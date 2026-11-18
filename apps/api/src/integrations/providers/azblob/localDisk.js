import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  contentDisposition,
  encodeBlobPath,
  md5Base64,
  toBuffer,
  validateAccessTier,
  validateBlobName,
  validateContainer,
} from './common.js';
import { containerName } from './config.js';
import { AzblobError } from './errors.js';
import { safeEqual } from './webhook.js';

/**
 * Local-disk storage with the same interface as createAzblobClient, for development and tests.
 *
 * Layout: <rootDir>/<container>/<sha256(blob name)>.bin plus a .json sidecar with properties.
 * Hashing the name means no blob name can escape rootDir and Windows path limits never bite.
 * Download URLs are HMAC-signed (signingSecret) and expire; a dev-only route calls
 * verifyDownloadUrl() / readDownload() to serve them. Same errors (kind, status, azureCode)
 * as Azure for the cases the CRM relies on: missing container/blob, create-only conflicts, If-Match.
 */

const localConfigSchema = z.object({
  rootDir: z.string().min(1),
  /** Where the dev download route is mounted, e.g. http://localhost:4000/dev-storage */
  baseUrl: z.url(),
  signingSecret: z.string().min(32),
  defaultContainer: containerName.optional(),
  maxUploadBytes: z.number().int().positive().default(256 * 1024 * 1024),
  downloadUrlTtlSeconds: z.number().int().min(1).default(900),
  maxDownloadUrlTtlSeconds: z.number().int().min(60).default(24 * 3600),
});

const notFound = (what) =>
  new AzblobError(`${what === 'container' ? 'ContainerNotFound' : 'BlobNotFound'}`, {
    kind: 'not_found',
    status: 404,
    azureCode: what === 'container' ? 'ContainerNotFound' : 'BlobNotFound',
  });

/**
 * @param {unknown} rawConfig
 * @param {{ now?: () => number }} [deps]
 */
