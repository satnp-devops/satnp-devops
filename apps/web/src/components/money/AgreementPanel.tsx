'use client';

import { useState } from 'react';
import { DateTime, Masked, Mono, Section, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf } from '@/lib/api';
import { AGREEMENT_STATUS } from '@/lib/money/format';
import { moneyApi, useDealBilling, useMoneyMutation } from '@/lib/money/queries';
import type { AgreementInput, DealBilling } from '@/lib/money/types';
import './money.css';

const DEV = process.env.NODE_ENV !== 'production';
const SIGN_TYPE: Record<string, string> = { aadhaar: 'Aadhaar e-sign', electronic: 'Electronic signature', dsc: 'Digital signature (DSC)' };

/**
 * Agreements for one deal, for the deal profile: made from a company template, sent for e-sign
 * (Digio), with each signer's status. Signer emails and mobiles are masked without contacts.view_pii.
 */
export function AgreementPanel({ dealId }: { dealId: string }) {
  const billing = useDealBilling(dealId);
  const [open, setOpen] = useState(false);
  const act = useMoneyMutation(({ id, name, body }: { id: string; name: 'send' | 'cancel' | 'refresh' | 'simulate'; body?: unknown }) => moneyApi.agreementAction(id, name, body), { dealId });

  if (billing.isPending) {
    return (
      <Section title="Agreements">
        <Spinner />
      </Section>
    );
  }
  if (billing.isError) {
    return (
      <Section title="Agreements">
        <ErrorAlert error={billing.error} />
      </Section>
    );
  }
  const data = billing.data;
  const templates = data.templates.filter((t) => t.audience === data.deal.kind);
  return (
    <Section
      title="Agreements"
      count={data.agreements.length}
      flush
      actions={
        data.can.manage && templates.length ? (
          <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
            New agreement
          </Button>
        ) : undefined
      }
    >
      {data.agreements.length === 0 ? (
        <EmptyState icon="note" title="No agreements yet">
          {templates.length ? 'Make one from a template and send it for e-sign.' : 'Add an agreement template in Settings › Billing first.'}
        </EmptyState>
      ) : (
        <ul className="list list--rows">
          {data.agreements.map((agreement) => {
            const status = AGREEMENT_STATUS[agreement.status];
            const busy = act.isPending && act.variables?.id === agreement.id;
            return (
              <li key={agreement.id} className="list__item stack gap-8 money-item">
                <div className="money-row">
                  <Mono>{agreement.ref}</Mono>
                  <span className="strong money-row__title">{agreement.title}</span>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </div>
                <p className="small muted">
                  {SIGN_TYPE[agreement.signType] ?? agreement.signType}
                  {agreement.sentAt ? (
                    <>
                      {' · sent '}
                      <DateTime value={agreement.sentAt} format="date" />
                    </>
                  ) : null}
                  {agreement.signedAt ? (
                    <>
                      {' · signed '}
                      <DateTime value={agreement.signedAt} format="date" />
                    </>
                  ) : agreement.expiresAt && ['sent', 'partially_signed'].includes(agreement.status) ? (
                    <>
                      {' · expires '}
                      <DateTime value={agreement.expiresAt} format="date" />
                    </>
                  ) : null}
                  {agreement.failure?.message ? ` · ${agreement.failure.message}` : ''}
                </p>
                <ul className="money-signers" aria-label="Signers">
                  {agreement.signers.map((signer) => (
                    <li key={`${signer.order}-${signer.name}`}>
                      <span className="mono small">{signer.order}</span>
                      <span>{signer.name}</span>
                      <span className="muted small">{signer.role}</span>
                      {signer.identifierMasked ? <Masked value={signer.identifier} kind={signer.identifier.includes('@') ? 'email' : 'phone'} /> : <span className="small">{signer.identifier}</span>}
                      <StatusPill tone={signer.status === 'signed' ? 'success' : signer.status === 'failed' || signer.status === 'rejected' ? 'danger' : 'neutral'}>{signer.status}</StatusPill>
                    </li>
                  ))}
                </ul>
                {data.can.manage ? (
                  <div className="row gap-6 money-actions">
                    {['draft', 'failed'].includes(agreement.status) ? (
                      <Button size="sm" variant="primary" loading={busy} onClick={() => act.mutate({ id: agreement.id, name: 'send' })}>
                        Send for e-sign
                      </Button>
                    ) : null}
                    {['sent', 'partially_signed'].includes(agreement.status) ? (
                      <Button size="sm" icon="refresh" loading={busy} onClick={() => act.mutate({ id: agreement.id, name: 'refresh' })}>
                        Check status
                      </Button>
                    ) : null}
                    {['draft', 'sent', 'partially_signed', 'failed'].includes(agreement.status) ? (
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: agreement.id, name: 'cancel', body: { reason: 'Cancelled from the deal' } })}>
                        Cancel
                      </Button>
                    ) : null}
                    {DEV && ['sent', 'partially_signed'].includes(agreement.status) ? (
                      <Button size="sm" variant="ghost" title="Development only" onClick={() => act.mutate({ id: agreement.id, name: 'simulate', body: { outcome: 'signed' } })}>
                        Simulate signed
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {act.error ? (
        <div className="card__body">
          <ErrorAlert error={act.error} />
        </div>
      ) : null}
      {open ? <AgreementDialog billing={data} onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

interface SignerDraft {
  name: string;
  identifier: string;
  role: string;
}

function AgreementDialog({ billing, onClose }: { billing: DealBilling; onClose: () => void }) {
  const b2c = billing.deal.kind === 'b2c';
  const templates = billing.templates.filter((t) => t.audience === billing.deal.kind);
  const quotes = billing.quotes.filter((q) => ['sent', 'accepted', 'approved'].includes(q.status));
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [quoteId, setQuoteId] = useState(quotes[0]?.id ?? '');
  const [signers, setSigners] = useState<SignerDraft[]>([{ name: '', identifier: '', role: b2c ? 'parent' : 'signatory' }]);
  const [send, setSend] = useState(true);
  const create = useMoneyMutation((input: AgreementInput) => moneyApi.createAgreement(input), { dealId: billing.deal.id });
  const errors = fieldErrorsOf(create.error);
  const update = (index: number, patch: Partial<SignerDraft>) => setSigners(signers.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  return (
    <Dialog open onClose={onClose} size="lg" title="New agreement" description="The template is filled in with the deal and the proposal, then sent to each signer.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            { dealId: billing.deal.id, templateId, ...(quoteId ? { quoteId } : {}), signers: signers.map((s, i) => ({ ...s, order: i + 1 })), send },
            { onSuccess: onClose },
          );
        }}
      >
        <DialogBody>
          <div className="form-grid">
            <Field label="Template" error={errors['body.templateId']}>
              {(control) => (
                <select {...control} className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {SIGN_TYPE[t.signType]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={b2c ? 'Fee proposal' : 'Quote'} optional error={errors['body.quoteId']}>
              {(control) => (
                <select {...control} className="select" value={quoteId} onChange={(e) => setQuoteId(e.target.value)}>
                  <option value="">None</option>
                  {quotes.map((q) => (
                    <option key={q.id} value={q.id ?? ''}>
                      {q.ref} · {q.title}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {signers.map((signer, index) => (
            <div key={index} className="money-line-row">
              <Field label={`Signer ${index + 1}`} error={errors[`body.signers.${index}.name`]}>
                {(control) => <input {...control} className="input" value={signer.name} autoComplete="off" onChange={(e) => update(index, { name: e.target.value })} />}
              </Field>
              <Field label="Email or mobile" hint="Indian mobile: 10 digits" error={errors[`body.signers.${index}.identifier`]}>
                {(control) => <input {...control} className="input" value={signer.identifier} autoComplete="off" onChange={(e) => update(index, { identifier: e.target.value })} />}
              </Field>
              <Field label="Role">
                {(control) => (
                  <select {...control} className="select" value={signer.role} onChange={(e) => update(index, { role: e.target.value })}>
                    {(b2c ? ['parent', 'guardian', 'student', 'witness'] : ['signatory', 'witness', 'company']).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {signers.length > 1 ? (
                <Button size="sm" variant="ghost" icon="x" iconOnly aria-label={`Remove signer ${index + 1}`} onClick={() => setSigners(signers.filter((_, i) => i !== index))} />
              ) : null}
            </div>
          ))}
          {signers.length < 5 ? (
            <div>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setSigners([...signers, { name: '', identifier: '', role: b2c ? 'student' : 'witness' }])}>
                Add a signer
              </Button>
            </div>
          ) : null}
          <label className="check">
            <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
            Send for e-sign now
          </label>
          <ErrorAlert error={create.error} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!templateId || signers.some((s) => !s.name.trim() || !s.identifier.trim())}>
            {send ? 'Create and send' : 'Create draft'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
