import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `node --test test/providers/exotel/` hands Node the directory, which loads this index.js; it
// then imports every *.test.js here. Under `npm test` each *.test.js file already runs on its own
// (and this file is entered by its own path), so nothing is imported twice.
const self = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] ?? '') !== self) {
  const files = readdirSync(path.dirname(self)).filter((f) => f.endsWith('.test.js')).sort();
  for (const file of files) await import(new URL(file, import.meta.url).href);
}
