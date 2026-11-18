'use client';

import { useState } from 'react';
import { ActionItem } from '@/components/ai/ActionItem';
import { ReviewDialog } from '@/components/ai/ReviewDialog';
import { Guard } from '@/components/Guard';
import { Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { STATUS_LABEL, companyOfScope } from '@/lib/ai/display';
import { useAiActions, useAiCatalog } from '@/lib/ai/queries';
import type { ActionFilters, ActionStatus } from '@/lib/ai/types';
import { useSession } from '@/lib/session';

const STATUSES = Object.keys(STATUS_LABEL) as ActionStatus[];

/** The AI log: every agent call in the working scope, newest first ("own" access: your records). */
export function ActivityView() {
  return (
    <Guard anyOf={['ai.view']} anywhere>
      <Activity />
    </Guard>
  );
}

function Activity() {
  const session = useSession();
  const { scope } = session;
  const [filters, setFilters] = useState<ActionFilters>({ agent: '', status: '' });
  const [open, setOpen] = useState<{ id: string; reviewable: boolean } | null>(null);
  const catalog = useAiCatalog();
  const actions = useAiActions(scope.id, filters);
  const atGroup = !companyOfScope(session);

  if (actions.isPending || catalog.isPending) return <PageLoading />;
  if (actions.isError || catalog.isError) return <ErrorAlert error={actions.error ?? catalog.error} />;
  const items = actions.data.pages.flatMap((page) => page.data);
  const filtered = Boolean(filters.agent || filters.status);

  return (
    <Card flush title="AI activity" description="Every AI call with what came in, what it answered, its guardrail decisions and who reviewed it. AI actions about a lead or account also appear on its timeline.">
      <div className="toolbar ai-toolbar">
        <div className="ai-toolbar__filters">
          <label className="visually-hidden" htmlFor="ai-activity-agent">
            Agent
          </label>
          <select id="ai-activity-agent" className="select toolbar__select" value={filters.agent} onChange={(e) => setFilters({ ...filters, agent: e.target.value })}>
            <option value="">Every agent</option>
            {catalog.data.agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor="ai-activity-status">
            Status
          </label>
          <select
            id="ai-activity-status"
            className="select toolbar__select"
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value as ActionStatus | '' })}
          >
            <option value="">Every status</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters({ agent: '', status: '' })}>
              Clear filters
            </Button>
          ) : null}
        </div>
        {actions.isFetching && !actions.isFetchingNextPage ? <span className="small muted">Refreshing…</span> : null}
      </div>
      {items.length === 0 ? (
        <EmptyState icon="sparkle" title={filtered ? 'No AI actions match' : 'No AI activity yet'}>
          {filtered ? 'Try another agent or status.' : 'Each time an agent runs for a lead, a meeting or a message, it is logged here.'}
        </EmptyState>
      ) : (
        <ul className="ai-list">
          {items.map((item) => (
            <ActionItem key={item.id} item={item} showCompany={atGroup} onOpen={() => setOpen({ id: item.id, reviewable: item.canReview && item.status === 'pending_review' })} />
          ))}
        </ul>
      )}
      {actions.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => actions.fetchNextPage()} loading={actions.isFetchingNextPage}>
            Show more
          </Button>
        </div>
      ) : null}
      <ReviewDialog actionId={open?.id ?? null} title={open?.reviewable ? 'Review AI output' : 'AI output'} onClose={() => setOpen(null)} />
    </Card>
  );
}
