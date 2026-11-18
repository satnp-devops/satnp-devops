import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IntegrationError } from '../errors.js';

/**
 * Shared behaviour of the mock adapters.
 *
 * Deterministic: ids are hashes of the connection id and the call (our `reference` when given),
 * times come from the injected clock, and nothing random is used, so the same call gives the same
 * answer and tests can assert on it. Mocks record every outbound call in the sandbox outbox
 * (integration_sandbox_messages), which Settings › Integrations shows.
 *
 * Failure simulation is explicit configuration on the mock connection (`simulate`):
 *   healthy          everything works (default)
 *   failing_sends    every call that would reach a provider throws integration_provider_error (retryable)
 *   failing_health   healthCheck() reports a failure; calls still work
 */

export const SIMULATE_OPTIONS = [
  { value: 'healthy', label: 'Healthy' },
  { value: 'failing_sends', label: 'Failing calls (retryable error)' },
  { value: 'failing_health', label: 'Failing health check' },
];

export const MOCK_SIGNATURE_HEADER = 'x-phoenix-mock-signature';

export function stableId(prefix, ...parts) {
  return `${prefix}_${createHash('sha256').update(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|')).digest('hex').slice(0, 24)}`;
}

/** A key for a call: our reference when there is one, else the canonical input. */
export function callKey(input) {
  return input?.reference ?? canonical(input);
}

function canonical(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `bytes:${createHash('sha256').update(value).digest('hex')}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${key}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function iso(now) {
  return new Date(now()).toISOString();
}

export function healthFor(ctx, message = 'Mock connection: calls are recorded in the sandbox outbox and nothing leaves this server') {
  if (ctx.config.simulate === 'failing_health') return { ok: false, message: 'The mock connection is set to fail its health check' };
  return { ok: true, message, details: { mock: true } };
}

/** Throw the simulated provider failure when the connection is set to fail calls. */
export function maybeFail(ctx, operation) {
  if (ctx.config.simulate === 'failing_sends') {
    throw new IntegrationError('integration_provider_error', `The mock connection is set to fail calls (${operation})`, {
      retryable: true,
      kind: ctx.connection.kind,
      provider: 'mock',
      details: { reason: 'simulated_failure' },
    });
  }
}

/** The mock's webhook secret: the stored credential when set, else one derived for the connection. */
export function webhookSecretOf(ctx) {
  return ctx.credentials.webhookSecret || ctx.derivedSecret('mock-webhook');
}

export function signMockBody(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const headerOf = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

const mockEventsBody = z.object({
  events: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        type: z.string().min(1).max(100),
        occurredAt: z.iso.datetime({ offset: true }),
        reference: z.string().max(120).nullable().optional(),
        data: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(500),
});

/**
 * Webhook methods shared by every mock kind that receives webhooks. A mock webhook is JSON
 * { events: [{ id, type, occurredAt, reference?, data }] } signed with HMAC-SHA256 of the raw body
 * in the x-phoenix-mock-signature header ("sha256=<hex>"); buildMockWebhook() makes one.
 * The handshake: GET with ?challenge=<value> echoes the value.
 */
export function mockWebhookMethods(ctx, kind) {
  const types = new Set(Object.keys(kind.webhooks?.events ?? {}));
  return {
    async verifyWebhook(request) {
      const given = headerOf(request.headers, MOCK_SIGNATURE_HEADER);
      if (!given) return { ok: false, reason: 'missing_signature' };
      const expected = signMockBody(webhookSecretOf(ctx), Buffer.from(request.rawBody));
      const a = Buffer.from(String(given));
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
      return { ok: true };
    },
    async parseWebhook(request) {
      let json;
      try {
        json = JSON.parse(Buffer.from(request.rawBody).toString('utf8'));
      } catch {
        throw new IntegrationError('integration_invalid_input', 'The webhook body is not JSON', { kind: kind.key, provider: 'mock' });
      }
      const parsed = mockEventsBody.safeParse(json);
      if (!parsed.success) {
        throw new IntegrationError('integration_invalid_input', 'The webhook body is not a mock event list', { kind: kind.key, provider: 'mock' });
      }
      const unknown = parsed.data.events.find((event) => !types.has(event.type));
      if (unknown) {
        throw new IntegrationError('integration_invalid_input', `Unknown ${kind.key} event "${unknown.type}"`, { kind: kind.key, provider: 'mock' });
      }
      return {
        events: parsed.data.events.map((event) => ({
          eventId: event.id,
          type: event.type,
          occurredAt: new Date(event.occurredAt).toISOString(),
          reference: event.reference ?? null,
          data: event.data,
        })),
      };
    },
    async webhookChallenge(request) {
      const challenge = request.query?.challenge;
      if (request.method !== 'GET' || typeof challenge !== 'string' || !challenge) return null;
      return { status: 200, contentType: 'text/plain', body: challenge.slice(0, 200) };
    },
  };
}

/** A signed mock webhook request for tests and local development: { rawBody, headers }. */
export function buildMockWebhook(secret, events) {
  const rawBody = Buffer.from(JSON.stringify({ events }));
  return { rawBody, headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: signMockBody(secret, rawBody) } };
}

/** Keep sandbox payloads small and free of file contents. */
export function summarisePayload(value, depth = 0) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (typeof value === 'string') {
    if (value.length > 2000) return `${value.slice(0, 2000)}… [${value.length} characters]`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => summarisePayload(item, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 5) return '[…]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = /base64$/i.test(key) && typeof item === 'string' ? `[${Math.floor((item.length * 3) / 4)} bytes, base64]` : summarisePayload(item, depth + 1);
    }
    return out;
  }
  return value;
}
