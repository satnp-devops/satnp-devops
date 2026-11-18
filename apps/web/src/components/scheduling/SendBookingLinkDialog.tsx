'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { StatusPill } from '@/components/crm';
import { Alert, Button, CopyButton, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { durationLabel, schedulingKeys, useBookingLinks, useEventTypes } from '@/lib/scheduling/api';
import type { BookingLink } from '@/lib/scheduling/types';
import './scheduling.css';

type Channel = 'whatsapp' | 'email' | 'sms';
const CHANNELS: Array<{ key: Channel; label: string; icon: 'whatsapp' | 'mail' | 'message' }> = [
  { key: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
  { key: 'email', label: 'Email', icon: 'mail' },
  { key: 'sms', label: 'SMS', icon: 'message' },
];

const LINK_TONE = { active: 'success', used: 'neutral', expired: 'warning', revoked: 'neutral' } as const;

/**
 * "Send booking link" on the deal profile: make a personal, prefilled booking link for a deal (or
 * a contact) and send it on WhatsApp, email or SMS, or copy it. A booking made through it lands on
 * the deal with its owner preferred as host.
 *
 *   <SendBookingLinkDialog open={open} onClose={close} unitId={deal.unitId} dealId={deal.id} kind={deal.kind} />
 */
export function SendBookingLinkDialog({
  open,
  onClose,
  unitId,
  dealId,
  contactId,
  kind,
  contactName,
}: {
  open: boolean;
  onClose: () => void;
  /** The deal's (or contact link's) unit: event types of its company show. */
  unitId: string;
  dealId?: string;
  contactId?: string;
  /** b2c or b2b, to suggest the right event types first. */
  kind?: 'b2c' | 'b2b';
  contactName?: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Send a booking link" description={`${contactName ?? 'They'} pick a time that suits them; the booking lands on this ${dealId ? 'deal' : 'contact'}.`}>
      {open ? <SendForm onClose={onClose} unitId={unitId} dealId={dealId} contactId={contactId} kind={kind} /> : null}
    </Dialog>
  );
}

function SendForm({ onClose, unitId, dealId, contactId, kind }: { onClose: () => void; unitId: string; dealId?: string; contactId?: string; kind?: 'b2c' | 'b2b' }) {
  const queryClient = useQueryClient();
  const eventTypes = useEventTypes(unitId);
  const links = useBookingLinks({ dealId, contactId });
  const options = (eventTypes.data ?? [])
    .filter((e) => e.active && !e.archivedAt && e.hosts.some((h) => h.active && h.hasAvailability))
    .sort((a, b) => Number(b.dealKind === kind) - Number(a.dealKind === kind) || a.name.localeCompare(b.name));
  const [eventTypeId, setEventTypeId] = useState<string>('');
  const chosenId = eventTypeId || options[0]?.id || '';
  const [days, setDays] = useState('');
  const [link, setLink] = useState<BookingLink | null>(null);
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [message, setMessage] = useState('');

  const create = useMutation({
    mutationFn: () => api.post<BookingLink>('/scheduling/links', { eventTypeId: chosenId, dealId, contactId: dealId ? undefined : contactId, expiresInDays: days ? Number(days) : undefined }),
    onSuccess: (created) => {
      setLink(created);
      void queryClient.invalidateQueries({ queryKey: schedulingKeys.links({ dealId, contactId }) });
    },
  });
  const send = useMutation({
    mutationFn: () => api.post<BookingLink>(`/scheduling/links/${link?.id}/send`, { channel, message: message.trim() || undefined }),
    onSuccess: (sent) => {
      setLink(sent);
      void queryClient.invalidateQueries({ queryKey: schedulingKeys.links({ dealId, contactId }) });
      void queryClient.invalidateQueries({ queryKey: crmKeys.all });
    },
  });
  const errors = fieldErrorsOf(create.error);

  if (eventTypes.isLoading) return <DialogBody><Spinner /></DialogBody>;

  if (!link) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <DialogBody>
          <ErrorAlert error={eventTypes.error ?? formErrorOf(create.error, ['eventTypeId', 'expiresInDays'])} />
          {options.length === 0 ? (
            <Alert tone="info" title="No booking pages yet">
              Ask a manager to add an event type with hosts in Settings › Booking.
            </Alert>
          ) : (
            <>
              <Field label="Meeting" error={errors.eventTypeId}>
                {(control) => (
                  <select {...control} className="select" value={chosenId} onChange={(e) => setEventTypeId(e.target.value)}>
                    {options.map((e) => (
                      <option key={e.id} value={e.id}>
                        {`${e.name} · ${durationLabel(e.durationMin)}`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Link works for" optional hint="Days. Leave empty for the company default. The link books once." error={errors.expiresInDays}>
                {(control) => <input {...control} className="input input--narrow" type="number" min={1} max={90} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}
              </Field>
            </>
          )}
          <ExistingLinks links={links.data ?? []} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!chosenId} loading={create.isPending}>
            Create link
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <>
      <DialogBody>
        {send.isSuccess ? (
          <Alert tone="success" title="Link sent">
            {link.delivery?.status === 'logged' ? 'Recorded on the timeline. Messaging is not connected in this environment, so copy the link if they need it now.' : 'They can pick a time from the message.'}
          </Alert>
        ) : null}
        <div className="row gap-8 nowrap">
          <input className="input mono" readOnly value={link.url} aria-label="Booking link" onFocus={(e) => e.target.select()} />
          <CopyButton text={link.url} />
        </div>
        <p className="small muted">
          {link.expiresAt ? `Works until ${new Date(link.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Does not expire'}
          {link.maxUses ? `, for ${link.maxUses} booking${link.maxUses > 1 ? 's' : ''}` : ''}.
        </p>
        <div className="row gap-8" role="radiogroup" aria-label="Send by">
          {CHANNELS.map((c) => (
            <label key={c.key} className="chip-toggle">
              <input type="radio" name="channel" checked={channel === c.key} onChange={() => setChannel(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
        <Field label="Message" optional hint="Sent before the link.">
          {(control) => <textarea {...control} className="textarea" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Hi! Pick a time for our call here:" />}
        </Field>
        <ErrorAlert error={send.error} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
        <Button variant="primary" icon={CHANNELS.find((c) => c.key === channel)?.icon} loading={send.isPending} onClick={() => send.mutate()}>
          {`Send on ${CHANNELS.find((c) => c.key === channel)?.label}`}
        </Button>
      </DialogFooter>
    </>
  );
}

function ExistingLinks({ links }: { links: BookingLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="stack gap-6">
      <p className="small strong">Links already made</p>
      <ul className="list list--compact">
        {links.slice(0, 5).map((l) => (
          <li key={l.id} className="list__item row gap-8">
            <span className="grow small">
              {l.eventType?.name ?? 'Meeting'}
              {l.lastSentAt ? ' · sent' : ''}
            </span>
            <StatusPill tone={LINK_TONE[l.status]}>{l.status}</StatusPill>
          </li>
        ))}
      </ul>
    </div>
  );
}
