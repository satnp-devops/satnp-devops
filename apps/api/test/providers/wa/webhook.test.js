import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import { WaError, parseWebhook, signWebhook, verifySubscription, verifyWebhook } from '../../../src/integrations/providers/wa/index.js';
import * as f from './fixtures.js';

/** HMAC-SHA256 through WebCrypto: an independent implementation to cross-check the vectors. */
async function webcryptoHex(secret, body) {
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await webcrypto.subtle.sign('HMAC', key, typeof body === 'string' ? enc.encode(body) : body);
  return Buffer.from(sig).toString('hex');
}

// Vectors computed with node:crypto for this suite (Meta publishes no body+secret+signature triple;
// its docs show only a bare example hash). The RFC 4231 case proves the primitive itself.
const VECTORS = [
  { name: 'RFC 4231 test case 2', secret: 'Jefe', body: 'what do ya want for nothing?', hex: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843' },
  { name: 'minimal payload', secret: f.APP_SECRET, body: f.RAW_MINIMAL_BODY, hex: 'cce1a3656fcd8469c854909d9f6608bed70fe1b6246f5158c03fef751c38d736' },
  { name: 'payload with \\u escapes', secret: f.APP_SECRET, body: f.RAW_ESCAPED_BODY, hex: '09dcccc44fba165d5fd0cc25fb67e742900275bc2b97938d24c836ebe8caf87a' },
  { name: 'official text example (compact JSON)', secret: f.APP_SECRET, body: JSON.stringify(f.inboundTextOfficial), hex: '2a27f9cb5113e4562ff7b8cfca9a3d3683b0f0bcb5e9c19cc94599fc694ddfcb' },
  { name: 'minimal payload, previous secret', secret: f.OLD_APP_SECRET, body: f.RAW_MINIMAL_BODY, hex: 'a032b42bd30247a64183a939bcbc5619a6146bf9ddf17bda5cad319a0e563285' },
];

test('signature vectors match node:crypto, WebCrypto and signWebhook', async () => {
  for (const v of VECTORS) {
    assert.equal(createHmac('sha256', v.secret).update(v.body).digest('hex'), v.hex, v.name);
    assert.equal(await webcryptoHex(v.secret, v.body), v.hex, v.name);
    assert.equal(signWebhook(v.body, v.secret), `sha256=${v.hex}`, v.name);
  }
});

test('verifyWebhook accepts a valid signature for Buffer, string and Uint8Array bodies', () => {
  const sig = `sha256=${VECTORS[2].hex}`;
  for (const body of [Buffer.from(f.RAW_ESCAPED_BODY), f.RAW_ESCAPED_BODY, new TextEncoder().encode(f.RAW_ESCAPED_BODY)]) {
    assert.deepEqual(verifyWebhook(body, { 'x-hub-signature-256': sig }, f.APP_SECRET), { ok: true, secretIndex: 0 });
  }
});

test('verifyWebhook reads the header case-insensitively from objects, arrays and Headers', () => {
  const sig = `sha256=${VECTORS[1].hex}`;
  assert.equal(verifyWebhook(f.RAW_MINIMAL_BODY, { 'X-Hub-Signature-256': sig }, f.APP_SECRET).ok, true);
  assert.equal(verifyWebhook(f.RAW_MINIMAL_BODY, { 'x-hub-signature-256': [sig] }, f.APP_SECRET).ok, true);
  assert.equal(verifyWebhook(f.RAW_MINIMAL_BODY, new Headers({ 'X-Hub-Signature-256': sig }), f.APP_SECRET).ok, true);
  assert.equal(verifyWebhook(f.RAW_MINIMAL_BODY, { 'x-hub-signature-256': sig.toUpperCase().replace('SHA256=', 'sha256=') }, f.APP_SECRET).ok, true);
});

test('verifyWebhook rejects a tampered body', () => {
  const sig = `sha256=${VECTORS[2].hex}`;
  const tampered = f.RAW_ESCAPED_BODY.replace('wamid.TEST1', 'wamid.TEST2');
  assert.deepEqual(verifyWebhook(tampered, { 'x-hub-signature-256': sig }, f.APP_SECRET), { ok: false, reason: 'bad_signature' });
  const flipped = Buffer.from(f.RAW_ESCAPED_BODY);
  flipped[10] ^= 1;
  assert.equal(verifyWebhook(flipped, { 'x-hub-signature-256': sig }, f.APP_SECRET).reason, 'bad_signature');
});

test('verifyWebhook rejects a re-serialised body: verification must use the raw bytes', () => {
  const sig = `sha256=${VECTORS[2].hex}`;
  const reserialised = JSON.stringify(JSON.parse(f.RAW_ESCAPED_BODY));
  assert.notEqual(reserialised, f.RAW_ESCAPED_BODY);
  assert.equal(verifyWebhook(reserialised, { 'x-hub-signature-256': sig }, f.APP_SECRET).reason, 'bad_signature');
});

test('verifyWebhook rejects tampered, malformed and missing signatures', () => {
  const good = VECTORS[1].hex;
  const wrongDigit = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
  const check = (headers, secret = f.APP_SECRET) => verifyWebhook(f.RAW_MINIMAL_BODY, headers, secret).reason;
  assert.equal(check({ 'x-hub-signature-256': `sha256=${wrongDigit}` }), 'bad_signature');
  assert.equal(check({ 'x-hub-signature-256': `sha256=${good}` }, 'some-other-secret'), 'bad_signature');
  assert.equal(check({ 'x-hub-signature-256': good }), 'malformed_signature');
  assert.equal(check({ 'x-hub-signature-256': `sha1=${good.slice(0, 40)}` }), 'malformed_signature');
  assert.equal(check({ 'x-hub-signature-256': `sha256=${good.slice(0, 62)}` }), 'malformed_signature');
  assert.equal(check({ 'x-hub-signature-256': `sha256=${good}00` }), 'malformed_signature');
  assert.equal(check({ 'x-hub-signature': `sha1=${good.slice(0, 40)}` }), 'missing_signature');
  assert.equal(check({}), 'missing_signature');
  assert.equal(check({ 'x-hub-signature-256': `sha256=${good}` }, ''), 'missing_secret');
  assert.equal(check({ 'x-hub-signature-256': `sha256=${good}` }, [undefined, null]), 'missing_secret');
});

test('verifyWebhook accepts the previous app secret while rotating', () => {
  const sig = `sha256=${VECTORS[4].hex}`;
  assert.deepEqual(verifyWebhook(f.RAW_MINIMAL_BODY, { 'x-hub-signature-256': sig }, [f.APP_SECRET, f.OLD_APP_SECRET]), { ok: true, secretIndex: 1 });
  assert.equal(verifyWebhook(f.RAW_MINIMAL_BODY, { 'x-hub-signature-256': sig }, f.APP_SECRET).ok, false);
});

test('verifyWebhook optional staleness check: expired payloads fail, Meta retries pass by default', () => {
  const body = JSON.stringify(f.inboundTextFromAd); // newest timestamp 1762300800
  const headers = { 'x-hub-signature-256': signWebhook(body, f.APP_SECRET) };
  const at = (seconds) => () => seconds * 1000;
  assert.equal(verifyWebhook(body, headers, f.APP_SECRET, { maxAgeSeconds: 300, now: at(1762300800 + 299) }).ok, true);
  assert.deepEqual(verifyWebhook(body, headers, f.APP_SECRET, { maxAgeSeconds: 300, now: at(1762300800 + 301) }), { ok: false, reason: 'stale' });
  // No tolerance unless asked: Meta re-delivers for up to 7 days.
  assert.equal(verifyWebhook(body, headers, f.APP_SECRET, { now: at(1762300800 + 6 * 86400) }).ok, true);
  // A tampered timestamp breaks the signature before staleness is even considered.
  const forged = body.replace('1762300800', '1762309999');
  assert.equal(verifyWebhook(forged, headers, f.APP_SECRET, { maxAgeSeconds: 300, now: at(1762309999) }).reason, 'bad_signature');
});

test('verifySubscription echoes the challenge only for the right token', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': f.VERIFY_TOKEN, 'hub.challenge': '1158201444' };
  assert.deepEqual(verifySubscription(q, f.VERIFY_TOKEN), { ok: true, challenge: '1158201444' });
  assert.deepEqual(verifySubscription(new URLSearchParams(q), f.VERIFY_TOKEN), { ok: true, challenge: '1158201444' });
  assert.deepEqual(verifySubscription({ hub: { mode: 'subscribe', verify_token: f.VERIFY_TOKEN, challenge: '42' } }, f.VERIFY_TOKEN), { ok: true, challenge: '42' });
  assert.equal(verifySubscription({ ...q, 'hub.verify_token': 'wrong' }, f.VERIFY_TOKEN).reason, 'bad_token');
  assert.equal(verifySubscription({ ...q, 'hub.verify_token': `${f.VERIFY_TOKEN}x` }, f.VERIFY_TOKEN).reason, 'bad_token');
  assert.equal(verifySubscription({ ...q, 'hub.mode': 'unsubscribe' }, f.VERIFY_TOKEN).reason, 'bad_mode');
  assert.equal(verifySubscription(q, undefined).reason, 'missing_verify_token');
  assert.equal(verifySubscription({ ...q, 'hub.challenge': '<script>alert(1)</script>' }, f.VERIFY_TOKEN).reason, 'bad_challenge');
  assert.equal(verifySubscription({ ...q, 'hub.challenge': '' }, f.VERIFY_TOKEN).reason, 'bad_challenge');
});

