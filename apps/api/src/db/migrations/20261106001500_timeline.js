// Timeline slice additions to the phase 2 schema (docs/crm/PHASE2_CONTRACT.md §5.10).
//
// Pinned entries: GET /timeline?pinned=true and the "at most 5 pinned" check would otherwise walk
// every entry of a subject (tens of thousands on a busy deal) to find a handful. These partial
// indexes hold only pinned, non-deleted rows, so they stay tiny.

const SUBJECTS = ['deal', 'contact', 'account'];

export async function up(knex) {
  for (const subject of SUBJECTS) {
    await knex.raw(
      `create index timeline_events_${subject}_pinned_idx on timeline_events (${subject}_id, occurred_at desc, id desc)
         where ${subject}_id is not null and pinned_at is not null and deleted_at is null`,
    );
  }
}

export async function down(knex) {
  for (const subject of SUBJECTS) await knex.raw(`drop index if exists timeline_events_${subject}_pinned_idx`);
}