export function createLocalDiskStorage(rawConfig, deps = {}) {
  const parsed = localConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AzblobError(`Invalid local storage config: ${fields}`, { kind: 'config' });
  }
  const cfg = parsed.data;
  const now = deps.now ?? Date.now;
  const root = path.resolve(cfg.rootDir);
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');

  const container = (name) => validateContainer(name ?? cfg.defaultContainer);
  const containerDir = (c) => path.join(root, c);
  const blobFile = (c, name) => path.join(containerDir(c), createHash('sha256').update(name, 'utf8').digest('hex'));

  async function containerExists(c) {
    try {
      return (await stat(containerDir(c))).isDirectory();
    } catch {
      return false;
    }
  }

  async function readProps(c, name) {
    try {
      return JSON.parse(await readFile(`${blobFile(c, name)}.json`, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function atomicWrite(file, data) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async function createContainer(input = {}) {
    const c = container(input.container);
    if (await containerExists(c)) {
      if (input.ignoreExisting ?? true) return { container: c, created: false };
      throw new AzblobError('ContainerAlreadyExists', { kind: 'conflict', status: 409, azureCode: 'ContainerAlreadyExists' });
    }
    await mkdir(containerDir(c), { recursive: true });
    return { container: c, created: true };
  }

  async function putBlob(input) {
    const c = container(input.container);
    validateBlobName(input.name);
    validateAccessTier(input.accessTier);
    const body = toBuffer(input.body);
    if (body.byteLength > cfg.maxUploadBytes) throw new AzblobError('Blob too large for a single upload', { kind: 'too_large' });
    if (!(await containerExists(c))) throw notFound('container');
    const existing = await readProps(c, input.name);
    if (input.overwrite === false && existing) {
      throw new AzblobError('BlobAlreadyExists', { kind: 'conflict', status: 409, azureCode: 'BlobAlreadyExists' });
    }
    if (input.ifMatch && existing?.etag !== input.ifMatch) {
      throw new AzblobError('ConditionNotMet', { kind: 'precondition', status: 412, azureCode: 'ConditionNotMet' });
    }
    const t = now();
    const md5 = md5Base64(body);
    const props = {
      name: input.name,
      contentType: input.contentType ?? 'application/octet-stream',
      contentDisposition: input.contentDisposition ?? (input.filename ? contentDisposition(input.filename) : null),
      contentEncoding: input.contentEncoding ?? null,
      contentLanguage: input.contentLanguage ?? null,
      cacheControl: input.cacheControl ?? null,
      contentLength: body.byteLength,
      contentMd5: md5,
      etag: `"0x${createHash('sha256').update(`${md5}:${t}:${randomUUID()}`).digest('hex').slice(0, 15).toUpperCase()}"`,
      lastModified: new Date(t).toISOString(),
      accessTier: input.accessTier ?? 'Hot',
      metadata: Object.fromEntries(Object.entries(input.metadata ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    };
    const file = blobFile(c, input.name);
    await atomicWrite(`${file}.bin`, body);
    await atomicWrite(`${file}.json`, JSON.stringify(props));
    return { container: c, name: input.name, etag: props.etag, lastModified: props.lastModified, contentMd5: md5, versionId: null, size: body.byteLength, requestId: null };
  }

  function toProperties(c, props) {
    return { container: c, blobType: 'BlockBlob', versionId: null, requestId: null, ...props };
  }

  async function getBlobProperties(input) {
    const c = container(input.container);
    validateBlobName(input.name);
    if (!(await containerExists(c))) throw notFound('container');
    const props = await readProps(c, input.name);
    if (!props) throw notFound('blob');
    return toProperties(c, props);
  }

  async function getBlob(input) {
    const props = await getBlobProperties(input);
    if (input.ifMatch && props.etag !== input.ifMatch) {
      throw new AzblobError('ConditionNotMet', { kind: 'precondition', status: 412, azureCode: 'ConditionNotMet' });
    }
    let body = await readFile(`${blobFile(props.container, input.name)}.bin`);
    let partial = false;
    if (input.range) {
      const { offset, count } = input.range;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= body.byteLength) {
        throw new AzblobError('InvalidRange', { kind: 'validation', status: 416, azureCode: 'InvalidRange' });
      }
      body = body.subarray(offset, count === undefined ? undefined : offset + count);
      partial = true;
    }
    return { ...props, body, contentLength: body.byteLength, partial };
  }

  async function deleteBlob(input) {
    const c = container(input.container);
    validateBlobName(input.name);
    const props = await readProps(c, input.name);
    if (!props) {
      if (input.ignoreMissing ?? true) return { deleted: false, requestId: null };
      throw notFound('blob');
    }
    if (input.ifMatch && props.etag !== input.ifMatch) {
      throw new AzblobError('ConditionNotMet', { kind: 'precondition', status: 412, azureCode: 'ConditionNotMet' });
    }
    const file = blobFile(c, input.name);
    await rm(`${file}.json`, { force: true });
    await rm(`${file}.bin`, { force: true });
    return { deleted: true, requestId: null };
  }

  function signature(fields) {
    return createHmac('sha256', cfg.signingSecret).update(fields.join('\n'), 'utf8').digest('base64url');
  }

  async function createDownloadUrl(input) {
    const c = container(input.container);
    validateBlobName(input.name);
    const ttl = input.expiresInSeconds ?? cfg.downloadUrlTtlSeconds;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > cfg.maxDownloadUrlTtlSeconds) {
      throw new AzblobError(`expiresInSeconds must be 1..${cfg.maxDownloadUrlTtlSeconds}`, { kind: 'validation' });
    }
    const t = now();
    const se = Math.floor(t / 1000) + ttl;
    const rscd = input.contentDisposition ?? (input.filename ? contentDisposition(input.filename, { inline: input.inline }) : '');
    const rsct = input.contentType ?? '';
    const sig = signature([c, input.name, String(se), rscd, rsct]);
    const query = new URLSearchParams({ se: String(se), ...(rscd ? { rscd } : {}), ...(rsct ? { rsct } : {}), sig });
    return {
      url: `${baseUrl}/${c}/${encodeBlobPath(input.name)}?${query.toString()}`,
      expiresAt: new Date(se * 1000).toISOString(),
      startsAt: new Date(t).toISOString(),
      sasKind: 'local',
    };
  }

  /**
   * Check a URL made by createDownloadUrl. Returns what to serve, or { valid: false, reason }.
   * @param {string} url full URL or path+query as received by the dev route
   */
  function verifyDownloadUrl(url) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url, baseUrl);
    } catch {
      return { valid: false, reason: 'malformed_url' };
    }
    const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
    if (!parsedUrl.pathname.startsWith(`${prefix}/`)) return { valid: false, reason: 'wrong_path' };
    const [rawContainer, ...rest] = parsedUrl.pathname.slice(prefix.length + 1).split('/');
    let name;
    try {
      name = rest.map(decodeURIComponent).join('/');
      validateContainer(rawContainer);
      validateBlobName(name);
    } catch {
      return { valid: false, reason: 'malformed_url' };
    }
    const q = parsedUrl.searchParams;
    const se = Number(q.get('se'));
    const expected = signature([rawContainer, name, q.get('se') ?? '', q.get('rscd') ?? '', q.get('rsct') ?? '']);
    if (!safeEqual(q.get('sig') ?? '', expected)) return { valid: false, reason: 'bad_signature' };
    if (!Number.isFinite(se) || se * 1000 <= now()) return { valid: false, reason: 'expired' };
    return { valid: true, container: rawContainer, name, contentDisposition: q.get('rscd'), contentType: q.get('rsct') };
  }

  /** verifyDownloadUrl + getBlob, with the response-header overrides applied. */
  async function readDownload(url) {
    const check = verifyDownloadUrl(url);
    if (!check.valid) throw new AzblobError(`Download link rejected: ${check.reason}`, { kind: 'forbidden', status: 403 });
    const blob = await getBlob({ container: check.container, name: check.name });
    return {
      ...blob,
      contentDisposition: check.contentDisposition ?? blob.contentDisposition,
      contentType: check.contentType ?? blob.contentType,
    };
  }

  return {
    provider: 'local-disk',
    kind: 'storage',
    capabilities: Object.freeze(['put_blob', 'get_blob', 'head_blob', 'delete_blob', 'create_private_container', 'signed_download_url', 'range_read']),
    putBlob,
    getBlob,
    getBlobProperties,
    deleteBlob,
    createContainer,
    createDownloadUrl,
    verifyDownloadUrl,
    readDownload,
  };
}
