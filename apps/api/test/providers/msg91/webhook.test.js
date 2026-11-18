import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  classifyFailureReason,
  createMsg91Client,
  deriveWebhookToken,
  parseWebhook,
  safeEqual,
  toMoney,
  toUtcIso,
  verifyWebhook,
  Msg91Error,
} from '../../../src/integrations/providers/msg91/index.js';
import { WEBHOOK_SECRET, baseConfig } from './helpers.js';

// Sample payloads copied from MSG91's help centre (read 2026-11-05); masked digits are MSG91's.
// Webhook (New), SMS "On Report Received": msg91.com/help/webhook-new/how-to-receive-sms-delivery-reports-via-webhook-new
const NEW_SMS = {
  pluginsource: '',
  requestedAt: '2026-03-19T16:57:59+05:30',
  status: '1',
  deliveryTime: '2026-03-19T16:58:07+05:30',
  telNum: '919XXXXXXXXX',
  credit: '0.25',
  senderId: 'wxxxxx',
  campaignName: 'WXXXXX',
  route: '4',
  campaign_pid: '0',
  clientId: '',
  userId: '4XXXXX',
  ts: '2026-03-19T16:58:19+05:30',
  CRQID: '0',
  requestId: '69XXXXXXXXXXXXXXXXXXXXXXX3',
  UUID: '0',
  INMSID: '0',
  DLT_TE_ID: '13XXXXXXXXXXXXXXXXX7',
  eventName: 'delivered',
  event: 'delivered',
  failureReason: '',
  smsLength: '1',
  upperCaseEventName: 'DELIVERED',
};
// SendOTP report webhook: msg91.com/help/webhook-new/how-to-receive-otp-delivery-reports-via-webhook
const OTP_REPORT = {
  CRQID: '0',
  requestedAt: '2025-07-19T06:56:28.000Z',
  requestId: '3567736c7a4164736a357955',
  telNum: '917748847990',
  countryName: 'India',
  status: '1',
  senderId: 'TXTAPI',
  deliveryTime: '2025-07-19T12:26:29.000Z',
  credit: '0.22',
  smsLength: '1',
  pauseReason: '',
  voiceRetryCount: '',
  otpRetry: '',
  verified: '',
  failureReason: '',
  userIp: '2600:1900:0:3902::700',
  flowID: '63ef3040d6fc054462756d53',
  DLT_TE_ID: '1307160975559044358',
  campaignName: 'Testing',
  telecomCircle: 'Madhya Pradesh & Chhattisgarh',
  circleDescription: 'State of Madhya Pradesh and State of Chhattisgarh',
};
// Legacy v2 (x-www-form-urlencoded, `data` is a JSON string): msg91.com/help/webhooks/how-can-i-get-the-delivery-reports-on-my-webhook-url
const V2_DATA =
  '[{"senderId":"uXXXXm","requestId":"346XXXXXXXXXXXX130","report":[{"date":"2024-05-22 10:06:20","amount":"0.01","clientid":"","INMSID":"0","CRQID":"0","ctCode":"900","number":"9195XXXX6558","credit":"1","status":"1","desc":"DELIVERED","failedReason":""}],"userId":"27XXXX","campaignName":"Sendhttp"}]';
const V2_FAILED =
  '[{"senderId":"TESTIN","requestId":"33666d73756c393431393033","report":[{"date":"2023-06-13 19:21:13","number":"91888888888","clientid":"12345","CRQID":"Beta2","status":"2","desc":"FAILED","failedReason":"Template Inactive on DLT"}],"userId":"12345","campaignName":"API"}]';
const V3 = {
  date: '2024-05-22 09:58:16',
  number: '9195XXXX6558',
  senderId: 'uXXXXm',
  amount: '0.01',
  requestId: '346XXXXXXXXXXXX130',
  INMSID: '0',
  CRQID: '0',
  credit: '1',
  userId: '27XXXX',
  campaignName: 'Sendhttp',
  status: '1',
  desc: 'DELIVERED',
};
const V4 = [{ data: [{ meta: '0', INMSID: '0', description: 'DELIVERED', ts: 1745494489 }], event: 'delivered' }];

// ---------------------------------------------------------------------------------------------
// Verification (shared-secret header; MSG91 does not sign webhooks)
// ---------------------------------------------------------------------------------------------

const RAW = JSON.stringify(NEW_SMS);

