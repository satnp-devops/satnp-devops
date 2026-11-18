'use client';

import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Alert, Button, Field } from '@/components/ui';
import { STEP_TYPES } from '@/lib/automations/queries';
import type {
  AutomationCatalog,
  EngineIssue,
  FlowDefinition,
  FlowSettings,
  FlowStep,
  FlowTrigger,
  JsonObject,
  WaitStep,
} from '@/lib/automations/types';
import { edgesOf, issueField, setEdge } from './graph';
import { JsonField, RecordField, SchemaForm } from './SchemaForm';

const DURATION_HINT = 'Like 30m, 2h, 3d or 1w (combine: 1d12h)';

function issueMap(issues: readonly EngineIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = issueField(issue);
    if (field && !out[field]) out[field] = issue.message;
  }
  return out;
}

function TextInput({
  label,
  value,
  onChange,
  hint,
  error,
  optional,
  code = false,
  multiline = false,
  disabled,
  placeholder,
}: {
  label: ReactNode;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  code?: boolean;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const cls = `${multiline ? 'textarea' : 'input'}${code ? ' auto-code' : ''}`;
  return (
    <Field label={label} hint={hint} error={error} optional={optional}>
      {(control) =>
        multiline ? (
          <textarea {...control} className={cls} rows={3} value={value ?? ''} disabled={disabled} spellCheck={!code} placeholder={placeholder} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
        ) : (
          <input {...control} className={cls} value={value ?? ''} disabled={disabled} spellCheck={!code} placeholder={placeholder} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
        )
      }
    </Field>
  );
}

/** Where a pointer goes: another step, or nowhere (the run ends there, completed). */
function PointerSelect({ label, value, steps, self, onChange, disabled, error }: { label: string; value: string | undefined; steps: FlowStep[]; self: string; onChange: (to: string | undefined) => void; disabled?: boolean; error?: string }) {
  return (
    <Field label={label} error={error}>
      {(control) => (
        <select {...control} className="select" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">End the run here</option>
          {steps
            .filter((s) => s.id !== self)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.label ? `${s.label} (${s.id})` : s.id}
              </option>
            ))}
        </select>
      )}
    </Field>
  );
}

