'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, DateTime, KeyValue, Mono, RelativeTime, SidePanel, infiniteRows, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Alert, Badge, Button, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { api } from '@/lib/api';
import { WAIT_KIND, automationKeys, outcomeLabel, useAutomationCatalog, useFlows, useRun, useRuns } from '@/lib/automations/queries';
import type { AutomationCatalog, AutomationRun, AutomationRunDetail, RunStatus } from '@/lib/automations/types';
import { useSession } from '@/lib/session';
import { ApprovalStatusPill, JsonBlock, RunStatusPill, Segmented, actionLabel } from '../shared';

type StatusFilter = 'all' | RunStatus;

export function RunsView() {
  return (
    <Guard anyOf={['automations.view']} anywhere>
      <Suspense fallback={<PageLoading />}>
        <Runs />
      </Suspense>
    </Guard>
  );
}

function waitingText(run: AutomationRun): string {
  if (run.status === 'failed') return run.error?.message ?? 'Failed';
  if (run.status === 'cancelled') return run.endReason === 'flow_archived' ? 'Flow archived' : 'Cancelled';
  if (run.status === 'completed') return run.lastStep?.stepId ? `Ended at ${run.lastStep.stepId}` : 'Finished';
  if (!run.waiting) return run.currentStepId ? `At ${run.currentStepId}` : 'Running';
  const what = run.waiting.kind === 'event' ? `${WAIT_KIND.event} ${run.waiting.event ?? 'an event'}` : (WAIT_KIND[run.waiting.kind] ?? 'Waiting');
  return `${what}${run.waiting.stepId ? ` (${run.waiting.stepId})` : ''}`;
}

