import { z } from 'zod';
import { json } from '../../lib/db.js';
import { emitEvent } from '../../core/events.js';

/**
 * Approval items: a flow's `approval` step (and AI steps whose output needs a person, such as the
 * follow-up writer) emits `automation.request_approval`; the runner turns that effect into a row
 * here in the same transaction, and the run waits. A decision (approve, edit and approve, reject)
 * resumes the run with `automation.approval_decided` (service.js decideApproval).
 *
 * Who decides (permission `automations.approve` at the approval's unit, i.e. the subject's unit):
 *   - the people the step lists (approvers.userIds) and the record owner (approvers.owner), with
 *     the permission at any level (counsellors hold automations.approve:own);
 *   - anyone holding it at the "all" level (managers, company admins), provided they also hold the
 *     permission the step names (approvers.permission), if it names one.
 * The queue shows the same people the same items (canSeeApproval).
 */

/** A uuid list from the step's approvers (the engine validated the flow; this is defence in depth). */
const uuidList = z.array(z.uuid()).max(20).catch([]);

/**
 * Insert the approval for a request_approval effect (in the runner's transaction). Idempotent on
 * the effect's key. `run` is the run row (ids and scope), `record` the subject as the runner saw it.
 */
export async function createApprovalFromEffect(trx, run, effect, { record, now }) {
  const params = effect.params ?? {};
  const approvers = params.approvers ?? {};
  const ownerUserId = approvers.owner && record?.ownerId ? record.ownerId : null;
  const at = new Date(now);
  const [row] = await trx('automation_approvals')
    .insert({
      idempotency_key: effect.idempotency_key,
      group_id: run.group_id,
      company_id: run.company_id,
      unit_id: run.unit_id,
      run_id: run.id,
      flow_id: run.flow_id,
      step_id: effect.step_id,
      subject_type: run.subject_type ?? null,
      subject_id: run.subject_id ?? null,
      deal_id: run.deal_id ?? null,
      title: String(params.title ?? 'Approval needed').slice(0, 200),
      body: typeof params.body === 'string' ? params.body.slice(0, 5000) : null,
      data: params.data !== undefined ? json(params.data) : null,
      approver_user_ids: uuidList.parse(approvers.userIds ?? []),
      approver_permission: typeof approvers.permission === 'string' ? approvers.permission : null,
      owner_user_id: ownerUserId,
      status: 'pending',
      expires_at: params.expiresAt ? new Date(params.expiresAt) : null,
      created_at: at,
      updated_at: at,
    })
    .onConflict('idempotency_key')
    .ignore()
    .returning(['id', 'approver_user_ids', 'owner_user_id', 'approver_permission', 'expires_at']);
  if (!row) return null;
  // Notification modules (messaging, in-app) can tell the approvers; nothing here sends anything.
  await emitEvent(trx, {
    type: 'automation.approval_requested',
    groupId: run.group_id,
    unitId: run.unit_id,
    aggregateType: 'automation_approval',
    aggregateId: row.id,
    payload: {
      approvalId: row.id,
      runId: run.id,
      flowId: run.flow_id,
      companyId: run.company_id,
      dealId: run.deal_id ?? null,
      approverUserIds: row.approver_user_ids ?? [],
      ownerUserId: row.owner_user_id,
      permission: row.approver_permission,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    },
  });
  return row;
}

/** Close pending approvals the run stopped waiting for without a decision (timed out or cancelled). */
export async function closeApprovalsForKey(trx, idempotencyKey, status, now) {
  if (!idempotencyKey) return 0;
  return trx('automation_approvals')
    .where({ idempotency_key: idempotencyKey, status: 'pending' })
    .update({ status, updated_at: new Date(now) });
}

/** Whether a person is named on the approval (listed, or the record owner it was sent to). */
export function isNamedApprover(approval, userId) {
  return (approval.approver_user_ids ?? []).includes(userId) || (approval.owner_user_id !== null && approval.owner_user_id === userId);
}

/**
 * Whether a person may see an approval (pure). `unit` is the approval's unit row.
 * @param {{ level: Function }} access
 */
export function canSeeApproval(access, unit, approval, userId) {
  if (!unit) return false;
  const level = access.level('automations.approve', unit.path);
  if (level === 'all') return true;
  return level === 'own' && isNamedApprover(approval, userId);
}

/** Whether a person may decide an approval (pure); pending state is checked by the caller. */
export function canDecideApproval(access, unit, approval, userId) {
  if (!unit) return false;
  const level = access.level('automations.approve', unit.path);
  if (!level) return false;
  if (isNamedApprover(approval, userId)) return true;
  if (level !== 'all') return false;
  return !approval.approver_permission || access.can(approval.approver_permission, unit.path);
}

/**
 * Edited data from the approver: only the keys the flow proposed, same kinds of values (text stays
 * text), at most 64 KB. Returns { ok, data } or { ok: false, message, path }.
 */
export function checkEditedData(original, edited) {
  if (edited === undefined || edited === null) return { ok: true, data: null };
  if (typeof edited !== 'object' || Array.isArray(edited)) return { ok: false, path: 'body.data', message: 'Send the edited fields as an object' };
  const base = original && typeof original === 'object' && !Array.isArray(original) ? original : {};
  for (const [key, value] of Object.entries(edited)) {
    if (!Object.hasOwn(base, key)) return { ok: false, path: `body.data.${key}`, message: 'This field was not part of the request' };
    const was = base[key];
    if (typeof was === 'string' && typeof value !== 'string') return { ok: false, path: `body.data.${key}`, message: 'Keep this as text' };
    if (typeof value === 'string' && value.length > 5000) return { ok: false, path: `body.data.${key}`, message: 'Keep it under 5,000 characters' };
  }
  const merged = { ...base, ...edited };
  if (Buffer.byteLength(JSON.stringify(merged)) > 64 * 1024) return { ok: false, path: 'body.data', message: 'The edited data is too large' };
  const changed = Object.keys(edited).some((key) => JSON.stringify(edited[key]) !== JSON.stringify(base[key]));
  return { ok: true, data: changed ? merged : null };
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

/** API shape of an approval (types.ts AutomationApproval). */
export function presentApproval(row, { canDecide = false, flowName, subjectLabel } = {}) {
  return {
    id: row.id,
    companyId: row.company_id,
    unitId: row.unit_id,
    runId: row.run_id,
    flowId: row.flow_id,
    flowName: flowName ?? row.flow_name ?? null,
    stepId: row.step_id,
    subject: row.subject_type ? { type: row.subject_type, id: row.subject_id, label: subjectLabel ?? row.subject_label ?? null } : null,
    dealId: row.deal_id,
    title: row.title,
    body: row.body,
    data: row.data ?? null,
    decisionData: row.decision_data ?? null,
    approvers: { userIds: row.approver_user_ids ?? [], permission: row.approver_permission, ownerUserId: row.owner_user_id },
    status: row.status,
    edited: row.edited,
    comment: row.comment,
    decidedBy: row.decided_by ? { id: row.decided_by, name: row.decided_by_name ?? null } : null,
    decidedAt: iso(row.decided_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    canDecide: row.status === 'pending' && canDecide,
  };
}
