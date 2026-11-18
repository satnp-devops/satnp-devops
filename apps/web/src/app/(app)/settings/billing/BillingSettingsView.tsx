'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mono, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Guard } from '@/components/Guard';
import { Alert, Badge, Button, Card, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf } from '@/lib/api';
import { keys } from '@/lib/queries';
import { money, parseMajor, percent, toMajorText } from '@/lib/money/format';
import { moneyKeys, useBillingCompanies, useBillingSetup, usePlans, usePriceLists, useTemplates } from '@/lib/money/queries';
import type { AgreementTemplate, BillingProfile, BillingSetup, Plan, PriceList } from '@/lib/money/types';
import { useSession } from '@/lib/session';
import '@/components/money/money.css';

// Settings > Billing: per company, the GSTIN and invoice series, plans and price lists, discount
// approval thresholds (settings), payment accounts and agreement templates.

const MISSING: Record<string, string> = { gstin: 'GSTIN', invoice_series: 'invoice series', credit_note_series: 'credit note series', payment_account: 'payment account' };

export function BillingSettingsView() {
  return (
    <Guard anyOf={['billing.configure']} anywhere>
      <BillingSettings />
    </Guard>
  );
}

function BillingSettings() {
  const { scope } = useSession();
  const companies = useBillingCompanies(scope.id);
  const [companyId, setCompanyId] = useState<string | null>(null);
  useEffect(() => {
    const list = companies.data ?? [];
    if (list.length && (!companyId || !list.some((c) => c.id === companyId))) setCompanyId(list[0]!.id);
  }, [companies.data, companyId]);
  const setup = useBillingSetup(companyId);

  if (companies.isPending) return <Spinner />;
  if (companies.isError) return <ErrorAlert error={companies.error} />;
  if (!companies.data.length) {
    return (
      <Card>
        <EmptyState icon="card" title="No company here">
          Billing is set up per company. Pick a company or the group in &ldquo;Working in&rdquo;.
        </EmptyState>
      </Card>
    );
  }
  const company = companies.data.find((c) => c.id === companyId);
  return (
    <div className="money-settings">
      <Card>
        <div className="card__body row gap-12">
          {companies.data.length > 1 ? (
            <Field label="Company">
              {(control) => (
                <select {...control} className="select" value={companyId ?? ''} onChange={(e) => setCompanyId(e.target.value)}>
                  {companies.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <p className="strong">{company?.name}</p>
          )}
          {company?.missing.length ? (
            <Alert tone="warning" title="Not ready to take payments">
              Still missing: {company.missing.map((m) => MISSING[m]).join(', ')}.
            </Alert>
          ) : company ? (
            <Badge tone="success">Ready to invoice</Badge>
          ) : null}
        </div>
      </Card>
      {setup.isPending ? <Spinner /> : setup.isError ? <ErrorAlert error={setup.error} /> : setup.data ? <CompanyBilling setup={setup.data} /> : null}
    </div>
  );
}

function CompanyBilling({ setup }: { setup: BillingSetup }) {
  return (
    <>
      <ProfileCard setup={setup} />
      <SeriesCard setup={setup} />
      <PlansCard companyId={setup.company.id} />
      <DiscountCard setup={setup} />
      <AccountsCard setup={setup} />
      <TemplatesCard companyId={setup.company.id} />
    </>
  );
}

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: moneyKeys.all });
}

function useSave<T>() {
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<T>, after?: () => void) => {
    setPending(true);
    setError(null);
    try {
      await fn();
      await refresh();
      after?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run, errors: fieldErrorsOf(error) };
}

// ---------- Business details ----------

