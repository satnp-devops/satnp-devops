import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { PERMISSIONS as P } from './constants.js';
import * as s from './schemas.js';
import { payoutDetailsSchema } from './payoutDetails.js';
import {
  createPartner,
  getPartner,
  grantPortalAccess,
  linkCompany,
  listOwners,
  listPartners,
  readPayoutDetails,
  revokePortalAccess,
  setPayoutDetails,
  updateCompanyLink,
  updatePartner,
} from './service.js';
import { createLink, listLinks, updateLink } from './links.js';
import { listAttributions, removeAttribution, setAttribution } from './attributions.js';
import { createPlan, listPlans, updatePlan } from './plans.js';
import { approveCommission, bulkApprove, commissionSummary, getCommission, listCommissions, rejectCommission } from './commissions.js';
import { approvePayout, cancelPayout, createPayout, getPayout, listPayouts, markPayoutPaid, previewPayout } from './payouts.js';
import { portalCommissions, portalCreateLink, portalLeads, portalLinks, portalMe, portalPayouts, portalUpdateLink } from './portal.js';

// Endpoints of the partners module (docs/partners/PARTNERS.md §4). Literal paths are registered
// before /:id routes. Every handler scopes on the server; anything outside scope is 404.

const companyLinkParams = z.strictObject({ id: z.uuid(), companyId: z.uuid() });
const ownersQuery = z.strictObject({ unitId: z.uuid() });

