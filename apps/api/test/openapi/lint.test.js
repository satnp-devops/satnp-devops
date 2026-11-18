import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRefs, lintSpec, resolvePointer } from '../../src/core/openapi/lint.js';

const valid = () => ({
  openapi: '3.1.1',
  info: { title: 'T', version: '1' },
  tags: [{ name: 'leads' }],
  paths: {
    '/leads/{id}': {
      get: {
        operationId: 'getLead',
        tags: ['leads'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, default: { $ref: '#/components/responses/Error' } },
        security: [{ session: [] }],
      },
    },
  },
  components: {
    responses: { Error: { description: 'Error' } },
    securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'sid' } },
  },
});

const problemsAfter = (mutate) => {
  const doc = valid();
  mutate(doc);
  return lintSpec(doc);
};
const op = (doc) => doc.paths['/leads/{id}'].get;

test('a valid document has no problems', () => {
  assert.deepEqual(lintSpec(valid()), []);
});

test('top-level required fields', () => {
  assert.deepEqual(lintSpec(null), ['The document is not an object']);
  assert.match(problemsAfter((d) => (d.openapi = '3.0.3')).join(), /openapi must be "3\.1\.x"/);
  assert.match(problemsAfter((d) => delete d.info.title).join(), /info\.title/);
  assert.match(problemsAfter((d) => delete d.info.version).join(), /info\.version/);
  assert.match(
    problemsAfter((d) => {
      delete d.paths;
      delete d.components;
    }).join(),
    /One of paths, components or webhooks/,
  );
});

test('values JSON cannot carry are reported', () => {
  assert.match(problemsAfter((d) => (d.info.big = 1n)).join(), /not serialisable as JSON/);
});

test('paths and path parameters', () => {
  assert.match(
    problemsAfter((d) => {
      d.paths['leads'] = d.paths['/leads/{id}'];
      delete d.paths['/leads/{id}'];
    }).join(),
    /must start with "\/"/,
  );
  assert.match(problemsAfter((d) => (op(d).parameters = [])).join(), /\{id\} has no parameter/);
  assert.match(problemsAfter((d) => (op(d).parameters[0].required = false)).join(), /must be required/);
  assert.match(problemsAfter((d) => (op(d).parameters[0].name = 'other')).join(), /"other" is not in the path/);
  assert.match(problemsAfter((d) => op(d).parameters.push({ ...op(d).parameters[0] })).join(), /listed twice/);
  assert.match(problemsAfter((d) => delete op(d).parameters[0].schema).join(), /needs a schema/);
  assert.match(problemsAfter((d) => op(d).parameters.push({ in: 'query' })).join(), /needs name and in/);
  assert.match(
    problemsAfter((d) => {
      d.paths['/a/{x}/{x}'] = {};
    }).join(),
    /repeats a parameter/,
  );
});

test('operations: unique ids, responses, tags and security schemes', () => {
  assert.match(
    problemsAfter((d) => {
      d.paths['/other'] = { post: { ...op(d), parameters: [] } };
    }).join(),
    /operationId "getLead" is also used/,
  );
  assert.match(problemsAfter((d) => (op(d).responses = {})).join(), /no responses/);
  assert.match(problemsAfter((d) => (op(d).responses.ok = { description: 'x' })).join(), /"ok" is not a status/);
  assert.match(problemsAfter((d) => (op(d).responses['404'] = {})).join(), /404 needs a description/);
  assert.match(problemsAfter((d) => (op(d).tags = ['nope'])).join(), /tag "nope" is not declared/);
  assert.match(problemsAfter((d) => (op(d).security = [{ apiKey: [] }])).join(), /"apiKey" is not declared/);
  assert.deepEqual(problemsAfter((d) => (op(d).responses['4XX'] = { description: 'x' })), []);
  // Non-operation keys of a path item (summary, parameters) are not operations.
  assert.deepEqual(problemsAfter((d) => (d.paths['/leads/{id}'].summary = 'Leads')), []);
});

test('dangling refs are reported', () => {
  assert.match(
    problemsAfter((d) => (op(d).responses.default = { $ref: '#/components/responses/Missing' })).join(),
    /"#\/components\/responses\/Missing" points at nothing/,
  );
  // External refs are not followed.
  assert.deepEqual(problemsAfter((d) => (op(d).responses.default = { $ref: 'https://example.com/x.json' })), []);
});

test('resolvePointer follows RFC 6901 escapes', () => {
  const doc = { a: { 'b/c': { 'd~e': 1 } }, s: { 'x y': 2 } };
  assert.equal(resolvePointer(doc, '#/a/b~1c/d~0e'), 1);
  assert.equal(resolvePointer(doc, '#/s/x%20y'), 2);
  assert.equal(resolvePointer(doc, '#/a/missing'), undefined);
  assert.equal(resolvePointer({ a: null }, '#/a/b'), undefined);
});

test('collectRefs finds refs at any depth, in arrays too', () => {
  const refs = collectRefs({ a: { $ref: '#/x' }, b: [{ c: { $ref: '#/y' } }, { $ref: '#/x' }] });
  assert.deepEqual([...refs], ['#/x', '#/y']);
});
