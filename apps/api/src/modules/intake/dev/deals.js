import { randomUUID } from 'node:crypto';
import { json } from '../../../lib/db.js';
import { errors } from '../../../lib/errors.js';
import { emitEvent } from '../../../core/events.js';
import { writeAudit } from '../../../core/audit.js';
import { getEffectiveSettings, getSetting } from '../../../core/settings.js';
import { channelHasFirstReplySla } from '../../../core/crm/channels.js';
import { addTimelineEvent } from '../../../core/crm/timeline.js';
import { refreshSearchDocument } from '../../../core/crm/search.js';
import { firstReplySlaSetting, referencePrefixSetting } from '../../../core/crm/settings.js';
import { settingDefinitions } from '../../settings/definitions.js';

// DEVELOPMENT AND TEST implementation of the intake deals port, written against the phase 2
// contract's tables (docs/crm/PHASE2_CONTRACT.md §5.8, §9.6 create rules, §11.2 timeline rules).
//
// TODO(integrator): connect the deals slice instead, at start-up:
//   connectIntakePorts({ deals: {
//     createDeal: (trx, input, ctx) => dealsService.createDeal(trx, toDealCreateBody(input), { actor: { type: 'system' } }),
//     reopenDeal: (trx, input, ctx) => dealsService.reopen(trx, input.dealId, { stageId: undefined }, ...) + assign when ownerUserId,
//     touchDeal:  (trx, input) => dealsService.patch(trx, input.dealId, { lastTouch: input.lastTouch }, { actor: { type: 'system' } }),
//   } })
// ports.js refuses to use this file in production, so nothing here inserts deals there.

const currencySetting = settingDefinitions.find((d) => d.key === 'locale.currency');
const TOUCH_KEYS = ['channel', 'campaign', 'utm', 'referrer', 'partnerId', 'landingUrl', 'formId', 'adId', 'at'];
const MESSAGE_KIND = { email: 'email', voice_call: 'call' };

const loadUnit = (trx, id) => trx('org_units').where({ id }).first();
const pickTouch = (touch) => Object.fromEntries(Object.entries(touch ?? {}).filter(([k, v]) => TOUCH_KEYS.includes(k) && v !== undefined && v !== null));

async function openStage(trx, pipelineId, preferredStageId) {
  const stages = await trx('pipeline_stages').where({ pipeline_id: pipelineId }).whereNull('archived_at').orderBy('position');
  return (preferredStageId && stages.find((s) => s.id === preferredStageId && s.category === 'open')) ?? stages.find((s) => s.category === 'open') ?? null;
}

async function ensureHousehold(trx, { groupId, primary, studentIds, actorUserId }) {
  const existing = await trx('household_members as hm')
    .join('households as h', 'h.id', 'hm.household_id')
    .where('hm.contact_id', primary.id)
    .whereIn('hm.role', ['parent', 'guardian'])
    .whereNull('h.archived_at')
    .orderBy('h.created_at')
    .first('h.id');
  let householdId = existing?.id;
  if (!householdId) {
    householdId = randomUUID();
    await trx('households').insert({
      id: householdId,
      group_id: groupId,
      name: `${primary.last_name || primary.display_name} family`,
      city: primary.city ?? null,
      created_by: actorUserId,
    });
    await trx('household_members').insert({ household_id: householdId, contact_id: primary.id, role: 'parent', is_primary: true });
  }
  if (studentIds.length) {
    await trx('household_members')
      .insert(studentIds.map((id) => ({ household_id: householdId, contact_id: id, role: 'student', is_primary: false })))
      .onConflict(['household_id', 'contact_id'])
      .ignore();
  }
  return householdId;
}

/**
 * Create a lead the way the deals service does (contract §9.6 create rules 2–12), for a system
 * caller. Idempotent on `sourceEventId`.
 * @returns {Promise<{ deal: object, created: boolean }>}
 */
