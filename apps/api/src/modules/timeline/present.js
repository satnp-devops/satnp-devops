import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { presentTimelineEntry } from '../../core/crm/timeline.js';

// Timeline rows → TimelineEntry (apps/web/src/lib/crm/types.ts). Pure.

/** Meta keys that can hold a phone number or an email address (contract §9.8). */
const PII_META_KEYS = ['phone', 'email', 'from', 'to'];

const maskContactValue = (value) => (value.includes('@') ? maskEmail(value) : maskPhone(value));

function maskMetaValue(value) {
  if (typeof value === 'string') return maskContactValue(value);
  if (Array.isArray(value)) return value.map(maskMetaValue);
  if (value && typeof value === 'object') {
    const out = { ...value };
    for (const key of ['phone', 'email', 'value', 'address']) {
      if (typeof out[key] === 'string') out[key] = maskContactValue(out[key]);
    }
    return out;
  }
  return value;
}

/** Mask the phone numbers and email addresses a timeline entry's meta may carry. Pure. */
export function maskTimelineMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = { ...meta };
  for (const key of PII_META_KEYS) if (out[key] != null) out[key] = maskMetaValue(out[key]);
  return out;
}

export const presentUserRef = (user) => (user ? { id: user.id, name: user.name } : null);

export const presentDealRef = (deal) => (deal ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status } : null);

/**
 * @param {object} row a timeline_events (or archive) row
 * @param {{ actor?: object | null, deal?: object | null, canViewPii: boolean,
 *           canEdit: boolean, canDelete: boolean, canPin: boolean }} context
 */
export function presentEntry(row, { actor = null, deal = null, canViewPii, canEdit, canDelete, canPin }) {
  const base = presentTimelineEntry(row, { actor: presentUserRef(actor) });
  return {
    ...base,
    meta: canViewPii ? (row.meta ?? {}) : maskTimelineMeta(row.meta),
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
    editedAt: toIso(row.edited_at),
    pinnedAt: toIso(row.pinned_at),
    deal: presentDealRef(deal),
    archived: Boolean(row.archived),
    canEdit,
    canDelete,
    canPin,
  };
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
