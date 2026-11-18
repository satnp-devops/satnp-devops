'use client';

import Link from 'next/link';
import { useState } from 'react';
import { KeyValue, RelativeTime, StatusPill } from '@/components/crm';
import { Button, ButtonLink, EmptyState, ErrorAlert, PageHeader, PageLoading, cx } from '@/components/ui';
import { Meter } from '@/components/delivery/Bits';
import '@/components/delivery/delivery.css';
import { isApiError } from '@/lib/api';
import { PROJECT_STATUS, dateLabel, daysUntil, todayInIndia } from '@/lib/delivery/format';
import { useProject, useProjectAction } from '@/lib/delivery/queries';
import type { ProjectDetail, ProjectPhase, ProjectStatus } from '@/lib/delivery/types';

export function ProjectView({ id }: { id: string }) {
  const query = useProject(id);
  if (query.isPending) return <PageLoading />;
  if (query.isError) {
    return (
      <>
        <PageHeader title="Implementation project" />
        <div className="content">
          {isApiError(query.error) && query.error.status === 404 ? (
            <div className="card">
              <EmptyState icon="flag" title="Project not found" action={<ButtonLink href="/onboarding/projects">All projects</ButtonLink>}>
                It doesn&apos;t exist or isn&apos;t in a team you work in.
              </EmptyState>
            </div>
          ) : (
            <ErrorAlert error={query.error} />
          )}
        </div>
      </>
    );
  }
  return <Project project={query.data} />;
}

function Project({ project }: { project: ProjectDetail }) {
  const action = useProjectAction(project.id);
  const goLiveIn = project.targetGoLiveOn ? daysUntil(project.targetGoLiveOn) : null;
  return (
    <>
      <PageHeader
        title={project.account?.name ?? project.name}
        description={
          <span className="row gap-8">
            <Link href="/onboarding/projects">Implementation</Link>
            <span aria-hidden="true">›</span>
            <span>{project.name}</span>
          </span>
        }
        actions={
          project.can.manage ? (
            <select
              className="select"
              aria-label="Project status"
              value={project.status}
              disabled={action.isPending}
              onChange={(event) => action.mutate({ kind: 'update', body: { status: event.target.value } })}
            >
              {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS[s].label}
                </option>
              ))}
            </select>
          ) : (
            <StatusPill tone={PROJECT_STATUS[project.status].tone}>{PROJECT_STATUS[project.status].label}</StatusPill>
          )
        }
      />
      <div className="content">
        {action.isError ? <ErrorAlert error={action.error} /> : null}
        <div className="split">
          <div className="split__main stack gap-16">
            <div className="card card__body">
              <Meter value={project.tasksDone} max={project.tasksTotal} label={`${project.tasksDone} of ${project.tasksTotal} tasks done`} tone={project.status === 'live' ? 'done' : undefined} />
            </div>
            <div className="delivery-phases">
              {project.phases.map((phase, index) => (
                <PhaseCard key={phase.id} project={project} phase={phase} step={index + 1} />
              ))}
            </div>
          </div>
          <div className="split__side">
            <div className="card card__body">
              <KeyValue
                items={[
                  { label: 'Status', value: <StatusPill tone={PROJECT_STATUS[project.status].tone}>{PROJECT_STATUS[project.status].label}</StatusPill> },
                  { label: 'Institute', value: project.account ? <Link href={`/accounts/${project.account.id}`}>{project.account.name}</Link> : null },
                  { label: 'Deal', value: project.deal ? <Link href={`/leads/${project.deal.id}`}>{project.deal.ref} · {project.deal.title}</Link> : null },
                  { label: 'Product', value: project.product?.name ?? project.productLine?.name ?? null },
                  { label: 'Owner', value: project.owner?.name ?? null },
                  { label: 'Kickoff', value: project.kickoffOn ? dateLabel(project.kickoffOn) : null },
                  {
                    label: 'Go-live',
                    value: project.wentLiveAt ? (
                      <>
                        Live <RelativeTime value={project.wentLiveAt} sans />
                      </>
                    ) : project.targetGoLiveOn ? (
                      <span className={cx(goLiveIn !== null && goLiveIn < 0 && 'delivery-overdue')}>
                        {dateLabel(project.targetGoLiveOn)} {goLiveIn !== null ? (goLiveIn < 0 ? `(${-goLiveIn} days late)` : `(in ${goLiveIn} days)`) : ''}
                      </span>
                    ) : null,
                  },
                  { label: 'Subscription', value: project.subscriptionId ? <span className="crm-mono">{project.subscriptionId}</span> : null },
                  { label: 'Contract', value: project.contractId ? <span className="crm-mono">{project.contractId}</span> : null },
                ]}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function PhaseCard({ project, phase, step }: { project: ProjectDetail; phase: ProjectPhase; step: number }) {
  const action = useProjectAction(project.id);
  const [title, setTitle] = useState('');
  const today = todayInIndia();
  const done = phase.tasks.filter((t) => t.status !== 'pending').length;
  return (
    <section className={cx('card card__body', `delivery-phase--${phase.status}`)} aria-labelledby={`phase-${phase.id}`}>
      <div className="stack gap-12">
        <div className="delivery-phase__head">
          <span className="delivery-phase__step" aria-hidden="true">
            {phase.status === 'done' ? '✓' : step}
          </span>
          <h2 id={`phase-${phase.id}`} className="delivery-phase__title">
            {phase.name}
          </h2>
          <span className="muted small">
            {done} of {phase.tasks.length}
            {phase.dueOn ? ` · due ${dateLabel(phase.dueOn)}` : ''}
          </span>
          {phase.overdue ? <StatusPill tone="danger">Overdue</StatusPill> : null}
          {phase.owner ? <span className="muted small">{phase.owner.name}</span> : null}
        </div>
        <ul className="delivery-checklist">
          {phase.tasks.map((task) => (
            <li key={task.id} className={cx('delivery-checklist__item', `delivery-checklist__item--${task.status}`)}>
              <input
                type="checkbox"
                id={`task-${task.id}`}
                checked={task.status !== 'pending'}
                disabled={!project.can.manage || action.isPending}
                onChange={(event) => action.mutate({ kind: 'task', taskId: task.id, body: { status: event.target.checked ? 'done' : 'pending' } })}
              />
              <label htmlFor={`task-${task.id}`} className="delivery-checklist__title">
                {task.title}
              </label>
              <span className="muted small">{task.status === 'skipped' ? 'Skipped' : ''}</span>
              <span className="delivery-checklist__meta">
                <span>{task.owner?.name ?? 'No owner'}</span>
                {task.dueOn ? <span className={task.status === 'pending' && task.dueOn < today ? 'delivery-overdue' : undefined}>Due {dateLabel(task.dueOn)}</span> : null}
                {task.completedAt ? (
                  <span>
                    Done <RelativeTime value={task.completedAt} sans />
                    {task.completedBy ? ` by ${task.completedBy.name}` : ''}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {project.can.manage ? (
          <form
            className="row gap-8"
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              action.mutate({ kind: 'addTask', body: { phaseId: phase.id, title: title.trim() } }, { onSuccess: () => setTitle('') });
            }}
          >
            <label className="visually-hidden" htmlFor={`add-${phase.id}`}>
              Add a task to {phase.name}
            </label>
            <input id={`add-${phase.id}`} className="input" style={{ flex: '1 1 200px' }} maxLength={200} placeholder={`Add a task to ${phase.name}`} value={title} onChange={(event) => setTitle(event.target.value)} />
            <Button type="submit" size="sm" icon="plus" disabled={!title.trim()} loading={action.isPending && Boolean(title)}>
              Add
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

