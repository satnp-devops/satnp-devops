'use client';

import { useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react';
import { formatCount } from '@/lib/crm/format';
import { Icon, type IconName } from '../icons';
import { Button, cx } from '../ui';
import { Popover } from './Popover';
import './crm.css';

// ---------- Search ----------

/**
 * A search box that reports its text (trimmed) once typing pauses. Enter searches at once,
 * Escape clears. If the parent changes `value` (Clear all, a saved view), the box follows.
 */
export function SearchInput({
  value,
  onChange,
  label = 'Search',
  placeholder = 'Search',
  delay = 300,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  delay?: number;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    // Adopt a value set from outside, but not our own text coming back trimmed
    // (that would eat the space someone just typed between two words).
    setSynced(value);
    if (value !== text.trim()) setText(value);
  }

  const report = useEffectEvent((next: string) => onChange(next));
  useEffect(() => {
    const next = text.trim();
    if (next === value) return undefined;
    const timer = setTimeout(() => report(next), delay);
    return () => clearTimeout(timer);
  }, [text, value, delay]);

  const clear = () => {
    setText('');
    if (value !== '') onChange('');
  };

  return (
    <div className={cx('crm-search', className)}>
      <Icon name="search" size={16} className="crm-search__icon" />
      <input
        type="search"
        className="input crm-search__input"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        enterKeyHint="search"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (text.trim() !== value) onChange(text.trim());
          } else if (event.key === 'Escape' && text !== '') {
            // Clear first; a second Escape can close whatever the box sits in.
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
      />
      {text ? (
        <button type="button" className="crm-search__clear" aria-label="Clear search" onClick={clear}>
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}

// ---------- Chips ----------

export interface ChipOption {
  value: string;
  label: string;
  icon?: IconName;
  /** How many records match, when the server reports it. */
  count?: number;
}

export interface ChipGroupProps {
  /** Names the group for screen readers ("Channel"); shown before the chips with `showLabel`. */
  label: string;
  options: readonly ChipOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  showLabel?: boolean;
}

/** Toggle chips for one filter, e.g. channels. Each chip is a checkbox; a tick shows it's on. */
export function ChipGroup({ label, options, selected, onChange, showLabel = false }: ChipGroupProps) {
  const labelId = useId();
  return (
    <div className="crm-chips" role="group" aria-labelledby={labelId}>
      <span id={labelId} className={showLabel ? 'crm-chips__label' : 'visually-hidden'}>
        {label}
      </span>
      <div className="crm-chips__list">
        {options.map((option) => {
          const checked = selected.includes(option.value);
          const icon = checked ? 'check' : option.icon;
          return (
            <label key={option.value} className="crm-chip">
              <input
                type="checkbox"
                className="crm-chip__input"
                checked={checked}
                onChange={(event) =>
                  onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))
                }
              />
              {icon ? <Icon name={icon} size={14} /> : null}
              <span>{option.label}</span>
              {option.count !== undefined ? <span className="crm-chip__count">{formatCount(option.count)}</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ---------- The bar ----------

export interface FilterBarProps {
  search?: { value: string; onChange: (value: string) => void; label?: string; placeholder?: string };
  chips?: readonly ChipGroupProps[];
  /** Less-used filters in a popover. `activeCount` is how many of them are set. */
  more?: { content: ReactNode; activeCount?: number; label?: string };
  /** Filters set by controls passed as children, so the count and Clear all include them. */
  extraActiveCount?: number;
  /** Resets every filter (search, chips, more and extras). */
  onClear?: () => void;
  /** Right-hand side: saved views, export. */
  end?: ReactNode;
  /** Extra controls after the chips (a date range, a select). */
  children?: ReactNode;
  /** Draw its own border and corners (when it isn't a DataTable's toolbar). */
  framed?: boolean;
  className?: string;
}

/**
 * Search, chip filters, a "More filters" popover, the number of active filters and Clear all.
 * Put it in a DataTable's `toolbar`, or on its own with `framed`.
 */
export function FilterBar({ search, chips = [], more, extraActiveCount = 0, onClear, end, children, framed = false, className }: FilterBarProps) {
  const active =
    (search?.value ? 1 : 0) +
    chips.reduce((total, group) => total + group.selected.length, 0) +
    (more?.activeCount ?? 0) +
    extraActiveCount;
  const moreLabel = more?.label ?? 'More filters';

  return (
    <div className={cx('crm-filters', framed && 'crm-filters--framed', className)}>
      {search ? <SearchInput {...search} /> : null}
      {chips.map((group) => (
        <ChipGroup key={group.label} {...group} />
      ))}
      {children}
      {more ? (
        <Popover
          label={moreLabel}
          trigger={(trigger) => (
            <Button {...trigger} icon="sliders">
              {moreLabel}
              {more.activeCount ? (
                <span className="crm-count">
                  {more.activeCount}
                  <span className="visually-hidden"> set</span>
                </span>
              ) : null}
            </Button>
          )}
        >
          {(close) => (
            <div className="crm-pop__body crm-filters__more">
              {more.content}
              <div className="crm-pop__footer">
                <Button size="sm" variant="primary" onClick={close}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Popover>
      ) : null}
      <div className="crm-filters__end">
        <span className="crm-filters__status" role="status">
          {active > 0 ? `${active} ${active === 1 ? 'filter' : 'filters'}` : ''}
        </span>
        {active > 0 && onClear ? (
          <button type="button" className="link-button crm-filters__clear" onClick={onClear}>
            Clear all
          </button>
        ) : null}
        {end}
      </div>
    </div>
  );
}
