'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { DataTable, DateTime, KeyValue, Mono, infiniteRows, type Column } from '@/components/crm';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, EmptyState, ErrorAlert, Field, PageHeader, PageLoading } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf, isApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { PAYOUT_STATUS, SKIP_REASON, money } from '@/lib/partners/format';
import { partnerKeys, usePayout, usePayouts } from '@/lib/partners/queries';
import type { Payout, PayoutDetail, PayoutInput, PayoutPreview, PayoutStatus } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { Amount, BackLink, PayoutPill, companiesInScope } from './Parts';

// /partners/payouts and /partners/payouts/[id]: payout batches with maker-checker approval.

export function PayoutsView() {
  const { scope, units, unitsById, can } = useSession();
  const router = useRouter();
  const [status, setStatus] = useState<'' | PayoutStatus>('');
  const [creating, setCreating] = useState(false);
  const payouts = usePayouts(scope.id, { status });
  const companies = companiesInScope(scope, units, unitsById).filter((c) => can('partners.manage_payouts', c));

  const columns: Column<Payout>[] = [
    {
      id: 'ref',
      header: 'Batch',
      card: 'title',
      width: 160,
      cell: (p) => (
        <span className="partners-name">
          <Link href={`/partners/payouts/${p.id}`}>
            <Mono>{p.ref}</Mono>
          </Link>
          <span className="partners-sub">{p.company?.name}</span>
        </span>
      ),
    },
    {
      id: 'period',
      header: 'Period',
      cell: (p) => (
        <span>
          <DateTime value={p.periodStart} format="date" sans /> – <DateTime value={p.periodEnd} format="date" sans />
        </span>
      ),
    },
    { id: 'partners', header: 'Partners', width: 90, align: 'end', cell: (p) => p.lineCount },
    { id: 'total', header: 'Total', width: 130, align: 'end', cell: (p) => <Amount value={p.total} /> },
    { id: 'status', header: 'Status', width: 180, cell: (p) => <PayoutPill status={p.status} /> },
    { id: 'by', header: 'Prepared by', hideBelow: 'lg', cell: (p) => p.createdBy?.name ?? '—' },
  ];

  return (
    <>
      <DataTable
        {...infiniteRows(payouts)}
        columns={columns}
        rowId={(p) => p.id}
        label="Payout batches"
        onRowActivate={(p) => router.push(`/partners/payouts/${p.id}`)}
        toolbar={
          <div className="partners-toolbar">
            <div className="partners-toolbar__filters">
              <select className="select toolbar__select" aria-label="Payout status" value={status} onChange={(e) => setStatus(e.target.value as '' | PayoutStatus)}>
                <option value="">Every status</option>
                {(Object.keys(PAYOUT_STATUS) as PayoutStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {PAYOUT_STATUS[s].label}
                  </option>
                ))}
              </select>
            </div>
            {companies.length > 0 ? (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                Prepare payout
              </Button>
            ) : null}
          </div>
        }
        empty={status ? 'No batches with this status.' : 'No payout batches yet. Finance prepares one when approved commissions are ready.'}
      />
      <NewPayoutDialog open={creating} companies={companies.map((c) => ({ id: c.id, name: c.name }))} onClose={() => setCreating(false)} onCreated={(id) => router.push(`/partners/payouts/${id}`)} />
    </>
  );
}

function monthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

