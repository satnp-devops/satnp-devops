'use client';

import { Fragment, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime, Mono } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { Badge, Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { api } from '@/lib/api';
import { KIND_ICON, ownerChoices, operationLabel } from '@/lib/integrations/display';
import { integrationKeys, useIntegrationCatalog, useSandbox } from '@/lib/integrations/queries';
import type { KindKey, SandboxMessage } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';

export function SandboxView() {
  const session = useSession();
  const { scope } = session;
  const catalog = useIntegrationCatalog();
  const [kind, setKind] = useState<KindKey | ''>('');
  const outbox = useSandbox(scope.id, kind);
  const [open, setOpen] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api.delete('/integrations/sandbox', { unitId: scope.id }),
    onSuccess: async () => {
      setClearing(false);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.all });
    },
  });

  if (catalog.isPending || outbox.isPending) return <PageLoading />;
  if (catalog.isError || outbox.isError) return <ErrorAlert error={catalog.error ?? outbox.error} />;

  const messages = outbox.data.pages.flatMap((page) => page.data);
  const labelOf = (key: KindKey) => catalog.data.kinds.find((k) => k.key === key)?.label ?? key;
  // The API clears the outbox of the companies in scope where the user manages integrations.
  const canClear = ownerChoices(session, 'integrations.manage').some((u) => u.type === 'company');

  return (
    <Card
      flush
      title="Sandbox outbox"
      description="Everything the mock adapters sent instead of a real provider: messages, calls, meetings, payment links, signing requests, AI answers and files. Newest first."
      actions={
        canClear && messages.length > 0 ? (
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setClearing(true)}>
            Clear
          </Button>
        ) : null
      }
    >
      <div className="toolbar int-toolbar">
        <label className="visually-hidden" htmlFor="int-sandbox-kind">
          Kind
        </label>
        <select id="int-sandbox-kind" className="select toolbar__select" value={kind} onChange={(e) => setKind(e.target.value as KindKey | '')}>
          <option value="">Every kind</option>
          {catalog.data.kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      {messages.length === 0 ? (
        <EmptyState icon="inbox" title="Nothing sent yet">
          When features send through a mock connection (or you press Try on a connection), it shows up here.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table int-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">To</th>
                <th scope="col">Content</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <Fragment key={m.id}>
                  <tr>
                    <td className="nowrap">
                      <DateTime value={m.createdAt} format="short" />
                    </td>
                    <td>
                      <div className="row gap-8 nowrap">
                        <Icon name={KIND_ICON[m.kind]} size={16} aria-hidden="true" />
                        <div className="stack gap-0">
                          <span className="strong">{operationLabel(m.operation)}</span>
                          <span className="small muted">
                            {labelOf(m.kind)}
                            {m.company ? ` · ${m.company.name}` : ''}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>{m.recipient ? <span className="mono int-identity">{m.recipient}</span> : <span className="muted">—</span>}</td>
                    <td>
                      <div className="stack gap-0 int-sandbox__content">
                        {m.subject ? <span className="strong">{m.subject}</span> : null}
                        {m.body ? <span className="small int-clamp">{m.body}</span> : null}
                        {m.status ? (
                          <span>
                            <Badge>{m.status}</Badge>
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="cell-actions">
                      <Button size="sm" variant="ghost" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
                        {open === m.id ? 'Hide' : 'Details'}
                      </Button>
                    </td>
                  </tr>
                  {open === m.id ? (
                    <tr className="int-sandbox__details">
                      <td colSpan={5}>
                        <Details message={m} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {outbox.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => outbox.fetchNextPage()} loading={outbox.isFetchingNextPage}>
            Show older
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={clearing}
        onClose={() => {
          setClearing(false);
          clear.reset();
        }}
        title="Clear the sandbox outbox?"
        confirmLabel="Clear"
        danger
        pending={clear.isPending}
        error={clear.error}
        onConfirm={() => clear.mutate()}
      >
        <p>This removes what the mocks recorded for the companies you manage here. Mock payments and signing requests then can&apos;t be looked up any more.</p>
      </ConfirmDialog>
    </Card>
  );
}

function Details({ message: m }: { message: SandboxMessage }) {
  return (
    <div className="stack gap-8">
      <dl className="int-dl small">
        <dt>Connection</dt>
        <dd>{m.connection?.name ?? 'Built-in mock'}</dd>
        {m.providerRef ? (
          <>
            <dt>Provider id</dt>
            <dd>
              <Mono>{m.providerRef}</Mono>
            </dd>
          </>
        ) : null}
        {m.reference ? (
          <>
            <dt>Our reference</dt>
            <dd>
              <Mono>{m.reference}</Mono>
            </dd>
          </>
        ) : null}
      </dl>
      {m.payload ? (
        <pre className="code-pre int-payload">{JSON.stringify(m.payload, null, 2)}</pre>
      ) : (
        <p className="small muted">The full payload is hidden: it may contain contact details you don&apos;t have access to.</p>
      )}
    </div>
  );
}
