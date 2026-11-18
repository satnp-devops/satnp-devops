'use client';

import { useState, type FormEvent } from 'react';
import { DateTime, Section, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import {
  CONSENT_CHANNELS,
  CONSENT_CHANNEL_LABELS,
  CONSENT_PURPOSES,
  CONSENT_PURPOSE_LABELS,
  CONSENT_SOURCES,
  CONSENT_SOURCE_LABELS,
  companyOfUnit,
} from '@/lib/contacts/labels';
import { useContactConsents, useRecordConsent } from '@/lib/contacts/queries';
import type { ConsentChannel, ConsentPurpose, ConsentSource, ConsentState, ConsentStatus, ContactDetail } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import './contacts.css';

const GROUP = 'group';
type Prefill = { channel: ConsentChannel; purpose: ConsentPurpose; status: ConsentStatus };

/** Consent and opt-out per channel and purpose (DPDP Act): the current state and every record behind it. */
export function ConsentsSection({ contact }: { contact: ContactDetail }) {
  const { scope, unitsById } = useSession();
  const consents = useContactConsents(contact.id);
  const record = useRecordConsent(contact.id);
  const companies = contact.links.map((link) => link.company);
  const companyName = (id: string | null) => (id === null ? 'Whole group' : (companies.find((c) => c.id === id)?.name ?? 'Another company'));

  const working = companyOfUnit(scope, unitsById);
  const [scopeKey, setScopeKey] = useState<string>(() => working && companies.some((c) => c.id === working.id) ? working.id : (companies[0]?.id ?? GROUP));
  const companyId = scopeKey === GROUP ? null : scopeKey;
  const [dialog, setDialog] = useState<Prefill | null>(null);

  const states = (consents.data?.effective ?? []).filter((state) => state.companyId === companyId);
  const stateOf = (channel: ConsentChannel, purpose: ConsentPurpose): ConsentState | undefined =>
    states.find((state) => state.channel === channel && state.purpose === purpose);
  const channels = CONSENT_CHANNELS.filter((channel) => channel !== 'all');

  return (
    <Section
      title="Consent"
      level={3}
      description="What this person agreed to, per channel and purpose. Withdrawals stop messages of that kind."
      flush
      actions={
        contact.can.manage ? (
          <Button size="sm" icon="plus" onClick={() => setDialog({ channel: 'whatsapp', purpose: 'marketing', status: 'granted' })}>
            Record
          </Button>
        ) : null
      }
    >
      <div className="contacts-consent-tools">
        <label className="contacts-sub" htmlFor={`consent-scope-${contact.id}`}>
          Applies to
        </label>
        <select
          id={`consent-scope-${contact.id}`}
          className="select contacts-consent-select"
          value={scopeKey}
          onChange={(event) => setScopeKey(event.target.value)}
        >
          <option value={GROUP}>Whole group</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </div>

      {consents.isPending ? (
        <div className="card__body">
          <Spinner label="Loading consent" />
        </div>
      ) : consents.isError ? (
        <div className="card__body">
          <ErrorAlert error={consents.error} />
        </div>
      ) : (
        <>
          <div className="contacts-consent-wrap">
            <table className="contacts-consent-table">
              <caption className="visually-hidden">Consent for {companyName(companyId)}</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  {CONSENT_PURPOSES.map((purpose) => (
                    <th key={purpose} scope="col">
                      {CONSENT_PURPOSE_LABELS[purpose]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel}>
                    <th scope="row">{CONSENT_CHANNEL_LABELS[channel]}</th>
                    {CONSENT_PURPOSES.map((purpose) => {
                      const state = stateOf(channel, purpose);
                      const status = state?.status ?? 'unknown';
                      return (
                        <td key={purpose}>
                          <div className="contacts-consent-cell">
                            <StatusPill tone={status === 'granted' ? 'success' : status === 'withdrawn' ? 'danger' : 'neutral'}>
                              {status === 'granted' ? 'Granted' : status === 'withdrawn' ? 'Withdrawn' : 'Not asked'}
                            </StatusPill>
                            {contact.can.manage && status === 'granted' ? (
                              <button
                                type="button"
                                className="link-button small"
                                aria-label={`Withdraw ${CONSENT_PURPOSE_LABELS[purpose].toLowerCase()} consent on ${CONSENT_CHANNEL_LABELS[channel]}`}
                                onClick={() => setDialog({ channel, purpose, status: 'withdrawn' })}
                              >
                                Withdraw
                              </button>
                            ) : null}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {consents.data.records.length > 0 ? (
            <details className="contacts-history">
              <summary>History ({consents.data.records.length})</summary>
              <ul className="contacts-rows">
                {consents.data.records.map((row) => (
                  <li key={row.id} className="contacts-row">
                    <div className="contacts-row__text">
                      <span className="contacts-row__title">
                        {row.status === 'granted' ? 'Granted' : 'Withdrew'} {CONSENT_PURPOSE_LABELS[row.purpose].toLowerCase()} on{' '}
                        {CONSENT_CHANNEL_LABELS[row.channel]}
                      </span>
                      <span className="contacts-sub">
                        {companyName(row.companyId)} · {CONSENT_SOURCE_LABELS[row.source]}
                        {row.capturedBy ? ` · by ${row.capturedBy.name}` : ''} · <DateTime value={row.capturedAt} format="short" />
                      </span>
                      {typeof row.evidence.note === 'string' && row.evidence.note ? <span className="contacts-sub">“{row.evidence.note}”</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="contacts-empty-line">No consent recorded yet.</p>
          )}
        </>
      )}

      <Dialog
        open={dialog !== null}
        onClose={() => {
          setDialog(null);
          record.reset();
        }}
        title={dialog?.status === 'withdrawn' ? 'Record a withdrawal' : 'Record consent'}
        description="Consent records are kept as proof and can't be edited; record a new one to change it."
      >
        {dialog ? (
          <ConsentForm
            prefill={dialog}
            companyId={companyId}
            companies={companies}
            pending={record.isPending}
            error={record.error}
            onCancel={() => {
              setDialog(null);
              record.reset();
            }}
            onSubmit={(body) => record.mutate(body, { onSuccess: () => setDialog(null) })}
          />
        ) : null}
      </Dialog>
    </Section>
  );
}

function ConsentForm({
  prefill,
  companyId,
  companies,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  prefill: Prefill;
  companyId: string | null;
  companies: ReadonlyArray<{ id: string; name: string }>;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: {
    companyId: string | null;
    channel: ConsentChannel;
    purpose: ConsentPurpose;
    status: ConsentStatus;
    source: ConsentSource;
    evidence: Record<string, string>;
  }) => void;
}) {
  const [target, setTarget] = useState(companyId ?? GROUP);
  const [channel, setChannel] = useState<ConsentChannel>(prefill.channel);
  const [purpose, setPurpose] = useState<ConsentPurpose>(prefill.purpose);
  const [status, setStatus] = useState<ConsentStatus>(prefill.status);
  const [source, setSource] = useState<ConsentSource>('manual');
  const [note, setNote] = useState('');
  const errors = fieldErrorsOf(error);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      companyId: target === GROUP ? null : target,
      channel,
      purpose,
      status,
      source,
      evidence: note.trim() ? { note: note.trim() } : {},
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <div className="form-grid">
          <Field label="Applies to" error={errors.companyId}>
            {(control) => (
              <select {...control} className="select" value={target} onChange={(event) => setTarget(event.target.value)}>
                <option value={GROUP}>Whole group</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Decision" error={errors.status}>
            {(control) => (
              <select {...control} className="select" value={status} onChange={(event) => setStatus(event.target.value as ConsentStatus)}>
                <option value="granted">Granted</option>
                <option value="withdrawn">Withdrawn (opt-out)</option>
              </select>
            )}
          </Field>
          <Field label="Channel" error={errors.channel}>
            {(control) => (
              <select {...control} className="select" value={channel} onChange={(event) => setChannel(event.target.value as ConsentChannel)}>
                {CONSENT_CHANNELS.map((option) => (
                  <option key={option} value={option}>
                    {CONSENT_CHANNEL_LABELS[option]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Purpose" error={errors.purpose}>
            {(control) => (
              <select {...control} className="select" value={purpose} onChange={(event) => setPurpose(event.target.value as ConsentPurpose)}>
                {CONSENT_PURPOSES.map((option) => (
                  <option key={option} value={option}>
                    {CONSENT_PURPOSE_LABELS[option]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="How it was given" error={errors.source}>
            {(control) => (
              <select {...control} className="select" value={source} onChange={(event) => setSource(event.target.value as ConsentSource)}>
                {CONSENT_SOURCES.map((option) => (
                  <option key={option} value={option}>
                    {CONSENT_SOURCE_LABELS[option]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label="Note" optional hint="What the person said, or where the proof is." error={errors['evidence.note']}>
          {(control) => <textarea {...control} className="textarea" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={formErrorOf(error, ['companyId', 'status', 'channel', 'purpose', 'source', 'evidence.note'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant={status === 'withdrawn' ? 'danger' : 'primary'} loading={pending}>
          {status === 'withdrawn' ? 'Record withdrawal' : 'Record consent'}
        </Button>
      </DialogFooter>
    </form>
  );
}
