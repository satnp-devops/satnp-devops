'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Kbd } from '@/components/crm';
import { Icon } from '@/components/icons';
import { Button, Spinner, cx } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import type { SearchHit } from '@/lib/crm/types';
import { useDebounced } from '@/lib/hooks';
import { filterActions, quickActions, type QuickAction } from '@/lib/search/actions';
import { MAX_QUERY_LENGTH, SEARCH_GROUPS, hitHref, searchableQuery, useSearch } from '@/lib/search/api';
import { resultsSummary } from '@/lib/search/format';
import { clearRecent, readRecent, rememberSearch } from '@/lib/search/recent';
import { useSession } from '@/lib/session';
import { SearchHitContent } from './SearchHitContent';
import { OPEN_SEARCH_EVENT, isTypingTarget, type OpenSearchDetail } from './open';
import './search.css';

// Global search (docs/crm/PHASE2_CONTRACT.md §9.10, §15.2). Mounted once in the signed-in layout;
// renders nothing until opened with Ctrl/Cmd+K, "/" (outside a text field) or openSearch().
// Accessibility: a modal <dialog>, and inside it the combobox + listbox pattern — focus stays in
// the input, aria-activedescendant points at the highlighted option, options are grouped.

const PER_TYPE = 5;
const DEBOUNCE_MS = 200;
const ACTIONS_WHILE_SEARCHING = 4;

type PaletteOption =
  | { kind: 'hit'; id: string; hit: SearchHit }
  | { kind: 'recent'; id: string; query: string }
  | { kind: 'clear-recent'; id: string }
  | { kind: 'action'; id: string; action: QuickAction }
  | { kind: 'all'; id: string; query: string };

interface PaletteSection {
  id: string;
  label: string;
  options: PaletteOption[];
}

export function CommandPalette() {
  // null while closed; `opened` remounts the dialog so each opening starts fresh.
  const [open, setOpen] = useState<{ query: string; opened: number } | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.altKey) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.shiftKey && (event.key.toLowerCase() === 'k' || event.code === 'KeyK')) {
        event.preventDefault();
        setOpen((current) => (current ? null : { query: '', opened: Date.now() }));
        return;
      }
      // "/" belongs to fields, and to other dialogs while they're open.
      if (event.key === '/' && !mod && !isTypingTarget(event.target) && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        setOpen({ query: '', opened: Date.now() });
      }
    }
    function onOpen(event: Event) {
      const detail = event instanceof CustomEvent ? (event.detail as OpenSearchDetail | null) : null;
      setOpen({ query: detail?.query ?? '', opened: Date.now() });
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return <PaletteDialog key={open.opened} initialQuery={open.query} onClose={() => setOpen(null)} />;
}

