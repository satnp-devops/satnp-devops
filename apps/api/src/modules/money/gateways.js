import { AppError } from '../../lib/errors.js';
import { parseWebhook as parseRazorpayWebhook, verifyWebhook as verifyRazorpayWebhook } from '../../integrations/providers/razorpay/index.js';
import { constructEvent as constructStripeEvent, isoMinorToStripe, stripeToIsoMinor } from '../../integrations/providers/stripe/index.js';
import { parseWebhook as parseDigioWebhook, verifyWebhook as verifyDigioWebhook } from '../../integrations/providers/digio/index.js';
import { PAYMENT_METHODS } from './constants.js';

// The payments port's adapters. A gateway hides one provider behind the same five calls:
//   createPaymentLink, cancelPaymentLink, createRefund, parseWebhook (verify + normalise)
// razorpayGateway / stripeGateway wrap the real provider clients (integrations/providers/*);
// ports.js picks the client per company (the integration framework supplies it at integration).
// Webhook events are normalised to one shape (MoneyEvent) so the handlers never see provider JSON.

/**
 * @typedef {{
 *   provider: 'razorpay' | 'stripe', dedupeKey: string, type: string, accountRef: string | null, occurredAt: string | null,
 *   action: 'payment_succeeded' | 'payment_failed' | 'payment_pending' | 'link_expired' | 'link_cancelled' | 'refund_processed' | 'refund_failed' | null,
 *   reference: string | null,
 *   payment: { id: string | null, amountMinor: number | null, currency: string | null, method: string | null,
 *              failure: { code: string | null, message: string | null } | null, feeMinor: number | null, taxMinor: number | null,
 *              orderId: string | null, amountRefundedMinor: number | null } | null,
 *   linkId: string | null,
 *   refund: { id: string | null, paymentId: string | null, amountMinor: number | null, reference: string | null } | null,
 * }} MoneyEvent
 */

/** 400-class error for a webhook that fails verification: the route answers 401 and logs nothing else. */
export class WebhookSignatureError extends AppError {
  constructor(reason) {
    super(401, 'webhook_signature', 'Webhook signature check failed', { reason });
    this.name = 'WebhookSignatureError';
  }
}

export class WebhookPayloadError extends AppError {
  constructor(message = 'Webhook body is not a recognised event') {
    super(400, 'webhook_payload', message);
    this.name = 'WebhookPayloadError';
  }
}

/** A provider call that failed; the API answers 502 with a safe message. */
export class GatewayError extends AppError {
  constructor(provider, cause) {
    const outcomeUnknown = Boolean(cause?.outcomeUnknown);
    super(502, 'provider_error', `${provider === 'stripe' ? 'Stripe' : provider === 'digio' ? 'Digio' : 'Razorpay'} could not complete the request. Try again in a minute.`, {
      provider,
      kind: cause?.kind ?? cause?.category ?? cause?.code ?? null,
      outcomeUnknown,
    });
    this.name = 'GatewayError';
  }
}

const METHOD_MAP = { upi: 'upi', card: 'card', netbanking: 'netbanking', wallet: 'wallet', emi: 'emi', cardless_emi: 'emi', paylater: 'paylater', bank_transfer: 'bank_transfer' };
export const normaliseMethod = (method) => {
  const mapped = METHOD_MAP[String(method ?? '').toLowerCase()];
  return mapped && PAYMENT_METHODS.includes(mapped) ? mapped : method ? 'other' : null;
};

// ---------- Razorpay ----------

const RAZORPAY_ACTIONS = {
  'payment.succeeded': 'payment_succeeded',
  'payment_link.paid': 'payment_succeeded',
  'order.paid': 'payment_succeeded',
  'payment.failed': 'payment_failed',
  'payment.pending': 'payment_pending',
  'payment.authorized': 'payment_pending',
  'payment_link.expired': 'link_expired',
  'payment_link.cancelled': 'link_cancelled',
  'refund.succeeded': 'refund_processed',
  'refund.failed': 'refund_failed',
};

/** Normalised Razorpay event (from parseWebhook / handleWebhook) → MoneyEvent. Pure. */
export function moneyEventFromRazorpay(event) {
  const p = event.payment;
  const link = event.paymentLink;
  return {
    provider: 'razorpay',
    dedupeKey: event.dedupeKey,
    type: event.type,
    accountRef: event.accountId ?? null,
    occurredAt: event.occurredAt ?? null,
    action: RAZORPAY_ACTIONS[event.kind] ?? null,
    reference: link?.referenceId ?? p?.notes?.phoenix_payment_id ?? event.order?.notes?.phoenix_payment_id ?? null,
    payment: p
      ? {
          id: p.id,
          amountMinor: p.amount,
          currency: p.currency ? String(p.currency).toUpperCase() : null,
          method: normaliseMethod(p.method),
          failure: p.error ? { code: p.error.code ?? null, message: p.error.description ?? p.error.reason ?? null } : null,
          feeMinor: p.fee ?? null,
          taxMinor: p.tax ?? null,
          orderId: p.orderId ?? null,
          amountRefundedMinor: p.amountRefunded ?? null,
        }
      : null,
    linkId: link?.id ?? null,
    refund: event.refund
      ? { id: event.refund.id, paymentId: event.refund.paymentId, amountMinor: event.refund.amount, reference: event.refund.notes?.phoenix_refund_id ?? null }
      : null,
  };
}

