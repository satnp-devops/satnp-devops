import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import { validate } from '../../src/lib/validate.js';
import { describe } from '../../src/core/openapi/describe.js';
import { createRouteCollector, flattenHandlers, inspectHandlers } from '../../src/core/openapi/collector.js';

const idParams = z.object({ id: z.uuid() });
const noop = (_req, _res, next) => next();
const handler = (_req, res) => res.json({ data: null });

test('records method, path, module, schemas and description', () => {
  const collector = createRouteCollector();
  const router = collector.wrap(express.Router(), 'leads');
  const body = z.object({ name: z.string() });
  router.get('/leads/:id', describe({ summary: 'Get a lead' }), noop, validate({ params: idParams }), handler);
  router.post('/leads', validate({ body }), handler);

  assert.equal(collector.routes.length, 2);
  const [get, post] = collector.routes;
  assert.deepEqual(
    { method: get.method, path: get.path, module: get.module, order: get.order },
    { method: 'get', path: '/leads/:id', module: 'leads', order: 0 },
  );
  assert.equal(get.schemas.params, idParams);
  assert.equal(get.schemas.body, undefined);
  assert.equal(get.description.summary, 'Get a lead');
  assert.equal(post.schemas.body, body);
  assert.deepEqual(post.description, {});
  assert.equal(post.order, 1);
});

test('the wrapped router still routes requests exactly as before', async (t) => {
  const collector = createRouteCollector();
  const app = express();
  const api = express.Router();
  api.use(express.json());
  const router = collector.wrap(api, 'leads');
  router.get('/leads/:id', validate({ params: idParams }), (req, res) => res.json({ data: req.valid.params }));
  router.post('/leads', validate({ body: z.object({ name: z.string() }) }), (req, res) => res.status(201).json({ data: req.valid.body }));
  router.route('/things').get((_req, res) => res.json({ data: 'got' })).put((_req, res) => res.status(204).end());
  app.use('/api/v1', api);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: { code: err.code } }));

  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const id = '3f2b8a8e-4c3d-4b8a-9f1e-2d3c4b5a6f70';

  const got = await fetch(`${base}/leads/${id}`);
  assert.deepEqual(await got.json(), { data: { id } });
  const bad = await fetch(`${base}/leads/not-a-uuid`);
  assert.equal(bad.status, 422);
  const created = await fetch(`${base}/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Asha"}' });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { data: { name: 'Asha' } });
  assert.deepEqual(await (await fetch(`${base}/things`)).json(), { data: 'got' });
  assert.equal((await fetch(`${base}/things`, { method: 'PUT' })).status, 204);

  assert.deepEqual(
    collector.routes.map((r) => `${r.method} ${r.path}`),
    ['get /leads/:id', 'post /leads', 'get /things', 'put /things'],
  );
});

test('chained calls keep recording and return the wrapper', () => {
  const collector = createRouteCollector();
  const router = collector.wrap(express.Router(), 'm');
  const returned = router.get('/a', handler).post('/b', handler);
  assert.equal(returned, router);
  assert.deepEqual(
    collector.routes.map((r) => `${r.method} ${r.path}`),
    ['get /a', 'post /b'],
  );
});

test('router.route() chains are recorded once each, with the route path', () => {
  const collector = createRouteCollector();
  const router = collector.wrap(express.Router(), 'm');
  const route = router.route('/items/:id');
  const chained = route.get(validate({ params: idParams }), handler).patch(handler).delete(handler);
  assert.equal(chained, route);
  assert.deepEqual(
    collector.routes.map((r) => `${r.method} ${r.path}`),
    ['get /items/:id', 'patch /items/:id', 'delete /items/:id'],
  );
  assert.equal(collector.routes[0].schemas.params, idParams);
});

test('Express internals are not recorded twice (router.get calls this.route internally)', () => {
  const collector = createRouteCollector();
  const router = collector.wrap(express.Router(), 'm');
  router.get('/once', handler);
  router.delete('/once', handler);
  assert.equal(collector.routes.length, 2);
});

test('array paths record each path; non-string paths warn and are skipped', () => {
  const warnings = [];
  const collector = createRouteCollector({ onWarning: (m) => warnings.push(m) });
  const router = collector.wrap(express.Router(), 'm');
  router.get(['/a', '/b'], handler);
  router.get(/^\/regex$/, handler);
  router.route(/^\/r$/).get(handler);
  assert.deepEqual(
    collector.routes.map((r) => r.path),
    ['/a', '/b'],
  );
  assert.equal(warnings.length, 2);
  assert.deepEqual(collector.warnings, warnings);
  assert.match(warnings[0], /non-string path/);
});

test('router.all is recorded with a warning; it is left out of the spec later', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'm').all('/any', handler);
  assert.equal(collector.routes[0].method, 'all');
  assert.match(collector.warnings[0], /ALL \/any/);
});

test('mounting a sub-router warns that its routes are not documented, but still works', () => {
  const collector = createRouteCollector();
  const api = express.Router();
  const router = collector.wrap(api, 'm');
  const returned = router.use('/sub', express.Router());
  assert.equal(returned, router);
  router.use(noop);
  assert.equal(collector.warnings.length, 1);
  assert.match(collector.warnings[0], /sub-router/);
});

test('other router properties and methods pass through', () => {
  const collector = createRouteCollector();
  const api = express.Router();
  const router = collector.wrap(api, 'm');
  assert.equal(router.stack, api.stack);
  router.param('id', (_req, _res, next) => next());
  router.get('/x', handler);
  assert.ok(api.stack.some((layer) => layer.route?.path === '/x'));
});

test('a single-argument get (an app settings lookup) is forwarded and not recorded', () => {
  const collector = createRouteCollector();
  const app = express();
  app.set('title', 'Phoenix');
  const wrapped = collector.wrap(app, 'm');
  assert.equal(wrapped.get('title'), 'Phoenix');
  assert.equal(collector.routes.length, 0);
});

test('wrap needs a module name', () => {
  assert.throws(() => createRouteCollector().wrap(express.Router()), /module name/);
});

test('inspectHandlers flattens arrays, merges descriptions and lets the later validate() win', () => {
  const first = z.object({ a: z.string() });
  const second = z.object({ b: z.string() });
  const out = inspectHandlers([
    [describe({ summary: 'One', permission: 'users.view' }), [validate({ body: first, query: first })]],
    validate({ body: second }),
    describe({ summary: 'Two' }),
    'not a function',
  ]);
  assert.deepEqual(out.schemas, { body: second });
  assert.deepEqual(out.description, { summary: 'Two', permission: 'users.view' });
  assert.equal(flattenHandlers([noop, [noop, [noop]], null]).length, 3);
});

test('validate() exposes its schemas without changing behaviour', () => {
  const mw = validate({ params: idParams });
  const req = { params: { id: '3f2b8a8e-4c3d-4b8a-9f1e-2d3c4b5a6f70' } };
  let nextCalled = false;
  mw(req, {}, () => (nextCalled = true));
  assert.ok(nextCalled);
  assert.deepEqual(req.valid, { params: req.params });
  assert.equal(inspectHandlers([mw]).schemas.params, idParams);
});

test('a path Express refuses throws as before and is not recorded', () => {
  const collector = createRouteCollector();
  const router = collector.wrap(express.Router(), 'm');
  assert.throws(() => router.get('/bad/:', handler), /Missing parameter name/);
  assert.equal(collector.routes.length, 0);
});
