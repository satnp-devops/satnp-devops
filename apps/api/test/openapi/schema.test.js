import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  addComponent,
  componentName,
  createSchemaStore,
  hasRequiredFields,
  resolveRef,
  rewriteRefs,
  stableStringify,
  toJsonSchema,
  toParameters,
} from '../../src/core/openapi/schema.js';
import { codeSchema, emailSchema, idParams, nameSchema, timeZoneSchema, webUrlSchema } from '../../src/lib/schemas.js';

const withWarnings = () => {
  const warnings = [];
  return { store: createSchemaStore((m) => warnings.push(m)), warnings };
};

test('plain shapes convert to JSON Schema 2020-12 without the $schema marker', () => {
  const out = toJsonSchema(z.object({ name: z.string().min(1).max(120), age: z.number().int().optional() }));
  assert.equal(out.$schema, undefined);
  assert.equal(out.type, 'object');
  assert.deepEqual(out.properties.name, { type: 'string', minLength: 1, maxLength: 120 });
  assert.equal(out.properties.age.type, 'integer');
  assert.deepEqual(out.required, ['name']);
});

test('the shared phase 1 schemas all convert', () => {
  const { store, warnings } = withWarnings();
  for (const schema of [emailSchema, nameSchema, codeSchema, webUrlSchema, idParams, timeZoneSchema]) {
    for (const io of ['input', 'output']) assert.doesNotThrow(() => toJsonSchema(schema, { io, store }));
  }
  assert.deepEqual(warnings, []);
  const email = toJsonSchema(emailSchema, { store });
  assert.equal(email.format, 'email');
  assert.equal(email.maxLength, 254);
  assert.equal(toJsonSchema(idParams, { store }).properties.id.format, 'uuid');
});

test('input vs output: coercion keeps its target type, defaults are optional on input and required on output', () => {
  const schema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
  const input = toJsonSchema(schema, { io: 'input' });
  const output = toJsonSchema(schema, { io: 'output' });
  assert.equal(input.properties.limit.type, 'integer');
  assert.equal(input.properties.limit.default, 50);
  assert.equal(input.required, undefined);
  assert.deepEqual(output.required, ['limit']);
});

test('input vs output: plain objects are open on input and closed on output', () => {
  const schema = z.object({ a: z.string() });
  assert.equal(toJsonSchema(schema, { io: 'input' }).additionalProperties, undefined);
  assert.equal(toJsonSchema(schema, { io: 'output' }).additionalProperties, false);
  assert.equal(toJsonSchema(z.strictObject({ a: z.string() }), { io: 'input' }).additionalProperties, false);
});

