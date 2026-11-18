import { randomUUID } from 'node:crypto';
import { json } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { emitEvent } from '../../core/events.js';
import { idsFromPath } from '../../core/orgTree.js';
import {
  AutomationError,
  EFFECT_RESULT,
  REQUEST_APPROVAL,
  TERMINAL_STATUSES,
  advance,
  canStartRun,
  cancelRun,
  matchTrigger,
  nextScheduleFire,
  noActivityCutoff,
  noActivityEventId,
  startRun,
} from '../../core/automation/index.js';
import { LIMITS } from './constants.js';
import { closeApprovalsForKey, createApprovalFromEffect } from './approvals.js';
import { performEffect } from './executor.js';
import { ports } from './ports.js';
import { getAutomationRegistry } from './registry.js';
import { automationsEnabled } from './settings.js';
import { loadDealRecords, loadRecord, loadRecords, subjectOf, toFlowEvent } from './subjects.js';

/**
 * The runner: everything that moves runs, around the pure interpreter (AUTOMATION_CORE.md §11).
 *
 *   handleEvent       outbox handler for '*': resume runs waiting on the event, start runs of
 *                     matching active flows, route automation.effect_result events
 *   tick              the scheduler job 'automations.tick' (every minute): due timers, schedule
 *                     triggers, no-activity scans, effects left pending by a crash
 *   deliverEffectResult  executors report awaited results here
 *
 * Rules: one transaction per run change (run row, step log, effects and approvals together);
 * runs are locked FOR UPDATE while advanced, so two workers never advance one run at once;
 * effects are performed only after the transaction commits (ports.dispatchEffects), and their
 * idempotency keys make a replay harmless. The clock (`now`, epoch ms) is a parameter.
 */

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

// ---------- Flow versions (immutable, so cached) ----------

const versionCache = new Map();
const VERSION_CACHE_SIZE = 500;

export async function loadVersions(trx, ids) {
  const missing = [...new Set(ids)].filter((id) => !versionCache.has(id));
  if (missing.length > 0) {
    const rows = await trx('automation_flow_versions').whereIn('id', missing).select('id', 'definition');
    for (const row of rows) {
      if (versionCache.size >= VERSION_CACHE_SIZE) versionCache.delete(versionCache.keys().next().value);
      versionCache.set(row.id, row.definition);
    }
  }
  return new Map(ids.map((id) => [id, versionCache.get(id)]));
}

// ---------- Rows ↔ engine runs ----------

export function runFromRow(row, definition) {
  return {
    id: row.id,
    flowKey: definition.key,
    flowVersion: row.flow_version,
    status: row.status,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id } : null,
    trigger: row.trigger,
    startedAt: iso(row.started_at),
    state: row.state,
  };
}

function runColumns(result, now, previous = null) {
  const terminal = TERMINAL_STATUSES.includes(result.status);
  const waiting = result.waitingFor ?? null;
  return {
    status: result.status,
    state: json(result.state),
    waiting_kind: waiting?.kind ?? null,
    waiting_event: waiting?.event ?? null,
    waiting_key: waiting?.idempotencyKey ?? null,
    next_wake_at: result.nextWakeAt ?? null,
    step_count: result.state.stepCount ?? 0,
    error: result.error ? json(result.error) : null,
    end_reason: result.state.endReason ?? null,
    ended_at: terminal ? (previous?.ended_at ?? new Date(now)) : null,
    updated_at: new Date(now),
  };
}

/** The interpreter refused the run (corrupt state, missing version): fail it visibly instead of retrying forever. */
function failedResult(run, error, now) {
  const at = new Date(now).toISOString();
  const state = structuredClone(run.state ?? {});
  const seq = state.traceSeq ?? 0;
  const entry = { seq, at, phase: 'run', stepId: null, type: 'run', outcome: 'failed', next: null, detail: { code: error.code, message: error.message } };
  state.trace = [...(state.trace ?? []), entry].slice(-300);
  state.traceSeq = seq + 1;
  state.waiting = null;
  state.cursor = null;
  state.error = { stepId: null, code: error.code, message: error.message };
  return { status: 'failed', state, effects: [], trace: [entry], nextWakeAt: null, waitingFor: null, changed: true, error: state.error };
}

