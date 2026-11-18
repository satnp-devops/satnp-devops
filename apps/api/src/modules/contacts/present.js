import { maskCustomPii } from '../../core/crm/customFields.js';
import { minorFromDb } from '../../core/crm/money.js';
import { presentContactMethod, presentContactPii } from '../../core/crm/pii.js';
import { presentTimelineEntry } from '../../core/crm/timeline.js';

// Rows → API shapes of apps/web/src/lib/crm/types.ts (ContactSummary, ContactListItem,
// ContactDetail, Household, ConsentRecord...). Personal data goes through core/crm/pii.js.

const iso = (value) => (value ? new Date(value).toISOString() : null);

export const userRef = (user) => (user ? { id: user.id, name: user.name } : null);
export const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);
export const companyRef = (unit) => (unit ? { id: unit.id, name: unit.name, code: unit.code } : null);

/** ContactSummary: a person inside other records. */
export function presentContactSummary(row, canViewPii) {
  const pii = presentContactPii(row, canViewPii);
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    city: row.city ?? null,
    primaryPhone: pii.primaryPhone,
    primaryEmail: pii.primaryEmail,
    piiMasked: pii.piiMasked,
    erased: Boolean(row.erased_at),
  };
}

/** CompanyLinkSummary: the working company's link, in lists. */
export function presentLinkSummary(link, usersById) {
  if (!link) return null;
  return {
    companyId: link.company_id,
    unitId: link.unit_id,
    owner: userRef(usersById.get(link.owner_user_id)),
    status: link.status,
    tags: link.tags ?? [],
    firstSeenAt: iso(link.first_seen_at),
  };
}

/** ContactListItem. */
export function presentContactListItem(row, { canViewPii, companies, link, openDealCount, usersById }) {
  return {
    ...presentContactSummary(row, canViewPii),
    studentProfile: row.student_profile ?? {},
    companies,
    link: presentLinkSummary(link, usersById),
    openDealCount,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * CompanyLink: a company's link to the person, on the contact page. `piiFields` (the company's
 * phone and email contact fields) are masked in `custom` for a viewer without contacts.view_pii.
 */
export function presentCompanyLink(link, { unitsById, usersById, piiFields = [] }) {
  const fields = piiFields.filter((definition) => !definition.company_id || definition.company_id === link.company_id);
  return {
    id: link.id,
    company: companyRef(unitsById.get(link.company_id)),
    unit: unitRef(unitsById.get(link.unit_id)),
    owner: userRef(usersById.get(link.owner_user_id)),
    status: link.status,
    firstSeenAt: iso(link.first_seen_at),
    source: link.source ?? null,
    tags: link.tags ?? [],
    custom: fields.length ? maskCustomPii(link.custom, fields) : (link.custom ?? {}),
    archivedAt: iso(link.archived_at),
  };
}

/** DealSummary, from a deals row joined with its stage (stage_*) and owner (owner_name). */
export function presentDealSummary(row) {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    status: row.status,
    kind: row.kind,
    companyId: row.company_id,
    stage: {
      id: row.stage_id,
      key: row.stage_key,
      name: row.stage_name,
      category: row.stage_category,
      colour: row.stage_colour ?? null,
    },
    owner: row.owner_user_id ? { id: row.owner_user_id, name: row.owner_name ?? '' } : null,
    value: { valueMinor: minorFromDb(row.value_minor), currency: row.currency },
    updatedAt: iso(row.updated_at),
  };
}

/**
 * ContactDetail.
 * @param {object} contact contacts row
 * @param {{ decision: object, methods: object[], households: object[], accounts: object[], deals: object[], unitsById: Map, usersById: Map, unmasked?: boolean,
 *   piiFields?: Array<{ company_id: string, key: string, type: string }> }} parts  piiFields: phone and email contact fields of the links' companies
 */
