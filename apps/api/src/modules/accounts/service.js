import { randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { webUrlSchema } from '../../lib/schemas.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { isKnownChannel } from '../../core/crm/channels.js';
import { accountKind } from '../../core/crm/constants.js';
import { findOrCreateContact } from '../../core/crm/contacts.js';
import { piiCustomDefinitions, validateCustomValues, withoutMaskedEchoes } from '../../core/crm/customFields.js';
import { emailDomain, isFreeEmailDomain, normalizeDomain, normalizeEmail, normalizeName, normalizePhone } from '../../core/crm/normalize.js';
import { accountDocument, refreshSearchDocuments, upsertSearchDocument } from '../../core/crm/search.js';
import { crmSetting, defaultCountrySetting, fuzzyMatchThresholdSetting } from '../../core/crm/settings.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import {
  applyUnitFilter,
  canViewPiiAt,
  companyOf,
  levelForRecord,
  listScope,
  loadVisibleAccount,
  loadVisibleContact,
  requireCreateUnit,
  scopeFromPaths,
  scopePaths,
  unitsIndex,
  userLevelAt,
} from '../../core/crm/scope.js';
import { accountDedupKeys, accountDomain, accountLockKeys, accountNameKey, chooseAccountMatch, fillAccountBlanks } from './dedup.js';
import { presentAccountContact, presentAccountListItem, presentDealSummary, presentLink } from './present.js';

// Institutes (B2B accounts): stored once per group, known to companies through account_companies,
// with their people in account_contacts. docs/crm/PHASE2_CONTRACT.md §9.2.

const OPEN_DEALS_SHOWN = 20;
const CLOSED_DEALS_SHOWN = 10;

