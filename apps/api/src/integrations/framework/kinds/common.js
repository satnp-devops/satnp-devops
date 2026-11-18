import { z } from 'zod';

// Schema pieces shared by the adapter kinds. Inputs are what feature code passes to an adapter;
// outputs are what every adapter (mock or real) must return. Times are ISO 8601 UTC strings and
// money is integer minor units plus an ISO 4217 currency, like everywhere else in the platform.

export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use an E.164 number such as +919876543210');
export const isoTime = z.iso.datetime({ offset: true });
export const currency = z.string().regex(/^[A-Z]{3}$/, 'Use an ISO 4217 code such as INR');
export const amountMinor = z.number().int().positive().max(10 ** 14);
export const email = z.email().max(254);
export const timeZone = z.string().min(1).max(64);

/** Our own id for an outbound call, used by providers for idempotency and echoed back in webhooks. */
export const reference = z.string().min(1).max(120);
export const optionalReference = reference.optional();

export const metadata = z.record(z.string().max(40), z.string().max(500)).optional();

export const healthResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * An HTTP request from a provider, as the webhooks route hands it to an adapter. `rawBody` is the
 * exact bytes received: signatures are computed over them, never over re-serialised JSON.
 * Header names are lower-case.
 */
export const webhookRequest = z.object({
  method: z.string().default('POST'),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()).default({}),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()).default({}),
  rawBody: z.union([z.instanceof(Buffer), z.instanceof(Uint8Array), z.string()]).default(''),
  url: z.string().optional(),
});

export const webhookVerdict = z.union([
  z.object({ ok: z.literal(true) }).loose(),
  z.object({ ok: z.literal(false), reason: z.string() }).loose(),
]);

/**
 * A provider event after parsing. `eventId` is the provider's id for the event (or a stable hash
 * of it when the provider sends none): the webhooks service de-duplicates on (connection, eventId).
 */
export const webhookEvent = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  occurredAt: isoTime,
  reference: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()),
});

export const webhookParseResult = z.object({ events: z.array(webhookEvent) });

/** A subscription handshake reply (Meta hub.challenge, Zoom url_validation, Graph validationToken). */
export const webhookChallengeResult = z
  .object({ status: z.number().int(), contentType: z.string(), body: z.string() })
  .nullable();

/** The webhook methods every kind with `webhooks` must implement. */
export const WEBHOOK_METHODS = Object.freeze({
  verifyWebhook: {
    description:
      'Check the request really came from the provider (signature over rawBody, shared token or IP rule). ' +
      'Never throws for a bad request: returns { ok: false, reason }. Compares secrets in constant time.',
    input: webhookRequest,
    output: webhookVerdict,
  },
  parseWebhook: {
    description: 'Turn a verified request into normalised events. Throws integration_invalid_input for a body it cannot read.',
    input: webhookRequest,
    output: webhookParseResult,
  },
  webhookChallenge: {
    description:
      'Answer a subscription handshake if this request is one (GET with hub.challenge, url_validation, validationToken); otherwise null.',
    input: webhookRequest,
    output: webhookChallengeResult,
  },
});

/** Define a kind: freezes it and fills defaults, so kinds stay plain data. */
export function defineKind(definition) {
  const methods = { ...definition.methods };
  return Object.freeze({
    webhooks: null,
    ...definition,
    methods: Object.freeze(methods),
  });
}
