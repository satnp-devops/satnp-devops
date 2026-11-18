import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';

// What the delivery module needs from modules built elsewhere, behind small functions the
// integrator connects (docs/delivery/DELIVERY.md §9). Everything else goes through domain events.
//
// Development stubs work without those modules:
//   createPaymentLink  → a link to the checkout page's own "Simulate payment" step, which emits
//                        payment.succeeded exactly as the money module will (dev and test only).
//
// Wiring (after the merge), once, at start-up in server.js and worker.js:
//   import { connectDeliveryPorts } from './modules/delivery/ports.js';
//   connectDeliveryPorts({ createPaymentLink: (input) => money.paymentLinks.create(input) });

/**
 * @typedef {{
 *   companyId: string, unitId: string, amountMinor: number, currency: string,
 *   reference: string,                       // the checkout session id: comes back on payment.succeeded
 *   description: string,                     // "SAT Evening batch (Jan 2027)"
 *   customer: { name: string, phone?: string | null, email?: string | null },
 *   returnUrl: string,                       // where the payer lands afterwards
 *   expiresAt: string,                       // ISO time; the link must stop working after it
 *   metadata: { checkoutSessionId: string, companyCode: string, batchId: string, productId: string },
 * }} PaymentLinkInput
 * @typedef {{ id: string, url: string, provider: string, expiresAt?: string | null }} PaymentLink
 */

/** @param {PaymentLinkInput & { token: string }} input @returns {Promise<PaymentLink>} */
async function devPaymentLink(input) {
  if (env.isProd) throw new Error('Payment links are not connected: wire connectDeliveryPorts({ createPaymentLink }) to the money module');
  const query = new URLSearchParams({ session: input.metadata.checkoutSessionId, token: input.token });
  return {
    id: `dev_plink_${randomUUID()}`,
    url: `${env.APP_URL}/checkout/${encodeURIComponent(input.metadata.companyCode)}/pay?${query}`,
    provider: 'dev',
    expiresAt: input.expiresAt,
  };
}

const ports = { createPaymentLink: devPaymentLink };

/** True while the payment-link port is the development stub (enables the simulate-payment endpoint). */
export const usingDevPayments = () => ports.createPaymentLink === devPaymentLink && !env.isProd;

/** Connect real implementations (integrator). Unknown names throw so typos are caught at start-up. */
export function connectDeliveryPorts(implementations) {
  for (const [name, fn] of Object.entries(implementations)) {
    if (!(name in ports)) throw new Error(`Unknown delivery port "${name}"`);
    if (typeof fn !== 'function') throw new TypeError(`Delivery port "${name}" must be a function`);
    ports[name] = fn;
  }
}

/** @param {PaymentLinkInput & { token: string }} input */
export const createPaymentLink = (input) => ports.createPaymentLink(input);