const ROLE_WORDS = {
  decision_maker: 'decision maker',
  influencer: 'influencer',
  champion: 'champion',
  user: 'user',
  billing: 'billing contact',
  other: 'contact',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Microsecond-exact UTC text of a timestamp, so keyset cursors never skip or repeat rows. */
const exactTimestamp = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Sorts of GET /accounts and the expressions their cursors carry (indexes: contract §5.14). */
const SORTS = {
  '-updatedAt': { column: 'a.updated_at', direction: 'desc', cast: 'timestamptz', value: exactTimestamp('a.updated_at') },
  '-createdAt': { column: 'a.created_at', direction: 'desc', cast: 'timestamptz', value: exactTimestamp('a.created_at') },
  name: { column: 'a.name_normalized', direction: 'asc', cast: 'text', value: 'a.name_normalized' },
};

/** The company's custom institute fields (entity "account"). */
function accountFieldDefinitions(companyId, trx = db) {
  return trx('custom_field_definitions').where({ company_id: companyId, entity: 'account', active: true }).orderBy('position');
}

async function contactSettings(companyUnit, trx = db) {
  const resolved = await getEffectiveSettings(companyUnit, [defaultCountrySetting, fuzzyMatchThresholdSetting], trx);
  return {
    defaultCountry: resolved[defaultCountrySetting.key].value,
    nameThreshold: resolved[fuzzyMatchThresholdSetting.key].value,
  };
}

function usersMap(rows) {
  return new Map(rows.filter((row) => row.id).map((row) => [row.id, row]));
}

async function loadUsers(ids, trx = db) {
  const unique = [...new Set(ids.filter(Boolean))];
  return usersMap(unique.length ? await trx('users').whereIn('id', unique).select('id', 'name') : []);
}

const byCompanyName = (unitsById) => (a, b) =>
  (unitsById.get(a.company_id)?.name ?? '').localeCompare(unitsById.get(b.company_id)?.name ?? '');

// ---------- List ----------

/** Owner filter values: a user id, "me" or "none". */
function applyOwnerFilter(query, owners, userId, column) {
  const ids = owners.filter((value) => value !== 'none').map((value) => (value === 'me' ? userId : value));
  const none = owners.includes('none');
  query.where((where) => {
    if (ids.length) where.orWhereIn(column, ids);
    if (none) where.orWhereNull(column);
  });
}

/**
 * Keep institutes with a company link in scope that also matches the link filters (status, owner,
 * tags). One EXISTS, so the filters only ever look at links the user may see.
 */
function whereVisibleLink(query, scope, filters) {
  return query.whereExists(function linked() {
    this.select(db.raw('1')).from('account_companies as l').whereRaw('l.account_id = a.id');
    if (!filters.includeArchived) this.whereNull('l.archived_at');
    if (scope.company) this.where('l.company_id', scope.company.id);
    applyUnitFilter(this, scope, { unitColumn: 'l.unit_id', ownerColumns: ['l.owner_user_id'] });
    if (filters.status?.length) this.whereIn('l.status', filters.status);
    if (filters.tag?.length) this.whereRaw('l.tags && ?::text[]', [filters.tag]);
    if (filters.owner?.length) applyOwnerFilter(this, filters.owner, scope.userId, 'l.owner_user_id');
  });
}

/**
 * The search box: an email or domain finds the institute's web domain (and exact email), a phone
 * number its phone, anything else the name (contains, or similar by trigrams).
 */
async function applySearch(query, q, scope) {
  const text = q.trim();
  const name = normalizeName(text) || text.toLowerCase();
  const nameMatch = (where) =>
    where.orWhere('a.name_normalized', 'like', `%${escapeLike(name)}%`).orWhereRaw('a.name_normalized % ?', [name]);

  if (text.includes('@')) {
    const email = normalizeEmail(text);
    const domain = email ? emailDomain(email) : normalizeDomain(text);
    query.where((where) => {
      if (email) where.orWhere('a.primary_email', email);
      if (domain && !isFreeEmailDomain(domain)) where.orWhere('a.domain', domain);
      if (!email && !domain) where.whereRaw('false');
    });
    return;
  }
  if (/^[+(]?[\d\s().-]{7,}$/.test(text)) {
    const country = await crmSetting(scope.company ?? scope.unit, defaultCountrySetting);
    const phone = normalizePhone(text, country);
    if (phone) {
      query.where('a.primary_phone', phone.e164);
      return;
    }
  }
  const domain = /\s/.test(text) ? null : normalizeDomain(text);
  query.where((where) => {
    if (domain) where.orWhere('a.domain', domain);
    nameMatch(where);
  });
}

/** GET /accounts → Page<AccountListItem>. */
export async function listAccounts(req, filters) {
  const scope = await listScope(req, 'accounts.view', { unitId: filters.unitId });
  const unitsById = await unitsIndex(req);
  const sort = SORTS[filters.sort];
  const after = decodeCursor(filters.cursor);
  // A cursor only continues the list it came from (same sort).
  if (after && (after.s !== filters.sort || typeof after.v !== 'string' || typeof after.id !== 'string' || !UUID.test(after.id))) {
    throw errors.badRequest('Invalid cursor');
  }

  const query = db('accounts as a').where('a.group_id', scope.groupId).whereNull('a.merged_into_id');
  whereVisibleLink(query, scope, filters);
  if (filters.q) await applySearch(query, filters.q, scope);
  if (filters.kind?.length) query.whereIn('a.kind', filters.kind);
  if (filters.city?.length) query.whereRaw('lower(a.city) = any(?::text[])', [filters.city.map((c) => c.toLowerCase())]);
  if (filters.state?.length) query.whereRaw('lower(a.state) = any(?::text[])', [filters.state.map((s) => s.toLowerCase())]);
  if (filters.currentSoftware) query.whereILike('a.current_software', `%${escapeLike(filters.currentSoftware)}%`);
  if (filters.studentCountMin !== undefined) query.where('a.student_count', '>=', filters.studentCountMin);
  if (filters.studentCountMax !== undefined) query.where('a.student_count', '<=', filters.studentCountMax);
  if (after) {
    const op = sort.direction === 'desc' ? '<' : '>';
    query.whereRaw(`(${sort.column}, a.id) ${op} (?::${sort.cast}, ?::uuid)`, [after.v, after.id]);
  }
  const rows = await query
    .orderBy([
      { column: sort.column, order: sort.direction },
      { column: 'a.id', order: sort.direction },
    ])
    .limit(filters.limit + 1)
    .select('a.*', db.raw(`${sort.value} as sort_value`));

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ s: filters.sort, v: last.sort_value, id: last.id }) : null;
  if (page.length === 0) return { data: [], nextCursor: null };

  const ids = page.map((row) => row.id);
  const [links, dealCounts] = await Promise.all([
    db('account_companies as l')
      .leftJoin('users as u', 'u.id', 'l.owner_user_id')
      .whereIn('l.account_id', ids)
      .select('l.*', 'u.name as owner_name'),
    db('deals')
      .whereIn('account_id', ids)
      .where('status', 'open')
      .whereNull('archived_at')
      .groupBy('account_id', 'company_id')
      .select('account_id', 'company_id', db.raw('count(*)::int as count')),
  ]);
  const usersById = usersMap(links.map((link) => ({ id: link.owner_user_id, name: link.owner_name })));
  const userId = req.auth.user.id;

  const data = page.map((row) => {
    const visible = links
      .filter((link) => link.account_id === row.id)
      .filter((link) => levelForRecord(req.access, unitsById, 'accounts.view', link, { userId }))
      .sort(byCompanyName(unitsById));
    const active = visible.filter((link) => !link.archived_at);
    const companyIds = new Set(active.map((link) => link.company_id));
    const openDealCount = dealCounts
      .filter((count) => count.account_id === row.id && companyIds.has(count.company_id))
      .reduce((sum, count) => sum + count.count, 0);
    return presentAccountListItem(row, {
      canViewPii: canViewPiiAt(req.access, unitsById, visible.map((link) => link.unit_id)),
      companies: active.map((link) => unitsById.get(link.company_id)).filter(Boolean),
      link: scope.company ? (visible.find((link) => link.company_id === scope.company.id) ?? null) : null,
      openDealCount,
      usersById,
    });
  });
  return { data, nextCursor };
}

// ---------- Detail ----------

/** The deals.view scope across the whole group, for deals shown inside an institute page. */
function groupDealScope(req, unitsById, groupId) {
  const group = unitsById.get(groupId);
  return scopeFromPaths({
    permission: 'deals.view',
    userId: req.auth.user.id,
    unit: group,
    unitsById,
    paths: scopePaths(req.access, 'deals.view'),
  });
}

function visibleDealsQuery(req, unitsById, account, trx) {
  const scope = groupDealScope(req, unitsById, account.group_id);
  const query = trx('deals as d')
    .join('pipeline_stages as s', 's.id', 'd.stage_id')
    .leftJoin('users as u', 'u.id', 'd.owner_user_id')
    .where('d.account_id', account.id)
    .where('d.group_id', account.group_id)
    .whereNull('d.archived_at');
  applyUnitFilter(query, scope, { unitColumn: 'd.unit_id', ownerColumns: ['d.owner_user_id'] });
  return query.select(
    'd.id',
    'd.ref',
    'd.title',
    'd.status',
    'd.kind',
    'd.company_id',
    'd.stage_id',
    'd.owner_user_id',
    'd.value_minor',
    'd.currency',
    'd.updated_at',
    's.key as s_key',
    's.name as s_name',
    's.category as s_category',
    's.colour as s_colour',
    'u.name as owner_name',
  );
}

