import { db } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { addDays, daysBetween } from '../../core/billing/index.js';
import { createLink } from './payments.js';
import { notifySafely } from './ports.js';
import { companyContext, minor, money } from './util.js';

// Background job processors. The platform's jobs framework (wave 1) runs them on a schedule; until
// it lands they can be run by hand. Each is idempotent and safe to run on several workers at once
// (rows are claimed with FOR UPDATE SKIP LOCKED and marked in the same transaction), and each
// returns counts for the job log. Suggested schedules (README.md, "Jobs"):
//   money.instalmentReminders   every 30 minutes
//   money.paymentRetries        every 15 minutes
//   money.subscriptionRenewals  hourly
//   money.expiries              hourly

/** Company context (time zone, settings) per unit, cached for one job run. */
function contextCache() {
  const cache = new Map();
  return async (unitId) => {
    if (!cache.has(unitId)) {
      const unit = await db('org_units').where({ id: unitId }).first();
      cache.set(unitId, await companyContext(unit));
    }
    return cache.get(unitId);
  };
}

/**
 * Instalment reminders: before the due date (billing.reminderDaysBefore) and after it
 * (billing.overdueReminderDays), once per instalment and offset (reminder_keys). The reminder
 * carries an open payment link for the instalment, creating one when there is none.
 */
export async function instalmentRemindersJob({ now = new Date(), batchSize = 200, log = logger } = {}) {
  const contextFor = contextCache();
  const today = now.toISOString().slice(0, 10);
  // Widest window any company could configure: 30 days ahead, 60 days overdue.
  const candidates = await db('instalments as i')
    .join('deals as d', 'd.id', 'i.deal_id')
    .where('i.status', 'pending')
    .whereBetween('i.due_date', [addDays(today, -61), addDays(today, 31)])
    .orderBy('i.due_date')
    .limit(batchSize)
    .select('i.id', 'i.due_date', 'i.reminder_keys', 'd.unit_id as deal_unit_id');
  let sent = 0;
  for (const row of candidates) {
    const ctx = await contextFor(row.deal_unit_id);
    const localToday = ctx.today();
    const daysUntil = daysBetween(localToday, row.due_date);
    const before = ctx.settings['billing.reminderDaysBefore'] ?? [];
    const after = ctx.settings['billing.overdueReminderDays'] ?? [];
    const key = daysUntil >= 0 && before.includes(daysUntil) ? `before:${daysUntil}` : daysUntil < 0 && after.includes(-daysUntil) ? `after:${-daysUntil}` : null;
    if (!key || row.reminder_keys.includes(key)) continue;
    const claimed = await db.transaction(async (trx) => {
      const instalment = await trx('instalments').where({ id: row.id, status: 'pending' }).forUpdate().skipLocked().first();
      if (!instalment || instalment.reminder_keys.includes(key)) return null;
      await trx('instalments').where({ id: row.id }).update({ reminder_keys: trx.raw('array_append(reminder_keys, ?)', [key]), last_reminder_at: trx.fn.now(), updated_at: trx.fn.now() });
      const deal = await trx('deals').where({ id: instalment.deal_id }).first();
      await emitEvent(trx, {
        type: daysUntil < 0 ? 'instalment.overdue' : 'instalment.reminder_due',
        groupId: deal.group_id,
        unitId: deal.unit_id,
        aggregateType: 'instalment',
        aggregateId: instalment.id,
        payload: { instalmentId: instalment.id, planId: instalment.plan_id, dealId: deal.id, companyId: instalment.company_id, dueDate: instalment.due_date, daysUntilDue: daysUntil, amountMinor: minor(instalment.amount_minor) - minor(instalment.paid_minor), currency: instalment.currency, reminder: key },
      });
      return { instalment, deal };
    });
    if (!claimed) continue;
    const { instalment, deal } = claimed;
    let link = await db('payments').where({ instalment_id: instalment.id }).whereIn('status', ['link_sent', 'failed']).where('expires_at', '>', now).orderBy('created_at', 'desc').first('id', 'link_url');
    if (!link) {
      try {
        const id = await createLink({ dealId: deal.id, body: { purpose: 'instalment', instalmentId: instalment.id, notify: false }, actorUserId: null });
        link = await db('payments').where({ id }).first('id', 'link_url');
      } catch (err) {
        log.warn({ instalmentId: instalment.id, code: err.code }, 'money: reminder sent without a payment link');
      }
    }
    await notifySafely({
      template: daysUntil < 0 ? 'billing.instalment_overdue' : 'billing.instalment_reminder',
      companyId: instalment.company_id,
      dealId: deal.id,
      contactId: deal.primary_contact_id,
      variables: { amount: money(minor(instalment.amount_minor) - minor(instalment.paid_minor), instalment.currency), dueDate: instalment.due_date, number: instalment.number, url: link?.link_url ?? null },
      idempotencyKey: `instalment.reminder:${instalment.id}:${key}`,
    });
    sent += 1;
  }
  return { checked: candidates.length, sent };
}

