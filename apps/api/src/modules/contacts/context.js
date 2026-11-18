import { db } from '../../lib/db.js';
import { primaryEmailOf, primaryPhoneOf } from '../../core/crm/contacts.js';
import { refreshSearchDocument, refreshSearchDocuments } from '../../core/crm/search.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { decideRecordAccess, levelForRecord, unitsIndex } from '../../core/crm/scope.js';
import { defaultCountrySetting, fuzzyMatchThresholdSetting } from '../../core/crm/settings.js';

// Small helpers shared by the contacts module's services.

/**
 * Run independent reads: in parallel on the pool, one after another inside a transaction (which has a
 * single connection). Items are query builders (lazy) or functions that start async work.
 */
export async function inOrder(trx, items) {
  const run = (item) => (typeof item === 'function' ? item() : item);
  if (!trx?.isTransaction) return Promise.all(items.map(run));
  const out = [];
  for (const item of items) out.push(await run(item));
  return out;
}

/** Map.groupBy, which Node 20 doesn't have. */
export function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/**
 * How the viewer reaches each of several people (links and deals in two queries), for lists of
 * household members and duplicate candidates. Map<contactId, decideRecordAccess result>.
 */
export async function decideContacts(req, contactIds, trx = db) {
  const ids = [...new Set(contactIds)].filter(Boolean);
  const out = new Map();
  if (ids.length === 0) return out;
  const [unitsById, links, deals] = await inOrder(trx, [
    () => unitsIndex(req, trx),
    trx('contact_companies').whereIn('contact_id', ids),
    trx('deal_contacts as dc')
      .join('deals as d', 'd.id', 'dc.deal_id')
      .whereIn('dc.contact_id', ids)
      .whereNull('d.archived_at')
      .select('dc.contact_id', 'd.id', 'd.unit_id', 'd.company_id', 'd.owner_user_id'),
  ]);
  const linksBy = groupBy(links, (row) => row.contact_id);
  const dealsBy = groupBy(deals, (row) => row.contact_id);
  for (const id of ids) {
    out.set(
      id,
      decideRecordAccess({
        access: req.access,
        unitsById,
        userId: req.auth.user.id,
        links: linksBy.get(id) ?? [],
        deals: dealsBy.get(id) ?? [],
      }),
    );
  }
  return out;
}

/**
 * The company link a change is recorded through: the first visible link the viewer can manage,
 * else the first visible one (null when the person is visible only through a deal).
 */
export function actingLink(req, unitsById, visibleLinks) {
  const userId = req.auth.user.id;
  return (
    visibleLinks.find((link) => levelForRecord(req.access, unitsById, 'contacts.manage', link, { userId })) ??
    visibleLinks[0] ??
    null
  );
}

/** Audit and event unit of a change to a person: the acting link's unit, else the group. */
export const changeUnit = (contact, link) => ({ id: link?.unit_id ?? contact.group_id, root_id: contact.group_id });

/** contacts.defaultCountry and contacts.fuzzyMatchThreshold at a unit, in one query. */
export async function contactSettingsAt(unit, trx = db) {
  const resolved = await getEffectiveSettings(unit, [defaultCountrySetting, fuzzyMatchThresholdSetting], trx);
  return {
    defaultCountry: resolved[defaultCountrySetting.key].value,
    threshold: Number(resolved[fuzzyMatchThresholdSetting.key].value),
  };
}

/** Users by id (one query), for owner and actor names. */
export async function usersById(ids, trx = db) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await trx('users').whereIn('id', unique).select('id', 'name');
  return new Map(rows.map((row) => [row.id, row]));
}

/** Postgres timestamps keep microseconds; JavaScript dates don't. Keyset cursors carry the full value. */
export const sortTimestamp = (column, alias = 'sort_key') =>
  db.raw(`to_char(?? at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ??`, [column, alias]);

/** Escape LIKE wildcards in user input. */
export const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Search documents of the person and of the deals they are the main contact of (deal documents carry their name and numbers). */
export async function refreshContactSearch(trx, contactId) {
  await refreshSearchDocument(trx, 'contact', contactId);
  const dealIds = await trx('deals').where({ primary_contact_id: contactId }).pluck('id');
  if (dealIds.length > 0) await refreshSearchDocuments(trx, 'deal', dealIds);
}

/** Keep contacts.primary_phone / primary_email in step with the methods. */
export async function syncPrimaries(trx, contactId) {
  const rows = await trx('contact_methods').where({ contact_id: contactId }).select('kind', 'normalized', 'is_primary');
  const methods = rows.map((row) => ({ kind: row.kind, normalized: row.normalized, isPrimary: row.is_primary }));
  const [contact] = await trx('contacts')
    .where({ id: contactId })
    .update({ primary_phone: primaryPhoneOf(methods), primary_email: primaryEmailOf(methods), updated_at: trx.fn.now() })
    .returning('*');
  return contact;
}

