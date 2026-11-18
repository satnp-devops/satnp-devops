'use client';

import { useState } from 'react';
import { Money, Mono, SidePanel, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf } from '@/lib/api';
import { moneyKeys, useInvoice, useMoneyMutation } from '@/lib/money/queries';
import { money, parseMajor, percent, SUPPLY_TYPES } from '@/lib/money/format';
import type { Invoice } from '@/lib/money/types';
import { useQueryClient } from '@tanstack/react-query';
import './money.css';

/** The GST invoice as a document (Rule 46 fields), ready to print or save as PDF from the browser. */
export function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const c = invoice.currency;
  const igst = invoice.taxKind === 'igst';
  const local = invoice.stateTaxLabel ?? 'SGST';
  const addr = invoice.supplier.address ?? {};
  return (
    <article className="money-invoice" aria-label={`Invoice ${invoice.number}`}>
      <header className="money-invoice__head">
        <div>
          <p className="money-invoice__kind">{invoice.documentType === 'bill_of_supply' ? 'Bill of supply' : 'Tax invoice'}</p>
          <h3 className="money-invoice__supplier">{invoice.supplier.legalName}</h3>
          <p className="muted small">
            {[addr.line1, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')}
          </p>
          <p className="small">
            GSTIN <Mono>{invoice.supplier.gstin ?? '—'}</Mono>
            {invoice.supplier.pan ? (
              <>
                {' '}
                · PAN <Mono>{invoice.supplier.pan}</Mono>
              </>
            ) : null}
          </p>
        </div>
        <dl className="money-invoice__meta">
          <div>
            <dt>Invoice no.</dt>
            <dd>
              <Mono>{invoice.number}</Mono>
            </dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>
              <Mono>{invoice.issueDate}</Mono>
            </dd>
          </div>
          <div>
            <dt>Place of supply</dt>
            <dd>{invoice.placeOfSupply ? `${invoice.placeOfSupply.name} (${invoice.placeOfSupply.code})` : '—'}</dd>
          </div>
        </dl>
      </header>
      <section className="money-invoice__party">
        <p className="muted small">Billed to</p>
        <p className="strong">{invoice.recipient.name ?? invoice.recipientName ?? 'Customer'}</p>
        {invoice.recipient.gstin ? (
          <p className="small">
            GSTIN <Mono>{invoice.recipient.gstin}</Mono>
          </p>
        ) : null}
        <p className="small muted">{SUPPLY_TYPES[invoice.supplyType] ?? invoice.supplyType}</p>
      </section>
      <div className="table-wrap">
        <table className="table money-invoice__lines">
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col">SAC</th>
              <th scope="col" className="money-num">
                Taxable
              </th>
              {igst ? (
                <th scope="col" className="money-num">
                  IGST
                </th>
              ) : (
                <>
                  <th scope="col" className="money-num">
                    CGST
                  </th>
                  <th scope="col" className="money-num">
                    {local}
                  </th>
                </>
              )}
              <th scope="col" className="money-num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line, index) => (
              <tr key={index}>
                <td>
                  {line.description}
                  {line.quantity !== 1 ? <span className="muted"> × {line.quantity}</span> : null}
                  {line.discount.valueMinor ? <span className="muted small"> (discount {money(line.discount)})</span> : null}
                </td>
                <td>
                  <Mono>{line.sac ?? '—'}</Mono>
                </td>
                <td className="money-num">
                  <Money minor={line.taxable.valueMinor} currency={c} exact />
                </td>
                {igst ? (
                  <td className="money-num">
                    <Money minor={line.igst.amount.valueMinor} currency={c} exact /> <span className="muted small">{percent(line.igst.rateBp)}</span>
                  </td>
                ) : (
                  <>
                    <td className="money-num">
                      <Money minor={line.cgst.amount.valueMinor} currency={c} exact /> <span className="muted small">{percent(line.cgst.rateBp)}</span>
                    </td>
                    <td className="money-num">
                      <Money minor={line.sgst.amount.valueMinor} currency={c} exact /> <span className="muted small">{percent(line.sgst.rateBp)}</span>
                    </td>
                  </>
                )}
                <td className="money-num">
                  <Money minor={line.total.valueMinor} currency={c} exact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="money-totals">
        <div>
          <dt>Taxable value</dt>
          <dd>{money(invoice.totals.taxable)}</dd>
        </div>
        {igst ? (
          <div>
            <dt>IGST</dt>
            <dd>{money(invoice.totals.igst)}</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>CGST</dt>
              <dd>{money(invoice.totals.cgst)}</dd>
            </div>
            <div>
              <dt>{local}</dt>
              <dd>{money(invoice.totals.sgst)}</dd>
            </div>
          </>
        )}
        {invoice.totals.roundOff.valueMinor ? (
          <div>
            <dt>Round off</dt>
            <dd>{money(invoice.totals.roundOff)}</dd>
          </div>
        ) : null}
        <div className="money-totals__grand">
          <dt>Total</dt>
          <dd>{money(invoice.totals.total)}</dd>
        </div>
      </dl>
      <p className="small">{invoice.amountInWords}</p>
      {invoice.endorsement ? <p className="small strong">{invoice.endorsement}</p> : null}
      {invoice.notes ? <p className="small muted">{invoice.notes}</p> : null}
    </article>
  );
}

/** Side panel with the invoice, its credit notes, and finance actions (credit note, cancel). */
export function InvoicePanel({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const invoice = useInvoice(invoiceId);
  const [creditOpen, setCreditOpen] = useState(false);
  const data = invoice.data;
  return (
    <SidePanel
      open={invoiceId !== null}
      onClose={onClose}
      size="lg"
      title={data ? `Invoice ${data.number}` : 'Invoice'}
      subtitle={data ? `${data.deal?.ref ?? ''} · ${data.deal?.title ?? ''}` : undefined}
      actions={
        data ? (
          <Button size="sm" icon="download" onClick={() => window.print()}>
            Print or save PDF
          </Button>
        ) : undefined
      }
    >
      {invoice.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : invoice.isError ? (
        <ErrorAlert error={invoice.error} />
      ) : data ? (
        <div className="stack gap-16 money-print-area">
          {data.status === 'cancelled' ? (
            <Alert tone="warning" title="Cancelled">
              {data.cancelReason}
            </Alert>
          ) : null}
          <InvoiceDocument invoice={data} />
          {data.creditNotes.length ? (
            <section className="stack gap-8">
              <h3 className="section-title">Credit notes</h3>
              <ul className="list list--bordered list--rows">
                {data.creditNotes.map((note) => (
                  <li key={note.id} className="list__item money-row">
                    <Mono>{note.number}</Mono>
                    <span className="muted small">{note.issueDate}</span>
                    <StatusPill tone="neutral">{note.reason.replace(/_/g, ' ')}</StatusPill>
                    <span className="spacer" />
                    <Money minor={note.total.valueMinor} currency={note.total.currency} exact />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.can.creditNote ? (
            <div className="row gap-8 no-print">
              <Button size="sm" onClick={() => setCreditOpen(true)}>
                Issue credit note
              </Button>
              <span className="muted small">GST can be reduced by credit notes until {data.creditNoteDeadline ?? '—'}.</span>
            </div>
          ) : null}
          <CreditNoteDialog invoice={data} open={creditOpen} onClose={() => setCreditOpen(false)} />
        </div>
      ) : null}
    </SidePanel>
  );
}

function CreditNoteDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('post_supply_discount');
  const left = invoice.total.valueMinor - invoice.credited.valueMinor;
  const issue = useMoneyMutation(
    (body: { mode: 'full' | 'partial'; amountMinor?: number; reason: string }) => api.post<Invoice>(`/billing/invoices/${invoice.id}/credit-notes`, body),
    invoice.deal ? { dealId: invoice.deal.id } : {},
  );
  const minor = parseMajor(amount, invoice.currency);
  const errors = fieldErrorsOf(issue.error);
  return (
    <Dialog open={open} onClose={onClose} title={`Credit note against ${invoice.number}`} description={`Up to ${money({ valueMinor: left, currency: invoice.currency })} can be credited.`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const full = minor === null || minor === left;
          issue.mutate(full && invoice.credited.valueMinor === 0 ? { mode: 'full', reason } : { mode: 'partial', amountMinor: minor ?? left, reason }, {
            onSuccess: async () => {
              await client.invalidateQueries({ queryKey: moneyKeys.invoice(invoice.id) });
              onClose();
            },
          });
        }}
      >
        <DialogBody>
          <Field label="Amount including GST" hint="Leave empty to credit everything that is left" error={errors['body.amountMinor']} optional>
            {(control) => <input {...control} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Reason" error={errors['body.reason']}>
            {(control) => (
              <select {...control} className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="post_supply_discount">Discount after the sale</option>
                <option value="cancellation">Cancellation</option>
                <option value="deficiency">Deficiency in service</option>
                <option value="excess_value">Charged too much</option>
                <option value="excess_tax">Too much tax charged</option>
                <option value="other">Other</option>
              </select>
            )}
          </Field>
          <ErrorAlert error={issue.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={issue.isPending} disabled={amount !== '' && minor === null}>
            Issue credit note
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
