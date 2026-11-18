import { readFileSync } from 'node:fs';
import { createMsgraphClient } from '../../../src/integrations/providers/msgraph/index.js';

/** Shared fakes for the Microsoft Graph client tests. No network access anywhere. */

export const TENANT_ID = '11111111-2222-4333-8444-555555555555';
export const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const CLIENT_SECRET = 'test-client-secret-value-0123456789';
export const WEBHOOK_SECRET = 'whsec-test-0123456789abcdef0123456789abcdef';
export const PREVIOUS_WEBHOOK_SECRET = 'whsec-old-fedcba9876543210fedcba9876543210';
export const MAILBOX = '16664f75-11dc-4870-bec6-38c1aaa81431';
export const ACCESS_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL2dyYXBoIn0.c2lnbmF0dXJl';
export const NOW = Date.parse('2026-11-05T06:00:00.000Z');

export const baseConfig = Object.freeze({
  tenantId: TENANT_ID,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  webhookSecret: WEBHOOK_SECRET,
  previousWebhookSecrets: [PREVIOUS_WEBHOOK_SECRET],
  notificationUrl: 'https://crm.phoenix.example.in/api/webhooks/msgraph',
  lifecycleNotificationUrl: 'https://crm.phoenix.example.in/api/webhooks/msgraph/lifecycle',
});

/** @param {string} name */
export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/**
 * @param {number} status
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
export function respond(status, body, headers = {}) {
  const noBody = body === undefined || status === 204 || status === 202;
  return new Response(noBody ? null : JSON.stringify(body), {
    status,
    headers: noBody ? headers : { 'content-type': 'application/json', ...headers },
  });
}

export const tokenOk = (expiresIn = 3599, token = ACCESS_TOKEN) =>
  respond(200, { token_type: 'Bearer', expires_in: expiresIn, access_token: token });

/**
 * Fake fetch. Token requests are answered by `token` (default: a valid token); Graph requests
 * are answered in order by `responses` (Response objects or functions of the call).
 * @param {Array<Response | ((call: any) => Response | Promise<Response>)>} responses
 * @param {{ token?: (call: any) => Response | Promise<Response> }} [options]
 */
export function fakeFetch(responses = [], { token = () => tokenOk() } = {}) {
  const calls = [];
  const tokenCalls = [];
  const queue = [...responses];
  async function fetch(url, init = {}) {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, method: init.method ?? 'GET', headers, body: init.body, signal: init.signal };
    if (String(url).includes('/oauth2/v2.0/token')) {
      tokenCalls.push(call);
      return token(call);
    }
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${call.method} ${url}`);
    return typeof next === 'function' ? next(call) : next;
  }
  return { fetch, calls, tokenCalls, pending: () => queue.length };
}

/** Captures log lines so tests can check nothing secret is logged. */
export function captureLogger() {
  const lines = [];
  const log = (level) => (obj, msg) => lines.push({ level, obj, msg });
  return { logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }, lines };
}

/**
 * Client wired to fakes: instant sleep (delays recorded), fixed clock, deterministic UUIDs.
 * @param {Array<any>} responses
 * @param {{ config?: object, token?: (call: any) => Response, now?: () => number }} [options]
 */
export function makeClient(responses = [], options = {}) {
  const fake = fakeFetch(responses, options.token ? { token: options.token } : undefined);
  const sleeps = [];
  const { logger, lines } = captureLogger();
  let n = 0;
  const client = createMsgraphClient(
    { ...baseConfig, ...options.config },
    {
      fetch: fake.fetch,
      now: options.now ?? (() => NOW),
      logger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    },
  );
  return { client, ...fake, sleeps, logs: lines };
}

/** Graph error body. @param {string} code @param {string} message */
export function graphError(code, message) {
  return { error: { code, message, innerError: { date: '2026-11-05T06:00:00', 'request-id': 'req-1', 'client-request-id': 'c-1' } } };
}
