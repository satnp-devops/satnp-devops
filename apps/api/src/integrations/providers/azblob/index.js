/**
 * Azure Blob Storage provider (kind: storage). Dependency-free REST client.
 *
 *   import { createAzblobClient, createLocalDiskStorage, verifyWebhook, parseWebhook } from '.../providers/azblob/index.js';
 *
 *   const storage = createAzblobClient(
 *     { accountName: 'phoenixdocs', auth: { type: 'managedIdentity' }, defaultContainer: 'admissions' },
 *     { fetch, now: Date.now, logger },
 *   );
 *   await storage.putBlob({ name: 'g/123/marksheet.pdf', body, contentType: 'application/pdf', filename: 'Marksheet.pdf' });
 *   const { url } = await storage.createDownloadUrl({ name: 'g/123/marksheet.pdf', expiresInSeconds: 600 });
 *
 * Both createAzblobClient and createLocalDiskStorage return the same shape:
 *   { provider, kind: 'storage', capabilities, putBlob, getBlob, getBlobProperties, deleteBlob,
 *     createContainer, createDownloadUrl }
 * See docs/providers/azblob.md for config fields, auth options, limits and webhook setup.
 */

export { createAzblobClient, CAPABILITIES } from './client.js';
export { createLocalDiskStorage } from './localDisk.js';
export { configSchema, parseConfig, parseConnectionString, AZURITE_ACCOUNT, DEFAULT_API_VERSION } from './config.js';
export { AzblobError, classifyStatus, redact } from './errors.js';
export {
  buildSharedKeyStringToSign,
  canonicalizeHeaders,
  canonicalizeResource,
  hmacSha256Base64,
  signSharedKey,
} from './sharedKey.js';
export {
  buildServiceSasStringToSign,
  buildUserDelegationSasStringToSign,
  generateServiceSas,
  generateUserDelegationSas,
  normalisePermissions,
  sasCanonicalResource,
  sasDate,
} from './sas.js';
export { buildIdentityRequest, parseTokenResponse } from './identity.js';
export {
  abuseProtectionResponse,
  EVENT_GRID_ORIGIN,
  parseBlobSubject,
  parseWebhook,
  safeEqual,
  subscriptionValidationResponse,
  verifyEntraBearer,
  verifyWebhook,
  WEBHOOK_SECRET_HEADER,
} from './webhook.js';
export { contentDisposition, encodeBlobPath, validateBlobName, validateContainer } from './common.js';
