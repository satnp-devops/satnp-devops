import { customFieldRef } from '../../core/crm/customFields.js';

// Pure rules for custom field definitions (docs/crm/PHASE2_CONTRACT.md §9.5), unit tested in
// test/config/fieldRules.test.js. Creation is checked by customFieldDefinitionSchema
// (core/crm/customFields.js); these check the definition a PATCH would produce.

export const CHOICE_TYPES = Object.freeze(['select', 'multiselect']);
export const MAX_ACTIVE_FIELDS = 100;

export const isChoiceType = (type) => CHOICE_TYPES.includes(type);

/**
 * Errors in a definition as it would be stored: options only (and at least one) for select types,
 * unique option values, appliesTo only on deal fields.
 * @param {{ entity: string, type: string, options: Array<{ value: string }>, appliesTo: string | null }} definition
 */
export function definitionErrors({ entity, type, options, appliesTo }, path = 'body') {
  const errors = [];
  if (isChoiceType(type) && options.length === 0) errors.push({ path: `${path}.options`, message: 'Add at least one option' });
  if (!isChoiceType(type) && options.length > 0) errors.push({ path: `${path}.options`, message: 'Only select fields have options' });
  const values = options.map((option) => option.value);
  if (new Set(values).size !== values.length) errors.push({ path: `${path}.options`, message: 'Option values must be different' });
  if (appliesTo && entity !== 'deal') errors.push({ path: `${path}.appliesTo`, message: 'Only deal fields can be limited to B2C or B2B' });
  return errors;
}

/**
 * The definition a PATCH produces from the stored row. Switching to a type without options
 * drops the old options unless the request sends some (which is then an error).
 */
export function mergedDefinition(row, patch) {
  const type = patch.type ?? row.type;
  let options = patch.options ?? row.options ?? [];
  if (patch.type && patch.options === undefined && !isChoiceType(type)) options = [];
  return {
    entity: row.entity,
    key: row.key,
    type,
    label: patch.label ?? row.label,
    options,
    required: patch.required ?? row.required,
    appliesTo: patch.appliesTo !== undefined ? patch.appliesTo : (row.applies_to ?? null),
    help: patch.help !== undefined ? patch.help : (row.help ?? null),
    position: patch.position ?? row.position,
    active: patch.active ?? row.active,
  };
}

/** Stages (rows with required_fields) that require a custom deal field. */
export const stagesRequiring = (stages, key) => stages.filter((stage) => (stage.required_fields ?? []).includes(customFieldRef(key)));

/**
 * Why a change to a deal field would break stage rules, or null. Stages are rows of the company's
 * active stages with `pipeline_kind` and `pipeline_name`.
 *   deactivating: a stage requires it (deals could never fill it)
 *   limiting to one kind: a pipeline of the other kind requires it
 */
export function stageConflict(row, next, stages) {
  if (row.entity !== 'deal') return null;
  const requiring = stagesRequiring(stages, row.key);
  const describeStages = (list) => list.map((stage) => `${stage.pipeline_name} › ${stage.name}`).join(', ');
  if (row.active && next.active === false && requiring.length) {
    return { message: `Stages require ${row.label}: ${describeStages(requiring)}. Remove it from their required fields first.`, stages: requiring };
  }
  if (next.appliesTo && next.appliesTo !== row.applies_to) {
    const other = requiring.filter((stage) => stage.pipeline_kind !== next.appliesTo);
    if (other.length) {
      return { message: `${describeStages(other)} require ${row.label}, so it must stay available to ${other[0].pipeline_kind.toUpperCase()} deals.`, stages: other };
    }
  }
  return null;
}

/**
 * The full order after PUT /custom-fields/order: the listed ids first, in the given order, then
 * the others in their current order. Errors for ids that aren't the company's fields of the entity.
 * @param {Array<{ id: string, position: number, label: string }>} rows the current definitions
 */
export function orderFields(rows, ids, path = 'body.ids') {
  const known = new Set(rows.map((row) => row.id));
  const errors = [];
  const seen = new Set();
  ids.forEach((id, index) => {
    if (!known.has(id)) errors.push({ path: `${path}.${index}`, message: 'Not a custom field of this company and record type' });
    else if (seen.has(id)) errors.push({ path: `${path}.${index}`, message: 'This field is listed twice' });
    seen.add(id);
  });
  const rest = rows
    .filter((row) => !seen.has(row.id))
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map((row) => row.id);
  return { errors, order: [...ids.filter((id) => known.has(id)), ...rest] };
}
