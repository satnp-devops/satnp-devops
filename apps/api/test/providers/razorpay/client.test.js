import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRazorpayClient, RazorpayError } from '../../../src/integrations/providers/razorpay/index.js';
import { BASIC_AUTH, fakeFetch, KEY_ID, KEY_SECRET, testDeps, WEBHOOK_SECRET } from './fake-fetch.js';

const API = 'https://api.razorpay.com/v1';
const config = { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET };
const ORDER = {
  id: 'order_Phx0000000001',
  entity: 'order',
  amount: 150000,
  amount_paid: 0,
  amount_due: 150000,
  currency: 'INR',
  receipt: 'adm_2026_0042',
  status: 'created',
  attempts: 0,
  notes: { admission_id: 'adm_42' },
  created_at: 1762336800,
};

function client(script, extra) {
  const fetch = fakeFetch(script);
  const { deps, sleeps } = testDeps(fetch, extra);
  return { rzp: createRazorpayClient(config, deps), fetch, sleeps };
}

const assertCommonHeaders = (call) => {
  assert.equal(call.headers.authorization, BASIC_AUTH);
  assert.equal(call.headers.accept, 'application/json');
};

test('createOrder: POST /orders with snake_case body and Basic auth', async () => {
  const { rzp, fetch } = client([{ status: 200, body: ORDER }]);
  const order = await rzp.createOrder({ amount: 150000, receipt: 'adm_2026_0042', notes: { admission_id: 'adm_42' }, partialPayment: false });
  const [call] = fetch.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${API}/orders`);
  assertCommonHeaders(call);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.body, {
    amount: 150000,
    currency: 'INR',
    receipt: 'adm_2026_0042',
    notes: { admission_id: 'adm_42' },
    partial_payment: false,
  });
  assert.equal(order.id, 'order_Phx0000000001');
  assert.equal(order.amountDue, 150000);
  assert.equal(order.createdAt, '2025-11-05T10:00:00.000Z');
  assert.deepEqual(order.raw, ORDER);
});

test('createOrder validates amounts locally: integers, INR minimum, currency code', async () => {
  const { rzp, fetch } = client([]);
  for (const input of [{ amount: 1500.5 }, { amount: 99 }, { amount: 0 }, { amount: 5000, currency: 'inr' }, { amount: 5000, extra: 1 }]) {
    await assert.rejects(rzp.createOrder(input), (err) => err instanceof RazorpayError && err.kind === 'validation' && !err.retryable);
  }
  await rzp.createOrder({ amount: 50, currency: 'USD' }).catch(() => {}); // not INR: no ₹1 rule (fails only on the empty fake)
  assert.equal(fetch.calls.length, 1);
});

test('fetchOrder, fetchPayment, fetchRefund, fetchPlan: GETs with no body', async () => {
  const { rzp, fetch } = client([
    { body: ORDER },
    { body: { id: 'pay_Phx0000000001', entity: 'payment', amount: 150000, currency: 'INR', status: 'captured', captured: true, notes: [] } },
    { body: { id: 'rfnd_Phx000000001', entity: 'refund', amount: 500, currency: 'INR', payment_id: 'pay_Phx0000000001', status: 'pending' } },
    { body: { id: 'plan_Phx000000001', entity: 'plan', period: 'monthly', interval: 1, item: { name: 'Fees', amount: 250000, currency: 'INR' } } },
  ]);
  assert.equal((await rzp.fetchOrder('order_Phx0000000001')).status, 'created');
  assert.equal((await rzp.fetchPayment('pay_Phx0000000001')).captured, true);
  assert.equal((await rzp.fetchRefund('rfnd_Phx000000001')).status, 'pending');
  assert.equal((await rzp.fetchPlan('plan_Phx000000001')).amount, 250000);
  assert.deepEqual(
    fetch.calls.map((c) => [c.method, c.url, c.body, c.headers['content-type']]),
    [
      ['GET', `${API}/orders/order_Phx0000000001`, undefined, undefined],
      ['GET', `${API}/payments/pay_Phx0000000001`, undefined, undefined],
      ['GET', `${API}/refunds/rfnd_Phx000000001`, undefined, undefined],
      ['GET', `${API}/plans/plan_Phx000000001`, undefined, undefined],
    ],
  );
  fetch.calls.forEach(assertCommonHeaders);
});

test('ids are validated before they reach the URL path', async () => {
  const { rzp, fetch } = client([]);
  for (const call of [
    () => rzp.fetchOrder('../payments'),
    () => rzp.fetchOrder('pay_Phx0000000001'),
    () => rzp.fetchPaymentLink('plink_x/cancel'),
    () => rzp.cancelSubscription('sub_a?b=1'),
    () => rzp.createRefund('order_Phx0000000001', {}),
  ]) {
    await assert.rejects(call(), (err) => err.kind === 'validation');
  }
  assert.equal(fetch.calls.length, 0);
});

test('createPaymentLink: full request shape, callback_method added, times as unix seconds', async () => {
  const link = {
    id: 'plink_Phx00000000001',
    amount: 250000,
    amount_paid: 0,
    currency: 'INR',
    status: 'created',
    reference_id: 'ADM-2026-0042',
    short_url: 'https://rzp.io/i/abc123',
    expire_by: 1763251200,
    cancelled_at: 0,
    expired_at: 0,
    customer: { name: 'Asha Rao', email: 'asha@example.com', contact: '+919800000000' },
    notify: { sms: true, email: true },
    reminder_enable: true,
    notes: { admission_id: 'adm_42' },
    callback_url: 'https://crm.example.com/pay/return',
    callback_method: 'get',
    created_at: 1762336800,
  };
  const { rzp, fetch } = client([{ body: link }]);
  const result = await rzp.createPaymentLink({
    amount: 250000,
    currency: 'INR',
    description: 'Admission fee - Grade 6',
    customer: { name: 'Asha Rao', email: 'asha@example.com', contact: '+919800000000' },
    notify: { sms: true, email: true },
    reminderEnable: true,
    expireBy: '2025-11-16T00:00:00Z',
    referenceId: 'ADM-2026-0042',
    notes: { admission_id: 'adm_42' },
    callbackUrl: 'https://crm.example.com/pay/return',
  }).catch((e) => e);
  // The injected clock is 2026-11-05, so a 2025 expiry is in the past.
  assert.equal(result.kind, 'validation');
  assert.equal(fetch.calls.length, 0);

  const ok = await rzp.createPaymentLink({
    amount: 250000,
    description: 'Admission fee - Grade 6',
    customer: { name: 'Asha Rao', email: 'asha@example.com', contact: '+919800000000' },
    notify: { sms: true, email: true },
    reminderEnable: true,
    expireBy: new Date('2026-11-16T00:00:00Z'),
    referenceId: 'ADM-2026-0042',
    notes: { admission_id: 'adm_42' },
    callbackUrl: 'https://crm.example.com/pay/return',
  });
  const [call] = fetch.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${API}/payment_links/`);
  assertCommonHeaders(call);
  assert.deepEqual(call.body, {
    amount: 250000,
    currency: 'INR',
    description: 'Admission fee - Grade 6',
    customer: { name: 'Asha Rao', email: 'asha@example.com', contact: '+919800000000' },
    notify: { sms: true, email: true },
    reminder_enable: true,
    expire_by: 1794787200,
    reference_id: 'ADM-2026-0042',
    notes: { admission_id: 'adm_42' },
    callback_url: 'https://crm.example.com/pay/return',
    callback_method: 'get',
  });
  assert.equal(ok.shortUrl, 'https://rzp.io/i/abc123');
  assert.equal(ok.cancelledAt, null);
  assert.equal(ok.expireBy, '2025-11-16T00:00:00.000Z');
});