test('parseWebhook: official inbound text example', () => {
  const [event, ...rest] = parseWebhook(f.inboundTextOfficial);
  assert.equal(rest.length, 0);
  assert.equal(event.kind, 'message.received');
  assert.equal(event.provider, 'whatsapp');
  assert.equal(event.eventId, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=');
  assert.equal(event.messageId, event.eventId);
  assert.equal(event.occurredAt, '2025-06-08T20:59:43.000Z');
  assert.equal(event.wabaId, '102290129340398');
  assert.equal(event.phoneNumberId, '106540352242922');
  assert.equal(event.displayPhoneNumber, '15550783881');
  assert.deepEqual(event.from, { phone: '+16505551234', waId: '16505551234', userId: null, name: 'Sheena Nelson', username: null });
  assert.equal(event.type, 'text');
  assert.equal(event.text, 'Does it come in another color?');
});

test('parseWebhook: raw bytes with unicode escapes and ad referral', () => {
  const [escaped] = parseWebhook(Buffer.from(f.RAW_ESCAPED_BODY));
  assert.equal(escaped.from.name, 'आशा');
  assert.equal(escaped.text, 'फीस?');
  const [ad] = parseWebhook(f.inboundTextFromAd);
  assert.equal(ad.from.phone, '+919876543210');
  assert.equal(ad.referral.sourceType, 'ad');
  assert.equal(ad.referral.sourceId, '120210000000000001');
  assert.match(ad.referral.ctwaClid, /^ARAk/);
  assert.equal(ad.referral.headline, 'Phoenix Public School');
});

test('parseWebhook: media, replies, reactions and locations', () => {
  const [image] = parseWebhook(f.inboundImage);
  assert.deepEqual(image.media, {
    kind: 'image',
    id: '1003383421387256',
    mimeType: 'image/jpeg',
    sha256: 'zbFxLoZJmL2Nv/vu6+6xNSRz7D7lZ6GsRtbD6TlxDYk=',
    caption: 'Marksheet attached',
    filename: null,
    voice: false,
    animated: false,
  });
  assert.equal(image.text, 'Marksheet attached');
  assert.equal(image.context.forwarded, true);

  const [button, quick, list] = parseWebhook(f.inboundReplies);
  assert.deepEqual(button.reply, { kind: 'button_reply', id: 'book_visit', title: 'Book a campus visit', description: null });
  assert.equal(button.context.messageId, 'wamid.OUTBOUND1');
  assert.deepEqual(quick.reply, { kind: 'button', id: 'STOP_PROMOS', title: 'Stop promotions', description: null });
  assert.deepEqual(list.reply, { kind: 'list_reply', id: 'grade_6', title: 'Class 6', description: 'Age 11+' });

  const [react, unreact, loc] = parseWebhook(f.inboundReactionAndLocation);
  assert.deepEqual(react.reaction, { messageId: 'wamid.OUTBOUND1', emoji: '\u{1F44D}' });
  assert.deepEqual(unreact.reaction, { messageId: 'wamid.OUTBOUND1', emoji: null });
  assert.equal(loc.location.latitude, 28.4595);
  assert.equal(loc.location.name, 'Home');
});

test('parseWebhook: unsupported messages carry classified errors', () => {
  const [event] = parseWebhook(f.inboundUnsupported);
  assert.equal(event.type, 'unsupported');
  assert.equal(event.errors[0].code, 131051);
  assert.equal(event.errors[0].kind, 'invalid_request');
  assert.equal(event.errors[0].details, 'Message type is currently not supported.');
});

test('parseWebhook: business-scoped user ids when the phone number is hidden', () => {
  const [event] = parseWebhook(f.inboundFromBsuid);
  assert.deepEqual(event.from, { phone: null, waId: null, userId: 'IN.13491208655302741918', name: 'Meera', username: 'meera.k' });
});

test('parseWebhook: status updates (official examples) with pricing, conversation and errors', () => {
  const [sent] = parseWebhook(f.statusSentOfficial);
  assert.equal(sent.kind, 'message.status');
  assert.equal(sent.eventId, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=:sent');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.occurredAt, '2025-06-15T23:27:53.000Z');
  assert.deepEqual(sent.pricing, { billable: true, model: 'PMP', type: 'regular', category: 'marketing' });
  assert.deepEqual(sent.conversation, { id: '72b14d6bd5407799e66f64d1b338e567', originType: 'marketing', expiresAt: '2025-06-16T23:28:00.000Z' });
  assert.equal(sent.recipient.phone, '+16505551234');

  const [v24] = parseWebhook(f.statusSentV24Official);
  assert.equal(v24.pricing, null);
  assert.equal(v24.conversation, null);

  const [failed] = parseWebhook(f.statusFailedOfficial);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errors[0].code, 131049);
  assert.equal(failed.errors[0].kind, 'recipient');
  assert.equal(failed.errors[0].retryable, true);
  assert.equal(failed.errors[0].retryAfterMs, 24 * 3600 * 1000);

  const [delivered, read] = parseWebhook(f.statusDeliveredRead);
  assert.equal(delivered.callbackData, 'outbox:01JBX7Q2');
  assert.equal(delivered.recipient.userId, 'IN.111');
  assert.equal(delivered.pricing.type, 'free_customer_service');
  assert.equal(read.eventId, 'wamid.OUT9:read');
  assert.notEqual(delivered.eventId, read.eventId);
});

test('parseWebhook: template status updates', () => {
  const [approved] = parseWebhook(f.templateApproved);
  assert.equal(approved.kind, 'template.status');
  assert.equal(approved.templateId, '1387372356726668');
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.name, 'admission_followup');
  assert.equal(approved.category, 'UTILITY');
  assert.equal(approved.eventId, 'template:1387372356726668:APPROVED:1762303000');
  assert.equal(approved.occurredAt, new Date(1762303000 * 1000).toISOString());

  const [rejected] = parseWebhook(f.templateRejected);
  assert.equal(rejected.reason, 'INVALID_FORMAT');
  assert.deepEqual(rejected.rejection, { reason: 'Variable at the end of the body', recommendation: 'Add text after the last variable' });
});

