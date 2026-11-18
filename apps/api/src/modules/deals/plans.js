import { AppError, errors } from '../../lib/errors.js';
import { crmSetting, nurtureOnLostSetting } from '../../core/crm/settings.js';
import { userLevelAt } from '../../core/crm/scope.js';
import { computeSla } from './sla.js';
import { evaluateStageMove, stageRulesMessage } from './stageRules.js';
import { newPlan } from './writes.js';

// The business rules of a deal change, shared by the single endpoints and bulk actions: each
// plan* function checks one deal and returns a plan (writes.js commits it), returns null when
// nothing would change, or throws an AppError the bulk action reports for that record.
// Permission checks happen in the callers (they differ between people and system callers).

const uniq = (values) => [...new Set(values.filter(Boolean))];

/** One stage of a pipeline, by id. */
const stageMap = (rows) => new Map(rows.map((row) => [row.id, row]));

/**
 * What the planners need about a set of deals, loaded with one query per kind:
 * the stages of their pipelines, the companies' custom deal fields, student counts and the
 * main contacts' kinds of contact method, and a cache for settings and owner checks.
 */
export async function loadPlanContext(trx, deals, { now = new Date(), userId = null } = {}) {
  const pipelineIds = uniq(deals.map((d) => d.pipeline_id));
  const companyIds = uniq(deals.map((d) => d.company_id));
  const dealIds = uniq(deals.map((d) => d.id));
  const contactIds = uniq(deals.map((d) => d.primary_contact_id));
  const [stages, definitions, students, methods] = await Promise.all([
    pipelineIds.length ? trx('pipeline_stages').whereIn('pipeline_id', pipelineIds).orderBy('position') : [],
    companyIds.length ? trx('custom_field_definitions').whereIn('company_id', companyIds).where('entity', 'deal') : [],
    dealIds.length
      ? trx('deal_contacts').whereIn('deal_id', dealIds).where('role', 'student').groupBy('deal_id').select('deal_id', trx.raw('count(*)::int as count'))
      : [],
    contactIds.length ? trx('contact_methods').whereIn('contact_id', contactIds).distinct('contact_id', 'kind') : [],
  ]);
  const stagesByPipeline = new Map();
  for (const stage of stages) {
    if (!stagesByPipeline.has(stage.pipeline_id)) stagesByPipeline.set(stage.pipeline_id, []);
    stagesByPipeline.get(stage.pipeline_id).push(stage);
  }
  const definitionsByCompany = new Map();
  for (const definition of definitions) {
    if (!definitionsByCompany.has(definition.company_id)) definitionsByCompany.set(definition.company_id, []);
    definitionsByCompany.get(definition.company_id).push(definition);
  }
  const studentCount = new Map(students.map((row) => [row.deal_id, row.count]));
  const methodKinds = new Map();
  for (const row of methods) {
    if (!methodKinds.has(row.contact_id)) methodKinds.set(row.contact_id, new Set());
    methodKinds.get(row.contact_id).add(row.kind);
  }

  const settings = new Map();
  const ownerLevels = new Map();
  return {
    trx,
    now,
    userId,
    stagesById: stageMap(stages),
    stagesByPipeline,
    definitionsByCompany,
    facts(deal) {
      const kinds = methodKinds.get(deal.primary_contact_id) ?? new Set();
      return {
        studentCount: studentCount.get(deal.id) ?? 0,
        contactHasPhone: kinds.has('phone') || kinds.has('whatsapp'),
        contactHasEmail: kinds.has('email'),
      };
    },
    /** deals.nurtureOnLost for a company (cached). */
    async nurtureDefault(companyUnit) {
      if (!settings.has(companyUnit.id)) settings.set(companyUnit.id, await crmSetting(companyUnit, nurtureOnLostSetting, trx));
      return settings.get(companyUnit.id);
    },
    /** The level at which a person holds deals.manage at a unit (cached). */
    async ownerLevel(userIdToCheck, unit) {
      const key = `${userIdToCheck}:${unit.id}`;
      if (!ownerLevels.has(key)) ownerLevels.set(key, await userLevelAt(userIdToCheck, unit, 'deals.manage', { trx }));
      return ownerLevels.get(key);
    },
  };
}

/** Columns every timeline entry on a deal carries (the deal, its company and unit, its main people). */
export function dealTimelineBase(deal) {
  return {
    groupId: deal.group_id,
    companyId: deal.company_id,
    unitId: deal.unit_id,
    dealId: deal.id,
    contactId: deal.primary_contact_id ?? null,
    accountId: deal.account_id ?? null,
  };
}

