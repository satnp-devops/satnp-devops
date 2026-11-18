import { db as defaultDb, json } from '../../lib/db.js';
import { emitEvent } from '../../core/events.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { formatMoney } from '../../core/crm/money.js';
import { daysBetween, localDate } from '../../core/billing/dates.js';
import { dueReminders, scoreChurnRisk, upsellFlags } from './churn.js';
import { expireCheckoutSessions } from './checkout.js';
import { resumeEnrollment } from './service.js';
import { churnHighScoreSetting, churnInactiveDaysSetting, churnMediumScoreSetting, deliverySettings, renewalReminderDaysSetting } from './settings.js';

// Job processors of the delivery module (docs/delivery/DELIVERY.md §10). The jobs platform
// (another module) schedules them; each is safe to run again and on several workers, and works
// through the data in batches with a few set-based queries per batch (no per-row lookups).
//
//   deliveryJobs = [{ name, every, run }]  → the integrator registers each as a repeatable job.

const BATCH = 200;

async function inSequence(thunks) {
  const out = [];
  for (const thunk of thunks) out.push(await thunk());
  return out;
}
const ACTIVITY_KINDS = ['call', 'message', 'email', 'meeting', 'note'];

async function companySettings(trx, companyIds, definitions) {
  const units = companyIds.length ? await trx('org_units').whereIn('id', companyIds) : [];
  const out = new Map();
  for (const unit of units) out.set(unit.id, await deliverySettings(unit, definitions, trx));
  return out;
}

/**
 * Send the renewal reminders that are due (90/60/30/7 days before by default, the
 * onboarding.renewalReminderDays setting): one renewal.reminder_due event and one timeline entry
 * per reminder, never twice for the same term (renewals.reminders_sent, plus the timeline's
 * source id). Automations (messaging) and the owner's tasks hang off the event.
 * @returns {Promise<{ checked: number, sent: number }>}
 */
export async function runRenewalReminders({ db = defaultDb, now = new Date(), log } = {}) {
  const today = localDate(now.getTime());
  let checked = 0;
  let sent = 0;
  let after = null;
  for (;;) {
    const sentNow = await db.transaction(async (trx) => {
      const rows = await trx('renewals')
        .where('status', 'active')
        .where('term_end', '>=', today)
        .whereRaw('term_end <= ?::date + 120', [today])
        .modify((q) => {
          if (after) q.where('id', '>', after);
        })
        .orderBy('id')
        .limit(BATCH)
        .forUpdate()
        .skipLocked();
      if (rows.length === 0) return null;
      after = rows[rows.length - 1].id;
      checked += rows.length;
      const settings = await companySettings(trx, [...new Set(rows.map((r) => r.company_id))], [renewalReminderDaysSetting]);
      let count = 0;
      for (const row of rows) {
        const offsets = settings.get(row.company_id)?.[renewalReminderDaysSetting.key] ?? [];
        const daysToRenewal = daysBetween(today, row.term_end);
        const already = row.reminder_term_end === row.term_end ? row.reminders_sent : [];
        const { send, markSent } = dueReminders({ daysToRenewal, offsets, sent: already });
        if (markSent.length === 0) continue;
        await trx('renewals')
          .where({ id: row.id })
          .update({ reminders_sent: [...new Set([...already, ...markSent])].sort((a, b) => b - a), reminder_term_end: row.term_end, updated_at: trx.fn.now() });
        if (send === null) continue;
        count += 1;
        const payload = {
          renewalId: row.id,
          companyId: row.company_id,
          subscriptionId: row.subscription_id,
          accountId: row.account_id,
          contactId: row.contact_id,
          dealId: row.deal_id,
          ownerUserId: row.owner_user_id,
          termEnd: row.term_end,
          daysBefore: send,
          daysToRenewal,
          autoRenew: row.auto_renew,
          amountMinor: Number(row.amount_minor),
          currency: row.currency,
          churnLevel: row.churn_level,
        };
        await emitEvent(trx, { type: 'renewal.reminder_due', groupId: row.group_id, unitId: row.unit_id, aggregateType: 'renewal', aggregateId: row.id, payload });
        if (row.account_id || row.contact_id) {
          await addTimelineEvent(trx, {
            groupId: row.group_id,
            companyId: row.company_id,
            unitId: row.unit_id,
            accountId: row.account_id,
            contactId: row.account_id ? null : row.contact_id,
            kind: 'system',
            title: `Renews in ${daysToRenewal} days (${row.term_end}, ${formatMoney(Number(row.amount_minor), row.currency)}${row.auto_renew ? ', auto-renew' : ''})`,
            meta: { action: 'renewal.reminder_due', renewalId: row.id, daysBefore: send, termEnd: row.term_end },
            actorType: 'system',
            sourceEventId: `renewal:${row.id}:${row.term_end}:${send}`,
            touchDeal: false,
          });
        }
      }
      return count;
    });
    if (sentNow === null) break;
    sent += sentNow;
  }
  log?.info?.({ checked, sent }, 'Renewal reminders');
  return { checked, sent };
}

