import { ZoomAuthError, ZoomError } from './errors.js';

/**
 * Server-to-Server OAuth (grant_type=account_credentials).
 *
 * - POST {oauthTokenUrl} with `Authorization: Basic base64(clientId:clientSecret)` and a
 *   form body `grant_type=account_credentials&account_id=...`.
 * - Tokens live one hour and there is no refresh token: we cache until
 *   `expires_in - tokenRefreshSkewSeconds`, then request a new one. Zoom allows several valid
 *   tokens at once, so a refresh never invalidates a token another worker is using.
 * - Concurrent callers share one in-flight request (single flight).
 * - The token request has no side effects, so it is retried like any idempotent call.
 */

/**
 * @typedef {object} CachedToken
 * @property {string} accessToken
 * @property {number} expiresAt  epoch ms
 * @property {number} refreshAt  epoch ms after which a new token is requested
 * @property {string|null} apiUrl  regional cluster from the token response, e.g. https://api-in.zoom.us
 * @property {string[]} scopes
 */

/**
 * @param {{ config: import('./config.js').ZoomConfig, http: ReturnType<typeof import('./http.js').createHttp>, now: () => number }} deps
 */
export function createTokenManager({ config, http, now }) {
  /** @type {CachedToken|null} */
  let cached = null;
  /** @type {Promise<CachedToken>|null} */
  let inflight = null;

  const skewMs = config.tokenRefreshSkewSeconds * 1000;

  function isFresh(token) {
    return token !== null && now() < token.refreshAt;
  }

  async function requestToken() {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
    const url = new URL(config.oauthTokenUrl);
    let result;
    try {
      result = await http.send({
        method: 'POST',
        url: url.toString(),
        path: url.pathname,
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'account_credentials', account_id: config.accountId }).toString(),
        idempotent: true,
      });
    } catch (error) {
      // 400/401/403 from the token endpoint mean wrong credentials, wrong account ID or a
      // deactivated app: permanent until an admin fixes the connection.
      if (error instanceof ZoomError && error.status && error.status < 500 && error.status !== 429) {
        throw new ZoomAuthError(`Zoom token request rejected: ${error.message}`, {
          status: error.status,
          providerCode: error.providerCode,
          method: 'POST',
          path: url.pathname,
        });
      }
      throw error;
    }
    const body = result.body ?? {};
    if (typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number') {
      throw new ZoomAuthError('Zoom token response is missing access_token or expires_in', { status: result.status, path: url.pathname });
    }
    const lifetimeMs = body.expires_in * 1000;
    return {
      accessToken: body.access_token,
      expiresAt: now() + lifetimeMs,
      // Refresh skew early, but never cache for less than half the lifetime.
      refreshAt: now() + Math.max(lifetimeMs / 2, lifetimeMs - skewMs),
      apiUrl: typeof body.api_url === 'string' ? body.api_url.replace(/\/+$/, '') : null,
      scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
    };
  }

  /**
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<CachedToken>}
   */
  async function getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && isFresh(cached)) return cached;
    if (!inflight) {
      inflight = requestToken()
        .then((token) => {
          cached = token;
          return token;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  /** Drop the cached token if it is still the one that Zoom just refused. */
  function invalidate(accessToken) {
    if (cached && (!accessToken || cached.accessToken === accessToken)) cached = null;
  }

  /** Current access token string, for redaction. */
  function currentSecret() {
    return cached?.accessToken;
  }

  return { getToken, invalidate, currentSecret };
}
