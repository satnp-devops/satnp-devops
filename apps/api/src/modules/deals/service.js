import { randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { getSetting } from '../../core/settings.js';
import { channelHasFirstReplySla, isKnownChannel } from '../../core/crm/channels.js';
import { findOrCreateContact } from '../../core/crm/contacts.js';
import { validateCustomValues, withoutMaskedEchoes } from '../../core/crm/customFields.js';
import { formatMoney } from '../../core/crm/money.js';
import {
  companyForUnit,
  companyOf,
  loadVisibleAccount,
  loadVisibleContact,
  requireCreateUnit,
  requireRecord,
  unitsIndex,
  userLevelAt,
} from '../../core/crm/scope.js';
import { refreshSearchDocument } from '../../core/crm/search.js';
import {
  crmSetting,
  defaultCountrySetting,
  firstReplySlaSetting,
  fuzzyMatchThresholdSetting,
  referencePrefixSetting,
} from '../../core/crm/settings.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { settingDefinitions } from '../settings/definitions.js';
import { loadDealForView, presentDetail } from './queries.js';
import {
  dealAudit,
  dealEvent,
  dealTimelineBase,
  firstStage,
  loadPlanContext,
  planArchive,
  planAssign,
  planMove,
  planRestore,
  stageRulesError,
} from './plans.js';
import { computeSla } from './sla.js';
import { evaluateStageMove } from './stageRules.js';
import { commitPlans } from './writes.js';

// Writes of the deals module (docs/crm/PHASE2_CONTRACT.md §9.6). Every write is one transaction
// with the audit entry, the outbox event, the timeline entry (§11.2) and the search document.

const MANAGE = 'deals.manage';
const currencySetting = settingDefinitions.find((definition) => definition.key === 'locale.currency');
const field = (path, message) => errors.validation([{ path, message }]);
const DEFAULT_ROLE = { b2c: 'parent', b2b: 'decision_maker' };

/** The person or system making a change. */
function actorFrom(ctx) {
  const req = ctx.req ?? null;
  return {
    req,
    userId: req?.auth?.user?.id ?? ctx.actor?.userId ?? null,
    actorType: req ? 'user' : (ctx.actor?.type ?? 'system'),
    registry: req?.app?.locals?.registry ?? ctx.registry,
  };
}

async function notFoundAs(path, message, load) {
  try {
    return await load();
  } catch (err) {
    if (err?.status === 404) throw field(path, message);
    throw err;
  }
}

/** A person the actor may attach to a deal: visible (people) or simply in the group (system callers). */
async function attachableContact(trx, actor, contactId, { groupId, path }) {
  const contact = actor.req
    ? (await notFoundAs(path, 'Contact not found', () => loadVisibleContact(actor.req, contactId, { trx }))).contact
    : await trx('contacts').where({ id: contactId }).whereNull('merged_into_id').first();
  if (!contact || contact.group_id !== groupId) throw field(path, 'Contact not found');
  if (contact.erased_at) throw field(path, "This person's data was erased on request");
  return contact;
}

async function attachableAccount(trx, actor, accountId, { groupId, path }) {
  const account = actor.req
    ? (await notFoundAs(path, 'Institute not found', () => loadVisibleAccount(actor.req, accountId, { trx }))).account
    : await trx('accounts').where({ id: accountId }).whereNull('merged_into_id').first();
  if (!account || account.group_id !== groupId) throw field(path, 'Institute not found');
  return account;
}

/**
 * The company now knows this person (or institute) through a deal: make sure it has a link row.
 * A new link writes what findOrCreateContact would: timeline entry, event and audit.
 */
async function ensureCompanyLink(trx, actor, kind, { recordId, groupId, companyId, unitId, ownerUserId, source }) {
  const table = kind === 'contact' ? 'contact_companies' : 'account_companies';
  const key = kind === 'contact' ? 'contact_id' : 'account_id';
  const [link] = await trx(table)
    .insert({
      id: randomUUID(),
      [key]: recordId,
      group_id: groupId,
      company_id: companyId,
      unit_id: unitId,
      owner_user_id: ownerUserId ?? null,
      status: 'lead',
      source: source ? json(source) : null,
      tags: [],
      created_by: actor.userId,
    })
    .onConflict([key, 'company_id'])
    .ignore()
    .returning('*');
  if (!link) return;
  await addTimelineEvent(trx, {
    groupId,
    companyId,
    unitId,
    [kind === 'contact' ? 'contactId' : 'accountId']: recordId,
    kind: 'system',
    title: kind === 'contact' ? 'Contact added to this company' : 'Institute added to this company',
    meta: { action: `${kind}.company_linked`, channel: source?.channel ?? null },
    actorType: actor.actorType,
    actorUserId: actor.userId,
  });
  await emitEvent(trx, {
    type: `${kind}.company_linked`,
    groupId,
    unitId,
    aggregateType: kind,
    aggregateId: recordId,
    actorUserId: actor.userId,
    payload: { [`${kind}Id`]: recordId, companyId, unitId, matchedBy: null, source: source?.channel ? { channel: source.channel } : null },
  });
  await writeAudit(trx, actor.req, {
    action: `${kind}.linked`,
    entityType: kind,
    entityId: recordId,
    unit: { id: unitId, root_id: groupId },
    after: { companyId },
    actorType: actor.actorType,
    actorUserId: actor.userId ?? undefined,
  });
}

/**
 * Product line and product: same company, active (when newly picked), sold to this kind of deal,
 * and the product inside the line. A product without a line brings its own line.
 */
async function resolveProduct(trx, { companyId, kind, productLineId, productId, keepLineId = null, keepProductId = null }) {
  let product = null;
  if (productId) {
    product = await trx('products').where({ id: productId }).first();
    if (!product || product.company_id !== companyId) throw field('body.productId', 'Product not found');
    if (!product.active && product.id !== keepProductId) throw field('body.productId', 'This product is no longer offered');
  }
  const lineId = productLineId ?? product?.product_line_id ?? null;
  let line = null;
  if (lineId) {
    line = await trx('product_lines').where({ id: lineId }).first();
    if (!line || line.company_id !== companyId) throw field('body.productLineId', 'Product line not found');
    if (!line.active && line.id !== keepLineId) throw field('body.productLineId', 'This product line is no longer offered');
    if (line.audience !== kind) {
      throw field('body.productLineId', kind === 'b2c' ? 'This product line is sold to institutes' : 'This product line is sold to families');
    }
  }
  if (product && line && product.product_line_id !== line.id) throw field('body.productId', "This product isn't in the chosen product line");
  return { line, product };
}

async function resolvePipeline(trx, { companyId, kind, pipelineId }) {
  if (pipelineId) {
    const pipeline = await trx('pipelines').where({ id: pipelineId }).first();
    if (!pipeline || pipeline.company_id !== companyId || pipeline.archived_at) throw field('body.pipelineId', 'Pipeline not found');
    if (pipeline.kind !== kind) throw field('body.pipelineId', kind === 'b2c' ? 'Pick a pipeline for families' : 'Pick a pipeline for institutes');
    return pipeline;
  }
  const pipeline = await trx('pipelines')
    .where({ company_id: companyId, kind })
    .whereNull('archived_at')
    .orderBy([{ column: 'is_default', order: 'desc' }, 'position', 'name'])
    .first();
  if (!pipeline) throw field('body.pipelineId', 'This company has no pipeline for this kind of lead yet. Set one up in Settings › Pipelines.');
  return pipeline;
}

/**
 * The family of a B2C deal (contract §9.6 create rule 4): the given household (it must include the
 * main contact), else the first household where the main contact is a parent or guardian, else a
 * new "<surname> family" when the deal has students. New students join it.
 */
async function resolveHousehold(trx, actor, { groupId, householdId, parent, students, path = 'body.householdId' }) {
  let household = null;
  if (householdId) {
    household = await trx('households').where({ id: householdId, group_id: groupId }).whereNull('archived_at').first();
    const member = household && (await trx('household_members').where({ household_id: household.id, contact_id: parent.id }).first());
    if (!household || !member) throw field(path, 'Pick a family the main contact belongs to');
  } else {
    household = await trx('household_members as hm')
      .join('households as h', 'h.id', 'hm.household_id')
      .where('hm.contact_id', parent.id)
      .whereIn('hm.role', ['parent', 'guardian'])
      .whereNull('h.archived_at')
      .orderBy('hm.created_at')
      .first('h.*');
  }
  if (!household && students.length === 0) return null;
  const audit = { actorType: actor.actorType, actorUserId: actor.userId ?? undefined };

  if (!household) {
    const name = `${parent.last_name || parent.display_name} family`;
    [household] = await trx('households')
      .insert({ id: randomUUID(), group_id: groupId, name, city: parent.city ?? null, created_by: actor.userId })
      .returning('*');
    const members = [
      { household_id: household.id, contact_id: parent.id, role: 'parent', relation: null, is_primary: true },
      ...students.map((s) => ({ household_id: household.id, contact_id: s.id, role: 'student', relation: null, is_primary: false })),
    ];
    await trx('household_members').insert(members);
    await emitEvent(trx, {
      type: 'household.created',
      groupId,
      aggregateType: 'household',
      aggregateId: household.id,
      actorUserId: actor.userId,
      payload: { householdId: household.id, memberIds: members.map((m) => m.contact_id) },
    });
    await writeAudit(trx, actor.req, { action: 'household.created', entityType: 'household', entityId: household.id, groupId, after: { name }, ...audit });
    return household;
  }

  const existing = new Set(
    await trx('household_members')
      .where({ household_id: household.id })
      .whereIn('contact_id', students.map((s) => s.id))
      .pluck('contact_id'),
  );
  for (const student of students.filter((s) => !existing.has(s.id))) {
    await trx('household_members').insert({ household_id: household.id, contact_id: student.id, role: 'student', relation: null, is_primary: false });
    await addTimelineEvent(trx, {
      groupId,
      contactId: student.id,
      kind: 'system',
      title: `Added to the ${household.name}`,
      meta: { action: 'household.member_added', householdId: household.id },
      actorType: actor.actorType,
      actorUserId: actor.userId,
    });
    await emitEvent(trx, {
      type: 'household.member_added',
      groupId,
      aggregateType: 'household',
      aggregateId: household.id,
      actorUserId: actor.userId,
      payload: { householdId: household.id, contactId: student.id, role: 'student' },
    });
    await writeAudit(trx, actor.req, {
      action: 'household.member_added',
      entityType: 'household',
      entityId: household.id,
      groupId,
      after: { contactId: student.id, role: 'student' },
      ...audit,
    });
  }
  return household;
}

const contactFields = (input) => ({
  firstName: input.firstName,
  lastName: input.lastName,
  phones: input.phones,
  emails: input.emails,
  city: input.city,
  countryCode: input.countryCode,
  timeZone: input.timeZone,
  language: input.language,
  studentProfile: input.studentProfile,
});

async function contactFacts(trx, contactId, studentCount) {
  const kinds = contactId ? new Set(await trx('contact_methods').where({ contact_id: contactId }).distinct().pluck('kind')) : new Set();
  return { studentCount, contactHasPhone: kinds.has('phone') || kinds.has('whatsapp'), contactHasEmail: kinds.has('email') };
}

/** The entry for the enquiry's first message, as it arrived. */
function originalMessageEntry(deal, message) {
  const kind = message.channel === 'email' ? 'email' : message.channel === 'voice_call' ? 'call' : 'message';
  return {
    ...dealTimelineBase(deal),
    kind,
    channel: message.channel,
    direction: 'inbound',
    title: message.subject ?? null,
    body: message.text,
    meta: { original: true, ...(message.subject ? { subject: message.subject } : {}) },
    actorType: 'contact',
    occurredAt: message.receivedAt,
  };
}

// ---------- Create ----------

/**
 * Create a lead (contract §9.6 create rules). Exported for intake and imports.
 *   ctx: { req } for people; { actor: { type: 'system' | 'ai', userId? }, registry } for system callers,
 *   which skip permission checks and required custom fields.
 *   ctx.reopenLost (system callers): when the person already has a lost lead of this kind in the
 *   company, reopen it instead of creating a new one ("a family that enquires again reopens their record").
 * @returns {Promise<{ deal: object, created: boolean, reopened?: boolean }>}
 */
export async function createDeal(trx, input, ctx = {}) {
  const actor = actorFrom(ctx);
  const { req, userId, registry } = actor;
  const system = !req;
  const now = new Date();
  const kind = input.kind;

  if (input.sourceEventId) {
    await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`crm.deal:${input.sourceEventId}`]);
    const existing = await trx('deals').where({ source_event_id: input.sourceEventId }).first();
    if (existing) return { deal: existing, created: false };
  }

  let unit;
  let company;
  if (req) ({ unit, company } = await requireCreateUnit(req, input.unitId, MANAGE, { trx }));
  else {
    unit = await trx('org_units').where({ id: input.unitId }).first();
    company = unit ? await companyForUnit(unit, trx) : null;
    if (!unit || !company) throw field('body.unitId', 'Pick a company, branch or team: leads belong to a company');
    if (unit.status !== 'active') throw errors.conflict(`${unit.name} is archived`);
  }
  const groupId = unit.root_id;

  const channel = input.channel ?? 'manual';
  if (!isKnownChannel(registry, channel)) throw field('body.channel', 'Unknown channel');
  if (input.firstTouch && !isKnownChannel(registry, input.firstTouch.channel)) throw field('body.firstTouch.channel', 'Unknown channel');
  if (input.originalMessage && !isKnownChannel(registry, input.originalMessage.channel)) {
    throw field('body.originalMessage.channel', 'Unknown channel');
  }
  if (input.primaryContactId && input.contact) throw field('body.contact', 'Give either an existing contact or a new one, not both');
  if (kind === 'b2c' && input.accountId) throw field('body.accountId', 'Institutes belong to B2B leads');
  if (kind === 'b2b' && input.students?.length) throw field('body.students', 'Students belong to B2C leads');
  if (kind === 'b2c' && !input.primaryContactId && !input.contact) throw field('body.contact', 'Add the parent or student this enquiry is about');
  if (kind === 'b2b' && !input.accountId && !input.primaryContactId && !input.contact) {
    throw field('body.contact', 'Add the institute or a person at it');
  }

  const pipeline = await resolvePipeline(trx, { companyId: company.id, kind, pipelineId: input.pipelineId });
  const stages = await trx('pipeline_stages').where({ pipeline_id: pipeline.id }).orderBy('position');
  let stage;
  if (input.stageId) {
    stage = stages.find((s) => s.id === input.stageId && !s.archived_at);
    if (!stage) throw field('body.stageId', 'Pick an active stage of this pipeline');
    if (stage.category === 'lost') throw field('body.stageId', "A new lead can't start in a lost stage");
  } else {
    stage = stages.find((s) => s.category === 'open' && !s.archived_at);
    if (!stage) throw field('body.stageId', 'This pipeline has no open stage');
  }

  const ownerUserId = input.ownerUserId === undefined ? userId : input.ownerUserId;
  if (req && ownerUserId !== userId && !req.access.can('deals.assign', unit.path)) {
    throw errors.forbidden('You can only add leads for yourself here');
  }
  let owner = null;
  if (ownerUserId) {
    const level = await userLevelAt(ownerUserId, unit, MANAGE, { trx });
    owner = level ? await trx('users').where({ id: ownerUserId }).first('id', 'name') : null;
    if (!owner) throw field('body.ownerUserId', `This person can't work leads in ${unit.name}`);
  }

  const { line, product } = await resolveProduct(trx, {
    companyId: company.id,
    kind,
    productLineId: input.productLineId ?? null,
    productId: input.productId ?? null,
  });

  const [defaultCountry, threshold, currency, prefix, replyMinutes, definitions] = await Promise.all([
    crmSetting(company, defaultCountrySetting, trx),
    crmSetting(company, fuzzyMatchThresholdSetting, trx),
    input.currency ? input.currency : getSetting(unit, currencySetting, trx),
    crmSetting(company, referencePrefixSetting, trx),
    crmSetting(unit, firstReplySlaSetting, trx),
    trx('custom_field_definitions').where({ company_id: company.id, entity: 'deal' }),
  ]);
  const custom = validateCustomValues(definitions, input.custom, { kind, enforceRequired: !system, defaultCountry });
  const firstTouch = input.firstTouch ?? { channel, at: now.toISOString() };

  // People.
  const findOrCreate = (contactInput, contactKind, path) =>
    findOrCreateContact(
      trx,
      {
        groupId,
        companyId: company.id,
        unitId: unit.id,
        kind: contactInput.kind ?? contactKind,
        ...contactFields(contactInput),
        ownerUserId,
        source: firstTouch,
        defaultCountry,
        nameThreshold: threshold,
        path,
        actorUserId: userId,
        actorType: actor.actorType,
      },
      { req },
    );
  const link = (kindOfRecord, recordId) =>
    ensureCompanyLink(trx, actor, kindOfRecord, { recordId, groupId, companyId: company.id, unitId: unit.id, ownerUserId, source: firstTouch });

  let account = null;
  if (input.accountId) {
    account = await attachableAccount(trx, actor, input.accountId, { groupId, path: 'body.accountId' });
    await link('account', account.id);
  }
  let primary = null;
  let primaryIsNew = false;
  if (input.primaryContactId) {
    primary = await attachableContact(trx, actor, input.primaryContactId, { groupId, path: 'body.primaryContactId' });
    await link('contact', primary.id);
  } else if (input.contact) {
    const result = await findOrCreate(input.contact, kind === 'b2c' ? 'parent' : 'staff', 'body.contact');
    primary = result.contact;
    primaryIsNew = result.created;
  } else if (account) {
    primary =
      (await trx('account_contacts as ac')
        .join('contacts as c', 'c.id', 'ac.contact_id')
        .where('ac.account_id', account.id)
        .whereNull('c.merged_into_id')
        .whereNull('c.erased_at')
        .orderBy([{ column: 'ac.is_primary', order: 'desc' }, 'ac.created_at'])
        .first('c.*')) ?? null;
  }

  // A family that enquires again: reopen their lost lead instead of creating another (system callers).
  if (ctx.reopenLost && primary && !primaryIsNew) {
    const lost = await trx('deals')
      .where({ company_id: company.id, kind, primary_contact_id: primary.id, status: 'lost' })
      .whereNull('archived_at')
      .orderBy('closed_at', 'desc')
      .forUpdate()
      .first();
    if (lost) return { deal: await reopenForEnquiry(trx, actor, lost, { input, firstTouch, now }), created: false, reopened: true };
  }

  const students = [];
  for (const [index, ref] of (input.students ?? []).entries()) {
    const student = ref.contactId
      ? await attachableContact(trx, actor, ref.contactId, { groupId, path: `body.students.${index}.contactId` })
      : (await findOrCreate(ref.contact, 'student', `body.students.${index}.contact`)).contact;
    if (ref.contactId) await link('contact', student.id);
    if (student.id !== primary?.id && !students.some((s) => s.id === student.id)) students.push(student);
  }

  const household =
    kind === 'b2c' && primary
      ? await resolveHousehold(trx, actor, { groupId, householdId: input.householdId ?? null, parent: primary, students })
      : null;

  const draft = {
    kind,
    pipeline_id: pipeline.id,
    stage_id: null,
    status: 'open',
    product_line_id: line?.id ?? null,
    product_id: product?.id ?? null,
    owner_user_id: ownerUserId ?? null,
    value_minor: input.valueMinor ?? 0,
    expected_close_on: input.expectedCloseOn ?? null,
    primary_contact_id: primary?.id ?? null,
    household_id: household?.id ?? null,
    account_id: account?.id ?? null,
    custom,
  };
  const rules = evaluateStageMove({
    deal: draft,
    fromStage: null,
    toStage: stage,
    pipelineStages: stages,
    facts: await contactFacts(trx, primary?.id, students.length),
    customDefinitions: definitions,
    mode: 'create',
  });
  if (!rules.ok) throw stageRulesError(rules, stage, stages);

  const { rows } = await trx.raw(
    `insert into crm_sequences (company_id, name, value) values (?, 'deal', 1)
     on conflict (company_id, name) do update set value = crm_sequences.value + 1
     returning value`,
    [company.id],
  );
  const number = Number(rows[0].value);
  const subject = account?.name ?? primary?.display_name ?? 'New lead';
  const status = stage.category;
  const sla = computeSla({
    status,
    stageEnteredAt: now,
    slaHours: stage.sla_hours,
    createdAt: now,
    firstReplySlaMinutes: replyMinutes,
    channelHasFirstReplySla: channelHasFirstReplySla(registry, channel),
  });

  const [deal] = await trx('deals')
    .insert({
      id: randomUUID(),
      group_id: groupId,
      company_id: company.id,
      unit_id: unit.id,
      number,
      ref: `${prefix}-${number}`,
      title: input.title || `${subject} – ${line?.name ?? 'Enquiry'}`,
      kind,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      status,
      product_line_id: draft.product_line_id,
      product_id: draft.product_id,
      owner_user_id: draft.owner_user_id,
      owner_seen_at: ownerUserId && ownerUserId === userId && !system ? now : null,
      value_minor: draft.value_minor,
      currency,
      primary_contact_id: draft.primary_contact_id,
      household_id: draft.household_id,
      account_id: draft.account_id,
      channel,
      first_touch: json(firstTouch),
      last_touch: json(firstTouch),
      original_message: input.originalMessage ? json(input.originalMessage) : null,
      custom: json(custom),
      tags: input.tags ?? [],
      nurture: input.nurture ?? false,
      stage_entered_at: now,
      sla_due_at: sla.slaDueAt,
      first_reply_due_at: sla.firstReplyDueAt,
      expected_close_on: draft.expected_close_on,
      closed_at: status === 'open' ? null : now,
      last_activity_at: now,
      source_event_id: input.sourceEventId ?? null,
      created_by: userId,
      created_at: now,
      updated_at: now,
    })
    .returning('*');

  const participants = [
    ...(primary ? [{ deal_id: deal.id, contact_id: primary.id, role: DEFAULT_ROLE[kind] }] : []),
    ...students.map((s) => ({ deal_id: deal.id, contact_id: s.id, role: 'student' })),
  ];
  if (participants.length) await trx('deal_contacts').insert(participants);
  await trx('deal_stage_history').insert({
    deal_id: deal.id,
    group_id: groupId,
    company_id: company.id,
    pipeline_id: pipeline.id,
    from_stage_id: null,
    to_stage_id: stage.id,
    from_status: null,
    to_status: status,
    moved_by_user_id: userId,
    moved_at: now,
  });

  await addTimelineEvent(trx, {
    ...dealTimelineBase(deal),
    kind: 'system',
    channel,
    direction: 'internal',
    title: 'Lead created',
    meta: { action: 'deal.created', channel, ref: deal.ref },
    actorType: actor.actorType,
    actorUserId: userId,
    occurredAt: now,
  });
  if (input.originalMessage) await addTimelineEvent(trx, originalMessageEntry(deal, input.originalMessage));
  await refreshSearchDocument(trx, 'deal', deal.id);
  await emitEvent(
    trx,
    dealEvent(
      deal,
      'deal.created',
      {
        dealId: deal.id,
        companyId: company.id,
        unitId: unit.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        kind,
        channel,
        ownerUserId: deal.owner_user_id ?? null,
        primaryContactId: deal.primary_contact_id ?? null,
        accountId: deal.account_id ?? null,
        productLineId: deal.product_line_id ?? null,
        valueMinor: Number(deal.value_minor),
        currency,
        sourceEventId: deal.source_event_id ?? null,
      },
      userId,
    ),
  );
  await writeAudit(trx, req, {
    ...dealAudit(deal, 'deal.created', {
      after: { ref: deal.ref, kind, pipelineId: pipeline.id, stageId: stage.id, ownerUserId: deal.owner_user_id ?? null, channel },
    }),
    actorType: actor.actorType,
    actorUserId: userId ?? undefined,
  });
  return { deal, created: true };
}

