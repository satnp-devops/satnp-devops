'use client';

import { useState } from 'react';
import { OrderButtons, errorFor } from '@/components/config/controls';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { FIELD_TYPE_LABELS, KEY_PATTERN, isChoiceType, moveItem, toKey } from '@/lib/config/format';
import { useConfigMutation } from '@/lib/config/queries';
import type {
  CustomFieldCreateInput,
  CustomFieldDefinition,
  CustomFieldEntity,
  CustomFieldOption,
  CustomFieldPatchInput,
  CustomFieldType,
  DealKind,
} from '@/lib/crm/types';
import { ENTITY_SINGULAR } from './entities';
import { FieldPreview } from './FieldPreview';

const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as CustomFieldType[];
const isFieldType = (value: string): value is CustomFieldType => FIELD_TYPES.some((type) => type === value);
const MAX_OPTIONS = 100;

/** An option being edited. Saved options keep their value: stored records refer to it. */
interface DraftOption {
  id: number;
  value: string;
  label: string;
  /** The value was typed by hand (so it no longer follows the label). */
  valueEdited: boolean;
  saved: boolean;
}

let nextOptionId = 1;
const draftOf = (option: CustomFieldOption): DraftOption => ({ id: nextOptionId++, ...option, valueEdited: true, saved: true });

/** Add a custom field to a record type, or edit one (its key and record type are fixed). */
export function FieldDialog({
  company,
  entity,
  field,
  onClose,
}: {
  company: ConfigCompany;
  entity: CustomFieldEntity;
  field: CustomFieldDefinition | 'new' | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={field !== null}
      onClose={onClose}
      size="lg"
      title={field === 'new' ? `Add a ${ENTITY_SINGULAR[entity]} field` : field ? `Edit ${field.label}` : ''}
    >
      {field ? <FieldForm company={company} entity={entity} field={field === 'new' ? null : field} onClose={onClose} /> : null}
    </Dialog>
  );
}

