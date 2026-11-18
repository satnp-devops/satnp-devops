import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { refreshSearchDocuments } from '../../core/crm/search.js';
import {
  byPosition,
  changedKeys,
  configCompanies,
  loadConfigRow,
  nextPosition,
  pick,
  recordChange,
  requireManagedCompany,
  sortByCompany,
  withUniqueConflicts,
} from './configAccess.js';
import { presentLostReason, presentPipeline, stageOrder } from './present.js';
import {
  archiveStageBlocker,
  defaultStagePosition,
  entryRulesWithout,
  errorsForStage,
  insertAt,
  normalizeStage,
  requiredFieldChoices,
  stageOrderErrors,
  stageSetErrors,
} from './rules.js';

// Pipelines, stages and lost reasons (docs/crm/PHASE2_CONTRACT.md §9.3). Each write is one
// transaction: load and lock, validate, write, audit and event; the response is built after it.

const VIEW = 'pipelines.view';
const MANAGE = 'pipelines.manage';
const SEARCH_BATCH = 500;

const PIPELINE_CONFLICTS = {
  pipelines_key_uq: 'Another pipeline of this company already uses this key',
  pipelines_default_uq: 'Another pipeline just became the default. Try again.',
};
const STAGE_CONFLICTS = { pipeline_stages_key_uq: 'Another stage of this pipeline already uses this key (archived stages keep theirs)' };
const LOST_REASON_CONFLICTS = { lost_reasons_label_uq: 'This company already has a lost reason with this label' };

// ---------- Loading ----------

/** Pipelines with their stages in one query (stages as a JSON array). */
function pipelinesQuery(trx, { includeArchivedStages = false } = {}) {
  return trx('pipelines as p')
    .select('p.*', trx.raw("coalesce(st.stages, '[]'::json) as stages"))
    .joinRaw(
      `left join lateral (select json_agg(s) as stages from pipeline_stages s where s.pipeline_id = p.id${
        includeArchivedStages ? '' : ' and s.archived_at is null'
      }) st on true`,
    );
}

async function loadPresented(id, trx = db) {
  const row = await pipelinesQuery(trx).where('p.id', id).first();
  return presentPipeline(row);
}

/** The company's custom deal field definitions (stage rules may require the active ones). */
const customDealFields = (trx, companyId) => trx('custom_field_definitions').where({ company_id: companyId, entity: 'deal' });

const activeStagesOf = async (trx, pipelineId) =>
  (await trx('pipeline_stages').where({ pipeline_id: pipelineId }).whereNull('archived_at')).sort(stageOrder);

/** A stage row in the shape the rules check. */
const stageInputOf = (row) => ({
  key: row.key,
  name: row.name,
  category: row.category,
  requiredFields: row.required_fields ?? [],
  entryRules: row.entry_rules ?? {},
});

/** Load a pipeline for a change (locked) and refuse changes to archived ones. */
async function loadPipelineForChange(req, trx, id, { allowArchived = false } = {}) {
  const { row, company } = await loadConfigRow(req, { table: 'pipelines', id, view: VIEW, manage: MANAGE, notFound: 'Pipeline', trx, forUpdate: true });
  if (row.archived_at && !allowArchived) throw errors.conflict(`${row.name} is archived. Restore it first.`);
  return { pipeline: row, company };
}

/** Product lines a pipeline is limited to must be the company's and sell to the pipeline's kind of buyer. */
async function productLineErrors(trx, company, kind, ids, path = 'body.productLineIds') {
  if (!ids?.length) return [];
  const rows = await trx('product_lines').whereIn('id', [...new Set(ids)]).select('id', 'company_id', 'audience');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id, index) => {
    const line = byId.get(id);
    if (!line || line.company_id !== company.id) return [{ path: `${path}.${index}`, message: 'Product line not found in this company' }];
    if (line.audience !== kind) return [{ path: `${path}.${index}`, message: `This product line isn't sold in ${kind.toUpperCase()} deals` }];
    return [];
  });
}

/** Set every listed stage's position to its index, in one statement. */
async function renumber(trx, ids) {
  if (ids.length === 0) return;
  await trx.raw(
    `update pipeline_stages s set position = v.position, updated_at = now()
       from unnest(?::uuid[], ?::int[]) as v(id, position)
      where s.id = v.id and s.position <> v.position`,
    [ids, ids.map((_, index) => index)],
  );
}

