'use client';

import { useState } from 'react';
import { DateTime, KeyValue, Money, Mono, Section, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, CopyButton, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf } from '@/lib/api';
import { INSTALMENT_STATE, money, moneyList, parseMajor, PAYMENT_STATUS, percent, PROVIDER_LABEL, QUOTE_STATUS, REFUND_REASONS, REFUND_STATUS } from '@/lib/money/format';
import { moneyApi, useDealBilling, useMoneyMutation } from '@/lib/money/queries';
import type { DealBilling, Payment, PaymentLinkInput, Quote } from '@/lib/money/types';
import { InvoicePanel } from './InvoicePanel';
import { QuoteDialog } from './QuoteDialog';
import './money.css';

const DEV = process.env.NODE_ENV !== 'production';

/**
 * Fees for one deal, for the deal profile: fee proposals and quotes (with discount approval), payment
 * links (full, instalment, EMI), instalments, invoices and refunds. Every action is checked again by
 * the API; the buttons follow the `can` flags of the deal.
 */
export function FeesPanel({ dealId }: { dealId: string }) {
  const billing = useDealBilling(dealId);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<Payment | null>(null);

  if (billing.isPending) {
    return (
      <Section title="Fees and payments">
        <Spinner />
      </Section>
    );
  }
  if (billing.isError) {
    return (
      <Section title="Fees and payments">
        <ErrorAlert error={billing.error} />
      </Section>
    );
  }
  const data = billing.data;
  const b2c = data.deal.kind === 'b2c';
  return (
    <div className="stack gap-16 money-panel">
      <Section
        title="Fees and payments"
        description={b2c ? 'Fee proposals, payment links, instalments and GST invoices for this family' : 'Quotes, payment links, subscriptions and GST invoices for this institute'}
        actions={
          data.can.manage ? (
            <Button size="sm" variant="primary" icon="plus" onClick={() => setQuoteOpen(true)}>
              {b2c ? 'New fee proposal' : 'New quote'}
            </Button>
          ) : undefined
        }
      >
        <div className="stack gap-12">
          {!data.setup.ready ? (
            <Alert tone="warning" title="Billing isn't fully set up for this company">
              Missing: {data.setup.missing.map((m) => m.replace('_', ' ')).join(', ')}. An admin can finish it in Settings › Billing.
            </Alert>
          ) : null}
          <KeyValue
            layout="inline"
            items={[
              { label: 'Quoted', value: moneyList(data.totals.quoted) },
              { label: 'Paid', value: moneyList(data.totals.paid) },
              { label: 'Instalments due', value: moneyList(data.totals.due) },
              { label: 'Refunded', value: moneyList(data.totals.refunded.filter((m) => m.valueMinor > 0)) },
            ]}
          />
        </div>
      </Section>

      <QuotesSection billing={data} />
      <PaymentsSection billing={data} onInvoice={setInvoiceId} onRefund={setRefundFor} />
      {data.instalmentPlans.length ? <InstalmentsSection billing={data} /> : null}
      {data.invoices.length ? (
        <Section title="Invoices" count={data.invoices.length} flush>
          <ul className="list list--rows">
            {data.invoices.map((invoice) => (
              <li key={invoice.id}>
                <button type="button" className="list__item list__item--button money-row" onClick={() => setInvoiceId(invoice.id)}>
                  <Mono>{invoice.number}</Mono>
                  <span className="muted small mono">{invoice.issueDate}</span>
                  {invoice.status === 'cancelled' ? <StatusPill tone="neutral">Cancelled</StatusPill> : null}
                  {invoice.credited.valueMinor ? <StatusPill tone="accent">Credited {money(invoice.credited)}</StatusPill> : null}
                  <span className="spacer" />
                  <Money minor={invoice.total.valueMinor} currency={invoice.total.currency} exact />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {data.refunds.length ? (
        <Section title="Refunds" count={data.refunds.length} flush>
          <ul className="list list--rows">
            {data.refunds.map((refund) => (
              <li key={refund.id} className="list__item money-row">
                <Mono>{refund.ref}</Mono>
                <StatusPill tone={REFUND_STATUS[refund.status].tone}>{REFUND_STATUS[refund.status].label}</StatusPill>
                <span className="muted small">{refund.requestedBy?.name}</span>
                <span className="spacer" />
                <Money minor={refund.amount.valueMinor} currency={refund.amount.currency} exact />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {quoteOpen ? <QuoteDialog billing={data} open={quoteOpen} onClose={() => setQuoteOpen(false)} /> : null}
      <InvoicePanel invoiceId={invoiceId} onClose={() => setInvoiceId(null)} />
      {refundFor ? <RefundDialog payment={refundFor} dealId={dealId} onClose={() => setRefundFor(null)} /> : null}
    </div>
  );
}

function QuotesSection({ billing }: { billing: DealBilling }) {
  const { can, deal } = billing;
  const action = useMoneyMutation(({ id, name, body }: { id: string; name: Parameters<typeof moneyApi.quoteAction>[1]; body?: unknown }) => moneyApi.quoteAction(id, name, body), { dealId: deal.id });
  const link = useMoneyMutation((input: PaymentLinkInput) => moneyApi.createLink(input), { dealId: deal.id });
  const activePlanQuotes = new Set(billing.instalmentPlans.filter((p) => p.status === 'active').map((p) => p.quoteId));
  const paidFor = (quote: Quote) =>
    billing.payments.filter((p) => p.quoteId === quote.id && p.status === 'succeeded').reduce((sum, p) => sum + p.amount.valueMinor, 0) >= quote.amounts.total.valueMinor;
  const busy = (id: string) => (action.isPending && action.variables?.id === id) || (link.isPending && link.variables?.quoteId === id);
  return (
    <Section title={deal.kind === 'b2c' ? 'Fee proposals' : 'Quotes'} count={billing.quotes.length} flush>
      {billing.quotes.length === 0 ? (
        <EmptyState icon="card" title="Nothing proposed yet">
          {can.manage ? 'Make a fee proposal from the company’s plans and price list.' : 'The deal’s owner makes proposals here.'}
        </EmptyState>
      ) : (
        <ul className="list list--rows">
          {billing.quotes.map((quote) => {
            const status = QUOTE_STATUS[quote.status];
            const canSend = can.manage && (quote.status === 'approved' || (quote.status === 'draft' && ['none', 'allowed'].includes(quote.discount.status)));
            const canLink = can.manage && ['sent', 'accepted'].includes(quote.status) && !activePlanQuotes.has(quote.id) && !paidFor(quote);
            return (
              <li key={quote.id} className="list__item stack gap-8 money-item">
                <div className="money-row">
                  <Mono>{quote.ref ?? ''}</Mono>
                  <span className="strong money-row__title">{quote.title}</span>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  <span className="spacer" />
                  <Money minor={quote.amounts.total.valueMinor} currency={quote.currency} exact />
                </div>
                <p className="small muted">
                  {quote.lines.map((l) => `${l.description}${l.quantity !== 1 ? ` × ${l.quantity}` : ''}`).join(', ')}
                  {quote.amounts.discount.valueMinor ? ` · discount ${money(quote.amounts.discount)} (${percent(quote.discount.percentBp)})` : ''}
                  {` · GST ${money(quote.amounts.tax)}`}
                  {quote.validUntil ? ` · valid until ${quote.validUntil}` : ''}
                  {quote.instalmentOption ? ` · ${quote.instalmentOption.count} instalments` : ''}
                </p>
                {quote.status === 'pending_approval' ? (
                  <p className="small">
                    Waiting for a {quote.discount.approverRoles.map((r) => r.replace('_', ' ')).join(' or ')} to approve {percent(quote.discount.percentBp)} off
                    {quote.discount.requestedBy ? `, asked by ${quote.discount.requestedBy.name}` : ''}.
                  </p>
                ) : null}
                <div className="row gap-6 money-actions">
                  {quote.status === 'pending_approval' && can.approveDiscounts ? (
                    <>
                      <Button size="sm" variant="primary" loading={busy(quote.id!)} onClick={() => action.mutate({ id: quote.id!, name: 'approve-discount' })}>
                        Approve discount
                      </Button>
                      <Button size="sm" onClick={() => action.mutate({ id: quote.id!, name: 'reject-discount' })}>
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {canSend ? (
                    <Button size="sm" variant="primary" icon="message" loading={busy(quote.id!)} onClick={() => action.mutate({ id: quote.id!, name: 'send' })}>
                      Send to {deal.kind === 'b2c' ? 'family' : 'institute'}
                    </Button>
                  ) : null}
                  {can.manage && quote.status === 'sent' ? (
                    <Button size="sm" onClick={() => action.mutate({ id: quote.id!, name: 'accept' })}>
                      Mark accepted
                    </Button>
                  ) : null}
                  {canLink ? (
                    <>
                      <Button size="sm" icon="link" loading={busy(quote.id!)} onClick={() => link.mutate({ dealId: deal.id, purpose: 'full', quoteId: quote.id! })}>
                        Send payment link
                      </Button>
                      {deal.kind === 'b2c' && quote.currency === 'INR' ? (
                        <Button size="sm" variant="ghost" onClick={() => link.mutate({ dealId: deal.id, purpose: 'emi', quoteId: quote.id! })}>
                          Link with EMI
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {can.manage && ['draft', 'pending_approval', 'approved', 'sent'].includes(quote.status) ? (
                    <Button size="sm" variant="ghost" onClick={() => action.mutate({ id: quote.id!, name: 'cancel' })}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {action.error || link.error ? (
        <div className="card__body">
          <ErrorAlert error={action.error ?? link.error} />
        </div>
      ) : null}
    </Section>
  );
}

function PaymentsSection({ billing, onInvoice, onRefund }: { billing: DealBilling; onInvoice: (id: string) => void; onRefund: (p: Payment) => void }) {
  const { can, deal } = billing;
  const act = useMoneyMutation(({ id, name }: { id: string; name: 'cancel' | 'resend' | 'invoice' }) => moneyApi.paymentAction(id, name), { dealId: deal.id });
  const simulate = useMoneyMutation(({ id, outcome }: { id: string; outcome: 'succeeded' | 'failed' }) => moneyApi.simulatePayment(id, outcome), { dealId: deal.id });
  return (
    <Section title="Payments" count={billing.payments.length} flush>
      {billing.payments.length === 0 ? (
        <EmptyState icon="card" title="No payments yet">
          Payment links appear here once a proposal is sent.
        </EmptyState>
      ) : (
        <ul className="list list--rows">
          {billing.payments.map((payment) => {
            const status = PAYMENT_STATUS[payment.status];
            const open = ['link_sent', 'failed', 'pending'].includes(payment.status);
            return (
              <li key={payment.id} className="list__item stack gap-6 money-item">
                <div className="money-row">
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  <span className="money-row__title">{payment.description}</span>
                  <span className="spacer" />
                  <Money minor={payment.amount.valueMinor} currency={payment.amount.currency} exact />
                </div>
                <p className="small muted">
                  {PROVIDER_LABEL[payment.provider]}
                  {payment.method ? ` · ${payment.method.replace('_', ' ')}` : ''}
                  {payment.paidAt ? (
                    <>
                      {' · paid '}
                      <DateTime value={payment.paidAt} />
                    </>
                  ) : (
                    <>
                      {' · created '}
                      <DateTime value={payment.createdAt} />
                    </>
                  )}
                  {payment.failure?.message ? ` · ${payment.failure.message}` : ''}
                  {payment.nextRetryAt ? ' · reminder scheduled' : ''}
                  {payment.refunded.valueMinor ? ` · refunded ${money(payment.refunded)}` : ''}
                </p>
                {payment.invoiceError ? <p className="small money-warning">No invoice yet: {payment.invoiceError}</p> : null}
                <div className="row gap-6 money-actions">
                  {payment.linkUrl && open ? <CopyButton text={payment.linkUrl} label="Copy link" /> : null}
                  {payment.invoiceId ? (
                    <Button size="sm" icon="note" onClick={() => onInvoice(payment.invoiceId!)}>
                      Invoice {payment.invoiceNumber}
                    </Button>
                  ) : null}
                  {payment.invoiceError && can.finance ? (
                    <Button size="sm" onClick={() => act.mutate({ id: payment.id, name: 'invoice' })}>
                      Issue invoice
                    </Button>
                  ) : null}
                  {can.manage && payment.status === 'link_sent' ? (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: payment.id, name: 'resend' })}>
                      Send again
                    </Button>
                  ) : null}
                  {can.manage && open && payment.provider !== 'manual' ? (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: payment.id, name: 'cancel' })}>
                      Cancel link
                    </Button>
                  ) : null}
                  {can.manage && payment.status === 'succeeded' && payment.refunded.valueMinor < payment.amount.valueMinor ? (
                    <Button size="sm" variant="ghost" onClick={() => onRefund(payment)}>
                      Request refund
                    </Button>
                  ) : null}
                  {DEV && can.manage && open && payment.provider !== 'manual' ? (
                    <>
                      <Button size="sm" variant="ghost" title="Development only" onClick={() => simulate.mutate({ id: payment.id, outcome: 'succeeded' })}>
                        Simulate paid
                      </Button>
                      <Button size="sm" variant="ghost" title="Development only" onClick={() => simulate.mutate({ id: payment.id, outcome: 'failed' })}>
                        Simulate failure
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {act.error || simulate.error ? (
        <div className="card__body">
          <ErrorAlert error={act.error ?? simulate.error} />
        </div>
      ) : null}
    </Section>
  );
}

function InstalmentsSection({ billing }: { billing: DealBilling }) {
  const { can, deal } = billing;
  const link = useMoneyMutation((input: PaymentLinkInput) => moneyApi.createLink(input), { dealId: deal.id });
  const openLinks = new Set(billing.payments.filter((p) => p.instalmentId && ['link_sent', 'pending', 'creating'].includes(p.status)).map((p) => p.instalmentId));
  return (
    <Section title="Instalments" flush>
      {billing.instalmentPlans.map((plan) => (
        <div key={plan.id} className="money-plan">
          <p className="small muted money-plan__head">
            {plan.count} instalments · {money(plan.total)} · {plan.status}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="money-num">
                    Amount
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.instalments.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td className="mono nowrap">{i.dueDate}</td>
                    <td className="money-num">
                      <Money minor={i.outstanding.valueMinor || i.amount.valueMinor} currency={i.amount.currency} exact />
                    </td>
                    <td>
                      <StatusPill tone={INSTALMENT_STATE[i.state].tone}>{INSTALMENT_STATE[i.state].label}</StatusPill>
                    </td>
                    <td>
                      {can.manage && i.status === 'pending' && plan.status === 'active' ? (
                        openLinks.has(i.id) ? (
                          <span className="small muted">Link sent</span>
                        ) : (
                          <Button size="sm" loading={link.isPending && link.variables?.instalmentId === i.id} onClick={() => link.mutate({ dealId: deal.id, purpose: 'instalment', instalmentId: i.id })}>
                            Send link
                          </Button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {link.error ? (
        <div className="card__body">
          <ErrorAlert error={link.error} />
        </div>
      ) : null}
    </Section>
  );
}

function RefundDialog({ payment, dealId, onClose }: { payment: Payment; dealId: string; onClose: () => void }) {
  const left = payment.amount.valueMinor - payment.refunded.valueMinor;
  const [amount, setAmount] = useState(String(left / 100));
  const [reason, setReason] = useState<string>('requested_by_customer');
  const [note, setNote] = useState('');
  const request = useMoneyMutation((body: { paymentId: string; amountMinor: number; reason: string; note?: string }) => moneyApi.requestRefund(body), { dealId });
  const minor = parseMajor(amount, payment.amount.currency);
  const errors = fieldErrorsOf(request.error);
  return (
    <Dialog open onClose={onClose} title="Request a refund" description={`Finance approves refunds. Up to ${money({ valueMinor: left, currency: payment.amount.currency })} can be refunded.`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (minor) request.mutate({ paymentId: payment.id, amountMinor: minor, reason, ...(note ? { note } : {}) }, { onSuccess: onClose });
        }}
      >
        <DialogBody>
          <Field label="Amount" error={errors['body.amountMinor']}>
            {(control) => <input {...control} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Reason" error={errors['body.reason']}>
            {(control) => (
              <select {...control} className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REFUND_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Note for finance" optional error={errors['body.note']}>
            {(control) => <textarea {...control} className="textarea" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <ErrorAlert error={request.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={request.isPending} disabled={!minor}>
            Ask finance to refund
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
