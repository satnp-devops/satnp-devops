import { IntegrationError } from '../errors.js';
import { esign, payments } from '../kinds/money.js';
import { callKey, healthFor, iso, maybeFail, mockWebhookMethods, stableId } from './common.js';

// Mock payments and e-sign.
//
// Payments: a mock payment link counts as paid at once. Its payment id is the link id with
// "plink_" replaced by "pay_", so getPayment and refund work without a webhook. Refunds are
// processed immediately and can't exceed what is left of the payment.
//
// E-sign: a mock signing request is fully signed 60 seconds after it was created (by the
// injected clock), unless it was cancelled first; downloadSigned then returns a small PDF.

const providerError = (ctx, message, reason) =>
  new IntegrationError('integration_provider_error', message, { kind: ctx.connection.kind, provider: 'mock', details: { reason } });

const formatAmount = (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`;

export function createPaymentsMock(ctx) {
  async function paymentState(providerPaymentId) {
    if (!providerPaymentId.startsWith('pay_')) return null;
    const link = await ctx.findRecord({ providerRef: providerPaymentId.replace(/^pay_/, 'plink_'), operation: 'createPaymentLink' });
    if (!link) return null;
    const refunds = await ctx.listRecords({ operation: 'refund', reference: providerPaymentId });
    const refunded = refunds.reduce((sum, row) => sum + (row.payload?.amountMinor ?? 0), 0);
    const amountMinor = link.payload.amountMinor;
    return { link, amountMinor, refunded, currency: link.payload.currency };
  }

  return {
    kind: payments.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    async createPaymentLink(input) {
      maybeFail(ctx, 'createPaymentLink');
      const providerLinkId = stableId('plink_mock', ctx.connection.id, callKey(input));
      await ctx.record({
        operation: 'createPaymentLink',
        recipient: input.customer.email ?? input.customer.phone ?? input.customer.name,
        subject: `${formatAmount(input.amountMinor, input.currency)} · ${input.reference}`,
        body: input.description,
        providerRef: providerLinkId,
        status: 'created',
        payload: input,
      });
      return { providerLinkId, url: `https://pay.mock.phoenix.invalid/${providerLinkId}`, status: 'created', expiresAt: input.expiresAt ?? null };
    },
    async getPayment({ providerPaymentId }) {
      maybeFail(ctx, 'getPayment');
      const state = await paymentState(providerPaymentId);
      if (!state) throw providerError(ctx, 'The mock has no payment with that id', 'not_found');
      const status = state.refunded === 0 ? 'captured' : state.refunded >= state.amountMinor ? 'refunded' : 'partially_refunded';
      return {
        providerPaymentId,
        status,
        amountMinor: state.amountMinor,
        currency: state.currency,
        method: 'upi',
        paidAt: new Date(state.link.created_at).toISOString(),
        reference: state.link.payload.reference,
      };
    },
    async refund(input) {
      maybeFail(ctx, 'refund');
      const state = await paymentState(input.providerPaymentId);
      if (!state) throw providerError(ctx, 'The mock has no payment with that id', 'not_found');
      // `reference` is the idempotency key: the same refund asked twice is answered, not repeated.
      const providerRefundId = stableId('rfnd_mock', ctx.connection.id, input.reference);
      const existing = await ctx.findRecord({ providerRef: providerRefundId, operation: 'refund' });
      if (existing) return { providerRefundId, status: 'processed', amountMinor: existing.payload.amountMinor };
      const amountMinor = input.amountMinor ?? state.amountMinor - state.refunded;
      if (amountMinor <= 0 || amountMinor > state.amountMinor - state.refunded) {
        throw providerError(ctx, 'The refund is more than what is left of the payment', 'amount_exceeds_payment');
      }
      await ctx.record({
        operation: 'refund',
        recipient: null,
        subject: `Refund ${formatAmount(amountMinor, state.currency)}`,
        body: input.reason ?? null,
        providerRef: providerRefundId,
        reference: input.providerPaymentId,
        status: 'processed',
        payload: { ...input, amountMinor },
      });
      return { providerRefundId, status: 'processed', amountMinor };
    },
    async createSubscription(input) {
      maybeFail(ctx, 'createSubscription');
      const providerSubscriptionId = stableId('sub_mock', ctx.connection.id, callKey(input));
      await ctx.record({
        operation: 'createSubscription',
        recipient: input.customer.email ?? input.customer.phone ?? input.customer.name,
        subject: `Plan ${input.planRef}`,
        body: input.totalCount ? `${input.totalCount} charges` : 'Until cancelled',
        providerRef: providerSubscriptionId,
        status: 'created',
        payload: input,
      });
      return { providerSubscriptionId, status: 'created', authUrl: `https://pay.mock.phoenix.invalid/sub/${providerSubscriptionId}` };
    },
    async cancelSubscription(input) {
      maybeFail(ctx, 'cancelSubscription');
      await ctx.record({
        operation: 'cancelSubscription',
        recipient: null,
        subject: input.atPeriodEnd ? 'Cancel at period end' : 'Cancel now',
        body: null,
        providerRef: input.providerSubscriptionId,
        status: 'cancelled',
        payload: input,
      });
      return { providerSubscriptionId: input.providerSubscriptionId, status: 'cancelled' };
    },
    ...mockWebhookMethods(ctx, payments),
  };
}

