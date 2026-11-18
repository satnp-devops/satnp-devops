import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildFlowUrl,
  computeCallbackSignature,
  computeStaticToken,
  ipAllowed,
  safeEqual,
  signCallbackUrl,
  verifyWebhook,
} from '../../../src/integrations/providers/exotel/index.js';
import { SECRET, terminalCallback } from './fixtures.js';

// Exotel does not sign webhooks, so there are no official vectors to check against. These vectors
// were computed independently with node:crypto (see the derivation test below) and pin the scheme.
const VECTOR = Object.freeze({
  ref: 'lead-42',
  exp: 1767225600, // 2026-01-01T00:00:00Z
  sig: '9A_4JD5CCnFK6kmTiQtGvuCRgbermpp_UgwC7Wjy1IE',
  staticToken: 'NcZ5T0sv_ceNpORgvtxqUCYlcnvAIr6PNGbgng2vjKs',
});
const BEFORE_EXP = Date.UTC(2025, 11, 31, 12, 0, 0);
const json = JSON.stringify(terminalCallback);
const jsonHeaders = { 'content-type': 'application/json' };

test('signature vectors match an independent HMAC-SHA256 computation', () => {
  const manual = createHmac('sha256', SECRET).update(`exotel-cb.v1\n${VECTOR.ref}\n${VECTOR.exp}`).digest('base64url');
  assert.equal(manual, VECTOR.sig);
  assert.equal(computeCallbackSignature(SECRET, VECTOR.ref, VECTOR.exp), VECTOR.sig);
  const manualStatic = createHmac('sha256', SECRET).update('exotel-static.v1\npassthru').digest('base64url');
  assert.equal(manualStatic, VECTOR.staticToken);
  assert.equal(computeStaticToken(SECRET), VECTOR.staticToken);
});

test('signCallbackUrl appends ref, exp and sig and replaces stale params', () => {
  const url = signCallbackUrl('https://crm.phoenix.test/hooks/exotel/status?tenant=b2c&phx_sig=old', SECRET, {
    ref: VECTOR.ref,
    expiresAt: VECTOR.exp,
  });
  assert.equal(
    url,
    `https://crm.phoenix.test/hooks/exotel/status?tenant=b2c&phx_ref=lead-42&phx_exp=1767225600&phx_sig=${VECTOR.sig}`,
  );
  assert.throws(() => signCallbackUrl('https://x.test', SECRET, { ref: 'bad ref', expiresAt: 1 }), TypeError);
});

test('valid signed status callback passes and reports the ref', () => {
  const url = `/hooks/exotel/status?phx_ref=lead-42&phx_exp=${VECTOR.exp}&phx_sig=${VECTOR.sig}`;
  const result = verifyWebhook(json, jsonHeaders, SECRET, { url, now: BEFORE_EXP });
  assert.deepEqual(result, { valid: true, scheme: 'signed_url', ref: 'lead-42', expiresAt: VECTOR.exp, ipChecked: false });
});

test('tampered signature, ref, exp or body are rejected', () => {
  const good = { ref: 'lead-42', exp: VECTOR.exp, sig: VECTOR.sig };
  const make = (p) => `/hooks/exotel/status?phx_ref=${p.ref}&phx_exp=${p.exp}&phx_sig=${p.sig}`;
  const check = (url, body = json) => verifyWebhook(body, jsonHeaders, SECRET, { url, now: BEFORE_EXP });
  assert.deepEqual(check(make({ ...good, sig: `${VECTOR.sig.slice(0, -1)}A` })), { valid: false, reason: 'signature_mismatch' });
  assert.deepEqual(check(make({ ...good, ref: 'lead-43' })), { valid: false, reason: 'signature_mismatch' });
  assert.deepEqual(check(make({ ...good, exp: VECTOR.exp + 86400 })), { valid: false, reason: 'signature_mismatch' });
  assert.deepEqual(check(make({ ...good, exp: 'soon' })), { valid: false, reason: 'signature_params_invalid' });
  const otherCall = JSON.stringify({ ...terminalCallback, CustomField: 'lead-99' });
  assert.deepEqual(check(make(good), otherCall), { valid: false, reason: 'ref_mismatch' });
  assert.deepEqual(check(make(good), '{"CallSid":'), { valid: false, reason: 'body_unreadable' });
  assert.deepEqual(verifyWebhook(json, jsonHeaders, 'another-secret-0123456789abcdefghijkl', { url: make(good), now: BEFORE_EXP }), {
    valid: false,
    reason: 'signature_mismatch',
  });
});

