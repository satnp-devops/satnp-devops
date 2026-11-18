import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import { CUSTOM_FIELD_ENTITIES } from '../../core/crm/constants.js';
import { customFieldDefinitionSchema, presentCustomFieldDefinition } from '../../core/crm/customFields.js';
import {
  changedKeys,
  configCompanies,
  loadConfigRow,
  nextPosition,
  recordChange,
  requireManagedCompany,
  sortByCompany,
  withUniqueConflicts,
} from '../pipelines/configAccess.js';
import { MAX_ACTIVE_FIELDS, definitionErrors, mergedDefinition, orderFields, stageConflict } from './rules.js';

// Custom field definitions per company and record type (docs/crm/PHASE2_CONTRACT.md §9.5).
// Values are written by the record owners through validateCustomValues (core/crm/customFields.js).

const VIEW = 'fields.view';
const MANAGE = 'fields.manage';
const CONFLICTS = { custom_field_definitions_key_uq: 'Another field of this record type already uses this key' };

/** Where each record type keeps its custom values, per company. */
const VALUE_TABLES = { deal: 'deals', contact: 'contact_companies', account: 'account_companies' };

const entityOrder = (entity) => CUSTOM_FIELD_ENTITIES.indexOf(entity);

const auditField = (row) => ({
  entity: row.entity,
  key: row.key,
  label: row.label,
  type: row.type,
  options: row.options,
  required: row.required,
  appliesTo: row.applies_to,
  help: row.help,
  position: row.position,
  active: row.active,
});

/** Columns of a merged definition (options still as an array). */
const columnsOf = (next) => ({
  type: next.type,
  label: next.label,
  options: next.options,
  required: next.required,
  applies_to: next.appliesTo,
  help: next.help,
  position: next.position,
  active: next.active,
});

const activeCount = async (trx, companyId, entity) =>
  Number((await trx('custom_field_definitions').where({ company_id: companyId, entity, active: true }).count('* as n').first())?.n ?? 0);

/** Does any record of the company store a value for this field? (jsonb_exists avoids the ? operator.) */
async function hasStoredValues(trx, companyId, entity, key) {
  const row = await trx(VALUE_TABLES[entity]).where({ company_id: companyId }).whereRaw('jsonb_exists(custom, ?)', [key]).first(trx.raw('1 as found'));
  return Boolean(row);
}

/** The company's active stages that could require a custom deal field, with their pipeline. */
const companyStages = (trx, companyId) =>
  trx('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where('s.company_id', companyId)
    .whereNull('s.archived_at')
    .whereNull('p.archived_at')
    .select('s.id', 's.name', 's.required_fields', 'p.name as pipeline_name', 'p.kind as pipeline_kind');

export async function listCustomFields(req, { unitId, companyId, entity, includeInactive = false }) {
  const companies = await configCompanies(req, { unitId, companyId }, VIEW);
  if (companies.length === 0) return [];
  const rows = await db('custom_field_definitions')
    .whereIn('company_id', companies.map((company) => company.id))
    .modify((query) => {
      if (entity) query.where('entity', entity);
      if (!includeInactive) query.where('active', true);
    })
    .limit(1000);
  return sortByCompany(
    rows,
    companies,
    (a, b) => entityOrder(a.entity) - entityOrder(b.entity) || a.position - b.position || a.label.localeCompare(b.label),
  ).map(presentCustomFieldDefinition);
}

export async function createCustomField(req, body) {
  const { companyId, ...rest } = body;
  // The cross-field rules (options only for select types, appliesTo only on deals) live in the shared schema.
  const input = parseOrThrow(customFieldDefinitionSchema, rest, 'body');
  return db.transaction(async (trx) => {
    const company = await requireManagedCompany(req, companyId, MANAGE, { trx });
    if (await trx('custom_field_definitions').where({ company_id: company.id, entity: input.entity, key: input.key }).first()) {
      throw errors.conflict(CONFLICTS.custom_field_definitions_key_uq);
    }
    if ((await activeCount(trx, company.id, input.entity)) >= MAX_ACTIVE_FIELDS) {
      throw errors.conflict(`A record type can have at most ${MAX_ACTIVE_FIELDS} active custom fields. Deactivate one first.`);
    }
    const [row] = await withUniqueConflicts(CONFLICTS, async () =>
      trx('custom_field_definitions')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          entity: input.entity,
          key: input.key,
          label: input.label,
          type: input.type,
          options: json(input.options),
          required: input.required,
          applies_to: input.appliesTo,
          help: input.help,
          position: input.position ?? (await nextPosition(trx, 'custom_field_definitions', { company_id: company.id, entity: input.entity })),
          created_by: req.auth.user.id,
        })
        .returning('*'),
    );
    await recordChange(trx, req, {
      company,
      action: 'custom_field.created',
      entityType: 'custom_field',
      entityId: row.id,
      after: auditField(row),
      event: { payload: { definitionId: row.id, companyId: company.id, entity: row.entity, key: row.key } },
    });
    return presentCustomFieldDefinition(row);
  });
}

