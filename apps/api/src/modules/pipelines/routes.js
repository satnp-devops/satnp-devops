import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { DEAL_KINDS, STAGE_CATEGORIES } from '../../core/crm/constants.js';
import { booleanQuery, colourSchema, keySchema, optionalText, percentSchema, requiredText } from '../../core/crm/schemas.js';
import { configScopeShape, exactlyOneScope } from './configAccess.js';
import {
  addStage,
  archivePipeline,
  archiveStage,
  createLostReason,
  createPipeline,
  getPipeline,
  listLostReasons,
  listPipelines,
  listRequiredFieldOptions,
  reorderStages,
  restorePipeline,
  updateLostReason,
  updatePipeline,
  updateStage,
} from './service.js';

// docs/crm/PHASE2_CONTRACT.md §9.3: pipelines, stages and lost reasons.

const positionSchema = z.number().int().min(0).max(1000);
const slaHoursSchema = z.number().int().min(1).max(8760).nullable();
const requiredFieldsSchema = z.array(z.string().max(80)).max(30);
const entryRulesSchema = z.strictObject({ allowedFrom: z.array(keySchema).max(30) }).partial();

export const stageInput = z.strictObject({
  key: keySchema,
  name: requiredText(60),
  category: z.enum(STAGE_CATEGORIES),
  probability: percentSchema.default(0),
  slaHours: slaHoursSchema.default(null),
  requiredFields: requiredFieldsSchema.default([]),
  entryRules: entryRulesSchema.default({}),
  colour: colourSchema.nullable().default(null),
});

export const pipelineCreateBody = z.strictObject({
  companyId: z.uuid(),
  key: keySchema,
  name: requiredText(80),
  kind: z.enum(DEAL_KINDS),
  isDefault: z.boolean().default(false),
  productLineIds: z.array(z.uuid()).max(50).default([]),
  position: positionSchema.optional(),
  stages: z.array(stageInput).min(3).max(30),
});

const pipelinePatchBody = z.strictObject({
  name: requiredText(80).optional(),
  isDefault: z.literal(true).optional(),
  productLineIds: z.array(z.uuid()).max(50).optional(),
  position: positionSchema.optional(),
});

const stageCreateBody = z.strictObject({ ...stageInput.shape, position: positionSchema.optional() });

// Written out without defaults: a PATCH only changes what it names.
const stagePatchBody = z.strictObject({
  name: requiredText(60).optional(),
  probability: percentSchema.optional(),
  slaHours: slaHoursSchema.optional(),
  requiredFields: requiredFieldsSchema.optional(),
  entryRules: entryRulesSchema.optional(),
  colour: colourSchema.nullable().optional(),
});

const pipelineListQuery = z
  .strictObject({ ...configScopeShape, kind: z.enum(DEAL_KINDS).optional() })
  .superRefine(exactlyOneScope);

const lostReasonListQuery = z
  .strictObject({
    unitId: configScopeShape.unitId,
    companyId: configScopeShape.companyId,
    kind: z.enum(DEAL_KINDS).optional(),
    includeInactive: booleanQuery.optional(),
  })
  .superRefine(exactlyOneScope);

const lostReasonBody = z.strictObject({
  companyId: z.uuid(),
  label: requiredText(80),
  kind: z.enum(DEAL_KINDS).nullable().default(null),
  requiresNote: z.boolean().default(false),
  position: positionSchema.optional(),
});

const lostReasonPatchBody = z.strictObject({
  label: requiredText(80).optional(),
  kind: z.enum(DEAL_KINDS).nullable().optional(),
  requiresNote: z.boolean().optional(),
  position: positionSchema.optional(),
  active: z.boolean().optional(),
});

const stageParams = z.strictObject({ id: z.uuid(), stageId: z.uuid() });

