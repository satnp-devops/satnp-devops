// The Leads list's state (filters, sort, columns), the built-in views and the conversions to the
// API's query (GET /deals) and saved views (docs/crm/PHASE2_CONTRACT.md §9.6, §9.7).

import type { Query } from '@/lib/api';
import type { BuiltInDealColumn, DealColumn, DealFilters, DealListQuery, DealSort, SavedView } from '@/lib/crm/types';

/** What the list shows. Saved views store exactly this. */
export interface LeadsState {
  filters: DealFilters;
  sort: DealSort;
  columns: DealColumn[];
}

/** Columns the person can show or hide; the lead (name) column is always there. */
export const OPTIONAL_COLUMNS: ReadonlyArray<{ id: BuiltInDealColumn; label: string }> = [
  { id: 'channel', label: 'Channel' },
  { id: 'stage', label: 'Stage' },
  { id: 'owner', label: 'Owner' },
  { id: 'productLine', label: 'Product line' },
  { id: 'value', label: 'Value' },
  { id: 'slaDueAt', label: 'SLA' },
  { id: 'tags', label: 'Tags' },
  { id: 'unit', label: 'Team' },
  { id: 'lastActivityAt', label: 'Last activity' },
  { id: 'createdAt', label: 'Created' },
  { id: 'updatedAt', label: 'Updated' },
];

export const DEFAULT_COLUMNS: DealColumn[] = ['channel', 'stage', 'owner', 'value', 'slaDueAt', 'createdAt'];
export const DEFAULT_SORT: DealSort = '-updatedAt';

/** The visible optional columns of a state, in the canonical order (an empty list means the defaults). */
export function visibleColumns(columns: readonly DealColumn[]): BuiltInDealColumn[] {
  const wanted = columns.length > 0 ? columns : DEFAULT_COLUMNS;
  return OPTIONAL_COLUMNS.map((column) => column.id).filter((id) => wanted.includes(id));
}

/** Start of the viewer's local day, in UTC: "New today" means since local midnight. */
export function startOfTodayIso(now: Date = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

/** A date input value ("2026-11-06") as the start of that local day in UTC, or null. */
export function dayStartIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The local day after a date input value, as an exclusive upper bound in UTC ("created up to and including that day"). */
export function dayEndIso(day: string): string | null {
  const start = dayStartIso(day);
  if (!start) return null;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** An ISO bound back to the local date input value. Upper bounds are exclusive, so they show the day before. */
export function isoToDay(iso: string | undefined, upper = false): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (upper) date.setDate(date.getDate() - 1);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface BuiltInView {
  id: string;
  name: string;
  description: string;
  state: () => LeadsState;
}

const open = { status: ['open' as const] };

/** Views everyone has. "New today" is computed when picked, so it always means today. */
export const BUILT_IN_VIEWS: readonly BuiltInView[] = [
  {
    id: 'builtin:open',
    name: 'Open leads',
    description: 'Every open lead in the working scope',
    state: () => ({ filters: { ...open }, sort: DEFAULT_SORT, columns: [] }),
  },
  {
    id: 'builtin:mine',
    name: 'My leads',
    description: 'Open leads you own',
    state: () => ({ filters: { ...open, owner: ['me'] }, sort: DEFAULT_SORT, columns: [] }),
  },
  {
    id: 'builtin:new-today',
    name: 'New today',
    description: 'Leads created since midnight',
    state: () => ({ filters: { createdFrom: startOfTodayIso() }, sort: '-createdAt', columns: [] }),
  },
  {
    id: 'builtin:sla-breached',
    name: 'SLA breached',
    description: 'Open leads past their stage SLA or first-reply deadline',
    state: () => ({ filters: { ...open, sla: 'breached' }, sort: 'slaDueAt', columns: [] }),
  },
  {
    id: 'builtin:unassigned',
    name: 'Unassigned',
    description: 'Open leads nobody owns yet',
    state: () => ({ filters: { ...open, owner: ['none'] }, sort: '-createdAt', columns: [] }),
  },
];

export const DEFAULT_VIEW_ID = 'builtin:open';

export function savedViewState(view: SavedView): LeadsState {
  return { filters: cleanFilters(view.filters), sort: view.sort, columns: view.columns };
}

/** Drops empty values, so equal filters compare equal and the query stays short. */
export function cleanFilters(filters: DealFilters): DealFilters {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return out as DealFilters;
}

export function sameState(a: LeadsState, b: LeadsState): boolean {
  return (
    a.sort === b.sort &&
    JSON.stringify(cleanFilters(a.filters)) === JSON.stringify(cleanFilters(b.filters)) &&
    JSON.stringify(visibleColumns(a.columns)) === JSON.stringify(visibleColumns(b.columns))
  );
}

/** How many filters are set (for the "Clear all" count). */
export function filterCount(filters: DealFilters): number {
  return Object.values(cleanFilters(filters)).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 1), 0);
}

/** GET /deals parameters: arrays become comma lists. */
export function toQuery(query: Omit<DealListQuery, 'cursor'> & { cursor?: string }): Query {
  const out: Query = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(',');
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** DataTable sort state ⇄ API sort. */
export function sortState(sort: DealSort): { key: string; direction: 'asc' | 'desc' } {
  return sort.startsWith('-') ? { key: sort.slice(1), direction: 'desc' } : { key: sort, direction: 'asc' };
}

export function sortFromState(state: { key: string; direction: 'asc' | 'desc' }): DealSort {
  return (state.direction === 'desc' ? `-${state.key}` : state.key) as DealSort;
}
