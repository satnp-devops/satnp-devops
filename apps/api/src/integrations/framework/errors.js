import { AppError } from '../../lib/errors.js';

/**
 * The one error type adapters throw. It is an AppError, so when feature code lets it bubble out of
 * a route the client gets the platform's usual error body ({ error: { code, message, details } }).
 *
 *   code                         status  meaning
 *   integration_not_connected    409     the company has no active connection of this kind (and mocks are off)
 *   integration_unavailable      409     the connection exists but is disabled, disconnected or of another kind
 *   integration_not_implemented  501     the provider's adapter is a stub: credentials can be stored, calls can't be made yet
 *   integration_invalid_input    422     the call didn't match the kind's input schema (details: [{ path, message }])
 *   integration_provider_error   502     the provider (or the mock, when told to fail) refused or failed the call
 *   integration_mocks_disabled   409     a mock connection was used while mocks are switched off (production)
 *
 * `retryable` tells background jobs whether trying again later may succeed.
 */
export class IntegrationError extends AppError {
  /**
   * @param {string} code
   * @param {string} message safe to show to people; never contains credentials
   * @param {{ status?: number, details?: unknown, retryable?: boolean, kind?: string, provider?: string, cause?: unknown }} [options]
   */
  constructor(code, message, { status, details, retryable = false, kind, provider, cause } = {}) {
    super(status ?? STATUS[code] ?? 502, code, message, details);
    this.name = 'IntegrationError';
    this.retryable = retryable;
    this.kind = kind ?? null;
    this.provider = provider ?? null;
    if (cause !== undefined) this.cause = cause;
  }
}

const STATUS = {
  integration_not_connected: 409,
  integration_unavailable: 409,
  integration_not_implemented: 501,
  integration_invalid_input: 422,
  integration_provider_error: 502,
  integration_mocks_disabled: 409,
};

export const INTEGRATION_ERROR_CODES = Object.freeze(Object.keys(STATUS));

export function isIntegrationError(error) {
  return error instanceof IntegrationError;
}
