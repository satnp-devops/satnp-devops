import { db as defaultDb } from '../../lib/db.js';
import { emitEvent } from '../../core/events.js';
import { getSetting } from '../../core/settings.js';
import { companyForUnit } from '../../core/crm/scope.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { formatMoney } from '../../core/crm/money.js';
import { localDate } from '../../core/billing/dates.js';
import { completeCheckout } from './checkout.js';
import { createEnrollment } from './service.js';
import { ensureImplementationProject } from './onboarding.js';
import { renewalFromEvent, upsertRenewal } from './renewals.js';
import { autoAssignBatchSetting, projectTriggersSetting } from './settings.js';

// Event handlers of the delivery module (docs/delivery/DELIVERY.md §9). Every handler is
// idempotent: the outbox delivers at least once and jobs retry.
//
// Payloads we expect from the money module (field names it is free to choose are read with
// fallbacks, see paymentFrom):
//   payment.succeeded   { paymentId, amountMinor, currency, paidAt, dealId?, contactId?,
//                         checkoutSessionId? | reference? | metadata.checkoutSessionId?,
//                         productId?, batchId?, studentContactIds?, isFirstPayment? }
//   checkout.completed | payment_link.paid   same as payment.succeeded (hosted checkout, payment link)
//   refund.processing | refund.completed | refund.failed   { withdrawalId | metadata.withdrawalId, refundId, utr?, paidAt? }
//   contract.signed     { contractId, dealId?, accountId, companyId, unitId?, productId?, ownerUserId? }
//   subscription.created | .started | .activated | .updated | .renewed | .cancelled | .ended
//                       { subscriptionId, accountId?, contactId?, dealId?, productId?, termStart, termEnd
//                         (or currentPeriodEnd), autoRenew, amountMinor, currency, seats?, planName? }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/** Normalise a payment event's payload. */
export function paymentFrom(event) {
  const p = event.payload ?? {};
  const meta = p.metadata ?? p.notes ?? {};
  const paymentId = p.paymentId ?? p.id ?? event.aggregateId;
  const sessionId = [p.checkoutSessionId, meta.checkoutSessionId, p.reference, p.referenceId].find(isUuid) ?? null;
  return {
    paymentId: paymentId ? String(paymentId) : null,
    amountMinor: Number.isSafeInteger(p.amountMinor) ? p.amountMinor : 0,
    currency: typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'INR',
    paidAt: p.paidAt ?? p.capturedAt ?? event.occurredAt ?? new Date().toISOString(),
    sourceEventId: event.id ? `event:${event.id}` : null,
    checkoutSessionId: sessionId,
    dealId: isUuid(p.dealId ?? meta.dealId) ? (p.dealId ?? meta.dealId) : null,
    payerContactId: isUuid(p.contactId ?? p.payerContactId) ? (p.contactId ?? p.payerContactId) : null,
    productId: isUuid(p.productId ?? meta.productId) ? (p.productId ?? meta.productId) : null,
    batchId: isUuid(p.batchId ?? meta.batchId) ? (p.batchId ?? meta.batchId) : null,
    studentContactIds: Array.isArray(p.studentContactIds) ? p.studentContactIds.filter(isUuid) : null,
  };
}

/** The earliest batch of a programme with a free seat, else the earliest joinable one (for its waitlist). */
export async function pickBatch(trx, { companyId, productId }) {
  const rows = await trx('batches')
    .where({ company_id: companyId, product_id: productId })
    .whereIn('status', ['planned', 'open'])
    .where('ends_on', '>=', localDate(Date.now()))
    .orderBy([{ column: 'starts_on' }, { column: 'id' }])
    .limit(20)
    .select('id', 'capacity', 'seats_taken', 'waitlist_enabled');
  return rows.find((b) => b.seats_taken < b.capacity) ?? rows.find((b) => b.waitlist_enabled) ?? null;
}

/**
 * The students a deal's payment enrolls: given ones, else the deal's students, else its primary
 * contact when that person is a student.
 */