test('createPaymentLink rejects partial-payment fields without acceptPartial and bad callback URLs', async () => {
  const { rzp } = client([]);
  await assert.rejects(rzp.createPaymentLink({ amount: 1000, firstMinPartialAmount: 500 }), (e) => e.kind === 'validation');
  await assert.rejects(rzp.createPaymentLink({ amount: 1000, callbackUrl: 'javascript:alert(1)' }), (e) => e.kind === 'validation');
  await assert.rejects(rzp.createPaymentLink({ amount: 1000, referenceId: 'x'.repeat(41) }), (e) => e.kind === 'validation');
  await assert.rejects(
    rzp.createPaymentLink({ amount: 1000, notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v'])) }),
    (e) => e.kind === 'validation',
  );
});

test('fetchPaymentLink and cancelPaymentLink', async () => {
  const { rzp, fetch } = client([
    { body: { id: 'plink_Phx00000000001', status: 'created', amount: 1000, currency: 'INR' } },
    { body: { id: 'plink_Phx00000000001', status: 'cancelled', amount: 1000, currency: 'INR', cancelled_at: 1762340000 } },
  ]);
  assert.equal((await rzp.fetchPaymentLink('plink_Phx00000000001')).status, 'created');
  const cancelled = await rzp.cancelPaymentLink('plink_Phx00000000001');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledAt, '2025-11-05T10:53:20.000Z');
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url, c.body]), [
    ['GET', `${API}/payment_links/plink_Phx00000000001`, undefined],
    ['POST', `${API}/payment_links/plink_Phx00000000001/cancel`, undefined],
  ]);
});

