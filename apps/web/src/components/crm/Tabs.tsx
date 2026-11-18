'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { formatCount } from '@/lib/crm/format';
import { cx } from '../ui';
import './crm.css';

export interface TabItem {
  href: string;
  label: ReactNode;
  /** A number after the label (open tasks, unread messages). */
  count?: number;
  /** Only the exact path counts as this tab (by default sub-pages do too). */
  exact?: boolean;
  /** Overrides the path match, e.g. for tabs that differ by a query string. */
  active?: boolean;
}

const pathOf = (href: string) => href.split(/[?#]/)[0] ?? href;

/** Which tab is current: an explicit `active`, else the longest path that matches. */
function currentIndex(items: readonly TabItem[], pathname: string): number {
  const explicit = items.findIndex((item) => item.active === true);
  if (explicit >= 0) return explicit;
  let best = -1;
  let bestLength = -1;
  items.forEach((item, index) => {
    if (item.active === false) return;
    const path = pathOf(item.href);
    const matches = item.exact ? pathname === path : pathname === path || pathname.startsWith(`${path.replace(/\/$/, '')}/`);
    if (matches && path.length > bestLength) {
      best = index;
      bestLength = path.length;
    }
  });
  return best;
}

/**
 * Route tabs: links with aria-current="page" on the current one. They scroll sideways on
 * narrow screens and keep the current tab in view. `page` draws the full-width bar under a page header.
 */
export function Tabs({ items, label, variant = 'inline' }: { items: readonly TabItem[]; label: string; variant?: 'inline' | 'page' }) {
  const pathname = usePathname();
  const current = currentIndex(items, pathname);
  const currentRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const tab = currentRef.current;
    const bar = tab?.parentElement;
    if (!tab || !bar || bar.scrollWidth <= bar.clientWidth) return;
    // Scroll the bar only (scrollIntoView could also scroll the page).
    bar.scrollLeft = tab.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2;
  }, [current]);

  return (
    <nav className={cx('crm-tabs', variant === 'page' && 'crm-tabs--page')} aria-label={label}>
      {items.map((item, index) => (
        <Link
          key={item.href}
          href={item.href}
          ref={index === current ? currentRef : undefined}
          className="crm-tabs__tab"
          aria-current={index === current ? 'page' : undefined}
        >
          {item.label}
          {item.count !== undefined ? <span className="crm-tabs__count">{formatCount(item.count)}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
