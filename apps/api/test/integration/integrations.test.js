import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { getAdapter, loadChannelIdentities } from '../../src/integrations/index.js';
import { decryptCredentials } from '../../src/integrations/framework/credentials.js';

// Integration framework end to end (docs/platform/INTEGRATIONS.md): connections CRUD and scoping,
// channel identities, the sandbox outbox, getAdapter against stored connections, and API keys.
// Needs a migrated and seeded database (npm run db:migrate && npm run db:seed). Unique names per run.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const RUN_DIGITS = String(Date.now()).slice(-5);

function client(base) {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  }
  call.login = async (email) => {
    const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
  };
  return call;
}

/** A machine client: only the Authorization header, no cookie and no X-Phoenix-Client. */
function keyClient(base, key) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

test('integration framework end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const cleanup = { connections: [], identities: [] };

  t.after(async () => {
    if (cleanup.identities.length) await db('channel_identities').whereIn('id', cleanup.identities).update({ archived_at: db.fn.now() });
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const owner = client(base);
  const spAdmin = client(base);
  const pvAdmin = client(base);
  const ritika = client(base);
  const kabir = client(base);
  await Promise.all([
    owner.login('owner@phoenix.test'),
    spAdmin.login('admin.satnpaper@phoenix.test'),
    pvAdmin.login('admin.pivector@phoenix.test'),
    ritika.login('ritika@phoenix.test'),
    kabir.login('kabir@phoenix.test'),
  ]);
  const units = (await owner('GET', '/auth/me')).body.data.units;
  const unit = (name) => units.find((u) => u.name === name);
  const group = unit('Phoenix Educational Institute');
  const satnpaper = unit('SatnPaper');
  const pivector = unit('Pi Vector');
  const satAdmissions = unit('SAT admissions');
  assert.ok(group && satnpaper && pivector && satAdmissions, 'seeded units');

  let spConnections;
  const spMock = (kind) => spConnections.find((c) => c.kind === kind && c.provider === 'mock' && c.owner.id === satnpaper.id);

  await t.test('the catalogue lists ten kinds and their providers for anyone signed in', async () => {
    const res = await ritika('GET', '/integrations/kinds');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.kinds.length, 10);
    assert.equal(res.body.data.mocksAllowed, true);
    const email = res.body.data.kinds.find((k) => k.key === 'messaging.email');
    assert.deepEqual(email.providers.map((p) => p.key).sort(), ['mock', 'sendgrid']);
  });

  await t.test('seeded mock connections: every kind is a default for SatnPaper; secrets never leave the server', async () => {
    const res = await spAdmin('GET', `/integrations/connections?unitId=${satnpaper.id}`);
    assert.equal(res.status, 200, res.text);
    spConnections = res.body.data;
    for (const kind of ['messaging.whatsapp', 'messaging.email', 'messaging.sms', 'calling', 'meetings', 'calendar', 'payments', 'esign', 'ai', 'storage']) {
      const mock = spMock(kind);
      assert.ok(mock, `${kind} mock`);
      assert.ok(mock.companies.some((c) => c.id === satnpaper.id && c.isDefault), `${kind} is the default`);
    }
    const shared = spConnections.find((c) => c.shared && c.kind === 'messaging.whatsapp');
    assert.ok(shared, 'the group WhatsApp shared with SatnPaper is listed');
    assert.equal(shared.canManage, false, 'a company admin cannot change a group connection');
    assert.ok(!res.text.includes('credentials_enc') && !res.text.includes('v1:'), 'no ciphertext in the response');
  });

  await t.test('scoping: other companies are 404, roles without integrations.view are 403', async () => {
    assert.equal((await pvAdmin('GET', `/integrations/connections?unitId=${satnpaper.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/integrations/connections/${spMock('payments').id}`)).status, 404);
    assert.equal((await pvAdmin('PATCH', `/integrations/connections/${spMock('payments').id}`, { name: 'x' })).status, 404);
    assert.equal((await pvAdmin('DELETE', `/integrations/connections/${spMock('payments').id}`)).status, 404);
    assert.equal((await ritika('GET', `/integrations/connections?unitId=${satAdmissions.id}`)).status, 403);
    assert.equal((await ritika('GET', `/integrations/connections/${spMock('payments').id}`)).status, 404);
    assert.equal((await kabir('GET', `/integrations/sandbox?unitId=${satnpaper.id}`)).status, 403);
    const pvList = await pvAdmin('GET', `/integrations/connections?unitId=${pivector.id}`);
    assert.equal(pvList.status, 200);
    assert.ok(pvList.body.data.every((c) => c.owner.id !== satnpaper.id), 'no SatnPaper connections for Pi Vector');
    const shared = pvList.body.data.find((c) => c.shared);
    assert.ok(shared, 'Pi Vector sees the shared group connection it uses');
    assert.equal((await pvAdmin('PATCH', `/integrations/connections/${shared.id}`, { name: 'Taken over' })).status, 403);
    // The group view: the owner sees every company's connections.
    const all = await owner('GET', `/integrations/connections?unitId=${group.id}&kind=payments`);
    assert.ok(all.body.data.some((c) => c.owner.id === satnpaper.id) && all.body.data.some((c) => c.owner.id === pivector.id));
  });

  let sendgrid;
  await t.test('connect a real provider: fields validated, credentials encrypted, health stored', async () => {
    const name = `SendGrid ${RUN}`;
    const bad = await spAdmin('POST', '/integrations/connections', {
      unitId: satnpaper.id,
      kind: 'messaging.email',
      provider: 'sendgrid',
      name,
      config: { fromEmail: 'admissions@satnpaper.example.com' },
      credentials: { apiKey: 'not-a-key' },
    });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.some((d) => d.path === 'body.credentials.apiKey'));

    const apiKey = `SG.${RUN}abcdefgh.secretpart${RUN}`;
    const res = await spAdmin('POST', '/integrations/connections', {
      unitId: satnpaper.id,
      kind: 'messaging.email',
      provider: 'sendgrid',
      name,
      config: { fromEmail: 'Admissions@SatnPaper.example.com', fromName: 'SatnPaper' },
      credentials: { apiKey },
    });
    assert.equal(res.status, 201, res.text);
    sendgrid = res.body.data;
    cleanup.connections.push(sendgrid.id);
    assert.equal(sendgrid.config.fromEmail, 'admissions@satnpaper.example.com');
    assert.equal(sendgrid.config.region, 'global', 'defaults are filled');
    assert.match(sendgrid.credentials.apiKey, /^•+/);
    assert.ok(!res.text.includes('secretpart'), 'the key is not echoed');
    assert.equal(sendgrid.companies[0].isDefault, false, 'the existing default (the mock) stays');

    const row = await db('integration_connections').where({ id: sendgrid.id }).first();
    assert.ok(!row.credentials_enc.includes('secretpart'));
    assert.deepEqual(decryptCredentials(row.id, row.credentials_enc, env.encryptionKey), { apiKey });

    assert.equal((await spAdmin('POST', '/integrations/connections', { unitId: satnpaper.id, kind: 'messaging.email', provider: 'sendgrid', name, config: { fromEmail: 'a@b.co' }, credentials: { apiKey } })).status, 409);
    assert.equal((await pvAdmin('POST', '/integrations/connections', { unitId: satnpaper.id, kind: 'ai', provider: 'mock', name: `x ${RUN}` })).status, 404);
    assert.equal((await kabir('POST', '/integrations/connections', { unitId: satnpaper.id, kind: 'ai', provider: 'mock', name: `x ${RUN}` })).status, 403);

    const tested = await spAdmin('POST', `/integrations/connections/${sendgrid.id}/test`);
    assert.equal(tested.status, 200);
    assert.equal(tested.body.data.result.ok, false);
    assert.match(tested.body.data.result.message, /not implemented yet/);
    assert.equal(tested.body.data.connection.health.status, 'failing');
    assert.equal((await spAdmin('POST', `/integrations/connections/${sendgrid.id}/try`)).status, 409, 'try is for mocks');

    const patched = await spAdmin('PATCH', `/integrations/connections/${sendgrid.id}`, { config: { fromName: null }, credentials: { apiKey: `SG.new${RUN}.other${RUN}xyz` } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.data.config.fromName, undefined, 'null clears an optional field');
    assert.equal(patched.body.data.health.status, 'unknown', 'new credentials need a new test');
    assert.equal(patched.body.data.config.fromEmail, 'admissions@satnpaper.example.com', 'untouched fields stay');
    const audit = await db('audit_logs').where({ entity_type: 'integration_connection', entity_id: sendgrid.id }).select('action', 'before', 'after', 'meta');
    assert.ok(audit.some((a) => a.action === 'integration_connection.created'));
    assert.ok(!JSON.stringify(audit).includes('secretpart') && !JSON.stringify(audit).includes(`other${RUN}`), 'secrets stay out of the audit log');
  });

  await t.test("getAdapter resolves the company's default, a named connection, and the stub's clear error", async () => {
    const mockEmail = await getAdapter({ companyId: satnpaper.id, kind: 'messaging.email' });
    assert.equal(mockEmail.connection.provider, 'mock');
    assert.equal(mockEmail.connection.id, spMock('messaging.email').id);

    const named = await getAdapter({ companyId: satnpaper.id, kind: 'messaging.email', connectionId: sendgrid.id });
    await assert.rejects(named.send({ to: [{ email: 'parent@example.com' }], subject: 'Hi', text: 'Hello' }), (error) => error.code === 'integration_not_implemented');
    await assert.rejects(getAdapter({ companyId: pivector.id, kind: 'messaging.email', connectionId: sendgrid.id }), (error) => error.code === 'integration_unavailable');

    const made = await spAdmin('POST', `/integrations/connections/${sendgrid.id}/default`, { companyId: satnpaper.id });
    assert.equal(made.status, 200, made.text);
    assert.equal((await getAdapter({ companyId: satnpaper.id, kind: 'messaging.email' })).connection.id, sendgrid.id);
    assert.equal((await pvAdmin('POST', `/integrations/connections/${sendgrid.id}/default`, { companyId: satnpaper.id })).status, 404);

    // Disconnecting the default falls back to the next active connection (the seeded mock).
    assert.equal((await spAdmin('DELETE', `/integrations/connections/${sendgrid.id}`)).status, 204);
    assert.equal((await spAdmin('GET', `/integrations/connections/${sendgrid.id}`)).status, 404);
    const row = await db('integration_connections').where({ id: sendgrid.id }).first();
    assert.equal(row.credentials_enc, null, 'credentials are wiped on disconnect');
    assert.equal((await getAdapter({ companyId: satnpaper.id, kind: 'messaging.email' })).connection.id, spMock('messaging.email').id);
    const restored = await spAdmin('POST', `/integrations/connections/${spMock('messaging.email').id}/default`, { companyId: satnpaper.id });
    assert.equal(restored.status, 200);
  });

  await t.test('try a mock: the sample lands in the sandbox outbox of its company only', async () => {
    const tried = await spAdmin('POST', `/integrations/connections/${spMock('messaging.whatsapp').id}/try`);
    assert.equal(tried.status, 200, tried.text);
    assert.equal(tried.body.data.ok, true);
    const outbox = await spAdmin('GET', `/integrations/sandbox?unitId=${satnpaper.id}&limit=5`);
    assert.equal(outbox.status, 200);
    assert.equal(outbox.body.data[0].connection.id, spMock('messaging.whatsapp').id);
    assert.ok('nextCursor' in outbox.body);
    const pvOutbox = await pvAdmin('GET', `/integrations/sandbox?unitId=${pivector.id}&limit=100`);
    assert.ok(pvOutbox.body.data.every((m) => m.company?.id !== satnpaper.id));
    assert.equal((await pvAdmin('GET', `/integrations/sandbox?unitId=${satnpaper.id}`)).status, 404);
  });

  await t.test('channel identities: owned by a company or shared, unique per group, routed by intake', async () => {
    const number = `+91 98${RUN_DIGITS.slice(0, 3)} ${RUN_DIGITS}`;
    const e164 = `+9198${RUN_DIGITS.slice(0, 3)}${RUN_DIGITS}`;
    const body = { type: 'whatsapp', identity: number, label: `Test ${RUN}`, companyId: satnpaper.id, connectionId: spMock('messaging.whatsapp').id };
    assert.equal((await pvAdmin('POST', '/integrations/identities', body)).status, 404, 'another company');
    assert.equal((await kabir('POST', '/integrations/identities', body)).status, 403);
    const created = await spAdmin('POST', '/integrations/identities', body);
    assert.equal(created.status, 201, created.text);
    cleanup.identities.push(created.body.data.id);
    assert.equal(created.body.data.normalized, e164);
    assert.equal((await spAdmin('POST', '/integrations/identities', { ...body, identity: '+91 12345' })).status, 422, 'not a phone number');
    assert.equal((await spAdmin('POST', '/integrations/identities', { ...body, identity: number.replace(/ /g, '') })).status, 409, 'same number, other spelling');
    const wrongKind = await spAdmin('POST', '/integrations/identities', { ...body, identity: `+9197${RUN_DIGITS.slice(0, 3)}${RUN_DIGITS}`, connectionId: spMock('payments').id });
    assert.equal(wrongKind.status, 422);

    const sharedBody = { type: 'website_form', identity: `forms.example.com/${RUN}`, shared: true, companyIds: [satnpaper.id, pivector.id] };
    const notVisible = await spAdmin('POST', '/integrations/identities', sharedBody);
    assert.equal(notVisible.status, 422, 'a company admin cannot even see Pi Vector');
    assert.equal(notVisible.body.error.details[0].path, 'body.companyIds.1');
    const shared = await owner('POST', '/integrations/identities', sharedBody);
    assert.equal(shared.status, 201, shared.text);
    cleanup.identities.push(shared.body.data.id);

    const pvList = await pvAdmin('GET', `/integrations/identities?unitId=${pivector.id}`);
    const ids = pvList.body.data.map((i) => i.id);
    assert.ok(ids.includes(shared.body.data.id), 'Pi Vector sees the shared channel');
    assert.ok(!ids.includes(created.body.data.id), "but not SatnPaper's own number");
    assert.equal((await pvAdmin('DELETE', `/integrations/identities/${created.body.data.id}`)).status, 404);
    const spShared = (await spAdmin('GET', `/integrations/identities?unitId=${satnpaper.id}`)).body.data.find((i) => i.id === shared.body.data.id);
    assert.deepEqual(spShared.companies.map((c) => c.id), [satnpaper.id], 'companies outside your scope are not named');

    const registry = await loadChannelIdentities(group.id);
    const entry = registry.find((i) => i.id === created.body.data.id);
    assert.equal(entry.companyId, satnpaper.id);
    assert.equal(entry.identity, e164);
    assert.deepEqual(registry.find((i) => i.id === shared.body.data.id).companyIds.sort(), [satnpaper.id, pivector.id].sort());

    assert.equal((await spAdmin('DELETE', `/integrations/identities/${created.body.data.id}`)).status, 204);
    assert.equal((await owner('DELETE', `/integrations/identities/${shared.body.data.id}`)).status, 204);
  });

  let readKey;
  let writeKey;
  await t.test('API keys: created with scopes the creator holds, shown once, stored hashed', async () => {
    assert.equal((await ritika('GET', `/api-keys?unitId=${satAdmissions.id}`)).status, 403);
    assert.equal((await ritika('POST', '/api-keys', { unitId: satnpaper.id, name: 'x', scopes: ['contacts.view'] })).status, 403);
    const scopes = await spAdmin('GET', `/api-keys/scopes?unitId=${satnpaper.id}`);
    assert.equal(scopes.status, 200);
    const keys = scopes.body.data.flatMap((g) => g.permissions.map((p) => p.key));
    assert.ok(keys.includes('integrations.view') && !keys.includes('api_keys.manage'));

    assert.equal((await spAdmin('POST', '/api-keys', { unitId: satnpaper.id, name: 'x', scopes: ['api_keys.manage'] })).status, 422);
    assert.equal((await spAdmin('POST', '/api-keys', { unitId: group.id, name: 'x', scopes: ['integrations.view'] })).status, 403);
    assert.equal((await pvAdmin('POST', '/api-keys', { unitId: satnpaper.id, name: 'x', scopes: ['integrations.view'] })).status, 404);

    const created = await spAdmin('POST', '/api-keys', { unitId: satnpaper.id, name: `Reader ${RUN}`, scopes: ['integrations.view'] });
    assert.equal(created.status, 201, created.text);
    readKey = created.body.data;
    assert.match(readKey.secret, /^phx_/);
    assert.equal(readKey.prefix, readKey.secret.slice(0, 12));
    const row = await db('api_keys').where({ id: readKey.id }).first();
    assert.equal(row.key_hash, createHash('sha256').update(readKey.secret).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(readKey.secret));
    const listed = await spAdmin('GET', `/api-keys?unitId=${satnpaper.id}`);
    const item = listed.body.data.find((k) => k.id === readKey.id);
    assert.ok(item && !('secret' in item), 'the list never shows the key');
    assert.ok(!(await pvAdmin('GET', `/api-keys?unitId=${pivector.id}`)).body.data.some((k) => k.id === readKey.id));

    const writer = await spAdmin('POST', '/api-keys', { unitId: satnpaper.id, name: `Writer ${RUN}`, scopes: ['integrations.view', 'integrations.manage'] });
    assert.equal(writer.status, 201);
    writeKey = writer.body.data;
  });

  await t.test('Bearer keys: reads work, writes need scopes, other companies are 404, cookies are ignored', async () => {
    const reader = keyClient(base, readKey.secret);
    const list = await reader('GET', `/integrations/connections?unitId=${satnpaper.id}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.data.length >= 10);
    assert.equal((await reader('GET', `/integrations/connections?unitId=${pivector.id}`)).status, 404);
    // At the group, a company key sees only its company's share.
    const atGroup = await reader('GET', `/integrations/connections?unitId=${group.id}`);
    assert.equal(atGroup.status, 200);
    assert.ok(atGroup.body.data.every((c) => c.companies.length > 0 && c.companies.every((co) => co.id === satnpaper.id)));
    const denied = await reader('POST', '/integrations/identities', { type: 'website_form', identity: `k.example.com/${RUN}`, companyId: satnpaper.id });
    assert.equal(denied.status, 403, 'writes need integrations.manage');
    assert.equal((await reader('GET', '/auth/me')).status, 403, 'no account endpoints');
    assert.equal((await reader('POST', '/api-keys', { unitId: satnpaper.id, name: 'x', scopes: ['integrations.view'] })).status, 403);

    const writer = keyClient(base, writeKey.secret);
    const made = await writer('POST', '/integrations/identities', { type: 'website_form', identity: `k.example.com/${RUN}`, companyId: satnpaper.id });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    cleanup.identities.push(made.body.data.id);
    const audit = await db('audit_logs').where({ entity_type: 'channel_identity', entity_id: made.body.data.id }).first();
    assert.equal(audit.actor_type, 'api_key');
    const keyRow = await db('api_keys').where({ id: writeKey.id }).first();
    assert.equal(audit.actor_user_id, keyRow.service_user_id);
    assert.equal((await writer('DELETE', `/integrations/identities/${made.body.data.id}`)).status, 204);

    // An Authorization header switches the cookie off: a bad key with a valid session is still 401.
    const mixed = await spAdmin('GET', `/integrations/connections?unitId=${satnpaper.id}`, undefined, { authorization: 'Bearer phx_not-a-real-key' });
    assert.equal(mixed.status, 401);
    assert.equal((await keyClient(base, 'phx_short')('GET', `/integrations/kinds`)).status, 401);

    await redis.set(`rl:apikey:${readKey.id}`, String(env.API_KEY_RATE_LIMIT), 'EX', 60);
    assert.equal((await reader('GET', '/integrations/kinds')).status, 429, 'rate limited per key');
    await redis.del(`rl:apikey:${readKey.id}`);
    await redis.del(`apikey:touch:${readKey.id}`);
  });

  await t.test('revoked keys fail at once; revoking is audited and scoped', async () => {
    assert.equal((await pvAdmin('DELETE', `/api-keys/${readKey.id}`)).status, 404);
    assert.equal((await spAdmin('DELETE', `/api-keys/${readKey.id}`)).status, 204);
    assert.equal((await spAdmin('DELETE', `/api-keys/${readKey.id}`)).status, 204, 'revoking twice is a no-op');
    assert.equal((await keyClient(base, readKey.secret)('GET', `/integrations/connections?unitId=${satnpaper.id}`)).status, 401);
    assert.equal((await spAdmin('DELETE', `/api-keys/${writeKey.id}`)).status, 204);
    const listed = await spAdmin('GET', `/api-keys?unitId=${satnpaper.id}&status=all`);
    assert.equal(listed.body.data.find((k) => k.id === readKey.id).status, 'revoked');
    assert.ok(!(await spAdmin('GET', `/api-keys?unitId=${satnpaper.id}&status=active`)).body.data.some((k) => k.id === readKey.id));
    const row = await db('api_keys').where({ id: readKey.id }).first();
    assert.ok(row.last_used_at, 'last use was recorded');
    assert.ok(await db('audit_logs').where({ entity_type: 'api_key', entity_id: readKey.id, action: 'api_key.revoked' }).first());
  });
});
