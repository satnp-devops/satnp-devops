import { emitEvent } from '../../core/events.js';
import { companyForUnit } from '../../core/crm/scope.js';
import { isCurrencyCode } from '../../core/crm/money.js';
import { isCalendarDate } from '../../core/billing/dates.js';

// The renewals read model (docs/delivery/DELIVERY.md §7): one row per subscription of the money
// module, kept up to date from its subscription.* events. Reminders and churn scores are added
// by the jobs in jobs.js.

const pick = (...values) => values.find((v) => v !== undefined && v !== null);
const dateOf = (value) => {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return isCalendarDate(text) ? text : null;
};

/**
 * Turn a subscription event into a renewals row (or null when it can't be placed).
 * Accepts the field names the money module is likely to use (termEnd / currentPeriodEnd / renewsOn).
 */
export async function renewalFromEvent(trx, event) {
  const p = event.payload ?? {};
  const subscriptionId = pick(p.subscriptionId, event.aggregateType === 'subscription' ? event.aggregateId : null);
  const termEnd = dateOf(pick(p.termEnd, p.currentPeriodEnd, p.renewsOn, p.endsOn));
  if (!subscriptionId || !termEnd) return null;
  const deal = p.dealId ? await trx('deals').where({ id: p.dealId }).first('id', 'unit_id', 'company_id', 'owner_user_id', 'account_id', 'product_id', 'product_line_id') : null;
  const unitId = pick(p.unitId, deal?.unit_id, event.unitId, p.companyId);
  if (!unitId) return null;
  const unit = await trx('org_units').where({ id: unitId }).first();
  const company = unit ? await companyForUnit(unit, trx) : null;
  if (!company) return null;
  if (p.companyId && p.companyId !== company.id) return null;
  const status = ['subscription.cancelled', 'subscription.deleted'].includes(event.type) || p.status === 'cancelled' ? 'cancelled' : event.type === 'subscription.ended' || p.status === 'ended' ? 'ended' : 'active';
  const currency = isCurrencyCode(p.currency) ? p.currency : 'INR';
  return {
    group_id: company.root_id,
    company_id: company.id,
    unit_id: unit.id,
    subscription_id: String(subscriptionId),
    account_id: pick(p.accountId, deal?.account_id) ?? null,
    contact_id: p.contactId ?? null,
    deal_id: deal?.id ?? null,
    product_id: pick(p.productId, deal?.product_id) ?? null,
    product_line_id: pick(p.productLineId, deal?.product_line_id) ?? null,
    plan_name: p.planName ? String(p.planName).slice(0, 200) : null,
    status,
    term_start: dateOf(pick(p.termStart, p.currentPeriodStart, p.startsOn)),
    term_end: termEnd,
    auto_renew: Boolean(p.autoRenew),
    amount_minor: Number.isSafeInteger(p.amountMinor) && p.amountMinor >= 0 ? p.amountMinor : 0,
    currency,
    seats: Number.isSafeInteger(p.seats) && p.seats >= 0 ? p.seats : null,
    owner_user_id: pick(p.ownerUserId, deal?.owner_user_id) ?? null,
    last_event_at: new Date(event.occurredAt ?? Date.now()),
  };
}

/**
 * Insert or update a renewal. Events arriving out of order (an older one after a newer one) are
 * ignored; a new term end resets the reminders already sent.
 * @returns {Promise<object | null>} the row, or null when the event was older than what is stored
 */
export async function upsertRenewal(trx, row) {
  const columns = Object.keys(row);
  const updates = columns
    .filter((c) => c !== 'subscription_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const { rows } = await trx.raw(
    `insert into renewals (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})
     on conflict (subscription_id) do update set ${updates},
       reminders_sent = case when renewals.term_end is distinct from excluded.term_end then '{}'::integer[] else renewals.reminders_sent end,
       reminder_term_end = case when renewals.term_end is distinct from excluded.term_end then null else renewals.reminder_term_end end,
       updated_at = now()
     where renewals.last_event_at is null or renewals.last_event_at <= excluded.last_event_at
     returning *, (xmax = 0) as inserted`,
    columns.map((c) => row[c]),
  );
  const saved = rows[0] ?? null;
  if (saved) {
    await emitEvent(trx, {
      type: saved.inserted ? 'renewal.created' : 'renewal.updated',
      groupId: saved.group_id,
      unitId: saved.unit_id,
      aggregateType: 'renewal',
      aggregateId: saved.id,
      payload: { renewalId: saved.id, companyId: saved.company_id, subscriptionId: saved.subscription_id, accountId: saved.account_id, termEnd: saved.term_end, status: saved.status },
    });
  }
  return saved;
}
