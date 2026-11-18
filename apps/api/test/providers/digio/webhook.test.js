import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIGIO_SIGNATURE_HEADER,
  computeWebhookChecksum,
  createDigioClient,
  isDigioWebhookIp,
  parseWebhook,
  verifyWebhook,
} from '../../../src/integrations/providers/digio/index.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const SECRET = 'whsec_phoenix_test_0001';
const ROTATED = 'whsec_phoenix_test_0002';

// Vectors computed with node:crypto (HMAC-SHA256, hex) and kept as literals so a change in the
// implementation can't silently change both sides.
const BODY_A =
  '{"id":"WHN230519170700329DEIO1NSND4O17T","event":"doc.sign.failed","created_at":1684496220000,"entities":["document"],"payload":{"document":{"id":"DID230519170552323OQPMNF8XBDVAYO","error_code":"ESP-###","error_message":"UIDAI Server Down","signer_identifier":"parent@example.in"}}}';
const SIG_A = 'a898c95e6a36d906f758c2c75aefa7b1f0d9293acfcbcdd6538e8b56613d32a3';
const SIG_A_ROTATED = 'e5414ff40dd58ef867a41f25406afae828d29483c8e3c7f5f9bf6d4b790ef2b7';
const BODY_B = JSON.stringify(fixture('webhook-doc-signed.json'));
const SIG_B = '52e2ea9a3775a567549f75329f0c680e5c371f3ff11f76ea830f35c408ff0177';
const BODY_UNICODE =
  '{"id":"WHN1","event":"doc.signed","created_at":1762336800000,"payload":{"document":{"id":"DID1","file_name":"प्रवेश.pdf"}}}';
const SIG_UNICODE = 'a8a2ed55ccb3499f409d852ab72ba229c0361a5284cdab965c7ad10af2f53a85';

test('checksum matches the RFC 4231 HMAC-SHA256 test case 2 and our fixed vectors', () => {
  // Digio's FAQ points to generic HMAC examples rather than publishing its own vectors.
  assert.equal(
    computeWebhookChecksum('what do ya want for nothing?', 'Jefe'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
  assert.equal(computeWebhookChecksum(BODY_A, SECRET), SIG_A);
  assert.equal(computeWebhookChecksum(Buffer.from(BODY_B), SECRET), SIG_B);
  assert.equal(computeWebhookChecksum(BODY_UNICODE, SECRET), SIG_UNICODE);
});

test('a valid checksum over the raw body verifies (string, Buffer, Uint8Array, Headers)', () => {
  assert.deepEqual(verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }, SECRET), {
    ok: true,
    createdAt: '2023-05-19T11:37:00.000Z',
  });
  assert.equal(verifyWebhook(Buffer.from(BODY_B), { 'X-Digio-Checksum': SIG_B }, SECRET).ok, true);
  assert.equal(verifyWebhook(new TextEncoder().encode(BODY_UNICODE), { 'X-DIGIO-CHECKSUM': SIG_UNICODE }, SECRET).ok, true);
  assert.equal(verifyWebhook(BODY_A, new Headers({ 'X-Digio-Checksum': SIG_A }), SECRET).ok, true);
  assert.equal(DIGIO_SIGNATURE_HEADER, 'x-digio-checksum');
});

test('upper-case hex and surrounding whitespace in the header are accepted', () => {
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': ` ${SIG_A.toUpperCase()} ` }, SECRET).ok, true);
});

test('a tampered body or a wrong secret is rejected', () => {
  const tampered = BODY_A.replace('doc.sign.failed', 'doc.signed');
  assert.deepEqual(verifyWebhook(tampered, { 'x-digio-checksum': SIG_A }, SECRET), {
    ok: false,
    reason: 'signature_mismatch',
  });
  const reformatted = JSON.stringify(JSON.parse(BODY_A), null, 2);
  assert.equal(verifyWebhook(reformatted, { 'x-digio-checksum': SIG_A }, SECRET).reason, 'signature_mismatch');
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }, ROTATED).reason, 'signature_mismatch');
  const flipped = SIG_A.slice(0, -1) + (SIG_A.endsWith('3') ? '4' : '3');
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': flipped }, SECRET).reason, 'signature_mismatch');
});