/** Trace entries this change added (cancelRun returns none of its own). */
function newTrace(previousState, result) {
  if (Array.isArray(result.trace)) return result.trace;
  const from = previousState?.traceSeq ?? 0;
  return (result.state.trace ?? []).filter((entry) => entry.seq >= from);
}

/**
 * Saves what one change produced, in the caller's transaction: step log, effects (one row per
 * idempotency key), approval items, approvals that ended without a decision, and run events.
 * @returns {Promise<string[]>} ids of effects to perform after commit
 */
async function persistOutcome(trx, run, result, { record, previousState, previousStatus, now }) {
  const trace = newTrace(previousState, result);
  if (trace.length > 0) {
    await trx('automation_run_steps')
      .insert(
        trace.map((t) => ({
          run_id: run.id,
          seq: t.seq,
          step_id: t.stepId ?? null,
          step_type: t.type ?? null,
          phase: t.phase ?? null,
          outcome: t.outcome ?? null,
          next_step_id: t.next ?? null,
          detail: t.detail ? json(t.detail) : null,
          at: t.at,
        })),
      )
      .onConflict(['run_id', 'seq'])
      .ignore();
  }

  const toDispatch = [];
  if (result.effects.length > 0) {
    const at = new Date(now);
    const inserted = await trx('automation_effects')
      .insert(
        result.effects.map((e) => {
          const internal = e.action === REQUEST_APPROVAL;
          return {
            idempotency_key: e.idempotencyKey,
            run_id: run.id,
            company_id: run.company_id,
            step_id: e.stepId,
            action: e.action,
            params: json(e.params),
            awaited: e.await === true,
            subject_type: e.subject?.type ?? null,
            subject_id: e.subject?.id ?? null,
            status: internal ? 'done' : 'pending',
            executor: internal ? 'internal' : null,
            completed_at: internal ? at : null,
            created_at: at,
            updated_at: at,
          };
        }),
      )
      .onConflict('idempotency_key')
      .ignore()
      .returning(['id', 'action', 'idempotency_key', 'step_id', 'params']);
    for (const effect of inserted) {
      if (effect.action === REQUEST_APPROVAL) await createApprovalFromEffect(trx, run, effect, { record, now });
      else toDispatch.push(effect.id);
    }
  }

  // An approval the run stopped waiting for without a decision: it timed out, or the run was cancelled.
  const was = previousState?.waiting;
  if (was?.kind === 'approval' && result.waitingFor?.idempotencyKey !== was.idempotencyKey) {
    const timedOut = trace.some((t) => t.stepId === was.stepId && t.outcome === 'timeout');
    await closeApprovalsForKey(trx, was.idempotencyKey, timedOut ? 'expired' : 'cancelled', now);
  }

  const terminal = TERMINAL_STATUSES.includes(result.status);
  if (terminal && !TERMINAL_STATUSES.includes(previousStatus ?? '')) {
    await emitEvent(trx, {
      type: `automation.run_${result.status}`,
      groupId: run.group_id,
      unitId: run.unit_id,
      aggregateType: 'automation_run',
      aggregateId: run.id,
      payload: {
        runId: run.id,
        flowId: run.flow_id,
        companyId: run.company_id,
        dealId: run.deal_id ?? null,
        subject: run.subject_type ? { type: run.subject_type, id: run.subject_id } : null,
        status: result.status,
        error: result.error ?? null,
      },
    });
  }
  return toDispatch;
}

/** Hands effects to the executor (after commit). */
export async function dispatch(db, effectIds, { log = logger, now } = {}) {
  if (!effectIds || effectIds.length === 0) return;
  await ports.dispatchEffects(effectIds, { performEffect: (id) => performEffect(db, id, { log, now: now ?? Date.now() }) });
}

