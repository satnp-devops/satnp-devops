/**
 * The normalised enquiry: the one shape every channel (web form, WhatsApp, calls, ad lead
 * forms, walk-ins, partner referrals, CSV imports, the public API) produces before routing,
 * dedup and assignment run.
 *
 * Channels build a plain object and call toEnquiry(); it validates with zod, normalises
 * phones, emails and names with the injected normalisers, fills UTM tags from the landing
 * URL, and returns the enquiry plus warnings, or field errors. Nothing is stored here.
 */

import { z } from 'zod';
import { resolveNormalizers } from './normalize.js';

/** Where an enquiry can arrive from. A channel's `identity` says which number, inbox or form. */
export const CHANNEL_TYPES = Object.freeze([
  'website_form', // identity: form id, or the site host ("satnpaper.com")
  'landing_page', // identity: page URL or host
  'chat_widget', // identity: widget id or site host
  'whatsapp', // identity: the business number (E.164)
  'phone_call', // identity: the number dialled (E.164)
  'missed_call', // identity: the missed-call number (E.164)
  'sms', // identity: the number or sender id
  'email', // identity: the receiving inbox
  'facebook_lead_ad', // identity: page id or form id
  'instagram', // identity: account id
  'google_lead_form', // identity: form id
  'walk_in', // identity: branch unit id
  'event', // identity: event id (fair, seminar, school visit)
  'partner_referral', // identity: partner id
  'csv_import', // identity: import batch id
  'api', // identity: API client id
  'other',
]);

/** Channel types whose identity is a phone number. */
export const PHONE_CHANNELS = new Set(['whatsapp', 'phone_call', 'missed_call', 'sms']);
/** Channel types whose identity may be a URL or host. */
export const WEB_CHANNELS = new Set(['website_form', 'landing_page', 'chat_widget']);

/** How the enquirer relates to the learner. */
export const RELATIONS = Object.freeze(['self', 'parent', 'guardian', 'sibling', 'staff', 'other']);

/** Blank strings and null mean "not given". */
const blank = (value) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return value;
};

const text = (max) => z.preprocess(blank, z.string().max(max).optional());
const bool = z.preprocess(blank, z.boolean().optional());

const timeZone = z.preprocess(
  blank,
  z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone')
    .optional(),
);

const webUrl = z.preprocess(
  blank,
  z.url({ protocol: /^https?$/, error: 'Use a full link starting with https://' }).max(2000).optional(),
);

const instant = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : blank(value)),
  z.iso.datetime({ offset: true, error: 'Use an ISO date and time, e.g. 2026-11-05T10:30:00Z' }).optional(),
);

export const utmSchema = z.strictObject({
  source: text(200),
  medium: text(200),
  campaign: text(200),
  term: text(200),
  content: text(200),
});

export const channelSchema = z.strictObject({
  type: z.enum(CHANNEL_TYPES),
  identity: text(500),
});

/** Source attribution: where the enquiry came from and which campaign brought it. */
export const sourceSchema = z.strictObject({
  channel: channelSchema,
  campaign: text(200),
  campaignId: text(100),
  utm: utmSchema.optional(),
  referrer: text(2000),
  partnerId: text(100),
  landingUrl: webUrl,
  formId: text(200),
  adId: text(200),
  clickIds: z.strictObject({ gclid: text(500), fbclid: text(500), msclkid: text(500) }).optional(),
  capturedById: text(100),
});

export const contactSchema = z.strictObject({
  name: text(200),
  firstName: text(100),
  lastName: text(100),
  phone: text(40),
  altPhone: text(40),
  email: text(254),
  relation: z.preprocess(blank, z.enum(RELATIONS).optional()),
  language: z.preprocess(
    (value) => (typeof blank(value) === 'string' ? blank(value).toLowerCase() : blank(value)),
    z.string().regex(/^[a-z]{2,3}$/, 'Use a language code such as hi, en or ta').optional(),
  ),
  timeZone,
  city: text(120),
  state: text(120),
  country: z.preprocess(
    (value) => (typeof blank(value) === 'string' ? blank(value).toUpperCase() : blank(value)),
    z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as IN').optional(),
  ),
  pincode: text(12),
});

