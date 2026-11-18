import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AZURITE_ACCOUNT,
  AzblobError,
  buildSharedKeyStringToSign,
  createAzblobClient,
  hmacSha256Base64,
  parseConnectionString,
} from '../../../src/integrations/providers/azblob/index.js';
import { azureError, fakeFetch, fixedNow, NOW, noSleep, reply } from './fakes.js';

const AZURITE = {
  accountName: AZURITE_ACCOUNT.accountName,
  auth: { type: 'sharedKey', accountKey: AZURITE_ACCOUNT.accountKey },
  blobEndpoint: AZURITE_ACCOUNT.blobEndpoint,
  allowInsecureHttp: true,
  defaultContainer: 'admissions',
};

function sharedKeyClient(script, extra = {}) {
  const fetch = fakeFetch(script);
  const client = createAzblobClient({ ...AZURITE, ...extra }, { fetch, now: fixedNow, sleep: noSleep, random: () => 0.5 });
  return { client, fetch };
}

/** Re-derive the signature the way Azure would, from what was actually sent. */
function assertSignedCorrectly(call, contentLength) {
  const headers = { ...call.headers };
  delete headers.Authorization;
  if (contentLength) headers['Content-Length'] = String(contentLength);
  const stringToSign = buildSharedKeyStringToSign({ method: call.method, url: call.url, headers, accountName: AZURITE_ACCOUNT.accountName });
  assert.equal(call.headers.Authorization, `SharedKey devstoreaccount1:${hmacSha256Base64(stringToSign, AZURITE_ACCOUNT.accountKey)}`);
}

test('putBlob sends a signed block-blob PUT with content headers, MD5 and metadata', async () => {
  const { client, fetch } = sharedKeyClient([
    reply(201, {
      headers: { etag: '"0x8DCF0A1B2C3D4E5"', 'last-modified': 'Thu, 05 Nov 2026 10:00:00 GMT', 'content-md5': 'XrY7u+Ae7tCTyyK7j1rNww==', 'x-ms-request-id': 'req-1', 'x-ms-version-id': '2026-11-05T10:00:00.0000000Z' },
    }),
  ]);
  const result = await client.putBlob({
    name: 'g/123/Fee receipt.pdf',
    body: 'hello world',
    contentType: 'application/pdf',
    filename: 'शुल्क रसीद.pdf',
    metadata: { studentId: 'G-123' },
    overwrite: false,
    clientRequestId: 'corr-1',
  });
  const [call] = fetch.calls;
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, 'http://127.0.0.1:10000/devstoreaccount1/admissions/g/123/Fee%20receipt.pdf');
  assert.equal(Buffer.from(call.body).toString(), 'hello world');
  assert.equal(call.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(call.headers['Content-Type'], 'application/pdf');
  assert.equal(call.headers['x-ms-blob-content-type'], 'application/pdf');
  assert.equal(call.headers['Content-MD5'], 'XrY7u+Ae7tCTyyK7j1rNww==');
  assert.equal(call.headers['If-None-Match'], '*');
  assert.equal(call.headers['x-ms-meta-studentid'], 'G-123');
  assert.equal(call.headers['x-ms-client-request-id'], 'corr-1');
  assert.equal(call.headers['x-ms-version'], '2026-04-06');
  assert.equal(call.headers['x-ms-date'], 'Thu, 05 Nov 2026 10:00:00 GMT');
  assert.match(call.headers['x-ms-blob-content-disposition'], /^attachment; filename="[^"]+\.pdf"; filename\*=UTF-8''%E0%A4%B6/);
  assert.equal(call.headers['Content-Length'], undefined, 'fetch derives Content-Length from the body');
  assertSignedCorrectly(call, 11);
  assert.deepEqual(result, {
    container: 'admissions',
    name: 'g/123/Fee receipt.pdf',
    etag: '"0x8DCF0A1B2C3D4E5"',
    lastModified: '2026-11-05T10:00:00.000Z',
    contentMd5: 'XrY7u+Ae7tCTyyK7j1rNww==',
    versionId: '2026-11-05T10:00:00.0000000Z',
    size: 11,
    requestId: 'req-1',
  });
});

