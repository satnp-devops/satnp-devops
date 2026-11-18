'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button, Field, cx } from '@/components/ui';
import type { Json, JsonObject, JsonSchema } from '@/lib/automations/types';

/**
 * A form for params, AI inputs and trigger config, built from the JSON Schema the catalog sends.
 * Text fields accept {{ }} templates; the ƒx switch turns a field into one expression ({ $expr }).
 * Anything the form can't draw (free JSON) gets a JSON box.
 */

type Kind = 'enum' | 'text' | 'longtext' | 'number' | 'boolean' | 'enumList' | 'list' | 'record' | 'json';

const LONG_TEXT = new Set(['description', 'body', 'message', 'purpose', 'facts', 'text', 'notes', 'transcript']);

function enumValues(schema: JsonSchema): Json[] | null {
  if (schema.enum) return schema.enum;
  if (schema.anyOf?.length && schema.anyOf.every((s) => s.const !== undefined)) return schema.anyOf.map((s) => s.const as Json);
  return null;
}

function kindOf(key: string, schema: JsonSchema): Kind {
  if (enumValues(schema)) return 'enum';
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'string') return LONG_TEXT.has(key) || (schema.maxLength ?? 0) > 400 ? 'longtext' : 'text';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return schema.items && enumValues(schema.items) ? 'enumList' : 'list';
  if (type === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object' && !schema.properties) return 'record';
  if (schema.anyOf?.every((s) => s.type === 'string' || s.const !== undefined)) return 'text';
  return 'json';
}

/** dueIn → Due in, teamUnitId → Team unit id, round_robin → Round robin. */
export function labelOf(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isExpr = (value: Json | undefined): value is { $expr: string } =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonObject).$expr === 'string';

export function SchemaForm({
  schema,
  value,
  onChange,
  issues,
  disabled = false,
  allowExpressions = true,
}: {
  schema: JsonSchema | null | undefined;
  value: JsonObject | undefined;
  onChange: (next: JsonObject) => void;
  /** Messages by property name. */
  issues?: Record<string, string>;
  disabled?: boolean;
  allowExpressions?: boolean;
}) {
  const current = value ?? {};
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const set = (key: string, next: Json | undefined) => {
    const copy: JsonObject = { ...current };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  if (Object.keys(properties).length === 0) {
    return <JsonField label="Values" value={current} onChange={(v) => onChange((v ?? {}) as JsonObject)} disabled={disabled} />;
  }
  return (
    <div className="stack gap-12">
      {Object.entries(properties).map(([key, prop]) => (
        <PropertyField
          key={key}
          name={key}
          schema={prop}
          value={current[key]}
          required={required.has(key)}
          error={issues?.[key]}
          onChange={(next) => set(key, next)}
          disabled={disabled}
          allowExpressions={allowExpressions}
        />
      ))}
    </div>
  );
}

function PropertyField({
  name,
  schema,
  value,
  required,
  error,
  onChange,
  disabled,
  allowExpressions,
}: {
  name: string;
  schema: JsonSchema;
  value: Json | undefined;
  required: boolean;
  error?: string;
  onChange: (next: Json | undefined) => void;
  disabled: boolean;
  allowExpressions: boolean;
}) {
  const kind = kindOf(name, schema);
  const exprMode = isExpr(value);
  const label = labelOf(name);
  const defaultHint = schema.default !== undefined ? `Default: ${typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default)}` : undefined;
  const toggle =
    allowExpressions && kind !== 'json' && !disabled ? (
      <button
        type="button"
        className={cx('auto-fx', exprMode && 'is-on')}
        aria-pressed={exprMode}
        title={exprMode ? 'Use a plain value' : 'Use an expression'}
        onClick={() => onChange(exprMode ? undefined : { $expr: '' })}
      >
        ƒx
      </button>
    ) : null;

  const wrap = (node: ReactNode) => (
    <div className="auto-prop">
      {node}
      {toggle}
    </div>
  );

  if (exprMode) {
    return wrap(
      <Field label={label} optional={!required} error={error} hint="An expression, e.g. record.ownerId or trigger.payload.amount.minor">
        {(control) => (
          <input {...control} className="input auto-code" value={(value as { $expr: string }).$expr} disabled={disabled} onChange={(e) => onChange({ $expr: e.target.value })} spellCheck={false} />
        )}
      </Field>
    );
  }

  switch (kind) {
    case 'enum': {
      const options = enumValues(schema) ?? [];
      return wrap(
        <Field label={label} optional={!required} error={error} hint={defaultHint}>
          {(control) => (
            <select
              {...control}
              className="select"
              disabled={disabled}
              value={value === undefined || value === null ? '' : String(value)}
              onChange={(e) => {
                const picked = options.find((o) => String(o) === e.target.value);
                onChange(e.target.value === '' ? undefined : (picked ?? e.target.value));
              }}
            >
              {!required || value === undefined ? <option value="">{schema.default !== undefined ? `Default (${String(schema.default)})` : 'Not set'}</option> : null}
              {options.map((o) => (
                <option key={String(o)} value={String(o)}>
                  {labelOf(String(o))}
                </option>
              ))}
            </select>
          )}
        </Field>
      );
    }
    case 'number':
      return wrap(
        <Field label={label} optional={!required} error={error} hint={defaultHint}>
          {(control) => (
            <input
              {...control}
              className="input"
              type="number"
              disabled={disabled}
              min={schema.minimum}
              max={schema.maximum}
              value={typeof value === 'number' ? value : ''}
              onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            />
          )}
        </Field>
      );
    case 'boolean':
      return (
        <label className="auto-check">
          <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked ? true : undefined)} /> {label}
        </label>
      );
    case 'enumList': {
      const options = enumValues(schema.items ?? {}) ?? [];
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className="auto-fieldset">
          <legend className="field__label">
            {label}
            {!required ? <span className="field__optional"> (optional)</span> : null}
          </legend>
          <div className="auto-chips">
            {options.map((o) => {
              const on = selected.some((s) => s === o);
              return (
                <label key={String(o)} className={cx('auto-chip', on && 'is-on')}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={() => {
                      const next = on ? selected.filter((s) => s !== o) : [...selected, o];
                      onChange(next.length ? next : undefined);
                    }}
                  />
                  {labelOf(String(o))}
                </label>
              );
            })}
          </div>
          {error ? <p className="field__error">{error}</p> : null}
        </fieldset>
      );
    }
    case 'list': {
      const numeric = schema.items?.type === 'integer' || schema.items?.type === 'number';
      return wrap(
        <Field label={label} optional={!required} error={error} hint="Separate items with commas">
          {(control) => (
            <ListInput
              {...control}
              disabled={disabled}
              value={Array.isArray(value) ? value : []}
              onChange={(items) => onChange(items.length ? (numeric ? items.map(Number).filter((n) => !Number.isNaN(n)) : items) : undefined)}
            />
          )}
        </Field>
      );
    }
    case 'record':
      return <RecordField label={label} required={required} error={error} value={value} onChange={onChange} disabled={disabled} />;
    case 'longtext':
    case 'text':
      return wrap(
        <Field label={label} optional={!required} error={error} hint={defaultHint ?? (schema.format === 'uuid' ? 'An id' : undefined)}>
          {(control) =>
            kind === 'longtext' ? (
              <textarea {...control} className="textarea" rows={3} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
            ) : (
              <input {...control} className="input" disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
            )
          }
        </Field>
      );
    default:
      return <JsonField label={label} required={required} error={error} value={value} onChange={onChange} disabled={disabled} />;
  }
}

