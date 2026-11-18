import { syncDealAttributions } from './attributions.js';
import { accrueCommission, clawbackCommissions } from './commissions.js';

// Event handlers (run by the worker; jobs retry, so every handler is idempotent):
//   deal.created, deal.updated   → attribute the lead to the partner its touch sources name
//   payment.succeeded            → accrue the commission (one per payment id)
//   refund.processed             → claw back inside the window (one per commission and refund);
//   refund.succeeded             → the same (the name the payment provider adapters use)

const TOUCH_CHANGES = new Set(['firstTouch', 'lastTouch', 'first_touch', 'last_touch', 'source', 'partnerId']);

function dealIdOf(event) {
  const id = event.payload?.dealId ?? (event.aggregateType === 'deal' ? event.aggregateId : null);
  return typeof id === 'string' ? id : null;
}

async function onDealCreated(event, { db, log }) {
  const dealId = dealIdOf(event);
  if (!dealId) return;
  const result = await db.transaction((trx) => syncDealAttributions(trx, dealId, { actorUserId: event.actorUserId ?? null }));
  if (result.created || result.updated) log?.info?.({ dealId, ...result }, 'partners: lead attributed');
}

async function onDealUpdated(event, deps) {
  const changes = event.payload?.changes;
  // Only touch-source changes can change who referred the lead. Without a list, check anyway.
  if (Array.isArray(changes) && !changes.some((change) => TOUCH_CHANGES.has(change))) return;
  await onDealCreated(event, deps);
}

/** Domain events carry the payment in `payload`; some producers nest it as `payload.payment`. */
const paymentOf = (event) => (event.payload?.payment && typeof event.payload.payment === 'object' ? { ...event.payload, ...event.payload.payment } : event.payload);

async function onPaymentSucceeded(event, { db, log }) {
  const result = await db.transaction((trx) => accrueCommission(trx, paymentOf(event), { eventId: event.id != null ? String(event.id) : null }));
  if (result.status === 'accrued') log?.info?.({ paymentId: event.payload?.paymentId, commissionId: result.commissionId }, 'partners: commission accrued');
  else if (result.reason === 'invalid_payload') log?.warn?.({ eventId: event.id, type: event.type }, 'partners: payment event without the expected payload');
}

async function onRefund(event, { db, log }) {
  const payload = event.payload?.refund && typeof event.payload.refund === 'object' ? { ...event.payload, ...event.payload.refund } : event.payload;
  const results = await db.transaction((trx) => clawbackCommissions(trx, payload, { eventId: event.id != null ? String(event.id) : null }));
  const clawed = results.filter((r) => r.status === 'clawed_back');
  if (clawed.length) log?.info?.({ refundId: payload?.refundId, clawed }, 'partners: commission clawed back');
}

export const partnerEventHandlers = {
  'deal.created': onDealCreated,
  'deal.updated': onDealUpdated,
  'payment.succeeded': onPaymentSucceeded,
  'refund.processed': onRefund,
  'refund.succeeded': onRefund,
};
