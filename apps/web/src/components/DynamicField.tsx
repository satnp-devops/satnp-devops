'use client';

import type { FieldDef, FieldOption } from '@/lib/types';
import { Field, FieldGroup, type ControlProps } from './ui';

// Renders form controls from field definitions sent by the API (unit profiles, settings),
// so a module can add a field or a whole new unit type without frontend changes.

const asText = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const asList = (value: unknown): Array<string | number> =>
  Array.isArray(value) ? value.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number') : [];

function optionFor(options: readonly FieldOption[], raw: string): FieldOption | undefined {
  return options.find((option) => String(option.value) === raw);
}

const TEXT_TYPES: Partial<Record<FieldDef['input'], string>> = {
  text: 'text',
  email: 'email',
  url: 'url',
  tel: 'tel',
  time: 'time',
  number: 'number',
};

/** Just the control, for callers that lay out their own label. */
export function FieldControl({
  field,
  value,
  onChange,
  disabled = false,
  control,
  allowEmpty = true,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  control?: ControlProps;
  /** Offer a "Not set" choice in selects. */
  allowEmpty?: boolean;
}) {
  const options = field.options ?? [];

  switch (field.input) {
    case 'textarea':
      return (
        <textarea
          {...control}
          className="textarea"
          value={asText(value)}
          placeholder={field.placeholder}
          disabled={disabled}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'select':
      return (
        <select
          {...control}
          className="select"
          value={asText(value)}
          disabled={disabled}
          onChange={(event) => onChange(optionFor(options, event.target.value)?.value ?? '')}
        >
          {allowEmpty || asText(value) === '' ? <option value="">{allowEmpty ? 'Not set' : 'Choose…'}</option> : null}
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      );

    case 'multiselect': {
      const selected = asList(value);
      return (
        <div className="row gap-8" role="group" aria-describedby={control?.['aria-describedby']}>
          {options.map((option) => {
            const checked = selected.some((item) => String(item) === String(option.value));
            return (
              <label key={String(option.value)} className="chip-toggle">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((item) => String(item) !== String(option.value));
                    // Keep the order the options are listed in.
                    onChange(options.map((o) => o.value).filter((v) => next.some((item) => String(item) === String(v))));
                  }}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      );
    }

    case 'boolean':
      return (
        <label className="check">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            aria-describedby={control?.['aria-describedby']}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{field.placeholder ?? 'On'}</span>
        </label>
      );

    case 'color': {
      const text = asText(value);
      const valid = /^#[0-9a-fA-F]{6}$/.test(text);
      return (
        <div className="row gap-8">
          <input
            type="color"
            className="input input--color"
            value={valid ? text.toLowerCase() : '#000000'}
            disabled={disabled}
            aria-label={`${field.label} picker`}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
          />
          <input
            {...control}
            className="input input--hex mono"
            value={text}
            placeholder={field.placeholder ?? '#2840D8'}
            maxLength={7}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value.trim())}
          />
        </div>
      );
    }

    default:
      return (
        <input
          {...control}
          type={TEXT_TYPES[field.input] ?? 'text'}
          className="input"
          value={asText(value)}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** A labelled control for a field definition. */
export function DynamicField({
  field,
  value,
  onChange,
  error,
  disabled,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string | undefined;
  disabled?: boolean;
}) {
  if (field.input === 'multiselect' || field.input === 'boolean') {
    return (
      <FieldGroup label={field.label} hint={field.help} error={error}>
        <FieldControl field={field} value={value} onChange={onChange} disabled={disabled} />
      </FieldGroup>
    );
  }
  return (
    <Field label={field.label} hint={field.help} error={error}>
      {(control) => <FieldControl field={field} value={value} onChange={onChange} disabled={disabled} control={control} />}
    </Field>
  );
}
