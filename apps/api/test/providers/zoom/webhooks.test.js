import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildUrlValidationResponse,
  computeSignature,
  createZoomClient,
  deriveEventId,
  getHeader,
  handleWebhookRequest,
  parseWebhook,
  verifyWebhook,
} from '../../../src/integrations/providers/zoom/index.js';
import { TEST_CONFIG, deps, fakeClock, fakeFetch, fixtureText } from './helpers.js';

const SECRET = TEST_CONFIG.webhookSecretToken;
const NOW_MS = Date.parse('2026-11-05T09:00:00Z');
const TS = '1793869200'; // NOW_MS in seconds

/** Signature the way Zoom documents it, computed independently of the module under test. */
function zoomSign(body, timestamp = TS, secret = SECRET) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

function signedHeaders(body, { timestamp = TS, secret = SECRET } = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-zm-request-timestamp': timestamp,
    'x-zm-signature': zoomSign(body, timestamp, secret),
    'x-zm-request-id': '6009d653_d487_445d_8406_42b654974899',
  };
}

test('official vector: URL validation example from Zoom docs (secret "SECRET_TOKEN")', () => {
  // developers.zoom.us/docs/api/webhooks/#validate-your-webhook-endpoint, fetched 2026-11-05.
  assert.deepEqual(buildUrlValidationResponse('qgg8vlvZRS6UYooatFL8Aw', 'SECRET_TOKEN'), {
    plainToken: 'qgg8vlvZRS6UYooatFL8Aw',
    encryptedToken: '23a89b634c017e5364a1c8d9c8ea909b60dd5599e2bb04bb1558d9c3a121faa5',
  });
});

test('signature vectors computed with node:crypto (fixed expected values)', () => {
  const joined = fixtureText('participant_joined.json');
  const vectors = [
    [joined, 'v0=1f99899de548122ef60c354dd11b3a363b38c87fff8b5ee66cebe77500861b57'],
    [fixtureText('url_validation.json'), 'v0=cca61c22aac864690fd505691ce232aae92fca53d33329160bab71ac4aced18e'],
    [
      '{"event":"meeting.participant_joined","payload":{"object":{"participant":{"user_name":"आशा शर्मा"}}}}',
      'v0=010455454db3e438683df07ba9d4c4c8685b5998992726bfce28908c8ee004eb',
    ],
  ];
  for (const [body, expected] of vectors) {
    assert.equal(zoomSign(body), expected);
    assert.equal(computeSignature(body, TS, SECRET), expected);
    assert.equal(computeSignature(Buffer.from(body, 'utf8'), TS, SECRET), expected);
  }
});

test('verifyWebhook accepts a valid signature over the raw body (string, Buffer, Headers object)', () => {
  const body = fixtureText('participant_joined.json');
  const headers = signedHeaders(body);
  assert.deepEqual(verifyWebhook(body, headers, SECRET, { now: NOW_MS }), { valid: true, timestamp: 1793869200, secretIndex: 0 });
  assert.equal(verifyWebhook(Buffer.from(body), headers, SECRET, { now: NOW_MS }).valid, true);
  assert.equal(verifyWebhook(new Uint8Array(Buffer.from(body)), new Headers(headers), SECRET, { now: NOW_MS }).valid, true);
  const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), [v]]));
  assert.equal(verifyWebhook(body, upper, SECRET, { now: NOW_MS }).valid, true, 'header names are case-insensitive, arrays allowed');
});

test('verifyWebhook rejects tampered bodies, wrong secrets and re-serialised JSON that differs from the raw bytes', () => {
  const body = fixtureText('participant_joined.json');
  const headers = signedHeaders(body);
  const tampered = body.replace('Jill Chill', 'Jill Chil1');
  assert.deepEqual(verifyWebhook(tampered, headers, SECRET, { now: NOW_MS }), { valid: false, reason: 'signature_mismatch' });
  assert.equal(verifyWebhook(body, headers, 'another-secret', { now: NOW_MS }).reason, 'signature_mismatch');
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  assert.equal(verifyWebhook(pretty, headers, SECRET, { now: NOW_MS }).reason, 'signature_mismatch');
  // Signature for another timestamp replayed with this timestamp.
  const replay = { ...headers, 'x-zm-signature': zoomSign(body, '1793869100') };
  assert.equal(verifyWebhook(body, replay, SECRET, { now: NOW_MS }).reason, 'signature_mismatch');
  // Uppercase hex is the same digest.
  const upperHex = { ...headers, 'x-zm-signature': `v0=${headers['x-zm-signature'].slice(3).toUpperCase()}` };
  assert.equal(verifyWebhook(body, upperHex, SECRET, { now: NOW_MS }).valid, true);
});

