import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { writeAudit } from '../../core/audit.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { companiesInScope, levelForRecord, listScope, requireCompany, scopePaths, unitsIndex } from '../../core/crm/scope.js';
import { optionalText, pageQuery } from '../../core/crm/schemas.js';
import { FILTER_ROOTS, FLOW_LIMITS, FUNCTION_DOCS, RUN_ROOTS, VALIDATION_LIMITS } from '../../core/automation/index.js';
import { executorSummary, INTEGRATION_ACTIONS } from './actions.js';
import { canDecideApproval, canSeeApproval, presentApproval } from './approvals.js';
import { APPROVAL_STATUSES, FLOW_KINDS, FLOW_STATUSES, LIMITS, RUN_STATUSES } from './constants.js';
import {
  checkDefinition,
  createFlow,
  engineFieldErrors,
  flowStats,
  loadFlow,
  missingActionPermissions,
  presentFlow,
  presentVersion,
  requireFlowUnit,
  setFlowStatus,
  updateFlow,
} from './flows.js';
import { getAutomationRegistry } from './registry.js';
import { cancelLockedRun, loadVersions, tick } from './runner.js';
import { dealVisibility, decideApproval, presentEffect, presentRun, presentRunStep, simulateFlow } from './service.js';
import { presentTemplate, templateByKey, FLOW_TEMPLATES } from './templates.js';

// Endpoints of the automations module (docs/automations/AUTOMATIONS.md §4). Literal paths are
// registered before /:id paths. Every handler checks permission and company scope itself.

const MAX_DEFINITION_BYTES = 256 * 1024;
const definitionSchema = z
  .record(z.string(), z.unknown())
  .refine((d) => Buffer.byteLength(JSON.stringify(d)) <= MAX_DEFINITION_BYTES, 'The flow is too large (256 KB at most)');
const jsonObject = z.record(z.string(), z.unknown());

function requireAnywhere(req, permission) {
  const paths = scopePaths(req.access, permission);
  if (paths.all.length === 0 && paths.own.length === 0) throw errors.forbidden();
}

const runColumns = [
  'r.id', 'r.group_id', 'r.company_id', 'r.unit_id', 'r.flow_id', 'r.flow_version', 'r.subject_type', 'r.subject_id', 'r.deal_id',
  'r.status', 'r.waiting_kind', 'r.waiting_event', 'r.next_wake_at', 'r.step_count', 'r.error', 'r.end_reason',
  'r.trigger_event_id', 'r.started_at', 'r.ended_at', 'r.updated_at',
  'f.name as flow_name', 'f.kind as flow_kind',
  'd.ref as deal_ref', 'd.title as deal_title', 'd.unit_id as deal_unit_id', 'd.owner_user_id as deal_owner_user_id',
];

/** List rows carry only the state's summary (cursor, waiting, last trace entry), not the whole state. */
function runListColumns(q) {
  return q.select(
    ...runColumns,
    db.raw(
      "jsonb_build_object('cursor', r.state->'cursor', 'waiting', r.state->'waiting', 'trace', case when jsonb_typeof(r.state->'trace') = 'array' and jsonb_array_length(r.state->'trace') > 0 then jsonb_build_array(r.state->'trace'->-1) else '[]'::jsonb end) as state",
    ),
    db.raw("jsonb_build_object('type', r.trigger->>'type') as trigger"),
  );
}

