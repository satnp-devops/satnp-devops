import type {
  ConsentChannel,
  ConsentPurpose,
  ConsentSource,
  ContactKind,
  ContactMethodKind,
  DuplicateCandidate,
  HouseholdRole,
  LinkStatus,
} from '@/lib/crm/types';
import type { OrgUnit } from '@/lib/types';

// Display names for the contacts vocabularies. The values come from the API (core/crm/constants.js).

export const CONTACT_KINDS: readonly ContactKind[] = ['parent', 'student', 'staff', 'other'];
export const KIND_LABELS: Record<ContactKind, string> = {
  parent: 'Parent',
  student: 'Student',
  staff: 'Institute staff',
  other: 'Other',
};

export const METHOD_KINDS: readonly ContactMethodKind[] = ['phone', 'whatsapp', 'email'];
export const METHOD_LABELS: Record<ContactMethodKind, string> = { phone: 'Phone', whatsapp: 'WhatsApp', email: 'Email' };

export const LINK_STATUS_LABELS: Record<LinkStatus, string> = { lead: 'Lead', customer: 'Customer', former: 'Former' };

export const HOUSEHOLD_ROLES: readonly HouseholdRole[] = ['parent', 'guardian', 'student', 'other'];
export const HOUSEHOLD_ROLE_LABELS: Record<HouseholdRole, string> = {
  parent: 'Parent',
  guardian: 'Guardian',
  student: 'Student',
  other: 'Other',
};

export const CONSENT_CHANNELS: readonly ConsentChannel[] = ['whatsapp', 'sms', 'email', 'voice', 'all'];
export const CONSENT_CHANNEL_LABELS: Record<ConsentChannel, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  voice: 'Calls',
  all: 'Every channel',
};

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = ['marketing', 'transactional', 'service'];
export const CONSENT_PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  marketing: 'Marketing',
  transactional: 'Transactional',
  service: 'Service',
};

export const CONSENT_SOURCES: readonly ConsentSource[] = [
  'manual',
  'call',
  'whatsapp',
  'email',
  'sms',
  'web_form',
  'checkout',
  'unsubscribe_link',
  'import',
];
export const CONSENT_SOURCE_LABELS: Record<ConsentSource, string> = {
  manual: 'Entered by staff',
  call: 'On a call',
  whatsapp: 'WhatsApp',
  email: 'Email',
  sms: 'SMS',
  web_form: 'Website form',
  checkout: 'Checkout',
  unsubscribe_link: 'Unsubscribe link',
  import: 'Import',
};

export const DUPLICATE_REASON_LABELS: Record<DuplicateCandidate['reasons'][number], string> = {
  phone: 'Same phone',
  email: 'Same email',
  name: 'Similar name',
  household: 'Same parent and student names',
};

/** The company a unit belongs to (itself when it is one); null for the group. */
export function companyOfUnit(unit: OrgUnit, unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  const ids = unit.path.split('/').filter(Boolean);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const candidate = ids[i] === unit.id ? unit : unitsById.get(ids[i] ?? '');
    if (candidate?.type === 'company') return candidate;
  }
  return unit.type === 'company' ? unit : null;
}

/** "Asha Verma", or "Unnamed contact" when a person has only a number. */
export function nameOf(contact: { displayName: string }): string {
  return contact.displayName.trim() || 'Unnamed contact';
}

/** E.164 from the API, spaced for reading: "+91 98765 43210". Other countries stay as stored. */
export function formatPhone(value: string): string {
  const india = /^\+91(\d{5})(\d{5})$/.exec(value);
  if (india) return `+91 ${india[1]} ${india[2]}`;
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  if (nanp) return `+1 ${nanp[1]} ${nanp[2]} ${nanp[3]}`;
  return value;
}

function displayName(type: 'region' | 'language', code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "IN" → "India". */
export const countryName = (code: string | null) => displayName('region', code);
/** "hi" → "Hindi". */
export const languageName = (code: string | null) => displayName('language', code);
