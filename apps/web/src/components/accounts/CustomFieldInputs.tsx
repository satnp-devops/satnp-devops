'use client';

import { FieldControl } from '@/components/DynamicField';
import { Field, FieldGroup } from '@/components/ui';
import type { CustomFieldDefinition, CustomFieldType, CustomValue, CustomValues } from '@/lib/crm/types';
import type { FieldDef, FieldInput } from '@/lib/types';

// A company's custom institute fields (entity "account"), rendered with the shared DynamicField
// controls. Dates get a native date input, which FieldDef has no type for.

const INPUTS: Record<Exclude<CustomFieldType, 'date'>, FieldInput> = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  select: 'select',
  multiselect: 'multiselect',
  boolean: 'boolean',
  phone: 'tel',
  email: 'email',
  url: 'url',
};

function fieldDef(definition: CustomFieldDefinition): FieldDef {
  return {
    key: definition.key,
    label: definition.label,
    input: definition.type === 'date' ? 'text' : INPUTS[definition.type],
    help: definition.help ?? undefined,
    placeholder: definition.type === 'boolean' ? 'Yes' : undefined,
    options: definition.options.map((option) => ({ value: option.value, label: option.label })),
  };
}

/** Values as the API wants them: numbers as numbers, empty answers as null (which clears them). */
export function customValuesForSave(definitions: readonly CustomFieldDefinition[], values: CustomValues): CustomValues {
  const out: CustomValues = {};
  for (const definition of definitions) {
    const value = values[definition.key];
    if (value === undefined) continue;
    if (value === '') {
      out[definition.key] = null;
    } else if (definition.type === 'number' && typeof value === 'string') {
      const number = Number(value);
      out[definition.key] = Number.isFinite(number) ? number : value;
    } else {
      out[definition.key] = value;
    }
  }
  return out;
}

function asCustomValue(value: unknown): CustomValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map(String);
  return null;
}

export function CustomFieldInputs({
  definitions,
  values,
  onChange,
  errors,
  disabled = false,
}: {
  definitions: readonly CustomFieldDefinition[];
  values: CustomValues;
  onChange: (key: string, value: CustomValue) => void;
  /** Field errors keyed like "custom.renews_on". */
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <>
      {definitions.map((definition) => {
        const field = fieldDef(definition);
        const value = values[definition.key] ?? null;
        const error = errors[`custom.${definition.key}`];
        const change = (next: unknown) => onChange(definition.key, asCustomValue(next));
        if (definition.type === 'multiselect' || definition.type === 'boolean') {
          return (
            <FieldGroup key={definition.id} label={definition.label} hint={definition.help ?? undefined} error={error}>
              <FieldControl field={field} value={value} onChange={change} disabled={disabled} />
            </FieldGroup>
          );
        }
        return (
          <Field key={definition.id} label={definition.label} hint={definition.help ?? undefined} error={error} optional={!definition.required}>
            {(control) =>
              definition.type === 'date' ? (
                <input
                  {...control}
                  type="date"
                  className="input"
                  value={typeof value === 'string' ? value : ''}
                  disabled={disabled}
                  onChange={(event) => change(event.target.value)}
                />
              ) : (
                <FieldControl field={field} value={value} onChange={change} disabled={disabled} control={control} allowEmpty={!definition.required} />
              )
            }
          </Field>
        );
      })}
    </>
  );
}
