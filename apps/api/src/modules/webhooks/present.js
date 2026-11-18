// API shapes for webhook events and background jobs (schemas.js documents them).

export const iso = (value) => (value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export const unitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);

const person = (id, name) => (id ? { id, name: name ?? 'Someone' } : null);

/** A webhook_events row (joined with its connection name) as the delivery log shows it. */
export function presentWebhookEvent(row, { index, canReplay }) {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    connection: { id: row.connection_id, name: row.connection_name ?? 'Connection' },
    owner: unitRef(index.get(row.unit_id)),
    eventId: row.external_event_id ?? null,
    type: row.type ?? null,
    reference: row.reference ?? null,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error ?? null,
    duplicates: row.duplicates,
    handlerCount: row.handler_count ?? null,
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    lastReceivedAt: iso(row.last_received_at),
    nextAttemptAt: row.status === 'retrying' ? iso(row.next_attempt_at) : null,
    processedAt: iso(row.processed_at),
    failedAt: iso(row.failed_at),
    replayCount: row.replay_count,
    replayedAt: iso(row.replayed_at),
    canReplay: row.status === 'failed' && canReplay,
  };
}

export function presentWebhookEventDetail(row, { index, canReplay, canViewPayload }) {
  return {
    ...presentWebhookEvent(row, { index, canReplay }),
    payload: canViewPayload ? (row.payload ?? {}) : null,
    payloadHidden: !canViewPayload,
    completedHandlers: row.completed_handlers ?? [],
    sourceIp: row.source_ip ?? null,
    requestId: row.request_id ?? null,
    replayedBy: person(row.replayed_by, row.replayed_by_name),
  };
}

function progressOf(progress) {
  if (!progress) return null;
  const done = Number.isFinite(progress.done) ? progress.done : 0;
  const total = Number.isFinite(progress.total) ? progress.total : null;
  const percent = total ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : null;
  return { done, total, message: progress.message ?? null, percent };
}

/** A background_jobs row (joined with the creator's name). */
export function presentJob(row, { index, canRetry, canCancel }) {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    status: row.status,
    tracked: row.tracked,
    unit: unitRef(row.unit_id ? index.get(row.unit_id) : null),
    createdBy: person(row.created_by, row.created_by_name),
    progress: progressOf(row.progress),
    result: row.result ?? null,
    errorCount: row.error_count,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    failures: row.failures,
    lastError: row.last_error ?? null,
    runAt: iso(row.run_at),
    nextAttemptAt: row.status === 'retrying' ? iso(row.next_attempt_at) : null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    replayCount: row.replay_count,
    canRetry: row.status === 'failed' && canRetry,
    canCancel: (row.status === 'queued' || row.status === 'retrying') && canCancel,
  };
}

export function presentJobDetail(row, options) {
  return { ...presentJob(row, options), data: row.data ?? {}, errors: Array.isArray(row.errors) ? row.errors : [] };
}
