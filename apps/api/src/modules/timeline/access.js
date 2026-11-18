import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { MANUAL_TIMELINE_KINDS } from '../../core/crm/constants.js';
import {
  applyUnitFilter,
  levelForRecord,
  loadVisibleAccount,
  loadVisibleContact,
  scopeFromPaths,
  scopePaths,
  unitsIndex,
} from '../../core/crm/scope.js';

// Who sees which timeline entries (docs/crm/PHASE2_CONTRACT.md §9.8):
//   - deal timeline: the deal is visible (deals.view, own respected); every entry on it.
//   - contact / institute timeline: the subject is visible, and each entry
//       (a) is a group-level fact (company_id null), or
//       (b) belongs to a deal the user can see, or
//       (c) has no deal and a unit where the user holds contacts.view (institutes: accounts.view)
//           at level all, or at level own with actor_user_id = me.
// Group roles hold their permissions at the group unit, so they see every company's entries.

export const SUBJECTS = [
  { key: 'dealId', column: 'deal_id', type: 'deal' },
  { key: 'contactId', column: 'contact_id', type: 'contact' },
  { key: 'accountId', column: 'account_id', type: 'account' },
];

/** The one subject of a request, or a 422 naming the field. */
export function pickSubject(input, prefix) {
  const given = SUBJECTS.filter((subject) => input[subject.key]);
  if (given.length !== 1) {
    throw errors.validation([{ path: `${prefix}.dealId`, message: 'Give exactly one of dealId, contactId or accountId' }]);
  }
  return { ...given[0], id: input[given[0].key] };
}

/** Is a deal visible: deals.view at its unit (own: the owner), and archived deals only with deals.archive. Pure. */
export function dealVisible(access, unitsById, deal, userId) {
  if (!deal) return false;
  if (!levelForRecord(access, unitsById, 'deals.view', deal, { userId })) return false;
  if (!deal.archived_at) return true;
  const unit = unitsById.get(deal.unit_id);
  return Boolean(unit && access.can('deals.archive', unit.path));
}

const DEAL_COLUMNS = ['id', 'group_id', 'company_id', 'unit_id', 'owner_user_id', 'archived_at', 'primary_contact_id', 'account_id', 'ref', 'title', 'status'];

/** Load a deal the user can see, or 404. */
export async function loadVisibleDeal(req, dealId, { trx = db, forUpdate = false } = {}) {
  const query = trx('deals').where({ id: dealId }).first(DEAL_COLUMNS);
  if (forUpdate) query.forUpdate();
  // Sequential: a transaction runs one query at a time.
  const deal = await query;
  const index = await unitsIndex(req, trx);
  if (!dealVisible(req.access, index, deal, req.auth.user.id)) throw errors.notFound('Deal');
  return deal;
}

/** The user's scope for a permission across a whole group (for contact and institute timelines). Pure. */
export function groupScope(access, unitsById, groupId, permission, userId) {
  const group = unitsById.get(groupId);
  if (!group) return { allUnitIds: [], ownUnitIds: [], userId, ownOnly: true };
  return scopeFromPaths({ permission, userId, unit: group, unitsById, paths: scopePaths(access, permission) });
}

/**
 * Load the subject of a timeline and work out what the user may do on it.
 * @returns {Promise<{ type: 'deal' | 'contact' | 'account', id: string, groupId: string,
 *   deal?: object, record?: object, links: object[], visibleLinks: object[], canViewPii: boolean }>}
 */
export async function loadSubject(req, subject, { trx = db } = {}) {
  if (subject.type === 'deal') {
    const deal = await loadVisibleDeal(req, subject.id, { trx });
    const index = await unitsIndex(req, trx);
    const unit = index.get(deal.unit_id);
    return {
      type: 'deal',
      id: deal.id,
      groupId: deal.group_id,
      deal,
      links: [],
      visibleLinks: [],
      canViewPii: Boolean(unit && req.access.can('contacts.view_pii', unit.path)),
    };
  }
  const loaded =
    subject.type === 'contact' ? await loadVisibleContact(req, subject.id, { trx }) : await loadVisibleAccount(req, subject.id, { trx });
  const record = loaded.contact ?? loaded.account;
  return {
    type: subject.type,
    id: record.id,
    groupId: record.group_id,
    record,
    links: loaded.links,
    visibleLinks: loaded.visibleLinks,
    canViewPii: loaded.canViewPii,
  };
}

/**
 * Add the visibility rule for a subject's timeline to a query on `te` (timeline_events or its
 * archive). One query per page: the deal check is an EXISTS on the deals primary key.
 */
