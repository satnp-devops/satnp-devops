// Moves old timeline entries to timeline_events_archive in batches (docs/crm/PHASE2_CONTRACT.md §5.10).
// Each batch is one statement (delete … returning, then insert), so a crash loses nothing and a
// second run continues where the first stopped. Pinned entries stay in the hot table: people
// pinned them because they still matter. Ids are kept, so cursors work across both tables.

const COLUMNS = [
  'id',
  'group_id',
  'company_id',
  'unit_id',
  'deal_id',
  'contact_id',
  'account_id',
  'kind',
  'channel',
  'direction',
  'title',
  'body',
  'meta',
  'actor_type',
  'actor_user_id',
  'source_event_id',
  'occurred_at',
  'created_at',
  'edited_at',
  'pinned_at',
  'deleted_at',
];

export const DEFAULT_ARCHIVE_BATCH = 5000;

/**
 * Parse CLI arguments: --before YYYY-MM-DD (or an ISO time), --batch N, --group <uuid>, --dry-run.
 * Pure; throws an Error with a message for people on bad input.
 */
export function parseArchiveArgs(argv) {
  const options = { before: null, batchSize: DEFAULT_ARCHIVE_BATCH, groupId: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--before') options.before = value();
    else if (flag === '--batch') options.batchSize = Number(value());
    else if (flag === '--group') options.groupId = value();
    else if (flag === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.before) throw new Error('Give --before, e.g. --before 2025-01-01');
  const before = /^\d{4}-\d{2}-\d{2}$/.test(options.before) ? new Date(`${options.before}T00:00:00.000Z`) : new Date(options.before);
  if (Number.isNaN(before.getTime())) throw new Error(`--before ${options.before} is not a date`);
  if (before.getTime() > Date.now()) throw new Error('--before must be in the past');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 50_000) {
    throw new Error('--batch must be a whole number from 1 to 50000');
  }
  if (options.groupId && !/^[0-9a-f-]{36}$/i.test(options.groupId)) throw new Error('--group must be a group id');
  return { ...options, before };
}

function candidates(knex, { before, groupId }) {
  const query = knex('timeline_events').where('occurred_at', '<', before).whereNull('pinned_at');
  if (groupId) query.where('group_id', groupId);
  return query;
}

/** How many entries an archive run would move (for --dry-run). */
export async function countArchivable(knex, options) {
  const [{ count }] = await candidates(knex, options).count({ count: '*' });
  return Number(count);
}

/** Move one batch; returns how many rows moved. */
export async function archiveBatch(knex, { before, groupId = null, batchSize = DEFAULT_ARCHIVE_BATCH }) {
  const picked = candidates(knex, { before, groupId }).select('id').limit(batchSize).forUpdate().skipLocked();
  const list = COLUMNS.join(', ');
  const { rows } = await knex.raw(
    `with picked as (?),
     moved as (
       delete from timeline_events t using picked where t.id = picked.id
       returning ${COLUMNS.map((column) => `t.${column}`).join(', ')}
     ),
     inserted as (
       insert into timeline_events_archive (${list}, archived_at)
       select ${list}, now() from moved
       returning id
     )
     select count(*)::int as moved from moved`,
    [picked],
  );
  return rows[0]?.moved ?? 0;
}

/**
 * Archive every entry older than `before`, batch by batch.
 * @param {import('knex').Knex} knex
 * @param {{ before: Date, groupId?: string | null, batchSize?: number, onBatch?: (info: { moved: number, total: number }) => void }} options
 * @returns {Promise<number>} rows moved
 */
export async function archiveTimeline(knex, { before, groupId = null, batchSize = DEFAULT_ARCHIVE_BATCH, onBatch } = {}) {
  let total = 0;
  for (;;) {
    const moved = await archiveBatch(knex, { before, groupId, batchSize });
    total += moved;
    if (moved > 0) onBatch?.({ moved, total });
    if (moved < batchSize) return total;
  }
}