/**
 * Failed-payment retry schedule (billing.paymentRetryHours, counted from the failure): remind with
 * the same link while it is open, or send a fresh link when it has expired.
 */
export async function paymentRetriesJob({ now = new Date(), batchSize = 100, log = logger } = {}) {
  const contextFor = contextCache();
  const due = await db('payments as p')
    .join('deals as d', 'd.id', 'p.deal_id')
    .where('p.status', 'failed')
    .whereNotNull('p.next_retry_at')
    .where('p.next_retry_at', '<=', now)
    .orderBy('p.next_retry_at')
    .limit(batchSize)
    .select('p.id', 'd.unit_id as deal_unit_id');
  let reminded = 0;
  let relinked = 0;
  for (const row of due) {
    const ctx = await contextFor(row.deal_unit_id);
    const schedule = ctx.settings['billing.paymentRetryHours'] ?? [];
    const claimed = await db.transaction(async (trx) => {
      const payment = await trx('payments').where({ id: row.id, status: 'failed' }).whereNotNull('next_retry_at').forUpdate().skipLocked().first();
      if (!payment) return null;
      const step = payment.failure?.reminders ?? 0;
      const nextHours = schedule[step + 1];
      const nextAt = nextHours && payment.failed_at ? new Date(new Date(payment.failed_at).getTime() + nextHours * 3_600_000) : null;
      await trx('payments')
        .where({ id: payment.id })
        .update({ next_retry_at: nextAt, failure: JSON.stringify({ ...(payment.failure ?? {}), reminders: step + 1 }), updated_at: trx.fn.now() });
      const deal = await trx('deals').where({ id: payment.deal_id }).first();
      await emitEvent(trx, {
        type: 'payment.retry_due',
        groupId: deal.group_id,
        unitId: deal.unit_id,
        aggregateType: 'payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, dealId: deal.id, companyId: payment.company_id, attempt: step + 1, amountMinor: minor(payment.amount_minor), currency: payment.currency },
      });
      return { payment, deal, step };
    });
    if (!claimed) continue;
    const { payment, deal, step } = claimed;
    const open = payment.link_url && payment.expires_at && new Date(payment.expires_at) > now;
    if (open) {
      await notifySafely({
        template: 'billing.payment_retry',
        companyId: payment.company_id,
        dealId: deal.id,
        contactId: deal.primary_contact_id,
        variables: { amount: money(payment.amount_minor, payment.currency), url: payment.link_url, description: payment.description },
        idempotencyKey: `payment.retry:${payment.id}:${step + 1}`,
      });
      reminded += 1;
      continue;
    }
    try {
      await db('payments').where({ id: payment.id, status: 'failed' }).update({ status: 'expired', next_retry_at: null, updated_at: db.fn.now() });
      await createLink({
        dealId: deal.id,
        body: { purpose: payment.purpose, quoteId: payment.quote_id ?? undefined, instalmentId: payment.instalment_id ?? undefined, subscriptionId: payment.subscription_id ?? undefined, notify: true },
        retryOf: payment,
        actorUserId: null,
      });
      relinked += 1;
    } catch (err) {
      log.warn({ paymentId: payment.id, code: err.code }, 'money: could not send a new link after a failed payment');
    }
  }
  return { checked: due.length, reminded, relinked };
}

/**
 * Subscriptions: send the renewal link billing.renewalReminderDays before the renewal date, mark
 * unpaid ones past due after it, and end the ones cancelled at period end.
 */