function accountContactsQuery(accountId, trx = db) {
  return trx('account_contacts as ac')
    .join('contacts as c', 'c.id', 'ac.contact_id')
    .where('ac.account_id', accountId)
    .whereNull('c.merged_into_id')
    .orderBy([
      { column: 'ac.is_primary', order: 'desc' },
      { column: db.raw("(ac.role = 'decision_maker')"), order: 'desc' },
      { column: 'c.display_name', order: 'asc' },
    ])
    .select('c.*', 'ac.title as ac_title', 'ac.role as ac_role', 'ac.is_primary as ac_is_primary');
}

/** GET /accounts/:id → AccountDetail. */
export async function getAccount(req, accountId, { trx = db } = {}) {
  const decision = await loadVisibleAccount(req, accountId, { trx });
  return presentDetail(req, decision, trx);
}

async function presentDetail(req, decision, trx = db) {
  const { account, visibleLinks, canManage, canViewPii } = decision;
  const unitsById = await unitsIndex(req, trx);
  const links = [...visibleLinks].sort(byCompanyName(unitsById));
  const activeCompanyIds = [...new Set(links.filter((link) => !link.archived_at).map((link) => link.company_id))];

  const [contacts, openDeals, closedDeals, owners, openCount, piiFields] = await Promise.all([
    accountContactsQuery(account.id, trx),
    visibleDealsQuery(req, unitsById, account, trx)
      .where('d.status', 'open')
      .orderBy([
        { column: 'd.updated_at', order: 'desc' },
        { column: 'd.id', order: 'desc' },
      ])
      .limit(OPEN_DEALS_SHOWN),
    visibleDealsQuery(req, unitsById, account, trx)
      .whereNot('d.status', 'open')
      .orderBy([
        { column: 'd.closed_at', order: 'desc' },
        { column: 'd.id', order: 'desc' },
      ])
      .limit(CLOSED_DEALS_SHOWN),
    loadUsers(links.map((link) => link.owner_user_id), trx),
    activeCompanyIds.length
      ? trx('deals')
          .where({ account_id: account.id, status: 'open' })
          .whereNull('archived_at')
          .whereIn('company_id', activeCompanyIds)
          .count({ count: '*' })
          .first()
      : { count: 0 },
    // Phone and email custom fields on the links are masked like the institute's own phone and email.
    canViewPii ? [] : piiCustomDefinitions(trx, links.map((link) => link.company_id), 'account'),
  ]);
  for (const deal of [...openDeals, ...closedDeals]) {
    if (deal.owner_user_id && deal.owner_name) owners.set(deal.owner_user_id, { id: deal.owner_user_id, name: deal.owner_name });
  }

  const listItem = presentAccountListItem(account, {
    canViewPii,
    companies: activeCompanyIds.map((id) => unitsById.get(id)).filter(Boolean),
    link: links.length === 1 ? links[0] : null,
    openDealCount: Number(openCount?.count ?? 0),
    usersById: owners,
  });
  return {
    ...listItem,
    legalName: account.legal_name ?? null,
    website: account.website ?? null,
    domain: account.domain ?? null,
    countryCode: account.country_code ?? null,
    address: canViewPii ? (account.address ?? {}) : null,
    profile: account.profile ?? {},
    links: links.map((link) => presentLink(link, { unitsById, usersById: owners, piiFields })),
    contacts: contacts.map((row) => presentAccountContact(row, canViewPii)),
    openDeals: openDeals.map((row) => presentDealSummary(row, owners)),
    closedDeals: closedDeals.map((row) => presentDealSummary(row, owners)),
    can: { manage: canManage, viewPii: canViewPii },
  };
}

// ---------- Find or create (also for intake) ----------

function auditUnit(link, groupId) {
  return link ? { id: link.unit_id, root_id: groupId } : { id: groupId, root_id: groupId };
}

/**
 * Find the institute (same web domain, email, phone, or name in the same city, inside the group)
 * or create it, and make sure the company knows it (an account_companies link).
 *
 * Runs inside the caller's transaction and writes, as needed: the institute, the company link,
 * a system timeline entry, the search document, the account.created / account.company_linked /
 * account.updated event and (when `req` is given) the audit entry. Concurrent calls for the same
 * institute wait for each other (advisory locks on its keys).
 *
 * @param {import('knex').Knex.Transaction} trx
 * @param {{
 *   groupId: string, companyId: string, unitId: string,
 *   kind?: string, name: string, legalName?: string, website?: string, phone?: string, email?: string,
 *   city?: string, state?: string, countryCode?: string, address?: object,
 *   branchCount?: number, studentCount?: number, currentSoftware?: string, profile?: object,
 *   ownerUserId?: string | null, status?: 'lead' | 'customer' | 'former', tags?: string[],
 *   custom?: Record<string, unknown>, source?: object | null,
 *   mode?: 'link' | 'create', defaultCountry?: string, invalidValues?: 'throw' | 'skip', path?: string,
 *   actorUserId?: string | null, actorType?: 'user' | 'system' | 'ai', writeTimeline?: boolean
 * }} input
 * @param {{ req?: import('express').Request | null }} [context]
 * @returns {Promise<{ account: object, created: boolean, matchedBy: 'domain' | 'email' | 'phone' | 'name' | null, link: object, linkCreated: boolean }>}
 */
