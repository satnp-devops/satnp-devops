import { mergeDescriptions, isZodSchema } from './describe.js';
import { toOpenApiPaths } from './paths.js';
import { createSchemaStore, hasRequiredFields, toJsonSchema, toParameters } from './schema.js';
import { RESPONSE_BY_STATUS, baseResponses, baseSchemas, envelope, securityFor, securitySchemes } from './components.js';

/**
 * buildSpec(registry, routes, options) -> an OpenAPI 3.1 document. Pure: no I/O, same input,
 * same output. Spec: https://spec.openapis.org/oas/v3.1.1.html
 *
 * @typedef {import('./collector.js').CollectedRoute} CollectedRoute
 * @typedef {import('./describe.js').RouteDescription} RouteDescription
 * @typedef {{
 *   title?: string,
 *   version?: string,
 *   description?: string,
 *   serverUrl?: string,
 *   sessionCookieName?: string,
 *   apiKeys?: boolean,
 *   descriptions?: Record<string, RouteDescription>,
 *   onWarning?: (message: string) => void,
 * }} BuildOptions
 *   descriptions  extra descriptions keyed "METHOD /express/path" (see phase1.js); a route's own describe() wins
 *   apiKeys       document Bearer API keys (turn on when the integrations module ships them)
 */

export const OPENAPI_VERSION = '3.1.1';

const DOCUMENTED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const NO_CONTENT = new Set([204, 205, 304]);
const PARTS = /** @type {const} */ (['params', 'query', 'body']);

/** The key used in `descriptions`: "GET /users/:id". */
export const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;

/**
 * operationId from method and path: GET /org/units/:id -> getOrgUnitsById.
 * @param {string} method
 * @param {string} path an OpenAPI template
 */
export function operationIdFor(method, path) {
  const words = [];
  for (const segment of path.split('/').filter(Boolean)) {
    const param = /^\{(.+)\}$/.exec(segment);
    if (param) words.push('by', ...splitWords(param[1]));
    else words.push(...splitWords(segment));
  }
  const camel = words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return `${method.toLowerCase()}${camel.charAt(0).toUpperCase()}${camel.slice(1)}` || method.toLowerCase();
}