const stageColumns = (stage) => ({
  name: stage.name,
  probability: stage.probability,
  sla_hours: stage.slaHours,
  required_fields: stage.requiredFields,
  entry_rules: json(stage.entryRules ?? {}),
  colour: stage.colour ? stage.colour.toUpperCase() : null,
});

/** What audit entries keep of a pipeline and a stage (no timestamps). */
const auditPipeline = (row) => ({
  key: row.key,
  name: row.name,
  kind: row.kind,
  isDefault: row.is_default,
  productLineIds: row.product_line_ids,
  position: row.position,
  archived: Boolean(row.archived_at),
});
const auditStage = (row) => ({
  key: row.key,
  name: row.name,
  category: row.category,
  probability: row.probability,
  slaHours: row.sla_hours,
  requiredFields: row.required_fields,
  entryRules: row.entry_rules,
  colour: row.colour,
});

// ---------- Pipelines ----------

export async function listPipelines(req, { unitId, companyId, kind, includeArchived = false }) {
  const companies = await configCompanies(req, { unitId, companyId }, VIEW);
  if (companies.length === 0) return [];
  const rows = await pipelinesQuery(db, { includeArchivedStages: includeArchived })
    .whereIn('p.company_id', companies.map((company) => company.id))
    .modify((query) => {
      if (kind) query.where('p.kind', kind);
      if (!includeArchived) query.whereNull('p.archived_at');
    })
    .limit(1000);
  return sortByCompany(rows, companies, byPosition).map((row) => presentPipeline(row));
}

export async function getPipeline(req, id) {
  await loadConfigRow(req, { table: 'pipelines', id, view: VIEW, notFound: 'Pipeline' });
  return loadPresented(id);
}

export async function listRequiredFieldOptions(req, { companyId, kind }) {
  const [company] = await configCompanies(req, { companyId }, VIEW);
  return requiredFieldChoices(await customDealFields(db, company.id), kind);
}

export async function createPipeline(req, body) {
  return db.transaction(async (trx) => {
    const company = await requireManagedCompany(req, body.companyId, MANAGE, { trx });
    const stages = body.stages.map(normalizeStage);
    const problems = [
      ...stageSetErrors(stages, { kind: body.kind, customDefinitions: await customDealFields(trx, company.id) }),
      ...(await productLineErrors(trx, company, body.kind, body.productLineIds)),
    ];
    if (problems.length) throw errors.validation(problems);
    if (await trx('pipelines').where({ company_id: company.id, key: body.key }).first()) {
      throw errors.conflict(PIPELINE_CONFLICTS.pipelines_key_uq);
    }

    const current = await trx('pipelines')
      .where({ company_id: company.id, kind: body.kind, is_default: true })
      .whereNull('archived_at')
      .forUpdate()
      .first();
    const isDefault = body.isDefault || !current;
    if (isDefault && current) await trx('pipelines').where({ id: current.id }).update({ is_default: false, updated_at: trx.fn.now() });

    const [pipeline] = await withUniqueConflicts(PIPELINE_CONFLICTS, async () =>
      trx('pipelines')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          key: body.key,
          name: body.name,
          kind: body.kind,
          is_default: isDefault,
          product_line_ids: [...new Set(body.productLineIds)],
          position: body.position ?? (await nextPosition(trx, 'pipelines', { company_id: company.id })),
          created_by: req.auth.user.id,
        })
        .returning('*'),
    );
    const stageRows = await trx('pipeline_stages')
      .insert(
        stages.map((stage, index) => ({
          pipeline_id: pipeline.id,
          company_id: company.id,
          key: stage.key,
          category: stage.category,
          position: index,
          ...stageColumns(stage),
        })),
      )
      .returning('*');

    await recordChange(trx, req, {
      company,
      action: 'pipeline.created',
      entityType: 'pipeline',
      entityId: pipeline.id,
      after: { ...auditPipeline(pipeline), stages: stageRows.map((stage) => stage.key) },
      event: { payload: { pipelineId: pipeline.id, companyId: company.id, kind: pipeline.kind } },
    });
    return presentPipeline(pipeline, stageRows);
  });
}

