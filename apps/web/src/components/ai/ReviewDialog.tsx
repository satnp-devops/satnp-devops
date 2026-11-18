'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime, KeyValue, Mono, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { STATUS_LABEL, STATUS_TONE, formatTokens, isJsonObject, keyLabel } from '@/lib/ai/display';
import { aiKeys, useAiAction } from '@/lib/ai/queries';
import type { AiAction, Json, ReviewDecision } from '@/lib/ai/types';
import { actionSubject } from './ActionItem';
import { ConfidenceMeter, GuardrailList, ReasonChips } from './Guardrails';
import { OutputView } from './OutputView';
import './ai.css';

// Review one AI output: see what came in, what the AI answered and why it waits, then approve it,
// approve an edited version, or reject it. The API validates edits against the agent's schema.
// Outputs that do not wait (or that someone else must review) open read-only, with the decision.

const LONG_TEXT = new Set(['reply', 'message', 'summary', 'text', 'rationale', 'reason']);

/** One editable top-level field: text for strings and numbers, a checkbox for booleans, JSON for the rest. */
type Draft = Record<string, { kind: 'text' | 'number' | 'boolean' | 'json'; value: string | boolean; wasNull: boolean }>;

function toDraft(output: Json): Draft {
  if (!isJsonObject(output)) return {};
  const draft: Draft = {};
  for (const [key, value] of Object.entries(output)) {
    if (key === 'confidence') continue;
    if (typeof value === 'boolean') draft[key] = { kind: 'boolean', value, wasNull: false };
    else if (typeof value === 'number') draft[key] = { kind: 'number', value: String(value), wasNull: false };
    else if (typeof value === 'string' || value === null) draft[key] = { kind: 'text', value: value ?? '', wasNull: value === null };
    else draft[key] = { kind: 'json', value: JSON.stringify(value, null, 2), wasNull: false };
  }
  return draft;
}

function fromDraft(draft: Draft, original: Json): { output: Record<string, Json> } | { error: string; field: string } {
  const output: Record<string, Json> = {};
  for (const [key, field] of Object.entries(draft)) {
    if (field.kind === 'boolean') output[key] = field.value === true;
    else if (field.kind === 'number') {
      const n = Number(field.value);
      if (String(field.value).trim() === '' || !Number.isFinite(n)) return { error: 'Enter a number', field: key };
      output[key] = n;
    } else if (field.kind === 'text') {
      const text = String(field.value);
      output[key] = text === '' && field.wasNull ? null : text;
    } else {
      try {
        output[key] = JSON.parse(String(field.value)) as Json;
      } catch {
        return { error: 'This is not valid JSON', field: key };
      }
    }
  }
  if (isJsonObject(original) && typeof original.confidence === 'number') output.confidence = original.confidence;
  return { output };
}

