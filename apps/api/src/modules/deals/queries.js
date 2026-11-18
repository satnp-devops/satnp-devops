import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { isKnownChannel } from '../../core/crm/channels.js';
import { chooseContactMatch, normalizeMethods } from '../../core/crm/contacts.js';
import { piiCustomDefinitions } from '../../core/crm/customFields.js';
import { normalizeEmail, normalizeName, normalizePhone } from '../../core/crm/normalize.js';
import {
  applyListScope,
  levelForRecord,
  listScope,
  loadVisible,
  loadVisibleAccount,
  loadVisibleContact,
  recordLevel,
  requireCreateUnit,
  unitsIndex,
} from '../../core/crm/scope.js';
import { crmSetting, defaultCountrySetting, fuzzyMatchThresholdSetting } from '../../core/crm/settings.js';
import { DUE_SOON_FRACTION } from './sla.js';
import { presentContactSummary, presentDealDetail, presentDealListItem, presentStageHistoryEntry } from './present.js';

// Reads of the deals module: the Leads list (filters, sorts, keyset cursors), stage counts, the
// deal detail, stage history and the duplicate pre-check. Related rows are loaded with one query
// per relation per page (docs/crm/PHASE2_CONTRACT.md §13).

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const uniq = (values) => [...new Set(values.filter(Boolean))];
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));

/**
 * Keyset sorts. `expr` matches the index expression exactly (contract §5.8, plus the slice's
 * lower(title) index); `cast` turns the cursor's text value back into the column type.
 * The cursor carries the value as Postgres text, so microsecond timestamps survive the round trip.
 */
const SORTS = {
  updatedAt: { expr: 'd.updated_at', cast: 'timestamptz' },
  createdAt: { expr: 'd.created_at', cast: 'timestamptz' },
  lastActivityAt: { expr: 'd.last_activity_at', cast: 'timestamptz' },
  value: { expr: 'd.value_minor', cast: 'bigint' },
  expectedCloseOn: { expr: "coalesce(d.expected_close_on, 'infinity'::date)", cast: 'date' },
  slaDueAt: { expr: "coalesce(d.sla_due_at, 'infinity'::timestamptz)", cast: 'timestamptz' },
  stageEnteredAt: { expr: 'd.stage_entered_at', cast: 'timestamptz' },
  title: { expr: 'lower(d.title)', cast: 'text' },
};

export function parseSort(sort) {
  const desc = sort.startsWith('-');
  const spec = SORTS[desc ? sort.slice(1) : sort];
  if (!spec) throw errors.validation([{ path: 'query.sort', message: 'Unknown sort' }]);
  return { ...spec, desc };
}

const CAMPAIGN = "coalesce(d.first_touch->>'campaign', d.first_touch->'utm'->>'campaign')";
const STAGE_BREACHED = "(d.status = 'open' and d.sla_due_at < now())";
const REPLY_OVERDUE = "(d.status = 'open' and d.first_replied_at is null and d.first_reply_due_at < now())";
const STAGE_DUE_SOON = `(d.status = 'open' and d.sla_due_at >= now() and d.sla_due_at - now() <= (d.sla_due_at - d.stage_entered_at) * ${DUE_SOON_FRACTION})`;
const REPLY_DUE_SOON = `(d.status = 'open' and d.first_replied_at is null and d.first_reply_due_at >= now() and d.first_reply_due_at - now() <= (d.first_reply_due_at - d.created_at) * ${DUE_SOON_FRACTION})`;

/** Deal ids whose people include a contact with this normalised phone or email (contact_methods_lookup_idx). */
const dealsWithMethod = (groupId, normalized) =>
  db('deal_contacts as dc')
    .join('contact_methods as m', 'm.contact_id', 'dc.contact_id')
    .where('m.group_id', groupId)
    .where('m.normalized', normalized)
    .select('dc.deal_id');

