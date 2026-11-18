import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { UNNAMED_CONTACT } from '../../core/crm/contacts.js';
import { piiCustomDefinitions } from '../../core/crm/customFields.js';
import { loadVisibleContact, unitsIndex } from '../../core/crm/scope.js';
import { refreshSearchDocuments, removeSearchDocument } from '../../core/crm/search.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { actingLink, changeUnit, inOrder, usersById } from './context.js';
import { householdsForExport } from './households.js';
import { presentConsent, presentDealSummary, presentExportTask, presentExportTimelineEntry } from './present.js';
import { presentLoadedContact } from './service.js';

// DPDP Act requests: access (export everything the group holds about a person) and erasure
// (anonymise personal data, keep deals, money and audit records). docs/crm/PHASE2_CONTRACT.md §9.1.

export const ERASED_CONTACT = 'Erased contact';

/** Timeline kinds whose titles are written by the system and say nothing personal. */
const KEPT_TITLE_KINDS = ['system', 'stage_change', 'task'];

async function loadForPrivacy(req, id, { trx = db, forUpdate = false } = {}) {
  await unitsIndex(req, trx);
  const loaded = await loadVisibleContact(req, id, { trx, forUpdate });
  if (!loaded.canPrivacy) {
    throw errors.forbidden('Data requests need the privacy permission at every company that knows this person');
  }
  return loaded;
}

const dealColumns = (query) =>
  query
    .join('pipeline_stages as s', 's.id', 'd.stage_id')
    .leftJoin('users as u', 'u.id', 'd.owner_user_id')
    .select('d.*', 's.key as stage_key', 's.name as stage_name', 's.category as stage_category', 's.colour as stage_colour', 'u.name as owner_name');

/** GET /contacts/:id/export → ContactExport (never masked). */
export async function exportContact(req, id) {
  const loaded = await loadForPrivacy(req, id);
  const [contact, householdIds, consents, deals, timeline, archived, tasks] = await Promise.all([
    presentLoadedContact(req, loaded, { everything: true }),
    db('household_members').where({ contact_id: id }).pluck('household_id'),
    db('consents').where({ contact_id: id }).orderBy([{ column: 'captured_at', order: 'desc' }, { column: 'created_at', order: 'desc' }]),
    dealColumns(db('deals as d'))
      .whereIn('d.id', db('deal_contacts').where({ contact_id: id }).select('deal_id'))
      .orderBy([{ column: 'd.created_at', order: 'desc' }]),
    db('timeline_events').where({ contact_id: id }).whereNull('deleted_at').orderBy([{ column: 'occurred_at', order: 'desc' }, { column: 'id', order: 'desc' }]),
    db('timeline_events_archive').where({ contact_id: id }).whereNull('deleted_at').orderBy([{ column: 'occurred_at', order: 'desc' }, { column: 'id', order: 'desc' }]),
    db('tasks').where({ contact_id: id }).orderBy([{ column: 'created_at', order: 'desc' }]),
  ]);
  const entries = [...timeline, ...archived];
  const dealsById = new Map(deals.map((row) => [row.id, row]));
  const missingDeals = [...new Set([...entries, ...tasks].map((row) => row.deal_id).filter((dealId) => dealId && !dealsById.has(dealId)))];
  const accountIds = [...new Set(tasks.map((row) => row.account_id).filter(Boolean))];
  const [moreDeals, accounts, households, users, unitsById] = await Promise.all([
    missingDeals.length ? db('deals').whereIn('id', missingDeals).select('id', 'ref', 'title', 'status') : [],
    accountIds.length ? db('accounts').whereIn('id', accountIds).select('id', 'name', 'kind') : [],
    householdsForExport(req, householdIds),
    usersById([
      ...consents.map((row) => row.captured_by),
      ...entries.map((row) => row.actor_user_id),
      ...tasks.flatMap((row) => [row.assignee_user_id, row.created_by, row.completed_by]),
    ]),
    unitsIndex(req),
  ]);
  for (const row of moreDeals) dealsById.set(row.id, row);
  const accountsById = new Map(accounts.map((row) => [row.id, row]));

  await writeAudit(db, req, {
    action: 'contact.exported',
    entityType: 'contact',
    entityId: id,
    unit: changeUnit(loaded.contact, actingLink(req, unitsById, loaded.visibleLinks)),
    meta: { deals: deals.length, timeline: entries.length, tasks: tasks.length },
  });

  return {
    exportedAt: new Date().toISOString(),
    contact,
    households,
    consents: consents.map((row) => presentConsent(row, users)),
    deals: deals.map(presentDealSummary),
    timeline: entries.map((row) => presentExportTimelineEntry(row, { usersById: users, dealsById })),
    tasks: tasks.map((row) => presentExportTask(row, { usersById: users, unitsById, dealsById, accountsById, contact: loaded.contact })),
  };
}

const touchSql = (column) =>
  `case when ${column} is null then null else jsonb_strip_nulls(jsonb_build_object('channel', ${column}->'channel', 'campaign', ${column}->'campaign', 'at', ${column}->'at')) end`;

