import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodiesMatch,
  checkSenderId,
  checkTemplateDefinition,
  checkVariableValue,
  estimateSegments,
  extractDltTags,
  extractPlaceholders,
  findUrls,
  formatIst,
  isCallbackNumberWhitelisted,
  isIpUrl,
  isUrlWhitelisted,
  maskMobile,
  normalizeMobile,
  parseMsg91Config,
  promotionalWindowStatus,
  templateVariables,
  toCrqid,
} from '../../../src/integrations/providers/msg91/index.js';

test('normalizeMobile accepts common Indian formats and rejects the rest', () => {
  for (const input of ['9876543210', '+91 98765 43210', '+91-98765-43210', '09876543210', '0091 9876543210', '919876543210', '(+91) 98765.43210', 9876543210]) {
    assert.deepEqual(normalizeMobile(input), { ok: true, value: '919876543210' }, String(input));
  }
  for (const input of ['', '12345', '5876543210', '+91 5876543210', 'abc9876543210', null, '+1 415 555 0100']) {
    assert.equal(normalizeMobile(input).ok, false, String(input));
  }
  assert.deepEqual(normalizeMobile('+1 415 555 0100', { allowInternational: true }), { ok: true, value: '14155550100' });
  assert.equal(maskMobile('919876543210'), '91******3210');
});

test('MSG91 placeholders, DLT tags and body matching', () => {
  const body = 'Dear ##name##, session on ##date##. Apply ##link## -Phoenix';
  assert.deepEqual(extractPlaceholders(body), ['name', 'date', 'link']);
  assert.deepEqual(extractDltTags('Dear {#var#}, on {#numeric#}. {#URL#}'), ['var', 'numeric', 'url']);
  assert.ok(bodiesMatch(body, 'Dear {#var#},  session on {#var#}.\nApply {#url#} -Phoenix'));
  assert.ok(!bodiesMatch(body, 'Dear {#var#}, session on {#var#}. Apply now -Phoenix'));
  assert.ok(!bodiesMatch(body, 'Hello {#var#}, session on {#var#}. Apply {#url#} -Phoenix'));
});

test('templateVariables infers types from typed DLT tags and caps length at 40', () => {
  const vars = templateVariables({
    templateId: 'abcdef123456',
    dltTemplateId: '1307160975559044358',
    category: 'service_implicit',
    body: 'Fee Rs ##amount## for ##student##, call ##cb## or see ##link##',
    dltBody: 'Fee Rs {#numeric#} for {#var#}, call {#cbn#} or see {#url#}',
    variables: [{ name: 'amount', type: 'text' }, { name: 'student', type: 'alphanumeric', maxLength: 20 }, { name: 'cb', type: 'text' }, { name: 'link', type: 'text' }],
  });
  assert.deepEqual(vars, [
    { name: 'amount', type: 'numeric', maxLength: 40 },
    { name: 'student', type: 'alphanumeric', maxLength: 20 },
    { name: 'cb', type: 'cbn', maxLength: 40 },
    { name: 'link', type: 'url', maxLength: 40 },
  ]);
});

test('checkTemplateDefinition flags malformed DLT variables, mismatches and trailing variables', () => {
  const base = { templateId: 'abcdef123456', dltTemplateId: '1307160975559044358', category: 'service_implicit' };
  const codes = (t) => checkTemplateDefinition('t', { ...base, ...t }).map((i) => i.code);
  assert.deepEqual(codes({ body: 'Hi ##name## -Phoenix', dltBody: 'Hi {#var#} -Phoenix' }), []);
  assert.ok(codes({ dltBody: 'Hi {#name#} -Phoenix' }).includes('malformed_dlt_variable'));
  assert.ok(codes({ dltBody: 'Hi {var} and {#var} -Phoenix' }).includes('malformed_dlt_variable'));
  assert.ok(codes({ dltBody: 'Your code is {#var#}' }).includes('variable_at_end'));
  assert.ok(codes({ body: 'Hi ##name##', variables: [{ name: 'nme' }] }).includes('variable_not_declared'));
  assert.ok(codes({ body: 'Visit https://other.example/x -Phoenix' }).includes('url_not_whitelisted'));
  assert.ok(codes({ senderId: 'PHX' }).includes('invalid_sender'));
});

