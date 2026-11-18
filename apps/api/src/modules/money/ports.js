import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { parseDigioEvent, parseRazorpayMoneyEvent, parseStripeMoneyEvent } from './gateways.js';

// Ports: the few things the money module needs from modules built elsewhere. Each has a
// development stub that works without credentials or network, so quotes, links, webhooks,
// refunds and e-sign can be exercised locally and in tests. The integrator replaces them once,
// at start-up, with configureMoneyPorts({...}) (see README.md, "Wiring").
//
//   paymentGateway({ companyId, provider, account }) → gateway (gateways.js: razorpayGateway(client),
//       stripeGateway(client)); the integration framework's getAdapter('payments', ...) gives the
//       configured client for the company's connection (account.connection_id).
//   esign({ companyId }) → digioEsign(client) for the company's Digio connection.
//   notify(message) → send a WhatsApp / email template through messaging. Called after commit with a
//       stable idempotencyKey, so the messaging service can drop repeats.
//
// The stubs refuse to run in production: a production deployment without connections answers
// 503 not_connected instead of pretending a link was sent.

/** Webhook secrets the development stubs verify with (tests and the dev "simulate" endpoint sign with them). */
export const DEV_WEBHOOK_SECRETS = Object.freeze({
  razorpay: 'phoenix_dev_razorpay_webhook_secret',
  stripe: 'whsec_phoenix_dev_stripe_webhook_secret',
  digio: 'phoenix_dev_digio_webhook_secret',
});

const rand = (length) => randomBytes(length).toString('base64url').replace(/[^A-Za-z0-9]/g, '').padEnd(length, 'x').slice(0, length);

function notConnected(what) {
  return new AppError(503, 'not_connected', `${what} is not connected for this company yet. Ask an admin to connect it in Settings > Integrations.`);
}

/** Development payment gateway: fake links and refunds, real signature checks with the dev secrets. */
export function devPaymentGateway(provider, { accountRef = null } = {}) {
  return {
    provider,
    dev: true,
    async createPaymentLink() {
      const linkId = provider === 'razorpay' ? `plink_dev${rand(14)}` : `plink_dev${rand(20)}`;
      return { linkId, url: `https://pay.example.test/${provider}/${linkId}`, orderId: null };
    },
    async cancelPaymentLink() {},
    async createRefund() {
      return { refundId: provider === 'razorpay' ? `rfnd_dev${rand(14)}` : `re_dev${rand(20)}`, status: 'pending' };
    },
    parseWebhook(rawBody, headers) {
      return provider === 'razorpay'
        ? parseRazorpayMoneyEvent(rawBody, headers, DEV_WEBHOOK_SECRETS.razorpay, { accountRef })
        : parseStripeMoneyEvent(rawBody, headers, DEV_WEBHOOK_SECRETS.stripe);
    },
  };
}

/** Development e-sign: a fake Digio document per request, real checksum checks with the dev secret. */
export function devEsign() {
  return {
    provider: 'digio',
    dev: true,
    async createSignRequest(input) {
      const id = `DIDdev${rand(26)}`;
      const expiresAt = new Date(Date.now() + (input.expiresInDays ?? 10) * 86_400_000).toISOString();
      return {
        provider: 'digio',
        id,
        status: 'pending',
        expiresAt,
        signers: input.signers.map((signer) => ({
          identifier: signer.identifier,
          name: signer.name,
          status: 'pending',
          signUrl: `https://sign.example.test/digio/${id}?signer=${encodeURIComponent(signer.order ?? 1)}`,
        })),
      };
    },
    async getDocument(id) {
      return { provider: 'digio', id, status: 'unknown', signers: [] };
    },
    async cancelSignRequest() {},
    parseWebhook(rawBody, headers) {
      return parseDigioEvent(rawBody, headers, DEV_WEBHOOK_SECRETS.digio);
    },
  };
}

const defaults = {
  async paymentGateway({ provider, account }) {
    if (env.isProd) throw notConnected(provider === 'stripe' ? 'Stripe' : 'Razorpay');
    return devPaymentGateway(provider, { accountRef: account?.account_ref ?? null });
  },
  async esign() {
    if (env.isProd) throw notConnected('Digio e-sign');
    return devEsign();
  },
  async notify(message) {
    // No personal data in logs: ids and the template only.
    logger.info(
      { template: message.template, dealId: message.dealId ?? null, companyId: message.companyId ?? null, idempotencyKey: message.idempotencyKey },
      'money: notification (development stub, nothing sent)',
    );
    return { queued: false };
  },
};

export const ports = { ...defaults };

/**
 * Replace stubs with real implementations (integrator, once at start-up), or with fakes in tests.
 * @param {Partial<typeof defaults>} overrides
 */
export function configureMoneyPorts(overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in defaults)) throw new Error(`Unknown money port "${key}"`);
    if (typeof value !== 'function') throw new Error(`Money port "${key}" must be a function`);
    ports[key] = value;
  }
}

export function resetMoneyPorts() {
  Object.assign(ports, defaults);
}

/** Run notify without letting a messaging failure undo a committed change. */
export async function notifySafely(message) {
  try {
    return await ports.notify(message);
  } catch (err) {
    logger.warn({ err: { message: err?.message }, template: message.template, idempotencyKey: message.idempotencyKey }, 'money: notification failed');
    return { queued: false, error: true };
  }
}
