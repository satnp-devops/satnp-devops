'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/icons';
import { Alert, Button, ErrorAlert, Field, FieldGroup, PageLoading } from '@/components/ui';
import { BookingSummaryCard, EventFacts, PublicShell, whenText } from '@/components/scheduling/PublicShell';
import { SlotPicker } from '@/components/scheduling/SlotPicker';
import { api, fieldErrorsOf, formErrorOf, isApiError } from '@/lib/api';
import { detectedTimeZone, schedulingKeys } from '@/lib/scheduling/api';
import type { PublicBooking, PublicPage, Slot } from '@/lib/scheduling/types';

function newKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Friendly words for a link that can't be used. */
export function LinkProblem({ error }: { error: unknown }) {
  const code = isApiError(error) ? error.code : null;
  const title =
    code === 'link_expired'
      ? 'This booking link has expired'
      : code === 'link_used'
        ? 'This booking link has already been used'
        : code === 'unavailable'
          ? 'Bookings are closed for this meeting'
          : isApiError(error) && error.status === 404
            ? 'This booking link is not valid'
            : 'We could not open this booking page';
  return (
    <PublicShell branding={null}>
      <section className="sch-public__card">
        <h1>{title}</h1>
        <p className="muted">
          {code === 'link_expired' || code === 'link_used'
            ? 'Ask the person who sent it for a new link.'
            : isApiError(error) && error.status === 429
              ? 'Too many tries from this network. Wait a few minutes and try again.'
              : 'Check that you opened the whole link, or ask for a new one.'}
        </p>
      </section>
    </PublicShell>
  );
}

export function BookingPage({ token }: { token: string }) {
  const page = useQuery({
    queryKey: schedulingKeys.publicPage(token),
    queryFn: () => api.get<PublicPage>(`/public/booking/${token}`),
    retry: false,
  });
  const [zone, setZone] = useState(() => (typeof window === 'undefined' ? 'Asia/Kolkata' : detectedTimeZone()));
  const [slot, setSlot] = useState<Slot | null>(null);
  const [done, setDone] = useState<PublicBooking | null>(null);

  if (page.isLoading) return <PageLoading />;
  if (page.error || !page.data) return <LinkProblem error={page.error} />;
  const data = page.data;

  if (done) {
    return (
      <PublicShell branding={data.branding}>
        <BookingSummaryCard booking={done} zone={zone} title="You're booked">
          <p className="small muted">
            We have emailed the details. Need to change it?{' '}
            <a href={`/book/manage/${done.manageToken}`}>Reschedule or cancel</a>.
          </p>
        </BookingSummaryCard>
      </PublicShell>
    );
  }

  if (data.usedUp) {
    return (
      <PublicShell branding={data.branding}>
        <section className="sch-public__card">
          <h1>This link has already been used</h1>
          <p className="muted">Check your email for the booking we made, or ask for a new link.</p>
        </section>
      </PublicShell>
    );
  }

  return (
    <PublicShell branding={data.branding}>
      <div className="sch-public__layout">
        <section className="sch-public__card" aria-labelledby="event-title">
          {data.branding.headline ? <p className="small strong muted">{data.branding.headline}</p> : null}
          <h1 id="event-title">{data.eventType.name}</h1>
          <EventFacts eventType={data.eventType} hostName={data.hostName} />
          {data.eventType.description ? <p className="small">{data.eventType.description}</p> : null}
        </section>
        <section className="sch-public__card" aria-label={slot ? 'Your details' : 'Pick a time'}>
          {slot ? (
            <DetailsForm token={token} page={data} slot={slot} zone={zone} onBack={() => setSlot(null)} onBooked={setDone} />
          ) : (
            <>
              <h2 className="title-lg">Pick a time</h2>
              <SlotPicker
                source={{ kind: 'link', token }}
                timeZone={zone}
                onTimeZoneChange={setZone}
                horizonDays={data.eventType.horizonDays}
                selected={null}
                onSelect={setSlot}
              />
            </>
          )}
        </section>
      </div>
    </PublicShell>
  );
}

