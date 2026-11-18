/**
 * Typed errors for the Azure Blob Storage client.
 *
 * Every failure the client raises is an AzblobError with:
 * - kind: a small, stable category the adapter layer can switch on
 * - retryable: true only for failures that may succeed if the same request is sent again
 * - status / azureCode / requestId: what Azure said, for logs and support tickets
 *
 * Messages never contain account keys, bearer tokens or SAS signatures (see redact()).
 */

/** @typedef {'config'|'validation'|'auth'|'forbidden'|'not_found'|'conflict'|'precondition'|'too_large'|'throttled'|'server'|'timeout'|'network'|'cancelled'|'unknown'} AzblobErrorKind */

export class AzblobError extends Error {
  /**
   * @param {string} message safe to log
   * @param {{ kind: AzblobErrorKind, retryable?: boolean, status?: number, azureCode?: string, requestId?: string, cause?: unknown }} info
   */
  constructor(message, { kind, retryable = false, status, azureCode, requestId, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AzblobError';
    this.provider = 'azblob';
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
    this.azureCode = azureCode;
    this.requestId = requestId;
  }
}

/** Azure error codes that are worth retrying even though the status alone would not say so. */
const RETRYABLE_CODES = new Set(['ServerBusy', 'OperationTimedOut', 'InternalError']);

/**
 * Map an HTTP status and Azure error code (x-ms-error-code / <Code>) to a kind and retryability.
 * @param {number} status
 * @param {string | undefined} azureCode
 * @returns {{ kind: AzblobErrorKind, retryable: boolean }}
 */
export function classifyStatus(status, azureCode) {
  if (azureCode && RETRYABLE_CODES.has(azureCode)) {
    return { kind: azureCode === 'ServerBusy' ? 'throttled' : 'server', retryable: true };
  }
  if (status === 400) return { kind: 'validation', retryable: false };
  if (status === 401) return { kind: 'auth', retryable: false };
  if (status === 403) {
    // 403 AuthenticationFailed is usually a bad key or clock skew (> 15 min); never retry blindly.
    return { kind: azureCode === 'AuthenticationFailed' ? 'auth' : 'forbidden', retryable: false };
  }
  if (status === 404) return { kind: 'not_found', retryable: false };
  if (status === 408) return { kind: 'timeout', retryable: true };
  if (status === 409) return { kind: 'conflict', retryable: false };
  if (status === 412) return { kind: 'precondition', retryable: false };
  if (status === 413) return { kind: 'too_large', retryable: false };
  if (status === 429) return { kind: 'throttled', retryable: true };
  if (status === 503) return { kind: 'throttled', retryable: true };
  if (status === 500 || status === 502 || status === 504) return { kind: 'server', retryable: true };
  if (status >= 500) return { kind: 'server', retryable: false };
  return { kind: 'unknown', retryable: false };
}

const SECRET_QUERY_KEYS = /([?&](?:sig|code|skoid|sktid|client_secret)=)[^&#]*/gi;

/**
 * Remove secrets from a URL or free text before it reaches a log line or an error message.
 * @param {string} text
 * @param {string[]} [secrets] literal secret values to mask wherever they appear
 */
export function redact(text, secrets = []) {
  let out = String(text).replace(SECRET_QUERY_KEYS, '$1[redacted]');
  out = out.replace(/(SharedKey\s+[^:\s]+:)\S+/g, '$1[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}