/** Reopen a lost lead for a new enquiry from the same person (system callers of createDeal). */
async function reopenForEnquiry(trx, actor, lost, { input, firstTouch, now }) {
  const ctx = await loadPlanContext(trx, [lost], { now, userId: actor.userId });
  ctx.actorType = actor.actorType;
  const toStage = firstStage(ctx, lost.pipeline_id, 'open');
  if (!toStage) throw errors.conflict('This pipeline has no open stage');
  let plan;
  try {
    plan = await planMove(lost, toStage, { mode: 'reopen', companyUnit: { id: lost.company_id } }, ctx);
  } catch (err) {
    // Required fields of the first stage can't block an enquiry: create a new lead instead.
    if (err?.code === 'stage_rules') return createDeal(trx, input, { actor: { type: actor.actorType, userId: actor.userId }, registry: actor.registry }).then((r) => r.deal);
    throw err;
  }
  plan.update.last_touch = json(firstTouch);
  if (input.originalMessage) plan.timeline.push({ ...originalMessageEntry(lost, input.originalMessage), occurredAt: input.originalMessage.receivedAt });
  await commitPlans(trx, actor.req, [plan], now);
  return trx('deals').where({ id: lost.id }).first();
}

/** POST /deals */
export async function createDealForRequest(req, body) {
  const result = await db.transaction((trx) => createDeal(trx, body, { req }));
  return { created: result.created, data: await presentDetail(req, result.deal) };
}

