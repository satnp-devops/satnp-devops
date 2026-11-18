/**
 * OpenAPI 3.1 for the Phoenix API, generated from the routes and zod schemas that run.
 * See docs/platform/OPENAPI.md.
 */
export { describe, describeOf, parseDescription, mergeDescriptions, DESCRIBE, AUTH_MODES } from './describe.js';
export { createRouteCollector, inspectHandlers, flattenHandlers, ROUTE_METHODS } from './collector.js';
export { toOpenApiPaths, joinPaths, tokenize, templateParams } from './paths.js';
export { toJsonSchema, toParameters, createSchemaStore, addComponent, COMPONENTS_PREFIX } from './schema.js';
export { buildSpec, operationIdFor, routeKey, OPENAPI_VERSION } from './spec.js';
export { lintSpec, collectRefs, resolvePointer } from './lint.js';
export { PHASE1_DESCRIPTIONS } from './phase1.js';
