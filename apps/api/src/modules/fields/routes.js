import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, DEAL_KINDS } from '../../core/crm/constants.js';
import { customFieldDefinitionSchema } from '../../core/crm/customFields.js';
import { booleanQuery, keySchema } from '../../core/crm/schemas.js';
import { configScopeShape, exactlyOneScope } from '../pipelines/configAccess.js';
import { createCustomField, listCustomFields, reorderCustomFields, updateCustomField } from './service.js';

// docs/crm/PHASE2_CONTRACT.md §9.5: custom field definitions per company and record type.

const optionSchema = z.strictObject({ value: keySchema, label: z.string().trim().min(1).max(80) });

/** POST body: the shared definition schema plus companyId (its cross-field rules run in the service). */
const createBody = z.strictObject({ ...customFieldDefinitionSchema.shape, companyId: z.uuid() });

// Entity and key are fixed. `type` may change only while no record stores a value for the field.
const patchBody = z.strictObject({
  label: z.string().trim().min(1, 'Give the field a label').max(80).optional(),
  type: z.enum(CUSTOM_FIELD_TYPES).optional(),
  options: z.array(optionSchema).max(100).optional(),
  required: z.boolean().optional(),
  appliesTo: z.enum(DEAL_KINDS).nullable().optional(),
  help: z.string().trim().max(300).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

const listQuery = z
  .strictObject({
    unitId: configScopeShape.unitId,
    companyId: configScopeShape.companyId,
    entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
    includeInactive: booleanQuery.optional(),
  })
  .superRefine(exactlyOneScope);

const orderBody = z.strictObject({
  companyId: z.uuid(),
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  ids: z.array(z.uuid()).min(1).max(200),
});

export function fieldRoutes(router) {
  router.get(
    '/custom-fields',
    describe({
      summary: 'List custom field definitions',
      description: 'By company, record type and position. Deal, contact and institute forms read their company\'s active definitions here.',
      permission: 'fields.view',
    }),
    requireAuth(),
    validate({ query: listQuery }),
    async (req, res) => {
      res.json({ data: await listCustomFields(req, req.valid.query) });
    },
  );

  router.post(
    '/custom-fields',
    describe({
      summary: 'Create a custom field',
      description: 'Key unique per company and record type; at most 100 active fields per record type. Emits `custom_field.created`.',
      permission: 'fields.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ body: createBody }),
    async (req, res) => {
      res.status(201).json({ data: await createCustomField(req, req.valid.body) });
    },
  );

  // Literal path before /custom-fields/:id.
  router.put(
    '/custom-fields/order',
    describe({
      summary: 'Reorder custom fields',
      description: 'The listed fields come first, in the given order; the others keep their order after them.',
      permission: 'fields.manage',
    }),
    requireAuth(),
    validate({ body: orderBody }),
    async (req, res) => {
      res.json({ data: await reorderCustomFields(req, req.valid.body) });
    },
  );

  router.patch(
    '/custom-fields/:id',
    describe({
      summary: 'Update a custom field',
      description:
        'Entity and key are fixed. Changing `type` is refused (409) once records hold values for the field. Deactivating a deal field a stage requires is refused (409, naming the stages). A removed option keeps stored values.',
      permission: 'fields.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: patchBody }),
    async (req, res) => {
      res.json({ data: await updateCustomField(req, req.valid.params.id, req.valid.body) });
    },
  );
}
