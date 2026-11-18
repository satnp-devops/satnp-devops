'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ChipGroup, DataTable, DateTime, FilterBar, infiniteRows, Money, Mono, StatusPill, type Column } from '@/components/crm';
import { InvoicePanel } from '@/components/money';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, EmptyState, ErrorAlert, Field } from '@/components/ui';
import { AGREEMENT_STATUS, INSTALMENT_STATE, money, PAYMENT_STATUS, percent, PROVIDER_LABEL, QUOTE_STATUS, REFUND_REASONS, REFUND_STATUS } from '@/lib/money/format';
import { moneyApi, useAgreements, useInstalments, useInvoices, useMoneyMutation, usePayments, useQuotes, useRefunds } from '@/lib/money/queries';
import type { Agreement, BillingDealRef, Instalment, InvoiceSummary, Payment, Quote, Refund } from '@/lib/money/types';
import { useSession } from '@/lib/session';

// The lists of the Fees and billing page. Every list is scoped by the API to what the viewer may
// see in the working unit (finance: everything; counsellors: their own deals).

function DealLink({ deal }: { deal: BillingDealRef | null }) {
  if (!deal) return <span className="muted">—</span>;
  return (
    <Link href={`/billing/deals/${deal.id}`} className="money-row__title">
      <Mono>{deal.ref}</Mono> <span className="small">{deal.title}</span>
    </Link>
  );
}

const dealColumn = <T extends { deal: BillingDealRef | null }>(): Column<T> => ({ id: 'deal', header: 'Deal', cell: (row) => <DealLink deal={row.deal} />, card: 'title' });

const PAYMENT_FILTERS = [
  { value: 'succeeded', label: 'Paid' },
  { value: 'link_sent', label: 'Link sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Processing' },
  { value: 'expired', label: 'Expired' },
];

export function PaymentsList() {
  const { scope } = useSession();
  const params = useSearchParams();
  const [status, setStatus] = useState<string[]>(params.get('status') ? [params.get('status') as string] : []);
  const query = usePayments(scope.id, { status: status.join(',') });
  const columns: Column<Payment>[] = [
    dealColumn<Payment>(),
    { id: 'what', header: 'For', cell: (p) => <span className="small">{p.description}</span>, hideBelow: 'lg' },
    { id: 'status', header: 'Status', cell: (p) => <StatusPill tone={PAYMENT_STATUS[p.status].tone}>{PAYMENT_STATUS[p.status].label}</StatusPill>, width: 150 },
    { id: 'via', header: 'Via', cell: (p) => <span className="small">{PROVIDER_LABEL[p.provider]}{p.method ? ` · ${p.method.replace('_', ' ')}` : ''}</span>, hideBelow: 'md', width: 140 },
    { id: 'when', header: 'When', cell: (p) => <DateTime value={p.paidAt ?? p.createdAt} format="short" />, width: 130 },
    { id: 'invoice', header: 'Invoice', cell: (p) => (p.invoiceNumber ? <Mono>{p.invoiceNumber}</Mono> : <span className="muted">—</span>), hideBelow: 'md', width: 150 },
    { id: 'amount', header: 'Amount', cell: (p) => <Money minor={p.amount.valueMinor} currency={p.amount.currency} exact />, align: 'end', width: 130 },
  ];
  const table = infiniteRows(query);
  return (
    <DataTable
      label="Payments"
      columns={columns}
      rowId={(p) => p.id}
      {...table}
      onLoadMore={() => void query.fetchNextPage()}
      toolbar={<FilterBar chips={[{ label: 'Status', options: PAYMENT_FILTERS, selected: status, onChange: setStatus }]} onClear={() => setStatus([])} />}
      empty={<EmptyState icon="card" title={status.length ? 'No payments match' : 'No payments yet'}>Payment links sent from a deal show here.</EmptyState>}
    />
  );
}