test('verifyWebhook enforces the timestamp tolerance (expired and future requests)', () => {
  const body = fixtureText('meeting_ended.json');
  const headers = signedHeaders(body);
  assert.equal(verifyWebhook(body, headers, SECRET, { now: NOW_MS + 300_000 }).valid, true, 'exactly at the edge');
  assert.equal(verifyWebhook(body, headers, SECRET, { now: NOW_MS + 301_000 }).reason, 'timestamp_out_of_tolerance');
  assert.equal(verifyWebhook(body, headers, SECRET, { now: NOW_MS - 301_000 }).reason, 'timestamp_out_of_tolerance');
  assert.equal(verifyWebhook(body, headers, SECRET, { now: NOW_MS + 3_600_000, toleranceSeconds: 7200 }).valid, true);
  assert.equal(verifyWebhook(body, headers, SECRET, { now: NOW_MS + 86_400_000, toleranceSeconds: 0 }).valid, true, '0 disables');
});

test('verifyWebhook reports missing and malformed inputs', () => {
  const body = fixtureText('meeting_ended.json');
  const headers = signedHeaders(body);
  const without = (name) => Object.fromEntries(Object.entries(headers).filter(([k]) => k !== name));
  assert.equal(verifyWebhook(body, without('x-zm-signature'), SECRET, { now: NOW_MS }).reason, 'missing_signature');
  assert.equal(verifyWebhook(body, without('x-zm-request-timestamp'), SECRET, { now: NOW_MS }).reason, 'missing_timestamp');
  assert.equal(verifyWebhook(body, { ...headers, 'x-zm-signature': 'v1=abc' }, SECRET, { now: NOW_MS }).reason, 'malformed_signature');
  assert.equal(verifyWebhook(body, { ...headers, 'x-zm-signature': headers['x-zm-signature'].slice(0, -2) }, SECRET, { now: NOW_MS }).reason, 'malformed_signature');
  assert.equal(verifyWebhook(body, { ...headers, 'x-zm-request-timestamp': '17938e9' }, SECRET, { now: NOW_MS }).reason, 'malformed_timestamp');
  assert.equal(verifyWebhook(body, headers, '', { now: NOW_MS }).reason, 'missing_secret');
  assert.equal(verifyWebhook({ parsed: true }, headers, SECRET, { now: NOW_MS }).reason, 'invalid_body');
  assert.equal(verifyWebhook(body, null, SECRET, { now: NOW_MS }).reason, 'missing_signature');
});

test('verifyWebhook supports secret rotation and reports which secret matched', () => {
  const body = fixtureText('meeting_ended.json');
  const headers = signedHeaders(body, { secret: 'old-secret-token' });
  assert.deepEqual(verifyWebhook(body, headers, [SECRET, 'old-secret-token'], { now: NOW_MS }), {
    valid: true,
    timestamp: 1793869200,
    secretIndex: 1,
  });
});

test('handleWebhookRequest answers URL validation only when the request is signed', () => {
  const rawBody = fixtureText('url_validation.json');
  const ok = handleWebhookRequest({ rawBody, headers: signedHeaders(rawBody) }, { secret: SECRET, now: NOW_MS });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, {
    plainToken: 'qgg8vlvZRS6UYooatFL8Aw',
    encryptedToken: createHmac('sha256', SECRET).update('qgg8vlvZRS6UYooatFL8Aw').digest('hex'),
  });
  assert.deepEqual(ok.events, []);

  // An unsigned challenge would make us an HMAC oracle: never answer it.
  const unsigned = handleWebhookRequest({ rawBody, headers: { 'content-type': 'application/json' } }, { secret: SECRET, now: NOW_MS });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.reason, 'missing_signature');
  assert.equal(JSON.stringify(unsigned).includes('encryptedToken'), false);

  // During rotation, answer with the secret that signed the challenge.
  const rotated = handleWebhookRequest(
    { rawBody, headers: signedHeaders(rawBody, { secret: 'old-secret-token' }) },
    { secret: [SECRET, 'old-secret-token'], now: NOW_MS },
  );
  assert.equal(rotated.body.encryptedToken, createHmac('sha256', 'old-secret-token').update('qgg8vlvZRS6UYooatFL8Aw').digest('hex'));
});

test('handleWebhookRequest returns events for signed notifications and 400 for signed garbage', () => {
  const rawBody = fixtureText('participant_left.json');
  const result = handleWebhookRequest({ rawBody, headers: signedHeaders(rawBody) }, { secret: SECRET, now: NOW_MS });
  assert.equal(result.status, 200);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'participant.left');
  assert.equal(result.events[0].requestId, '6009d653_d487_445d_8406_42b654974899');

  const garbage = 'not json';
  const bad = handleWebhookRequest({ rawBody: garbage, headers: signedHeaders(garbage) }, { secret: SECRET, now: NOW_MS });
  assert.equal(bad.status, 400);

  const noToken = '{"event":"endpoint.url_validation","payload":{},"event_ts":1}';
  assert.equal(handleWebhookRequest({ rawBody: noToken, headers: signedHeaders(noToken) }, { secret: SECRET, now: NOW_MS }).status, 400);
});

