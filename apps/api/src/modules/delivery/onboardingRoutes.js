import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { pageOf } from '../../lib/pagination.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { applyListScope, companiesInScope, listScope, loadVisible, requireCompany, requireCreateUnit, requireRecord, unitsIndex } from '../../core/crm/scope.js';
import { localDate } from '../../core/billing/dates.js';
import {
  PERMISSIONS as P,
  applyAscCursor,
  applyDescCursor,
  applyOwnerFilter,
  assertOwner,
  fieldError,
  ownerFor,
  productOfCompany,
  viewContext,
  visibleAccountField,
  visibleDealField,
} from './access.js';
import {
  addTaskSchema,
  checklistListQuery,
  createProjectSchema,
  createTemplateSchema,
  idAndItemParams,
  idAndPhaseParams,
  idAndTaskParams,
  idParams,
  itemUpdateSchema,
  phaseUpdateSchema,
  projectListQuery,
  renewalListQuery,
  taskUpdateSchema,
  templateListQuery,
  updateProjectSchema,
  updateTemplateSchema,
} from './schemas.js';
import { loadRefs, presentChecklistItem, presentChecklistSummary, presentProjects, presentRenewals } from './present.js';
import { addTask, ensureImplementationProject, saveTemplate, updateChecklistItem, updatePhase, updateProject, updateTask } from './onboarding.js';
import { DEFAULT_IMPLEMENTATION_PHASES } from './constants.js';

// Onboarding: templates, B2C checklists, B2B implementation projects and renewals
// (docs/delivery/DELIVERY.md §8.4-8.6).

const scoped = (query, scope, alias) =>
  applyListScope(query, scope, { unitColumn: `${alias}.unit_id`, ownerColumns: [`${alias}.owner_user_id`], companyColumn: `${alias}.company_id`, groupColumn: `${alias}.group_id` });

const canAt = (req, units, permission, row) => {
  const unit = units.get(row.unit_id);
  if (!unit) return false;
  const level = req.access.level(permission, unit.path);
  return level === 'all' || (level === 'own' && row.owner_user_id === req.auth.user.id);
};

// ---------- Templates ----------