export function partnerRoutes(router) {
  const auth = requireAuth();

  // ---------- Partners ----------
  router.get('/partners', describe({ summary: 'List partners', permission: P.view, list: true }), auth, validate({ query: s.partnersListQuery }), async (req, res) => {
    res.json(await listPartners(req, req.valid.query));
  });
  router.post('/partners', describe({ summary: 'Add a partner', permission: P.manage, status: 201 }), auth, validate({ body: s.createPartnerBody }), async (req, res) => {
    res.status(201).json({ data: await createPartner(req, req.valid.body) });
  });
  router.get('/partners/owners', describe({ summary: 'People who can own a partner’s leads', permission: P.manage }), auth, validate({ query: ownersQuery }), async (req, res) => {
    res.json({ data: await listOwners(req, req.valid.query.unitId) });
  });
  router.get('/partners/:id', describe({ summary: 'Get a partner', permission: P.view }), auth, validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getPartner(req, req.valid.params.id) });
  });
  router.patch('/partners/:id', describe({ summary: 'Update a partner', permission: P.manage }), auth, validate({ params: idParams, body: s.updatePartnerBody }), async (req, res) => {
    res.json({ data: await updatePartner(req, req.valid.params.id, req.valid.body) });
  });
  router.post(
    '/partners/:id/companies',
    describe({ summary: 'Start working with a partner in another company', permission: P.manage, status: 201 }),
    auth,
    validate({ params: idParams, body: s.linkCompanyBody }),
    async (req, res) => {
      res.status(201).json({ data: await linkCompany(req, req.valid.params.id, req.valid.body) });
    },
  );
  router.patch(
    '/partners/:id/companies/:companyId',
    describe({ summary: 'Change a partnership: status, unit, counsellor, plan', permission: P.manage }),
    auth,
    validate({ params: companyLinkParams, body: s.updateLinkBody }),
    async (req, res) => {
      res.json({ data: await updateCompanyLink(req, req.valid.params.id, req.valid.params.companyId, req.valid.body) });
    },
  );
  router.get(
    '/partners/:id/payout-details',
    describe({ summary: 'Read a partner’s payout details (audited)', permission: P.payoutDetails }),
    auth,
    validate({ params: idParams }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ data: await readPayoutDetails(req, req.valid.params.id) });
    },
  );
  router.put(
    '/partners/:id/payout-details',
    describe({ summary: 'Set a partner’s payout details (stored encrypted)', permission: P.payoutDetails }),
    auth,
    validate({ params: idParams, body: payoutDetailsSchema }),
    async (req, res) => {
      res.json({ data: await setPayoutDetails(req, req.valid.params.id, req.valid.body) });
    },
  );
  router.post(
    '/partners/:id/portal-access',
    describe({ summary: 'Give a partner a portal sign-in', permission: P.manage }),
    auth,
    validate({ params: idParams, body: s.portalAccessBody }),
    async (req, res) => {
      const { partner, inviteUrl } = await grantPortalAccess(req, req.valid.params.id, req.valid.body);
      res.json({ data: { partner, inviteUrl: inviteUrl ?? null } });
    },
  );
  router.delete(
    '/partners/:id/portal-access',
    describe({ summary: 'Remove a partner’s portal sign-in', permission: P.manage }),
    auth,
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await revokePortalAccess(req, req.valid.params.id) });
    },
  );

  // ---------- Referral links ----------
  router.get('/partner-links', describe({ summary: 'List referral links', permission: P.view, list: true }), auth, validate({ query: s.linksListQuery }), async (req, res) => {
    res.json(await listLinks(req, req.valid.query));
  });
  router.post('/partner-links', describe({ summary: 'Create a referral link', permission: P.manage, status: 201 }), auth, validate({ body: s.createLinkBody }), async (req, res) => {
    res.status(201).json({ data: await createLink(req, req.valid.body) });
  });
  router.patch(
    '/partner-links/:id',
    describe({ summary: 'Change or turn off a referral link', permission: P.manage }),
    auth,
    validate({ params: idParams, body: s.updateLinkFieldsBody }),
    async (req, res) => {
      res.json({ data: await updateLink(req, req.valid.params.id, req.valid.body) });
    },
  );

  // ---------- Attributions ----------
  router.get(
    '/partner-attributions',
    describe({ summary: 'List referred leads (attributions)', permission: P.view, list: true }),
    auth,
    validate({ query: s.attributionsListQuery }),
    async (req, res) => {
      res.json(await listAttributions(req, req.valid.query));
    },
  );
  router.post(
    '/partner-attributions',
    describe({ summary: 'Credit a partner for a lead', permission: [P.manage, 'deals.view'], status: 201 }),
    auth,
    validate({ body: s.createAttributionBody }),
    async (req, res) => {
      res.status(201).json({ data: await setAttribution(req, req.valid.body) });
    },
  );
  router.delete(
    '/partner-attributions/:id',
    describe({ summary: 'Remove an attribution', permission: P.manage, status: 204 }),
    auth,
    validate({ params: idParams }),
    async (req, res) => {
      await removeAttribution(req, req.valid.params.id);
      res.status(204).end();
    },
  );

  // ---------- Commission plans ----------
  router.get('/commission-plans', describe({ summary: 'List commission plans', permission: P.view }), auth, validate({ query: s.plansListQuery }), async (req, res) => {
    res.json({ data: await listPlans(req, req.valid.query) });
  });
  router.post(
    '/commission-plans',
    describe({ summary: 'Create a commission plan', permission: P.managePlans, status: 201 }),
    auth,
    validate({ body: s.createPlanBody }),
    async (req, res) => {
      res.status(201).json({ data: await createPlan(req, req.valid.body) });
    },
  );
  router.patch(
    '/commission-plans/:id',
    describe({ summary: 'Change a commission plan', permission: P.managePlans }),
    auth,
    validate({ params: idParams, body: s.updatePlanBody }),
    async (req, res) => {
      res.json({ data: await updatePlan(req, req.valid.params.id, req.valid.body) });
    },
  );

  // ---------- Commissions ----------
  router.get(
    '/partner-commissions',
    describe({ summary: 'List commissions', permission: P.view, list: true }),
    auth,
    validate({ query: s.commissionsListQuery }),
    async (req, res) => {
      res.json(await listCommissions(req, req.valid.query));
    },
  );
  router.get(
    '/partner-commissions/summary',
    describe({ summary: 'Commission totals by status and currency', permission: P.view }),
    auth,
    validate({ query: z.strictObject({ unitId: z.uuid(), partnerId: z.uuid().optional() }) }),
    async (req, res) => {
      res.json({ data: await commissionSummary(req, req.valid.query) });
    },
  );
  router.post(
    '/partner-commissions/approve',
    describe({ summary: 'Approve several commissions', permission: P.approveCommissions }),
    auth,
    validate({ body: s.bulkApproveBody }),
    async (req, res) => {
      res.json({ data: await bulkApprove(req, req.valid.body) });
    },
  );
  router.get('/partner-commissions/:id', describe({ summary: 'Get a commission', permission: P.view }), auth, validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getCommission(req, req.valid.params.id) });
  });
  router.post(
    '/partner-commissions/:id/approve',
    describe({ summary: 'Approve a commission', permission: P.approveCommissions }),
    auth,
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await approveCommission(req, req.valid.params.id) });
    },
  );
  router.post(
    '/partner-commissions/:id/reject',
    describe({ summary: 'Reject a commission', permission: P.approveCommissions }),
    auth,
    validate({ params: idParams, body: s.rejectCommissionBody }),
    async (req, res) => {
      res.json({ data: await rejectCommission(req, req.valid.params.id, req.valid.body) });
    },
  );

  // ---------- Payouts ----------
  router.get('/partner-payouts', describe({ summary: 'List payout batches', permission: [P.managePayouts, P.approvePayouts], list: true }), auth, validate({ query: s.payoutsListQuery }), async (req, res) => {
    res.json(await listPayouts(req, req.valid.query));
  });
  router.post(
    '/partner-payouts/preview',
    describe({ summary: 'Preview a payout batch', permission: P.managePayouts }),
    auth,
    validate({ body: s.createPayoutBody }),
    async (req, res) => {
      res.json({ data: await previewPayout(req, req.valid.body) });
    },
  );
  router.post('/partner-payouts', describe({ summary: 'Prepare a payout batch', permission: P.managePayouts, status: 201 }), auth, validate({ body: s.createPayoutBody }), async (req, res) => {
    res.status(201).json({ data: await createPayout(req, req.valid.body) });
  });
  router.get('/partner-payouts/:id', describe({ summary: 'Get a payout batch', permission: [P.managePayouts, P.approvePayouts] }), auth, validate({ params: idParams }), async (req, res) => {
    res.json({ data: await getPayout(req, req.valid.params.id) });
  });
  router.post(
    '/partner-payouts/:id/approve',
    describe({ summary: 'Approve a payout batch (not by its preparer)', permission: P.approvePayouts }),
    auth,
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await approvePayout(req, req.valid.params.id) });
    },
  );
  router.post(
    '/partner-payouts/:id/mark-paid',
    describe({ summary: 'Mark a payout batch paid', permission: P.managePayouts }),
    auth,
    validate({ params: idParams, body: s.markPaidBody }),
    async (req, res) => {
      res.json({ data: await markPayoutPaid(req, req.valid.params.id, req.valid.body) });
    },
  );
  router.post(
    '/partner-payouts/:id/cancel',
    describe({ summary: 'Cancel a payout batch', permission: P.managePayouts }),
    auth,
    validate({ params: idParams, body: s.cancelPayoutBody }),
    async (req, res) => {
      res.json({ data: await cancelPayout(req, req.valid.params.id, req.valid.body) });
    },
  );

  // ---------- Partner portal (the signed-in partner's own data) ----------
  router.get('/partner-portal/me', describe({ summary: 'The signed-in partner', permission: P.portal }), auth, async (req, res) => {
    res.json({ data: await portalMe(req) });
  });
  router.get('/partner-portal/links', describe({ summary: 'My referral links', permission: P.portal, list: true }), auth, validate({ query: s.portalPageQuery }), async (req, res) => {
    res.json(await portalLinks(req, req.valid.query));
  });
  router.post(
    '/partner-portal/links',
    describe({ summary: 'Create a referral link', permission: P.portal, status: 201 }),
    auth,
    validate({ body: s.portalCreateLinkBody }),
    async (req, res) => {
      res.status(201).json({ data: await portalCreateLink(req, req.valid.body) });
    },
  );
  router.patch(
    '/partner-portal/links/:id',
    describe({ summary: 'Rename or turn off one of my links', permission: P.portal }),
    auth,
    validate({ params: idParams, body: s.portalUpdateLinkBody }),
    async (req, res) => {
      res.json({ data: await portalUpdateLink(req, req.valid.params.id, req.valid.body) });
    },
  );
  router.get('/partner-portal/leads', describe({ summary: 'Leads I referred (masked)', permission: P.portal, list: true }), auth, validate({ query: s.portalPageQuery }), async (req, res) => {
    res.json(await portalLeads(req, req.valid.query));
  });
  router.get(
    '/partner-portal/commissions',
    describe({ summary: 'My commissions', permission: P.portal, list: true }),
    auth,
    validate({ query: s.portalPageQuery }),
    async (req, res) => {
      res.json(await portalCommissions(req, req.valid.query));
    },
  );
  router.get('/partner-portal/payouts', describe({ summary: 'My payouts', permission: P.portal, list: true }), auth, validate({ query: s.portalPageQuery }), async (req, res) => {
    res.json(await portalPayouts(req, req.valid.query));
  });
}