export const studentSchema = z.strictObject({
  name: text(200),
  grade: text(40),
  board: text(60),
  school: text(200),
  targetExam: text(100),
  dateOfBirth: z.preprocess(blank, z.iso.date().optional()),
});

export const parentSchema = z.strictObject({
  name: text(200),
  phone: text(40),
  email: text(254),
  relation: z.preprocess(blank, z.enum(['father', 'mother', 'guardian', 'other']).optional()),
});

export const instituteSchema = z.strictObject({
  name: text(200),
  type: text(60),
  city: text(120),
  studentCount: z.preprocess(blank, z.coerce.number().int().min(0).max(10_000_000).optional()),
  website: webUrl,
});

export const interestSchema = z.strictObject({
  productLineId: text(100),
  product: text(200),
  course: text(200),
  message: text(5000),
  preferredTime: text(200),
});

export const consentSchema = z.strictObject({
  marketing: bool,
  whatsapp: bool,
  calls: bool,
  capturedAt: instant,
  text: text(2000),
});

/** The normalised enquiry. Build one with toEnquiry(), which also normalises contact points. */
export const enquirySchema = z.strictObject({
  externalId: text(200),
  companyId: text(100),
  audience: z.preprocess(blank, z.enum(['b2c', 'b2b']).optional()),
  receivedAt: instant,
  source: sourceSchema,
  contact: contactSchema,
  student: studentSchema.optional(),
  parent: parentSchema.optional(),
  institute: instituteSchema.optional(),
  interest: interestSchema.optional(),
  consent: consentSchema.optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

/** @typedef {z.output<typeof enquirySchema>} Enquiry */
/** @typedef {{ path: string, code: string, message: string }} EnquiryIssue */

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];
const CLICK_KEYS = ['gclid', 'fbclid', 'msclkid'];

/**
 * UTM tags and ad click ids found in a landing URL's query string.
 * @param {string | undefined} url
 * @returns {{ utm: Record<string, string>, clickIds: Record<string, string> }}
 */
export function attributionFromUrl(url) {
  const out = { utm: {}, clickIds: {} };
  if (!url) return out;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return out;
  }
  for (const key of UTM_KEYS) {
    const value = parsed.searchParams.get(`utm_${key}`)?.trim();
    if (value) out.utm[key] = value.slice(0, 200);
  }
  for (const key of CLICK_KEYS) {
    const value = parsed.searchParams.get(key)?.trim();
    if (value) out.clickIds[key] = value.slice(0, 500);
  }
  return out;
}

/**
 * Validate and normalise an enquiry from any channel.
 *
 * - phones become E.164 and emails lower case (via `normalizers`); a contact point that can't be
 *   normalised is dropped with a warning when another one remains, otherwise it is an error;
 * - `contact.name` is built from first and last name when missing, and display-cleaned;
 * - UTM tags and click ids missing from `source` are taken from `source.landingUrl`;
 * - `receivedAt` defaults to `now`.
 *
 * @param {unknown} input
 * @param {{ normalizers?: Partial<import('./normalize.js').Normalizers>, defaultCountry?: string, now?: Date | number | string }} [options]
 * @returns {{ ok: true, enquiry: Enquiry, warnings: EnquiryIssue[] } | { ok: false, errors: EnquiryIssue[], warnings: EnquiryIssue[] }}
 */