test('expired signed URL is rejected after the clock-skew grace', () => {
  const url = `/s?phx_ref=lead-42&phx_exp=${VECTOR.exp}&phx_sig=${VECTOR.sig}`;
  const at = (seconds) => verifyWebhook(json, jsonHeaders, SECRET, { url, now: (VECTOR.exp + seconds) * 1000 });
  assert.equal(at(299).valid, true);
  assert.deepEqual(at(301), { valid: false, reason: 'expired' });
  assert.deepEqual(
    verifyWebhook(json, jsonHeaders, SECRET, { url, now: new Date((VECTOR.exp + 10) * 1000), clockSkewSeconds: 0 }),
    { valid: false, reason: 'expired' },
  );
});

test('default payload without CustomField still verifies on the URL alone', () => {
  const url = `/s?phx_ref=lead-42&phx_exp=${VECTOR.exp}&phx_sig=${VECTOR.sig}`;
  const body = 'CallSid=80bfbec2d78bbbf10fb851f4fa165211&Status=completed';
  assert.equal(verifyWebhook(body, { 'Content-Type': 'application/x-www-form-urlencoded' }, SECRET, { url, now: BEFORE_EXP }).valid, true);
});

test('secret rotation: any configured secret verifies', () => {
  const url = `/s?phx_ref=lead-42&phx_exp=${VECTOR.exp}&phx_sig=${VECTOR.sig}`;
  const secrets = ['new-secret-0123456789abcdefghijklmnopq', SECRET];
  assert.equal(verifyWebhook(json, jsonHeaders, secrets, { url, now: BEFORE_EXP }).valid, true);
});

test('static flow token (query or path) for Passthru URLs', () => {
  const flowUrl = buildFlowUrl('https://crm.phoenix.test/hooks/exotel/passthru', SECRET);
  assert.equal(flowUrl, `https://crm.phoenix.test/hooks/exotel/passthru?phx_token=${VECTOR.staticToken}`);
  const received = `/hooks/exotel/passthru?phx_token=${VECTOR.staticToken}&CallSid=abc&CallFrom=09876543210`;
  assert.deepEqual(verifyWebhook('', {}, SECRET, { url: received }), {
    valid: true,
    scheme: 'static_token',
    ref: null,
    expiresAt: null,
    ipChecked: false,
  });
  assert.deepEqual(verifyWebhook('', {}, SECRET, { url: received.replace(/phx_token=./, 'phx_token=X') }), {
    valid: false,
    reason: 'token_mismatch',
  });
  assert.deepEqual(verifyWebhook('', {}, SECRET, { url: received, purpose: 'connect_applet' }), {
    valid: false,
    reason: 'token_mismatch',
  });
  const inPath = buildFlowUrl('https://crm.phoenix.test/hooks/exotel/passthru/', SECRET, { inPath: true });
  assert.equal(inPath, `https://crm.phoenix.test/hooks/exotel/passthru/${VECTOR.staticToken}`);
  assert.equal(verifyWebhook('', {}, SECRET, { token: VECTOR.staticToken }).valid, true);
  assert.deepEqual(verifyWebhook('', {}, SECRET, { url: '/hooks/exotel/passthru?CallSid=abc' }), {
    valid: false,
    reason: 'token_missing',
  });
});

test('IP allow-list: required when configured, IPv4-mapped IPv6 handled, works alone', () => {
  const allowedIps = ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'];
  const url = `/p?phx_token=${VECTOR.staticToken}`;
  assert.equal(verifyWebhook('', {}, SECRET, { url, remoteIp: '203.0.113.10', allowedIps }).ipChecked, true);
  assert.equal(verifyWebhook('', {}, SECRET, { url, remoteIp: '::ffff:203.0.113.10', allowedIps }).valid, true);
  assert.deepEqual(verifyWebhook('', {}, SECRET, { url, remoteIp: '192.0.2.1', allowedIps }), { valid: false, reason: 'ip_not_allowed' });
  assert.deepEqual(verifyWebhook('', {}, SECRET, { url, allowedIps }), { valid: false, reason: 'ip_not_allowed' });
  assert.deepEqual(verifyWebhook('', {}, null, { remoteIp: '198.51.100.7', allowedIps }), {
    valid: true,
    scheme: 'ip_only',
    ref: null,
    expiresAt: null,
    ipChecked: true,
  });
  assert.equal(ipAllowed('2001:db8:1::5', allowedIps), true);
  assert.equal(ipAllowed('not-an-ip', allowedIps), false);
});

test('fails closed without any verification configured or without the request URL', () => {
  assert.deepEqual(verifyWebhook(json, jsonHeaders, undefined, {}), { valid: false, reason: 'no_verification_configured' });
  assert.deepEqual(verifyWebhook(json, jsonHeaders, SECRET, {}), { valid: false, reason: 'url_required' });
});

test('safeEqual is exact', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
