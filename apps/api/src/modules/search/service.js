import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { SEARCH_ENTITY_TYPES } from '../../core/crm/constants.js';
import { canViewPiiAt, companyOf, listScope, unitsIndex, applyListScope, applyUnitFilter } from '../../core/crm/scope.js';
import { crmSetting, defaultCountrySetting } from '../../core/crm/settings.js';
import { compareHits, escapeLike, matchedOnFor, parseSearchQuery, snippetFor } from './query.js';
import { presentHit } from './present.js';

// GET /search (docs/crm/PHASE2_CONTRACT.md §9.10). One query per entity type, run in parallel, each
// on search_documents with the same scope as the owning module's list:
//   deals     applyListScope with deals.view (company, units, own deals)
//   contacts  a contact_companies link in the contacts.view scope
//   accounts  an account_companies link in the accounts.view scope
// Types the user can't view anywhere in the working unit are skipped. Each query also joins the few
// facts a hit shows (deal status, value and owner; a person's or institute's phone or email, masked
// unless the viewer may see personal data where they see the record).

export const TYPE_PERMISSIONS = { deal: 'deals.view', contact: 'contacts.view', account: 'accounts.view' };

const LINKS = {
  contact: { linkTable: 'contact_companies', foreignKey: 'contact_id' },
  account: { linkTable: 'account_companies', foreignKey: 'account_id' },
};

/**
 * @param {import('express').Request} req
 * @param {{ unitId: string, q: string, types?: string[], limit: number }} query
 */
export async function search(req, { unitId, q, types, limit }) {
  const unitsById = await unitsIndex(req);
  const unit = unitsById.get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');

  // Numbers typed without +CC are read in the working company's country (the group's at group level).
  const countryUnit = companyOf(unit, unitsById) ?? unitsById.get(unit.root_id) ?? unit;
  const defaultCountry = await crmSetting(countryUnit, defaultCountrySetting);
  const parsed = parseSearchQuery(q, { defaultCountry });
  // Fragments of phone numbers and email addresses only for people who see personal data everywhere
  // in the working unit; otherwise a masked number could be rebuilt one digit at a time.
  const partial = parsed.partial && req.access.can('contacts.view_pii', unit.path) ? parsed.partial : null;

  const wanted = SEARCH_ENTITY_TYPES.filter((type) => !types?.length || types.includes(type));
  const allowed = wanted.filter((type) => req.access.canAnywhereWithin(TYPE_PERMISSIONS[type], unit.path));

  const groups = await Promise.all(
    allowed.map(async (type) => {
      const scope = await listScope(req, TYPE_PERMISSIONS[type], { unitId });
      const rows = await searchType(db, { type, scope, parsed, partial, limit });
      const hits = rows.sort(compareHits).map((row) => {
        const canViewPii = canViewPiiFor(req, unitsById, scope, type, row);
        const matchedOn = matchedOnFor(row, parsed);
        const { snippet, masked } = snippetFor({ matchedOn, row, parsed, canViewPii, names: namesOf(type, row), ref: row.ref ?? null });
        return presentHit(row, { type, matchedOn, snippet, snippetMasked: masked, canViewPii, unitsById });
      });
      return { type, hits };
    }),
  );
  return { query: parsed.text, groups };
}

/**
 * At most this many documents per match kind are ranked. A specific query ("priya sha", a number)
 * matches fewer and is ranked exactly; a broad one ("pr", "sharma" in a lakh of records) is cut
 * here, so a keystroke never ranks tens of thousands of rows.
 */
export const MAX_CANDIDATES = 500;

/** Documents of one type in a scope: the deals.view list scope, or a company link in scope. */
function scopedDocuments(knex, type, scope) {
  const query = knex('search_documents as sd').where('sd.group_id', scope.groupId).where('sd.entity_type', type);
  if (type === 'deal') {
    return applyListScope(query, scope, {
      unitColumn: 'sd.unit_id',
      ownerColumns: ['sd.owner_user_id'],
      companyColumn: 'sd.company_id',
      groupColumn: 'sd.group_id',
    });
  }
  return whereLinkedProbe(knex, query, scope, LINKS[type]);
}

/**
 * whereLinkedInScope (core/crm/scope.js) with the same filter (a live company link in the scope),
 * written as a per-document probe: `offset 0` stops Postgres from turning the EXISTS into a join.
 * With the candidate LIMIT the planner otherwise picks a merge join that walks every document of
 * the type in id order (a 2-letter query took 450 ms for a counsellor at 150k contacts; 70 ms so).
 */
function whereLinkedProbe(knex, query, scope, { linkTable, foreignKey }) {
  return query.whereExists(function linked() {
    this.select(knex.raw('1'))
      .from(`${linkTable} as l`)
      .whereRaw('?? = sd.entity_id', [`l.${foreignKey}`])
      .whereNull('l.archived_at');
    if (scope.company) this.where('l.company_id', scope.company.id);
    applyUnitFilter(this, scope, { unitColumn: 'l.unit_id', ownerColumns: ['l.owner_user_id'] });
    this.offset(knex.raw('0'));
  });
}

