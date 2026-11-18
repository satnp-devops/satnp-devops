import { STAGE_CATEGORIES } from '../../core/crm/constants.js';
import { customFieldKeyOf, customFieldRef } from '../../core/crm/customFields.js';
import { DEAL_REQUIRED_FIELDS, unknownRequiredFields } from '../../core/crm/dealFields.js';

// Pure validation of a pipeline's stage settings (docs/crm/PHASE2_CONTRACT.md §9.3 and §12).
// Every function returns field errors ({ path, message }) or plain data, so the rules are unit
// tested without a database (test/config/pipelineRules.test.js).

/** Built-in deal fields that only one kind of deal has (deal create: accountId is b2b only, students and household b2c). */
export const KIND_ONLY_FIELDS = Object.freeze({ accountId: 'b2b', students: 'b2c', householdId: 'b2c' });

const MISSING_CATEGORY = {
  open: 'Add at least one open stage',
  won: 'Add at least one won stage',
  lost: 'Add at least one lost stage',
};

const KIND_LABEL = { b2c: 'B2C', b2b: 'B2B' };

const unique = (values) => [...new Set(values)];

/** Drop repeated required fields and entry-rule keys; stage inputs keep their order. */
export function normalizeStage(stage) {
  const out = { ...stage };
  if (stage.requiredFields) out.requiredFields = unique(stage.requiredFields);
  if (stage.entryRules) {
    out.entryRules = stage.entryRules.allowedFrom?.length ? { allowedFrom: unique(stage.entryRules.allowedFrom) } : {};
  }
  return out;
}

/** The custom deal fields a stage may require: active ones. */
const activeDealFields = (definitions) => definitions.filter((d) => d.entity === 'deal' && d.active !== false);

/**
 * Check a pipeline's active stages as a whole.
 * @param {Array<{ key: string, category: string, requiredFields?: string[], entryRules?: { allowedFrom?: string[] } }>} stages in order
 * @param {{ kind?: 'b2c' | 'b2b', customDefinitions?: object[], path?: string }} options
 *   customDefinitions: the company's custom field rows (only active deal fields can be required)
 * @returns {Array<{ path: string, message: string }>}
 */
export function stageSetErrors(stages, { kind, customDefinitions = [], path = 'body.stages' } = {}) {
  const errors = [];
  const fields = activeDealFields(customDefinitions);
  const fieldByRef = new Map(fields.map((definition) => [customFieldRef(definition.key), definition]));

  const firstIndex = new Map();
  stages.forEach((stage, index) => {
    if (firstIndex.has(stage.key)) {
      errors.push({ path: `${path}.${index}.key`, message: `Another stage already uses the key "${stage.key}"` });
    } else {
      firstIndex.set(stage.key, index);
    }
  });

  for (const category of STAGE_CATEGORIES) {
    if (!stages.some((stage) => stage.category === category)) errors.push({ path, message: MISSING_CATEGORY[category] });
  }

  stages.forEach((stage, index) => {
    const required = stage.requiredFields ?? [];
    const unknown = new Set(unknownRequiredFields(required, fields));
    required.forEach((ref, position) => {
      const at = `${path}.${index}.requiredFields.${position}`;
      if (unknown.has(ref)) {
        errors.push({ path: at, message: customFieldKeyOf(ref) ? 'No active custom deal field has this key' : 'Unknown deal field' });
        return;
      }
      const only = KIND_ONLY_FIELDS[ref] ?? fieldByRef.get(ref)?.applies_to ?? null;
      if (kind && only && only !== kind) {
        errors.push({ path: at, message: `Only ${KIND_LABEL[only]} deals have this field, so a ${KIND_LABEL[kind]} deal could never enter this stage` });
      }
    });

    (stage.entryRules?.allowedFrom ?? []).forEach((key, position) => {
      const at = `${path}.${index}.entryRules.allowedFrom.${position}`;
      if (key === stage.key) errors.push({ path: at, message: "A stage can't be entered from itself" });
      else if (!firstIndex.has(key)) errors.push({ path: at, message: `No stage in this pipeline has the key "${key}"` });
    });
  });
  return errors;
}