// ---------- Update ----------

const SIGNIFICANT = ['valueMinor', 'productLineId', 'productId', 'expectedCloseOn', 'primaryContactId', 'accountId'];

/**
 * Apply dealFieldsPatch (and unitId) to a locked deal: validate, write, timeline entry for the
 * significant changes, deal.updated (+ deal.unit_changed), audit and search. Returns the new row.
 */
export async function applyDealFields(trx, req, deal, patch, { unitId } = {}) {
  const actor = actorFrom({ req });
  const registry = actor.registry;
  const units = await unitsIndex(req, trx);
  const company = units.get(deal.company_id);
  const changes = {};
  const before = {};
  const after = {};
  const changed = [];
  const notes = [];
  const set = (key, column, from, to) => {
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return false;
    changes[column] = to;
    before[key] = from ?? null;
    after[key] = to ?? null;
    changed.push(key);
    return true;
  };

  if (patch.title !== undefined) set('title', 'title', deal.title, patch.title);

  if (patch.productLineId !== undefined || patch.productId !== undefined) {
    const lineId = patch.productLineId !== undefined ? patch.productLineId : deal.product_line_id;
    let productId = patch.productId !== undefined ? patch.productId : deal.product_id;
    if (patch.productId === undefined && productId && lineId !== deal.product_line_id) {
      const current = await trx('products').where({ id: productId }).first('product_line_id');
      if (current?.product_line_id !== lineId) productId = null;
    }
    const { line, product } = await resolveProduct(trx, {
      companyId: deal.company_id,
      kind: deal.kind,
      productLineId: lineId,
      productId,
      keepLineId: deal.product_line_id,
      keepProductId: deal.product_id,
    });
    if (set('productLineId', 'product_line_id', deal.product_line_id, line?.id ?? null)) {
      notes.push(line ? `Product line set to ${line.name}` : 'Product line cleared');
    }
    if (set('productId', 'product_id', deal.product_id, product?.id ?? null)) notes.push(product ? `Product set to ${product.name}` : 'Product cleared');
  }

  const valueChanged = set('valueMinor', 'value_minor', Number(deal.value_minor), patch.valueMinor ?? Number(deal.value_minor));
  const currencyChanged = set('currency', 'currency', deal.currency, patch.currency ?? deal.currency);
  if (valueChanged || currencyChanged) {
    notes.push(`Value changed to ${formatMoney(patch.valueMinor ?? Number(deal.value_minor), patch.currency ?? deal.currency)}`);
  }

  let primaryContact = null;
  if (patch.primaryContactId !== undefined && patch.primaryContactId !== deal.primary_contact_id) {
    primaryContact = await attachableContact(trx, actor, patch.primaryContactId, { groupId: deal.group_id, path: 'body.primaryContactId' });
    set('primaryContactId', 'primary_contact_id', deal.primary_contact_id, primaryContact.id);
    notes.push(`Main contact changed to ${primaryContact.display_name}`);
  }

  if (patch.accountId !== undefined && patch.accountId !== deal.account_id) {
    if (deal.kind === 'b2c' && patch.accountId) throw field('body.accountId', 'Institutes belong to B2B leads');
    const account = patch.accountId ? await attachableAccount(trx, actor, patch.accountId, { groupId: deal.group_id, path: 'body.accountId' }) : null;
    set('accountId', 'account_id', deal.account_id, account?.id ?? null);
    notes.push(account ? `Institute changed to ${account.name}` : 'Institute removed');
    if (account) {
      await ensureCompanyLink(trx, actor, 'account', {
        recordId: account.id,
        groupId: deal.group_id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        ownerUserId: deal.owner_user_id,
        source: deal.first_touch,
      });
    }
  }
  const primaryId = changes.primary_contact_id ?? deal.primary_contact_id;
  const accountId = 'account_id' in changes ? changes.account_id : deal.account_id;
  if (!primaryId && !accountId) throw field('body.accountId', 'A lead needs a main contact or an institute');

  if (patch.householdId !== undefined && patch.householdId !== deal.household_id) {
    if (patch.householdId) {
      const participantIds = [primaryId, ...(await trx('deal_contacts').where({ deal_id: deal.id }).pluck('contact_id'))].filter(Boolean);
      const household = await trx('households').where({ id: patch.householdId, group_id: deal.group_id }).whereNull('archived_at').first();
      const member = household && (await trx('household_members').where({ household_id: household.id }).whereIn('contact_id', participantIds).first());
      if (!member) throw field('body.householdId', 'Pick a family one of the lead’s people belongs to');
    }
    set('householdId', 'household_id', deal.household_id, patch.householdId);
  }

  if (patch.expectedCloseOn !== undefined && set('expectedCloseOn', 'expected_close_on', deal.expected_close_on, patch.expectedCloseOn)) {
    notes.push(patch.expectedCloseOn ? `Expected close date set to ${patch.expectedCloseOn}` : 'Expected close date cleared');
  }
  if (patch.tags !== undefined) set('tags', 'tags', deal.tags ?? [], patch.tags);
  if (patch.nurture !== undefined) set('nurture', 'nurture', deal.nurture, patch.nurture);
  if (patch.lastTouch !== undefined) {
    if (!isKnownChannel(registry, patch.lastTouch.channel)) throw field('body.lastTouch.channel', 'Unknown channel');
    if (set('lastTouch', 'last_touch', deal.last_touch, patch.lastTouch)) changes.last_touch = json(patch.lastTouch);
  }
  if (patch.custom !== undefined) {
    const [definitions, defaultCountry] = await Promise.all([
      trx('custom_field_definitions').where({ company_id: deal.company_id, entity: 'deal' }),
      crmSetting(company, defaultCountrySetting, trx),
    ]);
    // Someone who sees phone and email fields masked may send them back as shown: that's no change.
    const dealUnit = units.get(deal.unit_id);
    const seesPii = !req || Boolean(dealUnit && req.access.can('contacts.view_pii', dealUnit.path));
    const values = seesPii ? patch.custom : withoutMaskedEchoes(patch.custom, deal.custom, definitions);
    const custom = validateCustomValues(definitions, values, { existing: deal.custom ?? {}, kind: deal.kind, enforceRequired: true, defaultCountry });
    if (JSON.stringify(custom) !== JSON.stringify(deal.custom ?? {})) {
      const keys = [...new Set([...Object.keys(custom), ...Object.keys(deal.custom ?? {})])].filter(
        (key) => JSON.stringify(custom[key]) !== JSON.stringify(deal.custom?.[key]),
      );
      changes.custom = json(custom);
      before.custom = keys;
      after.custom = keys;
      changed.push('custom');
    }
  }

  let toUnit = null;
  if (unitId && unitId !== deal.unit_id) {
    toUnit = units.get(unitId);
    if (!toUnit || !req.access.canSee(toUnit.path)) throw field('body.unitId', 'Unit not found');
    if (companyOf(toUnit, units)?.id !== deal.company_id) throw field('body.unitId', 'Pick a unit of the same company');
    if (toUnit.status !== 'active') throw errors.conflict(`${toUnit.name} is archived`);
    if (!req.access.level(MANAGE, toUnit.path)) throw errors.forbidden(`You can't work leads in ${toUnit.name}`);
    if (deal.owner_user_id && !(await userLevelAt(deal.owner_user_id, toUnit, MANAGE, { trx }))) {
      throw field('body.unitId', `The owner can't work leads in ${toUnit.name}. Reassign the lead first.`);
    }
    set('unitId', 'unit_id', deal.unit_id, toUnit.id);
  }

  if (changed.length === 0) return deal;
  const now = new Date();
  const [updated] = await trx('deals')
    .where({ id: deal.id })
    .update({ ...changes, updated_at: now })
    .returning('*');

  if (primaryContact) {
    const participant = await trx('deal_contacts').where({ deal_id: deal.id, contact_id: primaryContact.id }).first();
    if (!participant) await trx('deal_contacts').insert({ deal_id: deal.id, contact_id: primaryContact.id, role: DEFAULT_ROLE[deal.kind] });
    await ensureCompanyLink(trx, actor, 'contact', {
      recordId: primaryContact.id,
      groupId: deal.group_id,
      companyId: deal.company_id,
      unitId: updated.unit_id,
      ownerUserId: updated.owner_user_id,
      source: deal.first_touch,
    });
  }

  const significant = changed.filter((key) => SIGNIFICANT.includes(key) || key === 'currency');
  if (notes.length && significant.length) {
    await addTimelineEvent(trx, {
      ...dealTimelineBase(updated),
      kind: 'system',
      direction: 'internal',
      title: notes.join(' · '),
      meta: {
        action: 'deal.updated',
        changes: Object.fromEntries(significant.map((key) => [key, { from: before[key], to: after[key] }])),
      },
      actorType: 'user',
      actorUserId: actor.userId,
      occurredAt: now,
    });
  }
  if (toUnit) {
    await addTimelineEvent(trx, {
      ...dealTimelineBase(updated),
      kind: 'system',
      direction: 'internal',
      title: `Moved to ${toUnit.name}`,
      meta: { action: 'deal.unit_changed', fromUnitId: deal.unit_id, toUnitId: toUnit.id },
      actorType: 'user',
      actorUserId: actor.userId,
      occurredAt: now,
    });
    await emitEvent(
      trx,
      dealEvent(updated, 'deal.unit_changed', { dealId: deal.id, companyId: deal.company_id, fromUnitId: deal.unit_id, toUnitId: toUnit.id }, actor.userId),
    );
  }
  await emitEvent(trx, dealEvent(updated, 'deal.updated', { dealId: deal.id, companyId: deal.company_id, changes: changed }, actor.userId));
  await writeAudit(trx, req, dealAudit(updated, 'deal.updated', { before, after }));
  await refreshSearchDocument(trx, 'deal', deal.id);
  return updated;
}

