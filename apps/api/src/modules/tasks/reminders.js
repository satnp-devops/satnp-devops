import { emitEvent } from '../../core/events.js';

// Task reminders (docs/crm/PHASE2_CONTRACT.md §9.9): open tasks whose reminder time has come get
// reminder_sent_at and one task.reminder_due event each. Uses tasks_reminder_idx and
// "for update skip locked", so several workers can run it at once without sending twice.
// Notifications consume the event in a later phase; schedule this like the SLA sweep.

/**
 * @param {{ db: import('knex').Knex, now?: Date, limit?: number }} options
 * @returns {Promise<number>} reminders marked as sent
 */
export async function processDueTaskReminders({ db, now = new Date(), limit = 500 }) {
  return db.transaction(async (trx) => {
    const rows = await trx('tasks')
      .where('status', 'open')
      .whereNotNull('reminder_at')
      .whereNull('reminder_sent_at')
      .where('reminder_at', '<=', now)
      .orderBy('reminder_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .select('id', 'group_id', 'unit_id', 'assignee_user_id', 'due_at');
    if (rows.length === 0) return 0;
    await trx('tasks')
      .whereIn(
        'id',
        rows.map((row) => row.id),
      )
      .update({ reminder_sent_at: now });
    for (const row of rows) {
      await emitEvent(trx, {
        type: 'task.reminder_due',
        groupId: row.group_id,
        unitId: row.unit_id,
        aggregateType: 'task',
        aggregateId: row.id,
        payload: {
          taskId: row.id,
          assigneeUserId: row.assignee_user_id ?? null,
          dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
        },
      });
    }
    return rows.length;
  });
}
