import { randomUUID } from 'node:crypto';
import { parseStripeConfig } from './config.js';
import { StripeConfigError } from './errors.js';
import { parseWebhook } from './events.js';
import { createTransport } from './http.js';
import {
  pathId,
  toCheckoutSessionParams,
  toCustomerParams,
  toPaymentLinkParams,
  toPriceParams,
  toProductParams,
  toRefundParams,
  toSubscriptionParams,
} from './inputs.js';
import { verifyWebhook } from './webhook.js';

/** What this client can do, for the adapter registry. */
export const CAPABILITIES = Object.freeze([
  'checkout.session.create',
  'checkout.session.retrieve',
  'checkout.session.expire',
  'payment_link.create',
  'payment_link.retrieve',
  'payment_link.deactivate',
  'customer.create',
  'customer.update',
  'customer.retrieve',
  'customer.find_by_email',
  'product.create',
  'price.create',
  'price.retrieve',
  'subscription.create',
  'subscription.retrieve',
  'subscription.cancel',
  'refund.create',
  'refund.retrieve',
  'payment_intent.retrieve',
  'event.retrieve',
  'account.retrieve',
  'webhook.verify',
  'webhook.parse',
]);

const noopLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Attaches response metadata without changing the Stripe object's JSON shape.
 * @template T
 * @param {{ data: T, meta: import('./http.js').ResponseMeta }} result
 * @returns {T & { lastResponse: import('./http.js').ResponseMeta }}
 */
function withMeta({ data, meta }) {
  if (data && typeof data === 'object') Object.defineProperty(data, 'lastResponse', { value: meta, enumerable: false });
  return /** @type {any} */ (data);
}

/**
 * Creates a Stripe API v1 client.
 *
 * @param {unknown} rawConfig see stripeConfigSchema in config.js
 * @param {{
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   newIdempotencyKey?: () => string,
 * }} [deps] injectable for tests; defaults are the globals
 */
