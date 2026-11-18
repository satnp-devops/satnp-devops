import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { bumpAccessVersion } from '../core/access.js';
import { syncSystemRoles } from '../core/systemRoles.js';
import { buildRegistry } from '../registry.js';

// Update the built-in roles after installing or upgrading modules.
try {
  await syncSystemRoles(db, buildRegistry());
  await bumpAccessVersion();
  console.log('Built-in roles are in sync with the installed modules.');
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await db.destroy();
  redis.disconnect();
}