function ProfileCard({ setup }: { setup: BillingSetup }) {
  const p: Partial<BillingProfile> = setup.profile ?? {};
  const [form, setForm] = useState({
    legalName: p.legalName ?? '',
    tradeName: p.tradeName ?? '',
    gstin: p.gstin ?? '',
    stateCode: p.stateCode ?? '',
    line1: p.address?.line1 ?? '',
    city: p.address?.city ?? '',
    state: p.address?.state ?? '',
    pincode: p.address?.pincode ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    lutNumber: p.lutNumber ?? '',
    lutValidUntil: p.lutValidUntil ?? '',
    invoiceNotes: p.invoiceNotes ?? '',
    roundOff: p.roundOff ?? false,
  });
  const save = useSave();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run(() =>
      api.put('/billing/profile', {
        companyId: setup.company.id,
        legalName: form.legalName,
        tradeName: form.tradeName || null,
        gstin: form.gstin || null,
        ...(form.gstin ? {} : form.stateCode ? { stateCode: form.stateCode } : {}),
        address: { ...(form.line1 ? { line1: form.line1 } : {}), ...(form.city ? { city: form.city } : {}), ...(form.state ? { state: form.state } : {}), ...(form.pincode ? { pincode: form.pincode } : {}), country: 'India' },
        email: form.email || null,
        phone: form.phone || null,
        lutNumber: form.lutNumber || null,
        lutValidUntil: form.lutValidUntil || null,
        invoiceNotes: form.invoiceNotes || null,
        roundOff: form.roundOff,
      }),
    );
  };
  const e = save.errors;
  return (
    <Card title="Business details" description="Printed on every invoice. The GSTIN decides the state the company bills from." flush>
      <form className="card__body stack gap-16" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Legal name" error={e['body.legalName']}>
            {(c) => <input {...c} className="input" required value={form.legalName} onChange={set('legalName')} />}
          </Field>
          <Field label="Trade name" optional error={e['body.tradeName']}>
            {(c) => <input {...c} className="input" value={form.tradeName} onChange={set('tradeName')} />}
          </Field>
          <Field label="GSTIN" hint={p.stateName ? `Registered in ${p.stateName}` : 'e.g. 27AAPFU0939F1ZV'} error={e['body.gstin']}>
            {(c) => <input {...c} className="input mono" value={form.gstin} maxLength={15} onChange={(ev) => setForm({ ...form, gstin: ev.target.value.toUpperCase() })} />}
          </Field>
          {!form.gstin ? (
            <Field label="State code" hint="Two digits, e.g. 27 for Maharashtra" error={e['body.stateCode']}>
              {(c) => <input {...c} className="input input--narrow mono" value={form.stateCode} maxLength={2} onChange={set('stateCode')} />}
            </Field>
          ) : null}
          <Field label="Address" optional error={e['body.address.line1']}>
            {(c) => <input {...c} className="input" value={form.line1} onChange={set('line1')} />}
          </Field>
          <Field label="City" optional>
            {(c) => <input {...c} className="input" value={form.city} onChange={set('city')} />}
          </Field>
          <Field label="State" optional>
            {(c) => <input {...c} className="input" value={form.state} onChange={set('state')} />}
          </Field>
          <Field label="PIN code" optional error={e['body.address.pincode']}>
            {(c) => <input {...c} className="input input--narrow" value={form.pincode} onChange={set('pincode')} />}
          </Field>
          <Field label="Accounts email" optional error={e['body.email']}>
            {(c) => <input {...c} className="input" type="email" value={form.email} onChange={set('email')} />}
          </Field>
          <Field label="Accounts phone" optional>
            {(c) => <input {...c} className="input" value={form.phone} onChange={set('phone')} />}
          </Field>
          <Field label="LUT number" optional hint="Letter of undertaking: exports without IGST">
            {(c) => <input {...c} className="input mono" value={form.lutNumber} onChange={set('lutNumber')} />}
          </Field>
          <Field label="LUT valid until" optional error={e['body.lutValidUntil']}>
            {(c) => <input {...c} className="input" type="date" value={form.lutValidUntil} onChange={set('lutValidUntil')} />}
          </Field>
        </div>
        <Field label="Note on invoices" optional>
          {(c) => <input {...c} className="input" maxLength={1000} value={form.invoiceNotes} onChange={set('invoiceNotes')} />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.roundOff} onChange={(ev) => setForm({ ...form, roundOff: ev.target.checked })} />
          Round invoice totals to the rupee
        </label>
        <ErrorAlert error={save.error} />
        <div>
          <Button type="submit" variant="primary" loading={save.pending}>
            Save business details
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------- Invoice series ----------

const DOC_LABEL: Record<string, string> = { invoice: 'Invoices', credit_note: 'Credit notes', debit_note: 'Debit notes', bill_of_supply: 'Bills of supply' };

function SeriesCard({ setup }: { setup: BillingSetup }) {
  const [form, setForm] = useState({ documentType: 'invoice', prefix: '', fyStyle: 'compact' });
  const save = useSave();
  return (
    <Card title="Invoice number series" description="Numbers are consecutive per financial year and never reused (GST rule 46). Each document type has its own series." flush>
      {setup.series.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Documents</th>
                <th scope="col">Example</th>
                <th scope="col">Last number</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {setup.series.map((s) => (
                <tr key={s.id}>
                  <td>{DOC_LABEL[s.documentType]}</td>
                  <td>
                    <Mono>{s.example ?? s.prefix}</Mono>
                  </td>
                  <td className="mono small">{s.last ? `${s.last.sequence} in FY ${s.last.fyStartYear}-${String(s.last.fyStartYear + 1).slice(2)}` : '—'}</td>
                  <td>{!s.active ? <StatusPill tone="neutral">Inactive</StatusPill> : s.isDefault ? <StatusPill tone="success">In use</StatusPill> : <StatusPill tone="neutral">Spare</StatusPill>}</td>
                  <td>
                    {s.active && !s.isDefault ? (
                      <Button size="sm" variant="ghost" onClick={() => void save.run(() => api.patch(`/billing/series/${s.id}`, { isDefault: true }))}>
                        Use this
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="list" title="No series yet">
          Add the invoice and credit note series before taking payments.
        </EmptyState>
      )}
      <form
        className="card__body form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run(() => api.post('/billing/series', { companyId: setup.company.id, ...form, prefix: form.prefix.toUpperCase(), isDefault: true }), () => setForm({ ...form, prefix: '' }));
        }}
      >
        <Field label="Documents">
          {(c) => (
            <select {...c} className="select" value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}>
              {Object.entries(DOC_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Prefix" hint="Letters and digits, e.g. SP" error={save.errors['body.prefix'] ?? save.errors['body.padding']}>
          {(c) => <input {...c} className="input input--narrow mono" maxLength={10} value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />}
        </Field>
        <Field label="Year style">
          {(c) => (
            <select {...c} className="select" value={form.fyStyle} onChange={(e) => setForm({ ...form, fyStyle: e.target.value })}>
              <option value="compact">2627</option>
              <option value="short">26-27</option>
              <option value="long">2026-27</option>
              <option value="startYear">2026</option>
            </select>
          )}
        </Field>
        <div className="row gap-8" style={{ alignItems: 'end' }}>
          <Button type="submit" loading={save.pending} disabled={!form.prefix || !setup.profile?.gstin}>
            Add series
          </Button>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <ErrorAlert error={save.error} />
        </div>
      </form>
    </Card>
  );
}

// ---------- Plans and price lists ----------

function PlansCard({ companyId }: { companyId: string }) {
  const plans = usePlans({ companyId, includeInactive: true });
  const lists = usePriceLists({ companyId, includeInactive: true });
  const [editPlan, setEditPlan] = useState<Plan | 'new' | null>(null);
  const [editList, setEditList] = useState<PriceList | 'new' | null>(null);
  return (
    <Card
      title="Plans and price lists"
      description="What is sold, with its SAC code and GST rate, and the price in each list. Quotes and fee proposals are made from these."
      flush
      actions={
        <div className="row gap-6">
          <Button size="sm" icon="plus" onClick={() => setEditPlan('new')}>
            Plan
          </Button>
          <Button size="sm" icon="plus" onClick={() => setEditList('new')}>
            Price list
          </Button>
        </div>
      }
    >
      {plans.isPending || lists.isPending ? (
        <div className="card__body">
          <Spinner />
        </div>
      ) : plans.isError || lists.isError ? (
        <div className="card__body">
          <ErrorAlert error={plans.error ?? lists.error} />
        </div>
      ) : (
        <>
          <div className="card__body row gap-6">
            {(lists.data ?? []).map((l) => (
              <Button key={l.id} size="sm" variant="ghost" icon="edit" onClick={() => setEditList(l)}>
                {l.name} · {l.currency}
                {l.isDefault ? ' (default)' : ''}
                {!l.active ? ' (inactive)' : ''}
              </Button>
            ))}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Billing</th>
                  <th scope="col">SAC · GST</th>
                  {(lists.data ?? []).map((l) => (
                    <th key={l.id} scope="col" className="money-num">
                      {l.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(plans.data ?? []).map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <button type="button" className="link-button" onClick={() => setEditPlan(plan)}>
                        {plan.name}
                      </button>
                      <div className="small muted">
                        <Mono>{plan.code}</Mono> {plan.active ? null : '· inactive'}
                      </div>
                    </td>
                    <td className="small">{plan.kind === 'recurring' ? `${plan.interval === 'year' ? 'Yearly' : 'Monthly'} per ${plan.unit}` : 'One-time'}</td>
                    <td className="small mono">
                      {plan.sac ?? '—'} · {plan.taxability === 'taxable' ? percent(plan.taxRateBp) : plan.taxability.replace('_', ' ')}
                    </td>
                    {(lists.data ?? []).map((l) => {
                      const price = l.prices.find((p) => p.planId === plan.id);
                      return (
                        <td key={l.id} className="money-num small">
                          {price ? money(price.unitAmount) : <span className="muted">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editPlan ? <PlanDialog companyId={companyId} plan={editPlan === 'new' ? null : editPlan} onClose={() => setEditPlan(null)} /> : null}
      {editList ? <PriceListDialog companyId={companyId} list={editList === 'new' ? null : editList} plans={plans.data ?? []} onClose={() => setEditList(null)} /> : null}
    </Card>
  );
}

function PlanDialog({ companyId, plan, onClose }: { companyId: string; plan: Plan | null; onClose: () => void }) {
  const [form, setForm] = useState({
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    kind: plan?.kind ?? 'one_time',
    audience: plan?.audience ?? 'b2c',
    unit: plan?.unit ?? 'flat',
    interval: plan?.interval ?? 'year',
    sac: plan?.sac ?? '999293',
    taxRate: plan ? String(plan.taxRateBp / 100) : '18',
    taxability: plan?.taxability ?? 'taxable',
    active: plan?.active ?? true,
  });
  const save = useSave();
  const e = save.errors;
  const set = (key: keyof typeof form) => (ev: { target: { value: string } }) => setForm({ ...form, [key]: ev.target.value });
  return (
    <Dialog open onClose={onClose} title={plan ? `Edit ${plan.name}` : 'New plan'}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const body = {
            code: form.code,
            name: form.name,
            kind: form.kind,
            audience: form.audience,
            unit: form.unit,
            interval: form.kind === 'recurring' ? form.interval : null,
            sac: form.sac || null,
            taxRateBp: Math.round(Number(form.taxRate) * 100),
            taxability: form.taxability,
            active: form.active,
          };
          void save.run(() => (plan ? api.patch(`/billing/plans/${plan.id}`, body) : api.post('/billing/plans', { companyId, ...body })), onClose);
        }}
      >
        <DialogBody>
          <div className="form-grid">
            <Field label="Name" error={e['body.name']}>
              {(c) => <input {...c} className="input" required value={form.name} onChange={set('name')} />}
            </Field>
            <Field label="Code" error={e['body.code']}>
              {(c) => <input {...c} className="input mono" required value={form.code} onChange={set('code')} />}
            </Field>
            <Field label="Sold to">
              {(c) => (
                <select {...c} className="select" value={form.audience} onChange={set('audience')}>
                  <option value="b2c">Families and students</option>
                  <option value="b2b">Institutes</option>
                </select>
              )}
            </Field>
            <Field label="Billing" error={e['body.interval']}>
              {(c) => (
                <select {...c} className="select" value={form.kind} onChange={set('kind')}>
                  <option value="one_time">One-time fee</option>
                  <option value="recurring">Subscription</option>
                </select>
              )}
            </Field>
            {form.kind === 'recurring' ? (
              <>
                <Field label="Every">
                  {(c) => (
                    <select {...c} className="select" value={form.interval} onChange={set('interval')}>
                      <option value="year">Year</option>
                      <option value="month">Month</option>
                    </select>
                  )}
                </Field>
                <Field label="Priced per">
                  {(c) => (
                    <select {...c} className="select" value={form.unit} onChange={set('unit')}>
                      <option value="flat">Institute</option>
                      <option value="seat">Seat</option>
                      <option value="student">Student</option>
                      <option value="branch">Branch</option>
                    </select>
                  )}
                </Field>
              </>
            ) : null}
            <Field label="SAC code" hint="999293 coaching · 997331 software" error={e['body.sac']}>
              {(c) => <input {...c} className="input mono" value={form.sac} onChange={set('sac')} />}
            </Field>
            <Field label="GST rate (%)" error={e['body.taxRateBp']}>
              {(c) => <input {...c} className="input input--narrow" inputMode="decimal" value={form.taxRate} onChange={set('taxRate')} />}
            </Field>
            <Field label="Taxability">
              {(c) => (
                <select {...c} className="select" value={form.taxability} onChange={set('taxability')}>
                  <option value="taxable">Taxable</option>
                  <option value="exempt">Exempt</option>
                  <option value="nil_rated">Nil rated</option>
                  <option value="non_gst">Outside GST</option>
                </select>
              )}
            </Field>
          </div>
          {plan ? (
            <label className="check">
              <input type="checkbox" checked={form.active} onChange={(ev) => setForm({ ...form, active: ev.target.checked })} />
              On sale
            </label>
          ) : null}
          <ErrorAlert error={save.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.pending}>
            Save plan
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function PriceListDialog({ companyId, list, plans, onClose }: { companyId: string; list: PriceList | null; plans: Plan[]; onClose: () => void }) {
  const [name, setName] = useState(list?.name ?? '');
  const [currency, setCurrency] = useState(list?.currency ?? 'INR');
  const [includeTax, setIncludeTax] = useState(list?.pricesIncludeTax ?? true);
  const [isDefault, setIsDefault] = useState(list?.isDefault ?? false);
  const [active, setActive] = useState(list?.active ?? true);
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries((list?.prices ?? []).map((p) => [p.planId, toMajorText(p.unitAmount.valueMinor, p.unitAmount.currency)])),
  );
  const save = useSave();
  const entries = Object.entries(prices)
    .map(([planId, text]) => ({ planId, unitAmountMinor: parseMajor(text, currency) }))
    .filter((p): p is { planId: string; unitAmountMinor: number } => p.unitAmountMinor !== null);
  const invalid = Object.values(prices).some((t) => t.trim() !== '' && parseMajor(t, currency) === null);
  return (
    <Dialog open onClose={onClose} size="lg" title={list ? `Edit ${list.name}` : 'New price list'}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const body = { name, pricesIncludeTax: includeTax, isDefault, prices: entries };
          void save.run(() => (list ? api.patch(`/billing/price-lists/${list.id}`, { ...body, active }) : api.post('/billing/price-lists', { companyId, currency, ...body })), onClose);
        }}
      >
        <DialogBody>
          <div className="form-grid">
            <Field label="Name" error={save.errors['body.name']}>
              {(c) => <input {...c} className="input" required value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Currency" error={save.errors['body.currency']}>
              {(c) => <input {...c} className="input input--narrow mono" maxLength={3} disabled={list !== null} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}
            </Field>
          </div>
          <div className="row gap-16">
            <label className="check">
              <input type="checkbox" checked={includeTax} onChange={(e) => setIncludeTax(e.target.checked)} />
              Prices include GST
            </label>
            <label className="check">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Default for {currency}
            </label>
            {list ? (
              <label className="check">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                In use
              </label>
            ) : null}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Price ({currency})</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <label htmlFor={`price-${plan.id}`}>{plan.name}</label>
                      {plan.unit !== 'flat' ? <span className="small muted"> per {plan.unit}</span> : null}
                    </td>
                    <td>
                      <input
                        id={`price-${plan.id}`}
                        className="input input--narrow"
                        inputMode="decimal"
                        placeholder="Not sold"
                        value={prices[plan.id] ?? ''}
                        onChange={(e) => setPrices({ ...prices, [plan.id]: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorAlert error={save.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.pending} disabled={invalid || !name}>
            Save prices
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ---------- Discount approval ----------

const DISCOUNT_KEYS = [
  { key: 'billing.discountFreePercent', label: 'Anyone may give up to (%)' },
  { key: 'billing.discountFreeAmount', label: 'Anyone may give at most (₹)' },
  { key: 'billing.discountManagerPercent', label: 'A manager may approve up to (%)' },
  { key: 'billing.discountCompanyPercent', label: 'A company admin may approve up to (%)' },
] as const;

function DiscountCard({ setup }: { setup: BillingSetup }) {
  const session = useSession();
  const client = useQueryClient();
  const company = session.unitsById.get(setup.company.id);
  const canManage = company ? session.can('settings.manage', company) : false;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(DISCOUNT_KEYS.map(({ key }) => [key, String(setup.settings[key] ?? '')])));
  const [selfApproval, setSelfApproval] = useState(Boolean(setup.settings['billing.discountSelfApproval'] ?? true));
  const save = useSave();
  return (
    <Card title="Discount approval" description="Discounts above what anyone may give wait for approval by the tier that covers them; larger ones are refused." flush>
      <div className="card__body stack gap-12">
        <ol className="small">
          {setup.discountPolicy.tiers.map((tier, index) => (
            <li key={index}>
              {tier.label}: up to {percent(tier.maxPercentBp ?? 0)}
              {tier.maxAmountMinor !== undefined ? ` and ${money({ valueMinor: tier.maxAmountMinor, currency: 'INR' })}` : ''}
              {tier.approverRoles.length ? `, approved by ${tier.approverRoles.join(' or ').replace(/_/g, ' ')}` : ', no approval needed'}
            </li>
          ))}
        </ol>
        {canManage ? (
          <form
            className="stack gap-12"
            onSubmit={(event) => {
              event.preventDefault();
              void save.run(async () => {
                for (const { key } of DISCOUNT_KEYS) {
                  await api.put(`/settings/${key}`, { unitId: setup.company.id, value: Number(values[key]) });
                }
                await api.put('/settings/billing.discountSelfApproval', { unitId: setup.company.id, value: selfApproval });
                await client.invalidateQueries({ queryKey: keys.settingsAll });
              });
            }}
          >
            <div className="form-grid">
              {DISCOUNT_KEYS.map(({ key, label }) => (
                <Field key={key} label={label} error={save.errors['body.value']}>
                  {(c) => <input {...c} className="input input--narrow" inputMode="decimal" value={values[key] ?? ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />}
                </Field>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={selfApproval} onChange={(e) => setSelfApproval(e.target.checked)} />
              Approvers may approve their own discounts
            </label>
            <ErrorAlert error={save.error} />
            <div>
              <Button type="submit" loading={save.pending}>
                Save for {setup.company.name}
              </Button>
            </div>
          </form>
        ) : (
          <p className="small muted">Changing these needs the settings permission at {setup.company.name}.</p>
        )}
      </div>
    </Card>
  );
}

// ---------- Payment accounts ----------

function AccountsCard({ setup }: { setup: BillingSetup }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title="Payment accounts"
      description="Razorpay takes INR payments. Payments in other currencies go to Stripe (invite-only for Indian businesses; an Indian account needs exports enabled) or to Razorpay with international payments."
      flush
      actions={
        setup.accounts.length < 2 ? (
          <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
            Account
          </Button>
        ) : undefined
      }
    >
      {setup.accounts.length ? (
        <ul className="list list--rows">
          {setup.accounts.map((a) => (
            <li key={a.id} className="list__item money-row">
              <span className="strong">{a.label}</span>
              <StatusPill tone={a.mode === 'live' ? 'success' : 'neutral'}>{a.mode === 'live' ? 'Live' : 'Test'}</StatusPill>
              <span className="small muted">
                {a.provider === 'stripe' ? 'Stripe' : 'Razorpay'} · {a.scope === 'both' ? 'INR and international' : a.scope === 'domestic' ? 'INR' : 'International'}
                {a.indiaExports ? ` · India exports, ${a.purposeCode}` : ''}
              </span>
              <span className="spacer" />
              <span className="small">{a.connected ? 'Connected' : 'Development stub until connected in Integrations'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="card" title="No payment account">
          Add Razorpay to send payment links.
        </EmptyState>
      )}
      {open ? <AccountDialog companyId={setup.company.id} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

function AccountDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [form, setForm] = useState({ provider: 'razorpay', label: '', scope: 'domestic', mode: 'test', accountRef: '', indiaExports: false, purposeCode: '' });
  const save = useSave();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog open onClose={onClose} title="Add a payment account" description="Keys stay in the integration connection; this only tells billing which account takes which payments.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save.run(
            () =>
              api.post('/billing/payment-accounts', {
                companyId,
                provider: form.provider,
                label: form.label,
                scope: form.scope,
                mode: form.mode,
                accountRef: form.accountRef || null,
                indiaExports: form.provider === 'stripe' && form.indiaExports,
                purposeCode: form.provider === 'stripe' && form.purposeCode ? form.purposeCode : null,
              }),
            onClose,
          );
        }}
      >
        <DialogBody>
          <div className="form-grid">
            <Field label="Provider">
              {(c) => (
                <select {...c} className="select" value={form.provider} onChange={set('provider')}>
                  <option value="razorpay">Razorpay</option>
                  <option value="stripe">Stripe</option>
                </select>
              )}
            </Field>
            <Field label="Name" error={save.errors['body.label']}>
              {(c) => <input {...c} className="input" required value={form.label} onChange={set('label')} />}
            </Field>
            <Field label="Takes">
              {(c) => (
                <select {...c} className="select" value={form.scope} onChange={set('scope')}>
                  <option value="domestic">INR payments</option>
                  <option value="international">International payments</option>
                  <option value="both">Both</option>
                </select>
              )}
            </Field>
            <Field label="Mode">
              {(c) => (
                <select {...c} className="select" value={form.mode} onChange={set('mode')}>
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </select>
              )}
            </Field>
            <Field label="Account id" optional hint="acc_… or acct_…, checked against webhooks">
              {(c) => <input {...c} className="input mono" value={form.accountRef} onChange={set('accountRef')} />}
            </Field>
          </div>
          {form.provider === 'stripe' ? (
            <div className="stack gap-8">
              <label className="check">
                <input type="checkbox" checked={form.indiaExports} onChange={(e) => setForm({ ...form, indiaExports: e.target.checked })} />
                Indian Stripe account with exports enabled
              </label>
              {form.indiaExports ? (
                <Field label="Purpose code" hint="One per account: P1107 for education services" error={save.errors['body.purposeCode']}>
                  {(c) => <input {...c} className="input input--narrow mono" value={form.purposeCode} onChange={set('purposeCode')} />}
                </Field>
              ) : null}
            </div>
          ) : null}
          <ErrorAlert error={save.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.pending}>
            Add account
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ---------- Agreement templates ----------

const PLACEHOLDERS = '{{date}} {{company.name}} {{company.gstin}} {{customer.name}} {{deal.ref}} {{deal.title}} {{quote.ref}} {{quote.title}} {{quote.total}} {{quote.lines}} {{instalments}} {{signers}}';

function TemplatesCard({ companyId }: { companyId: string }) {
  const templates = useTemplates({ companyId, includeInactive: true });
  const [edit, setEdit] = useState<AgreementTemplate | 'new' | null>(null);
  return (
    <Card
      title="Agreement templates"
      description="Fee and software agreements sent for e-sign. Placeholders are filled from the deal and its proposal."
      flush
      actions={
        <Button size="sm" icon="plus" onClick={() => setEdit('new')}>
          Template
        </Button>
      }
    >
      {templates.isPending ? (
        <div className="card__body">
          <Spinner />
        </div>
      ) : templates.data?.length ? (
        <ul className="list list--rows">
          {templates.data.map((t) => (
            <li key={t.id}>
              <button type="button" className="list__item list__item--button money-row" onClick={() => setEdit(t)}>
                <span className="strong">{t.name}</span>
                <span className="small muted">
                  {t.audience === 'b2c' ? 'Families' : 'Institutes'} · {t.signType} · expires after {t.expiresInDays} days
                </span>
                {!t.active ? <StatusPill tone="neutral">Inactive</StatusPill> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="note" title="No templates yet" />
      )}
      {edit ? <TemplateDialog companyId={companyId} template={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

function TemplateDialog({ companyId, template, onClose }: { companyId: string; template: AgreementTemplate | null; onClose: () => void }) {
  const [form, setForm] = useState({
    key: template?.key ?? '',
    name: template?.name ?? '',
    audience: template?.audience ?? 'b2c',
    signType: template?.signType ?? 'aadhaar',
    expiresInDays: String(template?.expiresInDays ?? 10),
    body: template?.body ?? '',
    active: template?.active ?? true,
  });
  const save = useSave();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog open onClose={onClose} size="lg" title={template ? `Edit ${template.name}` : 'New agreement template'}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const body = { name: form.name, audience: form.audience, signType: form.signType, expiresInDays: Number(form.expiresInDays), body: form.body };
          void save.run(() => (template ? api.patch(`/billing/agreement-templates/${template.id}`, { ...body, active: form.active }) : api.post('/billing/agreement-templates', { companyId, key: form.key, ...body })), onClose);
        }}
      >
        <DialogBody>
          <div className="form-grid">
            <Field label="Name" error={save.errors['body.name']}>
              {(c) => <input {...c} className="input" required value={form.name} onChange={set('name')} />}
            </Field>
            {!template ? (
              <Field label="Key" hint="e.g. fee_agreement" error={save.errors['body.key']}>
                {(c) => <input {...c} className="input mono" required value={form.key} onChange={set('key')} />}
              </Field>
            ) : null}
            <Field label="For">
              {(c) => (
                <select {...c} className="select" value={form.audience} onChange={set('audience')}>
                  <option value="b2c">Families</option>
                  <option value="b2b">Institutes</option>
                </select>
              )}
            </Field>
            <Field label="Signature">
              {(c) => (
                <select {...c} className="select" value={form.signType} onChange={set('signType')}>
                  <option value="aadhaar">Aadhaar e-sign</option>
                  <option value="electronic">Electronic</option>
                  <option value="dsc">Digital signature (DSC)</option>
                </select>
              )}
            </Field>
            <Field label="Expires after (days)" error={save.errors['body.expiresInDays']}>
              {(c) => <input {...c} className="input input--narrow" inputMode="numeric" value={form.expiresInDays} onChange={set('expiresInDays')} />}
            </Field>
          </div>
          <Field label="Text" hint={`Placeholders: ${PLACEHOLDERS}`} error={save.errors['body.body']}>
            {(c) => <textarea {...c} className="textarea money-template-body" rows={14} required value={form.body} onChange={set('body')} />}
          </Field>
          {template ? (
            <label className="check">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              In use
            </label>
          ) : null}
          <ErrorAlert error={save.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.pending}>
            Save template
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
