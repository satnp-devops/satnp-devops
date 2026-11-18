import { env } from './config/env.js';
import { db } from './lib/db.js';
import { redis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './core/queue.js';
import { createApp } from './app.js';
import { buildRegistry } from './registry.js';
import { modules } from './modules/index.js';

const registry = buildRegistry();
const app = createApp({ registry, modules });

const server = app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, modules: registry.modules.map((m) => m.name) },
    `API listening on http://localhost:${env.API_PORT}`,
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down API');
  server.close();
  await Promise.allSettled([closeQueues(), db.destroy(), redis.quit()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