function presentTemplate(row, items, refs) {
  return {
    id: row.id,
    companyId: row.company_id,
    kind: row.kind,
    name: row.name,
    productLine: refs.lines.get(row.product_line_id) ? { id: row.product_line_id, name: refs.lines.get(row.product_line_id).name, kind: refs.lines.get(row.product_line_id).kind } : null,
    product: refs.products.get(row.product_id) ? { id: row.product_id, name: refs.products.get(row.product_id).name, code: refs.products.get(row.product_id).code ?? null } : null,
    phases: row.kind === 'b2b' ? (row.phases?.length ? row.phases : DEFAULT_IMPLEMENTATION_PHASES) : [],
    items: items.map((item) => ({
      id: item.id,
      phaseKey: item.phase_key ?? null,
      title: item.title,
      description: item.description ?? null,
      ownerRole: item.owner_role,
      dueOffsetDays: item.due_offset_days,
      position: item.position,
    })),
    active: row.active,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function presentTemplates(rows) {
  const ids = rows.map((r) => r.id);
  const [items, refs] = await Promise.all([
    ids.length ? db('onboarding_template_items').whereIn('template_id', ids).orderBy(['template_id', 'position']) : [],
    loadRefs({ productIds: rows.map((r) => r.product_id), lineIds: rows.map((r) => r.product_line_id) }),
  ]);
  return rows.map((row) => presentTemplate(row, items.filter((i) => i.template_id === row.id), refs));
}

async function checkTemplateRefs(body, company, trx) {
  if (body.productId) {
    const product = await productOfCompany(body.productId, company.id, 'body.productId', trx);
    if (body.productLineId && body.productLineId !== product.product_line_id) throw fieldError('body.productLineId', "This isn't the programme's line");
  }
  if (body.productLineId) {
    const line = await trx('product_lines').where({ id: body.productLineId }).first('company_id');
    if (!line) throw fieldError('body.productLineId', 'Not found');
    if (line.company_id !== company.id) throw fieldError('body.productLineId', 'Pick a line of the same company');
  }
  if (body.items.length && body.phases?.length) {
    const keys = new Set(body.phases.map((p) => p.key));
    body.items.forEach((item, index) => {
      if (item.phaseKey && !keys.has(item.phaseKey)) throw fieldError(`body.items.${index}.phaseKey`, 'Pick one of the phases');
    });
  }
}

function templateRoutes(router) {
  router.get(
    '/onboarding/templates',
    describe({ summary: 'List onboarding templates', permission: P.onboardingView, description: 'Checklist (b2c) and implementation (b2b) templates of the companies in scope, with their items.' }),
    requireAuth(),
    validate({ query: templateListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const companies = q.companyId ? [await requireCompany(req, q.companyId, P.onboardingView)] : await companiesInScope(req, q.unitId, P.onboardingView);
      if (companies.length === 0) throw errors.forbidden();
      const rows = await db('onboarding_templates')
        .whereIn('company_id', companies.map((c) => c.id))
        .modify((query) => {
          if (q.kind) query.where('kind', q.kind);
        })
        .orderBy([{ column: 'kind' }, { column: 'name' }, { column: 'id' }])
        .limit(1000);
      res.json({ data: await presentTemplates(rows) });
    },
  );

  router.post(
    '/onboarding/templates',
    describe({ summary: 'Create an onboarding template', permission: P.configure, status: 201, description: 'For a programme (productId), a line or the whole company. The most specific active template is used for new enrollments or projects.' }),
    requireAuth(),
    validate({ body: createTemplateSchema }),
    async (req, res) => {
      const body = req.valid.body;
      const row = await db.transaction(async (trx) => {
        const company = await requireCompany(req, body.companyId, P.configure, { write: true, trx, path: 'body.companyId' });
        await checkTemplateRefs(body, company, trx);
        return saveTemplate(trx, { req }, null, body, { company });
      });
      res.status(201).json({ data: (await presentTemplates([row]))[0] });
    },
  );

  router.put(
    '/onboarding/templates/:id',
    describe({ summary: 'Replace an onboarding template', permission: P.configure, description: 'Name, scope, phases and items. Checklists and projects already started keep their items.' }),
    requireAuth(),
    validate({ params: idParams, body: updateTemplateSchema }),
    async (req, res) => {
      const row = await db.transaction(async (trx) => {
        const template = await trx('onboarding_templates').where({ id: req.valid.params.id }).forUpdate().first();
        if (!template) throw errors.notFound('Template');
        const units = await unitsIndex(req, trx);
        const companyUnit = units.get(template.company_id);
        if (!companyUnit || !req.access.canSee(companyUnit.path) || !req.access.canAnywhereWithin(P.onboardingView, companyUnit.path)) throw errors.notFound('Template');
        const company = await requireCompany(req, template.company_id, P.configure, { write: true, trx });
        const body = { ...req.valid.body, kind: template.kind };
        if (template.kind === 'b2c' && body.phases?.length) throw fieldError('body.phases', 'Checklists have no phases');
        await checkTemplateRefs({ ...body, phases: body.phases ?? template.phases }, company, trx);
        return saveTemplate(trx, { req }, template, body, { company });
      });
      res.json({ data: (await presentTemplates([row]))[0] });
    },
  );
}

// ---------- B2C checklists ----------

async function loadChecklist(req, id, { trx = db, forUpdate = false } = {}) {
  const { row } = await loadVisible(req, { table: 'onboarding_checklists', id, permission: P.onboardingView, notFound: 'Checklist', trx, forUpdate });
  return row;
}

async function presentChecklistPage(req, rows) {
  const ctx = await viewContext(req);
  const enrollmentRows = rows.length ? await db('enrollments').whereIn('id', rows.map((r) => r.enrollment_id)) : [];
  const enrollments = new Map(enrollmentRows.map((e) => [e.id, e]));
  const refs = await loadRefs({
    userIds: rows.map((r) => r.owner_user_id),
    contactIds: enrollmentRows.map((e) => e.student_contact_id),
    batchIds: enrollmentRows.map((e) => e.batch_id),
    productIds: enrollmentRows.map((e) => e.product_id),
  });
  return rows.map((row) => presentChecklistSummary(row, { units: ctx.units, refs, enrollments, canViewPii: ctx.canViewPii }));
}

async function checklistDetail(req, id) {
  const checklist = await loadChecklist(req, id);
  const [summary] = await presentChecklistPage(req, [
    {
      ...checklist,
      ...(await db('onboarding_checklist_items')
        .where({ checklist_id: checklist.id, status: 'pending' })
        .first(db.raw('min(due_on)::text as next_due_on'), db.raw('count(*) filter (where due_on < ?)::int as overdue_count', [localDate(Date.now())]))),
    },
  ]);
  const items = await db('onboarding_checklist_items').where({ checklist_id: checklist.id }).orderBy('position');
  const refs = await loadRefs({ userIds: items.flatMap((i) => [i.owner_user_id, i.completed_by]) });
  const units = await unitsIndex(req);
  return { ...summary, items: items.map((item) => presentChecklistItem(item, refs.users)), can: { manage: canAt(req, units, P.onboardingManage, checklist) } };
}

function checklistRoutes(router) {
  router.get(
    '/onboarding/checklists',
    describe({ summary: 'List onboarding checklists', permission: P.onboardingView, list: true, description: 'B2C checklists, newest first, with the next due item and overdue count. `own` scope: checklists the user owns.' }),
    requireAuth(),
    validate({ query: checklistListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const scope = await listScope(req, P.onboardingView, { unitId: q.unitId });
      const today = localDate(Date.now());
      let query = scoped(db('onboarding_checklists as k'), scope, 'k').select(
        'k.*',
        db.raw('k.created_at::text as _k'),
        db.raw("(select min(i.due_on)::text from onboarding_checklist_items i where i.checklist_id = k.id and i.status = 'pending') as next_due_on"),
        db.raw("(select count(*) from onboarding_checklist_items i where i.checklist_id = k.id and i.status = 'pending' and i.due_on < ?)::int as overdue_count", [today]),
      );
      if (q.status) query.where('k.status', q.status);
      applyOwnerFilter(query, q.owner, 'k.owner_user_id', req.auth.user.id);
      if (q.overdue) {
        query.whereExists(db('onboarding_checklist_items as i').whereRaw('i.checklist_id = k.id').where('i.status', 'pending').where('i.due_on', '<', today).select(db.raw('1')));
      }
      query = applyDescCursor(query, q.cursor, 'k.created_at', 'k.id');
      const rows = await query.orderBy([{ column: 'k.created_at', order: 'desc' }, { column: 'k.id', order: 'desc' }]).limit(q.limit + 1);
      const { page, nextCursor } = pageOf(rows, q.limit, (row) => ({ k: row._k, id: row.id }));
      res.json({ data: await presentChecklistPage(req, page), nextCursor });
    },
  );

  router.get(
    '/onboarding/checklists/:id',
    describe({ summary: 'Get an onboarding checklist', permission: P.onboardingView }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await checklistDetail(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/onboarding/checklists/:id/items/:itemId',
    describe({ summary: 'Update a checklist item', permission: P.onboardingManage, description: 'Done, skipped or pending; owner; due date. The checklist closes when every item is done or skipped (`onboarding.checklist_completed`).' }),
    requireAuth(),
    validate({ params: idAndItemParams, body: itemUpdateSchema }),
    async (req, res) => {
      const { id, itemId } = req.valid.params;
      const body = req.valid.body;
      await db.transaction(async (trx) => {
        const checklist = await loadChecklist(req, id, { trx, forUpdate: true });
        await requireRecord(req, P.onboardingManage, checklist, { trx });
        const item = await trx('onboarding_checklist_items').where({ id: itemId, checklist_id: checklist.id }).forUpdate().first();
        if (!item) throw errors.notFound('Item');
        if (body.ownerUserId) {
          const unit = (await unitsIndex(req, trx)).get(checklist.unit_id);
          await assertOwner(body.ownerUserId, unit, P.onboardingView, 'body.ownerUserId', trx);
        }
        await updateChecklistItem(trx, { req }, item, checklist, body);
      });
      res.json({ data: await checklistDetail(req, id) });
    },
  );
}

// ---------- B2B implementation projects ----------

async function loadProject(req, id, { trx = db, forUpdate = false, permission = P.onboardingView } = {}) {
  const { row } = await loadVisible(req, { table: 'implementation_projects', id, permission: P.onboardingView, notFound: 'Project', trx, forUpdate });
  if (permission !== P.onboardingView) await requireRecord(req, permission, row, { trx });
  return row;
}

async function projectDetail(req, id) {
  const project = await loadProject(req, id);
  const units = await unitsIndex(req);
  const [[summary], phases, tasks] = await Promise.all([
    presentProjects([project], { units }),
    db('implementation_phases').where({ project_id: project.id }).orderBy('position'),
    db('implementation_tasks').where({ project_id: project.id }).orderBy(['phase_id', 'position']),
  ]);
  const refs = await loadRefs({ userIds: [...phases.map((p) => p.owner_user_id), ...tasks.flatMap((t) => [t.owner_user_id, t.completed_by])] });
  const today = localDate(Date.now());
  const user = (uid) => (refs.users.get(uid) ? { id: uid, name: refs.users.get(uid).name } : null);
  return {
    ...summary,
    phases: phases.map((phase) => ({
      id: phase.id,
      key: phase.key,
      name: phase.name,
      position: phase.position,
      status: phase.status,
      owner: user(phase.owner_user_id),
      dueOn: phase.due_on ?? null,
      overdue: phase.status !== 'done' && Boolean(phase.due_on && phase.due_on < today),
      completedAt: phase.completed_at ? new Date(phase.completed_at).toISOString() : null,
      tasks: tasks
        .filter((t) => t.phase_id === phase.id)
        .map((t) => ({ ...presentChecklistItem(t, refs.users), overdue: t.status === 'pending' && Boolean(t.due_on && t.due_on < today) })),
    })),
    can: { manage: canAt(req, units, P.onboardingManage, project) },
  };
}

function projectRoutes(router) {
  router.get(
    '/implementation-projects',
    describe({ summary: 'List implementation projects', permission: P.onboardingView, list: true, description: 'B2B onboarding projects, newest first, with their current phase. `own` scope: projects the user owns.' }),
    requireAuth(),
    validate({ query: projectListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const scope = await listScope(req, P.onboardingView, { unitId: q.unitId });
      let query = scoped(db('implementation_projects as p'), scope, 'p').select(
        'p.*',
        db.raw('p.created_at::text as _k'),
        db.raw(
          "(select json_build_object('key', ph.key, 'name', ph.name, 'dueOn', ph.due_on::text) from implementation_phases ph where ph.project_id = p.id and ph.status <> 'done' order by ph.position limit 1) as current_phase",
        ),
      );
      if (q.status?.length) query.whereIn('p.status', q.status);
      if (q.accountId) query.where('p.account_id', q.accountId);
      if (q.dealId) query.where('p.deal_id', q.dealId);
      applyOwnerFilter(query, q.owner, 'p.owner_user_id', req.auth.user.id);
      query = applyDescCursor(query, q.cursor, 'p.created_at', 'p.id');
      const rows = await query.orderBy([{ column: 'p.created_at', order: 'desc' }, { column: 'p.id', order: 'desc' }]).limit(q.limit + 1);
      const { page, nextCursor } = pageOf(rows, q.limit, (row) => ({ k: row._k, id: row.id }));
      res.json({ data: await presentProjects(page, { units: await unitsIndex(req) }), nextCursor });
    },
  );

  router.post(
    '/implementation-projects',
    describe({ summary: 'Start an implementation project', permission: P.onboardingManage, status: 201, description: 'By hand (won deals, signed contracts and new subscriptions start theirs automatically). Phases and tasks come from the company template. One project per deal: 409 when the deal has one.' }),
    requireAuth(),
    validate({ body: createProjectSchema }),
    async (req, res) => {
      const body = req.valid.body;
      const id = await db.transaction(async (trx) => {
        const { unit, company, level } = await requireCreateUnit(req, body.unitId, P.onboardingManage, { trx });
        const { account } = await visibleAccountField(req, body.accountId, 'body.accountId', trx);
        if (account.group_id !== unit.root_id) throw fieldError('body.accountId', 'Not found');
        let deal = null;
        if (body.dealId) {
          deal = await visibleDealField(req, body.dealId, 'body.dealId', trx);
          if (deal.company_id !== company.id) throw fieldError('body.dealId', 'Pick a deal of the same company');
          if (deal.account_id && deal.account_id !== account.id) throw fieldError('body.dealId', 'This deal is for another institute');
          const existing = await trx('implementation_projects').where({ deal_id: deal.id }).first('id');
          if (existing) throw errors.conflict('This deal already has an implementation project', { projectId: existing.id });
        }
        const product = body.productId ? await productOfCompany(body.productId, company.id, 'body.productId', trx) : null;
        const ownerUserId = ownerFor(req, level, body.ownerUserId);
        await assertOwner(ownerUserId, unit, P.onboardingManage, 'body.ownerUserId', trx);
        if (body.kickoffOn && body.targetGoLiveOn && body.targetGoLiveOn < body.kickoffOn) throw fieldError('body.targetGoLiveOn', 'Go-live on or after kickoff');
        const { project } = await ensureImplementationProject(trx, { req }, {
          groupId: unit.root_id,
          companyId: company.id,
          unitId: unit.id,
          accountId: account.id,
          dealId: deal?.id ?? null,
          productId: product?.id ?? deal?.product_id ?? null,
          productLineId: product?.product_line_id ?? deal?.product_line_id ?? null,
          name: body.name,
          ownerUserId,
          kickoffOn: body.kickoffOn,
          targetGoLiveOn: body.targetGoLiveOn,
          trigger: 'manual',
        });
        return project.id;
      });
      res.status(201).json({ data: await projectDetail(req, id) });
    },
  );

  router.get(
    '/implementation-projects/:id',
    describe({ summary: 'Get an implementation project', permission: P.onboardingView, description: 'With its phases (kickoff, data import, training, go-live by default) and their tasks.' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await projectDetail(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/implementation-projects/:id',
    describe({ summary: 'Update an implementation project', permission: P.onboardingManage, description: 'Name, status (`live` emits `implementation.went_live`), owner and dates.' }),
    requireAuth(),
    validate({ params: idParams, body: updateProjectSchema }),
    async (req, res) => {
      const body = req.valid.body;
      await db.transaction(async (trx) => {
        const project = await loadProject(req, req.valid.params.id, { trx, forUpdate: true, permission: P.onboardingManage });
        const unit = (await unitsIndex(req, trx)).get(project.unit_id);
        if (body.ownerUserId !== undefined && body.ownerUserId !== project.owner_user_id) {
          if (req.access.level(P.onboardingManage, unit.path) !== 'all') throw errors.forbidden('You can only change the owner of projects in your whole team');
          await assertOwner(body.ownerUserId, unit, P.onboardingManage, 'body.ownerUserId', trx);
        }
        const kickoff = body.kickoffOn !== undefined ? body.kickoffOn : project.kickoff_on;
        const goLive = body.targetGoLiveOn !== undefined ? body.targetGoLiveOn : project.target_go_live_on;
        if (kickoff && goLive && goLive < kickoff) throw fieldError('body.targetGoLiveOn', 'Go-live on or after kickoff');
        await updateProject(trx, { req }, project, body);
      });
      res.json({ data: await projectDetail(req, req.valid.params.id) });
    },
  );

  router.post(
    '/implementation-projects/:id/tasks',
    describe({ summary: 'Add a task to an implementation project', permission: P.onboardingManage, status: 201 }),
    requireAuth(),
    validate({ params: idParams, body: addTaskSchema }),
    async (req, res) => {
      await db.transaction(async (trx) => {
        const project = await loadProject(req, req.valid.params.id, { trx, forUpdate: true, permission: P.onboardingManage });
        if (req.valid.body.ownerUserId) await assertOwner(req.valid.body.ownerUserId, (await unitsIndex(req, trx)).get(project.unit_id), P.onboardingView, 'body.ownerUserId', trx);
        await addTask(trx, { req }, project, req.valid.body);
      });
      res.status(201).json({ data: await projectDetail(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/implementation-projects/:id/tasks/:taskId',
    describe({ summary: 'Update an implementation task', permission: P.onboardingManage, description: 'Phases move along with their tasks: in progress once one is done, done when all are.' }),
    requireAuth(),
    validate({ params: idAndTaskParams, body: taskUpdateSchema }),
    async (req, res) => {
      const { id, taskId } = req.valid.params;
      await db.transaction(async (trx) => {
        const project = await loadProject(req, id, { trx, forUpdate: true, permission: P.onboardingManage });
        const task = await trx('implementation_tasks').where({ id: taskId, project_id: project.id }).forUpdate().first();
        if (!task) throw errors.notFound('Task');
        if (req.valid.body.ownerUserId) await assertOwner(req.valid.body.ownerUserId, (await unitsIndex(req, trx)).get(project.unit_id), P.onboardingView, 'body.ownerUserId', trx);
        await updateTask(trx, { req }, task, project, req.valid.body);
      });
      res.json({ data: await projectDetail(req, id) });
    },
  );

  router.patch(
    '/implementation-projects/:id/phases/:phaseId',
    describe({ summary: 'Update an implementation phase', permission: P.onboardingManage }),
    requireAuth(),
    validate({ params: idAndPhaseParams, body: phaseUpdateSchema }),
    async (req, res) => {
      const { id, phaseId } = req.valid.params;
      await db.transaction(async (trx) => {
        const project = await loadProject(req, id, { trx, forUpdate: true, permission: P.onboardingManage });
        const phase = await trx('implementation_phases').where({ id: phaseId, project_id: project.id }).forUpdate().first();
        if (!phase) throw errors.notFound('Phase');
        if (req.valid.body.ownerUserId) await assertOwner(req.valid.body.ownerUserId, (await unitsIndex(req, trx)).get(project.unit_id), P.onboardingView, 'body.ownerUserId', trx);
        await updatePhase(trx, { req }, phase, project, req.valid.body);
      });
      res.json({ data: await projectDetail(req, id) });
    },
  );
}

// ---------- Renewals ----------

function renewalRoutes(router) {
  router.get(
    '/renewals',
    describe({
      summary: 'List renewals',
      permission: P.renewals,
      list: true,
      description: 'Subscriptions coming up for renewal, soonest first (`sort=due`) or riskiest first (`sort=risk`), with churn-risk signals and upsell flags (scored nightly). `own` scope: renewals the user owns.',
    }),
    requireAuth(),
    validate({ query: renewalListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const scope = await listScope(req, P.renewals, { unitId: q.unitId });
      const today = localDate(Date.now());
      let query = scoped(db('renewals as r'), scope, 'r').where('r.status', q.status);
      if (q.risk?.length) query.whereIn('r.churn_level', q.risk);
      if (q.dueWithinDays !== undefined) query.where('r.term_end', '>=', today).whereRaw('r.term_end <= ?::date + ?::int', [today, q.dueWithinDays]);
      if (q.upsell) query.whereRaw("jsonb_array_length(r.upsell_flags) > 0");
      applyOwnerFilter(query, q.owner, 'r.owner_user_id', req.auth.user.id);
      if (q.sort === 'risk') {
        query = applyDescCursor(query.select('r.*', db.raw('r.churn_score::text as _k')), q.cursor, 'r.churn_score', 'r.id');
        // churn_score is an integer; compare numerically.
        query.orderBy([{ column: 'r.churn_score', order: 'desc' }, { column: 'r.id', order: 'desc' }]);
      } else {
        query = applyAscCursor(query.select('r.*', db.raw('r.term_end::text as _k')), q.cursor, 'r.term_end', 'r.id');
        query.orderBy([{ column: 'r.term_end' }, { column: 'r.id' }]);
      }
      const rows = await query.limit(q.limit + 1);
      const { page, nextCursor } = pageOf(rows, q.limit, (row) => ({ k: row._k, id: row.id }));
      res.json({ data: await presentRenewals(page, { units: await unitsIndex(req) }), nextCursor });
    },
  );

  router.get(
    '/renewals/summary',
    describe({ summary: 'Summarise upcoming renewals', permission: P.renewals, description: 'Counts and value due in 30/90 days and by churn level, per currency.' }),
    requireAuth(),
    validate({ query: renewalListQuery.pick({ unitId: true }) }),
    async (req, res) => {
      const scope = await listScope(req, P.renewals, { unitId: req.valid.query.unitId });
      const today = localDate(Date.now());
      const rows = await scoped(db('renewals as r'), scope, 'r')
        .where('r.status', 'active')
        .where('r.term_end', '>=', today)
        .groupBy('r.currency')
        .select(
          'r.currency',
          db.raw('count(*) filter (where r.term_end <= ?::date + 30)::int as due30', [today]),
          db.raw('count(*) filter (where r.term_end <= ?::date + 90)::int as due90', [today]),
          db.raw('coalesce(sum(r.amount_minor) filter (where r.term_end <= ?::date + 90), 0)::bigint as value90', [today]),
          db.raw("count(*) filter (where r.churn_level = 'high')::int as high"),
          db.raw("count(*) filter (where r.churn_level = 'medium')::int as medium"),
          db.raw('count(*) filter (where jsonb_array_length(r.upsell_flags) > 0)::int as upsell'),
        );
      const sum = (key) => rows.reduce((n, r) => n + Number(r[key]), 0);
      res.json({
        data: {
          due30: sum('due30'),
          due90: sum('due90'),
          high: sum('high'),
          medium: sum('medium'),
          upsell: sum('upsell'),
          value90: rows.map((r) => ({ valueMinor: Number(r.value90), currency: r.currency })),
        },
      });
    },
  );
}

export function onboardingRoutes(router) {
  templateRoutes(router);
  checklistRoutes(router);
  projectRoutes(router);
  renewalRoutes(router);
}
