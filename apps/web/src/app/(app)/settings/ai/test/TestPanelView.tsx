'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { CompanySelect } from '@/components/ai/CompanySelect';
import { ConfidenceMeter, GuardrailList, ReasonChips } from '@/components/ai/Guardrails';
import { OutputView } from '@/components/ai/OutputView';
import { KeyValue, StatusPill, type PillTone } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { humanize } from '@/lib/crm/format';
import { aiCompanies, formatTokens, isJsonObject, keyLabel } from '@/lib/ai/display';
import { useAiCatalog } from '@/lib/ai/queries';
import type { AgentInfo, Json, JsonObject, TestResult } from '@/lib/ai/types';
import { useSession } from '@/lib/session';

// The agent test panel: pick a company and an agent, paste an input, and see the output, its
// confidence, every guardrail decision, the prompt and what a live call would log. Nothing is
// saved (the call is audited and its tokens count against the company's budget).

export function TestPanelView() {
  return (
    <Guard anyOf={['ai.manage']} anywhere>
      <TestPanel />
    </Guard>
  );
}

/** One input field of an agent, from its JSON Schema. */
interface FieldSpec {
  key: string;
  kind: 'text' | 'longText' | 'number' | 'boolean' | 'choice' | 'json';
  required: boolean;
  description: string | null;
  options: string[];
}

type Values = Record<string, string | boolean>;

function fieldsOf(agent: AgentInfo): FieldSpec[] {
  const properties = isJsonObject(agent.inputSchema.properties) ? agent.inputSchema.properties : {};
  const required = Array.isArray(agent.inputSchema.required) ? agent.inputSchema.required.filter((x): x is string => typeof x === 'string') : [];
  return Object.entries(properties).map(([key, raw]) => {
    const schema: JsonObject = isJsonObject(raw) ? raw : {};
    const options = Array.isArray(schema.enum) ? schema.enum.filter((x): x is string => typeof x === 'string') : [];
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : 0;
    let kind: FieldSpec['kind'] = 'json';
    if (options.length > 0) kind = 'choice';
    else if (schema.type === 'string') kind = maxLength > 300 ? 'longText' : 'text';
    else if (schema.type === 'integer' || schema.type === 'number') kind = 'number';
    else if (schema.type === 'boolean') kind = 'boolean';
    return { key, kind, required: required.includes(key), description: typeof schema.description === 'string' ? schema.description : null, options };
  });
}

function valuesFrom(fields: readonly FieldSpec[], input: JsonObject): Values {
  const values: Values = {};
  for (const field of fields) {
    const value = input[field.key];
    if (field.kind === 'boolean') values[field.key] = value === true;
    else if (value === undefined || value === null) values[field.key] = '';
    else if (field.kind === 'json') values[field.key] = JSON.stringify(value, null, 2);
    else values[field.key] = String(value);
  }
  return values;
}

/** The input to send: empty optional fields are left out. */
function inputFrom(fields: readonly FieldSpec[], values: Values): { input: Record<string, Json> } | { field: string; error: string } {
  const input: Record<string, Json> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === 'boolean') {
      if (value === true) input[field.key] = true;
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (text.trim() === '') continue;
    if (field.kind === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) return { field: field.key, error: 'Enter a number' };
      input[field.key] = n;
    } else if (field.kind === 'json') {
      try {
        input[field.key] = JSON.parse(text) as Json;
      } catch {
        return { field: field.key, error: 'This is not valid JSON' };
      }
    } else input[field.key] = text;
  }
  return { input };
}

const RESULT_LABEL: Record<TestResult['status'], string> = {
  completed: 'Would be used automatically',
  pending_review: 'Would wait for review',
  failed: 'Failed',
};
const RESULT_TONE: Record<TestResult['status'], PillTone> = { completed: 'success', pending_review: 'warning', failed: 'danger' };