export function ReviewDialog({ actionId, onClose, title = 'Review AI output' }: { actionId: string | null; onClose: () => void; title?: string }) {
  return (
    <Dialog open={Boolean(actionId)} onClose={onClose} title={title} size="lg">
      {actionId ? <ReviewBody actionId={actionId} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ReviewBody({ actionId, onClose }: { actionId: string; onClose: () => void }) {
  const action = useAiAction(actionId);
  if (action.isPending) return <PageLoading />;
  if (action.isError) {
    return (
      <DialogBody>
        <ErrorAlert error={action.error} />
      </DialogBody>
    );
  }
  return <ReviewForm action={action.data} onClose={onClose} />;
}

function ReviewForm({ action, onClose }: { action: AiAction; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(action.output));
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<{ field: string; message: string } | null>(null);

  const resolve = useMutation({
    mutationFn: (body: { decision: ReviewDecision; output?: Record<string, Json>; note?: string }) => api.post<AiAction>(`/ai/actions/${action.id}/review`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: aiKeys.all });
      onClose();
    },
  });

  const submit = (decision: ReviewDecision) => {
    setLocalError(null);
    const trimmed = note.trim() || undefined;
    if (decision !== 'edit') {
      resolve.mutate({ decision, note: trimmed });
      return;
    }
    const built = fromDraft(draft, action.output);
    if ('error' in built) {
      setLocalError({ field: built.field, message: built.error });
      return;
    }
    resolve.mutate({ decision, output: built.output, note: trimmed });
  };

  const serverErrors = fieldErrorsOf(resolve.error);
  const fieldError = (key: string) =>
    localError?.field === key ? localError.message : (serverErrors[`output.${key}`] ?? Object.entries(serverErrors).find(([path]) => path.startsWith(`output.${key}.`))?.[1]);
  const shown = Object.keys(draft).map((key) => `output.${key}`);
  const subject = actionSubject(action);
  const reviewable = action.canReview && action.status === 'pending_review';

  const reviewFooter = (
    <DialogFooter>
      <Button variant="danger" onClick={() => submit('reject')} disabled={resolve.isPending}>
        Reject
      </Button>
      {editing ? (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraft(toDraft(action.output));
              setLocalError(null);
            }}
            disabled={resolve.isPending}
          >
            Discard edits
          </Button>
          <Button variant="primary" icon="check" loading={resolve.isPending && resolve.variables?.decision === 'edit'} onClick={() => submit('edit')}>
            Save and approve
          </Button>
        </>
      ) : (
        <>
          <Button icon="edit" onClick={() => setEditing(true)} disabled={resolve.isPending || !isJsonObject(action.output)}>
            Edit
          </Button>
          <Button variant="primary" icon="check" loading={resolve.isPending && resolve.variables?.decision === 'approve'} onClick={() => submit('approve')}>
            Approve
          </Button>
        </>
      )}
    </DialogFooter>
  );

  return (
    <>
      <DialogBody>
        <div className="stack gap-16">
          <div className="stack gap-4">
            <div className="row gap-8">
              <span className="strong">{action.agentLabel}</span>
              <StatusPill tone={STATUS_TONE[action.status]}>{STATUS_LABEL[action.status]}</StatusPill>
            </div>
            <p className="small muted">
              {action.company.name}
              {subject ? ` · ${subject}` : ''} · <DateTime value={action.createdAt} format="short" />
            </p>
            <ReasonChips reasons={action.reviewReasons} />
          </div>

          {action.piiMasked ? (
            <Alert tone="info">Phone numbers and emails are hidden from you. Hidden values you leave unchanged are kept when you save.</Alert>
          ) : null}

          <section className="stack gap-8" aria-labelledby="ai-review-input">
            <h3 id="ai-review-input" className="small strong">
              What came in
            </h3>
            {action.input !== undefined ? <OutputView value={action.input} names={action.names} /> : <p className="small">{action.inputSummary}</p>}
          </section>

          <section className="stack gap-8" aria-labelledby="ai-review-output">
            <div className="row gap-8 ai-spread">
              <h3 id="ai-review-output" className="small strong">
                {editing ? 'Edit the output' : 'What the AI answered'}
              </h3>
              <ConfidenceMeter confidence={action.confidence} threshold={action.threshold} />
            </div>
            {editing ? (
              <div className="stack gap-12">
                {Object.entries(draft).map(([key, field]) =>
                  field.kind === 'boolean' ? (
                    <label key={key} className="check">
                      <input type="checkbox" checked={field.value === true} onChange={(e) => setDraft({ ...draft, [key]: { ...field, value: e.target.checked } })} />
                      {keyLabel(key)}
                    </label>
                  ) : (
                    <Field key={key} label={keyLabel(key)} error={fieldError(key)} hint={field.kind === 'json' ? 'JSON' : undefined}>
                      {(control) =>
                        field.kind === 'json' || LONG_TEXT.has(key) || String(field.value).length > 80 ? (
                          <textarea
                            {...control}
                            className={field.kind === 'json' ? 'textarea ai-test__json' : 'textarea'}
                            rows={field.kind === 'json' ? 6 : 4}
                            value={String(field.value)}
                            onChange={(e) => setDraft({ ...draft, [key]: { ...field, value: e.target.value } })}
                          />
                        ) : (
                          <input
                            {...control}
                            className="input"
                            inputMode={field.kind === 'number' ? 'decimal' : undefined}
                            value={String(field.value)}
                            onChange={(e) => setDraft({ ...draft, [key]: { ...field, value: e.target.value } })}
                          />
                        )
                      }
                    </Field>
                  ),
                )}
              </div>
            ) : (
              <OutputView value={action.output} hide={['confidence']} names={action.names} />
            )}
          </section>

          {action.error ? (
            <Alert tone="error" title="The call failed">
              {action.error.message ?? action.error.code}
            </Alert>
          ) : null}

          {action.status === 'edited' ? (
            <section className="stack gap-8" aria-labelledby="ai-review-final">
              <h3 id="ai-review-final" className="small strong">
                What the reviewer approved
              </h3>
              <OutputView value={action.finalOutput} hide={['confidence']} names={action.names} />
            </section>
          ) : null}

          {action.reviewer || action.reviewedAt ? (
            <p className="small">
              {STATUS_LABEL[action.status]} by {action.reviewer?.name ?? 'someone'}
              {action.reviewedAt ? (
                <>
                  {' '}
                  · <DateTime value={action.reviewedAt} format="short" />
                </>
              ) : null}
              {action.reviewNote ? <span className="muted"> · “{action.reviewNote}”</span> : null}
            </p>
          ) : null}

          <details className="ai-details">
            <summary>Guardrail decisions</summary>
            <GuardrailList results={action.guardrails} />
          </details>

          <details className="ai-details">
            <summary>Call details</summary>
            <KeyValue
              items={[
                { label: 'Model', value: action.model ? `${action.model}${action.mock ? ' (mock)' : ''}` : action.mock ? 'Mock' : null },
                { label: 'Tokens', value: `${formatTokens(action.usage.inputTokens)} in · ${formatTokens(action.usage.outputTokens)} out` },
                { label: 'Time', value: `${(action.latencyMs / 1000).toFixed(1)} s${action.attempts > 1 ? ` · ${action.attempts} attempts` : ''}` },
                { label: 'Started by', value: action.trigger === 'feature' ? 'A feature' : action.trigger === 'automation' ? 'An automation' : action.trigger === 'test' ? 'The test panel' : 'Sample data' },
                { label: 'Reference', value: action.reference ? <Mono>{action.reference}</Mono> : null },
                { label: 'Action id', value: <Mono>{action.id}</Mono> },
              ]}
            />
          </details>

          {reviewable ? (
            <Field label="Note" optional hint="Saved with your decision and shown on the timeline.">
              {(control) => <textarea {...control} className="textarea" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          ) : null}
          <ErrorAlert error={formErrorOf(resolve.error, shown)} />
        </div>
      </DialogBody>
      {reviewable ? (
        reviewFooter
      ) : (
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      )}
    </>
  );
}
