/**
 * Permission strings:
 *   "*"                 everything
 *   "users.*"           every action in a module
 *   "users.manage"      one action
 *   "leads.view:own"    one action, limited to records the user owns
 *
 * Grants come from roles assigned at an org unit and flow down to every unit below it.
 */

/** How much of `required` (e.g. "users.manage") a list of grants gives: 'all', 'own' or null. */
export function permissionLevel(granted, required) {
  const [module] = required.split('.');
  let level = null;
  for (const grant of granted) {
    if (grant === '*' || grant === required || grant === `${module}.*`) return 'all';
    if (grant === `${required}:own` || grant === `${module}.*:own`) level = 'own';
  }
  return level;
}

/** Does a set of held grants include everything `required` would give? Used to stop privilege escalation. */
export function coversPermission(held, required) {
  if (held.includes('*')) return true;
  if (required === '*') return false;
  const [base, scope] = required.split(':');
  const [module, action] = base.split('.');
  if (action === '*') {
    if (scope === 'own') return held.includes(`${module}.*`) || held.includes(`${module}.*:own`);
    return held.includes(`${module}.*`);
  }
  const level = permissionLevel(held, base);
  return scope === 'own' ? level !== null : level === 'all';
}