function TestPanel() {
  const session = useSession();
  const catalog = useAiCatalog();
  const companies = aiCompanies(session, 'ai.manage');
  const [picked, setPicked] = useState<string | null>(null);
  const companyId = picked && companies.some((c) => c.id === picked) ? picked : (companies[0]?.id ?? null);
  const [agentKey, setAgentKey] = useState<string | null>(null);

  if (catalog.isPending) return <PageLoading />;
  if (catalog.isError) return <ErrorAlert error={catalog.error} />;
  if (!companyId) {
    return (
      <Card>
        <EmptyState icon="sparkle" title="No company to test in">
          Agents run with a company’s guardrails. Switch “Working in” to a company where you may test agents.
        </EmptyState>
      </Card>
    );
  }
  const agent = catalog.data.agents.find((a) => a.key === agentKey) ?? catalog.data.agents[0];
  if (!agent) return null;

  return (
    <div className="stack gap-16">
      <div className="row gap-16 ai-test__pickers">
        <CompanySelect companies={companies} value={companyId} onChange={setPicked} id="ai-test-company" />
        <div className="row gap-8">
          <label htmlFor="ai-test-agent" className="small muted">
            Agent
          </label>
          <select id="ai-test-agent" className="select toolbar__select" value={agent.key} onChange={(e) => setAgentKey(e.target.value)}>
            {catalog.data.agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {/* A fresh form (and result) per agent and company. */}
      <AgentTest key={`${companyId}-${agent.key}`} companyId={companyId} agent={agent} />
    </div>
  );
}

function AgentTest({ companyId, agent }: { companyId: string; agent: AgentInfo }) {
  const fields = fieldsOf(agent);
  const [values, setValues] = useState<Values>(() => valuesFrom(fields, agent.sample));
  const [localError, setLocalError] = useState<{ field: string; message: string } | null>(null);
  const run = useMutation({ mutationFn: (input: Record<string, Json>) => api.post<TestResult>('/ai/test', { companyId, agent: agent.key, input }) });

  const serverErrors = fieldErrorsOf(run.error);
  const errorFor = (key: string) => (localError?.field === key ? localError.message : (serverErrors[`body.input.${key}`] ?? Object.entries(serverErrors).find(([path]) => path.startsWith(`body.input.${key}.`))?.[1]));
  const shown = fields.map((f) => `body.input.${f.key}`);
  const set = (key: string, value: string | boolean) => setValues({ ...values, [key]: value });

  return (
    <div className="ai-columns">
      <Card title={agent.label} description={agent.description}>
        <form
          className="stack gap-12"
          onSubmit={(e) => {
            e.preventDefault();
            setLocalError(null);
            const built = inputFrom(fields, values);
            if ('error' in built) setLocalError({ field: built.field, message: built.error });
            else run.mutate(built.input);
          }}
        >
          <div className="row gap-8">
            {agent.alwaysReview ? <Badge title="A person approves every draft before it is used">Always reviewed</Badge> : null}
            {agent.customerFacing ? <Badge title="Its text goes to families or institutes, so fee, discount and link checks apply">Customer-facing</Badge> : null}
          </div>
          {fields.map((field) => (
            <InputField key={field.key} field={field} value={values[field.key] ?? ''} error={errorFor(field.key)} onChange={(value) => set(field.key, value)} />
          ))}
          <ErrorAlert error={formErrorOf(run.error, shown)} />
          <div className="row gap-8">
            <Button type="submit" variant="primary" icon="sparkle" loading={run.isPending}>
              Run agent
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setValues(valuesFrom(fields, agent.sample));
                setLocalError(null);
                run.reset();
              }}
            >
              Use the sample
            </Button>
            <Button type="button" variant="ghost" onClick={() => setValues(valuesFrom(fields, {}))}>
              Clear
            </Button>
          </div>
          <p className="small muted">A dry run with this company’s guardrails: nothing is saved or sent, but tokens count against the monthly budget.</p>
        </form>
      </Card>
      <div aria-live="polite">{run.data ? <ResultView result={run.data} /> : <ResultPlaceholder pending={run.isPending} />}</div>
    </div>
  );
}