/**
 * `q`: a ref (SP-1042, exact), a phone or an email (deals whose people have it), otherwise the
 * deal title or a participant's or institute's name (trigram indexes).
 */
function applySearch(query, q, { groupId, defaultCountry }) {
  const text = q.trim();
  if (/^[a-z][a-z0-9]{0,5}-\d{1,12}$/i.test(text)) return query.whereRaw('upper(d.ref) = ?', [text.toUpperCase()]);
  if (text.includes('@')) {
    const email = normalizeEmail(text);
    if (email) return query.whereIn('d.id', dealsWithMethod(groupId, email));
  }
  if (/^[+(]?\d[\d\s().-]{5,}$/.test(text)) {
    const phone = normalizePhone(text, defaultCountry);
    if (phone) return query.whereIn('d.id', dealsWithMethod(groupId, phone.e164));
  }
  const name = normalizeName(text);
  return query.where((where) => {
    where.whereILike('d.title', `%${escapeLike(text)}%`);
    if (name) {
      const like = `%${escapeLike(name)}%`;
      where.orWhereIn(
        'd.id',
        db('deal_contacts as dc')
          .join('contacts as c', 'c.id', 'dc.contact_id')
          .where('c.group_id', groupId)
          .whereNull('c.merged_into_id')
          .whereLike('c.name_normalized', like)
          .select('dc.deal_id'),
      );
      where.orWhereIn('d.account_id', db('accounts').where('group_id', groupId).whereLike('name_normalized', like).select('id'));
    }
  });
}

/**
 * Add the list filters (GET /deals query, a saved view's filters or a bulk action's filter).
 * Arrays and booleans as parsed by the zod schemas.
 */
export function applyDealFilters(query, filters, { userId, groupId, defaultCountry = 'IN' }) {
  const f = filters;
  if (f.pipelineId) query.where('d.pipeline_id', f.pipelineId);
  if (f.stageId?.length) query.whereIn('d.stage_id', f.stageId);
  if (f.status?.length) query.whereIn('d.status', f.status);
  if (f.kind) query.where('d.kind', f.kind);
  if (f.channel?.length) query.whereIn('d.channel', f.channel);
  if (f.owner?.length) {
    const ids = uniq([...f.owner.filter((v) => v !== 'me' && v !== 'none'), ...(f.owner.includes('me') ? [userId] : [])]);
    const none = f.owner.includes('none');
    query.where((where) => {
      if (ids.length) where.orWhereIn('d.owner_user_id', ids);
      if (none) where.orWhereNull('d.owner_user_id');
    });
  }
  if (f.productLineId?.length) query.whereIn('d.product_line_id', f.productLineId);
  if (f.tag?.length) query.whereRaw('d.tags && ?::text[]', [f.tag]);
  if (f.nurture !== undefined) query.where('d.nurture', f.nurture);
  if (f.slaBreached !== undefined) query.whereRaw(f.slaBreached ? STAGE_BREACHED : `not ${STAGE_BREACHED}`);
  if (f.firstReplyOverdue !== undefined) query.whereRaw(f.firstReplyOverdue ? REPLY_OVERDUE : `not coalesce(${REPLY_OVERDUE}, false)`);
  if (f.sla === 'breached') query.whereRaw(`(${STAGE_BREACHED} or ${REPLY_OVERDUE})`);
  if (f.sla === 'due_soon') {
    query.whereRaw(`(${STAGE_DUE_SOON} or ${REPLY_DUE_SOON}) and not coalesce(${STAGE_BREACHED} or ${REPLY_OVERDUE}, false)`);
  }
  if (f.createdFrom) query.where('d.created_at', '>=', f.createdFrom);
  if (f.createdTo) query.where('d.created_at', '<', f.createdTo);
  if (f.updatedFrom) query.where('d.updated_at', '>=', f.updatedFrom);
  if (f.updatedTo) query.where('d.updated_at', '<', f.updatedTo);
  if (f.campaign?.length) query.whereRaw(`${CAMPAIGN} = any(?::text[])`, [f.campaign]);
  if (f.source?.length) query.whereRaw("d.first_touch->'utm'->>'source' = any(?::text[])", [f.source]);
  if (f.contactId) query.whereIn('d.id', db('deal_contacts').where('contact_id', f.contactId).select('deal_id'));
  if (f.accountId) query.where('d.account_id', f.accountId);
  if (f.householdId) query.where('d.household_id', f.householdId);
  if (f.q) applySearch(query, f.q, { groupId, defaultCountry });
  return query;
}

/** 422 for channel keys nobody registered. */
export function assertKnownChannels(registry, channels = [], path = 'query.channel') {
  const unknown = channels.map((key, index) => ({ key, index })).filter(({ key }) => !isKnownChannel(registry, key));
  if (unknown.length) throw errors.validation(unknown.map(({ index }) => ({ path: `${path}.${index}`, message: 'Unknown channel' })));
}

/**
 * The scoped base query of the list, stage counts and bulk filters.
 * archived=true lists only archived deals and needs deals.archive (its scope replaces deals.view).
 */
export async function scopedDeals(req, filters, { trx = db } = {}) {
  const permission = filters.archived ? 'deals.archive' : 'deals.view';
  const scope = await listScope(req, permission, { unitId: filters.unitId, trx });
  const defaultCountry = await crmSetting(scope.company ?? scope.unit, defaultCountrySetting, trx);
  const query = applyListScope(trx('deals as d'), scope, {
    unitColumn: 'd.unit_id',
    ownerColumns: ['d.owner_user_id'],
    companyColumn: 'd.company_id',
    groupColumn: 'd.group_id',
  });
  if (filters.archived) query.whereNotNull('d.archived_at');
  else query.whereNull('d.archived_at');
  applyDealFilters(query, filters, { userId: req.auth.user.id, groupId: scope.groupId, defaultCountry });
  return { query, scope };
}

// ---------- Related rows for a page ----------

/**
 * Everything the presenters need for a page of deals: one query per relation, run in parallel.
 * @returns {Promise<object>} context for presentDealListItem / presentDealDetail
 */
export async function dealContext(req, rows, { trx = db } = {}) {
  const units = await unitsIndex(req, trx);
  const dealIds = uniq(rows.map((r) => r.id));
  const ids = (column) => uniq(rows.map((r) => r[column]));
  const select = (table, idList, columns) => (idList.length ? trx(table).whereIn('id', idList).select(columns) : Promise.resolve([]));
  const [stages, productLines, products, users, contacts, accounts, students] = await Promise.all([
    select('pipeline_stages', ids('stage_id'), ['id', 'pipeline_id', 'key', 'name', 'category', 'colour', 'position', 'sla_hours']),
    select('product_lines', ids('product_line_id'), ['id', 'name', 'kind']),
    select('products', ids('product_id'), ['id', 'name', 'code']),
    select('users', ids('owner_user_id'), ['id', 'name']),
    select('contacts', ids('primary_contact_id'), [
      'id',
      'kind',
      'display_name',
      'first_name',
      'last_name',
      'city',
      'primary_phone',
      'primary_email',
      'erased_at',
    ]),
    select('accounts', ids('account_id'), ['id', 'name', 'kind']),
    dealIds.length
      ? trx('deal_contacts as dc')
          .join('contacts as c', 'c.id', 'dc.contact_id')
          .whereIn('dc.deal_id', dealIds)
          .where('dc.role', 'student')
          .orderBy('c.display_name')
          .select('dc.deal_id', 'c.display_name')
      : Promise.resolve([]),
  ]);
  const studentNames = new Map();
  for (const row of students) {
    if (!studentNames.has(row.deal_id)) studentNames.set(row.deal_id, []);
    studentNames.get(row.deal_id).push(row.display_name);
  }
  const piiByUnit = new Map();
  const canViewPii = (unitId) => {
    if (!piiByUnit.has(unitId)) {
      const unit = units.get(unitId);
      piiByUnit.set(unitId, unit ? req.access.can('contacts.view_pii', unit.path) : false);
    }
    return piiByUnit.get(unitId);
  };
  return {
    units,
    stages: byId(stages),
    productLines: byId(productLines),
    products: byId(products),
    users: byId(users),
    contacts: byId(contacts),
    accounts: byId(accounts),
    studentNames,
    canViewPii,
    now: new Date(),
  };
}

export async function presentDealRows(req, rows, { trx = db } = {}) {
  const ctx = await dealContext(req, rows, { trx });
  return rows.map((row) => presentDealListItem(row, ctx));
}

// ---------- GET /deals ----------

export async function listDeals(req, query) {
  const registry = req.app.locals.registry;
  assertKnownChannels(registry, query.channel);
  const { query: base } = await scopedDeals(req, query);
  const sort = parseSort(query.sort);
  const after = decodeCursor(query.cursor);
  if (after && (typeof after !== 'object' || typeof after.id !== 'string' || typeof after.v !== 'string')) {
    throw errors.badRequest('Invalid cursor');
  }
  const direction = sort.desc ? 'desc' : 'asc';
  if (after) base.whereRaw(`(${sort.expr}, d.id) ${sort.desc ? '<' : '>'} (?::${sort.cast}, ?::uuid)`, [after.v, after.id]);
  let rows;
  try {
    rows = await base
      .orderByRaw(`${sort.expr} ${direction}, d.id ${direction}`)
      .limit(query.limit + 1)
      .select('d.*', db.raw(`(${sort.expr})::text as sort_value`));
  } catch (err) {
    // A cursor whose value doesn't cast (it came from another sort) is the client's mistake.
    if (after && err?.code?.startsWith?.('22')) throw errors.badRequest('Invalid cursor');
    throw err;
  }
  const { page, nextCursor } = pageOf(rows, query.limit, (row) => ({ v: row.sort_value, id: row.id }));
  return { data: await presentDealRows(req, page), nextCursor };
}

// ---------- GET /deals/stage-counts ----------

export async function stageCounts(req, query) {
  assertKnownChannels(req.app.locals.registry, query.channel);
  const { query: base } = await scopedDeals(req, query);
  const rows = await base
    .groupBy('d.stage_id', 'd.currency')
    .select(
      'd.stage_id',
      'd.currency',
      db.raw('count(*)::int as count'),
      db.raw('coalesce(sum(d.value_minor), 0)::text as value_minor'),
      db.raw(`count(*) filter (where ${STAGE_BREACHED})::int as breached`),
    );
  const stages = new Map();
  for (const row of rows) {
    const entry = stages.get(row.stage_id) ?? { stageId: row.stage_id, count: 0, slaBreachedCount: 0, value: [] };
    entry.count += row.count;
    entry.slaBreachedCount += row.breached;
    entry.value.push({ valueMinor: Number(row.value_minor), currency: row.currency });
    stages.set(row.stage_id, entry);
  }
  const list = [...stages.values()];
  return { pipelineId: query.pipelineId, stages: list, total: list.reduce((sum, s) => sum + s.count, 0) };
}

// ---------- One deal ----------

/** Load a deal the user may see (archived ones need deals.archive), or 404. */
export async function loadDealForView(req, id, { trx = db, forUpdate = false } = {}) {
  const { row, level } = await loadVisible(req, { table: 'deals', id, permission: 'deals.view', notFound: 'Deal', trx, forUpdate });
  if (row.archived_at && !(await recordLevel(req, 'deals.archive', row, { trx }))) throw errors.notFound('Deal');
  return { row, level };
}

/** The deal's people (primary contact first), with their roles. */
export async function dealParticipants(trx, deal) {
  const rows = await trx('deal_contacts as dc')
    .join('contacts as c', 'c.id', 'dc.contact_id')
    .where('dc.deal_id', deal.id)
    .orderByRaw('(c.id = ?) desc, dc.created_at, c.display_name', [deal.primary_contact_id])
    .select('c.*', 'dc.role');
  return rows.map(({ role, ...contact }) => ({ contact, role }));
}

export async function presentDetail(req, row, { trx = db } = {}) {
  const units = await unitsIndex(req, trx);
  const unit = units.get(row.unit_id);
  const canViewPii = Boolean(unit && req.access.can('contacts.view_pii', unit.path));
  const [ctx, pipeline, household, participants, lostReason, createdBy, manage, piiFields] = await Promise.all([
    dealContext(req, [row], { trx }),
    trx('pipelines').where({ id: row.pipeline_id }).first('id', 'name', 'kind'),
    row.household_id ? trx('households').where({ id: row.household_id }).first('id', 'name') : null,
    dealParticipants(trx, row),
    row.lost_reason_id ? trx('lost_reasons').where({ id: row.lost_reason_id }).first('id', 'label') : null,
    row.created_by ? trx('users').where({ id: row.created_by }).first('id', 'name') : null,
    recordLevel(req, 'deals.manage', row, { trx }),
    // Phone and email custom fields are masked like the people's own numbers.
    canViewPii ? [] : piiCustomDefinitions(trx, row.company_id, 'deal'),
  ]);
  const can = {
    manage: Boolean(manage) && !row.archived_at,
    assign: Boolean(unit && req.access.can('deals.assign', unit.path)) && !row.archived_at,
    archive: Boolean(unit && req.access.can('deals.archive', unit.path)),
  };
  return presentDealDetail(row, ctx, { pipeline, household, participants, lostReason, createdBy, can, piiFields });
}

export async function getDeal(req, id) {
  const { row } = await loadDealForView(req, id);
  return presentDetail(req, row);
}

export async function stageHistory(req, id) {
  await loadDealForView(req, id);
  const rows = await db('deal_stage_history').where({ deal_id: id }).orderBy([
    { column: 'moved_at', order: 'desc' },
    { column: 'id', order: 'desc' },
  ]).limit(200);
  const stageIds = uniq(rows.flatMap((r) => [r.from_stage_id, r.to_stage_id]));
  const reasonIds = uniq(rows.map((r) => r.lost_reason_id));
  const userIds = uniq(rows.map((r) => r.moved_by_user_id));
  const [stages, lostReasons, users] = await Promise.all([
    stageIds.length ? db('pipeline_stages').whereIn('id', stageIds) : [],
    reasonIds.length ? db('lost_reasons').whereIn('id', reasonIds).select('id', 'label') : [],
    userIds.length ? db('users').whereIn('id', userIds).select('id', 'name') : [],
  ]);
  const ctx = { stages: byId(stages), lostReasons: byId(lostReasons), users: byId(users) };
  return rows.map((row) => presentStageHistoryEntry(row, ctx));
}

// ---------- POST /deals/check-duplicates ----------

const RECENTLY_LOST_DAYS = 180;

async function visibleOrNull(load) {
  try {
    return await load();
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

/** The person this input would be matched to by findOrCreateContact, without writing anything. */
async function matchContact(req, body, { groupId, company }) {
  const [defaultCountry, threshold] = await Promise.all([
    crmSetting(company, defaultCountrySetting),
    crmSetting(company, fuzzyMatchThresholdSetting),
  ]);
  const { methods } = normalizeMethods({ phones: body.phones ?? [], emails: body.emails ?? [] }, { defaultCountry });
  const keys = uniq(methods.map((m) => m.normalized));
  if (keys.length === 0) return null;
  const rows = await db('contact_methods as m')
    .join('contacts as c', 'c.id', 'm.contact_id')
    .where('m.group_id', groupId)
    .whereIn('m.normalized', keys)
    .whereNull('c.merged_into_id')
    .whereNull('c.erased_at')
    .select('c.*', 'm.kind as method_kind', 'm.normalized as method_normalized');
  const candidates = new Map();
  for (const row of rows) {
    const { method_kind: kind, method_normalized: normalized, ...contact } = row;
    const candidate = candidates.get(contact.id) ?? { ...contact, matchedEmails: [], matchedPhones: [] };
    (kind === 'email' ? candidate.matchedEmails : candidate.matchedPhones).push(normalized);
    candidates.set(contact.id, candidate);
  }
  const name = [body.firstName, body.lastName].filter(Boolean).join(' ');
  const kind = body.kind === 'b2b' ? 'staff' : body.kind === 'b2c' ? 'parent' : undefined;
  const match = chooseContactMatch([...candidates.values()], { kind, name }, { threshold });
  return match?.candidate ?? null;
}

export async function checkDuplicates(req, body) {
  const { unit, company } = await requireCreateUnit(req, body.unitId, 'deals.manage');
  const groupId = unit.root_id;
  let contact = null;
  let account = null;
  let knownElsewhere = false;
  let contactId = null;
  let accountId = null;

  if (body.contactId) {
    const visible = await visibleOrNull(() => loadVisibleContact(req, body.contactId));
    if (!visible) throw errors.validation([{ path: 'body.contactId', message: 'Contact not found' }]);
    contactId = visible.contact.id;
    contact = presentContactSummary(visible.contact, visible.canViewPii);
  } else {
    const match = await matchContact(req, body, { groupId, company });
    if (match) {
      contactId = match.id;
      const visible = await visibleOrNull(() => loadVisibleContact(req, match.id));
      if (visible) contact = presentContactSummary(visible.contact, visible.canViewPii);
      else knownElsewhere = true;
    }
  }
  if (body.accountId) {
    const visible = await visibleOrNull(() => loadVisibleAccount(req, body.accountId));
    if (!visible) throw errors.validation([{ path: 'body.accountId', message: 'Institute not found' }]);
    accountId = visible.account.id;
    account = { id: visible.account.id, name: visible.account.name, kind: visible.account.kind };
  }

  if (!contactId && !accountId) return { contact, account, knownElsewhere, openDeals: [], recentlyLost: [], hiddenOpenDealCount: 0 };

  // Only the unit's company: other companies' deals are never revealed, not even as a count.
  const candidates = await db('deals as d')
    .where('d.company_id', company.id)
    .whereNull('d.archived_at')
    .where((where) => {
      if (contactId) {
        where.orWhere('d.primary_contact_id', contactId);
        where.orWhereIn('d.id', db('deal_contacts').where('contact_id', contactId).select('deal_id'));
      }
      if (accountId) where.orWhere('d.account_id', accountId);
    })
    .where((where) => {
      where.where('d.status', 'open').orWhere((lost) => {
        lost.where('d.status', 'lost').where('d.closed_at', '>', db.raw(`now() - interval '${RECENTLY_LOST_DAYS} days'`));
      });
    })
    .orderBy('d.updated_at', 'desc')
    .limit(200)
    .select('d.*');

  const units = await unitsIndex(req);
  const userId = req.auth.user.id;
  const visible = candidates.filter((d) => levelForRecord(req.access, units, 'deals.view', d, { userId }));
  const open = visible.filter((d) => d.status === 'open').slice(0, 10);
  const lost = visible.filter((d) => d.status === 'lost').slice(0, 5);
  const hiddenOpenDealCount = candidates.filter((d) => d.status === 'open').length - visible.filter((d) => d.status === 'open').length;
  const presented = await presentDealRows(req, [...open, ...lost]);
  return {
    contact,
    account,
    knownElsewhere,
    openDeals: presented.slice(0, open.length),
    recentlyLost: presented.slice(open.length),
    hiddenOpenDealCount,
  };
}
