import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  GRAPH_CHANGE_TRACKING_APP_ID,
  createClientState,
  parseWebhook,
  validationResponse,
  verifyClientState,
  verifyValidationToken,
  verifyWebhook,
} from '../../../src/integrations/providers/msgraph/index.js';
import { CLIENT_ID, PREVIOUS_WEBHOOK_SECRET, TENANT_ID, WEBHOOK_SECRET, fixture, makeClient } from './helpers.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const SECRETS = [WEBHOOK_SECRET, PREVIOUS_WEBHOOK_SECRET];
const NOTIFY_NOW = Date.parse('2026-11-06T00:00:00Z');

// ---------------------------------------------------------------------------------------------
// clientState test vectors. Graph doesn't sign basic notifications, so these HMAC values are our
// own scheme; each is recomputed here independently with node:crypto and also pinned as a literal.
// ---------------------------------------------------------------------------------------------
const VECTORS = [
  {
    secret: WEBHOOK_SECRET,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    clientState: 'v1.AAECAwQFBgcICQoLDA0ODw.m5lQXkS4qjI772P3LvRasgC1-IapNOUs74T12WeOCw4',
  },
  {
    secret: WEBHOOK_SECRET,
    nonce: 'phoenix-crm-sub-0001',
    clientState: 'v1.phoenix-crm-sub-0001.mSE7pOSme91JwEr30a6MemXLxeeB9l0Y2NUbOd8qf78',
  },
  {
    secret: PREVIOUS_WEBHOOK_SECRET,
    nonce: 'phoenix-crm-sub-0002',
    clientState: 'v1.phoenix-crm-sub-0002.MCO3Tot_Ap6PNPgMRa6IW8iXEFDQnxmbxT6svmyKuG4',
  },
];

test('clientState vectors match an independent HMAC-SHA256 computation', () => {
  for (const { secret, nonce, clientState } of VECTORS) {
    const mac = createHmac('sha256', secret).update(`msgraph.clientState.v1.${nonce}`).digest('base64url');
    assert.equal(`v1.${nonce}.${mac}`, clientState);
    assert.equal(createClientState(secret, { nonce }), clientState);
    assert.ok(verifyClientState(clientState, SECRETS));
  }
});

test('clientState fits Graph limits and random nonces differ', () => {
  const a = createClientState(WEBHOOK_SECRET);
  const b = createClientState(WEBHOOK_SECRET);
  assert.notEqual(a, b);
  assert.ok(a.length <= 128);
  assert.ok(verifyClientState(a, WEBHOOK_SECRET));
});

test('tampered, foreign or malformed clientState values fail', () => {
  const good = VECTORS[1].clientState;
  const flipped = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  const otherNonce = good.replace('sub-0001', 'sub-0009');
  for (const value of [flipped, otherNonce, 'secretClientValue', '', null, 42, `${good}.x`, `v2${good.slice(2)}`, 'v1.short.abc', `${good}${'A'.repeat(100)}`]) {
    assert.equal(verifyClientState(value, SECRETS), false, String(value));
  }
  assert.equal(verifyClientState(good, 'another-secret-0123456789abcdef0123'), false);
  assert.equal(verifyClientState(VECTORS[2].clientState, WEBHOOK_SECRET), false, 'old secret only when listed');
  assert.throws(() => createClientState('short'), TypeError);
});

test('validation handshake echoes the URL-decoded token as text/plain', () => {
  const token = 'Validation: Testing client application reachability for subscription Request-Id: 6b2f8f2a-0000';
  const encoded = encodeURIComponent(token);
  for (const input of [
    `https://crm.phoenix.example.in/api/webhooks/msgraph?validationToken=${encoded}`,
    `?validationToken=${encoded}`,
    new URLSearchParams({ validationToken: token }),
    { validationToken: token },
    { validationToken: [token] },
  ]) {
    const res = validationResponse(input);
    assert.equal(res.status, 200);
    assert.equal(res.body, token);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal(validationResponse({}), null, 'a real notification has no validationToken');
  assert.equal(validationResponse('https://crm.phoenix.example.in/hook'), null);
});

test('validation handshake refuses markup and control characters', () => {
  for (const token of ['<script>alert(1)</script>', 'a\r\nSet-Cookie: x=1', '', 'x'.repeat(8193)]) {
    const res = validationResponse({ validationToken: token });
    assert.equal(res.status, 400, JSON.stringify(token.slice(0, 20)));
    assert.equal(res.body, '');
  }
});

test('verifyWebhook accepts a genuine change-notification batch', () => {
  const raw = Buffer.from(JSON.stringify(fixture('change-notifications.json')));
  const result = verifyWebhook(raw, JSON_HEADERS, SECRETS, { tenantId: TENANT_ID, now: NOTIFY_NOW });
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(result.notifications.length, 3);
  assert.deepEqual(result.rejected, []);
});

test('verifyWebhook accepts lifecycle notifications signed with a previous secret', () => {
  const raw = JSON.stringify(fixture('lifecycle-notifications.json'));
  const result = verifyWebhook(raw, JSON_HEADERS, SECRETS, { tenantId: TENANT_ID, now: NOTIFY_NOW });
  assert.equal(result.valid, true);
  const onlyCurrent = verifyWebhook(raw, JSON_HEADERS, WEBHOOK_SECRET, { tenantId: TENANT_ID, now: NOTIFY_NOW });
  assert.equal(onlyCurrent.valid, false);
  assert.deepEqual(onlyCurrent.rejected, [{ index: 2, reason: 'client_state_mismatch' }]);
  assert.equal(onlyCurrent.notifications.length, 2, 'valid items are still returned for processing');
});

test('verifyWebhook rejects tampered clientState, wrong tenant and unknown subscriptions', () => {
  const body = fixture('change-notifications.json');
  body.value[1].clientState = 'secretClientValue';
  body.value[2].tenantId = '99999999-2222-4333-8444-555555555555';
  const result = verifyWebhook(JSON.stringify(body), JSON_HEADERS, SECRETS, { tenantId: TENANT_ID, now: NOTIFY_NOW });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'client_state_mismatch');
  assert.deepEqual(result.rejected, [
    { index: 1, reason: 'client_state_mismatch' },
    { index: 2, reason: 'tenant_mismatch' },
  ]);

  const unknown = verifyWebhook(JSON.stringify(fixture('change-notifications.json')), JSON_HEADERS, SECRETS, {
    now: NOTIFY_NOW,
    isKnownSubscription: () => false,
  });
  assert.equal(unknown.reason, 'unknown_subscription');
});

