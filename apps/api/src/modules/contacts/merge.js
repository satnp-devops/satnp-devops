import { json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { UNNAMED_CONTACT, fillBlanks } from '../../core/crm/contacts.js';
import { displayName, normalizeName } from '../../core/crm/normalize.js';
import { loadVisibleContact, unitsIndex } from '../../core/crm/scope.js';
import { removeSearchDocument } from '../../core/crm/search.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { actingLink, changeUnit, refreshContactSearch, syncPrimaries } from './context.js';

// Merging two records of the same person (docs/crm/PHASE2_CONTRACT.md §9.1, POST /contacts/:id/merge).
// The target (":id") is kept and every piece of history moves to it; the source becomes a
// tombstone (merged_into_id) so old links and ids still resolve (404 "merged" with mergedIntoId).

const isEmptyObject = (value) => !value || Object.keys(value).length === 0;
const LINK_STATUS_RANK = { lead: 0, former: 1, customer: 2 };

/** Tables keyed by (something, contact_id): move the source's rows unless the target already has one. */
const MEMBERSHIPS = [
  { table: 'household_members', key: 'household_id', primary: true },
  { table: 'account_contacts', key: 'account_id', primary: true },
  { table: 'deal_contacts', key: 'deal_id', primary: false },
];

/** The source's link merged into the target's link of the same company. Pure. */
export function mergeLinkValues(kept, other) {
  const tags = [...new Set([...(kept.tags ?? []), ...(other.tags ?? [])])].slice(0, 20);
  const firstSeen = [kept.first_seen_at, other.first_seen_at].filter(Boolean).map((value) => new Date(value));
  return {
    owner_user_id: kept.owner_user_id ?? other.owner_user_id ?? null,
    status: (LINK_STATUS_RANK[other.status] ?? 0) > (LINK_STATUS_RANK[kept.status] ?? 0) ? other.status : kept.status,
    source: kept.source ?? other.source ?? null,
    tags,
    first_seen_at: firstSeen.length ? new Date(Math.min(...firstSeen.map((date) => date.getTime()))) : new Date(),
    custom: { ...(other.custom ?? {}), ...(kept.custom ?? {}) },
    archived_at: kept.archived_at && other.archived_at ? kept.archived_at : null,
  };
}

/** What the target takes from the source: only its blanks. Pure. */
export function mergedContactFill(target, source) {
  const fill = fillBlanks(target, {
    firstName: source.first_name,
    lastName: source.last_name,
    kind: source.kind,
    city: source.city,
    countryCode: source.country_code,
    timeZone: source.time_zone,
    language: source.language,
    studentProfile: source.student_profile ?? {},
  });
  if (!target.date_of_birth && source.date_of_birth) fill.date_of_birth = source.date_of_birth;
  if (isEmptyObject(target.address) && !isEmptyObject(source.address)) fill.address = source.address;
  if (fill.first_name !== undefined) {
    const name = displayName(fill.first_name, fill.last_name ?? target.last_name);
    fill.display_name = name || UNNAMED_CONTACT;
    fill.name_normalized = normalizeName(name);
  }
  return fill;
}

async function loadSource(req, sourceId, trx) {
  try {
    return await loadVisibleContact(req, sourceId, { trx });
  } catch (error) {
    if (error.status !== 404) throw error;
    const message = error.code === 'merged' ? 'This contact was already merged into another one' : 'Contact not found';
    throw errors.validation([{ path: 'body.sourceId', message }]);
  }
}

/**
 * Merge `sourceId` into `targetId` inside the caller's transaction. Both must be visible to the
 * viewer, who needs contacts.merge at every company that knows either person.
 * @returns {Promise<{ targetId: string, sourceId: string, companyIds: string[] }>}
 */
export async function mergeContacts(trx, { targetId, sourceId }, { req }) {
  if (targetId === sourceId) throw errors.validation([{ path: 'body.sourceId', message: 'Pick a different contact to merge' }]);
  // Lock both people in a fixed order so two merges of the same pair can't deadlock.
  await trx('contacts').whereIn('id', [targetId, sourceId]).orderBy('id').forUpdate().select('id');
  const unitsById = await unitsIndex(req, trx);
  const target = await loadVisibleContact(req, targetId, { trx });
  const source = await loadSource(req, sourceId, trx);
  const t = target.contact;
  const s = source.contact;
  if (t.group_id !== s.group_id) throw errors.validation([{ path: 'body.sourceId', message: 'Contact not found' }]);
  if (!target.canMerge || !source.canMerge) {
    throw errors.forbidden('Merging needs the merge permission at every company that knows these people');
  }
  if (t.erased_at || s.erased_at) throw errors.conflict('Erased contacts can’t be merged');

  // 1. Contact methods: the target keeps its own; the source's move unless the target has the
  //    same value (then the stricter opt-out and any verification carry over).
  await trx.raw(
    `update contact_methods t
        set opted_out_at = coalesce(t.opted_out_at, s.opted_out_at),
            verified_at = coalesce(t.verified_at, s.verified_at),
            updated_at = now()
       from contact_methods s
      where s.contact_id = ? and t.contact_id = ? and t.kind = s.kind and t.normalized = s.normalized`,
    [sourceId, targetId],
  );
  await trx.raw(
    `delete from contact_methods s using contact_methods t
      where s.contact_id = ? and t.contact_id = ? and t.kind = s.kind and t.normalized = s.normalized`,
    [sourceId, targetId],
  );
  await trx.raw(
    `update contact_methods s set is_primary = false
      where s.contact_id = ? and s.is_primary
        and exists (select 1 from contact_methods t where t.contact_id = ? and t.kind = s.kind and t.is_primary)`,
    [sourceId, targetId],
  );
  await trx('contact_methods').where({ contact_id: sourceId }).update({ contact_id: targetId, updated_at: trx.fn.now() });

  // 2. Company links: a company that knew both keeps the target's link, filled from the source's.
  const targetLinks = new Map(target.links.map((link) => [link.company_id, link]));
  for (const link of source.links) {
    const kept = targetLinks.get(link.company_id);
    if (!kept) {
      await trx('contact_companies').where({ id: link.id }).update({ contact_id: targetId, updated_at: trx.fn.now() });
      continue;
    }
    const values = mergeLinkValues(kept, link);
    await trx('contact_companies').where({ id: link.id }).delete();
    await trx('contact_companies')
      .where({ id: kept.id })
      .update({
        ...values,
        source: values.source ? json(values.source) : null,
        custom: json(values.custom),
        updated_at: trx.fn.now(),
      });
  }

  // 3. Households, institutes and deals the source takes part in.
  for (const { table, key, primary } of MEMBERSHIPS) {
    if (primary) {
      await trx.raw(
        `update ${table} t set is_primary = true from ${table} s
          where s.contact_id = ? and t.contact_id = ? and t.${key} = s.${key} and s.is_primary and not t.is_primary`,
        [sourceId, targetId],
      );
    }
    await trx.raw(
      `update ${table} s set contact_id = ?
        where s.contact_id = ? and not exists (select 1 from ${table} t where t.contact_id = ? and t.${key} = s.${key})`,
      [targetId, sourceId, targetId],
    );
    await trx(table).where({ contact_id: sourceId }).delete();
  }

  // 4. Everything else that points at the person.
  await trx('deals').where({ primary_contact_id: sourceId }).update({ primary_contact_id: targetId });
  await trx('tasks').where({ contact_id: sourceId }).update({ contact_id: targetId });
  await trx('consents').where({ contact_id: sourceId }).update({ contact_id: targetId });
  await trx('timeline_events').where({ contact_id: sourceId }).update({ contact_id: targetId });
  await trx('timeline_events_archive').where({ contact_id: sourceId }).update({ contact_id: targetId });
  await trx('contacts').where({ merged_into_id: sourceId }).update({ merged_into_id: targetId });

  // 5. The source becomes a tombstone; the target fills its blanks.
  await trx('contacts').where({ id: sourceId }).update({ merged_into_id: targetId, merged_at: trx.fn.now(), updated_at: trx.fn.now() });
  const fill = mergedContactFill(t, s);
  if (fill.student_profile) fill.student_profile = json(fill.student_profile);
  if (fill.address) fill.address = json(fill.address);
  if (Object.keys(fill).length > 0) await trx('contacts').where({ id: targetId }).update(fill);
  await syncPrimaries(trx, targetId);

  // 6. Search, timeline, event and audit.
  await removeSearchDocument(trx, 'contact', sourceId);
  await refreshContactSearch(trx, targetId);
  const userId = req.auth.user.id;
  await addTimelineEvent(trx, {
    groupId: t.group_id,
    contactId: targetId,
    kind: 'system',
    title: `Merged with ${s.display_name}`,
    meta: { action: 'contact.merged', sourceId },
    actorType: 'user',
    actorUserId: userId,
  });
  const companyIds = [...new Set([...target.links, ...source.links].map((link) => link.company_id))];
  const unit = changeUnit(t, actingLink(req, unitsById, target.visibleLinks));
  await emitEvent(trx, {
    type: 'contact.merged',
    groupId: t.group_id,
    unitId: unit.id,
    aggregateType: 'contact',
    aggregateId: targetId,
    actorUserId: userId,
    payload: { targetId, sourceId, companyIds },
  });
  await writeAudit(trx, req, {
    action: 'contact.merged',
    entityType: 'contact',
    entityId: targetId,
    unit,
    after: { sourceId, sourceName: s.display_name, filled: Object.keys(fill) },
    meta: { companyIds },
  });
  return { targetId, sourceId, companyIds };
}
