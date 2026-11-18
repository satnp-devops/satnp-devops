import { readFileSync } from 'node:fs';

/** Shared test helpers (this file has no tests of its own). */

export const fixturesDir = new URL('./fixtures/', import.meta.url);

/** Exact bytes of a fixture, as Zoom would send them. */
export function fixtureText(name) {
  return readFileSync(new URL(name, fixturesDir), 'utf8').trim();
}

export function fixture(name) {
  return JSON.parse(fixtureText(name));
}

/** Clearly fake credentials (never real ones). */
export const TEST_CONFIG = Object.freeze({
  accountId: 'test-account-id',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-DO-NOT-USE',
  webhookSecretToken: 'test-webhook-secret-token',
});

export function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
  });
}

export const tokenResponse = (overrides = {}) =>
  json(200, {
    access_token: 'access-token-1',
    token_type: 'bearer',
    expires_in: 3599,
    scope: 'meeting:write:meeting:admin meeting:read:list_past_participants:admin',
    api_url: 'https://api-in.zoom.us',
    ...overrides,
  });

/**
 * Fake fetch: every call is recorded. API calls go to `handler(call, index)`, which returns a
 * Response (or throws); token calls go to `options.token()` (default: a valid token).
 * @param {(call: { url: URL, method: string, headers: Record<string,string>, body: string|undefined }, index: number) => Response|undefined|Promise<Response|undefined>} handler
 * @param {{ token?: (call: object) => Response }} [options]
 */
export function fakeFetch(handler, options = {}) {
  const calls = [];
  const apiCalls = [];
  const fn = async (input, init = {}) => {
    const headers = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = value;
    const call = { url: new URL(String(input)), method: init.method ?? 'GET', headers, body: init.body, signal: init.signal };
    calls.push(call);
    if (call.url.pathname === '/oauth/token') return options.token ? options.token(call) : tokenResponse();
    apiCalls.push(call);
    const response = await handler(call, apiCalls.length - 1);
    if (response !== undefined) return response;
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  };
  fn.calls = calls;
  fn.apiCalls = apiCalls;
  fn.tokenCalls = () => calls.filter((c) => c.url.pathname === '/oauth/token');
  return fn;
}

/** Deterministic clock. */
export function fakeClock(startIso = '2026-11-05T09:00:00Z') {
  let current = Date.parse(startIso);
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

export function deps(fetch, now = fakeClock(), extra = {}) {
  const sleeps = [];
  const logs = [];
  const logger = {
    debug: (obj, msg) => logs.push({ level: 'debug', obj, msg }),
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  return {
    fetch,
    now,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    sleeps,
    logs,
    ...extra,
  };
}
