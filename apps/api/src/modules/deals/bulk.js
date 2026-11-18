import { db } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { loadAccess } from '../../core/access.js';
import { levelForRecord, unitsIndex } from '../../core/crm/scope.js';
import { assertKnownChannels, scopedDeals } from './queries.js';
import { firstStage, loadPlanContext, planArchive, planAssign, planMove, planNurture, planRestore, planTags } from './plans.js';
import { BULK_MAX } from './schemas.js';
import { canAssignTo } from './service.js';
import { commitPlans } from './writes.js';

// Bulk actions on leads (POST /deals/bulk): assign, move stage, mark lost, add or remove tags,
// nurture, archive and restore, for selected ids or everything a filter matches (up to 1000).
//
// Records are processed in chunks. Each chunk is one transaction: its rows are locked, every record
// gets the same checks as the single endpoint (visibility, permission, stage rules, lost reasons...),
// and the changes that pass are written set-based (writes.js commitPlans), with the same events,
// timeline entries and audit entries (meta { bulk: true }). Records that fail are reported with a
// code and a reason; the others go ahead.
//
// runDealBulk is the core a background job can call later: build the actor with bulkActorFor(userId).

const MANAGE = 'deals.manage';
export const BULK_CHUNK_SIZE = 100;

/** A request-like actor for jobs: the user's access, as requireAuth would load it. */
export async function bulkActorFor(userId, registry) {
  return { auth: { user: { id: userId } }, access: await loadAccess(userId, registry), app: { locals: { registry } } };
}

/** Ids of the deals a bulk filter matches, newest first; more than BULK_MAX is refused. */
export async function idsForFilter(actor, filter) {
  assertKnownChannels(actor.app.locals.registry, filter.channel, 'body.filter.channel');
  const { query } = await scopedDeals(actor, filter);
  const ids = await query
    .orderBy([
      { column: 'd.updated_at', order: 'desc' },
      { column: 'd.id', order: 'desc' },
    ])
    .limit(BULK_MAX + 1)
    .pluck('d.id');
  if (ids.length > BULK_MAX) {
    throw errors.validation(
      [{ path: 'body.filter', message: `More than ${BULK_MAX} leads match` }],
      `More than ${BULK_MAX} leads match. Narrow the filters, or select the leads instead.`,
    );
  }
  return ids;
}

/** Things every record of the request shares, loaded once (the owner, the target stage, the lost reason). */
async function prepare(input) {
  const shared = {};
  if (input.action === 'assign' && input.ownerUserId) {
    shared.owner = (await db('users').where({ id: input.ownerUserId }).first('id', 'name')) ?? null;
  }
  if (input.action === 'move') {
    shared.stage = await db('pipeline_stages').where({ id: input.stageId }).first();
    if (!shared.stage) throw errors.validation([{ path: 'body.stageId', message: 'Stage not found' }]);
  }
  if (input.lostReasonId) {
    shared.lostReason = await db('lost_reasons').where({ id: input.lostReasonId }).first();
    if (!shared.lostReason) throw errors.validation([{ path: 'body.lostReasonId', message: 'Lost reason not found' }]);
  }
  return shared;
}

/** The permission check of the single endpoint for this action. Throws 403. */
function checkPermission(actor, units, deal, input) {
  const unit = units.get(deal.unit_id);
  const userId = actor.auth.user.id;
  if (input.action === 'assign') {
    if (!canAssignTo(actor.access, unit, input.ownerUserId, userId)) throw errors.forbidden("You can't change who owns this lead");
    return;
  }
  if (input.action === 'archive' || input.action === 'restore') {
    if (!actor.access.can('deals.archive', unit.path)) throw errors.forbidden("You can't archive leads here");
    return;
  }
  if (!levelForRecord(actor.access, units, MANAGE, deal, { userId })) throw errors.forbidden("You can't change this lead");
}

