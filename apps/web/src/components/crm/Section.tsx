'use client';

import { useId, type ReactNode } from 'react';
import { formatCount } from '@/lib/crm/format';
import { cx } from '../ui';
import './crm.css';

/**
 * A titled card for one part of a record (Fees, Tasks, Timeline), with header actions,
 * an optional count and footer. `flush` drops the body padding for lists and tables.
 */
export function Section({
  title,
  description,
  count,
  actions,
  footer,
  flush = false,
  level = 2,
  id,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  /** Heading level: 2 on a page, 3 inside a panel that already has an h2. */
  level?: 2 | 3;
  id?: string;
  className?: string;
  children?: ReactNode;
}) {
  const headingId = useId();
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section id={id} className={cx('card card--flush crm-section', className)} aria-labelledby={headingId}>
      <header className="card__header card__header--padded">
        <div className="card__heading">
          <Heading id={headingId} className="crm-section__title">
            {title}
            {count !== undefined ? <span className="crm-section__count">{formatCount(count)}</span> : null}
          </Heading>
          {description ? <p className="card__description">{description}</p> : null}
        </div>
        {actions ? <div className="row gap-6">{actions}</div> : null}
      </header>
      {children !== undefined && children !== null ? <div className={flush ? undefined : 'card__body'}>{children}</div> : null}
      {footer ? <footer className="crm-section__footer">{footer}</footer> : null}
    </section>
  );
}
