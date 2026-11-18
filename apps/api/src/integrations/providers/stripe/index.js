/**
 * Stripe (international payments) provider client. Dependency-free apart from zod.
 * Docs: docs/providers/stripe.md
 *
 *   import { createStripeClient, constructEvent } from './integrations/providers/stripe/index.js';
 *   const stripe = createStripeClient({ secretKey, webhookSecret }, { fetch, now, logger });
 *   const session = await stripe.createCheckoutSession({ lineItems: [...], successUrl, metadata });
 *   // webhook route (raw body!):
 *   const event = stripe.webhooks.constructEvent(req.rawBody, req.headers);
 */
import { verifyWebhook } from './webhook.js';
import { parseWebhook } from './events.js';

export { createStripeClient, CAPABILITIES } from './client.js';
export { stripeConfigSchema, parseStripeConfig, DEFAULT_API_VERSION, DEFAULT_WEBHOOK_TOLERANCE_SEC } from './config.js';
export {
  StripeError,
  StripeConfigError,
  StripeRequestError,
  StripeConnectionError,
  StripeSignatureError,
  StripeEventError,
  ERROR_CATEGORIES,
  redact,
} from './errors.js';
export {
  verifyWebhook,
  computeSignature,
  parseSignatureHeader,
  getSignatureHeader,
  generateTestSignatureHeader,
  SIGNATURE_HEADER,
} from './webhook.js';
export { parseWebhook, EVENT_KINDS, RECOMMENDED_EVENT_TYPES } from './events.js';
export {
  ZERO_DECIMAL_CURRENCIES,
  THREE_DECIMAL_CURRENCIES,
  WHOLE_UNITS_IN_HUNDREDTHS,
  normalizeCurrency,
  stripeDecimals,
  isZeroDecimal,
  assertStripeAmount,
  isoMinorToStripe,
  stripeToIsoMinor,
  majorToStripeAmount,
  stripeAmountToMajor,
} from './currency.js';
export { encodeForm, flattenParams } from './form.js';

/**
 * Verifies the signature, then parses the event. Pure: no client or network needed.
 * @param {Buffer|Uint8Array|string} rawBody
 * @param {Headers|Record<string, string|string[]|undefined>|string} headers
 * @param {string|string[]} secret
 * @param {{ toleranceSec?: number, now?: () => number|Date }} [options]
 * @returns {import('./events.js').NormalizedEvent}
 */
export function constructEvent(rawBody, headers, secret, options) {
  verifyWebhook(rawBody, headers, secret, options);
  return parseWebhook(rawBody);
}
