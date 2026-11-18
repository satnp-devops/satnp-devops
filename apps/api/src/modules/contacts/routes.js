import { db } from '../../lib/db.js';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { listConsents, recordConsent } from './consents.js';
import {
  addMember,
  createHousehold,
  getHousehold,
  listHouseholds,
  removeMember,
  updateHousehold,
  updateMember,
} from './households.js';
import { exportContact } from './privacy.js';
import {
  contactCheckBody,
  contactCreateBody,
  contactListQuery,
  contactParams,
  contactPatchBody,
  consentBody,
  eraseBody,
  householdCreateBody,
  householdListQuery,
  householdMemberBody,
  householdMemberPatchBody,
  householdPatchBody,
  linkParams,
  linkPatchBody,
  memberParams,
  mergeBody,
  methodBody,
  methodParams,
  methodPatchBody,
} from './schemas.js';
import {
  addMethod,
  checkContact,
  createContact,
  eraseContact,
  findDuplicates,
  getContact,
  listContacts,
  mergeContacts,
  removeMethod,
  updateContact,
  updateLink,
  updateMethod,
} from './service.js';

// Contacts, contact methods, households, consents, duplicates and merge, DPDP export and erase
// (docs/crm/PHASE2_CONTRACT.md §9.1). Literal paths are registered before the /:id routes.

