import { z } from 'zod';
import { amountMinor, currency, defineKind, e164, email, isoTime, metadata, reference } from './common.js';

// Payments and e-sign. Amounts are integer minor units (paise, cents) with an ISO currency.
// Money calls always carry our `reference` (the invoice, instalment or agreement id), which the
// provider echoes back in webhooks so an event can never be credited to the wrong record.

const customer = z.strictObject({
  name: z.string().min(1).max(200),
  email: email.optional(),
  phone: e164.optional(),
});

const paymentStatus = z.enum(['created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded']);
const subscriptionStatus = z.enum(['created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired']);

export const payments = defineKind({
  key: 'payments',
  label: 'Payments',
  description: 'Payment links, subscriptions (instalments, renewals) and refunds.',
  methods: {
    createPaymentLink: {
      description: 'A hosted payment page for one amount. The link expires at expiresAt (default: the provider default).',
      input: z.strictObject({
        amountMinor,
        currency,
        description: z.string().min(1).max(2048),
        customer,
        reference,
        expiresAt: isoTime.optional(),
        notes: metadata,
      }),
      output: z.object({
        providerLinkId: z.string().min(1),
        url: z.string().url(),
        status: z.enum(['created', 'paid', 'expired', 'cancelled']),
        expiresAt: isoTime.nullable(),
      }),
    },
    getPayment: {
      description: 'The state of one payment.',
      input: z.strictObject({ providerPaymentId: z.string().min(1).max(200) }),
      output: z.object({
        providerPaymentId: z.string(),
        status: paymentStatus,
        amountMinor: z.number().int().min(0),
        currency,
        method: z.string().nullable(),
        paidAt: isoTime.nullable(),
        reference: z.string().nullable(),
      }),
    },
    refund: {
      description: 'Refund all of a captured payment, or amountMinor of it. `reference` makes retries safe (provider idempotency key).',
      input: z.strictObject({
        providerPaymentId: z.string().min(1).max(200),
        amountMinor: amountMinor.optional(),
        reason: z.string().max(500).optional(),
        reference,
      }),
      output: z.object({ providerRefundId: z.string().min(1), status: z.enum(['pending', 'processed', 'failed']), amountMinor: z.number().int().min(0) }),
    },
    createSubscription: {
      description: 'Start a recurring charge on a provider plan (planRef). authUrl, when present, is where the customer approves the mandate.',
      input: z.strictObject({
        planRef: z.string().min(1).max(200),
        customer,
        startAt: isoTime.optional(),
        totalCount: z.number().int().min(1).max(1200).optional(),
        reference,
        notes: metadata,
      }),
      output: z.object({ providerSubscriptionId: z.string().min(1), status: subscriptionStatus, authUrl: z.string().url().nullable() }),
    },
    cancelSubscription: {
      description: 'Stop a subscription now or at the end of the current period.',
      input: z.strictObject({ providerSubscriptionId: z.string().min(1).max(200), atPeriodEnd: z.boolean().default(true) }),
      output: z.object({ providerSubscriptionId: z.string(), status: subscriptionStatus }),
    },
  },
  webhooks: {
    description: 'Payment, refund and subscription events, signed with the webhook secret (HMAC-SHA256 for Razorpay, Stripe-Signature for Stripe).',
    events: {
      'payment.captured': '{ providerPaymentId, amountMinor, currency, method, reference, paidAt }',
      'payment.failed': '{ providerPaymentId, amountMinor, currency, reference, errorCode?, errorMessage? }',
      'payment_link.paid': '{ providerLinkId, providerPaymentId, amountMinor, currency, reference }',
      'payment_link.expired': '{ providerLinkId, reference }',
      'refund.processed': '{ providerRefundId, providerPaymentId, amountMinor, reference }',
      'refund.failed': '{ providerRefundId, providerPaymentId, reference }',
      'subscription.activated': '{ providerSubscriptionId, reference }',
      'subscription.charged': '{ providerSubscriptionId, providerPaymentId, amountMinor, currency, reference }',
      'subscription.halted': '{ providerSubscriptionId, reference }',
      'subscription.cancelled': '{ providerSubscriptionId, reference }',
    },
  },
  sample: {
    method: 'createPaymentLink',
    input: ({ now, provider }) => ({
      amountMinor: 100,
      currency: provider === 'stripe' ? 'USD' : 'INR',
      description: 'Connection check',
      customer: { name: 'Test customer', email: 'test@example.com' },
      reference: `check-${now()}`,
    }),
  },
});

const signingStatus = z.enum(['requested', 'partially_signed', 'completed', 'expired', 'declined', 'cancelled']);

export const esign = defineKind({
  key: 'esign',
  label: 'E-sign',
  description: 'Send agreements for electronic signature (Aadhaar eSign or electronic signature) and fetch the signed copy.',
  methods: {
    createSigningRequest: {
      description: 'Upload a PDF and ask the signers to sign it, in order when `order` is given.',
      input: z.strictObject({
        document: z.strictObject({
          fileName: z.string().min(1).max(255).regex(/\.pdf$/i, 'Must be a PDF'),
          contentBase64: z.string().min(1).max(14_000_000),
        }),
        signers: z
          .array(
            z
              .strictObject({
                name: z.string().min(1).max(200),
                email: email.optional(),
                phone: e164.optional(),
                order: z.number().int().min(1).max(10).optional(),
              })
              .refine((s) => s.email || s.phone, { message: 'Give an email or a phone', path: ['email'] }),
          )
          .min(1)
          .max(10),
        reference,
        expiresInDays: z.number().int().min(1).max(90).optional(),
        message: z.string().max(1000).optional(),
      }),
      output: z.object({
        providerRequestId: z.string().min(1),
        status: signingStatus,
        signers: z.array(z.object({ name: z.string(), signingUrl: z.string().url().nullable() })),
      }),
    },
    getSigningRequest: {
      description: 'Where a signing request stands.',
      input: z.strictObject({ providerRequestId: z.string().min(1).max(200) }),
      output: z.object({
        providerRequestId: z.string(),
        status: signingStatus,
        signers: z.array(z.object({ name: z.string(), status: z.enum(['pending', 'signed', 'declined']), signedAt: isoTime.nullable() })),
      }),
    },
    downloadSigned: {
      description: 'The signed PDF of a completed request.',
      input: z.strictObject({ providerRequestId: z.string().min(1).max(200) }),
      output: z.object({ fileName: z.string(), contentType: z.literal('application/pdf'), contentBase64: z.string() }),
    },
    cancelSigningRequest: {
      description: 'Withdraw a request that is not yet complete.',
      input: z.strictObject({ providerRequestId: z.string().min(1).max(200) }),
      output: z.object({ providerRequestId: z.string(), status: z.literal('cancelled') }),
    },
  },
  webhooks: {
    description: 'Signing progress, signed with the webhook secret.',
    events: {
      'esign.signed': '{ providerRequestId, signerName, signedAt, reference }',
      'esign.completed': '{ providerRequestId, reference }',
      'esign.declined': '{ providerRequestId, signerName, reference }',
      'esign.expired': '{ providerRequestId, reference }',
    },
  },
  sample: {
    method: 'createSigningRequest',
    input: ({ now }) => ({
      document: { fileName: 'connection-check.pdf', contentBase64: Buffer.from('%PDF-1.4\n% connection check\n%%EOF\n').toString('base64') },
      signers: [{ name: 'Test signer', email: 'test@example.com' }],
      reference: `check-${now()}`,
    }),
  },
});