export function dealEvent(deal, type, payload, actorUserId) {
  return { type, groupId: deal.group_id, unitId: deal.unit_id, aggregateType: 'deal', aggregateId: deal.id, actorUserId, payload };
}

export function dealAudit(deal, action, { before, after, meta } = {}) {
  return { action, entityType: 'deal', entityId: deal.id, unit: { id: deal.unit_id, root_id: deal.group_id }, before, after, meta };
}

/** A 422 the web can show next to the stage: details { missing, allowedFrom }. */
export function stageRulesError(result, toStage, stages) {
  return new AppError(422, 'stage_rules', stageRulesMessage(result, toStage, stages), {
    missing: result.missing,
    allowedFrom: result.allowedFrom,
  });
}

const actorOf = (ctx) => ({ actorType: ctx.actorType ?? (ctx.userId ? 'user' : 'system'), actorUserId: ctx.userId ?? null });

// ---------- Stage moves ----------

/**
 * Plan a stage move (move, win, lose, reopen, bulk move). Returns null when the deal is already there.
 * @param {object} deal deals row (after any `fields` were applied)
 * @param {object} toStage pipeline_stages row
 * @param {{ mode?: 'move' | 'reopen', lostReason?: object | null, lostNote?: string, nurture?: boolean,
 *           companyUnit: object, bulk?: boolean, auditAction?: string }} options
 * @param {Awaited<ReturnType<typeof loadPlanContext>>} ctx
 */
export async function planMove(deal, toStage, options, ctx) {
  if (deal.archived_at) throw errors.conflict('This lead is archived. Restore it first.');
  if (toStage.id === deal.stage_id) return null;
  const mode = options.mode ?? 'move';
  const stages = ctx.stagesByPipeline.get(deal.pipeline_id) ?? [];
  const fromStage = ctx.stagesById.get(deal.stage_id) ?? null;
  const result = evaluateStageMove({
    deal,
    fromStage,
    toStage,
    pipelineStages: stages,
    facts: ctx.facts(deal),
    customDefinitions: ctx.definitionsByCompany.get(deal.company_id) ?? [],
    mode,
  });
  if (!result.ok) throw stageRulesError(result, toStage, stages);

  const now = ctx.now;
  const toStatus = toStage.category;
  const fromStatus = deal.status;
  const update = { stage_id: toStage.id, status: toStatus, stage_entered_at: now, sla_breached_at: null };
  update.sla_due_at = computeSla({ status: toStatus, stageEnteredAt: now, slaHours: toStage.sla_hours, createdAt: deal.created_at }).slaDueAt;

  let lostReason = null;
  if (toStatus === 'lost') {
    lostReason = options.lostReason ?? null;
    if (!lostReason) throw errors.validation([{ path: 'body.lostReasonId', message: 'Pick why the lead was lost' }]);
    if (lostReason.company_id !== deal.company_id || !lostReason.active || (lostReason.kind && lostReason.kind !== deal.kind)) {
      throw errors.validation([{ path: 'body.lostReasonId', message: "This reason isn't available for this lead" }]);
    }
    if (lostReason.requires_note && !options.lostNote) {
      throw errors.validation([{ path: 'body.lostNote', message: `Add a note: "${lostReason.label}" needs one` }]);
    }
    update.lost_reason_id = lostReason.id;
    update.lost_note = options.lostNote ?? null;
    update.nurture = options.nurture ?? (await ctx.nurtureDefault(options.companyUnit));
  } else {
    update.lost_reason_id = null;
    update.lost_note = null;
    if (fromStatus !== 'open' || toStatus === 'won') update.nurture = false;
  }
  // closed_at is set iff the deal is closed; a move between two won (or lost) stages keeps it.
  if (toStatus !== fromStatus) update.closed_at = toStatus === 'open' ? null : now;

  const reopened = fromStatus !== 'open' && toStatus === 'open';
  const title =
    toStatus === 'won'
      ? `Won: ${toStage.name}`
      : toStatus === 'lost'
        ? `Lost: ${lostReason.label}`
        : reopened
          ? `Reopened in ${toStage.name}`
          : `Moved to ${toStage.name}`;
  const secondsInFromStage = Math.max(0, Math.round((now.getTime() - new Date(deal.stage_entered_at).getTime()) / 1000));
  const { actorType, actorUserId } = actorOf(ctx);

  const plan = newPlan(deal);
  plan.update = update;
  plan.history = {
    deal_id: deal.id,
    group_id: deal.group_id,
    company_id: deal.company_id,
    pipeline_id: deal.pipeline_id,
    from_stage_id: deal.stage_id,
    to_stage_id: toStage.id,
    from_status: fromStatus,
    to_status: toStatus,
    lost_reason_id: lostReason?.id ?? null,
    moved_by_user_id: actorUserId,
    seconds_in_from_stage: secondsInFromStage,
    moved_at: now,
  };
  plan.timeline.push({
    ...dealTimelineBase(deal),
    kind: 'stage_change',
    direction: 'internal',
    title,
    meta: {
      fromStageId: deal.stage_id,
      toStageId: toStage.id,
      fromStatus,
      toStatus,
      lostReasonId: lostReason?.id ?? null,
      lostNote: update.lost_note ?? null,
    },
    actorType,
    actorUserId,
    occurredAt: now,
  });
  plan.events.push(
    dealEvent(
      deal,
      'deal.stage_changed',
      {
        dealId: deal.id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        pipelineId: deal.pipeline_id,
        fromStageId: deal.stage_id,
        toStageId: toStage.id,
        fromStatus,
        toStatus,
        secondsInFromStage,
        lostReasonId: lostReason?.id ?? null,
      },
      actorUserId,
    ),
  );
  if (toStatus === 'won' && fromStatus !== 'won') {
    plan.events.push(
      dealEvent(
        deal,
        'deal.won',
        {
          dealId: deal.id,
          companyId: deal.company_id,
          stageId: toStage.id,
          valueMinor: Number(deal.value_minor),
          currency: deal.currency,
          productLineId: deal.product_line_id ?? null,
          productId: deal.product_id ?? null,
          ownerUserId: deal.owner_user_id ?? null,
        },
        actorUserId,
      ),
    );
  }
  if (toStatus === 'lost' && fromStatus !== 'lost') {
    plan.events.push(
      dealEvent(
        deal,
        'deal.lost',
        { dealId: deal.id, companyId: deal.company_id, stageId: toStage.id, lostReasonId: lostReason.id, nurture: update.nurture },
        actorUserId,
      ),
    );
  }
  if (reopened) {
    plan.events.push(
      dealEvent(deal, 'deal.reopened', { dealId: deal.id, companyId: deal.company_id, stageId: toStage.id, previousStatus: fromStatus }, actorUserId),
    );
  }
  plan.audits.push(
    dealAudit(deal, options.auditAction ?? (mode === 'reopen' ? 'deal.reopened' : 'deal.stage_changed'), {
      before: { stageId: deal.stage_id, status: fromStatus },
      after: { stageId: toStage.id, status: toStatus, lostReasonId: lostReason?.id ?? undefined },
      meta: options.bulk ? { bulk: true } : undefined,
    }),
  );
  return plan;
}

