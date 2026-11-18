import { splitE164 } from './normalize.js';

// Personal data the API masks for people without contacts.view_pii where they see the record:
// phone numbers, email addresses, dates of birth and street addresses. Names, city, kind and
// the student profile are basic details and are never masked.

const DOT = '•';

/** "+919812345678" → "+91 •••••••678". Unknown formats keep only their last three digits. */
export function maskPhone(value) {
  if (typeof value !== 'string' || !value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return DOT.repeat(4);
  const parts = value.startsWith('+') ? splitE164(`+${digits}`) : null;
  const national = parts?.callingCode ? parts.national : digits;
  const masked = `${DOT.repeat(Math.max(national.length - 3, 1))}${national.slice(-3)}`;
  return parts?.callingCode ? `+${parts.callingCode} ${masked}` : masked;
}

/** "ravi.k@school.example" → "r•••@school.example". The domain stays: it often names the institute. */
export function maskEmail(value) {
  if (typeof value !== 'string' || !value.includes('@')) return null;
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  return `${local.slice(0, 1)}${DOT.repeat(3)}@${value.slice(at + 1)}`;
}

/** Mask one contact method value by kind. */
export function maskMethodValue(kind, value) {
  return kind === 'email' ? maskEmail(value) : maskPhone(value);
}

/**
 * Present a contact method row for the API, masked unless the viewer may see personal details.
 * @param {{ id: string, kind: string, value: string, normalized: string, label: string | null, is_primary: boolean, verified_at: Date | null, opted_out_at: Date | null }} row
 */
export function presentContactMethod(row, canViewPii) {
  return {
    id: row.id,
    kind: row.kind,
    value: canViewPii ? row.value : maskMethodValue(row.kind, row.normalized),
    normalized: canViewPii ? row.normalized : null,
    label: row.label ?? null,
    isPrimary: row.is_primary === true,
    verifiedAt: row.verified_at ?? null,
    optedOutAt: row.opted_out_at ?? null,
    masked: !canViewPii,
  };
}

/**
 * The personal fields of a contact row, masked when needed. Spread into a presenter:
 *   { ...presentContactPii(row, canViewPii) }
 */
export function presentContactPii(row, canViewPii) {
  return {
    primaryPhone: canViewPii ? (row.primary_phone ?? null) : maskPhone(row.primary_phone),
    primaryEmail: canViewPii ? (row.primary_email ?? null) : maskEmail(row.primary_email),
    dateOfBirth: canViewPii ? (row.date_of_birth ?? null) : null,
    address: canViewPii ? (row.address ?? {}) : null,
    piiMasked: !canViewPii,
  };
}
