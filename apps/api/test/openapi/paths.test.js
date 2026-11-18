import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPaths, templateParams, toOpenApiPaths, tokenize } from '../../src/core/openapi/paths.js';

const only = (expressPath) => {
  const out = toOpenApiPaths(expressPath);
  assert.equal(out.length, 1, `expected one variant for ${expressPath}`);
  return out[0];
};

test('static paths pass through unchanged', () => {
  assert.deepEqual(only('/org/unit-types'), { path: '/org/unit-types', params: [] });
  assert.deepEqual(only('/'), { path: '/', params: [] });
  assert.deepEqual(only('/openapi.json'), { path: '/openapi.json', params: [] });
});

test(':params become {params}, in order', () => {
  assert.deepEqual(only('/users/:id'), { path: '/users/{id}', params: [{ name: 'id', splat: false }] });
  assert.deepEqual(only('/users/:id/assignments/:assignmentId'), {
    path: '/users/{id}/assignments/{assignmentId}',
    params: [
      { name: 'id', splat: false },
      { name: 'assignmentId', splat: false },
    ],
  });
});

test('a param ends at the first character that cannot be in a name', () => {
  assert.equal(only('/files/:name.json').path, '/files/{name}.json');
  assert.equal(only('/range/:from-:to').path, '/range/{from}-{to}');
  assert.equal(only('/u/:user_id$x').path, '/u/{user_id$x}');
});

test('quoted names allow any characters', () => {
  assert.deepEqual(only('/x/:"unit id"'), { path: '/x/{unit id}', params: [{ name: 'unit id', splat: false }] });
});

test('splats are documented as one parameter flagged as a splat', () => {
  assert.deepEqual(only('/files/*rest'), { path: '/files/{rest}', params: [{ name: 'rest', splat: true }] });
});

test('escaped characters are literal', () => {
  assert.deepEqual(only('/price\\:usd'), { path: '/price:usd', params: [] });
  assert.deepEqual(only('/a\\{b\\}'), { path: '/a{b}', params: [] });
});

test('optional groups expand into every variant', () => {
  assert.deepEqual(
    toOpenApiPaths('/reports{/:year}').map((v) => v.path),
    ['/reports', '/reports/{year}'],
  );
  assert.deepEqual(
    toOpenApiPaths('/r{/:year{/:month}}').map((v) => v.path),
    ['/r', '/r/{year}', '/r/{year}/{month}'],
  );
  assert.deepEqual(
    toOpenApiPaths('/a{/b}{/c}').map((v) => v.path),
    ['/a', '/a/c', '/a/b', '/a/b/c'],
  );
  const withParam = toOpenApiPaths('/users{/:id}');
  assert.deepEqual(withParam[0].params, []);
  assert.deepEqual(withParam[1].params, [{ name: 'id', splat: false }]);
});

test('variants that normalise to the same path appear once', () => {
  assert.deepEqual(
    toOpenApiPaths('/a{/}').map((v) => v.path),
    ['/a'],
  );
});

test('paths are normalised: leading slash, no doubled or trailing slashes', () => {
  assert.equal(only('users').path, '/users');
  assert.equal(only('/users/').path, '/users');
  assert.equal(only('//users//:id').path, '/users/{id}');
});

test('a repeated parameter is listed once', () => {
  assert.deepEqual(only('/a/:id/b/:id').params, [{ name: 'id', splat: false }]);
});

test('malformed paths throw a clear error', () => {
  assert.throws(() => toOpenApiPaths('/a/:'), /Missing parameter name/);
  assert.throws(() => toOpenApiPaths('/a/*'), /Missing parameter name/);
  assert.throws(() => toOpenApiPaths('/a{/b'), /Unclosed/);
  assert.throws(() => toOpenApiPaths('/a}'), /Unexpected "}"/);
  assert.throws(() => toOpenApiPaths('/:"open'), /Unterminated/);
  assert.throws(() => toOpenApiPaths(/regex/), /string paths/);
});

test('too many optional groups are refused rather than exploding', () => {
  const path = Array.from({ length: 8 }, (_, i) => `{/s${i}}`).join('');
  assert.throws(() => toOpenApiPaths(path), /Too many optional groups/);
});

test('tokenize exposes the structure', () => {
  assert.deepEqual(tokenize('/a/:id{/*rest}'), [
    { type: 'text', value: '/a/' },
    { type: 'param', name: 'id' },
    { type: 'group', tokens: [{ type: 'text', value: '/' }, { type: 'splat', name: 'rest' }] },
  ]);
});

test('joinPaths joins prefixes without doubling or losing slashes', () => {
  assert.equal(joinPaths('', '/users'), '/users');
  assert.equal(joinPaths('', ''), '/');
  assert.equal(joinPaths('/api/v1', '/users'), '/api/v1/users');
  assert.equal(joinPaths('/api/v1/', '/users'), '/api/v1/users');
  assert.equal(joinPaths('/api/v1', 'users'), '/api/v1/users');
  assert.equal(joinPaths('/reports', '{/:year}'), '/reports{/:year}');
});

test('templateParams reads names back from a template', () => {
  assert.deepEqual(templateParams('/users/{id}/assignments/{assignmentId}'), ['id', 'assignmentId']);
  assert.deepEqual(templateParams('/health'), []);
});
