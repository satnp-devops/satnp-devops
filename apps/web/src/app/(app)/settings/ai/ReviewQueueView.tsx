'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionItem } from '@/components/ai/ActionItem';
import { ReviewDialog } from '@/components/ai/ReviewDialog';
import { Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { companyOfScope } from '@/lib/ai/display';
import { useAiCatalog, useAiReviews } from '@/lib/ai/queries';
import { useSession } from '@/lib/session';

/** AI outputs waiting for a person, oldest first. Counsellors see the ones on their own records. */
export function ReviewQueueView() {
  const session = useSession();
  const router = useRouter();
  const canReview = session.canAnywhere('ai.review');

  // People who may see AI activity but not review it land on the log instead.
  useEffect(() => {
    if (!canReview) router.replace('/settings/ai/activity');
  }, [canReview, router]);

  if (!canReview) return <PageLoading />;
  return <ReviewQueue />;
}

function ReviewQueue() {
  const session = useSession();
  const { scope } = session;
  const [agent, setAgent] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const catalog = useAiCatalog();
  const reviews = useAiReviews(scope.id, agent);
  const atGroup = !companyOfScope(session);

  if (reviews.isPending || catalog.isPending) return <PageLoading />;
  if (reviews.isError || catalog.isError) return <ErrorAlert error={reviews.error ?? catalog.error} />;
  const items = reviews.data.pages.flatMap((page) => page.data);

  return (
    <Card
      flush
      title="Review queue"
      description="AI outputs that wait for a person: low confidence, a guardrail that blocked or flagged them, or agents whose drafts are always approved first. Your decision lets the feature that asked continue."
    >
      <div className="toolbar ai-toolbar">
        <div className="ai-toolbar__filters">
          <label className="visually-hidden" htmlFor="ai-review-agent">
            Agent
          </label>
          <select id="ai-review-agent" className="select toolbar__select" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Every agent</option>
            {catalog.data.agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        {reviews.isFetching && !reviews.isFetchingNextPage ? <span className="small muted">Refreshing…</span> : null}
      </div>
      {items.length === 0 ? (
        <EmptyState icon="check" title="Nothing waiting for review">
          When an AI answer needs a person, it shows up here{agent ? ' for this agent' : ''}.
        </EmptyState>
      ) : (
        <ul className="ai-list">
          {items.map((item) => (
            <ActionItem key={item.id} item={item} showCompany={atGroup} onOpen={() => setOpen(item.id)} />
          ))}
        </ul>
      )}
      {reviews.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => reviews.fetchNextPage()} loading={reviews.isFetchingNextPage}>
            Show more
          </Button>
        </div>
      ) : null}
      <ReviewDialog actionId={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
