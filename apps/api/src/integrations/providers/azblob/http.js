import { AzblobError, classifyStatus, redact } from './errors.js';
import { parseErrorXml } from './xml.js';

/**
 * One place that sends HTTP requests: per-attempt timeout (AbortSignal), caller cancellation,
 * retries with exponential backoff and full jitter for idempotent calls only, error mapping,
 * and redacted logging (never headers, never query secrets).
 */

const MAX_ERROR_BODY = 16 * 1024;

/**
 * @typedef {object} HttpDeps
 * @property {typeof fetch} fetch
 * @property {() => number} now epoch ms
 * @property {{ debug?: Function, info?: Function, warn?: Function }} [logger]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random] 0 <= x < 1
 * @property {() => string[]} [secrets] values to mask in messages
 */

/**
 * @typedef {object} SendOptions
 * @property {string} operation name for logs and errors, e.g. "putBlob"
 * @property {string} method
 * @property {string} url
 * @property {(attempt: number) => Promise<Record<string, string>> | Record<string, string>} headers built per attempt (fresh x-ms-date, refreshed token)
 * @property {Uint8Array | string} [body]
 * @property {number[]} expect success statuses
 * @property {boolean} idempotent only idempotent requests are retried
 * @property {AbortSignal} [signal] caller cancellation
 * @property {number} [timeoutMs] per attempt
 * @property {(text: string, res: Response) => { code?: string, message?: string }} [parseError]
 * @property {(status: number, code?: string) => { kind: import('./errors.js').AzblobErrorKind, retryable: boolean }} [classify]
 */

/**
 * @param {HttpDeps & { timeoutMs: number, maxRetries: number, retryBaseMs: number, retryMaxMs: number }} deps
 */
export function createHttp(deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const secrets = deps.secrets ?? (() => []);
  const log = deps.logger ?? {};

  /** Delay before retry number `attempt` (1-based), honouring Retry-After when the server sends one. */
  function backoff(attempt, res) {
    const retryAfter = Number(res?.headers?.get?.('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, deps.retryMaxMs);
    const ceiling = Math.min(deps.retryMaxMs, deps.retryBaseMs * 2 ** (attempt - 1));
    return Math.floor(random() * ceiling);
  }

  /** @param {SendOptions} opts */
  async function send(opts) {
    const maxAttempts = opts.idempotent ? deps.maxRetries + 1 : 1;
    const safeUrl = redact(opts.url, secrets());
    for (let attempt = 1; ; attempt += 1) {
      const started = deps.now();
      let res;
      try {
        res = await attemptOnce(opts, attempt);
      } catch (error) {
        const failure = networkFailure(error, opts, safeUrl);
        failure.attempts = attempt;
        if (!failure.retryable || attempt >= maxAttempts) throw failure;
        log.warn?.({ provider: 'azblob', op: opts.operation, attempt, kind: failure.kind }, 'azblob request failed, retrying');
        await sleep(backoff(attempt));
        continue;
      }
      const requestId = res.headers.get('x-ms-request-id') ?? undefined;
      log.debug?.(
        { provider: 'azblob', op: opts.operation, method: opts.method, url: safeUrl, status: res.status, attempt, ms: deps.now() - started, requestId },
        'azblob request',
      );
      if (opts.expect.includes(res.status)) return res;
      const failure = await httpFailure(res, opts, requestId);
      failure.attempts = attempt;
      if (!failure.retryable || attempt >= maxAttempts) throw failure;
      log.warn?.({ provider: 'azblob', op: opts.operation, attempt, status: res.status, requestId }, 'azblob request failed, retrying');
      await sleep(backoff(attempt, res));
    }
  }

  async function attemptOnce(opts, attempt) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? deps.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const headers = await opts.headers(attempt);
    return deps.fetch(opts.url, { method: opts.method, headers, body: opts.body, signal, redirect: 'manual' });
  }

  function networkFailure(error, opts, safeUrl) {
    if (error instanceof AzblobError) return error;
    if (opts.signal?.aborted) {
      return new AzblobError(`${opts.operation} cancelled`, { kind: 'cancelled', cause: error });
    }
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const kind = timedOut ? 'timeout' : 'network';
    const detail = timedOut ? 'timed out' : `network error (${redact(error?.message ?? 'unknown', secrets())})`;
    return new AzblobError(`${opts.operation} ${detail}: ${opts.method} ${safeUrl}`, { kind, retryable: true });
  }

  async function httpFailure(res, opts, requestId) {
    let text = '';
    try {
      text = (await res.text()).slice(0, MAX_ERROR_BODY);
    } catch {
      text = '';
    }
    const parsed = (opts.parseError ?? parseErrorXml)(text, res);
    const azureCode = res.headers.get('x-ms-error-code') ?? parsed.code ?? undefined;
    const { kind, retryable } = res.status >= 300 && res.status < 400 ? { kind: 'unknown', retryable: false } : (opts.classify ?? classifyStatus)(res.status, azureCode);
    // Auth failure messages echo the string-to-sign and signature; keep them out of logs.
    const firstLine = kind === 'auth' || kind === 'forbidden' ? '' : (parsed.message ?? '').split('\n')[0];
    const message = redact(
      `${opts.operation} failed with ${res.status}${azureCode ? ` ${azureCode}` : ''}${firstLine ? `: ${firstLine}` : ''}`,
      secrets(),
    );
    return new AzblobError(message, { kind, retryable, status: res.status, azureCode, requestId });
  }

  return { send };
}