test('parseWebhook normalises participant_joined (official example payload)', () => {
  const [event] = parseWebhook(fixtureText('participant_joined.json'));
  assert.equal(event.provider, 'zoom');
  assert.equal(event.type, 'participant.joined');
  assert.equal(event.providerEventType, 'meeting.participant_joined');
  assert.match(event.id, /^zoom_[0-9a-f]{32}$/);
  assert.equal(event.occurredAt, '2021-07-14T02:44:51.572Z');
  assert.equal(event.accountId, 'AAAAAABBBB');
  assert.deepEqual(event.meeting, {
    id: '1234567890',
    uuid: '4444AAAiAAAAAiAiAiiAii==',
    hostId: 'x1yCzABCDEfg23HiJKl4mN',
    hostEmail: null,
    topic: 'My Meeting',
    type: 8,
    startTime: '2021-07-13T21:44:51.000Z',
    endTime: null,
    timezone: 'America/Los_Angeles',
    durationMinutes: 60,
  });
  assert.deepEqual(event.participant, {
    userId: '1234567890',
    zoomUserId: 'rstuvwxyza789-cde',
    participantUuid: '55555AAAiAAAAAiAiAiiAii',
    registrantId: 'abcdefghij0-klmnopq23456',
    name: 'Jill Chill',
    email: 'jchill@example.com',
    customerKey: '349589LkJyeW',
    phoneNumber: '8615250064084',
    // The official example sends `date_time`; the schema says `join_time`. Both are read.
    joinTime: '2021-07-13T21:44:51.000Z',
    leaveTime: null,
    durationSeconds: null,
    status: null,
    leaveReason: null,
    internalUser: null,
  });
  assert.equal(event.requestId, null);
});

test('parseWebhook normalises participant_left and meeting.ended', () => {
  const [left] = parseWebhook(JSON.parse(fixtureText('participant_left.json')));
  assert.equal(left.type, 'participant.left');
  assert.equal(left.participant.leaveTime, '2021-07-13T22:50:51.000Z');
  assert.equal(left.participant.leaveReason, 'Jill Chill left the meeting.<br>Reason: Host ended the meeting.');

  const [ended] = parseWebhook(Buffer.from(fixtureText('meeting_ended.json')));
  assert.equal(ended.type, 'meeting.ended');
  assert.equal(ended.participant, null);
  assert.equal(ended.meeting.endTime, '2021-07-13T23:00:51.000Z');
  assert.equal(ended.meeting.hostEmail, 'jchill@example.com');
});

test('parseWebhook keeps unknown events, ignores malformed bodies, and derives stable ids', () => {
  const [unknown] = parseWebhook('{"event":"recording.completed","event_ts":1700000000000,"payload":{"object":{"uuid":"x"}}}');
  assert.equal(unknown.type, 'unknown');
  assert.equal(unknown.providerEventType, 'recording.completed');
  assert.deepEqual(parseWebhook('nope'), []);
  assert.deepEqual(parseWebhook('{"no":"event"}'), []);
  assert.deepEqual(parseWebhook(null), []);

  const body = fixtureText('participant_joined.json');
  // Same notification re-delivered (Zoom retries), even re-serialised: same id.
  assert.equal(parseWebhook(body)[0].id, parseWebhook(JSON.stringify(JSON.parse(body), null, 2))[0].id);
  const left = parseWebhook(fixtureText('participant_left.json'))[0];
  assert.notEqual(parseWebhook(body)[0].id, left.id, 'joined and left differ');
  assert.equal(deriveEventId(JSON.parse(body)), parseWebhook(body)[0].id);
});

test('getHeader handles Headers, plain objects and missing headers', () => {
  assert.equal(getHeader(new Headers({ 'X-Zm-Signature': 'a' }), 'x-zm-signature'), 'a');
  assert.equal(getHeader({ 'X-ZM-SIGNATURE': ['b', 'c'] }, 'x-zm-signature'), 'b');
  assert.equal(getHeader({}, 'x-zm-signature'), null);
  assert.equal(getHeader(undefined, 'x-zm-signature'), null);
});

test('client.webhooks uses the configured secret and tolerance', () => {
  const now = fakeClock('2026-11-05T09:00:00Z');
  const client = createZoomClient({ ...TEST_CONFIG, webhookToleranceSeconds: 60 }, deps(fakeFetch(() => undefined), now));
  const rawBody = fixtureText('meeting_ended.json');
  const headers = signedHeaders(rawBody);
  assert.equal(client.webhooks.verify(rawBody, headers).valid, true);
  assert.equal(client.webhooks.handle({ rawBody, headers }).events[0].type, 'meeting.ended');
  now.advance(61_000);
  assert.equal(client.webhooks.verify(rawBody, headers).reason, 'timestamp_out_of_tolerance');

  const { webhookSecretToken, ...noSecret } = TEST_CONFIG;
  assert.ok(webhookSecretToken);
  const apiOnly = createZoomClient(noSecret, deps(fakeFetch(() => undefined)));
  assert.throws(() => apiOnly.webhooks.verify(rawBody, headers), { name: 'ZoomConfigError' });
});