/** Lock a deal for a change by the user: visible, manage permission, not archived. */
async function lockForChange(trx, req, id, { permission = MANAGE, allowArchived = false } = {}) {
  const { row } = await loadDealForView(req, id, { trx, forUpdate: true });
  await requireRecord(req, permission, row, { trx, message: "You can't change this lead" });
  if (row.archived_at && !allowArchived) throw errors.conflict('This lead is archived. Restore it first.');
  return row;
}

/** PATCH /deals/:id */
export async function updateDeal(req, id, body) {
  const { unitId, ...patch } = body;
  const row = await db.transaction(async (trx) => {
    const deal = await lockForChange(trx, req, id);
    return applyDealFields(trx, req, deal, patch, { unitId });
  });
  return presentDetail(req, row);
}

// ---------- Stage moves ----------

async function stageOf(trx, ctx, deal, stageId, path = 'body.stageId') {
  const stage = ctx.stagesById.get(stageId) ?? (await trx('pipeline_stages').where({ id: stageId }).first());
  if (!stage || stage.company_id !== deal.company_id) throw field(path, 'Stage not found');
  return stage;
}

/**
 * Move, win, lose and reopen share this: lock, resolve the target stage, apply `fields`, run the
 * stage rules (planMove) and commit.
 * @param {'move' | 'win' | 'lose' | 'reopen'} action
 */
