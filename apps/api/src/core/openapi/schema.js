import { z } from 'zod';

/**
 * zod 4 -> JSON Schema 2020-12 (the dialect OpenAPI 3.1 uses), via zod's built-in z.toJSONSchema.
 *
 * Rules (zod docs, "JSON Schema": https://zod.dev/json-schema):
 *   - Requests are converted with io: 'input' (what a client may send: coerced fields keep their
 *     input type, fields with defaults are optional, preprocess documents the schema after it).
 *     Responses use io: 'output' (what the server sends).
 *   - Metadata from .meta() and .describe() (title, description, examples, deprecated) is kept.
 *     A schema with .meta({ id: 'Unit' }) becomes the shared component #/components/schemas/Unit.
 *   - Types JSON Schema can't express never throw: dates become ISO date-time strings (how
 *     JSON.stringify sends them), anything else (bigint, map, set, function, custom, a bare
 *     transform) becomes {} with an `x-unrepresentable` note and a warning.
 */

/** The OpenAPI 3.1 location of shared schemas. */
export const COMPONENTS_PREFIX = '#/components/schemas/';

/**
 * @typedef {Record<string, unknown>} JsonSchema
 * @typedef {'input' | 'output'} Io
 * @typedef {{
 *   schemas: Record<string, JsonSchema>,
 *   onWarning?: (message: string) => void,
 * }} SchemaStore  shared components, filled as routes are converted
 */

/**
 * Create the store that collects shared components while a document is built.
 * @param {(message: string) => void} [onWarning]
 * @returns {SchemaStore}
 */
export function createSchemaStore(onWarning) {
  return { schemas: {}, onWarning };
}

/** Stable JSON for comparing schemas regardless of key order. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Component names must match ^[a-zA-Z0-9._-]+$ (OpenAPI 3.1, "Components Object"). */
export function componentName(name) {
  const cleaned = String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'Schema';
}

/**
 * Add a component, reusing an identical one with the same name. A different schema under the
 * same name (usually the input and output shapes of one .meta({ id })) gets a suffix.
 * @param {SchemaStore} store
 * @param {string} name
 * @param {JsonSchema} schema
 * @param {Io} io
 * @returns {string} the name it was stored under
 */
export function addComponent(store, name, schema, io) {
  const base = componentName(name);
  const wanted = stableStringify(schema);
  // Reuse an identical schema already stored under this name or one of its variants.
  const variants = new RegExp(`^${base.replace(/[.]/g, '\\.')}(Input|Output|_\\d+)?$`);
  for (const [existingName, existing] of Object.entries(store.schemas)) {
    if (variants.test(existingName) && stableStringify(existing) === wanted) return existingName;
  }
  for (const candidate of [base, `${base}${io === 'input' ? 'Input' : 'Output'}`]) {
    if (!store.schemas[candidate]) {
      store.schemas[candidate] = schema;
      return candidate;
    }
  }
  let n = 2;
  while (store.schemas[`${base}_${n}`]) n += 1;
  const candidate = `${base}_${n}`;
  store.onWarning?.(`Two different schemas share the id "${base}"; one is documented as "${candidate}"`);
  store.schemas[candidate] = schema;
  return candidate;
}

/**
 * Replace $ref targets throughout a JSON Schema tree.
 * @param {unknown} node
 * @param {(ref: string) => string} mapRef
 */
export function rewriteRefs(node, mapRef) {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, mapRef));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === '$ref' && typeof value === 'string' ? mapRef(value) : rewriteRefs(value, mapRef);
  }
  return out;
}

/**
 * Convert a zod schema to a JSON Schema for embedding in an OpenAPI 3.1 document.
 * Named sub-schemas ($defs) move into store.schemas and refs point at #/components/schemas/.
 *
 * @param {import('zod').ZodType} schema
 * @param {{ io?: Io, store?: SchemaStore, name?: string, where?: string }} [options]
 *   name  used for anonymous shared parts (recursive schemas), e.g. "createUnitBody"
 *   where used in warnings, e.g. "POST /org/units body"
 * @returns {JsonSchema}
 */
