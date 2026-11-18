'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DataTable, FilterBar, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { Button, EmptyState } from '@/components/ui';
import { Cell, Stat, moneyText } from '@/components/delivery/Bits';
import { formatCount, formatMoney } from '@/lib/crm/format';
import { CHURN_LEVEL, dateLabel, daysUntil } from '@/lib/delivery/format';
import { useRenewalSummary, useRenewals } from '@/lib/delivery/queries';
import type { ChurnLevel, Renewal } from '@/lib/delivery/types';
import { useSession } from '@/lib/session';

export function RenewalsView() {
  return (
    <Guard anyOf={['onboarding.view_renewals']} anywhere>
      <Renewals />
    </Guard>
  );
}

const RISK_CHIPS = (['high', 'medium', 'low'] as ChurnLevel[]).map((value) => ({ value, label: CHURN_LEVEL[value].label }));
const WINDOWS = [
  { value: '', label: 'Any time' },
  { value: '30', label: 'Next 30 days' },
  { value: '90', label: 'Next 90 days' },
  { value: '180', label: 'Next 6 months' },
];

const COLUMNS: Column<Renewal>[] = [
  {
    id: 'account',
    header: 'Institute',
    card: 'title',
    cell: (r) => (
      <Cell
        main={r.account ? <Link href={`/accounts/${r.account.id}`}>{r.account.name}</Link> : (r.planName ?? r.subscriptionId)}
        sub={[r.product?.name ?? r.productLine?.name, r.planName].filter(Boolean).join(' · ') || null}
      />
    ),
  },
  {
    id: 'due',
    header: 'Renews',
    width: 150,
    cell: (r) => {
      const days = daysUntil(r.termEnd);
      return (
        <Cell
          main={dateLabel(r.termEnd)}
          sub={<span className={days <= 30 && !r.autoRenew ? 'delivery-overdue' : undefined}>{days < 0 ? `${-days} days ago` : days === 0 ? 'Today' : `in ${days} days`}{r.autoRenew ? ' · auto-renew' : ''}</span>}
        />
      );
    },
  },
  { id: 'amount', header: 'Value', width: 130, align: 'end', cell: (r) => <Cell main={moneyText(r.amount)} sub={r.seats ? `${formatCount(r.seats)} seats` : undefined} /> },
  {
    id: 'risk',
    header: 'Churn risk',
    width: 260,
    cell: (r) => (
      <div className="stack gap-2">
        <span className="row gap-6">
          <StatusPill tone={CHURN_LEVEL[r.churn.level].tone}>{CHURN_LEVEL[r.churn.level].label}</StatusPill>
          <span className="muted small crm-mono" title="Score out of 100">
            {r.churn.score}
          </span>
        </span>
        {r.churn.signals.length ? (
          <ul className="delivery-signals">
            {r.churn.signals.slice(0, 3).map((s) => (
              <li key={s.key}>{s.label}</li>
            ))}
          </ul>
        ) : null}
      </div>
    ),
  },
  {
    id: 'upsell',
    header: 'Upsell',
    width: 200,
    hideBelow: 'md',
    cell: (r) =>
      r.upsell.length ? (
        <ul className="delivery-signals">
          {r.upsell.map((f) => (
            <li key={f.key}>{f.label}</li>
          ))}
        </ul>
      ) : (
        <span className="muted">—</span>
      ),
  },
  { id: 'owner', header: 'Owner', width: 140, hideBelow: 'lg', cell: (r) => r.owner?.name ?? <span className="muted">No owner</span> },
];

function Renewals() {
  const { scope } = useSession();
  const [risk, setRisk] = useState<string[]>([]);
  const [within, setWithin] = useState('90');
  const [sort, setSort] = useState<'due' | 'risk'>('due');
  const [upsell, setUpsell] = useState(false);
  const [mine, setMine] = useState(false);
  const summary = useRenewalSummary(scope.id);
  const list = useRenewals(scope.id, { risk: risk.join(',') || undefined, dueWithinDays: within ? Number(within) : undefined, sort, upsell: upsell || undefined, owner: mine ? 'me' : undefined });
  const table = infiniteRows(list);
  const clear = () => {
    setRisk([]);
    setWithin('90');
    setUpsell(false);
    setMine(false);
  };
  const s = summary.data;
  return (
    <>
      {s ? (
        <div className="delivery-stats">
          <Stat label="Renewing in 30 days" value={formatCount(s.due30)} />
          <Stat label="Renewing in 90 days" value={formatCount(s.due90)} />
          <Stat label="Value in 90 days" value={s.value90.length ? s.value90.map((m) => formatMoney(m.valueMinor, m.currency, { compact: true })).join(' + ') : '₹0'} />
          <Stat label="High churn risk" value={formatCount(s.high)} tone={s.high > 0 ? 'danger' : undefined} />
          <Stat label="Upsell chances" value={formatCount(s.upsell)} />
        </div>
      ) : null}
      <DataTable
        {...table}
        label="Renewals"
        columns={COLUMNS}
        rowId={(r) => r.id}
        rowLabel={(r) => r.account?.name ?? r.subscriptionId}
        toolbar={
          <FilterBar chips={[{ label: 'Churn risk', options: RISK_CHIPS, selected: risk, onChange: setRisk }]} extraActiveCount={(within !== '90' ? 1 : 0) + (upsell ? 1 : 0) + (mine ? 1 : 0)} onClear={clear}
            end={
              <select className="select delivery-filter-select" aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as 'due' | 'risk')}>
                <option value="due">Soonest first</option>
                <option value="risk">Riskiest first</option>
              </select>
            }
          >
            <select className="select delivery-filter-select" aria-label="Renews within" value={within} onChange={(event) => setWithin(event.target.value)}>
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={upsell} onChange={(event) => setUpsell(event.target.checked)} />
              Upsell chances
            </label>
            <label className="check">
              <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
              Mine
            </label>
          </FilterBar>
        }
        empty={
          <EmptyState icon="repeat" title="No renewals in this window" action={<Button onClick={clear}>Show the next 90 days</Button>}>
            Subscriptions appear here from billing, with reminders 90, 60, 30 and 7 days before they renew.
          </EmptyState>
        }
        footer={table.rows.length > 0 ? `Showing ${formatCount(table.rows.length)} ${table.rows.length === 1 ? 'renewal' : 'renewals'} · risk scored nightly` : undefined}
      />
    </>
  );
}
