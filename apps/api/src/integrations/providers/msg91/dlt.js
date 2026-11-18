/**
 * Client-side enforcement of India's DLT (TRAI TCCCPR) rules for MSG91 SMS. Pure functions, no I/O.
 *
 * The operator DLT scrubber is the final authority; these checks catch the common rejections
 * before an SMS is paid for: unregistered templates, {#var#} values that are too long or of the
 * wrong type, CTA URLs / callback numbers that are not whitelisted, IP-based URLs, numeric
 * headers with short URLs, and promotional traffic outside 10:00–21:00 IST.
 *
 * Sources (read 2026-11-05): msg91.com/help/dlt-registration-in-india/{dlt-content-template-faqs,
 * variable-tagging-on-dlt-sms-templates, cta-whitelisting-faqs, dlt-template-scrubbing-filtering-rules,
 * cta-whitelisting-solution-for-redirecting-urls}.
 */

/** @typedef {import('./errors.js').Issue} Issue */
/** @typedef {import('./config.js').Msg91Template} Msg91Template */
/** @typedef {{ name: string, type: string, maxLength: number }} TemplateVariable */

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
export const IST_OFFSET_MINUTES = 330;
/** MSG91 rejects schedules more than three weeks ahead (API error 606). */
export const MAX_SCHEDULE_AHEAD_MS = 21 * 24 * 60 * 60 * 1000;
/** MSG91 CRQID: alphanumeric only, at most 52 characters. */
export const CRQID_MAX_LENGTH = 52;
/** Domain MSG91's URL shortener rewrites links to; `https://m.9m.io/<HEADER>/` must be on DLT. */
export const SHORT_URL_BASE = 'https://m.9m.io/';

const MSG91_PLACEHOLDER = /##([A-Za-z0-9_]+)##/g;
const DLT_PLACEHOLDER = /\{#(var|numeric|number|url|urlott|cbn|email|alphanumeric)#\}/gi;
const DLT_LIKE_TOKEN = /\{#[^}]*#\}|\{#[^}]*\}|\{[^}]*#\}/g;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'{}]+/gi;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PROMOTIONAL_CATEGORIES = new Set(['promotional', 'service_explicit']);

/** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] @returns {Issue} */
const issue = (code, message, extra = {}) => ({ code, message, severity: 'error', ...extra });
/** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] @returns {Issue} */
const warning = (code, message, extra = {}) => ({ code, message, severity: 'warning', ...extra });

// ---------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------

/**
 * Normalise a phone number to MSG91's format: country code + number, digits only (919876543210).
 * Accepts '+91 98765-43210', '09876543210', '9876543210', '0091 9876543210'.
 * @param {unknown} input
 * @param {{ defaultCountryCode?: string, allowInternational?: boolean }} [options]
 * @returns {{ ok: true, value: string } | { ok: false, issue: Issue }}
 */
export function normalizeMobile(input, { defaultCountryCode = '91', allowInternational = false } = {}) {
  const raw = typeof input === 'number' ? String(input) : input;
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, issue: issue('invalid_mobile', 'mobile number is required') };
  if (/[^\d\s+().-]/.test(raw)) return { ok: false, issue: issue('invalid_mobile', 'mobile number contains invalid characters') };
  const hadPlus = raw.trim().startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2);
  else if (!hadPlus && digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!hadPlus && digits.length === 10) digits = `${defaultCountryCode}${digits}`;
  if (digits.startsWith('91') && digits.length === 12) {
    return /^91[6-9]\d{9}$/.test(digits)
      ? { ok: true, value: digits }
      : { ok: false, issue: issue('invalid_mobile', 'Indian mobile numbers start with 6, 7, 8 or 9') };
  }
  if (!allowInternational) return { ok: false, issue: issue('invalid_mobile', 'only Indian (+91) mobile numbers are allowed') };
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, issue: issue('invalid_mobile', 'not a valid international number') };
  return { ok: true, value: digits };
}

