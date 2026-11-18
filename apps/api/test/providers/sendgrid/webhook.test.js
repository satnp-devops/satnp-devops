import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyWebhook, loadPublicKey, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../../../src/integrations/providers/sendgrid/index.js';

// Official vectors from the sendgrid-nodejs EventWebhook helper spec
// (packages/eventwebhook/src/eventwebhook.spec.js).
const OFFICIAL = {
  publicKey:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==',
  signature: 'MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=',
  timestamp: '1600112502',
  payload:
    JSON.stringify([
      {
        email: 'hello@world.com',
        event: 'dropped',
        reason: 'Bounced Address',
        sg_event_id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',
        sg_message_id: 'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0',
        'smtp-id': '<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>',
        timestamp: 1600112492,
      },
    ]) + '\r\n',
};

const MULTIPLE_EVENTS = [
  {
    email: 'invalid@gmail.com',
    event: 'processed',
    send_at: 0,
    sg_event_id: 'cHJvY2Vzc2VkLTE5OTQyMTEyLXFOd0JMZ1BRUWpXNkRKdktRd1NBYnctMA',
    sg_message_id: 'qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0',
    'smtp-id': '<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>',
    timestamp: 1619651146,
  },
  {
    email: 'invalid@gmail.com',
    event: 'bounce',
    ip: '167.89.101.76',
    reason:
      '552 5.2.2 The email account that you tried to reach is over quota and inactive. Please direct the recipient to https://support.google.com/mail/?p=OverQuotaPerm c17si1130468pgv.34 - gsmtp',
    sg_event_id: 'Ym91bmNlLTAtMTk5NDIxMTItcU53QkxnUFFRalc2REp2S1F3U0Fidy0w',
    sg_message_id: 'qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0',
    'smtp-id': '<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>',
    status: '5.2.2',
    timestamp: 1619651147,
    tls: 1,
    type: 'blocked',
  },
];
const OFFICIAL_MULTIPLE = {
  publicKey:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ4LIFtWztlsF7skFqOncjD1lun4H5w8XOhyOArHW9RcIx/FfEzx6cikC/yPfUvwaX/JScE7Fc9CJD2afQ9Ok3Q==',
  signature: 'MEYCIQC/I4o6vCgqRYrTljjoVWB/GRWNtxeePlLMHr3x9ETeRQIhAIpV+03nREPTTHWSW0wIOA0EoMPdcNgXa70yCaqDJlu5',
  timestamp: '1619651159',
  payload: JSON.stringify(MULTIPLE_EVENTS).split('},{').join('},\r\n{') + '\r\n',
};

// Vector computed for this repo with node:crypto (generateKeyPairSync('ec', prime256v1) and
// sign('sha256', timestamp + payload)). Fixed so a regression in key loading shows up.
const OWN = {
  publicKey:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2ygvDwlRny56Eqv4ctMclSMPVWs1UKY0/AAyubrnDQaCo2SGxnEWkQz/1WX17dV32jcpFfDXgkEYcQznL8eFfQ==',
  signature: 'MEUCIGEjuLSRoJzEdl0Sf3b6ZR4Imf1C96snMY1/Vy7vu6RwAiEAk5gvNwmEm4MANH7tOiA4LcExbMxlR4PqFVI3nf/TIjg=',
  timestamp: '1730800000',
  payload:
    '[{"email":"parent@example.in","timestamp":1730799990,"event":"delivered","sg_event_id":"rWVYmVk90MjZJ9iohOBa3w==","sg_message_id":"14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0","phoenix_message_id":"msg_01HZX","response":"250 OK"}]\r\n',
};

const headersFor = (/** @type {{ signature: string, timestamp: string }} */ v) => ({
  [SIGNATURE_HEADER]: v.signature,
  [TIMESTAMP_HEADER]: v.timestamp,
});

test('official single-event vector verifies, on string and Buffer bodies', () => {
  assert.deepEqual(verifyWebhook(OFFICIAL.payload, headersFor(OFFICIAL), OFFICIAL.publicKey), { ok: true, timestamp: 1600112502 });
  assert.equal(verifyWebhook(Buffer.from(OFFICIAL.payload), headersFor(OFFICIAL), OFFICIAL.publicKey).ok, true);
});

test('official multi-event vector verifies', () => {
  assert.equal(verifyWebhook(OFFICIAL_MULTIPLE.payload, headersFor(OFFICIAL_MULTIPLE), OFFICIAL_MULTIPLE.publicKey).ok, true);
});

test('own fixed vector verifies', () => {
  assert.equal(verifyWebhook(OWN.payload, headersFor(OWN), OWN.publicKey).ok, true);
});

