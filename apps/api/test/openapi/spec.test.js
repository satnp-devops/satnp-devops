import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import { validate } from '../../src/lib/validate.js';
import { describe } from '../../src/core/openapi/describe.js';
import { createRouteCollector } from '../../src/core/openapi/collector.js';
import { OPENAPI_VERSION, buildSpec, operationIdFor, routeKey } from '../../src/core/openapi/spec.js';
import { lintSpec } from '../../src/core/openapi/lint.js';
import { securityFor } from '../../src/core/openapi/components.js';

const handler = (_req, res) => res.json({ data: null });
const registry = {
  modules: [
    { name: 'system', label: 'System' },
    { name: 'leads', label: 'Leads' },
    { name: 'unused', label: 'Unused' },
  ],
};

const Lead = z.object({ id: z.uuid(), name: z.string(), createdAt: z.iso.datetime() }).meta({ id: 'SpecLead' });

/** A small fake installation: a leads module and a system module, registered out of order. */
function fixture() {
  const collector = createRouteCollector();
  const leads = collector.wrap(express.Router(), 'leads');
  leads.get(
    '/leads',
    describe({ summary: 'List leads', permission: 'leads.view', list: true, responses: { 200: Lead } }),
    validate({ query: z.object({ unitId: z.uuid(), cursor: z.string().optional(), limit: z.coerce.number().default(50) }) }),
    handler,
  );
  leads.get('/leads/:id', describe({ summary: 'Get a lead', responses: { 200: Lead } }), validate({ params: z.object({ id: z.uuid() }) }), handler);
  leads.post(
    '/leads',
    describe({ summary: 'Create a lead', status: 201, errors: [409], responses: { 201: Lead } }),
    validate({ body: z.object({ name: z.string(), phone: z.string().optional() }) }),
    handler,
  );
  leads.patch('/leads/:id', validate({ params: z.object({ id: z.uuid() }), body: z.object({ name: z.string().optional() }) }), handler);
  leads.delete('/leads/:id', describe({ summary: 'Delete a lead', status: 204 }), handler);
  leads.get('/leads/internal', describe({ hidden: true }), handler);
  leads.all('/leads/any', handler);
  const system = collector.wrap(express.Router(), 'system');
  system.post('/auth/login', describe({ summary: 'Sign in', auth: 'public', rateLimited: true }), handler);
  system.post('/auth/logout', describe({ summary: 'Sign out', auth: 'optional', status: 204 }), handler);
  return collector.routes;
}

const build = (options = {}) => {
  const warnings = [];
  const doc = buildSpec(registry, fixture(), { onWarning: (m) => warnings.push(m), ...options });
  return { doc, warnings };
};