test('transforms: input documents what a client sends; output of a bare transform is unrepresentable', () => {
  const { store, warnings } = withWarnings();
  const schema = z.object({ n: z.string().transform(Number) });
  assert.deepEqual(toJsonSchema(schema, { io: 'input', store }).properties.n, { type: 'string' });
  assert.deepEqual(warnings, []);
  const output = toJsonSchema(schema, { io: 'output', store, where: 'GET /x response 200' });
  assert.deepEqual(output.properties.n, { 'x-unrepresentable': 'transform' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GET \/x response 200 at properties\.n: Transforms cannot be represented/);
});

test('preprocess documents the schema after the preprocessing step', () => {
  const out = toJsonSchema(z.object({ email: emailSchema }), { io: 'input' });
  assert.equal(out.properties.email.type, 'string');
  assert.equal(out.properties.email.format, 'email');
  assert.deepEqual(out.required, ['email']);
});

test('refinements are kept as the base type (the rule itself is not representable but not lost silently)', () => {
  const { store, warnings } = withWarnings();
  assert.deepEqual(toJsonSchema(timeZoneSchema, { store }), { type: 'string' });
  assert.deepEqual(warnings, []);
});

test('dates become ISO date-time strings without a warning', () => {
  const { store, warnings } = withWarnings();
  const out = toJsonSchema(z.object({ at: z.date() }), { io: 'output', store });
  assert.deepEqual(out.properties.at, { type: 'string', format: 'date-time' });
  assert.deepEqual(warnings, []);
});

test('other unrepresentable types become any-value with a note and a warning, never a throw', () => {
  const { store, warnings } = withWarnings();
  const schema = z.object({
    big: z.bigint(),
    map: z.map(z.string(), z.number()),
    set: z.set(z.string()),
    custom: z.custom((v) => typeof v === 'string'),
  });
  const out = toJsonSchema(schema, { io: 'output', store, where: 'POST /x body' });
  assert.deepEqual(out.properties.big, { 'x-unrepresentable': 'bigint' });
  assert.deepEqual(out.properties.map, { 'x-unrepresentable': 'map' });
  assert.deepEqual(out.properties.set, { 'x-unrepresentable': 'set' });
  assert.equal(warnings.length, 4);
  for (const w of warnings) assert.match(w, /^POST \/x body at properties\.\w+: .*documented as any value$/);
});

test('metadata from .meta() and .describe() is kept', () => {
  const out = toJsonSchema(
    z.object({
      phone: z.string().describe('Mobile number with country code').meta({ examples: ['+91 98765 43210'] }),
      old: z.string().optional().meta({ deprecated: true }),
    }),
  );
  assert.equal(out.properties.phone.description, 'Mobile number with country code');
  assert.deepEqual(out.properties.phone.examples, ['+91 98765 43210']);
  assert.equal(out.properties.old.deprecated, true);
});

test('a schema with .meta({ id }) becomes a shared component and is referenced', () => {
  const store = createSchemaStore();
  const Unit = z.object({ id: z.uuid(), name: z.string() }).meta({ id: 'TestUnit', description: 'A unit' });
  const out = toJsonSchema(z.object({ unit: Unit, units: z.array(Unit) }), { io: 'output', store });
  assert.deepEqual(out.properties.unit, { $ref: '#/components/schemas/TestUnit' });
  assert.deepEqual(out.properties.units.items, { $ref: '#/components/schemas/TestUnit' });
  assert.equal(store.schemas.TestUnit.description, 'A unit');
  assert.equal(store.schemas.TestUnit.id, undefined);
  // A root with an id is a ref too.
  assert.deepEqual(toJsonSchema(Unit, { io: 'output', store }), { $ref: '#/components/schemas/TestUnit' });
  assert.deepEqual(Object.keys(store.schemas), ['TestUnit']);
});

test('the same id with different input and output shapes gets a suffix for the second', () => {
  const store = createSchemaStore();
  const Lead = z.object({ id: z.uuid() }).meta({ id: 'TestLead' });
  assert.deepEqual(toJsonSchema(Lead, { io: 'input', store }), { $ref: '#/components/schemas/TestLead' });
  assert.deepEqual(toJsonSchema(Lead, { io: 'output', store }), { $ref: '#/components/schemas/TestLeadOutput' });
  assert.deepEqual(toJsonSchema(Lead, { io: 'output', store }), { $ref: '#/components/schemas/TestLeadOutput' });
});

test('recursive schemas become self-referencing components', () => {
  const store = createSchemaStore();
  const Node = z.object({
    name: z.string(),
    get children() {
      return z.array(Node);
    },
  });
  const out = toJsonSchema(Node, { store, name: 'TreeBody' });
  assert.deepEqual(out, { $ref: '#/components/schemas/TreeBody' });
  assert.deepEqual(store.schemas.TreeBody.properties.children.items, { $ref: '#/components/schemas/TreeBody' });

  const Category = z
    .object({
      name: z.string(),
      get parent() {
        return Category.optional();
      },
    })
    .meta({ id: 'TestCategory' });
  const wrapped = toJsonSchema(z.object({ category: Category }), { store, name: 'X' });
  assert.deepEqual(wrapped.properties.category, { $ref: '#/components/schemas/TestCategory' });
  assert.deepEqual(store.schemas.TestCategory.properties.parent, { $ref: '#/components/schemas/TestCategory' });
});

test('the result is plain JSON (no functions, symbols or zod internals)', () => {
  const out = toJsonSchema(z.object({ a: z.string().default('x'), b: z.enum(['p', 'q']) }));
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  assert.equal(Object.getOwnPropertySymbols(out).length, 0);
  assert.equal(out['~standard'], undefined);
});

test('toParameters: query objects split into named parameters with required flags', () => {
  const store = createSchemaStore();
  const schema = toJsonSchema(
    z.object({
      unitId: z.uuid().describe('The unit to look in'),
      q: z.string().max(100).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.coerce.number().int().default(50).meta({ examples: [20] }),
      legacy: z.string().optional().meta({ deprecated: true }),
    }),
    { store },
  );
  const params = toParameters(schema, 'query', store, 'GET /x');
  assert.deepEqual(
    params.map((p) => [p.name, p.in, p.required]),
    [
      ['unitId', 'query', true],
      ['q', 'query', false],
      ['tags', 'query', false],
      ['limit', 'query', false],
      ['legacy', 'query', false],
    ],
  );
  assert.equal(params[0].description, 'The unit to look in');
  assert.equal(params[0].schema.description, undefined);
  assert.equal(params[2].style, 'form');
  assert.equal(params[2].explode, true);
  assert.equal(params[3].example, 20);
  assert.equal(params[3].schema.examples, undefined);
  assert.equal(params[4].deprecated, true);
});

test('toParameters: path parameters are always required', () => {
  const store = createSchemaStore();
  const schema = toJsonSchema(z.object({ key: z.string().max(100).optional() }), { store });
  assert.deepEqual(toParameters(schema, 'path', store, 'x')[0].required, true);
});

test('toParameters: an id-referenced object schema is resolved', () => {
  const store = createSchemaStore();
  const schema = toJsonSchema(z.object({ id: z.uuid() }).meta({ id: 'TestIdParams' }), { store });
  assert.deepEqual(schema, { $ref: '#/components/schemas/TestIdParams' });
  assert.deepEqual(toParameters(schema, 'path', store, 'x').map((p) => p.name), ['id']);
});

test('toParameters: a non-object schema falls back to one exploded parameter with a warning', () => {
  const { store, warnings } = withWarnings();
  const schema = toJsonSchema(z.record(z.string(), z.string()), { store });
  const params = toParameters(schema, 'query', store, 'GET /x');
  assert.equal(params.length, 1);
  assert.equal(params[0].style, 'form');
  assert.match(warnings[0], /not a plain object/);
});

test('hasRequiredFields decides whether a request body is required', () => {
  const store = createSchemaStore();
  assert.equal(hasRequiredFields(toJsonSchema(z.object({ a: z.string() }), { store }), store), true);
  assert.equal(hasRequiredFields(toJsonSchema(z.object({ a: z.string().optional() }), { store }), store), false);
  assert.equal(hasRequiredFields(toJsonSchema(z.array(z.string()), { store }), store), true);
  assert.equal(hasRequiredFields(toJsonSchema(z.unknown(), { store }), store), false);
});

test('addComponent reuses identical schemas and suffixes different ones', () => {
  const warnings = [];
  const store = createSchemaStore((m) => warnings.push(m));
  assert.equal(addComponent(store, 'A', { type: 'string' }, 'output'), 'A');
  assert.equal(addComponent(store, 'A', { type: 'string' }, 'input'), 'A');
  assert.equal(addComponent(store, 'A', { type: 'number' }, 'input'), 'AInput');
  assert.equal(addComponent(store, 'A', { type: 'number' }, 'input'), 'AInput');
  assert.equal(addComponent(store, 'A', { type: 'boolean' }, 'input'), 'A_2');
  assert.equal(addComponent(store, 'A', { type: 'boolean' }, 'output'), 'A_2');
  assert.equal(warnings.length, 1);
});

test('componentName keeps only characters OpenAPI allows', () => {
  assert.equal(componentName('Lead'), 'Lead');
  assert.equal(componentName('crm/lead v2'), 'crm_lead_v2');
  assert.equal(componentName('!!!'), 'Schema');
});

test('stableStringify ignores key order and undefined values', () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), stableStringify({ b: 1 }));
  assert.equal(stableStringify(undefined), 'null');
});

test('rewriteRefs and resolveRef', () => {
  const tree = { a: { $ref: '#/$defs/X' }, list: [{ $ref: '#/$defs/Y' }], $refx: 'kept' };
  const out = rewriteRefs(tree, (ref) => ref.replace('#/$defs/', '#/components/schemas/'));
  assert.deepEqual(out, { a: { $ref: '#/components/schemas/X' }, list: [{ $ref: '#/components/schemas/Y' }], $refx: 'kept' });
  const store = createSchemaStore();
  store.schemas.X = { $ref: '#/components/schemas/Y' };
  store.schemas.Y = { type: 'string' };
  assert.deepEqual(resolveRef({ $ref: '#/components/schemas/X' }, store), { type: 'string' });
  assert.deepEqual(resolveRef({ $ref: '#/components/schemas/Missing' }, store), { $ref: '#/components/schemas/Missing' });
  assert.deepEqual(resolveRef({ type: 'number' }, store), { type: 'number' });
});