export async function updatePipeline(req, id, body) {
  const pipelineId = await db.transaction(async (trx) => {
    const { pipeline, company } = await loadPipelineForChange(req, trx, id, { allowArchived: !body.isDefault });
    if (body.productLineIds) {
      const problems = await productLineErrors(trx, company, pipeline.kind, body.productLineIds);
      if (problems.length) throw errors.validation(problems);
    }
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.position !== undefined) patch.position = body.position;
    if (body.productLineIds !== undefined) patch.product_line_ids = [...new Set(body.productLineIds)];
    if (body.isDefault && !pipeline.is_default) {
      await trx('pipelines')
        .where({ company_id: company.id, kind: pipeline.kind, is_default: true })
        .whereNull('archived_at')
        .update({ is_default: false, updated_at: trx.fn.now() });
      patch.is_default = true;
    }
    if (Object.keys(patch).length === 0) return pipeline.id;

    const [updated] = await withUniqueConflicts(PIPELINE_CONFLICTS, () =>
      trx('pipelines').where({ id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*'),
    );
    const before = auditPipeline(pipeline);
    const after = auditPipeline(updated);
    await recordChange(trx, req, {
      company,
      action: 'pipeline.updated',
      entityType: 'pipeline',
      entityId: id,
      before,
      after,
      event: { payload: { pipelineId: id, companyId: company.id, changes: changedKeys(before, after) } },
    });
    return id;
  });
  return loadPresented(pipelineId);
}

/** Open, non-archived deals in a pipeline or stage (deals_stage_updated_idx leads with pipeline_id). */
async function dealCounts(trx, where) {
  const row = await trx('deals')
    .where(where)
    .whereNull('archived_at')
    .select(trx.raw("count(*) filter (where status = 'open')::int as open"), trx.raw('count(*)::int as total'))
    .first();
  return { openDealCount: row?.open ?? 0, dealCount: row?.total ?? 0 };
}

export async function archivePipeline(req, id) {
  await db.transaction(async (trx) => {
    const { pipeline, company } = await loadPipelineForChange(req, trx, id, { allowArchived: true });
    if (pipeline.archived_at) throw errors.conflict(`${pipeline.name} is already archived`);
    const { openDealCount } = await dealCounts(trx, { pipeline_id: id });
    if (openDealCount > 0) {
      throw errors.conflict(
        `${pipeline.name} has ${openDealCount} open ${openDealCount === 1 ? 'deal' : 'deals'}. Close or move them before archiving it.`,
        { openDealCount },
      );
    }
    const others = await trx('pipelines')
      .where({ company_id: company.id, kind: pipeline.kind })
      .whereNot({ id })
      .whereNull('archived_at')
      .orderBy([{ column: 'position' }, { column: 'name' }])
      .forUpdate();
    if (others.length === 0) {
      throw errors.conflict(`${pipeline.name} is the only active ${pipeline.kind.toUpperCase()} pipeline. Add another one first.`);
    }

    const [archived] = await trx('pipelines')
      .where({ id })
      .update({ archived_at: trx.fn.now(), is_default: false, updated_at: trx.fn.now() })
      .returning('*');
    let newDefaultId = null;
    if (pipeline.is_default) {
      newDefaultId = others[0].id;
      await trx('pipelines').where({ id: newDefaultId }).update({ is_default: true, updated_at: trx.fn.now() });
    }
    await recordChange(trx, req, {
      company,
      action: 'pipeline.archived',
      entityType: 'pipeline',
      entityId: id,
      before: auditPipeline(pipeline),
      after: auditPipeline(archived),
      meta: newDefaultId ? { newDefaultPipelineId: newDefaultId } : undefined,
      event: { payload: { pipelineId: id, companyId: company.id, kind: pipeline.kind } },
    });
  });
  const row = await pipelinesQuery(db, { includeArchivedStages: true }).where('p.id', id).first();
  return presentPipeline(row);
}

export async function restorePipeline(req, id) {
  await db.transaction(async (trx) => {
    const { pipeline, company } = await loadPipelineForChange(req, trx, id, { allowArchived: true });
    if (!pipeline.archived_at) throw errors.conflict(`${pipeline.name} is not archived`);
    const hasDefault = await trx('pipelines')
      .where({ company_id: company.id, kind: pipeline.kind, is_default: true })
      .whereNull('archived_at')
      .forUpdate()
      .first();
    const [restored] = await withUniqueConflicts(PIPELINE_CONFLICTS, () =>
      trx('pipelines')
        .where({ id })
        .update({ archived_at: null, is_default: !hasDefault, updated_at: trx.fn.now() })
        .returning('*'),
    );
    await recordChange(trx, req, {
      company,
      action: 'pipeline.restored',
      entityType: 'pipeline',
      entityId: id,
      before: auditPipeline(pipeline),
      after: auditPipeline(restored),
      event: { payload: { pipelineId: id, companyId: company.id, kind: pipeline.kind } },
    });
  });
  return loadPresented(id);
}

// ---------- Stages ----------

export async function addStage(req, id, body) {
  await db.transaction(async (trx) => {
    const { pipeline, company } = await loadPipelineForChange(req, trx, id);
    const { position, ...input } = body;
    const stage = normalizeStage(input);
    if (await trx('pipeline_stages').where({ pipeline_id: id, key: stage.key }).first()) {
      throw errors.conflict(STAGE_CONFLICTS.pipeline_stages_key_uq);
    }
    const active = await activeStagesOf(trx, id);
    const at = Math.max(0, Math.min(position ?? defaultStagePosition(active), active.length));
    const next = insertAt(active.map(stageInputOf), stage, at);
    const problems = errorsForStage(
      stageSetErrors(next, { kind: pipeline.kind, customDefinitions: await customDealFields(trx, company.id) }),
      at,
    );
    if (problems.length) throw errors.validation(problems);

    const [created] = await withUniqueConflicts(STAGE_CONFLICTS, () =>
      trx('pipeline_stages')
        .insert({ pipeline_id: id, company_id: company.id, key: stage.key, category: stage.category, position: at, ...stageColumns(stage) })
        .returning('*'),
    );
    await renumber(trx, insertAt(active, created, at).map((row) => row.id));
    await trx('pipelines').where({ id }).update({ updated_at: trx.fn.now() });
    await recordChange(trx, req, {
      company,
      action: 'pipeline_stage.created',
      entityType: 'pipeline',
      entityId: id,
      after: auditStage(created),
      meta: { stageId: created.id },
      event: { payload: { pipelineId: id, stageId: created.id } },
    });
  });
  return loadPresented(id);
}

/** Load one stage of a pipeline: 404 when it isn't one, 409 when archived. */
async function loadStage(trx, pipelineId, stageId) {
  const stage = await trx('pipeline_stages').where({ id: stageId, pipeline_id: pipelineId }).forUpdate().first();
  if (!stage) throw errors.notFound('Stage');
  if (stage.archived_at) throw errors.conflict(`${stage.name} is archived`);
  return stage;
}

export async function updateStage(req, id, stageId, body) {
  await db.transaction(async (trx) => {
    const { pipeline, company } = await loadPipelineForChange(req, trx, id);
    const stage = await loadStage(trx, id, stageId);
    const active = await activeStagesOf(trx, id);
    const index = active.findIndex((row) => row.id === stageId);
    const merged = normalizeStage({ ...stageInputOf(stage), ...body });
    const next = active.map((row, i) => (i === index ? merged : stageInputOf(row)));
    const problems = errorsForStage(
      stageSetErrors(next, { kind: pipeline.kind, customDefinitions: await customDealFields(trx, company.id) }),
      index,
    );
    if (problems.length) throw errors.validation(problems);

    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.probability !== undefined) patch.probability = body.probability;
    if (body.slaHours !== undefined) patch.sla_hours = body.slaHours;
    if (body.requiredFields !== undefined) patch.required_fields = merged.requiredFields;
    if (body.entryRules !== undefined) patch.entry_rules = json(merged.entryRules);
    if (body.colour !== undefined) patch.colour = body.colour ? body.colour.toUpperCase() : null;
    if (Object.keys(patch).length === 0) return;

    const [updated] = await trx('pipeline_stages').where({ id: stageId }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
    await trx('pipelines').where({ id }).update({ updated_at: trx.fn.now() });
    const before = auditStage(stage);
    const after = auditStage(updated);
    await recordChange(trx, req, {
      company,
      action: 'pipeline_stage.updated',
      entityType: 'pipeline',
      entityId: id,
      before,
      after,
      meta: { stageId },
      event: { payload: { pipelineId: id, stageId, changes: changedKeys(before, after) } },
    });
  });
  return loadPresented(id);
}

export async function reorderStages(req, id, { stageIds }) {
  await db.transaction(async (trx) => {
    const { company } = await loadPipelineForChange(req, trx, id);
    const active = await activeStagesOf(trx, id);
    const problems = stageOrderErrors(
      active.map((row) => row.id),
      stageIds,
    );
    if (problems.length) throw errors.validation(problems);
    await renumber(trx, stageIds);
    await trx('pipelines').where({ id }).update({ updated_at: trx.fn.now() });
    const keyOf = new Map(active.map((row) => [row.id, row.key]));
    await recordChange(trx, req, {
      company,
      action: 'pipeline_stage.reordered',
      entityType: 'pipeline',
      entityId: id,
      before: { order: active.map((row) => row.key) },
      after: { order: stageIds.map((stageId) => keyOf.get(stageId)) },
      event: { payload: { pipelineId: id } },
    });
  });
  return loadPresented(id);
}

/**
 * Move every non-archived deal of one stage to another stage of the same category, set-based:
 * the stage, its entry time and SLA, one deal_stage_history row and one stage_change timeline
 * entry per deal (stage rules are not applied). Returns the moved deal ids.
 */
async function moveDealsBetweenStages(trx, req, { from, to }) {
  const userId = req.auth.user.id;
  const meta = json({
    action: 'pipeline_stage.archived',
    fromStageId: from.id,
    toStageId: to.id,
    fromStatus: from.category,
    toStatus: to.category,
  });
  const { rows } = await trx.raw(
    `with prev as (
       select id, stage_entered_at from deals
        where pipeline_id = ? and stage_id = ? and archived_at is null
        for update
     ), moved as (
       update deals d
          set stage_id = ?,
              stage_entered_at = now(),
              sla_due_at = case when d.status = 'open' and ?::int is not null then now() + make_interval(hours => ?::int) else null end,
              sla_breached_at = null,
              last_activity_at = now(),
              updated_at = now()
         from prev
        where d.id = prev.id
       returning d.id, d.group_id, d.company_id, d.unit_id, d.pipeline_id, d.status, d.primary_contact_id, d.account_id,
                 prev.stage_entered_at as prev_entered_at
     ), history as (
       insert into deal_stage_history
         (deal_id, group_id, company_id, pipeline_id, from_stage_id, to_stage_id, from_status, to_status, moved_by_user_id, seconds_in_from_stage, moved_at)
       select id, group_id, company_id, pipeline_id, ?, ?, status, status, ?,
              greatest(0, floor(extract(epoch from now() - coalesce(prev_entered_at, now())))::bigint), now()
         from moved
     ), entries as (
       insert into timeline_events
         (group_id, company_id, unit_id, deal_id, contact_id, account_id, kind, title, meta, actor_type, actor_user_id, occurred_at)
       select group_id, company_id, unit_id, id, primary_contact_id, account_id, 'stage_change', ?, ?::jsonb, 'user', ?, now()
         from moved
     )
     select id from moved`,
    [from.pipeline_id, from.id, to.id, to.sla_hours, to.sla_hours, from.id, to.id, userId, `Moved to ${to.name}`, meta, userId],
  );
  const ids = rows.map((row) => row.id);
  for (let i = 0; i < ids.length; i += SEARCH_BATCH) await refreshSearchDocuments(trx, 'deal', ids.slice(i, i + SEARCH_BATCH));
  return ids;
}

export async function archiveStage(req, id, stageId, { moveToStageId }) {
  await db.transaction(async (trx) => {
    const { company } = await loadPipelineForChange(req, trx, id);
    const stage = await loadStage(trx, id, stageId);
    const active = await activeStagesOf(trx, id);

    const blocker = archiveStageBlocker(stage, active);
    if (blocker) throw errors.conflict(blocker);
    const rules = entryRulesWithout(
      active.filter((row) => row.id !== stageId),
      stage.key,
    );
    if (rules.blockedBy.length) {
      const names = rules.blockedBy.map((row) => row.name).join(', ');
      throw errors.conflict(`${names} can only be entered from ${stage.name}. Change ${rules.blockedBy.length === 1 ? 'its' : 'their'} entry rule first.`, {
        stageIds: rules.blockedBy.map((row) => row.id),
      });
    }

    let target = null;
    if (moveToStageId) {
      target = active.find((row) => row.id === moveToStageId && row.id !== stageId) ?? null;
      if (!target) throw errors.validation([{ path: 'body.moveToStageId', message: 'Pick another active stage of this pipeline' }]);
      if (target.category !== stage.category) {
        throw errors.validation([{ path: 'body.moveToStageId', message: `Pick a ${stage.category} stage, like ${stage.name}` }]);
      }
    }
    const counts = await dealCounts(trx, { pipeline_id: id, stage_id: stageId });
    if (counts.openDealCount > 0 && !target) {
      const n = counts.openDealCount;
      throw errors.conflict(`${stage.name} has ${n} open ${n === 1 ? 'deal' : 'deals'}. Pick a stage to move ${n === 1 ? 'it' : 'them'} to.`, counts);
    }

    const movedIds = target && counts.dealCount > 0 ? await moveDealsBetweenStages(trx, req, { from: stage, to: target }) : [];
    for (const update of rules.updates) {
      await trx('pipeline_stages').where({ id: update.id }).update({ entry_rules: json(update.entryRules), updated_at: trx.fn.now() });
    }
    await trx('pipeline_stages').where({ id: stageId }).update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() });
    await renumber(
      trx,
      active.filter((row) => row.id !== stageId).map((row) => row.id),
    );
    await trx('pipelines').where({ id }).update({ updated_at: trx.fn.now() });
    await recordChange(trx, req, {
      company,
      action: 'pipeline_stage.archived',
      entityType: 'pipeline',
      entityId: id,
      before: auditStage(stage),
      meta: { stageId, moveToStageId: target?.id ?? null, movedDealCount: movedIds.length },
      event: { payload: { pipelineId: id, stageId, moveToStageId: target?.id ?? null, movedDealCount: movedIds.length } },
    });
  });
  return loadPresented(id);
}

