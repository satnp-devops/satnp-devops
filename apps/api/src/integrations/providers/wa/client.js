import { createHash } from 'node:crypto';
import { z } from 'zod';
import { describeConfig, parseWaConfig } from './config.js';
import { WaError } from './errors.js';
import { createTransport } from './http.js';
import {
  MEDIA_LIMITS,
  buildCreateTemplate,
  buildEditTemplate,
  buildInteractiveMessage,
  buildMarkRead,
  buildMediaMessage,
  buildReactionMessage,
  buildTemplateMessage,
  buildTextMessage,
  normalizeTemplate,
  parseInput,
} from './payloads.js';
import { parseWebhook, verifySubscription, verifyWebhook } from './webhook.js';

/**
 * @typedef {object} CallOptions
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} SendResult
 * @property {'whatsapp'} provider
 * @property {string} messageId      wamid; status webhooks carry the same id
 * @property {string | null} recipientWaId WhatsApp id Meta resolved (may differ from the input number)
 * @property {string | null} messageStatus template pacing status when Meta paces the template
 * @property {string} acceptedAt     ISO 8601 UTC; accepted by Meta, not delivered
 */

const idSchema = z.string().regex(/^\d{1,30}$/, 'must be a numeric id');

/**
 * Create a WhatsApp Cloud API client for one business phone number.
 *
 * @param {import('./config.js').WaConfigInput} config validated with zod; see config.js
 * @param {import('./http.js').TransportDeps} [deps] injectable fetch, now, logger, sleep, random
 */
