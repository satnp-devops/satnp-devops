'use client';

import { Icon, unitIcon } from '@/components/icons';
import { Alert, Avatar, Badge, ButtonLink, Card, EmptyState, ErrorAlert, PageHeader, Spinner } from '@/components/ui';
import { describeAction, firstName, formatRelative, greeting } from '@/lib/format';
import { ROADMAP } from '@/lib/nav';
import { useAudit, useUnitTypes } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { unitTypeLabel } from '@/lib/tree';

export function HomeView() {
  const { me, user, scope, units, can, canAnywhere } = useSession();
  const types = useUnitTypes();
  const canSeeAudit = can('audit.view');
  const activity = useAudit(scope.id, '', canSeeAudit, 8);

  // Count the active units under the scope by type.
  const inside = units.filter((unit) => unit.id !== scope.id && unit.status === 'active' && unit.path.startsWith(scope.path));
  const counts = new Map<string, number>();
  for (const unit of inside) counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1);
  const typeOrder = (types.data ?? []).map((type) => type.key);
  const stats = [...counts.entries()].sort(([a], [b]) => typeOrder.indexOf(a) - typeOrder.indexOf(b));

  const entries = activity.data?.pages[0]?.data ?? [];

  return (
    <>
      <PageHeader title={`${greeting()}, ${firstName(user.name)}`} description={`You're working in ${scope.name}.`} />
      <div className="content stack gap-16">
        {!user.mfaEnabled ? (
          <Alert
            tone="warning"
            title="Protect your account"
            action={
              <ButtonLink href="/settings/security" size="sm">
                Turn on two-step verification
              </ButtonLink>
            }
          >
            Add a code from your phone at sign-in, so a stolen password alone can&apos;t open your account.
          </Alert>
        ) : null}

        <div className="grid-cards">
          <Card title="Your roles" description="A role at a unit applies to everything under it.">
            <ul className="list">
              {me.assignments.map((assignment) => (
                <li key={assignment.id} className="list__item">
                  <span className="unit-mark unit-mark--sm">
                    <Icon name={unitIcon(assignment.unitType)} size={16} />
                  </span>
                  <div className="list__text">
                    <div className="strong">{assignment.role.name}</div>
                    <div className="small muted">
                      {assignment.unitName} · {unitTypeLabel(types.data, assignment.unitType)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title={scope.name}
            description={stats.length ? 'Active units inside' : undefined}
            actions={
              canAnywhere('org.view') ? (
                <ButtonLink href="/settings/organization" size="sm" variant="ghost">
                  Open
                </ButtonLink>
              ) : undefined
            }
          >
            {stats.length ? (
              <div className="stat-grid">
                {stats.map(([type, count]) => (
                  <div key={type} className="stat">
                    <div className="stat__value">{count}</div>
                    <div className="stat__label">
                      {count === 1
                        ? unitTypeLabel(types.data, type)
                        : (types.data?.find((t) => t.key === type)?.pluralLabel ?? unitTypeLabel(types.data, type))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No units inside {scope.name} yet.</p>
            )}
          </Card>

          <Card title="Coming next" description="Each phase plugs into this foundation as a module.">
            <ul className="list list--compact">
              {ROADMAP.slice(0, 4).map((item) => (
                <li key={item.phase} className="list__item">
                  <Badge tone="accent">Phase {item.phase}</Badge>
                  <div className="list__text">
                    <div className="strong">{item.title}</div>
                    <div className="small muted">{item.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        {canSeeAudit ? (
          <Card
            flush
            title="Recent activity"
            description={`Changes in ${scope.name} and everything under it`}
            actions={
              <ButtonLink href="/settings/audit" size="sm" variant="ghost">
                See all
              </ButtonLink>
            }
          >
            {activity.isPending ? (
              <div className="empty">
                <Spinner />
              </div>
            ) : activity.isError ? (
              <div className="card__body">
                <ErrorAlert error={activity.error} />
              </div>
            ) : entries.length === 0 ? (
              <EmptyState icon="history" title="Nothing yet">
                Changes people make here will show up in this list.
              </EmptyState>
            ) : (
              <ul className="list list--rows">
                {entries.map((entry) => (
                  <li key={entry.id} className="list__item">
                    <Avatar name={entry.actor?.name ?? 'System'} size={28} />
                    <div className="list__text">
                      <div>
                        <span className="strong">{entry.actor?.name ?? 'System'}</span> {describeAction(entry.action).toLowerCase()}
                        {entry.unit ? <span className="muted"> in {entry.unit.name}</span> : null}
                      </div>
                    </div>
                    <span className="small muted nowrap">{formatRelative(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
