'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { CompanySelect } from '@/components/ai/CompanySelect';
import { Guard } from '@/components/Guard';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, PageLoading } from '@/components/ui';
import { api } from '@/lib/api';
import { aiCompanies, formatTokens } from '@/lib/ai/display';
import { aiKeys, useAiCatalog, useAiConfig } from '@/lib/ai/queries';
import type { AgentInfo, AiCatalog, AiConfig } from '@/lib/ai/types';
import { keys } from '@/lib/queries';
import { useSession } from '@/lib/session';

// Guardrails per company (docs/platform/AI.md "Guardrails"): what the AI may quote, the topics it
// always hands over, which agents run, the confidence each needs and the monthly budget. These
// are ordinary settings (PUT /settings/:key on the company), inherited from the group.

export function GuardrailsView() {
  return (
    <Guard anyOf={['ai.view']} anywhere>
      <Guardrails />
    </Guard>
  );
}

function Guardrails() {
  const session = useSession();
  const companies = aiCompanies(session, 'ai.view');
  const [picked, setPicked] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const companyId = picked && companies.some((c) => c.id === picked) ? picked : (companies[0]?.id ?? null);
  const catalog = useAiCatalog();
  const config = useAiConfig(companyId);

  if (!companyId) {
    return (
      <Card>
        <EmptyState icon="settings" title="No company to show">
          AI guardrails are set per company. Switch “Working in” to a company you can see.
        </EmptyState>
      </Card>
    );
  }
  if (catalog.isPending || config.isPending) return <PageLoading />;
  if (catalog.isError || config.isError) return <ErrorAlert error={catalog.error ?? config.error} />;

  return (
    <div className="stack gap-16">
      <CompanySelect
        companies={companies}
        value={companyId}
        onChange={(id) => {
          setPicked(id);
          setSavedFor(null);
        }}
      />
      <UsageCard config={config.data} />
      {/* Remount after each save so the form starts from what the server now holds. */}
      <GuardrailsForm
        key={`${companyId}-${config.dataUpdatedAt}`}
        config={config.data}
        catalog={catalog.data}
        saved={savedFor === companyId}
        onSaved={(saved) => setSavedFor(saved ? companyId : null)}
      />
    </div>
  );
}