/**
 * The matching documents of one type in a scope, with the facts their hits show: at most `limit`
 * rows, ordered by compareHits in SQL too, so the limit keeps the best ones.
 *   candidates  exact keyword tokens (phone forms, email, reference, domain) or a phone/email
 *               fragment; and, separately, words: prefix full text on words_tsv or trigram word
 *               similarity on the title (q <% title). Each kind capped at MAX_CANDIDATES.
 *   ranking     exact, fragment, similarity(title), ts_rank(words_tsv), updated_at.
 */
export function searchType(knex, { type, scope, parsed, partial, limit }) {
  const exact = parsed.exactTokens.length ? ["string_to_array(sd.keywords, ' ') && ?::text[]", [parsed.exactTokens]] : null;
  const fragment = partial ? ["sd.keywords like ? escape '\\'", [`%${escapeLike(partial)}%`]] : null;
  const words = parsed.tsquery ? parsed.words.join(' ') : null;

  const branches = [];
  if (exact || fragment) {
    branches.push(
      scopedDocuments(knex, type, scope)
        .where((where) => {
          for (const [sql, bindings] of [exact, fragment].filter(Boolean)) where.orWhereRaw(sql, bindings);
        })
        .select('sd.entity_id')
        .limit(MAX_CANDIDATES),
    );
  }
  if (words) {
    branches.push(
      scopedDocuments(knex, type, scope)
        .where((where) => where.whereRaw("sd.words_tsv @@ to_tsquery('simple', ?)", [parsed.tsquery]).orWhereRaw('? <% sd.title', [words]))
        .select('sd.entity_id')
        .limit(MAX_CANDIDATES),
    );
  }
  if (branches.length === 0) return Promise.resolve([]);

  const hits = knex('search_documents as sd')
    .where('sd.entity_type', type)
    .whereIn('sd.entity_id', branches.length === 1 ? branches[0] : knex.queryBuilder().unionAll(branches, true))
    .select('sd.entity_id as id', 'sd.title', 'sd.subtitle', 'sd.company_id', 'sd.unit_id', 'sd.owner_user_id', 'sd.keywords', 'sd.updated_at')
    .select(
      exact ? knex.raw(`(${exact[0]}) as exact`, exact[1]) : knex.raw('false as exact'),
      fragment ? knex.raw(`(${fragment[0]}) as partial`, fragment[1]) : knex.raw('false as partial'),
      words ? knex.raw('greatest(similarity(sd.title, ?), word_similarity(?, sd.title)) as sim', [words, words]) : knex.raw('0::real as sim'),
      words ? knex.raw("ts_rank(sd.words_tsv, to_tsquery('simple', ?)) as rank", [parsed.tsquery]) : knex.raw('0::real as rank'),
    )
    .orderByRaw('exact desc, partial desc, sim desc, rank desc, sd.updated_at desc, sd.entity_id')
    .limit(limit);

  const query = knex.with('hits', hits).from('hits as h').select('h.*');
  if (type === 'deal') {
    return query
      .leftJoin('deals as d', 'd.id', 'h.id')
      .leftJoin('users as u', 'u.id', 'd.owner_user_id')
      .leftJoin('contacts as c', 'c.id', 'd.primary_contact_id')
      .leftJoin('accounts as a', 'a.id', 'd.account_id')
      .select(
        'd.ref',
        'd.status',
        'd.value_minor',
        'd.currency',
        'u.name as owner_name',
        'c.display_name as contact_name',
        'a.name as account_name',
      );
  }
  const { linkTable, foreignKey } = LINKS[type];
  const table = type === 'contact' ? 'contacts as r' : 'accounts as r';
  return query
    .leftJoin(table, 'r.id', 'h.id')
    .select(
      'r.primary_phone',
      'r.primary_email',
      type === 'account' ? 'r.legal_name' : knex.raw('null as legal_name'),
      knex.raw(
        `(select coalesce(json_agg(json_build_object('unit_id', l.unit_id, 'owner_user_id', l.owner_user_id)), '[]'::json)
            from ?? as l where ?? = h.id and l.archived_at is null) as links`,
        [`${linkTable}`, `l.${foreignKey}`],
      ),
    );
}

/**
 * May the viewer see this hit's personal data? Deals: contacts.view_pii at the deal's unit.
 * People and institutes: at the unit of a company link they see it through in this scope.
 */
function canViewPiiFor(req, unitsById, scope, type, row) {
  if (type === 'deal') return canViewPiiAt(req.access, unitsById, [row.unit_id]);
  const all = new Set(scope.allUnitIds);
  const own = new Set(scope.ownUnitIds);
  const userId = req.auth.user.id;
  const units = (row.links ?? [])
    .filter((link) => all.has(link.unit_id) || (own.has(link.unit_id) && link.owner_user_id === userId))
    .map((link) => link.unit_id);
  return canViewPiiAt(req.access, unitsById, units);
}

/** Names a document was found by besides its title, for the reason under the hit. */
function namesOf(type, row) {
  if (type === 'deal') {
    return [
      ['Contact', row.contact_name],
      ['Institute', row.account_name],
    ];
  }
  if (type === 'account') return [['Legal name', row.legal_name]];
  return [];
}