/** The first active stage of a category in a pipeline (by position). */
export function firstStage(ctx, pipelineId, category) {
  return (ctx.stagesByPipeline.get(pipelineId) ?? []).find((stage) => stage.category === category && !stage.archived_at) ?? null;
}

// ---------- Assignment ----------

/**
 * Plan an owner change. The new owner must be able to work deals at the deal's unit.
 * @param {{ ownerUserId: string | null, owner: { id: string, name: string } | null, unit: object, bulk?: boolean }} options
 */
export async function planAssign(deal, options, ctx) {
  if (deal.archived_at) throw errors.conflict('This lead is archived. Restore it first.');
  const toUserId = options.ownerUserId ?? null;
  if ((deal.owner_user_id ?? null) === toUserId) return null;
  if (toUserId) {
    const level = await ctx.ownerLevel(toUserId, options.unit);
    if (!level || !options.owner) {
      throw errors.validation([{ path: 'body.ownerUserId', message: `This person can't work leads in ${options.unit.name}` }]);
    }
  }
  const { actorType, actorUserId } = actorOf(ctx);
  const plan = newPlan(deal);
  plan.update = { owner_user_id: toUserId, owner_seen_at: toUserId && toUserId === ctx.userId ? ctx.now : null };
  plan.timeline.push({
    ...dealTimelineBase(deal),
    kind: 'system',
    direction: 'internal',
    title: toUserId ? `Assigned to ${options.owner.name}` : 'Unassigned',
    meta: { action: 'deal.owner_changed', fromUserId: deal.owner_user_id ?? null, toUserId },
    actorType,
    actorUserId,
    occurredAt: ctx.now,
  });
  plan.events.push(
    dealEvent(
      deal,
      'deal.owner_changed',
      { dealId: deal.id, companyId: deal.company_id, unitId: deal.unit_id, fromUserId: deal.owner_user_id ?? null, toUserId },
      actorUserId,
    ),
  );
  plan.audits.push(
    dealAudit(deal, 'deal.assigned', {
      before: { ownerUserId: deal.owner_user_id ?? null },
      after: { ownerUserId: toUserId },
      meta: options.bulk ? { bulk: true } : undefined,
    }),
  );
  return plan;
}

