import { db } from '../../lib/db.js';

// Per-company AI budgets: tokens used per calendar month (UTC) in ai_usage, one row per company
// and month, checked before each call and added to after it.

/** The first day of the month (UTC) as YYYY-MM-01. */
export function periodOf(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const presentUsage = (row, period) => {
  const inputTokens = Number(row?.input_tokens ?? 0);
  const outputTokens = Number(row?.output_tokens ?? 0);
  return { period, calls: Number(row?.calls ?? 0), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};

/** This month's usage for a company. */
export async function usageFor(companyId, { now = new Date(), trx = db } = {}) {
  const period = periodOf(now);
  const row = await trx('ai_usage').where({ company_id: companyId, period }).first();
  return presentUsage(row, period);
}

/** Is there budget left? A budget of 0 means AI is off for the company. */
export const withinBudget = (usage, budget) => budget > 0 && usage.totalTokens < budget;

/** Add one call's tokens (atomic upsert). */
export async function recordUsage(trx, { companyId, groupId, inputTokens = 0, outputTokens = 0, calls = 1, now = new Date() }) {
  await trx.raw(
    `insert into ai_usage (company_id, group_id, period, calls, input_tokens, output_tokens, updated_at)
     values (?, ?, ?, ?, ?, ?, now())
     on conflict (company_id, period) do update
        set calls = ai_usage.calls + excluded.calls,
            input_tokens = ai_usage.input_tokens + excluded.input_tokens,
            output_tokens = ai_usage.output_tokens + excluded.output_tokens,
            updated_at = now()`,
    [companyId, groupId, periodOf(now), calls, inputTokens, outputTokens],
  );
}
