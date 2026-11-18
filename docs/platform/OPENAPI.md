# OpenAPI: the API documents itself

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 document of every endpoint, generated at run time from the routes the API registers and the zod schemas that validate them. Settings › API in the web app renders it as a readable reference. Nothing is written by hand twice, so the docs can't drift from the code.

Code: `apps/api/src/core/openapi/`. Tests: `apps/api/test/openapi/` (run `cd apps/api && node --test "test/openapi/*.test.js"`).

## 1. How it fits together

```
modules/*/routes.js ──router.get(path, describe?, requireAuth(), validate({...}), handler)
        │
app.js  └─ collector.wrap(api, mod.name)   records { method, path, module, schemas, description }
                                            and forwards every call to the real router unchanged
        │
http.js ── GET /openapi.json ── buildSpec(registry, collector.routes, { descriptions: PHASE1_DESCRIPTIONS })
                                 (built on the first request, then cached)
        │
web     └─ settings/api/ApiDocsView.tsx    endpoints grouped by module, parameters, bodies, responses, schemas
```

| File | Job |
| --- | --- |
| `describe.js` | `describe({...})`: a do-nothing middleware that carries documentation; `parseDescription` checks it at start-up |
| `collector.js` | `createRouteCollector()`: a Proxy around the Express router that records registrations |
| `paths.js` | Express 5 paths → OpenAPI templates (`/users/:id` → `/users/{id}`) |
| `schema.js` | zod → JSON Schema 2020-12 with `z.toJSONSchema`, shared components, parameters |
| `components.js` | envelopes, the error format, standard error responses, auth schemes |
| `spec.js` | `buildSpec(registry, routes, options)`: the document. Pure: no I/O |
| `lint.js` | `lintSpec(doc)`: structural checks (required fields, path params, unique operationIds, dangling refs) |
| `phase1.js` | descriptions of the phase 1 routes, kept outside the module files |
| `http.js` | the Express route and its access rule |

`lib/validate.js` keeps its schemas on the middleware it returns (`middleware[VALIDATE_SCHEMAS]`); that is the only change to how routes work.

## 2. API

```js
import { describe } from '../../core/openapi/describe.js';
import { createRouteCollector } from '../../core/openapi/collector.js';
import { buildSpec } from '../../core/openapi/spec.js';
import { lintSpec } from '../../core/openapi/lint.js';
```

### `describe(meta)` → middleware

Put it anywhere in a route's middleware list (first is easiest to read). Every field is optional; mistakes (unknown keys, bad permission keys, bad statuses) throw when the module loads.

| Field | Meaning |
| --- | --- |
| `summary` | One line, sentence case, no full stop: "Invite a person". Shown in lists. |
| `description` | Markdown: rules, side effects, events emitted. Permissions and auth are appended automatically. |
| `permission` | A key or an array of keys the handler checks (documentation only; the handler still enforces). Listed in `x-permissions`. |
| `auth` | `'session'` (default), `'optional'` (works signed in or out), `'public'` (no sign-in). |
| `status` | The success status: 200 (default), 201, 204. |
| `list` | The response is a cursor page: `{ data: [...], nextCursor }`. |
| `responses` | `{ [status]: zodSchema \| { schema?, description?, list?, raw? } }`. `schema` is what goes inside `data`; `raw: true` skips the envelope. |
| `errors` | Extra error statuses (e.g. `[404, 409]`) beyond the inferred ones. |
| `rateLimited` | Documents 429. |
| `tags` | Defaults to the module name. |
| `operationId` | Defaults to method + path: `GET /org/units/:id` → `getOrgUnitsById`. |
| `deprecated`, `hidden` | Flag it, or leave it out of the document. |

### `createRouteCollector({ onWarning })` → `{ routes, warnings, wrap, record }`