export async function changeStage(req, id, body, action) {
  const userId = req.auth.user.id;
  const row = await db.transaction(async (trx) => {
    let deal = await lockForChange(trx, req, id);
    const now = new Date();
    let ctx = await loadPlanContext(trx, [deal], { now, userId });
    let toStage;
    if (action === 'move') {
      toStage = await stageOf(trx, ctx, deal, body.stageId);
      if (body.fromStageId && body.fromStageId !== deal.stage_id) {
        throw new AppError(409, 'stage_changed', 'Someone moved this lead in the meantime', { currentStageId: deal.stage_id });
      }
    } else if (action === 'reopen') {
      if (deal.status === 'open') throw errors.conflict('This lead is already open');
      if (body.stageId) {
        toStage = await stageOf(trx, ctx, deal, body.stageId);
        if (toStage.pipeline_id !== deal.pipeline_id || toStage.category !== 'open' || toStage.archived_at) {
          throw field('body.stageId', 'Pick an open stage of this pipeline');
        }
      } else {
        const closing = await trx('deal_stage_history')
          .where({ deal_id: deal.id })
          .whereIn('to_status', ['won', 'lost'])
          .orderBy([{ column: 'moved_at', order: 'desc' }, { column: 'id', order: 'desc' }])
          .first('from_stage_id');
        const left = closing?.from_stage_id ? ctx.stagesById.get(closing.from_stage_id) : null;
        toStage = left && left.category === 'open' && !left.archived_at ? left : firstStage(ctx, deal.pipeline_id, 'open');
      }
    } else {
      const category = action === 'win' ? 'won' : 'lost';
      if (body.stageId) {
        toStage = await stageOf(trx, ctx, deal, body.stageId);
        if (toStage.pipeline_id !== deal.pipeline_id || toStage.category !== category) {
          throw field('body.stageId', action === 'win' ? 'Pick a won stage of this pipeline' : 'Pick a lost stage of this pipeline');
        }
      } else toStage = firstStage(ctx, deal.pipeline_id, category);
    }
    if (!toStage) throw errors.conflict('This pipeline has no stage for that. Set one up in Settings › Pipelines.');
    if (toStage.id === deal.stage_id) return deal;

    if (body.fields) {
      deal = await applyDealFields(trx, req, deal, body.fields);
      ctx = await loadPlanContext(trx, [deal], { now, userId });
    }
    const lostReason = body.lostReasonId ? await trx('lost_reasons').where({ id: body.lostReasonId }).first() : null;
    if (body.lostReasonId && !lostReason) throw field('body.lostReasonId', 'Lost reason not found');
    const units = await unitsIndex(req, trx);
    const plan = await planMove(
      deal,
      toStage,
      {
        mode: action === 'reopen' ? 'reopen' : 'move',
        lostReason,
        lostNote: body.lostNote,
        nurture: body.nurture,
        companyUnit: units.get(deal.company_id),
      },
      ctx,
    );
    if (!plan) return deal;
    await commitPlans(trx, req, [plan], now);
    return trx('deals').where({ id: deal.id }).first();
  });
  return presentDetail(req, row);
}

