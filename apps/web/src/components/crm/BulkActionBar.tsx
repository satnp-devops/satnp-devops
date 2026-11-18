'use client';

import type { ReactNode } from 'react';
import { formatCount } from '@/lib/crm/format';
import { Button } from '../ui';
import './crm.css';

/**
 * Appears while rows are selected: how many, the actions for them, and Clear. It sticks to the
 * bottom of the window, so put it right after the table. The count is announced as it changes.
 * Pass <Button size="sm"> actions as children; Escape inside the bar clears the selection.
 */
export function BulkActionBar({
  count,
  noun = 'record',
  nounPlural,
  onClear,
  label = 'Bulk actions',
  children,
}: {
  count: number;
  /** "lead" gives "3 leads selected". */
  noun?: string;
  nounPlural?: string;
  onClear: () => void;
  label?: string;
  children?: ReactNode;
}) {
  const text = `${formatCount(count)} ${count === 1 ? noun : (nounPlural ?? `${noun}s`)} selected`;
  return (
    <>
      <p className="visually-hidden" role="status">
        {count > 0 ? text : ''}
      </p>
      {count > 0 ? (
        <section
          className="crm-bulk"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClear();
            }
          }}
        >
          <span className="crm-bulk__count" aria-hidden="true">
            {text}
          </span>
          <div className="crm-bulk__actions">{children}</div>
          <Button size="sm" variant="ghost" icon="x" className="crm-bulk__clear" onClick={onClear}>
            Clear
          </Button>
        </section>
      ) : null}
    </>
  );
}
