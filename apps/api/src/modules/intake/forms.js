import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { webUrlSchema } from '../../lib/schemas.js';

// Website forms: the definition a company builds on Settings > Forms, the public submission
// format, spam protection (honeypot, a signed render token for the minimum fill time, an optional
// captcha, allowed origins) and the embed snippet. Pure functions; the routes do the I/O.

/** Where a form field's value goes in the normalised enquiry (core/intake enquiry shape). */
export const FORM_TARGETS = Object.freeze([
  'contact.name',
  'contact.firstName',
  'contact.lastName',
  'contact.phone',
  'contact.altPhone',
  'contact.email',
  'contact.city',
  'contact.state',
  'contact.pincode',
  'contact.language',
  'contact.relation',
  'student.name',
  'student.grade',
  'student.board',
  'student.school',
  'student.targetExam',
  'parent.name',
  'parent.phone',
  'parent.email',
  'institute.name',
  'institute.type',
  'institute.city',
  'institute.studentCount',
  'institute.website',
  'interest.course',
  'interest.product',
  'interest.message',
  'interest.preferredTime',
]);

export const FIELD_TYPES = Object.freeze(['text', 'email', 'phone', 'textarea', 'select', 'number', 'checkbox', 'hidden']);
export const CAPTCHA_PROVIDERS = Object.freeze(['none', 'turnstile', 'recaptcha', 'hcaptcha']);
export const CONSENT_CHANNELS = Object.freeze(['whatsapp', 'calls', 'marketing']);

const label = (max) => z.string().trim().min(1, 'Fill this in').max(max);
const optionalLabel = (max) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

export const formFieldSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lowercase letters, digits and _'),
    label: label(120),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    maps: z.enum(FORM_TARGETS).nullable().default(null),
    options: z.array(z.strictObject({ value: label(80), label: label(120) })).max(50).default([]),
    placeholder: optionalLabel(120),
    help: optionalLabel(300),
    defaultValue: optionalLabel(200),
  })
  .refine((f) => f.type !== 'select' || f.options.length > 0, { message: 'A list needs options', path: ['options'] });

export const formConsentSchema = z
  .strictObject({
    text: optionalLabel(2000),
    required: z.boolean().default(false),
    channels: z.array(z.enum(CONSENT_CHANNELS)).max(3).default(['whatsapp', 'calls']),
  })
  .default({ required: false, channels: ['whatsapp', 'calls'] });

export const formSpamSchema = z
  .strictObject({
    honeypot: z.boolean().default(true),
    minSeconds: z.number().int().min(0).max(120).default(3),
    captcha: z.enum(CAPTCHA_PROVIDERS).default('none'),
    captchaSiteKey: optionalLabel(200),
    allowedOrigins: z.array(z.string().trim().regex(/^https?:\/\/[^/\s]+$/, 'Use an origin like https://satnpaper.com')).max(20).default([]),
    perIpPerHour: z.number().int().min(1).max(1000).default(20),
  })
  .default({ honeypot: true, minSeconds: 3, captcha: 'none', allowedOrigins: [], perIpPerHour: 20 });

export const formThankYouSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('message'), message: label(1000) }),
    z.strictObject({ mode: z.literal('redirect'), redirectUrl: webUrlSchema }),
  ])
  .default({ mode: 'message', message: 'Thank you. We will be in touch shortly.' });

/** Checks across fields: unique keys, one field per target, a phone or email captured. */
export function checkFormFields(fields, kind = 'enquiry') {
  const issues = [];
  const keys = new Set();
  const targets = new Map();
  fields.forEach((field, i) => {
    if (keys.has(field.key)) issues.push({ path: `body.fields.${i}.key`, message: 'Each field needs its own key' });
    keys.add(field.key);
    if (field.maps) {
      if (targets.has(field.maps)) issues.push({ path: `body.fields.${i}.maps`, message: 'Another field already fills this' });
      targets.set(field.maps, i);
    }
    if (field.type === 'checkbox' && field.maps) issues.push({ path: `body.fields.${i}.maps`, message: 'A tick box cannot fill a detail' });
  });
  if (kind === 'enquiry' && !targets.has('contact.phone') && !targets.has('contact.email')) {
    issues.push({ path: 'body.fields', message: 'Add a phone or email field so the team can reply' });
  }
  return issues;
}

