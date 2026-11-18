import { minorFromDb } from '../../core/crm/money.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { displayPhone } from './query.js';

// Row → SearchHit (apps/web/src/lib/crm/types.ts). Keywords never leave the server. A person's or
// institute's phone or email (contactPoint) is masked unless the viewer may see personal data where
// they see the record; the reason under a phone or email match is masked the same way.

/**
 * @param {object} row a row from searchType()
 * @param {{ type: 'deal' | 'contact' | 'account', matchedOn: string, snippet: string | null,
 *           snippetMasked: boolean, canViewPii: boolean, unitsById: Map<string, object> }} context
 */
export function presentHit(row, { type, matchedOn, snippet, snippetMasked, canViewPii, unitsById }) {
  const hit = {
    type,
    id: row.id,
    title: row.title,
    subtitle: row.subtitle ?? null,
    companyId: row.company_id ?? null,
    matchedOn,
    snippet,
    company: null,
    status: null,
    value: null,
    owner: null,
    contactPoint: null,
    piiMasked: snippetMasked,
  };
  if (type === 'deal') {
    const company = unitsById.get(row.company_id);
    hit.company = company ? { id: company.id, name: company.name, code: company.code } : null;
    hit.status = row.status ?? null;
    hit.value = row.currency ? { valueMinor: minorFromDb(row.value_minor), currency: row.currency } : null;
    hit.owner = row.owner_user_id && row.owner_name ? { id: row.owner_user_id, name: row.owner_name } : null;
    return hit;
  }
  const phone = row.primary_phone ?? null;
  const email = row.primary_email ?? null;
  if (phone || email) {
    if (canViewPii) hit.contactPoint = phone ? displayPhone(phone) : email;
    else hit.contactPoint = phone ? maskPhone(phone) : maskEmail(email);
    hit.piiMasked = hit.piiMasked || !canViewPii;
  }
  return hit;
}
