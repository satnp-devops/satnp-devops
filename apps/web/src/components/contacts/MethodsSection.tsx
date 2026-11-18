'use client';

import { useState, type FormEvent } from 'react';
import { Menu, Section, StatusPill, type MenuItem } from '@/components/crm';
import { Icon, type IconName } from '@/components/icons';
import { ConfirmDialog } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { METHOD_KINDS, METHOD_LABELS } from '@/lib/contacts/labels';
import { useAddMethod, useRemoveMethod, useUpdateMethod } from '@/lib/contacts/queries';
import type { ContactDetail, ContactMethod, ContactMethodKind } from '@/lib/crm/types';
import { PiiText } from './PiiText';
import './contacts.css';

const METHOD_ICONS: Record<ContactMethodKind, IconName> = { phone: 'phone', whatsapp: 'whatsapp', email: 'mail' };

/** Phones, WhatsApp numbers and emails: add, remove, make primary, opt out. */
export function MethodsSection({ contact }: { contact: ContactDetail }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ContactMethod | null>(null);
  const update = useUpdateMethod(contact.id);
  const remove = useRemoveMethod(contact.id);
  const canManage = contact.can.manage;

  function actions(method: ContactMethod): MenuItem[] {
    const items: MenuItem[] = [];
    if (!method.isPrimary) {
      items.push({ key: 'primary', label: 'Make primary', icon: 'star', onSelect: () => update.mutate({ methodId: method.id, body: { isPrimary: true } }) });
    }
    items.push(
      method.optedOutAt
        ? { key: 'optin', label: 'Undo opt-out', icon: 'restore', onSelect: () => update.mutate({ methodId: method.id, body: { optedOut: false } }) }
        : { key: 'optout', label: 'Opted out: stop messages', icon: 'eyeOff', onSelect: () => update.mutate({ methodId: method.id, body: { optedOut: true } }) },
      method.verifiedAt
        ? { key: 'unverify', label: 'Mark as not verified', icon: 'x', onSelect: () => update.mutate({ methodId: method.id, body: { verified: false } }) }
        : { key: 'verify', label: 'Mark as verified', icon: 'check', onSelect: () => update.mutate({ methodId: method.id, body: { verified: true } }) },
      { key: 'remove', label: 'Remove', icon: 'trash', danger: true, onSelect: () => setRemoving(method) },
    );
    return items;
  }

  return (
    <Section
      title="Phone and email"
      level={3}
      count={contact.methods.length}
      flush
      actions={
        canManage && !adding ? (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add
          </Button>
        ) : null
      }
    >
      {contact.methods.length === 0 ? (
        <p className="contacts-empty-line">No phone number or email yet.</p>
      ) : (
        <ul className="contacts-rows">
          {contact.methods.map((method) => (
            <li key={method.id} className="contacts-row">
              <Icon name={METHOD_ICONS[method.kind]} size={16} className="contacts-row__icon" aria-hidden="true" />
              <div className="contacts-row__text">
                <span className={method.optedOutAt ? 'contacts-row__title contacts-row__title--muted' : 'contacts-row__title'}>
                  <PiiText value={method.value} kind={method.kind === 'email' ? 'email' : 'phone'} masked={method.masked} />
                </span>
                <span className="contacts-sub">{[METHOD_LABELS[method.kind], method.label].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="contacts-badges">
                {method.isPrimary ? <StatusPill tone="accent">Primary</StatusPill> : null}
                {method.verifiedAt ? (
                  <StatusPill tone="success" icon="check">
                    Verified
                  </StatusPill>
                ) : null}
                {method.optedOutAt ? (
                  <StatusPill tone="danger" icon="eyeOff" title="Opted out: don't send messages here">
                    Opted out
                  </StatusPill>
                ) : null}
              </div>
              {canManage ? (
                <div className="contacts-row__actions">
                  <Menu
                    label={`Actions for ${METHOD_LABELS[method.kind].toLowerCase()} ${method.masked ? '' : method.value}`.trim()}
                    placement="bottom-end"
                    items={actions(method)}
                    trigger={(trigger) => <Button {...trigger} size="sm" variant="ghost" iconOnly icon="more" aria-label={`Actions for ${METHOD_LABELS[method.kind]}`} />}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title={`Remove this ${removing ? METHOD_LABELS[removing.kind].toLowerCase() : 'method'}?`}
        confirmLabel="Remove"
        danger
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id, { onSuccess: () => setRemoving(null) });
        }}
      >
        <p>
          {removing?.isPrimary ? 'It is the primary one; the oldest other one of the same type becomes primary. ' : ''}
          The change is kept in the audit log.
        </p>
      </ConfirmDialog>
      {update.error ? (
        <div className="card__body">
          <ErrorAlert error={update.error} />
        </div>
      ) : null}
      {adding ? <AddMethodForm contactId={contact.id} hasKind={(kind) => contact.methods.some((m) => m.kind === kind)} onDone={() => setAdding(false)} /> : null}
    </Section>
  );
}

function AddMethodForm({
  contactId,
  hasKind,
  onDone,
}: {
  contactId: string;
  hasKind: (kind: ContactMethodKind) => boolean;
  onDone: () => void;
}) {
  const add = useAddMethod(contactId);
  const [kind, setKind] = useState<ContactMethodKind>('phone');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const errors = fieldErrorsOf(add.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate(
      { kind, value: value.trim(), label: label.trim() || undefined, isPrimary: isPrimary || !hasKind(kind) },
      { onSuccess: onDone },
    );
  }

  return (
    <form className="contacts-inline-form" onSubmit={submit} noValidate aria-label="Add a phone or email">
      <div className="form-grid">
        <Field label="Type" error={errors.kind}>
          {(control) => (
            <select {...control} className="select" value={kind} onChange={(event) => setKind(event.target.value as ContactMethodKind)}>
              {METHOD_KINDS.map((option) => (
                <option key={option} value={option}>
                  {METHOD_LABELS[option]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={kind === 'email' ? 'Email' : 'Number'} error={errors.value}>
          {(control) => (
            <input
              {...control}
              className="input"
              type={kind === 'email' ? 'email' : 'tel'}
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={kind === 'email' ? 'name@example.com' : '+91 98765 43210'}
              autoFocus
            />
          )}
        </Field>
        <Field label="Label" optional hint="e.g. Work, Father's" error={errors.label}>
          {(control) => <input {...control} className="input" value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} />}
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={isPrimary || !hasKind(kind)} disabled={!hasKind(kind)} onChange={(event) => setIsPrimary(event.target.checked)} />
        Make it the primary {METHOD_LABELS[kind].toLowerCase()}
      </label>
      <ErrorAlert error={formErrorOf(add.error, ['kind', 'value', 'label'])} />
      <div className="contacts-inline-form__actions">
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary" loading={add.isPending} disabled={value.trim().length < 3}>
          Add
        </Button>
      </div>
    </form>
  );
}
