'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { DynamicField } from '@/components/DynamicField';
import { Alert, Badge, Button, ErrorAlert, Field, FieldGroup, cx } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { groupCompanies, ownerChoices } from '@/lib/integrations/display';
import { integrationKeys } from '@/lib/integrations/queries';
import type { Connection, KindInfo, ProviderField, ProviderInfo } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';
import type { FieldDef } from '@/lib/types';

type Values = Record<string, unknown>;

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

function initialValues(provider: ProviderInfo, connection: Connection | null): Values {
  const values: Values = {};
  for (const field of provider.fields) {
    if (field.secret) values[field.key] = '';
    else if (connection) values[field.key] = connection.config[field.key] ?? (field.input === 'boolean' ? false : '');
    else values[field.key] = field.default ?? (field.input === 'boolean' ? false : '');
  }
  return values;
}

const asFieldDef = (field: ProviderField): FieldDef => ({
  key: field.key,
  label: field.required ? `${field.label} *` : field.label,
  input: field.input,
  placeholder: field.placeholder,
  help: field.help,
  options: field.options,
});

/** A secret: typed, never shown back. When editing, blank keeps the saved value. */
function SecretField({ field, value, hint, error, onChange }: { field: ProviderField; value: string; hint?: string; error?: string; onChange: (value: string) => void }) {
  const saved = hint ? `Saved (${hint}). Leave blank to keep it.` : null;
  return (
    <Field label={field.required && !hint ? `${field.label} *` : field.label} hint={[field.help, saved].filter(Boolean).join(' ')} error={error}>
      {(control) =>
        field.input === 'textarea' ? (
          <textarea {...control} className="textarea mono" rows={3} value={value} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input
            {...control}
            type="password"
            className="input mono"
            value={value}
            placeholder={hint ?? field.placeholder}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      }
    </Field>
  );
}

/**
 * Connect a provider for a kind, or change a connection. The form is built from the provider's
 * field definitions (GET /integrations/kinds): plain fields are config, secret ones go into the
 * encrypted credentials and are never sent back.
 */
export function ConnectionDialog({ kind, connection, onClose }: { kind: KindInfo; connection: Connection | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const owners = useMemo(() => ownerChoices(session, 'integrations.manage'), [session]);
  const editing = connection !== null;
  const firstProvider = kind.providers.find((p) => p.key === connection?.provider) ?? kind.providers[0];
  const [providerKey, setProviderKey] = useState(firstProvider?.key ?? '');
  const provider = kind.providers.find((p) => p.key === providerKey) ?? firstProvider;
  const [ownerId, setOwnerId] = useState(connection?.owner?.id ?? owners[0]?.id ?? '');
  const owner = session.unitsById.get(ownerId);
  const [name, setName] = useState(connection?.name ?? (provider ? provider.label : ''));
  const [values, setValues] = useState<Values>(() => (provider ? initialValues(provider, connection) : {}));
  const [status, setStatus] = useState<Connection['status']>(connection?.status ?? 'active');
  const companies = groupCompanies(session);
  const [companyIds, setCompanyIds] = useState<string[]>(connection ? connection.companies.map((c) => c.id) : companies.map((c) => c.id));

  const save = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error('Pick a provider');
      const plain = provider.fields.filter((f) => !f.secret);
      const secrets = provider.fields.filter((f) => f.secret);
      const sharedCompanies = owner?.type === 'group' ? { companyIds } : {};
      if (!connection) {
        const config = Object.fromEntries(plain.filter((f) => !isBlank(values[f.key])).map((f) => [f.key, values[f.key]]));
        const credentials = Object.fromEntries(secrets.filter((f) => !isBlank(values[f.key])).map((f) => [f.key, values[f.key]]));
        return api.post<Connection>('/integrations/connections', { unitId: ownerId, kind: kind.key, provider: provider.key, name, config, credentials, ...sharedCompanies });
      }
      // Only what changed: blank clears an optional field, untouched secrets are kept.
      const config: Values = {};
      for (const field of plain) {
        const before = connection.config[field.key];
        const after = values[field.key];
        if (isBlank(after) && !isBlank(before)) config[field.key] = null;
        else if (!isBlank(after) && after !== before) config[field.key] = after;
      }
      const credentials = Object.fromEntries(secrets.filter((f) => !isBlank(values[f.key])).map((f) => [f.key, values[f.key]]));
      return api.patch<Connection>(`/integrations/connections/${connection.id}`, {
        ...(name !== connection.name ? { name } : {}),
        ...(Object.keys(config).length ? { config } : {}),
        ...(Object.keys(credentials).length ? { credentials } : {}),
        ...(status !== connection.status ? { status } : {}),
        ...(connection.shared ? { companyIds } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      onClose();
    },
  });

  const errors = fieldErrorsOf(save.error);
  const shown = ['name', 'companyIds', ...(provider?.fields ?? []).map((f) => `${f.secret ? 'credentials' : 'config'}.${f.key}`)];

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const setValue = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  function chooseProvider(next: ProviderInfo) {
    setProviderKey(next.key);
    setValues(initialValues(next, null));
    if (!name || kind.providers.some((p) => p.label === name)) setName(next.label);
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={editing ? `Change ${connection.name}` : `Connect ${kind.label}`} description={kind.description}>
      <form onSubmit={submit} noValidate>
        <DialogBody>
          <div className="stack gap-16">
            <ErrorAlert error={formErrorOf(save.error, shown)} />
            {!editing ? (
              <FieldGroup label="Provider">
                <div className="int-providers">
                  {kind.providers.map((p) => (
                    <label key={p.key} className={cx('int-provider', p.key === providerKey && 'int-provider--on')}>
                      <input type="radio" name="provider" value={p.key} checked={p.key === providerKey} onChange={() => chooseProvider(p)} />
                      <span className="int-provider__text">
                        <span className="row gap-6">
                          <span className="strong">{p.label}</span>
                          {p.mock ? <Badge tone="accent">Mock</Badge> : null}
                          {!p.implemented ? <Badge tone="warning">Adapter coming</Badge> : null}
                        </span>
                        <span className="small muted">{p.vendor} · {p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </FieldGroup>
            ) : null}
            {provider && !provider.implemented ? (
              <Alert tone="warning" title={`${provider.label} is not wired up yet`}>
                You can save its credentials now. Calls fail with a clear &ldquo;not implemented&rdquo; error until its adapter ships; keep a mock as the default meanwhile.
              </Alert>
            ) : null}
            <div className="form-grid">
              {!editing && owners.length > 1 ? (
                <Field label="Used by">
                  {(control) => (
                    <select {...control} className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                      {owners.map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.type === 'group' ? `Several companies (shared from ${unit.name})` : unit.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
              <Field label="Name" hint="How people will recognise it, e.g. Admissions WhatsApp" error={errors.name}>
                {(control) => <input {...control} className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
              </Field>
            </div>
            {owner?.type === 'group' ? (
              <FieldGroup label="Companies that use it" error={errors.companyIds} hint="Each one keeps its own default; this connection becomes the default only where none is set.">
                <div className="row gap-8">
                  {companies.map((company) => (
                    <label key={company.id} className="chip-toggle">
                      <input
                        type="checkbox"
                        checked={companyIds.includes(company.id)}
                        onChange={(e) => setCompanyIds((ids) => (e.target.checked ? [...ids, company.id] : ids.filter((id) => id !== company.id)))}
                      />
                      {company.name}
                    </label>
                  ))}
                </div>
              </FieldGroup>
            ) : null}
            {provider ? (
              <div className="form-grid">
                {provider.fields.map((field) =>
                  field.secret ? (
                    <SecretField
                      key={`${provider.key}:${field.key}`}
                      field={field}
                      value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
                      hint={connection?.credentials[field.key]}
                      error={errors[`credentials.${field.key}`]}
                      onChange={(value) => setValue(field.key, value)}
                    />
                  ) : (
                    <DynamicField
                      key={`${provider.key}:${field.key}`}
                      field={asFieldDef(field)}
                      value={values[field.key]}
                      error={errors[`config.${field.key}`]}
                      onChange={(value) => setValue(field.key, value)}
                    />
                  ),
                )}
              </div>
            ) : null}
            {editing ? (
              <FieldGroup label="Status">
                <label className="check">
                  <input type="checkbox" checked={status === 'active'} onChange={(e) => setStatus(e.target.checked ? 'active' : 'disabled')} />
                  <span>Active (a disabled connection is nobody&apos;s default and refuses calls)</span>
                </label>
              </FieldGroup>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!provider || !ownerId}>
            {editing ? 'Save changes' : 'Connect'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
