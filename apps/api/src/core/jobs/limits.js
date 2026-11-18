import { z } from 'zod';
import { env } from '../../config/env.js';

/**
 * Default outbound rate limits, as token buckets: `perSecond` tokens are added every second, up to
 * `burst`. A limit applies per name and connection: throttle('whatsapp', connectionId).
 *
 * Names are channels (whatsapp, email, sms, ...), adapter kinds (messaging.whatsapp) or provider keys
 * (whatsapp_cloud, razorpay); a provider key wins over its channel. Override any of them with the
 * THROTTLE_LIMITS environment variable, e.g. {"whatsapp":{"perSecond":20,"burst":40}}.
 *
 * Where the numbers come from (conservative starting points, below the providers' published limits):
 *   whatsapp  Meta Cloud API: 80 messages a second per business number by default
 *   email     SendGrid v3 mail send: generous; 10 a second keeps bursts of bulk mail polite
 *   sms       MSG91: 20 a second per sender
 *   calling   Exotel click-to-call: a few calls a second per account
 *   payments  Razorpay / Stripe API: about 25 requests a second
 *   ai        Anthropic Messages API: depends on the plan; 2 a second with a burst of 5
 */
export const DEFAULT_LIMITS = Object.freeze({
  default: { perSecond: 10, burst: 20 },
  whatsapp: { perSecond: 80, burst: 80 },
  email: { perSecond: 10, burst: 20 },
  sms: { perSecond: 20, burst: 20 },
  calling: { perSecond: 2, burst: 5 },
  meetings: { perSecond: 5, burst: 10 },
  calendar: { perSecond: 5, burst: 10 },
  payments: { perSecond: 25, burst: 25 },
  esign: { perSecond: 5, burst: 10 },
  ai: { perSecond: 2, burst: 5 },
  storage: { perSecond: 50, burst: 100 },
});

const limitSchema = z.strictObject({ perSecond: z.number().positive().max(100_000), burst: z.number().int().min(1).max(100_000) });
const limitsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/), limitSchema);

/** Parse the THROTTLE_LIMITS override. Throws at start-up for a malformed value. */
export function parseLimitOverrides(value) {
  if (!value || !value.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('THROTTLE_LIMITS must be JSON, e.g. {"whatsapp":{"perSecond":20,"burst":40}}');
  }
  const result = limitsSchema.safeParse(parsed);
  if (!result.success) throw new Error(`THROTTLE_LIMITS is invalid: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return result.data;
}

export const LIMITS = Object.freeze({ ...DEFAULT_LIMITS, ...parseLimitOverrides(env.THROTTLE_LIMITS) });

/** The limit for a name: exact, then without a "messaging." prefix, then the default. */
export function limitFor(name, limits = LIMITS) {
  return limits[name] ?? limits[String(name).replace(/^messaging\./, '')] ?? limits.default ?? DEFAULT_LIMITS.default;
}
