'use client';

import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FieldControl } from '@/components/DynamicField';
import { Guard } from '@/components/Guard';
import { Alert, Badge, Button, Card, ErrorAlert, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf } from '@/lib/api';
import { sameValue } from '@/lib/objects';
import { keys, useSettingDefinitions, useUnitSettings, useUnitTypes } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { unitTypeLabel } from '@/lib/tree';
import type { FieldDef, OrgUnit, SettingDefinition, SettingValue, UnitType } from '@/lib/types';

export function GeneralView() {
  return (
    <Guard anyOf={['settings.view']}>
      <General />
    </Guard>
  );
}

function General() {
  const { scope } = useSession();
  const definitions = useSettingDefinitions();
  const settings = useUnitSettings(scope.id);
  const types = useUnitTypes();

  if (definitions.isPending || settings.isPending) return <PageLoading />;
  if (definitions.isError || settings.isError) return <ErrorAlert error={definitions.error ?? settings.error} />;

  // Group by category, keeping the order modules declared them in.
  const categories = new Map<string, SettingDefinition[]>();
  for (const definition of definitions.data) {
    categories.set(definition.category, [...(categories.get(definition.category) ?? []), definition]);
  }

  return (
    <div className="stack gap-16">
      <Alert tone="info">
        Settings flow down the organisation. A value set on {scope.name} applies to everything inside it unless a unit
        below sets its own.
        {settings.data.canManage ? null : ' You can see these settings here but not change them.'}
      </Alert>
      {[...categories.entries()].map(([category, items]) => (
        <Card key={category} flush title={category}>
          <div className="settings-list">
            {items.map((definition) => {
              const state = settings.data.values[definition.key];
              return state ? (
                <SettingRow
                  key={`${scope.id}:${definition.key}`}
                  definition={definition}
                  state={state}
                  unit={scope}
                  canManage={settings.data.canManage}
                  types={types.data}
                />
              ) : null;
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}

const orList = (items: string[]) => new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(items);

/** URL settings can be cleared; an empty box means "no value". */
function toSaved(definition: SettingDefinition, value: unknown): unknown {
  if (definition.input === 'url' && value === '') return null;
  return value;
}

function SettingRow({
  definition,
  state,
  unit,
  canManage,
  types,
}: {
  definition: SettingDefinition;
  state: SettingValue;
  unit: OrgUnit;
  canManage: boolean;
  types: UnitType[] | undefined;
}) {
  const { unitsById } = useSession();
  const queryClient = useQueryClient();
  const controlId = useId();

  // Follow the saved value, unless the user is part-way through changing it.
  const [baseline, setBaseline] = useState<unknown>(state.value);
  const [draft, setDraft] = useState<unknown>(state.value);
  if (!sameValue(baseline, state.value)) {
    setBaseline(state.value);
    setDraft(state.value);
  }

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.settingsAll });
    // Security policies change what the current user must do.
    if (definition.key.startsWith('security.')) await queryClient.invalidateQueries({ queryKey: keys.me });
  };
  const save = useMutation({
    mutationFn: () => api.put(`/settings/${encodeURIComponent(definition.key)}`, { unitId: unit.id, value: toSaved(definition, draft) }),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: () => api.delete(`/settings/${encodeURIComponent(definition.key)}`, { unitId: unit.id }),
    onSuccess: refresh,
  });

  const setHere = !state.inherited && !state.isDefault;
  const editable = canManage && state.settable;
  const dirty = !sameValue(toSaved(definition, draft), state.value);
  const source = state.isDefault
    ? 'Default'
    : setHere
      ? `Set on ${unit.name}`
      : `From ${unitsById.get(state.sourceUnitId ?? '')?.name ?? 'a unit above'}`;
  const levels = definition.levels.map((level) => unitTypeLabel(types, level).toLowerCase());
  const field: FieldDef = {
    key: definition.key,
    label: definition.label,
    input: definition.input,
    options: definition.options,
  };
  const error = fieldErrorsOf(save.error).value;

  return (
    <div className="setting-row">
      <div className="setting-row__text">
        {definition.input === 'multiselect' || definition.input === 'boolean' ? (
          <span className="strong">{definition.label}</span>
        ) : (
          <label className="strong" htmlFor={controlId}>
            {definition.label}
          </label>
        )}
        {definition.description ? <p className="small muted">{definition.description}</p> : null}
        <div className="row gap-6">
          <Badge tone={setHere ? 'accent' : 'default'}>{source}</Badge>
          {!state.settable ? (
            <span className="small muted">Can be changed on a {orList(levels)}</span>
          ) : null}
        </div>
      </div>
      <div className="setting-row__control">
        <FieldControl
          field={field}
          value={draft}
          onChange={setDraft}
          disabled={!editable}
          allowEmpty={definition.input === 'url'}
          control={{ id: controlId, 'aria-invalid': error ? true : undefined }}
        />
        {error ? <p className="field__error">{error}</p> : null}
        <ErrorAlert error={error ? null : (save.error ?? reset.error)} />
        {editable && (dirty || setHere) ? (
          <div className="row gap-8">
            {dirty ? (
              <>
                <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  Save
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setDraft(state.value);
                    save.reset();
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : null}
            {setHere && !dirty && unit.parentId !== null ? (
              <Button size="sm" variant="ghost" icon="restore" loading={reset.isPending} onClick={() => reset.mutate()}>
                Use the value from above
              </Button>
            ) : null}
            {setHere && !dirty && unit.parentId === null ? (
              <Button size="sm" variant="ghost" icon="restore" loading={reset.isPending} onClick={() => reset.mutate()}>
                Use the default
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
