import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, verify } from 'node:crypto';
import {
  buildAuthorizationUrl,
  createGoogleClient,
  createServiceAccountAssertion,
  exchangeAuthorizationCode,
  revokeToken,
  signRs256,
} from '../../../src/integrations/providers/google/index.js';
import { NOW, fakeFetch, fixture, googleError, makeClient, testPrivateKeyPem, testPublicKey, tokenOk } from './_helpers.js';

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('RS256 signer reproduces the RFC 7515 Appendix A.2 signature exactly', () => {
  const vector = fixture('rfc7515-a2.json');
  const key = createPrivateKey({ key: vector.jwk, format: 'jwk' });
  assert.equal(signRs256(vector.signingInput, key), vector.signature);
  // Same result when the key arrives as PKCS#8 PEM, the format in Google's JSON key files.
  const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.equal(signRs256(vector.signingInput, pem), vector.signature);
});

test('service-account assertion has the documented header and claims and a valid signature', () => {
  const { assertion, expiresAtMs } = createServiceAccountAssertion({
    clientEmail: 'svc@proj.iam.gserviceaccount.com',
    privateKey: testPrivateKeyPem,
    privateKeyId: 'kid-1',
    subject: 'admin@school.example.in',
    scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/meetings.space.readonly'],
    audience: 'https://oauth2.googleapis.com/token',
    nowMs: NOW + 999,
    lifetimeSeconds: 7200, // clamped to Google's 1 hour maximum
  });
  const [h, p, s] = assertion.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
  const iat = Math.floor(NOW / 1000);
  assert.deepEqual(decode(p), {
    iss: 'svc@proj.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: iat + 3600,
    iat,
    sub: 'admin@school.example.in',
  });
  assert.equal(expiresAtMs, (iat + 3600) * 1000);
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), testPublicKey, Buffer.from(s, 'base64url')));
});

test('assertion omits sub and kid when not configured', () => {
  const { assertion } = createServiceAccountAssertion({
    clientEmail: 'svc@proj.iam.gserviceaccount.com',
    privateKey: testPrivateKeyPem,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    audience: 'https://oauth2.googleapis.com/token',
    nowMs: NOW,
  });
  const [h, p] = assertion.split('.');
  assert.equal('kid' in decode(h), false);
  assert.equal('sub' in decode(p), false);
});

test('token request uses the JWT bearer grant and the token is cached until shortly before expiry', async () => {
  const { client, fake, advance } = makeClient([tokenOk('ya29.first-token-aaaa', 3600), tokenOk('ya29.second-token-bbbb', 3600)]);
  assert.equal(await client.getAccessToken(), 'ya29.first-token-aaaa');
  const call = fake.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url.href, 'https://oauth2.googleapis.com/token');
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(call.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = decode(call.form.get('assertion').split('.')[1]);
  assert.equal(claims.sub, 'counsellor@phoenix-school.example.in');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(call.headers.authorization, undefined);

  advance(3600_000 - 61_000);
  assert.equal(await client.getAccessToken(), 'ya29.first-token-aaaa');
  assert.equal(fake.calls.length, 1);
  advance(2_000); // inside the 60 s refresh margin
  assert.equal(await client.getAccessToken(), 'ya29.second-token-bbbb');
  assert.equal(fake.calls.length, 2);
});

test('concurrent callers share one token refresh', async () => {
  const { client, fake } = makeClient([tokenOk()]);
  const [a, b, c] = await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(fake.calls.length, 1);
});

