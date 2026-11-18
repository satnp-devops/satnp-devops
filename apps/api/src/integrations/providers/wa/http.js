import { createHmac } from 'node:crypto';
import { WaError, fromGraphError, redact } from './errors.js';

/**
 * HTTP transport for the Graph API: timeouts, retries with backoff, error mapping, safe logging.
 *
 * Retry policy:
 * - `idempotent: true` calls (GET, DELETE, mark-as-read, media upload) retry any retryable error,
 *   including timeouts and network failures.
 * - `idempotent: false` calls (sending a message, creating a template) retry only when Meta
 *   explicitly rejected the call before doing anything (throttling codes such as 130429, 131056, 4,
 *   80007). The Cloud API has no idempotency key, so a timeout or 5xx on a send is surfaced as
 *   `retryable: true, ambiguous: true` and the caller decides (see docs/providers/wa.md).
 */

/** @typedef {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} Logger */

/**
 * @typedef {object} TransportDeps
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]          epoch milliseconds
 * @property {Logger} [logger]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]       0 <= x < 1, used for jitter
 */

/**
 * @typedef {object} RequestOptions
 * @property {'GET' | 'POST' | 'DELETE'} method
 * @property {string} [path]        Graph path after the version, e.g. `/123/messages`
 * @property {string} [url]         absolute URL (media download); used instead of path
 * @property {Record<string, string | number | boolean | undefined>} [query]
 * @property {unknown} [json]       JSON body
 * @property {() => FormData} [form] multipart body, rebuilt for every attempt
 * @property {boolean} idempotent
 * @property {'json' | 'bytes'} [responseType]
 * @property {string} op            operation name for logs
 * @property {AbortSignal} [signal]
 * @property {number} [maxBytes]    limit for `bytes` responses
 */

const noop = () => {};
const silentLogger = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * @param {Readonly<import('./config.js').WaConfig>} config
 * @param {TransportDeps} [deps]
 */
