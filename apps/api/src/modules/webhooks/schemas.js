import { z } from 'zod';

// Response shapes for the OpenAPI document (docs/platform/OPENAPI.md section 4). They match
// present.js; apps/web/src/lib/webhooks/types.ts mirrors them for the web app.

const unitRef = z.object({ id: z.uuid(), name: z.string(), type: z.string() });
const time = z.iso.datetime();

export const WEBHOOK_STATUSES = Object.freeze(['queued', 'processing', 'retrying', 'processed', 'failed', 'rejected']);
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'retrying', 'completed', 'failed', 'cancelled']);

export const webhookEventSchema = z
  .object({
    id: z.uuid(),
    provider: z.string().describe('Provider key, e.g. razorpay or mock'),
    kind: z.string().describe('Adapter kind, e.g. payments'),
    connection: z.object({ id: z.uuid(), name: z.string() }),
    owner: unitRef.nullable().describe("The connection's owner: a company, or the group for a shared connection"),
    eventId: z.string().nullable().describe("The provider's event id (null for a rejected delivery)"),
    type: z.string().nullable().describe('Normalised event type, e.g. payment.captured'),
    reference: z.string().nullable().describe('Our own id the provider echoed back'),
    status: z.enum(WEBHOOK_STATUSES).describe('failed = dead letter (every attempt failed); rejected = signature or body refused'),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastError: z.string().nullable(),
    duplicates: z.number().int().describe('Redeliveries of the same event id, acknowledged and ignored'),
    handlerCount: z.number().int().nullable().describe('Handlers that ran, once processed'),
    occurredAt: time.nullable(),
    receivedAt: time,
    lastReceivedAt: time.nullable(),
    nextAttemptAt: time.nullable(),
    processedAt: time.nullable(),
    failedAt: time.nullable(),
    replayCount: z.number().int(),
    replayedAt: time.nullable(),
    canReplay: z.boolean(),
  })
  .meta({ id: 'WebhookEvent', description: 'One event a provider delivered, and how processing it went' });

export const webhookEventDetailSchema = webhookEventSchema
  .extend({
    payload: z.record(z.string(), z.unknown()).nullable().describe('The normalised event data; null when hidden (needs contacts.view_pii)'),
    payloadHidden: z.boolean(),
    completedHandlers: z.array(z.string()).describe('Handlers that finished (a retry skips them)'),
    sourceIp: z.string().nullable(),
    requestId: z.string().nullable(),
    replayedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  })
  .meta({ id: 'WebhookEventDetail' });

export const replayResultSchema = z.object({
  replayed: z.number().int(),
  remaining: z.number().int().describe('Failed events in scope still waiting for a replay (replay again for the next batch)'),
});

export const webhookAckSchema = z.object({
  received: z.number().int().describe('Events in the delivery'),
  accepted: z.number().int().describe('New events queued for processing'),
  duplicates: z.number().int().describe('Events already received before, acknowledged and ignored'),
});

export const jobSchema = z
  .object({
    id: z.uuid(),
    name: z.string().describe('The registered job, e.g. deals.bulk'),
    label: z.string().nullable(),
    status: z.enum(JOB_STATUSES).describe('failed = dead letter (every attempt failed)'),
    tracked: z.boolean().describe('False for a job that was only recorded when it failed its last attempt'),
    unit: unitRef.nullable(),
    createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    progress: z
      .object({ done: z.number().int(), total: z.number().int().nullable(), message: z.string().nullable(), percent: z.number().int().nullable() })
      .nullable(),
    result: z.unknown().describe('What the job returned, once completed'),
    errorCount: z.number().int().describe('Per-item problems the job reported (rows it skipped)'),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    failures: z.number().int().describe('How often it failed its last attempt (a repeating job folds its failures into one row)'),
    lastError: z.string().nullable(),
    runAt: time.nullable(),
    nextAttemptAt: time.nullable(),
    createdAt: time,
    startedAt: time.nullable(),
    finishedAt: time.nullable(),
    replayCount: z.number().int(),
    canRetry: z.boolean(),
    canCancel: z.boolean(),
  })
  .meta({ id: 'BackgroundJob', description: 'A background job: a bulk action, an import, or a job that failed every attempt' });

export const jobDetailSchema = jobSchema
  .extend({
    data: z.record(z.string(), z.unknown()).describe('The job payload'),
    errors: z.array(z.object({ message: z.string(), item: z.unknown().optional() })).describe('The first 200 per-item problems'),
  })
  .meta({ id: 'BackgroundJobDetail' });
