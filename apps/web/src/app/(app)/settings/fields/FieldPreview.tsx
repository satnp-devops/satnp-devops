'use client';

import { DynamicField } from '@/components/DynamicField';
import { Field } from '@/components/ui';
import { FIELD_INPUTS } from '@/lib/config/format';
import type { CustomFieldOption, CustomFieldType } from '@/lib/crm/types';
import type { FieldDef } from '@/lib/types';

/** What a preview needs of a definition (a saved one, or the draft in the editor). */
export interface PreviewDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  options: readonly CustomFieldOption[];
  required: boolean;
  help: string | null;
}

/**
 * One custom field drawn the way deal, contact and institute forms draw it (DynamicField; dates use
 * a native date input). The value is local: nothing is saved.
 */
export function FieldPreview({
  definition,
  value,
  onChange,
}: {
  definition: PreviewDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = `${definition.label.trim() || 'Untitled field'}${definition.required ? ' (required)' : ''}`;
  const help = definition.help?.trim() || undefined;

  if (definition.type === 'date') {
    return (
      <Field label={label} hint={help}>
        {(control) => (
          <input
            {...control}
            type="date"
            className="input"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
    );
  }

  const field: FieldDef = {
    key: definition.key || 'preview',
    label,
    input: FIELD_INPUTS[definition.type],
    options: definition.options.map((option) => ({ value: option.value, label: option.label || option.value })),
    ...(help ? { help } : {}),
    ...(definition.type === 'boolean' ? { placeholder: 'Yes' } : {}),
  };
  return <DynamicField field={field} value={value} onChange={onChange} />;
}