test('getBlob reads the body, maps properties, sends x-ms-range and verifies Content-MD5', async () => {
  const { client, fetch } = sharedKeyClient([
    reply(200, {
      body: 'hello world',
      headers: {
        'content-type': 'text/plain',
        'content-length': '11',
        'content-md5': 'XrY7u+Ae7tCTyyK7j1rNww==',
        'content-disposition': 'attachment; filename="hello.txt"',
        etag: '"0x1"',
        'last-modified': 'Thu, 05 Nov 2026 09:00:00 GMT',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-meta-studentid': 'G-123',
        'x-ms-request-id': 'req-2',
      },
    }),
    reply(206, { body: 'hello', headers: { 'content-length': '5', 'content-range': 'bytes 0-4/11' } }),
  ]);
  const full = await client.getBlob({ name: 'hello.txt' });
  assert.equal(full.body.toString(), 'hello world');
  assert.equal(full.contentType, 'text/plain');
  assert.equal(full.contentLength, 11);
  assert.equal(full.lastModified, '2026-11-05T09:00:00.000Z');
  assert.deepEqual(full.metadata, { studentid: 'G-123' });
  assert.equal(full.partial, false);
  assertSignedCorrectly(fetch.calls[0]);

  const part = await client.getBlob({ name: 'hello.txt', range: { offset: 0, count: 5 } });
  assert.equal(fetch.calls[1].headers['x-ms-range'], 'bytes=0-4');
  assert.equal(part.partial, true);
  assert.equal(part.body.toString(), 'hello');
});

test('getBlob rejects a body that does not match Content-MD5 as a retryable error', async () => {
  const { client } = sharedKeyClient([reply(200, { body: 'tampered', headers: { 'content-md5': 'XrY7u+Ae7tCTyyK7j1rNww==' } })]);
  await assert.rejects(client.getBlob({ name: 'hello.txt' }), (e) => e instanceof AzblobError && e.kind === 'server' && e.retryable);
});

test('getBlobProperties uses HEAD and maps 404 without a body via x-ms-error-code', async () => {
  const { client, fetch } = sharedKeyClient([
    reply(200, { headers: { 'content-length': '42', 'content-type': 'application/pdf', etag: '"0x2"' } }),
    reply(404, { headers: { 'x-ms-error-code': 'BlobNotFound', 'x-ms-request-id': 'req-404' } }),
  ]);
  const props = await client.getBlobProperties({ name: 'a.pdf' });
  assert.equal(fetch.calls[0].method, 'HEAD');
  assert.equal(props.contentLength, 42);
  await assert.rejects(client.getBlobProperties({ name: 'missing.pdf' }), (e) => e.kind === 'not_found' && e.azureCode === 'BlobNotFound' && !e.retryable && e.requestId === 'req-404');
  assert.equal(fetch.calls.length, 2, '404 is not retried');
});

test('deleteBlob expects 202, treats 404 as already deleted, and sends x-ms-delete-snapshots', async () => {
  const { client, fetch } = sharedKeyClient([reply(202, { headers: { 'x-ms-request-id': 'req-d' } }), azureError(404, 'BlobNotFound'), azureError(404, 'BlobNotFound')]);
  assert.deepEqual(await client.deleteBlob({ name: 'a.pdf', deleteSnapshots: 'include' }), { deleted: true, requestId: 'req-d' });
  assert.equal(fetch.calls[0].method, 'DELETE');
  assert.equal(fetch.calls[0].headers['x-ms-delete-snapshots'], 'include');
  assert.deepEqual(await client.deleteBlob({ name: 'a.pdf' }), { deleted: false, requestId: 'req-err' });
  await assert.rejects(client.deleteBlob({ name: 'a.pdf', ignoreMissing: false }), { kind: 'not_found' });
});

test('createContainer creates a private container (no public-access header) and tolerates existing ones', async () => {
  const { client, fetch } = sharedKeyClient([reply(201), azureError(409, 'ContainerAlreadyExists')]);
  assert.deepEqual(await client.createContainer({ container: 'receipts' }), { container: 'receipts', created: true });
  const [call] = fetch.calls;
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, 'http://127.0.0.1:10000/devstoreaccount1/receipts?restype=container');
  assert.equal(call.headers['x-ms-blob-public-access'], undefined);
  assertSignedCorrectly(call);
  assert.deepEqual(await client.createContainer({ container: 'receipts' }), { container: 'receipts', created: false });
});

