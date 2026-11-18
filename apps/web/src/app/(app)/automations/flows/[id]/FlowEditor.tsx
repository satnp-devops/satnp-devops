'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Menu, Mono, RelativeTime, SidePanel } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, ErrorAlert, PageLoading, cx } from '@/components/ui';
import { api, isApiError } from '@/lib/api';
import { STEP_TYPES, automationKeys, useAutomationCatalog, useFlow, useFlowVersions } from '@/lib/automations/queries';
import type { AutomationCatalog, AutomationFlow, EngineIssue, FlowDefinition, FlowStep, SimulationResult, StepType, ValidationResult } from '@/lib/automations/types';
import { useDebounced } from '@/lib/hooks';
import { FlowStatusPill, triggerLabel } from '../../shared';
import { createStep, edgesOf, editable, issuesByStep, orderSteps, removeStep, stableJson, stepSummary, unreachableIds } from './graph';
import { StepInspector, TriggerInspector } from './StepInspector';
import { TestPanel } from './TestPanel';

const TRIGGER = '__trigger';

export function FlowEditor({ id, initialStep = null, initialTest = null }: { id: string; initialStep?: string | null; initialTest?: string | null }) {
  const flow = useFlow(id);
  const catalog = useAutomationCatalog();
  if (flow.isPending || catalog.isPending) return <PageLoading />;
  if (flow.isError || catalog.isError) {
    const notFound = isApiError(flow.error) && flow.error.status === 404;
    return (
      <div className="content">
        {notFound ? (
          <Alert tone="warning" title="Flow not found">
            It may have been archived, or it belongs to a company you don&apos;t work in. <Link href="/automations">Back to automations</Link>
          </Alert>
        ) : (
          <ErrorAlert error={flow.error ?? catalog.error} />
        )}
      </div>
    );
  }
  return <Editor key={`${flow.data.id}:${flow.data.version}`} flow={flow.data} catalog={catalog.data} initialStep={initialStep} initialTest={initialTest} />;
}

function issuesFromError(error: unknown): EngineIssue[] {
  if (!isApiError(error) || error.status !== 422 || !Array.isArray(error.details)) return [];
  return (error.details as EngineIssue[]).filter((d) => typeof d.path === 'string' && d.path.startsWith('body.definition'));
}

