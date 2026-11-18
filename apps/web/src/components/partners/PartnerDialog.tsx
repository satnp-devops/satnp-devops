'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { UnitSelect } from '@/components/UnitSelect';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { partnerKeys, usePartnerOwners, usePlans } from '@/lib/partners/queries';
import type { PartnerDetail, PartnerInput, PartnerKind } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { companyOf } from './Parts';

const FIELDS = ['unitId', 'kind', 'name', 'code', 'legalName', 'email', 'phone', 'city', 'ownerUserId', 'status', 'commissionPlanId'];

/** Add a broker or referral partner at a unit (or link an existing one with the same email or phone). */
export function PartnerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add a partner"
      description="A broker, agency or person who refers families or institutes. Someone already known to another company is linked, not duplicated."
    >
      {open ? <PartnerForm onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function PartnerForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { scope, workUnits, unitsById, can } = useSession();
  const queryClient = useQueryClient();
  const units = workUnits.filter((u) => u.path.startsWith(scope.path) && u.type !== 'group' && can('partners.manage', u) && companyOf(u, unitsById));
  const [unitId, setUnitId] = useState(units[0]?.id ?? '');
  const [kind, setKind] = useState<PartnerKind>('organisation');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [status, setStatus] = useState<'active' | 'pending'>('active');
  const [planId, setPlanId] = useState('');
  const company = companyOf(unitsById.get(unitId), unitsById);
  const owners = usePartnerOwners(unitId || null);
  const plans = usePlans({ companyId: company?.id }, Boolean(company));

  const save = useMutation({
    mutationFn: () => {
      const body: PartnerInput = {
        unitId,
        kind,
        name,
        code: code.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        city: city.trim() || undefined,
        ownerUserId: ownerUserId || undefined,
        status,
        commissionPlanId: planId || undefined,
      };
      return api.post<PartnerDetail>('/partners', body);
    },
    onSuccess: (partner) => {
      void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
      onClose();
      onCreated(partner.id);
    },
  });
  const errors = fieldErrorsOf(save.error);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, FIELDS)} />
        <div className="form-grid">
          <Field label="Belongs to" hint={company ? `Partner of ${company.name}` : undefined} error={errors.unitId}>
            {(control) => <UnitSelect control={control} units={units} value={unitId} onChange={setUnitId} placeholder="Pick a unit" />}
          </Field>
          <fieldset className="field partners-fieldset">
            <legend className="field__label">Kind</legend>
            <div className="partners-radio">
              {(['organisation', 'person'] as const).map((value) => (
                <label key={value}>
                  <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
                  {value === 'organisation' ? 'Agency or company' : 'Person'}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Name" error={errors.name}>
            {(control) => <input {...control} className="input" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Partner code" optional hint="What their forms and spreadsheets carry, like edupath-advisors" error={errors.code}>
            {(control) => <input {...control} className="input mono" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Field label="Email" optional error={errors.email}>
            {(control) => <input {...control} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Phone" optional error={errors.phone}>
            {(control) => <input {...control} className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
          </Field>
          <Field label="City" optional error={errors.city}>
            {(control) => <input {...control} className="input" maxLength={100} value={city} onChange={(e) => setCity(e.target.value)} />}
          </Field>
          <Field label="Their counsellor" optional hint="Leads from this partner go to this person" error={errors.ownerUserId}>
            {(control) => (
              <select {...control} className="select" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
                <option value="">Assign as usual</option>
                {(owners.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Status" error={errors.status}>
            {(control) => (
              <select {...control} className="select" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'pending')}>
                <option value="active">Active: links work and commissions accrue</option>
                <option value="pending">Pending: agreement not signed yet</option>
              </select>
            )}
          </Field>
          <Field label="Commission plan" optional hint="Leave empty to match plans by product line" error={errors.commissionPlanId}>
            {(control) => (
              <select {...control} className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                <option value="">Match by product line</option>
                {(plans.data ?? [])
                  .filter((p) => p.active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={!unitId || !name.trim()}>
          Add partner
        </Button>
      </DialogFooter>
    </form>
  );
}