function PaletteDialog({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const session = useSession();
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const userId = session.user.id;

  const [input, setInput] = useState(initialQuery);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecent(userId));

  const typed = searchableQuery(input);
  const q = searchableQuery(useDebounced(input, DEBOUNCE_MS));
  const search = useSearch(session.scope.id, q, { limit: PER_TYPE });
  const actions = useMemo(() => quickActions(session), [session]);
  // Results on screen that are not (yet) for what's typed: shown dimmed, not selectable.
  const stale = typed !== null && (typed !== q || search.isPlaceholderData);
  const showCompany = session.scope.type === 'group';

  // Open as a modal; on close, focus goes back where it was.
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      if (dialog?.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const sections = useMemo<PaletteSection[]>(() => {
    const out: PaletteSection[] = [];
    const optionId = (kind: string, key: string | number) => `${baseId}-${kind}-${String(key).replace(/[^\w-]/g, '-')}`;
    const toAction = (action: QuickAction): PaletteOption => ({ kind: 'action', id: optionId('action', action.id), action });
    if (typed === null) {
      if (input.trim() === '' && recent.length > 0) {
        out.push({
          id: 'recent',
          label: 'Recent searches',
          options: [
            ...recent.map((query, index): PaletteOption => ({ kind: 'recent', id: optionId('recent', index), query })),
            { kind: 'clear-recent', id: optionId('clear', 'recent') },
          ],
        });
      }
      const matching = filterActions(actions, input);
      const pages = matching.filter((action) => action.section === 'actions');
      const settings = matching.filter((action) => action.section === 'settings');
      if (pages.length) out.push({ id: 'actions', label: 'Quick actions', options: pages.map(toAction) });
      if (settings.length) out.push({ id: 'settings', label: 'Settings', options: settings.map(toAction) });
      return out;
    }
    for (const group of SEARCH_GROUPS) {
      const hits = search.data?.groups.find((found) => found.type === group.type)?.hits ?? [];
      if (hits.length) {
        out.push({
          id: group.type,
          label: group.label,
          options: hits.map((hit): PaletteOption => ({ kind: 'hit', id: optionId(hit.type, hit.id), hit })),
        });
      }
    }
    const matching = filterActions(actions, input).slice(0, ACTIONS_WHILE_SEARCHING);
    if (matching.length) out.push({ id: 'actions', label: 'Quick actions', options: matching.map(toAction) });
    out.push({ id: 'all', label: 'All results', options: [{ kind: 'all', id: optionId('all', 'results'), query: typed }] });
    return out;
  }, [baseId, typed, input, recent, actions, search.data]);

  const navigable = useMemo(
    () => sections.flatMap((section) => section.options).filter((option) => !(stale && option.kind === 'hit')),
    [sections, stale],
  );
  const active = navigable.find((option) => option.id === activeId) ?? navigable[0] ?? null;

  useEffect(() => {
    if (active) document.getElementById(active.id)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(href: string) {
    onClose();
    router.push(href);
  }

  function run(option: PaletteOption) {
    switch (option.kind) {
      case 'hit':
        setRecent(rememberSearch(userId, input));
        go(hitHref(option.hit));
        return;
      case 'all':
        setRecent(rememberSearch(userId, option.query));
        go(`/search?q=${encodeURIComponent(option.query)}`);
        return;
      case 'action':
        go(option.action.href);
        return;
      case 'recent':
        setInput(option.query);
        setActiveId(null);
        inputRef.current?.focus();
        return;
      case 'clear-recent':
        clearRecent(userId);
        setRecent([]);
        setActiveId(null);
        inputRef.current?.focus();
        return;
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (navigable.length === 0) return;
      const index = active ? navigable.indexOf(active) : -1;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = navigable[(index + step + navigable.length) % navigable.length];
      if (next) setActiveId(next.id);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) run(active);
    }
  }

  const fresh = typed !== null && !stale && search.isSuccess;
  const noHits = fresh && search.data.groups.every((group) => group.hits.length === 0);
  const announcement =
    typed === null
      ? ''
      : search.isError
        ? 'Search failed'
        : fresh
          ? resultsSummary(search.data.groups)
          : 'Searching';

  let status: ReactNode = null;
  if (input.trim().length === 1) {
    status = <p className="search-palette__status">Type one more character to search leads, contacts and accounts.</p>;
  } else if (typed !== null && search.isError && !stale) {
    status = (
      <div className="search-palette__status search-palette__status--error" role="alert">
        <Icon name="alert" size={16} />
        <span>{errorMessage(search.error)}</span>
        <Button size="sm" onClick={() => void search.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (typed !== null && !search.data) {
    status = (
      <p className="search-palette__status">
        <Spinner label="Searching" /> Searching…
      </p>
    );
  } else if (noHits) {
    status = (
      <div className="search-palette__status search-palette__empty">
        <p>
          No leads, contacts or accounts match “{typed}” in {session.scope.name}.
        </p>
        <p className="muted">Try a full phone number, an email address, a lead reference or fewer words.</p>
      </div>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="search-palette"
      aria-label="Search"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="search-palette__panel">
        <div className="search-palette__bar">
          <Icon name="search" size={18} className="search-palette__glass" />
          <input
            ref={inputRef}
            className="search-palette__input"
            type="text"
            role="combobox"
            aria-label="Search leads, contacts and accounts, or jump to a page"
            aria-expanded={navigable.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active?.id}
            placeholder="Name, phone, email or reference"
            value={input}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => {
              setInput(event.target.value);
              setActiveId(null);
            }}
            onKeyDown={onKeyDown}
          />
          {typed !== null && search.isFetching ? <Spinner label="Searching" /> : null}
          <button type="button" className="search-palette__close" aria-label="Close search" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="search-palette__results">
          {status}
          <div
            role="listbox"
            id={listboxId}
            aria-label="Results and actions"
            className={cx('search-palette__list', stale && 'search-palette__list--stale')}
          >
            {sections.map((section) => (
              <div key={section.id} role="group" aria-labelledby={`${baseId}-${section.id}-label`} className="search-palette__group">
                <div role="presentation" id={`${baseId}-${section.id}-label`} className="search-palette__group-label">
                  {section.label}
                </div>
                {section.options.map((option) => {
                  const selectable = !(stale && option.kind === 'hit');
                  const isActive = active?.id === option.id;
                  return (
                    <div
                      key={option.id}
                      id={option.id}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={selectable ? undefined : true}
                      className={cx('search-option', `search-option--${option.kind}`, isActive && 'search-option--active')}
                      onMouseMove={() => {
                        if (selectable && !isActive) setActiveId(option.id);
                      }}
                      // Keep focus (and the caret) in the input.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (selectable) run(option);
                      }}
                    >
                      <OptionContent option={option} query={input} showCompany={showCompany} />
                      <Icon name="arrowRight" size={16} className="search-option__go" />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="search-palette__footer">
          <span className="search-palette__scope">
            Searching in <strong>{session.scope.name}</strong>
          </span>
          <span className="search-palette__keys" aria-hidden="true">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span>
              <Kbd>↵</Kbd> open
            </span>
            <span>
              <Kbd>Esc</Kbd> close
            </span>
          </span>
        </div>
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </div>
    </dialog>
  );
}

function OptionContent({ option, query, showCompany }: { option: PaletteOption; query: string; showCompany: boolean }) {
  switch (option.kind) {
    case 'hit':
      return <SearchHitContent hit={option.hit} query={query} showCompany={showCompany} />;
    case 'recent':
      return (
        <>
          <span className="search-hit__icon" aria-hidden="true">
            <Icon name="clock" size={16} />
          </span>
          <span className="search-option__label">{option.query}</span>
        </>
      );
    case 'clear-recent':
      return (
        <>
          <span className="search-hit__icon" aria-hidden="true">
            <Icon name="x" size={16} />
          </span>
          <span className="search-option__label muted">Clear recent searches</span>
        </>
      );
    case 'action':
      return (
        <>
          <span className="search-hit__icon" aria-hidden="true">
            <Icon name={option.action.icon} size={16} />
          </span>
          <span className="search-option__label">{option.action.label}</span>
        </>
      );
    case 'all':
      return (
        <>
          <span className="search-hit__icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <span className="search-option__label">See all results for “{option.query}”</span>
        </>
      );
  }
}