// ---------- Lost reasons ----------

export async function listLostReasons(req, { unitId, companyId, kind, includeInactive = false }) {
  const companies = await configCompanies(req, { unitId, companyId }, VIEW);
  if (companies.length === 0) return [];
  const rows = await db('lost_reasons')
    .whereIn('company_id', companies.map((company) => company.id))
    .modify((query) => {
      if (kind) query.where((w) => w.where('kind', kind).orWhereNull('kind'));
      if (!includeInactive) query.where('active', true);
    })
    .limit(1000);
  return sortByCompany(rows, companies, byPosition).map(presentLostReason);
}

const LOST_REASON_FIELDS = ['label', 'kind', 'requiresNote', 'position', 'active'];
const auditLostReason = (row) => ({ label: row.label, kind: row.kind, requiresNote: row.requires_note, position: row.position, active: row.active });

export async function createLostReason(req, body) {
  return db.transaction(async (trx) => {
    const company = await requireManagedCompany(req, body.companyId, MANAGE, { trx });
    if (await trx('lost_reasons').where({ company_id: company.id, label: body.label }).first()) {
      throw errors.conflict(LOST_REASON_CONFLICTS.lost_reasons_label_uq);
    }
    const [row] = await withUniqueConflicts(LOST_REASON_CONFLICTS, async () =>
      trx('lost_reasons')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          label: body.label,
          kind: body.kind,
          requires_note: body.requiresNote,
          position: body.position ?? (await nextPosition(trx, 'lost_reasons', { company_id: company.id })),
        })
        .returning('*'),
    );
    await recordChange(trx, req, {
      company,
      action: 'lost_reason.created',
      entityType: 'lost_reason',
      entityId: row.id,
      after: auditLostReason(row),
      event: { payload: { lostReasonId: row.id, companyId: company.id } },
    });
    return presentLostReason(row);
  });
}