test('any of several secrets verifies (rotation or several webhook groups)', () => {
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A_ROTATED }, [SECRET, ROTATED]).ok, true);
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }, [ROTATED, SECRET]).ok, true);
});

test('missing, malformed or duplicated headers and parsed bodies are rejected', () => {
  assert.equal(verifyWebhook(BODY_A, {}, SECRET).reason, 'missing_signature');
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': 'abc' }, SECRET).reason, 'malformed_signature');
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': `sha256=${SIG_A}` }, SECRET).reason, 'malformed_signature');
  assert.equal(
    verifyWebhook(BODY_A, { 'x-digio-checksum': Buffer.from(SIG_A, 'hex').toString('base64') }, SECRET).reason,
    'malformed_signature',
  );
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': [SIG_A, SIG_A] }, SECRET).reason, 'missing_signature');
  assert.equal(verifyWebhook(JSON.parse(BODY_A), { 'x-digio-checksum': SIG_A }, SECRET).reason, 'raw_body_required');
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }, '').reason, 'missing_secret');
  assert.equal(verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }, []).reason, 'missing_secret');
});

test('a signed body that is not JSON is rejected after the checksum passes', () => {
  const body = 'not json';
  const sig = computeWebhookChecksum(body, SECRET);
  assert.equal(verifyWebhook(body, { 'x-digio-checksum': sig }, SECRET).reason, 'invalid_json');
});

test('optional tolerance on the signed created_at rejects expired and far-future events', () => {
  const createdAt = 1684496220000;
  const at = (ms) => () => new Date(ms);
  const headers = { 'x-digio-checksum': SIG_A };
  assert.equal(verifyWebhook(BODY_A, headers, SECRET).ok, true, 'no tolerance by default (Digio retries for 24h)');
  assert.equal(verifyWebhook(BODY_A, headers, SECRET, { toleranceSeconds: 90_000, now: at(createdAt + 3_600_000) }).ok, true);
  assert.deepEqual(verifyWebhook(BODY_A, headers, SECRET, { toleranceSeconds: 90_000, now: at(createdAt + 90_001_000) }), {
    ok: false,
    reason: 'timestamp_out_of_range',
  });
  assert.equal(
    verifyWebhook(BODY_A, headers, SECRET, { toleranceSeconds: 90_000, now: at(createdAt - 301_000) }).reason,
    'timestamp_out_of_range',
  );
  const noTime = '{"id":"WHN2","event":"doc.signed","payload":{}}';
  assert.equal(
    verifyWebhook(noTime, { 'x-digio-checksum': computeWebhookChecksum(noTime, SECRET) }, SECRET, { toleranceSeconds: 60 }).reason,
    'missing_timestamp',
  );
});

test('the client verifies with its configured secrets and clock', () => {
  const client = createDigioClient(
    { clientId: 'AI_TEST_CLIENT', clientSecret: 'test-client-secret', webhookSecret: [ROTATED, SECRET] },
    { fetch: async () => new Response('{}'), now: () => 1684496220000 + 1000 },
  );
  assert.equal(client.verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }, { toleranceSeconds: 60 }).ok, true);
  const unconfigured = createDigioClient({ clientId: 'AI_TEST_CLIENT', clientSecret: 'test-client-secret' }, { fetch: async () => new Response('{}') });
  assert.equal(unconfigured.verifyWebhook(BODY_A, { 'x-digio-checksum': SIG_A }).reason, 'missing_secret');
});