/** Verify with the webhook secret(s), then normalise. Throws WebhookSignatureError. */
export function parseRazorpayMoneyEvent(rawBody, headers, secrets, { accountRef } = {}) {
  const result = verifyRazorpayWebhook(rawBody, headers, secrets);
  if (!result.valid) throw new WebhookSignatureError(result.reason);
  let event;
  try {
    event = parseRazorpayWebhook(rawBody, headers);
  } catch {
    throw new WebhookPayloadError();
  }
  if (accountRef && event.accountId && event.accountId !== accountRef) throw new WebhookSignatureError('other_account');
  return moneyEventFromRazorpay(event);
}

/**
 * Wrap a Razorpay client (createRazorpayClient) as a gateway.
 * @param {ReturnType<typeof import('../../integrations/providers/razorpay/index.js').createRazorpayClient>} client
 */
export function razorpayGateway(client, { accountRef = null } = {}) {
  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      throw new GatewayError('razorpay', err);
    }
  };
  return {
    provider: 'razorpay',
    createPaymentLink: (input) =>
      wrap(async () => {
        const link = await client.createPaymentLink({
          amount: input.amountMinor,
          currency: input.currency,
          description: input.description.slice(0, 2048),
          customer: compact({ name: input.customer?.name, email: input.customer?.email, contact: input.customer?.phone }),
          notify: { sms: false, email: false }, // the CRM sends its own WhatsApp and email messages
          reminderEnable: false,
          expireBy: input.expiresAt,
          referenceId: input.paymentId,
          notes: { phoenix_payment_id: input.paymentId, phoenix_company_id: input.companyId, purpose: input.purpose },
          ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
        });
        return { linkId: link.id, url: link.shortUrl, orderId: link.orderId ?? null };
      }),
    cancelPaymentLink: (linkId) => wrap(() => client.cancelPaymentLink(linkId)),
    createRefund: (input) =>
      wrap(async () => {
        const refund = await client.createRefund(input.providerPaymentId, {
          amount: input.amountMinor,
          speed: 'normal',
          receipt: input.reference.slice(0, 40),
          notes: { phoenix_refund_id: input.refundId },
          idempotencyKey: input.idempotencyKey,
        });
        return { refundId: refund.id, status: refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending' };
      }),
    parseWebhook(rawBody, headers) {
      let event;
      try {
        event = client.handleWebhook(rawBody, headers);
      } catch (err) {
        if (err?.kind === 'signature') throw new WebhookSignatureError(err.reason ?? err.details?.reason ?? 'signature_mismatch');
        throw new WebhookPayloadError();
      }
      if (accountRef && event.accountId && event.accountId !== accountRef) throw new WebhookSignatureError('other_account');
      return moneyEventFromRazorpay(event);
    },
  };
}

// ---------- Stripe ----------

/** Normalised Stripe event (constructEvent) → MoneyEvent. Pure. */
export function moneyEventFromStripe(event) {
  const p = event.payment;
  let action = null;
  if (event.kind === 'checkout.completed') action = p?.paid ? 'payment_succeeded' : 'payment_pending';
  else if (event.kind === 'checkout.async_payment_succeeded' || event.kind === 'payment.succeeded') action = 'payment_succeeded';
  else if (event.kind === 'checkout.async_payment_failed' || event.kind === 'payment.failed') action = 'payment_failed';
  else if (event.kind === 'refund.updated') action = 'refund_processed';
  const currency = p?.currency ?? null;
  const toIso = (amount) => (amount == null || !currency ? amount ?? null : safe(() => stripeToIsoMinor(amount, currency), amount));
  return {
    provider: 'stripe',
    dedupeKey: `stripe:${event.id}`,
    type: event.type,
    accountRef: event.account ?? null,
    occurredAt: event.createdAt ?? null,
    action,
    reference: p?.metadata?.phoenix_payment_id ?? p?.clientReferenceId ?? null,
    payment: p
      ? {
          id: p.paymentIntentId ?? null,
          amountMinor: toIso(p.amount),
          currency,
          method: 'card',
          failure: p.failure ? { code: p.failure.declineCode ?? p.failure.code ?? null, message: p.failure.message ?? null } : null,
          feeMinor: null,
          taxMinor: null,
          orderId: p.checkoutSessionId ?? null,
          amountRefundedMinor: p.refund ? toIso(p.refund.amountRefunded) : null,
        }
      : null,
    linkId: p?.paymentLinkId ?? null,
    refund: event.kind === 'refund.updated' && p ? { id: null, paymentId: p.paymentIntentId ?? null, amountMinor: toIso(p.refund?.amountRefunded ?? null), reference: null } : null,
  };
}

