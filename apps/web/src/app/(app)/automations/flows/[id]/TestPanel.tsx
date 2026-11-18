'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { DateTime, SidePanel, StatusPill } from '@/components/crm';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { outcomeLabel } from '@/lib/automations/queries';
import type { AutomationCatalog, FlowDefinition, Json, JsonObject, SimulationResult } from '@/lib/automations/types';
import { JsonBlock, RunStatusPill, actionLabel } from '../../shared';
import { JsonField } from './SchemaForm';

type Approval = 'approved' | 'rejected' | 'timeout';
type EventChoice = 'arrives' | 'never';
type ResultChoice = 'sample' | 'fails';

export function TestPanel({
  open,
  autoRun = false,
  onClose,
  companyId,
  flowId,
  kind,
  name,
  definition,
  catalog,
  onResult,
}: {
  open: boolean;
  autoRun?: boolean;
  onClose: () => void;
  companyId: string;
  flowId: string;
  kind: string;
  name: string;
  definition: FlowDefinition;
  catalog: AutomationCatalog;
  onResult: (result: SimulationResult | null) => void;
}) {
  const trigger = catalog.triggers.find((t) => t.key === definition.trigger.type);
  const [source, setSource] = useState<'sample' | 'deal'>('sample');
  const [dealRef, setDealRef] = useState('');
  const nurture = kind === 'nurture';
  const [payload, setPayload] = useState<JsonObject | undefined>(() => {
    const base = trigger?.sample?.payload ? structuredClone(trigger.sample.payload) : undefined;
    return nurture && definition.trigger.type === 'deal.stage_changed' ? { ...base, toStage: 'lost', toStatus: 'lost', fromStatus: 'open' } : base;
  });
  // The sample deal as it would be when this flow starts (a nurture flow starts on a lost deal).
  const [sample, setSample] = useState<JsonObject | undefined>(nurture ? { status: 'lost', stage: 'lost', nurture: true, lostReason: 'Fee too high' } : { status: 'open', stage: 'new_enquiry', kind: 'b2c', channel: 'whatsapp' });
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [events, setEvents] = useState<Record<string, EventChoice>>({});
  const [results, setResults] = useState<Record<string, ResultChoice>>({});
  const [force, setForce] = useState(false);

  const approvalSteps = definition.steps.filter((s) => s.type === 'approval');
  const eventWaits = definition.steps.filter((s) => s.type === 'wait' && s.mode === 'event');
  const awaited = definition.steps.filter((s) => s.type === 'ai_step' || (s.type === 'action' && s.await));

  const run = useMutation({
    mutationFn: () => {
      const scriptedEvents = eventWaits
        .filter((s) => (events[s.id] ?? 'arrives') === 'arrives' && s.type === 'wait' && s.event)
        .map((s) => ({ after: '1h', event: { type: s.type === 'wait' ? (s.event as string) : '', payload: {} as JsonObject } }));
      const scriptedResults: Record<string, Json> = {};
      for (const s of awaited) if ((results[s.id] ?? 'sample') === 'fails') scriptedResults[s.id] = { ok: false, error: { code: 'TEST_FAILURE', message: 'Failed in the test' } };
      return api.post<SimulationResult>('/automations/simulate', {
        companyId,
        flowId,
        name,
        definition,
        ...(source === 'deal' && dealRef.trim() ? { dealRef: dealRef.trim() } : {}),
        ...(source === 'sample' && sample ? { sample } : {}),
        ...(payload ? { event: { payload } } : {}),
        events: scriptedEvents,
        results: scriptedResults,
        approvals: Object.fromEntries(approvalSteps.map((s) => [s.id, approvals[s.id] ?? 'approved'])),
        force,
      });
    },
    onSuccess: (result) => onResult(result.ok ? result : null),
  });
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRun && !autoRan.current) {
      autoRan.current = true;
      run.mutate();
    }
  }, [autoRun, run]);
  const fieldErrors = fieldErrorsOf(run.error);
  const result = run.data;
  const label = (id: string) => definition.steps.find((s) => s.id === id)?.label || id;

  return (
    <SidePanel
      open={open}
      onClose={() => {
        onResult(null);
        onClose();
      }}
      title="Test this flow"
      subtitle="A dry run with a fast-forward clock: nothing is sent, no tasks are made, nothing is saved."
      size="lg"
      footer={
        <div className="row gap-8">
          <Button variant="primary" icon="refresh" loading={run.isPending} onClick={() => run.mutate()}>
            Run test
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div className="stack gap-16">
        <fieldset className="auto-fieldset">
          <legend className="field__label">Test against</legend>
          <label className="auto-check">
            <input type="radio" name="auto-source" checked={source === 'sample'} onChange={() => setSource('sample')} /> A sample deal (Priya Sharma, SAT group batches)
          </label>
          <label className="auto-check">
            <input type="radio" name="auto-source" checked={source === 'deal'} onChange={() => setSource('deal')} /> A real deal
          </label>
          {source === 'deal' ? (
            <Field label="Deal reference" hint="As shown on the deal, e.g. SP-1042" error={fieldErrors['body.dealRef']}>
              {(control) => <input {...control} className="input auto-code" value={dealRef} onChange={(e) => setDealRef(e.target.value)} placeholder="SP-1042" />}
            </Field>
          ) : (
            <JsonField label="Sample deal details" value={sample} onChange={(v) => setSample((v ?? undefined) as JsonObject | undefined)} />
          )}
        </fieldset>

        <JsonField label="Event details (trigger payload)" value={payload} onChange={(v) => setPayload((v ?? undefined) as JsonObject | undefined)} />

        {approvalSteps.length + eventWaits.length + awaited.length > 0 ? (
          <fieldset className="auto-fieldset">
            <legend className="field__label">What happens along the way</legend>
            <div className="stack gap-12">
              {approvalSteps.map((s) => (
                <Field key={s.id} label={`${label(s.id)}: the approver`}>
                  {(control) => (
                    <select {...control} className="select" value={approvals[s.id] ?? 'approved'} onChange={(e) => setApprovals({ ...approvals, [s.id]: e.target.value as Approval })}>
                      <option value="approved">Approves</option>
                      <option value="rejected">Rejects</option>
                      <option value="timeout">Doesn&apos;t decide in time</option>
                    </select>
                  )}
                </Field>
              ))}
              {eventWaits.map((s) => (
                <Field key={s.id} label={`${label(s.id)}: ${s.type === 'wait' ? s.event : ''}`}>
                  {(control) => (
                    <select {...control} className="select" value={events[s.id] ?? 'arrives'} onChange={(e) => setEvents({ ...events, [s.id]: e.target.value as EventChoice })}>
                      <option value="arrives">Happens an hour later</option>
                      <option value="never">Doesn&apos;t happen (times out)</option>
                    </select>
                  )}
                </Field>
              ))}
              {awaited.map((s) => (
                <Field key={s.id} label={`${label(s.id)}: the result`}>
                  {(control) => (
                    <select {...control} className="select" value={results[s.id] ?? 'sample'} onChange={(e) => setResults({ ...results, [s.id]: e.target.value as ResultChoice })}>
                      <option value="sample">Sample answer</option>
                      <option value="fails">Fails</option>
                    </select>
                  )}
                </Field>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label className="auto-check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Run even if the trigger&apos;s conditions don&apos;t match
        </label>

        <ErrorAlert error={formErrorOf(run.error, ['body.dealRef'])} />

        {result ? <TestResult result={result} catalog={catalog} label={label} /> : null}
      </div>
    </SidePanel>
  );
}

function TestResult({ result, catalog, label }: { result: SimulationResult; catalog: AutomationCatalog; label: (id: string) => string }) {
  if (!result.ok) {
    return (
      <Alert tone="error" title="The flow has problems">
        <ul className="auto-issues">
          {(result.errors ?? []).map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      </Alert>
    );
  }
  const start = result.now ? Date.parse(result.now) : null;
  const offset = (at: string) => {
    if (start === null) return '';
    const ms = Date.parse(at) - start;
    if (ms <= 0) return 'at once';
    const h = ms / 3_600_000;
    return h < 48 ? `after ${Math.round(h * 10) / 10}h` : `after ${Math.round(h / 24)}d`;
  };
  return (
    <section className="stack gap-12" aria-live="polite">
      <div className="row gap-8">
        <h3 className="auto-h3">Result</h3>
        {result.status === 'not_started' ? <StatusPill tone="warning">Didn&apos;t start</StatusPill> : result.status ? <RunStatusPill status={result.status} /> : null}
      </div>
      {result.status === 'not_started' ? (
        <Alert tone="warning" title="The trigger didn't match">
          {result.matchError?.message ?? (result.matchReason === 'filter' ? 'The "Only when" condition was false for this deal and event.' : result.matchReason === 'config' ? "The trigger's settings don't match this event." : `Reason: ${result.matchReason ?? 'unknown'}`)}
        </Alert>
      ) : null}
      {result.error ? (
        <Alert tone="error" title={`Stopped at ${result.error.stepId ? label(result.error.stepId) : 'the start'}`}>
          {result.error.message}
        </Alert>
      ) : null}
      {result.record ? (
        <p className="small muted">
          Tested with {String(result.record.ref ?? '')} {String(result.record.name ?? '')} · stage {String(result.record.stage ?? '–')}
        </p>
      ) : null}
      {result.path && result.path.length > 0 ? (
        <ol className="auto-path">
          {result.path.map((id, i) => (
            <li key={`${id}-${i}`}>
              <span className="crm-mono">{id}</span> {label(id) !== id ? label(id) : ''}
            </li>
          ))}
        </ol>
      ) : null}
      {result.effects && result.effects.length > 0 ? (
        <div className="stack gap-8">
          <h4 className="auto-h4">What it would do</h4>
          <ul className="auto-effects">
            {result.effects.map((e) => (
              <li key={e.idempotencyKey}>
                <div className="row gap-8">
                  <strong>{e.action === 'ai.run' ? `AI: ${String((e.params as JsonObject).agent)}` : actionLabel(catalog, e.action)}</strong>
                  <span className="small muted">
                    {label(e.stepId)} · {offset(e.at)}
                  </span>
                </div>
                <details>
                  <summary className="small">Details</summary>
                  <JsonBlock value={e.params} label={`Params of ${e.stepId}`} />
                </details>
              </li>
            ))}
          </ul>
        </div>
      ) : result.status !== 'not_started' ? (
        <p className="small muted">It wouldn&apos;t send or change anything.</p>
      ) : null}
      {result.trace && result.trace.length > 0 ? (
        <details>
          <summary className="small">Step by step</summary>
          <ol className="auto-trace">
            {result.trace.map((t) => (
              <li key={t.seq}>
                <DateTime value={t.at} format="short" /> <span className="crm-mono">{t.stepId ?? 'run'}</span> {outcomeLabel(t.outcome)}
                {t.next ? <span className="muted"> → {t.next}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
