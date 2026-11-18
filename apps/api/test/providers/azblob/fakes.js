/**
 * Test doubles for the azblob provider: a fake fetch that records every request and answers
 * from a script, plus helpers to build Responses. No network is ever touched.
 */

/**
 * @param {Array<Response | ((call: object) => Response | Promise<Response>)>} script one entry per expected request
 */
export function fakeFetch(script) {
  const queue = [...script];
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body, signal: init.signal };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${call.method} ${url}`);
    return typeof next === 'function' ? next(call) : next;
  };
  fn.calls = calls;
  fn.remaining = () => queue.length;
  return fn;
}

/** @param {number} status @param {{ headers?: Record<string, string>, body?: string | Uint8Array | null }} [opts] */
export function reply(status, { headers = {}, body = null } = {}) {
  return new Response(body, { status, headers });
}

export function azureError(status, code, message = 'Something went wrong.\nRequestId:abc\nTime:2026-11-05T10:00:00Z') {
  return reply(status, {
    headers: { 'x-ms-error-code': code, 'x-ms-request-id': 'req-err', 'content-type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  });
}

/** Fixed clock: Thu, 05 Nov 2026 10:00:00 GMT */
export const NOW = Date.parse('2026-11-05T10:00:00Z');
export const fixedNow = () => NOW;
export const noSleep = async () => {};
