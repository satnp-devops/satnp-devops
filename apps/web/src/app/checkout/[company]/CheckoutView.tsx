'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf, isApiError } from '@/lib/api';
import { formatMoney } from '@/lib/crm/format';
import { BATCH_MODES, dateRange, scheduleLabel } from '@/lib/delivery/format';
import type { CheckoutSession, PublicBatch, PublicCheckout } from '@/lib/delivery/types';
import '@/components/delivery/delivery.css';

/** Public header shared by the checkout pages. */
export function CheckoutHeader({ company, title, lead }: { company: string; title: string; lead?: ReactNode }) {
  return (
    <header className="delivery-checkout__top">
      <div className="delivery-checkout__top-inner">
        <div className="delivery-checkout__brand">
          <span className="brand__mark" aria-hidden="true">
            {company.slice(0, 1).toUpperCase()}
          </span>
          {company}
        </div>
        <h1 className="delivery-checkout__title">{title}</h1>
        {lead ? <p className="delivery-checkout__lead">{lead}</p> : null}
      </div>
    </header>
  );
}

export function CheckoutView({ company }: { company: string }) {
  const page = useQuery({
    queryKey: ['public-checkout', company],
    queryFn: () => api.get<PublicCheckout>(`/public/checkout/${encodeURIComponent(company)}`),
  });

  if (page.isPending) {
    return (
      <>
        <CheckoutHeader company="Admission" title="Join a batch" />
        <div className="delivery-checkout__body">
          <Spinner label="Loading the programmes" />
        </div>
      </>
    );
  }
  if (page.isError) {
    return (
      <>
        <CheckoutHeader company="Admission" title="Online admission isn't available" />
        <div className="delivery-checkout__body">
          {isApiError(page.error) && page.error.status === 404 ? (
            <Alert tone="info">This page doesn&apos;t take admissions online. Please call or visit the centre.</Alert>
          ) : (
            <ErrorAlert error={page.error} />
          )}
        </div>
      </>
    );
  }
  return <CheckoutForm data={page.data} onPolicyChanged={() => void page.refetch()} />;
}

function groupByProgramme(batches: PublicBatch[]) {
  const groups = new Map<string, { name: string; line: string; batches: PublicBatch[] }>();
  for (const b of batches) {
    const group = groups.get(b.product.id) ?? { name: b.product.name, line: b.productLine.name, batches: [] };
    group.batches.push(b);
    groups.set(b.product.id, group);
  }
  return [...groups.entries()];
}

