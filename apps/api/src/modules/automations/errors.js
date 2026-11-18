/** A failed action, reported to the run as { code, message } (and to onError steps). */
export class ActionError extends Error {
  /**
   * @param {string} code stable code, e.g. URL_PRIVATE_ADDRESS, NO_EXECUTOR
   * @param {string} message safe to show to people
   * @param {{ retryable?: boolean }} [options] retryable: the jobs framework may try again
   */
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.retryable = retryable;
  }
}
