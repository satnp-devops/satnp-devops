import { json } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { AppError, errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { referencePrefixSetting } from '../../core/crm/settings.js';
import { getSetting } from '../../core/settings.js';
import { localDate } from '../../core/billing/dates.js';
import { formatMoney } from '../../core/crm/money.js';
import { JOINABLE_BATCH_STATUSES } from './constants.js';
import { computeWithdrawalRefund } from './refunds.js';
import { coolingOffDaysSetting, deliverySettings, refundSlaDaysSetting, waitlistAutoPromoteSetting } from './settings.js';
import { startChecklist } from './onboarding.js';

// Enrollments, batch seats, the waitlist and withdrawals (docs/delivery/DELIVERY.md §4-5).
// Every function runs inside the caller's transaction and writes its own audit entry, event and
// timeline entry. `ctx` is { req?, actorUserId? }: a request for user actions, nothing for the worker.

const actorOf = (ctx) => ctx?.actorUserId ?? ctx?.req?.auth?.user?.id ?? null;

export async function audit(trx, ctx, entry) {
  await writeAudit(trx, ctx?.req ?? null, { ...entry, actorUserId: actorOf(ctx) ?? undefined });
}

export async function emit(trx, ctx, row, type, payload, aggregateType = 'enrollment') {
  await emitEvent(trx, {
    type,
    groupId: row.group_id,
    unitId: row.unit_id,
    aggregateType,
    aggregateId: row.id,
    actorUserId: actorOf(ctx),
    payload: { companyId: row.company_id, unitId: row.unit_id, ...payload },
  });
}

/** A system entry on the enrollment's deal (when there is one) and student. */
export async function enrollmentTimeline(trx, ctx, enrollment, title, meta) {
  await addTimelineEvent(trx, {
    groupId: enrollment.group_id,
    companyId: enrollment.company_id,
    unitId: enrollment.unit_id,
    dealId: enrollment.deal_id ?? null,
    contactId: enrollment.student_contact_id,
    kind: 'system',
    title,
    meta: { enrollmentId: enrollment.id, ref: enrollment.ref, ...meta },
    actorType: actorOf(ctx) ? 'user' : 'system',
    actorUserId: actorOf(ctx),
  });
}

const unitOf = (row) => ({ id: row.unit_id, root_id: row.group_id });

const conflict = (code, message, details) => new AppError(409, code, message, details);

// ---------- References ----------

export async function nextEnrollmentRef(trx, company) {
  const { rows } = await trx.raw(
    `insert into crm_sequences (company_id, name, value) values (?, 'enrollment', 1001)
     on conflict (company_id, name) do update set value = crm_sequences.value + 1 returning value`,
    [company.id],
  );
  const number = Number(rows[0].value);
  const prefix = await getSetting(company, referencePrefixSetting, trx);
  return { number, ref: `${prefix}-E${number}` };
}

// ---------- Seats and the waitlist ----------

async function lockBatch(trx, batchId) {
  const batch = await trx('batches').where({ id: batchId }).forUpdate().first();
  if (!batch) throw errors.notFound('Batch');
  return batch;
}

/** Can this enrollment take a seat in this batch? Throws 422 with a field path otherwise. */
export function assertBatchFits(batch, enrollment, path = 'body.batchId') {
  if (batch.company_id !== enrollment.company_id) throw errors.validation([{ path, message: 'Pick a batch of the same company' }]);
  if (batch.product_id !== enrollment.product_id) {
    throw errors.validation([{ path, message: 'This batch is for a different programme' }]);
  }
  if (!JOINABLE_BATCH_STATUSES.includes(batch.status)) {
    throw errors.validation([{ path, message: `This batch is ${batch.status}; pick an open one` }]);
  }
}

/**
 * Give the enrollment a seat in the batch, or a place on its waitlist when the batch is full.
 * The batch row is locked, so two enrollments can never take the last seat together.
 * @returns {Promise<{ placed: 'seated' | 'waitlisted', position: number | null, batch: object, enrollment: object }>}
 */
export async function placeInBatch(trx, ctx, enrollment, batchId, { joinWaitlist = true, via = 'create', path = 'body.batchId', resetDates = false } = {}) {
  const batch = await lockBatch(trx, batchId);
  assertBatchFits(batch, enrollment, path);
  const lockFee = enrollment.fee_minor === null && batch.fee_minor !== null;

  if (batch.seats_taken < batch.capacity) {
    const [updated] = await trx('enrollments')
      .where({ id: enrollment.id })
      .update({
        batch_id: batch.id,
        seat_status: 'seated',
        starts_on: resetDates ? batch.starts_on : (enrollment.starts_on ?? batch.starts_on),
        ends_on: resetDates ? batch.ends_on : (enrollment.ends_on ?? batch.ends_on),
        ...(lockFee ? { fee_minor: batch.fee_minor, currency: batch.currency } : {}),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    const [lockedBatch] = await trx('batches')
      .where({ id: batch.id })
      .update({ seats_taken: trx.raw('seats_taken + 1'), updated_at: trx.fn.now() })
      .returning('*');
    await emit(trx, ctx, updated, 'enrollment.batch_assigned', {
      enrollmentId: updated.id,
      batchId: batch.id,
      fromBatchId: enrollment.batch_id ?? null,
      via,
    });
    return { placed: 'seated', position: null, batch: lockedBatch, enrollment: updated };
  }

  const waitlistFull = batch.waitlist_limit !== null && batch.waitlist_count >= batch.waitlist_limit;
  if (!joinWaitlist || !batch.waitlist_enabled || waitlistFull) {
    throw conflict('batch_full', `${batch.name} is full${batch.waitlist_enabled && !waitlistFull ? '' : ' and its waitlist is closed'}`, {
      batchId: batch.id,
      capacity: batch.capacity,
      waitlistOpen: batch.waitlist_enabled && !waitlistFull,
    });
  }
  const [entry] = await trx('waitlist_entries')
    .insert({ group_id: batch.group_id, company_id: batch.company_id, unit_id: batch.unit_id, batch_id: batch.id, enrollment_id: enrollment.id })
    .returning('*');
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({
      batch_id: null,
      seat_status: 'waitlisted',
      ...(lockFee ? { fee_minor: batch.fee_minor, currency: batch.currency } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  const [lockedBatch] = await trx('batches')
    .where({ id: batch.id })
    .update({ waitlist_count: trx.raw('waitlist_count + 1'), updated_at: trx.fn.now() })
    .returning('*');
  const position = Number(
    (await trx('waitlist_entries').where({ batch_id: batch.id, status: 'waiting' }).where('queued_seq', '<=', entry.queued_seq).count({ n: '*' }))[0].n,
  );
  await emit(trx, ctx, updated, 'enrollment.waitlisted', { enrollmentId: updated.id, batchId: batch.id, position });
  return { placed: 'waitlisted', position, batch: lockedBatch, enrollment: updated };
}

/**
 * Give free seats to the people waiting, strictly in order of admission. The batch must be
 * locked by the caller (lockBatch) or freshly updated inside this transaction.
 * @returns {Promise<object[]>} the promoted enrollments
 */
export async function promoteFromWaitlist(trx, ctx, batchId, { max = Infinity } = {}) {
  const batch = await lockBatch(trx, batchId);
  const free = Math.min(max, batch.capacity - batch.seats_taken);
  if (free <= 0 || batch.waitlist_count === 0 || !JOINABLE_BATCH_STATUSES.includes(batch.status)) return [];
  const entries = await trx('waitlist_entries')
    .where({ batch_id: batchId, status: 'waiting' })
    .orderBy('queued_seq')
    .limit(free)
    .forUpdate();
  const promoted = [];
  for (const entry of entries) {
    await trx('waitlist_entries').where({ id: entry.id }).update({ status: 'promoted', resolution: 'promoted', resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
    const [enrollment] = await trx('enrollments')
      .where({ id: entry.enrollment_id, seat_status: 'waitlisted' })
      .whereIn('status', ['active', 'paused'])
      .update({
        batch_id: batchId,
        seat_status: 'seated',
        starts_on: trx.raw('coalesce(starts_on, ?)', [batch.starts_on]),
        ends_on: trx.raw('coalesce(ends_on, ?)', [batch.ends_on]),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    if (!enrollment) continue;
    promoted.push(enrollment);
    await emit(trx, ctx, enrollment, 'enrollment.batch_assigned', { enrollmentId: enrollment.id, batchId, fromBatchId: null, via: 'waitlist' });
    await enrollmentTimeline(trx, ctx, enrollment, `Got a seat in ${batch.name} from the waitlist`, { action: 'enrollment.batch_assigned', batchId });
    await audit(trx, ctx, {
      action: 'enrollment.batch_assigned',
      entityType: 'enrollment',
      entityId: enrollment.id,
      unit: unitOf(enrollment),
      after: { batchId, via: 'waitlist' },
    });
  }
  await trx('batches')
    .where({ id: batchId })
    .update({
      seats_taken: trx.raw('seats_taken + ?', [promoted.length]),
      waitlist_count: trx.raw('greatest(waitlist_count - ?, 0)', [entries.length]),
      updated_at: trx.fn.now(),
    });
  return promoted;
}

/**
 * Free whatever the enrollment holds (its seat or its waitlist place) and, when the batch's
 * setting says so, give the seat to the next person waiting.
 */
export async function releasePlace(trx, ctx, enrollment, { resolution = 'withdrawn' } = {}) {
  if (enrollment.seat_status === 'seated' && enrollment.batch_id) {
    const batch = await lockBatch(trx, enrollment.batch_id);
    await trx('batches')
      .where({ id: batch.id })
      .update({ seats_taken: trx.raw('greatest(seats_taken - 1, 0)'), updated_at: trx.fn.now() });
    const unit = await trx('org_units').where({ id: batch.unit_id }).first();
    if (await getSetting(unit, waitlistAutoPromoteSetting, trx)) await promoteFromWaitlist(trx, ctx, batch.id);
    return { freedBatchId: batch.id };
  }
  if (enrollment.seat_status === 'waitlisted') {
    const entry = await trx('waitlist_entries').where({ enrollment_id: enrollment.id, status: 'waiting' }).forUpdate().first();
    if (entry) {
      await lockBatch(trx, entry.batch_id);
      await trx('waitlist_entries').where({ id: entry.id }).update({ status: 'removed', resolution, resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
      await trx('batches')
        .where({ id: entry.batch_id })
        .update({ waitlist_count: trx.raw('greatest(waitlist_count - 1, 0)'), updated_at: trx.fn.now() });
    }
  }
  return { freedBatchId: null };
}

// ---------- Creating an enrollment ----------

/**
 * Create an enrollment, idempotently: the same source key (a payment or checkout session) or the
 * same deal, student and programme never creates a second one. Takes a seat (or a waitlist place)
 * when a batch is given, starts the onboarding checklist and emits enrollment.created.
 *
 * @param {{
 *   groupId: string, companyId: string, unitId: string,
 *   studentContactId: string, payerContactId?: string | null, householdId?: string | null,
 *   dealId?: string | null, productId: string, productLineId?: string | null,
 *   batchId?: string | null, joinWaitlist?: boolean, ownerUserId?: string | null,
 *   source: 'checkout' | 'payment' | 'manual', sourceKey?: string | null, checkoutSessionId?: string | null,
 *   feeMinor?: number | null, currency?: string | null, startsOn?: string | null,
 *   accessStatus?: string, payment?: { paymentId: string, amountMinor: number, currency: string, paidAt: string, sourceEventId?: string } | null,
 * }} input
 * @returns {Promise<{ enrollment: object, created: boolean, placed: string | null, position: number | null }>}
 */
export async function createEnrollment(trx, ctx, input) {
  // Serialise duplicate deliveries of the same payment or checkout, and enrollments of one student
  // in one deal, so the second sees the first's row.
  const keys = [input.sourceKey && `delivery.enroll:${input.sourceKey}`, input.dealId && `delivery.enroll:${input.dealId}:${input.studentContactId}:${input.productId}`]
    .filter(Boolean)
    .sort();
  await trx.raw('select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(?::text[]) as k order by k', [keys]);

  const anyKey = Boolean(input.sourceKey || input.dealId || input.checkoutSessionId);
  const existing = anyKey && await trx('enrollments')
    .where((where) => {
      if (input.sourceKey) where.orWhere({ source_key: input.sourceKey });
      if (input.dealId) where.orWhere({ deal_id: input.dealId, student_contact_id: input.studentContactId, product_id: input.productId });
      if (input.checkoutSessionId) where.orWhere({ checkout_session_id: input.checkoutSessionId });
    })
    .first();
  if (existing) {
    if (input.payment) await recordPayment(trx, existing, input.payment);
    return { enrollment: existing, created: false, placed: null, position: null };
  }

  const company = await trx('org_units').where({ id: input.companyId }).first();
  const { number, ref } = await nextEnrollmentRef(trx, company);
  let [enrollment] = await trx('enrollments')
    .insert({
      group_id: input.groupId,
      company_id: input.companyId,
      unit_id: input.unitId,
      number,
      ref,
      student_contact_id: input.studentContactId,
      payer_contact_id: input.payerContactId ?? null,
      household_id: input.householdId ?? null,
      deal_id: input.dealId ?? null,
      product_line_id: input.productLineId ?? null,
      product_id: input.productId,
      owner_user_id: input.ownerUserId ?? null,
      status: 'active',
      seat_status: 'unassigned',
      access_status: input.accessStatus ?? 'pending',
      source: input.source,
      source_key: input.sourceKey ?? null,
      checkout_session_id: input.checkoutSessionId ?? null,
      fee_minor: input.feeMinor ?? null,
      currency: input.currency ?? null,
      starts_on: input.startsOn ?? null,
      created_by: actorOf(ctx),
    })
    .returning('*');

  let placed = null;
  let position = null;
  let batch = null;
  if (input.batchId) {
    const result = await placeInBatch(trx, ctx, enrollment, input.batchId, { joinWaitlist: input.joinWaitlist !== false, via: 'create' });
    ({ enrollment, placed, position, batch } = result);
  }
  if (input.payment) enrollment = await recordPayment(trx, enrollment, input.payment);

  const checklist = await startChecklist(trx, ctx, enrollment, batch);

  const product = await trx('products').where({ id: enrollment.product_id }).first('name');
  const where = batch ? (placed === 'seated' ? ` in ${batch.name}` : ` (waitlisted for ${batch.name}, #${position})`) : '';
  await enrollmentTimeline(trx, ctx, enrollment, `Enrolled: ${product?.name ?? 'programme'}${where}`, {
    action: 'enrollment.created',
    batchId: batch?.id ?? null,
    seatStatus: enrollment.seat_status,
  });
  await emit(trx, ctx, enrollment, 'enrollment.created', {
    enrollmentId: enrollment.id,
    ref: enrollment.ref,
    studentContactId: enrollment.student_contact_id,
    payerContactId: enrollment.payer_contact_id,
    householdId: enrollment.household_id,
    dealId: enrollment.deal_id,
    productId: enrollment.product_id,
    productLineId: enrollment.product_line_id,
    batchId: enrollment.batch_id ?? batch?.id ?? null,
    seatStatus: enrollment.seat_status,
    waitlistPosition: position,
    source: enrollment.source,
    ownerUserId: enrollment.owner_user_id,
    checklistId: checklist?.id ?? null,
  });
  await audit(trx, ctx, {
    action: 'enrollment.created',
    entityType: 'enrollment',
    entityId: enrollment.id,
    unit: unitOf(enrollment),
    after: { ref, studentContactId: enrollment.student_contact_id, dealId: enrollment.deal_id, batchId: batch?.id ?? null, seatStatus: enrollment.seat_status, source: enrollment.source },
  });
  return { enrollment, created: true, placed, position };
}

/** Record a payment against an enrollment once (by payment id) and keep paid_minor in step. */
export async function recordPayment(trx, enrollment, payment) {
  const inserted = await trx('enrollment_payments')
    .insert({
      enrollment_id: enrollment.id,
      payment_id: String(payment.paymentId),
      amount_minor: payment.amountMinor,
      currency: payment.currency,
      paid_at: payment.paidAt ?? new Date(),
      source_event_id: payment.sourceEventId ?? null,
    })
    .onConflict(['enrollment_id', 'payment_id'])
    .ignore()
    .returning('id');
  if (inserted.length === 0) return enrollment;
  // paid_minor is in the enrollment's currency; a payment in another one is kept on record but
  // not added (the money module converts and settles those).
  if (enrollment.currency && enrollment.currency !== payment.currency) {
    logger.warn({ enrollmentId: enrollment.id, paymentId: payment.paymentId }, 'Payment currency differs from the enrollment; not added to paid');
    return enrollment;
  }
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({
      paid_minor: trx.raw('paid_minor + ?', [payment.amountMinor]),
      currency: trx.raw('coalesce(currency, ?)', [payment.currency]),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  return updated;
}

// ---------- Status changes ----------

function assertStatus(enrollment, allowed, action) {
  if (!allowed.includes(enrollment.status)) {
    throw conflict('invalid_status', `A ${enrollment.status} enrollment can't be ${action}`, { status: enrollment.status });
  }
}

export async function changeBatch(trx, ctx, enrollment, batchId, { joinWaitlist = false } = {}) {
  assertStatus(enrollment, ['active', 'paused'], 'moved');
  if (enrollment.batch_id === batchId) return { enrollment, placed: 'seated', position: null };
  // Lock both batches in id order so two moves in opposite directions can't deadlock.
  const ids = [batchId, enrollment.batch_id].filter(Boolean).sort();
  for (const id of ids) await lockBatch(trx, id);
  const previous = { ...enrollment };
  // Leave the waitlist of another batch first (a person waits in one queue at a time).
  if (enrollment.seat_status === 'waitlisted') await releasePlace(trx, ctx, enrollment, { resolution: 'moved' });
  const result = await placeInBatch(trx, ctx, enrollment, batchId, { joinWaitlist, via: 'manual', resetDates: true });
  if (previous.seat_status === 'seated') await releasePlace(trx, ctx, previous, { resolution: 'moved' });
  const batch = result.batch;
  await enrollmentTimeline(
    trx,
    ctx,
    result.enrollment,
    result.placed === 'seated' ? `Moved to ${batch.name}` : `Waitlisted for ${batch.name} (#${result.position})`,
    { action: 'enrollment.batch_assigned', batchId, fromBatchId: previous.batch_id ?? null },
  );
  await audit(trx, ctx, {
    action: 'enrollment.batch_assigned',
    entityType: 'enrollment',
    entityId: enrollment.id,
    unit: unitOf(enrollment),
    before: { batchId: previous.batch_id ?? null, seatStatus: previous.seat_status },
    after: { batchId: result.enrollment.batch_id ?? null, seatStatus: result.enrollment.seat_status, waitlistBatchId: result.placed === 'waitlisted' ? batchId : undefined },
  });
  return { enrollment: result.enrollment, placed: result.placed, position: result.position };
}

export async function pauseEnrollment(trx, ctx, enrollment, { resumeOn = null, reason = null } = {}) {
  assertStatus(enrollment, ['active'], 'paused');
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({
      status: 'paused',
      paused_at: trx.fn.now(),
      resume_on: resumeOn,
      pause_reason: reason,
      ...(enrollment.access_status === 'granted' ? { access_status: 'suspended', access_updated_at: trx.fn.now() } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  await enrollmentTimeline(trx, ctx, updated, resumeOn ? `Paused until ${resumeOn}` : 'Paused', { action: 'enrollment.paused', resumeOn });
  await emit(trx, ctx, updated, 'enrollment.paused', { enrollmentId: updated.id, resumeOn, reason, accessStatus: updated.access_status });
  await audit(trx, ctx, {
    action: 'enrollment.paused',
    entityType: 'enrollment',
    entityId: updated.id,
    unit: unitOf(updated),
    before: { status: enrollment.status },
    after: { status: 'paused', resumeOn, reason },
  });
  return updated;
}

export async function resumeEnrollment(trx, ctx, enrollment) {
  assertStatus(enrollment, ['paused'], 'resumed');
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({
      status: 'active',
      paused_at: null,
      resume_on: null,
      pause_reason: null,
      ...(enrollment.access_status === 'suspended' ? { access_status: 'granted', access_updated_at: trx.fn.now() } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  await enrollmentTimeline(trx, ctx, updated, 'Resumed', { action: 'enrollment.resumed' });
  await emit(trx, ctx, updated, 'enrollment.resumed', { enrollmentId: updated.id, accessStatus: updated.access_status });
  await audit(trx, ctx, { action: 'enrollment.resumed', entityType: 'enrollment', entityId: updated.id, unit: unitOf(updated), before: { status: 'paused' }, after: { status: 'active' } });
  return updated;
}

export async function completeEnrollment(trx, ctx, enrollment) {
  assertStatus(enrollment, ['active', 'paused'], 'completed');
  await releasePlace(trx, ctx, enrollment, { resolution: 'completed' });
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({
      status: 'completed',
      completed_at: trx.fn.now(),
      paused_at: null,
      resume_on: null,
      // A waitlisted enrollment that is completed never got its seat; keep the batch it sat in otherwise.
      ...(enrollment.seat_status === 'waitlisted' ? { seat_status: 'unassigned' } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');
  await enrollmentTimeline(trx, ctx, updated, 'Course completed', { action: 'enrollment.completed' });
  await emit(trx, ctx, updated, 'enrollment.completed', { enrollmentId: updated.id, batchId: updated.batch_id });
  await audit(trx, ctx, { action: 'enrollment.completed', entityType: 'enrollment', entityId: updated.id, unit: unitOf(updated), before: { status: enrollment.status }, after: { status: 'completed' } });
  return updated;
}

/**
 * Compute the refund a withdrawal would give (preview and the real thing use the same code).
 * @returns {Promise<ReturnType<typeof computeWithdrawalRefund>>}
 */
export async function previewRefund(trx, enrollment, { receivedAt, effectiveOn, classesAttended = null }) {
  const unit = await trx('org_units').where({ id: enrollment.unit_id }).first();
  const settings = await deliverySettings(unit, [refundSlaDaysSetting, coolingOffDaysSetting], trx);
  const batch = enrollment.batch_id ? await trx('batches').where({ id: enrollment.batch_id }).first() : null;
  const startsOn = enrollment.starts_on ?? batch?.starts_on ?? localDate(Date.now());
  const endsOn = enrollment.ends_on ?? batch?.ends_on ?? startsOn;
  // Never seated: nothing of the course was used.
  const effective = enrollment.seat_status === 'seated' ? effectiveOn : null;
  return computeWithdrawalRefund({
    feeMinor: enrollment.fee_minor === null ? null : Number(enrollment.fee_minor),
    paidMinor: Number(enrollment.paid_minor),
    currency: enrollment.currency ?? batch?.currency ?? 'INR',
    startsOn,
    endsOn,
    effectiveOn: effective ?? addDaysBefore(startsOn),
    enrolledAt: enrollment.enrolled_at,
    receivedAt,
    refundUnit: batch?.refund_unit ?? 'days',
    totalClasses: batch?.total_classes ?? null,
    classesAttended: effective ? classesAttended : 0,
    coolingOffDays: settings[coolingOffDaysSetting.key],
    slaDays: settings[refundSlaDaysSetting.key],
  });
}

function addDaysBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Withdraw: record the request (its time starts the refund clock), free the seat (the next person
 * waiting gets it), revoke platform access, and ask the money module for the pro-rata refund
 * (refund.requested). A reason is optional: the clock never waits for one.
 */
export async function withdrawEnrollment(trx, ctx, enrollment, input) {
  assertStatus(enrollment, ['active', 'paused'], 'withdrawn');
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw errors.validation([{ path: 'body.receivedAt', message: "This can't be in the future" }]);
  const effectiveOn = input.effectiveOn ?? localDate(receivedAt.getTime());
  const computed = await previewRefund(trx, enrollment, { receivedAt, effectiveOn, classesAttended: input.classesAttended ?? null });

  await releasePlace(trx, ctx, enrollment, { resolution: 'withdrawn' });
  const revoke = ['pending', 'granted', 'suspended'].includes(enrollment.access_status);
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({
      status: 'withdrawn',
      withdrawn_at: receivedAt,
      paused_at: null,
      resume_on: null,
      ...(enrollment.seat_status === 'waitlisted' ? { seat_status: 'unassigned' } : {}),
      ...(revoke ? { access_status: 'revoked', access_updated_at: trx.fn.now() } : {}),
      updated_at: trx.fn.now(),
    })
    .returning('*');

  const refundStatus = computed.refundMinor > 0 ? 'requested' : 'not_applicable';
  const [withdrawal] = await trx('enrollment_withdrawals')
    .insert({
      group_id: enrollment.group_id,
      company_id: enrollment.company_id,
      unit_id: enrollment.unit_id,
      enrollment_id: enrollment.id,
      received_at: receivedAt,
      channel: input.channel,
      reason: input.reason ?? null,
      requested_by_contact_id: input.requestedByContactId ?? null,
      effective_on: effectiveOn,
      refund_basis: json(computed.basis),
      refund_minor: computed.refundMinor,
      currency: computed.currency,
      refund_due_at: computed.dueAt,
      refund_status: refundStatus,
      recorded_by: actorOf(ctx),
    })
    .returning('*');

  const amount = formatMoney(computed.refundMinor, computed.currency);
  await enrollmentTimeline(
    trx,
    ctx,
    updated,
    computed.refundMinor > 0 ? `Withdrew; refund of ${amount} requested (due ${computed.basis.dueOn})` : 'Withdrew; no refund due',
    { action: 'enrollment.withdrawn', withdrawalId: withdrawal.id, refundMinor: computed.refundMinor, currency: computed.currency },
  );
  await emit(trx, ctx, updated, 'enrollment.withdrawn', {
    enrollmentId: updated.id,
    withdrawalId: withdrawal.id,
    batchId: enrollment.batch_id ?? null,
    receivedAt: receivedAt.toISOString(),
    refundMinor: computed.refundMinor,
    currency: computed.currency,
  });
  if (computed.refundMinor > 0) {
    const payments = await trx('enrollment_payments').where({ enrollment_id: enrollment.id }).orderBy('paid_at').select('payment_id', 'amount_minor', 'currency');
    await emit(
      trx,
      ctx,
      withdrawal,
      'refund.requested',
      {
        withdrawalId: withdrawal.id,
        enrollmentId: enrollment.id,
        enrollmentRef: enrollment.ref,
        dealId: enrollment.deal_id,
        contactId: enrollment.payer_contact_id ?? enrollment.student_contact_id,
        studentContactId: enrollment.student_contact_id,
        amountMinor: computed.refundMinor,
        currency: computed.currency,
        receivedAt: receivedAt.toISOString(),
        dueAt: computed.dueAt,
        reason: 'withdrawal',
        rule: computed.basis.rule,
        basis: computed.basis,
        paymentIds: payments.map((p) => p.payment_id),
        cancelFutureInstalments: true,
      },
      'enrollment_withdrawal',
    );
  }
  await audit(trx, ctx, {
    action: 'enrollment.withdrawn',
    entityType: 'enrollment',
    entityId: updated.id,
    unit: unitOf(updated),
    before: { status: enrollment.status, batchId: enrollment.batch_id ?? null },
    after: { status: 'withdrawn', receivedAt: receivedAt.toISOString(), channel: input.channel, refundMinor: computed.refundMinor, currency: computed.currency, dueAt: computed.dueAt },
    meta: { basis: computed.basis },
  });
  return { enrollment: updated, withdrawal };
}

export async function setAccessStatus(trx, ctx, enrollment, status) {
  if (enrollment.access_status === status) return enrollment;
  if (['withdrawn', 'completed'].includes(enrollment.status) && status === 'granted') {
    throw conflict('invalid_status', `A ${enrollment.status} enrollment can't get platform access`, { status: enrollment.status });
  }
  const [updated] = await trx('enrollments')
    .where({ id: enrollment.id })
    .update({ access_status: status, access_updated_at: trx.fn.now(), updated_at: trx.fn.now() })
    .returning('*');
  await emit(trx, ctx, updated, 'enrollment.access_changed', { enrollmentId: updated.id, from: enrollment.access_status, to: status });
  await audit(trx, ctx, { action: 'enrollment.access_changed', entityType: 'enrollment', entityId: updated.id, unit: unitOf(updated), before: { accessStatus: enrollment.access_status }, after: { accessStatus: status } });
  return updated;
}

/** Load and lock an enrollment for a write (handlers; routes use loadVisible). */
export const lockEnrollment = (trx, id) => trx('enrollments').where({ id }).forUpdate().first();

