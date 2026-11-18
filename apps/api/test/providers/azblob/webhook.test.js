import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  abuseProtectionResponse,
  parseBlobSubject,
  parseWebhook,
  subscriptionValidationResponse,
  verifyEntraBearer,
  verifyWebhook,
} from '../../../src/integrations/providers/azblob/index.js';

const SECRET = 'whsec_9f1c2e7a4b6d8e0f1a2b3c4d5e6f7a8b';
const OLD_SECRET = 'whsec_old_00000000000000000000000000';

// Samples copied from Microsoft Learn "Azure Blob Storage as Event Grid source" (updated 2026-03-25).
const EVENT_GRID_CREATED = [
  {
    topic: '/subscriptions/{subscription-id}/resourceGroups/Storage/providers/Microsoft.Storage/storageAccounts/my-storage-account',
    subject: '/blobServices/default/containers/test-container/blobs/new-file.txt',
    eventType: 'Microsoft.Storage.BlobCreated',
    eventTime: '2017-06-26T18:41:00.9584103Z',
    id: '831e1650-001e-001b-66ab-eeb76e069631',
    data: {
      api: 'PutBlockList',
      clientRequestId: '6d79dbfb-0e37-4fc4-981f-442c9ca65760',
      requestId: '831e1650-001e-001b-66ab-eeb76e000000',
      eTag: '0x8D4BCC2E4835CD0',
      contentType: 'text/plain',
      contentLength: 524288,
      blobType: 'BlockBlob',
      url: 'https://my-storage-account.blob.core.windows.net/testcontainer/new-file.txt',
      sequencer: '00000000000004420000000000028963',
      storageDiagnostics: { batchId: 'b68529f3-68cd-4744-baa4-3c0498ec19f0' },
    },
    dataVersion: '',
    metadataVersion: '1',
  },
];
const CLOUD_DELETED = [
  {
    source: '/subscriptions/{subscription-id}/resourceGroups/Storage/providers/Microsoft.Storage/storageAccounts/my-storage-account',
    subject: '/blobServices/default/containers/testcontainer/blobs/file-to-delete.txt',
    type: 'Microsoft.Storage.BlobDeleted',
    time: '2017-11-07T20:09:22.5674003Z',
    id: '4c2359fe-001e-00ba-0e04-58586806d298',
    data: {
      api: 'DeleteBlob',
      requestId: '4c2359fe-001e-00ba-0e04-585868000000',
      contentType: 'text/plain',
      blobType: 'BlockBlob',
      accessTier: 'Default',
      url: 'https://my-storage-account.blob.core.windows.net/testcontainer/file-to-delete.txt',
      sequencer: '0000000000000281000000000002F5CA',
      storageDiagnostics: { batchId: 'b68529f3-68cd-4744-baa4-3c0498ec19f0' },
    },
    specversion: '1.0',
  },
];
// From "Validate Webhook Endpoints with Event Grid Schema" (updated 2026-03-27).
const VALIDATION = [
  {
    id: '2d1781af-3a4c-4d7c-bd0c-e34b19da4e66',
    topic: '/subscriptions/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    subject: '',
    data: {
      validationCode: '512d38b6-c7b8-40c8-89fe-f46f9e9622b6',
      validationUrl: 'https://rp-eastus2.eventgrid.azure.net:553/eventsubscriptions/myeventsub/validate?id=0000000000-0000-0000-0000-00000000000000&t=2022-10-28T04:23:35.1981776Z&apiVersion=2018-05-01-preview&token=1A1A1A1A',
    },
    eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent',
    eventTime: '2022-10-28T04:23:35.1981776Z',
    metadataVersion: '1',
    dataVersion: '1',
  },
];

const raw = (value) => Buffer.from(JSON.stringify(value));