function CheckoutForm({ data, onPolicyChanged }: { data: PublicCheckout; onPolicyChanged: () => void }) {
  const [batchId, setBatchId] = useState('');
  const [parent, setParent] = useState({ firstName: '', lastName: '', phone: '', email: '', relation: '' });
  const [student, setStudent] = useState({ firstName: '', lastName: '', grade: '', school: '', city: '' });
  const [accept, setAccept] = useState(false);
  const [whatsapp, setWhatsapp] = useState(true);
  const [marketing, setMarketing] = useState(false);
  const batch = data.batches.find((b) => b.id === batchId) ?? null;
  const start = useMutation({
    mutationFn: () =>
      api.post<CheckoutSession>(`/public/checkout/${encodeURIComponent(data.company.code)}/sessions`, {
        batchId,
        parent: { ...parent, lastName: parent.lastName || undefined, relation: parent.relation || undefined },
        student: {
          firstName: student.firstName,
          lastName: student.lastName || undefined,
          grade: student.grade || undefined,
          school: student.school || undefined,
          city: student.city || undefined,
        },
        consent: { acceptPolicy: accept, policyVersion: data.policy.version, whatsappUpdates: whatsapp, marketing },
      }),
    onSuccess: (session) => {
      if (session.paymentUrl) window.location.assign(session.paymentUrl);
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'policy_changed') {
        setAccept(false);
        onPolicyChanged();
      }
    },
  });
  const errors = fieldErrorsOf(start.error);
  const shown = ['batchId', 'parent.firstName', 'parent.lastName', 'parent.phone', 'parent.email', 'student.firstName', 'student.lastName', 'student.grade', 'student.school', 'student.city', 'consent.acceptPolicy'];
  const setP = (key: keyof typeof parent) => (event: { target: { value: string } }) => setParent({ ...parent, [key]: event.target.value });
  const setS = (key: keyof typeof student) => (event: { target: { value: string } }) => setStudent({ ...student, [key]: event.target.value });

  return (
    <>
      <CheckoutHeader company={data.company.name} title="Join a batch" lead="Pick a batch, tell us about the student and pay securely online. Your seat is confirmed as soon as the payment goes through." />
      <form
        className="delivery-checkout__body"
        onSubmit={(event) => {
          event.preventDefault();
          start.mutate();
        }}
      >
        {data.batches.length === 0 ? <Alert tone="info">No batches are open for online admission right now. Please call the centre.</Alert> : null}
        <section className="delivery-checkout__step" aria-labelledby="step-batch">
          <h2 id="step-batch">
            <span className="delivery-checkout__num">1</span> Programme and batch
          </h2>
          {errors.batchId ? <p className="delivery-overdue small">{errors.batchId}</p> : null}
          {groupByProgramme(data.batches).map(([id, group]) => (
            <fieldset key={id} className="delivery-checkout__programme" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>
                <h3>{group.name}</h3>
              </legend>
              {group.batches.map((b) => (
                <label key={b.id} className="delivery-checkout__batch">
                  <input type="radio" name="batch" value={b.id} checked={batchId === b.id} disabled={b.seatsLeft === 0} onChange={() => setBatchId(b.id)} required />
                  <span className="delivery-checkout__batch-name">{b.name}</span>
                  <span className="delivery-checkout__fee">{formatMoney(b.fee.valueMinor, b.fee.currency)}</span>
                  <span className="delivery-checkout__batch-meta">
                    {dateRange(b.startsOn, b.endsOn)}
                    {scheduleLabel(b.schedule) ? ` · ${scheduleLabel(b.schedule)}` : ''} · {BATCH_MODES[b.mode]}
                    {b.location ? `, ${b.location}` : ''}
                  </span>
                  <span className={b.seatsLeft > 0 && b.seatsLeft <= 5 ? 'delivery-checkout__seats delivery-checkout__seats--low' : 'delivery-checkout__seats'}>
                    {b.seatsLeft === 0 ? 'Full' : b.seatsLeft === 1 ? 'Last seat' : b.seatsLeft <= 5 ? `Only ${b.seatsLeft} seats left` : `${b.seatsLeft} seats left`}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </section>

        <section className="delivery-checkout__step" aria-labelledby="step-parent">
          <h2 id="step-parent">
            <span className="delivery-checkout__num">2</span> Parent or guardian
          </h2>
          <div className="form-grid">
            <Field label="First name" error={errors['parent.firstName']}>
              {(control) => <input {...control} className="input" required autoComplete="given-name" maxLength={80} value={parent.firstName} onChange={setP('firstName')} />}
            </Field>
            <Field label="Last name" optional error={errors['parent.lastName']}>
              {(control) => <input {...control} className="input" autoComplete="family-name" maxLength={80} value={parent.lastName} onChange={setP('lastName')} />}
            </Field>
            <Field label="Mobile number" hint="We send class updates here." error={errors['parent.phone']}>
              {(control) => <input {...control} className="input" required type="tel" autoComplete="tel" inputMode="tel" maxLength={30} value={parent.phone} onChange={setP('phone')} placeholder="98200 12345" />}
            </Field>
            <Field label="Email" error={errors['parent.email']}>
              {(control) => <input {...control} className="input" required type="email" autoComplete="email" maxLength={254} value={parent.email} onChange={setP('email')} />}
            </Field>
            <Field label="Relation to the student" optional>
              {(control) => <input {...control} className="input" maxLength={40} value={parent.relation} onChange={setP('relation')} placeholder="Mother, Father, Guardian" />}
            </Field>
          </div>
        </section>

        <section className="delivery-checkout__step" aria-labelledby="step-student">
          <h2 id="step-student">
            <span className="delivery-checkout__num">3</span> Student
          </h2>
          <div className="form-grid">
            <Field label="First name" error={errors['student.firstName']}>
              {(control) => <input {...control} className="input" required maxLength={80} value={student.firstName} onChange={setS('firstName')} />}
            </Field>
            <Field label="Last name" optional error={errors['student.lastName']}>
              {(control) => <input {...control} className="input" maxLength={80} value={student.lastName} onChange={setS('lastName')} />}
            </Field>
            <Field label="Class or grade" optional error={errors['student.grade']}>
              {(control) => <input {...control} className="input" maxLength={20} value={student.grade} onChange={setS('grade')} placeholder="11" />}
            </Field>
            <Field label="School" optional error={errors['student.school']}>
              {(control) => <input {...control} className="input" maxLength={120} value={student.school} onChange={setS('school')} />}
            </Field>
            <Field label="City" optional error={errors['student.city']}>
              {(control) => <input {...control} className="input" autoComplete="address-level2" maxLength={80} value={student.city} onChange={setS('city')} />}
            </Field>
          </div>
        </section>

        <section className="delivery-checkout__step" aria-labelledby="step-policy">
          <h2 id="step-policy">
            <span className="delivery-checkout__num">4</span> Fees and refunds
          </h2>
          <div className="delivery-checkout__policy" tabIndex={0} aria-label="Fee, exit and refund policy">
            {data.policy.text}
          </div>
          <label className="check">
            <input type="checkbox" checked={accept} required onChange={(event) => setAccept(event.target.checked)} />
            I have read the fee and refund policy and accept it. If the student leaves midway, the fee for the remaining period is refunded within {data.policy.refundDays} days.
          </label>
          {errors['consent.acceptPolicy'] ? <p className="delivery-overdue small">{errors['consent.acceptPolicy']}</p> : null}
          <label className="check">
            <input type="checkbox" checked={whatsapp} onChange={(event) => setWhatsapp(event.target.checked)} />
            Send me timetable and class updates on WhatsApp.
          </label>
          <label className="check">
            <input type="checkbox" checked={marketing} onChange={(event) => setMarketing(event.target.checked)} />
            Tell me about other courses and offers (optional).
          </label>
        </section>

        {formErrorOf(start.error, shown) ? <ErrorAlert error={start.error} /> : null}
        <div className="delivery-checkout__step delivery-checkout__pay">
          <div className="stack gap-2">
            <span className="delivery-checkout__total">{batch ? formatMoney(batch.fee.valueMinor, batch.fee.currency) : 'Pick a batch'}</span>
            <span className="delivery-checkout__note">{batch ? `${batch.product.name}: ${batch.name}` : 'The fee is inclusive of taxes.'}</span>
          </div>
          <Button type="submit" variant="primary" loading={start.isPending} disabled={!batch || !accept}>
            {batch ? `Pay ${formatMoney(batch.fee.valueMinor, batch.fee.currency)}` : 'Pay'}
          </Button>
        </div>
      </form>
    </>
  );
}
