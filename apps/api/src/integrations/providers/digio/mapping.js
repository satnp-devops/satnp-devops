import { z } from 'zod';
import { DigioError } from './errors.js';

/**
 * Pure translation between the platform's e-sign shapes and Digio's wire format.
 * Field names and limits come from Digio's OpenAPI spec for POST /v2/client/document/uploadpdf
 * (operation uploadPdfFile) as published on documentation.digio.in.
 */

const IST_OFFSET_MINUTES = 330; // Asia/Kolkata, no daylight saving
const ADULT_AGE_YEARS = 18; // Indian Majority Act 1875

/** Platform sign type -> Digio `sign_type`. */
export const SIGN_TYPES = Object.freeze({
  aadhaar: 'aadhaar', // Aadhaar eSign (OTP by default; biometric/face per account settings)
  electronic: 'electronic', // drawn/typed signature, optionally OTP-backed
  dsc: 'dsc', // USB token Digital Signature Certificate
});

/** Modes Digio documents per sign type (fallback_sign_types.signature_mode description). */
export const SIGNATURE_MODES = Object.freeze({
  aadhaar: Object.freeze(['kyc', 'esign_3', 'esign_3s']),
  electronic: Object.freeze(['slate', 'slate_certified', 'otp', 'otp_certified', 'kyc']),
  dsc: Object.freeze([]),
});

/** Digio `agreement_status` -> platform document status. */
const DOCUMENT_STATUS = Object.freeze({
  draft: 'draft',
  requested: 'pending',
  completed: 'completed',
  expired: 'expired',
  failed: 'failed',
  cancelled: 'cancelled',
});

/** Digio signing party `status` -> platform signer status. */
const SIGNER_STATUS = Object.freeze({
  requested: 'pending',
  sequenced: 'waiting', // sequential signing: waiting for an earlier signer
  signed: 'signed',
  expired: 'expired',
  cancelled: 'cancelled',
  removed: 'removed',
  failed: 'failed',
  skipped: 'skipped',
});

/** @param {unknown} value */
export function mapDocumentStatus(value) {
  return (typeof value === 'string' && DOCUMENT_STATUS[value.toLowerCase()]) || 'unknown';
}

/** @param {unknown} value */
export function mapSignerStatus(value) {
  return (typeof value === 'string' && SIGNER_STATUS[value.toLowerCase()]) || 'unknown';
}

/**
 * Digio timestamps come in two shapes: REST responses use 'yyyy-mm-dd hh:mm:ss' in IST,
 * webhooks use epoch milliseconds. Returns an ISO-8601 UTC string or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseDigioTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value; // tolerate epoch seconds
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string') return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (local) {
    const [, y, mo, d, h, mi, s = '0'] = local;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - IST_OFFSET_MINUTES * 60_000;
    return new Date(utc).toISOString();
  }
  if (/^\d{10,13}$/.test(value.trim())) return parseDigioTime(Number(value.trim()));
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Digio identifies signers by email or mobile. Mobiles are sent as 10 digits (as in Digio's
 * samples); +91 / 0 prefixes and separators are removed.
 * @param {string} raw
 * @returns {{ identifier: string, kind: 'email' | 'mobile' } | null}
 */
