import { createPrivateKey, sign } from 'node:crypto';
import { GoogleError } from './errors.js';

/** Google's documented grant type for the service-account JWT flow. */
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Google accepts at most 1 hour between iat and exp. */
export const MAX_ASSERTION_LIFETIME_SECONDS = 3600;
/** Refresh cached access tokens this long before Google's stated expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** @param {Buffer|string} input */
export function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * RSASSA-PKCS1-v1_5 with SHA-256 over the ASCII signing input. Deterministic, so it can be
 * checked against RFC 7515 Appendix A.2.
 * @param {string} signingInput `base64url(header) + '.' + base64url(payload)`
 * @param {import('node:crypto').KeyLike} privateKey PEM string or KeyObject
 */
export function signRs256(signingInput, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  return sign('sha256', Buffer.from(signingInput, 'ascii'), key).toString('base64url');
}

/**
 * Build and sign the JWT assertion for the service-account flow.
 * @param {{ clientEmail: string, privateKey: import('node:crypto').KeyLike, privateKeyId?: string,
 *   subject?: string, scopes: string[], audience: string, nowMs: number, lifetimeSeconds?: number }} input
 * @returns {{ assertion: string, expiresAtMs: number }}
 */
export function createServiceAccountAssertion(input) {
  const lifetime = Math.min(input.lifetimeSeconds ?? MAX_ASSERTION_LIFETIME_SECONDS, MAX_ASSERTION_LIFETIME_SECONDS);
  const iat = Math.floor(input.nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(input.privateKeyId ? { kid: input.privateKeyId } : {}) };
  const claims = {
    iss: input.clientEmail,
    scope: input.scopes.join(' '),
    aud: input.audience,
    exp: iat + lifetime,
    iat,
    ...(input.subject ? { sub: input.subject } : {}),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return { assertion: `${signingInput}.${signRs256(signingInput, input.privateKey)}`, expiresAtMs: (iat + lifetime) * 1000 };
}

/**
 * Form body for the token endpoint, per auth mode.
 * @param {import('./config.js').GoogleConfig} config
 * @param {number} nowMs
 * @param {import('node:crypto').KeyObject|null} keyObject parsed service-account key
 */
export function tokenRequestBody(config, nowMs, keyObject) {
  const { auth } = config;
  if (auth.type === 'service_account') {
    const { assertion } = createServiceAccountAssertion({
      clientEmail: auth.clientEmail,
      privateKey: keyObject ?? auth.privateKey,
      privateKeyId: auth.privateKeyId,
      subject: auth.subject,
      scopes: config.scopes,
      audience: config.endpoints.tokenUrl,
      nowMs,
    });
    return new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion });
  }
  return new URLSearchParams({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: auth.refreshToken,
    grant_type: 'refresh_token',
  });
}

/**
 * Caches one access token and refreshes it shortly before expiry. Concurrent callers share a
 * single in-flight refresh.
 * @param {{ config: import('./config.js').GoogleConfig, now: () => number,
 *   postForm: (url: string, body: URLSearchParams, operation: string) => Promise<any> }} deps
 */
export function createTokenProvider({ config, now, postForm }) {
  /** @type {{ token: string, expiresAtMs: number, scope: string|null } | null} */
  let cached = null;
  /** @type {Promise<string>|null} */
  let inflight = null;
  let keyObject = null;
  if (config.auth.type === 'service_account') {
    try {
      keyObject = createPrivateKey(config.auth.privateKey);
    } catch {
      throw new GoogleError('config_invalid', 'Google service-account private key could not be parsed');
    }
  }

  async function refresh() {
    const body = tokenRequestBody(config, now(), keyObject);
    const json = await postForm(config.endpoints.tokenUrl, body, 'token');
    if (!json || typeof json.access_token !== 'string') {
      throw new GoogleError('invalid_response', 'Google token endpoint returned no access_token', { operation: 'token' });
    }
    const lifetimeMs = Number(json.expires_in ?? 3600) * 1000;
    cached = { token: json.access_token, expiresAtMs: now() + lifetimeMs, scope: json.scope ?? null };
    return cached.token;
  }

  return {
    /** @returns {Promise<string>} */
    async getAccessToken() {
      if (cached && now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) return cached.token;
      if (!inflight) inflight = refresh().finally(() => (inflight = null));
      return inflight;
    },
    /** Forget the cached token (after a 401). */
    invalidate() {
      cached = null;
    },
    /** For diagnostics: granted scopes from the last token response. */
    grantedScopes() {
      return cached?.scope ? cached.scope.split(' ') : null;
    },
    /** Every access token handed out so far must be redacted; expose the current one. */
    currentToken() {
      return cached?.token ?? null;
    },
  };
}

/**
 * Consent URL for the per-user OAuth flow (offline access so Google returns a refresh token).
 * @param {{ clientId: string, redirectUri: string, scopes?: string[], state: string, loginHint?: string,
 *   codeChallenge?: string, authorizeUrl?: string }} input
 */
export function buildAuthorizationUrl(input) {
  const url = new URL(input.authorizeUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? []).join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', input.state);
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  if (input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}
