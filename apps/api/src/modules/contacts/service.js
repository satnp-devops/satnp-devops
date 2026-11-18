import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { isKnownChannel } from '../../core/crm/channels.js';
import {
  UNNAMED_CONTACT,
  chooseContactMatch,
  findOrCreateContact,
  normalizeMethods,
} from '../../core/crm/contacts.js';
import { piiCustomDefinitions, validateCustomValues, withoutMaskedEchoes } from '../../core/crm/customFields.js';
import { displayName, normalizeEmail, normalizeName, normalizePhone } from '../../core/crm/normalize.js';
import { presentContactMethod } from '../../core/crm/pii.js';
import {
  applyUnitFilter,
  canViewPiiAt,
  companyOf,
  levelForRecord,
  listScope,
  loadVisibleContact,
  requireCreateUnit,
  unitsIndex,
  userLevelAt,
} from '../../core/crm/scope.js';
import {
  actingLink,
  changeUnit,
  contactSettingsAt,
  decideContacts,
  escapeLike,
  groupBy,
  inOrder,
  refreshContactSearch,
  sortTimestamp,
  syncPrimaries,
  usersById as loadUsers,
} from './context.js';
import { rankDuplicates, scoreDuplicate } from './duplicates.js';
import { addHouseholdMember, loadHouseholdAccess } from './households.js';
import { companyRef, presentContactDetail, presentContactListItem, presentContactSummary } from './present.js';

export { mergeContacts } from './merge.js';
export { eraseContact } from './privacy.js';

// Contacts: people stored once per group, seen by a company through its link row
// (docs/crm/PHASE2_CONTRACT.md §4.1 rule 4, §9.1).

const PATCH_COLUMNS = {
  kind: 'kind',
  firstName: 'first_name',
  lastName: 'last_name',
  dateOfBirth: 'date_of_birth',
  address: 'address',
  city: 'city',
  countryCode: 'country_code',
  timeZone: 'time_zone',
  language: 'language',
};
/** Personal data: audited by field name only (§9.0). */
const PII_FIELDS = new Set(['dateOfBirth', 'address']);

const SORTS = {
  '-updatedAt': { column: 'c.updated_at', order: 'desc', timestamp: true },
  '-createdAt': { column: 'c.created_at', order: 'desc', timestamp: true },
  name: { column: 'c.name_normalized', order: 'asc', timestamp: false },
};

const isEmptyObject = (value) => !value || (typeof value === 'object' && Object.keys(value).length === 0);

// ---------- Reading ----------

/** What a list search term means: an exact email or phone, or a name. */
function searchTerm(q, defaultCountry) {
  if (!q) return null;
  if (q.includes('@')) return { method: normalizeEmail(q) ?? '\u0000' };
  if (/^[+\d\s().-]{6,}$/.test(q) && /\d{5,}/.test(q.replace(/\D/g, ''))) {
    const phone = normalizePhone(q, defaultCountry);
    if (phone) return { method: phone.e164 };
  }
  return { name: normalizeName(q) };
}

