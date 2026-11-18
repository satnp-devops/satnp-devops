import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WaError, createWaClient, signWebhook } from '../../../src/integrations/providers/wa/index.js';
import { ACCESS_TOKEN, APP_SECRET, OLD_APP_SECRET, RAW_MINIMAL_BODY, VERIFY_TOKEN } from './fixtures.js';

const PHONE_ID = '106540352242922';
const WABA_ID = '102290129340398';
const BASE = `https://graph.facebook.com/v26.0`;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const graphError = (status, code, message = 'Error', extra = {}) =>
  json(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'AXsgnV2Cm3ZMGF3dF_cfYIn', ...extra } });

const sendOk = (id = 'wamid.HBgLOTE5ODc2NTQzMjEwFQIAERgSQUFBQQA=', extra = {}) =>
  json(200, { messaging_product: 'whatsapp', contacts: [{ input: '+919876543210', wa_id: '919876543210' }], messages: [{ id, ...extra }] });

/** A fetch that never answers until its signal aborts. */
const hang = (_url, init) =>
  new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));

/**
 * Fake fetch: replays the given responders in order and records every call.
 * A responder is a Response, an Error to throw, or a function (url, init) => Response | Promise.
 */
function fakeFetch(...responders) {
  const calls = [];
  const fetch = async (url, init) => {
    const responder = responders[Math.min(calls.length, responders.length - 1)];
    calls.push({ url: new URL(String(url)), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    if (responder instanceof Error) throw responder;
    if (typeof responder === 'function') return responder(url, init);
    return responder.clone();
  };
  return { fetch, calls };
}

function capturingLogger() {
  const lines = [];
  const log = (level) => (obj, msg) => lines.push({ level, obj, msg });
  return { logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }, lines };
}

function makeClient(responders, configOverrides = {}, depsOverrides = {}) {
  const ff = fakeFetch(...(Array.isArray(responders) ? responders : [responders]));
  const sleeps = [];
  const { logger, lines } = capturingLogger();
  const client = createWaClient(
    {
      accessToken: ACCESS_TOKEN,
      appSecret: APP_SECRET,
      previousAppSecret: OLD_APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      phoneNumberId: PHONE_ID,
      wabaId: WABA_ID,
      defaultCountryCode: '91',
      timeoutMs: 100,
      ...configOverrides,
    },
    {
      fetch: ff.fetch,
      now: () => Date.UTC(2026, 10, 5, 6, 30),
      logger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      ...depsOverrides,
    },
  );
  return { client, calls: ff.calls, sleeps, lines };
}

const rejectsWith = (promise, check) => assert.rejects(promise, (err) => err instanceof WaError && check(err));

test('config is validated with zod and errors never include secret values', () => {
  assert.throws(
    () => createWaClient({ accessToken: 'tiny-secret', phoneNumberId: 'abc' }),
    (err) => err instanceof WaError && err.kind === 'config' && /accessToken/.test(err.message) && /phoneNumberId/.test(err.message) && !err.message.includes('tiny-secret'),
  );
  assert.throws(() => createWaClient({ accessToken: ACCESS_TOKEN, phoneNumberId: PHONE_ID, graphVersion: 'v27' }), /graphVersion/);
  assert.throws(() => createWaClient({ accessToken: ACCESS_TOKEN, phoneNumberId: PHONE_ID, baseUrl: 'http://graph.facebook.com' }), /baseUrl/);
  const { client } = makeClient(sendOk());
  assert.deepEqual(client.info, {
    provider: 'whatsapp',
    phoneNumberId: PHONE_ID,
    wabaId: WABA_ID,
    graphVersion: 'v26.0',
    baseUrl: 'https://graph.facebook.com',
    appSecretProof: false,
    hasAppSecret: true,
    hasVerifyToken: true,
  });
  assert.ok(!JSON.stringify(client).includes(ACCESS_TOKEN));
});

test('sendTemplate posts the documented template body with named variables, media header and URL button', async () => {
  const { client, calls } = makeClient(sendOk('wamid.T1', { message_status: 'accepted' }));
  const result = await client.sendTemplate({
    to: '98765 43210',
    name: 'admission_followup',
    language: 'en_IN',
    variables: {
      header: { type: 'image', id: '1037543291543636' },
      body: { student_name: 'Asha', fee_due: { amountMinor: 1250000, currency: 'INR' } },
      buttons: [
        { type: 'url', index: 0, text: 'Gonçalves & co' },
        { type: 'quick_reply', index: 1, payload: 'CALL_ME' },
      ],
    },
    callbackData: 'outbox:42',
  });
  assert.deepEqual(result, {
    provider: 'whatsapp',
    messageId: 'wamid.T1',
    recipientWaId: '919876543210',
    messageStatus: 'accepted',
    acceptedAt: '2026-11-05T06:30:00.000Z',
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url.href, `${BASE}/${PHONE_ID}/messages`);
  assert.equal(call.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(call.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '+919876543210',
    type: 'template',
    biz_opaque_callback_data: 'outbox:42',
    template: {
      name: 'admission_followup',
      language: { code: 'en_IN' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: '1037543291543636' } }] },
        {
          type: 'body',
          parameters: [
            { type: 'text', parameter_name: 'student_name', text: 'Asha' },
            { type: 'text', parameter_name: 'fee_due', text: '₹12,500.00' },
          ],
        },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'Gon%C3%A7alves%20%26%20co' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'CALL_ME' }] },
      ],
    },
  });
});

