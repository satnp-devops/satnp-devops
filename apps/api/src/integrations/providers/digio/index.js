import { randomBytes } from 'node:crypto';
import { DIGIO_ENVIRONMENTS, digioConfigSchema, parseDigioConfig } from './config.js';
import { DigioError, isRetryable } from './errors.js';
import { buildMultipart, request } from './http.js';
import {
  buildCreateRequest,
  buildSigningUrl,
  createSignRequestSchema,
  normalizeAccessToken,
  normalizeDocument,
  normalizeIdentifier,
  parseDigioTime,
  parseSigningRedirect,
} from './mapping.js';
import {
  DIGIO_SIGNATURE_HEADER,
  computeWebhookChecksum,
  isDigioWebhookIp,
  parseWebhook,
  verifyWebhook,
} from './webhook.js';

/**
 * Digio e-sign client (DigiSign REST API v2). Dependency-free apart from zod; uses global fetch.
 *
 * const digio = createDigioClient({ environment: 'sandbox', clientId, clientSecret, webhookSecret });
 * const doc = await digio.createSignRequest({ document: { fileName, contentBase64 }, signers: [...] });
 * doc.signers[0].signUrl  // or digio.getSigningUrl({ documentId: doc.id, identifier })
 *
 * Wrap it in the platform's esign adapter: every method returns plain normalised objects and
 * throws DigioError (code, retryable, status, providerCode) on failure.
 */

export const DIGIO_CAPABILITIES = Object.freeze({
  kind: 'esign',
  provider: 'digio',
  signTypes: Object.freeze(['aadhaar', 'electronic', 'dsc']),
  sequentialSigning: true,
  expiryDays: Object.freeze({ min: 1, max: 90, default: 10 }),
  uploadTransports: Object.freeze(['json', 'multipart']),
  signingUrl: true,
  statusFetch: true,
  signedDocumentDownload: true,
  auditTrailDownload: true,
  cancel: true,
  idempotencyKeys: true, // Digio `callback` id
  webhooks: Object.freeze({
    signatureHeader: DIGIO_SIGNATURE_HEADER,
    algorithm: 'HMAC-SHA256 hex over raw body',
    timestampTolerance: false,
    events: Object.freeze(['doc.signed', 'doc.sign.failed', 'doc.sign.rejected']),
  }),
  minorsMaySign: false,
  amounts: false,
});

const DOC_ID = /^DID[A-Z0-9]{6,60}$/i;

/**
 * @typedef {import('./http.js').Logger} Logger
 * @typedef {{ fetch?: typeof fetch, now?: () => Date | number, logger?: Logger,
 *   sleep?: (ms: number) => Promise<void>, random?: () => number }} DigioDeps
 */

/**
 * @param {unknown} rawConfig see digioConfigSchema (config.js)
 * @param {DigioDeps} [deps]
 */
