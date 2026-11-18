import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DigioError, createDigioClient, isRetryable } from '../../../src/integrations/providers/digio/index.js';

const DOC = JSON.parse(readFileSync(new URL('./fixtures/document-requested.json', import.meta.url), 'utf8'));
const DOC_ID = DOC.id;
const CLIENT_ID = 'AI_TEST_CLIENT_ID';
const CLIENT_SECRET = 'TEST_CLIENT_SECRET_DO_NOT_USE';
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
const PDF = Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n', 'latin1');
const NOW = Date.parse('2026-11-05T10:00:00.000Z');

/** Fake fetch: replies from a queue and records every call. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: init.redirect });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    return next.clone();
  };
  fn.calls = calls;
  return fn;
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const pdf = (headers = {}) => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf', ...headers } });

function makeClient(fetch, config = {}, deps = {}) {
  const sleeps = [];
  const logs = [];
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (obj, msg) => logs.push({ level, obj, msg })]));
  const client = createDigioClient(
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webhookSecret: 'whsec_phoenix_test_0001', ...config },
    { fetch, now: () => NOW, logger, sleep: async (ms) => void sleeps.push(ms), random: () => 1, ...deps },
  );
  return { client, sleeps, logs };
}

const baseInput = () => ({
  document: { fileName: 'admission-agreement.pdf', contentBase64: PDF.toString('base64') },
  signers: [{ identifier: 'asha.verma@example.in', name: 'Asha Verma', reason: 'Admission agreement', signType: 'aadhaar' }],
});

// ---------- config ----------

test('config is validated and secrets are never echoed in errors', () => {
  assert.throws(
    () => createDigioClient({ clientId: CLIENT_ID, clientSecret: 'zq9x7' }),
    (err) => err instanceof DigioError && err.code === 'config_invalid' && !JSON.stringify(err).includes('zq9x7') && err.details[0].path === 'clientSecret',
  );
  assert.throws(() => createDigioClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, typo: 1 }), /config/);
  assert.throws(
    () => createDigioClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiBaseUrl: 'http://api.digio.in' }),
    (err) => err.code === 'config_invalid' && err.details[0].path === 'apiBaseUrl',
  );
});

test('sandbox is the default; production uses api.digio.in and app.digio.in', () => {
  const sandbox = createDigioClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, { fetch: fakeFetch(json(200, {})) });
  assert.equal(sandbox.environment, 'sandbox');
  assert.equal(sandbox.hosts.api, 'https://ext.digio.in:444');
  assert.equal(sandbox.hosts.app, 'https://ext.digio.in');
  const prod = createDigioClient(
    { environment: 'production', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    { fetch: fakeFetch(json(200, {})) },
  );
  assert.equal(prod.hosts.api, 'https://api.digio.in');
  assert.equal(prod.hosts.app, 'https://app.digio.in');
  assert.equal(prod.capabilities.kind, 'esign');
});

// ---------- create ----------

test('createSignRequest posts JSON with base64 PDF, Basic auth and mapped signers', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch);
  const input = baseInput();
  input.signers.push({ identifier: '+91 98765-43210', name: 'Phoenix Admissions Desk', signType: 'electronic', signatureMode: 'slate' });
  input.idempotencyKey = 'esign-req-0001';
  input.message = 'Please sign your admission agreement';
  const doc = await client.createSignRequest(input);

  assert.equal(fetch.calls.length, 1);
  const call = fetch.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://ext.digio.in:444/v2/client/document/uploadpdf');
  assert.equal(call.headers.Authorization, BASIC);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers.Accept, 'application/json');
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(call.redirect, 'error');
  assert.deepEqual(JSON.parse(call.body), {
    file_name: 'admission-agreement.pdf',
    signers: [
      { identifier: 'asha.verma@example.in', name: 'Asha Verma', reason: 'Admission agreement', sign_type: 'aadhaar' },
      {
        identifier: '9876543210',
        name: 'Phoenix Admissions Desk',
        reason: 'Agreement acceptance',
        sign_type: 'electronic',
        signature_mode: 'slate',
      },
    ],
    sequential: false,
    expire_in_days: 10,
    include_authentication_url: true,
    notify_signers: false,
    send_sign_link: false,
    customer_notification_mode: 'SMS',
    callback: 'esign-req-0001',
    comment: 'Please sign your admission agreement',
    file_data: PDF.toString('base64'),
  });

  assert.equal(doc.id, DOC_ID);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.createdAt, '2026-11-05T10:00:12.000Z'); // 15:30:12 IST
  assert.equal(doc.expiresAt, '2026-11-15T18:29:59.000Z');
  assert.equal(doc.pageCount, 3);
  assert.equal(doc.signers[0].signUrl, DOC.signing_parties[0].authentication_url);
  assert.equal(doc.signers[0].status, 'pending');
  assert.equal(doc.signers[1].status, 'waiting');
  assert.equal(doc.signers[1].signUrl, null);
});

test('signing order sorts signers and turns on sequential signing', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch);
  const input = baseInput();
  input.signers = [
    { identifier: 'desk@phoenix.example', name: 'Admissions Desk', signType: 'dsc', order: 2 },
    { identifier: 'asha.verma@example.in', name: 'Asha Verma', order: 1 },
  ];
  await client.createSignRequest(input);
  const body = JSON.parse(fetch.calls[0].body);
  assert.equal(body.sequential, true);
  assert.deepEqual(body.signers.map((s) => [s.identifier, s.sign_type]), [
    ['asha.verma@example.in', 'aadhaar'],
    ['desk@phoenix.example', 'dsc'],
  ]);
});

test('expiresAt becomes whole days and Digio-side notifications can be enabled', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch, { notifySigners: true, notificationChannel: 'WHATSAPP' });
  await client.createSignRequest({ ...baseInput(), expiresAt: '2026-11-08T09:00:00+05:30' });
  const body = JSON.parse(fetch.calls[0].body);
  assert.equal(body.expire_in_days, 3);
  assert.equal(body.notify_signers, true);
  assert.equal(body.send_sign_link, true);
  assert.equal(body.customer_notification_mode, 'WHATSAPP');
  await assert.rejects(client.createSignRequest({ ...baseInput(), expiresAt: '2027-06-01T00:00:00Z' }), { code: 'validation' });
});

test('multipart upload sends the PDF bytes and a JSON request part', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch);
  await client.createSignRequest({
    document: { fileName: 'agreement', content: PDF },
    signers: baseInput().signers,
    transport: 'multipart',
    providerOptions: { display_on_page: 'last' },
  });
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://ext.digio.in:444/v2/client/document/upload');
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(call.headers['Content-Type'])[1];
  const text = Buffer.from(call.body).toString('latin1');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="agreement.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
  assert.ok(text.includes(PDF.toString('latin1')));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
  const requestPart = text.split(`--${boundary}`)[2];
  assert.ok(requestPart.includes('Content-Disposition: form-data; name="request"\r\nContent-Type: application/json'));
  const request = JSON.parse(requestPart.split('\r\n\r\n')[1].trim());
  assert.equal(request.file_name, 'agreement.pdf');
  assert.equal(request.display_on_page, 'last');
  assert.equal(request.file_data, undefined);
});

test('minors cannot sign; a guardian signs on their behalf', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch);
  const minor = { identifier: 'student@example.in', name: 'Kabir Verma', isMinor: true };
  await assert.rejects(client.createSignRequest({ ...baseInput(), signers: [minor] }), (err) => {
    assert.equal(err.code, 'minor_signer');
    assert.match(err.message, /parent or guardian/);
    return true;
  });
  // 18th birthday on the IST calendar: 2026-11-05T18:00Z is 23:30 IST on the 5th, 20:00Z is the 6th.
  const dob = { identifier: 'student@example.in', name: 'Kabir Verma', dateOfBirth: '2008-11-06' };
  const before = makeClient(fetch, {}, { now: () => Date.parse('2026-11-05T18:00:00Z') }).client;
  await assert.rejects(before.createSignRequest({ ...baseInput(), signers: [dob] }), { code: 'minor_signer' });
  const after = makeClient(fetch, {}, { now: () => Date.parse('2026-11-05T20:00:00Z') }).client;
  await after.createSignRequest({ ...baseInput(), signers: [dob] });
  assert.equal(fetch.calls.length, 1, 'rejected requests never reach Digio');

  const guardian = {
    identifier: 'asha.verma@example.in',
    name: 'Asha Verma',
    reason: 'Admission agreement',
    onBehalfOf: { name: 'Kabir Verma', relationship: 'parent' },
  };
  await client.createSignRequest({ ...baseInput(), signers: [guardian] });
  assert.equal(JSON.parse(fetch.calls[1].body).signers[0].reason, 'Admission agreement. Signing as parent of Kabir Verma');
});

test('invalid requests fail before any network call', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch);
  const cases = [
    { ...baseInput(), document: { fileName: 'a.pdf', contentBase64: Buffer.from('hello world').toString('base64') } },
    { ...baseInput(), document: { fileName: 'a.pdf' } },
    { ...baseInput(), signers: [] },
    { ...baseInput(), signers: [{ identifier: '12345', name: 'A' }] },
    { ...baseInput(), signers: [{ identifier: 'a@b.in', name: 'A <script>' }] },
    { ...baseInput(), signers: [{ identifier: 'a@b.in', name: 'A' }, { identifier: 'a@b.in', name: 'B' }] },
    { ...baseInput(), signers: [{ identifier: 'a@b.in', name: 'A', signType: 'dsc', signatureMode: 'otp' }] },
    { ...baseInput(), providerOptions: { signers: [] } },
    { ...baseInput(), expiresInDays: 91 },
    { ...baseInput(), expiresInDays: 5, expiresAt: '2026-11-08T00:00:00Z' },
    { ...baseInput(), unknownField: true },
  ];
  for (const input of cases) {
    await assert.rejects(client.createSignRequest(input), (err) => err instanceof DigioError && err.code === 'validation' && !err.retryable);
  }
  const big = makeClient(fetch, { maxDocumentBytes: 1024 }).client;
  const large = Buffer.concat([PDF, Buffer.alloc(2048)]);
  await assert.rejects(big.createSignRequest({ ...baseInput(), document: { fileName: 'a.pdf', content: large } }), /limit is 1024/);
  assert.equal(fetch.calls.length, 0);
});

// ---------- errors and retries ----------

test('Digio 400 errors map to permanent bad_request with the exception reference', async () => {
  const fetch = fakeFetch(json(400, { details: 'EX23297402937402', code: 'REQUEST_VALIDATION_FAILED', message: 'Request Validation Failed' }));
  const { client } = makeClient(fetch);
  await assert.rejects(client.getDocument(DOC_ID), (err) => {
    assert.ok(err instanceof DigioError);
    assert.equal(err.code, 'bad_request');
    assert.equal(err.status, 400);
    assert.equal(err.providerCode, 'REQUEST_VALIDATION_FAILED');
    assert.equal(err.providerReference, 'EX23297402937402');
    assert.equal(err.retryable, false);
    assert.equal(isRetryable(err), false);
    assert.match(err.message, /Request Validation Failed/);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test('status and Digio codes map to typed errors', async () => {
  const cases = [
    [json(401, { message: 'Unauthorized' }), 'auth', false],
    [json(403, { details: 'EX2405131221289331CZ', code: 'UNAUTHORIZED_ACCESS', message: 'You are not authorized to take this action!' }), 'forbidden', false],
    [json(404, { message: 'Not found' }), 'not_found', false],
    [json(400, { code: '1016', message: 'Entity not found for this id' }), 'not_found', false],
    [json(400, { code: '1128', message: 'Duplicate request received' }), 'duplicate_request', false],
    [json(400, { code: '1015', message: 'Not Sufficient credits. Please buy more signs!' }), 'insufficient_credits', false],
    [json(400, { code: '1152', message: 'Requested action not allowed in current entity state' }), 'conflict', false],
    [json(400, { code: '1205', message: 'Aadhaar eSign is temporarily not working' }), 'provider_unavailable', true],
  ];
  for (const [reply, code, retryable] of cases) {
    const { client } = makeClient(fakeFetch(reply), { maxRetries: 0 });
    await assert.rejects(client.cancelSignRequest(DOC_ID), (err) => err.code === code && err.retryable === retryable);
  }
});

test('idempotent GETs retry 5xx with exponential backoff, then give up', async () => {
  const fetch = fakeFetch(json(503, { message: 'down' }));
  const { client, sleeps } = makeClient(fetch, { maxRetries: 2, retryBaseDelayMs: 500 });
  await assert.rejects(client.getDocument(DOC_ID), { code: 'provider_unavailable', retryable: true, status: 503 });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('a GET recovers after a transient failure and honours Retry-After', async () => {
  const fetch = fakeFetch(json(429, { message: 'slow down' }, { 'retry-after': '2' }), new TypeError('fetch failed'), json(200, DOC));
  const { client, sleeps } = makeClient(fetch, { maxRetries: 3 });
  const doc = await client.getDocument(DOC_ID);
  assert.equal(doc.id, DOC_ID);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 1000]);
});

test('create is retried only when it carries an idempotency key', async () => {
  const noKey = fakeFetch(json(502, {}), json(200, DOC));
  await assert.rejects(makeClient(noKey).client.createSignRequest(baseInput()), { code: 'provider_unavailable' });
  assert.equal(noKey.calls.length, 1);

  const withKey = fakeFetch(json(502, {}), json(200, DOC));
  const doc = await makeClient(withKey).client.createSignRequest({ ...baseInput(), idempotencyKey: 'esign-req-0002' });
  assert.equal(doc.id, DOC_ID);
  assert.equal(withKey.calls.length, 2);
  assert.equal(JSON.parse(withKey.calls[1].body).callback, 'esign-req-0002');

  const disabled = fakeFetch(json(502, {}), json(200, DOC));
  await assert.rejects(
    makeClient(disabled, { retryCreateWithIdempotencyKey: false }).client.createSignRequest({ ...baseInput(), idempotencyKey: 'esign-req-0003' }),
    { code: 'provider_unavailable' },
  );
  assert.equal(disabled.calls.length, 1);
});

test('cancel and token generation are never retried', async () => {
  const fetch = fakeFetch(json(500, {}));
  const { client } = makeClient(fetch);
  await assert.rejects(client.cancelSignRequest(DOC_ID), { code: 'provider_unavailable' });
  await assert.rejects(client.generateAccessToken({ documentId: DOC_ID, identifier: 'a@b.in' }), { code: 'provider_unavailable' });
  assert.equal(fetch.calls.length, 2);
});

test('timeouts are retryable; caller aborts are not', async () => {
  const timeout = fakeFetch(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const { client } = makeClient(timeout, { maxRetries: 1 });
  await assert.rejects(client.getDocument(DOC_ID), { code: 'timeout', retryable: true });
  assert.equal(timeout.calls.length, 2);

  const controller = new AbortController();
  const aborted = fakeFetch((_url, init) => {
    controller.abort(new Error('user navigated away'));
    throw init.signal.reason;
  });
  await assert.rejects(makeClient(aborted).client.getDocument(DOC_ID, { signal: controller.signal }), { code: 'aborted', retryable: false });
  assert.equal(aborted.calls.length, 1);
});

test('the per-attempt timeout really aborts a hung request', async () => {
  const hung = fakeFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
  const { client } = makeClient(hung, { timeoutMs: 1000, maxRetries: 0 });
  const started = Date.now();
  await assert.rejects(client.getDocument(DOC_ID), { code: 'timeout' });
  assert.ok(Date.now() - started >= 900);
});

test('secrets never appear in errors or logs', async () => {
  const fetch = fakeFetch(new TypeError(`connect failed for ${CLIENT_SECRET} via ${BASIC}`), json(500, { message: `echo ${CLIENT_SECRET}` }));
  const { client, logs } = makeClient(fetch, { maxRetries: 1 });
  const err = await client.getDocument(DOC_ID).catch((e) => e);
  assert.equal(err.code, 'provider_unavailable');
  const everything = JSON.stringify([err, err.message, logs]);
  assert.equal(everything.includes(CLIENT_SECRET), false);
  assert.equal(everything.includes(BASIC.slice(6)), false);
  assert.ok(everything.includes('[redacted]'));
  assert.ok(logs.every((l) => l.obj.provider === 'digio' && !('headers' in l.obj) && !('body' in l.obj)));
});

// ---------- status, download, cancel, token ----------

test('getDocument fetches by id and validates the id first', async () => {
  const fetch = fakeFetch(json(200, DOC));
  const { client } = makeClient(fetch);
  const doc = await client.getDocument(DOC_ID);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, `https://ext.digio.in:444/v2/client/document/${DOC_ID}`);
  assert.equal(fetch.calls[0].headers.Authorization, BASIC);
  assert.equal(fetch.calls[0].body, undefined);
  assert.equal(doc.signers.length, 2);
  await assert.rejects(client.getDocument('../admin'), { code: 'validation' });
  await assert.rejects(client.getDocument(undefined), { code: 'validation' });
  assert.equal(fetch.calls.length, 1);
});

test('statuses map from Digio values', async () => {
  for (const [digio, ours] of [['completed', 'completed'], ['expired', 'expired'], ['failed', 'failed'], ['draft', 'draft'], ['weird', 'unknown']]) {
    const { client } = makeClient(fakeFetch(json(200, { ...DOC, agreement_status: digio })));
    assert.equal((await client.getDocument(DOC_ID)).status, ours);
  }
  const { client } = makeClient(fakeFetch(json(200, { no: 'id' })));
  await assert.rejects(client.getDocument(DOC_ID), { code: 'invalid_response' });
});

test('downloadSignedDocument returns PDF bytes', async () => {
  const fetch = fakeFetch(pdf({ 'content-disposition': 'attachment; filename="admission-agreement-signed.pdf"' }));
  const { client } = makeClient(fetch);
  const file = await client.downloadSignedDocument(DOC_ID);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].url, `https://ext.digio.in:444/v2/client/document/download?document_id=${DOC_ID}`);
  assert.match(fetch.calls[0].headers.Accept, /application\/pdf/);
  assert.equal(fetch.calls[0].redirect, 'follow');
  assert.deepEqual(Buffer.from(file.bytes), PDF);
  assert.equal(file.fileName, 'admission-agreement-signed.pdf');
  assert.equal(file.contentType, 'application/pdf');
  assert.equal(file.size, PDF.length);
});

test('downloads refuse JSON errors and non-PDF bodies', async () => {
  const jsonError = makeClient(fakeFetch(json(200, { code: '1107', message: 'Document not ready for this action' }))).client;
  await assert.rejects(jsonError.downloadSignedDocument(DOC_ID), { code: 'conflict', providerCode: '1107' });
  const html = makeClient(fakeFetch(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))).client;
  await assert.rejects(html.downloadSignedDocument(DOC_ID), { code: 'invalid_response' });
});

test('audit trail, cancel and token endpoints use the documented paths', async () => {
  const fetch = fakeFetch(pdf(), json(200, { ...DOC, agreement_status: 'requested', cancel_reason: 'Cancelled by CRM' }), json(200, {
    id: 'GWT200526102029243SP8D8SUEK59XZL',
    created_at: '2020-05-26 10:20:29',
    entity_id: 'KID200526102029240GLYLZIMYROGYC1',
    valid_till: '2020-05-26 10:30:29',
  }));
  const { client } = makeClient(fetch);
  const audit = await client.downloadAuditTrail(DOC_ID);
  assert.equal(fetch.calls[0].url, `https://ext.digio.in:444/v2/client/document/${DOC_ID}/v2/audit_log`);
  assert.equal(audit.fileName, `${DOC_ID}-audit.pdf`);

  const cancelled = await client.cancelSignRequest(DOC_ID);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.equal(fetch.calls[1].url, `https://ext.digio.in:444/v2/client/document/${DOC_ID}/cancel`);
  assert.equal(cancelled.cancelReason, 'Cancelled by CRM');

  const token = await client.generateAccessToken({ documentId: DOC_ID, identifier: 'asha.verma@example.in' });
  assert.equal(fetch.calls[2].url, 'https://ext.digio.in:444/user/auth/generate_token');
  assert.deepEqual(JSON.parse(fetch.calls[2].body), { entityId: DOC_ID, identifier: 'asha.verma@example.in' });
  assert.deepEqual(token, {
    id: 'GWT200526102029243SP8D8SUEK59XZL',
    entityId: 'KID200526102029240GLYLZIMYROGYC1',
    validUntil: '2020-05-26T05:00:29.000Z',
    createdAt: '2020-05-26T04:50:29.000Z',
  });
});

// ---------- signing links ----------

test('signing links follow the documented gateway format', () => {
  const { client } = makeClient(fakeFetch(json(200, {})), { redirectUrl: 'https://crm.phoenix.example/esign/done' });
  assert.equal(
    client.getSigningUrl({ documentId: DOC_ID, identifier: 'asha.verma@example.in', txnId: 'vI3atY' }),
    `https://ext.digio.in/#/gateway/login/${DOC_ID}/vI3atY/asha.verma@example.in?redirect_url=https%3A%2F%2Fcrm.phoenix.example%2Fesign%2Fdone`,
  );
  const prod = createDigioClient({ environment: 'production', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, { fetch: fakeFetch(json(200, {})) });
  const url = prod.getSigningUrl({
    documentId: DOC_ID,
    identifier: '09876543210',
    txnId: 'txn_0001',
    redirectUrl: 'https://crm.phoenix.example/done?lead=42&x=y',
    logoUrl: 'https://cdn.phoenix.example/logo.png',
  });
  assert.equal(
    url,
    `https://app.digio.in/#/gateway/login/${DOC_ID}/txn_0001/9876543210?redirect_url=https%3A%2F%2Fcrm.phoenix.example%2Fdone%3Flead%3D42%26x%3Dy&logo=https%3A%2F%2Fcdn.phoenix.example%2Flogo.png`,
  );
  assert.match(prod.getSigningUrl({ documentId: DOC_ID, identifier: 'a@b.in' }), /^https:\/\/app\.digio\.in\/#\/gateway\/login\/DID\w+\/[\w-]{12}\/a@b\.in$/);
  assert.throws(() => prod.getSigningUrl({ documentId: DOC_ID, identifier: 'a@b.in', txnId: '../x' }), { code: 'validation' });
  assert.throws(() => prod.getSigningUrl({ documentId: DOC_ID, identifier: 'nobody' }), { code: 'validation' });
});