test('official negative cases: wrong key, bad payload, bad signature, bad timestamp', () => {
  const otherKey =
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqTxd43gyp8IOEto2LdIfjRQrIbsd4SXZkLW6jDutdhXSJCWHw8REntlo7aNDthvj+y7GjUuFDb/R1NGe1OPzpA==';
  assert.deepEqual(verifyWebhook(OFFICIAL.payload, headersFor(OFFICIAL), otherKey), { ok: false, reason: 'signature_mismatch', timestamp: 1600112502 });
  assert.equal(verifyWebhook('payload', headersFor(OFFICIAL), OFFICIAL.publicKey).reason, 'signature_mismatch');
  const badSig = 'MEUCIQCtIHJeH93Y+qpYeWrySphQgpNGNr/U+UyUlBkU6n7RAwIgJTz2C+8a8xonZGi6BpSzoQsbVRamr2nlxFDWYNH3j/0=';
  assert.equal(verifyWebhook(OFFICIAL.payload, { ...headersFor(OFFICIAL), [SIGNATURE_HEADER]: badSig }, OFFICIAL.publicKey).ok, false);
  assert.equal(verifyWebhook(OFFICIAL.payload, { ...headersFor(OFFICIAL), [TIMESTAMP_HEADER]: 'timestamp' }, OFFICIAL.publicKey).reason, 'invalid_timestamp');
});

test('raw bytes matter: re-serialised JSON or a dropped CRLF fails', () => {
  const reserialised = JSON.stringify(JSON.parse(OFFICIAL.payload));
  assert.equal(verifyWebhook(reserialised, headersFor(OFFICIAL), OFFICIAL.publicKey).ok, false);
  assert.equal(verifyWebhook(OFFICIAL.payload.trimEnd(), headersFor(OFFICIAL), OFFICIAL.publicKey).ok, false);
});

test('tampered body, tampered timestamp and swapped signature are rejected', () => {
  const tampered = OWN.payload.replace('delivered', 'bounce');
  assert.equal(verifyWebhook(tampered, headersFor(OWN), OWN.publicKey).reason, 'signature_mismatch');
  assert.equal(verifyWebhook(OWN.payload, { ...headersFor(OWN), [TIMESTAMP_HEADER]: '1730800001' }, OWN.publicKey).reason, 'signature_mismatch');
  assert.equal(verifyWebhook(OWN.payload, { ...headersFor(OWN), [SIGNATURE_HEADER]: OFFICIAL.signature }, OWN.publicKey).ok, false);
});

test('freshly signed requests verify with header lookups in any case and Headers objects', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const body = Buffer.from('[{"event":"open","sg_event_id":"abc","email":"a@b.in"}]\r\n');
  const ts = '1762300000';
  const signature = sign('sha256', Buffer.concat([Buffer.from(ts), body]), privateKey).toString('base64');
  const lower = { 'x-twilio-email-event-webhook-signature': signature, 'x-twilio-email-event-webhook-timestamp': ts };
  assert.equal(verifyWebhook(body, lower, spki).ok, true);
  assert.equal(verifyWebhook(body, new Headers(lower), pem).ok, true);
  assert.equal(verifyWebhook(body, { ...lower, 'x-twilio-email-event-webhook-signature': [signature] }, spki).ok, true);
});

test('timestamp tolerance: off by default, rejects expired and future timestamps when set', () => {
  const now = () => (1730800000 + 600) * 1000;
  assert.equal(verifyWebhook(OWN.payload, headersFor(OWN), OWN.publicKey, { now }).ok, true);
  assert.deepEqual(verifyWebhook(OWN.payload, headersFor(OWN), OWN.publicKey, { now, toleranceSeconds: 300 }), {
    ok: false,
    reason: 'timestamp_out_of_tolerance',
    timestamp: 1730800000,
  });
  assert.equal(verifyWebhook(OWN.payload, headersFor(OWN), OWN.publicKey, { now, toleranceSeconds: 900 }).ok, true);
  const past = () => (1730800000 - 600) * 1000;
  assert.equal(verifyWebhook(OWN.payload, headersFor(OWN), OWN.publicKey, { now: past, toleranceSeconds: 300 }).reason, 'timestamp_out_of_tolerance');
});

test('missing or malformed inputs fail closed with a reason', () => {
  assert.equal(verifyWebhook(OWN.payload, {}, OWN.publicKey).reason, 'missing_signature');
  assert.equal(verifyWebhook(OWN.payload, { [SIGNATURE_HEADER]: OWN.signature }, OWN.publicKey).reason, 'missing_timestamp');
  assert.equal(verifyWebhook(OWN.payload, { ...headersFor(OWN), [SIGNATURE_HEADER]: 'not base64!' }, OWN.publicKey).reason, 'malformed_signature');
  assert.equal(verifyWebhook(OWN.payload, { ...headersFor(OWN), [SIGNATURE_HEADER]: 'AAAA' }, OWN.publicKey).ok, false);
  assert.equal(verifyWebhook(OWN.payload, headersFor(OWN), 'not-a-key').reason, 'invalid_public_key');
  assert.equal(verifyWebhook(/** @type {any} */ ({ parsed: true }), headersFor(OWN), OWN.publicKey).reason, 'invalid_body');
});

test('loadPublicKey rejects keys that are not P-256', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => loadPublicKey(publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), /P-256/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
  assert.throws(() => loadPublicKey(rsa.export({ format: 'pem', type: 'spki' }).toString()), /P-256/);
});
