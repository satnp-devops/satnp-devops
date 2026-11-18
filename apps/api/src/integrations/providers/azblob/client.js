import { randomUUID } from 'node:crypto';
import {
  contentDisposition,
  encodeBlobPath,
  httpDateToIso,
  md5Base64,
  metadataFromHeaders,
  metadataHeaders,
  rangeHeader,
  toBuffer,
  validateAccessTier,
  validateBlobName,
  validateContainer,
} from './common.js';
import { parseConfig } from './config.js';
import { AzblobError } from './errors.js';
import { createHttp } from './http.js';
import { cachedTokenProvider, createManagedIdentityTokenProvider } from './identity.js';
import { generateServiceSas, generateUserDelegationSas, sasDate } from './sas.js';
import { signSharedKey } from './sharedKey.js';
import { buildKeyInfoXml, parseUserDelegationKeyXml } from './xml.js';

/**
 * Azure Blob Storage client over the REST API (no SDK). See docs/providers/azblob.md.
 *
 * Operations: putBlob (single-shot block blob), getBlob, getBlobProperties, deleteBlob,
 * createContainer (always private), getUserDelegationKey, createDownloadUrl (SAS).
 */

export const CAPABILITIES = Object.freeze([
  'put_blob',
  'get_blob',
  'head_blob',
  'delete_blob',
  'create_private_container',
  'signed_download_url',
  'range_read',
  'content_md5_check',
  'webhook_event_grid',
]);

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/**
 * @typedef {object} ClientDeps
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now] epoch ms
 * @property {{ debug?: Function, info?: Function, warn?: Function }} [logger]
 * @property {(ms: number) => Promise<void>} [sleep] for tests
 * @property {() => number} [random] for tests
 */

/**
 * @param {unknown} rawConfig validated with zod (see config.js)
 * @param {ClientDeps} [deps]
 */