test('retries 503 ServerBusy and 500 OperationTimedOut with backoff, then succeeds', async () => {
  const sleeps = [];
  const fetch = fakeFetch([azureError(503, 'ServerBusy'), azureError(500, 'OperationTimedOut'), reply(202)]);
  const client = createAzblobClient(AZURITE, { fetch, now: fixedNow, sleep: async (ms) => sleeps.push(ms), random: () => 0.5 });
  assert.equal((await client.deleteBlob({ name: 'x' })).deleted, true);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [250, 500], 'full jitter: random * min(max, base * 2^(n-1))');
  assert.notEqual(fetch.calls[0].headers.Authorization, undefined);
});

test('gives up after maxRetries with a retryable error, and honours Retry-After', async () => {
  const sleeps = [];
  const fetch = fakeFetch([
    reply(503, { headers: { 'retry-after': '2', 'x-ms-error-code': 'ServerBusy' } }),
    azureError(503, 'ServerBusy'),
    azureError(503, 'ServerBusy'),
  ]);
  const client = createAzblobClient({ ...AZURITE, maxRetries: 2 }, { fetch, now: fixedNow, sleep: async (ms) => sleeps.push(ms), random: () => 0 });
  await assert.rejects(client.getBlob({ name: 'x' }), (e) => e.kind === 'throttled' && e.retryable && e.status === 503 && e.attempts === 3);
  assert.equal(sleeps[0], 2000);
});

test('permanent errors are not retried: 403 AuthenticationFailed, 400, 409, 412, 413', async () => {
  const cases = [
    [azureError(403, 'AuthenticationFailed', "Server failed to authenticate. The MAC signature found in the HTTP request 'abc=' is not the same"), 'auth'],
    [azureError(403, 'AuthorizationPermissionMismatch'), 'forbidden'],
    [azureError(400, 'InvalidHeaderValue'), 'validation'],
    [azureError(409, 'BlobAlreadyExists'), 'conflict'],
    [azureError(412, 'ConditionNotMet'), 'precondition'],
    [azureError(413, 'RequestBodyTooLarge'), 'too_large'],
  ];
  for (const [response, kind] of cases) {
    const { client, fetch } = sharedKeyClient([response]);
    await assert.rejects(client.putBlob({ name: 'x', body: 'y' }), (e) => {
      assert.equal(e.kind, kind);
      assert.equal(e.retryable, false);
      assert.ok(!e.message.includes('MAC signature'), 'auth failure details stay out of messages');
      return true;
    });
    assert.equal(fetch.calls.length, 1);
  }
});

test('network errors and timeouts are retried for idempotent calls; caller cancellation is not', async () => {
  const fetch = fakeFetch([
    () => Promise.reject(new TypeError('fetch failed')),
    () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
    reply(202),
  ]);
  const client = createAzblobClient(AZURITE, { fetch, now: fixedNow, sleep: noSleep });
  assert.equal((await client.deleteBlob({ name: 'x' })).deleted, true);
  assert.ok(fetch.calls[0].signal instanceof AbortSignal);

  const controller = new AbortController();
  controller.abort();
  const cancelled = fakeFetch([() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), reply(202)]);
  const c2 = createAzblobClient(AZURITE, { fetch: cancelled, now: fixedNow, sleep: noSleep });
  await assert.rejects(c2.deleteBlob({ name: 'x', signal: controller.signal }), { kind: 'cancelled', retryable: false });
  assert.equal(cancelled.calls.length, 1);
});

test('a real per-attempt timeout aborts a hanging request', async () => {
  const hanging = (call) => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason)));
  const fetch = fakeFetch([hanging]);
  const client = createAzblobClient({ ...AZURITE, timeoutMs: 1000, maxRetries: 0 }, { fetch, now: fixedNow, sleep: noSleep });
  await assert.rejects(client.getBlobProperties({ name: 'x' }), { kind: 'timeout', retryable: true });
});

