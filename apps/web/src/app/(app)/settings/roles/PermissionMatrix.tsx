'use client';

import { useId } from 'react';
import type { PermissionDef, PermissionGroup } from '@/lib/types';

/**
 * Permissions grouped by module, as checkboxes. The catalog comes from the API's module
 * registry, so permissions from new modules appear here automatically.
 * Values are explicit keys: "users.manage", or "leads.view:own" for own-records-only.
 */
export function PermissionMatrix({
  catalog,
  value,
  onChange,
}: {
  catalog: readonly PermissionGroup[];
  value: ReadonlySet<string>;
  /** Leave out for a read-only view. */
  onChange?: (next: Set<string>) => void;
}) {
  return (
    <div className="stack gap-16">
      {catalog.map((group) => (
        <fieldset key={group.module} className="perm-group">
          <legend className="perm-group__title">
            {group.label}
            <span className="small muted"> · {countIn(group, value)} of {group.permissions.length}</span>
          </legend>
          <div className="perm-group__rows">
            {group.permissions.map((permission) => (
              <PermissionRow key={permission.key} permission={permission} value={value} onChange={onChange} />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function countIn(group: PermissionGroup, value: ReadonlySet<string>): number {
  return group.permissions.filter((p) => value.has(p.key) || value.has(`${p.key}:own`)).length;
}

function PermissionRow({
  permission,
  value,
  onChange,
}: {
  permission: PermissionDef;
  value: ReadonlySet<string>;
  onChange: ((next: Set<string>) => void) | undefined;
}) {
  const id = useId();
  const own = value.has(`${permission.key}:own`);
  const checked = value.has(permission.key) || own;
  const readOnly = !onChange;

  function update(nextChecked: boolean, scope: 'all' | 'own') {
    if (!onChange) return;
    const next = new Set(value);
    next.delete(permission.key);
    next.delete(`${permission.key}:own`);
    if (nextChecked) next.add(scope === 'own' ? `${permission.key}:own` : permission.key);
    onChange(next);
  }

  return (
    <div className="perm-row">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={readOnly}
        onChange={(event) => update(event.target.checked, own ? 'own' : 'all')}
      />
      <label htmlFor={id} className="perm-row__text">
        <span className="strong">{permission.label}</span>
        {permission.description ? <span className="small muted">{permission.description}</span> : null}
        <span className="perm-row__key mono">{permission.key}</span>
      </label>
      {permission.supportsOwn && checked ? (
        <select
          className="select perm-row__scope"
          value={own ? 'own' : 'all'}
          disabled={readOnly}
          aria-label={`${permission.label}: which records`}
          onChange={(event) => update(true, event.target.value === 'own' ? 'own' : 'all')}
        >
          <option value="all">All records</option>
          <option value="own">Only their own</option>
        </select>
      ) : null}
    </div>
  );
}
