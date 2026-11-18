import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import {
  accountContactBody,
  accountContactParams,
  accountContactPatchBody,
  accountCreateBody,
  accountLinkParams,
  accountListQuery,
  accountParams,
  accountPatchBody,
  linkPatchBody,
} from './schemas.js';
import {
  addAccountContact,
  createAccount,
  getAccount,
  listAccounts,
  removeAccountContact,
  updateAccount,
  updateAccountContact,
  updateAccountLink,
} from './service.js';

// Institutes API (docs/crm/PHASE2_CONTRACT.md §9.2). Routes go straight on the router the module
// receives, each with describe() first, so the OpenAPI document records them.

export function accountRoutes(router) {
  router.get(
    '/accounts',
    describe({
      summary: 'List institutes in the working scope',
      description:
        'Institutes with a company link the user may see (`accounts.view`, own level: links they own). ' +
        '`q` matches a web or email domain, a phone number, or the name. Phone and email are masked without `contacts.view_pii`.',
      permission: 'accounts.view',
      list: true,
    }),
    requireAuth(),
    validate({ query: accountListQuery }),
    async (req, res) => {
      res.json(await listAccounts(req, req.valid.query));
    },
  );

  router.post(
    '/accounts',
    describe({
      summary: 'Add an institute',
      description:
        'Finds the institute in the group (web domain, email, phone, or name in the same city) or creates it, links it to the ' +
        "unit's company and adds its people. 201 when created, 200 when an existing institute was matched. " +
        'Emits `account.created` or `account.company_linked`.',
      permission: 'accounts.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ body: accountCreateBody }),
    async (req, res) => {
      const result = await createAccount(req, req.valid.body);
      res.status(result.created ? 201 : 200).json({ data: result });
    },
  );

  router.get(
    '/accounts/:id',
    describe({ summary: 'Get an institute', description: 'Profile, company links, people and the deals the user may see.', permission: 'accounts.view' }),
    requireAuth(),
    validate({ params: accountParams }),
    async (req, res) => {
      res.json({ data: await getAccount(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/accounts/:id',
    describe({
      summary: "Edit an institute's details",
      description: 'Phone, email and address need `contacts.view_pii`. Emits `account.updated`.',
      permission: 'accounts.manage',
    }),
    requireAuth(),
    validate({ params: accountParams, body: accountPatchBody }),
    async (req, res) => {
      res.json({ data: await updateAccount(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.patch(
    '/accounts/:id/links/:companyId',
    describe({
      summary: "Change a company's relationship with an institute",
      description: 'Owning unit, owner, status, tags, custom fields and archiving for one company. Emits `account.link_updated`.',
      permission: 'accounts.manage',
    }),
    requireAuth(),
    validate({ params: accountLinkParams, body: linkPatchBody }),
    async (req, res) => {
      res.json({ data: await updateAccountLink(req, req.valid.params.id, req.valid.params.companyId, req.valid.body) });
    },
  );

  router.post(
    '/accounts/:id/contacts',
    describe({
      summary: 'Add a person to an institute',
      description: 'An existing contact, or a new one (found or created as institute staff). Emits `account.contact_added`.',
      permission: 'accounts.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ params: accountParams, body: accountContactBody }),
    async (req, res) => {
      res.status(201).json({ data: await addAccountContact(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.patch(
    '/accounts/:id/contacts/:contactId',
    describe({ summary: "Change a person's role at an institute", description: 'Emits `account.contact_updated`.', permission: 'accounts.manage' }),
    requireAuth(),
    validate({ params: accountContactParams, body: accountContactPatchBody }),
    async (req, res) => {
      res.json({ data: await updateAccountContact(req, req.valid.params.id, req.valid.params.contactId, req.valid.body) });
    },
  );

  router.delete(
    '/accounts/:id/contacts/:contactId',
    describe({
      summary: 'Remove a person from an institute',
      description: 'The person stays a contact. Emits `account.contact_removed`.',
      permission: 'accounts.manage',
      status: 204,
    }),
    requireAuth(),
    validate({ params: accountContactParams }),
    async (req, res) => {
      await removeAccountContact(req, req.valid.params.id, req.valid.params.contactId);
      res.status(204).end();
    },
  );
}
