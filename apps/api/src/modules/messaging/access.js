import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { levelForRecord, loadVisible, loadVisibleContact, unitsIndex } from '../../core/crm/scope.js';

// Who may read and send messages for whom (docs/platform/MESSAGING.md, "Access").
//
// A messaging request is about a deal or a person in one company:
//   - a deal: the deal must be visible (deals.view, own respected), the permission is checked on the
//     deal (messaging.send:own = deals they own), and the person must take part in it;
//   - a person: they must be visible (core/crm/scope.js), seen through the company's link, and the
//     permission is checked on that link (own = links they own).
// Invisible records are 404; visible ones without the permission are 403.

/**
 * @param {import('express').Request} req
 * @param {{ dealId?: string | null, contactId?: string | null, companyId?: string | null, permission: string, path?: string }} input
 * @returns {Promise<{ company: object, deal: object | null, contact: object, link: object | null, unit: object,
 *   level: 'all' | 'own', canViewPii: boolean, can: (permission: string) => boolean }>}
 */
export async function loadSubject(req, { dealId = null, contactId = null, companyId = null, permission, path = 'query' }) {
  const index = await unitsIndex(req);
  const userId = req.auth.user.id;
  const at = (record, perm) => levelForRecord(req.access, index, perm, record, { userId, unitColumn: 'unit_id', ownerColumns: ['owner_user_id'] });

  if (dealId) {
    const { row: deal } = await loadVisible(req, { table: 'deals', id: dealId, permission: 'deals.view', notFound: 'Deal' });
    if (deal.archived_at) throw errors.notFound('Deal');
    if (companyId && companyId !== deal.company_id) throw errors.validation([{ path: `${path}.companyId`, message: "Not this deal's company" }]);
    const personId = contactId ?? deal.primary_contact_id;
    if (!personId) throw errors.validation([{ path: `${path}.contactId`, message: 'This deal has no contact to message' }]);
    if (personId !== deal.primary_contact_id) {
      const onDeal = await db('deal_contacts').where({ deal_id: deal.id, contact_id: personId }).first('contact_id');
      if (!onDeal) throw errors.validation([{ path: `${path}.contactId`, message: 'Pick someone on this deal' }]);
    }
    const level = at(deal, permission);
    if (!level) throw errors.forbidden();
    const [contact, link] = await Promise.all([
      db('contacts').where({ id: personId }).first(),
      db('contact_companies').where({ contact_id: personId, company_id: deal.company_id }).first(),
    ]);
    if (!contact || contact.merged_into_id) throw errors.notFound('Contact');
    const unit = index.get(deal.unit_id);
    return {
      company: index.get(deal.company_id),
      deal,
      contact,
      link: link ?? null,
      unit,
      level,
      canViewPii: req.access.can('contacts.view_pii', unit.path),
      can: (perm) => Boolean(at(deal, perm)),
    };
  }

  if (!contactId) throw errors.validation([{ path: `${path}.contactId`, message: 'Give a deal or a contact' }]);
  const visible = await loadVisibleContact(req, contactId);
  const links = visible.visibleLinks;
  let link;
  if (companyId) {
    link = links.find((l) => l.company_id === companyId);
    if (!link) {
      if (visible.companyIds.includes(companyId)) throw errors.forbidden('Message them from their deal');
      throw errors.validation([{ path: `${path}.companyId`, message: "They aren't known to that company" }]);
    }
  } else if (links.length === 1) {
    [link] = links;
  } else if (links.length === 0) {
    throw errors.forbidden('Message them from their deal');
  } else {
    throw errors.validation([{ path: `${path}.companyId`, message: 'Pick the company to message them from' }]);
  }
  const level = at(link, permission);
  if (!level) throw errors.forbidden();
  const unit = index.get(link.unit_id);
  return {
    company: index.get(link.company_id),
    deal: null,
    contact: visible.contact,
    link,
    unit,
    level,
    canViewPii: req.access.can('contacts.view_pii', unit.path),
    can: (perm) => Boolean(at(link, perm)),
  };
}