export function normalizeIdentifier(raw) {
  const value = String(raw ?? '').trim();
  if (/^[^\s@/#?]+@[^\s@/#?]+\.[^\s@/#?]+$/.test(value) && value.length <= 254) {
    return { identifier: value, kind: 'email' };
  }
  let digits = value.replace(/[\s()-]/g, '');
  if (/^\+91\d{10}$/.test(digits)) digits = digits.slice(3);
  else if (/^91\d{10}$/.test(digits)) digits = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  if (/^[6-9]\d{9}$/.test(digits)) return { identifier: digits, kind: 'mobile' };
  return null;
}

/**
 * Age in whole years on the IST calendar date of `nowMs`.
 * @param {string} dateOfBirth YYYY-MM-DD
 * @param {number} nowMs
 */
export function ageOn(dateOfBirth, nowMs) {
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const today = new Date(nowMs + IST_OFFSET_MINUTES * 60_000);
  let age = today.getUTCFullYear() - y;
  const beforeBirthday = today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

// Digio's own pattern for signer names (signers[].name in the OpenAPI spec).
const DIGIO_NAME = /^[^<>";=%!*+?]*$/;

const signerSchema = z
  .object({
    identifier: z.string().min(3).max(254),
    name: z.string().trim().min(1).max(100).regex(DIGIO_NAME, 'Name cannot contain < > " ; = % ! * + ?'),
    reason: z.string().trim().min(1).max(250).optional(),
    signType: z.enum(['aadhaar', 'electronic', 'dsc']).default('aadhaar'),
    signatureMode: z.string().optional(),
    /** 1-based signing position; any signer with an order makes the request sequential. */
    order: z.number().int().min(1).max(100).optional(),
    /** Used only for the minor check; never sent to Digio. */
    dateOfBirth: z.iso.date().optional(),
    isMinor: z.boolean().optional(),
    /** Guardian signing for a minor: recorded in the signing reason. */
    onBehalfOf: z
      .object({
        name: z.string().trim().min(1).max(100),
        relationship: z.enum(['parent', 'guardian']),
      })
      .strict()
      .optional(),
  })
  .strict();

const document = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\\/:*?"<>|\r\n]+$/, 'File name has characters that are not allowed'),
    contentBase64: z.string().min(8).optional(),
    content: z.instanceof(Uint8Array).optional(),
  })
  .strict()
  .refine((doc) => Boolean(doc.contentBase64) !== Boolean(doc.content), {
    message: 'Pass exactly one of contentBase64 or content',
  });

export const createSignRequestSchema = z
  .object({
    document,
    signers: z.array(signerSchema).min(1).max(50),
    /** Force sequential signing in array order (also implied by `order`). */
    sequential: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    /** Our id for this request; sent as Digio's `callback` id, which Digio dedupes. */
    idempotencyKey: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    message: z.string().trim().max(500).optional(),
    notifySigners: z.boolean().optional(),
    notificationChannel: z.enum(['SMS', 'WHATSAPP', 'EMAIL', 'ALL']).optional(),
    /** Ask Digio for an SDK access token (generate_access_token). */
    generateAccessToken: z.boolean().optional(),
    /** 'json' (base64 in body, default) or 'multipart' (binary upload). */
    transport: z.enum(['json', 'multipart']).default('json'),
    /** Extra Digio fields (display_on_page, sign_coordinates, estamp_request, ...), sent as-is. */
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((input) => !(input.expiresInDays && input.expiresAt), {
    message: 'Pass expiresInDays or expiresAt, not both',
  });

/** @typedef {z.input<typeof createSignRequestSchema>} CreateSignRequestInput */

const RESERVED_PROVIDER_OPTIONS = new Set(['file_data', 'file_name', 'signers', 'callback', 'sequential']);

/**
 * Validate input and build Digio's request object (without file bytes).
 * @param {unknown} rawInput
 * @param {{ nowMs: number, defaultExpiryDays: number, notifySigners: boolean,
 *   notificationChannel: string, maxDocumentBytes: number }} ctx
 * @returns {{ body: Record<string, unknown>, file: { name: string, bytes: Uint8Array, base64: string },
 *   transport: 'json' | 'multipart', idempotencyKey: string | null }}
 */
export function buildCreateRequest(rawInput, ctx) {
  const parsed = createSignRequestSchema.safeParse(rawInput);
  if (!parsed.success) throw validationError(parsed.error);
  const input = parsed.data;

  const file = readDocument(input.document, ctx.maxDocumentBytes);
  const signers = buildSigners(input.signers, ctx.nowMs);
  const sequential = input.sequential ?? input.signers.some((s) => s.order !== undefined);
  const notify = input.notifySigners ?? ctx.notifySigners;

  /** @type {Record<string, unknown>} */
  const body = {
    file_name: file.name,
    signers,
    sequential,
    expire_in_days: expiryDays(input, ctx),
    include_authentication_url: true,
    notify_signers: notify,
    send_sign_link: notify,
    customer_notification_mode: input.notificationChannel ?? ctx.notificationChannel,
  };
  if (input.idempotencyKey) body.callback = input.idempotencyKey;
  if (input.message) body.comment = input.message;
  if (input.generateAccessToken) body.generate_access_token = true;
  for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
    if (RESERVED_PROVIDER_OPTIONS.has(key)) {
      throw new DigioError('validation', `providerOptions.${key} is set by the client and cannot be overridden`);
    }
    body[key] = value;
  }
  return { body, file, transport: input.transport, idempotencyKey: input.idempotencyKey ?? null };
}

/**
 * @param {z.infer<typeof signerSchema>[]} signers
 * @param {number} nowMs
 */
function buildSigners(signers, nowMs) {
  const seen = new Set();
  const withIndex = signers.map((signer, index) => ({ signer, index }));
  withIndex.sort((a, b) => (a.signer.order ?? Infinity) - (b.signer.order ?? Infinity) || a.index - b.index);
  return withIndex.map(({ signer, index }) => {
    const path = `signers.${index}`;
    const id = normalizeIdentifier(signer.identifier);
    if (!id) throw new DigioError('validation', `${path}.identifier must be an email or a 10-digit Indian mobile`);
    if (seen.has(id.identifier.toLowerCase())) {
      throw new DigioError('validation', `${path}.identifier appears more than once`);
    }
    seen.add(id.identifier.toLowerCase());
    assertAdult(signer, nowMs, path);

    const modes = SIGNATURE_MODES[signer.signType];
    if (signer.signatureMode && !modes.includes(signer.signatureMode)) {
      throw new DigioError(
        'validation',
        `${path}.signatureMode must be one of [${modes.join(', ')}] for ${signer.signType} signing`,
      );
    }
    /** @type {Record<string, unknown>} */
    const out = {
      identifier: id.identifier,
      name: signer.name,
      reason: signingReason(signer),
      sign_type: SIGN_TYPES[signer.signType],
    };
    if (signer.signatureMode) out.signature_mode = signer.signatureMode;
    return out;
  });
}

/**
 * Minors can't enter contracts in India (Indian Contract Act 1872 s.11), so a parent or
 * guardian signs and the minor is named in `onBehalfOf`.
 * @param {z.infer<typeof signerSchema>} signer
 * @param {number} nowMs
 * @param {string} path
 */
function assertAdult(signer, nowMs, path) {
  const minor = signer.isMinor === true || (signer.dateOfBirth && ageOn(signer.dateOfBirth, nowMs) < ADULT_AGE_YEARS);
  if (minor) {
    throw new DigioError(
      'minor_signer',
      `${path} is under 18. A parent or guardian must sign instead, with the student named in onBehalfOf.`,
    );
  }
}

/** @param {z.infer<typeof signerSchema>} signer */
function signingReason(signer) {
  const guardian = signer.onBehalfOf
    ? `Signing as ${signer.onBehalfOf.relationship} of ${signer.onBehalfOf.name}`
    : null;
  const reason = [signer.reason, guardian].filter(Boolean).join('. ');
  return (reason || 'Agreement acceptance').slice(0, 250);
}

/**
 * @param {{ expiresInDays?: number, expiresAt?: string }} input
 * @param {{ nowMs: number, defaultExpiryDays: number }} ctx
 */
function expiryDays(input, ctx) {
  if (input.expiresInDays) return input.expiresInDays;
  if (!input.expiresAt) return ctx.defaultExpiryDays;
  const days = Math.ceil((Date.parse(input.expiresAt) - ctx.nowMs) / 86_400_000);
  if (days < 1 || days > 90) {
    throw new DigioError('validation', 'expiresAt must be between 1 and 90 days from now (Digio limit)');
  }
  return days;
}

/**
 * @param {{ fileName: string, contentBase64?: string, content?: Uint8Array }} doc
 * @param {number} maxBytes
 */
function readDocument(doc, maxBytes) {
  let bytes;
  if (doc.content) {
    bytes = doc.content;
  } else {
    const clean = String(doc.contentBase64).replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new DigioError('validation', 'document.contentBase64 is not base64');
    bytes = Buffer.from(clean, 'base64');
  }
  if (bytes.byteLength > maxBytes) {
    throw new DigioError('validation', `document is ${bytes.byteLength} bytes; the limit is ${maxBytes}`);
  }
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new DigioError('validation', 'document must be a PDF');
  }
  const name = /\.pdf$/i.test(doc.fileName) ? doc.fileName : `${doc.fileName}.pdf`;
  return { name, bytes, base64: Buffer.from(bytes).toString('base64') };
}

/** @param {z.ZodError} error */
export function validationError(error) {
  const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  return new DigioError('validation', `Invalid e-sign request: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, {
    details: issues,
  });
}

/**
 * Normalise a signing party from a REST response or webhook payload.
 * Aadhaar demographic data (photo hash, gender, postcode, birth year) is deliberately dropped.
 * @param {Record<string, any>} party
 */
export function normalizeSigner(party) {
  const pki = party.pki_signature_details ?? null;
  return {
    identifier: party.identifier ?? null,
    name: party.name ?? null,
    status: mapSignerStatus(party.status),
    providerStatus: party.status ?? null,
    signType: party.signature_type ?? null,
    signatureMode: party.signature_mode ?? null,
    reason: party.reason ?? null,
    signUrl: party.authentication_url ?? null,
    expiresAt: parseDigioTime(party.expire_on),
    updatedAt: parseDigioTime(party.updated_at),
    signedName: pki?.name ?? null,
    nameMatchScore: typeof pki?.name_validation_score === 'number' ? pki.name_validation_score : null,
  };
}

/**
 * Normalise Digio's document object (create, get details, cancel, webhook payload.document).
 * @param {Record<string, any>} raw
 */
export function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    throw new DigioError('invalid_response', 'Digio returned a document without an id');
  }
  const token = raw.access_token;
  return {
    provider: 'digio',
    id: raw.id,
    status: mapDocumentStatus(raw.agreement_status),
    providerStatus: raw.agreement_status ?? null,
    fileName: raw.file_name ?? null,
    createdAt: parseDigioTime(raw.created_at),
    updatedAt: parseDigioTime(raw.updated_at),
    expiresAt: parseDigioTime(raw.sign_request_details?.expire_on),
    pageCount: typeof raw.no_of_pages === 'number' ? raw.no_of_pages : null,
    cancelReason: raw.cancel_reason ?? null,
    allSigned: raw.others?.has_all_signed ?? (raw.agreement_status === 'completed' ? true : null),
    signers: Array.isArray(raw.signing_parties) ? raw.signing_parties.map(normalizeSigner) : [],
    accessToken: token && typeof token === 'object' ? normalizeAccessToken(token) : null,
  };
}

/** @param {Record<string, any>} token */
export function normalizeAccessToken(token) {
  return {
    id: token.id ?? null,
    entityId: token.entityId ?? token.entity_id ?? null,
    validUntil: parseDigioTime(token.validTill ?? token.valid_till),
    createdAt: parseDigioTime(token.createdAt ?? token.created_at),
  };
}

/**
 * Signing link for the redirection approach (documentation.digio.in/sdk/redirect_url/redirect_url_sdk):
 * {app}/#/gateway/login/{documentId}/{txnId}/{identifier}?redirect_url=..&logo=..
 * `txnId` is any random value chosen by us. Prefer `signUrl` from the API when present.
 * @param {{ appBaseUrl: string, documentId: string, identifier: string, txnId: string,
 *   redirectUrl?: string, logoUrl?: string }} input
 */
export function buildSigningUrl({ appBaseUrl, documentId, identifier, txnId, redirectUrl, logoUrl }) {
  if (!/^DID[A-Z0-9]+$/i.test(documentId)) throw new DigioError('validation', 'documentId must be a Digio DID');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(txnId)) throw new DigioError('validation', 'txnId must be 4-64 URL-safe characters');
  const id = normalizeIdentifier(identifier);
  if (!id) throw new DigioError('validation', 'identifier must be an email or a 10-digit Indian mobile');
  const query = [];
  if (redirectUrl) query.push(`redirect_url=${encodeURIComponent(redirectUrl)}`);
  if (logoUrl) query.push(`logo=${encodeURIComponent(logoUrl)}`);
  const base = `${appBaseUrl}/#/gateway/login/${documentId}/${txnId}/${id.identifier}`;
  return query.length ? `${base}?${query.join('&')}` : base;
}

/**
 * Read the query Digio appends to redirect_url after signing (?status=success&digio_doc_id=..&message=..).
 * It is NOT signed: treat it as a hint and confirm with getDocument() or the webhook.
 * @param {string | URL} url
 */
export function parseSigningRedirect(url) {
  const params = new URL(String(url)).searchParams;
  return {
    trusted: false,
    status: params.get('status'),
    documentId: params.get('digio_doc_id'),
    message: params.get('message'),
  };
}
