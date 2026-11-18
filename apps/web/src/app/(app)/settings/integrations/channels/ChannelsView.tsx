'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { ChannelDialog } from '@/components/integrations/ChannelDialog';
import { Badge, Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { api } from '@/lib/api';
import { IDENTITY_ICON, identityLabel, ownerChoices } from '@/lib/integrations/display';
import { integrationKeys, useChannelIdentities, useConnections, useIntegrationCatalog } from '@/lib/integrations/queries';
import type { ChannelIdentity } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';

export function ChannelsView() {
  const session = useSession();
  const { scope } = session;
  const catalog = useIntegrationCatalog();
  const identities = useChannelIdentities(scope.id);
  const connections = useConnections(scope.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ChannelIdentity | null>(null);
  const [type, setType] = useState('');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (identity: ChannelIdentity) => api.delete(`/integrations/identities/${identity.id}`),
    onSuccess: async () => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.all });
    },
  });

  if (catalog.isPending || identities.isPending || connections.isPending) return <PageLoading />;
  if (catalog.isError || identities.isError || connections.isError) return <ErrorAlert error={catalog.error ?? identities.error ?? connections.error} />;

  const canAdd = ownerChoices(session, 'integrations.manage').length > 0;
  const types = [...new Set(identities.data.map((i) => i.type))];
  const rows = type ? identities.data.filter((i) => i.type === type) : identities.data;

  return (
    <Card
      flush
      title="Channels"
      description="The numbers, inboxes, forms, pages and links enquiries arrive on. An enquiry goes to the company that owns its channel."
      actions={
        canAdd ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
            Add channel
          </Button>
        ) : null
      }
    >
      {identities.data.length > 0 ? (
        <div className="toolbar int-toolbar">
          <label className="visually-hidden" htmlFor="int-channel-type">
            Channel type
          </label>
          <select id="int-channel-type" className="select toolbar__select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All channels ({identities.data.length})</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {identityLabel(t)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon="form" title="No channels registered">
          Register each company&apos;s WhatsApp numbers, inboxes, website forms and lead-ad pages so new enquiries reach the right company.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table int-table">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Number, inbox or id</th>
                <th scope="col">Belongs to</th>
                <th scope="col">Connection</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="row gap-8 nowrap">
                      <Icon name={IDENTITY_ICON[row.type] ?? 'link'} size={16} aria-hidden="true" />
                      <div className="stack gap-0">
                        <span className="strong">{identityLabel(row.type)}</span>
                        {row.label ? <span className="small muted">{row.label}</span> : null}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="mono int-identity">{row.identity}</span>
                  </td>
                  <td>
                    {row.shared ? (
                      <div className="stack gap-2 int-start">
                        <span>
                          <Badge>Shared</Badge>
                        </span>
                        <span className="small muted">{row.companies.map((c) => c.name).join(', ')}</span>
                      </div>
                    ) : (
                      (row.company?.name ?? '—')
                    )}
                  </td>
                  <td>{row.connection ? row.connection.name : <span className="muted">None</span>}</td>
                  <td className="cell-actions">
                    {row.canManage ? (
                      <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoving(row)} aria-label={`Remove ${identityLabel(row.type)} ${row.identity}`}>
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? <ChannelDialog catalog={catalog.data} connections={connections.data} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title="Remove this channel?"
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          New enquiries on <span className="mono">{removing?.identity}</span> will no longer be routed to its company. Leads that already came in keep their
          source.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