test('sendTemplate supports positional variables, raw components and template without variables', async () => {
  const { client, calls } = makeClient(sendOk());
  await client.sendTemplate({ to: '+91 98765 43210', name: 'otp_login', language: 'en', variables: { body: ['482910'], buttons: [{ type: 'url', index: 0, text: '482910' }] } });
  await client.sendTemplate({ to: '+919876543210', name: 'hello_world', language: 'en_US' });
  const raw = [{ type: 'body', parameters: [{ type: 'text', text: 'x' }] }];
  await client.sendTemplate({ to: '+919876543210', name: 'raw_one', language: 'hi', components: raw });
  assert.deepEqual(calls[0].body.template.components, [
    { type: 'body', parameters: [{ type: 'text', text: '482910' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482910' }] },
  ]);
  assert.deepEqual(calls[1].body.template, { name: 'hello_world', language: { code: 'en_US' } });
  assert.deepEqual(calls[2].body.template.components, raw);
});

test('free-form messages: text, media, reaction, interactive, replies and BSUID recipients', async () => {
  const { client, calls } = makeClient(sendOk());
  await client.sendText({ to: '09876543210', body: 'Your visit is confirmed for 10:30 IST.', previewUrl: false, replyTo: 'wamid.IN1' });
  await client.sendMedia({ to: '+919876543210', kind: 'document', media: { link: 'https://files.example.invalid/prospectus.pdf', filename: 'Prospectus.pdf' }, caption: 'Prospectus' });
  await client.sendReaction({ to: '+919876543210', messageId: 'wamid.IN1', emoji: '\u{1F44D}' });
  await client.sendInteractive({
    recipient: 'IN.13491208655302741918',
    interactive: { type: 'button', body: { text: 'Pick a slot' }, action: { buttons: [{ type: 'reply', reply: { id: 'am', title: 'Morning' } }] } },
  });
  assert.deepEqual(calls[0].body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '+919876543210',
    type: 'text',
    context: { message_id: 'wamid.IN1' },
    text: { body: 'Your visit is confirmed for 10:30 IST.', preview_url: false },
  });
  assert.deepEqual(calls[1].body.document, { link: 'https://files.example.invalid/prospectus.pdf', caption: 'Prospectus', filename: 'Prospectus.pdf' });
  assert.deepEqual(calls[2].body.reaction, { message_id: 'wamid.IN1', emoji: '\u{1F44D}' });
  assert.equal(calls[3].body.recipient, 'IN.13491208655302741918');
  assert.equal('to' in calls[3].body, false);
  assert.equal(calls[3].body.interactive.type, 'button');
});

test('invalid send input fails before any network call and does not echo the input', async () => {
  const { client, calls } = makeClient(sendOk());
  await rejectsWith(client.sendText({ to: '12345', body: 'hi' }), (e) => e.kind === 'invalid_request' && !e.message.includes('12345'));
  await rejectsWith(client.sendText({ to: '+919876543210', recipient: 'IN.1234567', body: 'hi' }), (e) => /exactly one of to or recipient/.test(e.message));
  await rejectsWith(client.sendText({ to: '+91 98765', body: 'hi' }), (e) => e.kind === 'invalid_request');
  await rejectsWith(client.sendText({ to: '+919876543210', body: 'x'.repeat(4097) }), (e) => /body/.test(e.message));
  await rejectsWith(client.sendTemplate({ to: '+919876543210', name: 'Bad Name', language: 'en' }), (e) => /name/.test(e.message));
  await rejectsWith(client.sendTemplate({ to: '+919876543210', name: 'ok', language: 'english' }), (e) => /language/.test(e.message));
  await rejectsWith(client.sendTemplate({ to: '+919876543210', name: 'ok', language: 'en', components: [], variables: {} }), (e) => /not both/.test(e.message));
  await rejectsWith(client.sendMedia({ to: '+919876543210', kind: 'audio', media: { id: '1' }, caption: 'no' }), (e) => /caption/.test(e.message));
  await rejectsWith(client.sendMedia({ to: '+919876543210', kind: 'image', media: { id: '1', link: 'https://x.invalid/a.jpg' } }), (e) => e.kind === 'invalid_request');
  await rejectsWith(client.sendText({ to: '+919876543210', body: 'hi', callbackData: 'x'.repeat(513) }), (e) => /callbackData/.test(e.message));
  assert.equal(calls.length, 0);
});

test('error mapping: permanent errors are typed and not retried', async () => {
  const cases = [
    [graphError(400, 131047, 'Re-engagement message'), 'window_closed'],
    [graphError(401, 190, 'Invalid OAuth access token'), 'auth'],
    [graphError(403, 200, 'Permissions error'), 'permission'],
    [graphError(400, 132001, 'Template name does not exist in the translation'), 'template'],
    [graphError(400, 131026, 'Message undeliverable'), 'recipient'],
    [graphError(400, 130403, 'Recipient blocked'), 'recipient'],
    [graphError(400, 368, 'Temporarily blocked for policies violations'), 'policy'],
    [graphError(400, 100, 'Invalid parameter'), 'invalid_request'],
    [graphError(400, 999999, 'Something new'), 'invalid_request'],
  ];
  for (const [response, kind] of cases) {
    const { client, calls, sleeps } = makeClient(response);
    await rejectsWith(client.sendText({ to: '+919876543210', body: 'hi' }), (e) => {
      assert.equal(e.kind, kind);
      assert.equal(e.retryable, false);
      assert.equal(e.ambiguous, false);
      assert.equal(e.fbtraceId, 'AXsgnV2Cm3ZMGF3dF_cfYIn');
      assert.equal(typeof e.code, 'number');
      return true;
    });
    assert.equal(calls.length, 1, kind);
    assert.equal(sleeps.length, 0);
  }
});

test('sends are retried only when Meta rejected them before processing (throughput 130429)', async () => {
  const { client, calls, sleeps } = makeClient([graphError(400, 130429, 'Rate limit hit'), sendOk('wamid.R1')]);
  const result = await client.sendText({ to: '+919876543210', body: 'hi' });
  assert.equal(result.messageId, 'wamid.R1');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.deepEqual(sleeps, [1000]);
});

test('pair rate limit 131056 backs off 4^x seconds, then hands the wait to the caller', async () => {
  const { client, calls, sleeps } = makeClient(graphError(400, 131056, 'Pair rate limit hit'), { maxRetries: 4, maxRetryDelayMs: 10_000 });
  await rejectsWith(client.sendText({ to: '+919876543210', body: 'hi' }), (e) => e.kind === 'rate_limited' && e.retryable && !e.ambiguous && e.retryAfterMs === 16_000);
  assert.deepEqual(sleeps, [1000, 4000]);
  assert.equal(calls.length, 3);
});

test('app-level rate limit (code 4) is not slept on inline: retryAfterMs goes to the caller', async () => {
  const { client, calls, sleeps } = makeClient(graphError(400, 4, 'Application request limit reached'));
  await rejectsWith(client.listTemplates(), (e) => e.kind === 'rate_limited' && e.retryable && e.retryAfterMs === 60_000);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('a 5xx on a send is not retried and is flagged ambiguous (no idempotency key exists)', async () => {
  const { client, calls } = makeClient(graphError(500, 131000, 'Something went wrong', { is_transient: true }));
  await rejectsWith(client.sendText({ to: '+919876543210', body: 'hi' }), (e) => e.kind === 'transient' && e.retryable && e.ambiguous && e.httpStatus === 500);
  assert.equal(calls.length, 1);
});

test('network failures and timeouts: sends fail fast as ambiguous, reads retry with backoff', async () => {
  const net = makeClient(new TypeError('fetch failed'));
  await rejectsWith(net.client.sendText({ to: '+919876543210', body: 'hi' }), (e) => e.kind === 'network' && e.retryable && e.ambiguous);
  assert.equal(net.calls.length, 1);

  const slow = makeClient(hang);
  await rejectsWith(slow.client.sendText({ to: '+919876543210', body: 'hi' }), (e) => e.kind === 'timeout' && e.ambiguous);
  assert.equal(slow.calls.length, 1);

  const reads = makeClient([hang, graphError(503, 2, 'Service temporarily unavailable', { is_transient: true }), json(200, { data: [], paging: {} })]);
  const page = await reads.client.listTemplates();
  assert.deepEqual(page, { templates: [], nextCursor: null, previousCursor: null });
  assert.equal(reads.calls.length, 3);
  assert.deepEqual(reads.sleeps, [375, 750]); // full-jitter backoff with random() = 0.5

  // is_transient from Meta overrides the table (code 1 alone is a permanent request error).
  const exhausted = makeClient(graphError(500, 1, 'Unknown', { is_transient: true }));
  await rejectsWith(exhausted.client.getTemplate('1387372356726668'), (e) => e.code === 1 && e.kind === 'transient' && e.retryable && !e.ambiguous);
  assert.equal(exhausted.calls.length, 3);
  assert.deepEqual(exhausted.sleeps, [375, 750]);
  const permanent = makeClient(graphError(400, 1, 'Invalid request'));
  await rejectsWith(permanent.client.getTemplate('1387372356726668'), (e) => e.kind === 'invalid_request' && !e.retryable);
  assert.equal(permanent.calls.length, 1);
});

test('mark-as-read is idempotent so it is retried on timeouts; typing indicator is optional', async () => {
  const { client, calls } = makeClient([hang, json(200, { success: true })]);
  assert.deepEqual(await client.markRead({ messageId: 'wamid.IN1', typing: true }), { success: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1', typing_indicator: { type: 'text' } });
});

test('a caller abort stops the call and is not retried', async () => {
  const controller = new AbortController();
  const { client, calls } = makeClient((url, init) => {
    queueMicrotask(() => controller.abort());
    return hang(url, init);
  });
  await rejectsWith(client.listTemplates({}, { signal: controller.signal }), (e) => e.kind === 'aborted' && !e.retryable);
  assert.equal(calls.length, 1);
});

test('secrets never reach logs or error messages', async () => {
  const leaky = graphError(400, 190, `Malformed access token ${ACCESS_TOKEN} for app secret ${APP_SECRET}`);
  const { client, lines } = makeClient([leaky], { appSecretProof: true });
  await rejectsWith(client.sendText({ to: '+919876543210', body: 'hi' }), (e) => {
    const text = `${e.message} ${JSON.stringify(e)} ${e.stack}`;
    assert.ok(!text.includes(ACCESS_TOKEN));
    assert.ok(!text.includes(APP_SECRET));
    assert.match(e.message, /\[REDACTED\]/);
    return true;
  });
  const logged = JSON.stringify(lines);
  assert.ok(lines.length > 0);
  assert.ok(!logged.includes(ACCESS_TOKEN));
  assert.ok(!logged.includes(APP_SECRET));
  assert.ok(!logged.includes('appsecret_proof'));
  assert.ok(!logged.includes('919876543210'), 'recipient numbers are not logged');
});

test('appsecret_proof is HMAC-SHA256(access token, app secret) and the Graph version is configurable', async () => {
  const { client, calls } = makeClient(json(200, { data: [], paging: {} }), { appSecretProof: true, graphVersion: 'v27.0' });
  await client.listTemplates({ limit: 5, status: 'approved' });
  const url = calls[0].url;
  assert.equal(url.pathname, `/v27.0/${WABA_ID}/message_templates`);
  assert.equal(url.searchParams.get('appsecret_proof'), '4fd0e2cd86f2c7d7aff6452ac0a087631f5bcb1f934c0270ad6d21a2f30e4147');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('status'), 'APPROVED');
  assert.match(url.searchParams.get('fields'), /^id,name,language,status,category/);
});

test('listTemplates normalises templates and exposes cursors', async () => {
  const page = {
    data: [
      {
        name: 'admission_followup',
        parameter_format: 'NAMED',
        components: [{ type: 'BODY', text: 'Hi {{student_name}}' }],
        language: 'en',
        status: 'APPROVED',
        category: 'UTILITY',
        quality_score: { score: 'GREEN' },
        id: '1387372356726668',
      },
      { name: 'fee_offer', language: 'hi', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'INVALID_FORMAT', id: '1166414785519855' },
    ],
    paging: { cursors: { before: 'QVFIUb', after: 'QVFIUa' }, next: 'https://graph.facebook.com/v26.0/102290129340398/message_templates?after=QVFIUa' },
  };
  const { client, calls } = makeClient(json(200, page));
  const result = await client.listTemplates({ after: 'QVFIUz' });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url.searchParams.get('after'), 'QVFIUz');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(result.nextCursor, 'QVFIUa');
  assert.equal(result.previousCursor, null);
  assert.deepEqual(result.templates[0], {
    id: '1387372356726668',
    name: 'admission_followup',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    subCategory: null,
    parameterFormat: 'NAMED',
    qualityScore: 'GREEN',
    rejectedReason: null,
    components: [{ type: 'BODY', text: 'Hi {{student_name}}' }],
    lastUpdatedAt: null,
  });
  assert.equal(result.templates[1].rejectedReason, 'INVALID_FORMAT');
});

test('template create, get, edit and delete use the documented endpoints', async () => {
  const { client, calls } = makeClient([
    json(200, { id: '594425479261596', status: 'PENDING', category: 'UTILITY' }),
    json(200, { id: '594425479261596', name: 'visit_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY', last_updated_time: 1762300800 }),
    json(200, { success: true }),
    json(200, { success: true }),
  ]);
  const components = [{ type: 'BODY', text: 'Hi {{1}}, your campus visit is at {{2}}.', example: { body_text: [['Asha', '10:30 AM']] } }];
  assert.deepEqual(await client.createTemplate({ name: 'visit_reminder', language: 'en', category: 'utility', parameterFormat: 'positional', components }), {
    id: '594425479261596',
    status: 'PENDING',
    category: 'UTILITY',
  });
  const tpl = await client.getTemplate('594425479261596');
  assert.equal(tpl.lastUpdatedAt, '2025-11-05T00:00:00.000Z');
  assert.deepEqual(await client.editTemplate('594425479261596', { components }), { success: true });
  assert.deepEqual(await client.deleteTemplate({ name: 'visit_reminder', templateId: '594425479261596' }), { success: true });

  assert.equal(calls[0].url.href, `${BASE}/${WABA_ID}/message_templates`);
  assert.deepEqual(calls[0].body, { name: 'visit_reminder', language: 'en', category: 'UTILITY', components, parameter_format: 'POSITIONAL' });
  assert.equal(calls[1].url.pathname, '/v26.0/594425479261596');
  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(calls[2].body, { components });
  assert.equal(calls[3].init.method, 'DELETE');
  assert.equal(calls[3].url.pathname, `/v26.0/${WABA_ID}/message_templates`);
  assert.equal(calls[3].url.searchParams.get('name'), 'visit_reminder');
  assert.equal(calls[3].url.searchParams.get('hsm_id'), '594425479261596');
});

test('template management needs a WABA id and validates input locally', async () => {
  const { client, calls } = makeClient(json(200, {}), { wabaId: undefined });
  await rejectsWith(client.listTemplates(), (e) => e.kind === 'config');
  const withWaba = makeClient(json(200, {}));
  await rejectsWith(withWaba.client.createTemplate({ name: 'x', language: 'en', category: 'promo', components: [{}] }), (e) => /category/.test(e.message));
  await rejectsWith(withWaba.client.editTemplate('1', {}), (e) => /nothing to change/.test(e.message));
  await rejectsWith(withWaba.client.getTemplate('../me'), (e) => e.kind === 'invalid_request');
  assert.equal(calls.length + withWaba.calls.length, 0);
});

test('uploadMedia sends multipart form data and enforces type and size limits', async () => {
  const { client, calls } = makeClient(json(200, { id: '1037543291543636' }));
  const pdf = new TextEncoder().encode('%PDF-1.7 fake');
  assert.deepEqual(await client.uploadMedia({ data: pdf, mimeType: 'application/pdf', filename: 'fees.pdf' }), { id: '1037543291543636' });
  const [call] = calls;
  assert.equal(call.url.href, `${BASE}/${PHONE_ID}/media`);
  assert.ok(call.init.body instanceof FormData);
  assert.equal(call.init.headers['Content-Type'], undefined, 'fetch sets the multipart boundary');
  assert.equal(call.init.body.get('messaging_product'), 'whatsapp');
  assert.equal(call.init.body.get('type'), 'application/pdf');
  const file = call.init.body.get('file');
  assert.equal(file.name, 'fees.pdf');
  assert.equal(file.type, 'application/pdf');
  assert.equal(await file.text(), '%PDF-1.7 fake');

  await rejectsWith(client.uploadMedia({ data: pdf, mimeType: 'application/zip' }), (e) => e.kind === 'media');
  await rejectsWith(client.uploadMedia({ data: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: 'image/png' }), (e) => /limit/.test(e.message));
  await rejectsWith(client.uploadMedia({ data: new Uint8Array(0), mimeType: 'image/png' }), (e) => /empty/.test(e.message));
  assert.equal(calls.length, 1);
});

test('downloadMedia resolves a fresh URL, sends the token only to Meta hosts and checks sha256', async () => {
  const bytes = new TextEncoder().encode('fake-jpeg-bytes');
  const sha = createHash('sha256').update(bytes).digest('base64');
  const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1003383421387256&ext=1762300900&hash=abc';
  const meta = (overrides = {}) => json(200, { messaging_product: 'whatsapp', url: mediaUrl, mime_type: 'image/jpeg', sha256: sha, file_size: '15', id: '1003383421387256', ...overrides });
  const binary = () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) } });

  const { client, calls } = makeClient([meta(), binary]);
  const media = await client.downloadMedia('1003383421387256');
  assert.deepEqual([...media.bytes], [...bytes]);
  assert.equal(media.mimeType, 'image/jpeg');
  assert.equal(calls[0].url.href, `${BASE}/1003383421387256?phone_number_id=${PHONE_ID}`);
  assert.equal(calls[1].url.href, mediaUrl);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[1].init.redirect, 'error');

  const evil = makeClient([meta({ url: 'https://attacker.example/steal' }), binary]);
  await rejectsWith(evil.client.downloadMedia('1003383421387256'), (e) => e.kind === 'media' && /attacker\.example/.test(e.message));
  assert.equal(evil.calls.length, 1);

  const mismatch = makeClient([meta({ sha256: 'AAAA' }), binary]);
  await rejectsWith(mismatch.client.downloadMedia('1003383421387256'), (e) => /sha256/.test(e.message));

  const big = makeClient([meta(), binary], { maxMediaBytes: 4 });
  await rejectsWith(big.client.downloadMedia('1003383421387256'), (e) => /limit/.test(e.message));

  const expired = makeClient([meta(), new Response('', { status: 404 })]);
  await rejectsWith(expired.client.downloadMedia('1003383421387256'), (e) => e.kind === 'not_found');
});

