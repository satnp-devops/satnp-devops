import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarIdFromResourceUri,
  createChannelToken,
  parseWebhook,
  verifyWebhook,
} from '../../../src/integrations/providers/google/index.js';
import { CHANNEL_SECRET, NOW, makeClient } from './_helpers.js';

const CHANNEL_ID = '4ba78bf0-6a47-11e2-bcfd-0800200c9a66';
// Computed independently with node:crypto and `openssl dgst -sha256 -hmac` (both agree):
// HMAC-SHA256(key = CHANNEL_SECRET, msg = "v1.4ba78bf0-6a47-11e2-bcfd-0800200c9a66.1700000000"), base64url.
const VECTOR_TOKEN = 'v1.1700000000.hKaa_WnLX4AWsvDq0JFjhwfW-3nxTi-kyy60TBNrg-8';

/** Headers as Google documents them (Express lower-cases names; the example has a double space after some colons). */
function notification({ token, state = 'exists', number = '10', channelId = CHANNEL_ID } = {}) {
  return {
    'content-type': 'application/json; utf-8',
    'content-length': '0',
    'user-agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
    'x-goog-channel-id': channelId,
    'x-goog-channel-token': token,
    'x-goog-channel-expiration': 'Tue, 12 Nov 2026 01:13:52 GMT',
    'x-goog-resource-id': ' ret08u3rv24htgh289g',
    'x-goog-resource-uri': 'https://www.googleapis.com/calendar/v3/calendars/counsellor%40phoenix-school.example.in/events?alt=json',
    'x-goog-resource-state': ` ${state}`,
    'x-goog-message-number': number,
  };
}

test('channel token matches the independently computed HMAC vector', () => {
  assert.equal(createChannelToken(CHANNEL_SECRET, CHANNEL_ID, 1700000000_000), VECTOR_TOKEN);
  assert.ok(VECTOR_TOKEN.length <= 256);
});

test('valid notification verifies', () => {
  const result = verifyWebhook('', notification({ token: VECTOR_TOKEN }), CHANNEL_SECRET, { now: 1699999000_000 });
  assert.deepEqual(result, { ok: true, channelId: CHANNEL_ID, expiresAtMs: 1700000000_000 });
});

test('works with a WHATWG Headers object and mixed-case names', () => {
  const headers = new Headers({ 'X-Goog-Channel-ID': CHANNEL_ID, 'X-Goog-Channel-Token': VECTOR_TOKEN, 'X-Goog-Resource-ID': 'r', 'X-Goog-Resource-State': 'sync', 'X-Goog-Message-Number': '1' });
  assert.equal(verifyWebhook(null, headers, CHANNEL_SECRET, { now: 1699999000_000 }).ok, true);
  const plain = { 'X-Goog-Channel-ID': CHANNEL_ID, 'X-Goog-Channel-Token': VECTOR_TOKEN, 'X-Goog-Resource-ID': 'r', 'X-Goog-Resource-State': 'sync', 'X-Goog-Message-Number': ['1'] };
  assert.equal(verifyWebhook(null, plain, CHANNEL_SECRET, { now: 1699999000_000 }).ok, true);
});