export function presentContactDetail(contact, { decision, methods, households, accounts, deals, unitsById, usersById, unmasked = false, piiFields = [] }) {
  const canViewPii = unmasked || decision.canViewPii;
  const pii = presentContactPii(contact, canViewPii);
  return {
    ...presentContactSummary(contact, canViewPii),
    dateOfBirth: pii.dateOfBirth,
    address: pii.address,
    countryCode: contact.country_code ?? null,
    timeZone: contact.time_zone ?? null,
    language: contact.language ?? null,
    studentProfile: contact.student_profile ?? {},
    methods: methods.map((row) => presentContactMethod(row, canViewPii)),
    links: decision.visibleLinks.map((link) => presentCompanyLink(link, { unitsById, usersById, piiFields: canViewPii ? [] : piiFields })),
    households: households.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      relation: row.relation ?? null,
      memberCount: Number(row.member_count ?? 0),
    })),
    accounts: accounts.map((row) => ({
      account: { id: row.account_id, name: row.account_name, kind: row.account_kind },
      title: row.title ?? null,
      role: row.role,
      isPrimary: row.is_primary === true,
    })),
    deals: deals.map(presentDealSummary),
    erasedAt: iso(contact.erased_at),
    createdAt: iso(contact.created_at),
    updatedAt: iso(contact.updated_at),
    can: {
      manage: decision.canManage && !contact.erased_at,
      viewPii: decision.canViewPii,
      merge: decision.canMerge && !contact.erased_at,
      privacy: decision.canPrivacy,
    },
  };
}

/**
 * Household. `members` are household_members rows joined with their contacts (c_* columns are the
 * contact row); `decisions` maps contact ids to how the viewer sees them. Hidden members are counted.
 */
export function presentHousehold(household, members, { decisions, canManage, unmasked = false }) {
  const visible = [];
  let hidden = 0;
  for (const member of members) {
    const decision = decisions.get(member.contact.id);
    if (!unmasked && !decision?.canView) {
      hidden += 1;
      continue;
    }
    visible.push({
      contact: presentContactSummary(member.contact, unmasked ? false : decision.canViewPii),
      role: member.role,
      relation: member.relation ?? null,
      isPrimary: member.is_primary === true,
    });
  }
  visible.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || roleOrder(a.role) - roleOrder(b.role));
  return {
    id: household.id,
    name: household.name,
    city: household.city ?? null,
    members: visible,
    hiddenMemberCount: hidden,
    archivedAt: iso(household.archived_at),
    createdAt: iso(household.created_at),
    updatedAt: iso(household.updated_at),
    can: { manage: canManage },
  };
}

const ROLE_ORDER = { parent: 0, guardian: 1, student: 2, other: 3 };
const roleOrder = (role) => ROLE_ORDER[role] ?? 9;

/** ConsentRecord. */
export function presentConsent(row, usersById) {
  return {
    id: row.id,
    contactId: row.contact_id,
    companyId: row.company_id ?? null,
    channel: row.channel,
    purpose: row.purpose,
    status: row.status,
    source: row.source,
    evidence: row.evidence ?? {},
    capturedAt: iso(row.captured_at),
    capturedBy: userRef(usersById.get(row.captured_by)),
    createdAt: iso(row.created_at),
  };
}

/** ConsentState rows of consentMatrix, with ISO times. */
export const presentConsentState = (state) => ({ ...state, capturedAt: iso(state.capturedAt) });

/** TimelineEntry for the export (read-only: no edit, delete or pin). */
export function presentExportTimelineEntry(row, { usersById, dealsById }) {
  const deal = row.deal_id ? dealsById.get(row.deal_id) : null;
  return {
    ...presentTimelineEntry(row, { actor: userRef(usersById.get(row.actor_user_id)) }),
    occurredAt: iso(row.occurred_at),
    createdAt: iso(row.created_at),
    editedAt: iso(row.edited_at),
    pinnedAt: iso(row.pinned_at),
    deal: deal ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status } : null,
    canEdit: false,
    canDelete: false,
    canPin: false,
  };
}

/** Task for the export (read-only). */
export function presentExportTask(row, { usersById, unitsById, dealsById, accountsById, contact }) {
  const deal = row.deal_id ? dealsById.get(row.deal_id) : null;
  const account = row.account_id ? accountsById.get(row.account_id) : null;
  return {
    id: row.id,
    companyId: row.company_id,
    unit: unitRef(unitsById.get(row.unit_id)) ?? { id: row.unit_id, name: '', type: '' },
    title: row.title,
    notes: row.notes ?? null,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    dueAt: iso(row.due_at),
    reminderAt: iso(row.reminder_at),
    overdue: row.status === 'open' && row.due_at ? new Date(row.due_at).getTime() < Date.now() : false,
    assignee: userRef(usersById.get(row.assignee_user_id)),
    createdBy: userRef(usersById.get(row.created_by)),
    completedAt: iso(row.completed_at),
    completedBy: userRef(usersById.get(row.completed_by)),
    deal: deal ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status } : null,
    contact: { id: contact.id, displayName: contact.display_name },
    account: account ? { id: account.id, name: account.name, kind: account.kind } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    can: { manage: false },
  };
}