// ---------- Starting runs ----------

async function runCounts(trx, flowId, subject, now) {
  const query = trx('automation_runs').where({ flow_id: flowId });
  if (subject) query.where({ subject_id: subject.id });
  else query.whereNull('subject_id');
  const [row] = await query.select(
    trx.raw("count(*) filter (where status in ('running', 'waiting'))::int as active"),
    trx.raw('count(*)::int as total'),
    trx.raw('count(*) filter (where started_at > ?)::int as recent', [new Date(now - 3_600_000)]),
  );
  return { activeRuns: row.active, totalRuns: row.total, recentRuns: row.recent };
}

/**
 * Starts one run of a flow for an event, if the trigger matches and the re-entry rule allows it.
 * Idempotent: a second delivery of the same event id starts nothing (unique flow + trigger event).
 * @param {object} flow  { id, group_id, company_id, unit_id, key, version_id, definition }
 * @returns {Promise<null | { runId: string, status: string, effectIds: string[] }>}
 */
export async function startRunForFlow(db, flow, flowEvent, { record = null, now = Date.now(), log = logger, unitId = null } = {}) {
  const automation = getAutomationRegistry();
  const definition = flow.definition;
  const match = matchTrigger(definition, automation, flowEvent, { now, context: { record } });
  if (!match.matched) {
    if (match.reason === 'filter_error' || match.reason === 'config_invalid') {
      log.warn({ flowId: flow.id, eventId: flowEvent.id, error: match.error }, 'Automation trigger could not be checked');
    }
    return null;
  }
  const subject = flowEvent.subject ?? null;
  return db.transaction(async (trx) => {
    // Serialises starts per flow and subject, so the re-entry rule holds under concurrent events.
    await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`automation:${flow.id}:${subject?.id ?? '-'}`]);
    const counts = await runCounts(trx, flow.id, subject, now);
    if (!canStartRun(definition, counts)) return null;
    if (subject && counts.recentRuns >= LIMITS.runsPerSubjectPerHour) {
      log.warn({ flowId: flow.id, subject }, 'Automation run limit per subject reached; not starting another run');
      return null;
    }
    const runId = randomUUID();
    const run = startRun(definition, { runId, event: flowEvent, now });
    let result;
    try {
      result = advance(definition, run, { registry: automation, now, context: { record } });
    } catch (err) {
      if (!(err instanceof AutomationError)) throw err;
      result = failedResult(run, err, now);
    }
    const ownUnit =
      unitId ?? (record?.type === 'deal' && record.companyId === flow.company_id ? record.unitId : null) ?? flowEvent.unitId ?? flow.unit_id;
    const [row] = await trx('automation_runs')
      .insert({
        id: runId,
        group_id: flow.group_id,
        company_id: flow.company_id,
        unit_id: ownUnit,
        flow_id: flow.id,
        flow_version_id: flow.version_id,
        flow_version: definition.version,
        subject_type: subject?.type ?? null,
        subject_id: subject?.id ?? null,
        deal_id: subject?.type === 'deal' ? subject.id : null,
        trigger: json(flowEvent),
        trigger_event_id: flowEvent.id ?? null,
        started_at: new Date(now),
        ...runColumns(result, now),
      })
      .onConflict(['flow_id', 'trigger_event_id'])
      .ignore()
      .returning(['id', 'group_id', 'company_id', 'unit_id', 'flow_id', 'subject_type', 'subject_id', 'deal_id']);
    if (!row) return null; // this event already started a run of this flow
    await emitEvent(trx, {
      type: 'automation.run_started',
      groupId: flow.group_id,
      unitId: ownUnit,
      aggregateType: 'automation_run',
      aggregateId: runId,
      payload: { runId, flowId: flow.id, flowVersion: definition.version, companyId: flow.company_id, dealId: row.deal_id, subject, triggerEventId: flowEvent.id ?? null },
    });
    const effectIds = await persistOutcome(trx, row, result, { record, previousState: run.state, previousStatus: null, now });
    return { runId, status: result.status, effectIds };
  });
}

