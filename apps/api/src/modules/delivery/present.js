import { db } from '../../lib/db.js';
import { presentContactPii } from '../../core/crm/pii.js';
import { minorFromDb } from '../../core/crm/money.js';

// Row → API shapes (apps/web/src/lib/delivery/types.ts). Related rows are loaded with one
// whereIn query per relation for a whole page (never per row).

const iso = (value) => (value ? new Date(value).toISOString() : null);
const unique = (values) => [...new Set(values.filter(Boolean))];
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));

export const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);
export const userRef = (user) => (user ? { id: user.id, name: user.name } : null);
export const money = (minor, currency) => (currency ? { valueMinor: minorFromDb(minor), currency } : null);

export function contactSummary(row, canViewPii) {
  if (!row) return null;
  const pii = presentContactPii(row, canViewPii);
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    city: row.city ?? null,
    primaryPhone: pii.primaryPhone,
    primaryEmail: pii.primaryEmail,
    piiMasked: pii.piiMasked,
    erased: Boolean(row.erased_at),
  };
}

const productRef = (row) => (row ? { id: row.id, name: row.name, code: row.code ?? null } : null);
const lineRef = (row) => (row ? { id: row.id, name: row.name, kind: row.kind } : null);
const dealRef = (row) => (row ? { id: row.id, ref: row.ref, title: row.title, status: row.status } : null);
const accountRef = (row) => (row ? { id: row.id, name: row.name, kind: row.kind } : null);
export const batchRef = (row) =>
  row ? { id: row.id, name: row.name, code: row.code ?? null, mode: row.mode, startsOn: row.starts_on, endsOn: row.ends_on, status: row.status } : null;

/**
 * Load the rows a page of records refers to.
 * @param {object} ids { contactIds, dealIds, productIds, lineIds, batchIds, userIds, accountIds }
 */
export async function loadRefs(ids, trx = db) {
  const load = (table, list, columns) => (list?.length ? trx(table).whereIn('id', unique(list)).select(columns) : Promise.resolve([]));
  const [contacts, deals, products, lines, batches, users, accounts] = await Promise.all([
    load('contacts', ids.contactIds, ['id', 'kind', 'display_name', 'first_name', 'last_name', 'city', 'primary_phone', 'primary_email', 'erased_at']),
    load('deals', ids.dealIds, ['id', 'ref', 'title', 'status', 'kind']),
    load('products', ids.productIds, ['id', 'name', 'code', 'product_line_id']),
    load('product_lines', ids.lineIds, ['id', 'name', 'kind']),
    load('batches', ids.batchIds, ['id', 'name', 'code', 'mode', 'starts_on', 'ends_on', 'status', 'teacher_user_id']),
    load('users', ids.userIds, ['id', 'name']),
    load('accounts', ids.accountIds, ['id', 'name', 'kind']),
  ]);
  return {
    contacts: byId(contacts),
    deals: byId(deals),
    products: byId(products),
    lines: byId(lines),
    batches: byId(batches),
    users: byId(users),
    accounts: byId(accounts),
  };
}

// ---------- Batches ----------

export function presentBatch(row, { units, refs, can = {} }) {
  return {
    id: row.id,
    companyId: row.company_id,
    unit: unitRef(units.get(row.unit_id)),
    product: productRef(refs.products.get(row.product_id)),
    productLine: lineRef(refs.lines.get(row.product_line_id)),
    code: row.code ?? null,
    name: row.name,
    mode: row.mode,
    schedule: row.schedule ?? {},
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    capacity: row.capacity,
    seatsTaken: row.seats_taken,
    seatsLeft: Math.max(0, row.capacity - row.seats_taken),
    waitlistEnabled: row.waitlist_enabled,
    waitlistLimit: row.waitlist_limit ?? null,
    waitlistCount: row.waitlist_count,
    fee: money(row.fee_minor, row.fee_minor === null || row.fee_minor === undefined ? null : row.currency),
    checkoutEnabled: row.checkout_enabled,
    teacher: userRef(refs.users.get(row.teacher_user_id)),
    teacherName: row.teacher_name ?? null,
    location: row.location ?? null,
    status: row.status,
    refundUnit: row.refund_unit,
    totalClasses: row.total_classes ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    can: { manage: Boolean(can.manage) },
  };
}