test('createRefund sends X-Refund-Idempotency (given or generated) and speed', async () => {
  const refund = { id: 'rfnd_Phx000000001', entity: 'refund', amount: 50000, currency: 'INR', payment_id: 'pay_Phx0000000001', status: 'processed', speed_requested: 'optimum', speed_processed: 'instant', notes: [] };
  const { rzp, fetch } = client([{ body: refund }, { body: refund }]);
  const a = await rzp.createRefund('pay_Phx0000000001', { amount: 50000, speed: 'optimum', receipt: 'rf_42', notes: { reason: 'withdrawal' }, idempotencyKey: 'refund-adm42-0001' });
  assert.equal(a.idempotencyKey, 'refund-adm42-0001');
  assert.equal(a.speedProcessed, 'instant');
  const b = await rzp.createRefund('pay_Phx0000000001');
  assert.equal(b.idempotencyKey, 'idem_generated_0001');
  const [first, second] = fetch.calls;
  assert.equal(first.method, 'POST');
  assert.equal(first.url, `${API}/payments/pay_Phx0000000001/refund`);
  assert.equal(first.headers['x-refund-idempotency'], 'refund-adm42-0001');
  assert.deepEqual(first.body, { amount: 50000, speed: 'optimum', receipt: 'rf_42', notes: { reason: 'withdrawal' } });
  assert.equal(second.headers['x-refund-idempotency'], 'idem_generated_0001');
  assert.deepEqual(second.body, { speed: 'normal' }); // full refund at normal speed
  await assert.rejects(rzp.createRefund('pay_Phx0000000001', { idempotencyKey: 'short' }), (e) => e.kind === 'validation');
  await assert.rejects(rzp.createRefund('pay_Phx0000000001', { speed: 'instant' }), (e) => e.kind === 'validation');
});

