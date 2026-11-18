import { randomUUID } from 'node:crypto';
import { db as defaultDb, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { getEffectiveSettings, getSetting } from '../../core/settings.js';
import { route, toEnquiry } from '../../core/intake/index.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { defaultCountrySetting } from '../../core/crm/settings.js';
import { port } from './ports.js';
import { assignLead, choosePoolAndUnit } from './assignment.js';
import { attachToContact, createContact, decideDuplicates, enquirerKind, loadCandidates, personInput, resolveStudent, studentProfileOf } from './people.js';
import {
  attachToOpenDealSetting,
  crmNormalizers,
  dedupMergeSetting,
  dedupSuggestSetting,
  reopenWindowSetting,
  returningOwnerSetting,
  routingThresholdSetting,
} from './settings.js';

// ingestEnquiry(): every channel ends here. One transaction per enquiry:
//   record → route (owned channel → company; shared → classifier port → review below threshold)
//   → de-duplicate against the group's people (merge into them, suggest, or create)
//   → add to their open lead, reopen a recently lost one, or create a lead (deals port)
//   → assign the owner (partner stickiness, returning family, round-robin with capacity,
//     language and time zone) → first-reply SLA (set by the deals port from the channel)
//   → consent records → events enquiry.received, lead.created | lead.merged | lead.reopened.

/** core/intake channel type → CRM channel key (core/crm/channels.js and this module's channels). */
export const DEAL_CHANNEL_BY_TYPE = Object.freeze({
  website_form: 'website_form',
  landing_page: 'website_form',
  chat_widget: 'website_form',
  whatsapp: 'whatsapp',
  phone_call: 'voice_call',
  missed_call: 'voice_call',
  sms: 'sms',
  email: 'email',
  facebook_lead_ad: 'lead_ad_facebook',
  instagram: 'lead_ad_instagram',
  google_lead_form: 'lead_ad_google',
  walk_in: 'walk_in',
  event: 'event',
  partner_referral: 'partner_referral',
  csv_import: 'csv_import',
  api: 'api',
  other: 'manual',
});

const MESSAGE_KIND = { email: 'email', voice_call: 'call' };
const CONSENT_SOURCE = { website_form: 'web_form', website_checkout: 'checkout', whatsapp: 'whatsapp', voice_call: 'call', email: 'email', sms: 'sms', csv_import: 'import' };

/** An enquiry that can't be read (field errors keep their paths, e.g. `contact.phone`). */
export class EnquiryInvalidError extends AppError {
  constructor(issues) {
    super(422, 'validation_failed', 'The enquiry could not be read', issues.map((i) => ({ path: i.path, message: i.message, code: i.code })));
    this.issues = issues;
  }
}

const companiesOfGroup = (trx, groupId) => trx('org_units').where({ root_id: groupId, type: 'company', status: 'active' }).select('*');

async function thresholdsFor(trx, group, companies) {
  const values = [];
  for (const c of companies) values.push(await getSetting(c, routingThresholdSetting, trx));
  return { default: await getSetting(group, routingThresholdSetting, trx), byCompany: Object.fromEntries(companies.map((c, i) => [c.id, values[i]])) };
}

async function loadIdentities(trx, groupId, type) {
  const rows = await trx('intake_channel_identities').where({ group_id: groupId, type, active: true });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    identity: r.identity,
    companyId: r.company_id ?? undefined,
    productLineId: r.product_line_id ?? undefined,
    shared: r.shared,
    companyIds: r.company_ids ?? [],
    unitId: r.unit_id ?? null,
  }));
}