export async function subscriptionRenewalsJob({ now = new Date(), batchSize = 100, log = logger } = {}) {
  const contextFor = contextCache();
  const today = now.toISOString().slice(0, 10);
  const rows = await db('subscriptions as s')
    .join('deals as d', 'd.id', 's.deal_id')
    .whereIn('s.status', ['active', 'past_due'])
    .where('s.current_period_end', '<=', addDays(today, 91))
    .orderBy('s.current_period_end')
    .limit(batchSize)
    .select('s.id', 's.current_period_end', 'd.unit_id as deal_unit_id');
  const counts = { linksSent: 0, pastDue: 0, ended: 0 };
  for (const row of rows) {
    const ctx = await contextFor(row.deal_unit_id);
    const localToday = ctx.today();
    const remindDays = ctx.settings['billing.renewalReminderDays'] ?? 14;
    const outcome = await db.transaction(async (trx) => {
      const sub = await trx('subscriptions').where({ id: row.id }).whereIn('status', ['active', 'past_due']).forUpdate().skipLocked().first();
      if (!sub) return null;
      const deal = await trx('deals').where({ id: sub.deal_id }).first();
      const event = (type, extra = {}) =>
        emitEvent(trx, {
          type,
          groupId: deal.group_id,
          unitId: deal.unit_id,
          aggregateType: 'subscription',
          aggregateId: sub.id,
          payload: { subscriptionId: sub.id, dealId: deal.id, companyId: sub.company_id, accountId: sub.account_id ?? null, renewsOn: sub.current_period_end, ...extra },
        });
      if (sub.current_period_end <= localToday && sub.cancel_at_period_end) {
        await trx('subscriptions').where({ id: sub.id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), updated_at: trx.fn.now() });
        await trx('payments').where({ subscription_id: sub.id }).whereIn('status', ['link_sent', 'failed']).update({ status: 'cancelled', next_retry_at: null, updated_at: trx.fn.now() });
        await writeAudit(trx, null, { action: 'subscription.cancelled', entityType: 'subscription', entityId: sub.id, unit: { id: deal.unit_id, root_id: deal.group_id }, meta: { reason: 'Ended at the renewal date' } });
        await event('subscription.cancelled', { status: 'cancelled', reason: sub.cancel_reason ?? null, atPeriodEnd: true });
        return 'ended';
      }
      if (sub.current_period_end <= localToday && sub.status === 'active') {
        await trx('subscriptions').where({ id: sub.id }).update({ status: 'past_due', updated_at: trx.fn.now() });
        await event('subscription.past_due', { status: 'past_due' });
        return 'pastDue';
      }
      if (!sub.cancel_at_period_end && !sub.renewal_reminded_at && daysBetween(localToday, sub.current_period_end) <= remindDays) {
        await trx('subscriptions').where({ id: sub.id }).update({ renewal_reminded_at: trx.fn.now() });
        await event('subscription.renewal_due', { status: sub.status, daysToRenewal: daysBetween(localToday, sub.current_period_end) });
        return { link: sub };
      }
      return null;
    });
    if (outcome === 'ended') counts.ended += 1;
    else if (outcome === 'pastDue') counts.pastDue += 1;
    else if (outcome?.link) {
      try {
        await createLink({ dealId: outcome.link.deal_id, body: { purpose: 'subscription', subscriptionId: outcome.link.id, notify: true }, actorUserId: null });
        counts.linksSent += 1;
      } catch (err) {
        log.warn({ subscriptionId: outcome.link.id, code: err.code }, 'money: renewal link not sent');
      }
    }
  }
  return { checked: rows.length, ...counts };
}

/** Expire sent quotes past their validity, payment links past expiry and unsigned agreements. */
export async function expiriesJob({ now = new Date(), batchSize = 500 } = {}) {
  const today = now.toISOString().slice(0, 10);
  const result = { quotes: 0, links: 0, agreements: 0 };
  await db.transaction(async (trx) => {
    const quotes = await trx('quotes').where({ status: 'sent' }).where('valid_until', '<', addDays(today, -1)).limit(batchSize).forUpdate().skipLocked();
    for (const quote of quotes) {
      const paying = await trx('payments').where({ quote_id: quote.id }).whereIn('status', ['creating', 'link_sent', 'pending', 'succeeded']).first('id');
      if (paying) continue;
      await trx('quotes').where({ id: quote.id }).update({ status: 'expired', updated_at: trx.fn.now() });
      const deal = await trx('deals').where({ id: quote.deal_id }).first();
      await emitEvent(trx, { type: 'quote.expired', groupId: deal.group_id, unitId: deal.unit_id, aggregateType: 'quote', aggregateId: quote.id, payload: { quoteId: quote.id, ref: quote.ref, dealId: deal.id, companyId: quote.company_id } });
      result.quotes += 1;
    }
    const links = await trx('payments').whereIn('status', ['link_sent', 'failed']).where('expires_at', '<', now).limit(batchSize).forUpdate().skipLocked();
    for (const payment of links) {
      if (payment.status === 'failed' && payment.next_retry_at) continue; // the retry job sends a new link
      await trx('payments').where({ id: payment.id }).update({ status: 'expired', next_retry_at: null, updated_at: trx.fn.now() });
      const deal = await trx('deals').where({ id: payment.deal_id }).first();
      await emitEvent(trx, { type: 'payment.link_expired', groupId: deal.group_id, unitId: deal.unit_id, aggregateType: 'payment', aggregateId: payment.id, payload: { paymentId: payment.id, dealId: deal.id, companyId: payment.company_id } });
      result.links += 1;
    }
    const agreements = await trx('agreements').whereIn('status', ['sent', 'partially_signed']).where('expires_at', '<', now).limit(batchSize).forUpdate().skipLocked();
    for (const agreement of agreements) {
      await trx('agreements').where({ id: agreement.id }).update({ status: 'expired', updated_at: trx.fn.now() });
      const deal = await trx('deals').where({ id: agreement.deal_id }).first();
      await emitEvent(trx, { type: 'agreement.expired', groupId: deal.group_id, unitId: deal.unit_id, aggregateType: 'agreement', aggregateId: agreement.id, payload: { agreementId: agreement.id, ref: agreement.ref, dealId: deal.id, companyId: agreement.company_id } });
      result.agreements += 1;
    }
  });
  return result;
}

/** Job processors by name, for the integrator to register with the jobs framework. */
export const moneyJobs = Object.freeze({
  'money.instalmentReminders': instalmentRemindersJob,
  'money.paymentRetries': paymentRetriesJob,
  'money.subscriptionRenewals': subscriptionRenewalsJob,
  'money.expiries': expiriesJob,
});