test('refund retries on 5xx and 409 with the same idempotency key', async () => {
  const { rzp, fetch, sleeps } = client([
    { status: 503, body: { error: { code: 'SERVER_ERROR', description: 'Service unavailable' } } },
    { status: 409, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Request in progress' } } },
    { body: { id: 'rfnd_Phx000000001', status: 'pending', amount: 100, currency: 'INR' } },
  ]);
  const r = await rzp.createRefund('pay_Phx0000000001', { amount: 100 });
  assert.equal(r.status, 'pending');
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(new Set(fetch.calls.map((c) => c.headers['x-refund-idempotency'])), new Set(['idem_generated_0001']));
  assert.deepEqual(sleeps, [150, 300]); // full jitter with random()=0.5: 0.5*300, 0.5*600
});

test('plans and subscriptions: create, fetch/status, cancel', async () => {
  const sub = { id: 'sub_Phx0000000001', entity: 'subscription', plan_id: 'plan_Phx000000001', status: 'created', total_count: 12, paid_count: 0, quantity: 1, short_url: 'https://rzp.io/i/sub', customer_notify: true, notes: [], created_at: 1762336800, current_start: null, charge_at: 1764547200 };
  const { rzp, fetch } = client([
    { body: { id: 'plan_Phx000000001', entity: 'plan', interval: 1, period: 'monthly', item: { name: 'Tuition - monthly', amount: 250000, currency: 'INR' }, notes: [], created_at: 1762336800 } },
    { body: sub },
    { body: { ...sub, status: 'active' } },
    { body: { ...sub, status: 'cancelled', ended_at: 1762340000 } },
    { body: { ...sub, status: 'active' } },
  ]);
  const plan = await rzp.createPlan({ period: 'monthly', interval: 1, item: { name: 'Tuition - monthly', amount: 250000, description: 'Grade 6' }, notes: { programme: 'g6' } });
  assert.equal(plan.id, 'plan_Phx000000001');
  const created = await rzp.createSubscription({
    planId: 'plan_Phx000000001',
    totalCount: 12,
    quantity: 1,
    customerNotify: true,
    startAt: '2026-12-01T00:00:00+05:30',
    expireBy: 1796083200,
    addons: [{ name: 'Admission kit', amount: 150000 }],
    notes: { admission_id: 'adm_42' },
  });
  assert.equal(created.shortUrl, 'https://rzp.io/i/sub');
  assert.equal(created.chargeAt, '2025-12-01T00:00:00.000Z');
  assert.equal(await rzp.getSubscriptionStatus('sub_Phx0000000001'), 'active');
  assert.equal((await rzp.cancelSubscription('sub_Phx0000000001')).status, 'cancelled');
  await rzp.cancelSubscription('sub_Phx0000000001', { atCycleEnd: true });

  const [p, s, f, c1, c2] = fetch.calls;
  assert.deepEqual([p.method, p.url], ['POST', `${API}/plans`]);
  assert.deepEqual(p.body, { period: 'monthly', interval: 1, item: { name: 'Tuition - monthly', amount: 250000, currency: 'INR', description: 'Grade 6' }, notes: { programme: 'g6' } });
  assert.deepEqual([s.method, s.url], ['POST', `${API}/subscriptions`]);
  assert.deepEqual(s.body, {
    plan_id: 'plan_Phx000000001',
    total_count: 12,
    quantity: 1,
    start_at: 1796063400, // 2026-12-01T00:00 IST = 2026-11-30T18:30Z
    expire_by: 1796083200,
    customer_notify: true,
    addons: [{ item: { name: 'Admission kit', amount: 150000, currency: 'INR' } }],
    notes: { admission_id: 'adm_42' },
  });
  assert.deepEqual([f.method, f.url], ['GET', `${API}/subscriptions/sub_Phx0000000001`]);
  assert.deepEqual([c1.method, c1.url, c1.body], ['POST', `${API}/subscriptions/sub_Phx0000000001/cancel`, { cancel_at_cycle_end: false }]);
  assert.deepEqual(c2.body, { cancel_at_cycle_end: true });
  await assert.rejects(rzp.createPlan({ period: 'daily', interval: 3, item: { name: 'x', amount: 100 } }), (e) => e.kind === 'validation');
});

test('error mapping: Razorpay error body becomes a typed, permanent error', async () => {
  const body = { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be atleast INR 1.00', field: 'amount', source: 'business', step: 'payment_initiation', reason: 'input_validation_failed', metadata: {} } };
  const { rzp, fetch } = client([{ status: 400, body }]);
  const err = await rzp.createOrder({ amount: 100 }).catch((e) => e);
  assert.ok(err instanceof RazorpayError);
  assert.equal(err.kind, 'bad_request');
  assert.equal(err.status, 400);
  assert.equal(err.retryable, false);
  assert.equal(err.outcomeUnknown, false);
  assert.equal(err.providerCode, 'BAD_REQUEST_ERROR');
  assert.equal(err.field, 'amount');
  assert.equal(err.reason, 'input_validation_failed');
  assert.equal(err.op, 'orders.create');
  assert.match(err.message, /HTTP 400 BAD_REQUEST_ERROR.*atleast INR 1\.00/);
  assert.equal(fetch.calls.length, 1);
});

test('error mapping by status: 401 auth, 404 / "does not exist" not_found, 403 forbidden', async () => {
  const { rzp } = client([
    { status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed', source: 'NA' } } },
    { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } } },
    { status: 404, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found on the server.' } } },
    { status: 403, body: 'forbidden' },
  ]);
  const auth = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.retryable, false);
  assert.equal(auth.source, null); // "NA" is dropped
  assert.equal((await rzp.fetchOrder('order_Phx0000000001').catch((e) => e)).kind, 'not_found');
  assert.equal((await rzp.fetchOrder('order_Phx0000000001').catch((e) => e)).kind, 'not_found');
  const forbidden = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.providerCode, null);
});