export async function presentBatches(rows, { units, canManage }, trx = db) {
  const refs = await loadRefs(
    {
      productIds: rows.map((r) => r.product_id),
      lineIds: rows.map((r) => r.product_line_id),
      userIds: rows.map((r) => r.teacher_user_id),
    },
    trx,
  );
  return rows.map((row) => presentBatch(row, { units, refs, can: { manage: canManage(row) } }));
}

// ---------- Enrollments ----------

/** Waitlist positions (1 = next in line) for enrollments, in one query. */
export async function waitlistPositions(enrollmentIds, trx = db) {
  if (enrollmentIds.length === 0) return new Map();
  const { rows } = await trx.raw(
    `select e.enrollment_id, e.batch_id, e.queued_at,
            (select count(*) from waitlist_entries w
              where w.batch_id = e.batch_id and w.status = 'waiting' and w.queued_seq <= e.queued_seq)::int as position
       from waitlist_entries e
      where e.status = 'waiting' and e.enrollment_id = any(?::uuid[])`,
    [enrollmentIds],
  );
  return new Map(rows.map((row) => [row.enrollment_id, row]));
}

export function presentEnrollment(row, { units, refs, waitlist, checklists, canViewPii }) {
  const queue = waitlist.get(row.id);
  const checklist = checklists.get(row.id);
  return {
    id: row.id,
    ref: row.ref,
    companyId: row.company_id,
    unit: unitRef(units.get(row.unit_id)),
    student: contactSummary(refs.contacts.get(row.student_contact_id), canViewPii(row)),
    payer: contactSummary(refs.contacts.get(row.payer_contact_id), canViewPii(row)),
    householdId: row.household_id ?? null,
    deal: dealRef(refs.deals.get(row.deal_id)),
    product: productRef(refs.products.get(row.product_id)),
    productLine: lineRef(refs.lines.get(row.product_line_id)),
    batch: batchRef(refs.batches.get(row.batch_id)),
    waitlist: queue ? { batch: batchRef(refs.batches.get(queue.batch_id)), position: queue.position, queuedAt: iso(queue.queued_at) } : null,
    owner: userRef(refs.users.get(row.owner_user_id)),
    status: row.status,
    seatStatus: row.seat_status,
    accessStatus: row.access_status,
    source: row.source,
    fee: money(row.fee_minor, row.fee_minor === null || row.fee_minor === undefined ? null : row.currency),
    paid: money(row.paid_minor, row.currency ?? 'INR'),
    enrolledAt: iso(row.enrolled_at),
    startsOn: row.starts_on ?? null,
    endsOn: row.ends_on ?? null,
    pausedAt: iso(row.paused_at),
    resumeOn: row.resume_on ?? null,
    pauseReason: row.pause_reason ?? null,
    withdrawnAt: iso(row.withdrawn_at),
    completedAt: iso(row.completed_at),
    checklist: checklist
      ? { id: checklist.id, status: checklist.status, itemsTotal: checklist.items_total, itemsDone: checklist.items_done }
      : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** A page of enrollments with everything they refer to (6 queries for any page size). */
export async function presentEnrollments(rows, { units, canViewPii }, trx = db) {
  const ids = rows.map((r) => r.id);
  const [waitlist, checklistRows] = await Promise.all([
    waitlistPositions(ids, trx),
    ids.length
      ? trx('onboarding_checklists').whereIn('enrollment_id', ids).select('id', 'enrollment_id', 'status', 'items_total', 'items_done')
      : [],
  ]);
  const refs = await loadRefs(
    {
      contactIds: rows.flatMap((r) => [r.student_contact_id, r.payer_contact_id]),
      dealIds: rows.map((r) => r.deal_id),
      productIds: rows.map((r) => r.product_id),
      lineIds: rows.map((r) => r.product_line_id),
      batchIds: [...rows.map((r) => r.batch_id), ...[...waitlist.values()].map((w) => w.batch_id)],
      userIds: rows.map((r) => r.owner_user_id),
    },
    trx,
  );
  const checklists = new Map(checklistRows.map((c) => [c.enrollment_id, c]));
  return rows.map((row) => presentEnrollment(row, { units, refs, waitlist, checklists, canViewPii }));
}

export function presentWithdrawal(row) {
  if (!row) return null;
  return {
    id: row.id,
    receivedAt: iso(row.received_at),
    channel: row.channel,
    reason: row.reason ?? null,
    effectiveOn: row.effective_on,
    refund: money(row.refund_minor, row.currency ?? 'INR'),
    refundDueAt: iso(row.refund_due_at),
    refundStatus: row.refund_status,
    refundReference: row.refund_reference ?? null,
    refundPaidAt: iso(row.refund_paid_at),
    basis: row.refund_basis ?? {},
    createdAt: iso(row.created_at),
  };
}

// ---------- Onboarding ----------

export function presentChecklistItem(row, users) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    owner: userRef(users.get(row.owner_user_id)),
    dueOn: row.due_on ?? null,
    position: row.position,
    completedAt: iso(row.completed_at),
    completedBy: userRef(users.get(row.completed_by)),
  };
}

