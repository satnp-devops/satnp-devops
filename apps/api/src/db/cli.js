import { env } from '../config/env.js';
import { db } from '../lib/db.js';

// Usage: node src/db/cli.js <migrate|rollback|seed|reset> [--all]

async function bumpAccessCache() {
  // Roles or assignments may have changed underneath a running API.
  const { redis } = await import('../lib/redis.js');
  try {
    await redis.incr('access:ver');
  } catch {
    // Redis isn't required for database commands.
  } finally {
    redis.disconnect();
  }
}

const command = process.argv[2];
try {
  switch (command) {
    case 'migrate': {
      const [, applied] = await db.migrate.latest();
      console.log(applied.length ? `Applied ${applied.length} migration(s):\n  ${applied.join('\n  ')}` : 'Database is up to date.');
      break;
    }
    case 'rollback': {
      const all = process.argv.includes('--all');
      const [, rolledBack] = await db.migrate.rollback(undefined, all);
      console.log(rolledBack.length ? `Rolled back ${rolledBack.length} migration(s).` : 'Nothing to roll back.');
      break;
    }
    case 'seed': {
      await db.seed.run();
      await bumpAccessCache();
      break;
    }
    case 'reset': {
      if (env.isProd) throw new Error('Refusing to reset a production database.');
      await db.migrate.rollback(undefined, true);
      await db.migrate.latest();
      await db.seed.run();
      await bumpAccessCache();
      console.log('Database reset and seeded.');
      break;
    }
    default:
      console.error('Usage: node src/db/cli.js <migrate|rollback|seed|reset> [--all]');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
