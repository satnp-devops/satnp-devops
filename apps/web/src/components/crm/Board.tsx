'use client';

import Link from 'next/link';
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { formatCount } from '@/lib/crm/format';
import { Button, cx } from '../ui';
import { Menu } from './Popover';
import './crm.css';

// A kanban board for pipelines. Cards move between columns by dragging (HTML5 drag and drop)
// or with each card's "Move to…" menu, which works from the keyboard and on touch screens.
// The board only reports moves: the page updates its data (optimistically, then the API).

export interface BoardColumnRef {
  id: string;
  title: string;
}

interface Dragging {
  cardId: string;
  title: string;
  fromColumnId: string;
}

interface BoardContextValue {
  columns: readonly BoardColumnRef[];
  /** For drawing drop targets. */
  dragging: Dragging | null;
  /** For drop decisions: set the moment a drag starts, before React re-renders the columns. */
  draggingRef: RefObject<Dragging | null>;
  setDragging: (dragging: Dragging | null) => void;
  move: (cardId: string, title: string, fromColumnId: string, toColumnId: string) => void;
  canMove: (cardId: string, fromColumnId: string, toColumnId: string) => boolean;
  /** The card that just moved, to focus once it shows up in its new column. */
  focusAfterMove: RefObject<string | null>;
}

const BoardContext = createContext<BoardContextValue | null>(null);
const ColumnContext = createContext<string | null>(null);

function useBoard(): BoardContextValue {
  const board = useContext(BoardContext);
  if (!board) throw new Error('BoardColumn and BoardCard must be inside <Board>');
  return board;
}

const allowAll = () => true;

export function Board({
  label,
  columns,
  onMove,
  canMove = allowAll,
  columnHeight,
  columnWidth,
  children,
}: {
  /** The board's name, e.g. "Admissions pipeline". */
  label: string;
  /** Every column in order, for the "Move to…" menus. */
  columns: readonly BoardColumnRef[];
  onMove: (cardId: string, toColumnId: string, fromColumnId: string) => void;
  /** Rule out moves (a stage that needs a dialog first can still be allowed and handled in onMove). */
  canMove?: (cardId: string, fromColumnId: string, toColumnId: string) => boolean;
  /** Fix column heights (e.g. 'calc(100dvh - 220px)') so long columns scroll on their own. */
  columnHeight?: string;
  /** Column width on wider screens; default 288px. */
  columnWidth?: string;
  children: ReactNode;
}) {
  const [dragging, setDraggingState] = useState<Dragging | null>(null);
  const draggingRef = useRef<Dragging | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const focusAfterMove = useRef<string | null>(null);

  const setDragging = useCallback((next: Dragging | null) => {
    draggingRef.current = next;
    setDraggingState(next);
  }, []);

  const move = useCallback(
    (cardId: string, title: string, fromColumnId: string, toColumnId: string) => {
      if (fromColumnId === toColumnId || !canMove(cardId, fromColumnId, toColumnId)) return;
      focusAfterMove.current = cardId;
      onMove(cardId, toColumnId, fromColumnId);
      const target = columns.find((column) => column.id === toColumnId);
      setAnnouncement(`${title} moved to ${target?.title ?? 'another column'}.`);
    },
    [canMove, columns, onMove],
  );

  const value = useMemo(
    () => ({ columns, dragging, draggingRef, setDragging, move, canMove, focusAfterMove }),
    [columns, dragging, setDragging, move, canMove],
  );

  const style = {
    ...(columnHeight ? { '--crm-board-height': columnHeight } : {}),
    ...(columnWidth ? { '--crm-column-width': columnWidth } : {}),
  } as CSSProperties;

  return (
    <BoardContext.Provider value={value}>
      <div className="crm-board" role="region" aria-label={label} style={style}>
        {children}
      </div>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </BoardContext.Provider>
  );
}

