import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { MANUAL_TIMELINE_KINDS, TIMELINE_DIRECTIONS } from '../../core/crm/constants.js';
import { booleanQuery, channelKeySchema, csvList, dateTimeSchema, nullableText, optionalText, text } from '../../core/crm/schemas.js';
import { addEntry, deleteEntry, editEntry, listTimeline, listTimelineKinds, setPinned } from './service.js';

// docs/crm/PHASE2_CONTRACT.md §9.8. Additions to the contract (reported): `channel` and
// `includeArchive` on the list.

const kindKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const timelineListQuery = z.strictObject({
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  kind: csvList(kindKey, 20).optional(),
  channel: csvList(channelKeySchema, 20).optional(),
  pinned: booleanQuery.optional(),
  includeArchive: booleanQuery.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const timelineCreateBody = z.strictObject({
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  kind: z.enum(MANUAL_TIMELINE_KINDS),
  direction: z.enum(TIMELINE_DIRECTIONS).optional(),
  channel: channelKeySchema.nullable().optional(),
  title: optionalText(300),
  body: z.string().trim().max(20_000).optional(),
  occurredAt: dateTimeSchema.optional(),
  meta: z
    .strictObject({
      durationSeconds: z.number().int().min(0).max(86_400),
      outcome: z.enum(['connected', 'no_answer', 'busy', 'voicemail', 'wrong_number', 'left_message']),
      attendees: z.array(text(120)).max(20),
      subject: text(300),
    })
    .partial()
    .default({}),
});

export const timelineEditBody = z.strictObject({
  title: nullableText(300).optional(),
  body: text(20_000).optional(),
  occurredAt: dateTimeSchema.optional(),
});

const entryParams = z.object({ id: z.string().regex(/^[1-9]\d{0,18}$/, 'Not a timeline entry id') });

export function timelineRoutes(router) {
  router.get(
    '/timeline/kinds',
    describe({ summary: 'List timeline entry kinds' }),
    requireAuth(),
    (_req, res) => {
      res.json({ data: listTimelineKinds() });
    },
  );

  router.get(
    '/timeline',
    describe({
      summary: "List a deal's, person's or institute's timeline",
      description:
        'Newest first, keyset-paginated. Exactly one of dealId, contactId or accountId. Person and institute timelines show group-level facts, entries of deals the viewer can see and company entries where the viewer holds the view permission. `includeArchive=true` also reads archived entries.',
      permission: ['deals.view', 'contacts.view', 'accounts.view'],
      list: true,
      errors: [404, 422],
    }),
    requireAuth(),
    validate({ query: timelineListQuery }),
    async (req, res) => {
      res.json(await listTimeline(req, req.valid.query));
    },
  );

  router.post(
    '/timeline',
    describe({
      summary: 'Add a note or log an activity',
      description: 'Emits `timeline.entry_added`. An outbound call, email, message or meeting on a deal counts as its first reply.',
      permission: 'timeline.write',
      status: 201,
      errors: [403, 404, 422],
    }),
    requireAuth(),
    validate({ body: timelineCreateBody }),
    async (req, res) => {
      res.status(201).json({ data: await addEntry(req, req.valid.body) });
    },
  );

  router.patch(
    '/timeline/:id',
    describe({
      summary: 'Edit your timeline entry',
      description: 'Only the author, manual kinds only. Emits `timeline.entry_edited`.',
      permission: 'timeline.write',
      errors: [403, 404],
    }),
    requireAuth(),
    validate({ params: entryParams, body: timelineEditBody }),
    async (req, res) => {
      res.json({ data: await editEntry(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.post(
    '/timeline/:id/pin',
    describe({ summary: 'Pin a timeline entry', description: 'At most 5 per record (409).', permission: 'timeline.write', errors: [403, 404, 409] }),
    requireAuth(),
    validate({ params: entryParams }),
    async (req, res) => {
      res.json({ data: await setPinned(req, req.valid.params.id, true) });
    },
  );

  router.post(
    '/timeline/:id/unpin',
    describe({ summary: 'Unpin a timeline entry', permission: 'timeline.write', errors: [403, 404] }),
    requireAuth(),
    validate({ params: entryParams }),
    async (req, res) => {
      res.json({ data: await setPinned(req, req.valid.params.id, false) });
    },
  );

  router.delete(
    '/timeline/:id',
    describe({
      summary: 'Delete a timeline entry',
      description: 'Soft delete of a manual entry by its author, or by someone with `timeline.moderate`. Emits `timeline.entry_deleted`.',
      permission: ['timeline.write', 'timeline.moderate'],
      status: 204,
      errors: [403, 404],
    }),
    requireAuth(),
    validate({ params: entryParams }),
    async (req, res) => {
      await deleteEntry(req, req.valid.params.id);
      res.status(204).end();
    },
  );
}