export function createStripeClient(rawConfig, deps = {}) {
  const config = parseStripeConfig(rawConfig);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new StripeConfigError('No fetch implementation available');
  const now = deps.now ?? Date.now;
  const nowMs = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const transport = createTransport({
    config,
    fetch: fetchImpl,
    now: nowMs,
    logger: deps.logger ?? noopLogger,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: deps.random ?? Math.random,
    newIdempotencyKey: deps.newIdempotencyKey ?? randomUUID,
  });

  /**
   * @param {import('./http.js').Method} method
   * @param {string} path
   * @param {Record<string, unknown>} [params]
   * @param {import('./http.js').RequestOptions} [options]
   */
  const call = async (method, path, params, options) => withMeta(await transport.request(method, path, params, options));

  /** @param {{ expand?: string[] }} [options] */
  const expandOf = (options) => (options?.expand?.length ? { expand: options.expand } : undefined);

  return Object.freeze({
    provider: 'stripe',
    kind: 'payments',
    mode: config.mode,
    apiVersion: config.apiVersion,
    capabilities: CAPABILITIES,

    /** Escape hatch for endpoints not wrapped below. Path must start with /v1/. */
    request: call,

    // ------------------------------------------------------------ Checkout Sessions
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createCheckoutSession: async (input, options) =>
      call('POST', '/v1/checkout/sessions', toCheckoutSessionParams(input, { nowMs: nowMs(), indiaExports: config.indiaExports }), options),
    /** @param {string} id @param {import('./http.js').RequestOptions & { expand?: string[] }} [options] */
    retrieveCheckoutSession: async (id, options) =>
      call('GET', `/v1/checkout/sessions/${pathId(id, ['cs'])}`, expandOf(options), options),
    /** Stops an open session from being paid. @param {string} id @param {import('./http.js').RequestOptions} [options] */
    expireCheckoutSession: async (id, options) => call('POST', `/v1/checkout/sessions/${pathId(id, ['cs'])}/expire`, undefined, options),

    // ------------------------------------------------------------ Payment Links
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createPaymentLink: async (input, options) =>
      call('POST', '/v1/payment_links', toPaymentLinkParams(input, { indiaExports: config.indiaExports }), options),
    /** @param {string} id @param {import('./http.js').RequestOptions} [options] */
    retrievePaymentLink: async (id, options) => call('GET', `/v1/payment_links/${pathId(id, ['plink'])}`, undefined, options),
    /** Payment Links can't be deleted; deactivating stops new payments. */
    deactivatePaymentLink: async (/** @type {string} */ id, /** @type {any} */ options) =>
      call('POST', `/v1/payment_links/${pathId(id, ['plink'])}`, { active: false }, options),

    // ------------------------------------------------------------ Customers
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createCustomer: async (input, options) => call('POST', '/v1/customers', toCustomerParams(input), options),
    /** @param {string} id @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    updateCustomer: async (id, input, options) => call('POST', `/v1/customers/${pathId(id, ['cus'])}`, toCustomerParams(input), options),
    /** @param {string} id @param {import('./http.js').RequestOptions} [options] */
    retrieveCustomer: async (id, options) => call('GET', `/v1/customers/${pathId(id, ['cus'])}`, undefined, options),
    /**
     * Exact, case-sensitive email match (Stripe list filter). Returns the array of customers.
     * @param {string} email @param {{ limit?: number } & import('./http.js').RequestOptions} [options]
     */
    findCustomersByEmail: async (email, options = {}) => {
      if (typeof email !== 'string' || !email.includes('@') || email.length > 512) throw new StripeConfigError('Invalid email');
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 100);
      const list = await call('GET', '/v1/customers', { email, limit }, options);
      return Array.isArray(list?.data) ? list.data : [];
    },

    // ------------------------------------------------------------ Products and Prices
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createProduct: async (input, options) => call('POST', '/v1/products', toProductParams(input), options),
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createPrice: async (input, options) => call('POST', '/v1/prices', toPriceParams(input), options),
    /** @param {string} id @param {import('./http.js').RequestOptions} [options] */
    retrievePrice: async (id, options) => call('GET', `/v1/prices/${pathId(id, ['price', 'plan'])}`, undefined, options),

    // ------------------------------------------------------------ Subscriptions
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createSubscription: async (input, options) => call('POST', '/v1/subscriptions', toSubscriptionParams(input), options),
    /** @param {string} id @param {import('./http.js').RequestOptions & { expand?: string[] }} [options] */
    retrieveSubscription: async (id, options) => call('GET', `/v1/subscriptions/${pathId(id, ['sub'])}`, expandOf(options), options),
    /**
     * atPeriodEnd: true keeps access until the paid period ends; otherwise cancels now.
     * @param {string} id @param {{ atPeriodEnd?: boolean } & import('./http.js').RequestOptions} [options]
     */
    cancelSubscription: async (id, options = {}) =>
      options.atPeriodEnd
        ? call('POST', `/v1/subscriptions/${pathId(id, ['sub'])}`, { cancel_at_period_end: true }, options)
        : call('DELETE', `/v1/subscriptions/${pathId(id, ['sub'])}`, undefined, options),

    // ------------------------------------------------------------ Refunds and payments
    /** @param {unknown} input @param {import('./http.js').RequestOptions} [options] */
    createRefund: async (input, options) => call('POST', '/v1/refunds', toRefundParams(input), options),
    /** @param {string} id @param {import('./http.js').RequestOptions} [options] */
    retrieveRefund: async (id, options) => call('GET', `/v1/refunds/${pathId(id, ['re', 'pyr'])}`, undefined, options),
    /** @param {string} id @param {import('./http.js').RequestOptions & { expand?: string[] }} [options] */
    retrievePaymentIntent: async (id, options) => call('GET', `/v1/payment_intents/${pathId(id, ['pi'])}`, expandOf(options), options),

    // ------------------------------------------------------------ Events and account
    /** For reconciling missed webhooks and reading thin events. @param {string} id @param {import('./http.js').RequestOptions} [options] */
    retrieveEvent: async (id, options) => call('GET', `/v1/events/${pathId(id, ['evt'])}`, undefined, options),
    /** The account behind the key: country ('IN' for Indian accounts), default_currency, charges_enabled. Doubles as a connection test. */
    retrieveAccount: async (/** @type {any} */ options) => call('GET', '/v1/account', undefined, options),

    // ------------------------------------------------------------ Webhooks
    webhooks: Object.freeze({
      /**
       * Verifies with the configured secret(s) and tolerance.
       * @param {Buffer|Uint8Array|string} rawBody @param {any} headers
       */
      verify: (rawBody, headers) => {
        if (!config.webhookSecret) throw new StripeConfigError('webhookSecret is not configured');
        return verifyWebhook(rawBody, headers, config.webhookSecret, { toleranceSec: config.webhookToleranceSec, now: nowMs });
      },
      parse: parseWebhook,
      /**
       * Verify, then parse. Throws StripeSignatureError (respond 400) or StripeEventError.
       * @param {Buffer|Uint8Array|string} rawBody @param {any} headers
       */
      constructEvent: (rawBody, headers) => {
        if (!config.webhookSecret) throw new StripeConfigError('webhookSecret is not configured');
        verifyWebhook(rawBody, headers, config.webhookSecret, { toleranceSec: config.webhookToleranceSec, now: nowMs });
        return parseWebhook(rawBody);
      },
    }),
  });
}