function ListInput({ value, onChange, ...rest }: { value: Json[]; onChange: (items: string[]) => void; id: string; disabled?: boolean }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value.join('\u0000')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      {...rest}
      className="input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Key → text rows (template variables, headers, approval data). */
export function RecordField({
  label,
  required = false,
  error,
  value,
  onChange,
  disabled = false,
  keyLabel = 'Name',
  valueLabel = 'Value',
}: {
  label: string;
  required?: boolean;
  error?: string;
  value: Json | undefined;
  onChange: (next: Json | undefined) => void;
  disabled?: boolean;
  keyLabel?: string;
  valueLabel?: string;
}) {
  const id = useId();
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as JsonObject) : [];
  const write = (rows: [string, Json][]) => {
    const obj: JsonObject = {};
    for (const [k, v] of rows) if (k) obj[k] = v;
    onChange(rows.length ? obj : undefined);
  };
  const show = (v: Json) => (typeof v === 'string' ? v : isExpr(v) ? `{{ ${v.$expr} }}` : JSON.stringify(v));
  return (
    <fieldset className="auto-fieldset">
      <legend className="field__label">
        {label}
        {!required ? <span className="field__optional"> (optional)</span> : null}
      </legend>
      {entries.length === 0 ? <p className="small muted">None yet.</p> : null}
      {entries.map(([k, v], i) => (
        <div key={i} className="auto-kv">
          <input
            className="input auto-code"
            aria-label={`${keyLabel} ${i + 1}`}
            id={`${id}-k${i}`}
            value={k}
            disabled={disabled}
            onChange={(e) => write(entries.map(([ek, ev], j) => (j === i ? [e.target.value.replace(/[^A-Za-z0-9_-]/g, ''), ev] : [ek, ev])))}
          />
          <input
            className="input"
            aria-label={`${valueLabel} ${i + 1}`}
            value={show(v)}
            disabled={disabled}
            onChange={(e) => write(entries.map(([ek, ev], j) => (j === i ? [ek, e.target.value] : [ek, ev])))}
          />
          {!disabled ? (
            <Button size="sm" variant="ghost" iconOnly icon="x" aria-label={`Remove ${k || 'row'}`} onClick={() => write(entries.filter((_, j) => j !== i))} />
          ) : null}
        </div>
      ))}
      {!disabled ? (
        <Button size="sm" icon="plus" onClick={() => write([...entries, [`field_${entries.length + 1}`, '']])}>
          Add
        </Button>
      ) : null}
      {error ? <p className="field__error">{error}</p> : null}
    </fieldset>
  );
}

/** Free JSON, parsed when the field loses focus. */
export function JsonField({
  label,
  required = false,
  error,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  required?: boolean;
  error?: string;
  value: Json | undefined;
  onChange: (next: Json | undefined) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const serialised = value === undefined ? '' : JSON.stringify(value, null, 2);
  useEffect(() => {
    setText(serialised);
    setParseError(null);
  }, [serialised]);
  return (
    <Field label={label} optional={!required} error={parseError ?? error} hint="JSON. Text inside may use {{ }} templates.">
      {(control) => (
        <textarea
          {...control}
          className="textarea auto-code"
          rows={4}
          spellCheck={false}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text.trim() === '') {
              setParseError(null);
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(text) as Json);
              setParseError(null);
            } catch {
              setParseError("That isn't valid JSON");
            }
          }}
        />
      )}
    </Field>
  );
}