test('valid: the configured secret in the custom header is accepted (any header case, Headers instance)', () => {
  assert.deepEqual(verifyWebhook(RAW, { 'x-phoenix-webhook-token': WEBHOOK_SECRET }, WEBHOOK_SECRET), { ok: true, method: 'header' });
  assert.deepEqual(verifyWebhook(Buffer.from(RAW), { 'X-Phoenix-Webhook-Token': WEBHOOK_SECRET }, WEBHOOK_SECRET), { ok: true, method: 'header' });
  assert.deepEqual(verifyWebhook(RAW, new Headers({ 'x-phoenix-webhook-token': WEBHOOK_SECRET }), WEBHOOK_SECRET), { ok: true, method: 'header' });
  assert.deepEqual(verifyWebhook(RAW, { 'x-hook': WEBHOOK_SECRET }, WEBHOOK_SECRET, { headerName: 'X-Hook' }), { ok: true, method: 'header' });
});

test('tampered: a wrong, truncated or extended token is rejected', () => {
  for (const token of [`${WEBHOOK_SECRET}x`, WEBHOOK_SECRET.slice(0, -1), WEBHOOK_SECRET.toUpperCase(), 'x'.repeat(WEBHOOK_SECRET.length)]) {
    assert.deepEqual(verifyWebhook(RAW, { 'x-phoenix-webhook-token': token }, WEBHOOK_SECRET), { ok: false, reason: 'mismatch' });
  }
  assert.deepEqual(verifyWebhook(RAW, {}, WEBHOOK_SECRET), { ok: false, reason: 'missing_token' });
  assert.deepEqual(verifyWebhook(RAW, { 'x-phoenix-webhook-token': [WEBHOOK_SECRET, WEBHOOK_SECRET] }, WEBHOOK_SECRET), { ok: false, reason: 'ambiguous_token' });
});

test('expired: a secret rotated out is rejected; during rotation both are accepted', () => {
  const previous = 'whsec-previous-0123456789';
  assert.equal(verifyWebhook(RAW, { 'x-phoenix-webhook-token': previous }, [WEBHOOK_SECRET, previous]).ok, true);
  assert.deepEqual(verifyWebhook(RAW, { 'x-phoenix-webhook-token': previous }, WEBHOOK_SECRET), { ok: false, reason: 'mismatch' });
});

test('replays carry no timestamp to expire, so the same payload always yields the same eventId for dedupe', () => {
  const [first] = parseWebhook(RAW);
  const [replay] = parseWebhook(Buffer.from(RAW));
  assert.equal(first.eventId, replay.eventId);
  assert.equal(first.eventId, 'msg91:69XXXXXXXXXXXXXXXXXXXXXXX3:919XXXXXXXXX:1');
});

test('misconfiguration and bad bodies fail closed', () => {
  assert.deepEqual(verifyWebhook(RAW, { 'x-phoenix-webhook-token': 'short' }, 'short'), { ok: false, reason: 'secret_not_configured' });
  assert.deepEqual(verifyWebhook(RAW, { 'x-phoenix-webhook-token': '' }, undefined), { ok: false, reason: 'secret_not_configured' });
  assert.deepEqual(verifyWebhook('', { 'x-phoenix-webhook-token': WEBHOOK_SECRET }, WEBHOOK_SECRET), { ok: false, reason: 'invalid_body' });
  assert.deepEqual(verifyWebhook(undefined, { 'x-phoenix-webhook-token': WEBHOOK_SECRET }, WEBHOOK_SECRET), { ok: false, reason: 'invalid_body' });
  assert.deepEqual(verifyWebhook('x'.repeat(256 * 1024 + 1), { 'x-phoenix-webhook-token': WEBHOOK_SECRET }, WEBHOOK_SECRET), { ok: false, reason: 'body_too_large' });
});

test('legacy webhooks: query token only when explicitly allowed', () => {
  const url = `/webhooks/msg91/conn_1?token=${encodeURIComponent(WEBHOOK_SECRET)}`;
  assert.deepEqual(verifyWebhook(RAW, {}, WEBHOOK_SECRET, { url }), { ok: false, reason: 'missing_token' });
  assert.deepEqual(verifyWebhook(RAW, {}, WEBHOOK_SECRET, { url, allowQueryToken: true }), { ok: true, method: 'query' });
  assert.deepEqual(verifyWebhook(RAW, {}, WEBHOOK_SECRET, { url: '/w?token=nope-nope-nope-nope', allowQueryToken: true }), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verifyWebhook(RAW, {}, WEBHOOK_SECRET, { url: `${url}&token=x`, allowQueryToken: true }), { ok: false, reason: 'ambiguous_token' });
});

test('client.verifyWebhook uses the connection secret and header name', () => {
  const sms = createMsg91Client(baseConfig(), { fetch: async () => new Response('') });
  assert.equal(sms.verifyWebhook(RAW, { 'x-phoenix-webhook-token': WEBHOOK_SECRET }).ok, true);
  assert.equal(sms.verifyWebhook(RAW, { 'x-phoenix-webhook-token': 'wrong-wrong-wrong-wrong' }).ok, false);
});

