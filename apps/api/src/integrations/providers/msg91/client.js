import { createHash } from 'node:crypto';
import { parseMsg91Config, templateSchema } from './config.js';
import {
  checkSchedule,
  checkSenderId,
  checkTemplateDefinition,
  checkUrls,
  checkVariableValue,
  estimateSegments,
  findUrls,
  formatIst,
  isWindowRestricted,
  maskMobile,
  normalizeMobile,
  promotionalWindowStatus,
  renderTemplate,
  templateVariables,
  toCrqid,
} from './dlt.js';
import { Msg91ConfigError, Msg91Error, Msg91ValidationError, classifyProviderError, redact } from './errors.js';
import { createTransport } from './http.js';
import { parseWebhook, verifyWebhook } from './webhook.js';

/** @typedef {import('./config.js').Msg91Config} Msg91Config */
/** @typedef {import('./config.js').Msg91Template} Msg91Template */
/** @typedef {import('./errors.js').Issue} Issue */
/** @typedef {import('./http.js').Logger} Logger */

/**
 * @typedef {{
 *   template: string | Msg91Template,
 *   to?: string | string[],
 *   variables?: Record<string, string | number>,
 *   reference?: string,
 *   recipients?: Array<{ to: string, variables?: Record<string, string | number>, reference?: string }>,
 *   shortUrl?: boolean,
 *   shortUrlExpirySeconds?: number,
 *   scheduleAt?: Date | string,
 *   realTimeResponse?: boolean,
 *   signal?: AbortSignal,
 * }} SendTemplateInput
 *
 * @typedef {{
 *   provider: 'msg91', requestId: string, status: 'accepted' | 'scheduled', dryRun: boolean,
 *   scheduledFor: string | null, templateId: string, dltTemplateId: string,
 *   recipients: Array<{ to: string, reference: string | null, providerMessageId: string }>,
 *   estimate: { encoding: 'gsm7' | 'unicode', units: number, segments: number } | null,
 *   warnings: Issue[],
 * }} SendTemplateResult
 */

const RESERVED_KEYS = new Set(['mobiles', 'CRQID', 'UUID', 'clientId', 'template_id', 'flow_id', 'sender']);

/**
 * Create an MSG91 client for one account.
 *
 * @param {unknown} config raw config, validated with zod (see config.js)
 * @param {{ fetch?: typeof fetch, now?: () => Date, logger?: Logger,
 *   sleep?: (ms: number) => Promise<void>, random?: () => number }} [deps]
 */
export function createMsg91Client(config, deps = {}) {
  const cfg = parseMsg91Config(config);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Msg91ConfigError('No fetch implementation available', []);
  const now = () => toDate(deps.now ? deps.now() : new Date());
  const logger = deps.logger;
  const secrets = [cfg.authKey, cfg.webhook.secret].filter(Boolean);
  checkTemplates(cfg, logger);

  const transport = createTransport({
    baseUrl: cfg.baseUrl,
    authKey: cfg.authKey,
    ...cfg.http,
    fetch: fetchImpl,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: deps.random ?? Math.random,
    now,
    logger,
    secrets,
  });

  const ctx = { cfg, now, logger, transport, secrets };

  return {
    provider: /** @type {const} */ ('msg91'),
    mode: cfg.mode,
    /** Validate a template send without calling MSG91. Never throws for validation problems. */
    validateTemplateSend: (/** @type {SendTemplateInput} */ input) => validateTemplateSend(ctx, input),
    /** Send a DLT template SMS (MSG91 Flow API). @returns {Promise<SendTemplateResult>} */
    sendTemplate: (/** @type {SendTemplateInput} */ input) => sendTemplate(ctx, input),
    sendOtp: (input) => sendOtp(ctx, input),
    verifyOtp: (input) => verifyOtp(ctx, input),
    resendOtp: (input) => resendOtp(ctx, input),
    getDeliveryLogs: (input) => getDeliveryLogs(ctx, input),
    listTemplates: (input = {}) => listTemplates(ctx, input),
    getTemplateVersions: (input) => getTemplateVersions(ctx, input),
    /** Cheap authenticated call for "test connection" buttons. */
    checkCredentials: async (input = {}) => {
      await listTemplates(ctx, input);
      return { ok: true };
    },
    /** verifyWebhook() bound to this connection's webhook settings. */
    verifyWebhook: (rawBody, headers, options = {}) =>
      verifyWebhook(rawBody, headers, options.secret ?? cfg.webhook.secret ?? '', {
        headerName: cfg.webhook.headerName,
        queryParam: cfg.webhook.queryParam,
        ...options,
      }),
    /** parseWebhook() with this connection's currency. */
    parseWebhook: (body) => parseWebhook(body, { currency: cfg.currency }),
    /** Registered template keys (for admin screens). */
    templateKeys: () => Object.keys(cfg.templates),
  };
}