test('verifyWebhook: valid secret via delivery-property header, ?code= query, or Authorization bearer', () => {
  const body = raw(EVENT_GRID_CREATED);
  assert.deepEqual(verifyWebhook(body, { 'x-phoenix-webhook-secret': SECRET, 'aeg-event-type': 'Notification' }, SECRET), { valid: true, method: 'header' });
  assert.deepEqual(verifyWebhook(body, {}, SECRET, { query: `https://api.phoenix.test/webhooks/azblob?code=${SECRET}` }), { valid: true, method: 'query' });
  assert.deepEqual(verifyWebhook(body, new Headers({ Authorization: `Bearer ${SECRET}` }), SECRET), { valid: true, method: 'bearer' });
});

test('verifyWebhook: rotation accepts the previous secret too', () => {
  assert.equal(verifyWebhook(raw(EVENT_GRID_CREATED), { 'x-phoenix-webhook-secret': OLD_SECRET }, [SECRET, OLD_SECRET]).valid, true);
});

test('verifyWebhook: tampered or missing credential, malformed body, weak secret config', () => {
  const body = raw(EVENT_GRID_CREATED);
  assert.deepEqual(verifyWebhook(body, { 'x-phoenix-webhook-secret': `${SECRET}x` }, SECRET), { valid: false, reason: 'bad_credential' });
  assert.deepEqual(verifyWebhook(body, { 'x-phoenix-webhook-secret': SECRET.slice(0, -1) }, SECRET), { valid: false, reason: 'bad_credential' });
  assert.deepEqual(verifyWebhook(body, {}, SECRET), { valid: false, reason: 'missing_credential' });
  assert.deepEqual(verifyWebhook(Buffer.from('{"id":'), { 'x-phoenix-webhook-secret': SECRET }, SECRET), { valid: false, reason: 'malformed_body' });
  assert.deepEqual(verifyWebhook(raw([{ eventType: 'x' }]), { 'x-phoenix-webhook-secret': SECRET }, SECRET), { valid: false, reason: 'malformed_body' });
  assert.deepEqual(verifyWebhook(body, { 'x-phoenix-webhook-secret': 'short' }, 'short'), { valid: false, reason: 'secret_not_configured' });
  assert.deepEqual(verifyWebhook(body, { 'x-phoenix-webhook-secret': SECRET, 'aeg-event-type': 'Bogus' }, SECRET), { valid: false, reason: 'unexpected_event_type_header' });
});

test('verifyWebhook: optional freshness window rejects expired and far-future events', () => {
  const now = () => Date.parse('2017-06-26T19:00:00Z');
  const headers = { 'x-phoenix-webhook-secret': SECRET };
  assert.equal(verifyWebhook(raw(EVENT_GRID_CREATED), headers, SECRET, { toleranceSeconds: 3600, now }).valid, true);
  assert.deepEqual(verifyWebhook(raw(EVENT_GRID_CREATED), headers, SECRET, { toleranceSeconds: 60, now }), { valid: false, reason: 'expired' });
  const future = [{ ...EVENT_GRID_CREATED[0], eventTime: '2017-06-26T20:00:00Z' }];
  assert.deepEqual(verifyWebhook(raw(future), headers, SECRET, { toleranceSeconds: 60, now }), { valid: false, reason: 'event_time_in_future' });
  // No window by default: Event Grid retries for up to 24 hours.
  assert.equal(verifyWebhook(raw(EVENT_GRID_CREATED), headers, SECRET).valid, true);
});

test('parseWebhook: Event Grid schema BlobCreated sample', () => {
  const [event] = parseWebhook(raw(EVENT_GRID_CREATED));
  assert.equal(event.provider, 'azblob');
  assert.equal(event.id, '831e1650-001e-001b-66ab-eeb76e069631');
  assert.equal(event.type, 'blob.created');
  assert.equal(event.schema, 'eventgrid');
  assert.equal(event.occurredAt, '2017-06-26T18:41:00.958Z');
  assert.equal(event.account, 'my-storage-account');
  assert.equal(event.container, 'test-container');
  assert.equal(event.blobName, 'new-file.txt');
  assert.equal(event.contentLength, 524288);
  assert.equal(event.api, 'PutBlockList');
  assert.equal(event.sequencer, '00000000000004420000000000028963');
});