/** Verify (t= / v1= header, 300 s tolerance), then normalise. Throws WebhookSignatureError. */
export function parseStripeMoneyEvent(rawBody, headers, secrets, options) {
  let event;
  try {
    event = constructStripeEvent(rawBody, headers, secrets, options);
  } catch (err) {
    if (err?.name === 'StripeSignatureError' || err?.category === 'signature') throw new WebhookSignatureError(err.code ?? 'signature_mismatch');
    throw new WebhookPayloadError();
  }
  return moneyEventFromStripe(event);
}

/**
 * Wrap a Stripe client (createStripeClient) as a gateway. Stripe Payment Links are reusable, so each
 * link is limited to one completed checkout. With indiaExports the client also requires a description
 * and collects the billing address (docs/providers/stripe.md, "Can an Indian business use Stripe").
 */
export function stripeGateway(client) {
  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      throw new GatewayError('stripe', err);
    }
  };
  return {
    provider: 'stripe',
    createPaymentLink: (input) =>
      wrap(async () => {
        const link = await client.createPaymentLink(
          {
            lineItems: [{ name: input.description.slice(0, 250), amount: isoMinorToStripe(input.amountMinor, input.currency), currency: input.currency, quantity: 1 }],
            description: input.description.slice(0, 1000),
            metadata: { phoenix_payment_id: input.paymentId, phoenix_company_id: input.companyId },
            ...(input.callbackUrl ? { redirectUrl: input.callbackUrl } : {}),
            extra: { restrictions: { completed_sessions: { limit: 1 } } },
          },
          { idempotencyKey: `plink:${input.paymentId}` },
        );
        return { linkId: link.id, url: link.url, orderId: null };
      }),
    cancelPaymentLink: (linkId) => wrap(() => client.deactivatePaymentLink(linkId)),
    createRefund: (input) =>
      wrap(async () => {
        const refund = await client.createRefund(
          { paymentIntentId: input.providerPaymentId, amount: input.amountMinor, reason: 'requested_by_customer', metadata: { phoenix_refund_id: input.refundId } },
          { idempotencyKey: input.idempotencyKey },
        );
        const status = refund.status === 'succeeded' ? 'processed' : refund.status === 'failed' || refund.status === 'canceled' ? 'failed' : 'pending';
        return { refundId: refund.id, status };
      }),
    parseWebhook(rawBody, headers) {
      let event;
      try {
        event = client.webhooks.constructEvent(rawBody, headers);
      } catch (err) {
        if (err?.name === 'StripeSignatureError' || err?.category === 'signature') throw new WebhookSignatureError(err.code ?? 'signature_mismatch');
        throw new WebhookPayloadError();
      }
      return moneyEventFromStripe(event);
    },
  };
}

// ---------- Digio (e-sign) ----------

/** Verify the X-Digio-Checksum HMAC, then parse. Throws WebhookSignatureError. */
export function parseDigioEvent(rawBody, headers, secrets) {
  const result = verifyDigioWebhook(rawBody, headers, secrets);
  if (!result.ok) throw new WebhookSignatureError(result.reason);
  try {
    return parseDigioWebhook(rawBody);
  } catch {
    throw new WebhookPayloadError();
  }
}

/**
 * Wrap a Digio client (createDigioClient) as the e-sign port.
 * @param {ReturnType<typeof import('../../integrations/providers/digio/index.js').createDigioClient>} client
 */
export function digioEsign(client) {
  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      throw new GatewayError('digio', err);
    }
  };
  return {
    provider: 'digio',
    createSignRequest: (input) => wrap(() => client.createSignRequest(input)),
    getDocument: (id) => wrap(() => client.getDocument(id)),
    cancelSignRequest: (id) => wrap(() => client.cancelSignRequest(id)),
    parseWebhook(rawBody, headers) {
      const result = client.verifyWebhook(rawBody, headers);
      if (!result.ok) throw new WebhookSignatureError(result.reason);
      try {
        return client.parseWebhook(rawBody);
      } catch {
        throw new WebhookPayloadError();
      }
    },
  };
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