const setPath = (target, path, value) => {
  const [head, tail] = path.split('.');
  target[head] = { ...(target[head] ?? {}), [tail]: value };
};

/**
 * A visitor's submission → the enquiry input for toEnquiry, plus field errors (paths
 * `body.fields.<key>`). Unmapped fields are kept in `raw.fields` and in the message.
 */
export function submissionToEnquiry(form, submission, { receivedAt, partnerId } = {}) {
  const values = submission.fields ?? {};
  const issues = [];
  const input = { contact: {}, source: { channel: { type: 'website_form', identity: form.key }, formId: form.id } };
  const extras = [];
  for (const field of form.fields) {
    let value = values[field.key];
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === '' || value === null) value = field.type === 'hidden' ? field.defaultValue : undefined;
    const missing = value === undefined || value === '' || (field.type === 'checkbox' && value !== true);
    if (field.required && missing) {
      issues.push({ path: `body.fields.${field.key}`, message: `${field.label} is required` });
      continue;
    }
    if (missing) continue;
    if (field.type === 'checkbox') {
      extras.push(`${field.label}: yes`);
      continue;
    }
    const str = String(value).slice(0, 5000);
    if (field.type === 'select' && !field.options.some((o) => o.value === str)) {
      issues.push({ path: `body.fields.${field.key}`, message: `Pick one of the options for ${field.label}` });
      continue;
    }
    if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str)) {
      issues.push({ path: `body.fields.${field.key}`, message: 'Enter a valid email address' });
      continue;
    }
    if (field.type === 'phone' && str.replace(/\D/g, '').length < 7) {
      issues.push({ path: `body.fields.${field.key}`, message: 'Enter a valid phone number' });
      continue;
    }
    if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(str)) {
      issues.push({ path: `body.fields.${field.key}`, message: `${field.label} must be a number` });
      continue;
    }
    if (field.maps) setPath(input, field.maps, field.maps === 'institute.studentCount' ? Number(str) : str);
    else extras.push(`${field.label}: ${str}`);
  }
  const consentGiven = submission.consent === true;
  if (form.consent?.required && !consentGiven) issues.push({ path: 'body.consent', message: 'Please agree so we can contact you' });
  if (extras.length) {
    const base = input.interest?.message ? `${input.interest.message}\n\n` : '';
    setPath(input, 'interest.message', `${base}${extras.join('\n')}`.slice(0, 5000));
  }
  if (form.product_line_id) setPath(input, 'interest.productLineId', form.product_line_id);
  // Only a real http(s) page counts as the landing page; anything else is dropped, not an error.
  if (submission.pageUrl && originOf(submission.pageUrl)) input.source.landingUrl = submission.pageUrl;
  if (submission.referrer) input.source.referrer = submission.referrer;
  if (submission.utm) input.source.utm = submission.utm;
  if (partnerId) input.source.partnerId = partnerId;
  if (consentGiven && form.consent) {
    const channels = new Set(form.consent.channels ?? []);
    input.consent = {
      whatsapp: channels.has('whatsapp') || undefined,
      calls: channels.has('calls') || undefined,
      marketing: channels.has('marketing') || undefined,
      text: form.consent.text,
      capturedAt: receivedAt,
    };
  }
  input.audience = form.audience;
  input.receivedAt = receivedAt;
  input.raw = { fields: values, pageUrl: submission.pageUrl ?? null };
  return { input, issues };
}

// ---------- Render tokens (minimum fill time) ----------

const TOKEN_MAX_AGE_MS = 24 * 3_600_000;

/** A token the form page gets when it loads; it proves when the form was shown. */
export function signRenderToken(formKey, issuedAtMs, key) {
  const payload = `${formKey}.${issuedAtMs}`;
  const sig = createHmac('sha256', key).update(`intake-form.v1\n${payload}`).digest('base64url');
  return `${issuedAtMs}.${sig}`;
}

/** @returns {{ ok: true, ageMs: number } | { ok: false, reason: 'missing' | 'invalid' | 'expired' }} */
export function verifyRenderToken(formKey, token, key, nowMs) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const [issued, sig] = token.split('.');
  const issuedAtMs = Number(issued);
  if (!Number.isSafeInteger(issuedAtMs) || !sig) return { ok: false, reason: 'invalid' };
  const expected = signRenderToken(formKey, issuedAtMs, key).split('.')[1];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'invalid' };
  const ageMs = nowMs - issuedAtMs;
  if (ageMs < 0 || ageMs > TOKEN_MAX_AGE_MS) return { ok: false, reason: 'expired' };
  return { ok: true, ageMs };
}