export function automationRoutes(router) {
  // ---------- Catalog and templates ----------

  router.get(
    '/automations/catalog',
    describe({ summary: 'Triggers, actions and AI agents flows can use', permission: 'automations.view', description: 'JSON Schemas for the editor forms, sample events, expression functions and where each action runs (a module, or `development`: recorded, nothing sent).' }),
    requireAuth(),
    (req, res) => {
      requireAnywhere(req, 'automations.view');
      const catalog = getAutomationRegistry().catalog();
      res.json({
        data: {
          ...catalog,
          executors: executorSummary(),
          integrationActions: INTEGRATION_ACTIONS,
          roots: RUN_ROOTS,
          filterRoots: FILTER_ROOTS,
          functions: catalog.functions ?? FUNCTION_DOCS,
          limits: { maxSteps: FLOW_LIMITS.maxSteps, maxCases: FLOW_LIMITS.maxCases, maxChain: VALIDATION_LIMITS.maxChain },
        },
      });
    },
  );

  router.get(
    '/automations/templates',
    describe({ summary: 'Flow templates (welcome, nurture for lost leads, no-show, payment chaser)', permission: 'automations.view' }),
    requireAuth(),
    (req, res) => {
      requireAnywhere(req, 'automations.view');
      res.json({ data: FLOW_TEMPLATES.map(presentTemplate) });
    },
  );

  // ---------- Flows ----------

  router.get(
    '/automations/flows',
    describe({ summary: 'List the flows of the companies in a working scope', permission: 'automations.view', description: 'Configuration list: every flow (up to 500 per company), with run counts. Archived flows only with `status=archived`.' }),
    requireAuth(),
    validate({
      query: z.strictObject({
        unitId: z.uuid(),
        status: z.enum(FLOW_STATUSES).optional(),
        kind: z.enum(FLOW_KINDS).optional(),
        q: optionalText(100),
      }),
    }),
    async (req, res) => {
      const { unitId, status, kind, q } = req.valid.query;
      const companies = await companiesInScope(req, unitId, 'automations.view');
      if (companies.length === 0) {
        if (!req.access.canAnywhereWithin('automations.view', (await unitsIndex(req)).get(unitId)?.path ?? '-')) throw errors.forbidden();
        return res.json({ data: [] });
      }
      const rows = await db('automation_flows')
        .whereIn('company_id', companies.map((c) => c.id))
        .modify((query) => {
          if (status) query.where('status', status);
          else query.whereNot('status', 'archived');
          if (kind) query.where('kind', kind);
          if (q) query.whereRaw('name ilike ?', [`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`]);
        })
        .orderByRaw('lower(name), id')
        .limit(LIMITS.flowsPerCompany * companies.length);
      const stats = await flowStats(db, rows.map((r) => r.id));
      const index = await unitsIndex(req);
      res.json({ data: rows.map((row) => presentFlow(row, { unit: index.get(row.unit_id), stats: stats.get(row.id) ?? { activeRuns: 0, runsLast7Days: 0, failedLast7Days: 0 }, definition: false })) });
    },
  );

  const createBody = z
    .strictObject({
      companyId: z.uuid(),
      unitId: z.uuid().optional(),
      name: optionalText(120),
      description: optionalText(2000),
      kind: z.enum(FLOW_KINDS).optional(),
      definition: definitionSchema.optional(),
      templateKey: z.string().max(64).optional(),
      note: optionalText(300),
    })
    .refine((b) => b.definition || b.templateKey, { message: 'Start from a template or send a definition', path: ['definition'] })
    .refine((b) => b.name || b.templateKey, { message: 'Name the flow', path: ['name'] });

  router.post(
    '/automations/flows',
    describe({ summary: 'Create a flow (draft)', permission: 'automations.manage', status: 201, description: 'From a definition or a template. The definition is validated by the engine; errors come back as 422 with paths under `body.definition`. You also need the permission of every action the flow performs (e.g. `automations.webhooks` for webhooks).' }),
    requireAuth(),
    validate({ body: createBody }),
    async (req, res) => {
      const body = req.valid.body;
      const template = body.templateKey ? templateByKey.get(body.templateKey) : null;
      if (body.templateKey && !template) throw errors.validation([{ path: 'body.templateKey', message: 'Unknown template' }]);
      const { company, unit } = await requireFlowUnit(req, body.companyId, body.unitId);
      const flow = await createFlow(req, {
        company,
        unit,
        name: body.name ?? template.name,
        description: body.description ?? template?.description ?? null,
        kind: body.kind ?? template?.kind ?? 'standard',
        definition: body.definition ?? structuredClone(template.definition),
        templateKey: template?.key ?? null,
        note: body.note,
      });
      res.status(201).json({ data: presentFlow(flow, { unit }) });
    },
  );

  router.post(
    '/automations/validate',
    describe({ summary: 'Check a flow definition without saving it', permission: 'automations.view', description: 'Engine errors and warnings (paths under `body.definition`), the longest pause-free chain, and the action permissions you would be missing to save it.' }),
    requireAuth(),
    validate({ body: z.strictObject({ companyId: z.uuid(), unitId: z.uuid().optional(), name: optionalText(120), definition: definitionSchema }) }),
    async (req, res) => {
      const { companyId, unitId, name, definition } = req.valid.body;
      const company = await requireCompany(req, companyId, 'automations.view', { path: 'body.companyId' });
      const unit = unitId ? ((await unitsIndex(req)).get(unitId) ?? company) : company;
      const result = checkDefinition(definition, { key: 'draft-check', version: 1, name: name ?? (typeof definition.name === 'string' ? definition.name : 'Untitled flow') });
      res.json({
        data: {
          ok: result.ok,
          errors: engineFieldErrors(result.errors),
          warnings: engineFieldErrors(result.warnings ?? []),
          stats: result.stats ?? null,
          missingPermissions: result.ok ? missingActionPermissions(req, result.flow, unit) : [],
        },
      });
    },
  );

  const eventInput = z.strictObject({ type: z.string().max(100).optional(), payload: jsonObject.optional() });
  router.post(
    '/automations/simulate',
    describe({ summary: 'Test a flow against a sample or real deal (dry run)', permission: 'automations.view', description: 'Runs the engine with a virtual clock: waits are skipped, awaited actions and AI steps return sample output unless scripted in `results`, approvals default to approved. Nothing is sent or stored. A real deal (`dealId`) needs `deals.view` on it.' }),
    requireAuth(),
    validate({
      body: z.strictObject({
        companyId: z.uuid(),
        flowId: z.uuid().optional(),
        name: optionalText(120),
        definition: definitionSchema.optional(),
        dealId: z.uuid().optional(),
        dealRef: z.string().trim().min(1).max(40).optional(),
        /** Changes to the sample deal (status, stage, nurture...) when no real deal is picked. */
        sample: jsonObject.refine((o) => Buffer.byteLength(JSON.stringify(o)) <= 16 * 1024, 'Keep the sample small').optional(),
        event: eventInput.optional(),
        events: z
          .array(
            z.strictObject({
              after: z.string().regex(/^(\d+(ms|s|m|h|d|w))+$/, 'Use a duration like 2h').optional(),
              at: z.iso.datetime({ offset: true }).optional(),
              event: z.strictObject({ type: z.string().min(1).max(100), payload: jsonObject.optional() }),
            }),
          )
          .max(20)
          .optional(),
        results: z.record(z.string().max(48), z.unknown()).optional(),
        approvals: z
          .record(z.string().max(48), z.union([z.enum(['approved', 'rejected', 'timeout']), z.strictObject({ decision: z.enum(['approved', 'rejected']), data: jsonObject.optional() })]))
          .optional(),
        force: z.boolean().optional(),
      }),
    }),
    async (req, res) => {
      const body = req.valid.body;
      const company = await requireCompany(req, body.companyId, 'automations.view', { path: 'body.companyId' });
      let definition = body.definition;
      let name = body.name;
      let key;
      if (body.flowId) {
        const { flow } = await loadFlow(req, body.flowId);
        if (flow.company_id !== company.id) throw errors.validation([{ path: 'body.flowId', message: 'Flow not found in this company' }]);
        definition ??= flow.definition;
        name ??= flow.name;
        key = flow.key;
      }
      if (!definition) throw errors.validation([{ path: 'body.definition', message: 'Send the flow to test' }]);
      try {
        const result = await simulateFlow(req, { company, definition, name, key, dealId: body.dealId, dealRef: body.dealRef, sample: body.sample, event: body.event, events: body.events, results: body.results, approvals: body.approvals, force: body.force });
        res.json({ data: result });
      } catch (err) {
        if (err instanceof RangeError || (err?.name && /Error$/.test(err.name) && typeof err.code === 'string' && !err.status)) {
          throw errors.validation([{ path: 'body', message: err.message }]);
        }
        throw err;
      }
    },
  );

  router.get(
    '/automations/flows/:id',
    describe({ summary: 'Get a flow with its latest definition', permission: 'automations.view' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const { flow, unit } = await loadFlow(req, req.valid.params.id);
      const stats = await flowStats(db, [flow.id]);
      const canManage = req.access.can('automations.manage', unit.path);
      res.json({
        data: {
          ...presentFlow(flow, { unit, stats: stats.get(flow.id) ?? { activeRuns: 0, runsLast7Days: 0, failedLast7Days: 0 } }),
          canManage,
          missingPermissions: canManage ? missingActionPermissions(req, flow.definition, unit) : [],
        },
      });
    },
  );

  router.patch(
    '/automations/flows/:id',
    describe({ summary: 'Save a flow (a new definition is a new version)', permission: 'automations.manage', errors: [409], description: 'Send `baseVersion` (the version you edited) to get 409 instead of overwriting someone else\'s save. While the flow is active, new runs start on the new version; runs already going stay on theirs.' }),
    requireAuth(),
    validate({
      params: idParams,
      body: z
        .strictObject({
          name: optionalText(120),
          description: z.union([optionalText(2000), z.null()]),
          unitId: z.uuid().optional(),
          definition: definitionSchema.optional(),
          baseVersion: z.int().min(1).optional(),
          note: optionalText(300),
        })
        .partial(),
    }),
    async (req, res) => {
      const { flow, version } = await updateFlow(req, req.valid.params.id, req.valid.body);
      const index = await unitsIndex(req);
      res.json({ data: { ...presentFlow(flow, { unit: index.get(flow.unit_id) }), savedVersion: version ? version.version : null } });
    },
  );

  for (const [path, action, summary] of [
    ['activate', 'activate', 'Turn a flow on (its latest version)'],
    ['pause', 'pause', 'Pause a flow (its waiting runs hold until it is turned on again)'],
  ]) {
    router.post(
      `/automations/flows/:id/${path}`,
      describe({ summary, permission: 'automations.manage', errors: [409] }),
      requireAuth(),
      validate({ params: idParams }),
      async (req, res) => {
        const { flow } = await setFlowStatus(req, req.valid.params.id, action);
        const index = await unitsIndex(req);
        res.json({ data: presentFlow(flow, { unit: index.get(flow.unit_id) }) });
      },
    );
  }

  router.delete(
    '/automations/flows/:id',
    describe({ summary: 'Archive a flow and cancel its open runs', permission: 'automations.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const { flow, cancelledRuns } = await setFlowStatus(req, req.valid.params.id, 'archive');
      const index = await unitsIndex(req);
      res.json({ data: { ...presentFlow(flow, { unit: index.get(flow.unit_id), definition: false }), cancelledRuns } });
    },
  );

  router.get(
    '/automations/flows/:id/versions',
    describe({ summary: "List a flow's versions, newest first", permission: 'automations.view' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const { flow } = await loadFlow(req, req.valid.params.id);
      const rows = await db('automation_flow_versions as v')
        .leftJoin('users as u', 'u.id', 'v.created_by')
        .where('v.flow_id', flow.id)
        .orderBy('v.version', 'desc')
        .limit(200)
        .select('v.id', 'v.flow_id', 'v.version', 'v.trigger_type', 'v.note', 'v.warnings', 'v.stats', 'v.created_by', 'v.created_at', 'u.name as created_by_name');
      res.json({ data: rows.map((row) => ({ ...presentVersion(row, { definition: false }), active: row.version === flow.active_version })) });
    },
  );

  const versionParams = z.strictObject({ id: z.uuid(), version: z.coerce.number().int().min(1) });
  router.get(
    '/automations/flows/:id/versions/:version',
    describe({ summary: 'Get one version of a flow', permission: 'automations.view' }),
    requireAuth(),
    validate({ params: versionParams }),
    async (req, res) => {
      const { flow } = await loadFlow(req, req.valid.params.id);
      const row = await db('automation_flow_versions as v')
        .leftJoin('users as u', 'u.id', 'v.created_by')
        .where({ 'v.flow_id': flow.id, 'v.version': req.valid.params.version })
        .first('v.*', 'u.name as created_by_name');
      if (!row) throw errors.notFound('Version');
      res.json({ data: { ...presentVersion(row), active: row.version === flow.active_version } });
    },
  );

  router.post(
    '/automations/flows/:id/versions/:version/restore',
    describe({ summary: 'Restore an old version (saved as a new version)', permission: 'automations.manage', errors: [409] }),
    requireAuth(),
    validate({ params: versionParams, body: z.strictObject({ baseVersion: z.int().min(1).optional() }).optional() }),
    async (req, res) => {
      const { flow } = await loadFlow(req, req.valid.params.id, { write: true });
      const old = await db('automation_flow_versions').where({ flow_id: flow.id, version: req.valid.params.version }).first('definition', 'version');
      if (!old) throw errors.notFound('Version');
      const { flow: updated, version } = await updateFlow(req, flow.id, {
        definition: old.definition,
        name: old.definition.name,
        baseVersion: req.valid.body?.baseVersion,
        note: `Restored version ${old.version}`,
      });
      const index = await unitsIndex(req);
      res.json({ data: { ...presentFlow(updated, { unit: index.get(updated.unit_id) }), savedVersion: version ? version.version : null } });
    },
  );

  // ---------- Runs ----------

  router.get(
    '/automations/runs',
    describe({ summary: 'List automation runs in a working scope', permission: 'automations.view', list: true, description: 'Newest first. A run belongs to its subject\'s unit; deal refs and titles show only with `deals.view` on the deal.' }),
    requireAuth(),
    validate({
      query: z.strictObject({
        unitId: z.uuid(),
        flowId: z.uuid().optional(),
        dealId: z.uuid().optional(),
        status: z.enum(RUN_STATUSES).optional(),
        ...pageQuery,
      }),
    }),
    async (req, res) => {
      const { unitId, flowId, dealId, status, cursor, limit } = req.valid.query;
      const scope = await listScope(req, 'automations.view', { unitId });
      const after = decodeCursor(cursor);
      const query = db('automation_runs as r')
        .join('automation_flows as f', 'f.id', 'r.flow_id')
        .leftJoin('deals as d', 'd.id', 'r.deal_id')
        .modify((q) => {
          if (scope.company) q.where('r.company_id', scope.company.id);
          else q.where('r.group_id', scope.groupId);
          if (flowId) q.where('r.flow_id', flowId);
          if (dealId) q.where('r.deal_id', dealId);
          if (status) q.where('r.status', status);
          if (after) q.whereRaw('(r.started_at, r.id) < (?::timestamptz, ?::uuid)', [after.s, after.i]);
        })
        .where((w) => {
          if (scope.allUnitIds.length) w.whereIn('r.unit_id', scope.allUnitIds);
          else w.whereRaw('false');
        })
        .orderBy([{ column: 'r.started_at', order: 'desc' }, { column: 'r.id', order: 'desc' }])
        .limit(limit + 1);
      const rows = await runListColumns(query);
      const { page, nextCursor } = pageOf(rows, limit, (r) => ({ s: new Date(r.started_at).toISOString(), i: r.id }));
      const index = await unitsIndex(req);
      const userId = req.auth.user.id;
      res.json({ data: page.map((row) => presentRun(row, { canSeeDeal: dealVisibility(req.access, index, userId, row) })), nextCursor });
    },
  );

  async function loadVisibleRun(req, id) {
    const row = await db('automation_runs as r')
      .join('automation_flows as f', 'f.id', 'r.flow_id')
      .leftJoin('deals as d', 'd.id', 'r.deal_id')
      .where('r.id', id)
      .first(...runColumns, 'r.state', 'r.trigger', 'r.flow_version_id');
    if (!row) throw errors.notFound('Run');
    const index = await unitsIndex(req);
    if (!levelForRecord(req.access, index, 'automations.view', row, { userId: req.auth.user.id, ownerColumns: [] })) throw errors.notFound('Run');
    return { row, index };
  }

  router.get(
    '/automations/runs/:id',
    describe({ summary: 'Get a run with its step trace, effects and approvals', permission: 'automations.view' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const { row, index } = await loadVisibleRun(req, req.valid.params.id);
      const userId = req.auth.user.id;
      const [steps, effects, approvals, versions] = await Promise.all([
        db('automation_run_steps').where({ run_id: row.id }).orderBy('seq', 'desc').limit(LIMITS.traceRows),
        db('automation_effects').where({ run_id: row.id }).orderBy('created_at').limit(500),
        db('automation_approvals as a').leftJoin('users as u', 'u.id', 'a.decided_by').where('a.run_id', row.id).orderBy('a.created_at').select('a.*', 'u.name as decided_by_name'),
        loadVersions(db, [row.flow_version_id]),
      ]);
      const canSeeDeal = dealVisibility(req.access, index, userId, row);
      const unit = index.get(row.unit_id);
      res.json({
        data: {
          ...presentRun(row, { canSeeDeal }),
          trigger: canSeeDeal || !row.deal_id ? row.trigger : { id: row.trigger?.id ?? null, type: row.trigger?.type ?? null },
          steps: steps.reverse().map(presentRunStep),
          traceDropped: row.state?.traceDropped ?? 0,
          stepStates: row.state?.steps ?? {},
          effects: effects.map(presentEffect),
          approvals: approvals.map((a) => presentApproval(a, { canDecide: canDecideApproval(req.access, unit, a, userId), flowName: row.flow_name })),
          definition: versions.get(row.flow_version_id) ?? null,
          canCancel: ['running', 'waiting'].includes(row.status) && req.access.level('automations.manage', unit?.path ?? '-') === 'all',
        },
      });
    },
  );

  router.post(
    '/automations/runs/:id/cancel',
    describe({ summary: 'Cancel a run', permission: 'automations.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const { row, index } = await loadVisibleRun(req, req.valid.params.id);
      const unit = index.get(row.unit_id);
      if (req.access.level('automations.manage', unit.path) !== 'all') throw errors.forbidden();
      const changed = await db.transaction(async (trx) => {
        const locked = await trx('automation_runs').where({ id: row.id }).forUpdate().first();
        if (!['running', 'waiting'].includes(locked.status)) throw errors.conflict(`This run has already ${locked.status === 'cancelled' ? 'been cancelled' : locked.status}`);
        const out = await cancelLockedRun(trx, locked, { reason: 'cancelled_by_user' });
        await writeAudit(trx, req, {
          action: 'automation_run.cancelled',
          entityType: 'automation_run',
          entityId: row.id,
          unit: { id: row.unit_id, root_id: row.group_id },
          before: { status: locked.status },
          after: { status: 'cancelled' },
          meta: { flowId: row.flow_id },
        });
        return out.changed;
      });
      res.json({ data: { id: row.id, status: 'cancelled', changed } });
    },
  );

  // ---------- Approvals ----------

  router.get(
    '/automations/approvals',
    describe({ summary: 'The approvals queue in a working scope', permission: 'automations.approve', list: true, description: 'Pending by default. With `automations.approve:own`, only requests sent to you (as a listed approver or the record owner).' }),
    requireAuth(),
    validate({
      query: z.strictObject({
        unitId: z.uuid(),
        status: z.enum([...APPROVAL_STATUSES, 'decided', 'all']).default('pending'),
        flowId: z.uuid().optional(),
        ...pageQuery,
      }),
    }),
    async (req, res) => {
      const { unitId, status, flowId, cursor, limit } = req.valid.query;
      const scope = await listScope(req, 'automations.approve', { unitId });
      const userId = req.auth.user.id;
      const after = decodeCursor(cursor);
      const rows = await db('automation_approvals as a')
        .join('automation_flows as f', 'f.id', 'a.flow_id')
        .leftJoin('deals as d', 'd.id', 'a.deal_id')
        .leftJoin('users as u', 'u.id', 'a.decided_by')
        .modify((q) => {
          if (scope.company) q.where('a.company_id', scope.company.id);
          else q.where('a.group_id', scope.groupId);
          if (status === 'decided') q.whereIn('a.status', ['approved', 'rejected']);
          else if (status !== 'all') q.where('a.status', status);
          if (flowId) q.where('a.flow_id', flowId);
          if (after) q.whereRaw('(a.created_at, a.id) < (?::timestamptz, ?::uuid)', [after.s, after.i]);
        })
        .where((w) => {
          if (scope.allUnitIds.length) w.orWhereIn('a.unit_id', scope.allUnitIds);
          if (scope.ownUnitIds.length) {
            w.orWhere((own) =>
              own.whereIn('a.unit_id', scope.ownUnitIds).andWhere((who) => who.where('a.owner_user_id', userId).orWhereRaw('?::uuid = any(a.approver_user_ids)', [userId])),
            );
          }
          if (!scope.allUnitIds.length && !scope.ownUnitIds.length) w.whereRaw('false');
        })
        .orderBy([{ column: 'a.created_at', order: 'desc' }, { column: 'a.id', order: 'desc' }])
        .limit(limit + 1)
        .select('a.*', 'f.name as flow_name', 'u.name as decided_by_name', 'd.ref as deal_ref', 'd.title as deal_title', 'd.unit_id as deal_unit_id', 'd.owner_user_id as deal_owner_user_id');
      const { page, nextCursor } = pageOf(rows, limit, (r) => ({ s: new Date(r.created_at).toISOString(), i: r.id }));
      const index = await unitsIndex(req);
      res.json({
        data: page.map((row) => {
          const unit = index.get(row.unit_id);
          const canSeeDeal = dealVisibility(req.access, index, userId, row);
          return presentApproval(row, { canDecide: canDecideApproval(req.access, unit, row, userId), subjectLabel: canSeeDeal ? [row.deal_ref, row.deal_title].filter(Boolean).join(' · ') : null });
        }),
        nextCursor,
      });
    },
  );

  router.get(
    '/automations/approvals/:id',
    describe({ summary: 'Get an approval request', permission: 'automations.approve' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      const row = await db('automation_approvals as a')
        .join('automation_flows as f', 'f.id', 'a.flow_id')
        .leftJoin('deals as d', 'd.id', 'a.deal_id')
        .leftJoin('users as u', 'u.id', 'a.decided_by')
        .where('a.id', req.valid.params.id)
        .first('a.*', 'f.name as flow_name', 'u.name as decided_by_name', 'd.ref as deal_ref', 'd.title as deal_title', 'd.unit_id as deal_unit_id', 'd.owner_user_id as deal_owner_user_id');
      const index = await unitsIndex(req);
      const userId = req.auth.user.id;
      const unit = row ? index.get(row.unit_id) : null;
      if (!row || !canSeeApproval(req.access, unit, row, userId)) throw errors.notFound('Approval');
      const canSeeDeal = dealVisibility(req.access, index, userId, row);
      res.json({ data: presentApproval(row, { canDecide: canDecideApproval(req.access, unit, row, userId), subjectLabel: canSeeDeal ? [row.deal_ref, row.deal_title].filter(Boolean).join(' · ') : null }) });
    },
  );

  const decisionBody = { comment: optionalText(1000) };
  for (const [path, decision, summary] of [
    ['approve', 'approved', 'Approve a request (optionally with edits) and resume its run'],
    ['reject', 'rejected', 'Reject a request and resume its run on the reject path'],
  ]) {
    router.post(
      `/automations/approvals/:id/${path}`,
      describe({ summary, permission: 'automations.approve', errors: [409], description: decision === 'approved' ? '`data` edits fields the flow proposed (e.g. `{ draft }`); unknown fields are refused. Later steps read the edited values from `steps.<id>.output.data`.' : undefined }),
      requireAuth(),
      validate({
        params: idParams,
        body: decision === 'approved' ? z.strictObject({ ...decisionBody, data: jsonObject.optional() }).optional() : z.strictObject(decisionBody).optional(),
      }),
      async (req, res) => {
        const body = req.valid.body ?? {};
        const { approval, runStatus } = await decideApproval(req, req.valid.params.id, { decision, data: body.data, comment: body.comment ?? null });
        const index = await unitsIndex(req);
        res.json({ data: { ...presentApproval(approval, { canDecide: false }), runStatus, unitName: index.get(approval.unit_id)?.name ?? null } });
      },
    );
  }

  // ---------- Development only ----------

  router.post(
    '/automations/tick',
    describe({ summary: 'Advance due runs now (development only)', permission: 'automations.manage', description: 'Runs the scheduler job `automations.tick` once. Answers 404 in production, where the jobs framework runs it every minute.' }),
    requireAuth(),
    async (req, res) => {
      if (env.isProd) throw errors.notFound('Route');
      requireAnywhere(req, 'automations.manage');
      res.json({ data: await tick(db) });
    },
  );
}