/** GET /contacts */
export async function listContacts(req, query) {
  const scope = await listScope(req, 'contacts.view', { unitId: query.unitId });
  const unitsById = await unitsIndex(req);
  const userId = req.auth.user.id;
  const after = decodeCursor(query.cursor);
  const sort = SORTS[query.sort];
  const term = query.q
    ? searchTerm(query.q, (await contactSettingsAt(scope.company ?? scope.unit)).defaultCountry)
    : null;

  const rows = await db('contacts as c')
    .where('c.group_id', scope.groupId)
    .whereNull('c.merged_into_id')
    .whereExists(function linked() {
      this.select(db.raw('1')).from('contact_companies as l').whereRaw('l.contact_id = c.id');
      if (!query.includeArchived) this.whereNull('l.archived_at');
      if (scope.company) this.where('l.company_id', scope.company.id);
      applyUnitFilter(this, scope, { unitColumn: 'l.unit_id', ownerColumns: ['l.owner_user_id'] });
      if (query.status?.length) this.whereIn('l.status', query.status);
      if (query.tag?.length) this.whereRaw('l.tags && ?::text[]', [query.tag]);
      if (query.owner?.length) {
        this.where((who) => {
          for (const owner of query.owner) {
            if (owner === 'none') who.orWhereNull('l.owner_user_id');
            else who.orWhere('l.owner_user_id', owner === 'me' ? userId : owner);
          }
        });
      }
    })
    .modify((builder) => {
      if (query.kind?.length) builder.whereIn('c.kind', query.kind);
      if (query.householdId) {
        builder.whereExists(
          db('household_members as hm').whereRaw('hm.contact_id = c.id').where('hm.household_id', query.householdId).select(db.raw('1')),
        );
      }
      if (query.accountId) {
        builder.whereExists(
          db('account_contacts as ac').whereRaw('ac.contact_id = c.id').where('ac.account_id', query.accountId).select(db.raw('1')),
        );
      }
      if (term?.method) {
        builder.whereIn('c.id', db('contact_methods').where({ group_id: scope.groupId, normalized: term.method }).select('contact_id'));
      } else if (term) {
        if (!term.name) builder.whereRaw('false');
        else {
          const like = escapeLike(term.name);
          builder.where((w) =>
            w
              .where('c.name_normalized', 'like', `${like}%`)
              .orWhere('c.name_normalized', 'like', `% ${like}%`)
              .orWhereRaw('c.name_normalized % ?', [term.name]),
          );
        }
      }
      if (after) {
        const op = sort.order === 'desc' ? '<' : '>';
        const cast = sort.timestamp ? '?::timestamptz' : '?';
        builder.whereRaw(`(??, c.id) ${op} (${cast}, ?::uuid)`, [sort.column, after.v, after.id]);
      }
    })
    .orderBy([
      { column: sort.column, order: sort.order },
      { column: 'c.id', order: sort.order },
    ])
    .limit(query.limit + 1)
    .select('c.*', sort.timestamp ? sortTimestamp(sort.column) : db.raw('c.name_normalized as sort_key'));

  const { page, nextCursor } = pageOf(rows, query.limit, (row) => ({ v: row.sort_key, id: row.id }));
  if (page.length === 0) return { data: [], nextCursor };

  const ids = page.map((row) => row.id);
  const [links, dealCounts, activity] = await Promise.all([
    db('contact_companies').whereIn('contact_id', ids),
    db('deal_contacts as dc')
      .join('deals as d', 'd.id', 'dc.deal_id')
      .whereIn('dc.contact_id', ids)
      .where('d.status', 'open')
      .whereNull('d.archived_at')
      .groupBy('dc.contact_id', 'd.company_id')
      .select('dc.contact_id', 'd.company_id', db.raw('count(*)::int as n')),
    db('timeline_events')
      .whereIn('contact_id', ids)
      .whereNull('deleted_at')
      .groupBy('contact_id', 'company_id')
      .select('contact_id', 'company_id', db.raw('max(occurred_at) as at')),
  ]);
  const linksBy = groupBy(links, (row) => row.contact_id);
  const visibleLinksBy = new Map(
    ids.map((id) => [
      id,
      (linksBy.get(id) ?? []).filter((link) => levelForRecord(req.access, unitsById, 'contacts.view', link, { userId })),
    ]),
  );
  const workingLinks = scope.company ? links.filter((link) => link.company_id === scope.company.id) : [];
  const users = await loadUsers(workingLinks.map((link) => link.owner_user_id));
  const countsBy = groupBy(dealCounts, (row) => row.contact_id);
  const activityBy = groupBy(activity, (row) => row.contact_id);

  const data = page.map((row) => {
    const visible = visibleLinksBy.get(row.id);
    const companyIds = new Set(visible.map((link) => link.company_id));
    const lastActivity = (activityBy.get(row.id) ?? [])
      .filter((entry) => entry.company_id === null || companyIds.has(entry.company_id))
      .reduce((latest, entry) => (!latest || new Date(entry.at) > new Date(latest) ? entry.at : latest), null);
    return {
      ...presentContactListItem(row, {
        canViewPii: canViewPiiAt(req.access, unitsById, visible.map((link) => link.unit_id)),
        companies: [...companyIds].map((id) => companyRef(unitsById.get(id))).filter(Boolean),
        link: workingLinks.find((link) => link.contact_id === row.id) ?? null,
        openDealCount: (countsBy.get(row.id) ?? []).filter((c) => companyIds.has(c.company_id)).reduce((sum, c) => sum + c.n, 0),
        usersById: users,
      }),
      lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
    };
  });
  return { data, nextCursor };
}

/** Institutes of the person that the viewer can see (account_companies links or deals). */
async function visibleAccountRows(req, rows, unitsById, trx) {
  if (rows.length === 0) return [];
  const accountIds = rows.map((row) => row.account_id);
  const userId = req.auth.user.id;
  const [links, deals] = await inOrder(trx, [
    trx('account_companies').whereIn('account_id', accountIds).select('account_id', 'unit_id', 'company_id', 'owner_user_id'),
    trx('deals').whereIn('account_id', accountIds).whereNull('archived_at').select('account_id', 'unit_id', 'company_id', 'owner_user_id'),
  ]);
  const options = { userId };
  return rows.filter(
    (row) =>
      links.some((link) => link.account_id === row.account_id && levelForRecord(req.access, unitsById, 'accounts.view', link, options)) ||
      deals.some((deal) => deal.account_id === row.account_id && levelForRecord(req.access, unitsById, 'deals.view', deal, options)),
  );
}

