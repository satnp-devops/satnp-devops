import { maskCustomPii } from '../../core/crm/customFields.js';
import { maskEmail, maskPhone, presentContactPii } from '../../core/crm/pii.js';
import { minorFromDb } from '../../core/crm/money.js';

// Rows → API shapes of apps/web/src/lib/crm/types.ts (AccountListItem, AccountDetail, AccountContact,
// CompanyLink, ContactSummary, DealSummary). Personal details are masked here, never in the UI.

export const companyRef = (unit) => (unit ? { id: unit.id, name: unit.name, code: unit.code } : null);
export const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);
export const userRef = (id, usersById) => {
  if (!id) return null;
  const user = usersById.get(id);
  return user ? { id: user.id, name: user.name } : null;
};

const iso = (value) => (value instanceof Date ? value.toISOString() : (value ?? null));

/** An institute's phone and email, masked without contacts.view_pii where it is seen. */
export function presentAccountPii(row, canViewPii) {
  return {
    primaryPhone: canViewPii ? (row.primary_phone ?? null) : maskPhone(row.primary_phone),
    primaryEmail: canViewPii ? (row.primary_email ?? null) : maskEmail(row.primary_email),
    piiMasked: !canViewPii,
  };
}

/** The working company's link, as lists show it (CompanyLinkSummary). */
export function presentLinkSummary(link, usersById) {
  if (!link) return null;
  return {
    companyId: link.company_id,
    unitId: link.unit_id,
    owner: userRef(link.owner_user_id, usersById),
    status: link.status,
    tags: link.tags ?? [],
    firstSeenAt: iso(link.first_seen_at),
  };
}

/**
 * A company's full link (CompanyLink), shown only to people who can see that link. `piiFields` (the
 * companies' phone and email institute fields) are masked in `custom` for a viewer without contacts.view_pii.
 */
export function presentLink(link, { unitsById, usersById, piiFields = [] }) {
  const fields = piiFields.filter((definition) => !definition.company_id || definition.company_id === link.company_id);
  return {
    id: link.id,
    company: companyRef(unitsById.get(link.company_id)),
    unit: unitRef(unitsById.get(link.unit_id)),
    owner: userRef(link.owner_user_id, usersById),
    status: link.status,
    firstSeenAt: iso(link.first_seen_at),
    source: link.source ?? null,
    tags: link.tags ?? [],
    custom: fields.length ? maskCustomPii(link.custom, fields) : (link.custom ?? {}),
    archivedAt: iso(link.archived_at),
  };
}

/**
 * A row of GET /accounts (AccountListItem).
 * @param {object} row accounts row
 * @param {{ canViewPii: boolean, companies: object[], link: object | null, openDealCount: number, usersById: Map }} extras
 */
export function presentAccountListItem(row, { canViewPii, companies, link, openDealCount, usersById }) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    city: row.city ?? null,
    state: row.state ?? null,
    branchCount: row.branch_count ?? null,
    studentCount: row.student_count ?? null,
    currentSoftware: row.current_software ?? null,
    ...presentAccountPii(row, canViewPii),
    companies: companies.map(companyRef).filter(Boolean),
    link: presentLinkSummary(link, usersById),
    openDealCount,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** A person inside another record (ContactSummary), masked per the viewer's right where it is seen. */
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

/** A person at the institute (AccountContact). `row` joins account_contacts (ac_*) with contacts. */
export function presentAccountContact(row, canViewPii) {
  return {
    contact: presentContactSummary(row, canViewPii),
    title: row.ac_title ?? null,
    role: row.ac_role,
    isPrimary: row.ac_is_primary === true,
  };
}

/** A deal inside the institute page (DealSummary). `row` joins deals with its stage (s_*). */
export function presentDealSummary(row, usersById) {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    status: row.status,
    kind: row.kind,
    companyId: row.company_id,
    stage: { id: row.stage_id, key: row.s_key, name: row.s_name, category: row.s_category, colour: row.s_colour ?? null },
    owner: userRef(row.owner_user_id, usersById),
    value: { valueMinor: minorFromDb(row.value_minor), currency: row.currency },
    updatedAt: iso(row.updated_at),
  };
}
