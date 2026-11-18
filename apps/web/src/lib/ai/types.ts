// Types of the AI service API (apps/api/src/modules/ai/schemas.js, docs/platform/AI.md).

export type AgentKey = 'intake' | 'classifier' | 'reply' | 'meeting_summary' | 'follow_up' | 'payment_chaser' | 'b2b_qualifier';
export type ActionStatus = 'completed' | 'pending_review' | 'approved' | 'edited' | 'rejected' | 'failed';
export type GuardrailOutcome = 'pass' | 'flag' | 'block' | 'handover';
export type ReviewDecision = 'approve' | 'edit' | 'reject';
export type ArticleStatus = 'draft' | 'approved' | 'archived';

/** A JSON value as the API sends it. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Ref {
  id: string;
  name: string;
}

export interface GuardrailResult {
  check: string;
  outcome: GuardrailOutcome;
  message: string;
  details?: Record<string, unknown>;
}

export interface AgentInfo {
  key: AgentKey;
  label: string;
  description: string;
  task: 'extract' | 'classify' | 'generate' | 'summarise';
  defaultThreshold: number;
  alwaysReview: boolean;
  customerFacing: boolean;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  sample: JsonObject;
}

export interface AiCatalog {
  agents: AgentInfo[];
  handoverTopics: Array<{ key: string; label: string }>;
  genericTasks: Array<{ key: string; label: string }>;
}

export interface AiSettings {
  enabledAgents: string[];
  mayQuoteFees: boolean;
  mayQuoteDiscounts: boolean;
  handoverTopics: string[];
  monthlyTokenBudget: number;
  thresholds: Record<string, number>;
  /** Where each setting is set: a unit id, or null for the default. */
  sources: Record<string, string | null>;
}

export interface AiUsage {
  period: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiConfig {
  company: Ref;
  settings: AiSettings;
  usage: AiUsage;
  connection: { name: string; provider: string; mock: boolean; fallback: boolean } | null;
  connectionProblem: string | null;
  canEditSettings: boolean;
  canTest: boolean;
  canEditKnowledge: boolean;
}

export interface AiAction {
  id: string;
  company: Ref;
  unitId: string;
  agent: string;
  agentLabel: string;
  trigger: 'feature' | 'automation' | 'test' | 'seed';
  reference: string | null;
  subject: {
    dealId: string | null;
    dealRef: string | null;
    dealTitle: string | null;
    contactId: string | null;
    contactName: string | null;
    accountId: string | null;
    accountName: string | null;
  };
  ownerUserId: string | null;
  status: ActionStatus;
  inputSummary: string | null;
  /** Only on GET /ai/actions/:id. */
  input?: Json;
  /** Only on GET /ai/actions/:id: names of the companies, teams, product lines and products it mentions, by id. */
  names?: Record<string, string>;
  output: Json;
  finalOutput: Json;
  confidence: number | null;
  threshold: number | null;
  guardrails: GuardrailResult[];
  reviewReasons: string[];
  provider: string | null;
  model: string | null;
  mock: boolean;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  attempts: number;
  error: { code: string; message: string | null } | null;
  reviewer: Ref | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  piiMasked: boolean;
  canReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSummary {
  pending: number;
  byAgent: Record<string, number>;
  oldestAt: string | null;
}

export interface KnowledgeArticle {
  id: string;
  company: Ref;
  title: string;
  body: string;
  tags: string[];
  status: ArticleStatus;
  owner: Ref | null;
  approvedBy: Ref | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

export interface RetrievedArticle {
  id: string;
  title: string;
  tags: string[];
  relevance: number;
  excerpt: string;
}

export interface TestResult {
  status: 'completed' | 'pending_review' | 'failed';
  output: Json;
  confidence: number | null;
  threshold: number | null;
  guardrails: GuardrailResult[];
  reviewReasons: string[];
  provider: string | null;
  model: string | null;
  mock: boolean;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  attempts: number;
  error: { code: string; message: string | null } | null;
  preview: {
    request: { purpose: string; system: string; messages: Array<{ role: string; content: string }>; maxTokens: number };
    log: JsonObject;
    timeline: JsonObject | null;
    context: JsonObject;
  };
}

export interface ActionFilters {
  agent: string;
  status: ActionStatus | '';
}
