import { normalizeName, phoneSearchTokens } from './normalize.js';

// Global search reads one table, search_documents: one row per deal, contact and account, written
// in the same transaction as the change (upsertSearchDocument / refreshSearchDocument) and repaired
// by the search module's event handlers and reindex CLI.
//
// Visibility (docs/crm/PHASE2_CONTRACT.md §9.10):
//   deal     company_id, unit_id and owner_user_id are set; filtered like deals.view
//   contact  group-level (company_id and unit_id are null); visible through contact_companies
//   account  group-level; visible through account_companies
// `keywords` hold normalised phones, emails and codes for matching only. The API never returns
// them, and titles and subtitles never contain personal details, so results need no masking.

/** Map.groupBy, which Node 20 doesn't have. */
function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

const DOC_COLUMNS = [
  'entity_type',
  'entity_id',
  'group_id',
  'company_id',
  'unit_id',
  'owner_user_id',
  'title',
  'subtitle',
  'keywords',
  'updated_at',
];

/** Unique lower-case tokens, phones expanded to the forms people type. */
export function searchKeywords({ phones = [], emails = [], codes = [], words = [] } = {}) {
  const tokens = new Set();
  for (const phone of phones) for (const token of phoneSearchTokens(phone)) tokens.add(token);
  for (const email of emails) if (email) tokens.add(String(email).toLowerCase());
  for (const code of codes) if (code !== null && code !== undefined && code !== '') tokens.add(String(code).toLowerCase());
  for (const word of words) for (const token of normalizeName(word).split(' ')) if (token) tokens.add(token);
  return [...tokens].join(' ');
}

const KIND_LABELS = { parent: 'Parent', student: 'Student', staff: 'Institute staff', other: 'Contact' };

/**
 * The document for a contact.
 * @param {object} contact contacts row
 * @param {Array<{ kind: string, normalized: string }>} methods its contact_methods rows
 */
export function contactDocument(contact, methods = []) {
  const subtitle = [KIND_LABELS[contact.kind] ?? 'Contact', contact.city, contact.student_profile?.grade ? `Grade ${contact.student_profile.grade}` : null]
    .filter(Boolean)
    .join(' · ');
  return {
    entity_type: 'contact',
    entity_id: contact.id,
    group_id: contact.group_id,
    company_id: null,
    unit_id: null,
    owner_user_id: null,
    title: contact.display_name,
    subtitle,
    keywords: searchKeywords({
      phones: methods.filter((m) => m.kind !== 'email').map((m) => m.normalized),
      emails: methods.filter((m) => m.kind === 'email').map((m) => m.normalized),
    }),
    updated_at: contact.updated_at ?? new Date(),
  };
}

/** The document for an account (institute). */
export function accountDocument(account) {
  const subtitle = [account.kind?.replace(/_/g, ' '), account.city].filter(Boolean).join(' · ');
  return {
    entity_type: 'account',
    entity_id: account.id,
    group_id: account.group_id,
    company_id: null,
    unit_id: null,
    owner_user_id: null,
    title: account.name,
    subtitle: subtitle.charAt(0).toUpperCase() + subtitle.slice(1),
    keywords: searchKeywords({
      phones: account.primary_phone ? [account.primary_phone] : [],
      emails: account.primary_email ? [account.primary_email] : [],
      codes: [account.domain],
      words: [account.legal_name],
    }),
    updated_at: account.updated_at ?? new Date(),
  };
}

/**
 * The document for a deal. Extras come from joins: the stage name, the product line name, and the
 * main contact's or institute's name and normalised phones and emails (so a phone search finds the lead).
 */
export function dealDocument(deal, { stageName, productLineName, contactName, accountName, phones = [], emails = [] } = {}) {
  return {
    entity_type: 'deal',
    entity_id: deal.id,
    group_id: deal.group_id,
    company_id: deal.company_id,
    unit_id: deal.unit_id,
    owner_user_id: deal.owner_user_id ?? null,
    title: deal.title,
    subtitle: [deal.ref, productLineName, stageName].filter(Boolean).join(' · '),
    keywords: searchKeywords({
      phones,
      emails,
      codes: [deal.ref, deal.number],
      words: [contactName, accountName].filter(Boolean),
    }),
    updated_at: deal.updated_at ?? new Date(),
  };
}

/** Insert or update documents (one statement for many). */
export async function upsertSearchDocuments(trx, docs) {
  if (docs.length === 0) return 0;
  const rows = docs.map((doc) => Object.fromEntries(DOC_COLUMNS.map((column) => [column, doc[column] ?? null])));
  await trx('search_documents')
    .insert(rows)
    .onConflict(['entity_type', 'entity_id'])
    .merge(DOC_COLUMNS.filter((column) => column !== 'entity_type' && column !== 'entity_id'));
  return rows.length;
}

/** Insert or update one document, in the same transaction as the change it reflects. */
export const upsertSearchDocument = (trx, doc) => upsertSearchDocuments(trx, [doc]);

/** Remove a document (archived deal, merged or erased contact, ...). */
export async function removeSearchDocument(trx, entityType, entityId) {
  await trx('search_documents').where({ entity_type: entityType, entity_id: entityId }).delete();
}

// ---------- Building documents from the database ----------

