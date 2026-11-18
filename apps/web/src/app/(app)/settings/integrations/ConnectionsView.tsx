'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RelativeTime, StatusPill } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { ConnectionDialog } from '@/components/integrations/ConnectionDialog';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { HEALTH_LABEL, HEALTH_TONE, KIND_ICON, companyOfScope, groupCompanies, ownerChoices } from '@/lib/integrations/display';
import { integrationKeys, useConnections, useIntegrationCatalog } from '@/lib/integrations/queries';
import type { Connection, ConnectionTest, KindInfo, TryOutcome } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';

type Notice = { connectionId: string; tone: 'success' | 'error' | 'info'; text: string };

export function ConnectionsView() {
  const { canAnywhere } = useSession();
  if (!canAnywhere('integrations.view')) {
    return (
      <Card>
        <EmptyState icon="plug" title="Connections are managed by your admins" action={<ButtonLink href="/settings/integrations/api-keys">Open API keys</ButtonLink>}>
          You can manage API keys here, but seeing connected providers needs the &ldquo;See integrations&rdquo; permission.
        </EmptyState>
      </Card>
    );
  }
  return <Connections />;
}

function Connections() {
  const session = useSession();
  const { scope } = session;
  const catalog = useIntegrationCatalog();
  const connections = useConnections(scope.id);
  const [dialog, setDialog] = useState<{ kind: KindInfo; connection: Connection | null } | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [companyFilter, setCompanyFilter] = useState('');
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: integrationKeys.all });

  const test = useMutation({
    mutationFn: (c: Connection) => api.post<ConnectionTest>(`/integrations/connections/${c.id}/test`),
    onSuccess: async (data, c) => {
      setNotice({ connectionId: c.id, tone: data.result.ok ? 'success' : 'error', text: data.result.message });
      await refresh();
    },
    onError: (error, c) => setNotice({ connectionId: c.id, tone: 'error', text: errorMessage(error) }),
  });
  const tryIt = useMutation({
    mutationFn: (c: Connection) => api.post<TryOutcome>(`/integrations/connections/${c.id}/try`),
    onSuccess: async (data, c) => {
      setNotice({
        connectionId: c.id,
        tone: data.ok ? 'success' : 'error',
        text: data.ok ? `Made a sample ${data.method}() call. It is in the sandbox outbox.` : (data.error?.message ?? 'The sample call failed'),
      });
      await refresh();
    },
    onError: (error, c) => setNotice({ connectionId: c.id, tone: 'error', text: errorMessage(error) }),
  });
  const makeDefault = useMutation({
    mutationFn: ({ c, companyId }: { c: Connection; companyId: string }) => api.post<Connection>(`/integrations/connections/${c.id}/default`, { companyId }),
    onSuccess: refresh,
    onError: (error, { c }) => setNotice({ connectionId: c.id, tone: 'error', text: errorMessage(error) }),
  });
  const disconnect = useMutation({
    mutationFn: (c: Connection) => api.delete(`/integrations/connections/${c.id}`),
    onSuccess: async () => {
      setDisconnecting(null);
      await refresh();
    },
  });

  if (catalog.isPending || connections.isPending) return <PageLoading />;
  if (catalog.isError || connections.isError) return <ErrorAlert error={catalog.error ?? connections.error} />;

  const company = companyOfScope(session);
  const companies = groupCompanies(session);
  const canConnect = ownerChoices(session, 'integrations.manage').length > 0;
  const canOperate = (c: Connection) =>
    c.canManage ||
    c.companies.some((co) => {
      const unit = session.unitsById.get(co.id);
      return Boolean(unit && session.can('integrations.manage', unit));
    });

  return (
    <div className="stack gap-16">
      {catalog.data.mocksAllowed ? (
        <Alert tone="info" title="Mocks are on (development)">
          <p>
            Every company starts with mock connections, so the app works without provider accounts. What mocks &ldquo;send&rdquo; appears in the{' '}
            <Link href="/settings/integrations/sandbox">sandbox outbox</Link>. On production servers mocks are off and each kind needs a real connection.
          </p>
        </Alert>
      ) : null}
      <div className="row gap-12 int-intro">
        <p className="muted small grow">
          {company ? `Connections ${company.name} uses, including ones shared from the group.` : 'Connections of every company in the group, and shared ones.'}{' '}
          Features use each company&apos;s default for a kind.
        </p>
        {company ? null : (
          <>
            <label className="visually-hidden" htmlFor="int-company">
              Company
            </label>
            <select id="int-company" className="select int-company" value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
              <option value="">All companies</option>
              {companies.map((co) => (
                <option key={co.id} value={co.id}>
                  {co.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {catalog.data.kinds.map((kind) => {
        const items = connections.data
          .filter((c) => c.kind === kind.key && (!companyFilter || c.owner?.id === companyFilter || c.companies.some((co) => co.id === companyFilter)))
          .sort((a, b) => Number(a.shared) - Number(b.shared) || (a.owner?.name ?? '').localeCompare(b.owner?.name ?? '') || a.name.localeCompare(b.name));
        return (
          <Card
            key={kind.key}
            flush
            className="int-kind"
            title={
              <span className="row gap-8">
                <Icon name={KIND_ICON[kind.key]} size={18} aria-hidden="true" />
                {kind.label}
              </span>
            }
            description={kind.description}
            actions={
              canConnect ? (
                <Button size="sm" icon="plus" onClick={() => setDialog({ kind, connection: null })} aria-label={`Connect ${kind.label}`}>
                  Connect
                </Button>
              ) : null
            }
          >
            {items.length === 0 ? (
              <p className="int-kind__empty muted small">
                {catalog.data.mocksAllowed ? 'Nothing connected: features use the built-in mock.' : 'Nothing connected: features that need this are unavailable.'}
              </p>
            ) : (
              <ul className="int-conns">
                {items.map((c) => (
                  <ConnectionRow
                    key={c.id}
                    connection={c}
                    workingCompanyId={company?.id ?? null}
                    canOperate={canOperate(c)}
                    canMakeDefault={Boolean(company && session.can('integrations.manage', company))}
                    notice={notice?.connectionId === c.id ? notice : null}
                    busy={(test.isPending && test.variables?.id === c.id) || (tryIt.isPending && tryIt.variables?.id === c.id)}
                    onTest={() => test.mutate(c)}
                    onTry={() => tryIt.mutate(c)}
                    onDefault={(companyId) => makeDefault.mutate({ c, companyId })}
                    onEdit={() => setDialog({ kind, connection: c })}
                    onDisconnect={() => setDisconnecting(c)}
                  />
                ))}
              </ul>
            )}
          </Card>
        );
      })}

      {dialog ? <ConnectionDialog kind={dialog.kind} connection={dialog.connection} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={disconnecting !== null}
        onClose={() => {
          setDisconnecting(null);
          disconnect.reset();
        }}
        title={`Disconnect ${disconnecting?.name ?? ''}?`}
        confirmLabel="Disconnect"
        danger
        pending={disconnect.isPending}
        error={disconnect.error}
        onConfirm={() => disconnecting && disconnect.mutate(disconnecting)}
      >
        <p>
          Its credentials are deleted and the companies that use it stop using it. Channels on it stay registered without a connection. Nothing
          that already happened is lost.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function ConnectionRow({
  connection: c,
  workingCompanyId,
  canOperate,
  canMakeDefault,
  notice,
  busy,
  onTest,
  onTry,
  onDefault,
  onEdit,
  onDisconnect,
}: {
  connection: Connection;
  workingCompanyId: string | null;
  canOperate: boolean;
  canMakeDefault: boolean;
  notice: Notice | null;
  busy: boolean;
  onTest: () => void;
  onTry: () => void;
  onDefault: (companyId: string) => void;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const here = workingCompanyId ? c.companies.find((co) => co.id === workingCompanyId) : undefined;
  return (
    <li className="int-conn">
      <div className="int-conn__main">
        <div className="row gap-6 int-conn__title">
          <span className="strong">{c.name}</span>
          <span className="muted small">{c.providerLabel}</span>
          {c.mock ? <Badge tone="accent">Mock</Badge> : null}
          {!c.implemented ? <Badge tone="warning">Adapter coming</Badge> : null}
          {c.status === 'disabled' ? <Badge>Disabled</Badge> : null}
          {c.shared ? <Badge title={`Owned by ${c.owner?.name ?? 'the group'}`}>Shared</Badge> : null}
        </div>
        <div className="row gap-6 int-conn__companies small">
          {c.companies.length === 0 ? <span className="muted">No company uses it</span> : null}
          {c.companies.map((co) => (
            <span key={co.id} className={co.isDefault ? 'int-chip int-chip--default' : 'int-chip'}>
              {co.name}
              {co.isDefault ? ' · default' : ''}
            </span>
          ))}
        </div>
        <div className="row gap-8 small">
          <StatusPill tone={HEALTH_TONE[c.health.status]}>{HEALTH_LABEL[c.health.status]}</StatusPill>
          {c.health.checkedAt ? (
            <span className="muted">
              checked <RelativeTime value={c.health.checkedAt} sans />
            </span>
          ) : null}
          {c.health.status === 'failing' && c.health.message ? <span className="int-conn__error">{c.health.message}</span> : null}
        </div>
        {notice ? (
          <p className={`int-notice int-notice--${notice.tone} small`} role="status">
            {notice.text}
          </p>
        ) : null}
      </div>
      <div className="int-conn__actions">
        {canOperate ? (
          <Button size="sm" icon="refresh" onClick={onTest} loading={busy} aria-label={`Test ${c.name}`}>
            Test
          </Button>
        ) : null}
        {canOperate && c.mock && c.status === 'active' ? (
          <Button size="sm" icon="bolt" onClick={onTry} disabled={busy} aria-label={`Send a sample through ${c.name}`}>
            Try
          </Button>
        ) : null}
        {here && !here.isDefault && canMakeDefault && c.status === 'active' ? (
          <Button size="sm" icon="star" onClick={() => onDefault(here.id)} aria-label={`Make ${c.name} the default`}>
            Make default
          </Button>
        ) : null}
        {c.canManage ? (
          <>
            <Button size="sm" icon="edit" onClick={onEdit} aria-label={`Change ${c.name}`}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={onDisconnect} aria-label={`Disconnect ${c.name}`}>
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