/** Mask a phone number for logs: 919876543210 → 91******3210. @param {string} mobile */
export function maskMobile(mobile) {
  const s = String(mobile ?? '');
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`;
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

/** Placeholder names in an MSG91 template body ('Hi ##name##' → ['name']), unique, in order. @param {string} body */
export function extractPlaceholders(body) {
  return [...new Set([...String(body).matchAll(MSG91_PLACEHOLDER)].map((m) => m[1]))];
}

/** Placeholder names in order of appearance, repeats included. @param {string} body */
function placeholderSequence(body) {
  return [...String(body).matchAll(MSG91_PLACEHOLDER)].map((m) => m[1]);
}

/** DLT tags in order of appearance ('{#var#}', '{#numeric#}', ...) lower-cased. @param {string} dltBody */
export function extractDltTags(dltBody) {
  return [...String(dltBody).matchAll(DLT_PLACEHOLDER)].map((m) => m[1].toLowerCase());
}

/** @param {string} s */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * True when the MSG91 body and the DLT-approved body have the same static text and the same
 * number of variables in the same places (whitespace-insensitive).
 * @param {string} body @param {string} dltBody
 */
export function bodiesMatch(body, dltBody) {
  const a = collapse(String(body).replace(MSG91_PLACEHOLDER, '\u0000'));
  const b = collapse(String(dltBody).replace(DLT_PLACEHOLDER, '\u0000'));
  return a === b;
}

/** @param {string} tag */
function typeFromDltTag(tag) {
  if (tag === 'number') return 'numeric';
  return tag === 'var' ? 'text' : tag;
}

/**
 * The variables of a template with type and length cap resolved. Order: `variables` as declared,
 * else body placeholders. Types come from the declaration, else from typed DLT tags
 * ({#numeric#}, {#url#}, ...) matched by position, else 'text'.
 * @param {Msg91Template} template
 * @param {number} [maxVariableLength]
 * @returns {TemplateVariable[]}
 */
export function templateVariables(template, maxVariableLength = 40) {
  const sequence = template.body ? placeholderSequence(template.body) : [];
  const tags = template.dltBody ? extractDltTags(template.dltBody) : [];
  /** @type {Map<string, string>} */
  const inferred = new Map();
  if (tags.length === sequence.length) sequence.forEach((name, i) => inferred.set(name, typeFromDltTag(tags[i])));
  const declared = template.variables ?? extractPlaceholders(template.body ?? '').map((name) => ({ name }));
  return declared.map((v) => ({
    name: v.name,
    type: v.type && (v.type !== 'text' || !inferred.has(v.name)) ? v.type : (inferred.get(v.name) ?? 'text'),
    maxLength: Math.min(v.maxLength ?? maxVariableLength, maxVariableLength),
  }));
}

/**
 * Static checks on a registered template definition (run once at client creation).
 * @param {string} key
 * @param {Msg91Template} template
 * @param {{ senderId?: string, whitelistedUrls?: string[] }} [context]
 * @returns {Issue[]}
 */
export function checkTemplateDefinition(key, template, context = {}) {
  /** @type {Issue[]} */
  const issues = [];
  const path = `templates.${key}`;
  const senderId = template.senderId ?? context.senderId;
  if (senderId) {
    const senderIssue = checkSenderId(senderId, template.category);
    if (senderIssue) issues.push({ ...senderIssue, path: `${path}.senderId` });
  }
  if (template.body && template.variables) {
    const inBody = new Set(extractPlaceholders(template.body));
    const declared = new Set(template.variables.map((v) => v.name));
    for (const name of declared) if (!inBody.has(name)) issues.push(issue('variable_not_in_body', `variable "${name}" is not used in the template body`, { path }));
    for (const name of inBody) if (!declared.has(name)) issues.push(issue('variable_not_declared', `placeholder ##${name}## is not declared in variables`, { path }));
  }
  if (template.dltBody) issues.push(...checkDltBody(template.dltBody, path));
  if (template.body && template.dltBody && !bodiesMatch(template.body, template.dltBody)) {
    issues.push(issue('dlt_body_mismatch', 'MSG91 body and DLT-approved body differ (static text or variable positions)', { path }));
  }
  if (template.body) {
    for (const url of findUrls(template.body.replace(MSG91_PLACEHOLDER, ''))) {
      if (!isUrlWhitelisted(url, context.whitelistedUrls ?? [])) {
        issues.push(warning('url_not_whitelisted', `static URL ${url} is not in dlt.whitelistedUrls`, { path }));
      }
    }
  }
  return issues;
}