export function toJsonSchema(schema, { io = 'input', store = createSchemaStore(), name = 'Schema', where = 'schema' } = {}) {
  /** @type {import('zod').core.UnrepresentableHandler} */
  const unrepresentable = ({ zodSchema, path, message }) => {
    const type = zodSchema._zod.def.type;
    if (type === 'date') return { type: 'string', format: 'date-time' };
    const at = path.length ? ` at ${path.join('.')}` : '';
    store.onWarning?.(`${where}${at}: ${message}; documented as any value`);
    return { 'x-unrepresentable': type };
  };

  const converted = /** @type {JsonSchema} */ (
    z.toJSONSchema(schema, { io, target: 'draft-2020-12', unrepresentable, cycles: 'ref', reused: 'inline' })
  );
  const { $schema: _dialect, $defs: defs = {}, ...root } = /** @type {JsonSchema & { $defs?: Record<string, JsonSchema> }} */ (
    JSON.parse(JSON.stringify(converted))
  );

  // Anonymous defs (zod names them __schema0, __schema1 ...) need names unique to this conversion.
  /** @type {Record<string, string>} */
  const renamed = {};
  let anonymous = 0;
  for (const key of Object.keys(defs)) {
    renamed[key] = key.startsWith('__schema') ? `${name}${anonymous++ === 0 ? '' : anonymous}Part` : key;
  }

  // A recursive root refers to itself as "#"; it has to become a component to be referable.
  const selfReferencing = stableStringify(root).includes('"$ref":"#"');
  const rootName = selfReferencing ? componentName(root.id ?? name) : null;
  delete root.id;

  /** @type {Record<string, string>} */
  const stored = {};
  const mapRef = (ref) => {
    if (ref === '#' && rootName) return COMPONENTS_PREFIX + stored['#'];
    const match = /^#\/\$defs\/(.+)$/.exec(ref);
    if (match && stored[match[1]]) return COMPONENTS_PREFIX + stored[match[1]];
    return ref;
  };

  // Reserve names first (refs can point at each other), then store the rewritten bodies.
  const existed = new Set(Object.keys(store.schemas));
  for (const key of Object.keys(defs)) stored[key] = componentName(renamed[key]);
  if (rootName) stored['#'] = rootName;
  for (const [key, body] of Object.entries(defs)) {
    const { id: _id, ...rest } = body;
    stored[key] = addComponent(store, stored[key], rewriteRefs(rest, mapRef), io);
  }
  // Names may have shifted when stored (suffixes), so rewrite the components this call created
  // against the final names. Components that already existed are shared and left alone.
  for (const [key, body] of Object.entries(defs)) {
    const { id: _id, ...rest } = body;
    if (!existed.has(stored[key])) store.schemas[stored[key]] = rewriteRefs(rest, mapRef);
  }

  if (rootName) {
    stored['#'] = addComponent(store, rootName, rewriteRefs(root, mapRef), io);
    if (!existed.has(stored['#'])) store.schemas[stored['#']] = rewriteRefs(root, mapRef);
    return { $ref: COMPONENTS_PREFIX + stored['#'] };
  }
  return /** @type {JsonSchema} */ (rewriteRefs(root, mapRef));
}

/**
 * Follow a local #/components/schemas/ ref.
 * @param {JsonSchema} schema
 * @param {SchemaStore} store
 * @returns {JsonSchema}
 */
export function resolveRef(schema, store) {
  let current = schema;
  for (let hops = 0; hops < 10 && typeof current?.$ref === 'string' && current.$ref.startsWith(COMPONENTS_PREFIX); hops += 1) {
    const target = store.schemas[current.$ref.slice(COMPONENTS_PREFIX.length)];
    if (!target) break;
    current = target;
  }
  return current;
}

/**
 * Split an object schema into OpenAPI parameters (for path and query).
 * A non-object schema becomes one form-exploded parameter, which OpenAPI allows but few tools love.
 *
 * @param {JsonSchema} schema converted with io: 'input'
 * @param {'path' | 'query'} location
 * @param {SchemaStore} store
 * @param {string} where for warnings
 * @returns {Array<Record<string, unknown>>}
 */
export function toParameters(schema, location, store, where) {
  const resolved = resolveRef(schema, store);
  const properties = /** @type {Record<string, JsonSchema> | undefined} */ (resolved.properties);
  if (resolved.type !== 'object' || !properties) {
    store.onWarning?.(`${where}: ${location} schema is not a plain object; documented as one exploded parameter`);
    return [{ name: location, in: location, required: location === 'path', schema: resolved, style: 'form', explode: true }];
  }
  const required = new Set(/** @type {string[]} */ (resolved.required ?? []));
  return Object.entries(properties).map(([name, property]) => {
    const { description, examples, deprecated, ...rest } = property;
    const parameter = {
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      ...(description ? { description } : {}),
      ...(deprecated ? { deprecated: true } : {}),
      schema: rest,
    };
    if (Array.isArray(examples) && examples.length > 0) parameter.example = examples[0];
    if (location === 'query' && (rest.type === 'array' || rest.type === 'object')) {
      parameter.style = 'form';
      parameter.explode = true;
    }
    return parameter;
  });
}

/**
 * True when a JSON Schema has required properties, so an empty body would be refused.
 * @param {JsonSchema} schema
 * @param {SchemaStore} store
 */
export function hasRequiredFields(schema, store) {
  const resolved = resolveRef(schema, store);
  if (Array.isArray(resolved.required) && resolved.required.length > 0) return true;
  return resolved.type !== undefined && resolved.type !== 'object';
}