async function dealStudents(trx, deal, given) {
  if (given?.length) {
    const rows = await trx('contacts').whereIn('id', given).where({ group_id: deal.group_id }).whereNull('merged_into_id').select('id');
    return rows.map((r) => r.id);
  }
  const rows = await trx('deal_contacts as dc')
    .join('contacts as c', 'c.id', 'dc.contact_id')
    .where('dc.deal_id', deal.id)
    .where((w) => w.where('dc.role', 'student').orWhere('c.kind', 'student'))
    .whereNull('c.merged_into_id')
    .orderBy('dc.created_at')
    .select('c.id');
  if (rows.length) return [...new Set(rows.map((r) => r.id))];
  if (deal.primary_contact_id) {
    const primary = await trx('contacts').where({ id: deal.primary_contact_id }).first('id', 'kind');
    if (primary?.kind === 'student') return [primary.id];
  }
  return [];
}

/** Enroll the students of a family deal on its payment (first payment creates, later ones are recorded). */
export async function enrollFromDealPayment(trx, payment, { log } = {}) {
  const deal = await trx('deals').where({ id: payment.dealId }).first();
  if (!deal || deal.archived_at || deal.account_id) return [];
  const productId = payment.productId ?? deal.product_id;
  if (!productId) {
    log?.warn?.({ dealId: deal.id, paymentId: payment.paymentId }, 'Paid deal has no programme; enroll the student by hand');
    return [];
  }
  const product = await trx('products as p').join('product_lines as l', 'l.id', 'p.product_line_id').where('p.id', productId).first('p.id', 'p.company_id', 'p.product_line_id', 'l.audience');
  if (!product || product.company_id !== deal.company_id || product.audience !== 'b2c') return [];
  const students = await dealStudents(trx, deal, payment.studentContactIds);
  if (students.length === 0) {
    log?.warn?.({ dealId: deal.id, paymentId: payment.paymentId }, 'Paid deal has no student; enroll the student by hand');
    return [];
  }
  const unit = await trx('org_units').where({ id: deal.unit_id }).first();
  let batchId = payment.batchId;
  if (batchId) {
    const batch = await trx('batches').where({ id: batchId, company_id: deal.company_id, product_id: productId }).first('id');
    if (!batch) batchId = null;
  }
  if (!batchId && (await getSetting(unit, autoAssignBatchSetting, trx))) batchId = (await pickBatch(trx, { companyId: deal.company_id, productId }))?.id ?? null;
  let payer = payment.payerContactId;
  if (!payer && deal.primary_contact_id && !students.includes(deal.primary_contact_id)) payer = deal.primary_contact_id;
  const results = [];
  for (const [index, studentId] of students.entries()) {
    const household = await trx('household_members').where({ contact_id: studentId }).orderBy('created_at').first('household_id');
    const result = await createEnrollment(trx, {}, {
      groupId: deal.group_id,
      companyId: deal.company_id,
      unitId: deal.unit_id,
      studentContactId: studentId,
      payerContactId: payer ?? null,
      householdId: household?.household_id ?? null,
      dealId: deal.id,
      productId,
      productLineId: product.product_line_id,
      batchId,
      joinWaitlist: true,
      ownerUserId: deal.owner_user_id ?? null,
      source: 'payment',
      sourceKey: `payment:${payment.paymentId}:${studentId}`,
      // A deal's value is the agreed price for all its students; lock it on the first one only.
      feeMinor: index === 0 && deal.value_minor !== null ? Number(deal.value_minor) : null,
      currency: index === 0 ? deal.currency : null,
      payment: index === 0 ? payment : null,
    });
    results.push(result);
  }
  return results;
}

export async function onPaymentSucceeded(event, { db = defaultDb, log } = {}) {
  const payment = paymentFrom(event);
  if (!payment.paymentId) return;
  await db.transaction(async (trx) => {
    if (payment.checkoutSessionId) {
      const session = await trx('checkout_sessions').where({ id: payment.checkoutSessionId }).first('id');
      if (session) {
        await completeCheckout(trx, session.id, payment);
        return;
      }
    }
    if (payment.dealId) await enrollFromDealPayment(trx, payment, { log });
  });
}

const REFUND_STATUS_BY_EVENT = {
  'refund.processing': 'processing',
  'refund.completed': 'paid',
  'refund.succeeded': 'paid',
  'refund.paid': 'paid',
  'refund.failed': 'failed',
};