function Editor({ flow, catalog, initialStep, initialTest }: { flow: AutomationFlow; catalog: AutomationCatalog; initialStep: string | null; initialTest: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const saved = useMemo(() => editable(flow.definition as FlowDefinition), [flow.definition]);
  const [draft, setDraft] = useState<FlowDefinition>(saved);
  const [name, setName] = useState(flow.name);
  const [selected, setSelected] = useState<string>(initialStep && flow.definition?.steps.some((s) => s.id === initialStep) ? initialStep : TRIGGER);
  const [testing, setTesting] = useState(initialTest !== null);
  const [showVersions, setShowVersions] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const readOnly = !flow.canManage || flow.status === 'archived';
  // On narrow screens the inspector sits under the steps: bring it into view when a step is picked.
  const inspectorRef = useRef<HTMLElement>(null);
  const firstSelect = useRef(true);
  useEffect(() => {
    if (firstSelect.current) {
      firstSelect.current = false;
      return;
    }
    if (window.matchMedia('(max-width: 960px)').matches) inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);
  const dirty = stableJson(draft) !== stableJson(saved) || name.trim() !== flow.name;

  // Live checks with the engine, a moment after the last edit.
  const debounced = useDebounced(draft, 600);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .post<ValidationResult>('/automations/validate', { companyId: flow.companyId, unitId: flow.unitId, name: name.trim() || flow.name, definition: debounced })
      .then((result) => {
        if (!cancelled) setValidation(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debounced, flow.companyId, flow.unitId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const refresh = async (next?: AutomationFlow) => {
    if (next) queryClient.setQueryData(automationKeys.flow(flow.id), { ...flow, ...next, canManage: flow.canManage });
    await queryClient.invalidateQueries({ queryKey: automationKeys.all });
  };

  const save = useMutation({
    mutationFn: () => api.patch<AutomationFlow>(`/automations/flows/${flow.id}`, { definition: draft, name: name.trim() || flow.name, baseVersion: flow.version }),
    onSuccess: (next) => refresh(next),
  });
  const setStatus = useMutation({
    mutationFn: (action: 'activate' | 'pause') => api.post<AutomationFlow>(`/automations/flows/${flow.id}/${action}`),
    onSuccess: (next) => refresh(next),
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/automations/flows/${flow.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: automationKeys.all });
      router.push('/automations');
    },
  });

  const issues = save.isError ? issuesFromError(save.error) : (validation?.errors ?? []);
  const byStep = issuesByStep(issues, draft);
  const ordered = orderSteps(draft);
  const unreachable = unreachableIds(draft);
  const visited = new Set(simulation?.path ?? []);
  const current = draft.steps.find((s) => s.id === selected) ?? null;
  const missing = validation?.missingPermissions ?? flow.missingPermissions ?? [];

  const replaceStep = (step: FlowStep) => setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.id === step.id ? step : s)) }));
  const addStep = (type: StepType) => {
    setDraft((d) => {
      const step = createStep(d, type, catalog);
      const after = d.steps.find((s) => s.id === selected);
      const nextField = after ? edgesOf(after).find((e) => e.field === 'next' || e.field === 'then' || e.field === 'otherwise') : null;
      if (after && nextField && type !== 'end') {
        const linked = { ...step, ...(nextField.to ? { next: nextField.to } : {}) } as FlowStep;
        const steps = d.steps.flatMap((s) => (s.id === after.id ? [setEdgeSafe(after, nextField.field, step.id), linked] : [s]));
        setSelected(step.id);
        return { ...d, steps };
      }
      if (after && nextField && type === 'end') {
        setSelected(step.id);
        return { ...d, steps: [...d.steps.map((s) => (s.id === after.id && !nextField.to ? setEdgeSafe(after, nextField.field, step.id) : s)), step] };
      }
      setSelected(step.id);
      return { ...d, steps: [...d.steps, step], start: d.steps.length === 0 ? step.id : d.start };
    });
  };

  const actionBusy = setStatus.isPending || save.isPending;
  const canActivate = !readOnly && flow.status !== 'active' && !dirty && (validation?.ok ?? true);

  return (
    <>
      <header className="page-header auto-editor-head">
        <div className="auto-editor-head__main">
          <nav className="small" aria-label="Breadcrumb">
            <Link href="/automations">Automations</Link> <span aria-hidden="true">›</span> <span className="muted">{flow.kind === 'nurture' ? 'Nurture flow' : 'Flow'}</span>
          </nav>
          <div className="row gap-8 auto-editor-title">
            {readOnly ? (
              <h1>{flow.name}</h1>
            ) : (
              <input className="auto-name" aria-label="Flow name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            )}
            <FlowStatusPill status={flow.status} />
            <Mono>{`v${flow.version}`}</Mono>
            {dirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
          </div>
          <p className="small muted">
            {flow.unitName ? `Applies in ${flow.unitName}` : null} · {triggerLabel(catalog, draft.trigger.type)} · saved <RelativeTime value={flow.updatedAt} sans />
            {flow.stats ? ` · ${flow.stats.activeRuns} runs going, ${flow.stats.runsLast7Days} in 7 days` : null}
          </p>
        </div>
        <div className="row gap-8 auto-editor-actions">
          <Button icon="refresh" onClick={() => setTesting(true)}>
            Test
          </Button>
          <Button icon="history" onClick={() => setShowVersions(true)}>
            Versions
          </Button>
          <Link className="btn" href={`/automations/runs?flowId=${flow.id}`}>
            Runs
          </Link>
          {!readOnly ? (
            <>
              <Button variant={dirty ? 'primary' : 'default'} icon="check" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
                Save
              </Button>
              {flow.status === 'active' ? (
                <Button loading={setStatus.isPending} disabled={actionBusy} onClick={() => setStatus.mutate('pause')}>
                  Pause
                </Button>
              ) : (
                <Button
                  variant={dirty ? 'default' : 'primary'}
                  loading={setStatus.isPending}
                  disabled={!canActivate || actionBusy}
                  title={dirty ? 'Save first' : validation && !validation.ok ? 'Fix the problems first' : undefined}
                  onClick={() => setStatus.mutate('activate')}
                >
                  Turn on
                </Button>
              )}
              <Menu
                label="More actions"
                placement="bottom-end"
                trigger={(t) => <Button {...t} iconOnly icon="more" aria-label="More actions" />}
                items={[{ key: 'archive', label: 'Archive flow', icon: 'archive', danger: true, onSelect: () => setConfirmArchive(true) }]}
              />
            </>
          ) : null}
        </div>
      </header>

      <div className="content stack gap-16">
        {flow.status === 'active' && dirty ? <Alert tone="info">This flow is on. Saving makes a new version: new runs use it, runs already going finish on the version they started with.</Alert> : null}
        {!flow.canManage ? <Alert tone="info">You can look and test, but only people who manage automations here can change this flow.</Alert> : null}
        {missing.length > 0 && !readOnly ? (
          <Alert tone="warning" title="You can't save this flow as it is">
            It uses steps that need permissions you don&apos;t have here: {missing.map((m) => `${m.permission} (${m.stepIds.join(', ')})`).join('; ')}.
          </Alert>
        ) : null}
        <ErrorAlert error={save.isError && issues.length === 0 ? save.error : setStatus.error} />
        {save.isError && issues.length > 0 ? <Alert tone="error" title="Not saved">Fix the steps marked below, then save again.</Alert> : null}

        <div className="auto-editor">
          <section className="auto-graph-wrap" aria-label="Steps">
            <ol className="auto-graph">
              <li>
                <button type="button" className={cx('auto-node auto-node--trigger', selected === TRIGGER && 'is-selected', byStep.has('trigger') && 'has-issue')} onClick={() => setSelected(TRIGGER)} aria-pressed={selected === TRIGGER}>
                  <span className="auto-node__icon">
                    <Icon name="bolt" size={16} />
                  </span>
                  <span className="auto-node__body">
                    <span className="auto-node__kind">When</span>
                    <span className="auto-node__title">{triggerLabel(catalog, draft.trigger.type)}</span>
                    {draft.trigger.filter ? <span className="auto-node__summary crm-mono">only when {draft.trigger.filter}</span> : null}
                  </span>
                </button>
              </li>
              {ordered.map((step, index) => {
                const meta = STEP_TYPES[step.type];
                const stepIssues = byStep.get(step.id) ?? [];
                const edges = edgesOf(step).filter((e) => e.to);
                const linearNext = edges.length === 1 && edges[0]?.field === 'next' && ordered[index + 1]?.id === edges[0]?.to;
                return (
                  <li key={step.id} className={cx('auto-graph__item', unreachable.has(step.id) && 'is-unreachable')}>
                    <span className="auto-connector" aria-hidden="true" />
                    <button
                      type="button"
                      className={cx('auto-node', `auto-node--${step.type}`, selected === step.id && 'is-selected', stepIssues.length > 0 && 'has-issue', visited.has(step.id) && 'is-visited')}
                      onClick={() => setSelected(step.id)}
                      aria-pressed={selected === step.id}
                    >
                      <span className="auto-node__icon">
                        <Icon name={meta.icon} size={16} />
                      </span>
                      <span className="auto-node__body">
                        <span className="auto-node__kind">
                          {meta.label}
                          {draft.start === step.id ? ' · first step' : ''}
                          {unreachable.has(step.id) ? ' · not connected' : ''}
                        </span>
                        <span className="auto-node__title">{step.label || step.id}</span>
                        <span className="auto-node__summary">{stepSummary(step, catalog)}</span>
                      </span>
                      {stepIssues.length > 0 ? (
                        <span className="auto-node__flag" title={stepIssues.map((i) => i.message).join('\n')}>
                          <Icon name="alert" size={14} /> {stepIssues.length}
                          <span className="visually-hidden"> problems</span>
                        </span>
                      ) : visited.has(step.id) ? (
                        <span className="auto-node__flag auto-node__flag--ok" title="Reached in the last test">
                          <Icon name="check" size={14} />
                          <span className="visually-hidden">Reached in the test</span>
                        </span>
                      ) : null}
                    </button>
                    {edges.length > 0 && !linearNext ? (
                      <ul className="auto-edges" aria-label={`Where ${step.label || step.id} goes`}>
                        {edges.map((edge) => (
                          <li key={edge.field}>
                            <button type="button" className="auto-edge" onClick={() => edge.to && setSelected(edge.to)}>
                              {edge.label} <span aria-hidden="true">→</span> <span className="crm-mono">{edge.to}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {!readOnly ? (
              <div className="auto-add">
                <p className="small muted">{current ? `Add a step after ${current.label || current.id}` : 'Add a step'}</p>
                <div className="auto-add__buttons">
                  {(Object.keys(STEP_TYPES) as StepType[]).map((type) => (
                    <Button key={type} size="sm" icon={STEP_TYPES[type].icon} onClick={() => addStep(type)} title={STEP_TYPES[type].hint}>
                      {STEP_TYPES[type].label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {byStep.has('flow') ? (
              <Alert tone="error" title="Flow problems">
                <ul className="auto-issues">
                  {byStep.get('flow')!.map((i, n) => (
                    <li key={n}>{i.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {validation?.warnings.length ? (
              <Alert tone="warning" title="Worth a look">
                <ul className="auto-issues">
                  {validation.warnings.map((w, n) => (
                    <li key={n}>{w.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </section>

          <aside ref={inspectorRef} className="auto-inspector-wrap" aria-label="Step settings">
            {selected === TRIGGER || !current ? (
              <TriggerInspector
                trigger={draft.trigger}
                settings={draft.settings}
                catalog={catalog}
                issues={byStep.get('trigger') ?? []}
                readOnly={readOnly}
                onChange={(trigger, settings) => setDraft((d) => ({ ...d, trigger, settings }))}
              />
            ) : (
              <StepInspector
                key={current.id}
                step={current}
                definition={draft}
                catalog={catalog}
                issues={byStep.get(current.id) ?? []}
                readOnly={readOnly}
                onChange={replaceStep}
                onMakeStart={() => setDraft((d) => ({ ...d, start: current.id }))}
                onRemove={() => {
                  setDraft((d) => removeStep(d, current.id));
                  setSelected(TRIGGER);
                }}
              />
            )}
          </aside>
        </div>
      </div>

      {testing ? (
        <TestPanel open autoRun={initialTest === 'run'} onClose={() => setTesting(false)} companyId={flow.companyId} flowId={flow.id} kind={flow.kind} name={name.trim() || flow.name} definition={draft} catalog={catalog} onResult={setSimulation} />
      ) : null}
      {showVersions ? (
        <VersionsPanel
          flow={flow}
          readOnly={readOnly}
          onClose={() => setShowVersions(false)}
          onRestored={async (next) => {
            setShowVersions(false);
            await refresh(next);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title="Archive this flow?"
        confirmLabel="Archive"
        danger
        pending={archive.isPending}
        error={archive.error}
        onConfirm={() => archive.mutate()}
      >
        It stops for good: runs that are going are cancelled and approvals waiting for it are withdrawn. Its runs stay in the history.
      </ConfirmDialog>
    </>
  );
}

function setEdgeSafe(step: FlowStep, field: string, to: string): FlowStep {
  return { ...step, [field]: to } as FlowStep;
}

function VersionsPanel({ flow, readOnly, onClose, onRestored }: { flow: AutomationFlow; readOnly: boolean; onClose: () => void; onRestored: (flow: AutomationFlow) => void }) {
  const versions = useFlowVersions(flow.id, true);
  const restore = useMutation({
    mutationFn: (version: number) => api.post<AutomationFlow>(`/automations/flows/${flow.id}/versions/${version}/restore`, { baseVersion: flow.version }),
    onSuccess: onRestored,
  });
  return (
    <SidePanel open onClose={onClose} title="Versions" subtitle="Every save is kept. Runs stay on the version they started with.">
      {versions.isPending ? <PageLoading /> : null}
      <ErrorAlert error={versions.error ?? restore.error} />
      <ol className="auto-versions">
        {(versions.data ?? []).map((v) => (
          <li key={v.id}>
            <div className="row gap-8">
              <Mono>{`v${v.version}`}</Mono>
              {v.active ? <Badge tone="success">On</Badge> : null}
              {v.version === flow.version ? <Badge>Latest</Badge> : null}
            </div>
            <p className="small">
              {v.createdBy?.name ?? 'Someone'} · <RelativeTime value={v.createdAt} sans />
            </p>
            {v.note ? <p className="small muted">{v.note}</p> : null}
            {!readOnly && v.version !== flow.version ? (
              <Button size="sm" loading={restore.isPending && restore.variables === v.version} onClick={() => restore.mutate(v.version)}>
                Restore as a new version
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </SidePanel>
  );
}
