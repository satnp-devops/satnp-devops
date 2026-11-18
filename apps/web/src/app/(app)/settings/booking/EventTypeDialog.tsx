'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field, FieldGroup, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { LOCATION_LABELS, schedulingKeys, useHostCandidates } from '@/lib/scheduling/api';
import type { EventType, EventTypeInput, HostInput, LocationKind, Question, QuestionType } from '@/lib/scheduling/types';

const REMINDERS = [
  { value: 1440, label: '1 day before' },
  { value: 120, label: '2 hours before' },
  { value: 60, label: '1 hour before' },
  { value: 15, label: '15 minutes before' },
];
const QUESTION_TYPES: Array<{ value: QuestionType; label: string }> = [
  { value: 'text', label: 'Short answer' },
  { value: 'textarea', label: 'Long answer' },
  { value: 'select', label: 'Choice' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
];
const DEFAULT_ATTENDING = [
  { value: 'parent', label: 'Parent' },
  { value: 'student', label: 'Student' },
  { value: 'both', label: 'Parent and student' },
];

const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function initial(eventType: EventType | null): EventTypeInput {
  if (!eventType) {
    return {
      name: '',
      slug: '',
      description: null,
      durationMin: 30,
      slotIntervalMin: null,
      bufferBeforeMin: 0,
      bufferAfterMin: 10,
      minNoticeMin: 240,
      maxPerDay: null,
      horizonDays: 30,
      locationKind: 'zoom',
      locationDetail: null,
      assignment: 'round_robin',
      attendanceThresholdMin: 10,
      reminderOffsetsMin: [1440, 60],
      questions: [],
      attendees: { ask: true, options: DEFAULT_ATTENDING, maxGuests: 1 },
      branding: {},
      dealKind: null,
    };
  }
  return {
    name: eventType.name,
    slug: eventType.slug,
    description: eventType.description,
    durationMin: eventType.durationMin,
    slotIntervalMin: eventType.slotIntervalMin,
    bufferBeforeMin: eventType.bufferBeforeMin,
    bufferAfterMin: eventType.bufferAfterMin,
    minNoticeMin: eventType.minNoticeMin,
    maxPerDay: eventType.maxPerDay,
    horizonDays: eventType.horizonDays,
    locationKind: eventType.locationKind,
    locationDetail: eventType.locationDetail,
    assignment: eventType.assignment,
    attendanceThresholdMin: eventType.attendanceThresholdMin,
    reminderOffsetsMin: eventType.reminderOffsetsMin,
    questions: eventType.questions,
    attendees: { ask: Boolean(eventType.attendees.ask), label: eventType.attendees.label, options: eventType.attendees.options?.length ? eventType.attendees.options : DEFAULT_ATTENDING, maxGuests: eventType.attendees.maxGuests ?? 0 },
    branding: eventType.branding,
    dealKind: eventType.dealKind,
  };
}

const num = (value: string): number => (value === '' ? Number.NaN : Number(value));

export function EventTypeDialog({ open, onClose, unitId, unitName, eventType }: { open: boolean; onClose: () => void; unitId: string; unitName: string; eventType: EventType | null }) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={eventType ? `Edit ${eventType.name}` : 'New event type'} description={eventType ? `Owned by ${eventType.unit.name}.` : `A bookable meeting for ${unitName}, with its own booking page.`}>
      {open ? <EventTypeForm onClose={onClose} unitId={eventType?.unit.id ?? unitId} eventType={eventType} /> : null}
    </Dialog>
  );
}

