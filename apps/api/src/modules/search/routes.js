import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { SEARCH_ENTITY_TYPES } from '../../core/crm/constants.js';
import { csvList } from '../../core/crm/schemas.js';
import { search } from './service.js';

export const searchQuerySchema = z.strictObject({
  unitId: z.uuid(),
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  types: csvList(z.enum(SEARCH_ENTITY_TYPES), SEARCH_ENTITY_TYPES.length).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

const hitSchema = z
  .object({
    type: z.enum(SEARCH_ENTITY_TYPES),
    id: z.uuid(),
    title: z.string(),
    subtitle: z.string().nullable(),
    companyId: z.uuid().nullable().describe('Set for deals; people and institutes are group-level'),
    matchedOn: z.enum(['name', 'phone', 'email', 'ref', 'text']),
    snippet: z.string().nullable().describe('Why it matched, e.g. "Phone +91 •••••••234" (masked without contacts.view_pii)'),
    company: z.object({ id: z.uuid(), name: z.string(), code: z.string() }).nullable(),
    status: z.enum(['open', 'won', 'lost']).nullable(),
    value: z.object({ valueMinor: z.number().int(), currency: z.string() }).nullable(),
    owner: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    contactPoint: z.string().nullable().describe('A person’s or institute’s primary phone or email, masked as needed'),
    piiMasked: z.boolean(),
  })
  .meta({ id: 'SearchHit' });

const searchResponseSchema = z
  .object({
    query: z.string(),
    groups: z.array(z.object({ type: z.enum(SEARCH_ENTITY_TYPES), hits: z.array(hitSchema) })),
  })
  .meta({ id: 'SearchResponse' });

export function searchRoutes(router) {
  router.get(
    '/search',
    describe({
      summary: 'Search leads, deals, contacts and institutes',
      description:
        'Global search (Ctrl/Cmd+K). Results follow each record type’s visibility (deals.view, contacts.view, accounts.view); ' +
        'types the user cannot view are skipped. Exact phone, email and reference matches come first, then names by ' +
        'trigram similarity, then full-text words. Personal data in results is masked without contacts.view_pii.',
      permission: ['deals.view', 'contacts.view', 'accounts.view'],
      errors: [404],
      responses: { 200: searchResponseSchema },
    }),
    requireAuth(),
    validate({ query: searchQuerySchema }),
    async (req, res) => {
      res.json({ data: await search(req, req.valid.query) });
    },
  );
}
