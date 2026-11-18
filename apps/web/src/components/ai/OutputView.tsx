'use client';

import { isJsonObject, keyLabel } from '@/lib/ai/display';
import type { Json } from '@/lib/ai/types';
import './ai.css';

// An AI output (any JSON) as a readable list: strings as text, lists as chips, nested objects as
// nested lists. `hide` leaves out keys shown elsewhere (confidence has its own meter).

/** Names for ids the value mentions (companies, product lines...), shown instead of the uuid. */
type Names = Readonly<Record<string, string>>;

function Value({ value, names }: { value: Json; names: Names }) {
  if (value === null || value === '') {
    return (
      <span className="muted">
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">Not set</span>
      </span>
    );
  }
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'string' && names[value.toLowerCase()]) return <span title={value}>{names[value.toLowerCase()]}</span>;
  if (typeof value === 'number' || typeof value === 'string') return <>{String(value)}</>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">None</span>;
    if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      return (
        <span className="ai-chips">
          {value.map((item, i) => {
            const name = typeof item === 'string' ? names[item.toLowerCase()] : undefined;
            return (
              <span key={`${String(item)}-${i}`} className="ai-chip" title={name ? String(item) : undefined}>
                {name ?? String(item)}
              </span>
            );
          })}
        </span>
      );
    }
    return (
      <div className="stack gap-6">
        {value.map((item, i) => (
          <Value key={i} value={item} names={names} />
        ))}
      </div>
    );
  }
  return <OutputView value={value} names={names} />;
}

export function OutputView({ value, hide = [], names = {} }: { value: Json; hide?: readonly string[]; names?: Names }) {
  if (!isJsonObject(value)) return <Value value={value} names={names} />;
  const entries = Object.entries(value).filter(([key]) => !hide.includes(key));
  return (
    <dl className="ai-output">
      {entries.map(([key, item]) => (
        <div key={key} className="ai-output__row">
          <dt>{keyLabel(key)}</dt>
          <dd>
            <Value value={item} names={names} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