test('getMedia, deleteMedia and checkConnection', async () => {
  const { client, calls } = makeClient([
    json(200, { messaging_product: 'whatsapp', url: 'https://lookaside.fbsbx.com/x', mime_type: 'application/pdf', sha256: 'abc', file_size: '2048', id: '42' }),
    json(200, { success: true }),
    json(200, { id: PHONE_ID, display_phone_number: '+91 124 456 7890', verified_name: 'Phoenix Admissions', quality_rating: 'GREEN', throughput: { level: 'STANDARD' } }),
  ]);
  assert.deepEqual(await client.getMedia('42'), { id: '42', url: 'https://lookaside.fbsbx.com/x', mimeType: 'application/pdf', sha256: 'abc', fileSize: 2048 });
  assert.deepEqual(await client.deleteMedia('42'), { success: true });
  assert.equal(calls[1].init.method, 'DELETE');
  assert.deepEqual(await client.checkConnection(), {
    phoneNumberId: PHONE_ID,
    displayPhoneNumber: '+91 124 456 7890',
    verifiedName: 'Phoenix Admissions',
    qualityRating: 'GREEN',
    throughput: 'STANDARD',
  });
  assert.equal(calls[2].url.searchParams.get('fields'), 'id,display_phone_number,verified_name,quality_rating,throughput');
});