export async function findOrCreateAccount(trx, input, { req = null } = {}) {
  const { groupId, companyId, unitId } = input;
  if (!groupId || !companyId || !unitId) throw new TypeError('findOrCreateAccount needs groupId, companyId and unitId');
  const kind = input.kind ?? 'other';
  if (!accountKind(kind)) throw new TypeError(`Unknown institute kind "${kind}"`);
  const path = input.path ?? 'body';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw errors.validation([{ path: `${path}.name`, message: 'Enter the institute name' }]);
  const actorUserId = input.actorUserId ?? req?.auth?.user?.id ?? null;
  const actorType = input.actorType ?? (actorUserId ? 'user' : 'system');

  // The web app links to the website: only http(s), whoever calls (intake, imports, people).
  const website = input.website && webUrlSchema.safeParse(input.website).success ? input.website : null;
  const { keys, invalid } = accountDedupKeys(
    { name, city: input.city, website, phone: input.phone, email: input.email },
    { defaultCountry: input.defaultCountry ?? 'IN', path },
  );
  if (input.website && !website) invalid.push({ path: `${path}.website`, message: 'Enter a full link starting with https://' });
  if (invalid.length > 0 && input.invalidValues !== 'skip') throw errors.validation(invalid);

  // Serialise concurrent find-or-create calls for the same institute in this group.
  await trx.raw('select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(?::text[]) as k order by k', [accountLockKeys(groupId, keys)]);

  let match = null;
  if (input.mode !== 'create') {
    const candidates = await trx('accounts')
      .where({ group_id: groupId })
      .whereNull('merged_into_id')
      .where((where) => {
        if (keys.domain) where.orWhere('domain', keys.domain);
        if (keys.email) where.orWhere('primary_email', keys.email);
        if (keys.phone) where.orWhere('primary_phone', keys.phone);
        where.orWhere((byName) => byName.where('name_normalized', keys.name).whereRaw("lower(btrim(coalesce(city, ''))) = ?", [keys.city]));
      })
      .limit(20)
      .forUpdate();
    match = chooseAccountMatch(candidates, keys);
  }

  const details = {
    kind,
    legalName: input.legalName || null,
    website,
    domain: keys.domain,
    phone: keys.phone,
    email: keys.email,
    city: input.city || null,
    state: input.state || null,
    countryCode: input.countryCode || null,
    address: input.address ?? {},
    branchCount: input.branchCount ?? null,
    studentCount: input.studentCount ?? null,
    currentSoftware: input.currentSoftware || null,
    profile: input.profile ?? {},
  };

  let account;
  let created = false;
  let changedFields = [];
  if (match) {
    account = match.candidate;
    const changes = fillAccountBlanks(account, details);
    changedFields = Object.keys(changes);
    if (changedFields.length > 0) {
      if (changes.address) changes.address = json(changes.address);
      if (changes.profile) changes.profile = json(changes.profile);
      [account] = await trx('accounts')
        .where({ id: account.id })
        .update({ ...changes, updated_at: trx.fn.now() })
        .returning('*');
    }
  } else {
    [account] = await trx('accounts')
      .insert({
        id: randomUUID(),
        group_id: groupId,
        kind,
        name,
        name_normalized: keys.name,
        legal_name: details.legalName,
        website: details.website,
        domain: details.domain,
        primary_phone: details.phone,
        primary_email: details.email,
        city: details.city,
        state: details.state,
        country_code: details.countryCode,
        address: json(details.address),
        branch_count: details.branchCount,
        student_count: details.studentCount,
        current_software: details.currentSoftware,
        profile: json(details.profile),
        created_by: actorUserId,
      })
      .returning('*');
    created = true;
  }

  // The company's relationship with the institute. Owner, status, tags, custom values and source
  // apply only when this call creates it.
  const [insertedLink] = await trx('account_companies')
    .insert({
      id: randomUUID(),
      account_id: account.id,
      group_id: groupId,
      company_id: companyId,
      unit_id: unitId,
      owner_user_id: input.ownerUserId ?? null,
      status: input.status ?? 'lead',
      source: input.source ? json(input.source) : null,
      tags: input.tags ?? [],
      custom: json(input.custom ?? {}),
      created_by: actorUserId,
    })
    .onConflict(['account_id', 'company_id'])
    .ignore()
    .returning('*');
  const link = insertedLink ?? (await trx('account_companies').where({ account_id: account.id, company_id: companyId }).first());
  const linkCreated = Boolean(insertedLink);

  if (created || changedFields.length > 0) await upsertSearchDocument(trx, accountDocument(account));

  if ((created || linkCreated) && input.writeTimeline !== false) {
    await addTimelineEvent(trx, {
      groupId,
      companyId,
      unitId: link.unit_id,
      accountId: account.id,
      kind: 'system',
      title: created ? 'Institute added' : 'Institute added to this company',
      meta: { action: created ? 'account.created' : 'account.company_linked', channel: input.source?.channel ?? null },
      actorType,
      actorUserId,
    });
  }

  const event = created ? 'account.created' : linkCreated ? 'account.company_linked' : changedFields.length ? 'account.updated' : null;
  if (event) {
    await emitEvent(trx, {
      type: event,
      groupId,
      unitId: link.unit_id,
      aggregateType: 'account',
      aggregateId: account.id,
      actorUserId,
      payload: {
        accountId: account.id,
        companyId,
        unitId: link.unit_id,
        kind: account.kind,
        matchedBy: match?.matchedBy ?? null,
        ...(event === 'account.updated' ? { changes: changedFields } : {}),
      },
    });
    if (req) {
      await writeAudit(trx, req, {
        action: event === 'account.company_linked' ? 'account.linked' : event,
        entityType: 'account',
        entityId: account.id,
        unit: auditUnit(link, groupId),
        after: { kind: account.kind, name: account.name, companyId, matchedBy: match?.matchedBy ?? null, ...(event === 'account.updated' ? { changed: changedFields } : {}) },
      });
    }
  }

  return { account, created, matchedBy: match?.matchedBy ?? null, link, linkCreated };
}

