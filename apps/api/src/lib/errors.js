export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable machine-readable code
   * @param {string} message message safe to show to people
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest: (message = 'Bad request', details) => new AppError(400, 'bad_request', message, details),
  validation: (details, message = 'Some fields need attention') =>
    new AppError(422, 'validation_failed', message, details),
  unauthorized: (message = 'Sign in to continue') => new AppError(401, 'unauthorized', message),
  invalidCredentials: () => new AppError(401, 'invalid_credentials', 'Email or password is incorrect'),
  invalidCode: () => new AppError(401, 'invalid_code', "That code didn't work. Try the latest code from your app."),
  forbidden: (message = "You don't have permission to do this") => new AppError(403, 'forbidden', message),
  mfaRequired: () => new AppError(403, 'mfa_required', 'Enter your verification code to continue'),
  mfaSetupRequired: () => new AppError(403, 'mfa_setup_required', 'Set up two-step verification to continue'),
  notFound: (what = 'Item') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (message, details) => new AppError(409, 'conflict', message, details),
  tooMany: (message = 'Too many attempts. Try again in a few minutes.') => new AppError(429, 'rate_limited', message),
};
