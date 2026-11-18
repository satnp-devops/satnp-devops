import { parseArgs } from 'node:util';
import { db } from '../lib/db.js';
import { SEARCH_ENTITY_TYPES } from '../core/crm/constants.js';
import { reindexSearch } from '../core/crm/search.js';

// Rebuild the global search index from the CRM tables, in id order and batches. Safe to run while
// the app is in use: every batch is an upsert of fresh documents plus removal of ones that should no
// longer be searchable (archived deals, merged or erased people); documents whose record is gone
// entirely are pruned at the end.
//   npm run search:reindex -w @phoenix/api                        every deal, contact and institute
//   npm run search:reindex -w @phoenix/api -- --type deals        one kind (deal(s), contact(s), account(s) or institute(s))
//   npm run search:reindex -w @phoenix/api -- --group <uuid>      one group
//   npm run search:reindex -w @phoenix/api -- --batch-size 2000   rows per batch (default 1000)

const ALIASES = {
  deal: 'deal',
  deals: 'deal',
  lead: 'deal',
  leads: 'deal',
  contact: 'contact',
  contacts: 'contact',
  account: 'account',
  accounts: 'account',
  institute: 'account',
  institutes: 'account',
};

const { values } = parseArgs({
  options: {
    type: { type: 'string', multiple: true },
    entity: { type: 'string', multiple: true },
    group: { type: 'string' },
    'batch-size': { type: 'string' },
    quiet: { type: 'boolean' },
  },
});

const requested = [...(values.type ?? []), ...(values.entity ?? [])].flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase());
const unknown = requested.filter((value) => !ALIASES[value]);
if (unknown.length) {
  console.error(`Unknown type: ${unknown.join(', ')}. Use ${SEARCH_ENTITY_TYPES.map((type) => `${type}s`).join(', ')}.`);
  process.exit(1);
}
const entityTypes = requested.length ? [...new Set(requested.map((value) => ALIASES[value]))] : SEARCH_ENTITY_TYPES;

const batchSize = Number(values['batch-size'] ?? 1000);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
  console.error('--batch-size must be a whole number from 1 to 10000.');
  process.exit(1);
}
if (values.group && !/^[0-9a-f-]{36}$/i.test(values.group)) {
  console.error('--group must be a group id (uuid).');
  process.exit(1);
}

const started = Date.now();
const progress = {};
try {
  const totals = await reindexSearch(db, {
    entityTypes,
    groupId: values.group,
    batchSize,
    prune: true,
    onBatch: ({ entityType, upserted, removed, pruned }) => {
      const seen = (progress[entityType] ??= { upserted: 0, removed: 0 });
      seen.upserted += upserted;
      seen.removed += removed;
      if (values.quiet || (pruned && removed === 0)) return;
      console.log(pruned ? `${entityType}s: ${removed} orphaned documents removed` : `${entityType}s: ${seen.upserted} indexed, ${seen.removed} removed so far`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const summary = Object.entries(totals)
    .map(([type, n]) => `${n} ${type}s (${progress[type]?.removed ?? 0} removed)`)
    .join(', ');
  console.log(`Search index rebuilt in ${seconds} s: ${summary}.`);
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
