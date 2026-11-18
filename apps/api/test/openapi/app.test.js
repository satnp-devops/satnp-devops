import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { env } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createRouteCollector } from '../../src/core/openapi/collector.js';
import { openapiRoutes } from '../../src/core/openapi/http.js';
import { buildSpec, routeKey } from '../../src/core/openapi/spec.js';
import { lintSpec } from '../../src/core/openapi/lint.js';
import { toOpenApiPaths } from '../../src/core/openapi/paths.js';
import { PHASE1_DESCRIPTIONS } from '../../src/core/openapi/phase1.js';
import { parseDescription } from '../../src/core/openapi/describe.js';

// The real installation: every module in modules/index.js, wired by createApp exactly as the server does.
// Nothing here touches Postgres or Redis (requests carry no session cookie).

const registry = buildRegistry();
const app = createApp({ registry, modules });
const routes = app.locals.routes;

function build() {
  const warnings = [];
  // apiKeys: app.js documents Bearer API keys since phase 3 (modules/integrations/apiKeys).
  const doc = buildSpec(registry, routes, { descriptions: PHASE1_DESCRIPTIONS, apiKeys: true, onWarning: (m) => warnings.push(m) });
  return { doc, warnings };
}

/** Routes as Express itself sees them, read from the router stack: an independent check on the collector. */
function expressRoutes() {
  const out = [];
  for (const layer of app.router.stack) {
    if (!Array.isArray(layer.handle?.stack)) continue;
    for (const inner of layer.handle.stack) {
      if (!inner.route) continue;
      for (const method of Object.keys(inner.route.methods)) {
        if (method !== '_all') out.push({ method, path: inner.route.path });
      }
    }
  }
  return out;
}

test('the collector saw every route Express registered under /api/v1', () => {
  const registered = expressRoutes().map((r) => routeKey(r.method, r.path));
  const collected = routes.map((r) => routeKey(r.method, r.path));
  assert.ok(registered.length >= 40, `expected the phase 1 routes, found ${registered.length}`);
  assert.deepEqual([...collected].sort(), [...registered].sort());
});

test('every registered route appears in the document', () => {
  const { doc } = build();
  for (const { method, path } of expressRoutes()) {
    for (const variant of toOpenApiPaths(path)) {
      assert.ok(doc.paths[variant.path]?.[method], `${method.toUpperCase()} ${variant.path} is missing from the spec`);
    }
  }
});

test('each route carries the module that registered it', () => {
  const { doc } = build();
  const names = new Set(registry.modules.map((m) => m.name));
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) assert.ok(names.has(op['x-module']), op.operationId);
  }
  assert.equal(doc.paths['/users/{id}'].get['x-module'], 'users');
  assert.equal(doc.paths['/auth/login'].post['x-module'], 'auth');
  assert.equal(doc.paths['/openapi.json'].get['x-module'], 'system');
  // One tag per module that registered routes, in load order (a module whose routes are still empty,
  // such as a phase 2 skeleton before its slice lands, gets no tag).
  const withRoutes = new Set(routes.map((r) => r.module));
  assert.deepEqual(
    doc.tags.map((t) => t.name),
    registry.modules.map((m) => m.name).filter((name) => withRoutes.has(name)),
  );
});

test('every phase 1 route has a summary, and every catalogue entry matches a route (builds without warnings)', () => {
  const { doc, warnings } = build();
  assert.deepEqual(warnings, []);
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.notEqual(op.summary, `${method.toUpperCase()} ${path}`, `${method} ${path} needs a summary`);
    }
  }
});

test('catalogue entries are valid descriptions', () => {
  for (const [key, meta] of Object.entries(PHASE1_DESCRIPTIONS)) {
    assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \//, key);
    assert.doesNotThrow(() => parseDescription(meta, key));
    assert.ok(meta.summary && !meta.summary.endsWith('.'), `${key}: one-line summary without a full stop`);
  }
});

test('the document passes the structural lint and has no dangling refs', () => {
  const { doc } = build();
  assert.deepEqual(lintSpec(doc), []);
});

