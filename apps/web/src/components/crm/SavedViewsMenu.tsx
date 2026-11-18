'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { Icon } from '../icons';
import { Button } from '../ui';
import { Popover } from './Popover';
import './crm.css';

/** A saved set of filters and sort. Personal views belong to one person; shared views to the team. */
export interface SavedView {
  id: string;
  name: string;
  shared: boolean;
  /** Built-in views ("All leads", "My leads") can't be renamed or deleted. */
  builtIn?: boolean;
  /** Whether the viewer may rename or delete it (their own views; shared ones for managers). */
  canEdit?: boolean;
}

/** Callbacks may return a promise: the menu waits for it and shows its error if it fails. */
type Action = void | Promise<unknown>;

type Editing = { mode: 'rename' | 'delete'; id: string } | { mode: 'save' } | null;

export function SavedViewsMenu({
  views,
  currentId,
  onSelect,
  onSave,
  onRename,
  onDelete,
  canShare = false,
  modified = false,
  label = 'Saved views',
}: {
  views: readonly SavedView[];
  currentId: string | null;
  onSelect: (view: SavedView) => void;
  /** Save the current filters as a new view. */
  onSave?: (input: { name: string; shared: boolean }) => Action;
  onRename?: (view: SavedView, name: string) => Action;
  onDelete?: (view: SavedView) => Action;
  /** Offer "Share with my team" when saving (needs the permission to share). */
  canShare?: boolean;
  /** The filters were changed since the view was picked: the trigger says so. */
  modified?: boolean;
  label?: string;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const current = views.find((view) => view.id === currentId);
  const groups: Array<{ title: string; items: SavedView[] }> = [
    { title: 'Standard', items: views.filter((view) => view.builtIn) },
    { title: 'Your views', items: views.filter((view) => !view.builtIn && !view.shared) },
    { title: 'Shared with the team', items: views.filter((view) => !view.builtIn && view.shared) },
  ];

  return (
    <Popover
      label={label}
      placement="bottom-end"
      className="crm-views"
      onOpenChange={(open) => {
        if (!open) setEditing(null);
      }}
      trigger={(trigger) => (
        <Button {...trigger} icon="bookmark">
          <span className="visually-hidden">{label}: </span>
          <span className="crm-views__trigger-name">{current?.name ?? 'Views'}</span>
          {modified ? <span className="muted small">(edited)</span> : null}
          <Icon name="chevronDown" size={14} />
        </Button>
      )}
    >
      {(close) => (
        <>
          {groups.map((group) =>
            group.items.length === 0 && group.title !== 'Your views' ? null : (
              <section key={group.title} aria-label={group.title}>
                <p className="crm-views__heading" aria-hidden="true">
                  {group.title}
                </p>
                {group.items.length === 0 ? (
                  <p className="crm-views__empty">Save filters you use often to find them here.</p>
                ) : (
                  <ul className="crm-views__list">
                    {group.items.map((view) => (
                      <li key={view.id}>
                        {editing && editing.mode !== 'save' && editing.id === view.id ? (
                          editing.mode === 'rename' ? (
                            <NameForm
                              initial={view.name}
                              submitLabel="Rename"
                              onCancel={() => setEditing(null)}
                              onSubmit={async (name) => {
                                await onRename?.(view, name);
                                setEditing(null);
                              }}
                            />
                          ) : (
                            <ConfirmDelete
                              name={view.name}
                              onCancel={() => setEditing(null)}
                              onConfirm={async () => {
                                await onDelete?.(view);
                                setEditing(null);
                              }}
                            />
                          )
                        ) : (
                          <div className="crm-views__row">
                            <button
                              type="button"
                              className="crm-views__pick"
                              aria-current={view.id === currentId ? 'true' : undefined}
                              onClick={() => {
                                close();
                                onSelect(view);
                              }}
                            >
                              <Icon
                                name="check"
                                size={16}
                                className={view.id === currentId ? 'crm-views__tick' : 'crm-views__tick crm-views__tick--off'}
                              />
                              <span className="crm-views__name">{view.name}</span>
                              {view.shared && !view.builtIn ? <Icon name="users" size={14} className="muted" /> : null}
                            </button>
                            {view.canEdit && !view.builtIn && onRename ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                icon="edit"
                                aria-label={`Rename ${view.name}`}
                                onClick={() => setEditing({ mode: 'rename', id: view.id })}
                              />
                            ) : null}
                            {view.canEdit && !view.builtIn && onDelete ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                icon="trash"
                                aria-label={`Delete ${view.name}`}
                                onClick={() => setEditing({ mode: 'delete', id: view.id })}
                              />
                            ) : null}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ),
          )}
          {onSave ? (
            <div className="crm-views__footer">
              {editing?.mode === 'save' ? (
                <NameForm
                  initial=""
                  submitLabel="Save view"
                  canShare={canShare}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (name, shared) => {
                    await onSave({ name, shared });
                    setEditing(null);
                    close();
                  }}
                />
              ) : (
                <Button size="sm" variant="ghost" icon="plus" block onClick={() => setEditing({ mode: 'save' })}>
                  Save current view
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}
    </Popover>
  );
}

/** A small inline form for naming a view. Escape cancels it without closing the menu. */
function NameForm({
  initial,
  submitLabel,
  canShare = false,
  onSubmit,
  onCancel,
}: {
  initial: string;
  submitLabel: string;
  canShare?: boolean;
  onSubmit: (name: string, shared: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [shared, setShared] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the view a name.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(trimmed, shared);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <form
      className="crm-views__edit"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="visually-hidden" htmlFor={id}>
        View name
      </label>
      <input
        id={id}
        className="input"
        value={name}
        maxLength={80}
        placeholder="View name"
        // The person just asked to type a name.
        autoFocus
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      {canShare ? (
        <label className="check">
          <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
          <span>Share with my team</span>
        </label>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="crm-views__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="crm-views__buttons">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ConfirmDelete({ name, onConfirm, onCancel }: { name: string; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  return (
    <div
      className="crm-views__edit"
      role="group"
      aria-label={`Delete ${name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="crm-views__question">
        Delete <strong>{name}</strong>? Anyone using it goes back to the standard view.
      </p>
      {error ? (
        <p className="crm-views__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="crm-views__buttons">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={pending}
          // Focus moves to the choice just offered.
          autoFocus
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await onConfirm();
            } catch (caught) {
              setError(errorMessage(caught));
              setPending(false);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