test('a create-only upload retried after a lost success is reconciled by comparing MD5', async () => {
  const { client, fetch } = sharedKeyClient([
    () => Promise.reject(new TypeError('socket hang up')),
    azureError(409, 'BlobAlreadyExists'),
    reply(200, { headers: { 'content-md5': 'XrY7u+Ae7tCTyyK7j1rNww==', etag: '"0x9"', 'content-length': '11' } }),
  ]);
  const result = await client.putBlob({ name: 'once.txt', body: 'hello world', overwrite: false });
  assert.equal(result.reconciled, true);
  assert.equal(result.etag, '"0x9"');
  assert.equal(fetch.calls[2].method, 'HEAD');
});

test('validation happens before any request: names, metadata, size, tier', async () => {
  const { client, fetch } = sharedKeyClient([], { maxUploadBytes: 4 });
  await assert.rejects(client.putBlob({ name: '../etc/passwd', body: 'x' }), { kind: 'validation' });
  await assert.rejects(client.putBlob({ name: 'a\\b', body: 'x' }), { kind: 'validation' });
  await assert.rejects(client.putBlob({ container: 'Bad_Name', name: 'a', body: 'x' }), { kind: 'validation' });
  await assert.rejects(client.putBlob({ name: 'a', body: 'x', metadata: { 'bad-name': 'v' } }), { kind: 'validation' });
  await assert.rejects(client.putBlob({ name: 'a', body: 'x', metadata: { name: 'अ' } }), { kind: 'validation' });
  await assert.rejects(client.putBlob({ name: 'a', body: 'hello' }), { kind: 'too_large' });
  await assert.rejects(client.putBlob({ name: 'a', body: 'x', accessTier: 'Frozen' }), { kind: 'validation' });
  await assert.rejects(client.createDownloadUrl({ name: 'a', expiresInSeconds: 999999 }), { kind: 'validation' });
  assert.equal(fetch.calls.length, 0);
});

test('createDownloadUrl with Shared Key returns a service SAS URL (no network call)', async () => {
  const { client, fetch } = sharedKeyClient([]);
  const { url, expiresAt, startsAt, sasKind } = await client.createDownloadUrl({ name: 'g/123/marksheet.pdf', expiresInSeconds: 600, filename: 'Marksheet.pdf' });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'http://127.0.0.1:10000/devstoreaccount1/admissions/g/123/marksheet.pdf');
  assert.equal(parsed.searchParams.get('sr'), 'b');
  assert.equal(parsed.searchParams.get('sp'), 'r');
  assert.equal(parsed.searchParams.get('se'), '2026-11-05T10:10:00Z');
  assert.equal(parsed.searchParams.get('st'), '2026-11-05T09:55:00Z');
  assert.equal(parsed.searchParams.get('spr'), null, 'http endpoint (Azurite) cannot require https');
  assert.match(parsed.searchParams.get('rscd'), /^attachment; filename="Marksheet.pdf"/);
  assert.equal(expiresAt, '2026-11-05T10:10:00.000Z');
  assert.equal(startsAt, '2026-11-05T09:55:00.000Z');
  assert.equal(sasKind, 'service');
  assert.equal(fetch.calls.length, 0);
});

const MI_CONFIG = { accountName: 'phoenixdocs', auth: { type: 'managedIdentity', clientId: '33333333-3333-3333-3333-333333333333' }, defaultContainer: 'admissions' };
const tokenReply = () =>
  reply(200, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: 'eyJ.fake.token', refresh_token: '', expires_in: '3599', expires_on: String(NOW / 1000 + 3599), resource: 'https://storage.azure.com/', token_type: 'Bearer' }),
  });

