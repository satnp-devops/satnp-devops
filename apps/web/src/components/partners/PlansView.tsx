'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Section, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { toMajorUnits, toMinorUnits } from '@/lib/crm/format';
import { planSummary } from '@/lib/partners/format';
import { partnerKeys, usePlans } from '@/lib/partners/queries';
import type { CommissionPlan, CommissionPlanInput, PlanBasis, PlanTrigger } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { companiesInScope } from './Parts';

// Settings › Partner programmes: commission plans per company. Which partner earns (first or last
// touch), holding commissions during the clawback window and the default landing page are
// settings under Settings › General (category "Partner programmes").

export function PlansView() {
  const { scope, units, unitsById, can, canAnywhere } = useSession();
  const companies = companiesInScope(scope, units, unitsById).filter((c) => canAnywhere('partners.view', c));
  const plans = usePlans({ unitId: scope.id });
  const [editing, setEditing] = useState<{ companyId: string; plan: CommissionPlan | null } | null>(null);

  if (plans.isPending) return <Spinner />;
  if (plans.isError) return <ErrorAlert error={plans.error} />;
  if (companies.length === 0) {
    return <EmptyState icon="handshake" title="Pick a company">Commission plans belong to a company. Choose one in “Working in”.</EmptyState>;
  }
  return (
    <div className="stack gap-16">
      <p className="small muted">
        A lead’s commission comes from the plan set on the partnership, else the plan for the lead’s product line, else the company-wide plan. Who earns it (first or last touch) and
        whether payouts wait for the clawback window are in <Link href="/settings/general">General settings</Link>.
      </p>
      {companies.map((company) => {
        const rows = (plans.data ?? []).filter((p) => p.companyId === company.id);
        const canManage = can('partners.manage_plans', company);
        return (
          <Section
            key={company.id}
            title={company.name}
            count={rows.length}
            flush
            actions={
              canManage ? (
                <Button size="sm" icon="plus" onClick={() => setEditing({ companyId: company.id, plan: null })}>
                  New plan
                </Button>
              ) : null
            }
          >
            {rows.length === 0 ? (
              <p className="small muted partners-empty-row">
                No plans yet: referred leads earn nothing until there is one.
              </p>
            ) : (
              <ul className="partners-list">
                {rows.map((plan) => (
                  <li key={plan.id}>
                    <div className="partners-list__text">
                      <p className="partners-list__title">
                        {plan.name} {plan.active ? null : <StatusPill tone="neutral">Off</StatusPill>}
                      </p>
                      <p className="partners-sub">
                        {plan.productLine ? `${plan.productLine.name} · ` : 'Every product line · '}
                        {planSummary(plan)}
                      </p>
                      {plan.description ? <p className="small">{plan.description}</p> : null}
                    </div>
                    {canManage ? (
                      <Button size="sm" icon="edit" onClick={() => setEditing({ companyId: company.id, plan })} aria-label={`Change ${plan.name}`}>
                        Change
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      })}
      <PlanDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function PlanDialog({ editing, onClose }: { editing: { companyId: string; plan: CommissionPlan | null } | null; onClose: () => void }) {
  return (
    <Dialog open={editing !== null} onClose={onClose} size="lg" title={editing?.plan ? `Change ${editing.plan.name}` : 'New commission plan'} description="Changes apply to commissions earned from now on; earlier ones keep their terms.">
      {editing ? <PlanForm companyId={editing.companyId} plan={editing.plan} onClose={onClose} /> : null}
    </Dialog>
  );
}

function PlanForm({ companyId, plan, onClose }: { companyId: string; plan: CommissionPlan | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const lines = useQuery({
    queryKey: ['partners', 'product-lines', companyId],
    queryFn: () => api.get<Array<{ id: string; name: string; active: boolean }>>('/product-lines', { companyId }),
    retry: false,
  });
  const currency = plan?.currency ?? 'INR';
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [productLineId, setProductLineId] = useState(plan?.productLine?.id ?? '');
  const [basis, setBasis] = useState<PlanBasis>(plan?.basis ?? 'percent');
  const [rate, setRate] = useState(plan?.rateBps ? String(plan.rateBps / 100) : '10');
  const [fixed, setFixed] = useState(plan?.fixed ? String(toMajorUnits(plan.fixed.valueMinor, currency)) : '');
  const [cap, setCap] = useState(plan?.cap ? String(toMajorUnits(plan.cap.valueMinor, currency)) : '');
  const [trigger, setTrigger] = useState<PlanTrigger>(plan?.trigger ?? 'first_payment');
  const [clawbackDays, setClawbackDays] = useState(String(plan?.clawbackDays ?? 30));
  const [active, setActive] = useState(plan?.active ?? true);

  const save = useMutation({
    mutationFn: () => {
      const capMinor = cap.trim() ? toMinorUnits(Number(cap), currency) : null;
      const body: CommissionPlanInput = {
        name,
        description: description.trim() || null,
        productLineId: productLineId || null,
        basis,
        rateBps: basis === 'percent' ? Math.round(Number(rate) * 100) : null,
        fixedMinor: basis === 'fixed' && fixed.trim() ? toMinorUnits(Number(fixed), currency) : null,
        currency: basis === 'fixed' || capMinor ? currency : null,
        trigger,
        clawbackDays: Number(clawbackDays),
        capMinor,
        active,
      };
      return plan ? api.patch<CommissionPlan>(`/commission-plans/${plan.id}`, body) : api.post<CommissionPlan>('/commission-plans', { ...body, companyId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
      onClose();
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
        <ErrorAlert error={formErrorOf(save.error, ['name', 'description', 'productLineId', 'basis', 'rateBps', 'fixedMinor', 'currency', 'trigger', 'clawbackDays', 'capMinor'])} />
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => <input {...control} className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Product line" optional hint="Empty: every product line without its own plan" error={errors.productLineId}>
            {(control) => (
              <select {...control} className="select" value={productLineId} onChange={(e) => setProductLineId(e.target.value)}>
                <option value="">Every product line</option>
                {(lines.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                {plan?.productLine && !(lines.data ?? []).some((l) => l.id === plan.productLine?.id) ? <option value={plan.productLine.id}>{plan.productLine.name}</option> : null}
              </select>
            )}
          </Field>
          <fieldset className="field partners-fieldset">
            <legend className="field__label">Pays</legend>
            <div className="partners-radio">
              <label>
                <input type="radio" name="basis" checked={basis === 'percent'} onChange={() => setBasis('percent')} />A percent of the fee
              </label>
              <label>
                <input type="radio" name="basis" checked={basis === 'fixed'} onChange={() => setBasis('fixed')} />A fixed amount
              </label>
            </div>
          </fieldset>
          {basis === 'percent' ? (
            <Field label="Percent" hint="Of the course fee (or the payment, when the fee isn’t known)" error={errors.rateBps}>
              {(control) => <input {...control} className="input input--narrow" type="number" min={0.01} max={100} step={0.01} required value={rate} onChange={(e) => setRate(e.target.value)} />}
            </Field>
          ) : (
            <Field label={`Amount (${currency})`} error={errors.fixedMinor ?? errors.currency}>
              {(control) => <input {...control} className="input input--narrow" type="number" min={1} step={1} required value={fixed} onChange={(e) => setFixed(e.target.value)} />}
            </Field>
          )}
          <Field label="When it is earned" error={errors.trigger}>
            {(control) => (
              <select {...control} className="select" value={trigger} onChange={(e) => setTrigger(e.target.value as PlanTrigger)}>
                <option value="first_payment">On the first payment</option>
                <option value="full_payment">When the fee is fully paid</option>
              </select>
            )}
          </Field>
          <Field label="Clawback window (days)" hint="A refund within this many days takes the commission back" error={errors.clawbackDays}>
            {(control) => <input {...control} className="input input--narrow" type="number" min={0} max={730} required value={clawbackDays} onChange={(e) => setClawbackDays(e.target.value)} />}
          </Field>
          <Field label={`Most per lead (${currency})`} optional error={errors.capMinor}>
            {(control) => <input {...control} className="input input--narrow" type="number" min={1} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />}
          </Field>
          <Field label="Description" optional error={errors.description}>
            {(control) => <input {...control} className="input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Plan is on
          </label>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={save.isPending}>
          {plan ? 'Save plan' : 'Create plan'}
        </Button>
      </DialogFooter>
    </form>
  );
}
