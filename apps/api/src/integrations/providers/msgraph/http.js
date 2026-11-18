import { MsgraphError, errorFromGraphResponse, redact } from './errors.js';

/**
 * HTTP plumbing shared by the token provider and the Graph transport:
 * per-attempt timeouts, retry delays, safe sleeping and fetch-failure classification.
 */

/**
 * @typedef {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} Logger
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 */

/** Logger that drops everything; used when the caller passes none. */
export const silentLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Sleep that wakes early (and rejects) when the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exponential backoff with full jitter: random(0, min(max, base * 2^attempt)).
 * @param {number} attempt zero-based retry number
 * @param {{ baseMs: number, maxMs: number, random: () => number }} options
 */
export function backoffDelay(attempt, { baseMs, maxMs, random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Combine the caller's signal with a per-attempt timeout.
 * @param {AbortSignal | undefined} callerSignal
 * @param {number} timeoutMs
 */
export function attemptSignal(callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  return { signal, timeout };
}

/**
 * Turn a rejected fetch into a typed error.
 * @param {unknown} err
 * @param {{ operation: string, callerSignal?: AbortSignal, timeout: AbortSignal, timeoutMs: number, idempotent: boolean, secrets: string[] }} ctx
 */
export function fetchFailure(err, { operation, callerSignal, timeout, timeoutMs, idempotent, secrets }) {
  if (callerSignal?.aborted) {
    return new MsgraphError(`${operation} aborted by caller`, { kind: 'aborted', operation, cause: err });
  }
  const outcomeUnknown = !idempotent;
  if (timeout.aborted) {
    return new MsgraphError(`${operation} timed out after ${timeoutMs} ms`, {
      kind: 'timeout',
      retryable: true,
      operation,
      details: { outcomeUnknown },
    });
  }
  const message = redact(/** @type {any} */ (err)?.message ?? String(err), secrets);
  return new MsgraphError(`${operation} network error: ${message}`, {
    kind: 'network',
    retryable: true,
    operation,
    details: { outcomeUnknown },
  });
}

/**
 * Read a response body as JSON when there is one.
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
export async function readJson(res) {
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonBody: true };
  }
}

/**
 * Small per-key semaphore (Outlook allows four concurrent requests per app and mailbox).
 * @param {number} limit
 */
export function createKeyedLimiter(limit) {
  /** @type {Map<string, { active: number, waiting: Array<() => void> }>} */
  const slots = new Map();
  return {
    /**
     * @template T
     * @param {string | null} key
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    async run(key, task) {
      if (!key) return task();
      let slot = slots.get(key);
      if (!slot) {
        slot = { active: 0, waiting: [] };
        slots.set(key, slot);
      }
      if (slot.active >= limit) await new Promise((resolve) => slot.waiting.push(() => resolve(undefined)));
      slot.active += 1;
      try {
        return await task();
      } finally {
        slot.active -= 1;
        const next = slot.waiting.shift();
        if (next) next();
        else if (slot.active === 0) slots.delete(key);
      }
    },
  };
}

/**
 * Encode OData query options. `$` stays literal in option names; values are percent-encoded once.
 * @param {Record<string, string | number | boolean | undefined>} [query]
 */
export function encodeQuery(query) {
  if (!query) return '';
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    const name = key.startsWith('$') ? `$${encodeURIComponent(key.slice(1))}` : encodeURIComponent(key);
    parts.push(`${name}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * @typedef {{
 *   operation: string,
 *   method: 'GET'|'POST'|'PATCH'|'DELETE',
 *   path: string,
 *   query?: Record<string, string | number | boolean | undefined>,
 *   body?: unknown,
 *   prefer?: string[],
 *   idempotent: boolean,
 *   mailbox?: string | null,
 *   signal?: AbortSignal,
 *   notFoundOk?: boolean,
 * }} GraphRequest
 */

/**
 * Authenticated Graph transport with timeouts, Retry-After handling and bounded retries.
 * Non-idempotent requests are never retried, except once after a 401 (the request was not executed).
 * @param {{
 *   config: import('./config.js').MsgraphConfig,
 *   fetch: FetchLike,
 *   now: () => number,
 *   sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   random: () => number,
 *   randomUUID: () => string,
 *   logger: Logger,
 *   tokens: { getToken: (o?: { forceRefresh?: boolean, signal?: AbortSignal }) => Promise<string>, invalidate: () => void },
 *   secrets: string[],
 * }} deps
 */
export function createGraphTransport(deps) {
  const { config, fetch, now, sleep, random, randomUUID, logger, tokens, secrets } = deps;
  const base = new URL(config.graphBaseUrl);
  const limiter = createKeyedLimiter(config.maxConcurrentPerMailbox);

  /** @param {string} path */
  function resolveUrl(path) {
    if (/^https:\/\//i.test(path)) {
      // Paging links come from the response; never send the token to another host.
      const url = new URL(path);
      if (url.origin !== base.origin) {
        throw new MsgraphError('Refusing to follow a link outside the Graph base URL', {
          kind: 'unexpected',
          code: 'foreign_link',
        });
      }
      return url.toString();
    }
    return `${config.graphBaseUrl.replace(/\/+$/, '')}${path}`;
  }

  /**
   * @param {GraphRequest} req
   * @returns {Promise<{ status: number, body: any, headers: Headers }>}
   */
  async function request(req) {
    return limiter.run(req.mailbox ? req.mailbox.toLowerCase() : null, () => send(req));
  }

  /** @param {GraphRequest} req */
  async function send(req) {
    const url = resolveUrl(req.path) + encodeQuery(req.query);
    const clientRequestId = randomUUID();
    let authRetried = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await tokens.getToken({ signal: req.signal });
      const headers = buildHeaders(req, token, clientRequestId);
      const { signal, timeout } = attemptSignal(req.signal, config.requestTimeoutMs);
      const started = now();
      /** @type {Response} */
      let res;
      try {
        res = await fetch(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal,
        });
      } catch (err) {
        const failure = fetchFailure(err, {
          operation: req.operation,
          callerSignal: req.signal,
          timeout,
          timeoutMs: config.requestTimeoutMs,
          idempotent: req.idempotent,
          secrets,
        });
        failure.clientRequestId = clientRequestId;
        if (!failure.retryable || !req.idempotent || attempt >= config.maxRetries) throw failure;
        await wait(req, attempt, failure, null);
        continue;
      }
      const body = await readJson(res);
      log('debug', req, { status: res.status, attempt, durationMs: now() - started, requestId: res.headers.get('request-id') });
      if (res.ok) return { status: res.status, body, headers: res.headers };
      if (res.status === 404 && req.notFoundOk) return { status: 404, body, headers: res.headers };
      const error = errorFromGraphResponse({
        status: res.status,
        body,
        headers: res.headers,
        nowMs: now(),
        operation: req.operation,
        secrets,
        clientRequestId,
      });
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        tokens.invalidate();
        continue;
      }
      if (!error.retryable || !req.idempotent || attempt >= config.maxRetries) throw error;
      await wait(req, attempt, error, error.retryAfterMs);
    }
  }

  /**
   * @param {GraphRequest} req
   * @param {number} attempt
   * @param {MsgraphError} error
   * @param {number | null} retryAfterMs
   */
  async function wait(req, attempt, error, retryAfterMs) {
    const delay =
      retryAfterMs ?? backoffDelay(attempt, { baseMs: config.retryBaseDelayMs, maxMs: config.maxRetryDelayMs, random });
    if (delay > config.maxRetryDelayMs) throw error;
    log('warn', req, { status: error.status, kind: error.kind, attempt, retryInMs: delay });
    await sleep(delay, req.signal);
  }

  /**
   * @param {GraphRequest} req
   * @param {string} token
   * @param {string} clientRequestId
   */
  function buildHeaders(req, token, clientRequestId) {
    /** @type {Record<string, string>} */
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'client-request-id': clientRequestId,
    };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.prefer?.length) headers.prefer = req.prefer.join(', ');
    return headers;
  }

  /**
   * @param {'debug'|'warn'} level
   * @param {GraphRequest} req
   * @param {Record<string, unknown>} fields
   */
  function log(level, req, fields) {
    logger[level]?.({ provider: 'msgraph', operation: req.operation, method: req.method, ...fields }, `msgraph ${req.operation}`);
  }

  return { request };
}