test('parseWebhook: CloudEvents BlobDeleted sample, single-object bodies and string input', () => {
  const [event] = parseWebhook(JSON.stringify(CLOUD_DELETED));
  assert.equal(event.type, 'blob.deleted');
  assert.equal(event.schema, 'cloudevents');
  assert.equal(event.id, '4c2359fe-001e-00ba-0e04-58586806d298');
  assert.equal(event.contentLength, null);
  assert.equal(event.accessTier, 'Default');
  assert.equal(parseWebhook(CLOUD_DELETED[0]).length, 1);
  assert.throws(() => parseWebhook('not json'), TypeError);
});

test('subscription validation handshake echoes the validation code', () => {
  const events = parseWebhook(raw(VALIDATION));
  assert.equal(events[0].type, 'subscription.validation');
  assert.deepEqual(subscriptionValidationResponse(events), { validationResponse: '512d38b6-c7b8-40c8-89fe-f46f9e9622b6' });
  assert.equal(subscriptionValidationResponse(parseWebhook(raw(EVENT_GRID_CREATED))), null);
});

test('CloudEvents abuse protection (OPTIONS) allows only the configured origin', () => {
  assert.deepEqual(abuseProtectionResponse({ 'WebHook-Request-Origin': 'eventgrid.azure.net' }), {
    allowed: true,
    status: 200,
    headers: { 'WebHook-Allowed-Origin': 'eventgrid.azure.net', 'WebHook-Allowed-Rate': '*', Allow: 'POST, OPTIONS' },
  });
  assert.equal(abuseProtectionResponse({ 'webhook-request-origin': 'evil.example.com' }).allowed, false);
});

test('blob subjects keep virtual directories in the blob name', () => {
  assert.deepEqual(parseBlobSubject('/blobServices/default/containers/admissions/blobs/g/123/मार्कशीट.pdf'), { container: 'admissions', blobName: 'g/123/मार्कशीट.pdf' });
  assert.deepEqual(parseBlobSubject('/blobServices/default/containers/admissions'), { container: 'admissions', blobName: null });
});

function jwt(payload, privateKey, kid = 'k1') {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(payload)}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

test('verifyEntraBearer: RS256 signature, audience, issuer and expiry', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] };
  const now = () => Date.parse('2026-11-05T10:00:00Z');
  const iss = 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0';
  const claims = { aud: 'api://phoenix-eventgrid', iss, exp: now() / 1000 + 600, nbf: now() / 1000 - 60 };
  const opts = { jwks, audience: 'api://phoenix-eventgrid', issuers: [iss], now };
  const token = jwt(claims, privateKey);
  assert.equal(verifyEntraBearer(`Bearer ${token}`, opts).valid, true);

  const [h, , s] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, aud: 'api://other' })).toString('base64url');
  assert.deepEqual(verifyEntraBearer(`Bearer ${h}.${tamperedPayload}.${s}`, opts), { valid: false, reason: 'bad_signature' });
  assert.deepEqual(verifyEntraBearer(`Bearer ${jwt({ ...claims, exp: now() / 1000 - 3600 }, privateKey)}`, opts), { valid: false, reason: 'expired' });
  assert.deepEqual(verifyEntraBearer(`Bearer ${jwt({ ...claims, aud: 'api://other' }, privateKey)}`, opts), { valid: false, reason: 'bad_audience' });
  assert.deepEqual(verifyEntraBearer(`Bearer ${jwt({ ...claims, iss: 'https://evil' }, privateKey)}`, opts), { valid: false, reason: 'bad_issuer' });
  assert.deepEqual(verifyEntraBearer(`Bearer ${jwt(claims, privateKey, 'unknown')}`, opts), { valid: false, reason: 'unknown_key' });
  assert.deepEqual(verifyEntraBearer(undefined, opts), { valid: false, reason: 'missing_credential' });
});
