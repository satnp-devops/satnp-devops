// Response types of the automations API (apps/api/src/modules/automations, docs/automations/AUTOMATIONS.md).

export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type FlowKind = 'standard' | 'nurture';
export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------- Flow definitions (the engine's shape, AUTOMATION_CORE.md §1) ----------

export interface FlowTrigger {
  type: string;
  config?: JsonObject;
  filter?: string;
}

interface StepBase {
  id: string;
  label?: string;
  notes?: string;
}

export interface ConditionStep extends StepBase {
  type: 'condition';
  if: string;
  then?: string;
  else?: string;
}
export interface BranchStep extends StepBase {
  type: 'branch';
  cases: { label?: string; when: string; next?: string }[];
  otherwise?: string;
}
export interface WaitStep extends StepBase {
  type: 'wait';
  mode: 'duration' | 'until' | 'event';
  duration?: string;
  until?: { at?: string; timeOfDay?: string; timeZone?: string; daysOfWeek?: number[] };
  event?: string;
  filter?: string;
  timeout?: string;
  next?: string;
  onTimeout?: string;
}
export interface ActionStep extends StepBase {
  type: 'action';
  action: string;
  params?: JsonObject;
  await?: boolean;
  timeout?: string;
  next?: string;
  onError?: string;
}
export interface AiStep extends StepBase {
  type: 'ai_step';
  agent: string;
  input?: JsonObject;
  timeout?: string;
  next?: string;
  onError?: string;
}
export interface ApprovalStep extends StepBase {
  type: 'approval';
  title: string;
  body?: string;
  approvers: { permission?: string; userIds?: string[]; owner?: boolean };
  data?: JsonObject;
  timeout?: string;
  next?: string;
  onReject?: string;
  onTimeout?: string;
}
export interface EndStep extends StepBase {
  type: 'end';
  outcome?: 'completed' | 'cancelled';
  reason?: string;
}

export type FlowStep = ConditionStep | BranchStep | WaitStep | ActionStep | AiStep | ApprovalStep | EndStep;
export type StepType = FlowStep['type'];

export interface FlowSettings {
  timeZone: string;
  maxStepsPerRun?: number;
  reentry: 'allow' | 'skip_if_active' | 'once';
}

export interface FlowDefinition {
  key?: string;
  version?: number;
  name?: string;
  trigger: FlowTrigger;
  start: string;
  steps: FlowStep[];
  settings?: FlowSettings;
}

// ---------- API ----------

export interface FlowStats {
  activeRuns: number;
  runsLast7Days: number;
  failedLast7Days: number;
}

export interface MissingPermission {
  permission: string;
  stepIds: string[];
}

export interface AutomationFlow {
  id: string;
  companyId: string;
  unitId: string;
  unitName: string | null;
  key: string;
  name: string;
  description: string | null;
  kind: FlowKind;
  status: FlowStatus;
  triggerType: string;
  version: number;
  activeVersion: number | null;
  templateKey: string | null;
  nextFireAt: string | null;
  stepCount: number;
  definition?: FlowDefinition;
  stats: FlowStats | null;
  createdBy: string | null;
  updatedBy: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canManage?: boolean;
  missingPermissions?: MissingPermission[];
  savedVersion?: number | null;
}

export interface AutomationFlowVersion {
  id: string;
  flowId: string;
  version: number;
  triggerType: string;
  note: string | null;
  warnings: EngineIssue[];
  stats: { maxChain?: number; steps?: number } & Record<string, unknown>;
  definition?: FlowDefinition;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  active: boolean;
}

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  kind: FlowKind;
  category: string;
  triggerType: string;
  stepCount: number;
  definition: FlowDefinition;
}

/** An engine error or warning, as a field error (`path` under body.definition). */
export interface EngineIssue {
  path: string;
  message: string;
  code?: string;
  stepId?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: EngineIssue[];
  warnings: EngineIssue[];
  stats: Record<string, unknown> | null;
  missingPermissions: MissingPermission[];
}

/** JSON Schema as produced by zod (only the parts the forms read). */
export interface JsonSchema {
  type?: string | string[];
  enum?: Json[];
  const?: Json;
  default?: Json;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  pattern?: string;
  description?: string;
}