/** Active flows (with their active version) listening to an event at the event unit or above. */
async function flowsForEvent(db, event) {
  const automation = getAutomationRegistry();
  const triggerKeys = automation.triggersForEvent(event.type).map((t) => t.key);
  if (triggerKeys.length === 0 || !event.unitId) return [];
  const unit = await db('org_units').where({ id: event.unitId }).first('id', 'path');
  if (!unit) return [];
  return db('automation_flows as f')
    .join('automation_flow_versions as v', function joinVersion() {
      this.on('v.flow_id', '=', 'f.id').andOn('v.version', '=', 'f.active_version');
    })
    .where('f.status', 'active')
    .whereIn('f.trigger_type', triggerKeys)
    .whereIn('f.unit_id', idsFromPath(unit.path))
    .orderBy('f.created_at')
    .select('f.id', 'f.group_id', 'f.company_id', 'f.unit_id', 'f.key', 'v.id as version_id', 'v.definition');
}

export async function startRunsForEvent(db, event, { now = Date.now(), log = logger, memo = {}, record } = {}) {
  const flows = await flowsForEvent(db, event);
  const out = { started: [], effectIds: [] };
  if (flows.length === 0) return out;
  if (!(await automationsEnabled(flows[0].company_id, db))) return out;
  const normalised = (memo.flowEvent ??= await toFlowEvent(db, event));
  const subjectRecord = record !== undefined ? record : await loadRecord(db, normalised.subject);
  for (const flow of flows) {
    try {
      const started = await startRunForFlow(db, flow, normalised, { record: subjectRecord, now, log });
      if (started) {
        out.started.push(started.runId);
        out.effectIds.push(...started.effectIds);
      }
    } catch (err) {
      // One broken flow must not stop the others (the event job would retry them all).
      log.error({ err, flowId: flow.id, eventId: event.id }, 'Automation run could not start');
    }
  }
  return out;
}

// ---------- Advancing runs ----------

/** Advances one locked run row inside a transaction. */
async function advanceLockedRun(trx, row, { definition, record, event = null, now }) {
  const automation = getAutomationRegistry();
  const def = definition ?? (await loadVersions(trx, [row.flow_version_id])).get(row.flow_version_id);
  const run = runFromRow(row, def ?? { key: null });
  let result;
  try {
    if (!def) throw new AutomationError('VERSION_MISSING', `Version ${row.flow_version} of this flow is missing`);
    result = advance(def, run, { registry: automation, now, event, context: { record } });
  } catch (err) {
    if (!(err instanceof AutomationError)) throw err;
    result = failedResult(run, err, now);
  }
  if (!result.changed) return { result, effectIds: [] };
  await trx('automation_runs').where({ id: row.id }).update(runColumns(result, now, row));
  const effectIds = await persistOutcome(trx, row, result, { record, previousState: row.state, previousStatus: row.status, now });
  return { result, effectIds };
}

/**
 * Locks a run and advances it with an event (or none: timers), then performs its new effects.
 * @returns {Promise<null | { result: object, effectIds: string[] }>}
 */
export async function advanceRun(db, runId, { event = null, record, now = Date.now(), log = logger } = {}) {
  const out = await db.transaction((trx) => advanceRunInTransaction(trx, runId, { event, record, now }));
  if (out?.effectIds.length) await dispatch(db, out.effectIds, { log, now });
  return out;
}

/**
 * Locks and advances a run in the caller's transaction (approval decisions save the decision and
 * the run together). The caller dispatches the returned effect ids after commit.
 * @returns {Promise<null | { result: object, effectIds: string[] }>}
 */