// ---------- Assignment, archive, restore ----------

/** Who may give a deal to someone: deals.assign at its unit; anyone working every deal there may take it. */
export function canAssignTo(access, unit, toUserId, userId) {
  if (access.can('deals.assign', unit.path)) return true;
  return toUserId === userId && access.level(MANAGE, unit.path) === 'all';
}

export async function assignDeal(req, id, { ownerUserId }) {
  const userId = req.auth.user.id;
  const row = await db.transaction(async (trx) => {
    const { row: deal } = await loadDealForView(req, id, { trx, forUpdate: true });
    const unit = (await unitsIndex(req, trx)).get(deal.unit_id);
    if (!canAssignTo(req.access, unit, ownerUserId, userId)) throw errors.forbidden("You can't change who owns this lead");
    const owner = ownerUserId ? await trx('users').where({ id: ownerUserId }).first('id', 'name') : null;
    const now = new Date();
    const ctx = await loadPlanContext(trx, [], { now, userId });
    const plan = await planAssign(deal, { ownerUserId, owner, unit }, ctx);
    if (!plan) return deal;
    await commitPlans(trx, req, [plan], now);
    return trx('deals').where({ id }).first();
  });
  return presentDetail(req, row);
}

export async function archiveDeal(req, id, { reason }) {
  const row = await db.transaction(async (trx) => {
    const deal = await lockForChange(trx, req, id, { permission: 'deals.archive', allowArchived: true });
    const now = new Date();
    const plan = planArchive(deal, { reason }, await loadPlanContext(trx, [], { now, userId: req.auth.user.id }));
    await commitPlans(trx, req, [plan], now);
    return trx('deals').where({ id }).first();
  });
  return presentDetail(req, row);
}

