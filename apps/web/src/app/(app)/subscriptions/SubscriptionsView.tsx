'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChipGroup, DataTable, DateTime, FilterBar, infiniteRows, KeyValue, Money, Mono, SidePanel, StatusPill, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Button, EmptyState, ErrorAlert, Field, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { money, PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '@/lib/money/format';
import { moneyApi, useMoneyMutation, useSubscription, useSubscriptions } from '@/lib/money/queries';
import type { Proration, Subscription } from '@/lib/money/types';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';
import '@/components/money/money.css';

const FILTERS = [
  { value: 'renewals', label: 'Renewing in 30 days' },
  { value: 'active', label: 'Active' },
  { value: 'past_due', label: 'Past due' },
  { value: 'pending', label: 'Awaiting first payment' },
  { value: 'cancelled', label: 'Cancelled' },
];

const UNIT: Record<string, string> = { seat: 'seats', student: 'students', branch: 'branches', flat: 'licences' };

export function SubscriptionsView() {
  const session = useSession();
  const trail = trailOf(session.scope, session.unitsById)
    .map((u) => u.name)
    .join(' › ');
  return (
    <>
      <PageHeader title="Subscriptions" description={`Software subscriptions of institutes · ${trail}`} />
      <div className="content">
        <Guard anyOf={['billing.view']} anywhere>
          <SubscriptionsList />
        </Guard>
      </div>
    </>
  );
}

function SubscriptionsList() {
  const { scope } = useSession();
  const [filter, setFilter] = useState('renewals');
  const [open, setOpen] = useState<string | null>(null);
  const query = useSubscriptions(scope.id, filter === 'renewals' ? { renewingWithinDays: 30 } : { status: filter });
  const columns: Column<Subscription>[] = [
    {
      id: 'who',
      header: 'Institute',
      card: 'title',
      cell: (s) => (
        <span className="stack gap-2">
          <span className="strong">{s.accountName ?? s.deal?.title ?? '—'}</span>
          {s.deal ? (
            <Link href={`/billing/deals/${s.deal.id}`} className="small">
              <Mono>{s.deal.ref}</Mono>
            </Link>
          ) : null}
        </span>
      ),
    },
    { id: 'plan', header: 'Plan', cell: (s) => <span className="small">{s.planName} · {s.quantity} {UNIT[s.unit]}</span> },
    { id: 'price', header: 'Per term', cell: (s) => <span className="small">{money(s.perPeriod)} {s.interval === 'year' ? '/ year' : '/ month'}{s.pricesIncludeTax ? '' : ' + GST'}</span>, hideBelow: 'md', width: 190 },
    { id: 'renews', header: 'Renews on', cell: (s) => <span className="mono small">{s.cancelAtPeriodEnd ? `Ends ${s.renewsOn}` : s.renewsOn}</span>, width: 130 },
    { id: 'status', header: 'Status', cell: (s) => <StatusPill tone={SUBSCRIPTION_STATUS[s.status].tone}>{SUBSCRIPTION_STATUS[s.status].label}</StatusPill>, width: 190 },
  ];
  return (
    <>
      <DataTable
        label="Subscriptions"
        columns={columns}
        rowId={(s) => s.id}
        {...infiniteRows(query)}
        onLoadMore={() => void query.fetchNextPage()}
        onRowActivate={(s) => setOpen(s.id)}
        activeRowId={open}
        toolbar={
          <FilterBar>
            <ChipGroup label="Show" options={FILTERS} selected={[filter]} onChange={(next) => setFilter(next.find((v) => v !== filter) ?? filter)} />
          </FilterBar>
        }
        empty={<EmptyState icon="repeat" title={filter === 'renewals' ? 'No renewals in the next 30 days' : 'No subscriptions here'}>Subscriptions start from a B2B deal.</EmptyState>}
      />
      <SubscriptionPanel id={open} onClose={() => setOpen(null)} />
    </>
  );
}

function SubscriptionPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const sub = useSubscription(id);
  const data = sub.data;
  const [quantity, setQuantity] = useState('');
  const [proration, setProration] = useState<Proration | null>(null);
  const dealId = data?.deal?.id;
  const action = useMoneyMutation(({ name, body }: { name: 'cancel' | 'renew'; body?: unknown }) => moneyApi.subscriptionAction(id ?? '', name, body), dealId ? { dealId } : {});
  const change = useMoneyMutation(
    async ({ preview }: { preview: boolean }) => {
      const result = await api.patch<{ proration: Proration; subscription: Subscription }>(`/billing/subscriptions/${id}`, { quantity: Number(quantity), preview });
      setProration(preview ? result.proration : null);
      return result;
    },
    dealId ? { dealId } : {},
  );
  return (
    <SidePanel open={id !== null} onClose={onClose} title={data?.accountName ?? 'Subscription'} subtitle={data ? `${data.planName} · ${data.deal?.ref ?? ''}` : undefined}>
      {sub.isPending ? (
        <Spinner />
      ) : sub.isError ? (
        <ErrorAlert error={sub.error} />
      ) : data ? (
        <div className="stack gap-16">
          <KeyValue
            items={[
              { label: 'Status', value: <StatusPill tone={SUBSCRIPTION_STATUS[data.status].tone}>{SUBSCRIPTION_STATUS[data.status].label}</StatusPill> },
              { label: 'Quantity', value: `${data.quantity} ${UNIT[data.unit]}` },
              { label: 'Unit price', value: money(data.unitPrice) },
              { label: 'Per term', value: `${money(data.perPeriod)}${data.pricesIncludeTax ? '' : ' + GST'}` },
              { label: 'Current term', value: <span className="mono">{`${data.currentPeriodStart} → ${data.renewsOn}`}</span> },
              { label: 'Renewals', value: String(data.renewalCount) },
              ...(data.addons.length ? [{ label: 'Add-ons', value: data.addons.map((a) => `${a.name} × ${a.quantity}`).join(', ') }] : []),
              ...(data.pendingChange?.quantity ? [{ label: 'At renewal', value: `${data.pendingChange.quantity} ${UNIT[data.unit]}` }] : []),
              ...(data.cancelAtPeriodEnd ? [{ label: 'Ends', value: data.renewsOn }] : []),
            ]}
          />
          {data.can?.change ? (
            <form
              className="stack gap-8"
              onSubmit={(event) => {
                event.preventDefault();
                change.mutate({ preview: true });
              }}
            >
              <Field label={`Change ${UNIT[data.unit]}`} hint="More takes effect now and is charged pro rata; fewer waits for the renewal">
                {(control) => <input {...control} className="input input--narrow" inputMode="numeric" value={quantity} placeholder={String(data.quantity)} onChange={(e) => { setQuantity(e.target.value); setProration(null); }} />}
              </Field>
              <div className="row gap-6">
                <Button size="sm" type="submit" disabled={!Number(quantity) || Number(quantity) === data.quantity} loading={change.isPending && change.variables?.preview}>
                  Work out the cost
                </Button>
                {proration ? (
                  <Button size="sm" variant="primary" loading={change.isPending && !change.variables?.preview} onClick={() => change.mutate({ preview: false })}>
                    {proration.netMinor > 0 ? 'Change and send link' : 'Change at renewal'}
                  </Button>
                ) : null}
              </div>
              {proration ? (
                <p className="small">
                  {proration.direction === 'upgrade'
                    ? `${proration.remainingDays} of ${proration.termDays} days left: charge ${money({ valueMinor: proration.netMinor, currency: data.unitPrice.currency })} plus GST now.`
                    : proration.direction === 'downgrade'
                      ? `Fewer ${UNIT[data.unit]} from ${data.renewsOn}; nothing changes now.`
                      : 'No change in price.'}
                </p>
              ) : null}
              <ErrorAlert error={change.error} />
            </form>
          ) : null}
          {data.payments?.length ? (
            <section className="stack gap-8">
              <h3 className="section-title">Payments</h3>
              <ul className="list list--bordered list--rows">
                {data.payments.map((p) => (
                  <li key={p.id} className="list__item money-row">
                    <StatusPill tone={PAYMENT_STATUS[p.status].tone}>{PAYMENT_STATUS[p.status].label}</StatusPill>
                    <span className="small muted">{p.purpose}</span>
                    <DateTime value={p.paidAt ?? p.createdAt} format="date" />
                    <span className="spacer" />
                    <Money minor={p.amount.valueMinor} currency={p.amount.currency} exact />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="row gap-6">
            {data.can?.renew && !data.cancelAtPeriodEnd ? (
              <Button size="sm" icon="repeat" loading={action.isPending && action.variables?.name === 'renew'} onClick={() => action.mutate({ name: 'renew' })}>
                Send renewal link now
              </Button>
            ) : null}
            {data.can?.cancel && !data.cancelAtPeriodEnd ? (
              <Button size="sm" variant="ghost" onClick={() => action.mutate({ name: 'cancel', body: { atPeriodEnd: true, reason: 'Cancelled from Subscriptions' } })}>
                {data.status === 'pending' ? 'Cancel' : 'End at renewal'}
              </Button>
            ) : null}
          </div>
          <ErrorAlert error={action.error} />
        </div>
      ) : null}
    </SidePanel>
  );
}