/**
 * ContactDetail from a loadVisibleContact result. `everything: true` (the DPDP export) skips the
 * viewer filters on deals and institutes and unmasks personal data.
 */
export async function presentLoadedContact(req, loaded, { trx = db, everything = false } = {}) {
  const { contact } = loaded;
  const unitsById = await unitsIndex(req, trx);
  const userId = req.auth.user.id;
  const [methods, households, accountRows, dealRows, users] = await inOrder(trx, [
    trx('contact_methods')
      .where({ contact_id: contact.id })
      .orderBy([{ column: 'kind' }, { column: 'is_primary', order: 'desc' }, { column: 'created_at' }, { column: 'id' }]),
    trx('household_members as hm')
      .join('households as h', 'h.id', 'hm.household_id')
      .where('hm.contact_id', contact.id)
      .whereNull('h.archived_at')
      .orderBy('h.name')
      .select(
        'h.id',
        'h.name',
        'hm.role',
        'hm.relation',
        db.raw('(select count(*)::int from household_members x where x.household_id = h.id) as member_count'),
      ),
    trx('account_contacts as ac')
      .join('accounts as a', 'a.id', 'ac.account_id')
      .where('ac.contact_id', contact.id)
      .whereNull('a.merged_into_id')
      .orderBy('a.name')
      .select('ac.account_id', 'a.name as account_name', 'a.kind as account_kind', 'ac.title', 'ac.role', 'ac.is_primary'),
    trx('deal_contacts as dc')
      .join('deals as d', 'd.id', 'dc.deal_id')
      .join('pipeline_stages as s', 's.id', 'd.stage_id')
      .leftJoin('users as u', 'u.id', 'd.owner_user_id')
      .where('dc.contact_id', contact.id)
      .whereNull('d.archived_at')
      .orderBy([{ column: 'd.updated_at', order: 'desc' }, { column: 'd.id', order: 'desc' }])
      .limit(200)
      .select(
        'd.*',
        's.key as stage_key',
        's.name as stage_name',
        's.category as stage_category',
        's.colour as stage_colour',
        'u.name as owner_name',
      ),
    () => loadUsers(loaded.visibleLinks.map((link) => link.owner_user_id), trx),
  ]);
  const accounts = everything ? accountRows : await visibleAccountRows(req, accountRows, unitsById, trx);
  const deals = (everything ? dealRows : dealRows.filter((d) => levelForRecord(req.access, unitsById, 'deals.view', d, { userId }))).slice(
    0,
    everything ? 200 : 20,
  );
  const decision = everything ? { ...loaded, visibleLinks: loaded.links } : loaded;
  const linkUsers = everything ? await loadUsers(loaded.links.map((link) => link.owner_user_id), trx) : users;
  // Phone and email custom fields on the company links are masked like the person's own numbers.
  const piiFields =
    everything || loaded.canViewPii ? [] : await piiCustomDefinitions(trx, loaded.visibleLinks.map((link) => link.company_id), 'contact');
  return presentContactDetail(contact, {
    piiFields,
    decision,
    methods,
    households,
    accounts,
    deals,
    unitsById,
    usersById: linkUsers,
    unmasked: everything,
  });
}

/** GET /contacts/:id */
export async function getContact(req, id, { trx = db } = {}) {
  return presentLoadedContact(req, await loadVisibleContact(req, id, { trx }), { trx });
}

/** Rows of people sharing any of the normalised values, grouped into match candidates. */
async function methodCandidates(groupId, normalized, { excludeId = null, trx = db } = {}) {
  if (normalized.length === 0) return [];
  const rows = await trx('contact_methods as m')
    .join('contacts as c', 'c.id', 'm.contact_id')
    .where('m.group_id', groupId)
    .whereIn('m.normalized', normalized)
    .whereNull('c.merged_into_id')
    .whereNull('c.erased_at')
    .modify((query) => {
      if (excludeId) query.whereNot('c.id', excludeId);
    })
    .select('c.*', 'm.kind as method_kind', 'm.normalized as method_normalized');
  const candidates = new Map();
  for (const row of rows) {
    const { method_kind: kind, method_normalized: value, ...contact } = row;
    const candidate = candidates.get(contact.id) ?? { ...contact, matchedEmails: [], matchedPhones: [] };
    (kind === 'email' ? candidate.matchedEmails : candidate.matchedPhones).push(value);
    candidates.set(contact.id, candidate);
  }
  return [...candidates.values()];
}

/** People of the group whose normalised name is similar (pg_trgm, GIN index), best first. */
export function similarNames(groupId, name, threshold, { excludeId = null, limit = 50, trx = db } = {}) {
  if (!name || name.length < 3) return [];
  return trx('contacts as c')
    .where('c.group_id', groupId)
    .whereNull('c.merged_into_id')
    .whereNull('c.erased_at')
    .whereRaw('c.name_normalized % ?', [name])
    .whereRaw('similarity(c.name_normalized, ?) >= ?', [name, threshold])
    .modify((query) => {
      if (excludeId) query.whereNot('c.id', excludeId);
    })
    .orderByRaw('similarity(c.name_normalized, ?) desc', [name])
    .limit(limit)
    .select('c.*');
}

