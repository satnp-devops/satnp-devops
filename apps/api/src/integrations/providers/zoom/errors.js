/**
 * Typed errors for the Zoom client.
 *
 * Every error carries `retryable` so a queue/adapter can decide what to do without
 * inspecting HTTP details:
 * - retryable: true  -> safe to try again later (rate limit, 5xx, network, timeout on a safe call).
 * - retryable: false -> permanent until something changes (bad config, bad input, missing scope, not found).
 *
 * `ambiguous: true` marks a failed non-idempotent call (create meeting) where the request may
 * have reached Zoom: the caller must reconcile before creating again. Zoom has no idempotency keys.
 *
 * Messages never contain credentials: build them with `redact()` from this module.
 */

/** @typedef {'config'|'auth'|'permission'|'validation'|'not_found'|'conflict'|'rate_limited'|'server'|'network'|'timeout'|'webhook'|'unknown'} ZoomErrorKind */

export class ZoomError extends Error {
  /**
   * @param {string} message
   * @param {{ kind?: ZoomErrorKind, status?: number|null, providerCode?: number|string|null, retryable?: boolean,
   *   retryAfterMs?: number|null, ambiguous?: boolean, method?: string, path?: string, details?: unknown, cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'ZoomError';
    this.provider = 'zoom';
    /** @type {ZoomErrorKind} */
    this.kind = info.kind ?? 'unknown';
    this.status = info.status ?? null;
    this.providerCode = info.providerCode ?? null;
    this.retryable = info.retryable ?? false;
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.ambiguous = info.ambiguous ?? false;
    this.method = info.method;
    this.path = info.path;
    this.details = info.details;
  }

  /** Plain object for logs and API responses (no stack, no secrets). */
  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      kind: this.kind,
      message: this.message,
      status: this.status,
      providerCode: this.providerCode,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      ambiguous: this.ambiguous,
      method: this.method,
      path: this.path,
    };
  }
}

export class ZoomConfigError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { ...info, kind: 'config', retryable: false });
    this.name = 'ZoomConfigError';
  }
}

/** Token request rejected or access token refused (after one automatic refresh). */
export class ZoomAuthError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { retryable: false, ...info, kind: 'auth' });
    this.name = 'ZoomAuthError';
  }
}

export class ZoomPermissionError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { ...info, kind: 'permission', retryable: false });
    this.name = 'ZoomPermissionError';
  }
}

export class ZoomValidationError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { kind: 'validation', ...info, retryable: false });
    this.name = 'ZoomValidationError';
  }
}

export class ZoomNotFoundError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { ...info, kind: 'not_found', retryable: false });
    this.name = 'ZoomNotFoundError';
  }
}

export class ZoomRateLimitError extends ZoomError {
  /** @param {string} message @param {object} [info] `limitType`: 'QPS' | 'Daily-limit' | null */
  constructor(message, info = {}) {
    super(message, { ...info, kind: 'rate_limited', retryable: true });
    this.name = 'ZoomRateLimitError';
    this.limitType = info.limitType ?? null;
    this.limitCategory = info.limitCategory ?? null;
  }
}

export class ZoomServerError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { retryable: true, ...info, kind: 'server' });
    this.name = 'ZoomServerError';
  }
}

/** Network failure or timeout (`kind` is 'network' or 'timeout'). */
export class ZoomNetworkError extends ZoomError {
  constructor(message, info = {}) {
    super(message, { retryable: true, kind: 'network', ...info });
    this.name = 'ZoomNetworkError';
  }
}

export class ZoomWebhookError extends ZoomError {
  /** @param {string} message @param {{ reason: string }} info */
  constructor(message, info) {
    super(message, { kind: 'webhook', retryable: false, status: 401 });
    this.name = 'ZoomWebhookError';
    this.reason = info.reason;
  }
}

/**
 * Replace every occurrence of the given secrets in a string with "[REDACTED]".
 * Short values (< 4 chars) are ignored to avoid mangling ordinary text.
 * @param {string} text
 * @param {Array<string|undefined|null>} secrets
 */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}