test('sender ids: 6 letters for service/transactional, 6 digits for promotional', () => {
  assert.equal(checkSenderId('PHXEDU', 'service_implicit'), null);
  assert.equal(checkSenderId('PHX123', 'transactional'), null);
  assert.equal(checkSenderId('567890', 'promotional'), null);
  assert.notEqual(checkSenderId('567890', 'service_implicit'), null);
  assert.notEqual(checkSenderId('PHXEDU', 'promotional'), null);
  assert.notEqual(checkSenderId('PHXEDUC', 'service_explicit'), null);
});

test('variable values: length (in characters, Unicode-aware), control characters and types', () => {
  const ctx = { whitelistedUrls: [], whitelistedCallbackNumbers: ['+91 1800 123 4567'], shortUrl: false, path: 'variables' };
  const check = (type, value, maxLength = 40) => checkVariableValue({ name: 'v', type, maxLength }, value, ctx).map((i) => i.code);
  assert.deepEqual(check('text', 'x'.repeat(40)), []);
  assert.deepEqual(check('text', 'x'.repeat(41)), ['variable_too_long']);
  assert.deepEqual(check('text', 'नमस्ते'.repeat(6)), []); // 36 code points
  assert.deepEqual(check('text', ''), ['empty_variable']);
  assert.deepEqual(check('text', 'a\tb'), ['invalid_variable']);
  assert.deepEqual(check('numeric', '0042'), []);
  assert.deepEqual(check('numeric', '4.2'), ['invalid_variable']);
  assert.deepEqual(check('alphanumeric', 'Ref 12 AB'), []);
  assert.deepEqual(check('alphanumeric', 'Ref#12'), ['invalid_variable']);
  assert.deepEqual(check('email', 'admissions@phoenix.edu.in'), []);
  assert.deepEqual(check('email', 'admissions@'), ['invalid_variable']);
  assert.deepEqual(check('cbn', '18001234567'), []);
  assert.deepEqual(check('cbn', '18009999999'), ['callback_not_whitelisted']);
  assert.deepEqual(check('url', 'https://phoenix.edu.in/a'), []);
  assert.deepEqual(check('url', 'see https://phoenix.edu.in/a'), ['invalid_variable']);
  assert.deepEqual(checkVariableValue({ name: 'v', type: 'text', maxLength: 40 }, undefined, ctx).map((i) => i.code), ['missing_variable']);
  assert.deepEqual(checkVariableValue({ name: 'v', type: 'text', maxLength: 40 }, { a: 1 }, ctx).map((i) => i.code), ['invalid_variable']);
});

test('URL whitelisting: static exact, dynamic (?) and path (/) prefixes, host case-insensitive, subdomains distinct', () => {
  const list = ['https://phoenix.edu.in/apply', 'https://phoenix.edu.in/track?', 'www.phoenix.edu.in/docs/'];
  assert.ok(isUrlWhitelisted('https://phoenix.edu.in/apply', list));
  assert.ok(isUrlWhitelisted('https://PHOENIX.edu.in/apply', list));
  assert.ok(!isUrlWhitelisted('https://phoenix.edu.in/Apply', list), 'paths are case-sensitive');
  assert.ok(!isUrlWhitelisted('https://phoenix.edu.in/apply/extra', list), 'static URLs match exactly');
  assert.ok(isUrlWhitelisted('https://phoenix.edu.in/track?id=9&u=2', list));
  assert.ok(isUrlWhitelisted('http://www.phoenix.edu.in/docs/brochure.pdf', list));
  assert.ok(!isUrlWhitelisted('https://apply.phoenix.edu.in/apply', list), 'subdomains are whitelisted separately');
  assert.ok(!isUrlWhitelisted('https://phoenix.edu.in.evil.example/apply', list));
  assert.ok(isIpUrl('http://10.0.0.1/x'));
  assert.ok(!isIpUrl('https://phoenix.edu.in/x'));
  assert.deepEqual(findUrls('Apply at https://phoenix.edu.in/apply. Or www.phoenix.edu.in/docs/x, thanks'), ['https://phoenix.edu.in/apply', 'www.phoenix.edu.in/docs/x']);
  assert.ok(isCallbackNumberWhitelisted('+91 1800-123-4567', ['18001234567']));
});