export function createWaClient(config, deps = {}) {
  const cfg = parseWaConfig(config);
  const { request } = createTransport(cfg, deps);
  const now = deps.now ?? Date.now;
  const phonePath = `/${cfg.phoneNumberId}`;
  const buildOptions = { defaultCountryCode: cfg.defaultCountryCode, messagingAccountId: cfg.messagingAccountId };

  function requireWaba() {
    if (!cfg.wabaId) throw new WaError('wabaId is required for template management', { kind: 'config', retryable: false });
    return cfg.wabaId;
  }

  /**
   * @param {Record<string, unknown>} body
   * @param {string} op
   * @param {CallOptions} [options]
   * @returns {Promise<SendResult>}
   */
  async function send(body, op, options = {}) {
    const { data } = await request({ method: 'POST', path: `${phonePath}/messages`, json: body, idempotent: false, op, signal: options.signal });
    const message = Array.isArray(data.messages) ? data.messages[0] : null;
    if (!message?.id) {
      throw new WaError('WhatsApp API accepted the request but returned no message id', { kind: 'unknown', retryable: false, ambiguous: true });
    }
    const contact = Array.isArray(data.contacts) ? data.contacts[0] : null;
    return {
      provider: 'whatsapp',
      messageId: message.id,
      recipientWaId: typeof contact?.wa_id === 'string' ? contact.wa_id : null,
      messageStatus: typeof message.message_status === 'string' ? message.message_status : null,
      acceptedAt: new Date(now()).toISOString(),
    };
  }

  /**
   * Look up a media id (from a webhook or an upload). The URL expires after 5 minutes.
   * @param {string} mediaId
   * @param {CallOptions} [options]
   */
  async function getMedia(mediaId, options = {}) {
    const id = parseInput(idSchema, mediaId, 'media id');
    const { data } = await request({ method: 'GET', path: `/${id}`, query: { phone_number_id: cfg.phoneNumberId }, idempotent: true, op: 'getMedia', signal: options.signal });
    return {
      id: String(data.id ?? id),
      url: typeof data.url === 'string' ? data.url : null,
      mimeType: typeof data.mime_type === 'string' ? data.mime_type : null,
      sha256: typeof data.sha256 === 'string' ? data.sha256 : null,
      fileSize: Number.isFinite(Number(data.file_size)) ? Number(data.file_size) : null,
    };
  }

  return Object.freeze({
    /** Safe-to-log description of this connection (no secrets). */
    info: describeConfig(cfg),

    /**
     * Send an approved template. Works outside the 24-hour customer service window.
     * @param {{ to?: string, recipient?: string, name: string, language: string,
     *   variables?: { header?: object, body?: Array<string | { amountMinor: number, currency: string }> | Record<string, string | { amountMinor: number, currency: string }>, buttons?: object[] }, components?: object[],
     *   callbackData?: string, replyTo?: string }} input
     * @param {CallOptions} [options]
     */
    async sendTemplate(input, options) {
      return send(buildTemplateMessage(input, buildOptions), 'sendTemplate', options);
    },

    /**
     * Free-form text inside the customer service window (else WaError kind 'window_closed', code 131047).
     * @param {{ to?: string, recipient?: string, body: string, previewUrl?: boolean, callbackData?: string, replyTo?: string }} input
     * @param {CallOptions} [options]
     */
    async sendText(input, options) {
      return send(buildTextMessage(input, buildOptions), 'sendText', options);
    },

    /**
     * @param {{ to?: string, recipient?: string, kind: 'image' | 'video' | 'audio' | 'document' | 'sticker',
     *   media: { id?: string, link?: string, filename?: string }, caption?: string, callbackData?: string, replyTo?: string }} input
     * @param {CallOptions} [options]
     */
    async sendMedia(input, options) {
      return send(buildMediaMessage(input, buildOptions), 'sendMedia', options);
    },

    /**
     * @param {{ to?: string, recipient?: string, messageId: string, emoji: string }} input
     * @param {CallOptions} [options]
     */
    async sendReaction(input, options) {
      return send(buildReactionMessage(input, buildOptions), 'sendReaction', options);
    },

    /**
     * @param {{ to?: string, recipient?: string, interactive: { type: string, action: object }, callbackData?: string, replyTo?: string }} input
     * @param {CallOptions} [options]
     */
    async sendInteractive(input, options) {
      return send(buildInteractiveMessage(input, buildOptions), 'sendInteractive', options);
    },

    /**
     * Mark a received message (and earlier ones) as read; `typing: true` also shows a typing indicator.
     * Safe to repeat, so it is retried on timeouts.
     * @param {{ messageId: string, typing?: boolean }} input
     * @param {CallOptions} [options]
     */
    async markRead(input, options = {}) {
      const { data } = await request({ method: 'POST', path: `${phonePath}/messages`, json: buildMarkRead(input), idempotent: true, op: 'markRead', signal: options.signal });
      return { success: data.success === true };
    },

    /**
     * List templates for the templates settings screen.
     * @param {{ limit?: number, after?: string, before?: string, status?: string, fields?: string[] }} [query]
     * @param {CallOptions} [options]
     */
    async listTemplates(query = {}, options = {}) {
      const q = parseInput(
        z.object({
          limit: z.number().int().min(1).max(1000).optional(),
          after: z.string().optional(),
          before: z.string().optional(),
          status: z.string().regex(/^[A-Za-z_]+$/).optional(),
          fields: z.array(z.string().regex(/^[a-z_{}.,()]+$/)).optional(),
        }),
        query,
        'template query',
      );
      const fields = q.fields ?? ['id', 'name', 'language', 'status', 'category', 'sub_category', 'parameter_format', 'components', 'quality_score', 'rejected_reason'];
      const { data } = await request({
        method: 'GET',
        path: `/${requireWaba()}/message_templates`,
        query: { fields: fields.join(','), limit: q.limit, after: q.after, before: q.before, status: q.status?.toUpperCase() },
        idempotent: true,
        op: 'listTemplates',
        signal: options.signal,
      });
      const cursors = data.paging?.cursors ?? {};
      return {
        templates: (Array.isArray(data.data) ? data.data : []).map(normalizeTemplate),
        nextCursor: data.paging?.next && typeof cursors.after === 'string' ? cursors.after : null,
        previousCursor: data.paging?.previous && typeof cursors.before === 'string' ? cursors.before : null,
      };
    },

    /**
     * @param {string} templateId
     * @param {CallOptions} [options]
     */
    async getTemplate(templateId, options = {}) {
      const id = parseInput(idSchema, templateId, 'template id');
      const { data } = await request({
        method: 'GET',
        path: `/${id}`,
        query: { fields: 'id,name,language,status,category,sub_category,parameter_format,components,quality_score,rejected_reason,last_updated_time' },
        idempotent: true,
        op: 'getTemplate',
        signal: options.signal,
      });
      return normalizeTemplate(data);
    },

    /**
     * Submit a template for review. Not retried on timeouts: a repeat would fail as a duplicate name+language.
     * @param {{ name: string, language: string, category: string, components: object[], parameterFormat?: string, allowCategoryChange?: boolean, messageSendTtlSeconds?: number }} input
     * @param {CallOptions} [options]
     * @returns {Promise<{ id: string, status: string | null, category: string | null }>}
     */
    async createTemplate(input, options = {}) {
      const { data } = await request({ method: 'POST', path: `/${requireWaba()}/message_templates`, json: buildCreateTemplate(input), idempotent: false, op: 'createTemplate', signal: options.signal });
      return { id: String(data.id), status: data.status ?? null, category: data.category ?? null };
    },

    /**
     * Edit an APPROVED, REJECTED or PAUSED template. Components replace all existing ones.
     * @param {string} templateId
     * @param {{ category?: string, components?: object[], messageSendTtlSeconds?: number }} input
     * @param {CallOptions} [options]
     */
    async editTemplate(templateId, input, options = {}) {
      const id = parseInput(idSchema, templateId, 'template id');
      const { data } = await request({ method: 'POST', path: `/${id}`, json: buildEditTemplate(input), idempotent: false, op: 'editTemplate', signal: options.signal });
      return { success: data.success === true };
    },

    /**
     * Delete a template. With only `name`, every language of that name is deleted.
     * @param {{ name: string, templateId?: string }} input
     * @param {CallOptions} [options]
     */
    async deleteTemplate(input, options = {}) {
      const x = parseInput(z.object({ name: z.string().regex(/^[a-z0-9_]{1,512}$/), templateId: idSchema.optional() }), input, 'template delete');
      const { data } = await request({
        method: 'DELETE',
        path: `/${requireWaba()}/message_templates`,
        query: { name: x.name, hsm_id: x.templateId },
        idempotent: true,
        op: 'deleteTemplate',
        signal: options.signal,
      });
      return { success: data.success === true };
    },

    /**
     * Upload media for sending (ids last 30 days). Retried on timeouts: a duplicate upload is harmless.
     * @param {{ data: Blob | Uint8Array | ArrayBuffer, mimeType: string, filename?: string }} input
     * @param {CallOptions} [options]
     * @returns {Promise<{ id: string }>}
     */
    async uploadMedia(input, options = {}) {
      const mimeType = String(input?.mimeType ?? '').toLowerCase();
      const limit = MEDIA_LIMITS[/** @type {keyof typeof MEDIA_LIMITS} */ (mimeType)];
      if (!limit) throw new WaError(`Unsupported media type ${mimeType || '(none)'}`, { kind: 'media', retryable: false });
      const blob = input.data instanceof Blob ? input.data : new Blob([/** @type {any} */ (input.data)], { type: mimeType });
      if (blob.size === 0) throw new WaError('Media is empty', { kind: 'media', retryable: false });
      if (blob.size > limit) throw new WaError(`Media is larger than the ${limit} byte limit for ${mimeType}`, { kind: 'media', retryable: false });
      const filename = input.filename ?? `upload.${mimeType.split('/')[1]?.split('.').pop() ?? 'bin'}`;
      const { data } = await request({
        method: 'POST',
        path: `${phonePath}/media`,
        form: () => {
          const form = new FormData();
          form.set('messaging_product', 'whatsapp');
          form.set('type', mimeType);
          form.set('file', new Blob([blob], { type: mimeType }), filename);
          return form;
        },
        idempotent: true,
        op: 'uploadMedia',
        signal: options.signal,
      });
      return { id: String(data.id) };
    },

    getMedia,

    /**
     * Download media bytes by media id. Fetches a fresh URL first and only sends the token to an
     * allowed Meta host. Checks the sha256 Meta reported (hex or base64) when present.
     * @param {string} mediaId
     * @param {CallOptions} [options]
     * @returns {Promise<{ id: string, bytes: Uint8Array, mimeType: string | null, sha256: string }>}
     */
    async downloadMedia(mediaId, options = {}) {
      const meta = await getMedia(mediaId, options);
      if (!meta.url) throw new WaError('WhatsApp API returned no media URL', { kind: 'media', retryable: false });
      const url = new URL(meta.url);
      const allowed = url.protocol === 'https:' && cfg.mediaHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
      if (!allowed) throw new WaError(`Refusing to send the access token to media host ${url.hostname}`, { kind: 'media', retryable: false });
      const result = await request({ method: 'GET', url: url.toString(), responseType: 'bytes', idempotent: true, op: 'downloadMedia', signal: options.signal, maxBytes: cfg.maxMediaBytes });
      const bytes = /** @type {Uint8Array} */ (result.bytes);
      const digest = createHash('sha256').update(bytes).digest();
      const hex = digest.toString('hex');
      if (meta.sha256 && meta.sha256 !== hex && meta.sha256 !== digest.toString('base64')) {
        throw new WaError('Downloaded media does not match its sha256', { kind: 'media', retryable: true });
      }
      return { id: meta.id, bytes, mimeType: result.contentType ?? meta.mimeType, sha256: hex };
    },

    /**
     * @param {string} mediaId
     * @param {CallOptions} [options]
     */
    async deleteMedia(mediaId, options = {}) {
      const id = parseInput(idSchema, mediaId, 'media id');
      const { data } = await request({ method: 'DELETE', path: `/${id}`, query: { phone_number_id: cfg.phoneNumberId }, idempotent: true, op: 'deleteMedia', signal: options.signal });
      return { success: data.success === true };
    },

    /**
     * Cheap "test connection" call for the settings screen.
     * @param {CallOptions} [options]
     */
    async checkConnection(options = {}) {
      const { data } = await request({
        method: 'GET',
        path: phonePath,
        query: { fields: 'id,display_phone_number,verified_name,quality_rating,throughput' },
        idempotent: true,
        op: 'checkConnection',
        signal: options.signal,
      });
      return {
        phoneNumberId: String(data.id ?? cfg.phoneNumberId),
        displayPhoneNumber: data.display_phone_number ?? null,
        verifiedName: data.verified_name ?? null,
        qualityRating: data.quality_rating ?? null,
        throughput: data.throughput?.level ?? null,
      };
    },

    /**
     * Verify a webhook POST with this connection's app secret (and previous secret while rotating).
     * @param {Buffer | Uint8Array | string} rawBody
     * @param {Headers | Record<string, string | string[] | undefined>} headers
     * @param {{ maxAgeSeconds?: number }} [opts]
     */
    verifyWebhook(rawBody, headers, opts = {}) {
      return verifyWebhook(rawBody, headers, [cfg.appSecret, cfg.previousAppSecret], { now, ...opts });
    },

    /**
     * Answer the GET subscription check with this connection's verify token.
     * @param {Record<string, unknown> | URLSearchParams} query
     */
    verifySubscription(query) {
      return verifySubscription(query, cfg.verifyToken);
    },

    parseWebhook,
  });
}
