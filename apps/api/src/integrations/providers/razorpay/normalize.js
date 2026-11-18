import { normalizeNotes, unixToIso } from './util.js';

/**
 * Razorpay entities → plain camelCase objects. Amounts stay integer minor units (paise for INR)
 * next to their ISO currency; unix-second timestamps become ISO-8601 UTC strings (null when unset).
 * Customer contact fields (email, contact, vpa) are personal data: keep them out of logs.
 */

/** @param {any} e */
export function normalizeOrder(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: e.id ?? null,
    status: e.status ?? null, // created | attempted | paid
    amount: e.amount ?? null,
    amountPaid: e.amount_paid ?? null,
    amountDue: e.amount_due ?? null,
    currency: e.currency ?? null,
    receipt: e.receipt ?? null,
    attempts: e.attempts ?? null,
    notes: normalizeNotes(e.notes),
    createdAt: unixToIso(e.created_at),
  };
}

/** @param {any} e */
export function normalizePayment(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: e.id ?? null,
    status: e.status ?? null, // created | authorized | captured | refunded | failed | pending (seen in payment.pending)
    amount: e.amount ?? null,
    currency: e.currency ?? null,
    amountRefunded: e.amount_refunded ?? 0,
    refundStatus: e.refund_status ?? null,
    captured: e.captured === true,
    method: e.method ?? null,
    orderId: e.order_id ?? null,
    invoiceId: e.invoice_id ?? null,
    international: e.international === true,
    description: e.description ?? null,
    email: e.email ?? null,
    contact: e.contact ?? null,
    bank: e.bank ?? null,
    wallet: e.wallet ?? null,
    vpa: e.vpa ?? null,
    fee: e.fee ?? null, // Razorpay fee incl. GST, minor units
    tax: e.tax ?? null, // GST part of the fee
    error: e.error_code
      ? {
          code: e.error_code,
          description: e.error_description ?? null,
          source: e.error_source ?? null,
          step: e.error_step ?? null,
          reason: e.error_reason ?? null,
        }
      : null,
    notes: normalizeNotes(e.notes),
    createdAt: unixToIso(e.created_at),
  };
}

/** @param {any} e */
export function normalizeRefund(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: e.id ?? null,
    paymentId: e.payment_id ?? null,
    status: e.status ?? null, // pending | processed | failed
    amount: e.amount ?? null,
    currency: e.currency ?? null,
    speedRequested: e.speed_requested ?? null, // normal | optimum
    speedProcessed: e.speed_processed ?? null, // normal | instant
    receipt: e.receipt ?? null,
    arn: e.acquirer_data?.arn ?? null,
    batchId: e.batch_id ?? null,
    notes: normalizeNotes(e.notes),
    createdAt: unixToIso(e.created_at),
  };
}

/** @param {any} e */
export function normalizePaymentLink(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: e.id ?? null,
    status: e.status ?? null, // created | partially_paid | paid | cancelled | expired
    referenceId: e.reference_id || null,
    amount: e.amount ?? null,
    amountPaid: e.amount_paid ?? 0,
    currency: e.currency ?? null,
    description: e.description ?? null,
    shortUrl: e.short_url ?? null,
    orderId: e.order_id ?? null,
    acceptPartial: e.accept_partial === true,
    customer: e.customer && typeof e.customer === 'object'
      ? { name: e.customer.name ?? null, email: e.customer.email ?? null, contact: e.customer.contact ?? null }
      : null,
    notify: e.notify && typeof e.notify === 'object' ? { sms: e.notify.sms === true, email: e.notify.email === true } : null,
    reminderEnable: e.reminder_enable === true,
    callbackUrl: e.callback_url || null,
    expireBy: unixToIso(e.expire_by),
    expiredAt: unixToIso(e.expired_at),
    cancelledAt: unixToIso(e.cancelled_at),
    notes: normalizeNotes(e.notes),
    createdAt: unixToIso(e.created_at),
    updatedAt: unixToIso(e.updated_at),
  };
}

/** @param {any} e */
export function normalizePlan(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: e.id ?? null,
    period: e.period ?? null,
    interval: e.interval ?? null,
    name: e.item?.name ?? null,
    description: e.item?.description ?? null,
    amount: e.item?.amount ?? null,
    currency: e.item?.currency ?? null,
    notes: normalizeNotes(e.notes),
    createdAt: unixToIso(e.created_at),
  };
}

/** @param {any} e */
export function normalizeSubscription(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: e.id ?? null,
    planId: e.plan_id ?? null,
    customerId: e.customer_id ?? null,
    // created | authenticated | active | pending | halted | cancelled | completed | expired (| paused)
    status: e.status ?? null,
    quantity: e.quantity ?? null,
    totalCount: e.total_count ?? null,
    paidCount: e.paid_count ?? null,
    remainingCount: e.remaining_count ?? null,
    authAttempts: e.auth_attempts ?? null,
    customerNotify: e.customer_notify === true || e.customer_notify === 1,
    shortUrl: e.short_url ?? null,
    offerId: e.offer_id ?? null,
    hasScheduledChanges: e.has_scheduled_changes === true,
    currentStart: unixToIso(e.current_start),
    currentEnd: unixToIso(e.current_end),
    chargeAt: unixToIso(e.charge_at),
    startAt: unixToIso(e.start_at),
    endAt: unixToIso(e.end_at),
    endedAt: unixToIso(e.ended_at),
    expireBy: unixToIso(e.expire_by),
    notes: normalizeNotes(e.notes),
    createdAt: unixToIso(e.created_at),
  };
}