export function InvoicesList() {
  const { scope } = useSession();
  const query = useInvoices(scope.id, {});
  const [open, setOpen] = useState<string | null>(null);
  const columns: Column<InvoiceSummary>[] = [
    { id: 'number', header: 'Number', cell: (i) => <Mono>{i.number}</Mono>, card: 'title', width: 160 },
    { id: 'date', header: 'Date', cell: (i) => <span className="mono small">{i.issueDate}</span>, width: 110 },
    dealColumn<InvoiceSummary>(),
    { id: 'to', header: 'Billed to', cell: (i) => <span className="small">{i.recipientName ?? '—'}</span>, hideBelow: 'lg' },
    { id: 'tax', header: 'GST', cell: (i) => <Money minor={i.tax.valueMinor} currency={i.tax.currency} exact />, align: 'end', hideBelow: 'md', width: 120 },
    {
      id: 'total',
      header: 'Total',
      cell: (i) => (
        <span className="stack gap-2">
          <Money minor={i.total.valueMinor} currency={i.total.currency} exact />
          {i.status === 'cancelled' ? <StatusPill tone="neutral">Cancelled</StatusPill> : i.credited.valueMinor ? <span className="small muted">credited {money(i.credited)}</span> : null}
        </span>
      ),
      align: 'end',
      width: 140,
    },
  ];
  return (
    <>
      <DataTable
        label="Invoices"
        columns={columns}
        rowId={(i) => i.id}
        {...infiniteRows(query)}
        onLoadMore={() => void query.fetchNextPage()}
        onRowActivate={(i) => setOpen(i.id)}
        activeRowId={open}
        empty={<EmptyState icon="note" title="No invoices yet">A GST invoice is issued automatically when a payment comes in.</EmptyState>}
      />
      <InvoicePanel invoiceId={open} onClose={() => setOpen(null)} />
    </>
  );
}

const INSTALMENT_FILTERS = [
  { value: 'due', label: 'Due this week' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'paid', label: 'Paid' },
] as const;

export function InstalmentsList() {
  const { scope } = useSession();
  const params = useSearchParams();
  const initial = INSTALMENT_FILTERS.find((f) => f.value === params.get('state'))?.value ?? 'due';
  const [state, setState] = useState<string>(initial);
  const query = useInstalments(scope.id, { state });
  const columns: Column<Instalment>[] = [
    dealColumn<Instalment>(),
    { id: 'n', header: 'Instalment', cell: (i) => <span className="small">{i.number}{i.count ? ` of ${i.count}` : ''}</span>, width: 110 },
    { id: 'due', header: 'Due', cell: (i) => <span className="mono small">{i.dueDate}</span>, width: 110 },
    { id: 'state', header: 'Status', cell: (i) => <StatusPill tone={INSTALMENT_STATE[i.state].tone}>{INSTALMENT_STATE[i.state].label}</StatusPill>, width: 120 },
    { id: 'reminded', header: 'Last reminder', cell: (i) => (i.lastReminderAt ? <DateTime value={i.lastReminderAt} format="short" /> : <span className="muted">—</span>), hideBelow: 'md', width: 140 },
    { id: 'amount', header: 'Amount', cell: (i) => <Money minor={(i.state === 'paid' ? i.paid : i.outstanding).valueMinor} currency={i.amount.currency} exact />, align: 'end', width: 130 },
  ];
  return (
    <DataTable
      label="Instalments"
      columns={columns}
      rowId={(i) => i.id}
      {...infiniteRows(query)}
      onLoadMore={() => void query.fetchNextPage()}
      toolbar={
        <FilterBar>
          <ChipGroup label="Show" options={INSTALMENT_FILTERS} selected={[state]} onChange={(next) => setState(next.find((v) => v !== state) ?? state)} />
        </FilterBar>
      }
      empty={<EmptyState icon="calendar" title="Nothing here">{state === 'overdue' ? 'No instalment is overdue.' : 'No instalments match.'}</EmptyState>}
    />
  );
}

