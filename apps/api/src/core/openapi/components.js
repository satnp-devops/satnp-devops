/**
 * The parts every Phoenix endpoint shares: envelopes, the error format and the auth schemes.
 * They mirror src/middleware/errorHandler.js, src/lib/errors.js, src/middleware/csrf.js and
 * src/lib/pagination.js; change them together.
 */

/** Shared schemas, under #/components/schemas. */
export function baseSchemas() {
  return {
    FieldError: {
      type: 'object',
      description: 'One field that failed validation. `path` starts with the request part: body.email, query.limit, params.id.',
      properties: {
        path: { type: 'string', examples: ['body.email'] },
        message: { type: 'string', examples: ['Enter a valid email address'] },
      },
      required: ['path', 'message'],
    },
    Error: {
      type: 'object',
      description: 'Every error answers with this shape.',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Stable, machine-readable. Branch on this, not on the message.',
              examples: ['not_found'],
            },
            message: { type: 'string', description: 'Safe to show to people.' },
            details: { description: 'Extra information; an array of FieldError for validation_failed.' },
            requestId: { type: 'string', description: 'Quote this when reporting a problem; it is also in the X-Request-Id header.' },
          },
          required: ['code', 'message'],
        },
      },
      required: ['error'],
    },
    ValidationError: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { const: 'validation_failed' },
            message: { type: 'string' },
            details: { type: 'array', items: { $ref: '#/components/schemas/FieldError' } },
            requestId: { type: 'string' },
          },
          required: ['code', 'message', 'details'],
        },
      },
      required: ['error'],
    },
    Cursor: {
      type: ['string', 'null'],
      description: 'Opaque. Pass it back as `cursor` to get the next page; null on the last page.',
    },
  };
}

/**
 * Standard error responses, under #/components/responses. Codes come from src/lib/errors.js.
 * @type {Record<string, { status: number, description: string, codes: string[], schema?: string }>}
 */
export const ERROR_RESPONSES = Object.freeze({
  BadRequest: { status: 400, description: 'The request could not be understood.', codes: ['bad_request', 'invalid_json'] },
  Unauthorized: {
    status: 401,
    description: 'Not signed in, or the session expired.',
    codes: ['unauthorized', 'invalid_credentials', 'invalid_code'],
  },
  Forbidden: {
    status: 403,
    description:
      'Signed in but not allowed: missing permission, a two-step code is still needed, two-step setup is required, or a write came without the X-Phoenix-Client header.',
    codes: ['forbidden', 'mfa_required', 'mfa_setup_required'],
  },
  NotFound: {
    status: 404,
    description: "It doesn't exist, or you can't see it (invisible units answer 404 so their existence isn't revealed).",
    codes: ['not_found'],
  },
  Conflict: { status: 409, description: 'Clashes with existing data, or is still in use.', codes: ['conflict'] },
  PayloadTooLarge: { status: 413, description: 'The body is over 1 MB.', codes: ['payload_too_large'] },
  ValidationFailed: {
    status: 422,
    description: 'Some fields need attention. `details` lists each field.',
    codes: ['validation_failed'],
    schema: 'ValidationError',
  },
  RateLimited: { status: 429, description: 'Too many attempts. Wait a few minutes.', codes: ['rate_limited'] },
  InternalError: { status: 500, description: 'Something went wrong on our side.', codes: ['internal_error'] },
});

/** Status -> component name, e.g. 404 -> NotFound. */
export const RESPONSE_BY_STATUS = Object.freeze(
  Object.fromEntries(Object.entries(ERROR_RESPONSES).map(([name, r]) => [r.status, name])),
);

export function baseResponses() {
  return Object.fromEntries(
    Object.entries(ERROR_RESPONSES).map(([name, r]) => [
      name,
      {
        description: `${r.description} Codes: ${r.codes.map((c) => `\`${c}\``).join(', ')}.`,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${r.schema ?? 'Error'}` } } },
      },
    ]),
  );
}

/**
 * Auth schemes, under #/components/securitySchemes.
 * @param {{ sessionCookieName: string, apiKeys: boolean }} options
 */
export function securitySchemes({ sessionCookieName, apiKeys }) {
  return {
    session: {
      type: 'apiKey',
      in: 'cookie',
      name: sessionCookieName,
      description: 'The HttpOnly session cookie set by POST /auth/login. Browsers send it automatically.',
    },
    phoenixClient: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Phoenix-Client',
      description:
        'Required on every write (POST, PUT, PATCH, DELETE) made with the session cookie. Any value works, for example "web"; cross-site forms cannot send custom headers, so this stops CSRF.',
    },
    ...(apiKeys
      ? {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'An API key from Settings › Integrations, sent as `Authorization: Bearer <key>`. Writes need no X-Phoenix-Client header.',
          },
        }
      : {}),
  };
}

const SAFE_METHODS = new Set(['get', 'head', 'options']);

/**
 * Security requirements for one operation (OpenAPI: alternatives are ORed, schemes inside one
 * requirement are ANDed; an empty requirement {} means "no auth needed").
 * @param {'session' | 'optional' | 'public'} auth
 * @param {string} method
 * @param {boolean} apiKeys
 */
export function securityFor(auth, method, apiKeys) {
  const write = !SAFE_METHODS.has(method);
  const signedIn = write ? { session: [], phoenixClient: [] } : { session: [] };
  const anonymous = write ? { phoenixClient: [] } : {};
  const withKey = apiKeys ? [{ apiKey: [] }] : [];
  if (auth === 'public') return [anonymous];
  if (auth === 'optional') return [signedIn, ...withKey, anonymous];
  return [signedIn, ...withKey];
}

/**
 * The success envelope: { data } or, for lists, { data: [...], nextCursor }.
 * @param {Record<string, unknown> | null} dataSchema null when the route doesn't declare one
 * @param {boolean} list
 */
export function envelope(dataSchema, list) {
  const data = dataSchema ?? {};
  if (list) {
    return {
      type: 'object',
      properties: { data: { type: 'array', items: data }, nextCursor: { $ref: '#/components/schemas/Cursor' } },
      required: ['data', 'nextCursor'],
    };
  }
  return { type: 'object', properties: { data }, required: ['data'] };
}
