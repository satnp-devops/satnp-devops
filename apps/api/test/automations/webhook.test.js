import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { callWebhook, signBody } from '../../src/modules/automations/webhook.js';
import { ActionError } from '../../src/modules/automations/errors.js';

// The http.call_webhook executor: URL checks, resolved-address checks, pinning, no redirects,
// limits and the signature. Local servers are reached only through `testOnlyAddressCheck`
// (the executor never passes it), so the real address check stays in force everywhere else.

const allowLoopback = () => ({ ok: true });
const resolveTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ActionError, `expected an ActionError, got ${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((r) => s.close(r)) }));
  });
}

test('refuses private, loopback, metadata and internal targets before connecting', async () => {
  let resolved = 0;
  const count = async () => {
    resolved += 1;
    return [{ address: '93.184.215.14', family: 4 }];
  };
  await rejects(callWebhook({ url: 'https://127.0.0.1/hook' }, { resolveHost: count }), 'URL_PRIVATE_ADDRESS');
  await rejects(callWebhook({ url: 'https://169.254.169.254/latest/meta-data' }, { resolveHost: count }), 'URL_PRIVATE_ADDRESS');
  await rejects(callWebhook({ url: 'https://[::ffff:10.0.0.1]/hook' }, { resolveHost: count }), 'URL_PRIVATE_ADDRESS');
  await rejects(callWebhook({ url: 'https://0x7f.1/hook' }, { resolveHost: count }), 'URL_PRIVATE_ADDRESS');
  const internal = await callWebhook({ url: 'https://metadata.google.internal/x' }, { resolveHost: count }).catch((e) => e);
  assert.ok(internal instanceof ActionError && /^URL_/.test(internal.code), String(internal?.code));
  await rejects(callWebhook({ url: 'http://example.com/hook' }, { resolveHost: count }), 'URL_SCHEME');
  assert.equal(resolved, 0, 'no DNS lookups for refused URLs');
});

test('refuses a public name that resolves to a private address (any answer)', async () => {
  await rejects(callWebhook({ url: 'https://hooks.example.com/x' }, { resolveHost: resolveTo('10.1.2.3') }), 'URL_PRIVATE_ADDRESS');
  await rejects(callWebhook({ url: 'https://hooks.example.com/x' }, { resolveHost: resolveTo('93.184.215.14', '192.168.1.5') }), 'URL_PRIVATE_ADDRESS');
  await rejects(callWebhook({ url: 'https://hooks.example.com/x' }, { resolveHost: resolveTo('fd00:ec2::254') }), 'URL_PRIVATE_ADDRESS');
  await rejects(callWebhook({ url: 'https://hooks.example.com/x' }, { resolveHost: resolveTo() }), 'URL_NO_ADDRESS');
  await rejects(
    callWebhook({ url: 'https://hooks.example.com/x' }, { resolveHost: async () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })) }),
    'URL_DNS_FAILED',
  );
});

test('connects to the checked address, signs the body and returns the JSON answer', async () => {
  let seen;
  const s = await server((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { headers: req.headers, body, method: req.method, url: req.url };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    // The name would resolve elsewhere; the call goes to the pinned (checked) address.
    const out = await callWebhook(
      { url: `http://crm-hooks.example.com:${s.port}/in?x=1`, method: 'PUT', headers: { 'X-Source': 'phoenix' }, body: { dealId: 'd1' } },
      { resolveHost: resolveTo('127.0.0.1'), allowHttp: true, testOnlyAddressCheck: allowLoopback, secret: 'shh', idempotencyKey: 'run:step:1', now: 1_700_000_000_000 },
    );
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(seen.method, 'PUT');
    assert.equal(seen.url, '/in?x=1');
    assert.equal(seen.headers.host, `crm-hooks.example.com:${s.port}`);
    assert.equal(seen.headers['x-source'], 'phoenix');
    assert.equal(seen.headers['x-phoenix-idempotency-key'], 'run:step:1');
    assert.equal(seen.headers['x-phoenix-signature'], signBody('shh', seen.body, 1_700_000_000));
    const mac = crypto.createHmac('sha256', 'shh').update(`1700000000.${seen.body}`).digest('hex');
    assert.equal(seen.headers['x-phoenix-signature'], `t=1700000000,v1=${mac}`);
    assert.equal(seen.headers.cookie, undefined);
  } finally {
    await s.close();
  }
});

test('does not follow redirects, reports HTTP errors and caps the response', async () => {
  let hits = 0;
  const s = await server((req, res) => {
    hits += 1;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      return res.end();
    }
    if (req.url === '/fail') {
      res.writeHead(503);
      return res.end('down');
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(Buffer.alloc(1024 * 1024 + 10, 97));
  });
  const options = { resolveHost: resolveTo('127.0.0.1'), allowHttp: true, testOnlyAddressCheck: allowLoopback };
  try {
    await rejects(callWebhook({ url: `http://hooks.example.com:${s.port}/redirect` }, options), 'WEBHOOK_REDIRECT');
    assert.equal(hits, 1, 'the redirect target was never requested');
    const failed = await callWebhook({ url: `http://hooks.example.com:${s.port}/fail` }, options).catch((e) => e);
    assert.equal(failed.code, 'WEBHOOK_HTTP_503');
    assert.equal(failed.retryable, true);
    await rejects(callWebhook({ url: `http://hooks.example.com:${s.port}/big` }, options), 'WEBHOOK_RESPONSE_TOO_LARGE');
  } finally {
    await s.close();
  }
});

test('times out slow endpoints', async () => {
  const s = await server(() => {
    /* never answers */
  });
  try {
    const started = Date.now();
    await rejects(
      callWebhook({ url: `http://hooks.example.com:${s.port}/slow`, timeoutMs: 1000 }, { resolveHost: resolveTo('127.0.0.1'), allowHttp: true, testOnlyAddressCheck: allowLoopback }),
      'WEBHOOK_TIMEOUT',
    );
    assert.ok(Date.now() - started < 5000);
  } finally {
    s.close();
  }
});
