'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Icon, type IconName } from '../icons';
import { cx } from '../ui';
import './crm.css';

// Popovers use the browser's Popover API: they render in the top layer (never clipped by a
// scrolling table, board column or side panel), close on Escape and outside clicks, and give
// focus back to their trigger. We only place them next to the trigger.

export type Placement = 'bottom-start' | 'bottom-end';

const GUTTER = 8;
const GAP = 4;
const MENU_ITEMS = '[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled),[role="menuitemcheckbox"]:not(:disabled)';
const FOCUSABLE =
  'button:not(:disabled),[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/** Puts a fixed panel under its anchor (above it when there's more room there), inside the viewport. */
function placePanel(anchor: HTMLElement, panel: HTMLElement, placement: Placement, matchWidth: boolean) {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  if (matchWidth) panel.style.minWidth = `${Math.min(rect.width, viewportWidth - 2 * GUTTER)}px`;
  panel.style.maxHeight = '';
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const preferred = placement === 'bottom-end' ? rect.right - width : rect.left;
  const left = Math.max(GUTTER, Math.min(preferred, viewportWidth - GUTTER - width));
  const below = viewportHeight - rect.bottom - GAP - GUTTER;
  const above = rect.top - GAP - GUTTER;
  let top: number;
  if (height <= below || below >= above) {
    top = rect.bottom + GAP;
    panel.style.maxHeight = `${Math.max(below, 120)}px`;
  } else {
    top = Math.max(GUTTER, rect.top - GAP - height);
    panel.style.maxHeight = `${above}px`;
  }
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.dataset.placed = 'true';
}

/** Keeps an open panel next to its anchor while the page scrolls, resizes or the panel's content changes. */
export function useAnchoredPanel(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  placement: Placement = 'bottom-start',
  matchWidth = false,
) {
  useLayoutEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (anchor && panel) placePanel(anchor, panel, placement, matchWidth);
    };
    const schedule = (event?: Event) => {
      // Scrolling inside the panel itself doesn't move it.
      if (event?.target instanceof Node && panelRef.current?.contains(event.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = new ResizeObserver(() => schedule());
    if (panelRef.current) observer.observe(panelRef.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer.disconnect();
    };
  }, [open, anchorRef, panelRef, placement, matchWidth]);
}

function handleMenuKeys(event: KeyboardEvent<HTMLElement>, close: () => void) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEMS)];
  if (items.length === 0) return;
  const index = items.findIndex((item) => item === document.activeElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = index < 0 ? 0 : (index + 1) % items.length;
      break;
    case 'ArrowUp':
      next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    case 'Tab':
      // Menus aren't part of the tab order: Tab closes them and moves on from the trigger.
      close();
      return;
    default:
      return;
  }
  event.preventDefault();
  items[next]?.focus();
}

/** Props to spread on the button that opens a popover. */
export interface PopoverTriggerProps {
  popoverTarget: string;
  'aria-haspopup': 'dialog' | 'menu';
  'aria-expanded': boolean;
  'aria-controls': string;
}

export interface PopoverProps {
  /** Render the opening button and spread the props onto it: `(t) => <Button {...t}>Filters</Button>`. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Content, or a function that receives `close`. Stays mounted while closed, so its state is kept. */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name of the panel. */
  label: string;
  kind?: 'dialog' | 'menu';
  placement?: Placement;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({ trigger, children, label, kind = 'dialog', placement = 'bottom-start', className, onOpenChange }: PopoverProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPanel(open, anchorRef, panelRef, placement);

  // Once placed (and visible), move focus in: the first item of a menu, the first control of a dialog.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || panel.contains(document.activeElement)) return;
    panel.querySelector<HTMLElement>(kind === 'menu' ? MENU_ITEMS : FOCUSABLE)?.focus();
  }, [open, kind]);

  const close = useCallback(() => {
    const panel = panelRef.current;
    if (panel?.matches(':popover-open')) panel.hidePopover();
  }, []);

  return (
    <>
      <span ref={anchorRef} className="crm-anchor">
        {trigger({ popoverTarget: id, 'aria-haspopup': kind, 'aria-expanded': open, 'aria-controls': id })}
      </span>
      <div
        ref={panelRef}
        id={id}
        popover="auto"
        role={kind}
        aria-label={label}
        className={cx('crm-pop', kind === 'menu' && 'crm-menu', className)}
        onBeforeToggle={(event) => {
          if (event.newState === 'open') delete event.currentTarget.dataset.placed;
        }}
        onToggle={(event) => {
          const next = event.newState === 'open';
          setOpen(next);
          onOpenChange?.(next);
        }}
        onKeyDown={kind === 'menu' ? (event) => handleMenuKeys(event, close) : undefined}
      >
        {typeof children === 'function' ? children(close) : children}
      </div>
    </>
  );
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Marks the current choice (the item becomes a menuitemradio). */
  checked?: boolean;
}

/** A dropdown menu of actions, with arrow-key navigation. */
export function Menu({
  label,
  trigger,
  items,
  heading,
  placement = 'bottom-start',
  emptyText = 'Nothing to choose',
}: {
  /** Accessible name, e.g. "Move Aarav Mehta to". */
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  items: readonly MenuItem[];
  /** Visible heading; screen readers hear `label` instead. */
  heading?: string;
  placement?: Placement;
  emptyText?: string;
}) {
  return (
    <Popover label={label} kind="menu" trigger={trigger} placement={placement}>
      {(close) => (
        <>
          {heading ? (
            <p className="crm-menu__heading" aria-hidden="true">
              {heading}
            </p>
          ) : null}
          {items.length === 0 ? (
            <p className="crm-menu__empty" aria-hidden="true">
              {emptyText}
            </p>
          ) : null}
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              tabIndex={-1}
              disabled={item.disabled}
              className={cx('crm-menu__item', item.danger && 'crm-menu__item--danger')}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.icon ? <Icon name={item.icon} size={16} /> : null}
              <span className="crm-menu__label">{item.label}</span>
              {item.checked ? <Icon name="check" size={16} className="crm-menu__check" /> : null}
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}