export function toEnquiry(input, { normalizers, defaultCountry = 'IN', now } = {}) {
  const parsed = enquirySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
      warnings: [],
    };
  }
  const norm = resolveNormalizers(normalizers);
  const enquiry = structuredClone(parsed.data);
  /** @type {EnquiryIssue[]} */
  const warnings = [];
  /** @type {EnquiryIssue[]} */
  const errors = [];
  const contact = enquiry.contact;

  const name = norm.name(contact.name ?? [contact.firstName, contact.lastName].filter(Boolean).join(' '));
  if (name) contact.name = name;
  else delete contact.name;
  for (const part of ['firstName', 'lastName']) {
    if (contact[part]) contact[part] = norm.name(contact[part]) || undefined;
    if (!contact[part]) delete contact[part];
  }

  const phoneOptions = { defaultCountry: contact.country ?? defaultCountry };
  const normalisePhoneField = (holder, field, path) => {
    if (!holder[field]) return;
    const value = norm.phone(holder[field], phoneOptions);
    if (value) holder[field] = value;
    else {
      warnings.push({ path, code: 'invalid_phone', message: `"${holder[field]}" is not a phone number we recognise` });
      delete holder[field];
    }
  };
  const normaliseEmailField = (holder, field, path) => {
    if (!holder[field]) return;
    const value = norm.email(holder[field]);
    if (value) holder[field] = value;
    else {
      warnings.push({ path, code: 'invalid_email', message: `"${holder[field]}" is not an email address` });
      delete holder[field];
    }
  };
  normalisePhoneField(contact, 'phone', 'contact.phone');
  normalisePhoneField(contact, 'altPhone', 'contact.altPhone');
  normaliseEmailField(contact, 'email', 'contact.email');
  if (!contact.phone && contact.altPhone) {
    contact.phone = contact.altPhone;
    delete contact.altPhone;
  }
  if (contact.altPhone && contact.altPhone === contact.phone) delete contact.altPhone;
  if (enquiry.parent) {
    normalisePhoneField(enquiry.parent, 'phone', 'parent.phone');
    normaliseEmailField(enquiry.parent, 'email', 'parent.email');
    if (enquiry.parent.name) enquiry.parent.name = norm.name(enquiry.parent.name) || undefined;
  }
  if (enquiry.student?.name) enquiry.student.name = norm.name(enquiry.student.name) || undefined;

  if (!contact.phone && !contact.email) {
    // Promote an invalid-contact-point warning to the error that explains the rejection.
    const reasons = warnings.filter((w) => w.path === 'contact.phone' || w.path === 'contact.email' || w.path === 'contact.altPhone');
    if (reasons.length) {
      for (const reason of reasons) warnings.splice(warnings.indexOf(reason), 1);
      errors.push(...reasons);
    }
    errors.push({ path: 'contact', code: 'contact_point_required', message: 'Give a phone number or an email address' });
  }
  if (!contact.name && !contact.phone && !enquiry.student?.name && !enquiry.institute?.name) {
    warnings.push({ path: 'contact.name', code: 'name_missing', message: 'No name given' });
  }

  const fromUrl = attributionFromUrl(enquiry.source.landingUrl);
  if (Object.keys(fromUrl.utm).length) enquiry.source.utm = { ...fromUrl.utm, ...stripUndefined(enquiry.source.utm) };
  if (Object.keys(fromUrl.clickIds).length) {
    enquiry.source.clickIds = { ...fromUrl.clickIds, ...stripUndefined(enquiry.source.clickIds) };
  }
  if (!enquiry.source.campaign && enquiry.source.utm?.campaign) enquiry.source.campaign = enquiry.source.utm.campaign;

  if (!enquiry.receivedAt) enquiry.receivedAt = new Date(now ?? Date.now()).toISOString();
  if (!enquiry.audience) enquiry.audience = enquiry.institute?.name ? 'b2b' : enquiry.student || enquiry.parent ? 'b2c' : undefined;
  const cleaned = /** @type {Enquiry} */ (deepStripUndefined(enquiry));

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, enquiry: cleaned, warnings };
}

function stripUndefined(object) {
  if (!object) return {};
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function deepStripUndefined(value) {
  if (Array.isArray(value)) return value.map(deepStripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const cleaned = deepStripUndefined(item);
      if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0 && key !== 'raw') {
        continue;
      }
      out[key] = cleaned;
    }
    return out;
  }
  return value;
}
