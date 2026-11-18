import { db } from '../lib/db.js';
import { archiveTimeline, countArchivable, parseArchiveArgs } from '../modules/timeline/archive.js';

// Move old timeline entries to timeline_events_archive, in batches. Safe to run while the app is in
// use and to run again after an interruption. Reads with includeArchive=true still show them.
//   npm run timeline:archive -w @phoenix/api -- --before 2025-01-01
//   npm run timeline:archive -w @phoenix/api -- --before 2025-01-01 --batch 2000 --group <uuid>
//   npm run timeline:archive -w @phoenix/api -- --before 2025-01-01 --dry-run

try {
  const options = parseArchiveArgs(process.argv.slice(2));
  const cutoff = options.before.toISOString();
  if (options.dryRun) {
    console.log(`${await countArchivable(db, options)} entries from before ${cutoff} would move to the archive.`);
  } else {
    const started = Date.now();
    const total = await archiveTimeline(db, {
      ...options,
      onBatch: ({ moved, total: soFar }) => console.log(`Moved ${moved} (${soFar} so far)`),
    });
    console.log(`Archived ${total} timeline entries from before ${cutoff} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