test('the document has the required OpenAPI 3.1 fields and is plain JSON', () => {
  const { doc } = build();
  assert.equal(doc.openapi, OPENAPI_VERSION);
  assert.match(doc.openapi, /^3\.1\.\d+$/);
  assert.equal(doc.info.title, 'Phoenix Platform API');
  assert.equal(doc.info.version, '0.1.0');
  assert.match(doc.info.description, /\{ "data": \.\.\. \}/);
  assert.deepEqual(doc.servers, [{ url: '/api/v1', description: 'This API, version 1' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
  assert.deepEqual(lintSpec(doc), []);
});

test('options set the title, version, server and cookie name', () => {
  const { doc } = build({ title: 'X', version: '2.0.0', description: 'D', serverUrl: '/v2', sessionCookieName: 'sid' });
  assert.deepEqual(doc.info, { title: 'X', version: '2.0.0', description: 'D' });
  assert.equal(doc.servers[0].url, '/v2');
  assert.equal(doc.components.securitySchemes.session.name, 'sid');
});

test('every documented route appears, with Express params mapped to {params}', () => {
  const { doc } = build();
  assert.deepEqual(Object.keys(doc.paths), ['/auth/login', '/auth/logout', '/leads', '/leads/{id}']);
  assert.deepEqual(Object.keys(doc.paths['/leads']), ['get', 'post']);
  assert.deepEqual(Object.keys(doc.paths['/leads/{id}']), ['get', 'patch', 'delete']);
});

test('hidden routes and router.all routes are left out', () => {
  const { doc } = build();
  assert.equal(doc.paths['/leads/internal'], undefined);
  assert.equal(doc.paths['/leads/any'], undefined);
});

test('tags: one per module that has routes, in registry order, with the label', () => {
  const { doc } = build();
  assert.deepEqual(doc.tags, [
    { name: 'system', description: 'System', 'x-displayName': 'System' },
    { name: 'leads', description: 'Leads', 'x-displayName': 'Leads' },
  ]);
  assert.deepEqual(doc.paths['/leads'].get.tags, ['leads']);
  assert.equal(doc.paths['/leads'].get['x-module'], 'leads');
});

test('custom tags are declared after module tags', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'leads').get('/x', describe({ summary: 'X', tags: ['reports', 'leads'] }), handler);
  const doc = buildSpec(registry, collector.routes);
  assert.deepEqual(
    doc.tags.map((t) => t.name),
    ['leads', 'reports'],
  );
  assert.deepEqual(lintSpec(doc), []);
});

test('path parameters come from the params schema; query parameters from the query schema', () => {
  const { doc } = build();
  const get = doc.paths['/leads/{id}'].get;
  assert.equal(get.parameters.length, 1);
  assert.equal(get.parameters[0].name, 'id');
  assert.equal(get.parameters[0].in, 'path');
  assert.equal(get.parameters[0].required, true);
  assert.equal(get.parameters[0].schema.format, 'uuid');

  const list = doc.paths['/leads'].get.parameters;
  assert.deepEqual(
    list.map((p) => [p.name, p.in, p.required]),
    [
      ['unitId', 'query', true],
      ['cursor', 'query', false],
      ['limit', 'query', false],
    ],
  );
});

test('path parameters without a params schema are documented as strings', () => {
  const { doc } = build();
  assert.deepEqual(doc.paths['/leads/{id}'].delete.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
});

test('splat parameters are documented as path segments', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'leads').get('/files/*rest', describe({ summary: 'File' }), handler);
  const doc = buildSpec(registry, collector.routes);
  assert.equal(doc.paths['/files/{rest}'].get.parameters[0].schema.description, 'One or more path segments');
});

test('optional groups document each variant with its own operationId', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'leads').get('/reports{/:year}', describe({ summary: 'Report' }), handler);
  const doc = buildSpec(registry, collector.routes);
  assert.deepEqual(Object.keys(doc.paths), ['/reports', '/reports/{year}']);
  assert.notEqual(doc.paths['/reports'].get.operationId, doc.paths['/reports/{year}'].get.operationId);
  assert.deepEqual(lintSpec(doc), []);
});

test('request bodies use the input shape; required only when the body has required fields', () => {
  const { doc } = build();
  const post = doc.paths['/leads'].post.requestBody;
  assert.equal(post.required, true);
  assert.deepEqual(post.content['application/json'].schema.required, ['name']);
  assert.equal(doc.paths['/leads/{id}'].patch.requestBody.required, false);
});

test('success responses use the { data } envelope, lists { data, nextCursor }', () => {
  const { doc } = build();
  const one = doc.paths['/leads/{id}'].get.responses['200'].content['application/json'].schema;
  assert.deepEqual(one, { type: 'object', properties: { data: { $ref: '#/components/schemas/SpecLead' } }, required: ['data'] });

  const list = doc.paths['/leads'].get.responses['200'];
  assert.equal(list.description, 'A page of results.');
  assert.deepEqual(list.content['application/json'].schema, {
    type: 'object',
    properties: {
      data: { type: 'array', items: { $ref: '#/components/schemas/SpecLead' } },
      nextCursor: { $ref: '#/components/schemas/Cursor' },
    },
    required: ['data', 'nextCursor'],
  });
  // Response schemas are converted as output: closed objects.
  assert.equal(doc.components.schemas.SpecLead.additionalProperties, false);
});

