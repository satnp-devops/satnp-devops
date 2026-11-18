'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field, FieldGroup } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { groupCompanies, identityLabel, ownerChoices } from '@/lib/integrations/display';
import { integrationKeys } from '@/lib/integrations/queries';
import type { ChannelIdentity, Connection, IntegrationCatalog } from '@/lib/integrations/types';
import { useSession } from '@/lib/session';

const SHARED = 'shared';

/**
 * Register a channel enquiries arrive on (a WhatsApp number, an inbox, a form, a lead-ad page, a
 * partner link prefix) for the company that owns it, or as shared by several companies.
 */
export function ChannelDialog({ catalog, connections, onClose }: { catalog: IntegrationCatalog; connections: Connection[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const owners = useMemo(() => ownerChoices(session, 'integrations.manage'), [session]);
  const companyOwners = owners.filter((u) => u.type === 'company');
  const canShare = owners.some((u) => u.type === 'group');
  const companies = groupCompanies(session);
  const [type, setType] = useState(catalog.identityTypes[0]?.key ?? 'website_form');
  const [identity, setIdentity] = useState('');
  const [label, setLabel] = useState('');
  const [owner, setOwner] = useState(companyOwners[0]?.id ?? (canShare ? SHARED : ''));
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const hint = catalog.identityTypes.find((t) => t.key === type)?.hint ?? '';
  const routeTo = owner === SHARED ? sharedIds : owner ? [owner] : [];

  // Connections that can carry this type and serve every company it routes to.
  const carriers = connections.filter(
    (c) =>
      c.status === 'active' &&
      (catalog.kindIdentityTypes[c.kind] ?? []).includes(type) &&
      routeTo.length > 0 &&
      routeTo.every((id) => c.companies.some((co) => co.id === id)),
  );

  const save = useMutation({
    mutationFn: () =>
      api.post<ChannelIdentity>('/integrations/identities', {
        type,
        identity,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(owner === SHARED ? { shared: true, companyIds: sharedIds } : { companyId: owner }),
        ...(connectionId && carriers.some((c) => c.id === connectionId) ? { connectionId } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open onClose={onClose} title="Add a channel" description="Enquiries that arrive on it go to the company that owns it. On a shared channel, intake works out the company.">
      <form onSubmit={submit} noValidate>
        <DialogBody>
          <div className="stack gap-16">
            <ErrorAlert error={formErrorOf(save.error, ['type', 'identity', 'label', 'companyId', 'companyIds', 'connectionId'])} />
            <div className="form-grid">
              <Field label="Channel" error={errors.type}>
                {(control) => (
                  <select {...control} className="select" value={type} onChange={(e) => setType(e.target.value)}>
                    {catalog.identityTypes.map((t) => (
                      <option key={t.key} value={t.key}>
                        {identityLabel(t.key)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Number, inbox, form or link" hint={hint} error={errors.identity}>
                {(control) => <input {...control} className="input mono" value={identity} maxLength={300} autoComplete="off" onChange={(e) => setIdentity(e.target.value)} />}
              </Field>
              <Field label="Label" optional hint="Shown in the lead's source, e.g. SAT landing page" error={errors.label}>
                {(control) => <input {...control} className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}
              </Field>
              <Field label="Belongs to" error={errors.companyId}>
                {(control) => (
                  <select {...control} className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
                    {companyOwners.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                    {canShare ? <option value={SHARED}>Shared by several companies</option> : null}
                  </select>
                )}
              </Field>
            </div>
            {owner === SHARED ? (
              <FieldGroup label="Companies it may route to" hint="Pick two or more." error={errors.companyIds}>
                <div className="row gap-8">
                  {companies.map((company) => (
                    <label key={company.id} className="chip-toggle">
                      <input
                        type="checkbox"
                        checked={sharedIds.includes(company.id)}
                        onChange={(e) => setSharedIds((ids) => (e.target.checked ? [...ids, company.id] : ids.filter((id) => id !== company.id)))}
                      />
                      {company.name}
                    </label>
                  ))}
                </div>
              </FieldGroup>
            ) : null}
            {carriers.length > 0 ? (
              <Field label="Connection" optional hint="The provider account this number or inbox belongs to." error={errors.connectionId}>
                {(control) => (
                  <select {...control} className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                    <option value="">None</option>
                    {carriers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.providerLabel})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!identity.trim() || !owner}>
            Add channel
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
