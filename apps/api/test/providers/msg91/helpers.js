/**
 * Shared fixtures for the MSG91 tests: a recording fake fetch (no network), a capturing logger
 * and a realistic config. Credentials here are obviously fake.
 */
export const AUTH_KEY = 'test-authkey-0000000000000000';
export const WEBHOOK_SECRET = 'whsec-test-0123456789abcdef';
/** 2026-11-05 11:30 IST (06:00 UTC): inside the promotional window. */
export const NOON_IST = new Date('2026-11-05T06:00:00.000Z');

export function baseConfig(overrides = {}) {
  return {
    authKey: AUTH_KEY,
    senderId: 'PHXEDU',
    otp: { templateId: '64f0c0ffee0c0ffee0c0ffee', length: 6, expiryMinutes: 10 },
    dlt: {
      whitelistedUrls: ['https://phoenix.edu.in/apply?', 'https://m.9m.io/PHXEDU/'],
      whitelistedCallbackNumbers: ['18001234567'],
    },
    webhook: { secret: WEBHOOK_SECRET },
    http: { timeoutMs: 1000, maxRetries: 2, retryBaseDelayMs: 10, retryMaxDelayMs: 2000 },
    templates: {
      'admission.counselling_reminder': {
        templateId: '669a29fbd6fc053066739b42',
        dltTemplateId: '1307160975559044358',
        category: 'service_implicit',
        body: 'Dear ##name##, your counselling session is on ##date##. Apply: ##link## -Phoenix Group',
        dltBody: 'Dear {#var#}, your counselling session is on {#var#}. Apply: {#url#} -Phoenix Group',
      },
      'admission.fee_due': {
        templateId: '669a29fbd6fc053066739b43',
        dltTemplateId: '1307160975559044359',
        category: 'service_implicit',
        body: 'Fee of Rs ##amount## for ##student## is due. Call ##helpline## -Phoenix Group',
        dltBody: 'Fee of Rs {#numeric#} for {#alphanumeric#} is due. Call {#cbn#} -Phoenix Group',
      },
      'marketing.open_day': {
        templateId: '669a29fbd6fc053066739b44',
        dltTemplateId: '1307160975559044360',
        category: 'promotional',
        senderId: '567890',
        body: 'Open day on ##date## at Phoenix campus. Register now -Phoenix Group',
        dltBody: 'Open day on {#var#} at Phoenix campus. Register now -Phoenix Group',
      },
    },
    ...overrides,
  };
}

/**
 * Fake fetch: `responses` is a list of handlers, one per call, each returning
 * { status, body, headers } or throwing. Records every call.
 */
export function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  async function fetch(url, init) {
    const u = new URL(String(url));
    calls.push({ url: u, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call ${init.method} ${u.pathname}`);
    const r = typeof next === 'function' ? await next(u, init) : next;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return new Response(text, { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' } });
  }
  return { fetch, calls, remaining: () => queue.length };
}

export function captureLogger() {
  const entries = [];
  const log = (level) => (obj, msg) => entries.push({ level, obj, msg });
  return { logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }, entries };
}

export const noSleep = async () => {};

/** Error like undici's for a refused connection. */
export function connectionRefused() {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' });
  return err;
}