export function pipelineRoutes(router) {
  // Literal paths before /pipelines/:id.
  router.get(
    '/pipelines',
    describe({
      summary: 'List pipelines with their stages',
      description: 'Every pipeline of one company (`companyId`) or of the companies in a working unit (`unitId`; all companies at group scope), by company name and position.',
      permission: 'pipelines.view',
    }),
    requireAuth(),
    validate({ query: pipelineListQuery }),
    async (req, res) => {
      res.json({ data: await listPipelines(req, req.valid.query) });
    },
  );

  router.get(
    '/pipelines/required-field-options',
    describe({
      summary: 'List the deal fields a stage can require',
      description: 'Built-in deal fields plus the company\'s active custom deal fields (`custom.<key>`). `kind` leaves out fields deals of the other kind never have.',
      permission: 'pipelines.view',
    }),
    requireAuth(),
    validate({ query: z.strictObject({ companyId: z.uuid(), kind: z.enum(DEAL_KINDS).optional() }) }),
    async (req, res) => {
      res.json({ data: await listRequiredFieldOptions(req, req.valid.query) });
    },
  );

  router.get(
    '/pipelines/:id',
    describe({ summary: 'Get a pipeline', permission: 'pipelines.view' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getPipeline(req, req.valid.params.id) });
    },
  );

  router.post(
    '/pipelines',
    describe({
      summary: 'Create a pipeline',
      description: 'Stages need unique keys and at least one open, won and lost stage. The first pipeline of a kind becomes the default. Emits `pipeline.created`.',
      permission: 'pipelines.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ body: pipelineCreateBody }),
    async (req, res) => {
      res.status(201).json({ data: await createPipeline(req, req.valid.body) });
    },
  );

  router.patch(
    '/pipelines/:id',
    describe({
      summary: 'Update a pipeline',
      description: 'Key and kind are fixed. `isDefault: true` makes it the default of its kind. Emits `pipeline.updated`.',
      permission: 'pipelines.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: pipelinePatchBody }),
    async (req, res) => {
      res.json({ data: await updatePipeline(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/pipelines/:id/archive',
    describe({
      summary: 'Archive a pipeline',
      description: 'Refused (409, `details.openDealCount`) while it has open deals, or when it is the only active pipeline of its kind. A default passes to the next active pipeline.',
      permission: 'pipelines.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await archivePipeline(req, req.valid.params.id) });
    },
  );

  router.post(
    '/pipelines/:id/restore',
    describe({ summary: 'Restore an archived pipeline', permission: 'pipelines.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await restorePipeline(req, req.valid.params.id) });
    },
  );

  router.put(
    '/pipelines/:id/stages/order',
    describe({
      summary: 'Reorder the stages of a pipeline',
      description: 'List every active stage exactly once; positions become 0..n-1.',
      permission: 'pipelines.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: z.strictObject({ stageIds: z.array(z.uuid()).min(3).max(30) }) }),
    async (req, res) => {
      res.json({ data: await reorderStages(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/pipelines/:id/stages',
    describe({
      summary: 'Add a stage to a pipeline',
      description: 'Inserted at `position` (default: before the first won stage); later stages shift. Returns the pipeline.',
      permission: 'pipelines.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: stageCreateBody }),
    async (req, res) => {
      res.status(201).json({ data: await addStage(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.patch(
    '/pipelines/:id/stages/:stageId',
    describe({
      summary: 'Update a stage',
      description: 'Key and category are fixed. A new SLA applies to deals entering the stage from now on.',
      permission: 'pipelines.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: stageParams, body: stagePatchBody }),
    async (req, res) => {
      res.json({ data: await updateStage(req, req.valid.params.id, req.valid.params.stageId, req.valid.body) });
    },
  );

  router.post(
    '/pipelines/:id/stages/:stageId/archive',
    describe({
      summary: 'Archive a stage',
      description:
        'The last active stage of its category can\'t be archived (409). With open deals in the stage, `moveToStageId` (an active stage of the same category) is required: otherwise 409 with `details: { openDealCount, dealCount }`. Moved deals get a stage history row and a `stage_change` timeline entry each.',
      permission: 'pipelines.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: stageParams, body: z.strictObject({ moveToStageId: z.uuid().optional() }) }),
    async (req, res) => {
      res.json({ data: await archiveStage(req, req.valid.params.id, req.valid.params.stageId, req.valid.body) });
    },
  );

  router.get(
    '/lost-reasons',
    describe({
      summary: 'List lost reasons',
      description: 'By company and position. `kind` returns that kind\'s reasons plus the shared ones.',
      permission: 'pipelines.view',
    }),
    requireAuth(),
    validate({ query: lostReasonListQuery }),
    async (req, res) => {
      res.json({ data: await listLostReasons(req, req.valid.query) });
    },
  );

  router.post(
    '/lost-reasons',
    describe({ summary: 'Create a lost reason', permission: 'pipelines.manage', status: 201, errors: [409] }),
    requireAuth(),
    validate({ body: lostReasonBody }),
    async (req, res) => {
      res.status(201).json({ data: await createLostReason(req, req.valid.body) });
    },
  );

  router.patch(
    '/lost-reasons/:id',
    describe({
      summary: 'Update a lost reason',
      description: 'There is no delete: deactivate a reason instead (deals keep theirs).',
      permission: 'pipelines.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: lostReasonPatchBody }),
    async (req, res) => {
      res.json({ data: await updateLostReason(req, req.valid.params.id, req.valid.body) });
    },
  );
}

/** For unit tests of the request rules. */
export const schemas = { stageInput, pipelineCreateBody, pipelinePatchBody, stagePatchBody, lostReasonBody, pipelineListQuery };