/**
 * Spam checks that need no I/O. A bot that fills the honeypot or submits faster than a person
 * can is answered with the normal thank-you (so it learns nothing) and nothing is stored.
 * @returns {{ spam: boolean, reason: string | null }}
 */
export function spamVerdict(form, submission, { key, nowMs, origin }) {
  const spam = form.spam ?? {};
  if (spam.honeypot !== false && typeof submission.hp === 'string' && submission.hp.trim() !== '') return { spam: true, reason: 'honeypot' };
  const minMs = (spam.minSeconds ?? 3) * 1000;
  const token = verifyRenderToken(form.key, submission.token, key, nowMs);
  if (!token.ok) return { spam: true, reason: `token_${token.reason}` };
  if (token.ageMs < minMs) return { spam: true, reason: 'too_fast' };
  if (spam.allowedOrigins?.length && origin && !spam.allowedOrigins.includes(origin)) return { spam: true, reason: 'origin' };
  return { spam: false, reason: null };
}

/** The origin of the page that embedded the form (from its URL), or null. */
export function originOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** The public parts of a form, for the hosted page. */
export function publicForm(form, { token }) {
  return {
    key: form.key,
    name: form.name,
    fields: form.fields.filter((f) => f.type !== 'hidden').map(({ key, label: l, type, required, options, placeholder, help }) => ({ key, label: l, type, required, options, placeholder: placeholder ?? null, help: help ?? null })),
    consent: form.consent?.text ? { text: form.consent.text, required: Boolean(form.consent.required) } : null,
    spam: { honeypot: form.spam?.honeypot !== false, captcha: form.spam?.captcha ?? 'none', captchaSiteKey: form.spam?.captchaSiteKey ?? null },
    thankYou: form.thank_you,
    token,
  };
}

/** Embed snippets for a form: an iframe of the hosted page, and the direct link. */
export function embedSnippet(form, { webOrigin }) {
  const url = `${webOrigin.replace(/\/+$/, '')}/f/${form.key}`;
  return {
    url,
    iframe: `<iframe src="${url}" title="${form.name.replace(/"/g, '&quot;')}" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>\n<script>window.addEventListener('message',function(e){if(e.origin!=='${new URL(url).origin}'||!e.data||e.data.type!=='phoenix-form-height')return;document.querySelectorAll('iframe[src^="${url}"]').forEach(function(f){f.style.height=e.data.height+'px'})});</script>`,
    referralUrl: (code) => `${url}?ref=${encodeURIComponent(code)}`,
  };
}

/** Default fields for a new form of each audience. */
export function defaultFields(audience) {
  if (audience === 'b2b') {
    return [
      { key: 'name', label: 'Your name', type: 'text', required: true, maps: 'contact.name', options: [] },
      { key: 'phone', label: 'Mobile number', type: 'phone', required: true, maps: 'contact.phone', options: [] },
      { key: 'email', label: 'Work email', type: 'email', required: false, maps: 'contact.email', options: [] },
      { key: 'institute', label: 'Institute name', type: 'text', required: true, maps: 'institute.name', options: [] },
      { key: 'city', label: 'City', type: 'text', required: false, maps: 'institute.city', options: [] },
      { key: 'students', label: 'Number of students', type: 'number', required: false, maps: 'institute.studentCount', options: [] },
      { key: 'message', label: 'What are you looking for?', type: 'textarea', required: false, maps: 'interest.message', options: [] },
    ];
  }
  return [
    { key: 'name', label: 'Parent name', type: 'text', required: true, maps: 'contact.name', options: [] },
    { key: 'phone', label: 'Mobile number', type: 'phone', required: true, maps: 'contact.phone', options: [] },
    { key: 'email', label: 'Email', type: 'email', required: false, maps: 'contact.email', options: [] },
    { key: 'student', label: 'Student name', type: 'text', required: false, maps: 'student.name', options: [] },
    { key: 'grade', label: 'Grade', type: 'text', required: false, maps: 'student.grade', options: [] },
    { key: 'message', label: 'How can we help?', type: 'textarea', required: false, maps: 'interest.message', options: [] },
  ];
}