async function planFor(deal, input, shared, ctx, units) {
  const bulk = true;
  switch (input.action) {
    case 'assign':
      return planAssign(deal, { ownerUserId: input.ownerUserId, owner: shared.owner, unit: units.get(deal.unit_id), bulk }, ctx);
    case 'move':
    case 'lose': {
      const toStage = input.action === 'move' ? shared.stage : firstStage(ctx, deal.pipeline_id, 'lost');
      if (!toStage) throw errors.conflict("This lead's pipeline has no lost stage");
      if (input.action === 'lose' && deal.status === 'lost') return null;
      if (toStage.company_id !== deal.company_id) throw new AppError(422, 'stage_rules', `${toStage.name} is a stage of another company`, { missing: [], allowedFrom: null });
      return planMove(
        deal,
        toStage,
        { lostReason: shared.lostReason, lostNote: input.lostNote, nurture: input.nurture, companyUnit: units.get(deal.company_id), bulk },
        ctx,
      );
    }
    case 'addTags':
      return planTags(deal, { add: input.tags, bulk }, ctx);
    case 'removeTags':
      return planTags(deal, { remove: input.tags, bulk }, ctx);
    case 'setNurture':
      return planNurture(deal, { nurture: input.nurture, bulk }, ctx);
    case 'archive':
      return planArchive(deal, { bulk }, ctx);
    case 'restore':
      return planRestore(deal, { bulk }, ctx);
    default:
      throw errors.badRequest('Unknown bulk action');
  }
}

/**
 * Run a bulk action.
 * @param {object} actor the request (or bulkActorFor(userId) in a job)
 * @param {object} input bulkBody (ids or filter)
 * @param {{ chunkSize?: number, onProgress?: (progress: { done: number, total: number }) => void | Promise<void> }} [options]
 * @returns {Promise<{ updated: string[], unchanged: string[], failed: Array<{ id: string, code: string, message: string }>, total: number }>}
 */
export async function runDealBulk(actor, input, { chunkSize = BULK_CHUNK_SIZE, onProgress } = {}) {
  const ids = input.ids ? [...new Set(input.ids)] : await idsForFilter(actor, input.filter);
  const shared = await prepare(input);
  const userId = actor.auth.user.id;
  const outcome = new Map();
  const needsStages = input.action === 'move' || input.action === 'lose';

  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    const decided = new Map();
    try {
      await db.transaction(async (trx) => {
        const units = await unitsIndex(actor, trx);
        const rows = await trx('deals').whereIn('id', chunk).forUpdate();
        const byId = new Map(rows.map((row) => [row.id, row]));
        const visible = (row) =>
          row &&
          levelForRecord(actor.access, units, 'deals.view', row, { userId }) &&
          (!row.archived_at || levelForRecord(actor.access, units, 'deals.archive', row, { userId }));
        const now = new Date();
        const workable = chunk.map((id) => byId.get(id)).filter(visible);
        const ctx = await loadPlanContext(trx, needsStages ? workable : [], { now, userId });
        const plans = [];
        for (const id of chunk) {
          const deal = byId.get(id);
          if (!visible(deal)) {
            decided.set(id, { status: 'failed', code: 'not_found', message: 'Lead not found' });
            continue;
          }
          try {
            checkPermission(actor, units, deal, input);
            const plan = await planFor(deal, input, shared, ctx, units);
            if (plan) plans.push(plan);
            decided.set(id, { status: plan ? 'updated' : 'unchanged' });
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
            const message = err.code === 'validation_failed' && Array.isArray(err.details) && err.details[0]?.message ? err.details[0].message : err.message;
            decided.set(id, { status: 'failed', code: err.code, message });
          }
        }
        await commitPlans(trx, actor, plans, now);
      });
      for (const [id, result] of decided) outcome.set(id, result);
    } catch (err) {
      // The chunk's transaction rolled back: none of its records changed.
      const message = err instanceof AppError ? err.message : 'Something went wrong while saving these leads. Try again.';
      for (const id of chunk) {
        const earlier = decided.get(id);
        outcome.set(id, earlier?.status === 'failed' ? earlier : { status: 'failed', code: err instanceof AppError ? err.code : 'error', message });
      }
      if (!(err instanceof AppError)) actor.log?.error?.({ err }, 'bulk action chunk failed');
    }
    await onProgress?.({ done: Math.min(start + chunk.length, ids.length), total: ids.length });
  }

  const result = { updated: [], unchanged: [], failed: [], total: ids.length };
  for (const id of ids) {
    const entry = outcome.get(id);
    if (entry.status === 'failed') result.failed.push({ id, code: entry.code, message: entry.message });
    else result[entry.status].push(id);
  }
  return result;
}