export function createDigioClient(rawConfig, deps = {}) {
  const config = parseDigioConfig(rawConfig);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new DigioError('config_invalid', 'No fetch implementation available');
  const nowMs = () => new Date(deps.now ? deps.now() : Date.now()).getTime();
  const webhookSecrets = config.webhookSecret === undefined ? [] : [config.webhookSecret].flat();
  const secrets = Object.freeze([
    config.clientSecret,
    Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'),
    ...webhookSecrets,
  ]);

  /** @type {import('./http.js').HttpContext} */
  const http = {
    fetch: fetchImpl,
    logger: deps.logger ?? {},
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: deps.random ?? Math.random,
    baseUrl: config.hosts.api,
    authorization: `Basic ${secrets[1]}`,
    secrets,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    retryBaseDelayMs: config.retryBaseDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs,
  };

  /**
   * Create a signature request. Returns the normalised document; each signer has `signUrl`
   * (Digio's authentication_url) when Digio provides one.
   * @param {import('./mapping.js').CreateSignRequestInput} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function createSignRequest(input, options = {}) {
    const built = buildCreateRequest(input, {
      nowMs: nowMs(),
      defaultExpiryDays: config.defaultExpiryDays,
      notifySigners: config.notifySigners,
      notificationChannel: config.notificationChannel,
      maxDocumentBytes: config.maxDocumentBytes,
    });
    // Only a request carrying Digio's dedupe id is safe to send twice.
    const retry = Boolean(built.idempotencyKey) && config.retryCreateWithIdempotencyKey;
    let res;
    if (built.transport === 'multipart') {
      const multipart = buildMultipart({ fileName: built.file.name, fileBytes: built.file.bytes, request: built.body });
      res = await request(http, {
        op: 'createSignRequest', method: 'POST', path: '/v2/client/document/upload',
        body: multipart.body, contentType: multipart.contentType, expect: 'json', retry, signal: options.signal,
      });
    } else {
      res = await request(http, {
        op: 'createSignRequest', method: 'POST', path: '/v2/client/document/uploadpdf',
        json: { ...built.body, file_data: built.file.base64 }, expect: 'json', retry, signal: options.signal,
      });
    }
    return normalizeDocument(res.json);
  }

  /**
   * Current status of a document and its signers.
   * @param {string} documentId Digio document id (DID...)
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function getDocument(documentId, options = {}) {
    const id = assertDocId(documentId);
    const res = await request(http, {
      op: 'getDocument', method: 'GET', path: `/v2/client/document/${id}`, expect: 'json', retry: true, signal: options.signal,
    });
    return normalizeDocument(res.json);
  }

  /**
   * Download the document PDF (signed once status is 'completed').
   * @param {string} documentId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function downloadSignedDocument(documentId, options = {}) {
    const id = assertDocId(documentId);
    const res = await request(http, {
      op: 'downloadSignedDocument', method: 'GET', path: '/v2/client/document/download',
      query: { document_id: id }, expect: 'binary', retry: true, signal: options.signal,
    });
    return toPdf(res, id, 'download');
  }

  /**
   * Download Digio's audit trail PDF for a document.
   * @param {string} documentId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function downloadAuditTrail(documentId, options = {}) {
    const id = assertDocId(documentId);
    const res = await request(http, {
      op: 'downloadAuditTrail', method: 'GET', path: `/v2/client/document/${id}/v2/audit_log`,
      expect: 'binary', retry: true, signal: options.signal,
    });
    return toPdf(res, id, 'audit_log');
  }

  /**
   * Cancel a pending request. Not retried: on a network error call getDocument() to see whether
   * the cancel landed.
   * @param {string} documentId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function cancelSignRequest(documentId, options = {}) {
    const id = assertDocId(documentId);
    const res = await request(http, {
      op: 'cancelSignRequest', method: 'POST', path: `/v2/client/document/${id}/cancel`, expect: 'json', retry: false, signal: options.signal,
    });
    return normalizeDocument(res.json);
  }

  /**
   * New SDK access token for a signer (POST /user/auth/generate_token), used by Digio's web/mobile
   * SDKs to skip the first login factor. Not needed for the redirect signing link.
   * @param {{ documentId: string, identifier: string }} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function generateAccessToken({ documentId, identifier }, options = {}) {
    const id = assertDocId(documentId);
    const signer = normalizeIdentifier(identifier);
    if (!signer) throw new DigioError('validation', 'identifier must be an email or a 10-digit Indian mobile');
    const res = await request(http, {
      op: 'generateAccessToken', method: 'POST', path: '/user/auth/generate_token',
      json: { entityId: id, identifier: signer.identifier }, expect: 'json', retry: false, signal: options.signal,
    });
    return normalizeAccessToken(res.json ?? {});
  }

  /**
   * Build a signing link (redirect approach). No network call.
   * @param {{ documentId: string, identifier: string, redirectUrl?: string, logoUrl?: string, txnId?: string }} input
   */
  function getSigningUrl({ documentId, identifier, redirectUrl, logoUrl, txnId }) {
    return buildSigningUrl({
      appBaseUrl: config.hosts.app,
      documentId: assertDocId(documentId),
      identifier,
      txnId: txnId ?? randomBytes(9).toString('base64url'),
      redirectUrl: redirectUrl ?? config.redirectUrl,
      logoUrl: logoUrl ?? config.logoUrl,
    });
  }

  /**
   * Verify with the configured webhook secret(s).
   * @param {Buffer | Uint8Array | string} rawBody
   * @param {Headers | Record<string, string | string[] | undefined>} headers
   * @param {{ toleranceSeconds?: number }} [options]
   */
  function verify(rawBody, headers, options = {}) {
    return verifyWebhook(rawBody, headers, webhookSecrets, { ...options, now: () => nowMs() });
  }

  return Object.freeze({
    provider: 'digio',
    environment: config.environment,
    hosts: config.hosts,
    capabilities: DIGIO_CAPABILITIES,
    createSignRequest,
    getDocument,
    downloadSignedDocument,
    downloadAuditTrail,
    cancelSignRequest,
    generateAccessToken,
    getSigningUrl,
    verifyWebhook: verify,
    parseWebhook,
    isWebhookIp: (/** @type {string} */ ip) => isDigioWebhookIp(ip, config.environment),
  });
}

/** @param {unknown} documentId */
function assertDocId(documentId) {
  if (typeof documentId !== 'string' || !DOC_ID.test(documentId)) {
    throw new DigioError('validation', 'documentId must be a Digio document id (DID...)');
  }
  return documentId;
}

/**
 * @param {{ headers: Headers, bytes?: Uint8Array }} res
 * @param {string} documentId
 * @param {string} kind
 */
function toPdf(res, documentId, kind) {
  const bytes = res.bytes ?? new Uint8Array();
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new DigioError('invalid_response', `Digio ${kind} for ${documentId} is not a PDF`);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return {
    documentId,
    bytes,
    contentType: 'application/pdf',
    fileName: (match && safeDecode(match[1])) || `${documentId}${kind === 'audit_log' ? '-audit' : ''}.pdf`,
    size: bytes.byteLength,
  };
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export {
  DIGIO_ENVIRONMENTS,
  DIGIO_SIGNATURE_HEADER,
  DigioError,
  buildSigningUrl,
  computeWebhookChecksum,
  createSignRequestSchema,
  digioConfigSchema,
  isDigioWebhookIp,
  isRetryable,
  normalizeDocument,
  parseDigioConfig,
  parseDigioTime,
  parseSigningRedirect,
  parseWebhook,
  verifyWebhook,
};
