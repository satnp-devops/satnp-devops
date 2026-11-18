// Shapes of the webhooks and background jobs API (docs/platform/WEBHOOKS_AND_JOBS.md).
// They mirror apps/api/src/modules/webhooks/schemas.js.

export interface UnitRef {
  id: string;
  name: string;
  type: string;
}

export type WebhookStatus = 'queued' | 'processing' | 'retrying' | 'processed' | 'failed' | 'rejected';

export const WEBHOOK_STATUSES: readonly WebhookStatus[] = ['queued', 'processing', 'retrying', 'processed', 'failed', 'rejected'];

export interface WebhookEvent {
  id: string;
  provider: string;
  kind: string;
  connection: { id: string; name: string };
  owner: UnitRef | null;
  /** The provider's event id; null for a rejected delivery. */
  eventId: string | null;
  type: string | null;
  reference: string | null;
  status: WebhookStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  duplicates: number;
  handlerCount: number | null;
  occurredAt: string | null;
  receivedAt: string;
  lastReceivedAt: string | null;
  nextAttemptAt: string | null;
  processedAt: string | null;
  failedAt: string | null;
  replayCount: number;
  replayedAt: string | null;
  canReplay: boolean;
}

export interface WebhookEventDetail extends WebhookEvent {
  /** Null when hidden: it may contain contact details the viewer can't see. */
  payload: Record<string, unknown> | null;
  payloadHidden: boolean;
  completedHandlers: string[];
  sourceIp: string | null;
  requestId: string | null;
  replayedBy: { id: string; name: string } | null;
}

export interface WebhookSummary {
  queued: number;
  processing: number;
  retrying: number;
  failed: number;
}

export interface ReplayResult {
  replayed: number;
  remaining: number;
}

export interface WebhookFilters {
  provider: string;
  status: WebhookStatus | '';
  connectionId: string;
}

export type JobStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'retrying', 'completed', 'failed', 'cancelled'];

export interface JobProgress {
  done: number;
  total: number | null;
  message: string | null;
  percent: number | null;
}

export interface BackgroundJob {
  id: string;
  name: string;
  label: string | null;
  status: JobStatus;
  /** False for a job that was only recorded when it failed every attempt. */
  tracked: boolean;
  unit: UnitRef | null;
  createdBy: { id: string; name: string } | null;
  progress: JobProgress | null;
  result: unknown;
  errorCount: number;
  attempts: number;
  maxAttempts: number;
  failures: number;
  lastError: string | null;
  runAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  replayCount: number;
  canRetry: boolean;
  canCancel: boolean;
}

export interface BackgroundJobDetail extends BackgroundJob {
  data: Record<string, unknown>;
  errors: Array<{ message: string; item?: unknown }>;
}

export interface JobFilters {
  status: JobStatus | '';
  mine: boolean;
}
