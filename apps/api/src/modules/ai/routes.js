import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { ACTION_STATUSES, AGENT_KEYS, TRIGGERS } from '../../core/ai/index.js';
import { agentCatalog, companyConfig, getAction, listActions, listReviews, resolveReview, reviewSummary, testAgent } from './service.js';
import { archiveArticle, createArticle, getArticle, listArticles, searchKnowledge, updateArticle } from './knowledge.js';
import { actionSchema, articleSchema, catalogSchema, configSchema, retrievedArticleSchema, reviewSummarySchema, testResultSchema } from './schemas.js';

// The AI service's REST API (docs/platform/AI.md "Endpoints").

const VIEW = 'ai.view';
const REVIEW = 'ai.review';
const MANAGE = 'ai.manage';
const KNOWLEDGE = 'ai.knowledge';

const limit = (max, fallback) => z.coerce.number().int().min(1).max(max).default(fallback);
const cursor = z.string().max(500).optional();
const agentKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'An agent key such as intake');

const actionsQuery = z.strictObject({
  unitId: z.uuid().describe('The working unit ("Working in")'),
  agent: agentKey.optional(),
  status: z.enum(ACTION_STATUSES).optional(),
  trigger: z.enum(TRIGGERS).optional(),
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  cursor,
  limit: limit(100, 25),
});

const reviewsQuery = z.strictObject({ unitId: z.uuid(), agent: agentKey.optional(), cursor, limit: limit(100, 25) });