function EventTypeForm({ onClose, unitId, eventType }: { onClose: () => void; unitId: string; eventType: EventType | null }) {
  const queryClient = useQueryClient();
  const candidates = useHostCandidates(unitId);
  const [form, setForm] = useState<EventTypeInput>(() => initial(eventType));
  const [slugTouched, setSlugTouched] = useState(Boolean(eventType));
  const [hosts, setHosts] = useState<HostInput[]>(() =>
    (eventType?.hosts ?? []).map((h) => ({ userId: h.user.id, weight: h.weight, priority: h.priority, languages: h.languages, active: h.active })),
  );
  const set = <K extends keyof EventTypeInput>(key: K, value: EventTypeInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const body = { ...form, description: form.description?.trim() || null, locationDetail: form.locationDetail?.trim() || null };
      if (!eventType) return api.post<EventType>('/scheduling/event-types', { ...body, unitId, hosts });
      await api.patch<EventType>(`/scheduling/event-types/${eventType.id}`, body);
      return api.put<EventType>(`/scheduling/event-types/${eventType.id}/hosts`, hosts);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const shown = ['name', 'slug', 'durationMin', 'slotIntervalMin', 'bufferBeforeMin', 'bufferAfterMin', 'minNoticeMin', 'maxPerDay', 'horizonDays', 'locationKind', 'locationDetail', 'attendanceThresholdMin', 'hosts'];
  const hostOf = (id: string) => hosts.find((h) => h.userId === id);

  const setQuestion = (index: number, patch: Partial<Question>) => set('questions', form.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, shown)} />
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input
                {...control}
                className="input"
                required
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
                }}
              />
            )}
          </Field>
          <Field label="Link name" hint="Lower-case words joined by dashes." error={errors.slug}>
            {(control) => (
              <input
                {...control}
                className="input mono"
                required
                value={form.slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  set('slug', e.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Field label="Description" optional hint="Shown on the booking page.">
          {(control) => <textarea {...control} className="textarea" rows={2} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />}
        </Field>

        <div className="form-grid">
          <Field label="Length (minutes)" error={errors.durationMin}>
            {(control) => <input {...control} className="input" type="number" min={5} max={480} step={5} required value={form.durationMin} onChange={(e) => set('durationMin', num(e.target.value))} />}
          </Field>
          <Field label="Start times every (minutes)" optional hint="Empty = the length." error={errors.slotIntervalMin}>
            {(control) => <input {...control} className="input" type="number" min={5} max={480} step={5} value={form.slotIntervalMin ?? ''} onChange={(e) => set('slotIntervalMin', e.target.value ? num(e.target.value) : null)} />}
          </Field>
          <Field label="Break before (minutes)" error={errors.bufferBeforeMin}>
            {(control) => <input {...control} className="input" type="number" min={0} max={240} value={form.bufferBeforeMin} onChange={(e) => set('bufferBeforeMin', num(e.target.value))} />}
          </Field>
          <Field label="Break after (minutes)" error={errors.bufferAfterMin}>
            {(control) => <input {...control} className="input" type="number" min={0} max={240} value={form.bufferAfterMin} onChange={(e) => set('bufferAfterMin', num(e.target.value))} />}
          </Field>
          <Field label="Minimum notice (hours)" error={errors.minNoticeMin}>
            {(control) => <input {...control} className="input" type="number" min={0} max={720} step={0.5} value={form.minNoticeMin / 60} onChange={(e) => set('minNoticeMin', Math.round(num(e.target.value) * 60))} />}
          </Field>
          <Field label="Bookable up to (days ahead)" error={errors.horizonDays}>
            {(control) => <input {...control} className="input" type="number" min={1} max={365} value={form.horizonDays} onChange={(e) => set('horizonDays', num(e.target.value))} />}
          </Field>
          <Field label="Most per host per day" optional error={errors.maxPerDay}>
            {(control) => <input {...control} className="input" type="number" min={1} max={100} value={form.maxPerDay ?? ''} onChange={(e) => set('maxPerDay', e.target.value ? num(e.target.value) : null)} />}
          </Field>
          <Field label="Counts as attended after (minutes)" hint="Time the family must spend in the online meeting." error={errors.attendanceThresholdMin}>
            {(control) => <input {...control} className="input" type="number" min={0} max={480} value={form.attendanceThresholdMin} onChange={(e) => set('attendanceThresholdMin', num(e.target.value))} />}
          </Field>
        </div>

        <div className="form-grid">
          <Field label="Where" error={errors.locationKind}>
            {(control) => (
              <select {...control} className="select" value={form.locationKind} onChange={(e) => set('locationKind', e.target.value as LocationKind)}>
                {(Object.keys(LOCATION_LABELS) as LocationKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {LOCATION_LABELS[kind]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={form.locationKind === 'in_person' ? 'Address' : 'Details'} optional={form.locationKind !== 'in_person'} hint={form.locationKind === 'phone' ? 'For example: we will call you on your number.' : undefined} error={errors.locationDetail}>
            {(control) => <input {...control} className="input" required={form.locationKind === 'in_person'} value={form.locationDetail ?? ''} onChange={(e) => set('locationDetail', e.target.value)} />}
          </Field>
          <Field label="Meant for" optional>
            {(control) => (
              <select {...control} className="select" value={form.dealKind ?? ''} onChange={(e) => set('dealKind', (e.target.value || null) as EventTypeInput['dealKind'])}>
                <option value="">Any deal</option>
                <option value="b2c">Families and students</option>
                <option value="b2b">Institutes</option>
              </select>
            )}
          </Field>
          <Field label="Hosts take turns">
            {(control) => (
              <select {...control} className="select" value={form.assignment} onChange={(e) => set('assignment', e.target.value as EventTypeInput['assignment'])}>
                <option value="round_robin">Round robin (fair share, deal owner first)</option>
                <option value="single">One host (the first)</option>
              </select>
            )}
          </Field>
        </div>

        <FieldGroup label="Hosts" hint="People who hold “Work bookings” here. A higher share gets more bookings. People without saved hours are never offered." error={errors.hosts}>
          {candidates.isLoading ? <Spinner /> : null}
          <ErrorAlert error={candidates.error} />
          <div className="stack gap-8">
            {(candidates.data ?? []).map((person) => {
              const host = hostOf(person.id);
              return (
                <div key={person.id} className="sch-host-row">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={Boolean(host)}
                      onChange={(e) =>
                        setHosts(e.target.checked ? [...hosts, { userId: person.id, weight: 1, priority: 0, languages: [], active: true }] : hosts.filter((h) => h.userId !== person.id))
                      }
                    />
                    {person.name}
                    {person.hasAvailability ? null : <span className="small muted"> · no hours yet</span>}
                  </label>
                  {host ? (
                    <>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={100}
                        aria-label={`${person.name} share`}
                        title="Share"
                        value={host.weight}
                        onChange={(e) => setHosts(hosts.map((h) => (h.userId === person.id ? { ...h, weight: num(e.target.value) } : h)))}
                      />
                      <select
                        className="select"
                        aria-label={`${person.name} priority`}
                        value={host.priority}
                        onChange={(e) => setHosts(hosts.map((h) => (h.userId === person.id ? { ...h, priority: Number(e.target.value) } : h)))}
                      >
                        <option value={1}>First</option>
                        <option value={0}>Normal</option>
                        <option value={-1}>Backup</option>
                      </select>
                      <label className="check small">
                        <input type="checkbox" checked={host.active} onChange={(e) => setHosts(hosts.map((h) => (h.userId === person.id ? { ...h, active: e.target.checked } : h)))} />
                        On
                      </label>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </FieldGroup>

        <FieldGroup label="Reminders" hint="Sent by email and WhatsApp in the family's time zone, never during quiet hours.">
          <div className="row gap-8">
            {REMINDERS.map((r) => (
              <label key={r.value} className="chip-toggle">
                <input
                  type="checkbox"
                  checked={form.reminderOffsetsMin.includes(r.value)}
                  onChange={(e) => set('reminderOffsetsMin', e.target.checked ? [...form.reminderOffsetsMin, r.value].sort((a, b) => b - a) : form.reminderOffsetsMin.filter((v) => v !== r.value))}
                />
                {r.label}
              </label>
            ))}
          </div>
        </FieldGroup>

        <FieldGroup label="Who will attend">
          <label className="check">
            <input type="checkbox" checked={form.attendees.ask} onChange={(e) => set('attendees', { ...form.attendees, ask: e.target.checked })} />
            Ask “Who will attend?” (parent, student or both)
          </label>
          <Field label="Extra people they can add" optional>
            {(control) => <input {...control} className="input input--narrow" type="number" min={0} max={10} value={form.attendees.maxGuests} onChange={(e) => set('attendees', { ...form.attendees, maxGuests: num(e.target.value) })} />}
          </Field>
        </FieldGroup>

        <FieldGroup label="Questions" hint="Asked on the booking page; answers appear on the booking.">
          <div className="stack gap-8">
            {form.questions.map((q, index) => (
              <div key={index} className="sch-question">
                <div className="form-grid">
                  <Field label="Question" error={errors[`questions.${index}.label`]}>
                    {(control) => (
                      <input
                        {...control}
                        className="input"
                        value={q.label}
                        onChange={(e) => setQuestion(index, { label: e.target.value, key: q.key || slugify(e.target.value).replace(/-/g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || `q${index + 1}` })}
                      />
                    )}
                  </Field>
                  <Field label="Answer">
                    {(control) => (
                      <select {...control} className="select" value={q.type} onChange={(e) => setQuestion(index, { type: e.target.value as QuestionType, options: e.target.value === 'select' ? (q.options ?? [{ value: 'yes', label: 'Yes' }]) : undefined })}>
                        {QUESTION_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
                {q.type === 'select' ? (
                  <Field label="Choices" hint="One per line." error={errors[`questions.${index}.options`]}>
                    {(control) => (
                      <textarea
                        {...control}
                        className="textarea"
                        rows={3}
                        value={(q.options ?? []).map((o) => o.label).join('\n')}
                        onChange={(e) =>
                          setQuestion(index, {
                            options: e.target.value
                              .split('\n')
                              .map((label) => label.trim())
                              .filter(Boolean)
                              .map((label) => ({ value: slugify(label) || label.slice(0, 60), label })),
                          })
                        }
                      />
                    )}
                  </Field>
                ) : null}
                <div className="row gap-8">
                  <label className="check small">
                    <input type="checkbox" checked={q.required} onChange={(e) => setQuestion(index, { required: e.target.checked })} />
                    Required
                  </label>
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => set('questions', form.questions.filter((_, i) => i !== index))}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button size="sm" icon="plus" onClick={() => set('questions', [...form.questions, { key: '', label: '', type: 'text', required: false }])}>
                Add a question
              </Button>
            </div>
          </div>
        </FieldGroup>

        <FieldGroup label="Booking page" hint="Without a colour or logo here, the page uses the company's brand colour and logo.">
          <div className="form-grid">
            <Field label="Colour" optional>
              {(control) => (
                <input {...control} className="input input--color" type="color" value={form.branding.color ?? '#2840d8'} onChange={(e) => set('branding', { ...form.branding, color: e.target.value.toUpperCase() })} />
              )}
            </Field>
            <Field label="Headline" optional>
              {(control) => <input {...control} className="input" value={form.branding.headline ?? ''} onChange={(e) => set('branding', { ...form.branding, headline: e.target.value || undefined })} />}
            </Field>
          </div>
          <Field label="After booking, tell them" optional>
            {(control) => (
              <textarea {...control} className="textarea" rows={2} value={form.branding.confirmationMessage ?? ''} onChange={(e) => set('branding', { ...form.branding, confirmationMessage: e.target.value || undefined })} />
            )}
          </Field>
        </FieldGroup>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {eventType ? 'Save' : 'Create'}
        </Button>
      </DialogFooter>
    </form>
  );
}
