import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signs everything with HMAC-SHA256 and sends the lower-case hex digest.
 *
 * | What                        | Key              | Message                                                        |
 * |-----------------------------|------------------|----------------------------------------------------------------|
 * | Webhook                     | webhook secret   | raw request body (bytes as received)                           |
 * | Checkout (orders)           | API key secret   | `${order_id}|${razorpay_payment_id}`                           |
 * | Checkout (subscriptions)    | API key secret   | `${razorpay_payment_id}|${subscription_id}`                    |
 * | Payment Link callback       | API key secret   | `${plink_id}|${reference_id}|${status}|${razorpay_payment_id}` |
 *
 * Sources: razorpay.com/docs webhooks/validate-test, payment-gateway/web-integration/standard,
 * subscriptions/integration-guide, payment-links/apis (fetched 2026-11-05).
 */

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * @param {string|Uint8Array} message
 * @param {string} secret
 */
export function hmacSha256Hex(message, secret) {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Constant-time comparison of a received hex signature with the expected one.
 * Malformed input (wrong length, not hex) returns false without comparing.
 * @param {unknown} received
 * @param {string} expectedHex
 */
export function signatureMatches(received, expectedHex) {
  if (typeof received !== 'string' || !HEX_SHA256.test(received)) return false;
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when `signature` matches HMAC(message) under any of the secrets. Every secret is
 * checked (no early exit) so timing does not reveal which one matched.
 * @param {string|Uint8Array} message
 * @param {unknown} signature
 * @param {string[]} secrets
 */
export function matchesAnySecret(message, signature, secrets) {
  let ok = false;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && signatureMatches(signature, hmacSha256Hex(message, secret))) {
      ok = true;
    }
  }
  return ok;
}

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.length > 0;

/**
 * Verify the `razorpay_signature` that Standard Checkout returns for an order payment.
 * Use the order id stored on your server, not the one echoed back by the browser.
 * @param {{ orderId: string, paymentId: string, signature: string }} input
 * @param {string} keySecret API key secret
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }, keySecret) {
  if (!isId(orderId) || !isId(paymentId) || !isId(keySecret)) return false;
  return signatureMatches(signature, hmacSha256Hex(`${orderId}|${paymentId}`, keySecret));
}

/**
 * Verify the checkout signature for the authorisation payment of a subscription.
 * Note the order: payment id first, then the subscription id stored on your server.
 * @param {{ subscriptionId: string, paymentId: string, signature: string }} input
 * @param {string} keySecret API key secret
 */
export function verifySubscriptionSignature({ subscriptionId, paymentId, signature }, keySecret) {
  if (!isId(subscriptionId) || !isId(paymentId) || !isId(keySecret)) return false;
  return signatureMatches(signature, hmacSha256Hex(`${paymentId}|${subscriptionId}`, keySecret));
}

/**
 * Verify the signature on a Payment Link callback redirect (query parameters
 * razorpay_payment_link_id, razorpay_payment_link_reference_id, razorpay_payment_link_status,
 * razorpay_payment_id, razorpay_signature). `referenceId` is '' when the link had none.
 * @param {{ paymentLinkId: string, referenceId?: string|null, status: string, paymentId: string, signature: string }} input
 * @param {string} keySecret API key secret
 */
export function verifyPaymentLinkSignature({ paymentLinkId, referenceId, status, paymentId, signature }, keySecret) {
  if (!isId(paymentLinkId) || !isId(status) || !isId(paymentId) || !isId(keySecret)) return false;
  const message = `${paymentLinkId}|${referenceId ?? ''}|${status}|${paymentId}`;
  return signatureMatches(signature, hmacSha256Hex(message, keySecret));
}
