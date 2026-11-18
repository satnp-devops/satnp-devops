import { z } from 'zod';
import { errors } from '../../lib/errors.js';
import { toFieldErrors } from '../../lib/validate.js';
import { webUrlSchema } from '../../lib/schemas.js';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, DEAL_KINDS } from './constants.js';
import { normalizeEmail, normalizePhone } from './normalize.js';
import { maskEmail, maskPhone } from './pii.js';
import { dateOnlySchema, keySchema } from './schemas.js';

// Custom fields are rows in custom_field_definitions (per company, per entity). Values live in a
// JSONB `custom` column keyed by the field key:
//   deal    → deals.custom
//   contact → contact_companies.custom   (company-specific facts about a shared person)
//   account → account_companies.custom
// Stage rules refer to them as "custom.<key>".

const optionSchema = z.strictObject({
  value: keySchema,
  label: z.string().trim().min(1).max(80),
});

/** Body of POST /custom-fields (the fields module adds companyId). */
export const customFieldDefinitionSchema = z
  .strictObject({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    key: keySchema,
    label: z.string().trim().min(1, 'Give the field a label').max(80),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(optionSchema).max(100).default([]),
    required: z.boolean().default(false),
    appliesTo: z.enum(DEAL_KINDS).nullable().default(null),
    help: z.string().trim().max(300).nullable().default(null),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .superRefine((value, ctx) => {
    const choice = value.type === 'select' || value.type === 'multiselect';
    if (choice && value.options.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one option' });
    }
    if (!choice && value.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only select fields have options' });
    }
    const values = value.options.map((o) => o.value);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option values must be different' });
    }
    if (value.appliesTo !== null && value.entity !== 'deal') {
      ctx.addIssue({ code: 'custom', path: ['appliesTo'], message: 'Only deal fields can be limited to B2C or B2B' });
    }
  });

/** Is a stored value "filled in" for required checks? */
export function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The zod schema for one field's value. `null` always clears a value.
 * @param {{ type: string, options?: Array<{ value: string }>, label: string }} definition
 */
export function valueSchemaFor(definition, { defaultCountry = 'IN' } = {}) {
  const options = (definition.options ?? []).map((option) => option.value);
  switch (definition.type) {
    case 'text':
      return z.string().trim().max(500);
    case 'textarea':
      return z.string().trim().max(5000);
    case 'number':
      // Forms send numbers as text; "12" and 12 are both accepted.
      return z.coerce.number({ error: 'Enter a number' }).finite();
    case 'date':
      return dateOnlySchema;
    case 'boolean':
      return z.boolean();
    case 'select':
      return options.length
        ? z.enum(options, { error: `Pick one of the ${definition.label} options` })
        : z.never({ error: 'This field has no options yet' });
    case 'multiselect':
      return options.length
        ? z
            .array(z.enum(options, { error: `Pick from the ${definition.label} options` }))
            .max(100)
            .transform((values) => [...new Set(values)])
        : z.never({ error: 'This field has no options yet' });
    case 'phone':
      return z.string().transform((value, ctx) => {
        const phone = normalizePhone(value, defaultCountry);
        if (!phone) {
          ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
          return z.NEVER;
        }
        return phone.e164;
      });
    case 'email':
      return z.string().transform((value, ctx) => {
        const email = normalizeEmail(value);
        if (!email) {
          ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' });
          return z.NEVER;
        }
        return email;
      });
    case 'url':
      return webUrlSchema;
    default:
      throw new Error(`Unknown custom field type "${definition.type}"`);
  }
}

/** Definitions that apply to a record: active, and for deals matching the deal kind. */
export function applicableDefinitions(definitions, { kind } = {}) {
  return definitions.filter((d) => d.active !== false && (!kind || !d.applies_to || d.applies_to === kind));
}

/**
 * Build a strict zod object for the `custom` values of a record.
 *   partial          every key optional (PATCH bodies)
 *   enforceRequired  required fields must be filled (user-made creates and updates; system intake skips it)
 * Unknown keys and keys of inactive fields are rejected.
 * @param {Array<{ key: string, type: string, label: string, required?: boolean, active?: boolean, applies_to?: string | null, options?: Array<{ value: string }> }>} definitions
 */
export function buildCustomFieldsSchema(definitions, { partial = false, enforceRequired = true, kind, defaultCountry } = {}) {
  const applicable = applicableDefinitions(definitions, { kind });
  const shape = {};
  for (const definition of applicable) {
    // An empty string from a form clears the value, like null.
    shape[definition.key] = z.preprocess(
      (value) => (value === '' ? null : value),
      valueSchemaFor(definition, { defaultCountry }).nullable().optional(),
    );
  }
  const object = z.strictObject(shape);
  if (partial || !enforceRequired) return object;
  return object.superRefine((value, ctx) => {
    for (const definition of applicable) {
      if (definition.required && !isFilled(value[definition.key])) {
        ctx.addIssue({ code: 'custom', path: [definition.key], message: `${definition.label} is required` });
      }
    }
  });
}

/**
 * Validate custom values against a company's definitions and merge them over the stored values.
 * Returns the object to store (null values remove the key). Throws a 422 with paths like
 * "body.custom.grade" when something is wrong.
 *
 * @param {Array<object>} definitions rows of custom_field_definitions for the company and entity
 * @param {Record<string, unknown> | undefined} values incoming values (e.g. req.valid.body.custom)
 * @param {{ existing?: Record<string, unknown>, enforceRequired?: boolean, kind?: 'b2c' | 'b2b', defaultCountry?: string, path?: string }} [options]
 */
export function validateCustomValues(definitions, values, options = {}) {
  const { existing = {}, enforceRequired = true, kind, defaultCountry, path = 'body.custom' } = options;
  const schema = buildCustomFieldsSchema(definitions, { partial: true, kind, defaultCountry });
  const parsed = schema.safeParse(values ?? {});
  if (!parsed.success) throw errors.validation(toFieldErrors(parsed.error, path));

  const merged = { ...existing };
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  if (enforceRequired) {
    const missing = applicableDefinitions(definitions, { kind }).filter((d) => d.required && !isFilled(merged[d.key]));
    if (missing.length > 0) {
      throw errors.validation(missing.map((d) => ({ path: `${path}.${d.key}`, message: `${d.label} is required` })));
    }
  }
  return merged;
}

// ---------- Personal data in custom fields ----------

/** Custom field types whose values are personal data, masked like a contact's phones and emails (contract §4.1 rule 5). */
export const PII_CUSTOM_FIELD_TYPES = Object.freeze(['phone', 'email']);

const maskCustomValue = (type, value) => (type === 'email' ? maskEmail(String(value)) : maskPhone(String(value))) ?? '••••';

/**
 * The phone and email field definitions ({ company_id, key, type }) of one or more companies for an
 * entity, archived ones included (their values stay on records). Pass the knex instance or transaction.
 */
export function piiCustomDefinitions(knex, companyIds, entity) {
  const ids = [...new Set([companyIds].flat().filter(Boolean))];
  if (ids.length === 0) return Promise.resolve([]);
  return knex('custom_field_definitions').whereIn('company_id', ids).where({ entity }).whereIn('type', PII_CUSTOM_FIELD_TYPES).select('company_id', 'key', 'type');
}

/**
 * Custom values as a viewer without contacts.view_pii sees them: phone and email fields masked,
 * everything else as stored. Pure.
 * @param {Record<string, unknown> | null | undefined} values
 * @param {Array<{ key: string, type: string }>} definitions the record's company and entity
 */
export function maskCustomPii(values, definitions) {
  const out = { ...(values ?? {}) };
  for (const definition of definitions) {
    if (!PII_CUSTOM_FIELD_TYPES.includes(definition.type)) continue;
    const value = out[definition.key];
    if (value === undefined || value === null || value === '') continue;
    out[definition.key] = maskCustomValue(definition.type, value);
  }
  return out;
}

/**
 * A custom-values patch from a viewer without contacts.view_pii, minus the phone and email fields
 * they sent back exactly as masked (the value they were shown is not an edit). Pure.
 */
export function withoutMaskedEchoes(patch, existing, definitions) {
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...patch };
  for (const definition of definitions) {
    if (!PII_CUSTOM_FIELD_TYPES.includes(definition.type)) continue;
    const stored = existing?.[definition.key];
    if (stored === undefined || stored === null || stored === '') continue;
    if (typeof out[definition.key] === 'string' && out[definition.key] === maskCustomValue(definition.type, stored)) delete out[definition.key];
  }
  return out;
}

/** Key used in pipeline_stages.required_fields for a custom field. */
export const customFieldRef = (key) => `custom.${key}`;

/** "custom.grade" → "grade"; anything else → null. */
export const customFieldKeyOf = (ref) => (typeof ref === 'string' && ref.startsWith('custom.') ? ref.slice(7) : null);

/** Present a definition row for the API. */
export function presentCustomFieldDefinition(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options ?? [],
    required: row.required === true,
    appliesTo: row.applies_to ?? null,
    help: row.help ?? null,
    position: row.position,
    active: row.active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