function FieldForm({
  company,
  entity,
  field,
  onClose,
}: {
  company: ConfigCompany;
  entity: CustomFieldEntity;
  field: CustomFieldDefinition | null;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(field?.label ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [keyEdited, setKeyEdited] = useState(false);
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text');
  const [options, setOptions] = useState<DraftOption[]>(() => (field?.options ?? []).map(draftOf));
  const [required, setRequired] = useState(field?.required ?? false);
  const [appliesTo, setAppliesTo] = useState<DealKind | ''>(field?.appliesTo ?? '');
  const [help, setHelp] = useState(field?.help ?? '');
  const [previewValue, setPreviewValue] = useState<unknown>(null);

  const choice = isChoiceType(type);
  const sentOptions: CustomFieldOption[] = choice ? options.map((option) => ({ value: option.value, label: option.label.trim() })) : [];

  const save = useConfigMutation(
    () => {
      const shared = {
        label,
        options: sentOptions,
        required,
        help: help.trim() || null,
        ...(entity === 'deal' ? { appliesTo: appliesTo || null } : {}),
      };
      if (field) {
        const body: CustomFieldPatchInput = { ...shared, ...(type !== field.type ? { type } : {}) };
        return api.patch<CustomFieldDefinition>(`/custom-fields/${field.id}`, body);
      }
      const body: CustomFieldCreateInput = { ...shared, companyId: company.unit.id, entity, key, type };
      return api.post<CustomFieldDefinition>('/custom-fields', body);
    },
    { onSuccess: onClose },
  );
  const errors = fieldErrorsOf(save.error);
  const shown = ['label', 'key', 'type', 'required', 'appliesTo', 'help', ...Object.keys(errors).filter((path) => path.startsWith('options'))];
  const keyProblem = !field && key !== '' && !KEY_PATTERN.test(key) ? 'Lowercase letters, digits and underscores, starting with a letter' : undefined;

  const changeLabel = (text: string) => {
    setLabel(text);
    if (!field && !keyEdited) setKey(toKey(text));
  };
  const changeOption = (id: number, patch: Partial<Pick<DraftOption, 'label' | 'value'>>) =>
    setOptions((list) =>
      list.map((option) => {
        if (option.id !== id) return option;
        if (patch.value !== undefined) return { ...option, value: patch.value, valueEdited: true };
        const text = patch.label ?? option.label;
        return { ...option, label: text, value: option.valueEdited ? option.value : toKey(text) };
      }),
    );
  const optionError = (index: number) => errorFor(errors, `options.${index}`);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(undefined);
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, shown)} />
        <div className="form-grid">
          <Field label="Label" error={errors.label}>
            {(control) => (
              <input {...control} className="input" value={label} maxLength={80} required onChange={(event) => changeLabel(event.target.value)} />
            )}
          </Field>
          {field ? (
            <Field label="Key" hint="Imports, automations and the API use the key. It can't change.">
              {(control) => <input {...control} className="input mono" value={field.key} readOnly />}
            </Field>
          ) : (
            <Field label="Key" hint="Imports, automations and the API use the key. It can't change later." error={errors.key ?? keyProblem}>
              {(control) => (
                <input
                  {...control}
                  className="input mono"
                  value={key}
                  maxLength={40}
                  required
                  spellCheck={false}
                  onChange={(event) => {
                    setKeyEdited(true);
                    setKey(event.target.value.trim().toLowerCase());
                  }}
                />
              )}
            </Field>
          )}
          <Field
            label="Type"
            hint={field ? 'The type can only change while no record has a value for this field.' : undefined}
            error={errors.type}
          >
            {(control) => (
              <select
                {...control}
                className="select"
                value={type}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!isFieldType(next)) return;
                  setType(next);
                  setPreviewValue(null);
                  if (isChoiceType(next) && options.length === 0) {
                    setOptions([{ id: nextOptionId++, value: '', label: '', valueEdited: false, saved: false }]);
                  }
                }}
              >
                {FIELD_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {FIELD_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {entity === 'deal' ? (
            <Field label="Used on" error={errors.appliesTo}>
              {(control) => (
                <select
                  {...control}
                  className="select"
                  value={appliesTo}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '' || value === 'b2c' || value === 'b2b') setAppliesTo(value);
                  }}
                >
                  <option value="">Every deal</option>
                  <option value="b2c">B2C deals (families)</option>
                  <option value="b2b">B2B deals (institutes)</option>
                </select>
              )}
            </Field>
          ) : null}
        </div>

        {choice ? (
          <fieldset className="field field--group">
            <legend className="field__label">Options</legend>
            <ol className="config-draft">
              {options.map((option, index) => (
                <li key={option.id}>
                  <div className="config-draft__row">
                    <OrderButtons
                      label={option.label || `option ${index + 1}`}
                      index={index}
                      count={options.length}
                      onMove={(delta) => setOptions(moveItem(options, index, delta))}
                    />
                    <input
                      className="input grow"
                      aria-label={`Option ${index + 1} label`}
                      value={option.label}
                      maxLength={80}
                      required
                      onChange={(event) => changeOption(option.id, { label: event.target.value })}
                    />
                    <input
                      className="input mono fields-option__value"
                      aria-label={`Option ${index + 1} stored value`}
                      title={option.saved ? 'Saved records use this value, so it is fixed' : 'Stored value'}
                      value={option.value}
                      maxLength={40}
                      required
                      readOnly={option.saved}
                      spellCheck={false}
                      onChange={(event) => changeOption(option.id, { value: event.target.value.trim().toLowerCase() })}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon="trash"
                      aria-label={`Remove option ${option.label || index + 1}`}
                      disabled={options.length <= 1}
                      onClick={() => setOptions(options.filter((o) => o.id !== option.id))}
                    />
                  </div>
                  {optionError(index) ? <p className="config-draft__error">{optionError(index)}</p> : null}
                </li>
              ))}
            </ol>
            <div className="row gap-8">
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                disabled={options.length >= MAX_OPTIONS}
                onClick={() => setOptions([...options, { id: nextOptionId++, value: '', label: '', valueEdited: false, saved: false }])}
              >
                Add an option
              </Button>
            </div>
            <p className="field__hint">
              The grey value is what records store. Removing an option keeps it on records that already have it.
            </p>
            {errors.options ? <p className="field__error">{errors.options}</p> : null}
          </fieldset>
        ) : null}

        <Field label="Help text" optional hint="Shown under the field on forms." error={errors.help}>
          {(control) => (
            <input {...control} className="input" value={help} maxLength={300} onChange={(event) => setHelp(event.target.value)} />
          )}
        </Field>
        <label className="check">
          <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
          <span>People must fill this in when they save a {ENTITY_SINGULAR[entity]}</span>
        </label>

        <div className="config-preview">
          <p className="config-preview__label">Preview</p>
          <FieldPreview
            definition={{ key, label, type, options: sentOptions, required, help }}
            value={previewValue}
            onChange={setPreviewValue}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={Boolean(keyProblem)}>
          {field ? 'Save' : 'Add field'}
        </Button>
      </DialogFooter>
    </form>
  );
}