/**
 * Gather churn signals for a batch of renewals in a few grouped queries.
 * @returns {Promise<Map<string, object>>} renewal id → signals for scoreChurnRisk
 */
export async function gatherSignals(trx, rows, now = new Date()) {
  const accountIds = [...new Set(rows.map((r) => r.account_id).filter(Boolean))];
  const contactIds = [...new Set(rows.filter((r) => !r.account_id).map((r) => r.contact_id).filter(Boolean))];
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const sixMonthsAgo = new Date(now.getTime() - 183 * 86_400_000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
  const today = localDate(now.getTime());
  const key = (companyId, subjectId) => `${companyId}:${subjectId}`;

  // One connection inside a transaction: the queries run one after another.
  const [activityA, activityC, tasks, lost, open, projects, withdrawn, accounts, owned, offered] = await inSequence([
    () => accountIds.length
      ? trx('timeline_events').whereIn('account_id', accountIds).whereIn('company_id', companyIds).whereIn('kind', ACTIVITY_KINDS).groupBy('company_id', 'account_id').select('company_id', 'account_id as subject_id', trx.raw('max(occurred_at) as last_at'))
      : [],
    () => contactIds.length
      ? trx('timeline_events').whereIn('contact_id', contactIds).whereIn('company_id', companyIds).whereIn('kind', ACTIVITY_KINDS).groupBy('company_id', 'contact_id').select('company_id', 'contact_id as subject_id', trx.raw('max(occurred_at) as last_at'))
      : [],
    () => accountIds.length
      ? trx('tasks').whereIn('account_id', accountIds).whereIn('company_id', companyIds).where('status', 'open').where('due_at', '<', now).groupBy('company_id', 'account_id').select('company_id', 'account_id as subject_id', trx.raw('count(*)::int as n'))
      : [],
    () => accountIds.length
      ? trx('deals').whereIn('account_id', accountIds).whereIn('company_id', companyIds).where('status', 'lost').where('closed_at', '>=', sixMonthsAgo).groupBy('company_id', 'account_id').select('company_id', 'account_id as subject_id', trx.raw('count(*)::int as n'))
      : [],
    () => accountIds.length
      ? trx('deals').whereIn('account_id', accountIds).whereIn('company_id', companyIds).where('status', 'open').whereNull('archived_at').groupBy('company_id', 'account_id').select('company_id', 'account_id as subject_id', trx.raw('count(*)::int as n'))
      : [],
    () => accountIds.length
      ? trx('implementation_projects').whereIn('account_id', accountIds).whereIn('company_id', companyIds).distinctOn('company_id', 'account_id').orderBy([{ column: 'company_id' }, { column: 'account_id' }, { column: 'created_at', order: 'desc' }]).select('company_id', 'account_id as subject_id', 'status', 'target_go_live_on')
      : [],
    () => accountIds.length
      ? trx('account_contacts as ac')
          .join('consents as c', 'c.contact_id', 'ac.contact_id')
          .whereIn('ac.account_id', accountIds)
          .where('c.status', 'withdrawn')
          .where('c.captured_at', '>=', ninetyDaysAgo)
          .select('ac.account_id as subject_id', 'c.company_id')
      : [],
    () => accountIds.length ? trx('accounts').whereIn('id', accountIds).select('id', 'student_count') : [],
    () => accountIds.length
      ? trx('renewals').whereIn('account_id', accountIds).whereIn('company_id', companyIds).where('status', 'active').whereNotNull('product_line_id').select('company_id', 'account_id as subject_id', 'product_line_id')
      : [],
    () => trx('product_lines').whereIn('company_id', companyIds).where({ audience: 'b2b', active: true }).orderBy('position').select('id', 'company_id', 'name'),
  ]);

  const lastAt = new Map([...activityA, ...activityC].map((r) => [key(r.company_id, r.subject_id), r.last_at]));
  const countMap = (list) => new Map(list.map((r) => [key(r.company_id, r.subject_id), r.n]));
  const overdue = countMap(tasks);
  const lostMap = countMap(lost);
  const openMap = countMap(open);
  const projectMap = new Map(projects.map((r) => [key(r.company_id, r.subject_id), r]));
  const withdrawnSet = new Set();
  for (const r of withdrawn) for (const companyId of r.company_id ? [r.company_id] : companyIds) withdrawnSet.add(key(companyId, r.subject_id));
  const studentCounts = new Map(accounts.map((a) => [a.id, a.student_count]));
  const ownedMap = new Map();
  for (const r of owned) {
    const k = key(r.company_id, r.subject_id);
    if (!ownedMap.has(k)) ownedMap.set(k, new Set());
    ownedMap.get(k).add(r.product_line_id);
  }

  const out = new Map();
  for (const row of rows) {
    const subject = row.account_id ?? row.contact_id;
    const k = key(row.company_id, subject);
    const last = lastAt.get(k);
    const project = projectMap.get(k);
    out.set(row.id, {
      signals: {
        daysSinceActivity: last ? Math.max(0, Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000)) : null,
        overdueTasks: overdue.get(k) ?? 0,
        recentLostDeals: lostMap.get(k) ?? 0,
        implementation: project ? { status: project.status, overdue: Boolean(project.target_go_live_on && project.target_go_live_on < today) } : null,
        consentWithdrawn: withdrawnSet.has(k),
        daysToRenewal: daysBetween(today, row.term_end),
        autoRenew: row.auto_renew,
        openDeals: openMap.get(k) ?? 0,
      },
      upsell: row.account_id
        ? upsellFlags({
            seats: row.seats,
            studentCount: studentCounts.get(row.account_id) ?? null,
            ownedLineIds: [...(ownedMap.get(k) ?? [])],
            offeredLines: offered.filter((l) => l.company_id === row.company_id),
          })
        : [],
    });
  }
  return out;
}