export async function advanceRunInTransaction(trx, runId, { event = null, record, now = Date.now() } = {}) {
  const row = await trx('automation_runs').where({ id: runId }).forUpdate().first();
  if (!row || TERMINAL_STATUSES.includes(row.status)) return null;
  const subject = row.subject_type ? { type: row.subject_type, id: row.subject_id } : null;
  const fresh = record !== undefined ? record : await loadRecord(trx, subject);
  return advanceLockedRun(trx, row, { record: fresh, event, now });
}

export async function resumeRunsForEvent(db, event, { now = Date.now(), log = logger, memo = {} } = {}) {
  const subject = subjectOf(event);
  if (!subject) return { resumed: 0 };
  const rows = await db('automation_runs as r')
    .join('automation_flows as f', 'f.id', 'r.flow_id')
    .where({ 'r.status': 'waiting', 'r.waiting_kind': 'event', 'r.waiting_event': event.type, 'r.subject_id': subject.id })
    .where('f.status', 'active')
    .limit(LIMITS.resumeBatch)
    .pluck('r.id');
  if (rows.length === 0) return { resumed: 0 };
  const normalised = (memo.flowEvent ??= await toFlowEvent(db, event));
  const record = await loadRecord(db, subject);
  let resumed = 0;
  for (const id of rows) {
    const out = await advanceRun(db, id, { event: normalised, record, now, log });
    if (out?.result.changed) resumed += 1;
  }
  return { resumed };
}

/**
 * An executor's result for an awaited effect. Safe to call twice (the run ignores a second delivery).
 * @param {{ idempotencyKey: string, ok: boolean, output?: unknown, error?: { code: string, message: string } }} result
 */
export async function deliverEffectResult(db, result, { now = Date.now(), log = logger } = {}) {
  if (typeof result?.idempotencyKey !== 'string') return null;
  const row = await db('automation_runs').where({ status: 'waiting', waiting_key: result.idempotencyKey }).first('id');
  if (!row) return null;
  const event = {
    id: `result:${result.idempotencyKey}`,
    type: EFFECT_RESULT,
    idempotencyKey: result.idempotencyKey,
    ok: result.ok === true,
    output: result.output ?? null,
    ...(result.ok === true ? {} : { error: { code: result.error?.code ?? 'EFFECT_FAILED', message: result.error?.message ?? 'The action failed' } }),
  };
  return advanceRun(db, row.id, { event, now, log });
}

/** Cancels a locked run row (in the caller's transaction). */
export async function cancelLockedRun(trx, row, { reason = 'cancelled', now = Date.now() } = {}) {
  if (TERMINAL_STATUSES.includes(row.status)) return { changed: false };
  const result = { ...cancelRun({ ...row, state: row.state }, { now, reason }), waitingFor: null, nextWakeAt: null, error: null };
  await trx('automation_runs').where({ id: row.id }).update(runColumns(result, now, row));
  await persistOutcome(trx, row, result, { record: null, previousState: row.state, previousStatus: row.status, now });
  return { changed: true };
}

// ---------- The outbox handler ----------

const EFFECT_RESULT_EVENT = EFFECT_RESULT;

/**
 * Registered for '*'. Must be idempotent: the events queue retries jobs.
 * @param {{ id: string, type: string, groupId?: string, unitId?: string, aggregateType?: string, aggregateId?: string, payload?: object }} event
 * @param {{ db: import('knex').Knex, log?: any }} deps
 */
export async function handleEvent(event, { db, log = logger, now = Date.now() } = {}) {
  if (!event?.type) return;
  if (event.type === EFFECT_RESULT_EVENT) {
    // Other modules' executors may report awaited results as a domain event.
    const p = event.payload ?? {};
    if (typeof p.idempotencyKey === 'string') await deliverEffectResult(db, { idempotencyKey: p.idempotencyKey, ok: p.ok === true, output: p.output, error: p.error }, { now, log });
    return;
  }
  // This module's own notifications (run_started, approval_requested, flow_activated...).
  if (event.type.startsWith('automation.')) return;
  // The engine-shaped event (stage keys added) is built once, and only if a run or flow needs it.
  const memo = {};
  await resumeRunsForEvent(db, event, { now, log, memo });
  const { effectIds } = await startRunsForEvent(db, event, { now, log, memo });
  await dispatch(db, effectIds, { log, now });
}

