/**
 * Built-in roles. Their permissions are assembled from every module's `roleGrants`,
 * so installing a new module automatically extends these roles (run `npm run roles:sync`).
 * Groups can also create their own custom roles from the Roles screen.
 */
export const SYSTEM_ROLES = [
  { key: 'group_owner', name: 'Group owner', description: 'Full access to everything in the group.', all: true },
  { key: 'group_admin', name: 'Group admin', description: 'Runs companies, people, roles and settings across the group.' },
  { key: 'company_admin', name: 'Company admin', description: 'Runs one company: its units, team, settings and audit log.' },
  { key: 'manager', name: 'Manager', description: 'Leads a branch or team; sees its people and settings.' },
  { key: 'counsellor', name: 'Counsellor', description: 'Works with families: enquiries, demos, fees and enrollments.' },
  { key: 'account_executive', name: 'Account executive', description: 'Sells software to institutes and mentors.' },
  { key: 'finance', name: 'Finance', description: 'Payments, invoices, refunds and payouts.' },
  { key: 'marketing', name: 'Marketing', description: 'Campaigns, forms and lead sources.' },
  { key: 'support', name: 'Support', description: 'Helps students, parents and clients after they join.' },
  { key: 'analyst', name: 'Analyst', description: 'Read-only access to reports.' },
];

export function systemRolePermissions(registry, roleKey) {
  const definition = SYSTEM_ROLES.find((role) => role.key === roleKey);
  if (definition?.all) return ['*'];
  return [...(registry.roleGrants.get(roleKey) ?? [])].sort();
}

/** Create or update the built-in roles so they match the installed modules. */
export async function syncSystemRoles(db, registry) {
  for (const role of SYSTEM_ROLES) {
    const permissions = systemRolePermissions(registry, role.key);
    const existing = await db('roles').whereNull('group_id').where({ key: role.key }).first();
    if (existing) {
      await db('roles')
        .where({ id: existing.id })
        .update({ name: role.name, description: role.description, permissions, is_system: true, updated_at: db.fn.now() });
    } else {
      await db('roles').insert({
        key: role.key,
        name: role.name,
        description: role.description,
        permissions,
        is_system: true,
        group_id: null,
      });
    }
  }
}
