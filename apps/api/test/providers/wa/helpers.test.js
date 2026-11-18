import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  WaError,
  buildMarkRead,
  buildTemplateComponents,
  classifyError,
  formatMoney,
  normalizePhone,
  redact,
  toIso,
} from '../../../src/integrations/providers/wa/index.js';

test('normalizePhone produces +E.164 and handles Indian formats', () => {
  const india = { defaultCountryCode: '91' };
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('+91-98765-43210'), '+919876543210');
  assert.equal(normalizePhone('0091 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210'); // wa_id from a webhook
  assert.equal(normalizePhone('98765 43210', india), '+919876543210');
  assert.equal(normalizePhone('098765 43210', india), '+919876543210');
  assert.equal(normalizePhone('919876543210', india), '+919876543210');
  assert.equal(normalizePhone('9198765432', india), '+919198765432'); // national number that starts with 91
  assert.equal(normalizePhone('+1 (631) 555-1234', india), '+16315551234');
  for (const bad of ['', 'abc', '+91 98765', '+91 98765 432100', '+0123456789', '12', '+1234567890123456', '9876543210<script>']) {
    assert.throws(() => normalizePhone(bad, india), (e) => e instanceof WaError && e.kind === 'invalid_request', bad);
  }
});

test('formatMoney renders integer minor units with the currency', () => {
  assert.equal(formatMoney({ amountMinor: 123450, currency: 'INR' }), '₹1,234.50');
  assert.equal(formatMoney({ amountMinor: 1_00_00_000_00, currency: 'INR' }), '₹1,00,00,000.00');
  assert.equal(formatMoney({ amountMinor: 1999, currency: 'USD' }, 'en-US'), '$19.99');
  assert.equal(formatMoney({ amountMinor: 1500, currency: 'JPY' }, 'en-US'), '¥1,500');
});

test('buildTemplateComponents: location header, text header with named param, encoded URL opt-out', () => {
  assert.deepEqual(
    buildTemplateComponents({
      header: { type: 'location', latitude: 28.4595, longitude: 77.0266, name: 'Campus', address: 'Sector 21' },
      buttons: [{ type: 'url', index: 0, text: 'a%20b', encoded: true }],
    }),
    [
      { type: 'header', parameters: [{ type: 'location', location: { latitude: '28.4595', longitude: '77.0266', name: 'Campus', address: 'Sector 21' } }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'a%20b' }] },
    ],
  );
  assert.deepEqual(buildTemplateComponents({ header: { type: 'text', text: 'Asha', name: 'student_name' } }), [
    { type: 'header', parameters: [{ type: 'text', text: 'Asha', parameter_name: 'student_name' }] },
  ]);
  assert.throws(() => buildTemplateComponents({ header: { type: 'image' } }), /exactly one of id or link/);
  assert.throws(() => buildTemplateComponents({ body: { 'Bad-Name': 'x' } }), WaError);
});

test('buildMarkRead without typing indicator', () => {
  assert.deepEqual(buildMarkRead({ messageId: 'wamid.X' }), { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.X' });
});

test('classifyError follows the documented retry guidance', () => {
  const retry = [2, 4, 80007, 130429, 131000, 131016, 131056, 131057, 133004, 2494100];
  const noRetry = [0, 3, 10, 100, 190, 368, 130403, 131026, 131047, 131050, 131051, 132000, 132001, 132015, 132016];
  for (const code of retry) assert.equal(classifyError({ code }).retryable, true, String(code));
  for (const code of noRetry) assert.equal(classifyError({ code }).retryable, false, String(code));
  // Throttling rejections are safe to repeat even for sends; generic transient errors are not.
  for (const code of [4, 80007, 130429, 131056]) assert.equal(classifyError({ code }).rejected, true, String(code));
  for (const code of [2, 131000, 131016]) assert.equal(classifyError({ code }).rejected, false, String(code));
  assert.equal(classifyError({ code: 131047 }).kind, 'window_closed');
  assert.equal(classifyError({ code: 250 }).kind, 'permission');
  assert.deepEqual(classifyError({ code: null, httpStatus: 429 }), { kind: 'rate_limited', retryable: true, rejected: true, retryAfterMs: 1000 });
  assert.equal(classifyError({ code: null, httpStatus: 502 }).retryable, true);
  assert.equal(classifyError({ code: null, httpStatus: 404 }).kind, 'not_found');
  assert.equal(classifyError({ code: 100, isTransient: true }).retryable, true);
  assert.ok(Object.isFrozen(ERROR_CODES));
});

test('redact scrubs configured secrets and token-shaped strings', () => {
  const out = redact('token EAAJBzzzzzzzzzzzzzzzzzzzzzzzz and secret s3cr3t-value', ['s3cr3t-value', undefined]);
  assert.equal(out, 'token [REDACTED] and secret [REDACTED]');
});

test('toIso converts Unix seconds (string or number) to UTC ISO strings', () => {
  assert.equal(toIso('1749416383'), '2025-06-08T20:59:43.000Z');
  assert.equal(toIso(1762303000), '2025-11-05T00:36:40.000Z');
  assert.equal(toIso(''), null);
  assert.equal(toIso('soon'), null);
  assert.equal(toIso(undefined), null);
});
