import { requireAuth } from '../guards.js';
import { describe } from './describe.js';
import { buildSpec } from './spec.js';
import { PHASE1_DESCRIPTIONS } from './phase1.js';

/**
 * GET /api/v1/openapi.json
 *
 * Who can read it: signed-in users in production; anyone in development and test, so local
 * tools (Postman, code generators, Swagger Editor) can load it without a cookie. The document
 * lists routes and input shapes, never data, but in production it stays behind sign-in so the
 * full API surface isn't handed to strangers. Staging servers reachable from the internet
 * should run with NODE_ENV=production.
 *
 * The document is built on the first request and cached: routes don't change while the
 * process runs.
 *
 * @param {import('express').Router} router the (wrapped) /api/v1 router
 * @param {{
 *   registry: Parameters<typeof buildSpec>[0],
 *   routes: import('./collector.js').CollectedRoute[],
 *   isProd: boolean,
 *   version?: string,
 *   sessionCookieName?: string,
 *   apiKeys?: boolean,
 *   log?: { warn: (obj: object, msg: string) => void },
 * }} options
 */
export function openapiRoutes(router, { registry, routes, isProd, version, sessionCookieName, apiKeys = false, log }) {
  let cached = null;
  const spec = () => {
    if (!cached) {
      const warnings = [];
      cached = buildSpec(registry, routes, {
        version,
        sessionCookieName,
        apiKeys,
        descriptions: PHASE1_DESCRIPTIONS,
        onWarning: (message) => warnings.push(message),
      });
      if (warnings.length > 0) log?.warn({ warnings }, 'OpenAPI document built with warnings');
    }
    return cached;
  };

  const access = isProd ? [requireAuth()] : [];
  router.get(
    '/openapi.json',
    describe({
      summary: 'Get this OpenAPI document',
      description: isProd
        ? 'The OpenAPI 3.1 description of every endpoint. Signed-in users only.'
        : 'The OpenAPI 3.1 description of every endpoint. Open to everyone outside production.',
      auth: isProd ? 'session' : 'public',
      responses: { 200: { raw: true, description: 'An OpenAPI 3.1 document.' } },
    }),
    ...access,
    (_req, res) => {
      res.set('Cache-Control', 'private, no-cache');
      res.json(spec());
    },
  );
  return { spec };
}