export function presentChecklistSummary(row, { units, refs, enrollments, canViewPii }) {
  const enrollment = enrollments.get(row.enrollment_id);
  return {
    id: row.id,
    name: row.name,
    companyId: row.company_id,
    unit: unitRef(units.get(row.unit_id)),
    status: row.status,
    itemsTotal: row.items_total,
    itemsDone: row.items_done,
    owner: userRef(refs.users.get(row.owner_user_id)),
    nextDueOn: row.next_due_on ?? null,
    overdueCount: Number(row.overdue_count ?? 0),
    enrollment: enrollment
      ? {
          id: enrollment.id,
          ref: enrollment.ref,
          status: enrollment.status,
          student: contactSummary(refs.contacts.get(enrollment.student_contact_id), canViewPii(row)),
          batch: batchRef(refs.batches.get(enrollment.batch_id)),
          product: productRef(refs.products.get(enrollment.product_id)),
        }
      : null,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  };
}

export function presentProjectSummary(row, { units, refs }) {
  return {
    id: row.id,
    name: row.name,
    companyId: row.company_id,
    unit: unitRef(units.get(row.unit_id)),
    account: accountRef(refs.accounts.get(row.account_id)),
    deal: dealRef(refs.deals.get(row.deal_id)),
    product: productRef(refs.products.get(row.product_id)),
    productLine: lineRef(refs.lines.get(row.product_line_id)),
    subscriptionId: row.subscription_id ?? null,
    contractId: row.contract_id ?? null,
    status: row.status,
    owner: userRef(refs.users.get(row.owner_user_id)),
    kickoffOn: row.kickoff_on ?? null,
    targetGoLiveOn: row.target_go_live_on ?? null,
    wentLiveAt: iso(row.went_live_at),
    tasksTotal: row.tasks_total,
    tasksDone: row.tasks_done,
    currentPhase: row.current_phase ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function presentProjects(rows, { units }, trx = db) {
  const refs = await loadRefs(
    {
      accountIds: rows.map((r) => r.account_id),
      dealIds: rows.map((r) => r.deal_id),
      productIds: rows.map((r) => r.product_id),
      lineIds: rows.map((r) => r.product_line_id),
      userIds: rows.map((r) => r.owner_user_id),
    },
    trx,
  );
  return rows.map((row) => presentProjectSummary(row, { units, refs }));
}

export function presentRenewal(row, { units, refs }) {
  return {
    id: row.id,
    companyId: row.company_id,
    unit: unitRef(units.get(row.unit_id)),
    subscriptionId: row.subscription_id,
    account: accountRef(refs.accounts.get(row.account_id)),
    deal: dealRef(refs.deals.get(row.deal_id)),
    product: productRef(refs.products.get(row.product_id)),
    productLine: lineRef(refs.lines.get(row.product_line_id)),
    planName: row.plan_name ?? null,
    status: row.status,
    termStart: row.term_start ?? null,
    termEnd: row.term_end,
    autoRenew: row.auto_renew,
    amount: money(row.amount_minor, row.currency),
    seats: row.seats ?? null,
    owner: userRef(refs.users.get(row.owner_user_id)),
    remindersSent: row.reminders_sent ?? [],
    churn: { score: row.churn_score, level: row.churn_level, signals: row.churn_signals ?? [], scoredAt: iso(row.scored_at) },
    upsell: row.upsell_flags ?? [],
    updatedAt: iso(row.updated_at),
  };
}

export async function presentRenewals(rows, { units }, trx = db) {
  const refs = await loadRefs(
    {
      accountIds: rows.map((r) => r.account_id),
      dealIds: rows.map((r) => r.deal_id),
      productIds: rows.map((r) => r.product_id),
      lineIds: rows.map((r) => r.product_line_id),
      userIds: rows.map((r) => r.owner_user_id),
    },
    trx,
  );
  return rows.map((row) => presentRenewal(row, { units, refs }));
}
