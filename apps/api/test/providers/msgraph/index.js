// Lets `node --test test/providers/msgraph/` run this folder: Node resolves a directory argument to
// its index.js. Under the default `npm test` glob this file runs as a plain file and does nothing,
// so no test runs twice.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (entry === here && statSync(entry, { throwIfNoEntry: false })?.isDirectory()) {
  for (const file of readdirSync(here).filter((f) => f.endsWith('.test.js')).sort()) {
    await import(pathToFileURL(path.join(here, file)).href);
  }
}
