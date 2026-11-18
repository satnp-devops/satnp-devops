import { RazorpayError, mapHttpError, redact } from './errors.js';

/**
 * HTTP transport: Basic auth, JSON, per-attempt timeout, retries with jittered exponential
 * backoff (Razorpay asks for backoff with randomisation on 429; docs api/understand#rate-limiting).
 *
 * Retry policy, by how safe a repeat is:
 * - 'safe' (GETs, and POSTs carrying an idempotency key): retried on network errors, timeouts,
 *   429, 5xx and 409 (in-flight duplicate of an idempotent request).
 * - 'unsafe' (POSTs Razorpay cannot de-duplicate, such as creating an order): retried only on
 *   429, which the rate limiter returns before doing any work. A timeout, network error or 5xx
 *   on these is returned with `outcomeUnknown: true` instead of being retried.
 */

/**
 * @typedef {{ debug: Function, info: Function, warn: Function, error: Function }} Logger
 * @typedef {{
 *   config: import('./config.js').RazorpayConfig,
 *   fetch: typeof fetch, logger: Logger, sleep: (ms: number) => Promise<void>, random: () => number,
 *   now: () => number, userAgent: string
 * }} TransportDeps
 * @typedef {{
 *   op: string, method: 'GET'|'POST'|'PATCH', path: string, query?: Record<string, string|number|undefined>,
 *   body?: unknown, headers?: Record<string, string>, retry: 'safe'|'unsafe', signal?: AbortSignal
 * }} RequestSpec
 */

/** @param {string|null} value header value in seconds or an HTTP date */
export function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * Full-jitter exponential backoff: random(0..min(max, base * 2^(attempt-1))), but never less
 * than a server-provided Retry-After (capped at the max delay).
 * @param {number} attempt 1 for the first retry
 */
export function backoffDelay(attempt, { baseMs, maxMs, random, retryAfterMs }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jittered = Math.floor(random() * ceiling);
  return retryAfterMs == null ? jittered : Math.min(maxMs, Math.max(jittered, retryAfterMs));
}

/** @param {TransportDeps} deps */
export function createTransport(deps) {
  const { config, logger } = deps;
  const authHeader = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;
  const secrets = [config.keySecret, ...config.webhookSecrets, authHeader.slice(6)];

  /** @param {RequestSpec} spec */
  function buildUrl(spec) {
    const url = new URL(config.baseUrl + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  /**
   * One attempt. Resolves to { status, body, retryAfterMs } or throws a RazorpayError for
   * transport failures (network, timeout, aborted, invalid_response).
   * @param {RequestSpec} spec
   */
  async function attemptOnce(spec, url) {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = spec.signal ? AbortSignal.any([spec.signal, timeout]) : timeout;
    /** @type {Record<string, string>} */
    const headers = { Authorization: authHeader, Accept: 'application/json', 'User-Agent': deps.userAgent, ...spec.headers };
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await deps.fetch(url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal,
      });
    } catch (cause) {
      const safe = spec.retry === 'safe';
      if (spec.signal?.aborted) {
        throw new RazorpayError('aborted', `Razorpay ${spec.op} was cancelled`, { op: spec.op, outcomeUnknown: !safe });
      }
      const timedOut = timeout.aborted;
      const kind = timedOut ? 'timeout' : 'network';
      const detail = timedOut ? `timed out after ${config.timeoutMs} ms` : redact(cause?.message ?? 'network error', secrets);
      throw new RazorpayError(kind, `Razorpay ${spec.op} ${timedOut ? detail : `failed: ${detail}`}`, {
        op: spec.op,
        retryable: safe,
        outcomeUnknown: !safe,
      });
    }
    const text = await response.text().catch(() => '');
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null, deps.now());
    return { status: response.status, ok: response.ok, body, retryAfterMs };
  }

  /**
   * Send a request with retries; resolves to the parsed JSON body.
   * @param {RequestSpec} spec
   */
  async function request(spec) {
    const url = buildUrl(spec);
    const safe = spec.retry === 'safe';
    const maxAttempts = 1 + config.maxRetries;
    for (let attempt = 1; ; attempt += 1) {
      const started = deps.now();
      /** @type {RazorpayError} */
      let failure;
      try {
        const res = await attemptOnce(spec, url);
        const durationMs = deps.now() - started;
        if (res.ok) {
          if (res.body === undefined || res.body === null) {
            throw new RazorpayError('invalid_response', `Razorpay ${spec.op} returned a non-JSON response`, {
              op: spec.op,
              status: res.status,
              outcomeUnknown: spec.method !== 'GET',
            });
          }
          logger.debug({ provider: 'razorpay', op: spec.op, method: spec.method, status: res.status, attempt, durationMs }, 'razorpay request ok');
          return res.body;
        }
        // mapHttpError applies the policy: 429 always retryable; 409/5xx only when `safe`.
        failure = mapHttpError({ status: res.status, body: res.body, op: spec.op, safeToRetry: safe, retryAfterMs: res.retryAfterMs, secrets });
      } catch (error) {
        if (!(error instanceof RazorpayError)) throw error;
        failure = error;
      }
      if (!failure.retryable || attempt >= maxAttempts) {
        logger.warn(
          { provider: 'razorpay', op: spec.op, method: spec.method, status: failure.status, kind: failure.kind, attempt, retryable: failure.retryable },
          'razorpay request failed',
        );
        throw failure;
      }
      const delayMs = backoffDelay(attempt, {
        baseMs: config.retryBaseDelayMs,
        maxMs: config.retryMaxDelayMs,
        random: deps.random,
        retryAfterMs: failure.retryAfterMs,
      });
      logger.info(
        { provider: 'razorpay', op: spec.op, method: spec.method, status: failure.status, kind: failure.kind, attempt, retryInMs: delayMs },
        'razorpay request will be retried',
      );
      await deps.sleep(delayMs);
    }
  }

  return { request };
}
