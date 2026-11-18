'use client';

import { useId, type ReactNode } from 'react';
import { Button, cx } from '@/components/ui';
import './config.css';

// Small controls shared by the configuration screens.

/** Up and down buttons for keyboard-friendly reordering. */
export function OrderButtons({
  label,
  index,
  count,
  disabled = false,
  onMove,
}: {
  /** What is being moved, for the buttons' accessible names: "Demo booked". */
  label: string;
  index: number;
  count: number;
  disabled?: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  return (
    <div className="config-order">
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="arrowUp"
        aria-label={`Move ${label} up`}
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
      />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="arrowDown"
        aria-label={`Move ${label} down`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
      />
    </div>
  );
}

/** An on/off switch (a checkbox with role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  hideLabel = false,
  disabled = false,
  accessibleLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
  /** A fuller name for screen readers when the visible label is generic ("Active: Fee too high"). */
  accessibleLabel?: string;
}) {
  return (
    <label className={cx('config-switch', disabled && 'config-switch--disabled')}>
      <input
        type="checkbox"
        role="switch"
        aria-label={accessibleLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="config-switch__track" aria-hidden="true">
        <span className="config-switch__thumb" />
      </span>
      <span className={hideLabel ? 'visually-hidden' : 'config-switch__label'}>{label}</span>
    </label>
  );
}

/** A row of toggle buttons where exactly one is pressed (entity tabs, kind filters). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="config-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="config-segmented__item"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Checkbox chips for picking several items from a list. */
export function ChipChecklist({
  label,
  hint,
  error,
  options,
  value,
  onChange,
  disabled = false,
  empty,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  /** Shown when there is nothing to pick. */
  empty?: ReactNode;
}) {
  const hintId = useId();
  return (
    <fieldset className="field field--group">
      <legend className="field__label">{label}</legend>
      {options.length === 0 ? (
        <p className="small muted">{empty ?? 'Nothing to pick yet.'}</p>
      ) : (
        <div className="row gap-8" aria-describedby={hint ? hintId : undefined}>
          {options.map((option) => (
            <label key={option.value} className="chip-toggle">
              <input
                type="checkbox"
                checked={value.includes(option.value)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? options.map((o) => o.value).filter((v) => v === option.value || value.includes(v))
                      : value.filter((v) => v !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      )}
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? <p className="field__error">{error}</p> : null}
    </fieldset>
  );
}

/** A swatch of a stage colour (or the default accent when none is set). */
export function ColourDot({ colour }: { colour: string | null }) {
  return <span className="config-dot" style={{ background: colour ?? 'var(--line-strong)' }} aria-hidden="true" />;
}

/** The first field error whose path starts with one of the prefixes ("requiredFields.1" → "requiredFields"). */
export function errorFor(fieldErrors: Record<string, string>, ...prefixes: string[]): string | undefined {
  for (const [path, message] of Object.entries(fieldErrors)) {
    if (prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) return message;
  }
  return undefined;
}