/** POST /contacts/check: the matching of findOrCreateContact, without writing. */
export async function checkContact(req, body) {
  const { unit } = await requireCreateUnit(req, body.unitId, 'contacts.manage');
  const settings = await contactSettingsAt(unit);
  const { methods } = normalizeMethods(body, { defaultCountry: settings.defaultCountry });
  const fullName = displayName(body.firstName, body.lastName);
  const normalized = [...new Set(methods.map((m) => m.normalized))];
  const [byMethod, byName] = await Promise.all([
    methodCandidates(unit.root_id, normalized),
    similarNames(unit.root_id, normalizeName(fullName), settings.threshold, { limit: 20 }),
  ]);
  const match = chooseContactMatch(byMethod, { kind: body.kind, name: fullName }, { threshold: settings.threshold });
  const others = new Map(byMethod.filter((c) => c.id !== match?.candidate.id).map((c) => [c.id, c]));
  for (const row of byName) if (row.id !== match?.candidate.id && !others.has(row.id)) others.set(row.id, { ...row, matchedEmails: [], matchedPhones: [] });

  const decisions = await decideContacts(req, [match?.candidate.id, ...others.keys()]);
  const target = { name: fullName, kind: body.kind };
  const scored = [];
  for (const candidate of others.values()) {
    const decision = decisions.get(candidate.id);
    if (!decision?.canView) continue;
    const result = scoreDuplicate(
      target,
      { name: candidate.display_name, kind: candidate.kind, sharedEmails: candidate.matchedEmails.length, sharedPhones: candidate.matchedPhones.length },
      { threshold: settings.threshold, nameAlone: true },
    );
    if (result) scored.push({ name: candidate.display_name, contact: presentContactSummary(candidate, decision.canViewPii), ...result });
  }
  const matchDecision = match ? decisions.get(match.candidate.id) : null;
  return {
    match: match && matchDecision?.canView ? presentContactSummary(match.candidate, matchDecision.canViewPii) : null,
    matchedBy: match?.matchedBy ?? null,
    hiddenMatch: Boolean(match && !matchDecision?.canView),
    candidates: rankDuplicates(scored)
      .slice(0, 10)
      .map(({ contact, reasons, score }) => ({ contact, reasons, score })),
  };
}

// ---------- Writing ----------

/** Can this person own contacts at the unit (contacts.view there)? 422 otherwise. */
async function assertOwner(req, ownerUserId, unit, trx, path) {
  if (!ownerUserId) return;
  if (ownerUserId === req.auth.user.id && req.access.can('contacts.view', unit.path)) return;
  const level = await userLevelAt(ownerUserId, unit, 'contacts.view', { trx });
  if (!level) throw errors.validation([{ path, message: `This person can't see contacts in ${unit.name}` }]);
}

const contactDefinitions = (companyId, trx) =>
  trx('custom_field_definitions').where({ company_id: companyId, entity: 'contact', active: true }).orderBy('position');