// ---------- People at the institute ----------

function personNotFound(path) {
  return errors.validation([{ path, message: 'Contact not found' }]);
}

/** Load a contact the user may see, as a 422 on the field when it isn't (never revealing whether it exists). */
async function visibleContactFor(req, contactId, account, { trx, path }) {
  let contact;
  try {
    ({ contact } = await loadVisibleContact(req, contactId, { trx }));
  } catch (err) {
    if (err instanceof AppError && err.status === 404) throw personNotFound(path);
    throw err;
  }
  if (contact.group_id !== account.group_id) throw personNotFound(path);
  if (contact.erased_at) throw errors.validation([{ path, message: "This person's details were erased" }]);
  return contact;
}

/**
 * Add one person to an institute (account_contacts), with the system timeline entry, the event and
 * the audit entry. Returns the new row, or null when they were already there.
 */
async function attachContact(trx, req, { account, contact, title, role, isPrimary, place }) {
  const [row] = await trx('account_contacts')
    .insert({ account_id: account.id, contact_id: contact.id, title: title ?? null, role, is_primary: false })
    .onConflict(['account_id', 'contact_id'])
    .ignore()
    .returning('*');
  if (!row) return null;
  if (isPrimary) await setPrimary(trx, account.id, contact.id);

  const actorUserId = req.auth.user.id;
  await addTimelineEvent(trx, {
    groupId: account.group_id,
    accountId: account.id,
    contactId: contact.id,
    kind: 'system',
    title: `${contact.display_name} added as ${ROLE_WORDS[role] ?? 'contact'}`,
    meta: { action: 'account.contact_added', role },
    actorType: 'user',
    actorUserId,
  });
  await emitEvent(trx, {
    type: 'account.contact_added',
    groupId: account.group_id,
    unitId: place?.unitId ?? account.group_id,
    aggregateType: 'account',
    aggregateId: account.id,
    actorUserId,
    payload: { accountId: account.id, contactId: contact.id, role },
  });
  await writeAudit(trx, req, {
    action: 'account.contact_added',
    entityType: 'account',
    entityId: account.id,
    unit: place ? { id: place.unitId, root_id: account.group_id } : auditUnit(null, account.group_id),
    after: { contactId: contact.id, role, title: title ?? null, isPrimary: isPrimary === true },
  });
  return { ...row, is_primary: isPrimary === true };
}

/** One primary person per institute. */
async function setPrimary(trx, accountId, contactId) {
  await trx('account_contacts')
    .where({ account_id: accountId })
    .update({ is_primary: trx.raw('contact_id = ?', [contactId]), updated_at: trx.fn.now() });
}

/**
 * Where the user acts on an institute: the first link they can manage (its company and unit),
 * else a deal of the institute they work. Used for new people's company links, events and audit.
 */
async function actingPlace(req, decision, trx) {
  const unitsById = await unitsIndex(req, trx);
  const userId = req.auth.user.id;
  const link = [...decision.visibleLinks]
    .sort(byCompanyName(unitsById))
    .find((candidate) => levelForRecord(req.access, unitsById, 'accounts.manage', candidate, { userId }));
  if (link) return { companyId: link.company_id, unitId: link.unit_id, link };
  if (decision.visibleDealIds.length > 0) {
    const deals = await trx('deals').whereIn('id', decision.visibleDealIds).select('id', 'unit_id', 'company_id', 'owner_user_id');
    const deal = deals.find((candidate) => levelForRecord(req.access, unitsById, 'accounts.manage', candidate, { userId }));
    if (deal) return { companyId: deal.company_id, unitId: deal.unit_id, link: null };
  }
  return null;
}

async function resolvePerson(trx, req, account, entry, { place, settings, path }) {
  if (entry.contactId) return visibleContactFor(req, entry.contactId, account, { trx, path: `${path}.contactId` });
  const { contact } = await findOrCreateContact(
    trx,
    {
      ...entry.contact,
      kind: entry.contact.kind ?? 'staff',
      groupId: account.group_id,
      companyId: place.companyId,
      unitId: place.unitId,
      ownerUserId: req.auth.user.id,
      defaultCountry: settings.defaultCountry,
      nameThreshold: settings.nameThreshold,
      path: `${path}.contact`,
    },
    { req },
  );
  return contact;
}

// ---------- Writes ----------

function assertChannel(req, source, path = 'body.source.channel') {
  if (source && !isKnownChannel(req.app.locals.registry, source.channel)) {
    throw errors.validation([{ path, message: 'Unknown channel' }]);
  }
}

/**
 * The matched institute is already with this company, in a team (or with an owner) the user can't
 * see. Say so, and roll back, rather than writing to a record they would then get a 404 for.
 */
async function assertMatchVisible(req, found, company, trx) {
  try {
    await loadVisibleAccount(req, found.account.id, { trx });
  } catch (err) {
    if (!(err instanceof AppError) || err.status !== 404) throw err;
    throw errors.conflict(
      `This institute is already with another team in ${company.name}. Ask its owner or a company admin to share it with you.`,
      { matchedBy: found.matchedBy },
    );
  }
}