/** The touch source for deals and company links (touchSourceSchema). */
export function touchFrom(enquiry, dealChannel) {
  const s = enquiry.source ?? {};
  const utm = s.utm && Object.keys(s.utm).length ? s.utm : undefined;
  return Object.fromEntries(
    Object.entries({
      channel: dealChannel,
      campaign: s.campaign?.slice(0, 200),
      utm,
      referrer: s.referrer?.slice(0, 2000),
      partnerId: s.partnerId,
      landingUrl: s.landingUrl,
      formId: s.formId?.slice(0, 100),
      adId: s.adId?.slice(0, 100),
      at: enquiry.receivedAt,
    }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

/** The first message of the enquiry (originalMessageSchema), when it has one. */
export function originalMessageFrom(enquiry, dealChannel) {
  const i = enquiry.interest ?? {};
  const lines = [i.message, i.course && `Course: ${i.course}`, i.product && `Product: ${i.product}`, i.preferredTime && `Preferred time: ${i.preferredTime}`, enquiry.student?.name && `Student: ${enquiry.student.name}${enquiry.student.grade ? `, grade ${enquiry.student.grade}` : ''}`, enquiry.institute?.name && `Institute: ${enquiry.institute.name}`].filter(Boolean);
  if (!lines.length) return null;
  const c = enquiry.contact ?? {};
  return {
    channel: dealChannel,
    text: lines.join('\n').slice(0, 10_000),
    ...(enquiry.raw?.subject ? { subject: String(enquiry.raw.subject).slice(0, 300) } : {}),
    receivedAt: enquiry.receivedAt,
    from: Object.fromEntries(Object.entries({ name: c.name?.slice(0, 120), phone: c.phone, email: c.email }).filter(([, v]) => v)),
  };
}

const kindOf = (enquiry, fallback) => (enquiry.institute?.name ? 'b2b' : enquiry.audience ?? fallback ?? 'b2c');

/** The person's deals with a company (as primary contact or participant), newest first. */
async function dealsOfPerson(trx, { companyId, contactId, accountId, kind }) {
  return trx('deals as d')
    .where({ 'd.company_id': companyId, 'd.kind': kind })
    .whereNull('d.archived_at')
    .where((q) => {
      q.where('d.primary_contact_id', contactId).orWhereExists(function participant() {
        this.select(trx.raw('1')).from('deal_contacts as dc').whereRaw('dc.deal_id = d.id').where('dc.contact_id', contactId);
      });
      if (accountId) q.orWhere('d.account_id', accountId);
    })
    .orderBy([{ column: 'd.updated_at', order: 'desc' }, { column: 'd.id', order: 'desc' }])
    .limit(20)
    .select('d.id', 'd.status', 'd.owner_user_id', 'd.closed_at', 'd.last_activity_at', 'd.updated_at', 'd.unit_id', 'd.first_reply_due_at');
}

/** The enquiry's message on an existing lead (repeat enquiries and reopened leads). */
async function addEnquiryEntries(trx, deal, enquiryId, enquiry, dealChannel, { title }) {
  const subject = { groupId: deal.group_id, companyId: deal.company_id, unitId: deal.unit_id, dealId: deal.id, contactId: deal.primary_contact_id, accountId: deal.account_id };
  await addTimelineEvent(trx, { ...subject, kind: 'system', title, meta: { action: 'intake.enquiry', enquiryId, channel: dealChannel }, actorType: 'system' });
  const message = originalMessageFrom(enquiry, dealChannel);
  if (message) {
    await addTimelineEvent(trx, {
      ...subject,
      kind: MESSAGE_KIND[dealChannel] ?? 'message',
      channel: dealChannel,
      direction: 'inbound',
      title: message.subject ?? null,
      body: message.text,
      meta: { enquiryId },
      actorType: 'contact',
      occurredAt: enquiry.receivedAt,
      sourceEventId: `intake:${enquiryId}:message`,
    });
  }
}

async function recordConsents(trx, { enquiry, enquiryRow, contactId, companyId, unitId, dealChannel, evidence }) {
  const c = enquiry.consent;
  if (!c || !contactId) return 0;
  const records = [
    c.whatsapp && { channel: 'whatsapp', purpose: 'service' },
    c.calls && { channel: 'voice', purpose: 'service' },
    c.marketing && { channel: 'all', purpose: 'marketing' },
  ].filter(Boolean);
  for (const r of records) {
    await port('contacts').recordConsent(trx, {
      groupId: enquiryRow.group_id,
      companyId,
      unitId,
      contactId,
      channel: r.channel,
      purpose: r.purpose,
      status: 'granted',
      source: CONSENT_SOURCE[dealChannel] ?? 'web_form',
      evidence: { enquiryId: enquiryRow.id, ...(c.text ? { wording: c.text.slice(0, 2000) } : {}), ...evidence },
      capturedAt: c.capturedAt ?? enquiry.receivedAt,
    });
  }
  return records.length;
}

/**
 * Turn an enquiry into a lead.
 *
 * @param {object} input
 * @param {string} input.groupId
 * @param {object} input.payload           core/intake enquiry input (toEnquiry)
 * @param {string} [input.dealChannel]     CRM channel key (default from the channel type)
 * @param {string} [input.idempotencyKey]  default `<type>:<identity>:<externalId>` when externalId is given
 * @param {{ companyId: string, productLineId?: string | null, identityId?: string | null }} [input.owned]
 *        the channel already identifies the company (a form, a checkout, an import)
 * @param {string} [input.unitId]          the unit leads should land in (a form's or an import's)
 * @param {string} [input.companyHint]     an integration connection's company: used when no identity matches
 * @param {string} [input.formId]
 * @param {string} [input.importJobId]
 * @param {string} [input.partnerCode]     a partner referral code (?ref=)
 * @param {string} [input.audience]        b2c | b2b when the payload doesn't say
 * @param {object} [input.evidence]        consent evidence (form URL, IP)
 * @param {object} [ctx] { db, registry, req, actorUserId, now }
 * @returns {Promise<{ enquiryId: string, status: string, outcome: string | null, dealId: string | null, contactId: string | null, replayed: boolean, review: boolean }>}
 */
export async function ingestEnquiry(input, ctx = {}) {
  const knex = ctx.db ?? defaultDb;
  const now = ctx.now ?? new Date();
  const group = await knex('org_units').where({ id: input.groupId }).first();
  if (!group || group.depth !== 0) throw errors.notFound('Group');
  const defaultCountry = await getSetting(group, defaultCountrySetting, knex);
  const parsed = toEnquiry(input.payload, { normalizers: crmNormalizers, defaultCountry, now: now.getTime() });
  if (!parsed.ok) throw new EnquiryInvalidError(parsed.errors);
  const enquiry = parsed.enquiry;
  const channel = enquiry.source.channel;
  const dealChannel = input.dealChannel ?? (input.partnerCode ? 'partner_referral' : DEAL_CHANNEL_BY_TYPE[channel.type] ?? 'manual');
  const idempotencyKey = input.idempotencyKey ?? (enquiry.externalId ? `${channel.type}:${channel.identity ?? ''}:${enquiry.externalId}` : null);

  try {
    return await knex.transaction(async (trx) => {
      const enquiryId = randomUUID();
      const [row] = await trx('intake_enquiries')
        .insert({
          id: enquiryId,
          group_id: group.id,
          channel_type: channel.type,
          channel_identity: channel.identity ?? null,
          deal_channel: dealChannel,
          form_id: input.formId ?? null,
          import_job_id: input.importJobId ?? null,
          external_id: enquiry.externalId ?? null,
          idempotency_key: idempotencyKey ?? `intake:${enquiryId}`,
          status: 'pending',
          raw: json(enquiry.raw ?? input.payload ?? {}),
          enquiry: json({ ...enquiry, raw: undefined }),
          warnings: json(parsed.warnings ?? []),
          ingest_options: json(ingestOptions(input)),
          received_at: enquiry.receivedAt ?? now,
          created_by: ctx.actorUserId ?? null,
        })
        .onConflict('idempotency_key')
        .ignore()
        .returning('*');
      if (!row) {
        const existing = await trx('intake_enquiries').where({ idempotency_key: idempotencyKey }).first();
        return { enquiryId: existing.id, status: existing.status, outcome: existing.outcome, dealId: existing.deal_id, contactId: existing.contact_id, replayed: true, review: existing.status === 'needs_review' };
      }
      await emitEvent(trx, {
        type: 'enquiry.received',
        groupId: group.id,
        unitId: input.unitId ?? null,
        aggregateType: 'intake_enquiry',
        aggregateId: row.id,
        actorUserId: ctx.actorUserId ?? null,
        payload: { enquiryId: row.id, channelType: channel.type, channel: dealChannel, formId: input.formId ?? null, importJobId: input.importJobId ?? null, receivedAt: new Date(row.received_at).toISOString() },
      });

      // Partner referral: attribution, and the partner's company owns the lead.
      let partner = null;
      if (input.partnerCode) {
        const ref = await port('partners').resolveReferral(trx, { groupId: group.id, code: input.partnerCode });
        if (ref && (!input.owned || input.owned.companyId === ref.companyId)) {
          partner = { link_id: ref.linkId, partner_id: ref.partnerId, partner_name: ref.partnerName, company_id: ref.companyId, owner_user_id: ref.ownerUserId, product_line_id: ref.productLineId };
          enquiry.source.partnerId = ref.partnerId;
          await trx('intake_enquiries').where({ id: row.id }).update({ partner_link_id: ref.linkId, partner_id: ref.partnerId, enquiry: json({ ...enquiry, raw: undefined }) });
        }
      }

      const routing = await decideRouting(trx, { group, enquiry, input, partner });
      if (routing.decision === 'review') {
        await queueRoutingReview(trx, { row, routing, group });
        return { enquiryId: row.id, status: 'needs_review', outcome: null, dealId: null, contactId: null, replayed: false, review: true };
      }
      return processRouted(trx, { row, enquiry, routing, partner, input, dealChannel, defaultCountry }, { ...ctx, now });
    });
  } catch (error) {
    if (error instanceof EnquiryInvalidError) throw error;
    // Keep what arrived, so nothing is lost when configuration (or a port) fails.
    if (ctx.recordFailures !== false) await recordFailed(knex, { group, input, enquiry, dealChannel, idempotencyKey, error, actorUserId: ctx.actorUserId, now });
    throw error;
  }
}

/** What a retry needs to ingest the enquiry the same way again. */
export function ingestOptions(input) {
  const keep = ['dealChannel', 'owned', 'unitId', 'companyHint', 'formId', 'importJobId', 'partnerCode', 'audience', 'evidence', 'ownerUserId'];
  return Object.fromEntries(keep.filter((k) => input[k] !== undefined && input[k] !== null).map((k) => [k, input[k]]));
}

async function recordFailed(knex, { group, input, enquiry, dealChannel, idempotencyKey, error, actorUserId, now }) {
  const failure = error instanceof AppError ? `${error.message}${Array.isArray(error.details) && error.details[0]?.message ? `: ${error.details[0].message}` : ''}` : 'Unexpected error while processing the enquiry';
  await knex('intake_enquiries')
    .insert({
      id: randomUUID(),
      group_id: group.id,
      channel_type: enquiry.source.channel.type,
      channel_identity: enquiry.source.channel.identity ?? null,
      deal_channel: dealChannel,
      form_id: input.formId ?? null,
      import_job_id: input.importJobId ?? null,
      external_id: enquiry.externalId ?? null,
      idempotency_key: idempotencyKey ? `${idempotencyKey}:failed:${now.getTime()}` : `failed:${randomUUID()}`,
      status: 'failed',
      raw: json(enquiry.raw ?? input.payload ?? {}),
      enquiry: json({ ...enquiry, raw: undefined }),
      ingest_options: json(ingestOptions(input)),
      failure: failure.slice(0, 500),
      received_at: enquiry.receivedAt ?? now,
      created_by: actorUserId ?? null,
    })
    .catch(() => {});
}

/** Route: an owned channel (form, partner link, import, registered identity) or the classifier. */
async function decideRouting(trx, { group, enquiry, input, partner }) {
  const fixed = input.owned ?? (partner?.company_id ? { companyId: partner.company_id, productLineId: partner.product_line_id ?? null, identityId: null } : null);
  if (fixed) {
    return { decision: 'route', companyId: fixed.companyId, productLineId: fixed.productLineId ?? null, confidence: 1, reason: 'owned_channel', message: 'The channel belongs to this company', shared: false, identityId: fixed.identityId ?? null, unitId: input.unitId ?? null, warnings: [] };
  }
  const identities = await loadIdentities(trx, group.id, enquiry.source.channel.type);
  const companies = await companiesOfGroup(trx, group.id);
  const thresholds = await thresholdsFor(trx, group, companies);
  const classifier = port('classifier');
  const result = await route({
    channel: enquiry.source.channel,
    identities,
    enquiry,
    classify: classifier ? (request) => classifier({ ...request, groupId: group.id }) : undefined,
    thresholds,
    normalizers: crmNormalizers,
  });
  const identity = identities.find((i) => i.id === result.identityId);
  if (result.decision === 'review' && result.reason === 'unknown_channel' && input.companyHint) {
    return { decision: 'route', companyId: input.companyHint, productLineId: null, confidence: 1, reason: 'owned_channel', message: 'The integration that received it belongs to this company', shared: false, identityId: null, unitId: input.unitId ?? null, warnings: result.warnings ?? [] };
  }
  const candidateCompanyIds = identity?.shared ? identity.companyIds : result.reason === 'unknown_channel' || result.reason === 'misconfigured_identity' ? companies.map((c) => c.id) : result.companyId ? [result.companyId] : [];
  return { ...result, productLineId: result.productLineId ?? null, unitId: input.unitId ?? identity?.unitId ?? null, candidateCompanyIds };
}

async function queueRoutingReview(trx, { row, routing, group }) {
  const suggestion = {
    companyId: routing.companyId ?? null,
    productLineId: routing.productLineId ?? null,
    confidence: routing.confidence ?? null,
    alternatives: routing.classification?.alternatives ?? [],
    rationale: routing.classification?.rationale ?? null,
  };
  const [item] = await trx('intake_review_items')
    .insert({
      id: randomUUID(),
      group_id: group.id,
      company_id: null,
      candidate_company_ids: routing.candidateCompanyIds ?? [],
      kind: 'routing',
      enquiry_id: row.id,
      reason: routing.reason,
      message: routing.message ?? null,
      confidence: typeof routing.confidence === 'number' ? routing.confidence : null,
      suggestion: json(suggestion),
    })
    .returning('*');
  await trx('intake_enquiries')
    .where({ id: row.id })
    .update({ status: 'needs_review', routing: json(stripRouting(routing)), routing_reason: routing.reason, identity_id: routing.identityId ?? null, updated_at: trx.fn.now() });
  await emitEvent(trx, {
    type: 'intake.review_queued',
    groupId: group.id,
    unitId: null,
    aggregateType: 'intake_review',
    aggregateId: item.id,
    payload: { reviewId: item.id, enquiryId: row.id, kind: 'routing', reason: routing.reason, companyIds: item.candidate_company_ids },
  });
  return item;
}

const stripRouting = (r) => ({ decision: r.decision, companyId: r.companyId ?? null, productLineId: r.productLineId ?? null, confidence: r.confidence ?? null, reason: r.reason, message: r.message ?? null, shared: Boolean(r.shared), identityId: r.identityId ?? null, threshold: r.threshold ?? null, warnings: r.warnings ?? [] });

/**
 * The part after routing: people, the lead, the owner, consent and events. Also used when a
 * reviewer approves a routing decision.
 */
export async function processRouted(trx, { row, enquiry, routing, partner = null, input = {}, dealChannel, defaultCountry }, ctx = {}) {
  const now = ctx.now ?? new Date();
  const registry = ctx.registry;
  const company = await trx('org_units').where({ id: routing.companyId, type: 'company' }).first();
  if (!company || company.status !== 'active' || company.root_id !== row.group_id) throw errors.validation([{ path: 'companyId', message: 'The enquiry was routed to a company that is not active in this group' }]);
  const group = { id: row.group_id };
  const kind = kindOf(enquiry, input.audience);

  // Product line: the channel's, else the enquiry's (only when it is the company's, active, right audience).
  let productLineId = routing.productLineId ?? null;
  const asked = enquiry.interest?.productLineId;
  if (!productLineId && asked && /^[0-9a-f-]{36}$/i.test(asked)) {
    const line = await trx('product_lines').where({ id: asked, company_id: company.id, active: true, audience: kind }).first('id');
    productLineId = line?.id ?? null;
  }
  if (productLineId) {
    const line = await trx('product_lines').where({ id: productLineId, company_id: company.id }).first('id', 'audience', 'active');
    if (!line || !line.active || line.audience !== kind) productLineId = null;
  }

  const { pool, unit } = await choosePoolAndUnit(trx, { company, kind, productLineId, explicitUnitId: routing.unitId ?? input.unitId ?? null });
  const companyUnit = company;
  const effective = await getEffectiveSettings(companyUnit, [reopenWindowSetting, attachToOpenDealSetting, returningOwnerSetting, dedupMergeSetting, dedupSuggestSetting, defaultCountrySetting], trx);
  const value = (d) => effective[d.key].value;
  const [reopenDays, attachOpen, returningDays, mergeScore, suggestScore] = [reopenWindowSetting, attachToOpenDealSetting, returningOwnerSetting, dedupMergeSetting, dedupSuggestSetting].map(value);
  const country = defaultCountry ?? value(defaultCountrySetting);
  const source = touchFrom(enquiry, dealChannel);
  const base = { groupId: group.id, companyId: company.id, unitId: unit.id, source, defaultCountry: country, actorUserId: ctx.actorUserId ?? null, req: ctx.req ?? null };

  // ---- People ----
  const candidates = await loadCandidates(trx, group.id, enquiry);
  const dedup = decideDuplicates(enquiry, candidates, { thresholds: { merge: mergeScore, suggest: Math.min(suggestScore, mergeScore - 0.01) } });
  const personKind = enquirerKind(enquiry, kind);
  const learnerFromParentPhone = dedup.decision === 'merge' && dedup.matchedAs === 'student';
  const person = personInput(enquiry, { kind: learnerFromParentPhone ? undefined : personKind });
  let contact = null;
  let contactMatch = dedup.decision;
  if (dedup.decision === 'merge') {
    const attached = await attachToContact(trx, dedup.contactId, learnerFromParentPhone ? { ...person, firstName: undefined, lastName: undefined } : person, { ...base, keepName: learnerFromParentPhone });
    contact = attached?.contact ?? null;
    if (!contact) contactMatch = 'new';
  }
  if (!contact) contact = (await createContact(trx, person, base)).contact;

  // The learner: the enquiry's student, or the enquirer when they wrote from a parent's phone.
  const studentIds = [];
  if (kind === 'b2c') {
    const learnerName = enquiry.student?.name ?? (learnerFromParentPhone ? enquiry.contact?.name : null);
    if (learnerName && personKind !== 'student') {
      const id = await resolveStudent(trx, { parentId: contact.id, name: learnerName, profile: studentProfileOf(enquiry.student) }, base);
      if (id && id !== contact.id) studentIds.push(id);
    }
  }
  let account = null;
  if (kind === 'b2b' && enquiry.institute?.name) {
    const result = await port('accounts').findOrCreateAccount(trx, {
      groupId: group.id,
      companyId: company.id,
      unitId: unit.id,
      name: enquiry.institute.name,
      kind: 'coaching_institute',
      city: enquiry.institute.city ?? enquiry.contact?.city ?? null,
      website: enquiry.institute.website ?? null,
      email: enquiry.contact?.email ?? null,
      studentCount: enquiry.institute.studentCount ?? null,
      contactId: contact.id,
      source,
      actorUserId: ctx.actorUserId ?? null,
    }, { req: ctx.req ?? null });
    account = result.account;
  }

  // ---- The lead: add to the open one, reopen a recently lost one, or create ----
  const deals = await dealsOfPerson(trx, { companyId: company.id, contactId: contact.id, accountId: account?.id, kind });
  const open = attachOpen ? deals.find((d) => d.status === 'open') : null;
  const lost = !open && reopenDays > 0 ? deals.find((d) => d.status === 'lost' && d.closed_at && now - new Date(d.closed_at) <= reopenDays * 86_400_000) : null;
  const lastOwned = deals.find((d) => d.owner_user_id);
  let outcome;
  let deal;
  let assignment = { decision: 'kept', ownerId: open?.owner_user_id ?? null, method: 'open_lead', poolId: null, reasons: [], excluded: [] };
  if (open) {
    outcome = 'merged';
    deal = await trx('deals').where({ id: open.id }).forUpdate().first();
    await port('deals').touchDeal(trx, { dealId: deal.id, lastTouch: source }, { req: ctx.req ?? null, registry });
    await addEnquiryEntries(trx, deal, row.id, enquiry, dealChannel, { title: 'New enquiry added to this lead' });
  } else {
    const existingOwner = lost?.owner_user_id ? { ownerId: lost.owner_user_id, lastActivityAt: lost.last_activity_at ?? lost.closed_at } : lastOwned ? { ownerId: lastOwned.owner_user_id, lastActivityAt: lastOwned.last_activity_at ?? lastOwned.updated_at } : null;
    const dealUnit = lost ? await trx('org_units').where({ id: lost.unit_id }).first() : unit;
    assignment = await assignLead(trx, { pool, unit: dealUnit, companyId: company.id, productLineId, enquiry, partner, existingOwner, now, returningOwnerDays: returningDays });
    if (input.ownerUserId && assignment.decision !== 'assigned') assignment = { ...assignment, decision: 'assigned', ownerId: input.ownerUserId, method: 'entered_by' };
    if (lost) {
      outcome = 'reopened';
      const result = await port('deals').reopenDeal(trx, { dealId: lost.id, ownerUserId: assignment.ownerId ?? undefined, actorUserId: ctx.actorUserId ?? null }, { req: ctx.req ?? null, registry });
      deal = result.deal;
      await addEnquiryEntries(trx, deal, row.id, enquiry, dealChannel, { title: 'Reopened by a new enquiry' });
    } else {
      outcome = 'created';
      const result = await port('deals').createDeal(
        trx,
        {
          groupId: group.id,
          companyId: company.id,
          unitId: unit.id,
          kind,
          productLineId,
          ownerUserId: assignment.ownerId ?? null,
          primaryContactId: contact.id,
          accountId: account?.id ?? null,
          studentContactIds: studentIds,
          channel: dealChannel,
          firstTouch: source,
          originalMessage: originalMessageFrom(enquiry, dealChannel),
          sourceEventId: `intake:${row.id}`,
          actorUserId: ctx.actorUserId ?? null,
        },
        { req: ctx.req ?? null, registry },
      );
      deal = result.deal;
    }
  }

  // Possible duplicates: the new person might be someone we know; a person decides.
  let reviewCount = 0;
  if (dedup.decision === 'suggest') {
    const suggestions = dedup.candidates.filter((c) => c.decision !== 'new' && c.contactId !== contact.id).slice(0, 3);
    for (const candidate of suggestions) {
      const inserted = await trx('intake_review_items')
        .insert({
          id: randomUUID(),
          group_id: group.id,
          company_id: company.id,
          unit_id: deal.unit_id,
          kind: 'duplicate',
          enquiry_id: row.id,
          contact_id: contact.id,
          candidate_contact_id: candidate.contactId,
          deal_id: deal.id,
          reason: 'possible_duplicate',
          message: candidate.explanation?.slice(0, 500) ?? null,
          confidence: candidate.score,
          suggestion: json({ rules: candidate.rules, matchedAs: candidate.matchedAs }),
        })
        .onConflict(trx.raw('(enquiry_id, kind, candidate_contact_id)'))
        .ignore()
        .returning('id');
      reviewCount += inserted.length;
    }
  }

  const consentCount = await recordConsents(trx, { enquiry, enquiryRow: row, contactId: contact.id, companyId: company.id, unitId: deal.unit_id, dealChannel, evidence: input.evidence ?? {} });

  await trx('intake_enquiries')
    .where({ id: row.id })
    .update({
      status: 'processed',
      outcome,
      company_id: company.id,
      unit_id: deal.unit_id,
      contact_id: contact.id,
      deal_id: deal.id,
      routing: json(stripRouting(routing)),
      routing_reason: routing.reason,
      identity_id: routing.identityId ?? null,
      dedup: json(dedup),
      dedup_decision: dedup.decision,
      assignment: json(assignment),
      processed_at: now,
      updated_at: now,
    });

  const payload = {
    enquiryId: row.id,
    dealId: deal.id,
    contactId: contact.id,
    accountId: account?.id ?? null,
    companyId: company.id,
    unitId: deal.unit_id,
    channel: dealChannel,
    ownerUserId: deal.owner_user_id ?? null,
    assignment: { decision: assignment.decision, method: assignment.method, poolId: assignment.poolId },
    contactMatch,
    duplicateSuggestions: reviewCount,
    partnerId: partner?.partner_id ?? null,
    firstReplyDueAt: deal.first_reply_due_at ? new Date(deal.first_reply_due_at).toISOString() : null,
  };
  await emitEvent(trx, { type: `lead.${outcome}`, groupId: group.id, unitId: deal.unit_id, aggregateType: 'deal', aggregateId: deal.id, actorUserId: ctx.actorUserId ?? null, payload });
  if (reviewCount) {
    await emitEvent(trx, { type: 'intake.review_queued', groupId: group.id, unitId: deal.unit_id, aggregateType: 'intake_enquiry', aggregateId: row.id, payload: { enquiryId: row.id, kind: 'duplicate', count: reviewCount, companyIds: [company.id] } });
  }
  await writeAudit(trx, ctx.req ?? null, {
    action: 'intake.enquiry_processed',
    entityType: 'intake_enquiry',
    entityId: row.id,
    unit: { id: deal.unit_id, root_id: group.id },
    actorType: ctx.actorUserId ? 'user' : 'system',
    actorUserId: ctx.actorUserId ?? null,
    after: { outcome, dealId: deal.id, contactMatch, assignment: assignment.method, channel: dealChannel, consents: consentCount },
  });
  return { enquiryId: row.id, status: 'processed', outcome, dealId: deal.id, contactId: contact.id, replayed: false, review: reviewCount > 0 };
}