test('managed identity: IMDS token request shape, bearer header, and token caching', async () => {
  const fetch = fakeFetch([tokenReply(), reply(202), reply(202)]);
  const client = createAzblobClient(MI_CONFIG, { fetch, now: fixedNow, sleep: noSleep });
  await client.deleteBlob({ name: 'a' });
  await client.deleteBlob({ name: 'b' });
  const [imds, first, second] = fetch.calls;
  const imdsUrl = new URL(imds.url);
  assert.equal(imdsUrl.origin + imdsUrl.pathname, 'http://169.254.169.254/metadata/identity/oauth2/token');
  assert.equal(imdsUrl.searchParams.get('api-version'), '2018-02-01');
  assert.equal(imdsUrl.searchParams.get('resource'), 'https://storage.azure.com/');
  assert.equal(imdsUrl.searchParams.get('client_id'), MI_CONFIG.auth.clientId);
  assert.equal(imds.headers.Metadata, 'true');
  assert.equal(first.url, 'https://phoenixdocs.blob.core.windows.net/admissions/a');
  assert.equal(first.headers.Authorization, 'Bearer eyJ.fake.token');
  assert.equal(second.headers.Authorization, 'Bearer eyJ.fake.token');
  assert.equal(fetch.calls.length, 3, 'token fetched once');
});

test('managed identity: IMDS 404/429/5xx are retried, 400 is permanent', async () => {
  const fetch = fakeFetch([reply(404), reply(429), tokenReply(), reply(202)]);
  const client = createAzblobClient(MI_CONFIG, { fetch, now: fixedNow, sleep: noSleep });
  assert.equal((await client.deleteBlob({ name: 'a' })).deleted, true);

  const bad = fakeFetch([reply(400, { body: JSON.stringify({ error: 'invalid_request', error_description: 'Identity not found' }) })]);
  const c2 = createAzblobClient(MI_CONFIG, { fetch: bad, now: fixedNow, sleep: noSleep });
  await assert.rejects(c2.deleteBlob({ name: 'a' }), (e) => e.kind === 'auth' && e.azureCode === 'invalid_request' && !e.retryable);
});

test('App Service identity endpoint uses X-IDENTITY-HEADER and api-version 2019-08-01', async () => {
  const fetch = fakeFetch([tokenReply(), reply(202)]);
  const client = createAzblobClient(
    { ...MI_CONFIG, auth: { type: 'managedIdentity', objectId: '44444444-4444-4444-4444-444444444444', identityEndpoint: 'http://localhost:8081/msi/token', identityHeader: 'hdr-secret' } },
    { fetch, now: fixedNow, sleep: noSleep },
  );
  await client.deleteBlob({ name: 'a' });
  const url = new URL(fetch.calls[0].url);
  assert.equal(url.searchParams.get('api-version'), '2019-08-01');
  assert.equal(url.searchParams.get('principal_id'), '44444444-4444-4444-4444-444444444444');
  assert.equal(fetch.calls[0].headers['X-IDENTITY-HEADER'], 'hdr-secret');
});

test('a 401 with a bearer token drops the cached token and retries once with a fresh one', async () => {
  let n = 0;
  const getToken = async () => ({ token: `tok-${(n += 1)}`, expiresOn: NOW + 3600_000 });
  const fetch = fakeFetch([azureError(401, 'InvalidAuthenticationInfo'), reply(202)]);
  const client = createAzblobClient({ accountName: 'phoenixdocs', auth: { type: 'token', getToken }, defaultContainer: 'admissions' }, { fetch, now: fixedNow, sleep: noSleep });
  await client.deleteBlob({ name: 'a' });
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer tok-1');
  assert.equal(fetch.calls[1].headers.Authorization, 'Bearer tok-2');
});

const UDK_XML = `<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>11111111-1111-1111-1111-111111111111</SignedOid><SignedTid>22222222-2222-2222-2222-222222222222</SignedTid><SignedStart>2026-11-05T09:55:00Z</SignedStart><SignedExpiry>2026-11-06T11:00:00Z</SignedExpiry><SignedService>b</SignedService><SignedVersion>2026-04-06</SignedVersion><Value>AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=</Value></UserDelegationKey>`;

