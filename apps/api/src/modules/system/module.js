import { db } from '../../lib/db.js';
import { redis } from '../../lib/redis.js';
import { requireAuth } from '../../core/guards.js';
import { permissionCatalog } from '../../core/registry.js';

const VERSION = '0.1.0';

export async function healthCheck(_req, res) {
  const checks = { database: 'ok', redis: 'ok' };
  try {
    await db.raw('select 1');
  } catch {
    checks.database = 'down';
  }
  try {
    await redis.ping();
  } catch {
    checks.redis = 'down';
  }
  const healthy = Object.values(checks).every((value) => value === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', version: VERSION, checks });
}

export default {
  name: 'system',
  label: 'System',
  routes(router) {
    router.get('/health', healthCheck);

    router.get('/meta', requireAuth(), (req, res) => {
      const { registry } = req.app.locals;
      res.json({
        data: {
          version: VERSION,
          modules: registry.modules,
          unitTypes: [...registry.unitTypes.keys()],
          permissions: permissionCatalog(registry),
        },
      });
    });
  },
};