- `wrap(router, moduleName)` returns a stand-in for the router. `get/post/put/patch/delete/head/options/all`, `route(path).get(...)` chains and arrays of paths are recorded; everything else passes through. Calls are applied to the real router, so behaviour is identical, and a path Express refuses still throws and is not recorded.
- Each record: `{ method, path, module, schemas: { params?, query?, body? }, description, order }`. If a route has two `validate()` calls, the later one's parts win, as they do on `req.valid`.
- Not recorded (with a warning): RegExp paths, and routes on a sub-router mounted with `router.use()`. Register routes on the router you're given.

### `buildSpec(registry, routes, options)` → OpenAPI 3.1 document

`registry` needs `modules: [{ name, label }]`. Options: `title`, `version`, `description`, `serverUrl` (`/api/v1`), `sessionCookieName` (`phx_session`), `apiKeys` (false), `descriptions` (`{ 'GET /users/:id': meta }`, overridden by a route's own `describe()`), `onWarning`.

It never throws for a bad route: it warns and leaves that route out (or documents it as best it can). The server logs build warnings once; `test/openapi/app.test.js` fails on any warning, so a missing summary or a stale catalogue entry is caught in CI.

### `lintSpec(doc)` → `string[]`

Problems found, empty when fine. Use it in tests of new modules if you build a document yourself.

## 3. Rules

### Paths (path-to-regexp v8, used by Express 5)

| Express | OpenAPI |
| --- | --- |
| `/users/:id` | `/users/{id}` |
| `/files/*rest` | `/files/{rest}` (a string of one or more segments) |
| `/reports{/:year}` | two paths: `/reports` and `/reports/{year}` |
| `/:"unit id"` | `/{unit id}` |
| `/price\:usd` | `/price:usd` |

Every `{param}` gets a parameter: from the `params` schema when there is one, else `{ type: string }`. All path parameters are required (OpenAPI 3.1 §4.8.12.1). Source: [path-to-regexp README](https://github.com/pillarjs/path-to-regexp).

### Schemas (zod 4.6 `z.toJSONSchema`, [zod.dev/json-schema](https://zod.dev/json-schema))

- **Requests use `io: 'input'`**, responses `io: 'output'`. So `z.coerce.number().int().default(50)` documents an optional `integer` with `default: 50` in a query, and `z.preprocess(trim, z.email())` documents an email string. Plain `z.object` is open on input (unknown keys are stripped, not refused) and closed on output; `z.strictObject` is closed on both.
- **Metadata**: `.describe()` and `.meta({ description, examples, deprecated, title })` are kept. In parameters, `description`, `deprecated` and the first example move to the parameter.
- **Shared components**: give a schema `.meta({ id: 'Lead' })` and it becomes `#/components/schemas/Lead`, referenced wherever it's used. If the input and output shapes of one id differ, the second one seen gets a suffix (`LeadOutput` or `LeadInput`). Recursive schemas (getter syntax) become self-referencing components.
- **Unrepresentable types never throw**: `z.date()` becomes `{ type: string, format: date-time }` (how JSON sends it); `bigint`, `map`, `set`, `custom`, `function` and bare transforms become "any value" with `x-unrepresentable` and a build warning. Refinements (`.refine`) keep the base type; the rule itself is described in words if it matters.
- A request body is `required` when its schema has required fields. A `query` or `params` schema that isn't a plain object becomes one form-exploded parameter, with a warning.

### Envelopes and errors

- Success: `{ data }`, or `{ data: [...], nextCursor }` with `list: true`. Without a response schema, `data` is documented as any value. 204 has no body.
- Every error is `{ error: { code, message, details, requestId } }` (`components.schemas.Error`); 422 uses `ValidationError`, whose `details` is a list of `{ path, message }`.
- Error statuses are inferred: 401 and 403 for signed-in routes, 403 for every write (missing `X-Phoenix-Client`), 400 and 422 when there's a body or other validated input, 404 when the path has parameters, 429 with `rateLimited`. Add others with `errors` or `responses`. Every operation also has `default` → `InternalError`.

### Auth (`components.securitySchemes`)

| Scheme | What |
| --- | --- |
| `session` | the HttpOnly session cookie (`SESSION_COOKIE_NAME`) |
| `phoenixClient` | the `X-Phoenix-Client` header, required on every write that uses the cookie (src/middleware/csrf.js) |
| `apiKey` | `Authorization: Bearer <key>`, only when `apiKeys: true` |

Per operation: reads need `session`; writes need `session` **and** `phoenixClient`; public writes need only `phoenixClient`; `optional` lists the signed-in and anonymous alternatives. When the integrations module ships API keys (phase 3), pass `apiKeys: true` in `http.js` and keys appear as an alternative on every signed-in operation (the CSRF guard already exempts the `Authorization` header).

### Who can read `openapi.json`

**Decision:** anyone in development and test; signed-in users (`requireAuth()`, two-step verified) in production.

Why: locally, tools like Postman, code generators and Swagger Editor should load it without a cookie. The document has no data, only routes and input shapes, but in production there's no reason to hand the full API surface to strangers. A staging server reachable from the internet should run with `NODE_ENV=production`. The document is cached after the first request and sent with `Cache-Control: private, no-cache` (Express adds an ETag).

## 4. How a new module uses it

Nothing to install: routes registered through the router a module receives are documented automatically, with inputs taken from `validate()`. Add `describe()` for the words and the response shape:

```js
import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';

// Response shapes: give shared ones an id so they become components.
export const contactSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phone: z.string().nullable().describe('E.164, e.g. +919876543210'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Contact', description: 'A family, student or institute contact' });

export function contactRoutes(router) {
  router.get(
    '/contacts',
    describe({ summary: 'List contacts in a unit', permission: 'contacts.view', list: true, responses: { 200: contactSchema } }),
    requireAuth(),
    validate({ query: z.object({ unitId: z.uuid(), q: z.string().max(100).optional(), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
    listContacts,
  );

  router.post(
    '/contacts',
    describe({
      summary: 'Create a contact',
      description: 'De-duplicates on phone and email within the company. Emits `contact.created`.',
      permission: 'contacts.manage',
      status: 201,
      errors: [409],
      responses: { 201: contactSchema },
    }),
    requireAuth(),
    validate({ body: createContactBody }),
    createContact,
  );

  router.get('/contacts/:id', describe({ summary: 'Get a contact', permission: 'contacts.view', responses: { 200: contactSchema } }), requireAuth(), validate({ params: idParams }), getContact);
}
```

Conventions:

1. Every route has `describe({ summary })`. The app test fails on a route without one.
2. Name the permission the handler checks. If the handler checks one of several, pass an array.
3. Declare the success status (`201`, `204`) and `list: true` for cursor pages, so clients see the right envelope.
4. Give response schemas for new endpoints. Reuse the zod schema your presenter's output matches; put `.meta({ id })` on shapes used by several endpoints.
5. Public routes say `auth: 'public'` and rate-limited ones `rateLimited: true`.
6. Internal or test-only routes: `hidden: true`.
7. Keep routes on the router you're given; don't mount sub-routers (they aren't recorded).

Phase 1 routes keep their descriptions in `core/openapi/phase1.js` so their module files stayed untouched. When you next edit a phase 1 route, you may move its entry into an inline `describe()` (the inline one wins field by field) and delete the catalogue entry, so there is one source. If a route is removed, the app test reports its leftover catalogue entry.

## 5. Limits and next steps

- Phase 1 responses are documented as `{ data: any }` except where a small schema was cheap to write (auth, sessions, settings writes, health). Adding presenter schemas (`presentUnit`, `presentUser`, `presentRole`, audit entries) with `.meta({ id })` would make the generated clients fully typed.
- `router.use()` sub-routers and RegExp paths aren't documented (a warning says so).
- `/health` outside `/api/v1` (for load balancers) isn't in the document; the same handler is, at `/api/v1/health`.
- The document is cached per process; it changes only on deploy.
- No new dependencies. A full OpenAPI validator (for example `@seriousme/openapi-schema-validator`) in CI would add checks beyond `lintSpec`.