test('managed identity downloads use a cached user delegation key and a user delegation SAS', async () => {
  const fetch = fakeFetch([tokenReply(), reply(200, { body: UDK_XML, headers: { 'content-type': 'application/xml' } })]);
  const client = createAzblobClient(MI_CONFIG, { fetch, now: fixedNow, sleep: noSleep });
  const first = await client.createDownloadUrl({ name: 'g/1/tc.pdf', filename: 'TC.pdf' });
  const second = await client.createDownloadUrl({ name: 'g/1/tc.pdf' });
  assert.equal(fetch.calls.length, 2, 'token + one key request; second URL reuses the key');
  const keyCall = fetch.calls[1];
  assert.equal(keyCall.method, 'POST');
  assert.equal(keyCall.url, 'https://phoenixdocs.blob.core.windows.net/?restype=service&comp=userdelegationkey');
  assert.equal(keyCall.headers.Authorization, 'Bearer eyJ.fake.token');
  assert.match(Buffer.from(keyCall.body).toString(), /^<\?xml version="1.0" encoding="utf-8"\?><KeyInfo><Start>2026-11-05T09:55:00Z<\/Start><Expiry>2026-11-06T10:00:00Z<\/Expiry><\/KeyInfo>$/, 'key lasts at least a day so it is reused');
  const q = new URL(first.url).searchParams;
  assert.equal(first.sasKind, 'user_delegation');
  assert.equal(q.get('skoid'), '11111111-1111-1111-1111-111111111111');
  assert.equal(q.get('ske'), '2026-11-06T11:00:00Z');
  assert.equal(q.get('spr'), 'https');
  assert.equal(q.get('sv'), '2026-04-06');
  assert.ok(q.get('sig'));
  assert.equal(new URL(second.url).searchParams.get('skt'), '2026-11-05T09:55:00Z');
});

test('secrets never appear in error messages or logs', async () => {
  const lines = [];
  const logger = { debug: (o, m) => lines.push(JSON.stringify(o) + m), warn: (o, m) => lines.push(JSON.stringify(o) + m) };
  const fetch = fakeFetch([() => Promise.reject(new TypeError(`connect failed ${AZURITE_ACCOUNT.accountKey}`)), azureError(500, 'InternalError', `boom ${AZURITE_ACCOUNT.accountKey}`), azureError(500, 'InternalError'), azureError(500, 'InternalError')]);
  const client = createAzblobClient(AZURITE, { fetch, now: fixedNow, sleep: noSleep, logger });
  const error = await client.getBlob({ name: 'x' }).catch((e) => e);
  assert.equal(error.kind, 'server');
  for (const text of [error.message, ...lines]) {
    assert.ok(!text.includes(AZURITE_ACCOUNT.accountKey), text);
    assert.ok(!text.includes('SharedKey devstoreaccount1:'), text);
  }
  assert.throws(
    () => createAzblobClient({ ...AZURITE, auth: { type: 'sharedKey', accountKey: 'not base64 !!!!!!!!' } }),
    (e) => e.kind === 'config' && !e.message.includes('not base64 !!'),
  );
});

test('config: defaults, endpoint rules and connection strings', () => {
  const client = createAzblobClient({ accountName: 'phoenixdocs', auth: { type: 'managedIdentity' } }, { fetch: fakeFetch([]) });
  assert.equal(client.blobEndpoint, 'https://phoenixdocs.blob.core.windows.net');
  assert.equal(client.kind, 'storage');
  assert.ok(client.capabilities.includes('signed_download_url'));
  assert.throws(() => createAzblobClient({ ...AZURITE, allowInsecureHttp: false }), /allowInsecureHttp/);
  assert.throws(() => createAzblobClient({ accountName: 'Bad', auth: { type: 'managedIdentity' } }), { kind: 'config' });
  assert.throws(() => createAzblobClient({ accountName: 'abc', auth: { type: 'managedIdentity', clientId: '33333333-3333-3333-3333-333333333333', objectId: '44444444-4444-4444-4444-444444444444' } }), /only one/);
  assert.deepEqual(parseConnectionString('UseDevelopmentStorage=true'), {
    accountName: 'devstoreaccount1',
    auth: { type: 'sharedKey', accountKey: AZURITE_ACCOUNT.accountKey },
    blobEndpoint: 'http://127.0.0.1:10000/devstoreaccount1',
    allowInsecureHttp: true,
  });
  const cs = parseConnectionString('DefaultEndpointsProtocol=https;AccountName=phoenixdocs;AccountKey=AAAABBBBCCCCDDDD;EndpointSuffix=core.windows.net');
  assert.equal(cs.blobEndpoint, 'https://phoenixdocs.blob.core.windows.net');
  assert.throws(() => parseConnectionString('AccountName=x'), { kind: 'config' });
});