// ---------- Archive and restore ----------

export function planArchive(deal, { reason, bulk } = {}, ctx) {
  if (deal.archived_at) throw errors.conflict('This lead is already archived');
  const { actorType, actorUserId } = actorOf(ctx);
  const plan = newPlan(deal);
  plan.update = { archived_at: ctx.now };
  plan.timeline.push({
    ...dealTimelineBase(deal),
    kind: 'system',
    direction: 'internal',
    title: 'Archived',
    body: reason ?? null,
    meta: { action: 'deal.archived', reason: reason ?? null },
    actorType,
    actorUserId,
    occurredAt: ctx.now,
  });
  plan.events.push(dealEvent(deal, 'deal.archived', { dealId: deal.id, companyId: deal.company_id, reason: reason ?? null }, actorUserId));
  plan.audits.push(dealAudit(deal, 'deal.archived', { meta: { ...(reason ? { reason } : {}), ...(bulk ? { bulk: true } : {}) } }));
  return plan;
}

export function planRestore(deal, { bulk } = {}, ctx) {
  if (!deal.archived_at) throw errors.conflict("This lead isn't archived");
  const { actorType, actorUserId } = actorOf(ctx);
  const plan = newPlan(deal);
  plan.update = { archived_at: null };
  plan.timeline.push({
    ...dealTimelineBase(deal),
    kind: 'system',
    direction: 'internal',
    title: 'Restored',
    meta: { action: 'deal.restored' },
    actorType,
    actorUserId,
    occurredAt: ctx.now,
  });
  plan.events.push(dealEvent(deal, 'deal.restored', { dealId: deal.id, companyId: deal.company_id }, actorUserId));
  plan.audits.push(dealAudit(deal, 'deal.restored', { meta: bulk ? { bulk: true } : undefined }));
  return plan;
}

// ---------- Tags and nurture (as PATCH: audit and event, no timeline entry) ----------

/** @param {{ add?: string[], remove?: string[], bulk?: boolean }} options */
export function planTags(deal, { add = [], remove = [], bulk } = {}, ctx) {
  if (deal.archived_at) throw errors.conflict('This lead is archived. Restore it first.');
  const current = deal.tags ?? [];
  const next = [...current.filter((tag) => !remove.includes(tag)), ...add.filter((tag) => !current.includes(tag))];
  if (next.length === current.length && next.every((tag, i) => tag === current[i])) return null;
  if (next.length > 20) throw errors.validation([{ path: 'body.tags', message: 'A lead can have at most 20 tags' }]);
  const plan = newPlan(deal);
  if (add.length) {
    plan.updateKey = `addTags:${JSON.stringify(add)}`;
    plan.rawUpdate = (trx) => ({
      tags: trx.raw('tags || array(select t from unnest(?::text[]) with ordinality as u(t, n) where not t = any(tags) order by n)', [add]),
    });
  } else {
    plan.updateKey = `removeTags:${JSON.stringify(remove)}`;
    plan.rawUpdate = (trx) => ({
      tags: trx.raw('array(select t from unnest(tags) with ordinality as u(t, n) where not t = any(?::text[]) order by n)', [remove]),
    });
  }
  const { actorUserId } = actorOf(ctx);
  plan.events.push(dealEvent(deal, 'deal.updated', { dealId: deal.id, companyId: deal.company_id, changes: ['tags'] }, actorUserId));
  plan.audits.push(dealAudit(deal, 'deal.updated', { before: { tags: current }, after: { tags: next }, meta: bulk ? { bulk: true } : undefined }));
  return plan;
}

export function planNurture(deal, { nurture, bulk } = {}, ctx) {
  if (deal.archived_at) throw errors.conflict('This lead is archived. Restore it first.');
  if (deal.nurture === nurture) return null;
  const plan = newPlan(deal);
  plan.update = { nurture };
  const { actorUserId } = actorOf(ctx);
  plan.events.push(dealEvent(deal, 'deal.updated', { dealId: deal.id, companyId: deal.company_id, changes: ['nurture'] }, actorUserId));
  plan.audits.push(dealAudit(deal, 'deal.updated', { before: { nurture: deal.nurture }, after: { nurture }, meta: bulk ? { bulk: true } : undefined }));
  return plan;
}