export function createTransport(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new WaError('No fetch implementation available', { kind: 'config', retryable: false });
  const now = deps.now ?? Date.now;
  const logger = { ...silentLogger, ...(deps.logger ?? {}) };
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const secrets = [config.accessToken, config.appSecret, config.previousAppSecret, config.verifyToken];
  const proof = config.appSecretProof && config.appSecret
    ? createHmac('sha256', config.appSecret).update(config.accessToken).digest('hex')
    : null;

  /** @param {RequestOptions} opts */
  function buildUrl(opts) {
    if (opts.url) return new URL(opts.url);
    const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/${config.graphVersion}${opts.path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (proof) url.searchParams.set('appsecret_proof', proof);
    return url;
  }

  /** @param {RequestOptions} opts */
  function buildInit(opts, signal) {
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${config.accessToken}`,
      'User-Agent': config.userAgent,
    };
    /** @type {RequestInit} */
    const init = { method: opts.method, headers, signal, redirect: opts.url ? 'error' : 'follow' };
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    } else if (opts.form) {
      init.body = opts.form();
    }
    if (opts.responseType !== 'bytes') headers.Accept = 'application/json';
    return init;
  }

  /**
   * Delay before the next attempt (the caller gives up when it exceeds maxRetryDelayMs).
   * @param {number} attempt 0 for the first retry
   * @param {WaError} error
   * @param {Response | null} res
   */
  function retryDelay(attempt, error, res) {
    let delay;
    if (error.code === 131056) {
      // Pair rate limit: Meta recommends retrying after 4^X seconds (X = 0, 1, 2, ...).
      delay = 4 ** attempt * 1000;
    } else {
      const ceiling = Math.min(config.maxRetryDelayMs, config.retryBaseMs * 2 ** attempt);
      delay = Math.round(ceiling / 2 + random() * (ceiling / 2));
    }
    const retryAfter = Number(res?.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
    if (error.retryAfterMs && error.code !== 131056) delay = Math.max(delay, error.retryAfterMs);
    return delay;
  }

  /**
   * Run one HTTP attempt and return the parsed response, or throw a WaError.
   * @param {RequestOptions} opts
   * @returns {Promise<{ res: Response | null, data?: any, bytes?: Uint8Array, contentType?: string | null, error?: WaError }>}
   */
  async function attemptOnce(opts) {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let res;
    try {
      res = await fetchImpl(buildUrl(opts), buildInit(opts, signal));
    } catch (cause) {
      return { res: null, error: transportError(cause, opts, timeout) };
    }
    if (res.ok && opts.responseType === 'bytes') {
      try {
        const bytes = await readLimited(res, opts.maxBytes ?? config.maxMediaBytes);
        return { res, bytes, contentType: res.headers.get('content-type') };
      } catch (cause) {
        return { res, error: cause instanceof WaError ? cause : transportError(cause, opts, timeout) };
      }
    }
    let text = '';
    try {
      text = await res.text();
    } catch (cause) {
      return { res, error: transportError(cause, opts, timeout) };
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) return { res, error: fromGraphError(data, res.status, secrets) };
    if (data === null || typeof data !== 'object') {
      return {
        res,
        error: new WaError(`WhatsApp API returned a non-JSON response (HTTP ${res.status})`, {
          kind: 'unknown',
          retryable: false,
          httpStatus: res.status,
        }),
      };
    }
    return { res, data };
  }

  /**
   * @param {unknown} cause
   * @param {RequestOptions} opts
   * @param {AbortSignal} timeout
   */
  function transportError(cause, opts, timeout) {
    const message = redact(cause instanceof Error ? cause.message : cause, secrets);
    if (timeout.aborted) {
      return new WaError(`WhatsApp API ${opts.op} timed out after ${config.timeoutMs}ms`, { kind: 'timeout', retryable: true });
    }
    if (opts.signal?.aborted) return new WaError(`WhatsApp API ${opts.op} was aborted`, { kind: 'aborted', retryable: false });
    return new WaError(`WhatsApp API ${opts.op} failed: ${message}`, { kind: 'network', retryable: true });
  }

  /**
   * @param {RequestOptions} opts
   */
  async function request(opts) {
    const path = opts.url ? new URL(opts.url).pathname : opts.path;
    for (let attempt = 0; ; attempt += 1) {
      const started = now();
      const result = await attemptOnce(opts);
      const ms = now() - started;
      const status = result.res?.status ?? null;
      if (!result.error) {
        logger.debug({ wa: { op: opts.op, method: opts.method, path, status, attempt, ms } }, 'whatsapp api call');
        return result;
      }
      const error = result.error;
      const rejected = /** @type {any} */ (error).rejected === true;
      const canRepeat = opts.idempotent ? error.retryable : error.retryable && rejected;
      if (!opts.idempotent && error.retryable && !rejected) error.ambiguous = true;
      let delay = canRepeat && attempt < config.maxRetries ? retryDelay(attempt, error, result.res) : null;
      if (delay !== null && delay > config.maxRetryDelayMs) {
        // Too long to wait inline: hand the wait to the caller's queue.
        error.retryAfterMs = Math.max(error.retryAfterMs ?? 0, delay);
        delay = null;
      }
      const log = { wa: { op: opts.op, method: opts.method, path, status, attempt, ms, kind: error.kind, code: error.code, fbtraceId: error.fbtraceId, retryInMs: delay } };
      if (delay === null) {
        logger.warn(log, 'whatsapp api call failed');
        delete /** @type {any} */ (error).rejected;
        throw error;
      }
      logger.info(log, 'whatsapp api call failed, retrying');
      await sleep(delay);
      if (opts.signal?.aborted) throw new WaError(`WhatsApp API ${opts.op} was aborted`, { kind: 'aborted', retryable: false });
    }
  }

  return { request, appSecretProof: proof };
}

/**
 * Read a response body, refusing to buffer more than maxBytes.
 * @param {Response} res
 * @param {number} maxBytes
 */
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(noop);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tooLarge(maxBytes) {
  return new WaError(`Media is larger than the ${maxBytes} byte limit`, { kind: 'media', retryable: false });
}
