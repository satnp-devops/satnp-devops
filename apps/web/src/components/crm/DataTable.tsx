'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { formatCount } from '@/lib/crm/format';
import { Icon } from '../icons';
import { Button, EmptyState, ErrorAlert, cx } from '../ui';
import './crm.css';

export type SortDirection = 'asc' | 'desc';

/** The sort the server should apply: a column's sortKey and a direction. */
export interface SortState {
  key: string;
  direction: SortDirection;
}

/** Widths of the table itself (not the window): sm 640 px, md 900 px, lg 1200 px. */
export type Breakpoint = 'sm' | 'md' | 'lg';

export interface Column<T> {
  id: string;
  header: ReactNode;
  /** Plain-text name for the phone layout and the sort menu, when `header` isn't a string. */
  label?: string;
  cell: (row: T, index: number) => ReactNode;
  /** Makes the header sortable; the key is sent to the server as is. */
  sortKey?: string;
  /** Direction of the first click (dates usually start newest first). Default asc. */
  firstDirection?: SortDirection;
  /** CSS width, e.g. 140 or '18%'. Columns without one share the rest. */
  width?: number | string;
  /** Hide the column while the table is narrower than this. 'sm' hides it in the phone layout too. */
  hideBelow?: Breakpoint;
  align?: 'start' | 'end' | 'center';
  /**
   * How the cell shows in the phone layout (below 640 px): `title` bold and first, `field` with
   * its label (the default), `plain` without a label, `hidden` not at all.
   */
  card?: 'title' | 'field' | 'plain' | 'hidden';
  className?: string;
}

export interface RowSelection {
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowId: (row: T) => string;
  /** The table's accessible name, e.g. "Leads". */
  label: string;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Checkboxes for bulk actions (see useRowSelection). The header box selects every row shown. */
  selection?: RowSelection;
  /** Names a row for its checkbox: "Select Aarav Mehta". */
  rowLabel?: (row: T) => string;
  /** Enter or a click on a row, e.g. to open the side preview. */
  onRowActivate?: (row: T) => void;
  /** The row shown in the preview, highlighted. */
  activeRowId?: string | null;
  /** First load: skeleton rows. */
  loading?: boolean;
  /** Reloading with rows on screen (new sort or filters): rows dim. */
  refreshing?: boolean;
  skeletonRows?: number;
  error?: unknown;
  onRetry?: () => void;
  /** Shown when there are no rows; say whether filters are hiding them. */
  empty?: ReactNode;
  /** Cursor pagination: show "Load more" while the server has more. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Inside the frame above the table, e.g. a <FilterBar />. */
  toolbar?: ReactNode;
  /** Inside the frame below the table, beside "Load more". */
  footer?: ReactNode;
  /**
   * Scroll inside the table, with the header stuck to its top, instead of with the page
   * (split layouts, boards). Without it the header sticks to the top of the window.
   */
  maxHeight?: string;
  /** Draw the white frame (border and corners). Off when the table sits inside another card. */
  framed?: boolean;
  rowClassName?: (row: T) => string | undefined;
}

/** What useInfiniteQuery returns, as much as the table needs. */
export interface InfiniteListQuery<T> {
  data: { pages: ReadonlyArray<{ data: readonly T[] }> } | undefined;
  isPending: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  error: unknown;
  hasNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => unknown;
}

/**
 * Table props from a useInfiniteQuery over `{ data, nextCursor }` pages:
 * <DataTable {...infiniteRows(leads)} columns={...} rowId={...} label="Leads" />
 */
export function infiniteRows<T>(query: InfiniteListQuery<T>) {
  return {
    rows: query.data?.pages.flatMap((page) => page.data) ?? [],
    loading: query.isPending,
    refreshing: query.isFetching && !query.isPending && !query.isFetchingNextPage,
    error: query.isError ? query.error : null,
    onRetry: () => void query.refetch(),
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    onLoadMore: () => void query.fetchNextPage(),
  };
}

const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="checkbox"],[contenteditable="true"],[data-row-ignore]';
const SKELETON_WIDTHS = [68, 44, 56, 36, 62, 48, 40];

