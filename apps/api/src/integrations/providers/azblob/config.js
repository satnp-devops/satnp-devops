import { z } from 'zod';
import { AzblobError } from './errors.js';

/**
 * Configuration for the Azure Blob Storage client.
 *
 * Two ways to authenticate:
 * - managedIdentity (production): no secret stored anywhere. The app's Azure managed identity gets
 *   an Entra ID token from IMDS (VMs, AKS, Container Apps) or the App Service identity endpoint.
 *   Downloads use a user delegation SAS signed with a key fetched by that identity.
 * - sharedKey (Azurite / local dev, or accounts that still allow Shared Key): the account key signs
 *   every request and every service SAS.
 * - token: bring your own token function (workload identity federation, Azure CLI, tests).
 */

/** Latest version fully deployed in every region as of 2026-10-29 (Microsoft Learn versioning page). */
export const DEFAULT_API_VERSION = '2026-04-06';

/** Well-known Azurite development account (published in the Azurite README; not a secret). */
export const AZURITE_ACCOUNT = Object.freeze({
  accountName: 'devstoreaccount1',
  accountKey: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
  blobEndpoint: 'http://127.0.0.1:10000/devstoreaccount1',
});

const version = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a REST version like 2026-04-06');
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Must be a GUID');
export const containerName = z
  .string()
  .regex(/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Container names are 3-63 lowercase letters, digits or single hyphens');

const sharedKeyAuth = z.object({
  type: z.literal('sharedKey'),
  accountKey: z
    .string()
    .min(16)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Account key must be base64'),
});

const managedIdentityAuth = z.object({
  type: z.literal('managedIdentity'),
  /** User-assigned identity selectors; set at most one. Omit all for the system-assigned identity. */
  clientId: guid.optional(),
  objectId: guid.optional(),
  resourceId: z.string().startsWith('/subscriptions/').optional(),
  /** App Service / Functions: values of IDENTITY_ENDPOINT and IDENTITY_HEADER. Omit to use IMDS. */
  identityEndpoint: z.url().optional(),
  identityHeader: z.string().min(1).optional(),
  /** Override only for tests; the real IMDS address is fixed. */
  imdsEndpoint: z.url().default('http://169.254.169.254/metadata/identity/oauth2/token'),
  /** Entra resource for Azure Storage tokens. */
  resource: z.string().default('https://storage.azure.com/'),
});

const tokenAuth = z.object({
  type: z.literal('token'),
  /** async () => ({ token, expiresOn: epoch ms }) */
  getToken: z.custom((value) => typeof value === 'function', 'getToken must be a function'),
});

export const configSchema = z
  .object({
    accountName: z.string().regex(/^[a-z0-9]{3,24}$/, 'Storage account names are 3-24 lowercase letters or digits'),
    auth: z.discriminatedUnion('type', [sharedKeyAuth, managedIdentityAuth, tokenAuth]),
    /** Defaults to https://<account>.blob.core.windows.net. Azurite: http://127.0.0.1:10000/devstoreaccount1 */
    blobEndpoint: z.url().optional(),
    defaultContainer: containerName.optional(),
    apiVersion: version.default(DEFAULT_API_VERSION),
    /** signedVersion (sv) for SAS tokens this client creates. */
    sasVersion: version.default(DEFAULT_API_VERSION),
    timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
    maxRetries: z.number().int().min(0).max(10).default(3),
    retryBaseMs: z.number().int().min(1).max(60_000).default(500),
    retryMaxMs: z.number().int().min(1).max(120_000).default(8_000),
    /** Single Put Blob upper bound we accept (Azure allows 5,000 MiB; the body is held in memory). */
    maxUploadBytes: z.number().int().positive().max(5000 * 1024 * 1024).default(256 * 1024 * 1024),
    downloadUrlTtlSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(900),
    maxDownloadUrlTtlSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(24 * 3600),
    /** Back-date SAS start time to absorb clock skew between us and Azure. */
    sasClockSkewSeconds: z.number().int().min(0).max(3600).default(300),
    /** Allow an http:// endpoint (Azurite only). Production must be https. */
    allowInsecureHttp: z.boolean().default(false),
  })
  .superRefine((cfg, ctx) => {
    const ids = ['clientId', 'objectId', 'resourceId'].filter((k) => cfg.auth.type === 'managedIdentity' && cfg.auth[k]);
    if (ids.length > 1) ctx.addIssue({ code: 'custom', path: ['auth'], message: 'Set only one of clientId, objectId, resourceId' });
    if (cfg.auth.type === 'managedIdentity' && Boolean(cfg.auth.identityEndpoint) !== Boolean(cfg.auth.identityHeader)) {
      ctx.addIssue({ code: 'custom', path: ['auth'], message: 'identityEndpoint and identityHeader go together' });
    }
    if (cfg.blobEndpoint?.startsWith('http://') && !cfg.allowInsecureHttp) {
      ctx.addIssue({ code: 'custom', path: ['blobEndpoint'], message: 'http endpoints need allowInsecureHttp (Azurite only)' });
    }
    if (cfg.blobEndpoint?.startsWith('http://') && cfg.auth.type !== 'sharedKey') {
      ctx.addIssue({ code: 'custom', path: ['auth'], message: 'Bearer tokens must only be sent over https' });
    }
    if (cfg.downloadUrlTtlSeconds > cfg.maxDownloadUrlTtlSeconds) {
      ctx.addIssue({ code: 'custom', path: ['downloadUrlTtlSeconds'], message: 'Must not exceed maxDownloadUrlTtlSeconds' });
    }
  });

/** @typedef {z.infer<typeof configSchema>} AzblobConfig */

/**
 * Validate config. Errors name the field but never echo the value (it may be a key).
 * @param {unknown} input
 * @returns {AzblobConfig & { blobEndpoint: string }}
 */
export function parseConfig(input) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new AzblobError(`Invalid azblob config: ${fields}`, { kind: 'config' });
  }
  const cfg = parsed.data;
  const blobEndpoint = (cfg.blobEndpoint ?? `https://${cfg.accountName}.blob.core.windows.net`).replace(/\/+$/, '');
  return { ...cfg, blobEndpoint };
}