/** @param {Date | number | string} value */
function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError('now() returned an invalid date');
  return d;
}

/** Template definitions with errors make the config invalid; warnings are logged. */
function checkTemplates(cfg, logger) {
  const issues = Object.entries(cfg.templates).flatMap(([key, template]) =>
    checkTemplateDefinition(key, template, { senderId: cfg.senderId, whitelistedUrls: cfg.dlt.whitelistedUrls }),
  );
  if (!cfg.dlt.enforce) return;
  const errors = issues.filter((i) => i.severity !== 'warning');
  if (errors.length > 0) {
    throw new Msg91ConfigError(`Invalid MSG91 templates: ${errors.map((i) => `${i.path}: ${i.message}`).join('; ')}`, errors.map((i) => ({ path: i.path ?? '', message: i.message })));
  }
  for (const w of issues) logger?.warn?.({ provider: 'msg91', issue: w }, `msg91 template warning: ${w.message}`);
}

// ---------------------------------------------------------------------------------------------
// Template SMS
// ---------------------------------------------------------------------------------------------

/**
 * @param {{ cfg: Msg91Config, now: () => Date }} ctx @param {SendTemplateInput} input
 * @returns {{ ok: true, payload: Record<string, unknown>, plan: Plan, warnings: Issue[] } | { ok: false, issues: Issue[], warnings: Issue[] }}
 */
function validateTemplateSend(ctx, rawInput) {
  const input = rawInput ?? /** @type {SendTemplateInput} */ ({ template: '' });
  const issues = [];
  const template = resolveTemplate(ctx.cfg, input.template, issues);
  if (!template) return { ok: false, issues, warnings: [] };
  const recipients = resolveRecipients(ctx.cfg, input, issues);
  const scheduleAt = resolveSchedule(ctx, input, template, issues);
  const senderId = template.senderId ?? ctx.cfg.senderId;
  if (senderId) pushIssue(issues, checkSenderId(senderId, template.category), 'senderId');
  if (input.shortUrlExpirySeconds !== undefined) checkShortUrlExpiry(input, issues);
  const preview = checkContent(ctx.cfg, template, recipients, { shortUrl: Boolean(input.shortUrl), senderId }, issues);
  const errors = issues.filter((i) => i.severity !== 'warning');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const enforced = ctx.cfg.dlt.enforce ? errors : errors.filter((i) => !DLT_ONLY_CODES.has(i.code));
  if (enforced.length > 0) return { ok: false, issues: enforced, warnings };
  /** @type {Plan} */
  const plan = { template, recipients, scheduleAt, senderId, estimate: preview ? estimateSegments(preview) : null };
  return { ok: true, payload: buildFlowPayload(plan, input), plan, warnings };
}

/** Issues that only matter for Indian DLT traffic (skipped when dlt.enforce is false). */
const DLT_ONLY_CODES = new Set([
  'variable_too_long',
  'invalid_variable',
  'url_not_whitelisted',
  'callback_not_whitelisted',
  'ip_url_not_allowed',
  'short_url_numeric_header',
  'outside_promotional_window',
  'invalid_sender',
  'unknown_variable',
]);

