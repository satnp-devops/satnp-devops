import { errors } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie sessions + a required custom header on every write. Browsers can't add custom
 * headers to cross-site requests without a CORS preflight, and this API allows none,
 * so a malicious site can't make writes with a signed-in user's cookie.
 * API keys (Authorization header) and provider webhooks are exempt.
 */
export function csrfGuard(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (req.get('authorization')) return next();
  if (req.get('x-phoenix-client')) return next();
  throw errors.forbidden('Missing the X-Phoenix-Client header');
}
