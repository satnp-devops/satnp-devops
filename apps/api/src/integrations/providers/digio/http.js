import { randomBytes } from 'node:crypto';
import { DigioError, mapHttpError, redact } from './errors.js';

/**
 * Minimal HTTP layer: Basic auth, per-attempt timeouts, retries with exponential backoff and
 * full jitter for calls marked `retry: true`, Retry-After support, and error mapping. It never
 * logs headers or bodies.
 */

/**
 * @typedef {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} Logger
 * @typedef {{
 *   fetch: typeof fetch, logger: Logger, sleep: (ms: number) => Promise<void>, random: () => number,
 *   baseUrl: string, authorization: string, secrets: readonly string[], timeoutMs: number,
 *   maxRetries: number, retryBaseDelayMs: number, retryMaxDelayMs: number }} HttpContext
 * @typedef {{
 *   method: 'GET' | 'POST', path: string, op: string, query?: Record<string, string>,
 *   json?: unknown, body?: Uint8Array, contentType?: string, accept?: string,
 *   expect: 'json' | 'binary', retry: boolean, signal?: AbortSignal }} HttpRequest
 */

/**
 * @param {HttpContext} ctx
 * @param {HttpRequest} req
 * @returns {Promise<{ status: number, headers: Headers, json?: any, bytes?: Uint8Array }>}
 */
export async function request(ctx, req) {
  const url = buildUrl(ctx.baseUrl, req.path, req.query);
  const headers = {
    Authorization: ctx.authorization,
    Accept: req.accept ?? (req.expect === 'json' ? 'application/json' : 'application/pdf, application/octet-stream, */*'),
  };
  let body;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.json);
  } else if (req.body) {
    headers['Content-Type'] = req.contentType ?? 'application/octet-stream';
    body = req.body;
  }

  const attempts = req.retry ? ctx.maxRetries + 1 : 1;
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    try {
      const result = await once(ctx, req, url, { method: req.method, headers, body });
      log(ctx.logger, 'debug', { op: req.op, method: req.method, path: req.path, status: result.status, attempt, ms: Date.now() - started });
      return result;
    } catch (error) {
      const err = toDigioError(error, req, ctx.secrets);
      const willRetry = err.retryable && attempt < attempts;
      log(ctx.logger, willRetry ? 'warn' : 'error', {
        op: req.op, method: req.method, path: req.path, status: err.status, code: err.code,
        providerCode: err.providerCode, attempt, retrying: willRetry, ms: Date.now() - started,
      });
      if (!willRetry) throw err;
      await ctx.sleep(backoffMs(ctx, attempt, err));
    }
  }
}

/**
 * @param {HttpContext} ctx
 * @param {HttpRequest} req
 * @param {string} url
 * @param {RequestInit} init
 */
async function once(ctx, req, url, init) {
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  // Downloads may be served via a redirect; API calls never are.
  const redirect = req.expect === 'binary' ? 'follow' : 'error';
  const response = await ctx.fetch(url, { ...init, signal, redirect });
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    const text = await safeText(response);
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw mapHttpError({
      status: response.status,
      body: parsed,
      method: req.method,
      path: req.path,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      secrets: ctx.secrets,
    });
  }

  if (req.expect === 'binary') {
    if (contentType.includes('application/json')) {
      // Some gateways answer 200 with a JSON error; never hand that out as a PDF.
      const parsed = JSON.parse((await safeText(response)) || '{}');
      throw mapHttpError({ status: 400, body: parsed, method: req.method, path: req.path, secrets: ctx.secrets });
    }
    return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  const text = await response.text();
  try {
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  } catch (cause) {
    throw new DigioError('invalid_response', `Digio ${req.method} ${req.path} returned non-JSON (HTTP ${response.status})`, {
      status: response.status,
      cause,
    });
  }
}

/**
 * @param {unknown} error
 * @param {HttpRequest} req
 * @param {readonly string[]} secrets
 */
function toDigioError(error, req, secrets) {
  if (error instanceof DigioError) return error;
  const name = /** @type {{ name?: string }} */ (error)?.name;
  const where = `Digio ${req.method} ${req.path}`;
  if (req.signal?.aborted) return new DigioError('aborted', `${where} was cancelled by the caller`);
  if (name === 'TimeoutError') return new DigioError('timeout', `${where} timed out`, { retryable: true });
  if (name === 'AbortError') return new DigioError('timeout', `${where} timed out`, { retryable: true });
  if (error instanceof SyntaxError) return new DigioError('invalid_response', `${where} returned malformed JSON`);
  const message = redact(String(/** @type {Error} */ (error)?.message ?? error), secrets);
  return new DigioError('network', `${where} failed: ${message}`, { retryable: true });
}

/**
 * Exponential backoff with full jitter; honours Retry-After when Digio sends one.
 * @param {HttpContext} ctx
 * @param {number} attempt 1-based attempt that just failed
 * @param {DigioError} err
 */
function backoffMs(ctx, attempt, err) {
  const hinted = /** @type {{ retryAfterMs?: number | null }} */ (err.details ?? {}).retryAfterMs;
  if (typeof hinted === 'number' && hinted >= 0) return Math.min(hinted, ctx.retryMaxDelayMs);
  const cap = Math.min(ctx.retryMaxDelayMs, ctx.retryBaseDelayMs * 2 ** (attempt - 1));
  return Math.round(ctx.random() * cap);
}

/** @param {string | null} value seconds or an HTTP date */
export function retryAfterMs(value, nowMs = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, string>} [query]
 */
function buildUrl(baseUrl, path, query) {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

/** @param {Response} response */
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * @param {Logger} logger
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {Record<string, unknown>} fields
 */
function log(logger, level, fields) {
  const fn = logger?.[level];
  if (typeof fn === 'function') fn.call(logger, { provider: 'digio', ...fields }, `digio ${fields.op}`);
}

/**
 * multipart/form-data body for POST /v2/client/document/upload: a `file` part (the PDF) and a
 * `request` part holding the JSON request. Built by hand so the `request` part carries
 * Content-Type: application/json without a filename, which FormData cannot express.
 * @param {{ fileName: string, fileBytes: Uint8Array, request: unknown, boundary?: string }} input
 */
export function buildMultipart({ fileName, fileBytes, request: requestJson, boundary }) {
  const b = boundary ?? `----phoenix-digio-${randomBytes(12).toString('hex')}`;
  const safeName = fileName.replace(/["\r\n\\]/g, '_');
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/pdf\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(
    `\r\n--${b}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(requestJson)}\r\n--${b}--\r\n`,
    'utf8',
  );
  return { body: new Uint8Array(Buffer.concat([head, fileBytes, tail])), contentType: `multipart/form-data; boundary=${b}` };
}