/**
 * @typedef {{ template: Msg91Template, recipients: Array<{ to: string, variables: Record<string, string>, crqid: string | null }>,
 *   scheduleAt: Date | null, senderId: string | undefined, estimate: ReturnType<typeof estimateSegments> | null }} Plan
 */

/** @param {Issue[]} issues @param {Issue | null} found @param {string} path */
function pushIssue(issues, found, path) {
  if (found) issues.push({ ...found, path });
}

/** @param {Msg91Config} cfg @param {unknown} ref @param {Issue[]} issues @returns {Msg91Template | null} */
function resolveTemplate(cfg, ref, issues) {
  if (typeof ref === 'string') {
    const found = Object.hasOwn(cfg.templates, ref) ? cfg.templates[ref] : undefined;
    if (!found) issues.push({ code: 'unknown_template', message: `template "${ref}" is not registered`, path: 'template', severity: 'error' });
    return found ?? null;
  }
  const parsed = templateSchema.safeParse(ref);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push({ code: 'invalid_template', message: i.message, path: ['template', ...i.path].join('.'), severity: 'error' });
    return null;
  }
  for (const i of checkTemplateDefinition('inline', parsed.data, { senderId: cfg.senderId, whitelistedUrls: cfg.dlt.whitelistedUrls })) issues.push(i);
  return parsed.data;
}

/**
 * @param {Msg91Config} cfg @param {SendTemplateInput} input @param {Issue[]} issues
 * @returns {Plan['recipients']}
 */
function resolveRecipients(cfg, input, issues) {
  const hasTo = input.to !== undefined;
  const hasList = input.recipients !== undefined;
  if (hasTo === hasList) {
    issues.push({ code: 'invalid_recipients', message: 'pass exactly one of `to` or `recipients`', path: 'to', severity: 'error' });
    return [];
  }
  const raw = hasTo
    ? (Array.isArray(input.to) ? input.to : [input.to]).map((to) => ({ to, variables: {}, reference: input.reference }))
    : input.recipients ?? [];
  if (raw.length === 0) issues.push({ code: 'invalid_recipients', message: 'at least one recipient is required', path: 'to', severity: 'error' });
  if (raw.length > cfg.maxRecipientsPerRequest) {
    issues.push({ code: 'too_many_recipients', message: `at most ${cfg.maxRecipientsPerRequest} recipients per request`, path: 'recipients', severity: 'error' });
    return [];
  }
  const seen = new Set();
  return raw.map((r, index) => resolveRecipient(cfg, input, r, index, seen, issues));
}

function resolveRecipient(cfg, input, r, index, seen, issues) {
  const path = input.recipients ? `recipients.${index}` : 'to';
  const mobile = normalizeMobile(r?.to, cfg);
  if (!mobile.ok) issues.push({ ...mobile.issue, path: `${path}.to` });
  const to = mobile.ok ? mobile.value : String(r?.to ?? '');
  if (mobile.ok && seen.has(to)) {
    issues.push({ code: 'duplicate_recipient', message: `${maskMobile(to)} appears twice (MSG91 rejects identical SMS within 10 s)`, path, severity: 'error' });
  }
  seen.add(to);
  let crqid = null;
  const reference = r?.reference ?? (input.recipients ? undefined : input.reference);
  if (reference !== undefined) {
    const c = toCrqid(reference);
    if (c.ok) crqid = c.value;
    else issues.push({ ...c.issue, path: `${path}.reference` });
  }
  return { to, variables: stringifyValues({ ...(input.variables ?? {}), ...(r?.variables ?? {}) }), crqid };
}

/** @param {Record<string, unknown>} values @returns {Record<string, any>} */
function stringifyValues(values) {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
}

/**
 * Explicit schedules are checked; promotional sends outside the IST window are rejected or, with
 * dlt.outsideWindow = 'schedule', moved to the next window opening.
 * @returns {Date | null}
 */