test('signature test vectors (computed with node:crypto): HMAC sanity per RFC 4231 and deriveWebhookToken', () => {
  // RFC 4231 test case 2 proves the HMAC-SHA256 primitive used by deriveWebhookToken.
  assert.equal(createHmac('sha256', 'Jefe').update('what do ya want for nothing?').digest('hex'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  // deriveWebhookToken = base64url(HMAC-SHA256(masterKey, "msg91-webhook:v1:" + scope)).
  assert.equal(deriveWebhookToken('phoenix-test-master-key-0001', 'conn_01HZX3Y8K2'), 'cD9__sxCzYy3rddDKvC4iPSmIKzEhDcDCIXVFPz5IOg');
  assert.equal(deriveWebhookToken('another-master-key-for-tests!', 'company-42'), 'FqbNK4wbsM_TuAMctT3eo7AXsLwEaEj2TMCTgtZjrVY');
  assert.equal(
    deriveWebhookToken('phoenix-test-master-key-0001', 'conn_01HZX3Y8K2'),
    createHmac('sha256', 'phoenix-test-master-key-0001').update('msg91-webhook:v1:conn_01HZX3Y8K2').digest('base64url'),
  );
  const token = deriveWebhookToken('phoenix-test-master-key-0001', 'conn_01HZX3Y8K2');
  assert.equal(verifyWebhook(RAW, { 'x-phoenix-webhook-token': token }, token).ok, true);
  assert.throws(() => deriveWebhookToken('short', 'x'), TypeError);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

test('Webhook (New) SMS report → normalised delivered event', () => {
  const [event] = parseWebhook(NEW_SMS);
  const { raw, ...rest } = event;
  assert.deepEqual(rest, {
    provider: 'msg91',
    eventId: 'msg91:69XXXXXXXXXXXXXXXXXXXXXXX3:919XXXXXXXXX:1',
    type: 'message.delivered',
    status: 'delivered',
    final: true,
    providerStatusCode: '1',
    providerStatus: 'DELIVERED',
    format: 'webhook_new',
    requestId: '69XXXXXXXXXXXXXXXXXXXXXXX3',
    providerMessageId: '69XXXXXXXXXXXXXXXXXXXXXXX3:919XXXXXXXXX',
    to: '919XXXXXXXXX',
    reference: null,
    uuid: null,
    clientId: null,
    senderId: 'wxxxxx',
    dltTemplateId: '13XXXXXXXXXXXXXXXXX7',
    templateId: null,
    route: 'transactional',
    occurredAt: '2026-03-19T11:28:07.000Z',
    requestedAt: '2026-03-19T11:27:59.000Z',
    failure: null,
    segments: 1,
    cost: { amountMinor: 25, currency: 'INR', exact: true },
  });
  assert.equal(raw.INMSID, '0');
});

test('SendOTP report webhook → delivered event with flow id', () => {
  const [event] = parseWebhook(JSON.stringify(OTP_REPORT));
  assert.equal(event.format, 'otp');
  assert.equal(event.type, 'message.delivered');
  assert.equal(event.templateId, '63ef3040d6fc054462756d53');
  assert.equal(event.requestedAt, '2025-07-19T06:56:28.000Z');
  assert.equal(event.cost.amountMinor, 22);
});

test('legacy v2 form-encoded body (raw string and pre-parsed object) → one event per report', () => {
  const raw = `data=${encodeURIComponent(V2_DATA)}`;
  for (const body of [raw, Buffer.from(raw), { data: V2_DATA }]) {
    const events = parseWebhook(body);
    assert.equal(events.length, 1);
    const [e] = events;
    assert.equal(e.format, 'v2');
    assert.equal(e.status, 'delivered');
    assert.equal(e.to, '9195XXXX6558');
    assert.equal(e.requestId, '346XXXXXXXXXXXX130');
    assert.equal(e.senderId, 'uXXXXm');
    assert.equal(e.occurredAt, '2024-05-22T04:36:20.000Z', 'naive MSG91 times are IST');
    assert.deepEqual(e.cost, { amountMinor: 1, currency: 'INR', exact: true });
    assert.equal(e.segments, 1);
  }
});

test('failed report with a DLT reason and our CRQID reference', () => {
  const [e] = parseWebhook({ data: V2_FAILED });
  assert.equal(e.type, 'message.failed');
  assert.equal(e.reference, 'Beta2');
  assert.equal(e.clientId, '12345');
  assert.deepEqual(e.failure, { reason: 'Template Inactive on DLT', category: 'dlt', permanent: true });
});

test('v3 flat JSON and v4 CleverTap payloads', () => {
  const [v3] = parseWebhook(V3);
  assert.equal(v3.format, 'v3');
  assert.equal(v3.status, 'delivered');
  assert.equal(v3.occurredAt, '2024-05-22T04:28:16.000Z');

  const [v4] = parseWebhook(V4);
  assert.equal(v4.format, 'v4');
  assert.equal(v4.status, 'delivered');
  assert.equal(v4.occurredAt, '2025-04-24T11:34:49.000Z');
  assert.match(v4.eventId, /^msg91:sha256:[0-9a-f]{32}$/);
  assert.equal(parseWebhook(V4)[0].eventId, v4.eventId);
});

test('status codes map to normalised statuses', () => {
  const at = (status, extra = {}) => parseWebhook({ ...NEW_SMS, status, eventName: '', event: '', upperCaseEventName: '', ...extra })[0];
  assert.equal(at('0').status, 'sent');
  assert.equal(at('0').final, false);
  assert.equal(at('2', { failureReason: 'Absent Subscriber' }).failure.category, 'subscriber_unavailable');
  assert.equal(at('2', { failureReason: 'Absent Subscriber' }).failure.permanent, false);
  assert.deepEqual(at('9').failure, { reason: 'NDNC', category: 'dnd', permanent: true });
  assert.equal(at('16').status, 'rejected');
  assert.equal(at('25').type, 'message.rejected');
  assert.equal(at('17').status, 'blocked');
  assert.equal(at('20').failure.category, 'country_blocked');
  assert.equal(at('99').status, 'unknown');
  assert.equal(at('', { eventName: 'url click', ts: '2026-03-19T17:00:00+05:30' }).type, 'message.clicked');
  assert.notEqual(at('', { eventName: 'url click', deliveryTime: '2026-03-19T17:00:00+05:30' }).eventId, at('', { eventName: 'url click', deliveryTime: '2026-03-19T17:05:00+05:30' }).eventId);
  // Successive statuses of one message get distinct ids.
  assert.notEqual(at('0').eventId, at('1').eventId);
});

test('arrays of reports produce one event each; malformed bodies throw invalid_webhook_payload', () => {
  assert.equal(parseWebhook([NEW_SMS, { ...NEW_SMS, telNum: '919811111111' }]).length, 2);
  for (const bad of ['', 'not json', '{"a":', 'data=%7B', null, 42, [1]]) {
    assert.throws(() => parseWebhook(bad), (err) => err instanceof Msg91Error && err.code === 'invalid_webhook_payload', String(bad));
  }
});

test('failure reasons from MSG91’s list are categorised', () => {
  assert.deepEqual(classifyFailureReason('Preference not matched in DLT'), { category: 'dnd', permanent: true });
  assert.deepEqual(classifyFailureReason('CTA not Whitelisted on DLT'), { category: 'dlt', permanent: true });
  assert.deepEqual(classifyFailureReason('Unknown Subscriber'), { category: 'invalid_number', permanent: true });
  assert.deepEqual(classifyFailureReason('Network Congestion'), { category: 'network', permanent: false });
  assert.deepEqual(classifyFailureReason('Blackout Time'), { category: 'blackout_time', permanent: false });
  assert.deepEqual(classifyFailureReason('Destination Flooding'), { category: 'spam_or_duplicate', permanent: true });
  assert.deepEqual(classifyFailureReason(null), { category: 'unknown', permanent: false });
});

test('time and money helpers', () => {
  assert.equal(toUtcIso('2025-07-09 11:29:46'), '2025-07-09T05:59:46.000Z');
  assert.equal(toUtcIso('2025-07-08 08:20:26.259000'), '2025-07-08T02:50:26.259Z');
  assert.equal(toUtcIso('2026-03-19T16:57:59+05:30'), '2026-03-19T11:27:59.000Z');
  assert.equal(toUtcIso('1745494489'), '2025-04-24T11:34:49.000Z');
  assert.equal(toUtcIso('1745494489123'), '2025-04-24T11:34:49.123Z');
  assert.equal(toUtcIso(''), null);
  assert.equal(toUtcIso('garbage'), null);
  assert.deepEqual(toMoney('0.20', 'INR'), { amountMinor: 20, currency: 'INR', exact: true });
  assert.deepEqual(toMoney('12', 'INR'), { amountMinor: 1200, currency: 'INR', exact: true });
  assert.deepEqual(toMoney('0.135', 'INR'), { amountMinor: 14, currency: 'INR', exact: false });
  assert.deepEqual(toMoney('0.1340', 'INR'), { amountMinor: 13, currency: 'INR', exact: false });
  assert.deepEqual(toMoney('0.1500', 'INR'), { amountMinor: 15, currency: 'INR', exact: true });
  assert.equal(toMoney('-1', 'INR'), null);
  assert.equal(toMoney('', 'INR'), null);
});
