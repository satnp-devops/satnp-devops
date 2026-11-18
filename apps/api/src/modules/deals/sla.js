import { emitEvent } from '../../core/events.js';

// SLAs of a lead (docs/crm/PHASE2_CONTRACT.md §12.2). Calendar time, everything in UTC.
//
//   stage SLA    sla_due_at = stage_entered_at + stage.sla_hours while the deal is open
//   first reply  first_reply_due_at = created_at + deals.firstReplySlaMinutes (channels with firstReplySla)
//
// "Breached" is computed live from the due times; sla_breached_at and first_reply_breached_at only
// make the sweep's events happen once. "Due soon" means less than a quarter of the window is left
// (the web turns amber then, red once it's overdue).

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Due soon: less than this share of the SLA window left. */
export const DUE_SOON_FRACTION = 0.25;

const toTime = (value) => {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * The state of one deadline.
 *   none      no deadline
 *   met       done before the deadline       missed   done after it
 *   ok        running, plenty of time left   due_soon less than a quarter of the window left
 *   breached  running and past the deadline
 */
export function deadlineState({ startedAt, dueAt, completedAt = null, now = new Date() }) {
  const due = toTime(dueAt);
  if (due === null) return 'none';
  const done = toTime(completedAt);
  if (done !== null) return done <= due ? 'met' : 'missed';
  const current = toTime(now);
  if (current >= due) return 'breached';
  const start = toTime(startedAt);
  const window = start === null ? 0 : due - start;
  return window > 0 && due - current <= window * DUE_SOON_FRACTION ? 'due_soon' : 'ok';
}

/**
 * Everything about a deal's SLAs, in one pure function. Call it when a deal is created or enters
 * a stage (it gives the due times to store) and when presenting it (it gives the flags).
 * Pass the stored due times (slaDueAt, firstReplyDueAt) for an existing deal: a setting or a
 * stage's sla_hours changing later doesn't move a target already set.
 *
 * @param {{
 *   status: 'open' | 'won' | 'lost',
 *   stageEnteredAt: Date | string,
 *   slaHours?: number | null,                 // of the current stage, to compute slaDueAt
 *   slaDueAt?: Date | string | null,          // or the stored value
 *   createdAt: Date | string,
 *   firstReplySlaMinutes?: number | null,     // the setting, to compute firstReplyDueAt
 *   channelHasFirstReplySla?: boolean,
 *   firstReplyDueAt?: Date | string | null,   // or the stored value
 *   firstRepliedAt?: Date | string | null,
 *   now?: Date,
 * }} input
 */
export function computeSla({
  status,
  stageEnteredAt,
  slaHours = null,
  slaDueAt,
  createdAt,
  firstReplySlaMinutes = null,
  channelHasFirstReplySla = false,
  firstReplyDueAt,
  firstRepliedAt = null,
  now = new Date(),
}) {
  const open = status === 'open';
  const asDate = (value) => (toTime(value) === null ? null : new Date(toTime(value)));

  const entered = toTime(stageEnteredAt);
  let stageDue = null;
  if (open) {
    if (slaDueAt !== undefined) stageDue = asDate(slaDueAt);
    else if (entered !== null && Number(slaHours) > 0) stageDue = new Date(entered + Number(slaHours) * HOUR);
  }
  const slaState = open ? deadlineState({ startedAt: stageEnteredAt, dueAt: stageDue, now }) : 'none';

  const created = toTime(createdAt);
  let replyDue = null;
  if (firstReplyDueAt !== undefined) replyDue = asDate(firstReplyDueAt);
  else if (channelHasFirstReplySla && created !== null && Number(firstReplySlaMinutes) > 0) {
    replyDue = new Date(created + Number(firstReplySlaMinutes) * MINUTE);
  }
  const replyState = deadlineState({ startedAt: createdAt, dueAt: replyDue, completedAt: firstRepliedAt, now });
  // A closed deal stops waiting for its first reply.
  const running = replyState === 'ok' || replyState === 'due_soon' || replyState === 'breached';
  const firstReplyState = !open && running ? 'none' : replyState;

  return {
    slaDueAt: stageDue,
    slaState,
    slaBreached: slaState === 'breached',
    slaDueSoon: slaState === 'due_soon',
    firstReplyDueAt: replyDue,
    firstReplyState,
    firstReplyOverdue: firstReplyState === 'breached',
    firstReplyDueSoon: firstReplyState === 'due_soon',
  };
}

/** The flags for a stored deals row (list rows and details). */
export function slaFlagsOf(row, now = new Date()) {
  const sla = computeSla({
    status: row.status,
    stageEnteredAt: row.stage_entered_at,
    slaDueAt: row.sla_due_at ?? null,
    createdAt: row.created_at,
    firstReplyDueAt: row.first_reply_due_at ?? null,
    firstRepliedAt: row.first_replied_at ?? null,
    now,
  });
  return {
    slaState: sla.slaState,
    slaBreached: sla.slaBreached,
    slaDueSoon: sla.slaDueSoon,
    firstReplyState: sla.firstReplyState,
    firstReplyOverdue: sla.firstReplyOverdue,
    firstReplyDueSoon: sla.firstReplyDueSoon,
  };
}

/**
 * Flag deals that just went past a target, once, and emit an event per deal (the timeline module
 * writes the "Stage SLA missed" / "First reply overdue" entries from those events).
 * Safe to run from several workers at once (for update skip locked). Schedule it every 5 minutes.
 * @returns {Promise<{ stage: number, firstReply: number }>}
 */
export async function sweepSlaBreaches({ db, now = new Date(), limit = 500 }) {
  return db.transaction(async (trx) => {
    const stage = await trx('deals')
      .where('status', 'open')
      .whereNull('archived_at')
      .whereNull('sla_breached_at')
      .whereNotNull('sla_due_at')
      .where('sla_due_at', '<', now)
      .orderBy('sla_due_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .select('id', 'group_id', 'company_id', 'unit_id', 'stage_id', 'sla_due_at', 'owner_user_id');
    if (stage.length) {
      await trx('deals').whereIn('id', stage.map((d) => d.id)).update({ sla_breached_at: now });
      for (const deal of stage) {
        await emitEvent(trx, {
          type: 'deal.sla_breached',
          groupId: deal.group_id,
          unitId: deal.unit_id,
          aggregateType: 'deal',
          aggregateId: deal.id,
          payload: {
            dealId: deal.id,
            companyId: deal.company_id,
            unitId: deal.unit_id,
            stageId: deal.stage_id,
            dueAt: new Date(deal.sla_due_at).toISOString(),
            ownerUserId: deal.owner_user_id ?? null,
          },
        });
      }
    }

    const reply = await trx('deals')
      .where('status', 'open')
      .whereNull('archived_at')
      .whereNull('first_replied_at')
      .whereNull('first_reply_breached_at')
      .whereNotNull('first_reply_due_at')
      .where('first_reply_due_at', '<', now)
      .orderBy('first_reply_due_at')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .select('id', 'group_id', 'company_id', 'unit_id', 'channel', 'first_reply_due_at', 'owner_user_id');
    if (reply.length) {
      await trx('deals').whereIn('id', reply.map((d) => d.id)).update({ first_reply_breached_at: now });
      for (const deal of reply) {
        await emitEvent(trx, {
          type: 'deal.first_reply_overdue',
          groupId: deal.group_id,
          unitId: deal.unit_id,
          aggregateType: 'deal',
          aggregateId: deal.id,
          payload: {
            dealId: deal.id,
            companyId: deal.company_id,
            unitId: deal.unit_id,
            channel: deal.channel,
            dueAt: new Date(deal.first_reply_due_at).toISOString(),
            ownerUserId: deal.owner_user_id ?? null,
          },
        });
      }
    }
    return { stage: stage.length, firstReply: reply.length };
  });
}
