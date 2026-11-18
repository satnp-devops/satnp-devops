import { ApiError } from '@/lib/api';

// The subset of OpenAPI 3.1 the API reference page reads. The API builds the document from its
// routes and zod schemas (apps/api/src/core/openapi); see docs/platform/OPENAPI.md.

export const SPEC_URL = '/api/v1/openapi.json';

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  deprecated?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  'x-unrepresentable'?: string;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: JsonSchema;
}

export interface MediaType {
  schema?: JsonSchema;
}

export interface ResponseObject {
  $ref?: string;
  description?: string;
  content?: Record<string, MediaType>;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, ResponseObject>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
  'x-module'?: string;
  'x-auth'?: 'session' | 'optional' | 'public';
  'x-permissions'?: string[];
}

export interface SecurityScheme {
  type: string;
  in?: string;
  name?: string;
  scheme?: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string; 'x-displayName'?: string }>;
  paths: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    responses?: Record<string, ResponseObject>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
}

export interface Endpoint {
  key: string;
  method: string;
  path: string;
  operation: Operation;
}

export interface EndpointGroup {
  tag: string;
  label: string;
  endpoints: Endpoint[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Load the document. It is a raw OpenAPI document, not wrapped in { data }. */
export async function fetchOpenApi(): Promise<OpenApiDocument> {
  let response: Response;
  try {
    response = await fetch(SPEC_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection and try again.");
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = isRecord(json) && isRecord(json.error) ? json.error : {};
    throw new ApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'http_error',
      typeof error.message === 'string' ? error.message : `The server answered ${response.status}. Please try again.`,
      error.details,
      typeof error.requestId === 'string' ? error.requestId : undefined,
    );
  }
  if (!isRecord(json) || typeof json.openapi !== 'string' || !isRecord(json.paths) || !isRecord(json.info)) {
    throw new ApiError(500, 'invalid_document', 'The API description could not be read.');
  }
  return json as unknown as OpenApiDocument;
}

/** Name of a #/components/... ref: "#/components/schemas/Lead" -> "Lead". */
export function refName(ref: string | undefined): string | null {
  if (!ref) return null;
  const last = ref.split('/').pop();
  return last ? decodeURIComponent(last) : null;
}

/** Follow #/components/schemas refs (a few hops at most). */
export function resolveSchema(schema: JsonSchema | undefined, doc: OpenApiDocument): JsonSchema {
  let current: JsonSchema = schema ?? {};
  for (let hops = 0; hops < 8 && current.$ref; hops += 1) {
    const name = refName(current.$ref);
    const target = name && current.$ref.startsWith('#/components/schemas/') ? doc.components?.schemas?.[name] : undefined;
    if (!target) break;
    current = target;
  }
  return current;
}

/** Follow a #/components/responses ref. */
export function resolveResponse(response: ResponseObject, doc: OpenApiDocument): ResponseObject {
  if (!response.$ref) return response;
  const name = refName(response.$ref);
  return (name ? doc.components?.responses?.[name] : undefined) ?? response;
}

/** The JSON schema of a request body or response, if any. */
export function jsonContent(content: Record<string, MediaType> | undefined): JsonSchema | undefined {
  return content?.['application/json']?.schema ?? Object.values(content ?? {})[0]?.schema;
}

function literal(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? 'null';
}

/** A short, readable type: "string (uuid)", "integer", "Lead[]", "\"a\" | \"b\"", "string | null". */
export function describeType(schema: JsonSchema | undefined, doc: OpenApiDocument): string {
  if (!schema) return 'any';
  const ref = refName(schema.$ref);
  if (ref) return ref;
  if (schema['x-unrepresentable']) return 'any';
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(' | ');
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return variants.map((v) => describeType(v, doc)).join(' | ');
  if (schema.allOf) return schema.allOf.map((v) => describeType(v, doc)).join(' & ');
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) return schema.properties ? 'object' : 'any';
  return types
    .map((type) => {
      if (type === 'array') return `${describeType(schema.items, doc)}[]`;
      if (type === 'string' && schema.format) return `string (${schema.format})`;
      return type;
    })
    .join(' | ');
}

/** Rules worth showing next to a field: lengths, ranges, defaults. Patterns only when there is no format. */
export function constraints(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const out: string[] = [];
  const range = (label: string, min?: number, max?: number) => {
    if (min !== undefined && max !== undefined) out.push(`${label} ${min}–${max}`);
    else if (min !== undefined) out.push(`${label} ≥ ${min}`);
    else if (max !== undefined) out.push(`${label} ≤ ${max}`);
  };
  range('length', schema.minLength, schema.maxLength);
  range('items', schema.minItems, schema.maxItems);
  const max = schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER ? schema.maximum : undefined;
  const min = schema.minimum !== undefined && schema.minimum > Number.MIN_SAFE_INTEGER ? schema.minimum : undefined;
  range('value', min, max);
  if (schema.exclusiveMinimum !== undefined) out.push(`> ${schema.exclusiveMinimum}`);
  if (schema.exclusiveMaximum !== undefined) out.push(`< ${schema.exclusiveMaximum}`);
  if (schema.pattern && !schema.format) out.push(`pattern ${schema.pattern}`);
  if (schema.default !== undefined) out.push(`default ${literal(schema.default)}`);
  return out;
}

/** Endpoints grouped by tag (one per module), in the document's tag order. */
export function groupEndpoints(doc: OpenApiDocument): EndpointGroup[] {
  const labels = new Map((doc.tags ?? []).map((t) => [t.name, t['x-displayName'] ?? t.description ?? t.name]));
  const groups = new Map<string, EndpointGroup>();
  for (const tag of doc.tags ?? []) groups.set(tag.name, { tag: tag.name, label: labels.get(tag.name) ?? tag.name, endpoints: [] });

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const tag = operation.tags?.[0] ?? operation['x-module'] ?? 'other';
      let group = groups.get(tag);
      if (!group) {
        group = { tag, label: labels.get(tag) ?? tag, endpoints: [] };
        groups.set(tag, group);
      }
      group.endpoints.push({ key: `${method} ${path}`, method, path, operation });
    }
  }
  return [...groups.values()].filter((g) => g.endpoints.length > 0);
}

/** Case-insensitive match on path, method, summary, permission and operationId. */
export function endpointMatches(endpoint: Endpoint, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { operation } = endpoint;
  return [
    endpoint.method,
    endpoint.path,
    operation.summary ?? '',
    operation.operationId ?? '',
    ...(operation['x-permissions'] ?? []),
  ].some((text) => text.toLowerCase().includes(q));
}

/** Who may call it, in words. */
export function authLabel(operation: Operation): string {
  switch (operation['x-auth']) {
    case 'public':
      return 'No sign-in';
    case 'optional':
      return 'Signed in or out';
    default:
      return 'Signed in';
  }
}

/** Split text on `code` spans and drop Markdown bold markers, for plain rendering without HTML injection. */
export function inlineParts(text: string): Array<{ code: boolean; text: string }> {
  return text
    .replace(/\*\*/g, '')
    .split('`')
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((part) => part.text !== '');
}
