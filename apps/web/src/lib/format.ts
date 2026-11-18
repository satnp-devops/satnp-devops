const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateOnly.format(date);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return formatDate(iso);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function greeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** A short device description from a user agent: "Chrome on macOS". */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : /curl|node|undici/i.test(userAgent)
              ? 'Script'
              : 'Browser';
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

const ACTIONS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.mfa_verified': 'Passed two-step check',
  'auth.mfa_failed': 'Failed two-step check',
  'auth.mfa_enabled': 'Turned on two-step verification',
  'auth.mfa_disabled': 'Turned off two-step verification',
  'auth.recovery_codes_regenerated': 'Made new recovery codes',
  'auth.password_changed': 'Changed password',
  'auth.password_reset_requested': 'Asked to reset password',
  'auth.password_reset': 'Reset password',
  'auth.session_revoked': 'Signed out a device',
  'org_unit.created': 'Added a unit',
  'org_unit.updated': 'Edited a unit',
  'org_unit.moved': 'Moved a unit',
  'org_unit.archived': 'Archived a unit',
  'org_unit.restored': 'Restored a unit',
  'user.invited': 'Invited someone',
  'user.access_added': 'Gave someone access',
  'user.invite_resent': 'Resent an invitation',
  'user.activated': 'Accepted an invitation',
  'user.updated': 'Updated a profile',
  'user.disabled': 'Disabled an account',
  'user.enabled': 'Re-enabled an account',
  'role_assignment.added': 'Gave a role',
  'role_assignment.removed': 'Removed a role',
  'role.created': 'Created a role',
  'role.updated': 'Edited a role',
  'role.deleted': 'Deleted a role',
  'settings.updated': 'Changed a setting',
  'settings.reset': 'Reset a setting',
};

/** Readable text for an audit action; unknown actions from new modules fall back to their key. */
export function describeAction(action: string): string {
  const known = ACTIONS[action];
  if (known) return known;
  const [, verb = action] = action.split('.');
  const words = verb.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "{ \"a\": 1 }" for display, with long values kept readable. */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value, null, 2);
}