test('routes without a response schema still document the envelope', () => {
  const { doc } = build();
  const patch = doc.paths['/leads/{id}'].patch.responses['200'];
  assert.equal(patch.description, 'OK.');
  assert.deepEqual(patch.content['application/json'].schema, { type: 'object', properties: { data: {} }, required: ['data'] });
});

test('status: 201 and 204', () => {
  const { doc } = build();
  const created = doc.paths['/leads'].post.responses;
  assert.equal(created['200'], undefined);
  assert.equal(created['201'].description, 'Created.');
  const deleted = doc.paths['/leads/{id}'].delete.responses;
  assert.deepEqual(deleted['204'], { description: 'Done. No content.' });
  assert.equal(deleted['200'], undefined);
});

test('raw responses skip the envelope', () => {
  const collector = createRouteCollector();
  collector
    .wrap(express.Router(), 'system')
    .get('/health', describe({ summary: 'Health', responses: { 200: { raw: true, schema: z.object({ status: z.string() }) } } }), handler);
  const doc = buildSpec(registry, collector.routes);
  assert.deepEqual(doc.paths['/health'].get.responses['200'].content['application/json'].schema.properties, { status: { type: 'string' } });
});

test('error responses: inferred from auth, validation and path params, plus declared ones', () => {
  const { doc } = build();
  const codes = (op) => Object.keys(op.responses).filter((s) => s !== '200' && s !== '201' && s !== '204');
  assert.deepEqual(codes(doc.paths['/leads'].get), ['401', '403', '422', 'default']);
  assert.deepEqual(codes(doc.paths['/leads/{id}'].get), ['401', '403', '404', '422', 'default']);
  assert.deepEqual(codes(doc.paths['/leads'].post), ['400', '401', '403', '409', '422', 'default']);
  assert.deepEqual(codes(doc.paths['/auth/login'].post), ['403', '429', 'default']);
  assert.deepEqual(doc.paths['/leads'].get.responses['422'], { $ref: '#/components/responses/ValidationFailed' });
  assert.deepEqual(doc.paths['/leads'].get.responses.default, { $ref: '#/components/responses/InternalError' });
});

test('declared error responses can carry a description or a schema; unknown statuses use the error shape', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'leads').get(
    '/x',
    describe({
      summary: 'X',
      errors: [418],
      responses: {
        404: { description: 'No such pipeline' },
        409: { schema: z.object({ error: z.object({ code: z.literal('duplicate'), existingId: z.uuid() }) }) },
      },
    }),
    handler,
  );
  const r = buildSpec(registry, collector.routes).paths['/x'].get.responses;
  assert.equal(r['404'].description, 'No such pipeline');
  assert.deepEqual(r['404'].content['application/json'].schema, { $ref: '#/components/schemas/Error' });
  assert.equal(r['409'].content['application/json'].schema.properties.error.properties.code.const, 'duplicate');
  assert.equal(r['418'].description, 'Error.');
});

test('the standard error format and envelopes are components', () => {
  const { doc } = build();
  const { schemas, responses } = doc.components;
  assert.deepEqual(schemas.Error.required, ['error']);
  assert.deepEqual(schemas.Error.properties.error.required, ['code', 'message']);
  assert.deepEqual(Object.keys(schemas.Error.properties.error.properties), ['code', 'message', 'details', 'requestId']);
  assert.equal(schemas.ValidationError.properties.error.properties.details.items.$ref, '#/components/schemas/FieldError');
  assert.deepEqual(schemas.Cursor.type, ['string', 'null']);
  for (const name of ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'Conflict', 'ValidationFailed', 'RateLimited', 'InternalError']) {
    assert.ok(responses[name]?.description, name);
  }
  assert.match(responses.Forbidden.description, /mfa_required/);
});

