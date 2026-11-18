import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Test helpers (no network). `fakeFetch(script)` answers each call with the next script entry:
 * - { status, body, headers }  → a Response (body is JSON-encoded unless it is a string)
 * - an Error                   → fetch rejects with it (network failure)
 * - 'hang'                     → never resolves until the request signal aborts
 * - (url, init) => Response    → custom
 * Calls are recorded as { method, url, headers, body } with headers lower-cased and body parsed.
 */
export function fakeFetch(script) {
  const queue = [...script];
  const calls = [];
  const fn = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init.method, url, headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`fakeFetch: unexpected call ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    if (next === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    if (typeof next === 'function') return next(url, init);
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return new Response(text, { status: next.status ?? 200, headers: next.headers ?? { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  fn.remaining = () => queue.length;
  return fn;
}

/** Logger that records every call so tests can assert nothing secret was logged. */
export function recordingLogger() {
  const lines = [];
  const log = (level) => (obj, msg) => lines.push({ level, obj, msg });
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const KEY_ID = 'rzp_test_PhoenixKey0001';
export const KEY_SECRET = 'phoenix_key_secret_123';
export const WEBHOOK_SECRET = 'phoenix_webhook_secret_v1';
export const BASIC_AUTH = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

/** Deterministic deps: fixed clock, instant sleeps (recorded), mid-range jitter. */
export function testDeps(fetch, extra = {}) {
  const sleeps = [];
  return {
    deps: {
      fetch,
      now: () => Date.parse('2026-11-05T10:00:00Z'),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      idempotencyKey: () => 'idem_generated_0001',
      ...extra,
    },
    sleeps,
  };
}

/** Raw bytes of an official Razorpay sample payload (razorpay.com/docs/webhooks/*, fetched 2026-11-05). */
export function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));
}