test('parseWebhook: unknown fields and change-level errors become stable events', () => {
  const [other] = parseWebhook(f.accountUpdate);
  assert.equal(other.kind, 'other');
  assert.equal(other.field, 'account_update');
  assert.match(other.eventId, /^other:account_update:[0-9a-f]{32}$/);
  assert.equal(parseWebhook(structuredClone(f.accountUpdate))[0].eventId, other.eventId);

  const [err] = parseWebhook(f.changeErrors);
  assert.equal(err.kind, 'error');
  assert.equal(err.errors[0].code, 131000);
  assert.equal(err.errors[0].retryable, true);
});

test('parseWebhook: event ids are stable across retried deliveries', () => {
  const first = parseWebhook(JSON.stringify(f.inboundReplies)).map((e) => e.eventId);
  const second = parseWebhook(f.inboundReplies).map((e) => e.eventId);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
});

test('parseWebhook: tolerates odd shapes and rejects non-JSON', () => {
  assert.deepEqual(parseWebhook({ object: 'whatsapp_business_account', entry: [] }), []);
  assert.deepEqual(parseWebhook({ object: 'whatsapp_business_account' }), []);
  const weird = parseWebhook({ object: 'page', entry: [{ id: '1', time: 1, changes: [{ field: 'feed', value: {} }] }] });
  assert.equal(weird[0].kind, 'other');
  const partial = parseWebhook(f.wrap('messages', { messages: [null, { id: 'wamid.X' }], statuses: [{}] }));
  assert.equal(partial.length, 2);
  assert.equal(partial[0].type, 'unknown');
  assert.equal(partial[0].occurredAt, null);
  assert.match(partial[1].eventId, /^status:/);
  assert.throws(() => parseWebhook('{not json'), (err) => err instanceof WaError && err.kind === 'invalid_payload');
  assert.throws(() => parseWebhook(null), (err) => err instanceof WaError && err.kind === 'invalid_payload');
});
