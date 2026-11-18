import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  DESCRIBE,
  describe,
  describeOf,
  isZodSchema,
  mergeDescriptions,
  parseDescription,
} from '../../src/core/openapi/describe.js';

test('describe() returns a pass-through middleware carrying its metadata', () => {
  const mw = describe({ summary: 'Get a lead', permission: 'leads.view' });
  let called = 0;
  mw({}, {}, () => (called += 1));
  assert.equal(called, 1);
  assert.deepEqual(describeOf(mw), { summary: 'Get a lead', permission: 'leads.view' });
  assert.equal(mw[DESCRIBE], describeOf(mw));
  assert.ok(Object.isFrozen(describeOf(mw)));
});

test('describeOf is undefined for ordinary functions and non-functions', () => {
  assert.equal(describeOf(() => {}), undefined);
  assert.equal(describeOf(null), undefined);
  assert.equal(describeOf({ [DESCRIBE]: { summary: 'x' } }), undefined);
});

test('every documented field is accepted', () => {
  const lead = z.object({ id: z.uuid() });
  const meta = parseDescription({
    summary: 'List leads',
    description: 'Newest first.',
    tags: ['leads'],
    permission: ['leads.view', 'leads.view:own'],
    auth: 'session',
    status: 200,
    list: true,
    responses: { 200: lead, 404: { description: 'No such pipeline' }, 201: { schema: lead, list: false, raw: false } },
    errors: [409],
    rateLimited: true,
    operationId: 'listLeads',
    deprecated: false,
    hidden: false,
  });
  assert.equal(meta.responses['200'], lead);
  assert.deepEqual(meta.permission, ['leads.view', 'leads.view:own']);
});

test('summaries are trimmed', () => {
  assert.equal(parseDescription({ summary: '  Get a lead  ' }).summary, 'Get a lead');
});

test('mistakes throw at definition time with the field named', () => {
  assert.throws(() => describe({ sumary: 'typo' }), /Invalid route description.*sumary|Unrecognized/);
  assert.throws(() => describe({ auth: 'anyone' }), /auth/);
  assert.throws(() => describe({ permission: 'Leads View' }), /permission/);
  assert.throws(() => describe({ status: 99 }), /status/);
  assert.throws(() => describe({ errors: [200] }), /errors/);
  assert.throws(() => describe({ responses: { ok: z.string() } }), /responses/);
  assert.throws(() => describe({ responses: { 200: { schema: 'not zod' } } }), /responses/);
  assert.throws(() => describe({ operationId: '1bad' }), /operationId/);
  assert.throws(() => describe({ summary: '' }), /summary/);
  assert.throws(() => parseDescription({ tags: [] }, 'GET /x'), /GET \/x/);
});

test('permission keys follow the registry format, wildcards included', () => {
  for (const permission of ['users.view', 'users.*', '*', 'leads.view:own']) {
    assert.doesNotThrow(() => parseDescription({ permission }), permission);
  }
  for (const permission of ['users', 'users.view:all', 'Users.view', 'users.view.extra']) {
    assert.throws(() => parseDescription({ permission }), undefined, permission);
  }
});

test('isZodSchema recognises zod schemas only', () => {
  assert.ok(isZodSchema(z.string()));
  assert.ok(isZodSchema(z.object({}).optional()));
  assert.ok(!isZodSchema({ type: 'string' }));
  assert.ok(!isZodSchema(null));
  assert.ok(!isZodSchema('z.string()'));
});

test('mergeDescriptions: later wins per field, responses merge by status, undefined is skipped', () => {
  const a = z.string();
  const b = z.number();
  const merged = mergeDescriptions(
    { summary: 'Old', permission: 'users.view', responses: { 200: a, 404: { description: 'x' } } },
    undefined,
    { summary: 'New', description: undefined, responses: { 200: b } },
  );
  assert.equal(merged.summary, 'New');
  assert.equal(merged.permission, 'users.view');
  assert.equal(merged.responses['200'], b);
  assert.deepEqual(merged.responses['404'], { description: 'x' });
  assert.ok(!('description' in merged));
  assert.deepEqual(mergeDescriptions(), {});
});