export async function updateLostReason(req, id, body) {
  return db.transaction(async (trx) => {
    const { row, company } = await loadConfigRow(req, { table: 'lost_reasons', id, view: VIEW, manage: MANAGE, notFound: 'Lost reason', trx, forUpdate: true });
    const input = pick(body, LOST_REASON_FIELDS);
    if (input.label !== undefined && input.label.toLowerCase() !== row.label.toLowerCase()) {
      const clash = await trx('lost_reasons').where({ company_id: company.id, label: input.label }).whereNot({ id }).first();
      if (clash) throw errors.conflict(LOST_REASON_CONFLICTS.lost_reasons_label_uq);
    }
    const patch = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.requiresNote !== undefined) patch.requires_note = input.requiresNote;
    if (input.position !== undefined) patch.position = input.position;
    if (input.active !== undefined) patch.active = input.active;
    if (Object.keys(patch).length === 0) return presentLostReason(row);

    const [updated] = await withUniqueConflicts(LOST_REASON_CONFLICTS, () =>
      trx('lost_reasons').where({ id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*'),
    );
    const before = auditLostReason(row);
    const after = auditLostReason(updated);
    await recordChange(trx, req, {
      company,
      action: 'lost_reason.updated',
      entityType: 'lost_reason',
      entityId: id,
      before,
      after,
      event: { payload: { lostReasonId: id, companyId: company.id, changes: changedKeys(before, after) } },
    });
    return presentLostReason(updated);
  });
}
