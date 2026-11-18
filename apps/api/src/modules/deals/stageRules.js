import { customFieldKeyOf, isFilled } from '../../core/crm/customFields.js';
import { DEAL_REQUIRED_FIELDS } from '../../core/crm/dealFields.js';

// The stage-rule evaluator (docs/crm/PHASE2_CONTRACT.md §12.1). Pure: the service loads the rows
// and turns a failure into 422 "stage_rules". Used by create, move, win, lose, reopen and bulk move.
//
// Rules, in order:
//   1. the target stage belongs to the deal's pipeline and isn't archived
//   2. entry_rules.allowedFrom (stage keys) when moving (not on create or reopen)
//   3. every required field of the target stage is filled (stages the deal skips aren't checked)

const BUILT_IN = new Map(DEAL_REQUIRED_FIELDS.map((field) => [field.key, field.label]));

/** How each built-in required field is read from the deal row and the facts. */
const FILLED = {
  productLineId: ({ deal }) => Boolean(deal.product_line_id),
  productId: ({ deal }) => Boolean(deal.product_id),
  ownerUserId: ({ deal }) => Boolean(deal.owner_user_id),
  valueMinor: ({ deal }) => Number(deal.value_minor ?? 0) > 0,
  expectedCloseOn: ({ deal }) => Boolean(deal.expected_close_on),
  primaryContactId: ({ deal }) => Boolean(deal.primary_contact_id),
  householdId: ({ deal }) => Boolean(deal.household_id),
  accountId: ({ deal }) => Boolean(deal.account_id),
  students: ({ facts }) => Number(facts?.studentCount ?? 0) > 0,
  contactPhone: ({ facts }) => facts?.contactHasPhone === true,
  contactEmail: ({ facts }) => facts?.contactHasEmail === true,
};

/**
 * The required fields of a stage that the deal hasn't filled, with their labels.
 * Custom fields whose definition is missing or inactive are ignored (nobody could fill them),
 * and so are unknown keys (the config slice rejects them when the stage is saved).
 */
export function missingRequiredFields({ deal, toStage, facts, customDefinitions = [] }) {
  const definitions = new Map(customDefinitions.map((definition) => [definition.key, definition]));
  const missing = [];
  for (const key of toStage.required_fields ?? []) {
    const customKey = customFieldKeyOf(key);
    if (customKey) {
      const definition = definitions.get(customKey);
      if (!definition || definition.active === false) continue;
      if (definition.applies_to && deal.kind && definition.applies_to !== deal.kind) continue;
      if (!isFilled(deal.custom?.[customKey])) missing.push({ key, label: definition.label });
      continue;
    }
    const filled = FILLED[key];
    if (!filled) continue;
    if (!filled({ deal, facts })) missing.push({ key, label: BUILT_IN.get(key) ?? key });
  }
  return missing;
}

/**
 * @param {{
 *   deal: { kind: string, pipeline_id?: string, stage_id: string | null, status?: string, product_line_id?: string | null,
 *           product_id?: string | null, owner_user_id?: string | null, value_minor?: number | string,
 *           expected_close_on?: string | null, primary_contact_id?: string | null, household_id?: string | null,
 *           account_id?: string | null, custom?: Record<string, unknown> },
 *   fromStage: object | null,
 *   toStage: object,
 *   pipelineStages: object[],
 *   facts: { studentCount: number, contactHasPhone: boolean, contactHasEmail: boolean },
 *   customDefinitions: object[],
 *   mode: 'create' | 'move' | 'reopen',
 * }} input
 * @returns {{ ok: boolean, missing: Array<{ key: string, label: string }>, allowedFrom: string[] | null,
 *             reason: null | 'other_pipeline' | 'archived_stage' | 'not_allowed_from' | 'missing_fields' }}
 */
export function evaluateStageMove({ deal, fromStage = null, toStage, pipelineStages = [], facts, customDefinitions = [], mode = 'move' }) {
  if (!toStage) throw new TypeError('evaluateStageMove needs the target stage');
  const pipelineId = deal.pipeline_id ?? fromStage?.pipeline_id ?? pipelineStages[0]?.pipeline_id ?? toStage.pipeline_id;
  const inPipeline =
    toStage.pipeline_id === pipelineId && (pipelineStages.length === 0 || pipelineStages.some((stage) => stage.id === toStage.id));
  if (!inPipeline) return { ok: false, missing: [], allowedFrom: null, reason: 'other_pipeline' };
  if (toStage.archived_at) return { ok: false, missing: [], allowedFrom: null, reason: 'archived_stage' };

  const missing = missingRequiredFields({ deal, toStage, facts, customDefinitions });
  const allowed = toStage.entry_rules?.allowedFrom ?? [];
  if (mode === 'move' && allowed.length > 0 && !(fromStage && allowed.includes(fromStage.key))) {
    return { ok: false, missing, allowedFrom: allowed, reason: 'not_allowed_from' };
  }
  if (missing.length > 0) return { ok: false, missing, allowedFrom: null, reason: 'missing_fields' };
  return { ok: true, missing: [], allowedFrom: null, reason: null };
}

/** "Product, Value and Student" */
function joinWords(words, last = 'and') {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}`;
}

/**
 * A sentence for a failed evaluation, e.g. "Fill Product and Value to move to Fee proposed" or
 * "Enrolled can only be reached from Demo done or Fee proposed".
 */
export function stageRulesMessage(result, toStage, pipelineStages = []) {
  switch (result.reason) {
    case 'other_pipeline':
      return `${toStage.name} is a stage of another pipeline`;
    case 'archived_stage':
      return `${toStage.name} is archived`;
    case 'not_allowed_from': {
      const names = (result.allowedFrom ?? []).map((key) => pipelineStages.find((stage) => stage.key === key)?.name ?? key);
      return `${toStage.name} can only be reached from ${joinWords(names, 'or')}`;
    }
    case 'missing_fields':
      return `Fill ${joinWords(result.missing.map((field) => field.label))} to move to ${toStage.name}`;
    default:
      return '';
  }
}
