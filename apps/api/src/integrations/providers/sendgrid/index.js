import { parseSendgridConfig, describeConfig, sendgridConfigSchema, SENDGRID_HOSTS } from './config.js';
import { createHttp } from './http.js';
import { buildMailSendBody, outboundEmailSchema } from './mail.js';
import { verifyWebhook, loadPublicKey, headerValue, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './webhook.js';
import { parseWebhook } from './events.js';
import { parseInboundEmail } from './inbound.js';
import { SendgridError } from './errors.js';

/**
 * SendGrid email client (kind: messaging.email). Dependency-free apart from zod and node:crypto.
 *
 * Wrap it in the adapter interface roughly like this:
 *
 *   const client = createSendgridClient(connection.config, { fetch, now, logger });
 *   adapter.send = (msg) => client.send(msg);                    // -> { providerMessageId, ... }
 *   adapter.verifyWebhook = (raw, headers) => client.verifyWebhook(raw, headers);
 *   adapter.parseWebhook = (raw) => client.parseWebhook(raw);    // -> NormalisedEvent[]
 *   adapter.parseInbound = (raw, headers) => client.parseInbound(raw, headers);
 *
 * Every method throws SendgridError (see errors.js) with `retryable` and `outcomeUnknown`.
 */

export const PROVIDER = 'sendgrid';
export const KIND = 'messaging.email';

export const CAPABILITIES = Object.freeze({
  send: true,
  templates: 'dynamic', // d- templates with dynamic_template_data (Handlebars)
  personalizations: true, // up to 1,000 recipients per request, per-recipient data
  attachments: true,
  scheduling: true, // send_at up to 72 hours ahead; batch_id to cancel
  categories: true,
  customArgs: true, // carries our message id back on every event
  sandbox: true, // validates without delivering; returns 200 and no events
  oneClickUnsubscribe: true, // RFC 8058 headers via message.unsubscribe
  idempotencyKeys: false, // SendGrid mail send has none; see outcomeUnknown
  webhookSignature: 'ecdsa-p256-sha256',
  events: ['processed', 'deferred', 'delivered', 'bounced', 'dropped', 'opened', 'clicked', 'spam_reported', 'unsubscribed', 'group_unsubscribed', 'group_resubscribed', 'account_status_changed'],
  inbound: true, // Inbound Parse, parsed and raw modes
  regions: Object.keys(SENDGRID_HOSTS),
});

/**
 * @typedef {{ status: 'accepted'|'validated', messageId: string, providerMessageId: string|null, sandbox: boolean,
 *   recipients: number, acceptedAt: string, statusCode: number, attempts: number,
 *   rateLimit: import('./http.js').RateLimit }} SendResult
 */

/**
 * @param {unknown} rawConfig validated with sendgridConfigSchema
 * @param {{ fetch?: typeof globalThis.fetch, now?: () => number, logger?: any,
 *   sleep?: (ms: number) => Promise<void>, random?: () => number }} [deps]
 */
export function createSendgridClient(rawConfig, deps = {}) {
  const config = parseSendgridConfig(rawConfig);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? {};
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const request = createHttp({ config, fetch: fetchImpl, now, sleep, random: deps.random ?? Math.random, logger });

  /**
   * Send one email (or one batch of personalizations). Not retried on 5xx/timeouts, because
   * SendGrid has no idempotency key: those errors carry outcomeUnknown = true.
   * @param {import('./mail.js').OutboundEmail} message
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<SendResult>}
   */
  async function send(message, { signal } = {}) {
    const { body, sandbox, recipients } = buildMailSendBody(message, config, { now });
    const result = await request({ method: 'POST', path: '/v3/mail/send', body, policy: 'unsafe', signal });
    const providerMessageId = result.headers.get('x-message-id');
    if (!sandbox && !providerMessageId) {
      logger.warn?.({ provider: PROVIDER, messageId: message.messageId, status: result.status }, 'sendgrid accepted mail without X-Message-Id');
    }
    logger.info?.(
      { provider: PROVIDER, messageId: message.messageId, providerMessageId, sandbox, recipients, status: result.status },
      'sendgrid mail accepted',
    );
    return {
      status: sandbox ? 'validated' : 'accepted',
      messageId: message.messageId,
      providerMessageId: providerMessageId ?? null,
      sandbox,
      recipients,
      acceptedAt: new Date(now()).toISOString(),
      statusCode: result.status,
      attempts: result.attempts,
      rateLimit: result.rateLimit,
    };
  }

  return Object.freeze({
    provider: PROVIDER,
    kind: KIND,
    capabilities: CAPABILITIES,
    /** Safe summary of the connection (no secrets). */
    describe: () => describeConfig(config),
    send,
    /** Validate a message with SendGrid without delivering it (sandbox mode). */
    validate: (/** @type {import('./mail.js').OutboundEmail} */ message, /** @type {{ signal?: AbortSignal }} */ options = {}) =>
      send({ ...message, sandbox: true }, options),
    /** The exact JSON body `send` would post; for previews and debugging. */
    buildRequest: (/** @type {import('./mail.js').OutboundEmail} */ message) => buildMailSendBody(message, config, { now }).body,

    /**
     * Check the key works; returns the API key's scopes and whether it can send mail.
     * @param {{ signal?: AbortSignal }} [options]
     */
    async testConnection({ signal } = {}) {
      const result = await request({ method: 'GET', path: '/v3/scopes', policy: 'idempotent', onBehalfOf: true, signal });
      const scopes = Array.isArray(/** @type {any} */ (result.body)?.scopes) ? /** @type {any} */ (result.body).scopes : [];
      return { ok: true, canSend: scopes.includes('mail.send'), scopes };
    },

    /**
     * Fetch the Signed Event Webhook public key (the same value shown in the dashboard).
     * @param {string} webhookId id from GET /v3/user/webhooks/event/settings/all
     * @param {{ signal?: AbortSignal }} [options]
     */
    async getEventWebhookPublicKey(webhookId, { signal } = {}) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(String(webhookId ?? ''))) throw new SendgridError('validation', 'Invalid webhook id', { retryable: false });
      const result = await request({
        method: 'GET',
        path: `/v3/user/webhooks/event/settings/signed/${encodeURIComponent(webhookId)}`,
        policy: 'idempotent',
        onBehalfOf: true,
        signal,
      });
      const key = /** @type {any} */ (result.body)?.public_key;
      if (typeof key !== 'string' || !key) throw new SendgridError('not_found', 'Signed webhook is not enabled for this webhook', { retryable: false });
      return { webhookId, publicKey: key };
    },

    /**
     * Create a batch id for scheduled sends (lets a scheduled batch be paused or cancelled).
     * @param {{ signal?: AbortSignal }} [options]
     */
    async createBatchId({ signal } = {}) {
      const result = await request({ method: 'POST', path: '/v3/mail/batch', policy: 'unsafe', onBehalfOf: true, signal });
      const batchId = /** @type {any} */ (result.body)?.batch_id;
      if (typeof batchId !== 'string') throw new SendgridError('provider_error', 'SendGrid returned no batch_id', { retryable: true });
      return { batchId };
    },

    /**
     * Verify an Event Webhook POST with the configured key.
     * @param {Buffer|string} rawBody @param {any} headers
     */
    verifyWebhook: (rawBody, headers) =>
      verifyWebhook(rawBody, headers, requireKey(config.eventWebhookPublicKey, 'eventWebhookPublicKey'), {
        toleranceSeconds: config.webhookToleranceSeconds,
        now,
      }),
    /** @param {Buffer|string|unknown[]} body */
    parseWebhook: (body) => parseWebhook(body, { messageIdArg: config.messageIdArg }),

    /**
     * Verify a signed Inbound Parse POST (needs a security policy with signature enabled).
     * @param {Buffer} rawBody @param {any} headers
     */
    verifyInbound: (rawBody, headers) =>
      verifyWebhook(rawBody, headers, requireKey(config.inboundParsePublicKey, 'inboundParsePublicKey'), {
        toleranceSeconds: config.webhookToleranceSeconds,
        now,
      }),
    /** @param {Buffer} rawBody @param {any} headersOrContentType */
    parseInbound: (rawBody, headersOrContentType) => parseInboundEmail(rawBody, headersOrContentType),
  });
}

/** @param {string|undefined} key @param {string} field */
function requireKey(key, field) {
  if (!key) throw new SendgridError('config', `SendGrid ${field} is not configured`, { retryable: false });
  return key;
}

export { SendgridError, redactSecrets } from './errors.js';
export { sendgridConfigSchema, parseSendgridConfig, SENDGRID_HOSTS };
export { buildMailSendBody, outboundEmailSchema, RESERVED_HEADERS, MAX_RECIPIENTS } from './mail.js';
export { verifyWebhook, loadPublicKey, headerValue, SIGNATURE_HEADER, TIMESTAMP_HEADER };
export { parseWebhook, EVENT_TYPES } from './events.js';
export { parseInboundEmail, addressTag } from './inbound.js';
export { parseMultipart } from './multipart.js';
export { parseAddressList, decodeEncodedWords, parseMimeMessage } from './mime.js';
export {
  buildListUnsubscribeHeaders,
  isOneClickUnsubscribePost,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  ONE_CLICK_POST_VALUE,
} from './unsubscribe.js';
