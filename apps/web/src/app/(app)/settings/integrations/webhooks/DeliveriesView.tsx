'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EventTable } from '@/components/webhooks/EventTable';
import { Button, Card, CopyButton, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { formatCount } from '@/lib/crm/format';
import { useConnections } from '@/lib/integrations/queries';
import { useSession } from '@/lib/session';
import { WEBHOOK_STATUS_LABEL, webhookUrl } from '@/lib/webhooks/display';
import { useWebhookEvents, useWebhookSummary } from '@/lib/webhooks/queries';
import { WEBHOOK_STATUSES, type WebhookFilters, type WebhookStatus } from '@/lib/webhooks/types';

/** Kinds whose providers call us back (the AI and storage kinds never do). */
const NO_WEBHOOKS = new Set(['ai', 'storage']);

export function DeliveriesView() {
  const { scope, canAnywhere } = useSession();
  const [filters, setFilters] = useState<WebhookFilters>({ provider: '', status: '', connectionId: '' });
  const events = useWebhookEvents(scope.id, filters);
  const summary = useWebhookSummary(scope.id);
  const connections = useConnections(scope.id, canAnywhere('integrations.view'));

  if (events.isPending) return <PageLoading />;
  if (events.isError) return <ErrorAlert error={events.error} />;

  const rows = events.data.pages.flatMap((page) => page.data);
  const hookConnections = (connections.data ?? []).filter((c) => !NO_WEBHOOKS.has(c.kind));
  const providers = [...new Set(hookConnections.map((c) => c.provider))].sort();
  const selected = hookConnections.find((c) => c.id === filters.connectionId) ?? null;
  const filtered = Boolean(filters.provider || filters.status || filters.connectionId);
  const set = (patch: Partial<WebhookFilters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <Card
      flush
      title="Webhook deliveries"
      description="Every event providers sent to the connections in this scope, newest first. Each is verified, stored once (redeliveries are ignored) and processed in the background with retries."
    >
      {summary.data && (summary.data.failed > 0 || summary.data.retrying > 0 || summary.data.queued + summary.data.processing > 0) ? (
        <div className="wh-summary" aria-live="polite">
          {summary.data.failed > 0 ? (
            <span className="wh-summary__failed">
              <strong>{formatCount(summary.data.failed)}</strong> dead letter{summary.data.failed === 1 ? '' : 's'} ·{' '}
              <Link href="/settings/integrations/webhooks/dead-letters">review and replay</Link>
            </span>
          ) : null}
          {summary.data.retrying > 0 ? (
            <span>
              <strong>{formatCount(summary.data.retrying)}</strong> retrying
            </span>
          ) : null}
          {summary.data.queued + summary.data.processing > 0 ? (
            <span>
              <strong>{formatCount(summary.data.queued + summary.data.processing)}</strong> waiting
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="toolbar wh-toolbar">
        <label className="visually-hidden" htmlFor="wh-provider">
          Provider
        </label>
        <select id="wh-provider" className="select toolbar__select" value={filters.provider} onChange={(e) => set({ provider: e.target.value })}>
          <option value="">Every provider</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor="wh-status">
          Status
        </label>
        <select id="wh-status" className="select toolbar__select" value={filters.status} onChange={(e) => set({ status: e.target.value as WebhookStatus | '' })}>
          <option value="">Every status</option>
          {WEBHOOK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {WEBHOOK_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {hookConnections.length > 0 ? (
          <>
            <label className="visually-hidden" htmlFor="wh-connection">
              Connection
            </label>
            <select id="wh-connection" className="select toolbar__select" value={filters.connectionId} onChange={(e) => set({ connectionId: e.target.value })}>
              <option value="">Every connection</option>
              {hookConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {filtered ? (
          <Button size="sm" variant="ghost" onClick={() => setFilters({ provider: '', status: '', connectionId: '' })}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {selected ? (
        <div className="wh-url">
          <span className="muted">Webhook URL for {selected.name}:</span>
          <code>{webhookUrl(window.location.origin, selected.provider, selected.id)}</code>
          <CopyButton text={webhookUrl(window.location.origin, selected.provider, selected.id)} label="Copy URL" />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon="inbox" title={filtered ? 'No deliveries match these filters' : 'No webhooks received yet'}>
          {filtered
            ? 'Try another provider, status or connection.'
            : 'When a provider calls a connection’s webhook URL (payments, messages, meetings, e-sign), each event shows up here with how processing went.'}
        </EmptyState>
      ) : (
        <EventTable events={rows} showOwner={scope.type === 'group'} />
      )}
      {events.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => events.fetchNextPage()} loading={events.isFetchingNextPage}>
            Show older
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