const reviewBody = z
  .strictObject({
    decision: z.enum(['approve', 'edit', 'reject']),
    output: z.record(z.string(), z.unknown()).optional().describe('The edited output (decision edit); it must match the agent’s output schema'),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((body) => body.decision !== 'edit' || body.output, { message: 'Give the edited output', path: ['output'] });

const tag = z.string().trim().toLowerCase().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Letters, numbers, spaces, - and _');
const articleCreate = z.strictObject({
  companyId: z.uuid(),
  title: z.string().trim().min(1, 'Give the article a title').max(200),
  body: z.string().trim().min(1, 'Write the answer').max(20_000),
  tags: z.array(tag).max(20).default([]),
  status: z.enum(['draft', 'approved']).default('draft'),
  ownerUserId: z.uuid().nullable().optional().describe('Who keeps it up to date (default: you)'),
});
const articleUpdate = z.strictObject({
  title: z.string().trim().min(1, 'Give the article a title').max(200).optional(),
  body: z.string().trim().min(1, 'Write the answer').max(20_000).optional(),
  tags: z.array(tag).max(20).optional(),
  status: z.enum(['draft', 'approved', 'archived']).optional(),
  ownerUserId: z.uuid().nullable().optional(),
});
const articlesQuery = z.strictObject({
  unitId: z.uuid(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['draft', 'approved', 'archived', 'all']).optional().describe('Default: drafts and approved'),
  tag: tag.optional(),
  cursor,
  limit: limit(100, 50),
});

export function aiRoutes(router) {
  router.get(
    '/ai/agents',
    describe({ summary: 'List AI agents and handover topics', description: 'The agent registry: input and output JSON Schemas, default thresholds, samples for the test panel.', responses: { 200: catalogSchema } }),
    requireAuth(),
    (_req, res) => {
      res.json({ data: agentCatalog() });
    },
  );

  router.get(
    '/ai/config',
    describe({ summary: 'Get a company’s AI guardrails and usage', description: 'Effective settings (change them with PUT /settings/:key), this month’s token usage and the AI connection calls use.', permission: VIEW, responses: { 200: configSchema } }),
    requireAuth(),
    validate({ query: z.strictObject({ companyId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await companyConfig(req, req.valid.query.companyId) });
    },
  );

  router.post(
    '/ai/test',
    describe({
      summary: 'Try an agent on an input',
      description: 'A dry run with the company’s guardrails: returns the output, confidence, guardrail decisions, the prompt and what a live call would log. Nothing is logged; tokens count against the budget. Audited as `ai.test_run`.',
      permission: MANAGE,
      rateLimited: true,
      responses: { 200: testResultSchema },
    }),
    requireAuth(),
    rateLimit({ name: 'ai-test', limit: 30, windowSeconds: 60, key: (req) => req.auth.user.id }),
    validate({ body: z.strictObject({ companyId: z.uuid(), agent: z.enum(AGENT_KEYS), input: z.record(z.string(), z.unknown()) }) }),
    async (req, res) => {
      res.json({ data: await testAgent(req, req.valid.body) });
    },
  );

  router.get(
    '/ai/actions',
    describe({ summary: 'List AI actions', description: 'The AI log in the working scope, newest first. "own" access lists actions on your own records.', permission: VIEW, list: true, responses: { 200: actionSchema } }),
    requireAuth(),
    validate({ query: actionsQuery }),
    async (req, res) => {
      res.json(await listActions(req, req.valid.query));
    },
  );

  router.get(
    '/ai/actions/:id',
    describe({ summary: 'Get an AI action', description: 'With its input. Phones and emails are masked without contacts.view_pii.', permission: [VIEW, REVIEW], responses: { 200: actionSchema } }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getAction(req, req.valid.params.id) });
    },
  );

  router.post(
    '/ai/actions/:id/review',
    describe({
      summary: 'Approve, edit or reject an AI output',
      description: 'For outputs waiting in the review queue. Emits `ai.review_resolved` so the feature that asked can continue, and adds a timeline entry when the action is about a record. 409 when it was already reviewed.',
      permission: REVIEW,
      errors: [409],
      responses: { 200: actionSchema },
    }),
    requireAuth(),
    validate({ params: idParams, body: reviewBody }),
    async (req, res) => {
      res.json({ data: await resolveReview(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.get(
    '/ai/reviews',
    describe({ summary: 'List the AI review queue', description: 'Outputs waiting for a person, oldest first.', permission: REVIEW, list: true, responses: { 200: actionSchema } }),
    requireAuth(),
    validate({ query: reviewsQuery }),
    async (req, res) => {
      res.json(await listReviews(req, req.valid.query));
    },
  );

  router.get(
    '/ai/reviews/summary',
    describe({ summary: 'Count the AI review queue', permission: REVIEW, responses: { 200: reviewSummarySchema } }),
    requireAuth(),
    validate({ query: z.strictObject({ unitId: z.uuid() }) }),
    async (req, res) => {
      res.json({ data: await reviewSummary(req, req.valid.query) });
    },
  );

  router.get(
    '/ai/knowledge',
    describe({ summary: 'List knowledge base articles', permission: VIEW, list: true, responses: { 200: articleSchema } }),
    requireAuth(),
    validate({ query: articlesQuery }),
    async (req, res) => {
      res.json(await listArticles(req, req.valid.query));
    },
  );

  router.get(
    '/ai/knowledge/search',
    describe({ summary: 'Find the articles the reply assistant would use', description: 'Only approved articles, best first, with a relevance from 0 to 1.', permission: VIEW, responses: { 200: z.array(retrievedArticleSchema) } }),
    requireAuth(),
    validate({ query: z.strictObject({ companyId: z.uuid(), q: z.string().trim().min(1).max(1000) }) }),
    async (req, res) => {
      res.json({ data: await searchKnowledge(req, req.valid.query) });
    },
  );

  router.post(
    '/ai/knowledge',
    describe({ summary: 'Add a knowledge base article', description: 'Emits `ai_knowledge.created`. Only approved articles are used by the reply assistant.', permission: KNOWLEDGE, status: 201, responses: { 201: articleSchema } }),
    requireAuth(),
    validate({ body: articleCreate }),
    async (req, res) => {
      res.status(201).json({ data: await createArticle(req, req.valid.body) });
    },
  );

  router.get(
    '/ai/knowledge/:id',
    describe({ summary: 'Get a knowledge base article', permission: VIEW, responses: { 200: articleSchema } }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getArticle(req, req.valid.params.id) });
    },
  );

  router.patch(
    '/ai/knowledge/:id',
    describe({ summary: 'Change a knowledge base article', description: 'Approving records who approved it; any other status clears that. Emits `ai_knowledge.updated` (or `.archived`).', permission: KNOWLEDGE, responses: { 200: articleSchema } }),
    requireAuth(),
    validate({ params: idParams, body: articleUpdate }),
    async (req, res) => {
      res.json({ data: await updateArticle(req, req.valid.params.id, req.valid.body) });
    },
  );

  router.delete(
    '/ai/knowledge/:id',
    describe({ summary: 'Archive a knowledge base article', description: 'It stays for history and can be restored by setting its status.', permission: KNOWLEDGE, status: 204 }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      await archiveArticle(req, req.valid.params.id);
      res.status(204).end();
    },
  );
}
