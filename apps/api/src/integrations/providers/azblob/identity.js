import { AzblobError } from './errors.js';

/**
 * Entra ID access tokens for Azure Storage from a managed identity.
 *
 * - Azure VMs, VM scale sets, AKS (pod-managed), Container Apps without IDENTITY_ENDPOINT:
 *   IMDS  GET http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=...
 *   header Metadata: true; optional client_id | object_id | msi_res_id.
 * - App Service / Functions (and Container Apps, which expose the same variables):
 *   GET $IDENTITY_ENDPOINT?resource=...&api-version=2019-08-01, header X-IDENTITY-HEADER: $IDENTITY_HEADER;
 *   optional client_id | principal_id | mi_res_id.
 *
 * Response JSON: { access_token, expires_on: "<epoch seconds>", expires_in?: "<seconds>", token_type: "Bearer" }.
 * IMDS guidance: retry 404, 410, 429 and 5xx with exponential backoff; other 4xx are permanent.
 * Tokens are cached and refreshed five minutes before expiry; concurrent callers share one fetch.
 */

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** IMDS-specific retry rules (Microsoft Learn, how-to-use-vm-token, "Retry guidance"). */
export function classifyIdentityStatus(status) {
  if (status === 404 || status === 410 || status === 429 || status >= 500) {
    return { kind: status === 429 ? 'throttled' : 'server', retryable: true };
  }
  if (status === 400 || status === 401 || status === 403) return { kind: 'auth', retryable: false };
  return { kind: 'unknown', retryable: false };
}

function parseIdentityError(text) {
  try {
    const body = JSON.parse(text);
    return { code: typeof body.error === 'string' ? body.error : undefined };
  } catch {
    return {};
  }
}

/**
 * Build the token request for the configured hosting environment.
 * @param {import('./config.js').AzblobConfig['auth'] & { type: 'managedIdentity' }} auth
 * @returns {{ url: string, headers: Record<string, string> }}
 */
export function buildIdentityRequest(auth) {
  const appService = Boolean(auth.identityEndpoint);
  const params = new URLSearchParams();
  params.set('api-version', appService ? '2019-08-01' : '2018-02-01');
  params.set('resource', auth.resource);
  if (auth.clientId) params.set('client_id', auth.clientId);
  if (auth.objectId) params.set(appService ? 'principal_id' : 'object_id', auth.objectId);
  if (auth.resourceId) params.set(appService ? 'mi_res_id' : 'msi_res_id', auth.resourceId);
  const base = appService ? auth.identityEndpoint : auth.imdsEndpoint;
  const url = `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
  const headers = appService ? { 'X-IDENTITY-HEADER': auth.identityHeader } : { Metadata: 'true' };
  return { url, headers };
}

/**
 * @param {object} json token endpoint response
 * @param {number} nowMs
 * @returns {{ token: string, expiresOn: number }}
 */
export function parseTokenResponse(json, nowMs) {
  const token = json?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new AzblobError('Managed identity response had no access_token', { kind: 'auth' });
  }
  const expiresOnSeconds = Number(json.expires_on);
  const expiresInSeconds = Number(json.expires_in);
  let expiresOn;
  if (Number.isFinite(expiresOnSeconds) && expiresOnSeconds > 0) expiresOn = expiresOnSeconds * 1000;
  else if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) expiresOn = nowMs + expiresInSeconds * 1000;
  else expiresOn = nowMs + 5 * 60 * 1000;
  return { token, expiresOn };
}

/**
 * Cached token provider: () => Promise<{ token, expiresOn }>.
 * @param {() => Promise<{ token: string, expiresOn: number }>} fetchToken
 * @param {() => number} now
 */
export function cachedTokenProvider(fetchToken, now) {
  let current = null;
  let inflight = null;
  const provider = async () => {
    if (current && current.expiresOn - REFRESH_MARGIN_MS > now()) return current;
    if (!inflight) {
      inflight = fetchToken()
        .then((fresh) => {
          current = fresh;
          return fresh;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
  provider.currentToken = () => current?.token;
  provider.clear = () => {
    current = null;
  };
  return provider;
}

/**
 * @param {import('./config.js').AzblobConfig['auth'] & { type: 'managedIdentity' }} auth
 * @param {{ http: ReturnType<typeof import('./http.js').createHttp>, now: () => number }} deps
 */
export function createManagedIdentityTokenProvider(auth, { http, now }) {
  const { url, headers } = buildIdentityRequest(auth);
  return cachedTokenProvider(async () => {
    const res = await http.send({
      operation: 'getManagedIdentityToken',
      method: 'GET',
      url,
      headers: () => ({ ...headers, Accept: 'application/json' }),
      expect: [200],
      idempotent: true,
      parseError: parseIdentityError,
      classify: classifyIdentityStatus,
    });
    let json;
    try {
      json = await res.json();
    } catch (error) {
      throw new AzblobError('Managed identity response was not JSON', { kind: 'auth', cause: error });
    }
    return parseTokenResponse(json, now());
  }, now);
}
