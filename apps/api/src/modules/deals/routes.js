import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { runDealBulk } from './bulk.js';
import { checkDuplicates, getDeal, listDeals, stageCounts, stageHistory } from './queries.js';
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView } from './savedViews.js';
import {
  addDealContact,
  archiveDeal,
  assignDeal,
  changeStage,
  createDealForRequest,
  markSeen,
  removeDealContact,
  restoreDeal,
  updateDeal,
} from './service.js';
import {
  archiveBody,
  assignBody,
  bulkBody,
  dealContactBody,
  dealCreateBody,
  dealPatchBody,
  duplicateCheckBody,
  listQuerySchema,
  loseBody,
  moveBody,
  reopenBody,
  savedViewBody,
  savedViewListQuery,
  savedViewPatchBody,
  stageCountsQuerySchema,
  winBody,
} from './schemas.js';

// Endpoints of docs/crm/PHASE2_CONTRACT.md §9.6 (deals) and §9.7 (saved views). Literal paths
// (/deals/stage-counts, /deals/bulk, /deals/check-duplicates) are registered before /deals/:id.

const EVENTS = 'Writes the audit entry, the outbox event, the timeline entry and the search document in one transaction.';

export function dealRoutes(router) {
  router.get(
    '/deals',
    describe({
      summary: 'List leads and deals',
      description:
        'Keyset-paginated, filtered on the server (stage, status, owner incl. `me` and `none`, channel, product line, tags, campaign, ' +
        'UTM source, SLA, created and updated ranges, `q` over refs, phones, emails, names and titles). Primary contact PII is masked ' +
        'per deal unit without `contacts.view_pii`. `archived=true` lists archived deals and needs `deals.archive`.',
      permission: 'deals.view',
      list: true,
    }),
    requireAuth(),
    validate({ query: listQuerySchema }),
    async (req, res) => {
      res.json(await listDeals(req, req.valid.query));
    },
  );

  router.get(
    '/deals/stage-counts',
    describe({ summary: 'Count leads per stage of a pipeline', permission: 'deals.view' }),
    requireAuth(),
    validate({ query: stageCountsQuerySchema }),
    async (req, res) => {
      res.json({ data: await stageCounts(req, req.valid.query) });
    },
  );

  router.post(
    '/deals/check-duplicates',
    describe({
      summary: 'Find existing people and open leads before adding a lead',
      description: 'Matches like findOrCreateContact without writing. Only deals of the unit’s company are considered.',
      permission: 'deals.manage',
    }),
    requireAuth(),
    validate({ body: duplicateCheckBody }),
    async (req, res) => {
      res.json({ data: await checkDuplicates(req, req.valid.body) });
    },
  );

  router.post(
    '/deals/bulk',
    describe({
      summary: 'Change many leads at once',
      description:
        'assign, move, lose, addTags, removeTags, setNurture, archive or restore, for `ids` or a `filter` (up to 1000 leads). ' +
        'Each lead gets the single endpoint’s checks; results per lead (`updated`, `unchanged`, `failed` with a code and reason).',
      permission: ['deals.manage', 'deals.assign', 'deals.archive'],
    }),
    requireAuth(),
    validate({ body: bulkBody }),
    async (req, res) => {
      res.json({ data: await runDealBulk(req, req.valid.body) });
    },
  );

  router.post(
    '/deals',
    describe({
      summary: 'Add a lead',
      description: `Manual entry: the person is found or created with de-duplication. 200 for a repeated sourceEventId. ${EVENTS}`,
      permission: 'deals.manage',
      status: 201,
      errors: [409],
    }),
    requireAuth(),
    validate({ body: dealCreateBody }),
    async (req, res) => {
      const result = await createDealForRequest(req, req.valid.body);
      res.status(result.created ? 201 : 200).json({ data: result.data });
    },
  );

  router.get(
    '/deals/:id',
    describe({ summary: 'Get a lead with its people, custom fields and SLA state', permission: 'deals.view' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getDeal(req, req.valid.params.id) });
    },
  );

  router.get(
    '/deals/:id/stage-history',
    describe({ summary: 'Stage history of a lead', permission: 'deals.view' }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await stageHistory(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/deals/:id',
    describe({ summary: 'Edit a lead', description: EVENTS, permission: 'deals.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams, body: dealPatchBody }),
    async (req, res) => {
      res.json({ data: await updateDeal(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/deals/:id/move',
    describe({
      summary: 'Move a lead to another stage',
      description: `Runs the stage rules: 422 \`stage_rules\` lists missing fields; 409 \`stage_changed\` when fromStageId is stale. ${EVENTS}`,
      permission: 'deals.manage',
      errors: [409],
    }),
    requireAuth(),
    validate({ params: idParams, body: moveBody }),
    async (req, res) => {
      res.json({ data: await changeStage(req, req.valid.params.id, req.valid.body, 'move') });
    },
  );

  router.post(
    '/deals/:id/win',
    describe({ summary: 'Mark a lead won', permission: 'deals.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams, body: winBody }),
    async (req, res) => {
      res.json({ data: await changeStage(req, req.valid.params.id, req.valid.body, 'win') });
    },
  );

  router.post(
    '/deals/:id/lose',
    describe({ summary: 'Mark a lead lost', description: 'A reason is required; nurture defaults to the deals.nurtureOnLost setting.', permission: 'deals.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams, body: loseBody }),
    async (req, res) => {
      res.json({ data: await changeStage(req, req.valid.params.id, req.valid.body, 'lose') });
    },
  );

  router.post(
    '/deals/:id/reopen',
    describe({ summary: 'Reopen a won or lost lead', permission: 'deals.manage', errors: [409] }),
    requireAuth(),
    validate({ params: idParams, body: reopenBody }),
    async (req, res) => {
      res.json({ data: await changeStage(req, req.valid.params.id, req.valid.body, 'reopen') });
    },
  );

  router.post(
    '/deals/:id/assign',
    describe({
      summary: 'Change who owns a lead',
      description: 'Needs deals.assign at the unit (people who work every lead there may take one). The new owner must be able to work there.',
      permission: 'deals.assign',
    }),
    requireAuth(),
    validate({ params: idParams, body: assignBody }),
    async (req, res) => {
      res.json({ data: await assignDeal(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/deals/:id/archive',
    describe({ summary: 'Archive a lead', permission: 'deals.archive', errors: [409] }),
    requireAuth(),
    validate({ params: idParams, body: archiveBody }),
    async (req, res) => {
      res.json({ data: await archiveDeal(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/deals/:id/restore',
    describe({ summary: 'Restore an archived lead', permission: 'deals.archive', errors: [409] }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await restoreDeal(req, req.valid.params.id) });
    },
  );

  router.post(
    '/deals/:id/seen',
    describe({ summary: 'Record that the owner opened a lead (it stops being new)', permission: 'deals.view', status: 204 }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await markSeen(req, req.valid.params.id);
      res.status(204).end();
    },
  );

  router.post(
    '/deals/:id/contacts',
    describe({ summary: 'Add a person to a lead', permission: 'deals.manage', status: 201, errors: [409] }),
    requireAuth(),
    validate({ params: idParams, body: dealContactBody }),
    async (req, res) => {
      res.status(201).json({ data: await addDealContact(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.delete(
    '/deals/:id/contacts/:contactId',
    describe({ summary: 'Remove a person from a lead', permission: 'deals.manage', errors: [409] }),
    requireAuth(),
    validate({ params: z.strictObject({ id: z.uuid(), contactId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await removeDealContact(req, req.valid.params.id, req.valid.params.contactId) });
    },
  );

  // ---------- Saved views ----------

  router.get(
    '/saved-views',
    describe({ summary: 'List saved views of the Leads list', permission: 'deals.view' }),
    requireAuth(),
    validate({ query: savedViewListQuery }),
    async (req, res) => {
      res.json({ data: await listSavedViews(req, req.valid.query) });
    },
  );

  router.post(
    '/saved-views',
    describe({ summary: 'Save a view', description: 'Shared views need deals.share_views at the unit.', permission: 'deals.view', status: 201, errors: [409] }),
    requireAuth(),
    validate({ body: savedViewBody }),
    async (req, res) => {
      res.status(201).json({ data: await createSavedView(req, req.valid.body) });
    },
  );

  router.patch(
    '/saved-views/:id',
    describe({ summary: 'Change a saved view', permission: 'deals.view' }),
    requireAuth(),
    validate({ params: idParams, body: savedViewPatchBody }),
    async (req, res) => {
      res.json({ data: await updateSavedView(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.delete(
    '/saved-views/:id',
    describe({ summary: 'Delete a saved view', permission: 'deals.view', status: 204 }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await deleteSavedView(req, req.valid.params.id);
      res.status(204).end();
    },
  );
}
