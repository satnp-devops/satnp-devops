import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StripeConfigError,
  StripeConnectionError,
  StripeError,
  StripeRequestError,
  StripeSignatureError,
  createStripeClient,
  generateTestSignatureHeader,
} from '../../../src/integrations/providers/stripe/index.js';
import { CREATED, checkoutSessionPaid, paymentIntentSucceeded, snapshotEvent } from './fixtures.js';

const SECRET_KEY = 'sk_test_51PhoenixFakeKeyForUnitTests000000';
const WEBHOOK_SECRET = 'whsec_phoenix_unit_test_secret';
const NOW_MS = CREATED * 1000;

/**
 * Fake fetch: replays scripted responses and records every request.
 * A script entry is { status, body, headers }, an Error to throw, or a function (url, init).
 */
function fakeFetch(script) {
  const queue = [...script];
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body, signal: init.signal });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? { id: 'obj_1', object: 'thing' });
    return new Response(body, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': `req_${calls.length}`, ...(next.headers ?? {}) },
    });
  };
  fn.calls = calls;
  fn.remaining = () => queue.length;
  return fn;
}

function setup(script, config = {}, deps = {}) {
  const fetch = fakeFetch(script);
  const sleeps = [];
  const logs = [];
  const logger = { debug: (o, m) => logs.push(['debug', o, m]), warn: (o, m) => logs.push(['warn', o, m]) };
  let keys = 0;
  const client = createStripeClient(
    { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, ...config },
    {
      fetch,
      now: () => NOW_MS,
      logger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      newIdempotencyKey: () => `idem-${++keys}`,
      ...deps,
    },
  );
  return { client, fetch, sleeps, logs };
}

/** @param {string} body */
const pairs = (body) => [...new URLSearchParams(body)];

test('createCheckoutSession sends a form-encoded POST with auth, version and idempotency headers', async () => {
  const { client, fetch } = setup([{ body: checkoutSessionPaid }]);
  const session = await client.createCheckoutSession({
    lineItems: [
      { name: 'Admission fee - Grade 6', amount: 250000, currency: 'USD', description: 'Phoenix Academy 2026-27' },
      { priceId: 'price_1Kit', quantity: 2 },
    ],
    successUrl: 'https://crm.phoenix.test/pay/success?cs={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://crm.phoenix.test/pay/cancel',
    customerEmail: 'parent@example.com',
    clientReferenceId: 'lead_01JBX7',
    description: 'Admission fee',
    metadata: { phoenix_payment_id: 'pay_01JBX8' },
    expiresAt: CREATED + 3600,
  });
  assert.equal(session.id, checkoutSessionPaid.id);
  assert.deepEqual(session.lastResponse, {
    status: 200,
    requestId: 'req_1',
    idempotencyKey: 'idem-1',
    idempotentReplayed: false,
    attempts: 1,
  });
  assert.ok(!Object.keys(session).includes('lastResponse'), 'meta is not enumerable');

  const [call] = fetch.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.deepEqual(call.headers, {
    Authorization: `Bearer ${SECRET_KEY}`,
    'Stripe-Version': '2026-10-28.endive',
    Accept: 'application/json',
    'User-Agent': 'PhoenixCRM-StripeClient/1.0',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': 'idem-1',
  });
  assert.ok(call.signal instanceof AbortSignal);
  assert.deepEqual(pairs(call.body), [
    ['mode', 'payment'],
    ['line_items[0][price_data][currency]', 'usd'],
    ['line_items[0][price_data][unit_amount]', '250000'],
    ['line_items[0][price_data][product_data][name]', 'Admission fee - Grade 6'],
    ['line_items[0][price_data][product_data][description]', 'Phoenix Academy 2026-27'],
    ['line_items[0][quantity]', '1'],
    ['line_items[1][price]', 'price_1Kit'],
    ['line_items[1][quantity]', '2'],
    ['success_url', 'https://crm.phoenix.test/pay/success?cs={CHECKOUT_SESSION_ID}'],
    ['cancel_url', 'https://crm.phoenix.test/pay/cancel'],
    ['customer_email', 'parent@example.com'],
    ['client_reference_id', 'lead_01JBX7'],
    ['metadata[phoenix_payment_id]', 'pay_01JBX8'],
    ['expires_at', String(CREATED + 3600)],
    ['payment_intent_data[description]', 'Admission fee'],
    ['payment_intent_data[metadata][phoenix_payment_id]', 'pay_01JBX8'],
  ]);
  assert.match(call.body, /line_items\[0\]\[price_data\]/, 'brackets stay literal');
});

