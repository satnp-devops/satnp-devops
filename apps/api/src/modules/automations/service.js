import { db as defaultDb, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { levelForRecord, unitsIndex } from '../../core/crm/scope.js';
import { APPROVAL_DECIDED, simulate } from '../../core/automation/index.js';
import { canDecideApproval, canSeeApproval, checkEditedData } from './approvals.js';
import { buildFlow, engineFieldErrors } from './flows.js';
import { getAutomationRegistry } from './registry.js';
import { advanceRunInTransaction, dispatch } from './runner.js';
import { loadDealRecords, sampleDealRecord } from './subjects.js';

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

// ---------- Approvals ----------

/**
 * Approve (optionally with edited data) or reject an approval, and resume its run, in one
 * transaction. 404 when the person can't see it, 403 when they can see but not decide, 409 when
 * it is no longer pending (decided, expired, cancelled) or has passed its deadline.
 * @param {{ decision: 'approved' | 'rejected', data?: Record<string, unknown> | null, comment?: string | null }} input
 */
export async function decideApproval(req, approvalId, input, { db = defaultDb, now = Date.now(), log = logger } = {}) {
  const userId = req.auth.user.id;
  const out = await db.transaction(async (trx) => {
    // Lock order run → approval, as the runner does (it closes approvals while holding the run).
    const found = await trx('automation_approvals').where({ id: approvalId }).first('run_id');
    if (!found) throw errors.notFound('Approval');
    await trx('automation_runs').where({ id: found.run_id }).forUpdate().first('id');
    const approval = await trx('automation_approvals').where({ id: approvalId }).forUpdate().first();
    if (!approval) throw errors.notFound('Approval');
    const index = await unitsIndex(req, trx);
    const unit = index.get(approval.unit_id);
    if (!canSeeApproval(req.access, unit, approval, userId)) throw errors.notFound('Approval');
    if (!canDecideApproval(req.access, unit, approval, userId)) throw errors.forbidden("You aren't one of the approvers of this request");
    if (approval.status !== 'pending') throw errors.conflict(`This request was already ${approval.status}`, { status: approval.status });
    if (approval.expires_at && new Date(approval.expires_at).getTime() <= now) throw errors.conflict('This request has expired', { status: 'expired' });

    let decisionData = null;
    if (input.decision === 'approved') {
      const checked = checkEditedData(approval.data, input.data);
      if (!checked.ok) throw errors.validation([{ path: checked.path, message: checked.message }]);
      decisionData = checked.data;
    } else if (input.data !== undefined && input.data !== null) {
      throw errors.validation([{ path: 'body.data', message: 'Edits only apply when approving' }]);
    }
    const at = new Date(now);
    const [updated] = await trx('automation_approvals')
      .where({ id: approval.id })
      .update({
        status: input.decision,
        decided_by: userId,
        decided_at: at,
        comment: input.comment ?? null,
        decision_data: decisionData ? json(decisionData) : null,
        edited: decisionData !== null,
        updated_at: at,
      })
      .returning('*');
    await writeAudit(trx, req, {
      action: `automation_approval.${input.decision}`,
      entityType: 'automation_approval',
      entityId: approval.id,
      unit: { id: approval.unit_id, root_id: approval.group_id },
      // Field names only: drafts are message bodies (PHASE2_CONTRACT §9.0).
      after: { decision: input.decision, edited: decisionData !== null, editedFields: decisionData ? Object.keys(input.data ?? {}) : [] },
      meta: { runId: approval.run_id, flowId: approval.flow_id, stepId: approval.step_id },
    });
    await emitEvent(trx, {
      type: APPROVAL_DECIDED,
      groupId: approval.group_id,
      unitId: approval.unit_id,
      aggregateType: 'automation_approval',
      aggregateId: approval.id,
      actorUserId: userId,
      payload: {
        approvalId: approval.id,
        runId: approval.run_id,
        flowId: approval.flow_id,
        companyId: approval.company_id,
        dealId: approval.deal_id,
        decision: input.decision,
        edited: decisionData !== null,
      },
    });
    const advanced = await advanceRunInTransaction(trx, approval.run_id, {
      now,
      event: {
        id: `decision:${approval.id}`,
        type: APPROVAL_DECIDED,
        idempotencyKey: approval.idempotency_key,
        decision: input.decision,
        decidedBy: userId,
        comment: input.comment ?? null,
        data: decisionData,
      },
    });
    return { approval: updated, effectIds: advanced?.effectIds ?? [], runStatus: advanced?.result.status ?? null };
  });
  await dispatch(db, out.effectIds, { log, now });
  return out;
}

// ---------- Simulation (the editor's test panel) ----------

/**
 * Dry-run a definition (saved or not) against a sample deal or a real one the person can see.
 * Nothing is performed or stored. The server clock is `now`.
 */
export async function simulateFlow(req, { company, definition, name, key, dealId, dealRef, sample: sampleChanges, event, events, results, approvals, force }, { db = defaultDb, now = Date.now() } = {}) {
  let record;
  if (dealId || dealRef) {
    const columns = ['id', 'company_id', 'unit_id', 'owner_user_id'];
    const deal = dealId
      ? await db('deals').where({ id: dealId }).first(...columns)
      : await db('deals').where({ company_id: company.id }).whereRaw('lower(ref) = lower(?)', [dealRef]).first(...columns);
    const index = await unitsIndex(req, db);
    const visible = deal && deal.company_id === company.id && levelForRecord(req.access, index, 'deals.view', deal, { userId: req.auth.user.id });
    if (!visible) throw errors.validation([{ path: dealId ? 'body.dealId' : 'body.dealRef', message: 'Deal not found in this company' }]);
    record = (await loadDealRecords(db, [deal.id])).get(deal.id);
  } else {
    const { id: _id, type: _type, companyId: _c, unitId: _u, groupId: _g, ...changes } = sampleChanges ?? {};
    record = { ...sampleDealRecord({ companyId: company.id, unitId: company.id }), ...changes };
  }
  const registry = getAutomationRegistry();
  const flow = buildFlow(definition, { key: key ?? 'test-flow', version: 1, name: name ?? definition?.name ?? 'Test' });
  const trigger = registry.trigger(flow.trigger?.type);
  const sample = trigger?.sample ?? { type: trigger?.events?.[0] ?? 'automation.test', payload: {} };
  const subject = trigger?.subject === 'deal' ? { type: 'deal', id: record.id } : (sample.subject ?? null);
  const payload = { ...(sample.payload ?? {}), ...(subject?.type === 'deal' ? { dealId: record.id } : {}), ...(event?.payload ?? {}) };
  const triggerEvent = { ...structuredClone(sample), ...(event?.type ? { type: event.type } : {}), subject, payload };
  // Scripted events are about the same subject (wait filters compare dealId with the trigger's).
  const scripted = events?.map((item) => ({ ...item, event: { ...item.event, subject, payload: { ...(subject?.type === 'deal' ? { dealId: record.id } : {}), ...(item.event?.payload ?? {}) } } }));
  const result = simulate(flow, registry, { now, event: triggerEvent, context: { record }, events: scripted, results, approvals, force });
  if (!result.ok) return { ok: false, errors: engineFieldErrors(result.errors), warnings: engineFieldErrors(result.warnings ?? []), record };
  return { ...result, warnings: engineFieldErrors(result.warnings ?? []), record, now: new Date(now).toISOString() };
}

// ---------- Runs ----------

/** types.ts AutomationRun (list and detail). `canSeeDeal` decides whether the deal's ref and title show. */
export function presentRun(row, { canSeeDeal = false } = {}) {
  const state = row.state ?? {};
  const last = Array.isArray(state.trace) && state.trace.length ? state.trace[state.trace.length - 1] : null;
  return {
    id: row.id,
    companyId: row.company_id,
    unitId: row.unit_id,
    flowId: row.flow_id,
    flowName: row.flow_name ?? null,
    flowKind: row.flow_kind ?? null,
    flowVersion: row.flow_version,
    subject: row.subject_type
      ? {
          type: row.subject_type,
          id: row.subject_id,
          ref: canSeeDeal ? (row.deal_ref ?? null) : null,
          label: canSeeDeal ? (row.deal_title ?? null) : null,
        }
      : null,
    dealId: row.deal_id,
    status: row.status,
    waiting: row.waiting_kind ? { kind: row.waiting_kind, event: row.waiting_event ?? null, stepId: state.waiting?.stepId ?? null, until: iso(row.next_wake_at) } : null,
    nextWakeAt: iso(row.next_wake_at),
    currentStepId: state.cursor ?? state.waiting?.stepId ?? null,
    lastStep: last ? { stepId: last.stepId ?? null, outcome: last.outcome, at: last.at } : null,
    stepCount: row.step_count,
    error: row.error ?? null,
    endReason: row.end_reason ?? null,
    triggerType: row.trigger?.type ?? null,
    triggerEventId: row.trigger_event_id ?? null,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    updatedAt: iso(row.updated_at),
  };
}

/** types.ts AutomationRunStep */
export function presentRunStep(row) {
  return {
    seq: row.seq,
    stepId: row.step_id,
    type: row.step_type,
    phase: row.phase,
    outcome: row.outcome,
    next: row.next_step_id,
    detail: row.detail ?? null,
    at: iso(row.at),
  };
}

/** types.ts AutomationEffect. Webhook bodies and message variables stay; secrets never reach params. */
export function presentEffect(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    stepId: row.step_id,
    action: row.action,
    params: row.params,
    awaited: row.awaited,
    status: row.status,
    executor: row.executor,
    output: row.output ?? null,
    error: row.error ?? null,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  };
}

/** Whether the person may see the run's deal ref and title (deals.view on the deal). Pure. */
export function dealVisibility(access, unitsById, userId, row) {
  if (!row.deal_id || row.deal_unit_id === undefined || row.deal_unit_id === null) return false;
  return Boolean(levelForRecord(access, unitsById, 'deals.view', { unit_id: row.deal_unit_id, owner_user_id: row.deal_owner_user_id }, { userId }));
}