function resolveSchedule(ctx, input, template, issues) {
  const now = ctx.now();
  let scheduleAt = null;
  if (input.scheduleAt !== undefined) {
    scheduleAt = input.scheduleAt instanceof Date ? input.scheduleAt : new Date(String(input.scheduleAt));
    issues.push(...checkSchedule(scheduleAt, now));
    if (Number.isNaN(scheduleAt.getTime())) return null;
  }
  if (!isWindowRestricted(template.category)) return scheduleAt;
  const window = ctx.cfg.dlt.promotionalWindow;
  const status = promotionalWindowStatus(scheduleAt ?? now, window);
  if (status.allowed || !status.nextAllowedAt) return scheduleAt;
  if (ctx.cfg.dlt.outsideWindow === 'schedule' && !scheduleAt) return status.nextAllowedAt;
  issues.push({
    code: 'outside_promotional_window',
    message: `${template.category} SMS can only be sent ${window.start}–${window.end} IST`,
    path: 'scheduleAt',
    severity: 'error',
    nextAllowedAt: status.nextAllowedAt.toISOString(),
  });
  return scheduleAt;
}

/** @param {SendTemplateInput} input @param {Issue[]} issues */
function checkShortUrlExpiry(input, issues) {
  const s = input.shortUrlExpirySeconds;
  if (!input.shortUrl) issues.push({ code: 'invalid_request', message: 'shortUrlExpirySeconds needs shortUrl: true', path: 'shortUrlExpirySeconds', severity: 'error' });
  else if (!Number.isInteger(s) || /** @type {number} */ (s) < 60) {
    issues.push({ code: 'invalid_request', message: 'shortUrlExpirySeconds must be an integer ≥ 60', path: 'shortUrlExpirySeconds', severity: 'error' });
  }
}

/**
 * Variable and CTA checks for every recipient. Returns the first rendered text (for length
 * estimates) when the template body is known.
 * @returns {string | null}
 */
function checkContent(cfg, template, recipients, opts, issues) {
  const variables = templateVariables(template, cfg.dlt.maxVariableLength);
  const known = template.body !== undefined || template.variables !== undefined;
  const names = new Set(variables.map((v) => v.name));
  if (!known) issues.push({ code: 'template_unverified', message: 'template has no body or variables; variable values are not checked', path: 'template', severity: 'warning' });
  let preview = null;
  recipients.forEach((r, index) => {
    const path = recipients.length > 1 ? `recipients.${index}.variables` : 'variables';
    for (const key of Object.keys(r.variables)) {
      if (RESERVED_KEYS.has(key)) issues.push({ code: 'invalid_variable', message: `"${key}" is a reserved MSG91 field`, path: `${path}.${key}`, severity: 'error' });
      else if (known && !names.has(key)) issues.push({ code: 'unknown_variable', message: `template has no variable "${key}"`, path: `${path}.${key}`, severity: 'error' });
    }
    for (const v of variables) issues.push(...checkVariableValue(v, r.variables[v.name], { ...cfg.dlt, shortUrl: opts.shortUrl, path }));
    const text = template.body ? renderTemplate(template.body, r.variables) : null;
    const urls = text ? findUrls(text) : Object.values(r.variables).flatMap((value) => findUrls(String(value ?? '')));
    issues.push(...checkUrls([...new Set(urls)], { whitelistedUrls: cfg.dlt.whitelistedUrls, shortUrl: opts.shortUrl, senderId: opts.senderId, path }));
    preview ??= text;
  });
  return dedupeIssues(issues, preview);
}

