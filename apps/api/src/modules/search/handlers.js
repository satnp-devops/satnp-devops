import { refreshSearchDocuments } from '../../core/crm/search.js';

// Consistency handlers (docs/crm/PHASE2_CONTRACT.md §9.10 and §11.2). Producers write search
// documents in the same transaction as the change; these handlers rebuild them from the database
// after the event, so a producer that missed an update (or a set-based change such as renaming a
// stage) is repaired. Rebuilding is idempotent: running a handler twice, late or out of order,
// leaves the same documents, which is what a retried job needs.

export const BATCH_SIZE = 500;

const ids = (...values) => [...new Set(values.filter((value) => typeof value === 'string' && value))];

/**
 * What one event asks the index to refresh: { deal?: string[], contact?: string[], account?: string[],
 * dealsWhere?: Array<{ column, value }> } (deals selected by a column, refreshed in batches).
 * Returns null for events search doesn't follow. Pure.
 */
export function refreshPlan(event) {
  const type = String(event?.type ?? '');
  const payload = event?.payload ?? {};
  const aggregateId = typeof event?.aggregateId === 'string' ? event.aggregateId : null;

  if (type.startsWith('deal.')) return { deal: ids(payload.dealId ?? aggregateId) };

  if (type === 'contact.merged') {
    // The source document goes (it is merged), the target is rebuilt, and so are the deals of both.
    const contacts = ids(payload.targetId, payload.sourceId);
    return { contact: contacts, dealsWhere: contacts.map((value) => ({ column: 'primary_contact_id', value })) };
  }
  if (type.startsWith('contact.')) {
    const contactId = payload.contactId ?? aggregateId;
    // Deal documents carry their main contact's name and numbers: an edit or an erasure changes them.
    const withDeals = type === 'contact.updated' || type === 'contact.erased';
    return {
      contact: ids(contactId),
      dealsWhere: withDeals && contactId ? [{ column: 'primary_contact_id', value: contactId }] : [],
    };
  }
  if (type.startsWith('account.')) {
    const accountId = payload.accountId ?? aggregateId;
    return {
      account: ids(accountId),
      dealsWhere: type === 'account.updated' && accountId ? [{ column: 'account_id', value: accountId }] : [],
    };
  }
  if (type === 'pipeline_stage.updated' || type === 'pipeline_stage.archived') {
    // An archive can move the stage's deals to another stage (set-based): refresh those too.
    const moved = type === 'pipeline_stage.archived' && payload.movedDealCount > 0 ? ids(payload.moveToStageId) : [];
    const stages = ids(payload.stageId, ...moved);
    return stages.length ? { dealsWhere: stages.map((value) => ({ column: 'stage_id', value })) } : null;
  }
  if (type === 'product_line.updated') {
    const productLineId = payload.productLineId ?? aggregateId;
    return productLineId ? { dealsWhere: [{ column: 'product_line_id', value: productLineId }] } : null;
  }
  return null;
}

const DEAL_COLUMNS = new Set(['primary_contact_id', 'account_id', 'stage_id', 'product_line_id']);

/** Refresh every deal with column = value, in id order and batches of BATCH_SIZE. */
export async function refreshDealsWhere(db, column, value, { batchSize = BATCH_SIZE } = {}) {
  if (!DEAL_COLUMNS.has(column)) throw new TypeError(`Can't select deals by "${column}"`);
  let after = null;
  let total = 0;
  for (;;) {
    const batch = await db('deals')
      .where(column, value)
      .modify((query) => {
        if (after) query.where('id', '>', after);
      })
      .orderBy('id')
      .limit(batchSize)
      .pluck('id');
    if (batch.length === 0) break;
    await db.transaction((trx) => refreshSearchDocuments(trx, 'deal', batch));
    total += batch.length;
    after = batch[batch.length - 1];
    if (batch.length < batchSize) break;
  }
  return total;
}

/** Apply a refresh plan. */
export async function applyRefreshPlan(db, plan) {
  for (const entityType of ['contact', 'account', 'deal']) {
    const list = plan[entityType] ?? [];
    if (list.length) await db.transaction((trx) => refreshSearchDocuments(trx, entityType, list));
  }
  for (const { column, value } of plan.dealsWhere ?? []) await refreshDealsWhere(db, column, value);
}

/** The catch-all handler the module registers: follows deal.*, contact.*, account.* and the config events. */
export async function handleSearchEvent(event, { db, log } = {}) {
  const plan = refreshPlan(event);
  if (!plan) return;
  await applyRefreshPlan(db, plan);
  log?.debug?.({ plan }, 'search documents refreshed');
}