function columnLabel<T>(column: Column<T>): string {
  return column.label ?? (typeof column.header === 'string' ? column.header : column.id);
}

function cardMode<T>(column: Column<T>): NonNullable<Column<T>['card']> {
  return column.card ?? (column.hideBelow === 'sm' ? 'hidden' : 'field');
}

function columnClasses<T>(column: Column<T>): string {
  return cx(
    column.hideBelow === 'md' && 'crm-hide-md',
    column.hideBelow === 'lg' && 'crm-hide-lg',
    column.align === 'end' && 'crm-align-end',
    column.align === 'center' && 'crm-align-center',
    column.className,
  );
}

/** A click that landed on a control inside the row (checkbox, link, button) isn't a row click. */
function fromControl(target: EventTarget, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(INTERACTIVE);
  return control !== null && control !== row && row.contains(control);
}

function Checkbox({ indeterminate = false, ...rest }: InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  // Every render: a click clears the DOM flag even when our value stays the same.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  });
  return <input ref={ref} type="checkbox" {...rest} />;
}

/**
 * A server-sorted, cursor-paginated table for CRM lists. Headers report sort changes (the server
 * sorts); rows can be selected for bulk actions, moved through with the arrow keys and opened with
 * Enter or a click. The header sticks while scrolling, first loads show skeleton rows, and below
 * 640 px of width each row becomes a card.
 *
 * Keys on a focused row: ↑ ↓ move, Home / End jump, Enter opens, Space selects (Shift extends).
 */
