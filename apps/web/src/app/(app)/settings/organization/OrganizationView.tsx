'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { DynamicField } from '@/components/DynamicField';
import { Guard } from '@/components/Guard';
import { Icon, unitIcon } from '@/components/icons';
import { UnitSelect } from '@/components/UnitSelect';
import { Badge, Button, Card, EmptyState, ErrorAlert, Field, PageLoading, cx } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { getPath, setPath, slugify } from '@/lib/objects';
import { keys, useUnitTypes } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { childTypesFor, flattenUnits, trailOf, unitTypeLabel } from '@/lib/tree';
import type { FieldDef, OrgUnit, UnitType } from '@/lib/types';

type UnitFormTarget = { kind: 'create'; parent: OrgUnit } | { kind: 'edit'; unit: OrgUnit };
type DialogState = UnitFormTarget | { kind: 'move'; unit: OrgUnit } | { kind: 'archive'; unit: OrgUnit };

export function OrganizationView() {
  return (
    <Guard anyOf={['org.view', 'org.manage']} anywhere>
      <Organization />
    </Guard>
  );
}

function Organization() {
  const { units, unitsById, scope } = useSession();
  const types = useUnitTypes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  if (types.isPending) return <PageLoading />;
  if (types.isError) return <ErrorAlert error={types.error} />;
  const typeList = types.data;

  const selected = (selectedId ? unitsById.get(selectedId) : undefined) ?? scope;
  const archivedCount = units.filter((unit) => unit.status === 'archived').length;
  const shown = units.filter((unit) => showArchived || unit.status === 'active' || unit.id === selected.id);
  const workCount = units.filter((unit) => unit.access !== 'context' && unit.status === 'active').length;
  const close = () => setDialog(null);

  return (
    <>
      <div className="split">
        <div className="split__side">
          <Card
            flush
            title="Structure"
            description={`${workCount} active ${workCount === 1 ? 'unit' : 'units'} in your area`}
            actions={
              archivedCount > 0 ? (
                <label className="check small">
                  <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
                  Show archived ({archivedCount})
                </label>
              ) : undefined
            }
          >
            <ul className="tree" aria-label="Organisation structure">
              {flattenUnits(shown).map(({ unit, level }) => {
                const contextOnly = unit.access === 'context';
                return (
                  <li key={unit.id}>
                    <button
                      type="button"
                      className={cx(
                        'tree__item',
                        contextOnly && 'tree__item--context',
                        unit.status === 'archived' && 'tree__item--archived',
                      )}
                      style={{ paddingLeft: 8 + level * 18 }}
                      aria-current={unit.id === selected.id ? 'true' : undefined}
                      disabled={contextOnly}
                      title={contextOnly ? "Shown for context: you don't work here" : undefined}
                      onClick={() => setSelectedId(unit.id)}
                    >
                      <Icon name={unitIcon(unit.type)} size={16} />
                      <span className="tree__name">{unit.name}</span>
                      {unit.status === 'archived' ? <Badge>Archived</Badge> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
        <div className="split__main">
          <UnitDetails key={selected.id} unit={selected} types={typeList} onSelect={setSelectedId} onAction={setDialog} />
        </div>
      </div>

      <UnitFormDialog
        target={dialog?.kind === 'create' || dialog?.kind === 'edit' ? dialog : null}
        types={typeList}
        onClose={close}
        onSaved={(unit) => {
          close();
          setSelectedId(unit.id);
        }}
      />
      <MoveDialog unit={dialog?.kind === 'move' ? dialog.unit : null} types={typeList} onClose={close} />
      <ArchiveDialog unit={dialog?.kind === 'archive' ? dialog.unit : null} onClose={close} />
    </>
  );
}

// ---------- Details ----------

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

function safeHref(value: string): string | null {
  return /^https?:\/\//i.test(value) ? value : null;
}

function displayValue(field: FieldDef, value: unknown): ReactNode {
  const label = (item: unknown) => field.options?.find((option) => String(option.value) === String(item))?.label ?? String(item);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (field.input === 'select') return label(value);
  if (field.input === 'boolean') return value === true ? 'Yes' : 'No';
  if (field.input === 'color' && typeof value === 'string') {
    return (
      <span className="row gap-8">
        <span className="swatch" style={{ background: value }} aria-hidden="true" />
        <span className="mono">{value}</span>
      </span>
    );
  }
  if (field.input === 'url' && typeof value === 'string') {
    const href = safeHref(value);
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {value}
      </a>
    ) : (
      value
    );
  }
  return String(value);
}

function UnitDetails({
  unit,
  types,
  onSelect,
  onAction,
}: {
  unit: OrgUnit;
  types: UnitType[];
  onSelect: (unitId: string) => void;
  onAction: (dialog: DialogState) => void;
}) {
  const { units, unitsById } = useSession();
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () => api.patch<OrgUnit>(`/org/units/${unit.id}`, { status: 'active' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });

  const type = types.find((item) => item.key === unit.type);
  const trail = trailOf(unit, unitsById);
  const children = units.filter((item) => item.parentId === unit.id);
  const parent = unit.parentId ? unitsById.get(unit.parentId) : undefined;
  const manage = unit.access === 'manage';
  const active = unit.status === 'active';
  const isGroup = unit.parentId === null;
  const childTypes = childTypesFor(types, unit.type);
  const details = (type?.fields ?? [])
    .map((field) => ({ field, value: getPath(unit.profile, field.key) }))
    .filter(({ value }) => hasValue(value));

  return (
    <div className="stack gap-16">
      <Card>
        <div className="stack gap-12">
          {trail.length > 1 ? (
            <nav className="breadcrumb" aria-label="Where this unit sits">
              {trail.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 ? <Icon name="chevronRight" size={12} /> : null}
                  {item.id === unit.id || item.access === 'context' ? (
                    <span>{item.name}</span>
                  ) : (
                    <button type="button" className="link-button" onClick={() => onSelect(item.id)}>
                      {item.name}
                    </button>
                  )}
                </Fragment>
              ))}
            </nav>
          ) : null}
          <div className="row gap-12">
            <span className="unit-mark">
              <Icon name={unitIcon(unit.type)} size={20} />
            </span>
            <div className="stack gap-2 grow">
              <h2 className="title-lg">{unit.name}</h2>
              <div className="row gap-8 small muted">
                <span>{unitTypeLabel(types, unit.type)}</span>
                <span className="mono">{unit.code}</span>
                {active ? null : <Badge tone="warning">Archived</Badge>}
                {manage ? null : <Badge>View only</Badge>}
              </div>
            </div>
            {manage ? (
              <div className="row gap-8">
                {active ? (
                  <Button size="sm" icon="edit" onClick={() => onAction({ kind: 'edit', unit })}>
                    Edit
                  </Button>
                ) : null}
                {active && !isGroup && parent?.access === 'manage' ? (
                  <Button size="sm" icon="move" onClick={() => onAction({ kind: 'move', unit })}>
                    Move
                  </Button>
                ) : null}
                {active && !isGroup && parent?.access === 'manage' ? (
                  <Button size="sm" icon="archive" variant="danger" onClick={() => onAction({ kind: 'archive', unit })}>
                    Archive
                  </Button>
                ) : null}
                {!active && parent?.access === 'manage' ? (
                  <Button size="sm" icon="restore" loading={restore.isPending} onClick={() => restore.mutate()}>
                    Restore
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <ErrorAlert error={restore.error} />
        </div>
      </Card>

      <Card title="Details">
        {details.length > 0 ? (
          <dl className="kv">
            {details.map(({ field, value }) => (
              <Fragment key={field.key}>
                <dt>{field.label}</dt>
                <dd>{displayValue(field, value)}</dd>
              </Fragment>
            ))}
            <dt>Added</dt>
            <dd>{formatDate(unit.createdAt)}</dd>
          </dl>
        ) : (
          <p className="muted">
            No details yet.{manage && active ? ' Use Edit to add contact details, branding and more.' : ''}
          </p>
        )}
      </Card>

      <Card
        flush
        title={`Inside ${unit.name}`}
        actions={
          manage && active && childTypes.length > 0 ? (
            <Button size="sm" icon="plus" onClick={() => onAction({ kind: 'create', parent: unit })}>
              Add unit
            </Button>
          ) : undefined
        }
      >
        {children.length === 0 ? (
          <EmptyState icon="layers" title="Nothing inside yet">
            {childTypes.length > 0
              ? `You can add ${childTypes.map((item) => item.pluralLabel.toLowerCase()).join(', ')} here.`
              : `A ${unitTypeLabel(types, unit.type).toLowerCase()} is the lowest level.`}
          </EmptyState>
        ) : (
          <ul className="list list--rows">
            {children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  className="list__item list__item--button"
                  disabled={child.access === 'context'}
                  onClick={() => onSelect(child.id)}
                >
                  <span className="unit-mark unit-mark--sm">
                    <Icon name={unitIcon(child.type)} size={16} />
                  </span>
                  <span className="list__text">
                    <span className="strong">{child.name}</span>
                    <span className="small muted"> · {unitTypeLabel(types, child.type)}</span>
                  </span>
                  {child.status === 'archived' ? <Badge>Archived</Badge> : null}
                  <Icon name="chevronRight" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------- Add and edit ----------

function UnitFormDialog({
  target,
  types,
  onClose,
  onSaved,
}: {
  target: UnitFormTarget | null;
  types: UnitType[];
  onClose: () => void;
  onSaved: (unit: OrgUnit) => void;
}) {
  const title = target?.kind === 'edit' ? `Edit ${target.unit.name}` : target ? `Add a unit to ${target.parent.name}` : '';
  return (
    <Dialog open={target !== null} onClose={onClose} title={title} size="lg">
      {target ? <UnitForm target={target} types={types} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function UnitForm({
  target,
  types,
  onClose,
  onSaved,
}: {
  target: UnitFormTarget;
  types: UnitType[];
  onClose: () => void;
  onSaved: (unit: OrgUnit) => void;
}) {
  const queryClient = useQueryClient();
  const editing = target.kind === 'edit' ? target.unit : null;
  const allowedTypes = target.kind === 'create' ? childTypesFor(types, target.parent.type) : [];
  const [type, setType] = useState(editing?.type ?? allowedTypes[0]?.key ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [code, setCode] = useState(editing?.code ?? '');
  const [codeEdited, setCodeEdited] = useState(editing !== null);
  const [profile, setProfile] = useState<Record<string, unknown>>(editing?.profile ?? {});
  const typeDef = types.find((item) => item.key === type);

  const save = useMutation({
    mutationFn: () => {
      if (target.kind === 'edit') return api.patch<OrgUnit>(`/org/units/${target.unit.id}`, { name, code, profile });
      return api.post<OrgUnit>('/org/units', { parentId: target.parent.id, type, name, code, profile });
    },
    onSuccess: async (unit) => {
      await queryClient.invalidateQueries({ queryKey: keys.me });
      onSaved(unit);
    },
  });

  const errors = fieldErrorsOf(save.error);
  const shownFields = ['type', 'name', 'code', ...(typeDef?.fields ?? []).map((field) => `profile.${field.key}`)];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, shownFields)} />
        <div className="form-grid">
          {target.kind === 'create' ? (
            <Field label="Kind of unit" error={errors.type}>
              {(control) => (
                <select
                  {...control}
                  className="select"
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value);
                    setProfile({});
                  }}
                >
                  {allowedTypes.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input
                {...control}
                className="input"
                required
                autoFocus
                maxLength={120}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!codeEdited) setCode(slugify(event.target.value));
                }}
              />
            )}
          </Field>
          <Field label="Code" hint="Short and unique among its neighbours. Used in links and reports." error={errors.code}>
            {(control) => (
              <input
                {...control}
                className="input mono"
                required
                maxLength={40}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setCodeEdited(true);
                }}
              />
            )}
          </Field>
        </div>
        {typeDef && typeDef.fields.length > 0 ? (
          <>
            <hr className="divider" />
            <p className="section-title">{typeDef.label} details</p>
            <div className="form-grid">
              {typeDef.fields.map((field) => (
                <DynamicField
                  key={field.key}
                  field={field}
                  value={getPath(profile, field.key)}
                  onChange={(value) => setProfile((current) => setPath(current, field.key, value))}
                  error={errors[`profile.${field.key}`]}
                />
              ))}
            </div>
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {editing ? 'Save changes' : 'Add unit'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------- Move ----------

function MoveDialog({ unit, types, onClose }: { unit: OrgUnit | null; types: UnitType[]; onClose: () => void }) {
  return (
    <Dialog
      open={unit !== null}
      onClose={onClose}
      title={unit ? `Move ${unit.name}` : ''}
      description="Everything inside moves with it, and people keep their roles."
    >
      {unit ? <MoveForm unit={unit} types={types} onClose={onClose} /> : null}
    </Dialog>
  );
}

function MoveForm({ unit, types, onClose }: { unit: OrgUnit; types: UnitType[]; onClose: () => void }) {
  const { units } = useSession();
  const queryClient = useQueryClient();
  const allowedParents = types.find((item) => item.key === unit.type)?.parents ?? [];
  const candidates = units.filter(
    (item) =>
      item.access === 'manage' &&
      item.status === 'active' &&
      item.groupId === unit.groupId &&
      item.id !== unit.parentId &&
      !item.path.startsWith(unit.path) &&
      allowedParents.includes(item.type),
  );
  const [parentId, setParentId] = useState(candidates[0]?.id ?? '');
  const move = useMutation({
    mutationFn: () => api.post<OrgUnit>(`/org/units/${unit.id}/move`, { parentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.me });
      onClose();
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        move.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={move.error} />
        {candidates.length === 0 ? (
          <p className="muted">
            There&apos;s nowhere else you can move this {unitTypeLabel(types, unit.type).toLowerCase()}. It can only sit under{' '}
            {allowedParents.map((key) => unitTypeLabel(types, key).toLowerCase()).join(' or ')} units that you manage.
          </p>
        ) : (
          <Field label="Move into">
            {(control) => <UnitSelect control={control} units={candidates} value={parentId} onChange={setParentId} types={types} />}
          </Field>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={move.isPending} disabled={!parentId}>
          Move
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------- Archive ----------

function ArchiveDialog({ unit, onClose }: { unit: OrgUnit | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: (target: OrgUnit) => api.patch<OrgUnit>(`/org/units/${target.id}`, { status: 'archived' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.me });
      onClose();
    },
  });
  const close = () => {
    archive.reset();
    onClose();
  };

  return (
    <ConfirmDialog
      open={unit !== null}
      onClose={close}
      title={unit ? `Archive ${unit.name}?` : ''}
      confirmLabel="Archive"
      danger
      pending={archive.isPending}
      error={archive.error}
      onConfirm={() => {
        if (unit) archive.mutate(unit);
      }}
    >
      <p>It disappears from lists, and roles given here stop working until it&apos;s restored.</p>
      <p className="muted">Units inside it need to be archived or moved first. You can restore it at any time.</p>
    </ConfirmDialog>
  );
}
