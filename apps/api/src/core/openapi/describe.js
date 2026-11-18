import { z } from 'zod';

/**
 * describe() adds documentation to a route without changing what it does:
 *
 *   router.get('/leads/:id',
 *     describe({ summary: 'Get a lead', permission: 'leads.view', responses: { 200: leadSchema } }),
 *     requireAuth(), validate({ params: idParams }), handler);
 *
 * The middleware only calls next(). The route collector reads the metadata from it.
 */

/** Where describe() keeps its metadata on the middleware it returns. */
export const DESCRIBE = Symbol.for('phoenix.openapi.describe');

/** HTTP statuses a description may name: 2xx successes and 4xx/5xx errors. */
const statusSchema = z.coerce.number().int().min(200).max(599);

const zodSchema = z.custom((value) => isZodSchema(value), { message: 'Expected a zod schema' });

/**
 * One documented response. A bare zod schema is shorthand for { schema }.
 * schema describes what goes inside the envelope ({ data }); `list` wraps it as { data: [...], nextCursor }.
 * Set `raw` when the handler answers without the envelope (like openapi.json itself).
 */
const responseSchema = z.union([
  zodSchema,
  z.strictObject({
    description: z.string().min(1).max(500).optional(),
    schema: zodSchema.optional(),
    list: z.boolean().optional(),
    raw: z.boolean().optional(),
  }),
]);

/**
 * Who may call a route:
 *   session   a signed-in session cookie (or, once they exist, an API key)   default
 *   optional  works signed in or out (sign-out)
 *   public    no session needed (sign-in, password reset, invitation links)
 * Writes always need the X-Phoenix-Client header, whatever the auth.
 */
export const AUTH_MODES = Object.freeze(['session', 'optional', 'public']);

const permissionKey = z.string().regex(/^(\*|[a-z][a-z0-9_]*\.(\*|[a-z][a-z0-9_]*)(:own)?)$/, 'Use a permission key like users.view');

export const descriptionSchema = z.strictObject({
  /** One line, sentence case, no full stop: "Invite a person". */
  summary: z.string().trim().min(1).max(120).optional(),
  /** Longer Markdown: rules, side effects, the events it emits. */
  description: z.string().trim().min(1).max(4000).optional(),
  /** Defaults to the module that registered the route. */
  tags: z.array(z.string().min(1).max(60)).min(1).optional(),
  /** Permission(s) the handler checks, for people reading the docs. The handler still enforces them. */
  permission: z.union([permissionKey, z.array(permissionKey).min(1)]).optional(),
  auth: z.enum(AUTH_MODES).optional(),
  /** The success status. Defaults to 200. */
  status: statusSchema.optional(),
  /** Shorthand for a cursor-paginated list response: { data: [...], nextCursor }. */
  list: z.boolean().optional(),
  /** Response schemas by status. */
  responses: z.record(z.string().regex(/^[2-5]\d\d$/, 'Use a status code like 200'), responseSchema).optional(),
  /** Error statuses the route can answer beyond the inferred ones (401/403/404/422). */
  errors: z.array(statusSchema.refine((s) => s >= 400, 'Error statuses are 4xx or 5xx')).optional(),
  /** Rate limited: documents 429. */
  rateLimited: z.boolean().optional(),
  operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(100).optional(),
  deprecated: z.boolean().optional(),
  /** Leave the route out of the spec (internal or test-only endpoints). */
  hidden: z.boolean().optional(),
});

/**
 * @typedef {z.infer<typeof descriptionSchema>} RouteDescription
 */

/** True for any zod 4 schema instance. */
export function isZodSchema(value) {
  return typeof value === 'object' && value !== null && typeof value._zod === 'object' && typeof value.safeParse === 'function';
}

/**
 * Check a description and return a frozen copy. Mistakes throw at start-up, not at request time.
 * @param {unknown} meta
 * @param {string} [where] for the error message, e.g. "GET /users"
 * @returns {Readonly<RouteDescription>}
 */
export function parseDescription(meta, where = 'describe()') {
  const result = descriptionSchema.safeParse(meta);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid route description for ${where}: ${problems}`);
  }
  return Object.freeze(result.data);
}

/**
 * Middleware that documents a route. It does nothing at request time.
 * @param {RouteDescription} meta
 */
export function describe(meta) {
  const parsed = parseDescription(meta);
  const middleware = (_req, _res, next) => next();
  middleware[DESCRIBE] = parsed;
  return middleware;
}

/**
 * The description attached to a middleware by describe(), if any.
 * @param {unknown} fn
 * @returns {Readonly<RouteDescription> | undefined}
 */
export function describeOf(fn) {
  return typeof fn === 'function' ? fn[DESCRIBE] : undefined;
}

/**
 * Merge descriptions; later ones win field by field. `responses` merge by status.
 * @param {...(RouteDescription | undefined)} parts
 * @returns {RouteDescription}
 */
export function mergeDescriptions(...parts) {
  /** @type {RouteDescription} */
  const out = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part)) {
      if (value === undefined) continue;
      out[key] = key === 'responses' ? { ...(out.responses ?? {}), ...value } : value;
    }
  }
  return out;
}