/** POST /contacts → { result, created } */
export async function createContact(req, body) {
  const userId = req.auth.user.id;
  const outcome = await db.transaction(async (trx) => {
    const { unit, company, level } = await requireCreateUnit(req, body.unitId, 'contacts.manage', { trx });
    const ownerUserId = body.ownerUserId === undefined ? userId : body.ownerUserId;
    if (level === 'own' && ownerUserId !== userId) throw errors.forbidden('You can only add contacts you own');
    if (body.source && !isKnownChannel(req.app.locals.registry, body.source.channel)) {
      throw errors.validation([{ path: 'body.source.channel', message: 'Unknown channel' }]);
    }
    await assertOwner(req, ownerUserId, unit, trx, 'body.ownerUserId');
    const settings = await contactSettingsAt(unit, trx);
    const household = body.household ? await loadHouseholdAccess(req, body.household.householdId, { trx, forUpdate: true }) : null;
    if (household && (!household.canView || household.household.group_id !== unit.root_id)) {
      throw errors.validation([{ path: 'body.household.householdId', message: 'Household not found' }]);
    }
    if (household && !household.canManage) throw errors.forbidden("You can't change this household");

    const result = await findOrCreateContact(
      trx,
      {
        groupId: unit.root_id,
        companyId: company.id,
        unitId: unit.id,
        kind: body.kind,
        firstName: body.firstName,
        lastName: body.lastName,
        phones: body.phones,
        emails: body.emails,
        city: body.city,
        countryCode: body.countryCode,
        timeZone: body.timeZone,
        language: body.language,
        studentProfile: body.studentProfile,
        ownerUserId,
        source: body.source ?? null,
        tags: body.tags ?? [],
        defaultCountry: settings.defaultCountry,
        nameThreshold: settings.threshold,
        mode: body.mode,
        path: 'body',
      },
      { req },
    );
    let { contact } = result;

    // Personal details only fill blanks: never overwrite what someone entered.
    const fill = {};
    if (body.dateOfBirth && !contact.date_of_birth) fill.date_of_birth = body.dateOfBirth;
    if (body.address && !isEmptyObject(body.address) && isEmptyObject(contact.address)) fill.address = json(body.address);
    if (Object.keys(fill).length > 0) {
      [contact] = await trx('contacts').where({ id: contact.id }).update({ ...fill, updated_at: trx.fn.now() }).returning('*');
      if (!result.created) {
        const changes = Object.keys(fill).map((column) => (column === 'date_of_birth' ? 'dateOfBirth' : 'address'));
        await recordContactUpdate(trx, req, contact, result.link, changes, {});
      }
    }

    // Link status and custom values apply only to a link this call created.
    if (result.linkCreated) {
      const definitions = await contactDefinitions(company.id, trx);
      const custom = validateCustomValues(definitions, body.custom ?? {}, {
        enforceRequired: true,
        defaultCountry: settings.defaultCountry,
        path: 'body.custom',
      });
      const linkChanges = {};
      if (body.status && body.status !== result.link.status) linkChanges.status = body.status;
      if (Object.keys(custom).length > 0) linkChanges.custom = json(custom);
      if (Object.keys(linkChanges).length > 0) {
        await trx('contact_companies').where({ id: result.link.id }).update({ ...linkChanges, updated_at: trx.fn.now() });
      }
    }

    if (household) {
      await addHouseholdMember(trx, req, household, contact, {
        role: body.household.role,
        relation: body.household.relation ?? null,
        isPrimary: false,
        unit: { id: result.link.unit_id, root_id: unit.root_id },
        ifMissing: true,
      });
    }
    return { contactId: contact.id, created: result.created, matchedBy: result.matchedBy, linkCreated: result.linkCreated };
  });
  return {
    created: outcome.created,
    result: {
      contact: await getContact(req, outcome.contactId),
      created: outcome.created,
      matchedBy: outcome.matchedBy,
      linkCreated: outcome.linkCreated,
    },
  };
}

/** contact.updated event + audit, with personal fields logged by name only. */
async function recordContactUpdate(trx, req, contact, link, changes, { before = {}, after = {} }) {
  const unit = changeUnit(contact, link);
  await emitEvent(trx, {
    type: 'contact.updated',
    groupId: contact.group_id,
    unitId: unit.id,
    aggregateType: 'contact',
    aggregateId: contact.id,
    actorUserId: req.auth.user.id,
    payload: { contactId: contact.id, companyId: link?.company_id ?? null, changes },
  });
  await writeAudit(trx, req, {
    action: 'contact.updated',
    entityType: 'contact',
    entityId: contact.id,
    unit,
    before,
    after,
    meta: { changed: changes },
  });
}

/** Load a contact the viewer may change (inside a transaction, locked). 403 without contacts.manage, 409 once erased. */
async function loadForChange(req, id, trx) {
  // Load the units first: loadVisibleContact reads them in parallel, and a transaction has one connection.
  await unitsIndex(req, trx);
  const loaded = await loadVisibleContact(req, id, { trx, forUpdate: true });
  if (!loaded.canManage) throw errors.forbidden();
  if (loaded.contact.erased_at) throw errors.conflict('This contact was erased on request and can no longer be changed');
  const unitsById = await unitsIndex(req, trx);
  return { ...loaded, unitsById, link: actingLink(req, unitsById, loaded.visibleLinks) };
}