test('429 is retried even for non-idempotent POSTs, honouring Retry-After', async () => {
  const { rzp, fetch, sleeps } = client([
    { status: 429, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } }, headers: { 'retry-after': '2' } },
    { status: 200, body: ORDER },
  ]);
  assert.equal((await rzp.createOrder({ amount: 150000 })).id, ORDER.id);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('429 that persists ends as a retryable rate_limited error after maxRetries', async () => {
  const tooMany = { status: 429, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } } };
  const { rzp, fetch, sleeps } = client([tooMany, tooMany, tooMany]);
  const err = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  assert.equal(err.kind, 'rate_limited');
  assert.equal(err.retryable, true);
  assert.equal(fetch.calls.length, 3); // 1 + maxRetries (default 2)
  assert.equal(sleeps.length, 2);
});

test('5xx: GET is retried; non-idempotent POST is not and reports outcomeUnknown', async () => {
  const boom = { status: 502, body: { error: { code: 'SERVER_ERROR', description: 'Bad gateway' } } };
  const get = client([boom, { body: ORDER }]);
  assert.equal((await get.rzp.fetchOrder('order_Phx0000000001')).id, ORDER.id);
  assert.equal(get.fetch.calls.length, 2);

  const post = client([boom]);
  const err = await post.rzp.createOrder({ amount: 150000 }).catch((e) => e);
  assert.equal(err.kind, 'server');
  assert.equal(err.retryable, false);
  assert.equal(err.outcomeUnknown, true);
  assert.equal(post.fetch.calls.length, 1);
});

test('network errors: GET retried, POST not retried and flagged outcomeUnknown', async () => {
  const get = client([new TypeError('fetch failed'), { body: ORDER }]);
  assert.equal((await get.rzp.fetchOrder('order_Phx0000000001')).id, ORDER.id);

  const post = client([new TypeError('fetch failed')]);
  const err = await post.rzp.createPaymentLink({ amount: 1000 }).catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.retryable, false);
  assert.equal(err.outcomeUnknown, true);
  assert.equal(post.fetch.calls.length, 1);
});

test('timeouts use AbortSignal and are retryable only for safe calls', async () => {
  const fetch = fakeFetch(['hang', 'hang']);
  const { deps } = testDeps(fetch);
  const rzp = createRazorpayClient({ ...config, timeoutMs: 20, maxRetries: 1 }, deps);
  const err = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  assert.equal(err.kind, 'timeout');
  assert.equal(err.retryable, true);
  assert.equal(fetch.calls.length, 2);

  const fetch2 = fakeFetch(['hang']);
  const rzp2 = createRazorpayClient({ ...config, timeoutMs: 20, maxRetries: 1 }, testDeps(fetch2).deps);
  const err2 = await rzp2.createOrder({ amount: 150000 }).catch((e) => e);
  assert.equal(err2.kind, 'timeout');
  assert.equal(err2.outcomeUnknown, true);
  assert.equal(fetch2.calls.length, 1);
});

test('a caller AbortSignal cancels without retrying', async () => {
  const fetch = fakeFetch(['hang', 'hang']);
  const rzp = createRazorpayClient(config, testDeps(fetch).deps);
  const controller = new AbortController();
  const pending = rzp.fetchOrder('order_Phx0000000001', { signal: controller.signal }).catch((e) => e);
  controller.abort();
  const err = await pending;
  assert.equal(err.kind, 'aborted');
  assert.equal(err.retryable, false);
  assert.equal(fetch.calls.length, 1);
});

test('a 2xx with a non-JSON body is an invalid_response error', async () => {
  const { rzp } = client([{ status: 200, body: '<html>maintenance</html>' }]);
  const err = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  assert.equal(err.kind, 'invalid_response');
  assert.equal(err.retryable, false);
});

