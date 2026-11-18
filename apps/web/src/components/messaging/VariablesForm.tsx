'use client';

import { Field } from '@/components/ui';
import { variableLabel } from '@/lib/messaging/render';

/**
 * One input per template variable. `hint` per variable explains where a prefilled value came from
 * (the person's name, the lead reference...). `errors` are keyed by variable name.
 */
export function VariablesForm({
  variables,
  values,
  onChange,
  hints = {},
  errors = {},
  disabled = false,
  idPrefix,
}: {
  variables: string[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  hints?: Record<string, string>;
  errors?: Record<string, string>;
  disabled?: boolean;
  idPrefix?: string;
}) {
  if (variables.length === 0) return <p className="msg-vars__hint">This template has no variables.</p>;
  return (
    <div className="msg-vars">
      {variables.map((name) => (
        <Field key={name} label={<span>{variableLabel(name)} <span className="mono muted">{`{{${name}}}`}</span></span>} hint={hints[name]} error={errors[name]}>
          {(control) => (
            <input
              {...control}
              name={idPrefix ? `${idPrefix}-${name}` : name}
              className="input"
              value={values[name] ?? ''}
              disabled={disabled}
              maxLength={1024}
              onChange={(e) => onChange(name, e.target.value)}
            />
          )}
        </Field>
      ))}
    </div>
  );
}
