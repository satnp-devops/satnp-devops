import { AzblobError } from './errors.js';
import { hmacSha256Base64 } from './sharedKey.js';

/**
 * Shared access signatures for time-limited blob downloads (and uploads, if ever needed).
 *
 * Sources (Microsoft Learn, both pages updated 2026-11-03, checked 2026-11-05):
 * - "Create a service SAS": the 2020-12-06 string-to-sign is the newest for Blob; the JS SDK
 *   (BlobSASSignatureValues.ts) uses it for every signedVersion >= 2020-12-06.
 * - "Create a user delegation SAS": three Blob formats we support, chosen by signedVersion:
 *   2020-12-06, 2025-07-05 (adds skdutid + sduoid) and 2026-04-06 (adds the srh/srq lines).
 *
 * This module does not emit srh/srq (signed request headers / query parameters); for
 * sv >= 2026-04-06 their string-to-sign lines are the empty string, as the docs require.
 */

const BLOB_PERMISSION_ORDER = 'racwd';

/** ISO 8601 UTC without milliseconds, e.g. 2026-11-05T10:00:00Z (accepted by Azure). */
export function sasDate(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Validate and re-order permission letters ("wr" -> "rw"). Only blob permissions r, a, c, w, d.
 * @param {string} permissions
 */
export function normalisePermissions(permissions) {
  const letters = new Set(String(permissions));
  for (const ch of letters) {
    if (!BLOB_PERMISSION_ORDER.includes(ch)) {
      throw new AzblobError(`Unsupported SAS permission "${ch}" (use r, a, c, w, d)`, { kind: 'validation' });
    }
  }
  const ordered = [...BLOB_PERMISSION_ORDER].filter((ch) => letters.has(ch)).join('');
  if (!ordered) throw new AzblobError('SAS needs at least one permission', { kind: 'validation' });
  return ordered;
}

/**
 * canonicalizedResource for blob SAS: "/blob/<account>/<container>[/<blob>]", URL-decoded.
 * @param {string} accountName
 * @param {string} container
 * @param {string} [blob]
 */
export function sasCanonicalResource(accountName, container, blob) {
  return blob ? `/blob/${accountName}/${container}/${blob}` : `/blob/${accountName}/${container}`;
}

function checkTimes(startsOn, expiresOn) {
  if (!Number.isFinite(expiresOn)) throw new AzblobError('SAS expiry is required', { kind: 'validation' });
  if (startsOn !== undefined && startsOn >= expiresOn) {
    throw new AzblobError('SAS start must be before its expiry', { kind: 'validation' });
  }
}

function checkVersion(version, minimum, what) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version) || version < minimum) {
    throw new AzblobError(`${what} needs signedVersion ${minimum} or later`, { kind: 'validation' });
  }
}

/**
 * @typedef {object} SasCommon
 * @property {string} accountName
 * @property {string} container
 * @property {string} [blob] omit for a container SAS (sr=c)
 * @property {string} permissions
 * @property {number} [startsOn] epoch ms
 * @property {number} expiresOn epoch ms
 * @property {string} version signedVersion (sv)
 * @property {string} [ipRange] "198.51.100.10" or "198.51.100.10-198.51.100.20"
 * @property {'https' | 'https,http'} [protocol]
 * @property {string} [encryptionScope]
 * @property {string} [cacheControl] rscc
 * @property {string} [contentDisposition] rscd
 * @property {string} [contentEncoding] rsce
 * @property {string} [contentLanguage] rscl
 * @property {string} [contentType] rsct
 */

/** Fields shared by both SAS kinds, with optional values defaulted to "". */
function commonFields(input) {
  checkTimes(input.startsOn, input.expiresOn);
  return {
    permissions: normalisePermissions(input.permissions),
    start: input.startsOn === undefined ? '' : sasDate(input.startsOn),
    expiry: sasDate(input.expiresOn),
    resource: input.blob ? 'b' : 'c',
    canonicalizedResource: sasCanonicalResource(input.accountName, input.container, input.blob),
    ip: input.ipRange ?? '',
    protocol: input.protocol ?? '',
    version: input.version,
    encryptionScope: input.encryptionScope ?? '',
    rscc: input.cacheControl ?? '',
    rscd: input.contentDisposition ?? '',
    rsce: input.contentEncoding ?? '',
    rscl: input.contentLanguage ?? '',
    rsct: input.contentType ?? '',
  };
}