export async function createDeal(trx, input, { req = null, registry } = {}) {
  if (input.sourceEventId) {
    const existing = await trx('deals').where({ source_event_id: input.sourceEventId }).first();
    if (existing) return { deal: existing, created: false };
  }
  const unit = await loadUnit(trx, input.unitId);
  const pipeline = await trx('pipelines')
    .where({ company_id: input.companyId, kind: input.kind, is_default: true })
    .whereNull('archived_at')
    .first();
  if (!pipeline) throw errors.validation([{ path: 'pipelineId', message: 'The company has no default pipeline for these leads' }]);
  const stage = await openStage(trx, pipeline.id, input.stageId);
  if (!stage) throw errors.validation([{ path: 'stageId', message: 'The pipeline has no open stage' }]);

  const [{ value: number }] = await trx.raw(
    `insert into crm_sequences (company_id, name, value) values (?, 'deal', 1)
     on conflict (company_id, name) do update set value = crm_sequences.value + 1 returning value`,
    [input.companyId],
  ).then((r) => r.rows);
  const company = await loadUnit(trx, input.companyId);
  const prefix = await getSetting(company, referencePrefixSetting, trx);
  const unitSettings = await getEffectiveSettings(unit, [currencySetting, firstReplySlaSetting], trx);
  const currency = unitSettings[currencySetting.key].value;
  const replyMinutes = unitSettings[firstReplySlaSetting.key].value;

  const primary = input.primaryContactId ? await trx('contacts').where({ id: input.primaryContactId }).first() : null;
  const account = input.accountId ? await trx('accounts').where({ id: input.accountId }).first() : null;
  const productLine = input.productLineId ? await trx('product_lines').where({ id: input.productLineId }).first() : null;
  const studentIds = [...new Set(input.studentContactIds ?? [])].filter((id) => id !== primary?.id);
  const householdId = input.kind === 'b2c' && primary && studentIds.length
    ? await ensureHousehold(trx, { groupId: input.groupId, primary, studentIds, actorUserId: input.actorUserId ?? null })
    : null;

  const now = new Date();
  const firstTouch = { ...pickTouch(input.firstTouch), channel: input.channel, at: input.firstTouch?.at ?? now.toISOString() };
  const title = input.title || `${primary?.display_name ?? account?.name ?? 'Enquiry'} – ${productLine?.name ?? 'Enquiry'}`;
  const [deal] = await trx('deals')
    .insert({
      id: randomUUID(),
      group_id: input.groupId,
      company_id: input.companyId,
      unit_id: input.unitId,
      number: Number(number),
      ref: `${prefix}-${number}`,
      title: title.slice(0, 200),
      kind: input.kind,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      status: 'open',
      product_line_id: productLine?.id ?? null,
      owner_user_id: input.ownerUserId ?? null,
      value_minor: 0,
      currency,
      primary_contact_id: primary?.id ?? null,
      household_id: householdId,
      account_id: account?.id ?? null,
      channel: input.channel,
      first_touch: json(firstTouch),
      last_touch: json(firstTouch),
      original_message: input.originalMessage ? json(input.originalMessage) : null,
      ai_fields: json(input.aiFields ?? {}),
      custom: json(input.custom ?? {}),
      tags: input.tags ?? [],
      stage_entered_at: now,
      sla_due_at: stage.sla_hours ? new Date(now.getTime() + stage.sla_hours * 3_600_000) : null,
      first_reply_due_at: channelHasFirstReplySla(registry, input.channel) ? new Date(now.getTime() + replyMinutes * 60_000) : null,
      last_activity_at: now,
      source_event_id: input.sourceEventId ?? null,
      created_by: input.actorUserId ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning('*');

  const participants = [];
  if (primary) participants.push({ deal_id: deal.id, contact_id: primary.id, role: input.kind === 'b2b' ? 'decision_maker' : 'parent' });
  for (const id of studentIds) participants.push({ deal_id: deal.id, contact_id: id, role: 'student' });
  if (participants.length) await trx('deal_contacts').insert(participants).onConflict(['deal_id', 'contact_id']).ignore();

  await trx('deal_stage_history').insert({
    deal_id: deal.id,
    group_id: deal.group_id,
    company_id: deal.company_id,
    pipeline_id: pipeline.id,
    from_stage_id: null,
    to_stage_id: stage.id,
    from_status: null,
    to_status: 'open',
    moved_by_user_id: input.actorUserId ?? null,
    seconds_in_from_stage: null,
    moved_at: now,
  });

  const actor = { actorType: input.actorUserId ? 'user' : 'system', actorUserId: input.actorUserId ?? null };
  const subject = { groupId: deal.group_id, companyId: deal.company_id, unitId: deal.unit_id, dealId: deal.id, contactId: primary?.id ?? null, accountId: account?.id ?? null };
  await addTimelineEvent(trx, { ...subject, ...actor, kind: 'system', title: 'Lead created', meta: { action: 'deal.created', channel: deal.channel, ref: deal.ref }, touchDeal: false });
  if (input.originalMessage?.text) {
    await addTimelineEvent(trx, {
      ...subject,
      kind: MESSAGE_KIND[input.channel] ?? 'message',
      channel: input.channel,
      direction: 'inbound',
      title: input.originalMessage.subject ?? null,
      body: input.originalMessage.text,
      meta: { original: true },
      actorType: 'contact',
      occurredAt: input.originalMessage.receivedAt,
      sourceEventId: input.sourceEventId ? `${input.sourceEventId}:message` : null,
      touchDeal: false,
    });
  }
  await refreshSearchDocument(trx, 'deal', deal.id);
  await emitEvent(trx, {
    type: 'deal.created',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'deal',
    aggregateId: deal.id,
    actorUserId: input.actorUserId ?? null,
    payload: {
      dealId: deal.id, companyId: deal.company_id, unitId: deal.unit_id, pipelineId: deal.pipeline_id, stageId: deal.stage_id,
      kind: deal.kind, channel: deal.channel, ownerUserId: deal.owner_user_id, primaryContactId: deal.primary_contact_id,
      accountId: deal.account_id, productLineId: deal.product_line_id, valueMinor: 0, currency: deal.currency, sourceEventId: deal.source_event_id,
    },
  });
  await writeAudit(trx, req, {
    action: 'deal.created',
    entityType: 'deal',
    entityId: deal.id,
    unit: { id: deal.unit_id, root_id: deal.group_id },
    actorType: input.actorUserId ? 'user' : 'system',
    after: { ref: deal.ref, kind: deal.kind, channel: deal.channel, stageId: deal.stage_id, ownerUserId: deal.owner_user_id },
  });
  return { deal, created: true };
}

/**
 * Reopen a lost (or won) lead in the open stage it left, as POST /deals/:id/reopen does, and
 * restart its first-reply target for the new enquiry. Optionally hand it to a new owner.
 */
export async function reopenDeal(trx, { dealId, ownerUserId, actorUserId = null, restartFirstReply = true }, { req = null, registry } = {}) {
  const deal = await trx('deals').where({ id: dealId }).forUpdate().first();
  if (!deal || deal.status === 'open') return { deal, reopened: false };
  const left = await trx('deal_stage_history')
    .where({ deal_id: deal.id })
    .whereNot('to_status', 'open')
    .orderBy([{ column: 'moved_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .first('from_stage_id');
  const stage = await openStage(trx, deal.pipeline_id, left?.from_stage_id);
  if (!stage) throw errors.conflict('The pipeline has no open stage to reopen the lead in');
  const now = new Date();
  const unit = await loadUnit(trx, deal.unit_id);
  const replyMinutes = await getSetting(unit, firstReplySlaSetting, trx);
  const ownerChanged = ownerUserId !== undefined && ownerUserId !== deal.owner_user_id;
  const [updated] = await trx('deals')
    .where({ id: deal.id })
    .update({
      stage_id: stage.id,
      status: 'open',
      closed_at: null,
      lost_reason_id: null,
      lost_note: null,
      nurture: false,
      stage_entered_at: now,
      sla_due_at: stage.sla_hours ? new Date(now.getTime() + stage.sla_hours * 3_600_000) : null,
      sla_breached_at: null,
      ...(restartFirstReply && channelHasFirstReplySla(registry, deal.channel)
        ? { first_reply_due_at: new Date(now.getTime() + replyMinutes * 60_000), first_replied_at: null, first_reply_breached_at: null }
        : {}),
      ...(ownerChanged ? { owner_user_id: ownerUserId } : {}),
      updated_at: now,
    })
    .returning('*');
  const seconds = deal.stage_entered_at ? Math.max(0, Math.round((now - new Date(deal.stage_entered_at)) / 1000)) : null;
  await trx('deal_stage_history').insert({
    deal_id: deal.id, group_id: deal.group_id, company_id: deal.company_id, pipeline_id: deal.pipeline_id,
    from_stage_id: deal.stage_id, to_stage_id: stage.id, from_status: deal.status, to_status: 'open',
    moved_by_user_id: actorUserId, seconds_in_from_stage: seconds, moved_at: now,
  });
  const subject = { groupId: deal.group_id, companyId: deal.company_id, unitId: deal.unit_id, dealId: deal.id, contactId: deal.primary_contact_id, accountId: deal.account_id };
  await addTimelineEvent(trx, {
    ...subject,
    kind: 'stage_change',
    title: `Reopened in ${stage.name}`,
    meta: { fromStageId: deal.stage_id, toStageId: stage.id, fromStatus: deal.status, toStatus: 'open', lostReasonId: null, lostNote: null },
    actorType: actorUserId ? 'user' : 'system',
    actorUserId,
  });
  const base = { groupId: deal.group_id, unitId: deal.unit_id, aggregateType: 'deal', aggregateId: deal.id, actorUserId };
  await emitEvent(trx, {
    ...base,
    type: 'deal.stage_changed',
    payload: {
      dealId: deal.id, companyId: deal.company_id, unitId: deal.unit_id, pipelineId: deal.pipeline_id, fromStageId: deal.stage_id,
      toStageId: stage.id, fromStatus: deal.status, toStatus: 'open', secondsInFromStage: seconds, lostReasonId: null,
    },
  });
  await emitEvent(trx, { ...base, type: 'deal.reopened', payload: { dealId: deal.id, companyId: deal.company_id, stageId: stage.id, previousStatus: deal.status } });
  if (ownerChanged) {
    await addTimelineEvent(trx, { ...subject, kind: 'system', title: ownerUserId ? 'Assigned by intake' : 'Unassigned', meta: { action: 'deal.owner_changed', fromUserId: deal.owner_user_id, toUserId: ownerUserId } });
    await emitEvent(trx, { ...base, type: 'deal.owner_changed', payload: { dealId: deal.id, companyId: deal.company_id, unitId: deal.unit_id, fromUserId: deal.owner_user_id, toUserId: ownerUserId } });
  }
  await refreshSearchDocument(trx, 'deal', deal.id);
  await writeAudit(trx, req, {
    action: 'deal.reopened',
    entityType: 'deal',
    entityId: deal.id,
    unit: { id: deal.unit_id, root_id: deal.group_id },
    actorType: actorUserId ? 'user' : 'system',
    before: { status: deal.status, stageId: deal.stage_id },
    after: { status: 'open', stageId: stage.id },
  });
  return { deal: updated, reopened: true };
}

/** Record the latest touch on a lead (PATCH /deals/:id { lastTouch }). */
export async function touchDeal(trx, { dealId, lastTouch }) {
  const touch = pickTouch(lastTouch);
  const [deal] = await trx('deals').where({ id: dealId }).update({ last_touch: json(touch), updated_at: trx.fn.now() }).returning('*');
  if (!deal) return;
  await emitEvent(trx, {
    type: 'deal.updated',
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'deal',
    aggregateId: deal.id,
    payload: { dealId: deal.id, companyId: deal.company_id, changes: ['lastTouch'] },
  });
  await refreshSearchDocument(trx, 'deal', dealId);
}