/** Collapse repeated issues (same code + path + message) in place; pass through `value`. */
function dedupeIssues(issues, value) {
  const seen = new Set();
  const unique = issues.filter((i) => {
    const key = `${i.code}|${i.path}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  issues.splice(0, issues.length, ...unique);
  return value;
}

/** MSG91 Flow API body. @param {Plan} plan @param {SendTemplateInput} input */
function buildFlowPayload(plan, input) {
  /** @type {Record<string, unknown>} */
  const payload = { template_id: plan.template.templateId };
  if (plan.senderId) payload.sender = plan.senderId;
  if (input.shortUrl !== undefined) payload.short_url = input.shortUrl ? '1' : '0';
  if (input.shortUrl && input.shortUrlExpirySeconds !== undefined) payload.short_url_expiry = String(input.shortUrlExpirySeconds);
  if (input.realTimeResponse) payload.realTimeResponse = '1';
  if (plan.scheduleAt) payload.schtime = formatIst(plan.scheduleAt);
  payload.recipients = plan.recipients.map((r) => ({ mobiles: r.to, ...r.variables, ...(r.crqid ? { CRQID: r.crqid } : {}) }));
  return payload;
}

/** @returns {Promise<SendTemplateResult>} */
async function sendTemplate(ctx, input) {
  const checked = validateTemplateSend(ctx, input);
  if (!checked.ok) throw new Msg91ValidationError(`MSG91 template send rejected: ${checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, checked.issues);
  const { plan, payload } = checked;
  let requestId;
  if (ctx.cfg.mode === 'dry_run') {
    requestId = dryRunId(payload);
    ctx.logger?.info?.({ provider: 'msg91', operation: 'sendTemplate', dryRun: true, template: plan.template.templateId, recipients: plan.recipients.map((r) => maskMobile(r.to)) }, 'msg91 dry run: SMS not sent');
  } else {
    const res = await ctx.transport.request({ method: 'POST', path: '/api/v5/flow', body: payload, idempotent: false, operation: 'sendTemplate', signal: input.signal });
    requestId = expectSuccess(ctx, res, 'sendTemplate', (body) => body?.message ?? body?.request_id ?? body?.data?.message);
  }
  return {
    provider: 'msg91',
    requestId,
    status: plan.scheduleAt ? 'scheduled' : 'accepted',
    dryRun: ctx.cfg.mode === 'dry_run',
    scheduledFor: plan.scheduleAt ? plan.scheduleAt.toISOString() : null,
    templateId: plan.template.templateId,
    dltTemplateId: plan.template.dltTemplateId,
    recipients: plan.recipients.map((r) => ({ to: r.to, reference: r.crqid, providerMessageId: `${requestId}:${r.to}` })),
    estimate: plan.estimate,
    warnings: checked.warnings,
  };
}

/** @param {unknown} payload */
function dryRunId(payload) {
  return `dryrun_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24)}`;
}

/**
 * Return the success value of an MSG91 response or throw a typed error. MSG91 often answers
 * HTTP 200 with `type: "error"`, so the body decides, not the status.
 * @param {{ secrets: string[] }} ctx @param {import('./http.js').TransportResponse} res @param {string} operation
 * @param {(body: any) => unknown} pick
 */
function expectSuccess(ctx, res, operation, pick) {
  const body = res.body;
  const ok = res.status >= 200 && res.status < 300 && body && (body.type === 'success' || body.status === 'success' || body.msg_type === 'Success' || body.msg_type === 'success') && !body.hasError;
  const value = ok ? pick(body) : undefined;
  if (ok && value !== undefined && value !== null && value !== '') return String(value);
  throw providerError(ctx, res, operation, ok ? 'success response without an id' : undefined);
}

/**
 * Typed error from an MSG91 error response. An explicit error response means MSG91 did not
 * accept the request, so `delivery` is 'not_sent'.
 * @param {{ secrets: string[] }} ctx @param {import('./http.js').TransportResponse} res @param {string} operation @param {string} [override]
 */
export function providerError(ctx, res, operation, override) {
  const body = res.body ?? {};
  const rawMessage = override ?? firstString(body.message, body.errors, body.error, body.msg, res.text) ?? `HTTP ${res.status}`;
  const message = redact(rawMessage, ctx.secrets).slice(0, 300);
  const providerCode = extractCode(body, message);
  const authFailure = res.status === 401 || res.status === 403;
  const { code, retryable } = authFailure ? { code: 'auth_failed', retryable: false } : classifyProviderError({ providerCode, message, status: res.status >= 400 ? res.status : undefined });
  return new Msg91Error(`MSG91 ${operation} failed: ${message}`, {
    code: override ? 'unexpected_response' : code,
    retryable: override ? false : retryable,
    status: res.status,
    providerCode,
    delivery: 'not_sent',
  });
}

/** @param  {...unknown} values */
function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) return v.map(String).join('; ');
  }
  return undefined;
}