function UsageCard({ config }: { config: AiConfig }) {
  const { usage, settings, connection } = config;
  const budget = settings.monthlyTokenBudget;
  const used = budget > 0 ? Math.min(1, usage.totalTokens / budget) : 1;
  return (
    <Card flush title="Model and budget" description={`This month (${usage.period}, UTC) for ${config.company.name}.`}>
      <div className="ai-usage">
        <div className="row gap-8">
          <span className="strong">{connection ? connection.name : 'No AI connection'}</span>
          {connection?.mock ? <Badge title="Answers come from the offline mock model">Mock model</Badge> : null}
          {connection?.fallback ? <Badge title="No connection is set up for this company, so the built-in mock is used">Built-in fallback</Badge> : null}
        </div>
        {config.connectionProblem ? <Alert tone="warning">{config.connectionProblem}</Alert> : null}
        <div className="ai-meter">
          <div
            className="ai-meter__bar"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={budget}
            aria-valuenow={Math.min(usage.totalTokens, budget)}
            aria-label={`${formatTokens(usage.totalTokens)} of ${formatTokens(budget)} tokens used`}
          >
            <span className={used >= 0.9 ? 'ai-meter__fill ai-meter__fill--low' : 'ai-meter__fill'} style={{ width: `${Math.round(used * 100)}%` }} />
          </div>
        </div>
        <div className="ai-usage__numbers">
          <span>
            {formatTokens(usage.totalTokens)} of {budget > 0 ? formatTokens(budget) : '0 (AI is off)'} tokens
          </span>
          <span className="muted">
            {usage.calls} {usage.calls === 1 ? 'call' : 'calls'} · {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
          </span>
        </div>
      </div>
    </Card>
  );
}

interface Draft {
  enabledAgents: string[];
  mayQuoteFees: boolean;
  mayQuoteDiscounts: boolean;
  handoverTopics: string[];
  monthlyTokenBudget: string;
  /** Percent, as typed. */
  thresholds: Record<string, string>;
}

const toPercent = (value: number) => String(Math.round(value * 100));

function draftOf(config: AiConfig): Draft {
  const { settings } = config;
  return {
    enabledAgents: settings.enabledAgents,
    mayQuoteFees: settings.mayQuoteFees,
    mayQuoteDiscounts: settings.mayQuoteDiscounts,
    handoverTopics: settings.handoverTopics,
    monthlyTokenBudget: String(settings.monthlyTokenBudget),
    thresholds: Object.fromEntries(Object.entries(settings.thresholds).map(([agent, value]) => [agent, toPercent(value)])),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

type Change = { key: string; value: unknown };

/** The settings that differ from what is saved, or the first problem with the draft. */
function changesOf(draft: Draft, config: AiConfig, catalog: AiCatalog): { changes: Change[]; errors: Record<string, string> } {
  const { settings } = config;
  const changes: Change[] = [];
  const errors: Record<string, string> = {};
  // Keep the registry order so the saved list reads the same as the screen.
  const order = (list: string[], all: readonly string[]) => all.filter((item) => list.includes(item));
  if (!sameSet(draft.enabledAgents, settings.enabledAgents)) {
    changes.push({ key: 'ai.enabledAgents', value: order(draft.enabledAgents, catalog.agents.map((a) => a.key)) });
  }
  if (draft.mayQuoteFees !== settings.mayQuoteFees) changes.push({ key: 'ai.mayQuoteFees', value: draft.mayQuoteFees });
  if (draft.mayQuoteDiscounts !== settings.mayQuoteDiscounts) changes.push({ key: 'ai.mayQuoteDiscounts', value: draft.mayQuoteDiscounts });
  if (!sameSet(draft.handoverTopics, settings.handoverTopics)) {
    changes.push({ key: 'ai.handoverTopics', value: order(draft.handoverTopics, catalog.handoverTopics.map((t) => t.key)) });
  }
  const budget = Number(draft.monthlyTokenBudget);
  if (!/^\d+$/.test(draft.monthlyTokenBudget.trim()) || budget > 1_000_000_000) errors['ai.monthlyTokenBudget'] = 'A whole number of tokens, up to 1,000,000,000';
  else if (budget !== settings.monthlyTokenBudget) changes.push({ key: 'ai.monthlyTokenBudget', value: budget });
  for (const agent of catalog.agents) {
    const key = `ai.threshold.${agent.key}`;
    const typed = (draft.thresholds[agent.key] ?? '').trim();
    const value = Number(typed);
    if (typed === '' || !Number.isFinite(value) || value < 0 || value > 100) errors[key] = 'Between 0 and 100';
    else if (Math.round(value) / 100 !== settings.thresholds[agent.key]) changes.push({ key, value: Math.round(value) / 100 });
  }
  return { changes, errors };
}

function GuardrailsForm({ config, catalog, saved, onSaved }: { config: AiConfig; catalog: AiCatalog; saved: boolean; onSaved: (saved: boolean) => void }) {
  const queryClient = useQueryClient();
  const companyId = config.company.id;
  const [draft, setDraft] = useState<Draft>(() => draftOf(config));
  const [touched, setTouched] = useState(false);
  const canEdit = config.canEditSettings;
  const { changes, errors } = changesOf(draft, config, catalog);
  const hasErrors = Object.keys(errors).length > 0;

  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: aiKeys.configAll }), queryClient.invalidateQueries({ queryKey: keys.settingsAll })]);
  };
  const save = useMutation({
    mutationFn: async () => {
      // One request per changed setting (each is its own audited change).
      for (const change of changes) {
        await api.put(`/settings/${encodeURIComponent(change.key)}`, { unitId: companyId, value: change.value });
      }
    },
    onSuccess: async () => {
      onSaved(true);
      await refresh();
    },
    onSettled: async (_data, error) => {
      if (error) await refresh();
    },
  });
  const reset = useMutation({
    mutationFn: (key: string) => api.delete(`/settings/${encodeURIComponent(key)}`, { unitId: companyId }),
    onSuccess: refresh,
  });

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setTouched(true);
    onSaved(false);
  };
  const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));
  const source = (key: string, what?: string) => (
    <SourceNote config={config} settingKey={key} what={what} canReset={canEdit} onReset={() => reset.mutate(key)} pending={reset.isPending && reset.variables === key} />
  );

  return (
    <form
      className="stack gap-16"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasErrors && changes.length > 0) save.mutate();
      }}
    >
      {canEdit ? null : <Alert tone="info">You can see {config.company.name}’s AI guardrails but not change them (it needs Manage settings).</Alert>}

      <Card flush title="What the AI may say" description="Checked on every answer before it is used. An answer that breaks a rule waits in the review queue with the reason.">
        <SettingRow label="May quote fees" help="Off: any amount of money in an answer sends it to a person. On: amounts must still come from the record or an approved article." control={source('ai.mayQuoteFees')}>
          <label className="check">
            <input type="checkbox" checked={draft.mayQuoteFees} disabled={!canEdit} onChange={(e) => update({ mayQuoteFees: e.target.checked })} />
            Allowed
          </label>
        </SettingRow>
        <SettingRow label="May mention discounts and scholarships" help="Off: answers that offer a discount, scholarship, waiver or coupon wait for a person." control={source('ai.mayQuoteDiscounts')}>
          <label className="check">
            <input type="checkbox" checked={draft.mayQuoteDiscounts} disabled={!canEdit} onChange={(e) => update({ mayQuoteDiscounts: e.target.checked })} />
            Allowed
          </label>
        </SettingRow>
        <SettingRow
          label="Always hand these to a person"
          help="When a message is about one of these, the AI does not answer and the conversation goes to the review queue."
          control={source('ai.handoverTopics')}
          wide
        >
          <fieldset className="ai-fieldset">
            <legend className="visually-hidden">Handover topics</legend>
            <div className="ai-chips">
              {catalog.handoverTopics.map((topic) => (
                <label key={topic.key} className="chip-toggle">
                  <input
                    type="checkbox"
                    checked={draft.handoverTopics.includes(topic.key)}
                    disabled={!canEdit}
                    onChange={(e) => update({ handoverTopics: toggle(draft.handoverTopics, topic.key, e.target.checked) })}
                  />
                  {topic.label}
                </label>
              ))}
            </div>
          </fieldset>
        </SettingRow>
        <SettingRow
          label="Monthly budget (tokens)"
          help="Input plus output tokens per calendar month. When it is used up, AI calls fail until next month. 0 switches AI off."
          control={source('ai.monthlyTokenBudget')}
          error={touched ? errors['ai.monthlyTokenBudget'] : undefined}
          labelFor="ai-budget"
        >
          <input
            id="ai-budget"
            className="input ai-budget"
            inputMode="numeric"
            value={draft.monthlyTokenBudget}
            disabled={!canEdit}
            aria-invalid={touched && errors['ai.monthlyTokenBudget'] ? true : undefined}
            onChange={(e) => update({ monthlyTokenBudget: e.target.value })}
          />
        </SettingRow>
      </Card>

      <Card
        flush
        title="Agents"
        description="Switch agents on or off for this company and set the confidence each answer needs. Answers below it wait in the review queue."
        actions={source('ai.enabledAgents', 'Agents switched on')}
      >
        {catalog.agents.map((agent) => (
          <AgentRow
            key={agent.key}
            agent={agent}
            enabled={draft.enabledAgents.includes(agent.key)}
            threshold={draft.thresholds[agent.key] ?? ''}
            error={touched ? errors[`ai.threshold.${agent.key}`] : undefined}
            canEdit={canEdit}
            source={source(`ai.threshold.${agent.key}`)}
            onEnabled={(on) => update({ enabledAgents: toggle(draft.enabledAgents, agent.key, on) })}
            onThreshold={(value) => update({ thresholds: { ...draft.thresholds, [agent.key]: value } })}
          />
        ))}
      </Card>

      <ErrorAlert error={save.error ?? reset.error} />
      {canEdit ? (
        <div className={changes.length > 0 ? 'ai-savebar ai-savebar--dirty' : 'ai-savebar'}>
          <span className="small muted" role="status">
            {saved && changes.length === 0 ? 'Saved.' : changes.length > 0 ? `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}` : 'No changes'}
          </span>
          <div className="row gap-8">
            <Button
              type="button"
              variant="ghost"
              disabled={!touched || save.isPending}
              onClick={() => {
                setDraft(draftOf(config));
                setTouched(false);
              }}
            >
              Discard
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={changes.length === 0 || hasErrors}>
              Save guardrails
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

function SettingRow({
  label,
  help,
  control,
  children,
  error,
  labelFor,
  wide = false,
}: {
  label: string;
  help: string;
  control: ReactNode;
  children: ReactNode;
  error?: string | undefined;
  labelFor?: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'ai-settings-row ai-settings-row--wide' : 'ai-settings-row'}>
      <div className="ai-settings-row__text">
        {labelFor ? (
          <label htmlFor={labelFor} className="ai-settings-row__label">
            {label}
          </label>
        ) : (
          <div className="ai-settings-row__label">{label}</div>
        )}
        <p className="ai-settings-row__help">{help}</p>
        {control}
      </div>
      <div className="ai-settings-row__control">
        {children}
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  enabled,
  threshold,
  error,
  canEdit,
  source,
  onEnabled,
  onThreshold,
}: {
  agent: AgentInfo;
  enabled: boolean;
  threshold: string;
  error: string | undefined;
  canEdit: boolean;
  source: ReactNode;
  onEnabled: (on: boolean) => void;
  onThreshold: (value: string) => void;
}) {
  const id = `ai-threshold-${agent.key}`;
  return (
    <div className="ai-settings-row">
      <div className="ai-settings-row__text">
        <div className="row gap-8">
          <label className="check ai-settings-row__label">
            <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => onEnabled(e.target.checked)} />
            {agent.label}
          </label>
          {agent.alwaysReview ? <Badge title="Its drafts always wait for a person, whatever the confidence">Always reviewed</Badge> : null}
        </div>
        <p className="ai-settings-row__help">{agent.description}</p>
        {source}
      </div>
      <div className="ai-settings-row__control">
        <label htmlFor={id} className="small muted">
          Confidence needed
        </label>
        <span className="ai-percent">
          <input
            id={id}
            className="input ai-threshold"
            inputMode="numeric"
            value={threshold}
            disabled={!canEdit}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => onThreshold(e.target.value)}
          />
          <span aria-hidden="true">%</span>
        </span>
        {error ? (
          <span id={`${id}-error`} className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Where a setting's value comes from, with a way back to the inherited value when it is set here. */
function SourceNote({
  config,
  settingKey,
  what,
  canReset,
  onReset,
  pending,
}: {
  config: AiConfig;
  settingKey: string;
  /** Names the setting when the note does not sit next to it. */
  what?: string | undefined;
  canReset: boolean;
  onReset: () => void;
  pending: boolean;
}) {
  const { unitsById } = useSession();
  const sourceId = config.settings.sources[settingKey] ?? null;
  const prefix = what ? `${what}: ` : '';
  if (sourceId === config.company.id) {
    return (
      <span className="ai-source">
        {prefix}Set for {config.company.name}
        {canReset ? (
          <>
            {' · '}
            <button type="button" className="link-button" onClick={onReset} disabled={pending}>
              {pending ? 'Resetting…' : 'Use the inherited value'}
            </button>
          </>
        ) : null}
      </span>
    );
  }
  if (sourceId) {
    return (
      <span className="ai-source">
        {prefix}Inherited from {unitsById.get(sourceId)?.name ?? 'the group'}
      </span>
    );
  }
  return <span className="ai-source">{prefix}Default</span>;
}