export async function restoreDeal(req, id) {
  const row = await db.transaction(async (trx) => {
    const deal = await lockForChange(trx, req, id, { permission: 'deals.archive', allowArchived: true });
    const now = new Date();
    const plan = planRestore(deal, {}, await loadPlanContext(trx, [], { now, userId: req.auth.user.id }));
    await commitPlans(trx, req, [plan], now);
    return trx('deals').where({ id }).first();
  });
  return presentDetail(req, row);
}

/** POST /deals/:id/seen: the owner opened the lead, so it's no longer "new". Not audited (a read receipt). */
export async function markSeen(req, id) {
  const { row } = await loadDealForView(req, id);
  if (row.owner_user_id === req.auth.user.id && !row.owner_seen_at) {
    await db('deals').where({ id, owner_user_id: req.auth.user.id }).whereNull('owner_seen_at').update({ owner_seen_at: new Date() });
  }
}

// ---------- People on a deal ----------

const CONTACT_KIND_FOR_ROLE = { parent: 'parent', guardian: 'parent', student: 'student', decision_maker: 'staff', influencer: 'staff' };
const ROLE_WORDS = { parent: 'parent', guardian: 'guardian', student: 'student', decision_maker: 'decision maker', influencer: 'influencer', other: 'contact' };

export async function addDealContact(req, id, body) {
  const actor = actorFrom({ req });
  const row = await db.transaction(async (trx) => {
    const deal = await lockForChange(trx, req, id);
    const units = await unitsIndex(req, trx);
    const unit = units.get(deal.unit_id);
    const company = units.get(deal.company_id);
    let contact;
    if (body.contactId) {
      contact = await attachableContact(trx, actor, body.contactId, { groupId: deal.group_id, path: 'body.contactId' });
      await ensureCompanyLink(trx, actor, 'contact', {
        recordId: contact.id,
        groupId: deal.group_id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        ownerUserId: deal.owner_user_id,
        source: deal.first_touch,
      });
    } else {
      const [defaultCountry, threshold] = await Promise.all([
        crmSetting(company, defaultCountrySetting, trx),
        crmSetting(company, fuzzyMatchThresholdSetting, trx),
      ]);
      const result = await findOrCreateContact(
        trx,
        {
          groupId: deal.group_id,
          companyId: deal.company_id,
          unitId: unit.id,
          kind: body.contact.kind ?? CONTACT_KIND_FOR_ROLE[body.role],
          ...contactFields(body.contact),
          ownerUserId: deal.owner_user_id,
          source: deal.first_touch,
          defaultCountry,
          nameThreshold: threshold,
          path: 'body.contact',
        },
        { req },
      );
      contact = result.contact;
    }
    const existing = await trx('deal_contacts').where({ deal_id: deal.id, contact_id: contact.id }).first();
    if (existing) throw errors.conflict(`${contact.display_name} is already on this lead`);
    await trx('deal_contacts').insert({ deal_id: deal.id, contact_id: contact.id, role: body.role });
    // A student joins the lead's family; the first student of a family lead makes one ("<surname> family").
    let householdId = deal.household_id;
    if (body.role === 'student' && deal.kind === 'b2c' && deal.primary_contact_id) {
      const parent = await trx('contacts').where({ id: deal.primary_contact_id }).first();
      const current = householdId ? await trx('households').where({ id: householdId }).whereNull('archived_at').first() : null;
      try {
        const household = await resolveHousehold(trx, actor, { groupId: deal.group_id, householdId: current?.id ?? null, parent, students: [contact] });
        if (household && !householdId) householdId = household.id;
      } catch (err) {
        // The main contact may have left the family since; the student still joins the lead.
        if (err?.status !== 422) throw err;
      }
    }
    const now = new Date();
    await addTimelineEvent(trx, {
      ...dealTimelineBase(deal),
      kind: 'system',
      direction: 'internal',
      title: `${contact.display_name} added as ${ROLE_WORDS[body.role]}`,
      meta: { action: 'deal.contact_added', contactId: contact.id, role: body.role },
      actorType: 'user',
      actorUserId: actor.userId,
      occurredAt: now,
    });
    const [updated] = await trx('deals').where({ id: deal.id }).update({ updated_at: now, household_id: householdId }).returning('*');
    await emitEvent(trx, dealEvent(deal, 'deal.contact_added', { dealId: deal.id, companyId: deal.company_id, contactId: contact.id, role: body.role }, actor.userId));
    await writeAudit(trx, req, dealAudit(deal, 'deal.contact_added', { after: { contactId: contact.id, role: body.role } }));
    await refreshSearchDocument(trx, 'deal', deal.id);
    return updated;
  });
  return presentDetail(req, row);
}

