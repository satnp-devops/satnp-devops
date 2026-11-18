import { randomUUID } from 'node:crypto';
import { json } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { addDays, localDate } from '../../core/billing/dates.js';
import { DEFAULT_IMPLEMENTATION_PHASES } from './constants.js';

// Onboarding (docs/delivery/DELIVERY.md §6): B2C checklists per enrollment and B2B
// implementation projects (phases with tasks), both built from per-company templates.

const actorOf = (ctx) => ctx?.actorUserId ?? ctx?.req?.auth?.user?.id ?? null;
const unitOf = (row) => ({ id: row.unit_id, root_id: row.group_id });
const today = () => localDate(Date.now());

async function audit(trx, ctx, entry) {
  await writeAudit(trx, ctx?.req ?? null, { ...entry, actorUserId: actorOf(ctx) ?? undefined });
}

async function emit(trx, ctx, row, type, payload, aggregateType) {
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

/**
 * The company's template for a product: the product's own, else its line's, else the company's
 * default for that kind (no product and no line). Inactive templates are ignored.
 */
export async function findTemplate(trx, { companyId, kind, productId, productLineId }) {
  const rows = await trx('onboarding_templates')
    .where({ company_id: companyId, kind, active: true })
    .where((where) => {
      where.whereNull('product_id').orWhere('product_id', productId ?? null);
    })
    .orderBy('updated_at', 'desc');
  const rank = (t) => (t.product_id && t.product_id === productId ? 0 : t.product_line_id && t.product_line_id === productLineId ? 1 : !t.product_id && !t.product_line_id ? 2 : 9);
  const best = rows.map((t) => ({ t, r: rank(t) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r)[0];
  return best?.t ?? null;
}

function resolveOwner(role, { recordOwnerId, teacherId }) {
  if (role === 'record_owner') return recordOwnerId ?? null;
  if (role === 'batch_teacher') return teacherId ?? recordOwnerId ?? null;
  return null;
}

// ---------- B2C checklists ----------

/** Start the enrollment's checklist from its template (once; nothing when there is no template). */
export async function startChecklist(trx, ctx, enrollment, batch = null) {
  const template = await findTemplate(trx, {
    companyId: enrollment.company_id,
    kind: 'b2c',
    productId: enrollment.product_id,
    productLineId: enrollment.product_line_id,
  });
  if (!template) return null;
  const items = await trx('onboarding_template_items').where({ template_id: template.id }).orderBy('position');
  const [checklist] = await trx('onboarding_checklists')
    .insert({
      group_id: enrollment.group_id,
      company_id: enrollment.company_id,
      unit_id: enrollment.unit_id,
      enrollment_id: enrollment.id,
      template_id: template.id,
      name: template.name,
      owner_user_id: enrollment.owner_user_id ?? null,
      status: items.length ? 'open' : 'done',
      items_total: items.length,
      completed_at: items.length ? null : trx.fn.now(),
    })
    .onConflict('enrollment_id')
    .ignore()
    .returning('*');
  if (!checklist) return trx('onboarding_checklists').where({ enrollment_id: enrollment.id }).first();
  // Offsets count from the day of enrollment (welcome call on day 0, timetable on day 1...).
  const anchor = localDate(enrollment.enrolled_at ?? Date.now());
  if (items.length) {
    await trx('onboarding_checklist_items').insert(
      items.map((item, index) => ({
        checklist_id: checklist.id,
        title: item.title,
        description: item.description,
        owner_user_id: resolveOwner(item.owner_role, { recordOwnerId: enrollment.owner_user_id, teacherId: batch?.teacher_user_id }),
        due_on: addDays(anchor, item.due_offset_days),
        position: index,
      })),
    );
  }
  await emit(trx, ctx, checklist, 'onboarding.checklist_started', { checklistId: checklist.id, enrollmentId: enrollment.id, itemCount: items.length }, 'onboarding_checklist');
  return checklist;
}

/** Recount a checklist's items and close or reopen it. */
async function refreshChecklist(trx, ctx, checklistId) {
  const [counts] = await trx('onboarding_checklist_items')
    .where({ checklist_id: checklistId })
    .select(trx.raw('count(*)::int as total'), trx.raw("count(*) filter (where status <> 'pending')::int as done"));
  const before = await trx('onboarding_checklists').where({ id: checklistId }).first();
  const status = counts.total > 0 && counts.done === counts.total ? 'done' : 'open';
  const [after] = await trx('onboarding_checklists')
    .where({ id: checklistId })
    .update({
      items_total: counts.total,
      items_done: counts.done,
      status,
      completed_at: status === 'done' ? (before.completed_at ?? trx.fn.now()) : null,
      updated_at: trx.fn.now(),
    })
    .returning('*');
  if (before.status !== 'done' && status === 'done') {
    await emit(trx, ctx, after, 'onboarding.checklist_completed', { checklistId, enrollmentId: after.enrollment_id }, 'onboarding_checklist');
    const enrollment = await trx('enrollments').where({ id: after.enrollment_id }).first();
    await addTimelineEvent(trx, {
      groupId: after.group_id,
      companyId: after.company_id,
      unitId: after.unit_id,
      dealId: enrollment.deal_id,
      contactId: enrollment.student_contact_id,
      kind: 'system',
      title: `Onboarding complete: ${after.name}`,
      meta: { action: 'onboarding.checklist_completed', checklistId, enrollmentId: enrollment.id },
      actorType: actorOf(ctx) ? 'user' : 'system',
      actorUserId: actorOf(ctx),
    });
  }
  return after;
}

export async function updateChecklistItem(trx, ctx, item, checklist, changes) {
  const patch = {};
  if (changes.status !== undefined && changes.status !== item.status) {
    patch.status = changes.status;
    patch.completed_at = changes.status === 'pending' ? null : trx.fn.now();
    patch.completed_by = changes.status === 'pending' ? null : actorOf(ctx);
  }
  if (changes.ownerUserId !== undefined) patch.owner_user_id = changes.ownerUserId;
  if (changes.dueOn !== undefined) patch.due_on = changes.dueOn;
  if (Object.keys(patch).length === 0) return { item, checklist };
  const [updated] = await trx('onboarding_checklist_items').where({ id: item.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
  const after = patch.status !== undefined ? await refreshChecklist(trx, ctx, checklist.id) : checklist;
  await emit(trx, ctx, checklist, 'onboarding.item_updated', { checklistId: checklist.id, itemId: item.id, changes: Object.keys(changes) }, 'onboarding_checklist');
  await audit(trx, ctx, {
    action: 'onboarding.item_updated',
    entityType: 'onboarding_checklist_item',
    entityId: item.id,
    unit: unitOf(checklist),
    before: { status: item.status, ownerUserId: item.owner_user_id, dueOn: item.due_on },
    after: { status: updated.status, ownerUserId: updated.owner_user_id, dueOn: updated.due_on },
  });
  return { item: updated, checklist: after };
}

// ---------- B2B implementation projects ----------

/**
 * Create the implementation project for a signed contract, a won deal or a started subscription,
 * once. A project that already exists for the same deal (or subscription) gets the other ids
 * attached instead of a second project.
 * @returns {Promise<{ project: object, created: boolean }>}
 */
export async function ensureImplementationProject(trx, ctx, input) {
  const keys = [input.dealId && `deal:${input.dealId}`, input.subscriptionId && `subscription:${input.subscriptionId}`, input.contractId && `contract:${input.contractId}`].filter(Boolean);
  const sourceKey = input.sourceKey ?? keys[0] ?? `manual:${randomUUID()}`;
  await trx.raw('select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(?::text[]) as k order by k', [
    [...new Set([...keys, sourceKey])].sort().map((k) => `delivery.project:${k}`),
  ]);
  const existing = await trx('implementation_projects')
    .where((where) => {
      where.where('source_key', sourceKey);
      if (input.dealId) where.orWhere('deal_id', input.dealId);
      if (input.subscriptionId) where.orWhere('subscription_id', input.subscriptionId);
      if (input.contractId) where.orWhere('contract_id', input.contractId);
    })
    .first();
  if (existing) {
    const attach = {};
    if (input.dealId && !existing.deal_id) attach.deal_id = input.dealId;
    if (input.subscriptionId && !existing.subscription_id) attach.subscription_id = input.subscriptionId;
    if (input.contractId && !existing.contract_id) attach.contract_id = input.contractId;
    if (Object.keys(attach).length === 0) return { project: existing, created: false };
    const [updated] = await trx('implementation_projects').where({ id: existing.id }).update({ ...attach, updated_at: trx.fn.now() }).returning('*');
    await emit(trx, ctx, updated, 'implementation.updated', { projectId: updated.id, changes: Object.keys(attach) }, 'implementation_project');
    return { project: updated, created: false };
  }

  const template = await findTemplate(trx, {
    companyId: input.companyId,
    kind: 'b2b',
    productId: input.productId,
    productLineId: input.productLineId,
  });
  const phases = template?.phases?.length ? template.phases : DEFAULT_IMPLEMENTATION_PHASES;
  const items = template ? await trx('onboarding_template_items').where({ template_id: template.id }).orderBy('position') : [];
  const kickoff = input.kickoffOn ?? today();
  const goLive = input.targetGoLiveOn ?? addDays(kickoff, Math.max(...phases.map((p) => p.offsetDays ?? 0), 0));
  const account = await trx('accounts').where({ id: input.accountId }).first('name');
  const product = input.productId ? await trx('products').where({ id: input.productId }).first('name') : null;

  const [project] = await trx('implementation_projects')
    .insert({
      group_id: input.groupId,
      company_id: input.companyId,
      unit_id: input.unitId,
      account_id: input.accountId,
      deal_id: input.dealId ?? null,
      subscription_id: input.subscriptionId ?? null,
      contract_id: input.contractId ?? null,
      product_line_id: input.productLineId ?? null,
      product_id: input.productId ?? null,
      template_id: template?.id ?? null,
      name: input.name ?? `${account?.name ?? 'Institute'}: ${product?.name ?? 'implementation'}`,
      status: 'planned',
      owner_user_id: input.ownerUserId ?? null,
      kickoff_on: kickoff,
      target_go_live_on: goLive,
      source_key: sourceKey,
      tasks_total: items.length,
      created_by: actorOf(ctx),
    })
    .returning('*');

  const phaseRows = await trx('implementation_phases')
    .insert(
      phases.map((phase, index) => ({
        project_id: project.id,
        key: phase.key,
        name: phase.name,
        position: index,
        owner_user_id: input.ownerUserId ?? null,
        due_on: addDays(kickoff, phase.offsetDays ?? 0),
      })),
    )
    .returning('*');
  const phaseByKey = new Map(phaseRows.map((p) => [p.key, p]));
  const tasks = items
    .map((item, index) => {
      const phase = phaseByKey.get(item.phase_key) ?? phaseRows[0];
      return {
        project_id: project.id,
        phase_id: phase.id,
        title: item.title,
        description: item.description,
        owner_user_id: resolveOwner(item.owner_role, { recordOwnerId: input.ownerUserId }),
        due_on: addDays(kickoff, item.due_offset_days),
        position: index,
      };
    });
  if (tasks.length) await trx('implementation_tasks').insert(tasks);

  await addTimelineEvent(trx, {
    groupId: project.group_id,
    companyId: project.company_id,
    unitId: project.unit_id,
    dealId: project.deal_id,
    accountId: project.account_id,
    kind: 'system',
    title: `Implementation project started: go-live planned for ${goLive}`,
    meta: { action: 'implementation.created', projectId: project.id, trigger: input.trigger ?? 'manual' },
    actorType: actorOf(ctx) ? 'user' : 'system',
    actorUserId: actorOf(ctx),
  });
  await emit(
    trx,
    ctx,
    project,
    'implementation.created',
    {
      projectId: project.id,
      accountId: project.account_id,
      dealId: project.deal_id,
      subscriptionId: project.subscription_id,
      contractId: project.contract_id,
      ownerUserId: project.owner_user_id,
      targetGoLiveOn: project.target_go_live_on,
      trigger: input.trigger ?? 'manual',
    },
    'implementation_project',
  );
  await audit(trx, ctx, {
    action: 'implementation.created',
    entityType: 'implementation_project',
    entityId: project.id,
    unit: unitOf(project),
    after: { accountId: project.account_id, dealId: project.deal_id, subscriptionId: project.subscription_id, trigger: input.trigger ?? 'manual' },
  });
  return { project, created: true };
}

const PROJECT_FIELDS = { name: 'name', status: 'status', ownerUserId: 'owner_user_id', kickoffOn: 'kickoff_on', targetGoLiveOn: 'target_go_live_on' };

export async function updateProject(trx, ctx, project, changes) {
  const patch = {};
  for (const [key, column] of Object.entries(PROJECT_FIELDS)) {
    if (changes[key] !== undefined && changes[key] !== project[column]) patch[column] = changes[key];
  }
  if (patch.status === 'live') patch.went_live_at = trx.fn.now();
  else if (patch.status) patch.went_live_at = null;
  if (Object.keys(patch).length === 0) return project;
  const [updated] = await trx('implementation_projects').where({ id: project.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
  await emit(trx, ctx, updated, 'implementation.updated', { projectId: updated.id, changes: Object.keys(changes).filter((k) => PROJECT_FIELDS[k] in patch) }, 'implementation_project');
  if (patch.status === 'live') {
    await emit(trx, ctx, updated, 'implementation.went_live', { projectId: updated.id, accountId: updated.account_id, dealId: updated.deal_id }, 'implementation_project');
    await addTimelineEvent(trx, {
      groupId: updated.group_id,
      companyId: updated.company_id,
      unitId: updated.unit_id,
      dealId: updated.deal_id,
      accountId: updated.account_id,
      kind: 'system',
      title: 'Went live',
      meta: { action: 'implementation.went_live', projectId: updated.id },
      actorType: actorOf(ctx) ? 'user' : 'system',
      actorUserId: actorOf(ctx),
    });
  }
  await audit(trx, ctx, {
    action: 'implementation.updated',
    entityType: 'implementation_project',
    entityId: project.id,
    unit: unitOf(project),
    before: Object.fromEntries(Object.keys(patch).filter((c) => c !== 'went_live_at').map((c) => [c, project[c]])),
    after: Object.fromEntries(Object.keys(patch).filter((c) => c !== 'went_live_at').map((c) => [c, updated[c]])),
  });
  return updated;
}

/** Recount tasks, move phases along (in progress once a task is done, done when all are) and start the project. */
async function refreshProject(trx, ctx, projectId) {
  const tasks = await trx('implementation_tasks').where({ project_id: projectId }).select('phase_id', 'status');
  const phases = await trx('implementation_phases').where({ project_id: projectId }).orderBy('position');
  for (const phase of phases) {
    const mine = tasks.filter((t) => t.phase_id === phase.id);
    const done = mine.filter((t) => t.status !== 'pending').length;
    const status = mine.length > 0 && done === mine.length ? 'done' : done > 0 ? 'in_progress' : phase.status === 'done' && mine.length === 0 ? 'done' : 'pending';
    if (status !== phase.status) {
      await trx('implementation_phases')
        .where({ id: phase.id })
        .update({ status, completed_at: status === 'done' ? trx.fn.now() : null, updated_at: trx.fn.now() });
    }
  }
  const doneCount = tasks.filter((t) => t.status !== 'pending').length;
  const project = await trx('implementation_projects').where({ id: projectId }).first();
  const patch = { tasks_total: tasks.length, tasks_done: doneCount, updated_at: trx.fn.now() };
  if (project.status === 'planned' && doneCount > 0) patch.status = 'in_progress';
  const [updated] = await trx('implementation_projects').where({ id: projectId }).update(patch).returning('*');
  if (patch.status) await emit(trx, ctx, updated, 'implementation.updated', { projectId, changes: ['status'] }, 'implementation_project');
  return updated;
}

export async function updateTask(trx, ctx, task, project, changes) {
  const patch = {};
  if (changes.status !== undefined && changes.status !== task.status) {
    patch.status = changes.status;
    patch.completed_at = changes.status === 'pending' ? null : trx.fn.now();
    patch.completed_by = changes.status === 'pending' ? null : actorOf(ctx);
  }
  if (changes.ownerUserId !== undefined) patch.owner_user_id = changes.ownerUserId;
  if (changes.dueOn !== undefined) patch.due_on = changes.dueOn;
  if (changes.title !== undefined) patch.title = changes.title;
  if (Object.keys(patch).length === 0) return { task, project };
  const [updated] = await trx('implementation_tasks').where({ id: task.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
  const after = patch.status !== undefined ? await refreshProject(trx, ctx, project.id) : project;
  if (patch.status === 'done') {
    await emit(trx, ctx, project, 'implementation.task_completed', { projectId: project.id, taskId: task.id, phaseId: task.phase_id }, 'implementation_project');
  }
  await audit(trx, ctx, {
    action: 'implementation.task_updated',
    entityType: 'implementation_task',
    entityId: task.id,
    unit: unitOf(project),
    before: { status: task.status, ownerUserId: task.owner_user_id, dueOn: task.due_on, title: task.title },
    after: { status: updated.status, ownerUserId: updated.owner_user_id, dueOn: updated.due_on, title: updated.title },
  });
  return { task: updated, project: after };
}

export async function addTask(trx, ctx, project, input) {
  const phase = await trx('implementation_phases').where({ project_id: project.id, id: input.phaseId }).first();
  if (!phase) throw new AppError(422, 'validation_failed', 'Some fields need attention', [{ path: 'body.phaseId', message: 'Pick a phase of this project' }]);
  const [{ max }] = await trx('implementation_tasks').where({ phase_id: phase.id }).max({ max: 'position' });
  const [task] = await trx('implementation_tasks')
    .insert({
      project_id: project.id,
      phase_id: phase.id,
      title: input.title,
      description: input.description ?? null,
      owner_user_id: input.ownerUserId ?? null,
      due_on: input.dueOn ?? phase.due_on,
      position: (max ?? -1) + 1,
    })
    .returning('*');
  const after = await refreshProject(trx, ctx, project.id);
  await emit(trx, ctx, project, 'implementation.task_added', { projectId: project.id, taskId: task.id, phaseId: phase.id }, 'implementation_project');
  await audit(trx, ctx, { action: 'implementation.task_added', entityType: 'implementation_task', entityId: task.id, unit: unitOf(project), after: { title: task.title, phaseId: phase.id } });
  return { task, project: after };
}

export async function updatePhase(trx, ctx, phase, project, changes) {
  const patch = {};
  if (changes.ownerUserId !== undefined) patch.owner_user_id = changes.ownerUserId;
  if (changes.dueOn !== undefined) patch.due_on = changes.dueOn;
  if (Object.keys(patch).length === 0) return phase;
  const [updated] = await trx('implementation_phases').where({ id: phase.id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
  await emit(trx, ctx, project, 'implementation.updated', { projectId: project.id, phaseId: phase.id, changes: Object.keys(changes) }, 'implementation_project');
  await audit(trx, ctx, {
    action: 'implementation.phase_updated',
    entityType: 'implementation_phase',
    entityId: phase.id,
    unit: unitOf(project),
    before: { ownerUserId: phase.owner_user_id, dueOn: phase.due_on },
    after: { ownerUserId: updated.owner_user_id, dueOn: updated.due_on },
  });
  return updated;
}

// ---------- Templates ----------

/** Replace a template's items (and phases) in one go. */
export async function saveTemplate(trx, ctx, template, input, { company }) {
  const fields = {
    name: input.name,
    product_line_id: input.productLineId ?? null,
    product_id: input.productId ?? null,
    phases: json(input.kind === 'b2b' ? (input.phases?.length ? input.phases : DEFAULT_IMPLEMENTATION_PHASES) : []),
    active: input.active ?? true,
  };
  let row;
  if (template) {
    [row] = await trx('onboarding_templates').where({ id: template.id }).update({ ...fields, updated_at: trx.fn.now() }).returning('*');
    await trx('onboarding_template_items').where({ template_id: template.id }).delete();
  } else {
    [row] = await trx('onboarding_templates')
      .insert({ ...fields, group_id: company.root_id, company_id: company.id, kind: input.kind, created_by: actorOf(ctx) })
      .returning('*');
  }
  if (input.items.length) {
    await trx('onboarding_template_items').insert(
      input.items.map((item, index) => ({
        template_id: row.id,
        phase_key: input.kind === 'b2b' ? item.phaseKey : null,
        title: item.title,
        description: item.description ?? null,
        owner_role: item.ownerRole ?? 'record_owner',
        due_offset_days: item.dueOffsetDays ?? 0,
        position: index,
      })),
    );
  }
  const action = template ? 'onboarding.template_updated' : 'onboarding.template_created';
  await emitEvent(trx, {
    type: action,
    groupId: company.root_id,
    unitId: company.id,
    aggregateType: 'onboarding_template',
    aggregateId: row.id,
    actorUserId: actorOf(ctx),
    payload: { templateId: row.id, companyId: company.id, kind: row.kind, itemCount: input.items.length },
  });
  await audit(trx, ctx, {
    action,
    entityType: 'onboarding_template',
    entityId: row.id,
    unit: company,
    before: template ? { name: template.name, active: template.active } : undefined,
    after: { name: row.name, kind: row.kind, active: row.active, items: input.items.length },
  });
  return row;
}
