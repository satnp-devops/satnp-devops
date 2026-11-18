// Deals slice demo data on top of 02_crm.js (docs/crm/PHASE2_CONTRACT.md §14).
//
// The Leads list highlights a lead as "New" while it is open, less than 7 days old and its owner
// hasn't opened it (deals.owner_seen_at, migration 20261106001400_deals.js). The phase 2 seed
// doesn't know that column, so every recent demo lead would look unopened. Here, a lead counts as
// seen by its owner when the owner has already worked it: replied to the enquiry or moved it past
// the stage it was created in. Recent leads nobody has touched stay "New".
//
// Idempotent: only leads without owner_seen_at are touched, and running it again changes nothing.

const GROUP_CODE = 'phoenix';

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first('id');
  if (!group) return;

  await knex.raw(
    `update deals d
        set owner_seen_at = coalesce(d.first_replied_at, moved.first_move_at, d.updated_at)
       from (
         select d2.id,
                (select min(h.moved_at) from deal_stage_history h
                  where h.deal_id = d2.id and h.from_stage_id is not null) as first_move_at
           from deals d2
          where d2.group_id = ?
            and d2.owner_seen_at is null
            and d2.owner_user_id is not null
       ) moved
      where d.id = moved.id
        and (d.first_replied_at is not null or moved.first_move_at is not null)`,
    [group.id],
  );
}
