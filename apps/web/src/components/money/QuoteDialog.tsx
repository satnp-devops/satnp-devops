'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Money } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { money, parseMajor, percent, SUPPLY_TYPES } from '@/lib/money/format';
import { moneyApi, useMoneyMutation, usePlans, usePriceLists } from '@/lib/money/queries';
import type { DealBilling, QuoteInput } from '@/lib/money/types';

interface LineDraft {
  planId: string;
  quantity: string;
  discount: string;
}

/** New fee proposal (B2C) or quote (B2B): plans from the company's price lists, GST and discount checked live. */
export function QuoteDialog({ billing, open, onClose }: { billing: DealBilling; open: boolean; onClose: () => void }) {
  const deal = billing.deal;
  const b2c = deal.kind === 'b2c';
  const plans = usePlans({ companyId: deal.companyId }, open);
  const lists = usePriceLists({ companyId: deal.companyId }, open);
  const [priceListId, setPriceListId] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ planId: '', quantity: '1', discount: '' }]);
  const [instalments, setInstalments] = useState(false);
  const [count, setCount] = useState('3');
  const [startDate, setStartDate] = useState(billing.today);
  const [discountNote, setDiscountNote] = useState('');

  const audiencePlans = useMemo(() => (plans.data ?? []).filter((p) => p.audience === deal.kind && p.active), [plans.data, deal.kind]);
  const list = (lists.data ?? []).find((l) => l.id === priceListId) ?? null;
  const currency = list?.currency ?? 'INR';

  // Default price list: the first that prices this deal's kind of plans.
  useEffect(() => {
    if (priceListId || !lists.data?.length || !audiencePlans.length) return;
    const ids = new Set(audiencePlans.map((p) => p.id));
    const best = lists.data.find((l) => l.currency === (deal.currency || 'INR') && l.prices.some((p) => ids.has(p.planId))) ?? lists.data[0];
    if (best) setPriceListId(best.id);
  }, [lists.data, audiencePlans, priceListId, deal.currency]);

  const priced = (planId: string) => list?.prices.find((p) => p.planId === planId)?.unitAmount ?? null;
  const input: QuoteInput | null = useMemo(() => {
    const ready = lines.filter((l) => l.planId);
    if (!ready.length || !priceListId) return null;
    return {
      dealId: deal.id,
      priceListId,
      lines: ready.map((l) => ({
        planId: l.planId,
        quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
        discountMinor: parseMajor(l.discount, currency) ?? 0,
      })),
      ...(instalments && b2c ? { instalmentOption: { count: Number(count) || 2, frequency: 'monthly' as const, startDate } } : {}),
      ...(discountNote ? { discountNote } : {}),
    };
  }, [lines, priceListId, deal.id, currency, instalments, b2c, count, startDate, discountNote]);

  const debounced = useDebounced(input, 350);
  const preview = useQuery({
    queryKey: ['money', 'preview', debounced],
    queryFn: () => moneyApi.previewQuote(debounced as QuoteInput),
    enabled: open && debounced !== null,
    retry: false,
  });
  const create = useMoneyMutation((body: QuoteInput) => moneyApi.createQuote(body), { dealId: deal.id });
  const errors = fieldErrorsOf(create.error ?? preview.error);
  const quote = preview.data;

  const close = () => {
    create.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} size="lg" title={b2c ? 'New fee proposal' : 'New quote'} description={`${deal.ref} · ${deal.title}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input) create.mutate(input, { onSuccess: close });
        }}
      >
        <DialogBody>
          {plans.isPending || lists.isPending ? (
            <Spinner />
          ) : !audiencePlans.length ? (
            <Alert tone="warning" title="No plans yet">
              Add {b2c ? 'fee' : 'software'} plans and prices in Settings › Billing first.
            </Alert>
          ) : (
            <>
              <Field label="Price list" error={errors['body.priceListId']}>
                {(control) => (
                  <select {...control} className="select" value={priceListId} onChange={(e) => setPriceListId(e.target.value)}>
                    {(lists.data ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} · {l.currency} {l.pricesIncludeTax ? '(incl. GST)' : '(plus GST)'}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {lines.map((line, index) => {
                return (
                  <div key={index} className="money-line-row">
                    <Field label={index === 0 ? (b2c ? 'Course or programme' : 'Plan') : `Line ${index + 1}`} error={errors[`body.lines.${index}.planId`] ?? errors[`body.lines.${index}.unitPriceMinor`]}>
                      {(control) => (
                        <select
                          {...control}
                          className="select"
                          value={line.planId}
                          onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, planId: e.target.value } : l)))}
                        >
                          <option value="">Pick a plan</option>
                          {audiencePlans.map((p) => {
                            const amount = priced(p.id);
                            return (
                              <option key={p.id} value={p.id} disabled={!amount}>
                                {p.name}
                                {amount ? ` · ${money(amount)}${p.unit !== 'flat' ? ` per ${p.unit}` : ''}` : ' · no price in this list'}
                              </option>
                            );
                          })}
                        </select>
                      )}
                    </Field>
                    <Field label="Quantity">
                      {(control) => (
                        <input
                          {...control}
                          className="input input--narrow"
                          inputMode="numeric"
                          value={line.quantity}
                          onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
                        />
                      )}
                    </Field>
                    <Field label={`Discount (${currency})`} error={errors[`body.lines.${index}.discountMinor`]} optional>
                      {(control) => (
                        <input
                          {...control}
                          className="input input--narrow"
                          inputMode="decimal"
                          placeholder="0"
                          value={line.discount}
                          onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, discount: e.target.value } : l)))}
                        />
                      )}
                    </Field>
                    {lines.length > 1 ? (
                      <Button size="sm" variant="ghost" icon="x" iconOnly aria-label={`Remove line ${index + 1}`} onClick={() => setLines(lines.filter((_, i) => i !== index))} />
                    ) : null}
                  </div>
                );
              })}
              {lines.length < 10 ? (
                <div>
                  <Button size="sm" variant="ghost" icon="plus" onClick={() => setLines([...lines, { planId: '', quantity: '1', discount: '' }])}>
                    Add a line
                  </Button>
                </div>
              ) : null}
              {b2c ? (
                <div className="stack gap-8">
                  <label className="check">
                    <input type="checkbox" checked={instalments} onChange={(e) => setInstalments(e.target.checked)} />
                    Pay in monthly instalments
                  </label>
                  {instalments ? (
                    <div className="form-grid">
                      <Field label="Instalments" error={errors['body.instalmentOption.count']}>
                        {(control) => (
                          <select {...control} className="select" value={count} onChange={(e) => setCount(e.target.value)}>
                            {[2, 3, 4, 6, 9, 12].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                      <Field label="First due on" error={errors['body.instalmentOption.startDate']}>
                        {(control) => <input {...control} className="input" type="date" value={startDate} min={billing.today} onChange={(e) => setStartDate(e.target.value)} />}
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <section className="money-preview" aria-live="polite" aria-label="Totals">
                {preview.isFetching ? <Spinner label="Pricing" /> : null}
                {quote ? (
                  <>
                    <dl className="money-totals">
                      <div>
                        <dt>List price</dt>
                        <dd>{money(quote.amounts.subtotal)}</dd>
                      </div>
                      {quote.amounts.discount.valueMinor ? (
                        <div>
                          <dt>Discount ({percent(quote.discount.percentBp)})</dt>
                          <dd>−{money(quote.amounts.discount)}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Taxable value</dt>
                        <dd>{money(quote.amounts.taxable)}</dd>
                      </div>
                      <div>
                        <dt>{quote.taxKind === 'igst' ? 'IGST' : quote.taxKind === 'none' ? 'GST' : 'CGST + SGST'}</dt>
                        <dd>{money(quote.amounts.tax)}</dd>
                      </div>
                      <div className="money-totals__grand">
                        <dt>Total</dt>
                        <dd>
                          <Money minor={quote.amounts.total.valueMinor} currency={quote.currency} exact />
                        </dd>
                      </div>
                    </dl>
                    <p className="small muted">{quote.supplyType ? SUPPLY_TYPES[quote.supplyType] : null}</p>
                    {quote.discount.status === 'needs_approval' ? (
                      <Alert tone="warning" title="This discount needs approval">
                        {quote.discount.tierLabel ? `${quote.discount.tierLabel} tier: ` : null}a {quote.discount.approverRoles.map((r) => r.replace('_', ' ')).join(' or ')} must approve it before it can be sent.
                      </Alert>
                    ) : null}
                    {quote.instalmentPreview?.length ? (
                      <ol className="money-schedule">
                        {quote.instalmentPreview.map((i) => (
                          <li key={i.number}>
                            <span className="mono">{i.dueDate}</span> <Money minor={i.amountMinor} currency={quote.currency} exact />
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </>
                ) : preview.isError ? (
                  <ErrorAlert error={preview.error} />
                ) : (
                  <p className="muted small">Pick a plan to see the price with GST.</p>
                )}
              </section>
              {quote?.discount.status === 'needs_approval' ? (
                <Field label="Why this discount" hint="Shown to the approver" optional>
                  {(control) => <input {...control} className="input" maxLength={500} value={discountNote} onChange={(e) => setDiscountNote(e.target.value)} />}
                </Field>
              ) : null}
            </>
          )}
          <ErrorAlert error={create.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!input || preview.isError}>
            {quote?.discount.status === 'needs_approval' ? 'Save and ask for approval' : 'Save draft'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