test('doc.signed with everyone signed becomes esign.document.completed', () => {
  const event = parseWebhook(fixture('webhook-doc-signed.json'));
  assert.equal(event.provider, 'digio');
  assert.equal(event.id, 'WHN2102031134107462ZH2S89SR5WDVG');
  assert.equal(event.type, 'esign.document.completed');
  assert.equal(event.providerEvent, 'doc.signed');
  assert.equal(event.occurredAt, '2021-02-03T06:04:10.000Z');
  assert.equal(event.documentId, 'DID210203112428801WRLZNUOYR345SJ');
  assert.equal(event.documentStatus, 'completed');
  assert.equal(event.completed, true);
  assert.equal(event.signer.identifier, '8765432109');
  assert.equal(event.signer.status, 'signed');
  assert.equal(event.signer.nameMatchScore, 54);
  assert.equal(event.signer.signedName, 'Ravi Kumar Verma');
  assert.equal(event.document.expiresAt, '2021-02-13T18:29:59.000Z');
  assert.equal(event.document.signers.length, 2);
  assert.equal(event.error, null);
  assert.equal(event.raw, undefined);
  const serialized = JSON.stringify(event);
  for (const pii of ['hash_of_photograph', 'C80ADFDAD35B', 'aadhaar_suffix', '400001', '1980']) {
    assert.equal(serialized.includes(pii), false, `${pii} must not be in the normalised event`);
  }
});

test('doc.signed before the last signer is a signer-level event', () => {
  const body = fixture('webhook-doc-signed.json');
  body.payload.document.agreement_status = 'requested';
  body.payload.document.others = { last_signed_by: '9876543210', has_all_signed: false };
  body.payload.document.signing_parties[1].status = 'requested';
  const event = parseWebhook(JSON.stringify(body));
  assert.equal(event.type, 'esign.signer.signed');
  assert.equal(event.completed, false);
  assert.equal(event.documentStatus, 'pending');
  assert.equal(event.signer.identifier, '9876543210');
});

test('doc.sign.failed carries the ESP error', () => {
  const event = parseWebhook(Buffer.from(BODY_A));
  assert.equal(event.type, 'esign.signer.failed');
  assert.equal(event.documentId, 'DID230519170552323OQPMNF8XBDVAYO');
  assert.deepEqual(event.error, { code: 'ESP-###', message: 'UIDAI Server Down' });
  assert.equal(event.signer.identifier, 'parent@example.in');
  assert.equal(event.document, null);
  assert.equal(event.documentStatus, null);
  assert.equal(parseWebhook(fixture('webhook-doc-sign-failed.json')).id, 'WHN230519170700329DEIO1NSND4O17T');
});

test('doc.sign.rejected keeps rule outcomes but not the compared values', () => {
  const event = parseWebhook(fixture('webhook-doc-sign-rejected.json'));
  assert.equal(event.type, 'esign.signer.rejected');
  assert.equal(event.occurredAt, '2023-05-19T11:37:00.000Z');
  assert.deepEqual(event.validation, {
    overallResult: 'FAIL',
    rules: [
      { ruleId: 1, result: 'FAIL', failedFields: ['AADHAAR'] },
      { ruleId: 2, result: 'PASS', failedFields: ['YOB'] },
    ],
  });
  assert.equal(JSON.stringify(event).includes('7142'), false);
  assert.ok(parseWebhook(fixture('webhook-doc-sign-rejected.json'), { includeRaw: true }).raw);
});

test('events from other Digio products are returned as unknown, and junk is refused', () => {
  const event = parseWebhook({ id: 'WHN9', event: 'mndt.transuccess', created_at: 1, entities: ['mandate'], payload: { mandate: {} } });
  assert.equal(event.type, 'unknown');
  assert.equal(event.documentId, null);
  assert.throws(() => parseWebhook({ hello: 'world' }), TypeError);
  assert.throws(() => parseWebhook('not json'), SyntaxError);
});

test('published webhook source IPs per environment', () => {
  assert.equal(isDigioWebhookIp('35.154.20.28', 'sandbox'), true);
  assert.equal(isDigioWebhookIp('::ffff:13.126.198.236', 'production'), true);
  assert.equal(isDigioWebhookIp('52.66.66.81', 'production'), true);
  assert.equal(isDigioWebhookIp('35.154.20.28', 'production'), false);
  assert.equal(isDigioWebhookIp('10.0.0.1', 'sandbox'), false);
});
