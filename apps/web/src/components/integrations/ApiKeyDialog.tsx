'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, CopyButton, ErrorAlert, Field, FieldGroup, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { ownerChoices } from '@/lib/integrations/display';
import { integrationKeys, useGrantableScopes } from '@/lib/integrations/queries';
import type { CreatedApiKey } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';

/** End of the chosen day in UTC, so "expires on 31 Dec" means the whole day. */
const endOfDayUtc = (date: string) => `${date}T23:59:59Z`;

/**
 * Create an API key: where it applies, what it may do, an optional expiry. The key is shown once
 * after creation; only its hash is stored.
 */
export function ApiKeyDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const owners = useMemo(() => ownerChoices(session, 'api_keys.manage'), [session]);
  const [unitId, setUnitId] = useState(owners.find((u) => u.type === 'company')?.id ?? owners[0]?.id ?? '');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const grantable = useGrantableScopes(unitId || null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const save = useMutation({
    mutationFn: () => api.post<CreatedApiKey>('/api-keys', { unitId, name, scopes, ...(expires ? { expiresAt: endOfDayUtc(expires) } : {}) }),
    onSuccess: async (key) => {
      setCreated(key);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.apiKeysAll });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const scopeError = errors.scopes ?? Object.entries(errors).find(([key]) => key.startsWith('scopes.'))?.[1];

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const toggle = (key: string, on: boolean) => setScopes((current) => (on ? [...current, key] : current.filter((s) => s !== key)));

  if (created) {
    return (
      <Dialog open onClose={onClose} title="Copy your API key now" description={`${created.name} · ${created.unit?.name ?? ''}`}>
        <DialogBody>
          <div className="stack gap-16">
            <Alert tone="warning" title="You won't see this key again">
              Store it in the system that will use it (an environment variable or secret store). If it is lost, revoke it and create another.
            </Alert>
            <div className="int-secret">
              <code className="mono int-secret__value" aria-label="API key">
                {created.secret}
              </code>
              <CopyButton text={created.secret} label="Copy key" />
            </div>
            <div className="stack gap-6">
              <p className="small muted">Send it in the Authorization header. Writes need no X-Phoenix-Client header.</p>
              <pre className="code-pre int-payload">{`curl -H "Authorization: Bearer ${created.prefix}…" \\\n  "$PHOENIX_URL/api/v1/integrations/connections?unitId=${created.unit?.id ?? ''}"`}</pre>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} size="lg" title="Create an API key" description="For websites, scripts and partner systems. A key can do only what you tick, only where it applies.">
      <form onSubmit={submit} noValidate>
        <DialogBody>
          <div className="stack gap-16">
            <ErrorAlert error={formErrorOf(save.error, ['unitId', 'name', 'scopes', 'expiresAt', ...scopes.map((_, i) => `scopes.${i}`)])} />
            <div className="form-grid">
              <Field label="Name" hint="What uses it, e.g. SatnPaper website forms" error={errors.name}>
                {(control) => <input {...control} className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
              </Field>
              <Field label="Applies to" error={errors.unitId}>
                {(control) => (
                  <select
                    {...control}
                    className="select"
                    value={unitId}
                    onChange={(e) => {
                      setUnitId(e.target.value);
                      setScopes([]);
                    }}
                  >
                    {owners.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.type === 'group' ? `${unit.name} (every company)` : unit.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Expires on" optional hint="Leave blank for a key that lasts until it is revoked." error={errors.expiresAt}>
                {(control) => <input {...control} type="date" className="input" value={expires} onChange={(e) => setExpires(e.target.value)} />}
              </Field>
            </div>
            <FieldGroup label="Permissions" hint="Only permissions you hold here are listed. Keys can never manage API keys." error={scopeError}>
              {grantable.isPending ? (
                <Spinner label="Loading permissions" />
              ) : grantable.isError ? (
                <ErrorAlert error={grantable.error} />
              ) : (
                <div className="int-scopes">
                  {grantable.data.map((group) => (
                    <div key={group.module} className="int-scopes__group">
                      <p className="int-scopes__title">{group.label}</p>
                      {group.permissions.map((p) => (
                        <label key={p.key} className="check int-scope">
                          <input type="checkbox" checked={scopes.includes(p.key)} onChange={(e) => toggle(p.key, e.target.checked)} />
                          <span>
                            {p.label} <span className="mono small muted">{p.key}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </FieldGroup>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!unitId || !name.trim() || scopes.length === 0}>
            Create key
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
