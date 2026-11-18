'use client';

import { Popover } from '@/components/crm';
import { Button } from '@/components/ui';
import type { BuiltInDealColumn } from '@/lib/crm/types';
import { DEFAULT_COLUMNS, OPTIONAL_COLUMNS } from '@/lib/deals/views';

/** Show or hide the Leads table's optional columns; saved views remember the choice. */
export function ColumnsMenu({ visible, onChange }: { visible: readonly BuiltInDealColumn[]; onChange: (next: BuiltInDealColumn[]) => void }) {
  return (
    <Popover
      label="Columns"
      placement="bottom-end"
      trigger={(trigger) => (
        <Button {...trigger} icon="list">
          Columns
        </Button>
      )}
    >
      {(close) => (
        <div className="crm-pop__body leads-columns">
          <fieldset className="leads-columns__list">
            <legend className="field__label">Show columns</legend>
            {OPTIONAL_COLUMNS.map((column) => (
              <label key={column.id} className="check">
                <input
                  type="checkbox"
                  checked={visible.includes(column.id)}
                  onChange={(event) => {
                    const next = event.target.checked ? [...visible, column.id] : visible.filter((id) => id !== column.id);
                    onChange(OPTIONAL_COLUMNS.map((item) => item.id).filter((id) => next.includes(id)));
                  }}
                />
                <span>{column.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="crm-pop__footer">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange(DEFAULT_COLUMNS.filter((id): id is BuiltInDealColumn => !id.startsWith('custom.')))}
            >
              Reset
            </Button>
            <Button size="sm" variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
