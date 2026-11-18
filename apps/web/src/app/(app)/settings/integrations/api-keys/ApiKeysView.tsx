'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime, RelativeTime, StatusPill } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { ApiKeyDialog } from '@/components/integrations/ApiKeyDialog';
import { Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { api } from '@/lib/api';
import { KEY_STATUS_TONE, ownerChoices } from '@/lib/integrations/display';
import { integrationKeys, useApiKeys } from '@/lib/integrations/queries';
import type { ApiKey } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';

const STATUS_LABEL = { active: 'Active', revoked: 'Revoked', expired: 'Expired' } as const;

export function ApiKeysView() {
  const session = useSession();
  const { scope } = session;
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const keysQuery = useApiKeys(scope.id, status);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api.delete(`/api-keys/${key.id}`),
    onSuccess: async () => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.apiKeysAll });
    },
  });

  if (keysQuery.isPending) return <PageLoading />;
  if (keysQuery.isError) return <ErrorAlert error={keysQuery.error} />;

  const keys = keysQuery.data.pages.flatMap((page) => page.data);
  const canCreate = ownerChoices(session, 'api_keys.manage').length > 0;

  return (
    <Card
      flush
      title="API keys"
      description="Machine access for websites, scripts and partner systems: Authorization: Bearer phx_… acts with exactly the key's permissions, where it applies."
      actions={
        canCreate ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Create key
          </Button>
        ) : null
      }
    >
      <div className="toolbar int-toolbar">
        <label className="visually-hidden" htmlFor="int-key-status">
          Show
        </label>
        <select id="int-key-status" className="select toolbar__select" value={status} onChange={(e) => setStatus(e.target.value === 'all' ? 'all' : 'active')}>
          <option value="active">Active keys</option>
          <option value="all">All keys, including revoked</option>
        </select>
      </div>
      {keys.length === 0 ? (
        <EmptyState icon="key" title={status === 'active' ? 'No active keys' : 'No keys yet'}>
          Create a key for each system that calls the API, with only the permissions it needs.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table int-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Applies to</th>
                <th scope="col">Permissions</th>
                <th scope="col">Last used</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>
                    <div className="stack gap-0">
                      <span className="strong">{key.name}</span>
                      <span className="mono small muted">{key.prefix}…</span>
                      <span className="small muted">
                        by {key.createdBy?.name ?? 'someone'} · <DateTime value={key.createdAt} format="date" sans />
                      </span>
                    </div>
                  </td>
                  <td>{key.unit?.name ?? '—'}</td>
                  <td>
                    <ul className="int-scope-list">
                      {key.scopes.map((s) => (
                        <li key={s} className="mono small">
                          {s}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="nowrap">{key.lastUsedAt ? <RelativeTime value={key.lastUsedAt} sans /> : <span className="muted">Never</span>}</td>
                  <td className="nowrap">
                    <StatusPill tone={KEY_STATUS_TONE[key.status]}>{STATUS_LABEL[key.status]}</StatusPill>
                    {key.expiresAt && key.status === 'active' ? (
                      <span className="small muted int-expiry">
                        until <DateTime value={key.expiresAt} format="date" sans />
                      </span>
                    ) : null}
                  </td>
                  <td className="cell-actions">
                    {key.status === 'active' ? (
                      <Button size="sm" variant="ghost" icon="x" onClick={() => setRevoking(key)} aria-label={`Revoke ${key.name}`}>
                        Revoke
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {keysQuery.hasNextPage ? (
        <div className="load-more">
          <Button onClick={() => keysQuery.fetchNextPage()} loading={keysQuery.isFetchingNextPage}>
            Show more
          </Button>
        </div>
      ) : null}

      {creating ? <ApiKeyDialog onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        title={`Revoke ${revoking?.name ?? 'this key'}?`}
        confirmLabel="Revoke key"
        danger
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      >
        <p>Requests with this key fail from now on. This can&apos;t be undone; create a new key if it is still needed.</p>
      </ConfirmDialog>
    </Card>
  );
}
