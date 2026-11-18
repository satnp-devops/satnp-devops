import { z } from 'zod';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { toFieldErrors } from '../../lib/validate.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { applyListScope, canViewPiiAt, levelForRecord, listScope, requireCompany, unitsIndex } from '../../core/crm/scope.js';
import { AGENT_LIST, HANDOVER_TOPICS, getAgent, loadAiSettings, runAgent, usageFor } from '../../core/ai/index.js';
import { jsonSchemaFor } from '../../core/ai/prompt.js';
import { restoreMasked } from '../../core/ai/text.js';
import { getAdapter } from '../../integrations/index.js';
import { GENERIC_TASKS, agentLabel, presentAction } from './present.js';

const VIEW = 'ai.view';
const REVIEW = 'ai.review';
const MANAGE = 'ai.manage';

// ---------- Catalogue and configuration ----------

export function agentCatalog() {
  return {
    agents: AGENT_LIST.map((agent) => ({
      key: agent.key,
      label: agent.label,
      description: agent.description,
      task: agent.task,
      defaultThreshold: agent.defaultThreshold,
      alwaysReview: agent.alwaysReview,
      customerFacing: agent.customerFacing,
      inputSchema: z.toJSONSchema(agent.inputSchema, { io: 'input' }),
      outputSchema: jsonSchemaFor(agent.outputSchema),
      sample: agent.sample,
    })),
    handoverTopics: HANDOVER_TOPICS.map((t) => ({ key: t.key, label: t.label })),
    genericTasks: GENERIC_TASKS,
  };
}

/** The company's effective guardrails, this month's usage and the AI connection in use. */
export async function companyConfig(req, companyId) {
  const company = await requireCompany(req, companyId, VIEW, { path: 'query.companyId' });
  const [settings, usage] = await Promise.all([loadAiSettings(company), usageFor(company.id)]);
  let connection = null;
  let connectionProblem = null;
  try {
    const adapter = await getAdapter({ companyId: company.id, kind: 'ai' });
    connection = { name: adapter.connection.name, provider: adapter.connection.provider, mock: Boolean(adapter.mock), fallback: Boolean(adapter.connection.fallback) };
  } catch (error) {
    connectionProblem = error.message ?? 'No AI connection';
  }
  return {
    company: { id: company.id, name: company.name },
    settings,
    usage,
    connection,
    connectionProblem,
    canEditSettings: req.access.can('settings.manage', company.path),
    canTest: req.access.can(MANAGE, company.path),
    canEditKnowledge: req.access.can('ai.knowledge', company.path),
  };
}

/** The agent test panel: a dry run (nothing logged, tokens still counted), audited. */
export async function testAgent(req, { companyId, agent, input }) {
  const company = await requireCompany(req, companyId, MANAGE, { write: true, path: 'body.companyId' });
  if (!getAgent(agent)) throw errors.validation([{ path: 'body.agent', message: 'Unknown agent' }]);
  let result;
  try {
    result = await runAgent({ companyId: company.id, agent, input, dryRun: true, trigger: 'test', actorUserId: req.auth.user.id, log: req.log });
  } catch (error) {
    if (error.code === 'validation_failed' && Array.isArray(error.details)) {
      error.details = error.details.map((d) => ({ ...d, path: d.path.startsWith('input') ? `body.${d.path}` : d.path }));
    }
    throw error;
  }
  await db.transaction((trx) =>
    writeAudit(trx, req, {
      unit: company,
      action: 'ai.test_run',
      entityType: 'ai_agent',
      entityId: agent,
      meta: { status: result.status, provider: result.provider, model: result.model, mock: result.mock, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    }),
  );
  const { actionId: _actionId, agent: _agent, companyId: _companyId, finalOutput: _final, reused: _reused, logged: _logged, ...rest } = result;
  return rest;
}

// ---------- The log and the review queue ----------

const LIST_COLUMNS = [
  'a.id',
  'a.group_id',
  'a.company_id',
  'a.unit_id',
  'a.agent',
  'a.trigger',
  'a.reference',
  'a.deal_id',
  'a.contact_id',
  'a.account_id',
  'a.owner_user_id',
  'a.status',
  'a.input_summary',
  'a.output',
  'a.final_output',
  'a.confidence',
  'a.threshold',
  'a.guardrails',
  'a.review_reasons',
  'a.provider',
  'a.model',
  'a.mock',
  'a.input_tokens',
  'a.output_tokens',
  'a.latency_ms',
  'a.attempts',
  'a.error_code',
  'a.error_message',
  'a.reviewer_user_id',
  'a.reviewed_at',
  'a.review_note',
  'a.created_at',
  'a.updated_at',
  'cu.name as company_name',
  'd.ref as deal_ref',
  'd.title as deal_title',
  'c.display_name as contact_name',
  'ac.name as account_name',
  'r.name as reviewer_name',
];

/** ai_actions with the names a list shows, in one query. */
const actionQuery = (trx = db) =>
  trx('ai_actions as a')
    .join('org_units as cu', 'cu.id', 'a.company_id')
    .leftJoin('deals as d', 'd.id', 'a.deal_id')
    .leftJoin('contacts as c', 'c.id', 'a.contact_id')
    .leftJoin('accounts as ac', 'ac.id', 'a.account_id')
    .leftJoin('users as r', 'r.id', 'a.reviewer_user_id');

const scopeOptions = { unitColumn: 'a.unit_id', ownerColumns: ['a.owner_user_id'], companyColumn: 'a.company_id', groupColumn: 'a.group_id' };

function presenter(req, index) {
  const userId = req.auth.user.id;
  return (row, extra = {}) =>
    presentAction(row, {
      canViewPii: canViewPiiAt(req.access, index, [row.unit_id]),
      canReview: Boolean(levelForRecord(req.access, index, REVIEW, row, { userId, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] })),
      ...extra,
    });
}

