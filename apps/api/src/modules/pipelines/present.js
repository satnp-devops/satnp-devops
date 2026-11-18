import { toIso } from './configAccess.js';

// Row → API shapes of apps/web/src/lib/crm/types.ts (Pipeline, Stage, LostReason).
// Stages may come from json_agg (text timestamps), so times go through toIso.

export function presentStage(row) {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    key: row.key,
    name: row.name,
    category: row.category,
    colour: row.colour ?? null,
    position: row.position,
    probability: row.probability,
    slaHours: row.sla_hours ?? null,
    requiredFields: row.required_fields ?? [],
    entryRules: row.entry_rules?.allowedFrom?.length ? { allowedFrom: row.entry_rules.allowedFrom } : {},
    archivedAt: toIso(row.archived_at),
  };
}

/** Archived stages after active ones, each by position. */
export const stageOrder = (a, b) =>
  Number(Boolean(a.archived_at)) - Number(Boolean(b.archived_at)) || a.position - b.position || a.name.localeCompare(b.name);

export function presentPipeline(row, stages = row.stages ?? []) {
  return {
    id: row.id,
    companyId: row.company_id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    isDefault: row.is_default === true,
    productLineIds: row.product_line_ids ?? [],
    position: row.position,
    archivedAt: toIso(row.archived_at),
    stages: [...stages].sort(stageOrder).map(presentStage),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function presentLostReason(row) {
  return {
    id: row.id,
    label: row.label,
    companyId: row.company_id,
    kind: row.kind ?? null,
    requiresNote: row.requires_note === true,
    position: row.position,
    active: row.active === true,
  };
}