export function contactRoutes(router) {
  router.get(
    '/contacts',
    describe({
      summary: 'List contacts in a unit',
      description: 'People known to the working unit through their company links. `q` is an exact phone or email, or a name. PII is masked without `contacts.view_pii`.',
      permission: 'contacts.view',
      list: true,
    }),
    requireAuth(),
    validate({ query: contactListQuery }),
    async (req, res) => {
      res.json(await listContacts(req, req.valid.query));
    },
  );

  router.post(
    '/contacts/check',
    describe({
      summary: 'Check for an existing person before adding a contact',
      description: 'Runs the same matching as creating a contact, without writing. A match the viewer can’t see comes back as `hiddenMatch`.',
      permission: 'contacts.manage',
    }),
    requireAuth(),
    validate({ body: contactCheckBody }),
    async (req, res) => {
      res.json({ data: await checkContact(req, req.valid.body) });
    },
  );

  router.post(
    '/contacts',
    describe({
      summary: 'Add a contact',
      description:
        'De-duplicated across the group: an existing person with the same phone or email is linked to the company and returned (200) instead of created (201). Emits `contact.created`, `contact.company_linked` or `contact.updated`.',
      permission: 'contacts.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ body: contactCreateBody }),
    async (req, res) => {
      const { created, result } = await createContact(req, req.valid.body);
      res.status(created ? 201 : 200).json({ data: result });
    },
  );

  router.get(
    '/contacts/:id',
    describe({ summary: 'Get a contact', permission: 'contacts.view' }),
    requireAuth(),
    validate({ params: contactParams }),
    async (req, res) => {
      res.json({ data: await getContact(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/contacts/:id',
    describe({
      summary: 'Change a contact’s details',
      description: 'Date of birth and address need `contacts.view_pii`. Emits `contact.updated`.',
      permission: 'contacts.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: contactParams, body: contactPatchBody }),
    async (req, res) => {
      res.json({ data: await updateContact(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.patch(
    '/contacts/:id/links/:companyId',
    describe({
      summary: 'Change a company’s link to a contact',
      description: 'Owning unit, owner, status, tags, custom fields, archive. Emits `contact.link_updated`.',
      permission: 'contacts.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: linkParams, body: linkPatchBody }),
    async (req, res) => {
      const { id, companyId } = req.valid.params;
      res.json({ data: await updateLink(req, id, companyId, req.valid.body) });
    },
  );

  router.post(
    '/contacts/:id/methods',
    describe({ summary: 'Add a phone number or email to a contact', permission: 'contacts.manage', status: 201, errors: [409] }),
    requireAuth(),
    validate({ params: contactParams, body: methodBody }),
    async (req, res) => {
      res.status(201).json({ data: await addMethod(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.patch(
    '/contacts/:id/methods/:methodId',
    describe({
      summary: 'Change a contact method',
      description: 'Label, primary, verified, opted out (the person asked not to be contacted on this number or address).',
      permission: 'contacts.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: methodParams, body: methodPatchBody }),
    async (req, res) => {
      const { id, methodId } = req.valid.params;
      res.json({ data: await updateMethod(req, id, methodId, req.valid.body) });
    },
  );

  router.delete(
    '/contacts/:id/methods/:methodId',
    describe({ summary: 'Remove a contact method', permission: 'contacts.manage', status: 204, errors: [409] }),
    requireAuth(),
    validate({ params: methodParams }),
    async (req, res) => {
      const { id, methodId } = req.valid.params;
      await removeMethod(req, id, methodId);
      res.status(204).end();
    },
  );

  router.get(
    '/contacts/:id/duplicates',
    describe({
      summary: 'Suggest duplicates of a contact',
      description: 'People sharing a phone or email, similar names with something in common, and families entered twice (similar parent and student names).',
      permission: 'contacts.view',
    }),
    requireAuth(),
    validate({ params: contactParams }),
    async (req, res) => {
      res.json({ data: await findDuplicates(req, req.valid.params.id) });
    },
  );

  router.post(
    '/contacts/:id/merge',
    describe({
      summary: 'Merge a duplicate into this contact',
      description: 'Keeps this contact and moves every method, link, household, deal, task, consent and timeline entry of `sourceId` to it. Emits `contact.merged`.',
      permission: 'contacts.merge',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: contactParams, body: mergeBody }),
    async (req, res) => {
      const { id } = req.valid.params;
      await db.transaction((trx) => mergeContacts(trx, { targetId: id, sourceId: req.valid.body.sourceId }, { req }));
      res.json({ data: await getContact(req, id) });
    },
  );

  router.get(
    '/contacts/:id/export',
    describe({
      summary: 'Export everything the group holds about a person',
      description: 'DPDP access request: unmasked JSON download. Audited as `contact.exported`.',
      permission: 'contacts.privacy',
    }),
    requireAuth(),
    validate({ params: contactParams }),
    async (req, res) => {
      const { id } = req.valid.params;
      const data = await exportContact(req, id);
      res.set('Content-Disposition', `attachment; filename="contact-${id}.json"`);
      res.set('Cache-Control', 'no-store');
      res.json({ data });
    },
  );

  router.post(
    '/contacts/:id/erase',
    describe({
      summary: 'Erase a person’s personal data',
      description: 'DPDP erasure request: anonymises the person and their messages; deals, money and audit records stay. Emits `contact.erased`.',
      permission: 'contacts.privacy',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: contactParams, body: eraseBody }),
    async (req, res) => {
      const { id } = req.valid.params;
      await db.transaction((trx) => eraseContact(trx, id, { req, reason: req.valid.body.reason }));
      res.json({ data: await getContact(req, id) });
    },
  );

  router.get(
    '/contacts/:id/consents',
    describe({ summary: 'List a contact’s consent records and effective consent', permission: 'contacts.view' }),
    requireAuth(),
    validate({ params: contactParams }),
    async (req, res) => {
      res.json({ data: await listConsents(req, req.valid.params.id) });
    },
  );

  router.post(
    '/contacts/:id/consents',
    describe({
      summary: 'Record consent or a withdrawal',
      description: 'Append-only. Group-wide grants need `contacts.manage` at the group. Emits `consent.recorded`.',
      permission: 'contacts.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ params: contactParams, body: consentBody }),
    async (req, res) => {
      res.status(201).json({ data: await recordConsent(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.get(
    '/households',
    describe({ summary: 'List households in a unit', permission: 'contacts.view', list: true }),
    requireAuth(),
    validate({ query: householdListQuery }),
    async (req, res) => {
      res.json(await listHouseholds(req, req.valid.query));
    },
  );

  router.post(
    '/households',
    describe({ summary: 'Create a household', permission: 'contacts.manage', status: 201 }),
    requireAuth(),
    validate({ body: householdCreateBody }),
    async (req, res) => {
      res.status(201).json({ data: await createHousehold(req, req.valid.body) });
    },
  );

  router.get(
    '/households/:id',
    describe({ summary: 'Get a household', permission: 'contacts.view' }),
    requireAuth(),
    validate({ params: contactParams }),
    async (req, res) => {
      res.json({ data: await getHousehold(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/households/:id',
    describe({ summary: 'Rename, move or archive a household', permission: 'contacts.manage' }),
    requireAuth(),
    validate({ params: contactParams, body: householdPatchBody }),
    async (req, res) => {
      res.json({ data: await updateHousehold(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/households/:id/members',
    describe({ summary: 'Add a person to a household', permission: 'contacts.manage', status: 201, errors: [409] }),
    requireAuth(),
    validate({ params: contactParams, body: householdMemberBody }),
    async (req, res) => {
      res.status(201).json({ data: await addMember(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.patch(
    '/households/:id/members/:contactId',
    describe({ summary: 'Change a household member’s role', permission: 'contacts.manage' }),
    requireAuth(),
    validate({ params: memberParams, body: householdMemberPatchBody }),
    async (req, res) => {
      const { id, contactId } = req.valid.params;
      res.json({ data: await updateMember(req, id, contactId, req.valid.body) });
    },
  );

  router.delete(
    '/households/:id/members/:contactId',
    describe({ summary: 'Remove a person from a household', permission: 'contacts.manage' }),
    requireAuth(),
    validate({ params: memberParams }),
    async (req, res) => {
      const { id, contactId } = req.valid.params;
      res.json({ data: await removeMember(req, id, contactId) });
    },
  );
}