/**
 * Re-score churn risk and upsell flags for every active renewal (nightly). Emits
 * renewal.churn_risk_changed when a renewal's level changes, so automations can alert its owner.
 * @returns {Promise<{ scored: number, changed: number }>}
 */
export async function runChurnScoring({ db = defaultDb, now = new Date(), companyId = null, log } = {}) {
  let scored = 0;
  let changed = 0;
  let after = null;
  for (;;) {
    const done = await db.transaction(async (trx) => {
      const rows = await trx('renewals')
        .where('status', 'active')
        .modify((q) => {
          if (companyId) q.where('company_id', companyId);
          if (after) q.where('id', '>', after);
        })
        .orderBy('id')
        .limit(BATCH)
        .forUpdate()
        .skipLocked();
      if (rows.length === 0) return true;
      after = rows[rows.length - 1].id;
      const settings = await companySettings(trx, [...new Set(rows.map((r) => r.company_id))], [churnInactiveDaysSetting, churnMediumScoreSetting, churnHighScoreSetting]);
      const signals = await gatherSignals(trx, rows, now);
      for (const row of rows) {
        const s = settings.get(row.company_id);
        const rules = { inactiveDays: s[churnInactiveDaysSetting.key], mediumScore: s[churnMediumScoreSetting.key], highScore: s[churnHighScoreSetting.key] };
        const { signals: input, upsell } = signals.get(row.id);
        const result = scoreChurnRisk(input, rules);
        await trx('renewals')
          .where({ id: row.id })
          .update({ churn_score: result.score, churn_level: result.level, churn_signals: json(result.signals), upsell_flags: json(upsell), scored_at: now, updated_at: trx.fn.now() });
        scored += 1;
        if (result.level !== row.churn_level) {
          changed += 1;
          await emitEvent(trx, {
            type: 'renewal.churn_risk_changed',
            groupId: row.group_id,
            unitId: row.unit_id,
            aggregateType: 'renewal',
            aggregateId: row.id,
            payload: { renewalId: row.id, companyId: row.company_id, accountId: row.account_id, ownerUserId: row.owner_user_id, from: row.churn_level, to: result.level, score: result.score, termEnd: row.term_end },
          });
        }
      }
      return false;
    });
    if (done) break;
  }
  log?.info?.({ scored, changed }, 'Churn scoring');
  return { scored, changed };
}

/** Resume paused enrollments whose resume date has come (daily). */
export async function runEnrollmentResumes({ db = defaultDb, now = new Date(), log } = {}) {
  const today = localDate(now.getTime());
  let resumed = 0;
  for (;;) {
    const n = await db.transaction(async (trx) => {
      const rows = await trx('enrollments').where('status', 'paused').where('resume_on', '<=', today).orderBy('id').limit(BATCH).forUpdate().skipLocked();
      for (const row of rows) await resumeEnrollment(trx, {}, row);
      return rows.length;
    });
    resumed += n;
    if (n < BATCH) break;
  }
  log?.info?.({ resumed }, 'Enrollment resumes');
  return { resumed };
}

export async function runCheckoutExpiry({ db = defaultDb, now = new Date() } = {}) {
  return expireCheckoutSessions({ now, trx: db });
}

/** For the jobs platform: register each as a repeatable job (cron in Asia/Kolkata). */
export const deliveryJobs = [
  { name: 'delivery.renewal_reminders', cron: '30 8 * * *', run: runRenewalReminders },
  { name: 'delivery.churn_scoring', cron: '0 3 * * *', run: runChurnScoring },
  { name: 'delivery.enrollment_resumes', cron: '15 6 * * *', run: runEnrollmentResumes },
  { name: 'delivery.checkout_expiry', cron: '*/10 * * * *', run: runCheckoutExpiry },
];