test('subscription-mode checkout puts description on subscription_data; extra params deep-merge', async () => {
  const { client, fetch } = setup([{}]);
  await client.createCheckoutSession({
    mode: 'subscription',
    lineItems: [{ name: 'CRM Pro', amount: 9900, currency: 'usd', recurring: { interval: 'month' } }],
    successUrl: 'https://crm.phoenix.test/ok',
    customerId: 'cus_InstituteA1',
    description: 'Phoenix CRM Pro (monthly)',
    extra: { subscription_data: { trial_period_days: 14 }, tax_id_collection: { enabled: true } },
  });
  assert.deepEqual(pairs(fetch.calls[0].body), [
    ['mode', 'subscription'],
    ['line_items[0][price_data][currency]', 'usd'],
    ['line_items[0][price_data][unit_amount]', '9900'],
    ['line_items[0][price_data][product_data][name]', 'CRM Pro'],
    ['line_items[0][price_data][recurring][interval]', 'month'],
    ['line_items[0][quantity]', '1'],
    ['success_url', 'https://crm.phoenix.test/ok'],
    ['customer', 'cus_InstituteA1'],
    ['subscription_data[description]', 'Phoenix CRM Pro (monthly)'],
    ['subscription_data[trial_period_days]', '14'],
    ['tax_id_collection[enabled]', 'true'],
  ]);
});

test('indiaExports requires a description and collects the billing address', async () => {
  const { client, fetch } = setup([{}, {}], { indiaExports: true });
  const items = [{ name: 'Online course', amount: 4900, currency: 'usd' }];
  await assert.rejects(client.createCheckoutSession({ lineItems: items, successUrl: 'https://x.test/ok' }), StripeConfigError);
  await client.createCheckoutSession({ lineItems: items, successUrl: 'https://x.test/ok', description: 'Educational services' });
  assert.ok(pairs(fetch.calls[0].body).some(([k, v]) => k === 'billing_address_collection' && v === 'required'));
  await client.createPaymentLink({ lineItems: items, description: 'Educational services', billingAddressCollection: 'auto' });
  assert.ok(pairs(fetch.calls[1].body).some(([k, v]) => k === 'billing_address_collection' && v === 'auto'), 'explicit choice wins');
});

