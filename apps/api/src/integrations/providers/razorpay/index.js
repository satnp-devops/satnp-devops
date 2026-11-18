/**
 * Razorpay provider client (payments, INR). Dependency-free apart from zod; uses global fetch.
 *
 *   import { createRazorpayClient } from './integrations/providers/razorpay/index.js';
 *   const rzp = createRazorpayClient({ keyId, keySecret, webhookSecret }, { logger });
 *   const order = await rzp.createOrder({ amount: 50000, currency: 'INR', receipt: 'adm_123' });
 *   const event = rzp.handleWebhook(req.rawBody, req.headers); // throws RazorpayError('signature')
 *
 * Pure helpers (no client needed): verifyWebhook, parseWebhook, verifyPaymentSignature,
 * verifySubscriptionSignature, verifyPaymentLinkSignature. See docs/providers/razorpay.md.
 */
export { createRazorpayClient, CAPABILITIES } from './client.js';
export { razorpayConfigSchema, parseConfig, modeFromKeyId, DEFAULT_BASE_URL } from './config.js';
export { RazorpayError, isRazorpayError, isRetryable, mapHttpError, redact } from './errors.js';
export {
  verifyWebhook,
  parseWebhook,
  EVENT_KINDS,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
} from './webhooks.js';
export {
  hmacSha256Hex,
  signatureMatches,
  verifyPaymentSignature,
  verifySubscriptionSignature,
  verifyPaymentLinkSignature,
} from './signatures.js';
export {
  normalizeOrder,
  normalizePayment,
  normalizePaymentLink,
  normalizePlan,
  normalizeRefund,
  normalizeSubscription,
} from './normalize.js';
export { backoffDelay, parseRetryAfter } from './http.js';