/** @param {Record<string, any>} body @param {string} message */
function extractCode(body, message) {
  const explicit = body.code ?? body.errorCode ?? body.error_code;
  if (explicit !== undefined && explicit !== null && /^\d{3}$/.test(String(explicit))) return String(explicit);
  const m = message.match(/^\s*(\d{3})\b/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------------------------

/** @param {Issue[]} issues @param {string} operation */
function throwIfIssues(issues, operation) {
  if (issues.length > 0) throw new Msg91ValidationError(`MSG91 ${operation} rejected: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, issues);
}

function mobileOrIssue(cfg, to, issues) {
  const mobile = normalizeMobile(to, cfg);
  if (!mobile.ok) issues.push({ ...mobile.issue, path: 'to' });
  return mobile.ok ? mobile.value : '';
}

/**
 * Generate and send an OTP with an MSG91 OTP template (POST /api/v5/otp).
 * MSG91 stores the code and its expiry; check it with verifyOtp().
 * @param {*} ctx
 * @param {{ to: string, templateId?: string, otp?: string, length?: number, expiryMinutes?: number,
 *   variables?: Record<string, string | number>, unicode?: boolean, realTimeResponse?: boolean, signal?: AbortSignal }} input
 * @returns {Promise<{ provider: 'msg91', requestId: string, to: string, dryRun: boolean }>}
 */
async function sendOtp(ctx, input) {
  const { cfg } = ctx;
  const issues = [];
  const to = mobileOrIssue(cfg, input?.to, issues);
  const templateId = input?.templateId ?? cfg.otp.templateId;
  if (!templateId) issues.push({ code: 'missing_template', message: 'no OTP templateId (set config.otp.templateId)', path: 'templateId', severity: 'error' });
  if (input?.otp !== undefined && !/^\d{4,9}$/.test(String(input.otp))) issues.push({ code: 'invalid_otp', message: 'otp must be 4–9 digits', path: 'otp', severity: 'error' });
  const length = input?.length ?? cfg.otp.length;
  if (length !== undefined && !(Number.isInteger(length) && length >= 4 && length <= 9)) issues.push({ code: 'invalid_otp', message: 'length must be 4–9', path: 'length', severity: 'error' });
  const expiry = input?.expiryMinutes ?? cfg.otp.expiryMinutes;
  if (expiry !== undefined && !(Number.isInteger(expiry) && expiry >= 1 && expiry <= 10080)) issues.push({ code: 'invalid_otp', message: 'expiryMinutes must be 1–10080', path: 'expiryMinutes', severity: 'error' });
  const variables = stringifyValues(input?.variables ?? {});
  for (const [name, value] of Object.entries(variables)) issues.push(...checkVariableValue({ name, type: 'text', maxLength: cfg.dlt.maxVariableLength }, value, { ...cfg.dlt, shortUrl: false, path: 'variables' }));
  throwIfIssues(issues, 'sendOtp');
  if (cfg.mode === 'dry_run') return { provider: 'msg91', requestId: dryRunId({ to, templateId, t: ctx.now().getTime() }), to, dryRun: true };
  const query = {
    template_id: templateId,
    mobile: to,
    otp: input.otp,
    otp_length: input.otp === undefined ? length : undefined,
    otp_expiry: expiry,
    unicode: input.unicode ? 1 : undefined,
    realTimeResponse: input.realTimeResponse ? 1 : undefined,
  };
  const res = await ctx.transport.request({ method: 'POST', path: '/api/v5/otp', query, body: variables, idempotent: false, operation: 'sendOtp', signal: input.signal });
  const requestId = expectSuccess(ctx, res, 'sendOtp', (body) => body.request_id ?? body.message);
  return { provider: 'msg91', requestId, to, dryRun: false };
}

/** Verify-OTP messages (msg91 docs + observed variants) → reason. First match wins. */
const VERIFY_REASONS = [
  [/already\s*verified/i, 'already_verified'],
  [/expired/i, 'expired'],
  [/not\s*match|invalid\s*otp|incorrect|wrong/i, 'mismatch'],
  [/max|limit|attempt/i, 'too_many_attempts'],
  [/mobile|number/i, 'invalid_mobile'],
  [/not\s*found|no\s*otp|request|generate/i, 'not_found'],
];

/**
 * Check a user-entered OTP (GET /api/v5/otp/verify). Wrong/expired codes are a normal outcome,
 * not an exception: MSG91 answers HTTP 200 with `type: "error"` for them.
 * @param {*} ctx
 * @param {{ to: string, otp: string, signal?: AbortSignal }} input
 * @returns {Promise<{ verified: boolean, reason: string, message: string | null }>}
 */
async function verifyOtp(ctx, input) {
  const { cfg } = ctx;
  const issues = [];
  const to = mobileOrIssue(cfg, input?.to, issues);
  const otp = String(input?.otp ?? '').trim();
  if (!/^\d{4,9}$/.test(otp)) issues.push({ code: 'invalid_otp', message: 'otp must be 4–9 digits', path: 'otp', severity: 'error' });
  throwIfIssues(issues, 'verifyOtp');
  if (cfg.mode === 'dry_run') {
    const verified = Boolean(cfg.dryRunOtp) && otp === cfg.dryRunOtp;
    return { verified, reason: verified ? 'verified' : 'dry_run', message: null };
  }
  const res = await ctx.transport.request({ method: 'GET', path: '/api/v5/otp/verify', query: { otp, mobile: to }, idempotent: false, operation: 'verifyOtp', signal: input.signal });
  const body = res.body;
  if (res.status === 200 && body?.type === 'success') return { verified: true, reason: 'verified', message: String(body.message ?? '') || null };
  if (res.status === 200 && body?.type === 'error') {
    const message = redact(String(body.message ?? ''), ctx.secrets);
    const match = VERIFY_REASONS.find(([pattern]) => /** @type {RegExp} */ (pattern).test(message));
    return { verified: false, reason: match ? /** @type {string} */ (match[1]) : 'rejected', message: message || null };
  }
  throw providerError(ctx, res, 'verifyOtp');
}

/**
 * Resend the same OTP by SMS ('text') or voice call (GET /api/v5/otp/retry). MSG91 allows a
 * limited number of retries per OTP; hitting it is returned as `{ sent: false, reason: 'retry_limit' }`.
 * @param {*} ctx
 * @param {{ to: string, channel?: 'text' | 'voice', signal?: AbortSignal }} input
 * @returns {Promise<{ sent: boolean, reason: string, message: string | null }>}
 */
async function resendOtp(ctx, input) {
  const { cfg } = ctx;
  const issues = [];
  const to = mobileOrIssue(cfg, input?.to, issues);
  const channel = input?.channel ?? 'text';
  if (channel !== 'text' && channel !== 'voice') issues.push({ code: 'invalid_request', message: "channel is 'text' or 'voice'", path: 'channel', severity: 'error' });
  throwIfIssues(issues, 'resendOtp');
  if (cfg.mode === 'dry_run') return { sent: true, reason: 'dry_run', message: null };
  const res = await ctx.transport.request({ method: 'GET', path: '/api/v5/otp/retry', query: { mobile: to, retrytype: channel }, idempotent: false, operation: 'resendOtp', signal: input.signal });
  const body = res.body;
  if (res.status === 200 && body?.type === 'success') return { sent: true, reason: 'sent', message: String(body.message ?? '') || null };
  if (res.status === 200 && body?.type === 'error') {
    const message = redact(String(body.message ?? ''), ctx.secrets);
    if (/max|limit/i.test(message)) return { sent: false, reason: 'retry_limit', message };
    if (/verified/i.test(message)) return { sent: false, reason: 'already_verified', message };
    if (/expired|no\s*otp|not\s*found|request/i.test(message)) return { sent: false, reason: 'no_active_otp', message };
  }
  throw providerError(ctx, res, 'resendOtp');
}

// ---------------------------------------------------------------------------------------------
// Reads (idempotent, retried)
// ---------------------------------------------------------------------------------------------

/** @param {Date | string} value */
function toIstDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : formatIst(d).slice(0, 10);
}

/**
 * SMS delivery logs (POST /api/v5/report/logs/p/sms). MSG91 allows a window of at most 3 days
 * starting within the last 3 days; dates are IST calendar dates (YYYY-MM-DD).
 * @param {*} ctx
 * @param {{ startDate: Date | string, endDate: Date | string, requestId?: string, signal?: AbortSignal }} input
 */
async function getDeliveryLogs(ctx, input) {
  const issues = [];
  const startDate = toIstDate(input?.startDate);
  const endDate = toIstDate(input?.endDate);
  if (!startDate) issues.push({ code: 'invalid_request', message: 'startDate must be a date', path: 'startDate', severity: 'error' });
  if (!endDate) issues.push({ code: 'invalid_request', message: 'endDate must be a date', path: 'endDate', severity: 'error' });
  if (startDate && endDate) {
    const span = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
    const age = (Date.parse(toIstDate(ctx.now())) - Date.parse(startDate)) / 86400000;
    if (span < 0 || span > 3) issues.push({ code: 'invalid_request', message: 'MSG91 log window is at most 3 days', path: 'endDate', severity: 'error' });
    if (age > 3) issues.push({ code: 'invalid_request', message: 'startDate must be within the last 3 days', path: 'startDate', severity: 'error' });
  }
  throwIfIssues(issues, 'getDeliveryLogs');
  const res = await ctx.transport.request({
    method: 'POST',
    path: '/api/v5/report/logs/p/sms',
    query: { startDate, endDate, requestId: input.requestId },
    idempotent: true,
    operation: 'getDeliveryLogs',
    signal: input.signal,
  });
  if (res.status !== 200 || res.body === null || typeof res.body !== 'object' || (res.body.error && !res.body.data)) throw providerError(ctx, res, 'getDeliveryLogs');
  return { rows: Array.isArray(res.body.data) ? res.body.data : Array.isArray(res.body) ? res.body : [], raw: res.body };
}

/**
 * Templates (flows) on the account (GET /api/v5/flows).
 * @returns {Promise<Array<{ templateId: string, name: string }>>}
 */
async function listTemplates(ctx, input) {
  const res = await ctx.transport.request({ method: 'GET', path: '/api/v5/flows', idempotent: true, operation: 'listTemplates', signal: input?.signal });
  if (res.status !== 200 || !Array.isArray(res.body?.data)) throw providerError(ctx, res, 'listTemplates');
  return res.body.data.map((f) => ({ templateId: String(f.flow_id ?? f.id ?? ''), name: String(f.flow_name ?? f.name ?? '') }));
}

/**
 * Versions of one MSG91 template, including its DLT id and approval state
 * (POST /api/v5/sms/getTemplateVersions — a read, so it is retried).
 * @param {*} ctx @param {{ templateId: string, signal?: AbortSignal }} input
 */
async function getTemplateVersions(ctx, input) {
  if (!input?.templateId || !/^[A-Za-z0-9]{6,40}$/.test(input.templateId)) {
    throw new Msg91ValidationError('MSG91 getTemplateVersions rejected: templateId is required', [{ code: 'invalid_request', message: 'templateId is required', path: 'templateId', severity: 'error' }]);
  }
  const res = await ctx.transport.request({ method: 'POST', path: '/api/v5/sms/getTemplateVersions', body: { template_id: input.templateId }, idempotent: true, operation: 'getTemplateVersions', signal: input.signal });
  if (res.status !== 200 || res.body?.hasError || res.body?.status === 'error' || !Array.isArray(res.body?.data)) throw providerError(ctx, res, 'getTemplateVersions');
  return res.body.data;
}