// ---------- The scheduler job ----------

const STALE_EFFECT_MS = 2 * 60_000;

async function advanceDueRuns(db, { now, log, batchSize, maxBatches }) {
  let advanced = 0;
  let failed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const effectIds = [];
    const count = await db.transaction(async (trx) => {
      const { rows } = await trx.raw(
        `select r.* from automation_runs r
           join automation_flows f on f.id = r.flow_id
          where r.status = 'waiting' and r.next_wake_at <= ? and f.status = 'active'
          order by r.next_wake_at
          limit ?
          for update of r skip locked`,
        [new Date(now), batchSize],
      );
      if (rows.length === 0) return 0;
      const versions = await loadVersions(trx, rows.map((r) => r.flow_version_id));
      const records = await loadRecords(trx, rows.map((r) => (r.subject_type ? { type: r.subject_type, id: r.subject_id } : null)));
      for (const row of rows) {
        const record = row.subject_type ? (records.get(`${row.subject_type}:${row.subject_id}`) ?? null) : null;
        try {
          // A savepoint per run: one bad run doesn't undo the batch.
          const out = await trx.transaction((sp) => advanceLockedRun(sp, row, { definition: versions.get(row.flow_version_id), record, now }));
          if (out.result.changed) advanced += 1;
          effectIds.push(...out.effectIds);
        } catch (err) {
          failed += 1;
          log.error({ err, runId: row.id }, 'Automation run could not be advanced');
          await trx('automation_runs')
            .where({ id: row.id })
            .update({ status: 'failed', error: json({ stepId: null, code: 'RUNNER_ERROR', message: 'The run could not be advanced' }), next_wake_at: null, ended_at: new Date(now), updated_at: new Date(now) });
        }
      }
      return rows.length;
    });
    await dispatch(db, effectIds, { log, now });
    if (count < batchSize) break;
  }
  return { advanced, failed };
}

async function activeFlowsWithTrigger(db, triggerType, extra) {
  return db('automation_flows as f')
    .join('automation_flow_versions as v', function joinVersion() {
      this.on('v.flow_id', '=', 'f.id').andOn('v.version', '=', 'f.active_version');
    })
    .where('f.status', 'active')
    .where('f.trigger_type', triggerType)
    .modify((q) => extra?.(q))
    .orderBy('f.id')
    .limit(100)
    .select('f.id', 'f.group_id', 'f.company_id', 'f.unit_id', 'f.key', 'f.next_fire_at', 'f.trigger_state', 'v.id as version_id', 'v.definition');
}

async function fireSchedules(db, { now, log }) {
  const flows = await activeFlowsWithTrigger(db, 'schedule', (q) => q.where('f.next_fire_at', '<=', new Date(now)));
  let started = 0;
  const effectIds = [];
  for (const flow of flows) {
    const config = flow.definition.trigger.config ?? {};
    const firedAt = iso(flow.next_fire_at);
    try {
      if (await automationsEnabled(flow.company_id, db)) {
        const event = { id: `${flow.key}@${firedAt}`, type: 'automation.schedule_tick', occurredAt: new Date(now).toISOString(), subject: null, payload: { scheduledFor: firedAt } };
        const out = await startRunForFlow(db, flow, event, { record: null, now, log, unitId: flow.unit_id });
        if (out) {
          started += 1;
          effectIds.push(...out.effectIds);
        }
      }
    } catch (err) {
      log.error({ err, flowId: flow.id }, 'Scheduled automation could not start');
    }
    await db('automation_flows').where({ id: flow.id }).update({ next_fire_at: new Date(nextScheduleFire(config, now)) });
  }
  await dispatch(db, effectIds, { log, now });
  return started;
}

