import { z } from 'zod';
import { DEAL_CONTACT_ROLES, DEAL_KINDS, DEAL_SORTS, SAVED_VIEW_ENTITIES, SAVED_VIEW_VISIBILITIES } from '../../core/crm/constants.js';
import {
  channelKeySchema,
  contactInputSchema,
  csvList,
  currencySchema,
  dateOnlySchema,
  dateTimeSchema,
  dealColumnSchema,
  dealFiltersSchema,
  dealListQuerySchema,
  emailInputSchema,
  idsSchema,
  optionalText,
  originalMessageSchema,
  phoneInputSchema,
  requiredText,
  tagsSchema,
  text,
  touchSourceSchema,
  valueMinorSchema,
} from '../../core/crm/schemas.js';

// Request schemas of the deals module, built from the shared pieces exactly as
// docs/crm/PHASE2_CONTRACT.md §9.6 and §9.7 describe, plus the deals slice's additions
// (reported as contract changes): sort by name, SLA / campaign / source / updated filters,
// a "lose" bulk action, bulk actions on a filter and up to 1000 records.

/** List sorts: the contract's, plus the name (title) A–Z and Z–A. */
export const LIST_SORTS = [...DEAL_SORTS, 'title', '-title'];
export const listSortSchema = z.enum(LIST_SORTS);

/** "breached": stage SLA or first reply overdue. "due_soon": less than a quarter of either window left. */
export const SLA_FILTERS = ['breached', 'due_soon'];

/** At most this many records per bulk request (selected ids or a filter). */
export const BULK_MAX = 1000;

const campaignSchema = text(200).pipe(z.string().min(1));

/** Filters a saved view stores: the contract's dealFiltersSchema plus the slice's extra filters. */
export const viewFiltersSchema = dealFiltersSchema.extend({
  sla: z.enum(SLA_FILTERS).optional(),
  campaign: z.array(campaignSchema).max(20).optional(),
  source: z.array(campaignSchema).max(20).optional(),
  updatedFrom: dateTimeSchema.optional(),
  updatedTo: dateTimeSchema.optional(),
});

/** GET /deals: dealListQuerySchema plus the extra filters and sorts. */
export const listQuerySchema = dealListQuerySchema.extend({
  sort: listSortSchema.default('-updatedAt'),
  sla: z.enum(SLA_FILTERS).optional(),
  campaign: csvList(campaignSchema, 20).optional(),
  source: csvList(campaignSchema, 20).optional(),
  updatedFrom: dateTimeSchema.optional(),
  updatedTo: dateTimeSchema.optional(),
});

/** GET /deals/stage-counts: the list filters without stage, status, sort and paging; pipelineId required. */
export const stageCountsQuerySchema = listQuerySchema
  .omit({ stageId: true, status: true, sort: true, cursor: true, limit: true })
  .extend({ pipelineId: z.uuid() });