async function loadContactDocs(trx, ids) {
  const contacts = await trx('contacts').whereIn('id', ids).whereNull('merged_into_id').whereNull('erased_at');
  if (contacts.length === 0) return [];
  const methods = await trx('contact_methods').whereIn('contact_id', contacts.map((c) => c.id)).select('contact_id', 'kind', 'normalized');
  const byContact = groupBy(methods, (m) => m.contact_id);
  return contacts.map((contact) => contactDocument(contact, byContact.get(contact.id) ?? []));
}

async function loadAccountDocs(trx, ids) {
  const accounts = await trx('accounts').whereIn('id', ids).whereNull('merged_into_id');
  return accounts.map(accountDocument);
}

async function loadDealDocs(trx, ids) {
  const deals = await trx('deals as d')
    .leftJoin('pipeline_stages as s', 's.id', 'd.stage_id')
    .leftJoin('product_lines as pl', 'pl.id', 'd.product_line_id')
    .leftJoin('contacts as c', 'c.id', 'd.primary_contact_id')
    .leftJoin('accounts as a', 'a.id', 'd.account_id')
    .whereIn('d.id', ids)
    .whereNull('d.archived_at')
    .select('d.*', 's.name as stage_name', 'pl.name as product_line_name', 'c.display_name as contact_name', 'a.name as account_name');
  if (deals.length === 0) return [];
  const contactIds = [...new Set(deals.map((d) => d.primary_contact_id).filter(Boolean))];
  const methods = contactIds.length
    ? await trx('contact_methods').whereIn('contact_id', contactIds).select('contact_id', 'kind', 'normalized')
    : [];
  const byContact = groupBy(methods, (m) => m.contact_id);
  return deals.map((deal) => {
    const own = byContact.get(deal.primary_contact_id) ?? [];
    return dealDocument(deal, {
      stageName: deal.stage_name,
      productLineName: deal.product_line_name,
      contactName: deal.contact_name,
      accountName: deal.account_name,
      phones: own.filter((m) => m.kind !== 'email').map((m) => m.normalized),
      emails: own.filter((m) => m.kind === 'email').map((m) => m.normalized),
    });
  });
}

const LOADERS = { contact: loadContactDocs, account: loadAccountDocs, deal: loadDealDocs };

/**
 * Rebuild the documents for some records from the database: upserts the ones that should be
 * searchable and removes the rest (archived deals, merged or erased contacts, missing rows).
 * @returns {Promise<{ upserted: number, removed: number }>}
 */
export async function refreshSearchDocuments(trx, entityType, ids) {
  const load = LOADERS[entityType];
  if (!load) throw new TypeError(`Unknown search entity "${entityType}"`);
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return { upserted: 0, removed: 0 };
  const docs = await load(trx, unique);
  await upsertSearchDocuments(trx, docs);
  const kept = new Set(docs.map((doc) => doc.entity_id));
  const gone = unique.filter((id) => !kept.has(id));
  if (gone.length) await trx('search_documents').where({ entity_type: entityType }).whereIn('entity_id', gone).delete();
  return { upserted: docs.length, removed: gone.length };
}

/** Rebuild one document. */
export const refreshSearchDocument = (trx, entityType, id) => refreshSearchDocuments(trx, entityType, [id]);

const TABLES = { contact: 'contacts', account: 'accounts', deal: 'deals' };

/**
 * Remove documents whose record no longer exists at all (refreshing by id can't see those).
 * @returns {Promise<number>} documents removed
 */
export async function pruneSearchDocuments(knex, entityType, { groupId } = {}) {
  const table = TABLES[entityType];
  if (!table) throw new TypeError(`Unknown search entity "${entityType}"`);
  return knex('search_documents as sd')
    .where('sd.entity_type', entityType)
    .modify((query) => {
      if (groupId) query.where('sd.group_id', groupId);
    })
    .whereNotExists(knex(table).select(knex.raw('1')).whereRaw('??.id = sd.entity_id', [table]))
    .delete();
}

/**
 * Rebuild every document of a kind (or all kinds), in id order and batches, optionally for one group.
 * Used by the seed and the reindex CLI. Safe to run while the app is in use.
 * With `prune`, documents of records that are gone entirely are removed afterwards (reported to
 * onBatch as `{ entityType, upserted: 0, removed, pruned: true }`).
 */
export async function reindexSearch(
  knex,
  { entityTypes = ['contact', 'account', 'deal'], groupId, batchSize = 500, onBatch, prune = false } = {},
) {
  const totals = {};
  for (const entityType of entityTypes) {
    let after = null;
    let count = 0;
    for (;;) {
      const ids = await knex(TABLES[entityType])
        .modify((query) => {
          if (groupId) query.where({ group_id: groupId });
          if (after) query.where('id', '>', after);
        })
        .orderBy('id')
        .limit(batchSize)
        .pluck('id');
      if (ids.length === 0) break;
      const result = await refreshSearchDocuments(knex, entityType, ids);
      count += result.upserted;
      after = ids[ids.length - 1];
      onBatch?.({ entityType, ...result });
      if (ids.length < batchSize) break;
    }
    if (prune) {
      const removed = await pruneSearchDocuments(knex, entityType, { groupId });
      onBatch?.({ entityType, upserted: 0, removed, pruned: true });
    }
    totals[entityType] = count;
  }
  return totals;
}
