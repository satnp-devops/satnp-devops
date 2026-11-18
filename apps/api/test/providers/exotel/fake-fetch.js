/**
 * Scripted fetch for tests: each call consumes the next responder. A responder is a Response,
 * an Error to throw, or a function (url, init) => Response | Promise<Response>.
 * @param {Array<Response | Error | ((url: string, init: RequestInit) => any)>} script
 */
export function fakeFetch(script) {
  /** @type {Array<{ url: string, method: string, headers: Record<string, string>, body: string | undefined, redirect: string | undefined, signal: AbortSignal | undefined }>} */
  const calls = [];
  const queue = [...script];
  /** @type {typeof fetch} */
  const fn = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: { ...(/** @type {Record<string, string>} */ (init.headers ?? {})) },
      body: /** @type {string | undefined} */ (init.body),
      redirect: init.redirect,
      signal: init.signal ?? undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: unexpected request ${init.method ?? 'GET'} ${url}`);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(String(url), init);
    return next;
  };
  return Object.assign(fn, { calls, remaining: () => queue.length });
}

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch responder that never resolves until its signal aborts. */
export function hang() {
  return (/** @type {string} */ _url, /** @type {RequestInit} */ init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    });
}

/** Collects log calls so tests can assert nothing sensitive is logged. */
export function memoryLogger() {
  /** @type {Array<{ level: string, args: unknown[] }>} */
  const entries = [];
  const log = (level) => (/** @type {unknown[]} */ ...args) => entries.push({ level, args });
  return { entries, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