/** POST /accounts → AccountCreateResult. */
export async function createAccount(req, body) {
  const { unit, company, level } = await requireCreateUnit(req, body.unitId, 'accounts.manage');
  const userId = req.auth.user.id;
  const ownerUserId = body.ownerUserId === undefined ? userId : body.ownerUserId;
  if (level === 'own' && ownerUserId !== userId) throw errors.forbidden('You can only add institutes you own');
  assertChannel(req, body.source);
  const primaries = body.contacts.map((entry, index) => (entry.isPrimary ? index : -1)).filter((index) => index >= 0);
  if (primaries.length > 1) {
    throw errors.validation([{ path: `body.contacts.${primaries[1]}.isPrimary`, message: 'Only one person can be the main contact' }]);
  }

  const [settings, definitions, ownerLevel] = await Promise.all([
    contactSettings(company),
    accountFieldDefinitions(company.id),
    ownerUserId && ownerUserId !== userId ? userLevelAt(ownerUserId, unit, 'accounts.view') : 'all',
  ]);
  if (ownerUserId && !ownerLevel) {
    throw errors.validation([{ path: 'body.ownerUserId', message: `This person can't see institutes in ${unit.name}` }]);
  }
  // Types and options now; required fields only if this call creates the company's link.
  const custom = validateCustomValues(definitions, body.custom, { enforceRequired: false, defaultCountry: settings.defaultCountry });

  const result = await db.transaction(async (trx) => {
    const found = await findOrCreateAccount(
      trx,
      {
        groupId: unit.root_id,
        companyId: company.id,
        unitId: unit.id,
        kind: body.kind,
        name: body.name,
        legalName: body.legalName,
        website: body.website,
        phone: body.phone,
        email: body.email,
        city: body.city,
        state: body.state,
        countryCode: body.countryCode,
        address: body.address,
        branchCount: body.branchCount,
        studentCount: body.studentCount,
        currentSoftware: body.currentSoftware,
        profile: body.profile,
        ownerUserId,
        status: body.status,
        tags: body.tags,
        custom,
        source: body.source ?? null,
        mode: body.mode,
        defaultCountry: settings.defaultCountry,
      },
      { req },
    );
    if (found.linkCreated) validateCustomValues(definitions, custom, { enforceRequired: true, defaultCountry: settings.defaultCountry });
    else await assertMatchVisible(req, found, company, trx);

    const place = { companyId: company.id, unitId: found.link.unit_id };
    for (const [index, entry] of body.contacts.entries()) {
      const path = `body.contacts.${index}`;
      const contact = await resolvePerson(trx, req, found.account, entry, { place, settings, path });
      await attachContact(trx, req, { account: found.account, contact, title: entry.title, role: entry.role, isPrimary: entry.isPrimary, place });
    }
    if (body.contacts.length > 0 && !found.created) {
      await trx('accounts').where({ id: found.account.id }).update({ updated_at: trx.fn.now() });
    }
    return found;
  });

  return {
    account: await getAccount(req, result.account.id),
    created: result.created,
    matchedBy: result.matchedBy,
    linkCreated: result.linkCreated,
  };
}

const DETAIL_FIELDS = [
  ['kind', 'kind'],
  ['name', 'name'],
  ['legalName', 'legal_name'],
  ['website', 'website'],
  ['phone', 'primary_phone'],
  ['email', 'primary_email'],
  ['city', 'city'],
  ['state', 'state'],
  ['countryCode', 'country_code'],
  ['address', 'address'],
  ['branchCount', 'branch_count'],
  ['studentCount', 'student_count'],
  ['currentSoftware', 'current_software'],
  ['profile', 'profile'],
];
const PII_FIELDS = new Set(['phone', 'email', 'address']);
/** Logged by name only: personal data and free text. */
const NAMES_ONLY = new Set(['phone', 'email', 'address', 'profile']);

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** PATCH /accounts/:id → AccountDetail. */
export async function updateAccount(req, accountId, body) {
  await db.transaction(async (trx) => {
    const decision = await loadVisibleAccount(req, accountId, { trx, forUpdate: true });
    const { account } = decision;
    if (!decision.canManage) throw errors.forbidden("You can't edit this institute");
    if (Object.keys(body).some((key) => PII_FIELDS.has(key)) && !decision.canViewPii) {
      throw errors.forbidden("You can't change this institute's phone, email or address");
    }
    const place = await actingPlace(req, decision, trx);

    const next = { ...body };
    if (body.phone) {
      const unitsById = await unitsIndex(req, trx);
      const companyUnit = place ? unitsById.get(place.companyId) : unitsById.get(account.group_id);
      const country = await crmSetting(companyUnit, defaultCountrySetting, trx);
      const phone = normalizePhone(body.phone, country);
      if (!phone) throw errors.validation([{ path: 'body.phone', message: 'Enter a valid phone number' }]);
      next.phone = phone.e164;
    }
    if (body.email) {
      const email = normalizeEmail(body.email);
      if (!email) throw errors.validation([{ path: 'body.email', message: 'Enter a valid email address' }]);
      next.email = email;
    }
    if (body.address === null) next.address = {};
    if (body.profile === null) next.profile = {};

    const changes = {};
    const changed = [];
    const before = {};
    const after = {};
    for (const [field, column] of DETAIL_FIELDS) {
      if (next[field] === undefined || sameValue(next[field], account[column])) continue;
      changes[column] = column === 'address' || column === 'profile' ? json(next[field]) : next[field];
      changed.push(field);
      if (!NAMES_ONLY.has(field)) {
        before[field] = account[column] ?? null;
        after[field] = next[field];
      }
    }
    if (changed.length === 0) return;
    if (changes.name !== undefined) changes.name_normalized = accountNameKey(changes.name);
    if (changes.website !== undefined || changes.primary_email !== undefined) {
      const domain = accountDomain({
        website: changes.website !== undefined ? changes.website : account.website,
        email: changes.primary_email !== undefined ? changes.primary_email : account.primary_email,
      });
      if (domain !== (account.domain ?? null)) changes.domain = domain;
    }

    const [updated] = await trx('accounts')
      .where({ id: account.id })
      .update({ ...changes, updated_at: trx.fn.now() })
      .returning('*');
    await upsertSearchDocument(trx, accountDocument(updated));
    if (changes.name !== undefined) {
      // Deal documents carry the institute's name.
      const dealIds = await trx('deals').where({ account_id: account.id }).whereNull('archived_at').pluck('id');
      for (let i = 0; i < dealIds.length; i += 500) await refreshSearchDocuments(trx, 'deal', dealIds.slice(i, i + 500));
    }
    await emitEvent(trx, {
      type: 'account.updated',
      groupId: account.group_id,
      unitId: place?.unitId ?? account.group_id,
      aggregateType: 'account',
      aggregateId: account.id,
      actorUserId: req.auth.user.id,
      payload: { accountId: account.id, companyId: place?.companyId ?? null, changes: changed },
    });
    await writeAudit(trx, req, {
      action: 'account.updated',
      entityType: 'account',
      entityId: account.id,
      unit: place ? { id: place.unitId, root_id: account.group_id } : auditUnit(null, account.group_id),
      before,
      after: { ...after, changed },
    });
  });
  return getAccount(req, accountId);
}

