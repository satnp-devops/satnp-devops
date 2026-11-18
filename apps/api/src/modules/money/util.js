import { db } from '../../lib/db.js';
import { getEffectiveSettings } from '../../core/settings.js';
import { referencePrefixSetting } from '../../core/crm/settings.js';
import { settingDefinitions } from '../settings/definitions.js';
import { DEFAULT_TIME_ZONE, localDate } from '../../core/billing/index.js';
import { formatMoney } from '../../core/crm/money.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { moneySettings } from './settings.js';

const timeZoneSetting = settingDefinitions.find((d) => d.key === 'locale.timeZone');

/** Next number of a per-company counter in crm_sequences (row-locked until commit, no gaps). */
export async function nextCompanyNumber(trx, companyId, name) {
  const { rows } = await trx.raw(
    `insert into crm_sequences (company_id, name, value) values (?, ?, 1)
     on conflict (company_id, name) do update set value = crm_sequences.value + 1
     returning value`,
    [companyId, `billing.${name}`],
  );
  return Number(rows[0].value);
}

export const refFor = (prefix, code, number) => `${prefix}-${code}-${String(number).padStart(4, '0')}`;

/**
 * What billing needs to know about a company, in one query: its time zone, reference prefix and
 * the money settings. `unit` is the company (or a unit inside it, for settings read at the deal's unit).
 */
export async function companyContext(unit, trx = db) {
  const definitions = [timeZoneSetting, referencePrefixSetting, ...moneySettings];
  const resolved = await getEffectiveSettings(unit, definitions, trx);
  const values = Object.fromEntries(Object.entries(resolved).map(([key, entry]) => [key, entry.value]));
  const timeZone = values['locale.timeZone'] || DEFAULT_TIME_ZONE;
  return {
    timeZone,
    prefix: values['deals.referencePrefix'] || 'D',
    settings: values,
    today: () => localDate(Date.now(), timeZone),
  };
}

export const money = (minor, currency) => formatMoney(Number(minor), currency);

/** A billing timeline entry on a deal (also shown on its primary contact and institute). */
export function dealTimeline(trx, deal, { kind = 'payment', title, body = null, meta = {}, actorUserId = null, sourceEventId = null, actorType }) {
  return addTimelineEvent(trx, {
    groupId: deal.group_id,
    companyId: deal.company_id,
    unitId: deal.unit_id,
    dealId: deal.id,
    contactId: deal.primary_contact_id ?? null,
    accountId: deal.account_id ?? null,
    kind,
    title,
    body,
    meta,
    actorType: actorType ?? (actorUserId ? 'user' : 'system'),
    actorUserId,
    sourceEventId,
    touchDeal: true,
  });
}

/** The audit unit of a billing record: the deal's unit inside its group. */
export const auditUnit = (deal) => ({ id: deal.unit_id, root_id: deal.group_id });

/** Load the deal a billing row belongs to (for events and timeline entries). */
export const loadDeal = (trx, dealId) => trx('deals').where({ id: dealId }).first();

export const minor = (value) => (value === null || value === undefined ? 0 : Number(value));
export const iso = (value) => (value ? new Date(value).toISOString() : null);