test('verifyWebhook rejects notifications for subscriptions expired beyond the 4-hour redelivery window', () => {
  const raw = JSON.stringify(fixture('change-notifications.json'));
  const expiry = Date.parse('2026-11-12T04:30:00Z');
  const withinGrace = verifyWebhook(raw, JSON_HEADERS, SECRETS, { now: expiry + 4 * 3600_000 });
  assert.equal(withinGrace.valid, true, 'Graph may redeliver for up to 4 hours');
  const expired = verifyWebhook(raw, JSON_HEADERS, SECRETS, { now: expiry + 5 * 3600_000 });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'subscription_expired');
});

test('verifyWebhook rejects malformed requests before looking at items', () => {
  const raw = JSON.stringify(fixture('change-notifications.json'));
  const cases = [
    [raw, { 'content-type': 'text/plain' }, 'unsupported_content_type'],
    ['', JSON_HEADERS, 'empty_body'],
    ['{"value":', JSON_HEADERS, 'invalid_json'],
    ['{"value":[]}', JSON_HEADERS, 'no_notifications'],
    [raw, JSON_HEADERS, 'body_too_large', { maxBytes: 100 }],
  ];
  for (const [body, headers, reason, extra] of cases) {
    assert.equal(verifyWebhook(body, headers, SECRETS, { now: NOTIFY_NOW, ...extra }).reason, reason);
  }
  const headersObject = new Headers(JSON_HEADERS);
  assert.equal(verifyWebhook(raw, headersObject, SECRETS, { now: NOTIFY_NOW }).valid, true, 'Headers instances work too');
});

test('client.verifyNotification binds secrets, tenant and clock', () => {
  const { client } = makeClient([], { now: () => NOTIFY_NOW });
  const raw = JSON.stringify(fixture('lifecycle-notifications.json'));
  assert.equal(client.verifyNotification(raw, JSON_HEADERS).valid, true);
});

test('parseWebhook normalises change notifications with provider ids and dedupe keys', () => {
  const events = parseWebhook(fixture('change-notifications.json'));
  assert.deepEqual(events.map((e) => e.type), ['calendar.event.created', 'calendar.event.updated', 'calendar.event.deleted']);
  const [created, updated, deleted] = events;
  assert.equal(created.provider, 'msgraph');
  assert.equal(created.id, 'lsgTZMr9KwAAA');
  assert.equal(created.providerEventId, 'lsgTZMr9KwAAA');
  assert.equal(created.kind, 'change');
  assert.equal(created.resourceId, 'AAMkAGI1AAAt8AHjAAA=');
  assert.equal(created.mailboxId, '16664f75-11dc-4870-bec6-38c1aaa81431');
  assert.equal(created.resourceType, '#Microsoft.Graph.Event');
  assert.equal(created.subscriptionExpiresAt, '2026-11-12T04:30:00.000Z');
  assert.equal(created.tenantId, TENANT_ID);
  assert.equal(updated.providerEventId, null, 'Graph notification ids are optional');
  assert.match(updated.id, /^derived:[0-9a-f]{32}$/);
  assert.notEqual(created.dedupeKey, updated.dedupeKey);
  assert.equal(deleted.etag, null);
  assert.equal(parseWebhook(JSON.stringify(fixture('change-notifications.json')))[1].dedupeKey, updated.dedupeKey, 'stable across parses');
});