test('per-user OAuth refreshes with the refresh_token grant', async () => {
  const fake = fakeFetch([tokenOk('ya29.user-token-cccc')]);
  const client = createGoogleClient(
    { auth: { type: 'oauth_user', clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-value', refreshToken: '1//0g-refresh-token-value' } },
    { fetch: fake.fetch, now: () => NOW },
  );
  assert.equal(await client.getAccessToken(), 'ya29.user-token-cccc');
  const form = fake.calls[0].form;
  assert.deepEqual(Object.fromEntries(form), {
    client_id: 'cid.apps.googleusercontent.com',
    client_secret: 'GOCSPX-secret-value',
    refresh_token: '1//0g-refresh-token-value',
    grant_type: 'refresh_token',
  });
});

test('invalid_grant is a permanent auth_failed error and leaks no secrets', async () => {
  const fake = fakeFetch([{ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked. 1//0g-refresh-token-value' } }]);
  const client = createGoogleClient(
    { auth: { type: 'oauth_user', clientId: 'cid', clientSecret: 'GOCSPX-secret-value', refreshToken: '1//0g-refresh-token-value' } },
    { fetch: fake.fetch, now: () => NOW, sleep: async () => {} },
  );
  await assert.rejects(client.getAccessToken(), (error) => {
    assert.equal(error.code, 'auth_failed');
    assert.equal(error.reason, 'invalid_grant');
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes('1//0g-refresh-token-value'));
    assert.ok(!JSON.stringify(error).includes('GOCSPX'));
    return true;
  });
  assert.equal(fake.calls.length, 1, 'permanent errors are not retried');
});

test('token endpoint 503 is retried with backoff', async () => {
  const { client, fake, sleeps } = makeClient([{ status: 503, json: { error: 'backend_error' } }, tokenOk()]);
  await client.getAccessToken();
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(sleeps, [100]);
});

test('a 401 from the API refreshes the token once and resends', async () => {
  const { client, fake } = makeClient([
    tokenOk('ya29.stale-token-dddd'),
    googleError(401, 'authError', 'Invalid Credentials'),
    tokenOk('ya29.fresh-token-eeee'),
    { json: { kind: 'calendar#event', id: 'evt12345', start: {}, end: {} } },
  ]);
  const event = await client.calendar.getEvent({ eventId: 'evt12345' });
  assert.equal(event.id, 'evt12345');
  assert.equal(fake.calls[1].headers.authorization, 'Bearer ya29.stale-token-dddd');
  assert.equal(fake.calls[3].headers.authorization, 'Bearer ya29.fresh-token-eeee');
});

test('a second 401 surfaces as auth_failed', async () => {
  const { client } = makeClient([tokenOk(), googleError(401, 'authError'), tokenOk(), googleError(401, 'authError')]);
  await assert.rejects(client.calendar.getEvent({ eventId: 'evt12345' }), { code: 'auth_failed', status: 401 });
});

test('buildAuthorizationUrl requests offline access with consent and PKCE', () => {
  const url = new URL(
    buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://crm.phoenix.example.in/oauth/google/callback',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
      state: 'st-123',
      codeChallenge: 'abc',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events');
});

test('exchangeAuthorizationCode posts the code once and maps the response', async () => {
  const fake = fakeFetch([
    { json: { access_token: 'ya29.x', expires_in: 3599, refresh_token: '1//new-refresh', scope: 'a b', token_type: 'Bearer' } },
  ]);
  const result = await exchangeAuthorizationCode(
    { clientId: 'cid', clientSecret: 'GOCSPX-secret', code: '4/0code', redirectUri: 'https://x.example/cb', codeVerifier: 'v' },
    { fetch: fake.fetch },
  );
  assert.equal(result.refreshToken, '1//new-refresh');
  assert.deepEqual(result.scopes, ['a', 'b']);
  assert.equal(fake.calls[0].form.get('grant_type'), 'authorization_code');
  assert.equal(fake.calls[0].form.get('code_verifier'), 'v');
});

test('revokeToken posts to the revoke endpoint', async () => {
  const fake = fakeFetch([{ status: 200, body: '' }]);
  assert.deepEqual(await revokeToken({ token: '1//refresh' }, { fetch: fake.fetch }), { revoked: true });
  assert.equal(fake.calls[0].url.href, 'https://oauth2.googleapis.com/revoke');
  assert.equal(fake.calls[0].form.get('token'), '1//refresh');
});