const cursorOf = (row) => ({ t: new Date(row.created_at).toISOString(), id: row.id });

function applyFilters(query, filters) {
  if (filters.agent) query.where('a.agent', filters.agent);
  if (filters.status) query.where('a.status', filters.status);
  if (filters.trigger) query.where('a.trigger', filters.trigger);
  if (filters.dealId) query.where('a.deal_id', filters.dealId);
  if (filters.contactId) query.where('a.contact_id', filters.contactId);
  if (filters.accountId) query.where('a.account_id', filters.accountId);
  return query;
}

/** The AI log in the working scope, newest first. */
export async function listActions(req, filters) {
  const scope = await listScope(req, VIEW, { unitId: filters.unitId });
  const cursor = decodeCursor(filters.cursor);
  const query = applyFilters(applyListScope(actionQuery(), scope, scopeOptions), filters);
  if (cursor) query.whereRaw('(a.created_at, a.id) < (?::timestamptz, ?::uuid)', [cursor.t, cursor.id]);
  const rows = await query
    .orderBy([{ column: 'a.created_at', order: 'desc' }, { column: 'a.id', order: 'desc' }])
    .limit(filters.limit + 1)
    .select(LIST_COLUMNS);
  const { page, nextCursor } = pageOf(rows, filters.limit, cursorOf);
  const present = presenter(req, await unitsIndex(req));
  return { data: page.map((row) => present(row)), nextCursor };
}

/** Outputs waiting for a person, oldest first. "own" reviewers see the ones on their own records. */
export async function listReviews(req, filters) {
  const scope = await listScope(req, REVIEW, { unitId: filters.unitId });
  const cursor = decodeCursor(filters.cursor);
  const query = applyFilters(applyListScope(actionQuery(), scope, scopeOptions), { agent: filters.agent }).where('a.status', 'pending_review');
  if (cursor) query.whereRaw('(a.created_at, a.id) > (?::timestamptz, ?::uuid)', [cursor.t, cursor.id]);
  const rows = await query.orderBy([{ column: 'a.created_at' }, { column: 'a.id' }]).limit(filters.limit + 1).select(LIST_COLUMNS);
  const { page, nextCursor } = pageOf(rows, filters.limit, cursorOf);
  const present = presenter(req, await unitsIndex(req));
  return { data: page.map((row) => present(row)), nextCursor };
}

export async function reviewSummary(req, { unitId }) {
  const scope = await listScope(req, REVIEW, { unitId });
  const rows = await applyListScope(db('ai_actions as a'), scope, scopeOptions)
    .where('a.status', 'pending_review')
    .groupBy('a.agent')
    .select('a.agent', db.raw('count(*)::int as count'), db.raw('min(a.created_at) as oldest'));
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r.count]));
  const oldest = rows.map((r) => r.oldest).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0];
  return { pending: rows.reduce((sum, r) => sum + r.count, 0), byAgent, oldestAt: oldest ? new Date(oldest).toISOString() : null };
}

/** One action the user may see (ai.view or ai.review on it), or 404. */
async function loadAction(req, id, trx = db, { forUpdate = false } = {}) {
  const query = actionQuery(trx).where('a.id', id).first(['a.*', ...LIST_COLUMNS.filter((c) => !c.startsWith('a.'))]);
  if (forUpdate) query.forUpdate('a');
  const row = await query;
  if (!row) throw errors.notFound('AI action');
  const index = await unitsIndex(req, trx);
  const options = { userId: req.auth.user.id, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] };
  const viewLevel = levelForRecord(req.access, index, VIEW, row, options);
  const reviewLevel = levelForRecord(req.access, index, REVIEW, row, options);
  if (!viewLevel && !reviewLevel) throw errors.notFound('AI action');
  return { row, index, reviewLevel, canViewPii: canViewPiiAt(req.access, index, [row.unit_id]) };
}