function DetailsForm({
  token,
  page,
  slot,
  zone,
  onBack,
  onBooked,
}: {
  token: string;
  page: PublicPage;
  slot: Slot;
  zone: string;
  onBack: () => void;
  onBooked: (booking: PublicBooking) => void;
}) {
  const { eventType } = page;
  const [name, setName] = useState(page.prefill.name ?? '');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [attending, setAttending] = useState(page.prefill.attending ?? '');
  const [guests, setGuests] = useState<Array<{ name: string; email: string }>>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  // One key per form: a double tap or a retry after a timeout makes one booking.
  const [idempotencyKey] = useState(newKey);

  const book = useMutation({
    mutationFn: () =>
      api.post<PublicBooking>(`/public/booking/${token}/book`, {
        start: slot.start,
        timeZone: zone,
        name,
        email,
        phone: phone.trim() || undefined,
        attending: attending || undefined,
        guests: guests.filter((g) => g.name.trim()).map((g) => ({ name: g.name.trim(), email: g.email.trim() || undefined })),
        answers,
        notes: notes.trim() || undefined,
        idempotencyKey,
      }),
    onSuccess: onBooked,
  });
  const errors = fieldErrorsOf(book.error);
  const taken = isApiError(book.error) && book.error.code === 'slot_unavailable';
  const shown = ['name', 'email', 'phone', 'attending', 'guests', 'notes', ...eventType.questions.map((q) => `answers.${q.key}`)];

  return (
    <form
      className="stack gap-16"
      onSubmit={(event) => {
        event.preventDefault();
        book.mutate();
      }}
    >
      <div className="sch-chosen">
        <div className="stack gap-2">
          <span className="small muted">Your time</span>
          <strong>{whenText(slot.start, slot.end, zone)}</strong>
        </div>
        <Button size="sm" onClick={onBack}>
          Change
        </Button>
      </div>
      {taken ? (
        <Alert tone="warning" title="Someone just took that time" action={<Button size="sm" onClick={onBack}>Pick another time</Button>}>
          Sorry about that. Pick another time and we will hold it for you.
        </Alert>
      ) : (
        <ErrorAlert error={formErrorOf(book.error, shown)} />
      )}

      <Field label="Your name" error={errors.name}>
        {(control) => <input {...control} className="input" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Email" hint="We send the confirmation and joining link here." error={errors.email}>
        {(control) => <input {...control} className="input" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field label="Phone or WhatsApp" optional hint="For reminders, like +91 98765 43210." error={errors.phone}>
        {(control) => <input {...control} className="input" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
      </Field>

      {eventType.attendees.ask ? (
        <FieldGroup label={eventType.attendees.label} error={errors.attending}>
          <div className="row gap-8">
            {eventType.attendees.options.map((option) => (
              <label key={option.value} className="chip-toggle">
                <input type="radio" name="attending" value={option.value} checked={attending === option.value} onChange={() => setAttending(option.value)} required />
                {option.label}
              </label>
            ))}
          </div>
        </FieldGroup>
      ) : null}

      {eventType.attendees.maxGuests > 0 ? (
        <FieldGroup label="Anyone else joining?" hint={`Add up to ${eventType.attendees.maxGuests}.`} error={errors.guests}>
          <div className="sch-guests">
            {guests.map((guest, index) => (
              <div key={index} className="sch-guest">
                <input
                  className="input"
                  aria-label={`Guest ${index + 1} name`}
                  placeholder="Name"
                  value={guest.name}
                  onChange={(e) => setGuests(guests.map((g, i) => (i === index ? { ...g, name: e.target.value } : g)))}
                />
                <input
                  className="input"
                  type="email"
                  aria-label={`Guest ${index + 1} email`}
                  placeholder="Email (optional)"
                  value={guest.email}
                  onChange={(e) => setGuests(guests.map((g, i) => (i === index ? { ...g, email: e.target.value } : g)))}
                />
                <Button size="sm" variant="ghost" iconOnly icon="x" aria-label={`Remove guest ${index + 1}`} onClick={() => setGuests(guests.filter((_, i) => i !== index))} />
              </div>
            ))}
            {guests.length < eventType.attendees.maxGuests ? (
              <div>
                <Button size="sm" icon="plus" onClick={() => setGuests([...guests, { name: '', email: '' }])}>
                  Add a person
                </Button>
              </div>
            ) : null}
          </div>
        </FieldGroup>
      ) : null}

      {eventType.questions.map((question) => (
        <Field key={question.key} label={question.label} optional={!question.required} hint={question.help ?? undefined} error={errors[`answers.${question.key}`]}>
          {(control) =>
            question.type === 'select' ? (
              <select {...control} className="select" required={question.required} value={answers[question.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [question.key]: e.target.value })}>
                <option value="">Choose…</option>
                {(question.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : question.type === 'textarea' ? (
              <textarea {...control} className="textarea" rows={3} required={question.required} value={answers[question.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [question.key]: e.target.value })} />
            ) : (
              <input
                {...control}
                className="input"
                type={question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : 'text'}
                required={question.required}
                value={answers[question.key] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [question.key]: e.target.value })}
              />
            )
          }
        </Field>
      ))}

      <Field label="Anything we should know?" optional error={errors.notes}>
        {(control) => <textarea {...control} className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>

      <Button type="submit" variant="primary" block loading={book.isPending}>
        <Icon name="check" size={16} aria-hidden="true" />
        Confirm booking
      </Button>
      <p className="small muted">By booking you agree that {page.branding.companyName} may contact you about this meeting.</p>
    </form>
  );
}