/**
 * Errors about one stage of a set, re-rooted for a single-stage request:
 * "body.stages.2.requiredFields.0" becomes "body.requiredFields.0". Set-level errors are kept as "body".
 */
export function errorsForStage(errors, index, { from = 'body.stages', to = 'body' } = {}) {
  const prefix = `${from}.${index}.`;
  return errors
    .filter((error) => error.path === from || error.path.startsWith(prefix))
    .map((error) => ({ ...error, path: error.path === from ? to : `${to}.${error.path.slice(prefix.length)}` }));
}

/** Where a new stage goes by default: just before the first won stage (else at the end). */
export function defaultStagePosition(stages) {
  const index = stages.findIndex((stage) => stage.category === 'won');
  return index === -1 ? stages.length : index;
}

/** A copy of `items` with `item` inserted at `position` (clamped to the list). */
export function insertAt(items, item, position) {
  const at = Math.max(0, Math.min(position ?? items.length, items.length));
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/**
 * Check a requested order (PUT /pipelines/:id/stages/order): every active stage exactly once.
 * @returns {Array<{ path: string, message: string }>}
 */
export function stageOrderErrors(activeIds, stageIds, path = 'body.stageIds') {
  const errors = [];
  const known = new Set(activeIds);
  const seen = new Set();
  stageIds.forEach((id, index) => {
    if (!known.has(id)) errors.push({ path: `${path}.${index}`, message: 'This is not an active stage of the pipeline' });
    else if (seen.has(id)) errors.push({ path: `${path}.${index}`, message: 'This stage is listed twice' });
    seen.add(id);
  });
  const missing = activeIds.filter((id) => !seen.has(id)).length;
  if (missing > 0) errors.push({ path, message: `List every active stage once (${missing} missing)` });
  return errors;
}

/**
 * What archiving a stage does to the other stages' entry rules: its key is removed from their
 * `allowedFrom`. A stage that could only be entered from the archived one would become reachable
 * from anywhere, so it blocks the archive instead.
 * @returns {{ updates: Array<{ id: string, entryRules: object }>, blockedBy: object[] }}
 */
export function entryRulesWithout(stages, key) {
  const updates = [];
  const blockedBy = [];
  for (const stage of stages) {
    const allowed = stage.entry_rules?.allowedFrom ?? [];
    if (!allowed.includes(key)) continue;
    const rest = allowed.filter((item) => item !== key);
    if (rest.length === 0) blockedBy.push(stage);
    else updates.push({ id: stage.id, entryRules: { ...stage.entry_rules, allowedFrom: rest } });
  }
  return { updates, blockedBy };
}

/**
 * Can this stage be archived? The last active stage of its category can't (409).
 * @returns {string | null} the reason it can't, or null
 */
export function archiveStageBlocker(stage, activeStages) {
  const sameCategory = activeStages.filter((other) => other.category === stage.category && other.id !== stage.id);
  if (sameCategory.length === 0) return `${stage.name} is the only ${stage.category} stage. Add another ${stage.category} stage first.`;
  return null;
}

/** Choices for a stage's required fields, optionally limited to what deals of one kind can have. */
export function requiredFieldChoices(customDefinitions, kind) {
  const fields = activeDealFields(customDefinitions).filter((d) => !kind || !d.applies_to || d.applies_to === kind);
  return [
    ...DEAL_REQUIRED_FIELDS.filter(({ key }) => !kind || !KIND_ONLY_FIELDS[key] || KIND_ONLY_FIELDS[key] === kind).map(
      ({ key, label }) => ({ key, label, source: 'deal' }),
    ),
    ...fields.map((d) => ({ key: customFieldRef(d.key), label: d.label, source: 'custom' })),
  ];
}