function NewPayoutDialog({ open, companies, onClose, onCreated }: { open: boolean; companies: Array<{ id: string; name: string }>; onClose: () => void; onCreated: (id: string) => void }) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Prepare a payout batch" description="Approved commissions earned up to the end of the period, minus refunds of commissions already paid. Someone else approves the batch before it is paid.">
      {open ? <NewPayoutForm companies={companies} onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function NewPayoutForm({ companies, onClose, onCreated }: { companies: Array<{ id: string; name: string }>; onClose: () => void; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const bounds = monthBounds();
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [periodStart, setPeriodStart] = useState(bounds.start);
  const [periodEnd, setPeriodEnd] = useState(bounds.end);
  const [notes, setNotes] = useState('');
  const body: PayoutInput = { companyId, periodStart, periodEnd, currency: 'INR', ...(notes.trim() ? { notes: notes.trim() } : {}) };
  const preview = useMutation({ mutationFn: () => api.post<PayoutPreview>('/partner-payouts/preview', body) });
  const create = useMutation({
    mutationFn: () => api.post<PayoutDetail>('/partner-payouts', body),
    onSuccess: (payout) => {
      void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
      onClose();
      onCreated(payout.id);
    },
  });
  const { mutate: runPreview } = preview;
  useEffect(() => {
    if (companyId && periodStart && periodEnd && periodEnd >= periodStart) runPreview();
  }, [companyId, periodStart, periodEnd, runPreview]);
  const errors = fieldErrorsOf(create.error ?? preview.error);
  const p = preview.data;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(create.error, ['companyId', 'periodStart', 'periodEnd', 'notes'])} />
        <div className="form-grid">
          <Field label="Company" error={errors.companyId}>
            {(control) => (
              <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Period from" error={errors.periodStart}>
            {(control) => <input {...control} className="input" type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />}
          </Field>
          <Field label="Period to" error={errors.periodEnd}>
            {(control) => <input {...control} className="input" type="date" required value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />}
          </Field>
          <Field label="Notes" optional error={errors.notes}>
            {(control) => <input {...control} className="input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        </div>
        <hr className="divider" />
        {preview.isPending ? (
          <p className="small muted">Working out what this batch would pay…</p>
        ) : preview.isError ? (
          <ErrorAlert error={preview.error} />
        ) : p ? (
          <div className="stack gap-8" aria-live="polite">
            <p className="section-title">
              {p.lines.length === 0 ? 'Nothing to pay for this period yet' : `${p.lines.length} ${p.lines.length === 1 ? 'partner' : 'partners'} · ${money(p.total)}`}
            </p>
            {p.holdDuringClawback ? <p className="small muted">Commissions still inside their clawback window wait for a later batch.</p> : null}
            {p.lines.length > 0 ? (
              <ul className="partners-list">
                {p.lines.map((l) => (
                  <li key={l.partner.id}>
                    <span className="partners-list__text">
                      {l.partner.name}
                      <span className="partners-sub">
                        {' '}
                        · {l.commissionCount} {l.commissionCount === 1 ? 'commission' : 'commissions'}
                        {l.deductions.valueMinor > 0 ? ` · ${money(l.deductions)} deducted` : ''}
                      </span>
                    </span>
                    <Amount value={l.net} />
                  </li>
                ))}
              </ul>
            ) : null}
            {p.skipped.length > 0 ? (
              <Alert tone="warning" title={`${p.skipped.length} waiting`}>
                {p.skipped.map((s) => `${s.partner.name}: ${SKIP_REASON[s.reason] ?? s.reason}`).join('. ')}.
              </Alert>
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={create.isPending} disabled={!p || p.lines.length === 0}>
          Prepare batch
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------- One batch ----------

export function PayoutView({ id }: { id: string }) {
  const payout = usePayout(id);
  if (payout.isPending) return <PageLoading />;
  if (payout.isError) {
    return (
      <div className="content">
        {isApiError(payout.error) && payout.error.status === 404 ? (
          <EmptyState icon="card" title="Payout not found" action={<Link href="/partners/payouts">Back to payouts</Link>} />
        ) : (
          <ErrorAlert error={payout.error} />
        )}
      </div>
    );
  }
  return <PayoutDetailView payout={payout.data} />;
}

function PayoutDetailView({ payout }: { payout: PayoutDetail }) {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<'approve' | 'paid' | 'cancel' | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const done = (updated: PayoutDetail) => {
    queryClient.setQueryData(partnerKeys.payout(payout.id), updated);
    void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
    setAction(null);
  };
  const approve = useMutation({ mutationFn: () => api.post<PayoutDetail>(`/partner-payouts/${payout.id}/approve`), onSuccess: done });
  const markPaid = useMutation({ mutationFn: () => api.post<PayoutDetail>(`/partner-payouts/${payout.id}/mark-paid`, { reference }), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api.post<PayoutDetail>(`/partner-payouts/${payout.id}/cancel`, { reason }), onSuccess: done });
  const steps = [
    { label: `Prepared by ${payout.createdBy?.name ?? 'finance'}`, done: true },
    { label: payout.approvedBy ? `Approved by ${payout.approvedBy.name}` : 'Approval by someone else', done: Boolean(payout.approvedAt) },
    { label: payout.paidAt ? `Paid${payout.reference ? ` · ${payout.reference}` : ''}` : 'Paid', done: Boolean(payout.paidAt) },
  ];

  return (
    <>
      <PageHeader
        title={`Payout ${payout.ref}`}
        description={`${payout.company?.name ?? ''} · ${formatDate(payout.periodStart)} to ${formatDate(payout.periodEnd)}`}
        actions={
          <>
            {payout.can.cancel ? (
              <Button variant="ghost" onClick={() => setAction('cancel')}>
                Cancel batch
              </Button>
            ) : null}
            {payout.can.approve ? (
              <Button variant="primary" icon="check" onClick={() => setAction('approve')}>
                Approve
              </Button>
            ) : null}
            {payout.can.markPaid ? (
              <Button variant="primary" onClick={() => setAction('paid')}>
                Mark paid
              </Button>
            ) : null}
          </>
        }
      />
      <div className="content stack gap-16">
        <BackLink href="/partners/payouts">All payouts</BackLink>
        <div className="row gap-12">
          <PayoutPill status={payout.status} />
          <ol className="partners-steps" aria-label="Progress">
            {steps.map((s) => (
              <li key={s.label} data-done={s.done}>
                {s.label}
              </li>
            ))}
          </ol>
        </div>
        {payout.status === 'draft' && payout.can.isPreparer ? (
          <Alert tone="info" title="Waiting for approval">
            You prepared this batch, so someone else with payout approval must approve it.
          </Alert>
        ) : null}
        {payout.status === 'cancelled' ? (
          <Alert tone="warning" title="Cancelled">
            {payout.cancelReason ?? ''} Its commissions go into the next batch.
          </Alert>
        ) : null}
        <div className="partners-stats">
          <div className="partners-stat">
            <KeyValue
              layout="stacked"
              items={[
                { label: 'Commissions', value: <Amount value={payout.commission} /> },
                { label: 'Refund deductions', value: <Amount value={payout.deductions} /> },
                { label: 'To pay', value: <strong><Amount value={payout.total} /></strong> },
              ]}
            />
          </div>
        </div>
        <DataTable
          rows={payout.lines}
          rowId={(l) => l.id}
          label="Partners in this batch"
          columns={[
            { id: 'partner', header: 'Partner', card: 'title', cell: (l) => <Link href={`/partners/${l.partner.id}`}>{l.partner.name}</Link> },
            { id: 'to', header: 'Pay to', cell: (l) => (l.payout?.summary ? <span className="small">{l.payout.summary}</span> : <span className="muted">—</span>) },
            { id: 'count', header: 'Commissions', width: 110, align: 'end', hideBelow: 'md', cell: (l) => l.commissionCount },
            { id: 'deductions', header: 'Deducted', width: 110, align: 'end', hideBelow: 'md', cell: (l) => <Amount value={l.deductions} /> },
            { id: 'net', header: 'Net', width: 120, align: 'end', cell: (l) => <Amount value={l.net} /> },
            { id: 'ref', header: 'Transfer ref', hideBelow: 'lg', cell: (l) => (l.reference ? <Mono>{l.reference}</Mono> : '—') },
          ]}
          empty="Nobody is left to pay in this batch."
        />
      </div>
      <ConfirmDialog open={action === 'approve'} onClose={() => setAction(null)} title={`Approve ${payout.ref}?`} confirmLabel={`Approve ${money(payout.total)}`} pending={approve.isPending} error={approve.error} onConfirm={() => approve.mutate()}>
        <p>
          {payout.lineCount} {payout.lineCount === 1 ? 'partner' : 'partners'} will be paid {money(payout.total)} in total. Finance then sends the transfers and marks the batch paid.
        </p>
      </ConfirmDialog>
      <Dialog open={action === 'paid'} onClose={() => setAction(null)} title={`Mark ${payout.ref} paid`} description="After the bank transfers went out. Commissions in the batch become paid and partners see it in their portal.">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            markPaid.mutate();
          }}
        >
          <DialogBody>
            <ErrorAlert error={formErrorOf(markPaid.error, ['reference'])} />
            <Field label="Bank batch reference" error={fieldErrorsOf(markPaid.error).reference}>
              {(control) => <input {...control} className="input mono" required minLength={3} maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setAction(null)}>Cancel</Button>
            <Button variant="primary" type="submit" loading={markPaid.isPending}>
              Mark paid
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      <Dialog open={action === 'cancel'} onClose={() => setAction(null)} title={`Cancel ${payout.ref}?`} description="Its commissions and deductions go back to wait for the next batch.">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            cancel.mutate();
          }}
        >
          <DialogBody>
            <ErrorAlert error={formErrorOf(cancel.error, ['reason'])} />
            <Field label="Reason" error={fieldErrorsOf(cancel.error).reason}>
              {(control) => <textarea {...control} className="textarea" rows={3} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setAction(null)}>Keep batch</Button>
            <Button variant="danger" type="submit" loading={cancel.isPending}>
              Cancel batch
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  );
}