function Runs() {
  const { scope } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const flowId = params.get('flowId') ?? '';
  const openId = params.get('run');
  const [status, setStatus] = useState<StatusFilter>('all');
  const catalog = useAutomationCatalog();
  const flows = useFlows(scope.id, {});
  const runs = useRuns(scope.id, { flowId: flowId || undefined, status: status === 'all' ? undefined : status });
  const table = infiniteRows(runs);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  const columns = useMemo<Column<AutomationRun>[]>(
    () => [
      {
        id: 'started',
        header: 'Started',
        width: 150,
        cell: (run) => <DateTime value={run.startedAt} format="short" />,
      },
      {
        id: 'flow',
        header: 'Flow',
        card: 'title',
        cell: (run) => (
          <span className="auto-cell-name">
            <span>{run.flowName ?? 'Flow'}</span>
            <span className="small muted">
              <Mono>{`v${run.flowVersion}`}</Mono>
            </span>
          </span>
        ),
      },
      {
        id: 'record',
        header: 'Record',
        cell: (run) =>
          run.subject ? (
            run.subject.ref || run.subject.label ? (
              <span className="auto-cell-name">
                {run.subject.ref ? <Mono>{run.subject.ref}</Mono> : null}
                <span className="small">{run.subject.label}</span>
              </span>
            ) : (
              <span className="small muted">A {run.subject.type} you can&apos;t open</span>
            )
          ) : (
            <span className="small muted">Scheduled</span>
          ),
      },
      { id: 'status', header: 'Status', width: 120, cell: (run) => <RunStatusPill status={run.status} /> },
      {
        id: 'now',
        header: 'Where it is',
        hideBelow: 'sm',
        cell: (run) => (
          <span className="auto-cell-name">
            <span className={run.status === 'failed' ? 'small auto-danger' : 'small'}>{waitingText(run)}</span>
            {run.status === 'waiting' && run.nextWakeAt ? (
              <span className="small muted">
                until <DateTime value={run.nextWakeAt} format="short" />
              </span>
            ) : null}
          </span>
        ),
      },
      { id: 'steps', header: 'Steps', align: 'end', hideBelow: 'md', width: 70, cell: (run) => <span className="crm-mono">{run.stepCount}</span> },
    ],
    [],
  );

  return (
    <>
      <DataTable
        label="Automation runs"
        columns={columns}
        rowId={(run) => run.id}
        rowLabel={(run) => `${run.flowName ?? 'Run'} ${run.subject?.ref ?? ''}`}
        onRowActivate={(run) => setParam('run', run.id)}
        activeRowId={openId}
        {...table}
        toolbar={
          <div className="auto-toolbar">
            <Segmented<StatusFilter>
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All' },
                { value: 'waiting', label: 'Waiting' },
                { value: 'completed', label: 'Completed' },
                { value: 'failed', label: 'Failed' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
            <Field label="Flow">
              {(control) => (
                <select {...control} className="select auto-select" value={flowId} onChange={(e) => setParam('flowId', e.target.value || null)}>
                  <option value="">Every flow</option>
                  {(flows.data ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        }
        empty={
          <div className="auto-empty">
            <p>
              <strong>No runs {status !== 'all' ? 'with this status ' : ''}yet.</strong>
            </p>
            <p className="small muted">A run starts each time a flow that is on matches an event, such as a new enquiry.</p>
          </div>
        }
      />
      {openId ? <RunPanel id={openId} catalog={catalog.data} onClose={() => setParam('run', null)} /> : null}
    </>
  );
}

export function RunPanel({ id, catalog, onClose }: { id: string; catalog: AutomationCatalog | undefined; onClose: () => void }) {
  const run = useRun(id);
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.post(`/automations/runs/${id}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: automationKeys.all }),
  });
  const data = run.data;
  return (
    <SidePanel
      open
      onClose={onClose}
      size="lg"
      title={data ? (data.flowName ?? 'Run') : 'Run'}
      subtitle={data ? <RunSubtitle run={data} /> : undefined}
      footer={
        data?.canCancel ? (
          <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel run
          </Button>
        ) : undefined
      }
    >
      {run.isPending ? <PageLoading /> : null}
      <ErrorAlert error={run.error ?? cancel.error} />
      {data ? <RunDetail run={data} catalog={catalog} /> : null}
    </SidePanel>
  );
}

function RunSubtitle({ run }: { run: AutomationRunDetail }) {
  return (
    <span className="row gap-8">
      <RunStatusPill status={run.status} />
      <Mono>{run.id}</Mono>
    </span>
  );
}

function RunDetail({ run, catalog }: { run: AutomationRunDetail; catalog: AutomationCatalog | undefined }) {
  const label = (stepId: string | null) => (stepId ? (run.definition?.steps.find((s) => s.id === stepId)?.label ?? stepId) : 'Run');
  return (
    <div className="stack gap-16">
      {run.error ? (
        <Alert tone="error" title={`Failed at ${label(run.error.stepId)}`}>
          {run.error.message} <span className="crm-mono small">({run.error.code})</span>
        </Alert>
      ) : null}
      <KeyValue
        items={[
          { label: 'Flow', value: <Link href={`/automations/flows/${run.flowId}`}>{`${run.flowName ?? 'Flow'} (v${run.flowVersion})`}</Link> },
          {
            label: 'Record',
            value: run.subject ? (
              run.subject.ref || run.subject.label ? (
                <Link href={`/leads/${run.subject.id}`}>{[run.subject.ref, run.subject.label].filter(Boolean).join(' · ')}</Link>
              ) : (
                <span className="muted">Not visible to you</span>
              )
            ) : (
              'None (scheduled)'
            ),
          },
          { label: 'Started', value: <DateTime value={run.startedAt} /> },
          { label: run.endedAt ? 'Ended' : 'Next step', value: run.endedAt ? <DateTime value={run.endedAt} /> : run.nextWakeAt ? <DateTime value={run.nextWakeAt} /> : 'As soon as it can' },
          { label: 'Trigger', value: <span className="crm-mono small">{run.trigger?.type ?? run.triggerType}</span> },
        ]}
      />

      <section className="stack gap-8">
        <h3 className="auto-h3">Step by step</h3>
        {run.traceDropped > 0 ? <p className="small muted">{run.traceDropped} earlier entries are not kept.</p> : null}
        <ol className="auto-trace auto-trace--timeline">
          {run.steps.map((t) => (
            <li key={t.seq} className={`is-${t.outcome}`}>
              <DateTime value={t.at} format="short" />
              <span>
                <strong>{label(t.stepId)}</strong> {outcomeLabel(t.outcome)}
                {t.next ? <span className="muted"> → {label(t.next)}</span> : null}
              </span>
              {t.detail && Object.keys(t.detail).length > 0 ? (
                <details>
                  <summary className="small">Details</summary>
                  <JsonBlock value={t.detail} />
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {run.effects.some((e) => e.action !== 'automation.request_approval') ? (
        <section className="stack gap-8">
          <h3 className="auto-h3">What it did</h3>
          <ul className="auto-effects">
            {run.effects.filter((e) => e.action !== 'automation.request_approval').map((e) => (
              <li key={e.id}>
                <div className="row gap-8">
                  <strong>{e.action === 'ai.run' ? `AI: ${String(e.params.agent ?? '')}` : actionLabel(catalog, e.action)}</strong>
                  <Badge tone={e.status === 'failed' ? 'danger' : e.status === 'done' ? 'success' : e.status === 'recorded' ? 'accent' : 'default'}>
                    {e.status === 'recorded' ? 'Recorded (development)' : e.status}
                  </Badge>
                  <span className="small muted">{label(e.stepId)}</span>
                  <RelativeTime value={e.createdAt} />
                </div>
                {e.error ? <p className="small auto-danger">{e.error.message}</p> : null}
                <details>
                  <summary className="small">Details</summary>
                  <JsonBlock value={{ params: e.params, output: e.output, executor: e.executor, attempts: e.attempts }} />
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {run.approvals.length > 0 ? (
        <section className="stack gap-8">
          <h3 className="auto-h3">Approvals</h3>
          <ul className="auto-effects">
            {run.approvals.map((a) => (
              <li key={a.id}>
                <div className="row gap-8">
                  <strong>{a.title}</strong>
                  <ApprovalStatusPill status={a.status} canDecide={a.canDecide} />
                </div>
                <p className="small muted">
                  {a.decidedBy ? `${a.decidedBy.name ?? 'Someone'} · ` : ''}
                  {a.decidedAt ? <DateTime value={a.decidedAt} format="short" /> : a.status === 'pending' ? <Link href="/automations/approvals">Open the approvals queue</Link> : null}
                  {a.edited ? ' · edited' : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