/**
 * Turn an Azure Storage connection string into config fields ({ accountName, auth, blobEndpoint }).
 * Supports AccountName/AccountKey/BlobEndpoint/DefaultEndpointsProtocol/EndpointSuffix and
 * UseDevelopmentStorage=true (Azurite).
 * @param {string} connectionString
 */
export function parseConnectionString(connectionString) {
  const parts = {};
  for (const piece of String(connectionString).split(';')) {
    const at = piece.indexOf('=');
    if (at > 0) parts[piece.slice(0, at).trim().toLowerCase()] = piece.slice(at + 1).trim();
  }
  if (parts.usedevelopmentstorage === 'true') {
    return {
      accountName: AZURITE_ACCOUNT.accountName,
      auth: { type: 'sharedKey', accountKey: AZURITE_ACCOUNT.accountKey },
      blobEndpoint: AZURITE_ACCOUNT.blobEndpoint,
      allowInsecureHttp: true,
    };
  }
  if (!parts.accountname || !parts.accountkey) {
    throw new AzblobError('Connection string needs AccountName and AccountKey', { kind: 'config' });
  }
  const protocol = parts.defaultendpointsprotocol || 'https';
  const suffix = parts.endpointsuffix || 'core.windows.net';
  const blobEndpoint = parts.blobendpoint || `${protocol}://${parts.accountname}.blob.${suffix}`;
  return {
    accountName: parts.accountname,
    auth: { type: 'sharedKey', accountKey: parts.accountkey },
    blobEndpoint,
    allowInsecureHttp: blobEndpoint.startsWith('http://'),
  };
}