test('input validation fails before any request is sent', async () => {
  const { client, fetch } = setup([]);
  const base = { lineItems: [{ priceId: 'price_1' }], successUrl: 'https://x.test/ok' };
  const bad = [
    { lineItems: [{ priceId: 'price_1' }] }, // hosted needs successUrl
    { ...base, customerId: 'cus_1', customerEmail: 'a@b.test' },
    { ...base, lineItems: [{ name: 'x', amount: 10.5, currency: 'usd' }] },
    { ...base, lineItems: [{ name: 'x', amount: 550, currency: 'isk' }] }, // ISK must be whole kronur (x100)
    { ...base, lineItems: [{ name: 'x', amount: 100, currency: 'rupees' }] },
    { ...base, expiresAt: CREATED + 600 }, // Stripe minimum is 30 minutes
    { ...base, expiresAt: new Date((CREATED + 25 * 3600) * 1000) },
    { ...base, metadata: { 'bad[key]': 'x' } },
    { ...base, unknownField: true },
    { mode: 'subscription', lineItems: [{ name: 'one-off', amount: 100, currency: 'usd' }], successUrl: 'https://x.test' },
  ];
  for (const input of bad) {
    await assert.rejects(client.createCheckoutSession(input), (error) => error instanceof StripeConfigError && error.retryable === false);
  }
  await assert.rejects(client.createRefund({ paymentIntentId: 'pi_1', chargeId: 'ch_1' }), StripeConfigError);
  await assert.rejects(client.createRefund({}), StripeConfigError);
  await assert.rejects(client.createPrice({ amount: 100, currency: 'usd' }), StripeConfigError);
  await assert.rejects(client.retrieveCustomer('../v1/charges'), StripeConfigError);
  await assert.rejects(client.retrieveCustomer('pi_123'), StripeConfigError);
  await assert.rejects(client.request('GET', '/v2/core/events'), StripeConfigError);
  assert.equal(fetch.calls.length, 0);
});