export async function onRefundUpdate(event, { db = defaultDb } = {}) {
  const status = REFUND_STATUS_BY_EVENT[event.type];
  const p = event.payload ?? {};
  const withdrawalId = [p.withdrawalId, p.metadata?.withdrawalId, p.reference].find(isUuid);
  if (!status || !withdrawalId) return;
  await db.transaction(async (trx) => {
    const withdrawal = await trx('enrollment_withdrawals').where({ id: withdrawalId }).forUpdate().first();
    if (!withdrawal || withdrawal.refund_status === status || withdrawal.refund_status === 'paid') return;
    const [updated] = await trx('enrollment_withdrawals')
      .where({ id: withdrawal.id })
      .update({
        refund_status: status,
        refund_reference: p.utr ?? p.refundId ?? p.id ?? withdrawal.refund_reference,
        refund_paid_at: status === 'paid' ? new Date(p.paidAt ?? event.occurredAt ?? Date.now()) : null,
        ...(Number.isSafeInteger(p.amountMinor) && status === 'paid' ? { refund_minor: p.amountMinor } : {}),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    const enrollment = await trx('enrollments').where({ id: withdrawal.enrollment_id }).first();
    const amount = formatMoney(Number(updated.refund_minor), updated.currency ?? 'INR');
    const late = status === 'paid' && new Date(updated.refund_paid_at) > new Date(withdrawal.refund_due_at);
    await addTimelineEvent(trx, {
      groupId: enrollment.group_id,
      companyId: enrollment.company_id,
      unitId: enrollment.unit_id,
      dealId: enrollment.deal_id,
      contactId: enrollment.student_contact_id,
      kind: 'system',
      title: status === 'paid' ? `Refund of ${amount} paid${late ? ' (after the deadline)' : ''}` : status === 'failed' ? `Refund of ${amount} failed` : `Refund of ${amount} is being processed`,
      meta: { action: 'enrollment.refund_updated', withdrawalId: withdrawal.id, status, enrollmentId: enrollment.id },
      actorType: 'system',
      sourceEventId: event.id ? `event:${event.id}` : null,
    });
    await emitEvent(trx, {
      type: 'enrollment.refund_updated',
      groupId: enrollment.group_id,
      unitId: enrollment.unit_id,
      aggregateType: 'enrollment',
      aggregateId: enrollment.id,
      payload: { enrollmentId: enrollment.id, withdrawalId: withdrawal.id, companyId: enrollment.company_id, status, late },
    });
  });
}

/** A merged person: their enrollments follow them to the surviving record. */
export async function onContactMerged(event, { db = defaultDb } = {}) {
  const { targetId, sourceId } = event.payload ?? {};
  if (!isUuid(targetId) || !isUuid(sourceId)) return;
  await db.transaction(async (trx) => {
    await trx('enrollments').where({ student_contact_id: sourceId }).update({ student_contact_id: targetId, updated_at: trx.fn.now() });
    await trx('enrollments').where({ payer_contact_id: sourceId }).update({ payer_contact_id: targetId, updated_at: trx.fn.now() });
    await trx('renewals').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: trx.fn.now() });
  });
}

// ---------- B2B: implementation projects and renewals ----------

async function triggers(trx, unitId) {
  const unit = await trx('org_units').where({ id: unitId }).first();
  return unit ? await getSetting(unit, projectTriggersSetting, trx) : [];
}

/** deal.won on an institute deal = the contract is signed (B2B pipelines end in "Contract signed"). */
export async function onDealWon(event, { db = defaultDb } = {}) {
  const dealId = event.payload?.dealId ?? event.aggregateId;
  if (!isUuid(dealId)) return;
  await db.transaction(async (trx) => {
    const deal = await trx('deals').where({ id: dealId }).first();
    if (!deal?.account_id || deal.status !== 'won') return;
    const line = deal.product_line_id ? await trx('product_lines').where({ id: deal.product_line_id }).first('audience') : null;
    if (line && line.audience !== 'b2b') return;
    if (!(await triggers(trx, deal.unit_id)).includes('deal_won')) return;
    await ensureImplementationProject(trx, { actorUserId: event.actorUserId ?? null }, {
      groupId: deal.group_id,
      companyId: deal.company_id,
      unitId: deal.unit_id,
      accountId: deal.account_id,
      dealId: deal.id,
      productId: deal.product_id,
      productLineId: deal.product_line_id,
      ownerUserId: deal.owner_user_id,
      trigger: 'deal_won',
    });
  });
}

