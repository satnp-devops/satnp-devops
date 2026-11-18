'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import type { Person } from '@/lib/types';
import { Icon } from '../icons';
import { Avatar, cx, type ControlProps } from '../ui';
import { useAnchoredPanel } from './Popover';
import './crm.css';

/** The person a picker holds. A Person from the API fits, and so does an owner embedded in a record. */
export interface PickedUser {
  id: string;
  name: string;
  email?: string;
}

/** Cache keys sit under 'people', so anything that refreshes the people list refreshes pickers too. */
export const userPickerKey = (unitId: string, q: string) => ['people', 'picker', unitId, q] as const;

/**
 * Pick one active person who works in a unit (or anywhere under it), searching by name or email
 * as you type. Uses GET /users?unitId&q, so it needs users.view at that unit: without it the
 * list says so instead of failing. Works inside a <Field> (pass its control props) or on its own
 * with `aria-label`.
 */
export function UserPicker({
  unitId,
  value,
  onChange,
  placeholder = 'Search by name or email',
  disabled = false,
  clearable = true,
  excludeIds,
  control,
  'aria-label': ariaLabel,
}: {
  unitId: string;
  value: PickedUser | null;
  onChange: (user: PickedUser | null) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  /** People who can't be picked here (e.g. already on the deal). */
  excludeIds?: readonly string[];
  control?: ControlProps;
  'aria-label'?: string;
}) {
  const listId = useId();
  const fallbackId = useId();
  const inputId = control?.id ?? fallbackId;
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), 250);

  const people = useQuery({
    queryKey: userPickerKey(unitId, q),
    queryFn: () => api.page<Person>('/users', { unitId, q, status: 'active', limit: 20 }),
    enabled: open && unitId !== '',
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const options = (people.data?.data ?? []).filter((person) => !excludeIds?.includes(person.id));
  const activeIndex = Math.min(active, options.length - 1);

  // Show the list before it's placed (placing measures it), so this runs first.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const shown = panel.matches(':popover-open');
    if (open && !shown) panel.showPopover();
    if (!open && shown) {
      panel.hidePopover();
      delete panel.dataset.placed;
    }
  }, [open]);
  useAnchoredPanel(open, anchorRef, panelRef, 'bottom-start', true);

  // Keep the highlighted option in view while moving through the list with the arrow keys.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  function openList() {
    if (disabled) return;
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditing(false);
    setText('');
    setActive(0);
  }

  function pick(person: PickedUser) {
    onChange({ id: person.id, name: person.name, email: person.email });
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) openList();
        else setActive(Math.min(activeIndex + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) setActive(Math.max(activeIndex - 1, 0));
        break;
      case 'Enter': {
        const option = options[activeIndex];
        if (open && option) {
          event.preventDefault();
          pick(option);
        }
        break;
      }
      case 'Escape':
        if (open || editing) {
          // Handled here, so a surrounding dialog or panel stays open.
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        break;
      default:
    }
  }

  const forbidden = isApiError(people.error) && (people.error.status === 403 || people.error.status === 404);
  let status = '';
  if (open) {
    if (people.isPending) status = 'Searching…';
    else if (forbidden) status = "You can't look up people here.";
    else if (people.isError) status = "Couldn't load people. Try again.";
    else if (options.length === 0) status = q ? `No one matches “${q}”.` : 'No one to choose here.';
  }
  const activeOption = open ? options[activeIndex] : undefined;

  return (
    <div ref={anchorRef} className="crm-picker">
      <span className="crm-picker__lead" aria-hidden="true">
        {value && !editing ? <Avatar name={value.name} size={22} /> : <Icon name="search" size={16} />}
      </span>
      <input
        id={inputId}
        type="text"
        role="combobox"
        className="input crm-picker__input"
        aria-label={control ? undefined : ariaLabel}
        aria-invalid={control?.['aria-invalid']}
        aria-describedby={control?.['aria-describedby']}
        aria-expanded={open}
        aria-controls={`${listId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={value ? undefined : placeholder}
        disabled={disabled}
        value={editing ? text : (value?.name ?? '')}
        onChange={(event) => {
          setText(event.target.value);
          setEditing(true);
          setActive(0);
          openList();
        }}
        onClick={openList}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      {value && clearable && !disabled ? (
        <button
          type="button"
          className="crm-picker__clear"
          aria-label={`Clear ${value.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange(null);
            close();
          }}
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}

      <div ref={panelRef} popover="manual" className="crm-pop crm-picker__list">
        <div id={`${listId}-list`} role="listbox" aria-label="People" className="crm-picker__options">
          {options.map((person, index) => (
            <div
              key={person.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cx('crm-option', index === activeIndex && 'crm-option--active')}
              // Keep focus in the input, so choosing doesn't blur and close the list first.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => pick(person)}
            >
              <Avatar name={person.name} size={28} />
              <span className="crm-option__text">
                <span className="crm-option__name">{person.name}</span>
                <span className="crm-option__email">{person.email}</span>
              </span>
              {value?.id === person.id ? <Icon name="check" size={16} className="crm-option__tick" /> : null}
            </div>
          ))}
        </div>
        <p className="crm-picker__status" role="status">
          {status}
        </p>
      </div>
    </div>
  );
}
