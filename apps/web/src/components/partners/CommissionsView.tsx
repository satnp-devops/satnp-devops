'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BulkActionBar, DataTable, DateTime, KeyValue, Mono, SidePanel, infiniteRows, useRowSelection, type Column } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf } from '@/lib/api';
import { formatMoney } from '@/lib/crm/format';
import { plural } from '@/lib/format';
import { COMMISSION_STATUS, TRIGGER_LABEL, formatRate, moneyList } from '@/lib/partners/format';
import { partnerKeys, useCommission, useCommissionSummary, useCommissions } from '@/lib/partners/queries';
import type { BulkApproveResult, Commission, CommissionStatus } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { Amount, CommissionPill, Stat } from './Parts';

const STATUS_ORDER: CommissionStatus[] = ['pending', 'approved', 'paid', 'clawed_back', 'rejected'];

export function CommissionsView() {
  const { scope } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get('commission');
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | CommissionStatus>('');
  const [rejecting, setRejecting] = useState<Commission | null>(null);
  const commissions = useCommissions(scope.id, { status });
  const summary = useCommissionSummary(scope.id);
  const selection = useRowSelection([scope.id, status]);
  const rows = commissions.data?.pages.flatMap((p) => p.data) ?? [];
  const approvable = rows.filter((c) => c.can.approve);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
  const approve = useMutation({ mutationFn: (id: string) => api.post(`/partner-commissions/${id}/approve`), onSuccess: refresh });
  const bulk = useMutation({
    mutationFn: (ids: string[]) => api.post<BulkApproveResult>('/partner-commissions/approve', { ids }),
    onSuccess: () => {
      selection.clear();
      refresh();
    },
  });
  const open = (id: string | null) => router.replace(id ? `${pathname}?commission=${id}` : pathname, { scroll: false });

  const totals = (s: CommissionStatus) => (summary.data?.statuses ?? []).filter((t) => t.status === s);
  const totalText = (s: CommissionStatus) => {
    const list = totals(s);
    return list.length ? list.map((t) => formatMoney(t.total.valueMinor, t.total.currency)).join(' + ') : formatMoney(0, 'INR');
  };
  const countOf = (s: CommissionStatus) => totals(s).reduce((n, t) => n + t.count, 0);

  const columns: Column<Commission>[] = [
    {
      id: 'deal',
      header: 'Lead',
      card: 'title',
      cell: (c) => (
        <span className="partners-name">
          <button type="button" className="link-button" onClick={() => open(c.id)}>
            {c.deal.title ?? c.deal.ref}
          </button>
          <span className="partners-sub">
            <Mono>{c.deal.ref}</Mono> · {c.company?.name}
          </span>
        </span>
      ),
    },
    { id: 'partner', header: 'Partner', cell: (c) => <Link href={`/partners/${c.partner.id}`}>{c.partner.name}</Link> },
    {
      id: 'plan',
      header: 'Plan',
      hideBelow: 'lg',
      cell: (c) => (
        <span className="partners-name">
          <span>{c.plan.name}</span>
          <span className="partners-sub">{c.basis === 'percent' ? `${formatRate(c.rateBps)} of ${formatMoney(c.base.valueMinor, c.base.currency)}` : 'Fixed amount'}</span>
        </span>
      ),
    },
    {
      id: 'amount',
      header: 'Payable',
      align: 'end',
      width: 130,
      cell: (c) => (
        <span className="partners-name">
          <Amount value={c.payable} />
          {c.clawedBack.valueMinor > 0 ? <span className="partners-sub">of {formatMoney(c.amount.valueMinor, c.amount.currency)}</span> : null}
        </span>
      ),
    },
    { id: 'status', header: 'Status', width: 170, cell: (c) => <CommissionPill status={c.status} /> },
    { id: 'earned', header: 'Earned', width: 120, hideBelow: 'md', cell: (c) => <DateTime value={c.earnedAt} format="date" /> },
    {
      id: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      label: 'Actions',
      width: 180,
      card: 'plain',
      cell: (c) =>
        c.can.approve ? (
          <span className="row gap-4 nowrap">
            <Button size="sm" variant="primary" loading={approve.isPending && approve.variables === c.id} onClick={() => approve.mutate(c.id)} aria-label={`Approve ${c.deal.ref}`}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(c)} aria-label={`Reject ${c.deal.ref}`}>
              Reject
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="stack gap-16">
      <div className="partners-stats">
        <Stat label="Awaiting approval" value={totalText('pending')} meta={plural(countOf('pending'), 'commission')} />
        <Stat label="Approved, unpaid" value={totalText('approved')} meta={plural(countOf('approved'), 'commission')} />
        <Stat label="Paid" value={totalText('paid')} meta={plural(countOf('paid'), 'commission')} />
        <Stat label="Clawed back" value={moneyList(summary.data?.clawedBack)} meta="Refunds inside the window" />
      </div>
      <ErrorAlert error={approve.error ?? bulk.error} />
      {bulk.data && bulk.data.skipped.length > 0 ? (
        <Alert tone="warning" title={`${bulk.data.approved.length} approved, ${bulk.data.skipped.length} skipped`}>
          {bulk.data.skipped[0]?.message}
        </Alert>
      ) : null}
      {selection.count > 0 ? (
        <BulkActionBar count={selection.count} noun="commission" onClear={selection.clear}>
          <Button size="sm" variant="primary" loading={bulk.isPending} onClick={() => bulk.mutate([...selection.selected])}>
            Approve selected
          </Button>
        </BulkActionBar>
      ) : null}
      <DataTable
        {...infiniteRows(commissions)}
        columns={columns}
        rowId={(c) => c.id}
        label="Commissions"
        selection={status === 'pending' && approvable.length > 0 ? { selected: selection.selected, onChange: (ids) => selection.onChange(new Set([...ids].filter((id) => approvable.some((c) => c.id === id)))) } : undefined}
        rowLabel={(c) => `Select ${c.deal.ref}`}
        onRowActivate={(c) => open(c.id)}
        activeRowId={openId}
        toolbar={
          <div className="partners-toolbar">
            <div className="partners-toolbar__filters">
              <select className="select toolbar__select" aria-label="Commission status" value={status} onChange={(e) => setStatus(e.target.value as '' | CommissionStatus)}>
                <option value="">Every status</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {COMMISSION_STATUS[s].label}
                  </option>
                ))}
              </select>
              {status !== 'pending' && approvable.length > 1 ? <span className="small muted">Show “Pending approval” to approve several at once</span> : null}
            </div>
          </div>
        }
        empty={status ? 'No commissions with this status.' : 'No commissions yet. They accrue when a referred family pays.'}
      />
      <CommissionPanel id={openId} onClose={() => open(null)} />
      <RejectDialog commission={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />
    </div>
  );
}

function CommissionPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const commission = useCommission(id);
  const c = commission.data;
  return (
    <SidePanel open={id !== null} onClose={onClose} title={c ? `Commission for ${c.deal.ref}` : 'Commission'} subtitle={c ? `${c.partner.name} · ${c.company?.name ?? ''}` : undefined}>
      {commission.isPending ? (
        <Spinner />
      ) : commission.isError ? (
        <ErrorAlert error={commission.error} />
      ) : c ? (
        <div className="stack gap-16">
          <div className="row gap-8">
            <CommissionPill status={c.status} />
            {c.payout ? (
              <Link href={`/partners/payouts/${c.payout.id}`} className="small">
                In payout {c.payout.ref}
              </Link>
            ) : null}
          </div>
          <KeyValue
            items={[
              { label: 'Earned', value: <Amount value={c.amount} /> },
              { label: 'Clawed back', value: <Amount value={c.clawedBack} /> },
              { label: 'Payable', value: <Amount value={c.payable} /> },
              { label: 'Plan', value: c.plan.name },
              { label: 'Terms', value: `${c.basis === 'percent' ? `${formatRate(c.rateBps)} of ${formatMoney(c.base.valueMinor, c.base.currency)}` : 'Fixed amount'} · ${TRIGGER_LABEL[c.trigger].toLowerCase()}` },
              { label: 'Payment', value: <Mono>{c.paymentId}</Mono> },
              { label: 'Earned on', value: <DateTime value={c.earnedAt} /> },
              { label: 'Clawback window ends', value: <DateTime value={c.clawbackUntil} format="date" /> },
              ...(c.approvedAt ? [{ label: 'Approved', value: `${c.approvedBy?.name ?? ''}, ${new Date(c.approvedAt).toLocaleDateString('en-IN')}` }] : []),
              ...(c.rejectionReason ? [{ label: 'Rejected because', value: c.rejectionReason }] : []),
              ...(c.paidAt ? [{ label: 'Paid', value: <DateTime value={c.paidAt} format="date" /> }] : []),
            ]}
          />
          {c.clawbacks.length > 0 ? (
            <div className="stack gap-8">
              <p className="section-title">Refunds</p>
              <ul className="partners-list">
                {c.clawbacks.map((k) => (
                  <li key={k.id}>
                    <div className="partners-list__text">
                      <p className="partners-list__title">
                        <Amount value={k.amount} /> {k.recovery === 'netted' ? 'taken off this commission' : 'deducted from the next payout'}
                      </p>
                      <p className="partners-sub">
                        Refund <Mono>{k.refundId}</Mono> · <DateTime value={k.refundedAt} format="date" />
                        {k.recovery === 'deduct' ? (k.recoveredAt ? ' · recovered' : ' · not recovered yet') : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </SidePanel>
  );
}

function RejectDialog({ commission, onClose, onDone }: { commission: Commission | null; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={commission !== null} onClose={onClose} title={`Reject the commission for ${commission?.deal.ref ?? ''}?`} description="The partner won’t be paid for this lead. Say why, for the audit log and the partner’s manager.">
      {commission ? <RejectForm commission={commission} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

function RejectForm({ commission, onClose, onDone }: { commission: Commission; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const reject = useMutation({
    mutationFn: () => api.post(`/partner-commissions/${commission.id}/reject`, { reason }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const errors = fieldErrorsOf(reject.error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        reject.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={errors.reason ? null : reject.error} />
        <Field label="Reason" error={errors.reason}>
          {(control) => <textarea {...control} className="textarea" rows={3} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" type="submit" loading={reject.isPending}>
          Reject commission
        </Button>
      </DialogFooter>
    </form>
  );
}