export async function removeDealContact(req, id, contactId) {
  const userId = req.auth.user.id;
  const row = await db.transaction(async (trx) => {
    const deal = await lockForChange(trx, req, id);
    const participant = await trx('deal_contacts as dc')
      .join('contacts as c', 'c.id', 'dc.contact_id')
      .where({ 'dc.deal_id': deal.id, 'dc.contact_id': contactId })
      .first('dc.role', 'c.display_name');
    if (!participant) throw errors.notFound('Contact on this lead');
    if (contactId === deal.primary_contact_id) throw errors.conflict("The main contact can't be removed. Change the main contact first.");
    await trx('deal_contacts').where({ deal_id: deal.id, contact_id: contactId }).delete();
    const now = new Date();
    await addTimelineEvent(trx, {
      ...dealTimelineBase(deal),
      kind: 'system',
      direction: 'internal',
      title: `${participant.display_name} removed from the lead`,
      meta: { action: 'deal.contact_removed', contactId, role: participant.role },
      actorType: 'user',
      actorUserId: userId,
      occurredAt: now,
    });
    const [updated] = await trx('deals').where({ id: deal.id }).update({ updated_at: now }).returning('*');
    await emitEvent(trx, dealEvent(deal, 'deal.contact_removed', { dealId: deal.id, companyId: deal.company_id, contactId, role: participant.role }, userId));
    await writeAudit(trx, req, dealAudit(deal, 'deal.contact_removed', { before: { contactId, role: participant.role } }));
    await refreshSearchDocument(trx, 'deal', deal.id);
    return updated;
  });
  return presentDetail(req, row);
}