export function applySubjectVisibility(query, req, subjectContext, unitsById) {
  const { type, id, groupId } = subjectContext;
  const column = SUBJECTS.find((subject) => subject.type === type).column;
  query.where(`te.${column}`, id).whereNull('te.deleted_at');
  if (type === 'deal') return query;

  const userId = req.auth.user.id;
  const dealScope = groupScope(req.access, unitsById, groupId, 'deals.view', userId);
  const archiveScope = groupScope(req.access, unitsById, groupId, 'deals.archive', userId);
  const viewPermission = type === 'contact' ? 'contacts.view' : 'accounts.view';
  const recordScope = groupScope(req.access, unitsById, groupId, viewPermission, userId);

  return query.where((visible) => {
    visible.whereNull('te.company_id');
    visible.orWhere((onDeal) => {
      onDeal.whereNotNull('te.deal_id').whereExists(function dealInScope() {
        this.select(db.raw('1')).from('deals as d').whereRaw('d.id = te.deal_id');
        applyUnitFilter(this, dealScope, { unitColumn: 'd.unit_id', ownerColumns: ['d.owner_user_id'] });
        this.where((archived) => {
          archived.whereNull('d.archived_at');
          if (archiveScope.allUnitIds.length) archived.orWhereIn('d.unit_id', archiveScope.allUnitIds);
        });
      });
    });
    visible.orWhere((companyEntry) => {
      companyEntry.whereNull('te.deal_id').whereNotNull('te.company_id');
      applyUnitFilter(companyEntry, recordScope, { unitColumn: 'te.unit_id', ownerColumns: ['te.actor_user_id'] });
    });
  });
}

/** Can the user see this one entry on its own (same rule as the lists)? Pure apart from the loaded rows. */
export function entryVisibleOnRecord(access, unitsById, row, { userId, type }) {
  if (!row.company_id) return true;
  const permission = type === 'contact' ? 'contacts.view' : 'accounts.view';
  return Boolean(levelForRecord(access, unitsById, permission, row, { userId, unitColumn: 'unit_id', ownerColumns: ['actor_user_id'] }));
}

/**
 * Load one entry of the hot table that the user can see, or 404.
 * @returns {Promise<{ row: object, context: object, unitsById: Map }>}
 */
export async function loadVisibleEntry(req, id, { trx = db, forUpdate = false } = {}) {
  const query = trx('timeline_events').where({ id }).first();
  if (forUpdate) query.forUpdate();
  const row = await query;
  const unitsById = await unitsIndex(req, trx);
  if (!row || row.deleted_at) throw errors.notFound('Timeline entry');
  const userId = req.auth.user.id;
  const notFound = () => errors.notFound('Timeline entry');

  if (row.deal_id) {
    const deal = await trx('deals').where({ id: row.deal_id }).first(DEAL_COLUMNS);
    if (!dealVisible(req.access, unitsById, deal, userId)) throw notFound();
    const unit = unitsById.get(deal.unit_id);
    const context = {
      type: 'deal',
      id: deal.id,
      groupId: deal.group_id,
      deal,
      links: [],
      visibleLinks: [],
      canViewPii: Boolean(unit && req.access.can('contacts.view_pii', unit.path)),
    };
    return { row, context, unitsById, deal };
  }

  const type = row.contact_id ? 'contact' : 'account';
  let context;
  try {
    context = await loadSubject(req, { type, id: row.contact_id ?? row.account_id }, { trx });
  } catch (err) {
    if (err?.status === 404) throw notFound();
    throw err;
  }
  if (!entryVisibleOnRecord(req.access, unitsById, row, { userId, type })) throw notFound();
  return { row, context, unitsById, deal: null };
}

/** Unit paths that decide permissions on an entry: its own unit, else the subject's visible units. Pure. */
export function entryPermissionPaths(row, context, unitsById) {
  const own = row.unit_id ? unitsById.get(row.unit_id) : null;
  if (own) return [own.path];
  if (context.deal) {
    const unit = unitsById.get(context.deal.unit_id);
    return unit ? [unit.path] : [];
  }
  return context.visibleLinks.map((link) => unitsById.get(link.unit_id)?.path).filter(Boolean);
}

/** canEdit / canDelete / canPin for one entry. Pure. */
export function entryFlags(access, row, paths, userId) {
  const can = (permission) => paths.some((path) => access.can(permission, path));
  const manual = MANUAL_TIMELINE_KINDS.includes(row.kind);
  const author = Boolean(row.actor_user_id) && row.actor_user_id === userId && row.actor_type === 'user';
  // Only what people added: inbound messages, and calls, emails or messages recorded by a channel
  // (actor contact or system), are the conversation record and stay.
  const deletable = manual && row.actor_type === 'user' && !(row.kind === 'message' && row.direction === 'inbound');
  const archived = Boolean(row.archived);
  return {
    canEdit: !archived && manual && author,
    canDelete: !archived && deletable && (author || can('timeline.moderate')),
    canPin: !archived && can('timeline.write'),
  };
}

/** Does the viewer see personal data on this entry (contacts.view_pii at the entry's unit)? Pure. */
export function entryCanViewPii(access, row, context, unitsById) {
  const unit = row.unit_id ? unitsById.get(row.unit_id) : null;
  if (unit) return access.can('contacts.view_pii', unit.path);
  return context.canViewPii;
}