/** @param {string} dltBody @param {string} path @returns {Issue[]} */
function checkDltBody(dltBody, path) {
  /** @type {Issue[]} */
  const issues = [];
  const malformed = (dltBody.match(DLT_LIKE_TOKEN) ?? []).filter((t) => !new RegExp(`^${DLT_PLACEHOLDER.source}$`, 'i').test(t));
  for (const token of malformed) issues.push(issue('malformed_dlt_variable', `"${token}" is not a DLT variable; use {#var#}`, { path }));
  if (/\{#[a-z]+#\}\s*[.!]?\s*$/i.test(dltBody)) issues.push(warning('variable_at_end', 'DLT does not allow a variable as the last word of a template', { path }));
  return issues;
}

/**
 * DLT headers are 6 characters. Promotional headers are numeric; transactional and service
 * headers are alphabetic (some DLTs also accept alphanumeric).
 * @param {string} senderId @param {string} category
 * @returns {Issue | null}
 */
export function checkSenderId(senderId, category) {
  if (category === 'promotional') {
    return /^\d{6}$/.test(senderId) ? null : issue('invalid_sender', 'promotional headers are 6 digits');
  }
  return /^(?=.*[A-Za-z])[A-Za-z0-9]{6}$/.test(senderId) ? null : issue('invalid_sender', 'transactional/service headers are 6 letters (or letters and digits)');
}

/**
 * Render an MSG91 template body with variable values (used for URL scanning and length estimates).
 * @param {string} body @param {Record<string, string>} values
 */
export function renderTemplate(body, values) {
  return String(body).replace(MSG91_PLACEHOLDER, (whole, name) => (name in values ? values[name] : whole));
}

// ---------------------------------------------------------------------------------------------
// URLs and callback numbers (CTA whitelisting)
// ---------------------------------------------------------------------------------------------

/** URLs found in a text (http, https or www.), trailing punctuation removed. @param {string} text */
export function findUrls(text) {
  return [...String(text).matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,;:!)\]]+$/, ''));
}

