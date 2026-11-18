'use client';

import { Fragment, type ReactNode } from 'react';
import { cx } from '../ui';
import './crm.css';

export interface KeyValueItem {
  /** Unique within the list; defaults to the label when it's text. */
  key?: string;
  label: ReactNode;
  /** null, undefined or '' shows as "Not set". */
  value: ReactNode;
  /** A small marker after the label, e.g. "AI" for fields the intake agent filled in. */
  meta?: ReactNode;
}

const isEmpty = (value: ReactNode) => value === null || value === undefined || value === '';

function Empty({ className }: { className: string }) {
  return (
    <span className={className}>
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">Not set</span>
    </span>
  );
}

/**
 * A description list. `inline` puts labels beside values (profile details); `stacked` puts each
 * label above its value in a responsive grid (AI-captured fields in a side panel).
 */
export function KeyValue({
  items,
  layout = 'inline',
  className,
}: {
  items: readonly KeyValueItem[];
  layout?: 'inline' | 'stacked';
  className?: string;
}) {
  const keyOf = (item: KeyValueItem, index: number) => item.key ?? (typeof item.label === 'string' ? item.label : String(index));

  if (layout === 'stacked') {
    return (
      <dl className={cx('crm-kvgrid', className)}>
        {items.map((item, index) => (
          <div key={keyOf(item, index)} className="crm-kvgrid__item">
            <dt>
              {item.label}
              {item.meta ?? null}
            </dt>
            <dd>{isEmpty(item.value) ? <Empty className="crm-kvgrid__empty" /> : item.value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <dl className={cx('kv crm-kv', className)}>
      {items.map((item, index) => (
        <Fragment key={keyOf(item, index)}>
          <dt>{item.label}</dt>
          <dd>
            {isEmpty(item.value) ? <Empty className="crm-kv__empty" /> : item.value}
            {item.meta ? <span className="crm-kv__meta">{item.meta}</span> : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