test('security: session for reads, session + X-Phoenix-Client for writes, public and optional routes', () => {
  const { doc } = build();
  assert.deepEqual(doc.paths['/leads'].get.security, [{ session: [] }]);
  assert.deepEqual(doc.paths['/leads'].post.security, [{ session: [], phoenixClient: [] }]);
  assert.deepEqual(doc.paths['/auth/login'].post.security, [{ phoenixClient: [] }]);
  assert.deepEqual(doc.paths['/auth/logout'].post.security, [{ session: [], phoenixClient: [] }, { phoenixClient: [] }]);
  assert.deepEqual(Object.keys(doc.components.securitySchemes), ['session', 'phoenixClient']);
  assert.equal(doc.components.securitySchemes.session.in, 'cookie');
  assert.equal(doc.components.securitySchemes.phoenixClient.name, 'X-Phoenix-Client');
  assert.equal(doc.paths['/auth/login'].post['x-auth'], 'public');
});

test('security: Bearer API keys appear as an alternative once enabled', () => {
  const { doc } = build({ apiKeys: true });
  assert.deepEqual(doc.components.securitySchemes.apiKey, {
    type: 'http',
    scheme: 'bearer',
    description: doc.components.securitySchemes.apiKey.description,
  });
  assert.deepEqual(doc.paths['/leads'].post.security, [{ session: [], phoenixClient: [] }, { apiKey: [] }]);
  assert.deepEqual(doc.paths['/auth/login'].post.security, [{ phoenixClient: [] }]);
  assert.deepEqual(lintSpec(doc), []);
});

test('securityFor covers every mode and method', () => {
  assert.deepEqual(securityFor('public', 'get', false), [{}]);
  assert.deepEqual(securityFor('optional', 'get', true), [{ session: [] }, { apiKey: [] }, {}]);
  assert.deepEqual(securityFor('session', 'delete', false), [{ session: [], phoenixClient: [] }]);
  assert.deepEqual(securityFor('session', 'head', false), [{ session: [] }]);
});

test('permissions are listed in x-permissions and in the description', () => {
  const { doc } = build();
  const get = doc.paths['/leads'].get;
  assert.deepEqual(get['x-permissions'], ['leads.view']);
  assert.match(get.description, /\*\*Permission:\*\* `leads\.view`/);
  assert.equal(doc.paths['/leads/{id}'].get['x-permissions'], undefined);
  assert.match(doc.paths['/auth/login'].post.description, /No sign-in needed/);
  assert.match(doc.paths['/auth/logout'].post.description, /signed in or out/);
});

test('summaries: from describe(), else a placeholder and a warning', () => {
  const { doc, warnings } = build();
  assert.equal(doc.paths['/leads'].get.summary, 'List leads');
  assert.equal(doc.paths['/leads/{id}'].patch.summary, 'PATCH /leads/{id}');
  assert.ok(warnings.some((w) => /PATCH \/leads\/\{id\} has no summary/.test(w)));
});

test('external descriptions fill in, and a route’s own describe() wins', () => {
  const { doc, warnings } = build({
    descriptions: {
      'PATCH /leads/:id': { summary: 'Update a lead', permission: 'leads.manage', errors: [409] },
      'GET /leads': { summary: 'Overridden', description: 'From the catalogue' },
      'GET /nothing': { summary: 'Stale' },
    },
  });
  const patch = doc.paths['/leads/{id}'].patch;
  assert.equal(patch.summary, 'Update a lead');
  assert.deepEqual(patch['x-permissions'], ['leads.manage']);
  assert.ok(patch.responses['409']);
  assert.equal(doc.paths['/leads'].get.summary, 'List leads');
  assert.match(doc.paths['/leads'].get.description, /From the catalogue/);
  assert.ok(warnings.some((w) => w === 'Description "GET /nothing" matches no registered route'));
});