export function DataTable<T>({
  columns,
  rows,
  rowId,
  label,
  sort = null,
  onSortChange,
  selection,
  rowLabel,
  onRowActivate,
  activeRowId = null,
  loading = false,
  refreshing = false,
  skeletonRows = 6,
  error = null,
  onRetry,
  empty,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  toolbar,
  footer,
  maxHeight,
  framed = true,
  rowClassName,
}: DataTableProps<T>) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const sortSelectId = useId();
  const [focusIndex, setFocusIndex] = useState(0);
  const lastToggled = useRef<number | null>(null);

  const ids = rows.map(rowId);
  const tabRow = rows.length === 0 ? -1 : Math.min(focusIndex, rows.length - 1);
  const selected = selection?.selected;
  const selectedShown = selected ? ids.filter((id) => selected.has(id)).length : 0;
  const allShown = ids.length > 0 && selectedShown === ids.length;
  const someShown = selectedShown > 0 && !allShown;
  const sortable = onSortChange ? columns.filter((column) => column.sortKey) : [];
  const columnCount = columns.length + (selection ? 1 : 0);
  const showSkeleton = loading && rows.length === 0;

  function moveFocus(index: number) {
    const target = bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]')[index];
    if (!target) return;
    setFocusIndex(index);
    target.focus();
  }

  function toggleRow(index: number, extend: boolean) {
    if (!selection) return;
    const id = ids[index];
    if (id === undefined) return;
    const next = new Set(selection.selected);
    const select = !next.has(id);
    const from = extend && lastToggled.current !== null ? Math.min(lastToggled.current, index) : index;
    const to = extend && lastToggled.current !== null ? Math.max(lastToggled.current, index) : index;
    for (let i = from; i <= to; i += 1) {
      const each = ids[i];
      if (each === undefined) continue;
      if (select) next.add(each);
      else next.delete(each);
    }
    lastToggled.current = index;
    selection.onChange(next);
  }

  function toggleAllShown() {
    if (!selection) return;
    const next = new Set(selection.selected);
    for (const id of ids) {
      if (allShown) next.delete(id);
      else next.add(id);
    }
    selection.onChange(next);
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) {
    const onRow = event.target === event.currentTarget;
    // Typing in a field inside a cell keeps its own keys.
    if (!onRow && event.target instanceof HTMLElement && event.target.matches('input:not([type="checkbox"]),select,textarea,[contenteditable="true"]')) {
      return;
    }
    const last = rows.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (index === last && hasMore && !loadingMore) onLoadMore?.();
        moveFocus(Math.min(index + 1, last));
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(Math.max(index - 1, 0));
        break;
      case 'PageDown':
        event.preventDefault();
        moveFocus(Math.min(index + 10, last));
        break;
      case 'PageUp':
        event.preventDefault();
        moveFocus(Math.max(index - 10, 0));
        break;
      case 'Home':
        if (onRow) {
          event.preventDefault();
          moveFocus(0);
        }
        break;
      case 'End':
        if (onRow) {
          event.preventDefault();
          moveFocus(last);
        }
        break;
      case 'Enter':
        if (onRow && onRowActivate) {
          event.preventDefault();
          onRowActivate(row);
        }
        break;
      case ' ':
        if (onRow && selection) {
          event.preventDefault();
          toggleRow(index, event.shiftKey);
        }
        break;
      default:
    }
  }

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, row: T) {
    if (!onRowActivate || fromControl(event.target, event.currentTarget)) return;
    // Selecting text to copy it shouldn't open the record.
    if (window.getSelection()?.toString()) return;
    onRowActivate(row);
  }

  const style = maxHeight ? ({ '--crm-table-max-height': maxHeight } as CSSProperties) : undefined;

  let body: ReactNode;
  if (showSkeleton) {
    body = Array.from({ length: skeletonRows }, (_, rowIndex) => (
      <tr key={`skeleton-${rowIndex}`} className="crm-row crm-row--skeleton" role="row" aria-hidden="true">
        {selection ? (
          <td className="crm-cell crm-cell--select" role="cell">
            <span className="crm-skel crm-skel--check" />
          </td>
        ) : null}
        {columns.map((column, columnIndex) => (
          <td key={column.id} role="cell" className={cx('crm-cell', `crm-cell--${cardMode(column)}`, columnClasses(column))}>
            <span className="crm-skel" style={{ width: `${SKELETON_WIDTHS[(rowIndex + columnIndex) % SKELETON_WIDTHS.length] ?? 50}%` }} />
          </td>
        ))}
      </tr>
    ));
  } else if (rows.length === 0) {
    body = (
      <tr className="crm-row crm-row--message" role="row">
        <td colSpan={columnCount} role="cell" className="crm-table__message">
          {error ? (
            <>
              <ErrorAlert error={error} />
              {onRetry ? (
                <div className="crm-table__retry">
                  <Button icon="refresh" onClick={onRetry}>
                    Try again
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            (empty ?? <EmptyState icon="inbox" title="Nothing here yet" />)
          )}
        </td>
      </tr>
    );
  } else {
    body = rows.map((row, index) => {
      const id = ids[index] ?? String(index);
      const isSelected = selected?.has(id) ?? false;
      const isActive = activeRowId === id;
      const focusable = index === tabRow;
      return (
        <tr
          key={id}
          data-row=""
          role="row"
          tabIndex={focusable ? 0 : -1}
          aria-current={isActive ? 'true' : undefined}
          className={cx(
            'crm-row',
            onRowActivate && 'crm-row--action',
            isSelected && 'crm-row--selected',
            isActive && 'crm-row--active',
            rowClassName?.(row),
          )}
          onFocus={() => setFocusIndex(index)}
          onKeyDown={(event) => onRowKeyDown(event, row, index)}
          onClick={(event) => onRowClick(event, row)}
        >
          {selection ? (
            <td className="crm-cell crm-cell--select" role="cell">
              <label className="crm-check">
                <input
                  type="checkbox"
                  checked={isSelected}
                  tabIndex={focusable ? 0 : -1}
                  aria-label={`Select ${rowLabel ? rowLabel(row) : `row ${index + 1}`}`}
                  onChange={(event) => toggleRow(index, 'shiftKey' in event.nativeEvent && event.nativeEvent.shiftKey === true)}
                />
              </label>
            </td>
          ) : null}
          {columns.map((column) => {
            const mode = cardMode(column);
            return (
              <td key={column.id} role="cell" className={cx('crm-cell', `crm-cell--${mode}`, columnClasses(column))}>
                {mode === 'field' ? <span className="crm-cell__label">{columnLabel(column)}</span> : null}
                <div className="crm-cell__value">{column.cell(row, index)}</div>
              </td>
            );
          })}
        </tr>
      );
    });
  }

  return (
    <div
      className={cx('crm-table', !framed && 'crm-table--plain', selection && 'crm-table--selectable', refreshing && 'crm-table--refreshing')}
      style={style}
    >
      {toolbar ? <div className="crm-table__toolbar">{toolbar}</div> : null}

      {/* Phone layout: the header row is hidden, so select-all and sorting live here. */}
      {(selection && rows.length > 0) || sortable.length > 0 ? (
        <div className="crm-table__bar">
          {selection && rows.length > 0 ? (
            <label className="crm-table__bar-select">
              <Checkbox checked={allShown} indeterminate={someShown} onChange={toggleAllShown} />
              <span>Select all {formatCount(rows.length)}</span>
            </label>
          ) : null}
          {sortable.length > 0 && onSortChange ? (
            <div className="crm-table__sort">
              <label className="visually-hidden" htmlFor={sortSelectId}>
                Sort by
              </label>
              <select
                id={sortSelectId}
                className="select"
                value={sort?.key ?? ''}
                onChange={(event) => {
                  const column = sortable.find((item) => item.sortKey === event.target.value);
                  if (column?.sortKey) onSortChange({ key: column.sortKey, direction: column.firstDirection ?? 'asc' });
                }}
              >
                {sort ? null : <option value="">Sort by…</option>}
                {sortable.map((column) => (
                  <option key={column.id} value={column.sortKey}>
                    {columnLabel(column)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                iconOnly
                icon={sort?.direction === 'desc' ? 'arrowDown' : 'arrowUp'}
                aria-label={sort?.direction === 'desc' ? 'Descending: switch to ascending' : 'Ascending: switch to descending'}
                disabled={!sort}
                onClick={() => {
                  if (sort) onSortChange({ key: sort.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={cx('crm-table__scroll', maxHeight && 'crm-table__scroll--contained')}>
        <table className="crm-table__grid" role="table" aria-busy={loading || refreshing || undefined}>
          <caption className="visually-hidden">{label}</caption>
          <thead role="rowgroup">
            <tr role="row">
              {selection ? (
                <th scope="col" role="columnheader" className="crm-cell--select">
                  <label className="crm-check">
                    <Checkbox
                      checked={allShown}
                      indeterminate={someShown}
                      disabled={rows.length === 0}
                      aria-label={`Select all ${formatCount(rows.length)} shown`}
                      onChange={toggleAllShown}
                    />
                  </label>
                </th>
              ) : null}
              {columns.map((column) => {
                const sorted = sort !== null && column.sortKey !== undefined && sort.key === column.sortKey;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    role="columnheader"
                    className={columnClasses(column)}
                    style={column.width !== undefined ? { width: column.width } : undefined}
                    aria-sort={sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {column.sortKey && onSortChange ? (
                      <SortButton column={column} sort={sort} onSortChange={onSortChange} />
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef} role="rowgroup">
            {body}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && error ? (
        <div className="crm-table__foot">
          <div className="grow">
            <ErrorAlert error={error} />
          </div>
        </div>
      ) : null}
      {rows.length > 0 && (footer || (hasMore && onLoadMore)) ? (
        <div className={cx('crm-table__foot', !footer && 'crm-table__foot--center')}>
          {footer ? <div className="crm-table__footnote">{footer}</div> : null}
          {hasMore && onLoadMore ? (
            <Button loading={loadingMore} onClick={onLoadMore}>
              Load more
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="visually-hidden" role="status">
        {loading && rows.length === 0 ? `Loading ${label.toLowerCase()}` : loadingMore ? 'Loading more' : ''}
      </p>
    </div>
  );
}

function SortButton<T>({ column, sort, onSortChange }: { column: Column<T>; sort: SortState | null; onSortChange: (sort: SortState) => void }) {
  const key = column.sortKey ?? column.id;
  const active = sort?.key === key;
  const next: SortDirection = active ? (sort.direction === 'asc' ? 'desc' : 'asc') : (column.firstDirection ?? 'asc');
  return (
    <button type="button" className="crm-sort" onClick={() => onSortChange({ key, direction: next })}>
      <span className="crm-sort__label">{column.header}</span>
      <Icon name={active ? (sort.direction === 'asc' ? 'arrowUp' : 'arrowDown') : 'sort'} size={14} className="crm-sort__icon" />
    </button>
  );
}