test('parseWebhook normalises lifecycle notifications', () => {
  const events = parseWebhook(Buffer.from(JSON.stringify(fixture('lifecycle-notifications.json'))));
  assert.deepEqual(events.map((e) => [e.kind, e.type, e.lifecycleEvent]), [
    ['lifecycle', 'subscription.reauthorization_required', 'reauthorizationRequired'],
    ['lifecycle', 'subscription.missed', 'missed'],
    ['lifecycle', 'subscription.removed', 'subscriptionRemoved'],
  ]);
  assert.equal(events[0].changeType, null);
  assert.equal(events[0].resourceId, null);
  assert.notEqual(events[0].dedupeKey, events[1].dedupeKey);
});

test('parseWebhook handles "{userId}@{tenantId}" resources and unknown change types', () => {
  const [event] = parseWebhook({
    value: [
      {
        subscriptionId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
        changeType: 'unknownFutureValue',
        resource: `users/16664f75-11dc-4870-bec6-38c1aaa81431@${TENANT_ID}/events/AAMk=`,
      },
    ],
  });
  assert.equal(event.mailboxId, '16664f75-11dc-4870-bec6-38c1aaa81431');
  assert.equal(event.resourceId, 'AAMk=');
  assert.equal(event.type, 'calendar.event.unknown');
});

// ---------------------------------------------------------------------------------------------
// validationTokens (rich notifications): RS256 JWTs signed by the Microsoft identity platform.
// We sign test tokens with a locally generated key and pass its JWKS in.
// ---------------------------------------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', use: 'sig' }] };
const NOW_SEC = Math.floor(NOTIFY_NOW / 1000);

function jwt(claimsOverride = {}, headerOverride = {}) {
  const header = { typ: 'JWT', alg: 'RS256', kid: 'test-kid-1', ...headerOverride };
  const claims = {
    aud: CLIENT_ID,
    iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    iat: NOW_SEC - 60,
    nbf: NOW_SEC - 60,
    exp: NOW_SEC + 3600,
    azp: GRAPH_CHANGE_TRACKING_APP_ID,
    tid: TENANT_ID,
    ver: '2.0',
    ...claimsOverride,
  };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = `${encode(header)}.${encode(claims)}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

const tokenOptions = { jwks: JWKS, clientId: CLIENT_ID, tenantId: TENANT_ID, now: NOTIFY_NOW };

test('validation token: valid v2.0 and v1.0 tokens pass', () => {
  assert.equal(verifyValidationToken(jwt(), tokenOptions).valid, true);
  const v1 = jwt({ ver: '1.0', azp: undefined, appid: GRAPH_CHANGE_TRACKING_APP_ID, iss: `https://sts.windows.net/${TENANT_ID}/` });
  assert.equal(verifyValidationToken(v1, tokenOptions).valid, true);
});

test('validation token: tampered, expired and mis-addressed tokens fail', () => {
  const good = jwt();
  const [h, , s] = good.split('.');
  const forgedClaims = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(good.split('.')[1], 'base64url')), aud: 'someone-else' })).toString('base64url');
  const cases = [
    [`${h}.${forgedClaims}.${s}`, 'bad_signature'],
    [jwt({ exp: NOW_SEC - 301 }), 'expired'],
    [jwt({ nbf: NOW_SEC + 301 }), 'not_yet_valid'],
    [jwt({ aud: '00000000-0000-0000-0000-000000000000' }), 'wrong_audience'],
    [jwt({ azp: CLIENT_ID }), 'wrong_publisher'],
    [jwt({ iss: 'https://evil.example/v2.0' }), 'wrong_issuer'],
    [jwt({ tid: '99999999-2222-4333-8444-555555555555' }), 'wrong_tenant'],
    [jwt({}, { kid: 'rotated-away' }), 'unknown_key'],
    [jwt({}, { alg: 'none' }), 'unsupported_alg'],
    ['not.a.jwt', 'malformed'],
  ];
  for (const [token, reason] of cases) {
    const result = verifyValidationToken(token, tokenOptions);
    assert.equal(result.valid, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('verifyWebhook checks validationTokens when present and a JWKS is supplied', () => {
  const body = fixture('change-notifications.json');
  const options = { now: NOTIFY_NOW, tenantId: TENANT_ID, jwks: JWKS, clientId: CLIENT_ID };
  const ok = verifyWebhook(JSON.stringify({ ...body, validationTokens: [jwt()] }), JSON_HEADERS, SECRETS, options);
  assert.equal(ok.valid, true);
  assert.equal(ok.validationTokensChecked, true);

  const bad = verifyWebhook(JSON.stringify({ ...body, validationTokens: [jwt(), jwt({ exp: NOW_SEC - 1000 })] }), JSON_HEADERS, SECRETS, options);
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'validation_token_expired');

  const required = verifyWebhook(JSON.stringify(body), JSON_HEADERS, SECRETS, { ...options, requireValidationTokens: true });
  assert.equal(required.reason, 'missing_validation_tokens');
});