test('operationIds are generated, unique, and can be set', () => {
  assert.equal(operationIdFor('get', '/org/units/{id}'), 'getOrgUnitsById');
  assert.equal(operationIdFor('post', '/auth/mfa/recovery-codes'), 'postAuthMfaRecoveryCodes');
  assert.equal(operationIdFor('delete', '/users/{id}/assignments/{assignmentId}'), 'deleteUsersByIdAssignmentsByAssignmentId');
  assert.equal(operationIdFor('get', '/openapi.json'), 'getOpenapiJson');
  assert.equal(operationIdFor('get', '/'), 'get');

  const collector = createRouteCollector();
  const r = collector.wrap(express.Router(), 'leads');
  r.get('/a-b', describe({ summary: 'One' }), handler);
  r.get('/a/b', describe({ summary: 'Two' }), handler);
  r.get('/c', describe({ summary: 'Three', operationId: 'getAB' }), handler);
  const warnings = [];
  const doc = buildSpec(registry, collector.routes, { onWarning: (m) => warnings.push(m) });
  const ids = Object.values(doc.paths).map((item) => item.get.operationId);
  assert.deepEqual(ids, ['getAB', 'getAB2', 'getAB3']);
  assert.ok(warnings.some((w) => /operationId "getAB" is used twice/.test(w)));
});

test('a route registered twice is documented once, with a warning', () => {
  const collector = createRouteCollector();
  const r = collector.wrap(express.Router(), 'leads');
  r.get('/dup', describe({ summary: 'First' }), handler);
  r.get('/dup', describe({ summary: 'Second' }), handler);
  const warnings = [];
  const doc = buildSpec(registry, collector.routes, { onWarning: (m) => warnings.push(m) });
  assert.equal(doc.paths['/dup'].get.summary, 'First');
  assert.ok(warnings.some((w) => /registered twice/.test(w)));
});

test('bad paths and mismatched params warn instead of breaking the document', () => {
  const collector = createRouteCollector();
  const r = collector.wrap(express.Router(), 'leads');
  // Express refuses a malformed path itself, so inject one the way a hand-built route list could.
  collector.record('get', '/bad/:', [describe({ summary: 'Bad' }), handler], 'leads');
  r.get('/x/:id', describe({ summary: 'X' }), validate({ params: z.object({ id: z.uuid(), other: z.string() }) }), handler);
  r.get('/body', describe({ summary: 'Body on GET' }), validate({ body: z.object({ a: z.string() }) }), handler);
  const warnings = [];
  const doc = buildSpec(registry, collector.routes, { onWarning: (m) => warnings.push(m) });
  assert.equal(doc.paths['/bad/{}'], undefined);
  assert.ok(warnings.some((w) => /GET \/bad\/:.*Missing parameter name/.test(w)));
  assert.ok(warnings.some((w) => /params schema has "other"/.test(w)));
  assert.ok(warnings.some((w) => /a body schema on a GET route/.test(w)));
  assert.deepEqual(lintSpec(doc), []);
});

test('routes are ordered by module (registry order), then registration order; unknown modules last', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'stranger').get('/z', describe({ summary: 'Z' }), handler);
  collector.wrap(express.Router(), 'leads').get('/b', describe({ summary: 'B' }), handler);
  collector.wrap(express.Router(), 'leads').get('/a', describe({ summary: 'A' }), handler);
  collector.wrap(express.Router(), 'system').get('/s', describe({ summary: 'S' }), handler);
  const doc = buildSpec(registry, collector.routes);
  assert.deepEqual(Object.keys(doc.paths), ['/s', '/b', '/a', '/z']);
  assert.deepEqual(
    doc.tags.map((t) => t.name),
    ['system', 'leads', 'stranger'],
  );
  assert.equal(doc.tags[2].description, 'stranger');
});

test('deprecated routes are flagged', () => {
  const collector = createRouteCollector();
  collector.wrap(express.Router(), 'leads').get('/old', describe({ summary: 'Old', deprecated: true }), handler);
  assert.equal(buildSpec(registry, collector.routes).paths['/old'].get.deprecated, true);
});

test('the same input always builds the same document', () => {
  const routes = fixture();
  assert.equal(JSON.stringify(buildSpec(registry, routes)), JSON.stringify(buildSpec(registry, routes)));
});

test('routeKey is "METHOD /express/path"', () => {
  assert.equal(routeKey('get', '/users/:id'), 'GET /users/:id');
});