test('GET requests use query strings, expand[], no body and no idempotency key; Connect header', async () => {
  const { client, fetch } = setup([{}, { body: { object: 'list', data: [{ id: 'cus_1' }] } }, {}], { accountId: 'acct_1Platform' });
  await client.retrieveCheckoutSession('cs_test_abc', { expand: ['payment_intent', 'line_items'] });
  const customers = await client.findCustomersByEmail('parent+1@example.com', { limit: 3 });
  await client.retrievePaymentIntent('pi_123', { stripeAccount: 'acct_2Other' });

  const [get, list, other] = fetch.calls;
  assert.equal(get.method, 'GET');
  assert.equal(get.url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_abc?expand[0]=payment_intent&expand[1]=line_items');
  assert.equal(get.body, undefined);
  assert.equal(get.headers['Idempotency-Key'], undefined);
  assert.equal(get.headers['Content-Type'], undefined);
  assert.equal(get.headers['Stripe-Account'], 'acct_1Platform');
  assert.equal(list.url, 'https://api.stripe.com/v1/customers?email=parent%2B1%40example.com&limit=3');
  assert.deepEqual(customers, [{ id: 'cus_1' }]);
  assert.equal(other.headers['Stripe-Account'], 'acct_2Other');
});

test('resource helpers build the documented requests', async () => {
  const { client, fetch } = setup(Array.from({ length: 10 }, () => ({})));
  await client.createPaymentLink({
    lineItems: [{ priceId: 'price_1Fee', quantity: 1, adjustableQuantity: { enabled: true, maximum: 5 } }],
    redirectUrl: 'https://crm.phoenix.test/thanks',
    metadata: { lead: 'lead_1' },
  });
  await client.deactivatePaymentLink('plink_1abc');
  await client.createCustomer({
    email: 'parent@example.com',
    name: 'Aisha Khan',
    address: { line1: 'Al Wasl Rd', city: 'Dubai', country: 'AE', postalCode: '00000' },
    metadata: { contact_id: 'c_1' },
  });
  await client.createPrice({ amount: 9900, currency: 'USD', productName: 'CRM Pro', recurring: { interval: 'year' } });
  await client.createSubscription({ customerId: 'cus_1', items: [{ priceId: 'price_1' }], paymentBehavior: 'default_incomplete' });
  await client.cancelSubscription('sub_1', { atPeriodEnd: true });
  await client.cancelSubscription('sub_1');
  await client.createRefund({ paymentIntentId: 'pi_1', amount: 50000, reason: 'requested_by_customer', metadata: { ticket: 'T-9' } });
  await client.retrieveAccount();
  await client.expireCheckoutSession('cs_test_abc');

  const summary = fetch.calls.map((c) => [c.method, c.url.replace('https://api.stripe.com', ''), c.body ? pairs(c.body) : null]);
  assert.deepEqual(summary, [
    [
      'POST',
      '/v1/payment_links',
      [
        ['line_items[0][price]', 'price_1Fee'],
        ['line_items[0][quantity]', '1'],
        ['line_items[0][adjustable_quantity][enabled]', 'true'],
        ['line_items[0][adjustable_quantity][maximum]', '5'],
        ['metadata[lead]', 'lead_1'],
        ['after_completion[type]', 'redirect'],
        ['after_completion[redirect][url]', 'https://crm.phoenix.test/thanks'],
        ['payment_intent_data[metadata][lead]', 'lead_1'],
      ],
    ],
    ['POST', '/v1/payment_links/plink_1abc', [['active', 'false']]],
    [
      'POST',
      '/v1/customers',
      [
        ['email', 'parent@example.com'],
        ['name', 'Aisha Khan'],
        ['address[line1]', 'Al Wasl Rd'],
        ['address[city]', 'Dubai'],
        ['address[postal_code]', '00000'],
        ['address[country]', 'AE'],
        ['metadata[contact_id]', 'c_1'],
      ],
    ],
    [
      'POST',
      '/v1/prices',
      [
        ['currency', 'usd'],
        ['unit_amount', '9900'],
        ['product_data[name]', 'CRM Pro'],
        ['recurring[interval]', 'year'],
      ],
    ],
    [
      'POST',
      '/v1/subscriptions',
      [
        ['customer', 'cus_1'],
        ['items[0][price]', 'price_1'],
        ['items[0][quantity]', '1'],
        ['payment_behavior', 'default_incomplete'],
      ],
    ],
    ['POST', '/v1/subscriptions/sub_1', [['cancel_at_period_end', 'true']]],
    ['DELETE', '/v1/subscriptions/sub_1', null],
    [
      'POST',
      '/v1/refunds',
      [
        ['payment_intent', 'pi_1'],
        ['amount', '50000'],
        ['reason', 'requested_by_customer'],
        ['metadata[ticket]', 'T-9'],
      ],
    ],
    ['GET', '/v1/account', null],
    ['POST', '/v1/checkout/sessions/cs_test_abc/expire', null],
  ]);
  assert.equal(fetch.calls[6].headers['Idempotency-Key'], undefined, 'DELETE carries no idempotency key');
});

test('caller idempotency key is reused on every retry; replay header is surfaced', async () => {
  const { client, fetch, sleeps } = setup([
    { status: 500, body: { error: { type: 'api_error', message: 'Something went wrong' } } },
    { status: 409, body: { error: { type: 'idempotency_error', message: 'concurrent request with this key' } } },
    { headers: { 'idempotent-replayed': 'true' } },
  ]);
  const refund = await client.createRefund({ chargeId: 'ch_1' }, { idempotencyKey: 'refund:pay_01JBX8:1' });
  assert.deepEqual(
    fetch.calls.map((c) => c.headers['Idempotency-Key']),
    ['refund:pay_01JBX8:1', 'refund:pay_01JBX8:1', 'refund:pay_01JBX8:1'],
  );
  assert.equal(refund.lastResponse.idempotentReplayed, true);
  assert.equal(refund.lastResponse.attempts, 3);
  assert.deepEqual(sleeps, [500, 750], 'exponential backoff with jitter (random=0.5)');
});

test('no retries without an idempotency key, when Stripe says no, or for permanent errors', async () => {
  const serverError = { status: 500, body: { error: { type: 'api_error', message: 'boom' } } };
  const a = setup([serverError]);
  await assert.rejects(a.client.createCustomer({ name: 'x' }, { idempotencyKey: false }), (e) => e.retryable && e.status === 500);
  assert.equal(a.fetch.calls[0].headers['Idempotency-Key'], undefined);
  assert.equal(a.fetch.calls.length, 1);

  const b = setup([{ ...serverError, headers: { 'stripe-should-retry': 'false' } }]);
  await assert.rejects(b.client.retrieveCustomer('cus_1'), (e) => e.retryable === false && e.category === 'api');
  assert.equal(b.fetch.calls.length, 1);

  const c = setup([{ status: 400, body: { error: { type: 'invalid_request_error', message: 'No such price', param: 'line_items[0][price]' } } }]);
  await assert.rejects(c.client.createCheckoutSession({ lineItems: [{ priceId: 'price_x' }], successUrl: 'https://x.test' }), (e) => {
    assert.equal(e.category, 'invalid_request');
    assert.equal(e.param, 'line_items[0][price]');
    return true;
  });
  assert.equal(c.fetch.calls.length, 1);
});

test('429 is retried with backoff (honouring Retry-After) until maxRetries, then surfaced', async () => {
  const limited = { status: 429, body: { error: { message: 'Too many requests' } }, headers: { 'stripe-rate-limited-reason': 'endpoint-rate', 'retry-after': '2' } };
  const { client, fetch, sleeps } = setup([limited, limited, limited], { maxRetries: 2 });
  await assert.rejects(client.retrieveCustomer('cus_1'), (e) => {
    assert.ok(e instanceof StripeRequestError);
    assert.equal(e.category, 'rate_limit');
    assert.equal(e.code, 'endpoint-rate');
    assert.equal(e.retryable, true);
    assert.equal(e.retryAfterMs, 2000);
    return true;
  });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('maps Stripe error responses to typed, categorised errors', async () => {
  const cases = [
    [400, { type: 'invalid_request_error', message: 'Missing required param: line_items.' }, 'invalid_request', false],
    [400, { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' }, 'idempotency', false],
    [401, { type: 'invalid_request_error', message: 'Invalid API Key provided' }, 'authentication', false],
    [402, { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' }, 'card', false],
    [403, { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' }, 'permission', false],
    [404, { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer' }, 'not_found', false],
    [424, { type: 'api_error', message: 'External dependency failed' }, 'external_dependency', false],
    [503, { type: 'api_error', message: 'Service unavailable' }, 'api', true],
  ];
  for (const [status, error, category, retryable] of cases) {
    const { client } = setup([{ status, body: { error } }], { maxRetries: 0 });
    await assert.rejects(client.retrieveCustomer('cus_1'), (e) => {
      assert.ok(e instanceof StripeError, `${status}`);
      assert.equal(e.category, category, `${status} ${error.type}`);
      assert.equal(e.retryable, retryable, `${status} retryable`);
      assert.equal(e.status, status);
      assert.equal(e.type, error.type);
      assert.equal(e.requestId, 'req_1');
      if (error.decline_code) assert.equal(e.declineCode, 'insufficient_funds');
      if (error.code) assert.equal(e.code, error.code);
      return true;
    });
  }
  const html = setup([{ status: 502, body: '<html>Bad gateway</html>', headers: { 'content-type': 'text/html' } }], { maxRetries: 0 });
  await assert.rejects(html.client.retrieveCustomer('cus_1'), (e) => e.category === 'api' && e.retryable && /HTTP 502/.test(e.message));
  const notJson = setup([{ status: 200, body: 'ok', headers: { 'content-type': 'text/plain' } }]);
  await assert.rejects(notJson.client.retrieveCustomer('cus_1'), (e) => e.category === 'invalid_response');
});

test('network errors are retried for safe calls; timeouts and cancellation are typed', async () => {
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const a = setup([reset, {}]);
  await a.client.createCustomer({ name: 'x' });
  assert.equal(a.fetch.calls.length, 2);
  assert.equal(a.fetch.calls[0].headers['Idempotency-Key'], a.fetch.calls[1].headers['Idempotency-Key']);

  const b = setup([reset, reset, reset]);
  await assert.rejects(b.client.retrieveCustomer('cus_1'), (e) => e instanceof StripeConnectionError && e.category === 'connection' && e.retryable && /ECONNRESET/.test(e.message));

  const hang = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const c = setup([hang]);
  await assert.rejects(c.client.retrieveCustomer('cus_1', { timeoutMs: 20, maxRetries: 0 }), (e) => e.category === 'timeout' && e.retryable);

  const d = setup([hang, {}]);
  const controller = new AbortController();
  const pending = d.client.retrieveCustomer('cus_1', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.category === 'aborted' && e.retryable === false);
  assert.equal(d.fetch.remaining(), 1, 'a cancelled call is not retried');
});

test('secrets never appear in errors or logs; params are not logged', async () => {
  const echo = { status: 401, body: { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${SECRET_KEY} / ${WEBHOOK_SECRET}` } } };
  const { client, logs } = setup([echo]);
  await assert.rejects(client.createCustomer({ email: 'private.parent@example.com' }), (e) => {
    const text = `${e.message} ${JSON.stringify(e)} ${e.stack}`;
    assert.ok(!text.includes(SECRET_KEY));
    assert.ok(!text.includes(WEBHOOK_SECRET));
    assert.match(e.message, /sk_test_\[redacted\]|\[redacted\]/);
    return true;
  });
  const logged = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  assert.ok(!logged.includes(SECRET_KEY));
  assert.ok(!logged.includes(WEBHOOK_SECRET));
  assert.ok(!logged.includes('private.parent@example.com'));
});

test('config is validated with zod and never echoes values', () => {
  const bad = [
    {},
    { secretKey: 'pk_test_123456789' },
    { secretKey: 'sk_test_short' },
    { secretKey: SECRET_KEY, webhookSecret: 'not-a-secret' },
    { secretKey: SECRET_KEY, apiVersion: 'latest' },
    { secretKey: SECRET_KEY, accountId: 'acc_1' },
    { secretKey: SECRET_KEY, timeoutMs: 10 },
    { secretKey: SECRET_KEY, extraField: 1 },
    { secretKey: 'sk_live_51PhoenixFakeLiveKey000000', apiBase: 'http://stripe-mock.local' },
  ];
  for (const config of bad) {
    assert.throws(() => createStripeClient(config, { fetch: async () => {} }), (e) => {
      assert.ok(e instanceof StripeConfigError);
      if (config.secretKey) assert.ok(!e.message.includes(config.secretKey));
      return true;
    });
  }
  const client = createStripeClient(
    { secretKey: 'rk_live_51PhoenixRestricted00000', webhookSecret: [WEBHOOK_SECRET, 'whsec_previous_secret'] },
    { fetch: async () => {} },
  );
  assert.equal(client.mode, 'live');
  assert.equal(client.apiVersion, '2026-10-28.endive');
  assert.ok(client.capabilities.includes('webhook.verify'));
});

test('client.webhooks verifies with the configured secret(s), tolerance and clock', () => {
  const { client } = setup([], { webhookSecret: ['whsec_new_rolled_secret', WEBHOOK_SECRET], webhookToleranceSec: 60 });
  const body = JSON.stringify(snapshotEvent('payment_intent.succeeded', paymentIntentSucceeded));
  const signature = generateTestSignatureHeader({ payload: body, secret: WEBHOOK_SECRET, timestamp: CREATED - 30 });
  const event = client.webhooks.constructEvent(Buffer.from(body), { 'Stripe-Signature': signature });
  assert.equal(event.kind, 'payment.succeeded');
  assert.equal(client.webhooks.verify(body, signature).secretIndex, 1);
  const stale = generateTestSignatureHeader({ payload: body, secret: WEBHOOK_SECRET, timestamp: CREATED - 61 });
  assert.throws(() => client.webhooks.verify(body, stale), (e) => e instanceof StripeSignatureError && e.code === 'timestamp_outside_tolerance');

  const noSecret = createStripeClient({ secretKey: SECRET_KEY }, { fetch: async () => {} });
  assert.throws(() => noSecret.webhooks.verify(body, signature), StripeConfigError);
});
