'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChannelBadge, DateTime, Mono, RelativeTime, StatusPill } from '@/components/crm';
import { Alert, Badge, Button, EmptyState, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { Guard } from '@/components/Guard';
import { api, errorMessage } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { useSession } from '@/lib/session';
import { intakeKeys, useReviewCounts, useReviewQueue } from '@/lib/intake/api';
import { CHANNEL_TYPE_LABELS, type ReviewAction, type ReviewContact, type ReviewItem, type ReviewKind } from '@/lib/intake/types';
import '@/components/intake/intake.css';

const KINDS: Array<{ kind: ReviewKind; label: string }> = [
  { kind: 'routing', label: 'Routing' },
  { kind: 'duplicate', label: 'Possible duplicates' },
  { kind: 'extraction', label: 'Extracted details' },
];

const REASONS: Record<string, string> = {
  low_confidence: 'The classifier was not sure which company this is for',
  ambiguous: 'Two companies scored too close to call',
  unknown_channel: 'No company has registered this channel',
  no_classifier: 'Arrived on a shared channel; no classifier is connected yet',
  classifier_error: 'The classifier failed',
  classifier_invalid: 'The classifier gave an unusable answer',
  out_of_scope: 'The classifier picked a company this channel does not serve',
  misconfigured_identity: 'The channel is registered without a company',
  possible_duplicate: 'This may be someone you already know',
  low_extraction_confidence: 'Check the details the assistant read from the message',
};

const RESOLUTIONS: Record<string, string> = {
  approved: 'Approved',
  overridden: 'Routed by hand',
  discarded: 'Discarded',
  merged: 'Merged',
  kept_separate: 'Kept separate',
  dismissed: 'Dismissed',
};

export function ReviewView() {
  return (
    <Guard anyOf={['intake.review']} anywhere>
      <Review />
    </Guard>
  );
}

function Review() {
  const { scope } = useSession();
  const params = useSearchParams();
  const [kind, setKind] = useState<ReviewKind>(() => KINDS.find((k) => k.kind === params.get('kind'))?.kind ?? 'routing');
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const counts = useReviewCounts(scope.id);
  const queue = useReviewQueue(scope.id, kind, status);
  const items = queue.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="stack gap-16">
      <div className="intake-toolbar">
        <div className="intake-segment" role="group" aria-label="Kind of decision">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>
              {k.label}
              {counts.data && counts.data[k.kind] > 0 ? ` (${counts.data[k.kind]})` : ''}
            </button>
          ))}
        </div>
        <div className="intake-segment" role="group" aria-label="Status">
          <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            To decide
          </button>
          <button type="button" aria-pressed={status === 'resolved'} onClick={() => setStatus('resolved')}>
            Decided
          </button>
        </div>
      </div>

      {queue.isPending ? (
        <PageLoading />
      ) : queue.isError ? (
        <ErrorAlert error={queue.error} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon="check" title={status === 'open' ? 'Nothing to decide' : 'No decisions yet'}>
            {status === 'open'
              ? kind === 'routing'
                ? 'Enquiries on shared channels that the classifier is unsure about wait here.'
                : kind === 'duplicate'
                  ? 'People who might already be known to the group wait here.'
                  : 'Details read from messages by the assistant wait here for a check.'
              : `Decisions made in ${scope.name} show here.`}
          </EmptyState>
        </div>
      ) : (
        <div className="intake-list">
          {items.map((item) => (
            <ReviewCard key={item.id} item={item} />
          ))}
          {queue.hasNextPage ? (
            <div className="row">
              <Button onClick={() => void queue.fetchNextPage()} loading={queue.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PersonBox({ label, person, fallbackName }: { label: string; person: ReviewContact | null; fallbackName?: string | null }) {
  return (
    <div className="intake-person">
      <span className="intake-person__label">{label}</span>
      <span className="intake-person__name">{person?.displayName ?? fallbackName ?? 'Unknown'}</span>
      {person?.primaryPhone ? <Mono>{person.primaryPhone}</Mono> : null}
      {person?.primaryEmail ? <Mono>{person.primaryEmail}</Mono> : null}
      {person?.city ? <span className="muted">{person.city}</span> : null}
      {person?.merged ? <Badge tone="warning">Merged since</Badge> : null}
    </div>
  );
}

function ReviewCard({ item }: { item: ReviewItem }) {
  const { unitsById, can } = useSession();
  const queryClient = useQueryClient();
  const person = item.enquiry.person;
  const reviewable = item.candidateCompanies.filter((c) => {
    const unit = unitsById.get(c.id);
    return unit ? can('intake.review', unit) : false;
  });
  const [companyId, setCompanyId] = useState<string>(item.suggestion.companyId && reviewable.some((c) => c.id === item.suggestion.companyId) ? item.suggestion.companyId : reviewable[0]?.id ?? '');
  const resolve = useMutation({
    mutationFn: (body: { action: ReviewAction; companyId?: string }) => api.post(`/intake/review/${item.id}/resolve`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: intakeKeys.reviewAll });
      await queryClient.invalidateQueries({ queryKey: crmKeys.deals.all });
      await queryClient.invalidateQueries({ queryKey: crmKeys.contacts.all });
    },
  });
  const open = item.status === 'open';
  // The server checks the merge right at the lead's unit; this only enables the button.
  const mergeUnit = item.unitId ? unitsById.get(item.unitId) : undefined;
  const title = person.name ?? person.phone ?? person.email ?? 'Someone';
  const confidence = item.confidence ?? item.suggestion.confidence;

  return (
    <article className="intake-item" aria-labelledby={`review-${item.id}`}>
      <div className="intake-item__head">
        <h2 className="intake-item__title" id={`review-${item.id}`}>
          {title}
        </h2>
        <div className="row gap-8">
          {confidence ? <span className="intake-score" title="Confidence">{Math.round(confidence * 100)}%</span> : null}
          {open ? <StatusPill tone="warning">To decide</StatusPill> : <StatusPill tone="success">{RESOLUTIONS[item.resolution ?? ''] ?? 'Decided'}</StatusPill>}
        </div>
      </div>
      <div className="intake-item__meta">
        <ChannelBadge channel={item.enquiry.channel} />
        <span>{CHANNEL_TYPE_LABELS[item.enquiry.channelType] ?? item.enquiry.channelType}</span>
        {item.enquiry.channelIdentity ? <Mono>{item.enquiry.channelIdentity}</Mono> : null}
        <RelativeTime value={item.enquiry.receivedAt} />
        {item.companyName ? <span>{item.companyName}</span> : null}
        {item.deal ? <Mono>{item.deal.ref}</Mono> : null}
      </div>
      <p className="muted">{REASONS[item.reason] ?? item.reason}{item.message && item.kind === 'duplicate' ? `: ${item.message}` : ''}</p>
      {person.message ? <p className="intake-item__message">{person.message}</p> : null}

      {item.kind === 'duplicate' ? (
        <div className="intake-compare">
          <PersonBox label="New enquiry" person={item.contact} fallbackName={person.name} />
          <PersonBox label="Already known" person={item.candidate} />
        </div>
      ) : (
        <div className="intake-item__meta">
          {person.phone ? <Mono>{person.phone}</Mono> : null}
          {person.email ? <Mono>{person.email}</Mono> : null}
          {person.studentName ? <span>Student: {person.studentName}{person.grade ? `, grade ${person.grade}` : ''}</span> : null}
          {person.instituteName ? <span>Institute: {person.instituteName}</span> : null}
          {person.piiMasked ? <Badge>Contact details hidden</Badge> : null}
        </div>
      )}

      {item.kind === 'routing' && item.suggestion.companyName ? (
        <p className="muted">
          Best guess: <span className="strong">{item.suggestion.companyName}</span>
          {item.suggestion.rationale ? ` (${item.suggestion.rationale})` : ''}
        </p>
      ) : null}

      {resolve.isError ? <Alert tone="error">{errorMessage(resolve.error)}</Alert> : null}

      {open ? (
        <div className="intake-item__actions">
          {item.kind === 'routing' ? (
            reviewable.length ? (
              <>
                <Field label="Company">
                  {(control) => (
                    <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                      {reviewable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Button
                  variant="primary"
                  loading={resolve.isPending}
                  disabled={!companyId}
                  onClick={() => resolve.mutate(companyId === item.suggestion.companyId ? { action: 'approve' } : { action: 'override', companyId })}
                >
                  {companyId === item.suggestion.companyId ? 'Approve' : 'Send to this company'}
                </Button>
                <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'discard' })}>
                  Not a lead
                </Button>
              </>
            ) : (
              <p className="muted">You can't route enquiries to any of these companies.</p>
            )
          ) : item.kind === 'duplicate' ? (
            <>
              <Button variant="primary" icon="merge" loading={resolve.isPending} disabled={!mergeUnit || !can('contacts.merge', mergeUnit)} onClick={() => resolve.mutate({ action: 'merge' })}>
                Same person: merge
              </Button>
              <Button disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'keep_separate' })}>
                Different people
              </Button>
              <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'dismiss' })}>
                Dismiss
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" loading={resolve.isPending} onClick={() => resolve.mutate({ action: 'approve' })}>
                Looks right
              </Button>
              <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'dismiss' })}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      ) : item.resolvedAt ? (
        <p className="muted">
          Decided <DateTime value={item.resolvedAt} />
          {item.resolutionNote ? ` · ${item.resolutionNote}` : ''}
        </p>
      ) : null}
    </article>
  );
}