export async function getAction(req, id) {
  const { row, index } = await loadAction(req, id);
  const action = presenter(req, index)(row, { withInput: true });
  return { ...action, names: await namesFor(req, index, [row.input, row.output, row.final_output]) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uuid-looking string inside a JSON value (at most `max`). */
function collectIds(value, into, max = 200) {
  if (into.size >= max || value === null || value === undefined) return into;
  if (typeof value === 'string') {
    if (UUID.test(value)) into.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into, max);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectIds(item, into, max);
  }
  return into;
}

/**
 * Names for the ids an AI input or output mentions (companies, teams, product lines, products),
 * so the review screen can show "SatnPaper" instead of a uuid. Only units the user can see, and
 * product lines and products of companies the user can see. Two queries at most.
 */
async function namesFor(req, index, values) {
  const ids = new Set();
  for (const value of values) collectIds(value, ids);
  if (ids.size === 0) return {};
  const names = {};
  const rest = [];
  for (const id of ids) {
    const unit = index.get(id);
    if (unit && req.access.canSee(unit.path)) names[id] = unit.name;
    else if (!unit) rest.push(id);
  }
  const companyIds = [...index.values()].filter((u) => u.type === 'company' && req.access.canSee(u.path)).map((u) => u.id);
  if (rest.length && companyIds.length) {
    const [lines, products] = await Promise.all([
      db('product_lines').whereIn('id', rest).whereIn('company_id', companyIds).select('id', 'name'),
      db('products').whereIn('id', rest).whereIn('company_id', companyIds).select('id', 'name'),
    ]);
    for (const item of [...lines, ...products]) names[item.id] = item.name;
  }
  return names;
}

/** Same keys and value types as the original output (for generic tasks, which have no fixed schema). */
function sameShape(original, edited) {
  if (!original || typeof original !== 'object' || !edited || typeof edited !== 'object' || Array.isArray(edited)) return false;
  return Object.keys(original).every((key) => key in edited && (original[key] === null || edited[key] === null || typeof original[key] === typeof edited[key]));
}

const PAST = { approve: 'approved', edit: 'edited and approved', reject: 'rejected' };
const STATUS = { approve: 'approved', edit: 'edited', reject: 'rejected' };

/**
 * Resolve a review: approve the output as it is, approve an edited version, or reject it.
 * One transaction: the action row, audit, `ai.review_resolved`, and a timeline entry when the
 * action is about a record. 409 when someone resolved it first.
 */
export async function resolveReview(req, id, { decision, output, note }) {
  return db.transaction(async (trx) => {
    const { row, index, reviewLevel, canViewPii } = await loadAction(req, id, trx, { forUpdate: true });
    if (!reviewLevel) throw errors.forbidden('You can see this output but not review it');
    if (row.status !== 'pending_review') throw errors.conflict('Someone already reviewed this output', { status: row.status });

    let finalOutput = null;
    if (decision === 'approve') finalOutput = row.output;
    if (decision === 'edit') {
      if (!output || typeof output !== 'object') throw errors.validation([{ path: 'body.output', message: 'Give the edited output' }]);
      const edited = canViewPii ? output : restoreMasked(output, row.output);
      const agent = getAgent(row.agent);
      if (agent) {
        const parsed = agent.outputSchema.safeParse(edited);
        if (!parsed.success) throw errors.validation(toFieldErrors(parsed.error, 'body.output'));
        finalOutput = parsed.data;
      } else {
        if (!sameShape(row.output, edited)) throw errors.validation([{ path: 'body.output', message: 'Keep the same fields as the original output' }]);
        finalOutput = edited;
      }
    }
    const now = new Date();
    const status = STATUS[decision];
    await trx('ai_actions')
      .where({ id: row.id })
      .update({
        status,
        final_output: finalOutput === null ? null : json(finalOutput),
        reviewer_user_id: req.auth.user.id,
        reviewed_at: now,
        review_note: note ?? null,
        updated_at: now,
      });
    const unit = index.get(row.unit_id);
    await writeAudit(trx, req, {
      unit,
      action: 'ai.review_resolved',
      entityType: 'ai_action',
      entityId: row.id,
      before: { status: row.status },
      after: { status },
      meta: { agent: row.agent, decision, companyId: row.company_id },
    });
    await emitEvent(trx, {
      type: 'ai.review_resolved',
      groupId: row.group_id,
      unitId: row.unit_id,
      aggregateType: 'ai_action',
      aggregateId: row.id,
      actorUserId: req.auth.user.id,
      payload: {
        actionId: row.id,
        agent: row.agent,
        companyId: row.company_id,
        decision,
        status,
        dealId: row.deal_id,
        contactId: row.contact_id,
        accountId: row.account_id,
        reference: row.reference,
        trigger: row.trigger,
      },
    });
    if (row.deal_id || row.contact_id || row.account_id) {
      await addTimelineEvent(trx, {
        groupId: row.group_id,
        companyId: row.company_id,
        unitId: row.unit_id,
        dealId: row.deal_id,
        contactId: row.contact_id,
        accountId: row.account_id,
        kind: 'ai',
        direction: 'internal',
        actorType: 'user',
        actorUserId: req.auth.user.id,
        title: `${agentLabel(row.agent)} ${PAST[decision]}`,
        body: note ?? null,
        meta: { agent: row.agent, actionId: row.id, decision, status },
        sourceEventId: `ai:${row.id}:review`,
        touchDeal: false,
      });
    }
    const updated = await actionQuery(trx).where('a.id', row.id).first(['a.*', ...LIST_COLUMNS.filter((c) => !c.startsWith('a.'))]);
    return presenter(req, index)(updated, { withInput: true });
  });
}
