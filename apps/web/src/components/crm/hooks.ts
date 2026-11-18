'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';

// ---------- A shared clock ----------
// Relative times and SLA badges re-render together from one timer, however many are on screen.

const TICK_MS = 30_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function onVisible() {
  if (document.visibilityState === 'visible') tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
    // Background tabs throttle timers; catch up as soon as the tab is visible again.
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

const getNow = () => now;

/** The current time in ms, refreshed every 30 seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

// ---------- Keyboard ----------

const noop = () => () => undefined;
const isApple = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘" on Apple devices, "Ctrl" elsewhere (Ctrl during server rendering). */
export function useModifierKey(): '⌘' | 'Ctrl' {
  return useSyncExternalStore(noop, () => (isApple() ? '⌘' : 'Ctrl'), () => 'Ctrl');
}

// ---------- Selection ----------

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Row selection for a DataTable that starts again when `resetKey` changes (filters, sort,
 * the working scope), so a bulk action never touches rows the person can no longer see.
 */
export function useRowSelection(resetKey?: unknown) {
  const key = JSON.stringify(resetKey ?? null);
  const [state, setState] = useState<{ key: string; ids: ReadonlySet<string> }>({ key, ids: EMPTY });
  const selected = state.key === key ? state.ids : EMPTY;
  const onChange = useCallback((ids: ReadonlySet<string>) => setState({ key, ids }), [key]);
  const clear = useCallback(() => setState({ key, ids: EMPTY }), [key]);
  return { selected, onChange, clear, count: selected.size };
}