/** PATCH /accounts/:id/links/:companyId → AccountDetail. */
export async function updateAccountLink(req, accountId, companyId, body) {
  await db.transaction(async (trx) => {
    const decision = await loadVisibleAccount(req, accountId, { trx, forUpdate: true });
    const { account } = decision;
    const unitsById = await unitsIndex(req, trx);
    const userId = req.auth.user.id;
    const link = decision.visibleLinks.find((candidate) => candidate.company_id === companyId);
    if (!link) throw errors.notFound('Company link');
    if (!levelForRecord(req.access, unitsById, 'accounts.manage', link, { userId })) {
      throw errors.forbidden("You can't change this company's relationship with the institute");
    }

    const changes = {};
    const changed = [];
    const before = {};
    const after = {};
    const note = (field, from, to) => {
      changed.push(field);
      before[field] = from;
      after[field] = to;
    };

    let unit = unitsById.get(link.unit_id);
    if (body.unitId !== undefined && body.unitId !== link.unit_id) {
      const target = unitsById.get(body.unitId);
      if (!target || !req.access.canSee(target.path)) throw errors.validation([{ path: 'body.unitId', message: 'Unit not found' }]);
      if (companyOf(target, unitsById)?.id !== companyId) {
        throw errors.validation([{ path: 'body.unitId', message: `Pick a unit of ${unitsById.get(companyId)?.name ?? 'the same company'}` }]);
      }
      if (target.status !== 'active') throw errors.conflict(`${target.name} is archived`);
      if (!req.access.can('accounts.manage', target.path)) throw errors.forbidden(`You can't manage institutes in ${target.name}`);
      changes.unit_id = target.id;
      note('unitId', link.unit_id, target.id);
      unit = target;
    }

    const ownerId = body.ownerUserId !== undefined ? body.ownerUserId : link.owner_user_id;
    if (ownerId && (body.ownerUserId !== undefined || changes.unit_id)) {
      const ownerLevel = await userLevelAt(ownerId, unit, 'accounts.view', { trx });
      if (!ownerLevel) throw errors.validation([{ path: 'body.ownerUserId', message: `This person can't see institutes in ${unit.name}` }]);
    }
    if (body.ownerUserId !== undefined && body.ownerUserId !== link.owner_user_id) {
      changes.owner_user_id = body.ownerUserId;
      note('ownerUserId', link.owner_user_id, body.ownerUserId);
    }
    if (body.status !== undefined && body.status !== link.status) {
      changes.status = body.status;
      note('status', link.status, body.status);
    }
    if (body.tags !== undefined && !sameValue([...body.tags].sort(), [...(link.tags ?? [])].sort())) {
      changes.tags = body.tags;
      note('tags', link.tags ?? [], body.tags);
    }
    if (body.archived !== undefined && body.archived !== Boolean(link.archived_at)) {
      changes.archived_at = body.archived ? trx.fn.now() : null;
      note('archived', Boolean(link.archived_at), body.archived);
    }
    if (body.custom !== undefined) {
      const companyUnit = unitsById.get(companyId);
      const [definitions, country] = await Promise.all([
        accountFieldDefinitions(companyId, trx),
        crmSetting(companyUnit, defaultCountrySetting, trx),
      ]);
      // Phone and email fields come back masked from someone who can't see them: that's no change.
      const values = decision.canViewPii ? body.custom : withoutMaskedEchoes(body.custom, link.custom, definitions);
      const merged = validateCustomValues(definitions, values, { existing: link.custom ?? {}, enforceRequired: true, defaultCountry: country });
      if (!sameValue(merged, link.custom ?? {})) {
        changes.custom = json(merged);
        changed.push('custom');
        after.customKeys = Object.keys(values);
      }
    }
    if (changed.length === 0) return;

    await trx('account_companies')
      .where({ id: link.id })
      .update({ ...changes, updated_at: trx.fn.now() });
    await trx('accounts').where({ id: account.id }).update({ updated_at: trx.fn.now() });
    await emitEvent(trx, {
      type: 'account.link_updated',
      groupId: account.group_id,
      unitId: changes.unit_id ?? link.unit_id,
      aggregateType: 'account',
      aggregateId: account.id,
      actorUserId: userId,
      payload: { accountId: account.id, companyId, changes: changed },
    });
    await writeAudit(trx, req, {
      action: 'account.link_updated',
      entityType: 'account',
      entityId: account.id,
      unit: { id: changes.unit_id ?? link.unit_id, root_id: account.group_id },
      before,
      after: { ...after, changed },
    });
  });
  return getAccount(req, accountId);
}