/** Where a B2B record from another module belongs: its deal's unit, else the unit or company given. */
async function placeB2b(trx, p, event) {
  const deal = isUuid(p.dealId) ? await trx('deals').where({ id: p.dealId }).first() : null;
  const unitId = deal?.unit_id ?? [p.unitId, event.unitId, p.companyId].find(isUuid);
  if (!unitId) return null;
  const unit = await trx('org_units').where({ id: unitId }).first();
  if (!unit) return null;
  const company = await companyForUnit(unit, trx);
  if (!company || (p.companyId && p.companyId !== company.id)) return null;
  const accountId = isUuid(p.accountId) ? p.accountId : deal?.account_id;
  if (!accountId) return null;
  const account = await trx('accounts').where({ id: accountId, group_id: company.root_id }).first('id');
  if (!account) return null;
  return { deal, unit, company, accountId };
}

export async function onContractSigned(event, { db = defaultDb } = {}) {
  const p = event.payload ?? {};
  const contractId = p.contractId ?? event.aggregateId;
  if (!contractId) return;
  await db.transaction(async (trx) => {
    const place = await placeB2b(trx, p, event);
    if (!place || !(await triggers(trx, place.unit.id)).includes('contract_signed')) return;
    await ensureImplementationProject(trx, { actorUserId: event.actorUserId ?? null }, {
      groupId: place.company.root_id,
      companyId: place.company.id,
      unitId: place.unit.id,
      accountId: place.accountId,
      dealId: place.deal?.id ?? null,
      contractId: String(contractId),
      productId: isUuid(p.productId) ? p.productId : (place.deal?.product_id ?? null),
      productLineId: place.deal?.product_line_id ?? null,
      ownerUserId: isUuid(p.ownerUserId) ? p.ownerUserId : (place.deal?.owner_user_id ?? null),
      trigger: 'contract_signed',
    });
  });
}

const STARTING = new Set(['subscription.created', 'subscription.started', 'subscription.activated']);

export async function onSubscriptionEvent(event, { db = defaultDb } = {}) {
  await db.transaction(async (trx) => {
    const row = await renewalFromEvent(trx, event);
    if (row) await upsertRenewal(trx, row);
    if (!STARTING.has(event.type)) return;
    const p = event.payload ?? {};
    const place = await placeB2b(trx, p, event);
    if (!place || !(await triggers(trx, place.unit.id)).includes('subscription_started')) return;
    const subscriptionId = String(p.subscriptionId ?? event.aggregateId);
    await ensureImplementationProject(trx, { actorUserId: event.actorUserId ?? null }, {
      groupId: place.company.root_id,
      companyId: place.company.id,
      unitId: place.unit.id,
      accountId: place.accountId,
      dealId: place.deal?.id ?? null,
      subscriptionId,
      productId: isUuid(p.productId) ? p.productId : (place.deal?.product_id ?? null),
      productLineId: place.deal?.product_line_id ?? null,
      ownerUserId: isUuid(p.ownerUserId) ? p.ownerUserId : (place.deal?.owner_user_id ?? null),
      kickoffOn: typeof p.termStart === 'string' ? p.termStart.slice(0, 10) : undefined,
      trigger: 'subscription_started',
    });
  });
}

export const enrollmentHandlers = {
  'payment.succeeded': onPaymentSucceeded,
  // A hosted checkout or payment link paid in full (the money module may emit these instead of payment.succeeded).
  'checkout.completed': onPaymentSucceeded,
  'payment_link.paid': onPaymentSucceeded,
  'refund.processing': onRefundUpdate,
  'refund.completed': onRefundUpdate,
  'refund.succeeded': onRefundUpdate,
  'refund.paid': onRefundUpdate,
  'refund.failed': onRefundUpdate,
  'contact.merged': onContactMerged,
};

export const onboardingHandlers = {
  'deal.won': onDealWon,
  'contract.signed': onContractSigned,
  'subscription.created': onSubscriptionEvent,
  'subscription.started': onSubscriptionEvent,
  'subscription.activated': onSubscriptionEvent,
  'subscription.updated': onSubscriptionEvent,
  'subscription.renewed': onSubscriptionEvent,
  'subscription.cancelled': onSubscriptionEvent,
  'subscription.ended': onSubscriptionEvent,
  'subscription.deleted': onSubscriptionEvent,
};
