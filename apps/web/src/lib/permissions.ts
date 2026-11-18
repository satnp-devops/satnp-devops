import type { PermissionGroup, PermissionLevel } from './types';

// Mirrors apps/api/src/core/permissions.js so the UI hides what the API would refuse.
// The API still checks every request; this only decides what to show.
//
//   "*"               everything
//   "users.*"         every action in a module
//   "users.manage"    one action
//   "leads.view:own"  one action, limited to the user's own records

export function permissionLevel(granted: readonly string[], required: string): PermissionLevel | null {
  const [module] = required.split('.');
  let level: PermissionLevel | null = null;
  for (const grant of granted) {
    if (grant === '*' || grant === required || grant === `${module}.*`) return 'all';
    if (grant === `${required}:own` || grant === `${module}.*:own`) level = 'own';
  }
  return level;
}

/** Do the held grants include everything `required` gives? Mirrors the API's privilege-escalation check. */
export function coversPermission(held: readonly string[], required: string): boolean {
  if (held.includes('*')) return true;
  if (required === '*') return false;
  const [base = required, scope] = required.split(':');
  const [module, action] = base.split('.');
  if (action === '*') {
    if (scope === 'own') return held.includes(`${module}.*`) || held.includes(`${module}.*:own`);
    return held.includes(`${module}.*`);
  }
  const level = permissionLevel(held, base);
  return scope === 'own' ? level !== null : level === 'all';
}

/**
 * Turn wildcards into the explicit keys they cover today, for editing in a checklist.
 * "users.*" becomes every users permission; "*" becomes every permission.
 */
export function expandPermissions(granted: readonly string[], catalog: readonly PermissionGroup[]): Set<string> {
  const out = new Set<string>();
  for (const group of catalog) {
    for (const permission of group.permissions) {
      const level = permissionLevel(granted, permission.key);
      if (level === 'all') out.add(permission.key);
      else if (level === 'own' && permission.supportsOwn) out.add(`${permission.key}:own`);
    }
  }
  return out;
}

export function countPermissions(catalog: readonly PermissionGroup[]): number {
  return catalog.reduce((sum, group) => sum + group.permissions.length, 0);
}
