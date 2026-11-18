/**
 * Lets `node --test test/providers/msg91/` work: Node 24 treats a directory argument as a module
 * path and resolves it to this index.js. In that case (argv[1] is the directory) every MSG91 test
 * file is loaded here. When the default glob of `npm test` runs this file directly (argv[1] ends
 * in index.js), it does nothing, so no test runs twice.
 */
import { basename } from 'node:path';

if (basename(process.argv[1] ?? '') !== 'index.js') {
  await import('./client.test.js');
  await import('./dlt.test.js');
  await import('./webhook.test.js');
}