test('tampered signature, exp or channel id is rejected', () => {
  const now = 1699999000_000;
  const i = VECTOR_TOKEN.length - 10;
  const flipped = VECTOR_TOKEN.slice(0, i) + (VECTOR_TOKEN[i] === 'A' ? 'B' : 'A') + VECTOR_TOKEN.slice(i + 1);
  assert.deepEqual(verifyWebhook('', notification({ token: flipped }), CHANNEL_SECRET, { now }), { ok: false, reason: 'bad_signature' });
  // Same bytes, non-canonical spelling (last char differs only in its 2 unused bits): rejected.
  const nonCanonical = VECTOR_TOKEN.slice(0, -1) + '9';
  assert.deepEqual(verifyWebhook('', notification({ token: nonCanonical }), CHANNEL_SECRET, { now }), { ok: false, reason: 'malformed_token' });
  const laterExp = VECTOR_TOKEN.replace('1700000000', '1800000000');
  assert.deepEqual(verifyWebhook('', notification({ token: laterExp }), CHANNEL_SECRET, { now }), { ok: false, reason: 'bad_signature' });
  const otherChannel = notification({ token: VECTOR_TOKEN, channelId: 'another-channel' });
  assert.deepEqual(verifyWebhook('', otherChannel, CHANNEL_SECRET, { now }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWebhook('', notification({ token: VECTOR_TOKEN }), 'a-different-secret-of-sufficient-length', { now }), {
    ok: false,
    reason: 'bad_signature',
  });
});

test('expired channel tokens are rejected after the tolerance', () => {
  const headers = notification({ token: VECTOR_TOKEN });
  assert.equal(verifyWebhook('', headers, CHANNEL_SECRET, { now: 1700000000_000 + 299_000 }).ok, true);
  assert.deepEqual(verifyWebhook('', headers, CHANNEL_SECRET, { now: 1700000000_000 + 301_000 }), { ok: false, reason: 'expired' });
  assert.equal(verifyWebhook('', headers, CHANNEL_SECRET, { now: 1700000000_000 + 301_000, toleranceSeconds: 600 }).ok, true);
});

test('missing or malformed tokens and headers are rejected', () => {
  const now = 1699999000_000;
  assert.deepEqual(verifyWebhook('', notification({ token: undefined }), CHANNEL_SECRET, { now }), { ok: false, reason: 'missing_token' });
  assert.deepEqual(verifyWebhook('', notification({ token: 'static-token' }), CHANNEL_SECRET, { now }), { ok: false, reason: 'malformed_token' });
  assert.deepEqual(verifyWebhook('', notification({ token: 'v1.1700000000.short' }), CHANNEL_SECRET, { now }), { ok: false, reason: 'malformed_token' });
  const { 'x-goog-resource-id': _drop, ...noResource } = notification({ token: VECTOR_TOKEN });
  assert.deepEqual(verifyWebhook('', noResource, CHANNEL_SECRET, { now }), { ok: false, reason: 'missing_headers' });
  assert.deepEqual(verifyWebhook('', {}, CHANNEL_SECRET, { now }), { ok: false, reason: 'missing_headers' });
  assert.deepEqual(verifyWebhook('', notification({ token: VECTOR_TOKEN }), '', { now }), { ok: false, reason: 'no_secret' });
});

test('a previous secret is still accepted during rotation', () => {
  const token = createChannelToken('old-secret-old-secret-old-secret-00', CHANNEL_ID, 1700000000_000);
  const result = verifyWebhook('', notification({ token }), [CHANNEL_SECRET, 'old-secret-old-secret-old-secret-00'], { now: 1699999000_000 });
  assert.equal(result.ok, true);
});

test('client.verifyWebhook uses the configured secret and clock', async () => {
  const { client } = makeClient([]);
  const token = createChannelToken(CHANNEL_SECRET, CHANNEL_ID, NOW + 3600_000);
  assert.equal(client.verifyWebhook('', notification({ token })).ok, true);
});

test('parseWebhook normalises a change notification', () => {
  const events = parseWebhook('', notification({ token: VECTOR_TOKEN }));
  assert.deepEqual(events, [
    {
      provider: 'google',
      id: `${CHANNEL_ID}:10`,
      type: 'calendar.events.changed',
      channelId: CHANNEL_ID,
      resourceId: 'ret08u3rv24htgh289g',
      resourceUri: 'https://www.googleapis.com/calendar/v3/calendars/counsellor%40phoenix-school.example.in/events?alt=json',
      resourceState: 'exists',
      messageNumber: 10,
      calendarId: 'counsellor@phoenix-school.example.in',
      channelExpiresAt: '2026-11-12T01:13:52.000Z',
      requiresSync: true,
    },
  ]);
});

test('parseWebhook handles sync and not_exists states and ignores junk', () => {
  const [sync] = parseWebhook('', notification({ token: VECTOR_TOKEN, state: 'sync', number: '1' }));
  assert.equal(sync.type, 'calendar.channel.sync');
  assert.equal(sync.id, `${CHANNEL_ID}:1`);
  assert.equal(sync.requiresSync, false);
  const [gone] = parseWebhook('', notification({ token: VECTOR_TOKEN, state: 'not_exists', number: '11' }));
  assert.equal(gone.type, 'calendar.events.resource_gone');
  const [odd] = parseWebhook('', notification({ token: VECTOR_TOKEN, state: 'surprise', number: '12' }));
  assert.equal(odd.type, 'calendar.unknown');
  assert.deepEqual(parseWebhook('', {}), []);
  assert.deepEqual(parseWebhook('', notification({ token: VECTOR_TOKEN, number: 'x' })), []);
});

test('calendarIdFromResourceUri decodes the calendar segment', () => {
  assert.equal(calendarIdFromResourceUri('https://www.googleapis.com/calendar/v3/calendars/my_calendar@gmail.com/events'), 'my_calendar@gmail.com');
  assert.equal(calendarIdFromResourceUri('https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json&eventTypes=default'), 'primary');
  assert.equal(calendarIdFromResourceUri('https://www.googleapis.com/calendar/v3/users/me/calendarList'), null);
  assert.equal(calendarIdFromResourceUri(null), null);
});