export function RefundsList() {
  const { scope } = useSession();
  const [status, setStatus] = useState<string[]>(['requested']);
  const query = useRefunds(scope.id, { status: status.join(',') });
  const [review, setReview] = useState<{ refund: Refund; approve: boolean } | null>(null);
  const columns: Column<Refund>[] = [
    { id: 'ref', header: 'Refund', cell: (r) => <Mono>{r.ref}</Mono>, width: 120 },
    dealColumn<Refund>(),
    { id: 'reason', header: 'Reason', cell: (r) => <span className="small">{REFUND_REASONS.find((x) => x.value === r.reason)?.label ?? r.reason}{r.note ? ` · ${r.note}` : ''}</span>, hideBelow: 'lg' },
    { id: 'by', header: 'Asked by', cell: (r) => <span className="small">{r.requestedBy?.name ?? '—'}</span>, hideBelow: 'md', width: 140 },
    { id: 'status', header: 'Status', cell: (r) => <StatusPill tone={REFUND_STATUS[r.status].tone}>{REFUND_STATUS[r.status].label}</StatusPill>, width: 180 },
    { id: 'amount', header: 'Amount', cell: (r) => <Money minor={r.amount.valueMinor} currency={r.amount.currency} exact />, align: 'end', width: 120 },
    {
      id: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      label: 'Actions',
      card: 'plain',
      width: 190,
      cell: (r) =>
        r.can?.approve || r.can?.reject ? (
          <span className="row gap-6">
            {r.can.approve ? (
              <Button size="sm" variant="primary" onClick={() => setReview({ refund: r, approve: true })}>
                Approve
              </Button>
            ) : null}
            {r.can.reject ? (
              <Button size="sm" onClick={() => setReview({ refund: r, approve: false })}>
                Reject
              </Button>
            ) : null}
          </span>
        ) : r.status === 'requested' ? (
          <span className="small muted">Finance approves</span>
        ) : null,
    },
  ];
  return (
    <>
      <DataTable
        label="Refunds"
        columns={columns}
        rowId={(r) => r.id}
        {...infiniteRows(query)}
        onLoadMore={() => void query.fetchNextPage()}
        toolbar={
          <FilterBar
            chips={[
              {
                label: 'Status',
                options: [
                  { value: 'requested', label: 'Awaiting approval' },
                  { value: 'processing', label: 'Processing' },
                  { value: 'processed', label: 'Refunded' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'rejected', label: 'Rejected' },
                ],
                selected: status,
                onChange: setStatus,
              },
            ]}
            onClear={() => setStatus([])}
          />
        }
        empty={<EmptyState icon="card" title={status.includes('requested') && status.length === 1 ? 'No refunds waiting' : 'No refunds match'}>Refunds are requested from a deal's payments.</EmptyState>}
      />
      {review ? <ReviewRefundDialog {...review} onClose={() => setReview(null)} /> : null}
    </>
  );
}

function ReviewRefundDialog({ refund, approve, onClose }: { refund: Refund; approve: boolean; onClose: () => void }) {
  const [note, setNote] = useState('');
  const act = useMoneyMutation((body: { note: string }) => moneyApi.refundAction(refund.id, approve ? 'approve' : 'reject', body.note || undefined), refund.deal ? { dealId: refund.deal.id } : {});
  return (
    <Dialog open onClose={onClose} title={`${approve ? 'Approve' : 'Reject'} refund ${refund.ref}`} description={`${money(refund.amount)} for ${refund.deal?.ref ?? ''}${approve ? '. The money goes back through the original payment method.' : ''}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          act.mutate({ note }, { onSuccess: onClose });
        }}
      >
        <DialogBody>
          <Field label="Note" optional>
            {(control) => <textarea {...control} className="textarea" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <ErrorAlert error={act.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={approve ? 'primary' : 'danger'} loading={act.isPending}>
            {approve ? 'Approve and refund' : 'Reject'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function AgreementsList() {
  const { scope } = useSession();
  const [status, setStatus] = useState<string[]>([]);
  const query = useAgreements(scope.id, { status: status.join(',') });
  const columns: Column<Agreement>[] = [
    { id: 'ref', header: 'Agreement', cell: (a) => <Mono>{a.ref}</Mono>, width: 120 },
    dealColumn<Agreement>(),
    { id: 'signers', header: 'Signers', cell: (a) => <span className="small">{a.signers.map((s) => `${s.name} (${s.status})`).join(', ')}</span>, hideBelow: 'lg' },
    { id: 'status', header: 'Status', cell: (a) => <StatusPill tone={AGREEMENT_STATUS[a.status].tone}>{AGREEMENT_STATUS[a.status].label}</StatusPill>, width: 160 },
    { id: 'sent', header: 'Sent', cell: (a) => (a.sentAt ? <DateTime value={a.sentAt} format="short" /> : <span className="muted">—</span>), hideBelow: 'md', width: 130 },
  ];
  return (
    <DataTable
      label="Agreements"
      columns={columns}
      rowId={(a) => a.id}
      {...infiniteRows(query)}
      onLoadMore={() => void query.fetchNextPage()}
      toolbar={
        <FilterBar
          chips={[
            {
              label: 'Status',
              options: [
                { value: 'sent', label: 'Awaiting signature' },
                { value: 'partially_signed', label: 'Partly signed' },
                { value: 'signed', label: 'Signed' },
                { value: 'failed', label: 'Not signed' },
              ],
              selected: status,
              onChange: setStatus,
            },
          ]}
          onClear={() => setStatus([])}
        />
      }
      empty={<EmptyState icon="note" title="No agreements">Agreements are made from a template on a deal.</EmptyState>}
    />
  );
}

export function ApprovalsList() {
  const { scope, canAnywhere } = useSession();
  const canApprove = canAnywhere('billing.approve_discounts');
  const query = useQuotes(scope.id, { awaitingApproval: 'true' });
  const act = useMoneyMutation(({ id, approve }: { id: string; approve: boolean }) => moneyApi.quoteAction(id, approve ? 'approve-discount' : 'reject-discount'));
  const columns: Column<Quote>[] = [
    { id: 'ref', header: 'Proposal', cell: (q) => <Mono>{q.ref ?? ''}</Mono>, width: 120 },
    dealColumn<Quote>(),
    { id: 'by', header: 'Asked by', cell: (q) => <span className="small">{q.discount.requestedBy?.name ?? '—'}</span>, hideBelow: 'md', width: 140 },
    { id: 'discount', header: 'Discount', cell: (q) => <span className="small">{money(q.amounts.discount)} ({percent(q.discount.percentBp)}) · {q.discount.tierLabel}</span>, width: 200 },
    { id: 'total', header: 'Total', cell: (q) => <Money minor={q.amounts.total.valueMinor} currency={q.currency} exact />, align: 'end', width: 130 },
    { id: 'status', header: 'Status', cell: (q) => <StatusPill tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</StatusPill>, hideBelow: 'lg', width: 200 },
    {
      id: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      label: 'Actions',
      card: 'plain',
      width: 190,
      cell: (q) => !canApprove ? <span className="small muted">Waiting for an approver</span> : (
        <span className="row gap-6">
          <Button size="sm" variant="primary" loading={act.isPending && act.variables?.id === q.id && act.variables.approve} onClick={() => act.mutate({ id: q.id!, approve: true })}>
            Approve
          </Button>
          <Button size="sm" onClick={() => act.mutate({ id: q.id!, approve: false })}>
            Reject
          </Button>
        </span>
      ),
    },
  ];
  return (
    <div className="stack gap-12">
      <ErrorAlert error={act.error} />
      <DataTable
        label="Discounts awaiting approval"
        columns={columns}
        rowId={(q) => q.id ?? ''}
        {...infiniteRows(query)}
        onLoadMore={() => void query.fetchNextPage()}
        empty={<EmptyState icon="check" title="Nothing to approve">Discounts above the free tier wait here for a manager or company admin.</EmptyState>}
      />
    </div>
  );
}
