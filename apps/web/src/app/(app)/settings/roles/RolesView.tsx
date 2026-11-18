'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Guard } from '@/components/Guard';
import { Alert, Badge, Button, Card, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { plural } from '@/lib/format';
import { expandPermissions } from '@/lib/permissions';
import { keys, usePermissionCatalog, useRoles } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { PermissionGroup, Role } from '@/lib/types';
import { PermissionMatrix } from './PermissionMatrix';

export function RolesView() {
  return (
    <Guard anyOf={['roles.view', 'users.manage']} anywhere>
      <Roles />
    </Guard>
  );
}

interface Draft {
  name: string;
  description: string;
  permissions: Set<string>;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((key) => b.has(key));

function Roles() {
  const { scope, unitsById, can } = useSession();
  const group = unitsById.get(scope.groupId);
  const roles = useRoles(scope.groupId);
  const catalog = usePermissionCatalog();
  const canManage = group ? can('roles.manage', group) : false;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  if (roles.isPending || catalog.isPending) return <PageLoading />;
  if (roles.isError || catalog.isError) return <ErrorAlert error={roles.error ?? catalog.error} />;

  const selected = roles.data.find((role) => role.id === selectedId) ?? roles.data[0];
  const builtIn = roles.data.filter((role) => role.isSystem);
  const custom = roles.data.filter((role) => !role.isSystem);

  const roleButton = (role: Role) => (
    <li key={role.id}>
      <button
        type="button"
        className="tree__item"
        aria-current={role.id === selected?.id ? 'true' : undefined}
        onClick={() => setSelectedId(role.id)}
      >
        <span className="tree__name">{role.name}</span>
        <span className="small muted">{role.peopleCount ?? 0}</span>
      </button>
    </li>
  );

  return (
    <>
      <div className="split">
        <div className="split__side">
          <Card
            flush
            title="Roles"
            description={`For everyone in ${group?.name ?? 'this group'}`}
            actions={
              canManage ? (
                <Button
                  size="sm"
                  icon="plus"
                  onClick={() => setDraft({ name: '', description: '', permissions: new Set() })}
                >
                  New role
                </Button>
              ) : undefined
            }
          >
            <p className="list-heading">Built in</p>
            <ul className="tree">{builtIn.map(roleButton)}</ul>
            <p className="list-heading">Made by your team</p>
            {custom.length ? (
              <ul className="tree">{custom.map(roleButton)}</ul>
            ) : (
              <p className="small muted list-note">None yet. Duplicate a built-in role to make your own.</p>
            )}
          </Card>
        </div>
        <div className="split__main">
          {selected ? (
            <RoleEditor
              key={selected.id}
              role={selected}
              catalog={catalog.data}
              canManage={canManage}
              onDuplicate={() =>
                setDraft({
                  name: `${selected.name} (copy)`,
                  description: selected.description ?? '',
                  permissions: expandPermissions(selected.permissions, catalog.data),
                })
              }
              onDeleted={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      </div>
      <NewRoleDialog
        draft={draft}
        groupId={scope.groupId}
        catalog={catalog.data}
        onClose={() => setDraft(null)}
        onCreated={(role) => {
          setDraft(null);
          setSelectedId(role.id);
        }}
      />
    </>
  );
}

function RoleEditor({
  role,
  catalog,
  canManage,
  onDuplicate,
  onDeleted,
}: {
  role: Role;
  catalog: PermissionGroup[];
  canManage: boolean;
  onDuplicate: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const editable = canManage && !role.isSystem;
  const fullAccess = role.permissions.includes('*');
  const original = useMemo(() => expandPermissions(role.permissions, catalog), [role.permissions, catalog]);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');
  const [permissions, setPermissions] = useState<Set<string>>(original);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = name !== role.name || description !== (role.description ?? '') || !sameSet(permissions, original);
  const count = role.peopleCount ?? 0;

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.rolesAll });
  const save = useMutation({
    mutationFn: () => api.patch<Role>(`/roles/${role.id}`, { name, description, permissions: [...permissions].sort() }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/roles/${role.id}`),
    onSuccess: async () => {
      await refresh();
      onDeleted();
    },
  });
  const errors = fieldErrorsOf(save.error);

  return (
    <form
      className="stack gap-16"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <div className="stack gap-12">
          <div className="row gap-8">
            <div className="stack gap-2 grow">
              <h2 className="title-lg">{role.name}</h2>
              <div className="row gap-8 small muted">
                {role.isSystem ? <Badge>Built in</Badge> : <Badge tone="accent">Custom</Badge>}
                <span>{plural(count, 'person', 'people')} in this group</span>
              </div>
            </div>
            {canManage ? (
              <Button size="sm" icon="copy" onClick={onDuplicate}>
                Duplicate
              </Button>
            ) : null}
            {editable ? (
              <Button size="sm" icon="trash" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ) : null}
          </div>
          {editable ? (
            <div className="form-grid">
              <Field label="Name" error={errors.name}>
                {(control) => <input {...control} className="input" required value={name} onChange={(event) => setName(event.target.value)} />}
              </Field>
              <Field label="Description" optional error={errors.description}>
                {(control) => (
                  <input {...control} className="input" maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} />
                )}
              </Field>
            </div>
          ) : role.description ? (
            <p className="muted">{role.description}</p>
          ) : null}
          {role.isSystem ? (
            <p className="small muted">
              Built-in roles grow automatically as new modules are added. Duplicate one to make a version you can change.
            </p>
          ) : null}
        </div>
      </Card>

      {fullAccess ? (
        <Alert tone="info" title="Full access">
          Everything in the group, including permissions that future modules add.
        </Alert>
      ) : null}

      <Card title="What this role can do" description="Applies at the unit where it's given and everything under it.">
        <PermissionMatrix catalog={catalog} value={permissions} onChange={editable ? setPermissions : undefined} />
      </Card>

      {editable ? (
        <div className="sticky-actions">
          <ErrorAlert error={formErrorOf(save.error, ['name', 'description'])} />
          <div className="row gap-8">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              Save changes
            </Button>
            {dirty ? (
              <Button
                onClick={() => {
                  setName(role.name);
                  setDescription(role.description ?? '');
                  setPermissions(original);
                  save.reset();
                }}
              >
                Discard
              </Button>
            ) : save.isSuccess ? (
              <span className="small muted">Saved. People with this role get the change straight away.</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
          remove.reset();
        }}
        title={`Delete ${role.name}?`}
        confirmLabel="Delete role"
        danger
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate()}
      >
        <p>
          {count > 0
            ? `${plural(count, 'person has', 'people have')} this role. Remove it from them first, from the People page.`
            : 'Nobody has this role, so nobody loses access.'}
        </p>
      </ConfirmDialog>
    </form>
  );
}

function NewRoleDialog({
  draft,
  groupId,
  catalog,
  onClose,
  onCreated,
}: {
  draft: Draft | null;
  groupId: string;
  catalog: PermissionGroup[];
  onClose: () => void;
  onCreated: (role: Role) => void;
}) {
  return (
    <Dialog
      open={draft !== null}
      onClose={onClose}
      size="lg"
      title="New role"
      description="You can only include permissions you hold yourself."
    >
      {draft ? <NewRoleForm draft={draft} groupId={groupId} catalog={catalog} onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function NewRoleForm({
  draft,
  groupId,
  catalog,
  onClose,
  onCreated,
}: {
  draft: Draft;
  groupId: string;
  catalog: PermissionGroup[];
  onClose: () => void;
  onCreated: (role: Role) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [permissions, setPermissions] = useState<Set<string>>(draft.permissions);
  const create = useMutation({
    mutationFn: () =>
      api.post<Role>('/roles', { groupId, name, description: description || undefined, permissions: [...permissions].sort() }),
    onSuccess: async (role) => {
      await queryClient.invalidateQueries({ queryKey: keys.rolesAll });
      onCreated(role);
    },
  });
  const errors = fieldErrorsOf(create.error);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(create.error, ['name', 'description'])} />
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input {...control} className="input" required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field label="Description" optional error={errors.description}>
            {(control) => (
              <input {...control} className="input" maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} />
            )}
          </Field>
        </div>
        <PermissionMatrix catalog={catalog} value={permissions} onChange={setPermissions} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create role
        </Button>
      </DialogFooter>
    </form>
  );
}
