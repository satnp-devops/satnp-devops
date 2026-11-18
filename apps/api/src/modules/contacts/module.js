import { contactSettings } from '../../core/crm/settings.js';
import { contactRoutes } from './routes.js';

// Contacts: parents, students and institute staff, stored once per group (contacts, contact_methods,
// contact_companies), households, consents, duplicates and merge, DPDP export and erase.
// Built by the contacts slice; see docs/crm/PHASE2_CONTRACT.md.

export default {
  name: 'contacts',
  label: 'Contacts',
  permissions: [
    {
      key: 'contacts.view',
      label: 'See contacts',
      description: 'See families, students and institute staff known to a unit',
      supportsOwn: true,
    },
    {
      key: 'contacts.manage',
      label: 'Manage contacts',
      description: 'Add and edit contacts, households and consent records',
      supportsOwn: true,
    },
    {
      key: 'contacts.view_pii',
      label: 'See personal details',
      description: 'See phone numbers, emails, dates of birth and addresses (masked otherwise)',
    },
    { key: 'contacts.merge', label: 'Merge duplicates', description: 'Merge two records of the same person' },
    {
      key: 'contacts.privacy',
      label: 'Handle data requests',
      description: "Export or erase a person's data when they ask (DPDP Act)",
    },
  ],
  roleGrants: {
    group_admin: ['contacts.view', 'contacts.manage', 'contacts.view_pii', 'contacts.merge', 'contacts.privacy'],
    company_admin: ['contacts.view', 'contacts.manage', 'contacts.view_pii', 'contacts.merge', 'contacts.privacy'],
    manager: ['contacts.view', 'contacts.manage', 'contacts.view_pii', 'contacts.merge'],
    counsellor: ['contacts.view', 'contacts.manage', 'contacts.view_pii'],
    account_executive: ['contacts.view', 'contacts.manage', 'contacts.view_pii'],
    finance: ['contacts.view', 'contacts.view_pii'],
    marketing: ['contacts.view'],
    support: ['contacts.view', 'contacts.manage', 'contacts.view_pii'],
    analyst: ['contacts.view'],
  },
  settings: contactSettings,
  routes: (router) => contactRoutes(router),
};