export function StepInspector({
  step,
  definition,
  catalog,
  issues,
  onChange,
  onRemove,
  onMakeStart,
  readOnly,
}: {
  step: FlowStep;
  definition: FlowDefinition;
  catalog: AutomationCatalog;
  issues: readonly EngineIssue[];
  onChange: (step: FlowStep) => void;
  onRemove: () => void;
  onMakeStart: () => void;
  readOnly: boolean;
}) {
  const meta = STEP_TYPES[step.type];
  const errors = issueMap(issues);
  const update = (patch: Partial<FlowStep>) => onChange({ ...step, ...patch } as FlowStep);
  const unset = (key: string) => {
    const copy = { ...step } as Record<string, unknown>;
    delete copy[key];
    onChange(copy as unknown as FlowStep);
  };
  const setOptional = (key: string, value: unknown) => (value === undefined ? unset(key) : update({ [key]: value } as Partial<FlowStep>));

  return (
    <div className="auto-inspector">
      <div className="auto-inspector__head">
        <Icon name={meta.icon} size={18} />
        <div>
          <h2>{step.label || meta.label}</h2>
          <p className="small muted">
            <span className="crm-mono">{step.id}</span> · {meta.hint}
          </p>
        </div>
      </div>
      {issues.length > 0 ? (
        <Alert tone="error" title="Fix this step">
          <ul className="auto-issues">
            {issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <fieldset className="auto-fieldset auto-fieldset--plain" disabled={readOnly}>
        <div className="stack gap-12">
          <TextInput label="Label" optional value={step.label} onChange={(v) => setOptional('label', v)} placeholder={meta.label} />

          {step.type === 'action' ? (
            <>
              <Field label="Action" error={errors['@action']}>
                {(control) => (
                  <select
                    {...control}
                    className="select"
                    value={step.action}
                    onChange={(e) => onChange({ ...step, action: e.target.value, params: {} })}
                  >
                    {catalog.actions.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.label}
                        {catalog.executors[a.key] === 'development' ? ' (recorded in development)' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <p className="small muted">{catalog.actions.find((a) => a.key === step.action)?.description}</p>
              <SchemaForm
                schema={catalog.actions.find((a) => a.key === step.action)?.paramsSchema}
                value={step.params}
                onChange={(params) => update({ params })}
                issues={errors}
                disabled={readOnly}
              />
              <label className="auto-check">
                <input type="checkbox" checked={step.await === true} onChange={(e) => setOptional('await', e.target.checked ? true : undefined)} /> Wait for the result
                (later steps can read it, failures go to &ldquo;If it fails&rdquo;)
              </label>
              {step.await ? <TextInput label="Give up after" optional hint={`${DURATION_HINT}. Default 1d.`} value={step.timeout} onChange={(v) => setOptional('timeout', v)} code /> : null}
            </>
          ) : null}

          {step.type === 'ai_step' ? (
            <>
              <Field label="Agent">
                {(control) => (
                  <select {...control} className="select" value={step.agent} onChange={(e) => onChange({ ...step, agent: e.target.value, input: {} })}>
                    {catalog.agents.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.label}
                        {a.requiresApproval ? ' (needs approval)' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {catalog.agents.find((a) => a.key === step.agent)?.requiresApproval ? (
                <Alert tone="info">What this agent writes must go through an approval step before anything is sent.</Alert>
              ) : null}
              <SchemaForm schema={catalog.agents.find((a) => a.key === step.agent)?.inputSchema} value={step.input} onChange={(input) => update({ input })} issues={errors} disabled={readOnly} />
              <TextInput label="Give up after" optional hint={`${DURATION_HINT}. Default 1h.`} value={step.timeout} onChange={(v) => setOptional('timeout', v)} code />
            </>
          ) : null}

          {step.type === 'condition' ? (
            <TextInput label="If" code multiline value={step.if} onChange={(v) => update({ if: v ?? '' })} error={errors['@if']} hint="e.g. record.stage == 'demo_done' and record.valueMinor > 5000000" />
          ) : null}

          {step.type === 'branch' ? (
            <div className="stack gap-12">
              {step.cases.map((c, i) => (
                <div key={i} className="auto-case">
                  <div className="auto-case__head">
                    <strong className="small">Case {i + 1}</strong>
                    {!readOnly && step.cases.length > 1 ? (
                      <Button size="sm" variant="ghost" icon="x" onClick={() => update({ cases: step.cases.filter((_, j) => j !== i) })}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                  <TextInput label="Name" optional value={c.label} onChange={(v) => update({ cases: step.cases.map((x, j) => (j === i ? { ...x, label: v } : x)) })} />
                  <TextInput label="When" code value={c.when} onChange={(v) => update({ cases: step.cases.map((x, j) => (j === i ? { ...x, when: v ?? '' } : x)) })} />
                </div>
              ))}
              {!readOnly ? (
                <Button size="sm" icon="plus" onClick={() => update({ cases: [...step.cases, { when: 'true' }] })}>
                  Add case
                </Button>
              ) : null}
            </div>
          ) : null}

          {step.type === 'wait' ? <WaitFields step={step} catalog={catalog} errors={errors} onChange={onChange} /> : null}

          {step.type === 'approval' ? (
            <>
              <TextInput label="Title" value={step.title} onChange={(v) => update({ title: v ?? '' })} hint="{{ }} templates work here" error={errors['@title']} />
              <TextInput label="Details" optional multiline value={step.body} onChange={(v) => setOptional('body', v)} />
              <fieldset className="auto-fieldset">
                <legend className="field__label">Who approves</legend>
                <label className="auto-check">
                  <input type="checkbox" checked={step.approvers.owner === true} onChange={(e) => update({ approvers: { ...step.approvers, owner: e.target.checked || undefined } })} /> The record&apos;s owner
                </label>
                <TextInput
                  label="Or anyone with this permission"
                  optional
                  code
                  value={step.approvers.permission}
                  onChange={(v) => update({ approvers: { ...step.approvers, permission: v } })}
                  hint="Managers and admins with automations.approve can always decide, unless a permission is named here."
                />
                {errors['@approvers'] ? <p className="field__error">{errors['@approvers']}</p> : null}
              </fieldset>
              <RecordField
                label="What the approver sees and may edit"
                value={step.data}
                onChange={(v) => setOptional('data', v)}
                keyLabel="Field"
                valueLabel="Text or {{ template }}"
                disabled={readOnly}
              />
              <p className="small muted">
                To show an AI draft, add a field <span className="crm-mono">draft</span> with the value <span className="crm-mono">{'{{ steps.<ai step>.output.draft }}'}</span>. Later steps read the approved
                text as <span className="crm-mono">{`steps.${step.id}.output.data.draft`}</span>.
              </p>
              <TextInput label="Expires after" optional code hint={DURATION_HINT} value={step.timeout} onChange={(v) => setOptional('timeout', v)} />
            </>
          ) : null}

          {step.type === 'end' ? (
            <Field label="Outcome">
              {(control) => (
                <select {...control} className="select" value={step.outcome ?? 'completed'} onChange={(e) => setOptional('outcome', e.target.value === 'completed' ? undefined : e.target.value)}>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              )}
            </Field>
          ) : null}

          {edgesOf(step).map((edge) => (
            <PointerSelect
              key={edge.field}
              label={edge.label}
              value={edge.to}
              steps={definition.steps}
              self={step.id}
              error={errors[`@${edge.field}`]}
              onChange={(to) => onChange(setEdge(step, edge.field, to))}
              disabled={readOnly}
            />
          ))}
          <TextInput label="Notes" optional multiline value={step.notes} onChange={(v) => setOptional('notes', v)} />
        </div>
      </fieldset>
      {!readOnly ? (
        <div className="row gap-8 auto-inspector__actions">
          {definition.start !== step.id ? (
            <Button size="sm" onClick={onMakeStart}>
              Make this the first step
            </Button>
          ) : null}
          <Button size="sm" variant="danger" icon="trash" onClick={onRemove}>
            Remove step
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function WaitFields({ step, catalog, errors, onChange }: { step: WaitStep; catalog: AutomationCatalog; errors: Record<string, string>; onChange: (step: FlowStep) => void }) {
  const events = [...new Set(catalog.triggers.flatMap((t) => t.events).filter((e) => !e.startsWith('automation.')).concat(['deal.stage_changed', 'deal.updated', 'task.completed', 'deal.first_replied']))].sort();
  const set = (patch: Partial<WaitStep>, drop: string[] = []) => {
    const copy = { ...step, ...patch } as Record<string, unknown>;
    for (const key of drop) delete copy[key];
    onChange(copy as unknown as FlowStep);
  };
  return (
    <>
      <Field label="Wait">
        {(control) => (
          <select
            {...control}
            className="select"
            value={step.mode}
            onChange={(e) => {
              const mode = e.target.value as WaitStep['mode'];
              if (mode === 'duration') set({ mode, duration: step.duration ?? '1d' }, ['until', 'event', 'filter', 'timeout', 'onTimeout']);
              if (mode === 'until') set({ mode, until: step.until ?? { timeOfDay: '10:00' } }, ['duration', 'event', 'filter', 'timeout', 'onTimeout']);
              if (mode === 'event') set({ mode, event: step.event ?? 'booking.created', timeout: step.timeout ?? '2d', filter: step.filter ?? 'event.payload.dealId == trigger.payload.dealId' }, ['duration', 'until']);
            }}
          >
            <option value="duration">For a while</option>
            <option value="until">Until a time</option>
            <option value="event">Until something happens</option>
          </select>
        )}
      </Field>
      {step.mode === 'duration' ? <TextInput label="How long" code hint={DURATION_HINT} value={step.duration} onChange={(v) => set({ duration: v ?? '' })} error={errors['@duration']} /> : null}
      {step.mode === 'until' ? (
        <>
          <TextInput
            label="Time of day"
            optional
            code
            hint="HH:MM in the flow's time zone (the next such time)"
            value={step.until?.timeOfDay}
            onChange={(v) => set({ until: v ? { ...step.until, timeOfDay: v, at: undefined } : { at: step.until?.at } })}
          />
          <TextInput
            label="Or at (expression)"
            optional
            code
            hint="e.g. record.expectedCloseOn or trigger.payload.startsAt - 1d"
            value={step.until?.at}
            onChange={(v) => set({ until: v ? { at: v } : { timeOfDay: step.until?.timeOfDay ?? '10:00' } })}
          />
          {errors['@until'] ? <p className="field__error">{errors['@until']}</p> : null}
        </>
      ) : null}
      {step.mode === 'event' ? (
        <>
          <Field label="Event" error={errors['@event']}>
            {(control) => (
              <select {...control} className="select" value={step.event ?? ''} onChange={(e) => set({ event: e.target.value })}>
                {events.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <TextInput label="Only when" optional code value={step.filter} onChange={(v) => set({ filter: v }, v ? [] : ['filter'])} hint="e.g. event.payload.dealId == trigger.payload.dealId" error={errors['@filter']} />
          <TextInput label="Wait at most" code hint={DURATION_HINT} value={step.timeout} onChange={(v) => set({ timeout: v ?? '' })} error={errors['@timeout']} />
        </>
      ) : null}
    </>
  );
}

export function TriggerInspector({
  trigger,
  settings,
  catalog,
  issues,
  onChange,
  readOnly,
}: {
  trigger: FlowTrigger;
  settings: FlowSettings | undefined;
  catalog: AutomationCatalog;
  issues: readonly EngineIssue[];
  onChange: (trigger: FlowTrigger, settings: FlowSettings) => void;
  readOnly: boolean;
}) {
  const def = catalog.triggers.find((t) => t.key === trigger.type);
  const current: FlowSettings = { timeZone: 'Asia/Kolkata', reentry: 'skip_if_active', ...settings };
  const errors = issueMap(issues);
  return (
    <div className="auto-inspector">
      <div className="auto-inspector__head">
        <Icon name="bolt" size={18} />
        <div>
          <h2>When this happens</h2>
          <p className="small muted">The trigger starts a run for each matching event.</p>
        </div>
      </div>
      {issues.length > 0 ? (
        <Alert tone="error" title="Fix the trigger">
          <ul className="auto-issues">
            {issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <fieldset className="auto-fieldset auto-fieldset--plain" disabled={readOnly}>
        <div className="stack gap-12">
          <Field label="Trigger">
            {(control) => (
              <select {...control} className="select" value={trigger.type} onChange={(e) => onChange({ type: e.target.value, ...(trigger.filter ? { filter: trigger.filter } : {}) }, current)}>
                {catalog.triggers.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {def?.description ? <p className="small muted">{def.description}</p> : null}
          {def?.configSchema?.properties && Object.keys(def.configSchema.properties).length > 0 ? (
            <SchemaForm
              schema={def.configSchema}
              value={trigger.config}
              onChange={(config) => onChange(Object.keys(config).length ? { ...trigger, config } : { type: trigger.type, ...(trigger.filter ? { filter: trigger.filter } : {}) }, current)}
              issues={errors}
              allowExpressions={false}
              disabled={readOnly}
            />
          ) : null}
          <TextInput
            label="Only when"
            optional
            code
            multiline
            value={trigger.filter}
            onChange={(filter) => {
              const next: FlowTrigger = { ...trigger };
              if (filter) next.filter = filter;
              else delete next.filter;
              onChange(next, current);
            }}
            hint="An expression over trigger, event and record, e.g. record.kind == 'b2c' and trigger.payload.channel != 'import'"
            error={errors['@filter']}
          />
          <Field label="Runs per record" hint="Whether a record can be in this flow more than once">
            {(control) => (
              <select {...control} className="select" value={current.reentry} onChange={(e) => onChange(trigger, { ...current, reentry: e.target.value as FlowSettings['reentry'] })}>
                <option value="skip_if_active">One at a time (skip while a run is going)</option>
                <option value="once">Once ever</option>
                <option value="allow">Every time</option>
              </select>
            )}
          </Field>
          <TextInput label="Time zone" code value={current.timeZone} onChange={(v) => onChange(trigger, { ...current, timeZone: v ?? 'Asia/Kolkata' })} hint="For time-of-day waits and schedules, e.g. Asia/Kolkata" />
          {def?.sample?.payload ? (
            <details className="auto-details">
              <summary className="small">What the event carries (sample)</summary>
              <JsonField label="Sample payload" value={def.sample.payload as JsonObject} onChange={() => undefined} disabled />
            </details>
          ) : null}
        </div>
      </fieldset>
    </div>
  );
}
