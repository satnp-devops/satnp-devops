import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { checkResolvedAddresses, checkWebhookUrl, checkIp } from '../../core/automation/index.js';
import { ActionError } from './errors.js';

/**
 * The http.call_webhook executor (AUTOMATION_CORE.md §8):
 *   1. static URL checks again on the resolved URL (scheme, credentials, blocked IP literals, internal names);
 *   2. resolve the host ourselves and refuse if ANY answer is a blocked address;
 *   3. connect to the address we checked (pinned lookup), so a second DNS answer can't swap in a
 *      private address (DNS rebinding);
 *   4. never follow redirects (a 3xx is a failed call);
 *   5. no proxy (own agent), a total time limit, a 1 MB response cap, an HMAC-SHA256 signature
 *      with the connection's secret, no cookies or forwarding headers (the params schema refuses them).
 */

export const WEBHOOK_LIMITS = Object.freeze({ maxResponseBytes: 1024 * 1024, maxTimeoutMs: 10_000, keptBodyChars: 4000 });

/** X-Phoenix-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signBody(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/**
 * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: unknown, timeoutMs?: number }} params
 * @param {{ resolveHost: (host: string) => Promise<{ address: string, family?: number }[]>, secret?: string | null,
 *           idempotencyKey?: string, allowHttp?: boolean, now?: number, testOnlyAddressCheck?: Function }} options
 * @returns {Promise<{ status: number, body: unknown, address: string }>}
 */
export async function callWebhook(params, options) {
  const checked = checkWebhookUrl(params.url, { allowHttp: options.allowHttp === true });
  if (!checked.ok) throw new ActionError(checked.code, checked.message);
  const url = new URL(checked.url);

  // IP literals were judged by checkWebhookUrl; names are resolved here and every answer checked.
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses;
  if (checkIp(literal).version !== null) {
    addresses = [{ address: literal, family: literal.includes(':') ? 6 : 4 }];
  } else {
    try {
      addresses = await options.resolveHost(checked.host);
    } catch (err) {
      throw new ActionError('URL_DNS_FAILED', `Couldn't resolve ${checked.host} (${err.code ?? err.message})`, { retryable: true });
    }
  }
  // testOnlyAddressCheck lets unit tests reach a local server; the executor never passes it.
  const verdict = (options.testOnlyAddressCheck ?? checkResolvedAddresses)(addresses);
  if (!verdict.ok) throw new ActionError(verdict.code, verdict.message);
  const pinned = addresses[0];
  const family = pinned.family ?? (pinned.address.includes(':') ? 6 : 4);

  const body = JSON.stringify(params.body ?? {});
  const headers = {
    ...(params.headers ?? {}),
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'user-agent': 'Phoenix-Automations/1.0',
    ...(options.idempotencyKey ? { 'x-phoenix-idempotency-key': options.idempotencyKey } : {}),
    ...(options.secret ? { 'x-phoenix-signature': signBody(options.secret, body, Math.floor((options.now ?? Date.now()) / 1000)) } : {}),
  };
  const timeoutMs = Math.min(params.timeoutMs ?? WEBHOOK_LIMITS.maxTimeoutMs, WEBHOOK_LIMITS.maxTimeoutMs);
  const transport = url.protocol === 'https:' ? https : http;
  // Our own agent: never the global one, so HTTP(S)_PROXY / NODE_USE_ENV_PROXY can't route the call.
  const agent = new transport.Agent({ keepAlive: false, maxSockets: 1 });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      fn(value);
    };
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: params.method ?? 'POST',
        headers,
        agent,
        servername: /^[0-9.]+$|:/.test(checked.host) ? undefined : checked.host,
        // Pinned: connect to the address that was checked, whatever DNS says now.
        lookup: (_hostname, opts, callback) => {
          if (opts?.all) callback(null, [{ address: pinned.address, family }]);
          else callback(null, pinned.address, family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          finish(reject, new ActionError('WEBHOOK_REDIRECT', `The endpoint answered ${status} (redirects are not followed)`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > WEBHOOK_LIMITS.maxResponseBytes) {
            res.destroy();
            finish(reject, new ActionError('WEBHOOK_RESPONSE_TOO_LARGE', 'The response was larger than 1 MB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text.slice(0, WEBHOOK_LIMITS.keptBodyChars);
          if (/json/i.test(String(res.headers['content-type'] ?? '')) && text.length <= WEBHOOK_LIMITS.keptBodyChars) {
            try {
              parsed = JSON.parse(text);
            } catch {
              // keep the text
            }
          }
          if (status < 200 || status >= 300) {
            finish(reject, new ActionError(`WEBHOOK_HTTP_${status}`, `The endpoint answered ${status}`, { retryable: status >= 500 || status === 429 }));
            return;
          }
          finish(resolve, { status, body: parsed, address: pinned.address });
        });
        res.on('error', (err) => finish(reject, new ActionError('WEBHOOK_FAILED', err.message, { retryable: true })));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new ActionError('WEBHOOK_TIMEOUT', `No answer within ${timeoutMs} ms`, { retryable: true }));
    }, timeoutMs);
    req.on('error', (err) => finish(reject, new ActionError('WEBHOOK_FAILED', err.message, { retryable: true })));
    req.end(body);
  });
}
