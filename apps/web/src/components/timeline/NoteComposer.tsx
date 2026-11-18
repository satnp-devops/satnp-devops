'use client';

import { useId, useState } from 'react';
import { Icon } from '@/components/icons';
import { Button, ErrorAlert, cx } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { CompanyRef, ManualTimelineKind, TimelineCreateInput, TimelineSubject } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { useAddEntry } from '@/lib/timeline/queries';
import { COMPOSER_KINDS } from '@/lib/timeline/present';

const OUTCOMES = [
  { value: 'connected', label: 'Connected' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'busy', label: 'Busy' },
  { value: 'voicemail', label: 'Voicemail' },
  { value: 'left_message', label: 'Left a message' },
  { value: 'wrong_number', label: 'Wrong number' },
] as const;
type Outcome = (typeof OUTCOMES)[number]['value'];

const PLACEHOLDER: Record<ManualTimelineKind, string> = {
  note: 'Write a note for your team…',
  call: 'What did you talk about?',
  email: 'What was the email about?',
  meeting: 'What happened in the meeting?',
  message: 'What did you send?',
};

/**
 * Add a note (optionally pinned) or log a call, email, meeting or message on a deal, person or
 * institute. Ctrl/Cmd+Enter saves. For a person or institute known to several companies, the
 * entry belongs to the company picked here: from `companies` when given, else (once the server
 * says it can't tell) from the companies the viewer works in.
 */
export function NoteComposer({ subject, companies = [] }: { subject: TimelineSubject; companies?: readonly CompanyRef[] }) {
  const id = useId();
  const [kind, setKind] = useState<ManualTimelineKind>('note');
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('connected');
  const [minutes, setMinutes] = useState('');
  const [pin, setPin] = useState(false);
  const [companyId, setCompanyId] = useState(companies.length === 1 ? (companies[0]?.id ?? '') : '');
  const add = useAddEntry();
  const { units } = useSession();
  const isDeal = 'dealId' in subject;
  const fieldErrors = fieldErrorsOf(add.error);
  const companyError = fieldErrors.companyId;
  const choices: readonly Pick<CompanyRef, 'id' | 'name'>[] =
    companies.length > 0 ? companies : units.filter((unit) => unit.type === 'company' && unit.status === 'active');
  const needsCompany = !isDeal && (companies.length > 1 || Boolean(companyError) || (companies.length === 0 && companyId !== '')) && choices.length > 0;

  const reset = () => {
    setBody('');
    setTitle('');
    setMinutes('');
    setPin(false);
  };

  const canSave = (kind !== 'note' || body.trim().length > 0) && (!needsCompany || companyId);

  const submit = () => {
    if (!canSave || add.isPending) return;
    const meta: TimelineCreateInput['meta'] = {};
    if (kind === 'call') meta.outcome = outcome;
    const duration = Number(minutes);
    if ((kind === 'call' || kind === 'meeting') && minutes && Number.isFinite(duration) && duration > 0) {
      meta.durationSeconds = Math.min(Math.round(duration * 60), 86_400);
    }
    if (kind === 'email' && title.trim()) meta.subject = title.trim();
    const input: TimelineCreateInput = {
      ...subject,
      kind,
      body: body.trim() || undefined,
      title: kind !== 'note' && kind !== 'email' && title.trim() ? title.trim() : undefined,
      meta,
      ...(!isDeal && companyId ? { companyId } : {}),
    };
    add.mutate({ input, pin }, { onSuccess: reset });
  };

  return (
    <form
      className="timeline-composer"
      aria-label="Add to the timeline"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="timeline-composer__kinds" role="radiogroup" aria-label="What to add">
        {COMPOSER_KINDS.map((option) => (
          <label key={option.kind} className={cx('timeline-composer__kind', kind === option.kind && 'is-active')}>
            <input
              type="radio"
              name={`${id}-kind`}
              className="visually-hidden"
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
            />
            <Icon name={option.icon} size={14} aria-hidden="true" />
            {option.label}
          </label>
        ))}
      </div>

      {kind !== 'note' ? (
        <div className="timeline-composer__row">
          <label className="visually-hidden" htmlFor={`${id}-title`}>
            {kind === 'email' ? 'Subject' : 'Title'}
          </label>
          <input
            id={`${id}-title`}
            className="input"
            value={title}
            maxLength={300}
            placeholder={kind === 'email' ? 'Subject' : 'Title (optional)'}
            onChange={(event) => setTitle(event.target.value)}
          />
          {kind === 'call' ? (
            <>
              <label className="visually-hidden" htmlFor={`${id}-outcome`}>
                Outcome
              </label>
              <select id={`${id}-outcome`} className="select" value={outcome} onChange={(event) => setOutcome(event.target.value as Outcome)}>
                {OUTCOMES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {kind === 'call' || kind === 'meeting' ? (
            <>
              <label className="visually-hidden" htmlFor={`${id}-minutes`}>
                Minutes
              </label>
              <input
                id={`${id}-minutes`}
                className="input timeline-composer__minutes"
                inputMode="numeric"
                type="number"
                min={0}
                max={1440}
                placeholder="Minutes"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <label className="visually-hidden" htmlFor={`${id}-body`}>
        {kind === 'note' ? 'Note' : 'Details'}
      </label>
      <textarea
        id={`${id}-body`}
        className="textarea"
        rows={kind === 'note' ? 3 : 2}
        maxLength={20_000}
        placeholder={PLACEHOLDER[kind]}
        value={body}
        aria-invalid={fieldErrors.body ? true : undefined}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />

      <div className="timeline-composer__foot">
        {needsCompany ? (
          <>
            <label className="visually-hidden" htmlFor={`${id}-company`}>
              Company
            </label>
            <select
              id={`${id}-company`}
              className="select timeline-composer__company"
              value={companyId}
              aria-invalid={companyError ? true : undefined}
              onChange={(event) => setCompanyId(event.target.value)}
            >
              <option value="">For which company?</option>
              {choices.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label className="check timeline-composer__pin">
          <input type="checkbox" checked={pin} onChange={(event) => setPin(event.target.checked)} />
          Pin to the top
        </label>
        <span className="spacer" />
        <Button type="submit" variant="primary" size="sm" loading={add.isPending} disabled={!canSave}>
          {kind === 'note' ? 'Add note' : 'Log it'}
        </Button>
      </div>
      {companyError ? <p className="field__error">{companyError}</p> : null}
      <ErrorAlert error={formErrorOf(add.error, ['companyId'])} />
    </form>
  );
}
