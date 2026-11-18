import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { pageOf } from '../../lib/pagination.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import {
  applyListScope,
  companiesInScope,
  listScope,
  loadVisible,
  requireCreateUnit,
  requireRecord,
  unitsIndex,
} from '../../core/crm/scope.js';
import { normalizeName } from '../../core/crm/normalize.js';
import {
  PERMISSIONS as P,
  applyDescCursor,
  applyOwnerFilter,
  assertOwner,
  fieldError,
  isUniqueViolation,
  ownerFor,
  productOfCompany,
  viewContext,
  visibleContactField,
  visibleDealField,
} from './access.js';
import {
  batchListQuery,
  countsQuery,
  createBatchSchema,
  createEnrollmentSchema,
  enrollmentListQuery,
  idParams,
  moveBatchSchema,
  pauseSchema,
  refundPreviewSchema,
  updateBatchSchema,
  updateEnrollmentSchema,
  withdrawSchema,
} from './schemas.js';
import { presentBatches, presentEnrollments, presentWithdrawal, loadRefs, presentChecklistItem } from './present.js';
import {
  audit,
  changeBatch,
  completeEnrollment,
  createEnrollment,
  emit,
  pauseEnrollment,
  previewRefund,
  promoteFromWaitlist,
  resumeEnrollment,
  setAccessStatus,
  withdrawEnrollment,
} from './service.js';
import { getSetting } from '../../core/settings.js';
import { waitlistAutoPromoteSetting } from './settings.js';
import { localDate } from '../../core/billing/dates.js';

// Batches and enrollments (docs/delivery/DELIVERY.md §8.1-8.2).

const unitOf = (row) => ({ id: row.unit_id, root_id: row.group_id });

// ---------- Batches ----------

/** A batch the user can see: enrollments.view at, above or inside its company (batches are shared configuration). */
async function loadBatch(req, id, { trx = db, forUpdate = false } = {}) {
  const query = trx('batches').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const batch = await query;
  if (!batch) throw errors.notFound('Batch');
  const units = await unitsIndex(req, trx);
  const company = units.get(batch.company_id);
  if (!company || !req.access.canSee(company.path) || !req.access.canAnywhereWithin(P.view, company.path)) throw errors.notFound('Batch');
  return { batch, units };
}

const canManageBatch = (req, units) => (row) => {
  const unit = units.get(row.unit_id);
  return Boolean(unit && req.access.can(P.batches, unit.path));
};

/**
 * A batch's teacher is an active member of staff of the batch's company: a role at the company,
 * at a unit inside it, or at the group above it. Not another company's staff (their name would
 * show on this company's batches and they would own its onboarding steps), nor a partner sign-in.
 */
async function assertTeacher(userId, companyId, path, trx) {
  if (!userId) return;
  const company = await trx('org_units').where({ id: companyId }).first('id', 'path', 'root_id');
  const row = await trx('users as u')
    .join('role_assignments as ra', 'ra.user_id', 'u.id')
    .join('roles as r', 'r.id', 'ra.role_id')
    .join('org_units as o', 'o.id', 'ra.org_unit_id')
    .where({ 'u.id': userId, 'u.status': 'active', 'o.root_id': company.root_id })
    .whereNot('r.key', 'partner')
    .where((w) => w.whereRaw('strpos(?, o.path) = 1', [company.path]).orWhereRaw('strpos(o.path, ?) = 1', [company.path]))
    .first('u.id');
  if (!row) throw fieldError(path, 'Pick someone who works for this company');
}

function batchColumns(body) {
  const map = {
    code: 'code',
    name: 'name',
    mode: 'mode',
    startsOn: 'starts_on',
    endsOn: 'ends_on',
    capacity: 'capacity',
    waitlistEnabled: 'waitlist_enabled',
    waitlistLimit: 'waitlist_limit',
    checkoutEnabled: 'checkout_enabled',
    teacherUserId: 'teacher_user_id',
    teacherName: 'teacher_name',
    location: 'location',
    status: 'status',
    refundUnit: 'refund_unit',
    totalClasses: 'total_classes',
  };
  const out = {};
  for (const [key, column] of Object.entries(map)) if (body[key] !== undefined) out[column] = body[key];
  if (body.schedule !== undefined) out.schedule = json(body.schedule);
  if (body.fee !== undefined) {
    out.fee_minor = body.fee?.valueMinor ?? null;
    out.currency = body.fee?.currency ?? null;
  }
  return out;
}