/** Build the query string from ordered [name, value] pairs, skipping empty optional values. */
function toQuery(pairs) {
  return pairs
    .filter(([, value]) => value !== '' && value !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
}

function responseOverrides(f) {
  return [
    ['rscc', f.rscc],
    ['rscd', f.rscd],
    ['rsce', f.rsce],
    ['rscl', f.rscl],
    ['rsct', f.rsct],
  ];
}

/**
 * Service SAS string-to-sign (Blob, signedVersion 2020-12-06 and later).
 * @param {ReturnType<typeof commonFields> & { identifier?: string, snapshotTime?: string }} f
 */
export function buildServiceSasStringToSign(f) {
  return [
    f.permissions,
    f.start,
    f.expiry,
    f.canonicalizedResource,
    f.identifier ?? '',
    f.ip,
    f.protocol,
    f.version,
    f.resource,
    f.snapshotTime ?? '',
    f.encryptionScope,
    f.rscc,
    f.rscd,
    f.rsce,
    f.rscl,
    f.rsct,
  ].join('\n');
}

/**
 * Service SAS signed with the account key.
 * @param {SasCommon & { accountKey: string, identifier?: string }} input
 * @returns {{ token: string, stringToSign: string, signature: string }}
 */
export function generateServiceSas(input) {
  checkVersion(input.version, '2020-12-06', 'Service SAS');
  const f = { ...commonFields(input), identifier: input.identifier ?? '' };
  const stringToSign = buildServiceSasStringToSign(f);
  const signature = hmacSha256Base64(stringToSign, input.accountKey);
  const token = toQuery([
    ['sv', f.version],
    ['spr', f.protocol],
    ['st', f.start],
    ['se', f.expiry],
    ['sr', f.resource],
    ['sp', f.permissions],
    ['sip', f.ip],
    ['si', f.identifier],
    ['ses', f.encryptionScope],
    ...responseOverrides(f),
    ['sig', signature],
  ]);
  return { token, stringToSign, signature };
}

/**
 * @typedef {object} UserDelegationKey  as returned by Get User Delegation Key
 * @property {string} signedObjectId
 * @property {string} signedTenantId
 * @property {string} signedStart
 * @property {string} signedExpiry
 * @property {string} signedService
 * @property {string} signedVersion
 * @property {string} [signedDelegatedUserTenantId]
 * @property {string} value base64 key
 */

/**
 * User delegation SAS string-to-sign. The layout depends on signedVersion.
 * @param {ReturnType<typeof commonFields> & { key: UserDelegationKey, authorizedObjectId?: string, unauthorizedObjectId?: string, correlationId?: string, delegatedUserObjectId?: string }} f
 */
export function buildUserDelegationSasStringToSign(f) {
  const v = f.version;
  const lines = [
    f.permissions,
    f.start,
    f.expiry,
    f.canonicalizedResource,
    f.key.signedObjectId,
    f.key.signedTenantId,
    f.key.signedStart,
    f.key.signedExpiry,
    f.key.signedService,
    f.key.signedVersion,
    f.authorizedObjectId ?? '',
    f.unauthorizedObjectId ?? '',
    f.correlationId ?? '',
  ];
  if (v >= '2025-07-05') lines.push(f.key.signedDelegatedUserTenantId ?? '', f.delegatedUserObjectId ?? '');
  lines.push(f.ip, f.protocol, f.version, f.resource, '' /* signedSnapshotTime */, f.encryptionScope);
  if (v >= '2026-04-06') lines.push('' /* canonicalizedSignedRequestHeaders */, '' /* ...QueryParameters */);
  lines.push(f.rscc, f.rscd, f.rsce, f.rscl, f.rsct);
  return lines.join('\n');
}

/**
 * User delegation SAS signed with a key obtained through Entra ID (no account key involved).
 * @param {SasCommon & { userDelegationKey: UserDelegationKey, authorizedObjectId?: string, unauthorizedObjectId?: string, correlationId?: string, delegatedUserObjectId?: string }} input
 * @returns {{ token: string, stringToSign: string, signature: string }}
 */
export function generateUserDelegationSas(input) {
  checkVersion(input.version, '2020-12-06', 'User delegation SAS');
  const key = input.userDelegationKey;
  if (!key?.value || !key.signedObjectId || !key.signedTenantId) {
    throw new AzblobError('A user delegation key is required', { kind: 'validation' });
  }
  if (input.expiresOn > Date.parse(key.signedExpiry)) {
    throw new AzblobError('SAS expiry is after the user delegation key expiry', { kind: 'validation' });
  }
  const f = {
    ...commonFields(input),
    key,
    authorizedObjectId: input.authorizedObjectId,
    unauthorizedObjectId: input.unauthorizedObjectId,
    correlationId: input.correlationId,
    delegatedUserObjectId: input.version >= '2025-07-05' ? input.delegatedUserObjectId : undefined,
  };
  const stringToSign = buildUserDelegationSasStringToSign(f);
  const signature = hmacSha256Base64(stringToSign, key.value);
  const userBound = input.version >= '2025-07-05';
  const token = toQuery([
    ['sv', f.version],
    ['spr', f.protocol],
    ['st', f.start],
    ['se', f.expiry],
    ['skoid', key.signedObjectId],
    ['sktid', key.signedTenantId],
    ['skt', key.signedStart],
    ['ske', key.signedExpiry],
    ['sks', key.signedService],
    ['skv', key.signedVersion],
    ['skdutid', userBound ? (key.signedDelegatedUserTenantId ?? '') : ''],
    ['sduoid', f.delegatedUserObjectId ?? ''],
    ['saoid', f.authorizedObjectId ?? ''],
    ['suoid', f.unauthorizedObjectId ?? ''],
    ['scid', f.correlationId ?? ''],
    ['sr', f.resource],
    ['sp', f.permissions],
    ['sip', f.ip],
    ['ses', f.encryptionScope],
    ...responseOverrides(f),
    ['sig', signature],
  ]);
  return { token, stringToSign, signature };
}
