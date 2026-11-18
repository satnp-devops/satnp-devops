import { randomUUID } from 'node:crypto';
import { encodeForm } from './form.js';
import { StripeConfigError, StripeConnectionError, StripeRequestError, errorFromResponse, redact } from './errors.js';

/**
 * HTTP transport for Stripe API v1: auth, API version, form bodies, idempotency keys,
 * timeouts, and retries with exponential backoff and jitter.
 *
 * Retries happen only when repeating the call is safe: GET/DELETE, or POST with an
 * Idempotency-Key (Stripe replays the first result for the same key for at least 24 h).
 */

const USER_AGENT = 'PhoenixCRM-StripeClient/1.0';
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 5000;
const MAX_RETRY_AFTER_MS = 60_000;

/** @typedef {'GET'|'POST'|'DELETE'} Method */

/**
 * @typedef {object} RequestOptions
 * @property {string|false} [idempotencyKey] POST only. Default: a fresh UUID v4. false: send none (and never retry).
 * @property {string} [stripeAccount] Connect: overrides config.accountId for this call
 * @property {number} [timeoutMs] per attempt
 * @property {number} [maxRetries]
 * @property {AbortSignal} [signal] caller cancellation (never retried)
 */

/**
 * @typedef {object} ResponseMeta
 * @property {number} status
 * @property {string|null} requestId Stripe Request-Id, quote it to Stripe support
 * @property {string|null} idempotencyKey
 * @property {boolean} idempotentReplayed true when Stripe replayed an earlier result
 * @property {number} attempts
 */

/**
 * @param {{
 *   config: import('./config.js').StripeConfig,
 *   fetch: typeof globalThis.fetch,
 *   now: () => number,
 *   logger: { debug?: Function, info?: Function, warn?: Function },
 *   sleep: (ms: number) => Promise<void>,
 *   random: () => number,
 *   newIdempotencyKey: () => string,
 * }} deps
 */
export function createTransport({ config, fetch, now, logger, sleep, random, newIdempotencyKey = randomUUID }) {
  const base = config.apiBase.replace(/\/+$/, '');
  const secrets = [config.secretKey, ...[config.webhookSecret ?? []].flat()];

  /** @param {number} attempt 0-based retry number @param {number|undefined} retryAfterMs */
  function backoff(attempt, retryAfterMs) {
    const exp = Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    const jittered = Math.max(INITIAL_DELAY_MS, exp * (0.5 + random() / 2));
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  /**
   * @param {Method} method
   * @param {string} path
   * @param {Record<string, unknown>|undefined} params
   * @param {RequestOptions} options
   */
  function buildRequest(method, path, params, options) {
    if (!/^\/v1\/[A-Za-z0-9_\-/.]+$/.test(path) || path.includes('..')) {
      throw new StripeConfigError(`Invalid Stripe API path: ${path.slice(0, 80)}`);
    }
    const encoded = encodeForm(params);
    const url = method === 'POST' || !encoded ? `${base}${path}` : `${base}${path}?${encoded}`;
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${config.secretKey}`,
      'Stripe-Version': config.apiVersion,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    const account = options.stripeAccount ?? config.accountId;
    if (account) headers['Stripe-Account'] = account;
    let idempotencyKey = null;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (options.idempotencyKey !== false) {
        idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 255) {
          throw new StripeConfigError('Idempotency key must be 1-255 characters');
        }
        headers['Idempotency-Key'] = idempotencyKey;
      }
    }
    return { url, headers, body: method === 'POST' ? encoded : undefined, idempotencyKey };
  }

  /**
   * @param {Response} response
   * @returns {Promise<any>}
   */
  async function readJson(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * @param {unknown} error
   * @param {AbortSignal|undefined} callerSignal
   * @param {number} timeoutMs
   */
  function connectionError(error, callerSignal, timeoutMs) {
    if (callerSignal?.aborted) {
      return new StripeConnectionError('Stripe request was cancelled', { category: 'aborted', retryable: false, cause: error });
    }
    const name = /** @type {any} */ (error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new StripeConnectionError(`Stripe request timed out after ${timeoutMs} ms`, { category: 'timeout', retryable: true });
    }
    const detail = redact(/** @type {any} */ (error)?.cause?.code ?? /** @type {any} */ (error)?.message ?? 'network error', secrets);
    return new StripeConnectionError(`Could not reach Stripe: ${detail}`, { category: 'connection', retryable: true });
  }

  /**
   * Sends one Stripe API call.
   * @param {Method} method
   * @param {string} path e.g. /v1/checkout/sessions
   * @param {Record<string, unknown>} [params]
   * @param {RequestOptions} [options]
   * @returns {Promise<{ data: any, meta: ResponseMeta }>}
   */
  async function request(method, path, params, options = {}) {
    const { url, headers, body, idempotencyKey } = buildRequest(method, path, params, options);
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    const maxRetries = options.maxRetries ?? config.maxRetries;
    const retrySafe = method !== 'POST' || idempotencyKey !== null;

    for (let attempt = 0; ; attempt += 1) {
      const started = now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      /** @type {import('./errors.js').StripeError} */
      let failure;
      try {
        const response = await fetch(url, { method, headers, body, signal });
        const data = await readJson(response);
        const requestId = response.headers.get('request-id');
        const log = { stripe: { method, path, status: response.status, requestId, attempt, ms: now() - started } };
        if (response.ok) {
          if (data === undefined || data === null) {
            throw new StripeRequestError('Stripe returned a response that is not JSON', {
              category: 'invalid_response',
              status: response.status,
              requestId: requestId ?? undefined,
            });
          }
          logger.debug?.(log, 'stripe request ok');
          return {
            data,
            meta: {
              status: response.status,
              requestId,
              idempotencyKey,
              idempotentReplayed: response.headers.get('idempotent-replayed') === 'true',
              attempts: attempt + 1,
            },
          };
        }
        failure = errorFromResponse({ status: response.status, body: data, headers: response.headers, secrets, nowMs: now() });
        logger.warn?.({ ...log, error: failure.toJSON() }, 'stripe request failed');
      } catch (error) {
        if (error instanceof StripeRequestError) throw error;
        failure = connectionError(error, options.signal, timeoutMs);
        logger.warn?.({ stripe: { method, path, attempt, error: failure.toJSON() } }, 'stripe request failed');
      }

      const retryAfterMs = failure.retryAfterMs;
      const canRetry =
        failure.retryable && retrySafe && attempt < maxRetries && !(retryAfterMs && retryAfterMs > MAX_RETRY_AFTER_MS);
      if (!canRetry) throw failure;
      await sleep(backoff(attempt, retryAfterMs));
    }
  }

  return { request, buildRequest, backoff };
}
