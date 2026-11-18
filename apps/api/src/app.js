import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestContext } from './middleware/requestContext.js';
import { csrfGuard } from './middleware/csrf.js';
import { loadSession } from './middleware/session.js';
import { apiKeyAuth } from './modules/integrations/apiKeys/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthCheck } from './modules/system/module.js';
import { createRouteCollector } from './core/openapi/collector.js';
import { openapiRoutes } from './core/openapi/http.js';
import { webhookIngressRoutes } from './modules/webhooks/ingress.js';

export function createApp({ registry, modules }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);
  app.locals.registry = registry;

  app.use(helmet());
  app.use(requestContext);
  // Provider webhooks need the exact bytes for their signatures: keep the raw body (a Buffer) there.
  app.use('/api/v1/webhooks', express.raw({ type: () => true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', healthCheck);

  const collector = createRouteCollector();
  // Phase 3: POST /api/v1/webhooks/:provider/:connectionId, before (outside) the session, CSRF and
  // API-key chain: the provider's signature is the authentication (docs/platform/WEBHOOKS_AND_JOBS.md).
  const hooks = express.Router();
  webhookIngressRoutes(collector.wrap(hooks, 'webhooks'));
  app.use('/api/v1', hooks);

  const api = express.Router();
  api.use(csrfGuard);
  api.use(loadSession);
  // Phase 3: Authorization: Bearer phx_... API keys (replaces the cookie session for that request).
  api.use(apiKeyAuth);
  // Each module gets a recording wrapper around the router, so GET /api/v1/openapi.json
  // documents exactly the routes that are registered (see core/openapi/collector.js).
  for (const mod of modules) mod.routes?.(collector.wrap(api, mod.name), { registry });
  openapiRoutes(collector.wrap(api, 'system'), {
    registry,
    routes: collector.routes,
    isProd: env.isProd,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    apiKeys: true, // phase 3: Bearer API keys (modules/integrations/apiKeys)
    log: logger,
  });
  app.locals.routes = collector.routes;
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