export interface CatalogTrigger {
  key: string;
  label: string;
  description: string | null;
  events: string[];
  subject: string | null;
  configSchema: JsonSchema | null;
  sample: { type: string; payload?: JsonObject } | null;
}
export interface CatalogAction {
  key: string;
  label: string;
  description: string | null;
  sideEffect: boolean;
  paramsSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  module: string;
}
export interface CatalogAgent {
  key: string;
  label: string;
  description: string | null;
  requiresApproval: boolean;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
}
export interface AutomationCatalog {
  triggers: CatalogTrigger[];
  actions: CatalogAction[];
  agents: CatalogAgent[];
  functions: Record<string, string>;
  executors: Record<string, string>;
  integrationActions: { key: string; owner: string; does: string }[];
  roots: string[];
  filterRoots: string[];
  limits: { maxSteps: number; maxCases: number; maxChain: number };
}

export interface TraceEntry {
  seq: number;
  at: string;
  phase: 'run' | 'resume';
  stepId: string | null;
  type: string;
  outcome: string;
  next: string | null;
  detail?: Record<string, Json> | null;
}

export interface SimulatedEffect {
  action: string;
  params: JsonObject;
  idempotencyKey: string;
  stepId: string;
  at: string;
  sideEffect: boolean;
  await?: boolean;
}

export interface SimulationResult {
  ok: boolean;
  errors?: EngineIssue[];
  warnings: EngineIssue[];
  matched?: boolean;
  matchReason?: string | null;
  matchError?: { code: string; message: string } | null;
  status?: RunStatus | 'not_started';
  path?: string[];
  branches?: { stepId: string; outcome: string; detail?: Record<string, Json> }[];
  effects?: SimulatedEffect[];
  waits?: { kind: string; stepId: string; until: string | null; from: string; event?: string }[];
  trace?: TraceEntry[];
  error?: { stepId: string | null; code: string; message: string } | null;
  endedAt?: string;
  record?: Record<string, Json>;
  now?: string;
}

export interface AutomationRun {
  id: string;
  companyId: string;
  unitId: string;
  flowId: string;
  flowName: string | null;
  flowKind: FlowKind | null;
  flowVersion: number;
  subject: { type: string; id: string; ref: string | null; label: string | null } | null;
  dealId: string | null;
  status: RunStatus;
  waiting: { kind: 'timer' | 'event' | 'effect' | 'approval'; event: string | null; stepId: string | null; until: string | null } | null;
  nextWakeAt: string | null;
  currentStepId: string | null;
  lastStep: { stepId: string | null; outcome: string; at: string } | null;
  stepCount: number;
  error: { stepId: string | null; code: string; message: string } | null;
  endReason: string | null;
  triggerType: string | null;
  triggerEventId: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface AutomationEffect {
  id: string;
  idempotencyKey: string;
  stepId: string;
  action: string;
  params: JsonObject;
  awaited: boolean;
  status: 'pending' | 'running' | 'done' | 'recorded' | 'failed' | 'skipped';
  executor: string | null;
  output: Json;
  error: { code: string; message: string } | null;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
}

export interface AutomationApproval {
  id: string;
  companyId: string;
  unitId: string;
  runId: string;
  flowId: string;
  flowName: string | null;
  stepId: string;
  subject: { type: string; id: string; label: string | null } | null;
  dealId: string | null;
  title: string;
  body: string | null;
  data: JsonObject | null;
  decisionData: JsonObject | null;
  approvers: { userIds: string[]; permission: string | null; ownerUserId: string | null };
  status: ApprovalStatus;
  edited: boolean;
  comment: string | null;
  decidedBy: { id: string; name: string | null } | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  canDecide: boolean;
  runStatus?: RunStatus | null;
}

export interface AutomationRunDetail extends AutomationRun {
  trigger: { id?: string | null; type: string | null; payload?: JsonObject; occurredAt?: string | null } | null;
  steps: TraceEntry[];
  traceDropped: number;
  stepStates: Record<string, { status?: string; output?: Json; error?: { code: string; message: string } | null; at?: string }>;
  effects: AutomationEffect[];
  approvals: AutomationApproval[];
  definition: FlowDefinition | null;
  canCancel: boolean;
}