const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

async function scanQuietDeals(db, { now, log }) {
  const flows = await activeFlowsWithTrigger(db, 'no_activity');
  let started = 0;
  for (const flow of flows) {
    const config = flow.definition.trigger.config ?? {};
    if ((config.entity ?? 'deal') !== 'deal') continue;
    try {
      if (!(await automationsEnabled(flow.company_id, db))) continue;
      const cutoff = new Date(noActivityCutoff(config, now));
      const cursor = flow.trigger_state?.scan ?? null;
      const unit = await db('org_units').where({ id: flow.unit_id }).first('id', 'path');
      const rows = await db('deals as d')
        .modify((q) => {
          if (config.stages?.length) q.join('pipeline_stages as s', 's.id', 'd.stage_id').whereIn('s.key', config.stages);
          if (cursor) q.whereRaw('(d.last_activity_at, d.id) > (?, ?)', [cursor.at, cursor.id]);
        })
        .where('d.company_id', flow.company_id)
        .whereIn('d.unit_id', db('org_units').where('path', 'like', `${unit.path}%`).select('id'))
        .where('d.status', 'open')
        .whereNull('d.archived_at')
        .where('d.last_activity_at', '<=', cutoff)
        .orderBy([{ column: 'd.last_activity_at' }, { column: 'd.id' }])
        .limit(LIMITS.quietBatch)
        .select('d.id', 'd.last_activity_at');
      const records = await loadDealRecords(db, rows.map((r) => r.id));
      const effectIds = [];
      for (const deal of rows) {
        const record = records.get(deal.id) ?? null;
        const lastActivityAt = iso(deal.last_activity_at);
        const subject = { type: 'deal', id: deal.id };
        const event = {
          id: noActivityEventId(flow.key, subject, lastActivityAt),
          type: 'automation.no_activity',
          occurredAt: new Date(now).toISOString(),
          subject,
          payload: { dealId: deal.id, lastActivityAt, stage: record?.stage ?? null, ownerId: record?.ownerId ?? null },
        };
        const out = await startRunForFlow(db, flow, event, { record, now, log });
        if (out) {
          started += 1;
          effectIds.push(...out.effectIds);
        }
      }
      const last = rows[rows.length - 1];
      const scan = rows.length === LIMITS.quietBatch ? { at: iso(last.last_activity_at), id: last.id } : { at: cutoff.toISOString(), id: MAX_UUID };
      await db('automation_flows').where({ id: flow.id }).update({ trigger_state: json({ ...(flow.trigger_state ?? {}), scan }) });
      await dispatch(db, effectIds, { log, now });
    } catch (err) {
      log.error({ err, flowId: flow.id }, 'No-activity scan failed');
    }
  }
  return started;
}

async function redispatchStaleEffects(db, { now, log }) {
  const ids = await db('automation_effects')
    .where('status', 'pending')
    .where('created_at', '<', new Date(now - STALE_EFFECT_MS))
    .orderBy('created_at')
    .limit(100)
    .pluck('id');
  await dispatch(db, ids, { log, now });
  return ids.length;
}

/**
 * The scheduler job processor 'automations.tick'. Run it every minute (more often is fine; it is
 * safe to run concurrently from several workers).
 * @param {import('knex').Knex} db
 * @param {{ now?: number, log?: any, batchSize?: number, maxBatches?: number }} [options]
 */
export async function tick(db, { now = Date.now(), log = logger, batchSize = 50, maxBatches = 10 } = {}) {
  const runs = await advanceDueRuns(db, { now, log, batchSize, maxBatches });
  const scheduled = await fireSchedules(db, { now, log });
  const quiet = await scanQuietDeals(db, { now, log });
  const redispatched = await redispatchStaleEffects(db, { now, log });
  return { ...runs, scheduled, quiet, redispatched };
}
