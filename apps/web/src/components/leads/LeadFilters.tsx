'use client';

import { useState, type ReactNode } from 'react';
import { FilterBar, channelIcon, type ChipOption } from '@/components/crm';
import { Field } from '@/components/ui';
import { CHANNEL_KEYS, channelLabel } from '@/lib/crm/format';
import type { Channel, DealFilters, DealSlaFilter, DealStatus, PersonOption, Pipeline, ProductLine } from '@/lib/crm/types';
import { dayEndIso, dayStartIso, filterCount, isoToDay } from '@/lib/deals/views';

const STATUS_OPTIONS: ChipOption[] = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

/** Filters shown outside the "More filters" popover; the rest count towards its badge. */
const OUTSIDE = new Set(['q', 'channel', 'status', 'owner']);

/** A comma-separated list typed in a box, applied on Enter or when the box loses focus. */
function ListInput({
  id,
  value,
  onChange,
  placeholder,
  describedBy,
}: {
  id: string;
  value: string[] | undefined;
  onChange: (next: string[]) => void;
  placeholder: string;
  describedBy?: string;
}) {
  const joined = (value ?? []).join(', ');
  const [text, setText] = useState(joined);
  const [seen, setSeen] = useState(joined);
  if (seen !== joined) {
    setSeen(joined);
    setText(joined);
  }
  const commit = () => {
    const next = text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (next.join(', ') !== joined) onChange(next);
  };
  return (
    <input
      id={id}
      className="input"
      value={text}
      placeholder={placeholder}
      aria-describedby={describedBy}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

export function LeadFilters({
  filters,
  onChange,
  channels,
  pipelines,
  productLines,
  owners,
  end,
}: {
  filters: DealFilters;
  onChange: (next: DealFilters) => void;
  channels: readonly Channel[] | undefined;
  pipelines: readonly Pipeline[];
  productLines: readonly ProductLine[];
  owners: readonly PersonOption[];
  /** Saved views and columns. */
  end?: ReactNode;
}) {
  const set = <K extends keyof DealFilters>(key: K, value: DealFilters[K]) => onChange({ ...filters, [key]: value });

  const channelOptions: ChipOption[] = (
    channels?.map((channel) => ({ key: channel.key, label: channel.label })) ?? CHANNEL_KEYS.map((key) => ({ key, label: channelLabel(key) }))
  ).map(({ key, label }) => ({ value: key, label, icon: channelIcon(key) }));

  const pipeline = pipelines.length === 1 ? pipelines[0] : pipelines.find((item) => item.id === filters.pipelineId);
  const stages = pipeline ? pipeline.stages.filter((stage) => stage.archivedAt === null).sort((a, b) => a.position - b.position) : [];
  const selectedStages = filters.stageId ?? [];
  const owner = filters.owner ?? [];
  const ownerValue = owner.length === 0 ? '' : owner.length === 1 ? (owner[0] ?? '') : 'several';

  const moreCount = Object.keys(filters).reduce((total, key) => {
    if (OUTSIDE.has(key)) return total;
    return total + filterCount({ [key]: filters[key as keyof DealFilters] } as DealFilters);
  }, 0);

  const more = (
    <div className="leads-more">
      {pipelines.length > 1 ? (
        <Field label="Pipeline">
          {(control) => (
            <select
              {...control}
              className="select"
              value={filters.pipelineId ?? ''}
              onChange={(event) => onChange({ ...filters, pipelineId: event.target.value || undefined, stageId: undefined })}
            >
              <option value="">Any pipeline</option>
              {pipelines.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <fieldset className="leads-more__group">
        <legend className="field__label">Stage</legend>
        {stages.length === 0 ? (
          <p className="muted small">{pipelines.length > 1 ? 'Pick a pipeline to filter by stage.' : 'No stages to filter by.'}</p>
        ) : (
          <div className="leads-more__checks">
            {stages.map((stage) => (
              <label key={stage.id} className="check">
                <input
                  type="checkbox"
                  checked={selectedStages.includes(stage.id)}
                  onChange={(event) =>
                    set('stageId', event.target.checked ? [...selectedStages, stage.id] : selectedStages.filter((id) => id !== stage.id))
                  }
                />
                <span>{stage.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {productLines.length > 0 ? (
        <fieldset className="leads-more__group">
          <legend className="field__label">Product line</legend>
          <div className="leads-more__checks">
            {productLines.map((line) => {
              const selected = filters.productLineId ?? [];
              return (
                <label key={line.id} className="check">
                  <input
                    type="checkbox"
                    checked={selected.includes(line.id)}
                    onChange={(event) =>
                      set('productLineId', event.target.checked ? [...selected, line.id] : selected.filter((id) => id !== line.id))
                    }
                  />
                  <span>{line.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <Field label="SLA">
        {(control) => (
          <select
            {...control}
            className="select"
            value={filters.sla ?? ''}
            onChange={(event) => set('sla', (event.target.value || undefined) as DealSlaFilter | undefined)}
          >
            <option value="">Any</option>
            <option value="breached">Breached (stage SLA or first reply)</option>
            <option value="due_soon">Due soon</option>
          </select>
        )}
      </Field>
      <div className="leads-more__pair">
        <Field label="Created from">
          {(control) => (
            <input
              {...control}
              type="date"
              className="input"
              value={isoToDay(filters.createdFrom)}
              onChange={(event) => set('createdFrom', dayStartIso(event.target.value) ?? undefined)}
            />
          )}
        </Field>
        <Field label="Created to">
          {(control) => (
            <input
              {...control}
              type="date"
              className="input"
              value={isoToDay(filters.createdTo, true)}
              onChange={(event) => set('createdTo', dayEndIso(event.target.value) ?? undefined)}
            />
          )}
        </Field>
      </div>
      <div className="leads-more__pair">
        <Field label="Updated from">
          {(control) => (
            <input
              {...control}
              type="date"
              className="input"
              value={isoToDay(filters.updatedFrom)}
              onChange={(event) => set('updatedFrom', dayStartIso(event.target.value) ?? undefined)}
            />
          )}
        </Field>
        <Field label="Updated to">
          {(control) => (
            <input
              {...control}
              type="date"
              className="input"
              value={isoToDay(filters.updatedTo, true)}
              onChange={(event) => set('updatedTo', dayEndIso(event.target.value) ?? undefined)}
            />
          )}
        </Field>
      </div>
      <Field label="Tags" hint="Any of these, separated by commas">
        {(control) => (
          <ListInput
            id={control.id}
            describedBy={control['aria-describedby']}
            value={filters.tag}
            onChange={(next) => set('tag', next)}
            placeholder="scholarship, sibling"
          />
        )}
      </Field>
      <div className="leads-more__pair">
        <Field label="Campaign">
          {(control) => <ListInput id={control.id} value={filters.campaign} onChange={(next) => set('campaign', next)} placeholder="sat-diwali" />}
        </Field>
        <Field label="Source (UTM)">
          {(control) => <ListInput id={control.id} value={filters.source} onChange={(next) => set('source', next)} placeholder="google" />}
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={filters.nurture === true} onChange={(event) => set('nurture', event.target.checked ? true : undefined)} />
        <span>Only leads in a nurture flow</span>
      </label>
    </div>
  );

  return (
    <FilterBar
      search={{
        value: filters.q ?? '',
        onChange: (value) => set('q', value || undefined),
        label: 'Search leads',
        placeholder: 'Name, phone, email, ref or title',
      }}
      chips={[
        { label: 'Channel', options: channelOptions, selected: filters.channel ?? [], onChange: (next) => set('channel', next) },
        {
          label: 'Status',
          options: STATUS_OPTIONS,
          selected: filters.status ?? [],
          onChange: (next) => set('status', next as DealStatus[]),
          showLabel: true,
        },
      ]}
      extraActiveCount={owner.length}
      more={{ content: more, activeCount: moreCount }}
      onClear={() => onChange({})}
      end={end}
    >
      <label className="leads-owner">
        <span className="visually-hidden">Owner</span>
        <select className="select" value={ownerValue} onChange={(event) => set('owner', event.target.value ? [event.target.value] : undefined)}>
          <option value="">Any owner</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {ownerValue === 'several' ? (
            <option value="several" disabled>
              Several people
            </option>
          ) : null}
          {owners.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
    </FilterBar>
  );
}
