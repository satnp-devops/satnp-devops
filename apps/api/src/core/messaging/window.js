import { WHATSAPP_WINDOW_HOURS } from './constants.js';

// WhatsApp's customer-service window. A business may send free-form messages to a person only
// within 24 hours of that person's last message to the business number; outside it, only approved
// templates (Meta's rule, enforced by the provider). The window is computed from the conversation's
// last inbound message, so the reply box can say "Free text allowed for 13 h more".

const HOUR = 3_600_000;

const toMs = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime());

/**
 * The window after a person's last inbound message. Pure.
 *   open             free text may be sent now
 *   expiresAt        when it closes (null without an inbound message)
 *   remainingSeconds whole seconds left (0 when closed)
 * A last message stamped slightly in the future (clock skew) counts as now.
 * @param {Date | string | number | null | undefined} lastInboundAt
 * @param {{ now?: Date | string | number, hours?: number }} [options]
 * @returns {{ open: boolean, lastInboundAt: string | null, expiresAt: string | null, remainingSeconds: number }}
 */
export function customerServiceWindow(lastInboundAt, { now = Date.now(), hours = WHATSAPP_WINDOW_HOURS } = {}) {
  if (lastInboundAt === null || lastInboundAt === undefined) {
    return { open: false, lastInboundAt: null, expiresAt: null, remainingSeconds: 0 };
  }
  const nowMs = toMs(now);
  const lastMs = toMs(lastInboundAt);
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) throw new TypeError('customerServiceWindow needs valid dates');
  const startMs = Math.min(lastMs, nowMs);
  const expiresMs = startMs + hours * HOUR;
  const remainingMs = Math.max(0, expiresMs - nowMs);
  return {
    open: remainingMs > 0,
    lastInboundAt: new Date(lastMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    remainingSeconds: Math.floor(remainingMs / 1000),
  };
}

/** The latest of several timestamps (a contact with several threads on one number). Pure. */
export function latestTime(values) {
  let best = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (best === null || toMs(value) > toMs(best)) best = value;
  }
  return best;
}