test('client-bound webhook helpers use the configured secrets and verify token', () => {
  const { client } = makeClient(sendOk());
  assert.deepEqual(client.verifyWebhook(RAW_MINIMAL_BODY, { 'x-hub-signature-256': signWebhook(RAW_MINIMAL_BODY, OLD_APP_SECRET) }), { ok: true, secretIndex: 1 });
  assert.equal(client.verifyWebhook(RAW_MINIMAL_BODY, { 'x-hub-signature-256': signWebhook(RAW_MINIMAL_BODY, 'nope-nope-nope') }).ok, false);
  assert.deepEqual(client.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '99' }), { ok: true, challenge: '99' });
  assert.equal(client.parseWebhook({ object: 'whatsapp_business_account', entry: [] }).length, 0);
});

test('a 200 without a message id is surfaced as an ambiguous unknown error', async () => {
  const { client } = makeClient(json(200, { messaging_product: 'whatsapp', messages: [] }));
  await rejectsWith(client.sendText({ to: '+919876543210', body: 'hi' }), (e) => e.kind === 'unknown' && e.ambiguous);
  const html = makeClient(new Response('<html>oops</html>', { status: 200 }));
  await rejectsWith(html.client.listTemplates(), (e) => e.kind === 'unknown' && /non-JSON/.test(e.message));
});
