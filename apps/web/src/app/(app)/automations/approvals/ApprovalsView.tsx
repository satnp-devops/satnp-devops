'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime, RelativeTime } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Icon } from '@/components/icons';
import { Button, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { automationKeys, useApprovals } from '@/lib/automations/queries';
import type { ApprovalStatus, AutomationApproval, JsonObject } from '@/lib/automations/types';
import { humanize } from '@/lib/crm/format';
import { useSession } from '@/lib/session';
import { ApprovalStatusPill, JsonBlock, Segmented } from '../shared';

type Filter = 'pending' | 'decided' | 'all';

export function ApprovalsView() {
  return (
    <Guard anyOf={['automations.approve']} anywhere>
      <Approvals />
    </Guard>
  );
}

function Approvals() {
  const { scope } = useSession();
  const [filter, setFilter] = useState<Filter>('pending');
  const approvals = useApprovals(scope.id, { status: filter as ApprovalStatus | 'decided' | 'all' });
  const items = approvals.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="stack gap-16">
      <div className="auto-toolbar auto-toolbar--plain">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pending', label: 'Waiting' },
            { value: 'decided', label: 'Decided' },
            { value: 'all', label: 'All' },
          ]}
        />
        <p className="small muted">Flows pause here until someone approves, edits or rejects what they want to do.</p>
      </div>
      {approvals.isPending ? <PageLoading /> : null}
      <ErrorAlert error={approvals.error} />
      {!approvals.isPending && items.length === 0 && !approvals.isError ? (
        <div className="card auto-empty">
          <Icon name="check" size={28} />
          <p>
            <strong>{filter === 'pending' ? 'Nothing waiting for you.' : 'No approvals here yet.'}</strong>
          </p>
          <p className="small muted">When a flow asks for a person, such as before sending an AI-written follow-up, it shows up here.</p>
        </div>
      ) : null}
      <ul className="auto-approvals">
        {items.map((item) => (
          <li key={item.id}>
            <ApprovalCard approval={item} />
          </li>
        ))}
      </ul>
      {approvals.hasNextPage ? (
        <Button loading={approvals.isFetchingNextPage} onClick={() => void approvals.fetchNextPage()}>
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: AutomationApproval }) {
  const queryClient = useQueryClient();
  const proposed = (approval.decisionData ?? approval.data ?? {}) as JsonObject;
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      const changed = Object.fromEntries(Object.entries(edits).filter(([k, v]) => v !== proposed[k]));
      return api.post<AutomationApproval>(`/automations/approvals/${approval.id}/${decision}`, {
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(decision === 'approve' && Object.keys(changed).length ? { data: changed } : {}),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: automationKeys.all }),
  });
  const errors = fieldErrorsOf(decide.error);
  const editable = approval.canDecide;
  const headingId = `approval-${approval.id}`;

  return (
    <article className="card auto-approval" aria-labelledby={headingId}>
      <div className="auto-approval__head">
        <div>
          <h3 id={headingId}>{approval.title}</h3>
          <p className="small muted">
            {approval.flowName ? <Link href={`/automations/flows/${approval.flowId}`}>{approval.flowName}</Link> : 'A flow'}
            {approval.subject?.label ? (
              <>
                {' · '}
                <Link href={`/leads/${approval.subject.id}`}>{approval.subject.label}</Link>
              </>
            ) : null}
            {' · '}asked <RelativeTime value={approval.createdAt} sans />
            {approval.expiresAt && approval.status === 'pending' ? (
              <>
                {' · '}expires <DateTime value={approval.expiresAt} format="short" sans />
              </>
            ) : null}
          </p>
        </div>
        <ApprovalStatusPill status={approval.status} canDecide={approval.canDecide} />
      </div>
      {approval.body ? <p>{approval.body}</p> : null}
      {Object.keys(proposed).length > 0 ? (
        <div className="stack gap-12">
          {Object.entries(proposed).map(([key, value]) =>
            typeof value === 'string' ? (
              <Field key={key} label={humanize(key)} error={errors[`body.data.${key}`]}>
                {(control) =>
                  editable ? (
                    <textarea
                      {...control}
                      className="textarea"
                      rows={Math.min(10, Math.max(3, Math.ceil(value.length / 70)))}
                      value={edits[key] ?? value}
                      maxLength={5000}
                      onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                    />
                  ) : (
                    <p {...control} className="auto-quote">
                      {value}
                    </p>
                  )
                }
              </Field>
            ) : (
              <div key={key}>
                <p className="field__label">{humanize(key)}</p>
                <JsonBlock value={value} />
              </div>
            ),
          )}
        </div>
      ) : null}
      {approval.status !== 'pending' ? (
        <p className="small muted">
          {approval.status === 'approved' || approval.status === 'rejected'
            ? `${approval.status === 'approved' ? 'Approved' : 'Rejected'} by ${approval.decidedBy?.name ?? 'someone'}${approval.edited ? ' with edits' : ''}`
            : approval.status === 'expired'
              ? 'Nobody decided in time.'
              : 'The run stopped, so this was withdrawn.'}
          {approval.comment ? ` · “${approval.comment}”` : ''}
        </p>
      ) : null}
      {editable ? (
        <div className="stack gap-12">
          <Field label="Comment" optional>
            {(control) => <input {...control} className="input" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />}
          </Field>
          <ErrorAlert error={formErrorOf(decide.error, Object.keys(proposed).map((k) => `body.data.${k}`))} />
          <div className="row gap-8">
            <Button variant="primary" icon="check" loading={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              {Object.entries(edits).some(([k, v]) => v !== proposed[k]) ? 'Approve with edits' : 'Approve'}
            </Button>
            <Button variant="danger" icon="x" loading={decide.isPending && decide.variables === 'reject'} disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
              Reject
            </Button>
          </div>
        </div>
      ) : approval.status === 'pending' ? (
        <p className="small muted">Waiting for {approval.approvers.ownerUserId ? 'the record owner' : 'an approver'}.</p>
      ) : null}
    </article>
  );
}