/** The filter of a bulk action: what the list shows (JSON arrays, not comma lists). */
export const bulkFilterSchema = viewFiltersSchema.extend({
  unitId: z.uuid(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  householdId: z.uuid().optional(),
  archived: z.boolean().optional(),
});

// ---------- Deals ----------

export const dealContactRef = z.union([z.strictObject({ contactId: z.uuid() }), z.strictObject({ contact: contactInputSchema })]);

export const dealFieldsPatch = z
  .strictObject({
    title: requiredText(200),
    productLineId: z.uuid().nullable(),
    productId: z.uuid().nullable(),
    valueMinor: valueMinorSchema,
    currency: currencySchema,
    primaryContactId: z.uuid(),
    householdId: z.uuid().nullable(),
    accountId: z.uuid().nullable(),
    expectedCloseOn: dateOnlySchema.nullable(),
    tags: tagsSchema,
    custom: z.record(z.string(), z.unknown()),
    nurture: z.boolean(),
    lastTouch: touchSourceSchema,
  })
  .partial();

export const dealPatchBody = dealFieldsPatch.extend({ unitId: z.uuid().optional() });

export const dealCreateBody = z.strictObject({
  unitId: z.uuid(),
  kind: z.enum(DEAL_KINDS),
  title: optionalText(200),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  productLineId: z.uuid().nullable().optional(),
  productId: z.uuid().nullable().optional(),
  ownerUserId: z.uuid().nullable().optional(),
  valueMinor: valueMinorSchema.optional(),
  currency: currencySchema.optional(),
  primaryContactId: z.uuid().optional(),
  contact: contactInputSchema.optional(),
  students: z.array(dealContactRef).max(10).optional(),
  householdId: z.uuid().nullable().optional(),
  accountId: z.uuid().optional(),
  channel: channelKeySchema.default('manual'),
  firstTouch: touchSourceSchema.optional(),
  originalMessage: originalMessageSchema.optional(),
  expectedCloseOn: dateOnlySchema.nullable().optional(),
  tags: tagsSchema.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  nurture: z.boolean().optional(),
  sourceEventId: z.string().min(1).max(200).optional(),
});

export const moveBody = z.strictObject({
  stageId: z.uuid(),
  fromStageId: z.uuid().optional(),
  lostReasonId: z.uuid().optional(),
  lostNote: optionalText(1000),
  nurture: z.boolean().optional(),
  fields: dealFieldsPatch.optional(),
});

export const winBody = z.strictObject({ stageId: z.uuid().optional(), fields: dealFieldsPatch.optional() });

export const loseBody = z.strictObject({
  stageId: z.uuid().optional(),
  lostReasonId: z.uuid(),
  lostNote: optionalText(1000),
  nurture: z.boolean().optional(),
});

export const reopenBody = z.strictObject({ stageId: z.uuid().optional() });
export const assignBody = z.strictObject({ ownerUserId: z.uuid().nullable() });
export const archiveBody = z.strictObject({ reason: optionalText(300) });

export const dealContactBody = z.union([
  z.strictObject({ contactId: z.uuid(), role: z.enum(DEAL_CONTACT_ROLES) }),
  z.strictObject({ contact: contactInputSchema, role: z.enum(DEAL_CONTACT_ROLES) }),
]);

export const duplicateCheckBody = z.strictObject({
  unitId: z.uuid(),
  kind: z.enum(DEAL_KINDS).optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  phones: z.array(phoneInputSchema).max(5).optional(),
  emails: z.array(emailInputSchema).max(5).optional(),
  firstName: optionalText(80),
  lastName: optionalText(80),
});

// ---------- Bulk actions ----------

/** Either `ids` (selected rows) or `filter` (everything the list shows, up to BULK_MAX). */
const target = {
  ids: idsSchema(BULK_MAX).optional(),
  filter: bulkFilterSchema.optional(),
};
const exactlyOneTarget = (value) => Boolean(value.ids) !== Boolean(value.filter);
const targetMessage = { message: 'Send either ids or filter', path: ['ids'] };
const action = (name, shape) => z.strictObject({ action: z.literal(name), ...target, ...shape }).refine(exactlyOneTarget, targetMessage);

export const bulkBody = z.discriminatedUnion('action', [
  action('assign', { ownerUserId: z.uuid().nullable() }),
  action('move', { stageId: z.uuid(), lostReasonId: z.uuid().optional(), lostNote: optionalText(1000) }),
  action('lose', { lostReasonId: z.uuid(), lostNote: optionalText(1000), nurture: z.boolean().optional() }),
  action('addTags', { tags: tagsSchema.pipe(z.array(z.string()).min(1)) }),
  action('removeTags', { tags: tagsSchema.pipe(z.array(z.string()).min(1)) }),
  action('setNurture', { nurture: z.boolean() }),
  action('archive', {}),
  action('restore', {}),
]);

// ---------- Saved views ----------

export const savedViewBody = z.strictObject({
  unitId: z.uuid(),
  entity: z.enum(SAVED_VIEW_ENTITIES).default('deals'),
  name: requiredText(60),
  visibility: z.enum(SAVED_VIEW_VISIBILITIES).default('personal'),
  filters: viewFiltersSchema.default({}),
  sort: listSortSchema.default('-updatedAt'),
  columns: z.array(dealColumnSchema).max(30).default([]),
  position: z.number().int().min(0).max(1000).optional(),
});

export const savedViewPatchBody = z
  .strictObject({
    name: requiredText(60),
    visibility: z.enum(SAVED_VIEW_VISIBILITIES),
    filters: viewFiltersSchema,
    sort: listSortSchema,
    columns: z.array(dealColumnSchema).max(30),
    position: z.number().int().min(0).max(1000),
  })
  .partial();

export const savedViewListQuery = z.strictObject({
  unitId: z.uuid(),
  entity: z.enum(SAVED_VIEW_ENTITIES).default('deals'),
});

