/**
 * Makes `node --test test/automation/` work: Node 24 loads a directory argument as a
 * module (this file) instead of searching it for tests, so this file imports the
 * folder's *.test.js files. Under `npm test` every file already runs on its own, and
 * this file is the entry point by name, so it does nothing then.
 */
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const folder = fileURLToPath(new URL('.', import.meta.url));
if (basename(process.argv[1] ?? '') !== 'index.js') {
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.test.js')).sort()) {
    await import(pathToFileURL(folder + file).href);
  }
}