const SIGN_AFTER_MS = 60_000;

export function createEsignMock(ctx) {
  async function requestState(providerRequestId) {
    const row = await ctx.findRecord({ providerRef: providerRequestId, operation: 'createSigningRequest' });
    if (!row) return null;
    const cancelled = await ctx.findRecord({ providerRef: providerRequestId, operation: 'cancelSigningRequest' });
    const signedAt = new Date(new Date(row.created_at).getTime() + SIGN_AFTER_MS);
    const completed = !cancelled && signedAt.getTime() <= ctx.now();
    return { row, cancelled: Boolean(cancelled), completed, signedAt: signedAt.toISOString() };
  }

  return {
    kind: esign.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx);
    },
    async createSigningRequest(input) {
      maybeFail(ctx, 'createSigningRequest');
      const providerRequestId = stableId('mock-doc', ctx.connection.id, callKey(input));
      await ctx.record({
        operation: 'createSigningRequest',
        recipient: input.signers.map((s) => s.email ?? s.phone).join(', '),
        subject: input.document.fileName,
        body: input.message ?? null,
        providerRef: providerRequestId,
        status: 'requested',
        payload: input,
      });
      return {
        providerRequestId,
        status: 'requested',
        signers: input.signers.map((signer, i) => ({ name: signer.name, signingUrl: `https://sign.mock.phoenix.invalid/${providerRequestId}/${i + 1}` })),
      };
    },
    async getSigningRequest({ providerRequestId }) {
      const state = await requestState(providerRequestId);
      if (!state) throw providerError(ctx, 'The mock has no signing request with that id', 'not_found');
      const status = state.cancelled ? 'cancelled' : state.completed ? 'completed' : 'requested';
      return {
        providerRequestId,
        status,
        signers: (state.row.payload.signers ?? []).map((signer) => ({
          name: signer.name,
          status: state.completed ? 'signed' : 'pending',
          signedAt: state.completed ? state.signedAt : null,
        })),
      };
    },
    async downloadSigned({ providerRequestId }) {
      const state = await requestState(providerRequestId);
      if (!state) throw providerError(ctx, 'The mock has no signing request with that id', 'not_found');
      if (!state.completed) throw providerError(ctx, 'The document is not signed yet', 'not_completed');
      const pdf = `%PDF-1.4\n% Mock signed copy of ${state.row.payload.document.fileName} (${providerRequestId}), signed ${state.signedAt}\n%%EOF\n`;
      return {
        fileName: state.row.payload.document.fileName.replace(/\.pdf$/i, '-signed.pdf'),
        contentType: 'application/pdf',
        contentBase64: Buffer.from(pdf).toString('base64'),
      };
    },
    async cancelSigningRequest({ providerRequestId }) {
      maybeFail(ctx, 'cancelSigningRequest');
      const state = await requestState(providerRequestId);
      if (!state) throw providerError(ctx, 'The mock has no signing request with that id', 'not_found');
      if (state.completed) throw providerError(ctx, 'The document is already signed', 'already_completed');
      if (!state.cancelled) {
        await ctx.record({ operation: 'cancelSigningRequest', recipient: null, subject: 'Signing request cancelled', body: null, providerRef: providerRequestId, status: 'cancelled', payload: { providerRequestId } });
      }
      return { providerRequestId, status: 'cancelled' };
    },
    ...mockWebhookMethods(ctx, esign),
  };
}