/**
 * Erase a person's personal data on request, inside the caller's transaction. The contact row
 * stays (as "Erased contact") so deals, invoices, tasks and the audit log keep their references.
 * @returns {Promise<{ contactId: string, companyIds: string[] }>}
 */
export async function eraseContact(trx, contactId, { req, reason }) {
  const loaded = await loadForPrivacy(req, contactId, { trx, forUpdate: true });
  const { contact } = loaded;
  if (contact.erased_at) throw errors.conflict('This contact was already erased');
  const companyIds = [...new Set(loaded.links.map((link) => link.company_id))];
  const [dealIds, householdIds] = await inOrder(trx, [
    trx('deal_contacts').where({ contact_id: contactId }).pluck('deal_id'),
    trx('household_members').where({ contact_id: contactId }).pluck('household_id'),
  ]);
  const primaryDealIds = await trx('deals').where({ primary_contact_id: contactId }).pluck('id');
  const allDealIds = [...new Set([...dealIds, ...primaryDealIds])];

  // Deals keep their figures, stages and history; free text, AI notes and detailed touches go.
  if (allDealIds.length > 0) {
    const name = contact.display_name;
    const replaceName = name && name !== UNNAMED_CONTACT && name.length >= 3;
    await trx.raw(
      `update deals
          set original_message = null,
              ai_fields = '{}'::jsonb,
              first_touch = ${touchSql('first_touch')},
              last_touch = ${touchSql('last_touch')},
              title = case when ?::boolean then replace(title, ?, ?) else title end,
              updated_at = now()
        where id = any(?::uuid[])`,
      [replaceName, name, ERASED_CONTACT, allDealIds],
    );
  }
  // Phone and email custom fields on the deals they are the main contact of hold their numbers and
  // addresses too (other people's deals keep theirs).
  if (primaryDealIds.length > 0) {
    const dealCompanies = await trx('deals').whereIn('id', primaryDealIds).distinct().pluck('company_id');
    const piiFields = await piiCustomDefinitions(trx, dealCompanies, 'deal');
    for (const companyId of dealCompanies) {
      const keys = piiFields.filter((field) => field.company_id === companyId).map((field) => field.key);
      if (keys.length === 0) continue;
      await trx.raw('update deals set custom = custom - ?::text[] where id = any(?::uuid[]) and company_id = ?', [keys, primaryDealIds, companyId]);
    }
  }

  // Timeline entries about the person: bodies and details go; system titles stay.
  for (const table of ['timeline_events', 'timeline_events_archive']) {
    await trx.raw(
      `update ${table}
          set body = null,
              meta = case when meta->'action' is not null then jsonb_build_object('action', meta->'action') else '{}'::jsonb end,
              title = case when kind = any(?::text[]) then title else null end
        where contact_id = ?`,
      [KEPT_TITLE_KINDS, contactId],
    );
  }

  // Consents stay as proof of what the person chose; the evidence (IPs, wording, message ids) goes.
  await trx('consents').where({ contact_id: contactId }).update({ evidence: '{}' });
  await trx('contact_companies')
    .where({ contact_id: contactId })
    .update({ source: null, custom: '{}', tags: [], updated_at: trx.fn.now() });
  await trx('contact_methods').where({ contact_id: contactId }).delete();
  await trx('account_contacts').where({ contact_id: contactId }).delete();
  await trx('household_members').where({ contact_id: contactId }).delete();
  if (householdIds.length > 0) {
    await trx('households')
      .whereIn('id', householdIds)
      .whereNull('archived_at')
      .whereNotExists(trx('household_members as hm').whereRaw('hm.household_id = households.id').select(trx.raw('1')))
      .update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() });
  }
  await trx('contacts')
    .where({ id: contactId })
    .update({
      first_name: null,
      last_name: null,
      display_name: ERASED_CONTACT,
      name_normalized: '',
      primary_phone: null,
      primary_email: null,
      date_of_birth: null,
      address: '{}',
      city: null,
      student_profile: '{}',
      erased_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

  await removeSearchDocument(trx, 'contact', contactId);
  if (allDealIds.length > 0) await refreshSearchDocuments(trx, 'deal', allDealIds);

  const userId = req.auth.user.id;
  await addTimelineEvent(trx, {
    groupId: contact.group_id,
    contactId,
    kind: 'system',
    title: 'Personal data erased on request',
    meta: { action: 'contact.erased' },
    actorType: 'user',
    actorUserId: userId,
  });
  const unitsById = await unitsIndex(req, trx);
  const unit = changeUnit(contact, actingLink(req, unitsById, loaded.visibleLinks));
  await emitEvent(trx, {
    type: 'contact.erased',
    groupId: contact.group_id,
    unitId: unit.id,
    aggregateType: 'contact',
    aggregateId: contactId,
    actorUserId: userId,
    payload: { contactId, companyIds },
  });
  await writeAudit(trx, req, {
    action: 'contact.erased',
    entityType: 'contact',
    entityId: contactId,
    unit,
    meta: { reason, companyIds, deals: allDealIds.length },
  });
  return { contactId, companyIds };
}