function InputField({ field, value, error, onChange }: { field: FieldSpec; value: string | boolean; error: string | undefined; onChange: (value: string | boolean) => void }) {
  const label = keyLabel(field.key);
  if (field.kind === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  const text = typeof value === 'string' ? value : '';
  const hint = field.kind === 'json' ? `JSON${field.description ? `. ${field.description}` : ''}` : (field.description ?? undefined);
  return (
    <Field label={label} optional={!field.required} error={error} hint={hint}>
      {(control) =>
        field.kind === 'choice' ? (
          <select {...control} className="select" value={text} onChange={(e) => onChange(e.target.value)}>
            {field.required ? null : <option value="">Not set</option>}
            {field.options.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>
        ) : field.kind === 'longText' || field.kind === 'json' ? (
          <textarea
            {...control}
            className={field.kind === 'json' ? 'textarea ai-test__json' : 'textarea ai-test__input'}
            value={text}
            spellCheck={field.kind !== 'json'}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input {...control} className="input" inputMode={field.kind === 'number' ? 'numeric' : undefined} value={text} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Field>
  );
}

function ResultPlaceholder({ pending }: { pending: boolean }) {
  return (
    <Card>
      <EmptyState icon="sparkle" title={pending ? 'Running…' : 'No result yet'}>
        {pending ? 'Waiting for the model.' : 'Run the agent to see its output, confidence and guardrail decisions here.'}
      </EmptyState>
    </Card>
  );
}

function ResultView({ result }: { result: TestResult }) {
  const { preview } = result;
  const model = result.model ? `${result.model}${result.mock ? ' (mock)' : ''}` : result.mock ? 'Mock' : '—';
  return (
    <Card
      title="Result"
      actions={
        <span className="row gap-8">
          <StatusPill tone={RESULT_TONE[result.status]}>{RESULT_LABEL[result.status]}</StatusPill>
          {result.mock ? <Badge title="Answered by the offline mock model">Mock</Badge> : null}
        </span>
      }
    >
      <div className="stack gap-16">
        <ConfidenceMeter confidence={result.confidence} threshold={result.threshold} />
        <ReasonChips reasons={result.reviewReasons} />
        {result.error ? (
          <Alert tone="error" title="The call failed">
            {result.error.message ?? result.error.code}
          </Alert>
        ) : null}

        <section className="stack gap-8" aria-labelledby="ai-test-output">
          <h3 id="ai-test-output" className="small strong">
            Output
          </h3>
          <OutputView value={result.output} hide={['confidence']} />
        </section>

        <section className="stack gap-8" aria-labelledby="ai-test-guardrails">
          <h3 id="ai-test-guardrails" className="small strong">
            Guardrail decisions
          </h3>
          <GuardrailList results={result.guardrails} />
        </section>

        <KeyValue
          items={[
            { label: 'Model', value: model },
            { label: 'Tokens', value: `${formatTokens(result.usage.inputTokens)} in · ${formatTokens(result.usage.outputTokens)} out` },
            { label: 'Time', value: `${(result.latencyMs / 1000).toFixed(1)} s${result.attempts > 1 ? ` · ${result.attempts} attempts` : ''}` },
          ]}
        />

        <details className="ai-details">
          <summary>Prompt sent to the model</summary>
          <div className="stack gap-8">
            <p className="small muted">
              System prompt, then the messages. Outside text is wrapped in delimiters and treated as data, never as instructions.
            </p>
            <pre className="code-pre ai-prompt">{preview.request.system}</pre>
            {preview.request.messages.map((message, i) => (
              <div key={i} className="stack gap-4">
                <span className="small strong">{humanize(message.role)}</span>
                <pre className="code-pre ai-prompt">{message.content}</pre>
              </div>
            ))}
          </div>
        </details>
        <details className="ai-details">
          <summary>What a live call would log</summary>
          <pre className="code-pre ai-prompt">{JSON.stringify(preview.log, null, 2)}</pre>
        </details>
        <details className="ai-details">
          <summary>Timeline entry</summary>
          {preview.timeline ? (
            <pre className="code-pre ai-prompt">{JSON.stringify(preview.timeline, null, 2)}</pre>
          ) : (
            <p className="small muted">None: a timeline entry is added only when the call is about a lead, contact or account.</p>
          )}
        </details>
        {Object.keys(preview.context).length > 0 ? (
          <details className="ai-details">
            <summary>Context the agent loaded</summary>
            <pre className="code-pre ai-prompt">{JSON.stringify(preview.context, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </Card>
  );
}
