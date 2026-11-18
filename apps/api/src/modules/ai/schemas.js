import { z } from 'zod';

// Response shapes of the AI module, for the OpenAPI document (docs/platform/OPENAPI.md). The
// presenters in present.js return exactly these; apps/web/src/lib/ai/types.ts mirrors them.

const ref = z.object({ id: z.uuid(), name: z.string() });
const iso = z.iso.datetime({ offset: true });

export const guardrailResultSchema = z
  .object({
    check: z.string(),
    outcome: z.enum(['pass', 'flag', 'block', 'handover']),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'AiGuardrailResult' });

export const actionSchema = z
  .object({
    id: z.uuid(),
    company: ref,
    unitId: z.uuid(),
    agent: z.string(),
    agentLabel: z.string(),
    trigger: z.enum(['feature', 'automation', 'test', 'seed']),
    reference: z.string().nullable(),
    subject: z.object({
      dealId: z.uuid().nullable(),
      dealRef: z.string().nullable(),
      dealTitle: z.string().nullable(),
      contactId: z.uuid().nullable(),
      contactName: z.string().nullable(),
      accountId: z.uuid().nullable(),
      accountName: z.string().nullable(),
    }),
    ownerUserId: z.uuid().nullable(),
    status: z.enum(['completed', 'pending_review', 'approved', 'edited', 'rejected', 'failed']),
    inputSummary: z.string().nullable(),
    input: z.unknown().optional().describe('Only on GET /ai/actions/:id'),
    names: z.record(z.string(), z.string()).optional().describe('Only on GET /ai/actions/:id: names of the companies, teams, product lines and products its input and output mention, by id'),
    output: z.unknown().nullable(),
    finalOutput: z.unknown().nullable(),
    confidence: z.number().nullable(),
    threshold: z.number().nullable(),
    guardrails: z.array(guardrailResultSchema),
    reviewReasons: z.array(z.string()),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    mock: z.boolean(),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
    latencyMs: z.number().int(),
    attempts: z.number().int(),
    error: z.object({ code: z.string(), message: z.string().nullable() }).nullable(),
    reviewer: ref.nullable(),
    reviewedAt: iso.nullable(),
    reviewNote: z.string().nullable(),
    piiMasked: z.boolean(),
    canReview: z.boolean(),
    createdAt: iso,
    updatedAt: iso,
  })
  .meta({ id: 'AiAction' });

export const reviewSummarySchema = z
  .object({ pending: z.number().int(), byAgent: z.record(z.string(), z.number().int()), oldestAt: iso.nullable() })
  .meta({ id: 'AiReviewSummary' });

export const articleSchema = z
  .object({
    id: z.uuid(),
    company: ref,
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()),
    status: z.enum(['draft', 'approved', 'archived']),
    owner: ref.nullable(),
    approvedBy: ref.nullable(),
    approvedAt: iso.nullable(),
    createdAt: iso,
    updatedAt: iso,
    canEdit: z.boolean(),
  })
  .meta({ id: 'AiKnowledgeArticle' });

export const retrievedArticleSchema = z
  .object({ id: z.uuid(), title: z.string(), tags: z.array(z.string()), relevance: z.number(), excerpt: z.string() })
  .meta({ id: 'AiRetrievedArticle' });

export const agentSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
    task: z.enum(['extract', 'classify', 'generate', 'summarise']),
    defaultThreshold: z.number(),
    alwaysReview: z.boolean(),
    customerFacing: z.boolean(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    sample: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'AiAgent' });

export const catalogSchema = z
  .object({
    agents: z.array(agentSchema),
    handoverTopics: z.array(z.object({ key: z.string(), label: z.string() })),
    genericTasks: z.array(z.object({ key: z.string(), label: z.string() })),
  })
  .meta({ id: 'AiCatalog' });

export const configSchema = z
  .object({
    company: ref,
    settings: z.object({
      enabledAgents: z.array(z.string()),
      mayQuoteFees: z.boolean(),
      mayQuoteDiscounts: z.boolean(),
      handoverTopics: z.array(z.string()),
      monthlyTokenBudget: z.number().int(),
      thresholds: z.record(z.string(), z.number()),
      sources: z.record(z.string(), z.uuid().nullable()).describe('Where each value is set: a unit id, or null for the default'),
    }),
    usage: z.object({ period: z.string(), calls: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), totalTokens: z.number().int() }),
    connection: z
      .object({ name: z.string(), provider: z.string(), mock: z.boolean(), fallback: z.boolean() })
      .nullable()
      .describe('The AI connection calls use, or null when there is none'),
    connectionProblem: z.string().nullable(),
    canEditSettings: z.boolean(),
    canTest: z.boolean(),
    canEditKnowledge: z.boolean(),
  })
  .meta({ id: 'AiConfig' });

export const testResultSchema = z
  .object({
    status: z.enum(['completed', 'pending_review', 'failed']),
    output: z.unknown().nullable(),
    confidence: z.number().nullable(),
    threshold: z.number().nullable(),
    guardrails: z.array(guardrailResultSchema),
    reviewReasons: z.array(z.string()),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    mock: z.boolean(),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
    latencyMs: z.number().int(),
    attempts: z.number().int(),
    error: z.object({ code: z.string(), message: z.string().nullable() }).nullable(),
    preview: z.object({
      request: z.object({ purpose: z.string(), system: z.string(), messages: z.array(z.object({ role: z.string(), content: z.string() })), maxTokens: z.number().int() }),
      log: z.record(z.string(), z.unknown()).describe('The ai_actions row a live call would write'),
      timeline: z.record(z.string(), z.unknown()).nullable(),
      context: z.record(z.string(), z.unknown()).describe('What the agent loaded: knowledge articles, candidates, programs'),
    }),
  })
  .meta({ id: 'AiTestResult' });
