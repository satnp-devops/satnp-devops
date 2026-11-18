'use client';

import type { ReactNode } from 'react';
import { cx } from '@/components/ui';
import { formatMoney } from '@/lib/crm/format';
import type { Money } from '@/lib/crm/types';
import { percent } from '@/lib/delivery/format';
import './delivery.css';

/** A small progress bar with its numbers: seats taken, checklist items done. */
export function Meter({ value, max, label, tone }: { value: number; max: number; label: ReactNode; tone?: 'full' | 'done' }) {
  const width = Math.min(100, percent(value, max));
  return (
    <div className={cx('delivery-meter', tone && `delivery-meter--${tone}`)}>
      <div className="delivery-meter__track" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={typeof label === 'string' ? label : undefined}>
        <div className="delivery-meter__fill" style={{ width: `${width}%` }} />
      </div>
      <span className="delivery-meter__label">{label}</span>
    </div>
  );
}

/** Two lines in a table cell: the main value and a muted detail. */
export function Cell({ main, sub }: { main: ReactNode; sub?: ReactNode }) {
  return (
    <div className="delivery-cell">
      <span className="delivery-cell__main">{main}</span>
      {sub ? <span className="delivery-cell__sub">{sub}</span> : null}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <div className={cx('delivery-stat', tone && `delivery-stat--${tone}`)}>
      <span className="delivery-stat__label">{label}</span>
      <span className="delivery-stat__value">{value}</span>
    </div>
  );
}

export const moneyText = (money: Money | null | undefined) => (money ? formatMoney(money.valueMinor, money.currency) : '');
