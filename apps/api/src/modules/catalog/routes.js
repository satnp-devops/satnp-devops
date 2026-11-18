import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { PRODUCT_KINDS } from '../../core/crm/constants.js';
import { booleanQuery, keySchema, nullableText, optionalText, requiredText, text } from '../../core/crm/schemas.js';
import { configScopeShape, exactlyOneScope } from '../pipelines/configAccess.js';
import {
  createProduct,
  createProductLine,
  listPeople,
  listProductLines,
  listProducts,
  updateProduct,
  updateProductLine,
  vocabularies,
} from './service.js';

// docs/crm/PHASE2_CONTRACT.md §9.4: CRM vocabularies, the people picker, product lines and products.

const PEOPLE_PERMISSIONS = [
  'deals.manage',
  'deals.view',
  'tasks.view',
  'tasks.manage',
  'contacts.view',
  'contacts.manage',
  'accounts.view',
  'accounts.manage',
];

const positionSchema = z.number().int().min(0).max(1000);

export const productAttributesSchema = z
  .strictObject({
    mode: z.enum(['online', 'centre', 'hybrid']),
    sessions: z.number().int().min(1).max(1000),
    durationWeeks: z.number().int().min(1).max(520),
    tests: z.number().int().min(1).max(1000),
    exam: text(60),
    grades: z.array(text(20)).max(20),
    billing: z.enum(['one_time', 'monthly', 'annual', 'per_student_year', 'per_branch_year', 'per_institute_year', 'per_seat_month']),
    addOn: z.boolean(),
  })
  .partial();

/** Product codes are upper-cased: "SAT-BATCH-12". */
export const productCodeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,29}$/, 'Use up to 30 letters, numbers and dashes, starting with a letter or number'),
);
/** An empty code from a form clears it. */
const productCodeInput = z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), productCodeSchema.nullable());

const productLineBody = z.strictObject({
  companyId: z.uuid(),
  key: keySchema,
  name: requiredText(80),
  kind: z.enum(PRODUCT_KINDS.map((kind) => kind.key)),
  description: optionalText(500),
  position: positionSchema.optional(),
});

const productLinePatchBody = z.strictObject({
  name: requiredText(80).optional(),
  description: nullableText(500).optional(),
  position: positionSchema.optional(),
  active: z.boolean().optional(),
});

const productBody = z.strictObject({
  productLineId: z.uuid(),
  code: productCodeInput.optional(),
  name: requiredText(120),
  description: optionalText(1000),
  attributes: productAttributesSchema.default({}),
  position: positionSchema.optional(),
});

const productPatchBody = z.strictObject({
  productLineId: z.uuid().optional(),
  code: productCodeInput.optional(),
  name: requiredText(120).optional(),
  description: nullableText(1000).optional(),
  attributes: productAttributesSchema.optional(),
  position: positionSchema.optional(),
  active: z.boolean().optional(),
});

const lineListQuery = z
  .strictObject({ unitId: configScopeShape.unitId, companyId: configScopeShape.companyId, includeInactive: booleanQuery.optional() })
  .superRefine(exactlyOneScope);

const productListQuery = z
  .strictObject({
    unitId: configScopeShape.unitId,
    companyId: configScopeShape.companyId,
    productLineId: z.uuid().optional(),
    q: z.string().trim().min(1).max(100).optional(),
    includeInactive: booleanQuery.optional(),
  })
  .superRefine((value, ctx) => {
    // A product line alone is enough: its company is the scope.
    if (value.unitId && value.companyId) ctx.addIssue({ code: 'custom', path: ['unitId'], message: 'Give either unitId or companyId' });
    if (!value.unitId && !value.companyId && !value.productLineId) {
      ctx.addIssue({ code: 'custom', path: ['unitId'], message: 'Give unitId, companyId or productLineId' });
    }
  });

const peopleQuery = z.strictObject({
  unitId: z.uuid(),
  permission: z.enum(PEOPLE_PERMISSIONS),
  q: z.string().trim().min(1).max(100).optional(),
});

export function catalogRoutes(router) {
  router.get(
    '/crm/vocabularies',
    describe({
      summary: 'Get the CRM vocabularies',
      description: 'Channels (from the module registry), contact, account, deal, product, custom field, timeline, task and consent vocabularies. Cached for 5 minutes.',
    }),
    requireAuth(),
    (req, res) => {
      res.set('Cache-Control', 'private, max-age=300');
      res.json({ data: vocabularies(req.app.locals.registry) });
    },
  );

  router.get(
    '/crm/people',
    describe({
      summary: 'List people who can own or be assigned work at a unit',
      description: 'Active people holding `permission` at the unit (from a role there or above), by name, at most 200. For owner and assignee pickers.',
      permission: ['deals.view', 'contacts.view', 'tasks.view', 'accounts.view'],
    }),
    requireAuth(),
    validate({ query: peopleQuery }),
    async (req, res) => {
      res.json({ data: await listPeople(req, req.valid.query) });
    },
  );

  router.get(
    '/product-lines',
    describe({ summary: 'List product lines', description: 'With the number of active products in each.', permission: 'catalog.view' }),
    requireAuth(),
    validate({ query: lineListQuery }),
    async (req, res) => {
      res.json({ data: await listProductLines(req, req.valid.query) });
    },
  );

  router.post(
    '/product-lines',
    describe({
      summary: 'Create a product line',
      description: 'Its audience (B2C or B2B) follows from the kind. Emits `product_line.created`.',
      permission: 'catalog.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ body: productLineBody }),
    async (req, res) => {
      res.status(201).json({ data: await createProductLine(req, req.valid.body) });
    },
  );

  router.patch(
    '/product-lines/:id',
    describe({
      summary: 'Update a product line',
      description: 'Key and kind are fixed. Inactive lines stay on existing deals; new deals can\'t pick them.',
      permission: 'catalog.manage',
    }),
    requireAuth(),
    validate({ params: idParams, body: productLinePatchBody }),
    async (req, res) => {
      res.json({ data: await updateProductLine(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.get(
    '/products',
    describe({ summary: 'List products', description: 'By company, product line and position.', permission: 'catalog.view' }),
    requireAuth(),
    validate({ query: productListQuery }),
    async (req, res) => {
      res.json({ data: await listProducts(req, req.valid.query) });
    },
  );

  router.post(
    '/products',
    describe({ summary: 'Create a product', permission: 'catalog.manage', status: 201, errors: [409] }),
    requireAuth(),
    validate({ body: productBody }),
    async (req, res) => {
      res.status(201).json({ data: await createProduct(req, req.valid.body) });
    },
  );

  router.patch(
    '/products/:id',
    describe({
      summary: 'Update a product',
      description: 'A new product line must be of the same company and audience.',
      permission: 'catalog.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: productPatchBody }),
    async (req, res) => {
      res.json({ data: await updateProduct(req, req.valid.params.id, req.valid.body) });
    },
  );
}