/** PATCH /contacts/:id */
export async function updateContact(req, id, body) {
  await db.transaction(async (trx) => {
    const loaded = await loadForChange(req, id, trx);
    const { contact } = loaded;
    if ((body.dateOfBirth !== undefined || body.address !== undefined) && !loaded.canViewPii) {
      throw errors.forbidden("You can't change personal details of this contact");
    }
    const changes = {};
    const changed = [];
    const before = {};
    const after = {};
    for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
      if (body[field] === undefined) continue;
      let value = body[field];
      if (field === 'address') value = value ?? {};
      if (JSON.stringify(value ?? null) === JSON.stringify(contact[column] ?? (field === 'address' ? {} : null))) continue;
      changes[column] = field === 'address' ? json(value) : value;
      changed.push(field);
      if (!PII_FIELDS.has(field)) {
        before[field] = contact[column] ?? null;
        after[field] = value ?? null;
      }
    }
    if (body.studentProfile) {
      const profile = { ...(contact.student_profile ?? {}) };
      for (const [key, value] of Object.entries(body.studentProfile)) {
        if (value === null) delete profile[key];
        else if (value !== undefined) profile[key] = value;
      }
      if (JSON.stringify(profile) !== JSON.stringify(contact.student_profile ?? {})) {
        changes.student_profile = json(profile);
        changed.push('studentProfile');
        before.studentProfile = contact.student_profile ?? {};
        after.studentProfile = profile;
      }
    }
    if (changed.length === 0) return;
    const namesChanged = changed.includes('firstName') || changed.includes('lastName');
    if (namesChanged) {
      const first = 'first_name' in changes ? changes.first_name : contact.first_name;
      const last = 'last_name' in changes ? changes.last_name : contact.last_name;
      const name = displayName(first, last);
      changes.display_name = name || UNNAMED_CONTACT;
      changes.name_normalized = normalizeName(name);
    }
    const [updated] = await trx('contacts').where({ id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    if (namesChanged || changed.includes('kind') || changed.includes('city') || changed.includes('studentProfile')) {
      await refreshContactSearch(trx, id);
    }
    await recordContactUpdate(trx, req, updated, loaded.link, changed, { before, after });
  });
  return getContact(req, id);
}

/** PATCH /contacts/:id/links/:companyId */
export async function updateLink(req, id, companyId, body) {
  await db.transaction(async (trx) => {
    const unitsById = await unitsIndex(req, trx);
    const loaded = await loadVisibleContact(req, id, { trx, forUpdate: true });
    const userId = req.auth.user.id;
    const link = loaded.visibleLinks.find((row) => row.company_id === companyId);
    if (!link) throw errors.notFound('Company link');
    if (!levelForRecord(req.access, unitsById, 'contacts.manage', link, { userId })) throw errors.forbidden();
    if (loaded.contact.erased_at && (body.custom !== undefined || body.tags !== undefined)) {
      throw errors.conflict('This contact was erased on request; its tags and fields stay empty');
    }

    const next = { unit_id: link.unit_id, owner_user_id: link.owner_user_id };
    if (body.unitId !== undefined && body.unitId !== link.unit_id) {
      const unit = unitsById.get(body.unitId);
      if (!unit || !req.access.canSee(unit.path)) throw errors.validation([{ path: 'body.unitId', message: 'Unit not found' }]);
      const company = unitsById.get(companyId);
      if (companyOf(unit, unitsById)?.id !== companyId) {
        throw errors.validation([{ path: 'body.unitId', message: `Pick a unit inside ${company?.name ?? 'the same company'}` }]);
      }
      if (unit.status !== 'active') throw errors.validation([{ path: 'body.unitId', message: `${unit.name} is archived` }]);
      if (!req.access.can('contacts.manage', unit.path)) throw errors.forbidden(`You can't manage contacts in ${unit.name}`);
      next.unit_id = unit.id;
    }
    if (body.ownerUserId !== undefined) next.owner_user_id = body.ownerUserId;
    if (!levelForRecord(req.access, unitsById, 'contacts.manage', { ...link, ...next }, { userId })) {
      throw errors.forbidden('You can only keep contacts you own');
    }
    const unit = unitsById.get(next.unit_id);
    if (next.owner_user_id && (next.owner_user_id !== link.owner_user_id || next.unit_id !== link.unit_id)) {
      await assertOwner(req, next.owner_user_id, unit, trx, 'body.ownerUserId');
    }

    const changes = {};
    const changed = [];
    const before = {};
    const after = {};
    const track = (field, column, value, from) => {
      if (JSON.stringify(value) === JSON.stringify(from)) return;
      changes[column] = value;
      changed.push(field);
      before[field] = from;
      after[field] = value;
    };
    track('unitId', 'unit_id', next.unit_id, link.unit_id);
    track('ownerUserId', 'owner_user_id', next.owner_user_id ?? null, link.owner_user_id ?? null);
    if (body.status !== undefined) track('status', 'status', body.status, link.status);
    if (body.tags !== undefined) track('tags', 'tags', body.tags, link.tags ?? []);
    if (body.archived !== undefined && body.archived !== Boolean(link.archived_at)) {
      changes.archived_at = body.archived ? trx.fn.now() : null;
      changed.push('archived');
      before.archived = Boolean(link.archived_at);
      after.archived = body.archived;
    }
    if (body.custom !== undefined) {
      const [definitions, settings] = await inOrder(trx, [contactDefinitions(companyId, trx), () => contactSettingsAt(unit, trx)]);
      // Phone and email fields come back masked from someone who can't see them: that's no change.
      const values = loaded.canViewPii ? body.custom : withoutMaskedEchoes(body.custom, link.custom, definitions);
      const custom = validateCustomValues(definitions, values, {
        existing: link.custom ?? {},
        enforceRequired: true,
        defaultCountry: settings.defaultCountry,
        path: 'body.custom',
      });
      if (JSON.stringify(custom) !== JSON.stringify(link.custom ?? {})) {
        changes.custom = json(custom);
        changed.push('custom');
      }
    }
    if (changed.length === 0) return;
    await trx('contact_companies').where({ id: link.id }).update({ ...changes, updated_at: trx.fn.now() });
    await trx('contacts').where({ id }).update({ updated_at: trx.fn.now() });
    const auditUnit = { id: next.unit_id, root_id: loaded.contact.group_id };
    await emitEvent(trx, {
      type: 'contact.link_updated',
      groupId: loaded.contact.group_id,
      unitId: next.unit_id,
      aggregateType: 'contact',
      aggregateId: id,
      actorUserId: userId,
      payload: { contactId: id, companyId, changes: changed },
    });
    await writeAudit(trx, req, {
      action: 'contact.link_updated',
      entityType: 'contact',
      entityId: id,
      unit: auditUnit,
      before,
      after,
      meta: { companyId, changed },
    });
  });
  return getContact(req, id);
}

// ---------- Contact methods ----------

function normalizeMethodValue(kind, value, defaultCountry) {
  if (kind === 'email') return normalizeEmail(value);
  return normalizePhone(value, defaultCountry)?.e164 ?? null;
}

async function recordMethodChange(trx, req, loaded, action, after) {
  const { contact, link } = loaded;
  const unit = changeUnit(contact, link);
  await emitEvent(trx, {
    type: 'contact.updated',
    groupId: contact.group_id,
    unitId: unit.id,
    aggregateType: 'contact',
    aggregateId: contact.id,
    actorUserId: req.auth.user.id,
    payload: { contactId: contact.id, companyId: link?.company_id ?? null, changes: ['methods'] },
  });
  await writeAudit(trx, req, { action, entityType: 'contact', entityId: contact.id, unit, after });
}

/** POST /contacts/:id/methods */
export async function addMethod(req, id, body) {
  return db.transaction(async (trx) => {
    const loaded = await loadForChange(req, id, trx);
    const companyUnit = loaded.unitsById.get(loaded.link?.company_id) ?? loaded.unitsById.get(loaded.contact.group_id);
    const { defaultCountry } = await contactSettingsAt(companyUnit, trx);
    const normalized = normalizeMethodValue(body.kind, body.value, defaultCountry);
    if (!normalized) {
      throw errors.validation([
        { path: 'body.value', message: body.kind === 'email' ? 'Enter a valid email address' : 'Enter a valid phone number' },
      ]);
    }
    const [existing, primary] = await inOrder(trx, [
      trx('contact_methods').where({ contact_id: id, kind: body.kind, normalized }).first('id'),
      trx('contact_methods').where({ contact_id: id, kind: body.kind, is_primary: true }).first('id'),
    ]);
    if (existing) throw errors.conflict(body.kind === 'email' ? 'This email is already on the contact' : 'This number is already on the contact');
    const isPrimary = body.isPrimary || !primary;
    if (isPrimary && primary) await trx('contact_methods').where({ id: primary.id }).update({ is_primary: false, updated_at: trx.fn.now() });
    const [row] = await trx('contact_methods')
      .insert({
        contact_id: id,
        group_id: loaded.contact.group_id,
        kind: body.kind,
        value: body.value.trim(),
        normalized,
        label: body.label ?? null,
        is_primary: isPrimary,
      })
      .returning('*');
    await syncPrimaries(trx, id);
    await refreshContactSearch(trx, id);
    await recordMethodChange(trx, req, loaded, 'contact.method_added', { methodId: row.id, kind: row.kind, label: row.label, isPrimary });
    return presentContactMethod(row, loaded.canViewPii);
  });
}

async function loadMethod(trx, contactId, methodId) {
  const method = await trx('contact_methods').where({ id: methodId, contact_id: contactId }).forUpdate().first();
  if (!method) throw errors.notFound('Contact method');
  return method;
}

/** PATCH /contacts/:id/methods/:methodId */
export async function updateMethod(req, id, methodId, body) {
  return db.transaction(async (trx) => {
    const loaded = await loadForChange(req, id, trx);
    const method = await loadMethod(trx, id, methodId);
    const changes = {};
    const after = { methodId, kind: method.kind };
    if (body.label !== undefined && body.label !== method.label) {
      changes.label = body.label;
      after.label = body.label;
    }
    if (body.isPrimary && !method.is_primary) {
      await trx('contact_methods').where({ contact_id: id, kind: method.kind, is_primary: true }).update({ is_primary: false, updated_at: trx.fn.now() });
      changes.is_primary = true;
      after.isPrimary = true;
    }
    if (body.verified !== undefined && body.verified !== Boolean(method.verified_at)) {
      changes.verified_at = body.verified ? trx.fn.now() : null;
      after.verified = body.verified;
    }
    if (body.optedOut !== undefined && body.optedOut !== Boolean(method.opted_out_at)) {
      changes.opted_out_at = body.optedOut ? trx.fn.now() : null;
      after.optedOut = body.optedOut;
    }
    if (Object.keys(changes).length === 0) return presentContactMethod(method, loaded.canViewPii);
    const [row] = await trx('contact_methods').where({ id: methodId }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    if (changes.is_primary) await syncPrimaries(trx, id);
    else await trx('contacts').where({ id }).update({ updated_at: trx.fn.now() });
    await recordMethodChange(trx, req, loaded, 'contact.method_updated', after);
    return presentContactMethod(row, loaded.canViewPii);
  });
}

/** DELETE /contacts/:id/methods/:methodId (a removed primary passes to the oldest other method of its kind) */
export async function removeMethod(req, id, methodId) {
  await db.transaction(async (trx) => {
    const loaded = await loadForChange(req, id, trx);
    const method = await loadMethod(trx, id, methodId);
    await trx('contact_methods').where({ id: methodId }).delete();
    if (method.is_primary) {
      const next = await trx('contact_methods')
        .where({ contact_id: id, kind: method.kind })
        .orderBy([{ column: 'created_at' }, { column: 'id' }])
        .first('id');
      if (next) await trx('contact_methods').where({ id: next.id }).update({ is_primary: true, updated_at: trx.fn.now() });
    }
    await syncPrimaries(trx, id);
    await refreshContactSearch(trx, id);
    await recordMethodChange(trx, req, loaded, 'contact.method_removed', { methodId, kind: method.kind, wasPrimary: method.is_primary });
  });
}

// ---------- Duplicates ----------

/** GET /contacts/:id/duplicates */
export async function findDuplicates(req, id) {
  const loaded = await loadVisibleContact(req, id);
  const { contact } = loaded;
  if (contact.erased_at) return { candidates: [], hiddenCount: 0 };
  const unitsById = await unitsIndex(req);
  const { threshold } = await contactSettingsAt(unitsById.get(contact.group_id));
  const [methods, family] = await Promise.all([
    db('contact_methods').where({ contact_id: id }).pluck('normalized'),
    db('household_members as hm')
      .join('contacts as c', 'c.id', 'hm.contact_id')
      .whereIn('hm.household_id', db('household_members').where({ contact_id: id }).select('household_id'))
      .select('hm.household_id', 'hm.contact_id', 'c.display_name'),
  ]);
  const [byMethod, byName] = await Promise.all([
    methodCandidates(contact.group_id, [...new Set(methods)], { excludeId: id }),
    similarNames(contact.group_id, contact.name_normalized, threshold, { excludeId: id }),
  ]);
  const candidates = new Map(byMethod.map((c) => [c.id, c]));
  for (const row of byName) if (!candidates.has(row.id)) candidates.set(row.id, { ...row, matchedEmails: [], matchedPhones: [] });
  if (candidates.size === 0) return { candidates: [], hiddenCount: 0 };

  const ids = [...candidates.keys()];
  const [theirFamilies, decisions] = await Promise.all([
    db('household_members as hm')
      .join('household_members as other', 'other.household_id', 'hm.household_id')
      .join('contacts as oc', 'oc.id', 'other.contact_id')
      .whereIn('hm.contact_id', ids)
      .select('hm.contact_id', 'hm.household_id', 'other.contact_id as other_id', 'oc.display_name as other_name'),
    decideContacts(req, ids),
  ]);
  const familiesBy = groupBy(theirFamilies, (row) => row.contact_id);
  const target = {
    name: contact.display_name,
    kind: contact.kind,
    city: contact.city,
    householdIds: [...new Set(family.map((row) => row.household_id))],
    householdNames: family.filter((row) => row.contact_id !== id).map((row) => row.display_name),
  };

  const scored = [];
  let hiddenCount = 0;
  for (const candidate of candidates.values()) {
    const rows = familiesBy.get(candidate.id) ?? [];
    const result = scoreDuplicate(
      target,
      {
        name: candidate.display_name,
        kind: candidate.kind,
        city: candidate.city,
        householdIds: [...new Set(rows.map((row) => row.household_id))],
        householdNames: rows.filter((row) => row.other_id !== candidate.id).map((row) => row.other_name),
        sharedEmails: candidate.matchedEmails.length,
        sharedPhones: candidate.matchedPhones.length,
      },
      { threshold },
    );
    if (!result) continue;
    const decision = decisions.get(candidate.id);
    if (!decision?.canView) {
      hiddenCount += 1;
      continue;
    }
    scored.push({ name: candidate.display_name, contact: presentContactSummary(candidate, decision.canViewPii), ...result });
  }
  const ranked = rankDuplicates(scored);
  return {
    candidates: ranked.slice(0, 20).map(({ contact: summary, reasons, score }) => ({ contact: summary, reasons, score })),
    hiddenCount,
  };
}