export function createAzblobClient(rawConfig, deps = {}) {
  const cfg = parseConfig(rawConfig);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? {};
  const sharedKey = cfg.auth.type === 'sharedKey' ? cfg.auth.accountKey : null;

  let tokenProvider = null;
  const secrets = () => [sharedKey, tokenProvider?.currentToken?.()].filter(Boolean);
  const httpOptions = { fetch: fetchImpl, now, logger, sleep: deps.sleep, random: deps.random, secrets };
  const http = createHttp({
    ...httpOptions,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    retryBaseMs: cfg.retryBaseMs,
    retryMaxMs: cfg.retryMaxMs,
  });

  if (cfg.auth.type === 'managedIdentity') {
    // IMDS asks for at least ~1 s between retries; give identity calls a slower backoff.
    const identityHttp = createHttp({
      ...httpOptions,
      timeoutMs: cfg.timeoutMs,
      maxRetries: Math.max(cfg.maxRetries, 3),
      retryBaseMs: Math.max(cfg.retryBaseMs, 1000),
      retryMaxMs: Math.max(cfg.retryMaxMs, 30_000),
    });
    tokenProvider = createManagedIdentityTokenProvider(cfg.auth, { http: identityHttp, now });
  } else if (cfg.auth.type === 'token') {
    const getToken = cfg.auth.getToken;
    tokenProvider = cachedTokenProvider(async () => {
      const result = await getToken();
      if (!result?.token || !Number.isFinite(result.expiresOn)) {
        throw new AzblobError('getToken must return { token, expiresOn }', { kind: 'config' });
      }
      return result;
    }, now);
  }

  const container = (name) => validateContainer(name ?? cfg.defaultContainer);
  const blobUrl = (c, name, query = '') => `${cfg.blobEndpoint}/${c}/${encodeBlobPath(validateBlobName(name))}${query ? `?${query}` : ''}`;

  /** Base headers + x-ms-version + fresh x-ms-date + Authorization, built for every attempt. */
  function authorizer(method, url, base, contentLength) {
    return async () => {
      const headers = { ...base, 'x-ms-version': cfg.apiVersion, 'x-ms-date': new Date(now()).toUTCString() };
      if (sharedKey) {
        const signing = contentLength ? { ...headers, 'Content-Length': String(contentLength) } : headers;
        headers.Authorization = signSharedKey({ method, url, headers: signing, accountName: cfg.accountName, accountKey: sharedKey });
      } else {
        const { token } = await tokenProvider();
        headers.Authorization = `Bearer ${token}`;
      }
      return headers;
    };
  }

  /** Send, and on a 401 with a bearer token drop the cached token and try once more. */
  async function send(opts, base, body) {
    const run = () => http.send({ ...opts, body, headers: authorizer(opts.method, opts.url, base, body?.byteLength) });
    try {
      return await run();
    } catch (error) {
      if (tokenProvider && error instanceof AzblobError && error.status === 401) {
        tokenProvider.clear();
        return run();
      }
      throw error;
    }
  }

  function blobProperties(res, c, name) {
    const h = res.headers;
    const length = Number(h.get('content-length'));
    return {
      container: c,
      name,
      contentType: h.get('content-type'),
      contentDisposition: h.get('content-disposition'),
      contentEncoding: h.get('content-encoding'),
      contentLanguage: h.get('content-language'),
      cacheControl: h.get('cache-control'),
      contentLength: Number.isSafeInteger(length) ? length : null,
      contentMd5: h.get('content-md5'),
      etag: h.get('etag'),
      lastModified: httpDateToIso(h.get('last-modified')),
      blobType: h.get('x-ms-blob-type'),
      accessTier: h.get('x-ms-access-tier'),
      versionId: h.get('x-ms-version-id'),
      metadata: metadataFromHeaders(h),
      requestId: h.get('x-ms-request-id'),
    };
  }

  /**
   * Upload a whole block blob in one Put Blob call.
   * @param {{ container?: string, name: string, body: Buffer | Uint8Array | ArrayBuffer | string, contentType?: string,
   *   contentDisposition?: string, filename?: string, cacheControl?: string, contentEncoding?: string, contentLanguage?: string,
   *   metadata?: Record<string, string>, overwrite?: boolean, ifMatch?: string, accessTier?: string, clientRequestId?: string, signal?: AbortSignal }} input
   */
  async function putBlob(input) {
    const c = container(input.container);
    const url = blobUrl(c, input.name);
    const body = toBuffer(input.body);
    if (body.byteLength > cfg.maxUploadBytes) {
      throw new AzblobError(`Blob is ${body.byteLength} bytes; the limit for a single upload is ${cfg.maxUploadBytes}`, { kind: 'too_large' });
    }
    const md5 = md5Base64(body);
    const disposition = input.contentDisposition ?? (input.filename ? contentDisposition(input.filename) : undefined);
    const contentType = input.contentType ?? 'application/octet-stream';
    const base = {
      'Content-Type': contentType,
      'Content-MD5': md5,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': contentType,
      'x-ms-client-request-id': input.clientRequestId ?? randomUUID(),
      ...metadataHeaders(input.metadata),
    };
    if (disposition) base['x-ms-blob-content-disposition'] = disposition;
    if (input.cacheControl) base['x-ms-blob-cache-control'] = input.cacheControl;
    if (input.contentEncoding) base['x-ms-blob-content-encoding'] = input.contentEncoding;
    if (input.contentLanguage) base['x-ms-blob-content-language'] = input.contentLanguage;
    if (validateAccessTier(input.accessTier)) base['x-ms-access-tier'] = input.accessTier;
    if (input.overwrite === false) base['If-None-Match'] = '*';
    if (input.ifMatch) base['If-Match'] = input.ifMatch;

    let res;
    try {
      // Put Blob replaces the whole blob with the same bytes, so a retry is safe.
      res = await send({ operation: 'putBlob', method: 'PUT', url, expect: [201], idempotent: true, signal: input.signal }, base, body);
    } catch (error) {
      // A conditional upload whose first attempt succeeded but whose response was lost comes
      // back 409/412 on the retry. If the stored bytes are ours, report success.
      const lostSuccess = error instanceof AzblobError && error.attempts > 1 && ['conflict', 'precondition'].includes(error.kind);
      if (lostSuccess) {
        const existing = await getBlobProperties({ container: c, name: input.name, signal: input.signal }).catch(() => null);
        if (existing?.contentMd5 === md5) {
          const { etag, lastModified, versionId, requestId } = existing;
          return { container: c, name: input.name, etag, lastModified, contentMd5: md5, versionId, size: body.byteLength, requestId, reconciled: true };
        }
      }
      throw error;
    }
    return {
      container: c,
      name: input.name,
      etag: res.headers.get('etag'),
      lastModified: httpDateToIso(res.headers.get('last-modified')),
      contentMd5: res.headers.get('content-md5') ?? md5,
      versionId: res.headers.get('x-ms-version-id'),
      size: body.byteLength,
      requestId: res.headers.get('x-ms-request-id'),
    };
  }

  /**
   * Download a blob (or a byte range of it) into memory.
   * @param {{ container?: string, name: string, range?: { offset: number, count?: number }, ifMatch?: string, signal?: AbortSignal }} input
   */
  async function getBlob(input) {
    const c = container(input.container);
    const url = blobUrl(c, input.name);
    const base = { 'x-ms-client-request-id': randomUUID() };
    const range = rangeHeader(input.range);
    if (range) base['x-ms-range'] = range;
    if (input.ifMatch) base['If-Match'] = input.ifMatch;
    const res = await send({ operation: 'getBlob', method: 'GET', url, expect: [200, 206], idempotent: true, signal: input.signal }, base);
    const body = Buffer.from(await res.arrayBuffer());
    const props = blobProperties(res, c, input.name);
    // For a full read, Content-MD5 is the stored hash of the whole blob; check what we received.
    if (res.status === 200 && props.contentMd5 && md5Base64(body) !== props.contentMd5) {
      throw new AzblobError('getBlob body does not match Content-MD5', { kind: 'server', retryable: true, requestId: props.requestId });
    }
    return { ...props, body, contentLength: body.byteLength, partial: res.status === 206 };
  }

  /** @param {{ container?: string, name: string, signal?: AbortSignal }} input */
  async function getBlobProperties(input) {
    const c = container(input.container);
    const url = blobUrl(c, input.name);
    const res = await send({ operation: 'getBlobProperties', method: 'HEAD', url, expect: [200], idempotent: true, signal: input.signal }, { 'x-ms-client-request-id': randomUUID() });
    return blobProperties(res, c, input.name);
  }

  /**
   * @param {{ container?: string, name: string, deleteSnapshots?: 'include' | 'only', ifMatch?: string, ignoreMissing?: boolean, signal?: AbortSignal }} input
   * @returns {Promise<{ deleted: boolean, requestId: string | null }>}
   */
  async function deleteBlob(input) {
    const c = container(input.container);
    const url = blobUrl(c, input.name);
    const base = { 'x-ms-client-request-id': randomUUID() };
    if (input.deleteSnapshots) {
      if (!['include', 'only'].includes(input.deleteSnapshots)) throw new AzblobError('deleteSnapshots must be include or only', { kind: 'validation' });
      base['x-ms-delete-snapshots'] = input.deleteSnapshots;
    }
    if (input.ifMatch) base['If-Match'] = input.ifMatch;
    try {
      const res = await send({ operation: 'deleteBlob', method: 'DELETE', url, expect: [202], idempotent: true, signal: input.signal }, base);
      return { deleted: true, requestId: res.headers.get('x-ms-request-id') };
    } catch (error) {
      // A retried delete whose first attempt succeeded also lands here as 404.
      if (error instanceof AzblobError && error.kind === 'not_found' && (input.ignoreMissing ?? true)) {
        return { deleted: false, requestId: error.requestId ?? null };
      }
      throw error;
    }
  }

  /**
   * Create a private container (no x-ms-blob-public-access header means no anonymous access).
   * @param {{ container?: string, ignoreExisting?: boolean, signal?: AbortSignal }} [input]
   */
  async function createContainer(input = {}) {
    const c = container(input.container);
    const url = `${cfg.blobEndpoint}/${c}?restype=container`;
    try {
      await send({ operation: 'createContainer', method: 'PUT', url, expect: [201], idempotent: true, signal: input.signal }, { 'x-ms-client-request-id': randomUUID() });
      return { container: c, created: true };
    } catch (error) {
      if (error instanceof AzblobError && error.status === 409 && error.azureCode === 'ContainerAlreadyExists' && (input.ignoreExisting ?? true)) {
        return { container: c, created: false };
      }
      throw error;
    }
  }

  let delegationKey = null;
  let delegationKeyInflight = null;

  /**
   * Get (and cache) a user delegation key valid until at least `validUntil` (max 7 days ahead).
   * @param {{ validUntil?: number, delegatedUserTenantId?: string, signal?: AbortSignal, retried?: boolean }} [input]
   * @returns {Promise<import('./sas.js').UserDelegationKey>}
   */
  async function getUserDelegationKey(input = {}) {
    if (sharedKey) throw new AzblobError('User delegation keys need Entra ID auth (managedIdentity or token)', { kind: 'config' });
    const t = now();
    const validUntil = input.validUntil ?? t + cfg.maxDownloadUrlTtlSeconds * 1000;
    if (validUntil > t + SEVEN_DAYS_MS - 60_000) throw new AzblobError('User delegation keys last at most 7 days', { kind: 'validation' });
    const fits = (key) =>
      key &&
      Date.parse(key.signedExpiry) >= validUntil &&
      Date.parse(key.signedStart) <= t &&
      key.delegatedUserTenantId === input.delegatedUserTenantId;
    if (fits(delegationKey)) return delegationKey;
    if (!delegationKeyInflight) {
      // Ask for at least a day (reused across many links), never beyond Azure's 7-day limit.
      const start = sasDate(t - cfg.sasClockSkewSeconds * 1000);
      const expiry = sasDate(Math.min(t + SEVEN_DAYS_MS - 60_000, Math.max(validUntil + 3600_000, t + DAY_MS)));
      const url = `${cfg.blobEndpoint}/?restype=service&comp=userdelegationkey`;
      const xml = Buffer.from(buildKeyInfoXml({ start, expiry, delegatedUserTenantId: input.delegatedUserTenantId }), 'utf8');
      const opts = { operation: 'getUserDelegationKey', method: 'POST', url, expect: [200], idempotent: true, signal: input.signal };
      delegationKeyInflight = send(opts, { 'Content-Type': 'application/xml', 'x-ms-client-request-id': randomUUID() }, xml)
        .then(async (res) => {
          const key = parseUserDelegationKeyXml(await res.text());
          if (!key.value || !key.signedObjectId || !key.signedExpiry) throw new AzblobError('User delegation key response was incomplete', { kind: 'server' });
          delegationKey = { ...key, delegatedUserTenantId: input.delegatedUserTenantId };
          return delegationKey;
        })
        .finally(() => {
          delegationKeyInflight = null;
        });
    }
    const key = await delegationKeyInflight;
    if (!fits(key)) {
      // Another caller started a fetch for a shorter window; fetch once more for ours.
      if (input.retried) throw new AzblobError('User delegation key does not cover the requested expiry', { kind: 'server' });
      return getUserDelegationKey({ ...input, retried: true });
    }
    return key;
  }

  /**
   * Time-limited URL for a private blob: service SAS with Shared Key, user delegation SAS with Entra ID.
   * @param {{ container?: string, name: string, expiresInSeconds?: number, permissions?: string, filename?: string, inline?: boolean,
   *   contentDisposition?: string, contentType?: string, cacheControl?: string, ipRange?: string, correlationId?: string,
   *   delegatedUserObjectId?: string, delegatedUserTenantId?: string, signal?: AbortSignal }} input
   * @returns {Promise<{ url: string, expiresAt: string, startsAt: string, sasKind: 'service' | 'user_delegation' }>}
   */
  async function createDownloadUrl(input) {
    const c = container(input.container);
    validateBlobName(input.name);
    const ttl = input.expiresInSeconds ?? cfg.downloadUrlTtlSeconds;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > cfg.maxDownloadUrlTtlSeconds) {
      throw new AzblobError(`expiresInSeconds must be 1..${cfg.maxDownloadUrlTtlSeconds}`, { kind: 'validation' });
    }
    const t = now();
    const common = {
      accountName: cfg.accountName,
      container: c,
      blob: input.name,
      permissions: input.permissions ?? 'r',
      // SAS times have one-second precision; round so the reported expiry is the real one.
      startsOn: Math.floor((t - cfg.sasClockSkewSeconds * 1000) / 1000) * 1000,
      expiresOn: Math.floor((t + ttl * 1000) / 1000) * 1000,
      version: cfg.sasVersion,
      protocol: cfg.blobEndpoint.startsWith('https://') ? 'https' : undefined,
      ipRange: input.ipRange,
      contentDisposition: input.contentDisposition ?? (input.filename ? contentDisposition(input.filename, { inline: input.inline }) : undefined),
      contentType: input.contentType,
      cacheControl: input.cacheControl,
    };
    let token;
    let sasKind;
    if (sharedKey) {
      ({ token } = generateServiceSas({ ...common, accountKey: sharedKey }));
      sasKind = 'service';
    } else {
      const userDelegationKey = await getUserDelegationKey({ validUntil: common.expiresOn, delegatedUserTenantId: input.delegatedUserTenantId, signal: input.signal });
      ({ token } = generateUserDelegationSas({ ...common, userDelegationKey, correlationId: input.correlationId, delegatedUserObjectId: input.delegatedUserObjectId }));
      sasKind = 'user_delegation';
    }
    return { url: blobUrl(c, input.name, token), expiresAt: new Date(common.expiresOn).toISOString(), startsAt: new Date(common.startsOn).toISOString(), sasKind };
  }

  return {
    provider: 'azblob',
    kind: 'storage',
    capabilities: CAPABILITIES,
    accountName: cfg.accountName,
    blobEndpoint: cfg.blobEndpoint,
    authType: cfg.auth.type,
    putBlob,
    getBlob,
    getBlobProperties,
    deleteBlob,
    createContainer,
    getUserDelegationKey,
    createDownloadUrl,
  };
}