test('promotional window is [10:00, 21:00) IST with the next opening otherwise', () => {
  const window = { start: '10:00', end: '21:00' };
  const at = (iso) => promotionalWindowStatus(new Date(iso), window);
  assert.deepEqual(at('2026-11-05T04:29:59Z'), { allowed: false, nextAllowedAt: new Date('2026-11-05T04:30:00Z') }); // 09:59:59 IST
  assert.deepEqual(at('2026-11-05T04:30:00Z'), { allowed: true, nextAllowedAt: null }); // 10:00 IST
  assert.deepEqual(at('2026-11-05T15:29:59Z'), { allowed: true, nextAllowedAt: null }); // 20:59:59 IST
  assert.deepEqual(at('2026-11-05T15:30:00Z'), { allowed: false, nextAllowedAt: new Date('2026-11-06T04:30:00Z') }); // 21:00 IST
  assert.deepEqual(at('2026-11-05T19:00:00Z'), { allowed: false, nextAllowedAt: new Date('2026-11-06T04:30:00Z') }); // 00:30 IST next day
  assert.deepEqual(at('2026-12-31T18:45:00Z'), { allowed: false, nextAllowedAt: new Date('2027-01-01T04:30:00Z') }); // 00:15 IST, new year
});

test('formatIst renders MSG91 schtime and CRQIDs are alphanumeric ≤ 52', () => {
  assert.equal(formatIst(new Date('2026-11-05T18:45:30Z')), '2026-11-06 00:15:30');
  assert.deepEqual(toCrqid('4f9c1e2a-0b7d-4c3e-9a51-2d6f8e7b1c90'), { ok: true, value: '4f9c1e2a0b7d4c3e9a512d6f8e7b1c90' });
  assert.equal(toCrqid('---').ok, false);
  assert.equal(toCrqid('a'.repeat(52)).ok, true);
  assert.equal(toCrqid('a'.repeat(53)).ok, false);
});

test('estimateSegments: GSM-7 160/153, extension chars count double, Unicode 70/67', () => {
  assert.deepEqual(estimateSegments('a'.repeat(160)), { encoding: 'gsm7', units: 160, segments: 1 });
  assert.deepEqual(estimateSegments('a'.repeat(161)), { encoding: 'gsm7', units: 161, segments: 2 });
  assert.deepEqual(estimateSegments('€'.repeat(80)), { encoding: 'gsm7', units: 160, segments: 1 });
  assert.deepEqual(estimateSegments('अ'.repeat(70)), { encoding: 'unicode', units: 70, segments: 1 });
  assert.deepEqual(estimateSegments('अ'.repeat(71)), { encoding: 'unicode', units: 71, segments: 2 });
});

test('config defaults: DLT window, retries, currency and webhook header', () => {
  const cfg = parseMsg91Config({ authKey: 'abcdefgh12345678' });
  assert.equal(cfg.baseUrl, 'https://control.msg91.com');
  assert.deepEqual(cfg.dlt.promotionalWindow, { start: '10:00', end: '21:00' });
  assert.equal(cfg.dlt.maxVariableLength, 40);
  assert.equal(cfg.http.maxRetries, 2);
  assert.equal(cfg.currency, 'INR');
  assert.equal(cfg.webhook.headerName, 'x-phoenix-webhook-token');
  assert.equal(cfg.mode, 'live');
  assert.throws(() => parseMsg91Config({ authKey: 'abcdefgh12345678', templates: { t: { templateId: 'abcdef1', dltTemplateId: '12', category: 'promotional' } } }), /19 digits/);
  assert.throws(() => parseMsg91Config({ authKey: 'abcdefgh12345678', dlt: { promotionalWindow: { start: '25:00', end: '21:00' } } }), /HH:MM/);
});