async function presentOneBatch(req, id) {
  const { batch, units } = await loadBatch(req, id);
  const [data] = await presentBatches([batch], { units, canManage: canManageBatch(req, units) });
  return data;
}

function batchRoutes(router) {
  router.get(
    '/batches/programmes',
    describe({ summary: 'List programmes that run in batches', permission: P.view, description: 'Active family programmes (B2C products) of the companies in scope, for batch and enrollment forms.' }),
    requireAuth(),
    validate({ query: countsQuery }),
    async (req, res) => {
      const companies = await companiesInScope(req, req.valid.query.unitId, P.view);
      if (companies.length === 0) throw errors.forbidden();
      const rows = await db('products as p')
        .join('product_lines as l', 'l.id', 'p.product_line_id')
        .whereIn('p.company_id', companies.map((c) => c.id))
        .where({ 'p.active': true, 'l.active': true, 'l.audience': 'b2c' })
        .orderBy([{ column: 'p.company_id' }, { column: 'l.position' }, { column: 'p.position' }, { column: 'p.id' }])
        .limit(1000)
        .select('p.id', 'p.name', 'p.code', 'p.company_id', 'l.id as line_id', 'l.name as line_name', 'l.kind as line_kind');
      res.json({
        data: rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, companyId: r.company_id, productLine: { id: r.line_id, name: r.line_name, kind: r.line_kind } })),
      });
    },
  );

  router.get(
    '/batches',
    describe({ summary: 'List batches', permission: P.view, list: true, description: 'Batches of the companies in the working scope, newest start first. `joinable=true` keeps planned and open batches that have not ended.' }),
    requireAuth(),
    validate({ query: batchListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const companies = await companiesInScope(req, q.unitId, P.view);
      if (companies.length === 0) throw errors.forbidden();
      const units = await unitsIndex(req);
      let query = db('batches as b')
        .whereIn('b.company_id', companies.map((c) => c.id))
        .select('b.*', db.raw('b.starts_on::text as _k'));
      if (q.productId) query.where('b.product_id', q.productId);
      if (q.status?.length) query.whereIn('b.status', q.status);
      if (q.joinable) query.whereIn('b.status', ['planned', 'open']).where('b.ends_on', '>=', localDate(Date.now()));
      if (q.q) query.where((w) => w.whereILike('b.name', `%${q.q}%`).orWhereILike('b.code', `%${q.q}%`));
      query = applyDescCursor(query, q.cursor, 'b.starts_on', 'b.id');
      const rows = await query.orderBy([{ column: 'b.starts_on', order: 'desc' }, { column: 'b.id', order: 'desc' }]).limit(q.limit + 1);
      const { page, nextCursor } = pageOf(rows, q.limit, (row) => ({ k: row._k, id: row.id }));
      res.json({ data: await presentBatches(page, { units, canManage: canManageBatch(req, units) }), nextCursor });
    },
  );

  router.post(
    '/batches',
    describe({ summary: 'Create a batch', permission: P.batches, status: 201, description: 'Emits `batch.created`.' }),
    requireAuth(),
    validate({ body: createBatchSchema }),
    async (req, res) => {
      const body = req.valid.body;
      const id = await db.transaction(async (trx) => {
        const { unit, company } = await requireCreateUnit(req, body.unitId, P.batches, { trx });
        const product = await productOfCompany(body.productId, company.id, 'body.productId', trx);
        if (product.audience !== 'b2c') throw fieldError('body.productId', 'Batches are for programmes sold to families');
        await assertTeacher(body.teacherUserId, company.id, 'body.teacherUserId', trx);
        let row;
        try {
          [row] = await trx('batches')
            .insert({
              group_id: unit.root_id,
              company_id: company.id,
              unit_id: unit.id,
              product_id: product.id,
              product_line_id: product.product_line_id,
              ...batchColumns(body),
              created_by: req.auth.user.id,
            })
            .returning('*');
        } catch (err) {
          if (isUniqueViolation(err, 'batches_code_uq')) throw fieldError('body.code', 'Another batch of this company has this code');
          throw err;
        }
        await emit(trx, { req }, row, 'batch.created', { batchId: row.id, productId: row.product_id, capacity: row.capacity, startsOn: row.starts_on }, 'batch');
        await audit(trx, { req }, { action: 'batch.created', entityType: 'batch', entityId: row.id, unit: unitOf(row), after: { name: row.name, capacity: row.capacity, productId: row.product_id } });
        return row.id;
      });
      res.status(201).json({ data: await presentOneBatch(req, id) });
    },
  );

  router.get(
    '/batches/:id',
    describe({ summary: 'Get a batch', permission: P.view }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await presentOneBatch(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/batches/:id',
    describe({
      summary: 'Update a batch',
      permission: P.batches,
      description: 'More seats (or reopening) gives them to the waitlist in order when `enrollments.waitlistAutoPromote` is on. Capacity can not go below the seats taken. Emits `batch.updated`.',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: updateBatchSchema }),
    async (req, res) => {
      const body = req.valid.body;
      await db.transaction(async (trx) => {
        const { batch, units } = await loadBatch(req, req.valid.params.id, { trx, forUpdate: true });
        if (!canManageBatch(req, units)(batch)) throw errors.forbidden();
        const next = { ...batch, ...batchColumns(body) };
        if (next.ends_on < next.starts_on) throw fieldError('body.endsOn', 'End on or after the start');
        if (next.capacity < batch.seats_taken) throw fieldError('body.capacity', `${batch.seats_taken} seats are taken; move students out first`);
        if (next.checkout_enabled && (next.fee_minor === null || next.currency === null)) throw fieldError('body.fee', 'Set the fee to sell this batch online');
        if (next.refund_unit === 'classes' && !next.total_classes) throw fieldError('body.totalClasses', 'Give the number of classes to refund by class');
        if (body.status === 'cancelled' && batch.status !== 'cancelled' && (batch.seats_taken > 0 || batch.waitlist_count > 0)) {
          throw errors.conflict(`Move the ${batch.seats_taken + batch.waitlist_count} students of this batch first`, { seatsTaken: batch.seats_taken, waitlistCount: batch.waitlist_count });
        }
        if (body.teacherUserId) await assertTeacher(body.teacherUserId, batch.company_id, 'body.teacherUserId', trx);
        const patch = batchColumns(body);
        let updated;
        try {
          [updated] = await trx('batches').where({ id: batch.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
        } catch (err) {
          if (isUniqueViolation(err, 'batches_code_uq')) throw fieldError('body.code', 'Another batch of this company has this code');
          throw err;
        }
        const changes = Object.keys(body);
        await emit(trx, { req }, updated, 'batch.updated', { batchId: updated.id, changes }, 'batch');
        await audit(trx, { req }, {
          action: 'batch.updated',
          entityType: 'batch',
          entityId: updated.id,
          unit: unitOf(updated),
          before: Object.fromEntries(Object.keys(patch).map((c) => [c, batch[c]])),
          after: Object.fromEntries(Object.keys(patch).map((c) => [c, updated[c]])),
        });
        const unit = await trx('org_units').where({ id: updated.unit_id }).first();
        if (updated.capacity > updated.seats_taken && updated.waitlist_count > 0 && (await getSetting(unit, waitlistAutoPromoteSetting, trx))) {
          await promoteFromWaitlist(trx, { req }, updated.id);
        }
      });
      res.json({ data: await presentOneBatch(req, req.valid.params.id) });
    },
  );

  router.get(
    '/batches/:id/waitlist',
    describe({ summary: "List a batch's waitlist", permission: P.view, description: 'People waiting, first come first served. Only enrollments the user may see are listed; positions count everyone.' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const { batch } = await loadBatch(req, req.valid.params.id);
      const scope = await listScope(req, P.view, { unitId: batch.company_id });
      const rows = await applyListScope(
        db('waitlist_entries as w').join('enrollments as e', 'e.id', 'w.enrollment_id').where({ 'w.batch_id': batch.id, 'w.status': 'waiting' }),
        scope,
        { unitColumn: 'e.unit_id', ownerColumns: ['e.owner_user_id'], companyColumn: 'e.company_id', groupColumn: 'e.group_id' },
      )
        .select(
          'e.*',
          'w.id as waitlist_id',
          'w.queued_at',
          db.raw("(select count(*) from waitlist_entries x where x.batch_id = w.batch_id and x.status = 'waiting' and x.queued_seq <= w.queued_seq)::int as position"),
        )
        .orderBy('w.queued_seq')
        .limit(500);
      const ctx = await viewContext(req);
      const enrollments = await presentEnrollments(rows, ctx);
      res.json({
        data: rows.map((row, i) => ({ id: row.waitlist_id, position: row.position, queuedAt: new Date(row.queued_at).toISOString(), enrollment: enrollments[i] })),
      });
    },
  );
}

// ---------- Enrollments ----------

async function loadEnrollment(req, id, { trx = db, forUpdate = false, permission = P.view } = {}) {
  const { row, level } = await loadVisible(req, { table: 'enrollments', id, permission: P.view, notFound: 'Enrollment', trx, forUpdate });
  if (permission !== P.view) await requireRecord(req, permission, row, { trx });
  return { enrollment: row, level };
}

async function enrollmentDetail(req, id) {
  const { enrollment } = await loadEnrollment(req, id);
  const ctx = await viewContext(req);
  const [[data], withdrawal, payments, checklist] = await Promise.all([
    presentEnrollments([enrollment], ctx),
    db('enrollment_withdrawals').where({ enrollment_id: enrollment.id }).first(),
    db('enrollment_payments').where({ enrollment_id: enrollment.id }).orderBy('paid_at'),
    db('onboarding_checklists').where({ enrollment_id: enrollment.id }).first(),
  ]);
  const items = checklist ? await db('onboarding_checklist_items').where({ checklist_id: checklist.id }).orderBy('position') : [];
  const refs = await loadRefs({ userIds: items.flatMap((i) => [i.owner_user_id, i.completed_by]) });
  const units = ctx.units;
  const unit = units.get(enrollment.unit_id);
  const can = (permission) => Boolean(unit && (req.access.level(permission, unit.path) === 'all' || (req.access.level(permission, unit.path) === 'own' && enrollment.owner_user_id === req.auth.user.id)));
  const open = ['active', 'paused'].includes(enrollment.status);
  return {
    ...data,
    withdrawal: presentWithdrawal(withdrawal),
    payments: payments.map((p) => ({ id: p.id, paymentId: p.payment_id, amount: { valueMinor: Number(p.amount_minor), currency: p.currency }, paidAt: new Date(p.paid_at).toISOString() })),
    checklistItems: items.map((item) => presentChecklistItem(item, refs.users)),
    can: {
      manage: can(P.manage),
      withdraw: open && can(P.withdraw),
      changeBatch: open && can(P.manage),
      pause: enrollment.status === 'active' && can(P.manage),
      resume: enrollment.status === 'paused' && can(P.manage),
      complete: open && can(P.manage),
      manageChecklist: Boolean(checklist) && can(P.onboardingManage),
    },
  };
}


function enrollmentRoutesOnly(router) {
  router.get(
    '/enrollments',
    describe({ summary: 'List enrollments', permission: P.view, list: true, description: 'Newest first. `own` scope: enrollments the user owns. `batchId` also matches people waiting for that batch.' }),
    requireAuth(),
    validate({ query: enrollmentListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const scope = await listScope(req, P.view, { unitId: q.unitId });
      let query = applyListScope(db('enrollments as e'), scope, { unitColumn: 'e.unit_id', ownerColumns: ['e.owner_user_id'], companyColumn: 'e.company_id', groupColumn: 'e.group_id' }).select(
        'e.*',
        db.raw('e.created_at::text as _k'),
      );
      if (q.status?.length) query.whereIn('e.status', q.status);
      if (q.seatStatus) query.where('e.seat_status', q.seatStatus);
      if (q.batchId) {
        query.where((w) =>
          w.where('e.batch_id', q.batchId).orWhereExists(
            db('waitlist_entries as w').whereRaw('w.enrollment_id = e.id').where({ 'w.batch_id': q.batchId, 'w.status': 'waiting' }).select(db.raw('1')),
          ),
        );
      }
      if (q.productId) query.where('e.product_id', q.productId);
      if (q.dealId) query.where('e.deal_id', q.dealId);
      if (q.contactId) query.where((w) => w.where('e.student_contact_id', q.contactId).orWhere('e.payer_contact_id', q.contactId));
      applyOwnerFilter(query, q.owner, 'e.owner_user_id', req.auth.user.id);
      if (q.q) {
        const name = normalizeName(q.q);
        query.where((w) => {
          w.whereILike('e.ref', `%${q.q}%`);
          if (name) w.orWhereExists(db('contacts as c').whereRaw('c.id = e.student_contact_id').where('c.name_normalized', 'like', `%${name}%`).select(db.raw('1')));
        });
      }
      query = applyDescCursor(query, q.cursor, 'e.created_at', 'e.id');
      const rows = await query.orderBy([{ column: 'e.created_at', order: 'desc' }, { column: 'e.id', order: 'desc' }]).limit(q.limit + 1);
      const { page, nextCursor } = pageOf(rows, q.limit, (row) => ({ k: row._k, id: row.id }));
      res.json({ data: await presentEnrollments(page, await viewContext(req)), nextCursor });
    },
  );

  router.get(
    '/enrollments/counts',
    describe({ summary: 'Count enrollments by status', permission: P.view }),
    requireAuth(),
    validate({ query: countsQuery }),
    async (req, res) => {
      const scope = await listScope(req, P.view, { unitId: req.valid.query.unitId });
      const [row] = await applyListScope(db('enrollments as e'), scope, { unitColumn: 'e.unit_id', ownerColumns: ['e.owner_user_id'], companyColumn: 'e.company_id', groupColumn: 'e.group_id' }).select(
        db.raw("count(*) filter (where e.status = 'active')::int as active"),
        db.raw("count(*) filter (where e.status = 'paused')::int as paused"),
        db.raw("count(*) filter (where e.status = 'withdrawn')::int as withdrawn"),
        db.raw("count(*) filter (where e.status = 'completed')::int as completed"),
        db.raw("count(*) filter (where e.seat_status = 'waitlisted' and e.status in ('active', 'paused'))::int as waitlisted"),
      );
      res.json({ data: row });
    },
  );

  router.post(
    '/enrollments',
    describe({
      summary: 'Enroll a student',
      permission: P.manage,
      status: 201,
      errors: [409],
      description: 'Manual enrollment (payments and the website checkout create theirs automatically). Takes a seat, or a waitlist place when the batch is full and `joinWaitlist` is true (409 `batch_full` otherwise); starts the onboarding checklist; emits `enrollment.created`. 409 `already_enrolled` when the student already holds an open enrollment in this programme.',
    }),
    requireAuth(),
    validate({ body: createEnrollmentSchema }),
    async (req, res) => {
      const body = req.valid.body;
      const id = await db.transaction(async (trx) => {
        const { unit, company, level } = await requireCreateUnit(req, body.unitId, P.manage, { trx });
        const product = await productOfCompany(body.productId, company.id, 'body.productId', trx);
        if (product.audience !== 'b2c') throw fieldError('body.productId', 'Enroll students in programmes sold to families');
        const { contact: student } = await visibleContactField(req, body.studentContactId, 'body.studentContactId', trx);
        if (student.kind && !['student', 'other'].includes(student.kind)) throw fieldError('body.studentContactId', 'Pick the student');
        if (body.payerContactId) await visibleContactField(req, body.payerContactId, 'body.payerContactId', trx);
        if (body.householdId) {
          // The student's own family (or the payer's): never any family of the group by id, which
          // would tie another company's family (and its members' refund requests) to this enrollment.
          const members = [student.id, body.payerContactId].filter(Boolean);
          const household = await trx('households as h')
            .where({ 'h.id': body.householdId, 'h.group_id': unit.root_id })
            .whereExists(trx('household_members as m').whereRaw('m.household_id = h.id').whereIn('m.contact_id', members))
            .first('h.id');
          if (!household) throw fieldError('body.householdId', 'Pick the student’s family');
        }
        let deal = null;
        if (body.dealId) {
          deal = await visibleDealField(req, body.dealId, 'body.dealId', trx);
          if (deal.company_id !== company.id) throw fieldError('body.dealId', 'Pick a deal of the same company');
        }
        const ownerUserId = ownerFor(req, level, body.ownerUserId);
        await assertOwner(ownerUserId, unit, P.manage, 'body.ownerUserId', trx);
        const open = await trx('enrollments')
          .where({ company_id: company.id, student_contact_id: student.id, product_id: product.id })
          .whereIn('status', ['active', 'paused'])
          .first('id', 'ref');
        if (open) throw new AppError(409, 'already_enrolled', `Already enrolled (${open.ref})`, { enrollmentId: open.id });
        const household = body.householdId ?? (await trx('household_members').where({ contact_id: student.id }).orderBy('created_at').first('household_id'))?.household_id ?? null;
        const result = await createEnrollment(trx, { req }, {
          groupId: unit.root_id,
          companyId: company.id,
          unitId: unit.id,
          studentContactId: student.id,
          payerContactId: body.payerContactId ?? null,
          householdId: household,
          dealId: deal?.id ?? null,
          productId: product.id,
          productLineId: product.product_line_id,
          batchId: body.batchId ?? null,
          joinWaitlist: body.joinWaitlist,
          ownerUserId,
          source: 'manual',
          feeMinor: body.fee?.valueMinor ?? null,
          currency: body.fee?.currency ?? null,
          startsOn: body.startsOn ?? null,
          accessStatus: body.accessStatus ?? 'pending',
        });
        if (!result.created) throw new AppError(409, 'already_enrolled', `Already enrolled (${result.enrollment.ref})`, { enrollmentId: result.enrollment.id });
        return result.enrollment.id;
      });
      res.status(201).json({ data: await enrollmentDetail(req, id) });
    },
  );

  router.get(
    '/enrollments/:id',
    describe({ summary: 'Get an enrollment', permission: P.view, description: 'With its withdrawal (and refund), payments, checklist items and `can` flags.' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await enrollmentDetail(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/enrollments/:id',
    describe({ summary: 'Update an enrollment', permission: P.manage, description: 'Owner, platform access status and course dates. Emits `enrollment.updated` (and `enrollment.access_changed`).' }),
    requireAuth(),
    validate({ params: idParams, body: updateEnrollmentSchema }),
    async (req, res) => {
      const body = req.valid.body;
      await db.transaction(async (trx) => {
        const { enrollment } = await loadEnrollment(req, req.valid.params.id, { trx, forUpdate: true, permission: P.manage });
        let current = enrollment;
        const patch = {};
        if (body.ownerUserId !== undefined && body.ownerUserId !== enrollment.owner_user_id) {
          const manageLevel = (await unitsIndex(req, trx)).get(enrollment.unit_id);
          if (req.access.level(P.manage, manageLevel.path) !== 'all') throw errors.forbidden('You can only change the owner of enrollments in your whole team');
          if (body.ownerUserId) await assertOwner(body.ownerUserId, manageLevel, P.manage, 'body.ownerUserId', trx);
          patch.owner_user_id = body.ownerUserId;
        }
        if (body.startsOn !== undefined) patch.starts_on = body.startsOn;
        if (body.endsOn !== undefined) patch.ends_on = body.endsOn;
        const starts = patch.starts_on !== undefined ? patch.starts_on : enrollment.starts_on;
        const ends = patch.ends_on !== undefined ? patch.ends_on : enrollment.ends_on;
        if (starts && ends && ends < starts) throw fieldError('body.endsOn', 'End on or after the start');
        if (Object.keys(patch).length) {
          [current] = await trx('enrollments').where({ id: enrollment.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
          await emit(trx, { req }, current, 'enrollment.updated', { enrollmentId: current.id, changes: Object.keys(body).filter((k) => k !== 'accessStatus') });
          await audit(trx, { req }, {
            action: 'enrollment.updated',
            entityType: 'enrollment',
            entityId: current.id,
            unit: unitOf(current),
            before: Object.fromEntries(Object.keys(patch).map((c) => [c, enrollment[c]])),
            after: Object.fromEntries(Object.keys(patch).map((c) => [c, current[c]])),
          });
        }
        if (body.accessStatus) await setAccessStatus(trx, { req }, current, body.accessStatus);
      });
      res.json({ data: await enrollmentDetail(req, req.valid.params.id) });
    },
  );

  router.post(
    '/enrollments/:id/batch',
    describe({ summary: 'Move an enrollment to another batch', permission: P.manage, errors: [409], description: 'Frees the old seat (the next person waiting gets it). A full batch is 409 `batch_full` unless `joinWaitlist`.' }),
    requireAuth(),
    validate({ params: idParams, body: moveBatchSchema }),
    async (req, res) => {
      await db.transaction(async (trx) => {
        const { enrollment } = await loadEnrollment(req, req.valid.params.id, { trx, forUpdate: true, permission: P.manage });
        await loadBatch(req, req.valid.body.batchId, { trx }).catch(() => {
          throw fieldError('body.batchId', 'Not found');
        });
        await changeBatch(trx, { req }, enrollment, req.valid.body.batchId, { joinWaitlist: req.valid.body.joinWaitlist });
      });
      res.json({ data: await enrollmentDetail(req, req.valid.params.id) });
    },
  );

  const statusAction = (path, summary, description, fn, schema) =>
    router.post(
      `/enrollments/:id/${path}`,
      describe({ summary, permission: P.manage, errors: [409], description }),
      requireAuth(),
      validate(schema ? { params: idParams, body: schema } : { params: idParams }),
      async (req, res) => {
        await db.transaction(async (trx) => {
          const { enrollment } = await loadEnrollment(req, req.valid.params.id, { trx, forUpdate: true, permission: P.manage });
          await fn(trx, { req }, enrollment, req.valid.body ?? {});
        });
        res.json({ data: await enrollmentDetail(req, req.valid.params.id) });
      },
    );

  statusAction(
    'pause',
    'Pause an enrollment',
    'The seat is kept; platform access is suspended. Paused enrollments with `resumeOn` resume on that day (worker job). Emits `enrollment.paused`.',
    (trx, ctx, enrollment, body) => pauseEnrollment(trx, ctx, enrollment, { resumeOn: body.resumeOn ?? null, reason: body.reason ?? null }),
    pauseSchema,
  );
  statusAction('resume', 'Resume a paused enrollment', 'Emits `enrollment.resumed`.', (trx, ctx, enrollment) => resumeEnrollment(trx, ctx, enrollment));
  statusAction('complete', 'Mark an enrollment completed', 'Frees the seat. Emits `enrollment.completed`.', (trx, ctx, enrollment) => completeEnrollment(trx, ctx, enrollment));

  router.post(
    '/enrollments/:id/withdraw/preview',
    describe({ summary: 'Preview the refund for a withdrawal', permission: P.withdraw, description: 'The pro-rata refund and its due date, computed exactly as a withdrawal would. Changes nothing.' }),
    requireAuth(),
    validate({ params: idParams, body: refundPreviewSchema }),
    async (req, res) => {
      const { enrollment } = await loadEnrollment(req, req.valid.params.id, { permission: P.withdraw });
      const body = req.valid.body;
      const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
      const result = await previewRefund(db, enrollment, {
        receivedAt,
        effectiveOn: body.effectiveOn ?? localDate(receivedAt.getTime()),
        classesAttended: body.classesAttended ?? null,
      });
      res.json({ data: { refund: { valueMinor: result.refundMinor, currency: result.currency }, dueAt: result.dueAt, coolingOff: result.coolingOff, basis: result.basis } });
    },
  );

  router.post(
    '/enrollments/:id/withdraw',
    describe({
      summary: 'Withdraw an enrollment',
      permission: P.withdraw,
      errors: [409],
      description:
        'Records the request (its time starts the refund clock: `enrollments.refundSlaDays`, 10 by default, MoE coaching guidelines 2024 cl. 8(iv)), frees the seat, revokes platform access and emits `refund.requested` with the pro-rata amount for the money module, plus `enrollment.withdrawn`. A reason is optional.',
    }),
    requireAuth(),
    validate({ params: idParams, body: withdrawSchema }),
    async (req, res) => {
      const body = req.valid.body;
      await db.transaction(async (trx) => {
        const { enrollment } = await loadEnrollment(req, req.valid.params.id, { trx, forUpdate: true, permission: P.withdraw });
        if (body.requestedByContactId) {
          const ok =
            [enrollment.student_contact_id, enrollment.payer_contact_id].includes(body.requestedByContactId) ||
            (enrollment.household_id && (await trx('household_members').where({ household_id: enrollment.household_id, contact_id: body.requestedByContactId }).first()));
          if (!ok) throw fieldError('body.requestedByContactId', 'Pick the student, the payer or someone in their family');
        }
        await withdrawEnrollment(trx, { req }, enrollment, body);
      });
      res.json({ data: await enrollmentDetail(req, req.valid.params.id) });
    },
  );
}

export function enrollmentRoutes(router) {
  batchRoutes(router);
  enrollmentRoutesOnly(router);
}

export { loadEnrollment, enrollmentDetail };