test('phase 1 specifics: params, queries, bodies, auth and statuses', () => {
  const { doc } = build();
  const p = doc.paths;

  assert.deepEqual(
    p['/users/{id}/assignments/{assignmentId}'].delete.parameters.map((x) => [x.name, x.in, x.schema.format]),
    [
      ['id', 'path', 'uuid'],
      ['assignmentId', 'path', 'uuid'],
    ],
  );
  assert.ok(p['/users/{id}/assignments/{assignmentId}'].delete.responses['204']);

  const audit = p['/audit'].get;
  assert.ok(audit.responses['200'].content['application/json'].schema.properties.nextCursor);
  assert.deepEqual(audit['x-permissions'], ['audit.view']);
  const limit = audit.parameters.find((x) => x.name === 'limit');
  assert.deepEqual([limit.required, limit.schema.type, limit.schema.default], [false, 'integer', 50]);
  assert.equal(audit.parameters.find((x) => x.name === 'unitId').required, true);

  const login = p['/auth/login'].post;
  assert.deepEqual(login.security, [{ phoenixClient: [] }]);
  assert.deepEqual(login.requestBody.content['application/json'].schema.required, ['email', 'password']);
  assert.equal(login.requestBody.content['application/json'].schema.properties.email.format, 'email');
  assert.ok(login.responses['429']);
  assert.equal(
    login.responses['200'].content['application/json'].schema.properties.data.properties.mfaRequired.type,
    'boolean',
  );

  assert.deepEqual(p['/auth/logout'].post.security, [{ session: [], phoenixClient: [] }, { phoenixClient: [] }]);
  assert.deepEqual(p['/auth/invites/{token}'].get.security, [{}]);
  assert.deepEqual(p['/org/units'].post.security, [{ session: [], phoenixClient: [] }, { apiKey: [] }]);
  assert.ok(p['/org/units'].post.responses['201']);
  assert.deepEqual(p['/settings/{key}'].put.parameters.map((x) => x.name), ['key']);
  assert.deepEqual(p['/settings/{key}'].delete.parameters.map((x) => [x.name, x.in]), [
    ['key', 'path'],
    ['unitId', 'query'],
  ]);
  assert.deepEqual(p['/roles'].get['x-permissions'], ['roles.view', 'users.manage']);
  const health = p['/health'].get.responses;
  assert.equal(health['200'].content['application/json'].schema.properties.status.enum[0], 'ok');
  assert.ok(health['503'].content['application/json'].schema.properties.checks);
});

test('GET /api/v1/openapi.json serves the document outside production, without a session', async (t) => {
  assert.equal(env.isProd, false, 'tests run outside production');
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/v1/openapi.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  const served = await res.json();
  assert.match(served.openapi, /^3\.1\./);
  assert.deepEqual(lintSpec(served), []);
  assert.deepEqual(served, JSON.parse(JSON.stringify(build().doc)));
  assert.deepEqual(served.paths['/openapi.json'].get.security, [{}]);
  assert.equal(served.components.securitySchemes.session.name, env.SESSION_COOKIE_NAME);

  const again = await fetch(`${base}/api/v1/openapi.json`);
  assert.deepEqual(await again.json(), served);
});

test('in production the document needs a signed-in session', async (t) => {
  const prod = express();
  const api = express.Router();
  const collector = createRouteCollector();
  openapiRoutes(collector.wrap(api, 'system'), { registry, routes: collector.routes, isProd: true });
  prod.use('/api/v1', api);
  prod.use(errorHandler);
  const server = prod.listen(0);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/openapi.json`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'unauthorized');
  // It documents itself as needing a session.
  const route = collector.routes.find((r) => r.path === '/openapi.json');
  assert.equal(route.description.auth, 'session');
});

test('the document is built once and cached', () => {
  const api = express.Router();
  const collector = createRouteCollector();
  const { spec } = openapiRoutes(collector.wrap(api, 'system'), { registry, routes: collector.routes, isProd: false });
  assert.equal(spec(), spec());
});

test('build warnings are logged once, not thrown', () => {
  const logged = [];
  const collector = createRouteCollector();
  const api = collector.wrap(express.Router(), 'system');
  api.get('/undescribed', (_req, res) => res.json({ data: null }));
  const { spec } = openapiRoutes(api, {
    registry,
    routes: collector.routes,
    isProd: false,
    log: { warn: (obj, msg) => logged.push({ obj, msg }) },
  });
  spec();
  spec();
  assert.equal(logged.length, 1);
  assert.ok(logged[0].obj.warnings.some((w) => /GET \/undescribed has no summary/.test(w)));
});
