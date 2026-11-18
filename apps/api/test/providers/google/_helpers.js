// Shared test helpers (no tests here). Fake fetch, a throwaway RSA key and fixtures.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGoogleClient } from '../../../src/integrations/providers/google/index.js';

export const NOW = Date.parse('2026-11-05T10:00:00.000Z');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const testPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const testPublicKey = publicKey;

export const CHANNEL_SECRET = 'phoenix-test-channel-secret-0123456789';

/** @param {string} name */
export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/**
 * Fake fetch that answers from a queue. Each entry is a response spec
 * `{ status, json, body, headers }`, an Error to throw, or a function (call) => spec.
 * @param {Array<any>} responses
 */
export function fakeFetch(responses = []) {
  const calls = [];
  const queue = [...responses];
  async function fetch(url, init = {}) {
    const call = {
      url: new URL(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
      json: typeof init.body === 'string' && init.headers?.['content-type'] === 'application/json' ? JSON.parse(init.body) : undefined,
      form: typeof init.body === 'string' && init.headers?.['content-type'] === 'application/x-www-form-urlencoded' ? new URLSearchParams(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(call);
    if (queue.length === 0) throw new Error(`unexpected request ${call.method} ${url}`);
    const next = queue.shift();
    const spec = typeof next === 'function' ? await next(call) : next;
    if (spec instanceof Error) throw spec;
    const body = spec.body ?? (spec.json === undefined ? null : JSON.stringify(spec.json));
    return new Response(body, { status: spec.status ?? 200, headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) } });
  }
  return { fetch, calls, pending: () => queue.length };
}

export const tokenOk = (token = 'ya29.test-access-token-0001', expiresIn = 3599) => ({
  json: { access_token: token, expires_in: expiresIn, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/calendar.events' },
});

export const googleError = (status, reason, message = 'error', domain = 'global') => ({
  status,
  json: { error: { errors: [{ domain, reason, message }], code: status, message } },
});

export function serviceAccountConfig(overrides = {}) {
  return {
    auth: {
      type: 'service_account',
      clientEmail: 'phoenix-calendar@phoenix-crm-test.iam.gserviceaccount.com',
      privateKey: testPrivateKeyPem,
      privateKeyId: 'kid-test-1',
      subject: 'counsellor@phoenix-school.example.in',
    },
    webhook: { address: 'https://crm.phoenix.example.in/webhooks/google/calendar', channelSecret: CHANNEL_SECRET },
    backoffBaseMs: 100,
    ...overrides,
  };
}

/**
 * Client wired to a fake fetch, a fixed clock, and recorded (instant) sleeps.
 * @param {Array<any>} responses queued fetch responses (include the token response first)
 * @param {object} [overrides] config overrides
 */
export function makeClient(responses, overrides = {}) {
  const fake = fakeFetch(responses);
  const sleeps = [];
  const logs = [];
  const logger = { debug: (obj, msg) => logs.push({ level: 'debug', obj, msg }), warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }) };
  let clock = NOW;
  const client = createGoogleClient(serviceAccountConfig(overrides), {
    fetch: fake.fetch,
    now: () => clock,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0,
  });
  return { client, fake, sleeps, logs, advance: (ms) => (clock += ms), clock: () => clock };
}