test('secrets never appear in errors or logs', async () => {
  const logs = [];
  const log = (level) => (obj, msg) => logs.push(JSON.stringify({ level, obj, msg }));
  const logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  const echo = { status: 500, body: { error: { code: 'SERVER_ERROR', description: `upstream said ${KEY_SECRET} and ${BASIC_AUTH.slice(6)}` } } };
  const fetch = fakeFetch([echo, echo, echo, new TypeError(`connect failed for ${KEY_SECRET}`), new TypeError('x'), new TypeError('x')]);
  const rzp = createRazorpayClient(config, testDeps(fetch, { logger }).deps);
  const err = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  const err2 = await rzp.fetchOrder('order_Phx0000000001').catch((e) => e);
  const everything = [err.message, JSON.stringify(err), err2.message, JSON.stringify(err2), ...logs].join('\n');
  assert.ok(logs.length > 0);
  assert.ok(!everything.includes(KEY_SECRET), 'key secret leaked');
  assert.ok(!everything.includes(BASIC_AUTH.slice(6)), 'basic auth token leaked');
  assert.ok(!everything.includes(WEBHOOK_SECRET), 'webhook secret leaked');
  assert.match(err.message, /\[REDACTED\]/);
  assert.ok(!JSON.stringify(rzp).includes(KEY_SECRET));
});

test('config is validated with zod; errors name fields, never values', () => {
  const bad = (input) => {
    try {
      createRazorpayClient(input, { fetch: async () => {} });
    } catch (e) {
      return e;
    }
    return null;
  };
  const e1 = bad({ keyId: 'not-a-key', keySecret: 'super-secret-value' });
  assert.equal(e1.kind, 'config');
  assert.ok(!JSON.stringify(e1).includes('super-secret-value'));
  assert.ok(!e1.message.includes('not-a-key'));
  assert.equal(bad({ keyId: KEY_ID, keySecret: 'short' }).kind, 'config');
  assert.equal(bad({ keyId: KEY_ID, keySecret: KEY_SECRET, mode: 'live' }).details[0].path, 'mode');
  assert.equal(bad({ keyId: 'rzp_partner_abc', keySecret: KEY_SECRET }).details[0].path, 'mode');
  assert.equal(bad({ keyId: KEY_ID, keySecret: KEY_SECRET, unknown: 1 }).kind, 'config');
  assert.equal(bad({ keyId: KEY_ID, keySecret: KEY_SECRET, timeoutMs: 0 }).kind, 'config');

  const testClient = createRazorpayClient(config, { fetch: async () => {} });
  assert.equal(testClient.mode, 'test');
  assert.equal(testClient.isTestMode, true);
  const live = createRazorpayClient({ keyId: 'rzp_live_PhoenixKey0001', keySecret: KEY_SECRET }, { fetch: async () => {} });
  assert.equal(live.mode, 'live');
  assert.deepEqual(testClient.toJSON(), { provider: 'razorpay', mode: 'test', keyId: KEY_ID });
});

test('custom baseUrl (proxy or mock server) is respected without a trailing slash', async () => {
  const fetch = fakeFetch([{ body: ORDER }]);
  const rzp = createRazorpayClient({ ...config, baseUrl: 'http://127.0.0.1:9999/v1/' }, testDeps(fetch).deps);
  await rzp.fetchOrder('order_Phx0000000001');
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:9999/v1/orders/order_Phx0000000001');
});

test('checkoutOptions exposes only the public key id; client-bound signature helpers use the key secret', () => {
  const rzp = createRazorpayClient(config, { fetch: async () => {} });
  const opts = rzp.checkoutOptions({ orderId: 'order_Phx0000000001', amount: 150000, name: 'Phoenix Admissions', prefill: { email: 'a@example.com' } });
  assert.deepEqual(opts, { key: KEY_ID, order_id: 'order_Phx0000000001', amount: 150000, currency: 'INR', name: 'Phoenix Admissions', prefill: { email: 'a@example.com' } });
  assert.ok(!JSON.stringify(opts).includes(KEY_SECRET));
  assert.equal(
    rzp.verifyPaymentSignature({ orderId: 'order_TestPhoenix001', paymentId: 'pay_TestPhoenix0001', signature: '7a9bcde0015053e36f2190ca777e7f5beb53ece53bfcd841ad40ceebdc01f259' }),
    true,
  );
  assert.ok(rzp.capabilities.includes('refunds.create'));
});
