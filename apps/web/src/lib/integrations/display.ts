import type { IconName } from '@/components/icons';
import type { Session } from '@/lib/session';
import type { OrgUnit } from '@/lib/types';
import type { ApiKeyStatus, HealthStatus, KindKey } from './types';

export const KIND_ICON: Record<KindKey, IconName> = {
  'messaging.whatsapp': 'whatsapp',
  'messaging.email': 'mail',
  'messaging.sms': 'message',
  calling: 'phone',
  meetings: 'users',
  calendar: 'calendar',
  payments: 'card',
  esign: 'edit',
  ai: 'sparkle',
  storage: 'upload',
};

export const IDENTITY_LABELS: Record<string, string> = {
  website_form: 'Website form',
  landing_page: 'Landing page',
  chat_widget: 'Chat widget',
  whatsapp: 'WhatsApp number',
  phone_call: 'Call number',
  missed_call: 'Missed-call number',
  sms: 'SMS number',
  email: 'Email inbox',
  facebook_lead_ad: 'Facebook lead ads',
  instagram: 'Instagram',
  google_lead_form: 'Google lead form',
  walk_in: 'Walk-in',
  event: 'Event',
  partner_referral: 'Partner link',
  csv_import: 'CSV import',
  api: 'API client',
  other: 'Other',
};

export const IDENTITY_ICON: Record<string, IconName> = {
  website_form: 'form',
  landing_page: 'link',
  chat_widget: 'message',
  whatsapp: 'whatsapp',
  phone_call: 'phone',
  missed_call: 'phone',
  sms: 'message',
  email: 'mail',
  facebook_lead_ad: 'facebook',
  instagram: 'instagram',
  google_lead_form: 'form',
  partner_referral: 'handshake',
  api: 'key',
};

export const identityLabel = (type: string): string => IDENTITY_LABELS[type] ?? type;

export const HEALTH_TONE: Record<HealthStatus, 'success' | 'danger' | 'neutral'> = {
  healthy: 'success',
  failing: 'danger',
  unknown: 'neutral',
};

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'Healthy',
  failing: 'Failing',
  unknown: 'Not tested',
};

export const KEY_STATUS_TONE: Record<ApiKeyStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
};

/** "messaging.whatsapp" → "Send template" style names for adapter operations. */
export function operationLabel(operation: string): string {
  const words = operation.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type ScopeSession = Pick<Session, 'scope' | 'units' | 'unitsById' | 'can'>;

/** The company the working unit belongs to, or null when working at the group. */
export function companyOfScope(session: ScopeSession): OrgUnit | null {
  let unit: OrgUnit | undefined = session.scope;
  while (unit) {
    if (unit.type === 'company') return unit;
    unit = unit.parentId ? session.unitsById.get(unit.parentId) : undefined;
  }
  return null;
}

/** Active companies of the working group, in name order. */
export function groupCompanies(session: ScopeSession): OrgUnit[] {
  return session.units
    .filter((u) => u.type === 'company' && u.groupId === session.scope.groupId && u.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where a new connection or key may live for a permission: the working company, or (working at the
 * group) the group itself and each company where the user holds the permission.
 */
export function ownerChoices(session: ScopeSession, permission: string): OrgUnit[] {
  const company = companyOfScope(session);
  if (company) return session.can(permission, company) ? [company] : [];
  const group = session.unitsById.get(session.scope.groupId);
  const companies = groupCompanies(session).filter((c) => session.can(permission, c));
  return [...(group && session.can(permission, group) ? [group] : []), ...companies];
}