async function loadManageable(req, accountId, trx) {
  const decision = await loadVisibleAccount(req, accountId, { trx, forUpdate: true });
  if (!decision.canManage) throw errors.forbidden("You can't change this institute's people");
  return decision;
}

async function presentOneContact(trx, decision, contactId) {
  const row = await accountContactsQuery(decision.account.id, trx).where('ac.contact_id', contactId).first();
  return presentAccountContact(row, decision.canViewPii);
}

/** POST /accounts/:id/contacts → AccountContact. */
export async function addAccountContact(req, accountId, body) {
  return db.transaction(async (trx) => {
    const decision = await loadManageable(req, accountId, trx);
    const { account } = decision;
    const place = await actingPlace(req, decision, trx);
    if (!place) throw errors.forbidden("You can't change this institute's people");
    let contact;
    if (body.contactId) {
      contact = await visibleContactFor(req, body.contactId, account, { trx, path: 'body.contactId' });
    } else {
      const unitsById = await unitsIndex(req, trx);
      const settings = await contactSettings(unitsById.get(place.companyId), trx);
      contact = await resolvePerson(trx, req, account, body, { place, settings, path: 'body' });
    }
    const row = await attachContact(trx, req, { account, contact, title: body.title, role: body.role, isPrimary: body.isPrimary, place });
    if (!row) throw errors.conflict(`${contact.display_name} is already at this institute`);
    await trx('accounts').where({ id: account.id }).update({ updated_at: trx.fn.now() });
    return presentOneContact(trx, decision, contact.id);
  });
}

/** PATCH /accounts/:id/contacts/:contactId → AccountContact. */
export async function updateAccountContact(req, accountId, contactId, body) {
  return db.transaction(async (trx) => {
    const decision = await loadManageable(req, accountId, trx);
    const { account } = decision;
    const row = await trx('account_contacts').where({ account_id: account.id, contact_id: contactId }).forUpdate().first();
    if (!row) throw errors.notFound('Person at this institute');

    const changes = {};
    const changed = [];
    if (body.title !== undefined && (body.title ?? null) !== (row.title ?? null)) {
      changes.title = body.title;
      changed.push('title');
    }
    if (body.role !== undefined && body.role !== row.role) {
      changes.role = body.role;
      changed.push('role');
    }
    if (body.isPrimary !== undefined && body.isPrimary !== row.is_primary) changed.push('isPrimary');
    if (changed.length > 0) {
      if (Object.keys(changes).length > 0) {
        await trx('account_contacts')
          .where({ account_id: account.id, contact_id: contactId })
          .update({ ...changes, updated_at: trx.fn.now() });
      }
      if (body.isPrimary === true) await setPrimary(trx, account.id, contactId);
      if (body.isPrimary === false) {
        await trx('account_contacts').where({ account_id: account.id, contact_id: contactId }).update({ is_primary: false, updated_at: trx.fn.now() });
      }
      const place = await actingPlace(req, decision, trx);
      const role = changes.role ?? row.role;
      await trx('accounts').where({ id: account.id }).update({ updated_at: trx.fn.now() });
      await emitEvent(trx, {
        type: 'account.contact_updated',
        groupId: account.group_id,
        unitId: place?.unitId ?? account.group_id,
        aggregateType: 'account',
        aggregateId: account.id,
        actorUserId: req.auth.user.id,
        payload: { accountId: account.id, contactId, role, changes: changed },
      });
      await writeAudit(trx, req, {
        action: 'account.contact_updated',
        entityType: 'account',
        entityId: account.id,
        unit: place ? { id: place.unitId, root_id: account.group_id } : auditUnit(null, account.group_id),
        before: { contactId, title: row.title ?? null, role: row.role, isPrimary: row.is_primary },
        after: {
          contactId,
          title: changes.title !== undefined ? changes.title : (row.title ?? null),
          role,
          isPrimary: body.isPrimary ?? row.is_primary,
        },
      });
    }
    return presentOneContact(trx, decision, contactId);
  });
}

/** DELETE /accounts/:id/contacts/:contactId → 204. The person stays a contact. */
export async function removeAccountContact(req, accountId, contactId) {
  await db.transaction(async (trx) => {
    const decision = await loadManageable(req, accountId, trx);
    const { account } = decision;
    const [row] = await trx('account_contacts').where({ account_id: account.id, contact_id: contactId }).delete().returning('*');
    if (!row) throw errors.notFound('Person at this institute');
    const contact = await trx('contacts').where({ id: contactId }).first('id', 'display_name');
    const place = await actingPlace(req, decision, trx);
    const actorUserId = req.auth.user.id;
    await trx('accounts').where({ id: account.id }).update({ updated_at: trx.fn.now() });
    await addTimelineEvent(trx, {
      groupId: account.group_id,
      accountId: account.id,
      contactId,
      kind: 'system',
      title: `${contact?.display_name ?? 'A person'} removed from the institute`,
      meta: { action: 'account.contact_removed', role: row.role },
      actorType: 'user',
      actorUserId,
    });
    await emitEvent(trx, {
      type: 'account.contact_removed',
      groupId: account.group_id,
      unitId: place?.unitId ?? account.group_id,
      aggregateType: 'account',
      aggregateId: account.id,
      actorUserId,
      payload: { accountId: account.id, contactId, role: row.role },
    });
    await writeAudit(trx, req, {
      action: 'account.contact_removed',
      entityType: 'account',
      entityId: account.id,
      unit: place ? { id: place.unitId, root_id: account.group_id } : auditUnit(null, account.group_id),
      before: { contactId, role: row.role, title: row.title ?? null },
    });
  });
}