/** One stage: title, card count, total value and a slot for an SLA flag, then its cards. */
export function BoardColumn({
  id,
  title,
  count,
  countLabel = 'cards',
  total,
  flag,
  actions,
  footer,
  emptyText = 'Nothing here',
  children,
}: {
  id: string;
  title: string;
  /** All cards in the stage (from the server), which may be more than are loaded. */
  count?: number;
  /** Spoken after the count: "12 deals". */
  countLabel?: string;
  /** e.g. <Money minor={...} currency="INR" compact />. */
  total?: ReactNode;
  /** e.g. <StatusPill tone="danger" icon="clock">3 over SLA</StatusPill>. */
  flag?: ReactNode;
  actions?: ReactNode;
  /** e.g. a "Load more" button for the stage's next page. */
  footer?: ReactNode;
  emptyText?: string;
  children?: ReactNode;
}) {
  const board = useBoard();
  const headingId = useId();
  const [over, setOver] = useState(false);
  const accepts = (drag: Dragging | null): drag is Dragging =>
    drag !== null && drag.fromColumnId !== id && board.canMove(drag.cardId, drag.fromColumnId, id);
  const droppable = accepts(board.dragging);
  const empty = Children.toArray(children).length === 0;

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!accepts(board.draggingRef.current)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!over) setOver(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOver(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setOver(false);
    const drag = board.draggingRef.current;
    if (accepts(drag)) board.move(drag.cardId, drag.title, drag.fromColumnId, id);
    board.setDragging(null);
  }

  return (
    <ColumnContext.Provider value={id}>
      <section
        className={cx('crm-bcol', droppable && 'crm-bcol--droppable', droppable && over && 'crm-bcol--over')}
        aria-labelledby={headingId}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <header className="crm-bcol__head">
          <div className="crm-bcol__titlebar">
            <h3 id={headingId} className="crm-bcol__title">
              <span className="crm-bcol__name">{title}</span>
              {count !== undefined ? (
                <span className="crm-bcol__count">
                  <span className="visually-hidden">, </span>
                  {formatCount(count)}
                  <span className="visually-hidden"> {countLabel}</span>
                </span>
              ) : null}
            </h3>
            {actions}
          </div>
          {total !== undefined || flag ? (
            <div className="crm-bcol__meta">
              {total !== undefined ? (
                <span className="crm-bcol__total">
                  <span className="visually-hidden">Total </span>
                  {total}
                </span>
              ) : null}
              {flag}
            </div>
          ) : null}
        </header>
        {empty ? (
          <p className="crm-bcol__empty">{droppable ? 'Drop here' : emptyText}</p>
        ) : (
          <ul className="crm-bcol__body" role="list">
            {children}
          </ul>
        )}
        {footer ? <div className="crm-bcol__foot">{footer}</div> : null}
      </section>
    </ColumnContext.Provider>
  );
}

/**
 * A card on the board. Drag it to another column, or use its "Move to…" menu. The title opens the
 * record (a link with `href`, or `onOpen`); a click anywhere else on the card does the same.
 */
export function BoardCard({
  id,
  title,
  href,
  onOpen,
  draggable = true,
  children,
}: {
  id: string;
  title: string;
  href?: string;
  onOpen?: () => void;
  draggable?: boolean;
  /** Details under the title: value, owner, badges. */
  children?: ReactNode;
}) {
  const board = useBoard();
  const column = useContext(ColumnContext);
  const titleRef = useRef<HTMLElement | null>(null);

  // After a move, the card mounts again in its new column: put focus back on it there.
  useEffect(() => {
    if (board.focusAfterMove.current !== id) return;
    board.focusAfterMove.current = null;
    titleRef.current?.focus();
  });

  if (column === null) throw new Error('BoardCard must be inside <BoardColumn>');
  const columnId = column;
  const isDragging = board.dragging?.cardId === id;

  const targets = board.columns.filter((column) => column.id !== columnId && board.canMove(id, columnId, column.id));

  function onCardClick(event: MouseEvent<HTMLLIElement>) {
    if (event.target instanceof Element && event.target.closest('a,button,input,select,textarea,[role="menuitem"]')) return;
    if (window.getSelection()?.toString()) return;
    if (href) titleRef.current?.click();
    else onOpen?.();
  }

  return (
    <li
      className={cx('crm-bcard', isDragging && 'crm-bcard--dragging')}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', title);
        board.setDragging({ cardId: id, title, fromColumnId: columnId });
      }}
      onDragEnd={() => board.setDragging(null)}
      onClick={onCardClick}
    >
      <div className="crm-bcard__head">
        {href ? (
          <Link
            href={href}
            className="crm-bcard__title"
            draggable={false}
            ref={(element) => {
              titleRef.current = element;
            }}
          >
            {title}
          </Link>
        ) : (
          <button
            type="button"
            className="crm-bcard__title"
            ref={(element) => {
              titleRef.current = element;
            }}
            onClick={onOpen}
          >
            {title}
          </button>
        )}
        <div className="crm-bcard__move">
          <Menu
            label={`Move ${title} to`}
            heading="Move to…"
            placement="bottom-end"
            emptyText="No other stage allowed"
            items={targets.map((column) => ({
              key: column.id,
              label: column.title,
              icon: 'arrowRight',
              onSelect: () => board.move(id, title, columnId, column.id),
            }))}
            trigger={(trigger) => <Button {...trigger} size="sm" variant="ghost" iconOnly icon="move" aria-label={`Move ${title}`} />}
          />
        </div>
      </div>
      {children ? <div className="crm-bcard__body">{children}</div> : null}
    </li>
  );
}
