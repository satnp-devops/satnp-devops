import { db as defaultDb, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { slugify } from '../../lib/text.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { companyOf, unitsIndex } from '../../core/crm/scope.js';
import { nextScheduleFire, validateFlow } from '../../core/automation/index.js';
import { requiredPermissions } from './actions.js';
import { LIMITS } from './constants.js';
import { getAutomationRegistry } from './registry.js';
import { cancelLockedRun } from './runner.js';

/**
 * Flows and their versions. A flow belongs to a company (configuration, PHASE2_CONTRACT §4.1 rule 6)
 * and applies to subjects at its unit or below (the company by default, or a branch or team).
 *
 *   read   automations.view at, above or anywhere inside the company (else 404)
 *   write  automations.manage at the flow's unit (company admins: every flow of the company)
 *   + the permission of every action the flow performs, at the "all" level at the flow's unit
 *     (actions.js ACTION_PERMISSIONS): nobody makes a flow do what they couldn't do themselves.
 *
 * Every save of a definition is a new immutable version (validated by the engine; invalid
 * definitions are refused with the engine's errors mapped to field paths). While a flow is active
 * its active version follows saves; runs already going stay on the version they started on.
 */

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

/** JSON with sorted keys (jsonb reorders keys, so plain JSON.stringify can't compare stored and new definitions). */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------- Validation ----------

/** The engine's flow object for a definition from the editor (key, version and name are the flow's). */
export function buildFlow(definition, { key, version, name }) {
  const { key: _k, version: _v, name: _n, ...rest } = definition ?? {};
  return { key, version, name, ...rest };
}

/** Engine errors → API field errors (paths under `prefix`, codes and step ids kept for the editor). */
export function engineFieldErrors(list, prefix = 'body.definition') {
  return list.map((e) => ({
    path: [prefix, ...(e.path ?? [])].join('.'),
    message: e.message,
    code: e.code,
    ...(e.stepId ? { stepId: e.stepId } : {}),
  }));
}

/** Validate a definition against the live registry. @returns engine result */
export function checkDefinition(definition, meta) {
  return validateFlow(buildFlow(definition, meta), getAutomationRegistry());
}

/**
 * Permissions the person lacks for the actions in a definition, at the flow's unit.
 * @returns {{ permission: string, stepIds: string[] }[]}
 */
export function missingActionPermissions(req, definition, unit) {
  const needed = requiredPermissions(definition, req.app.locals.registry);
  const missing = [];
  for (const [permission, stepIds] of needed) {
    if (req.access.level(permission, unit.path) !== 'all') missing.push({ permission, stepIds });
  }
  return missing;
}

function assertActionPermissions(req, definition, unit) {
  const missing = missingActionPermissions(req, definition, unit);
  if (missing.length === 0) return;
  throw errors.forbidden(
    `You need ${missing.map((m) => m.permission).join(', ')} at ${unit.name} to use ${missing.flatMap((m) => m.stepIds).join(', ')} in a flow`,
  );
}

const LITERAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literalId = (value) => (typeof value === 'string' && LITERAL_ID.test(value) ? value : null);

/**
 * The people, teams and pipelines a flow names by id must belong to its company: flows run as the
 * system, so a Pi Vector flow must never assign Pi Vector leads to a SatnPaper person or team, or
 * move them into a SatnPaper pipeline. Values computed at run time ({ $expr }) are checked by the
 * executors. Also re-run on activation, as people leave companies. 422 with the step's field path.
 * @param {import('knex').Knex} trx
 * @param {{ steps?: object[] }} definition
 * @param {{ id: string, path: string, root_id: string }} company
 */
export async function assertFlowReferences(trx, definition, company) {
  const people = [];
  const teams = [];
  const pipelines = [];
  const connections = [];
  (definition?.steps ?? []).forEach((step, index) => {
    const at = (key) => `body.definition.steps.${index}.${key}`;
    const params = step.params ?? {};
    // A webhook step signs with an integration connection's secret: only one the company uses.
    if (step.type === 'action' && step.action === 'http.call_webhook' && literalId(params.connectionId)) connections.push([params.connectionId, at('params.connectionId')]);
    if (step.type === 'action' && step.action === 'tasks.create' && literalId(params.assignee)) people.push([params.assignee, at('params.assignee')]);
    if (step.type === 'action' && step.action === 'records.assign') {
      if (literalId(params.userId)) people.push([params.userId, at('params.userId')]);
      if (literalId(params.teamUnitId)) teams.push([params.teamUnitId, at('params.teamUnitId')]);
    }
    if (step.type === 'action' && step.action === 'deals.change_stage' && literalId(params.pipelineId)) pipelines.push([params.pipelineId, at('params.pipelineId')]);
    if (step.type === 'approval') (step.approvers?.userIds ?? []).forEach((id, i) => people.push([id, at(`approvers.userIds.${i}`)]));
  });
  const issues = [];
  if (people.length) {
    // Someone works for the company when they hold an active role at it, inside it, or above it (the group).
    const ids = [...new Set(people.map(([id]) => id))];
    const rows = await trx('role_assignments as ra')
      .join('org_units as o', 'o.id', 'ra.org_unit_id')
      .join('users as u', 'u.id', 'ra.user_id')
      .whereIn('ra.user_id', ids)
      .where('u.status', 'active')
      .where('o.status', 'active')
      .where('o.root_id', company.root_id)
      .select('ra.user_id', 'o.path');
    const works = new Set(rows.filter((r) => r.path.startsWith(company.path) || company.path.startsWith(r.path)).map((r) => r.user_id));
    for (const [id, path] of people) if (!works.has(id)) issues.push({ path, message: "This person doesn't work for this company" });
  }
  if (teams.length) {
    const inside = new Set(
      await trx('org_units').whereIn('id', teams.map(([id]) => id)).where('root_id', company.root_id).where('path', 'like', `${company.path}%`).pluck('id'),
    );
    for (const [id, path] of teams) if (!inside.has(id)) issues.push({ path, message: 'Pick a team of this company' });
  }
  if (pipelines.length) {
    const own = new Set(await trx('pipelines').whereIn('id', pipelines.map(([id]) => id)).where('company_id', company.id).pluck('id'));
    for (const [id, path] of pipelines) if (!own.has(id)) issues.push({ path, message: 'Pick a pipeline of this company' });
  }
  if (connections.length) {
    const linked = new Set(
      await trx('integration_connection_companies as l')
        .join('integration_connections as c', 'c.id', 'l.connection_id')
        .whereIn('l.connection_id', connections.map(([id]) => id))
        .where('l.company_id', company.id)
        .whereNull('c.disconnected_at')
        .pluck('l.connection_id'),
    );
    for (const [id, path] of connections) if (!linked.has(id)) issues.push({ path, message: 'Pick a connection of this company' });
  }
  if (issues.length) throw errors.validation(issues, 'The flow names people, teams, pipelines or connections outside its company');
}

function assertValid(result) {
  if (!result.ok) throw errors.validation(engineFieldErrors(result.errors), 'The flow has problems to fix before it can be saved');
}

// ---------- Scope ----------

/**
 * Load a flow the person may read (404 otherwise); with `write`, also check automations.manage at
 * the flow's unit (403 when visible but not allowed).
 * @returns {Promise<{ flow: object, company: object, unit: object }>}
 */
export async function loadFlow(req, id, { write = false, trx = defaultDb, forUpdate = false } = {}) {
  const query = trx('automation_flows').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const flow = await query;
  if (!flow) throw errors.notFound('Flow');
  const index = await unitsIndex(req, trx);
  const company = index.get(flow.company_id);
  const unit = index.get(flow.unit_id);
  if (!company || !unit || !req.access.canSee(company.path) || !req.access.canAnywhereWithin('automations.view', company.path)) {
    throw errors.notFound('Flow');
  }
  if (write && !req.access.can('automations.manage', unit.path)) throw errors.forbidden();
  return { flow, company, unit };
}

/**
 * The unit a new flow applies to: the company itself, or a unit inside it the person can manage.
 * @returns {Promise<{ company: object, unit: object }>}
 */
export async function requireFlowUnit(req, companyId, unitId, { trx = defaultDb } = {}) {
  const index = await unitsIndex(req, trx);
  const company = index.get(companyId);
  if (!company || !req.access.canSee(company.path)) throw errors.notFound('Company');
  if (company.type !== 'company') throw errors.validation([{ path: 'body.companyId', message: 'Pick a company' }]);
  const unit = unitId ? index.get(unitId) : company;
  if (!unit || !req.access.canSee(unit.path)) throw errors.validation([{ path: 'body.unitId', message: 'Unit not found' }]);
  if (companyOf(unit, index)?.id !== company.id) throw errors.validation([{ path: 'body.unitId', message: 'Pick a unit inside this company' }]);
  if (unit.status !== 'active') throw errors.conflict(`${unit.name} is archived`);
  if (!req.access.can('automations.manage', unit.path)) throw errors.forbidden();
  return { company, unit };
}

// ---------- Presenters ----------

/** types.ts AutomationFlow */
export function presentFlow(row, { unit, stats, definition = true } = {}) {
  return {
    id: row.id,
    companyId: row.company_id,
    unitId: row.unit_id,
    unitName: unit?.name ?? null,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    kind: row.kind,
    status: row.status,
    triggerType: row.trigger_type,
    version: row.version,
    activeVersion: row.active_version ?? null,
    templateKey: row.template_key ?? null,
    nextFireAt: iso(row.next_fire_at),
    stepCount: Array.isArray(row.definition?.steps) ? row.definition.steps.length : 0,
    ...(definition ? { definition: row.definition } : {}),
    stats: stats ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    activatedAt: iso(row.activated_at),
    pausedAt: iso(row.paused_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** types.ts AutomationFlowVersion */
export function presentVersion(row, { definition = true } = {}) {
  return {
    id: row.id,
    flowId: row.flow_id,
    version: row.version,
    triggerType: row.trigger_type,
    note: row.note ?? null,
    warnings: row.warnings ?? [],
    stats: row.stats ?? {},
    ...(definition ? { definition: row.definition } : {}),
    createdBy: row.created_by ? { id: row.created_by, name: row.created_by_name ?? null } : null,
    createdAt: iso(row.created_at),
  };
}

/** Run counts per flow in one query: { active, last7d, failed7d }. */
export async function flowStats(trx, flowIds, now = Date.now()) {
  if (flowIds.length === 0) return new Map();
  const since = new Date(now - 7 * 86_400_000);
  const rows = await trx('automation_runs')
    .whereIn('flow_id', flowIds)
    .groupBy('flow_id')
    .select(
      'flow_id',
      trx.raw("count(*) filter (where status in ('running', 'waiting'))::int as active"),
      trx.raw('count(*) filter (where started_at >= ?)::int as last7d', [since]),
      trx.raw("count(*) filter (where status = 'failed' and started_at >= ?)::int as failed7d", [since]),
    );
  return new Map(rows.map((r) => [r.flow_id, { activeRuns: r.active, runsLast7Days: r.last7d, failedLast7Days: r.failed7d }]));
}

// ---------- Writes ----------

async function uniqueKey(trx, companyId, wanted) {
  const base = (slugify(wanted) || 'flow').slice(0, 56).replace(/^[^a-z]+/, '') || 'flow';
  const root = base.length >= 2 ? base : `flow-${base}`;
  const taken = new Set(
    await trx('automation_flows').where({ company_id: companyId }).whereRaw('key like ?', [`${root}%`]).pluck('key'),
  );
  if (!taken.has(root)) return root;
  for (let i = 2; i < 1000; i += 1) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
  throw errors.conflict('Too many flows with this name');
}

/** Columns that follow the trigger (schedule firing, no-activity cursor) when a flow becomes active. */
function triggerColumns(definition, now) {
  if (definition.trigger.type === 'schedule') {
    return { next_fire_at: new Date(nextScheduleFire(definition.trigger.config ?? {}, now)), trigger_state: json({}) };
  }
  return { next_fire_at: null, trigger_state: json({}) };
}

async function insertVersion(trx, flow, result, { userId, note }) {
  const [version] = await trx('automation_flow_versions')
    .insert({
      flow_id: flow.id,
      company_id: flow.company_id,
      version: result.flow.version,
      trigger_type: result.flow.trigger.type,
      definition: json(result.flow),
      warnings: json(result.warnings ?? []),
      stats: json(result.stats ?? {}),
      note: note ?? null,
      created_by: userId,
    })
    .returning('*');
  return version;
}

const auditUnit = (unit) => ({ id: unit.id, root_id: unit.root_id });

/**
 * Create a flow (draft) from a definition. @returns {Promise<object>} the flow row
 * @param {{ company: object, unit: object, name: string, description?: string, kind: string, definition: object, templateKey?: string | null, note?: string }} input
 */
export async function createFlow(req, input, { trx: outer = defaultDb, now = Date.now(), userId = req.auth.user.id } = {}) {
  const { company, unit } = input;
  assertActionPermissions(req, input.definition, unit);
  return outer.transaction(async (trx) => {
    const count = await trx('automation_flows').where({ company_id: company.id }).whereNot('status', 'archived').count({ n: '*' }).first();
    if (Number(count?.n ?? 0) >= LIMITS.flowsPerCompany) throw errors.conflict(`A company can have up to ${LIMITS.flowsPerCompany} flows`);
    const key = await uniqueKey(trx, company.id, input.name);
    const result = checkDefinition(input.definition, { key, version: 1, name: input.name });
    assertValid(result);
    await assertFlowReferences(trx, result.flow, company);
    const [flow] = await trx('automation_flows')
      .insert({
        group_id: company.root_id,
        company_id: company.id,
        unit_id: unit.id,
        key,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        status: 'draft',
        trigger_type: result.flow.trigger.type,
        version: 1,
        active_version: null,
        definition: json(result.flow),
        template_key: input.templateKey ?? null,
        created_by: userId,
        updated_by: userId,
        created_at: new Date(now),
        updated_at: new Date(now),
      })
      .returning('*');
    await insertVersion(trx, flow, result, { userId, note: input.note ?? (input.templateKey ? `From template ${input.templateKey}` : null) });
    await writeAudit(trx, req, {
      action: 'automation_flow.created',
      entityType: 'automation_flow',
      entityId: flow.id,
      unit: auditUnit(unit),
      after: { name: flow.name, key, kind: flow.kind, trigger: flow.trigger_type, templateKey: flow.template_key },
    });
    await emitEvent(trx, {
      type: 'automation.flow_created',
      groupId: company.root_id,
      unitId: unit.id,
      aggregateType: 'automation_flow',
      aggregateId: flow.id,
      actorUserId: userId,
      payload: { flowId: flow.id, companyId: company.id, key, kind: flow.kind, triggerType: flow.trigger_type },
    });
    return flow;
  });
}

/**
 * Save changes. A new definition (or name) is a new version; `baseVersion` guards against two
 * editors overwriting each other (409). Moving the flow to another unit needs manage there too.
 */
export async function updateFlow(req, id, body, { now = Date.now() } = {}) {
  const userId = req.auth.user.id;
  return defaultDb.transaction(async (trx) => {
    const { flow, company, unit: currentUnit } = await loadFlow(req, id, { write: true, trx, forUpdate: true });
    if (flow.status === 'archived') throw errors.conflict('This flow is archived');
    if (body.baseVersion !== undefined && body.baseVersion !== flow.version) {
      throw errors.conflict(`Someone saved version ${flow.version} while you were editing. Reload to see it.`, { currentVersion: flow.version });
    }
    let unit = currentUnit;
    if (body.unitId && body.unitId !== flow.unit_id) {
      ({ unit } = await requireFlowUnit(req, flow.company_id, body.unitId, { trx }));
    }
    const name = body.name ?? flow.name;
    const changes = {};
    let version = null;
    const definitionInput = body.definition ?? (name !== flow.name ? flow.definition : null);
    if (definitionInput) {
      const result = checkDefinition(definitionInput, { key: flow.key, version: flow.version + 1, name });
      assertValid(result);
      const same = stableJson({ ...result.flow, version: flow.version }) === stableJson(flow.definition);
      if (!same) {
        assertActionPermissions(req, result.flow, unit);
        await assertFlowReferences(trx, result.flow, company);
        version = await insertVersion(trx, flow, result, { userId, note: body.note });
        Object.assign(changes, {
          version: result.flow.version,
          definition: json(result.flow),
          trigger_type: result.flow.trigger.type,
          name,
          ...(flow.status === 'active' ? { active_version: result.flow.version, ...triggerChange(flow, result.flow, now) } : {}),
        });
      }
    }
    if (body.description !== undefined && (body.description ?? null) !== flow.description) changes.description = body.description ?? null;
    if (unit.id !== flow.unit_id) {
      assertActionPermissions(req, changes.definition ? JSON.parse(changes.definition) : flow.definition, unit);
      changes.unit_id = unit.id;
    }
    if (Object.keys(changes).length === 0) return { flow, version: null, changed: false };
    const [updated] = await trx('automation_flows')
      .where({ id: flow.id })
      .update({ ...changes, updated_by: userId, updated_at: new Date(now) })
      .returning('*');
    await writeAudit(trx, req, {
      action: 'automation_flow.updated',
      entityType: 'automation_flow',
      entityId: flow.id,
      unit: auditUnit(unit),
      before: { name: flow.name, version: flow.version, unitId: flow.unit_id, description: flow.description },
      after: { name: updated.name, version: updated.version, unitId: updated.unit_id, description: updated.description },
    });
    await emitEvent(trx, {
      type: 'automation.flow_updated',
      groupId: updated.group_id,
      unitId: updated.unit_id,
      aggregateType: 'automation_flow',
      aggregateId: flow.id,
      actorUserId: userId,
      payload: { flowId: flow.id, companyId: flow.company_id, version: updated.version, changes: Object.keys(changes) },
    });
    return { flow: updated, version, changed: true };
  });
}

/** A saved trigger change on an active flow resets its schedule / scan state. */
function triggerChange(flow, definition, now) {
  return stableJson(flow.definition?.trigger ?? null) === stableJson(definition.trigger) ? {} : triggerColumns(definition, now);
}

/**
 * activate | pause | archive. Activation re-validates the latest version against today's registry
 * (a module may have gone) and the author's permissions. Archiving cancels the flow's open runs.
 */
export async function setFlowStatus(req, id, action, { now = Date.now() } = {}) {
  const userId = req.auth.user.id;
  return defaultDb.transaction(async (trx) => {
    const { flow, company, unit } = await loadFlow(req, id, { write: true, trx, forUpdate: true });
    if (flow.status === 'archived') throw errors.conflict('This flow is archived');
    const changes = {};
    let cancelled = 0;
    if (action === 'activate') {
      if (flow.status === 'active') return { flow, changed: false };
      const result = checkDefinition(flow.definition, { key: flow.key, version: flow.version, name: flow.name });
      if (!result.ok) throw errors.validation(engineFieldErrors(result.errors), 'Fix the problems in this flow before turning it on');
      assertActionPermissions(req, flow.definition, unit);
      await assertFlowReferences(trx, flow.definition, company);
      Object.assign(changes, {
        status: 'active',
        active_version: flow.version,
        activated_at: new Date(now),
        paused_at: null,
        ...(flow.status === 'paused' && flow.active_version === flow.version ? {} : triggerColumns(flow.definition, now)),
      });
      if (flow.definition.trigger.type === 'schedule' && !changes.next_fire_at) {
        changes.next_fire_at = new Date(nextScheduleFire(flow.definition.trigger.config ?? {}, now));
      }
    } else if (action === 'pause') {
      if (flow.status !== 'active') throw errors.conflict('Only an active flow can be paused');
      Object.assign(changes, { status: 'paused', paused_at: new Date(now) });
    } else if (action === 'archive') {
      Object.assign(changes, { status: 'archived', archived_at: new Date(now), next_fire_at: null });
      const open = await trx('automation_runs').where({ flow_id: flow.id }).whereIn('status', ['running', 'waiting']).forUpdate().limit(5000);
      for (const run of open) {
        const out = await cancelLockedRun(trx, run, { reason: 'flow_archived', now });
        if (out.changed) cancelled += 1;
      }
    } else {
      throw errors.badRequest('Unknown action');
    }
    const [updated] = await trx('automation_flows')
      .where({ id: flow.id })
      .update({ ...changes, updated_by: userId, updated_at: new Date(now) })
      .returning('*');
    const verb = { activate: 'activated', pause: 'paused', archive: 'archived' }[action];
    await writeAudit(trx, req, {
      action: `automation_flow.${verb}`,
      entityType: 'automation_flow',
      entityId: flow.id,
      unit: auditUnit(unit),
      before: { status: flow.status, activeVersion: flow.active_version },
      after: { status: updated.status, activeVersion: updated.active_version },
      meta: action === 'archive' ? { cancelledRuns: cancelled } : undefined,
    });
    await emitEvent(trx, {
      type: `automation.flow_${verb}`,
      groupId: updated.group_id,
      unitId: updated.unit_id,
      aggregateType: 'automation_flow',
      aggregateId: flow.id,
      actorUserId: userId,
      payload: { flowId: flow.id, companyId: flow.company_id, version: updated.active_version ?? updated.version, ...(action === 'archive' ? { cancelledRuns: cancelled } : {}) },
    });
    return { flow: updated, changed: true, cancelledRuns: cancelled };
  });
}