/** @param {string} url */
function splitUrl(url) {
  const withoutScheme = url.replace(/^https?:\/\//i, '');
  const cut = withoutScheme.search(/[/?#]/);
  const host = (cut === -1 ? withoutScheme : withoutScheme.slice(0, cut)).toLowerCase();
  const rest = cut === -1 ? '' : withoutScheme.slice(cut);
  return { host, rest };
}

/** True for http://10.0.0.1/... style links, which DLT never whitelists. @param {string} url */
export function isIpUrl(url) {
  const { host } = splitUrl(url);
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || host.startsWith('[');
}

/**
 * Whether a URL is covered by the DLT CTA whitelist. Host comparison is case-insensitive and the
 * scheme is ignored; the path is case-sensitive. Entries ending in '?' (dynamic URLs) or '/'
 * match as prefixes; other entries (static URLs) must match exactly. Subdomains are distinct.
 * @param {string} url @param {string[]} whitelist
 */
export function isUrlWhitelisted(url, whitelist) {
  const target = splitUrl(url);
  return whitelist.some((entry) => {
    const allowed = splitUrl(entry);
    if (allowed.host !== target.host) return false;
    if (allowed.rest.endsWith('?') || allowed.rest.endsWith('/')) return target.rest.startsWith(allowed.rest) || `${target.rest}/` === allowed.rest;
    return target.rest === allowed.rest || (allowed.rest === '' && target.rest === '/');
  });
}

/** Last 10 digits, so +91 98765 43210 and 9876543210 compare equal. @param {string} n */
const tail10 = (n) => String(n).replace(/\D/g, '').slice(-10);

/** @param {string} value @param {string[]} whitelist */
export function isCallbackNumberWhitelisted(value, whitelist) {
  return whitelist.some((entry) => tail10(entry) === tail10(value) && tail10(value).length >= 6);
}

// ---------------------------------------------------------------------------------------------
// Variable values
// ---------------------------------------------------------------------------------------------

/**
 * Check one variable value against DLT rules.
 * @param {TemplateVariable} variable
 * @param {unknown} rawValue
 * @param {{ whitelistedUrls: string[], whitelistedCallbackNumbers: string[], shortUrl: boolean, path: string }} ctx
 * @returns {Issue[]}
 */
export function checkVariableValue(variable, rawValue, ctx) {
  const path = `${ctx.path}.${variable.name}`;
  if (rawValue === undefined || rawValue === null) return [issue('missing_variable', `variable "${variable.name}" is required`, { path })];
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return [issue('invalid_variable', `variable "${variable.name}" must be a string or number`, { path })];
  const value = String(rawValue);
  if (value.trim() === '') return [issue('empty_variable', `variable "${variable.name}" is empty`, { path })];
  if ([...value].length > variable.maxLength) {
    return [issue('variable_too_long', `variable "${variable.name}" is ${[...value].length} characters; DLT allows ${variable.maxLength}`, { path })];
  }
  if (CONTROL_CHARS.test(value)) return [issue('invalid_variable', `variable "${variable.name}" contains line breaks or control characters`, { path })];
  return checkTyped(variable, value, ctx, path);
}

/**
 * @param {TemplateVariable} variable @param {string} value
 * @param {{ whitelistedUrls: string[], whitelistedCallbackNumbers: string[], shortUrl: boolean }} ctx
 * @param {string} path @returns {Issue[]}
 */
function checkTyped(variable, value, ctx, path) {
  switch (variable.type) {
    case 'numeric':
      return /^\d+$/.test(value) ? [] : [issue('invalid_variable', `variable "${variable.name}" must be digits only`, { path })];
    case 'alphanumeric':
      return /^[A-Za-z0-9 ]+$/.test(value) ? [] : [issue('invalid_variable', `variable "${variable.name}" must be letters, digits and spaces only`, { path })];
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(value) ? [] : [issue('invalid_variable', `variable "${variable.name}" must be an email address`, { path })];
    case 'cbn':
      return isCallbackNumberWhitelisted(value, ctx.whitelistedCallbackNumbers)
        ? []
        : [issue('callback_not_whitelisted', `callback number in "${variable.name}" is not in dlt.whitelistedCallbackNumbers`, { path })];
    case 'url':
    case 'urlott': {
      const urls = findUrls(value);
      if (urls.length !== 1 || urls[0] !== value) return [issue('invalid_variable', `variable "${variable.name}" must be a single URL`, { path })];
      return [];
    }
    default:
      return [];
  }
}

/**
 * Every URL in the final text must be CTA-whitelisted (static parts and variables alike). With
 * MSG91's short URL feature every link is rewritten to https://m.9m.io/<HEADER>/..., so that
 * prefix must be whitelisted instead and the header must not be numeric.
 * @param {string[]} urls
 * @param {{ whitelistedUrls: string[], shortUrl: boolean, senderId?: string, path: string }} ctx
 * @returns {Issue[]}
 */
export function checkUrls(urls, ctx) {
  /** @type {Issue[]} */
  const issues = [];
  for (const url of urls) {
    if (isIpUrl(url)) issues.push(issue('ip_url_not_allowed', `IP-based URL ${url} cannot be whitelisted on DLT`, { path: ctx.path }));
    else if (!ctx.shortUrl && !isUrlWhitelisted(url, ctx.whitelistedUrls)) {
      issues.push(issue('url_not_whitelisted', `URL ${url} is not in dlt.whitelistedUrls (TRAI CTA whitelisting)`, { path: ctx.path }));
    }
  }
  if (ctx.shortUrl && urls.length > 0) issues.push(...checkShortUrl(ctx));
  return issues;
}

/** @param {{ whitelistedUrls: string[], senderId?: string, path: string }} ctx @returns {Issue[]} */
function checkShortUrl(ctx) {
  if (!ctx.senderId) return [warning('short_url_unverified', 'cannot check the short URL whitelist without a senderId', { path: ctx.path })];
  if (/^\d+$/.test(ctx.senderId)) return [issue('short_url_numeric_header', 'MSG91 short URLs are not allowed with numeric headers', { path: ctx.path })];
  const prefix = `${SHORT_URL_BASE}${ctx.senderId}/`;
  const covered = ctx.whitelistedUrls.some((entry) => entry === prefix || entry === prefix.slice(0, -1));
  return covered ? [] : [issue('url_not_whitelisted', `short URLs need ${prefix} in dlt.whitelistedUrls (header is case-sensitive)`, { path: ctx.path })];
}

// ---------------------------------------------------------------------------------------------
// Time: promotional window and schedules (IST)
// ---------------------------------------------------------------------------------------------

/** @param {string} hhmm */
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Promotional / service-explicit templates are only delivered inside the window. @param {string} category */
export const isWindowRestricted = (category) => PROMOTIONAL_CATEGORIES.has(category);

/**
 * Whether `at` falls inside the IST delivery window [start, end), and if not, the next opening.
 * @param {Date} at
 * @param {{ start: string, end: string }} window e.g. { start: '10:00', end: '21:00' }
 * @returns {{ allowed: boolean, nextAllowedAt: Date | null }}
 */
export function promotionalWindowStatus(at, window) {
  const istMs = at.getTime() + IST_OFFSET_MINUTES * 60000;
  const minuteOfDay = Math.floor((istMs % 86400000) / 60000);
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (minuteOfDay >= start && minuteOfDay < end) return { allowed: true, nextAllowedAt: null };
  const istMidnight = istMs - (istMs % 86400000);
  const dayOffset = minuteOfDay >= end ? 86400000 : 0;
  const nextIst = istMidnight + dayOffset + start * 60000;
  return { allowed: false, nextAllowedAt: new Date(nextIst - IST_OFFSET_MINUTES * 60000) };
}

/** MSG91 `schtime` format, in IST: 'YYYY-MM-DD HH:MM:SS'. @param {Date} date */
export function formatIst(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 19)}`;
}

/**
 * @param {Date} scheduleAt @param {Date} now
 * @returns {Issue[]}
 */
export function checkSchedule(scheduleAt, now) {
  if (Number.isNaN(scheduleAt.getTime())) return [issue('invalid_schedule', 'scheduleAt is not a valid date', { path: 'scheduleAt' })];
  if (scheduleAt.getTime() <= now.getTime()) return [issue('invalid_schedule', 'scheduleAt must be in the future', { path: 'scheduleAt' })];
  if (scheduleAt.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) {
    return [issue('invalid_schedule', 'MSG91 cannot schedule more than three weeks ahead', { path: 'scheduleAt' })];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// References and length
// ---------------------------------------------------------------------------------------------

/**
 * Turn a caller reference (e.g. a UUID message id) into an MSG91 CRQID: alphanumeric only, ≤ 52.
 * MSG91 echoes the CRQID in delivery webhooks, so store the returned value for correlation.
 * @param {string} reference
 * @returns {{ ok: true, value: string } | { ok: false, issue: Issue }}
 */
export function toCrqid(reference) {
  const value = String(reference ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (!value) return { ok: false, issue: issue('invalid_reference', 'reference must contain letters or digits', { path: 'reference' }) };
  if (value.length > CRQID_MAX_LENGTH) return { ok: false, issue: issue('invalid_reference', `reference is longer than ${CRQID_MAX_LENGTH} alphanumeric characters`, { path: 'reference' }) };
  return { ok: true, value };
}

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f';

/**
 * Estimate SMS encoding and parts (GSM-7: 160 / 153 per part, UCS-2: 70 / 67 per part).
 * MSG91 bills per part; webhooks report the actual count as `smsLength`.
 * @param {string} text
 * @returns {{ encoding: 'gsm7' | 'unicode', units: number, segments: number }}
 */
export function estimateSegments(text) {
  let units = 0;
  let gsm = true;
  for (const ch of String(text)) {
    if (GSM7_BASIC.includes(ch)) units += 1;
    else if (GSM7_EXTENDED.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    const codeUnits = String(text).length;
    return { encoding: 'unicode', units: codeUnits, segments: codeUnits <= 70 ? 1 : Math.ceil(codeUnits / 67) };
  }
  return { encoding: 'gsm7', units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}