export async function updateCustomField(req, id, body) {
  return db.transaction(async (trx) => {
    const { row, company } = await loadConfigRow(req, {
      table: 'custom_field_definitions',
      id,
      view: VIEW,
      manage: MANAGE,
      notFound: 'Custom field',
      trx,
      forUpdate: true,
    });
    const next = mergedDefinition(row, body);
    const problems = definitionErrors(next);
    if (problems.length) throw errors.validation(problems);

    if (next.type !== row.type && (await hasStoredValues(trx, company.id, row.entity, row.key))) {
      throw errors.conflict(`Records already have values for ${row.label}, so its type can't change. Add a new field instead.`);
    }
    if (row.entity === 'deal' && (next.active === false || next.appliesTo)) {
      const conflict = stageConflict(row, next, await companyStages(trx, company.id));
      if (conflict) throw errors.conflict(conflict.message, { stageIds: conflict.stages.map((stage) => stage.id) });
    }
    if (!row.active && next.active && (await activeCount(trx, company.id, row.entity)) >= MAX_ACTIVE_FIELDS) {
      throw errors.conflict(`A record type can have at most ${MAX_ACTIVE_FIELDS} active custom fields. Deactivate one first.`);
    }

    const before = auditField(row);
    const changes = changedKeys(before, auditField({ ...row, ...columnsOf(next) }));
    if (changes.length === 0) return presentCustomFieldDefinition(row);
    const patch = { ...columnsOf(next), options: json(next.options) };
    const [updated] = await trx('custom_field_definitions').where({ id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
    const after = auditField(updated);
    await recordChange(trx, req, {
      company,
      action: 'custom_field.updated',
      entityType: 'custom_field',
      entityId: id,
      before,
      after,
      event: { payload: { definitionId: id, companyId: company.id, changes } },
    });
    return presentCustomFieldDefinition(updated);
  });
}

export async function reorderCustomFields(req, { companyId, entity, ids }) {
  return db.transaction(async (trx) => {
    const company = await requireManagedCompany(req, companyId, MANAGE, { trx });
    const rows = await trx('custom_field_definitions').where({ company_id: company.id, entity }).forUpdate();
    const { errors: problems, order } = orderFields(rows, ids);
    if (problems.length) throw errors.validation(problems);
    await trx.raw(
      `update custom_field_definitions d set position = v.position, updated_at = now()
         from unnest(?::uuid[], ?::int[]) as v(id, position)
        where d.id = v.id and d.position <> v.position`,
      [order, order.map((_, index) => index)],
    );
    const keyOf = new Map(rows.map((row) => [row.id, row.key]));
    const before = [...rows].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label)).map((row) => row.key);
    await recordChange(trx, req, {
      company,
      action: 'custom_field.reordered',
      entityType: 'custom_field',
      entityId: company.id,
      before: { order: before },
      after: { order: order.map((fieldId) => keyOf.get(fieldId)) },
      meta: { entity },
      event: { payload: { companyId: company.id, entity } },
    });
    const updated = await trx('custom_field_definitions').where({ company_id: company.id, entity });
    const position = new Map(order.map((fieldId, index) => [fieldId, index]));
    return updated.sort((a, b) => position.get(a.id) - position.get(b.id)).map(presentCustomFieldDefinition);
  });
}
