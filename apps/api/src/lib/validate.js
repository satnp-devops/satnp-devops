import { errors } from './errors.js';

/**
 * Where validate() keeps its schemas on the middleware it returns, so the OpenAPI route
 * collector (core/openapi) can document a route from the same zod shapes that check it.
 * Symbol.for keeps it one value even if this file is loaded twice.
 */
export const VALIDATE_SCHEMAS = Symbol.for('phoenix.validate.schemas');

/** Turn zod issues into the API's field error format. */
export function toFieldErrors(error, prefix) {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path].filter((p) => p !== undefined && p !== '').join('.'),
    message: issue.message,
  }));
}

/**
 * Validate params, query and body with zod schemas.
 * Parsed values land on req.valid because Express 5 makes req.query read-only.
 * The schemas stay readable on the middleware as middleware[VALIDATE_SCHEMAS].
 */
export function validate(schemas) {
  const middleware = (req, _res, next) => {
    const valid = {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) throw errors.validation(toFieldErrors(result.error, part));
      valid[part] = result.data;
    }
    req.valid = valid;
    next();
  };
  middleware[VALIDATE_SCHEMAS] = Object.freeze({ ...schemas });
  return middleware;
}

/** Parse with a schema inside a handler and throw a 422 on failure. */
export function parseOrThrow(schema, value, prefix) {
  const result = schema.safeParse(value);
  if (!result.success) throw errors.validation(toFieldErrors(result.error, prefix));
  return result.data;
}