function splitWords(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Build the OpenAPI document.
 * @param {{ modules: Array<{ name: string, label?: string }>, permissions?: Map<string, { label?: string }> }} registry
 * @param {CollectedRoute[]} routes
 * @param {BuildOptions} [options]
 */
export function buildSpec(registry, routes, options = {}) {
  const {
    title = 'Phoenix Platform API',
    version = '0.1.0',
    description = defaultDescription(),
    serverUrl = '/api/v1',
    sessionCookieName = 'phx_session',
    apiKeys = false,
    descriptions = {},
    onWarning,
  } = options;

  const store = createSchemaStore(onWarning);
  Object.assign(store.schemas, baseSchemas());
  const warn = (message) => onWarning?.(message);

  const moduleOrder = new Map(registry.modules.map((m, i) => [m.name, i]));
  const labels = new Map(registry.modules.map((m) => [m.name, m.label ?? m.name]));
  const sorted = [...routes].sort(
    (a, b) => (moduleOrder.get(a.module) ?? Infinity) - (moduleOrder.get(b.module) ?? Infinity) || a.order - b.order,
  );

  /** @type {Record<string, Record<string, unknown>>} */
  const paths = {};
  const usedTags = new Set();
  const operationIds = new Set();
  const usedDescriptionKeys = new Set();

  for (const route of sorted) {
    const method = route.method.toLowerCase();
    if (!DOCUMENTED_METHODS.has(method)) continue;
    const key = routeKey(method, route.path);
    if (descriptions[key]) usedDescriptionKeys.add(key);
    const meta = mergeDescriptions(descriptions[key], route.description);
    if (meta.hidden) continue;

    let variants;
    try {
      variants = toOpenApiPaths(route.path);
    } catch (err) {
      warn(`${key}: ${err.message}; not documented`);
      continue;
    }

    for (const variant of variants) {
      const where = `${method.toUpperCase()} ${variant.path}`;
      if (paths[variant.path]?.[method]) {
        warn(`${where} is registered twice; the first registration is documented`);
        continue;
      }
      const tags = meta.tags ?? [route.module];
      for (const tag of tags) usedTags.add(tag);

      let operationId = meta.operationId ?? operationIdFor(method, variant.path);
      if (operationIds.has(operationId)) {
        let n = 2;
        while (operationIds.has(`${operationId}${n}`)) n += 1;
        if (meta.operationId) warn(`${where}: operationId "${operationId}" is used twice; documented as "${operationId}${n}"`);
        operationId = `${operationId}${n}`;
      }
      operationIds.add(operationId);

      const permissions = meta.permission ? [meta.permission].flat() : [];
      const auth = meta.auth ?? 'session';
      const opName = operationId;
      const text = composeDescription(meta, permissions, auth);

      /** @type {Record<string, unknown>} */
      const operation = {
        operationId,
        summary: meta.summary ?? defaultSummary(method, variant.path),
        ...(text ? { description: text } : {}),
        tags,
      };
      if (!meta.summary) warn(`${where} has no summary; add describe({ summary }) or a catalogue entry`);

      // Parameters: path first (in template order), then query.
      const parameters = [];
      const pathParams = route.schemas.params
        ? toParameters(convert(route.schemas.params, 'input', `${opName}Params`, `${where} params`), 'path', store, where)
        : [];
      for (const param of variant.params) {
        const declared = pathParams.find((p) => p.name === param.name);
        parameters.push(
          declared ?? {
            name: param.name,
            in: 'path',
            required: true,
            schema: param.splat ? { type: 'string', description: 'One or more path segments' } : { type: 'string' },
          },
        );
      }
      for (const declared of pathParams) {
        if (!variant.params.some((p) => p.name === declared.name) && declared.name !== 'path') {
          warn(`${where}: params schema has "${declared.name}", which is not in the path`);
        }
      }
      if (route.schemas.query) {
        parameters.push(
          ...toParameters(convert(route.schemas.query, 'input', `${opName}Query`, `${where} query`), 'query', store, where),
        );
      }
      if (parameters.length > 0) operation.parameters = parameters;

      if (route.schemas.body) {
        const schema = convert(route.schemas.body, 'input', `${opName}Body`, `${where} body`);
        operation.requestBody = {
          required: hasRequiredFields(schema, store),
          content: { 'application/json': { schema } },
        };
        if (method === 'get' || method === 'head') warn(`${where}: a body schema on a ${method.toUpperCase()} route`);
      }

      operation.responses = buildResponses({ meta, method, route, variant, auth, convert, opName, where });
      // API keys are refused on account endpoints (/auth/...), see modules/integrations/apiKeys/auth.js.
      operation.security = securityFor(auth, method, apiKeys && !variant.path.startsWith('/auth/'));
      if (meta.deprecated) operation.deprecated = true;
      operation['x-module'] = route.module;
      operation['x-auth'] = auth;
      if (permissions.length > 0) operation['x-permissions'] = permissions;

      paths[variant.path] ??= {};
      paths[variant.path][method] = operation;
    }
  }

  for (const key of Object.keys(descriptions)) {
    if (!usedDescriptionKeys.has(key)) warn(`Description "${key}" matches no registered route`);
  }

  const tags = [...registry.modules.map((m) => m.name), ...[...usedTags].filter((t) => !moduleOrder.has(t))]
    .filter((name) => usedTags.has(name))
    .map((name) => ({
      name,
      description: labels.get(name) ?? name,
      'x-displayName': labels.get(name) ?? name,
    }));

  return {
    openapi: OPENAPI_VERSION,
    info: { title, version, description },
    servers: [{ url: serverUrl, description: 'This API, version 1' }],
    tags,
    paths,
    components: {
      schemas: store.schemas,
      responses: baseResponses(),
      securitySchemes: securitySchemes({ sessionCookieName, apiKeys }),
    },
  };

  /**
   * @param {import('zod').ZodType} schema
   * @param {'input' | 'output'} io
   */
  function convert(schema, io, name, where) {
    return toJsonSchema(schema, { io, store, name, where });
  }
}

/** Success and error responses for one operation. */
function buildResponses({ meta, method, route, variant, auth, convert, opName, where }) {
  /** @type {Record<string, unknown>} */
  const responses = {};
  const declared = meta.responses ?? {};
  const successStatus = meta.status ?? (Object.keys(declared).map(Number).find((s) => s < 400) || 200);

  const successStatuses = new Set([successStatus, ...Object.keys(declared).map(Number).filter((s) => s < 400)]);
  for (const status of [...successStatuses].sort((a, b) => a - b)) {
    const entry = normaliseResponse(declared[status]);
    const list = entry.list ?? (status === successStatus ? meta.list === true : false);
    if (NO_CONTENT.has(status)) {
      responses[status] = { description: entry.description ?? 'Done. No content.' };
      continue;
    }
    const data = entry.schema ? convert(entry.schema, 'output', `${opName}${status}`, `${where} response ${status}`) : null;
    const schema = entry.raw ? (data ?? {}) : envelope(data, list);
    responses[status] = {
      description: entry.description ?? (list ? 'A page of results.' : status === 201 ? 'Created.' : 'OK.'),
      content: { 'application/json': { schema } },
    };
  }

  // Errors: inferred from what the route does, plus what it declares.
  const errorStatuses = new Set(meta.errors ?? []);
  const write = !['get', 'head', 'options'].includes(method);
  if (Object.values(route.schemas).some(Boolean)) errorStatuses.add(422);
  if (route.schemas.body) errorStatuses.add(400);
  if (auth === 'session') errorStatuses.add(401).add(403);
  if (write) errorStatuses.add(403);
  if (variant.params.length > 0) errorStatuses.add(404);
  if (meta.rateLimited) errorStatuses.add(429);
  for (const status of Object.keys(declared).map(Number)) if (status >= 400) errorStatuses.add(status);

  for (const status of [...errorStatuses].sort((a, b) => a - b)) {
    const entry = declared[status] ? normaliseResponse(declared[status]) : null;
    if (entry?.schema) {
      responses[status] = {
        description: entry.description ?? 'Error.',
        content: { 'application/json': { schema: convert(entry.schema, 'output', `${opName}${status}`, `${where} response ${status}`) } },
      };
    } else if (RESPONSE_BY_STATUS[status]) {
      responses[status] = entry?.description
        ? { description: entry.description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
        : { $ref: `#/components/responses/${RESPONSE_BY_STATUS[status]}` };
    } else {
      responses[status] = {
        description: entry?.description ?? 'Error.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
    }
  }
  responses.default = { $ref: '#/components/responses/InternalError' };
  return responses;
}

/** Accept a bare zod schema or { description, schema, list, raw }. */
function normaliseResponse(entry) {
  if (!entry) return {};
  return isZodSchema(entry) ? { schema: entry } : entry;
}

function defaultSummary(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

/** The operation description: the route's own text plus who may call it. */
function composeDescription(meta, permissions, auth) {
  const lines = [];
  if (meta.description) lines.push(meta.description);
  if (permissions.length > 0) {
    lines.push(`**Permission:** ${permissions.map((p) => `\`${p}\``).join(' or ')} at the unit concerned (or above it).`);
  }
  if (auth === 'public') lines.push('**No sign-in needed.**');
  if (auth === 'optional') lines.push('**Works signed in or out.**');
  return lines.join('\n\n');
}

function defaultDescription() {
  return [
    'The Phoenix Platform REST API. Every path below is under `/api/v1`.',
    '',
    '- **Success** answers `{ "data": ... }`; lists answer `{ "data": [...], "nextCursor": "..." | null }`. Pass `cursor` (and optionally `limit`) to get the next page.',
    '- **Errors** answer `{ "error": { "code", "message", "details", "requestId" } }`. Branch on `code`; `validation_failed` lists each field in `details`.',
    '- **Auth**: sign in with `POST /auth/login` to get the session cookie. Every write must also send the `X-Phoenix-Client` header (any value).',
    '- **Times** are UTC ISO 8601 instants; **money** is integer minor units with an ISO 4217 currency; **ids** are UUIDs.',
    '- **Permissions** are checked at the unit a request is about and are inherited down the organisation tree. Units you cannot see answer 404.',
  ].join('\n');
}
