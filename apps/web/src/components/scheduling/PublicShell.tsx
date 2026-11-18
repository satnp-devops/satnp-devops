'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { safeExternalUrl } from '@/lib/objects';
import { readableBrand } from '@/lib/scheduling/brand';
import { LOCATION_LABELS, dayLabel, durationLabel, offsetLabel, timeLabel, zonedParts } from '@/lib/scheduling/api';
import type { Branding, PublicBooking, PublicEventType } from '@/lib/scheduling/types';
import './scheduling.css';

/** The company-branded frame of the public booking pages (no app chrome, no sign-in). */
export function PublicShell({ branding, children }: { branding: Branding | null; children: ReactNode }) {
  const brand = readableBrand(branding?.color);
  const name = branding?.companyName ?? 'Phoenix';
  return (
    <div className="sch-public" style={{ '--sch-brand': brand } as CSSProperties}>
      <div className="sch-public__band" />
      <main className="sch-public__wrap">
        <header className="sch-public__brand">
          {branding?.logoUrl ? (
            // Company logos are external URLs (the logo setting), so a plain img.
            <img className="sch-public__logo" src={branding.logoUrl} alt={name} />
          ) : (
            <span className="sch-public__mark" aria-hidden="true">
              {name.slice(0, 1).toUpperCase()}
            </span>
          )}
          {branding?.logoUrl ? null : <span className="sch-public__company">{name}</span>}
        </header>
        {children}
        <p className="sch-footer">Bookings by {name}. Times are shown in your time zone.</p>
      </main>
    </div>
  );
}

/** What, how long, where and with whom. */
export function EventFacts({ eventType, hostName }: { eventType: PublicEventType; hostName?: string | null }) {
  return (
    <ul className="sch-facts">
      <li>
        <Icon name="clock" size={16} aria-hidden="true" />
        {durationLabel(eventType.durationMin)}
      </li>
      <li>
        <Icon name={eventType.locationKind === 'phone' ? 'phone' : eventType.locationKind === 'in_person' ? 'pin' : 'device'} size={16} aria-hidden="true" />
        {LOCATION_LABELS[eventType.locationKind]}
        {eventType.locationKind === 'in_person' && eventType.locationDetail ? `: ${eventType.locationDetail}` : ''}
      </li>
      {hostName ? (
        <li>
          <Icon name="user" size={16} aria-hidden="true" />
          With {hostName}
        </li>
      ) : null}
    </ul>
  );
}

/** "Tuesday 10 November, 4:30 pm – 5:00 pm (GMT+5:30)" in a zone. */
export function whenText(startAt: string, endAt: string, zone: string): string {
  const date = zonedParts(startAt, zone).date;
  return `${dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${timeLabel(startAt, zone)} – ${timeLabel(endAt, zone)} (${offsetLabel(zone, Date.parse(startAt))})`;
}

const icsStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function googleCalendarUrl(booking: PublicBooking): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${booking.eventType.name} · ${booking.branding.companyName}`,
    dates: `${icsStamp(booking.startAt)}/${icsStamp(booking.endAt)}`,
    details: [booking.location.meetingUrl ? `Join: ${booking.location.meetingUrl}` : null, `Reschedule or cancel: ${booking.manageUrl}`].filter(Boolean).join('\n'),
  });
  const where = booking.location.meetingUrl ?? booking.location.detail;
  if (where) params.set('location', where);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** The confirmation: time in the visitor's zone, how to join, add to calendar, manage. */
export function BookingSummaryCard({ booking, zone, title, children }: { booking: PublicBooking; zone: string; title: string; children?: ReactNode }) {
  const active = booking.status === 'booked' || booking.status === 'rescheduled';
  return (
    <section className="sch-public__card sch-confirm" aria-live="polite">
      <span className="sch-confirm__icon" aria-hidden="true">
        <Icon name={active ? 'check' : 'x'} size={22} />
      </span>
      <h1>{title}</h1>
      <p className="strong">{booking.eventType.name}</p>
      <ul className="sch-facts">
        <li>
          <Icon name="calendar" size={16} aria-hidden="true" />
          <span className="mono">{whenText(booking.startAt, booking.endAt, zone)}</span>
        </li>
        {booking.host ? (
          <li>
            <Icon name="user" size={16} aria-hidden="true" />
            With {booking.host.name}
          </li>
        ) : null}
        <li>
          <Icon name={booking.location.kind === 'phone' ? 'phone' : booking.location.kind === 'in_person' ? 'pin' : 'device'} size={16} aria-hidden="true" />
          {LOCATION_LABELS[booking.location.kind]}
          {booking.location.detail ? `: ${booking.location.detail}` : ''}
        </li>
      </ul>
      {active && booking.location.meetingUrl ? (
        <p className="small">
          Joining link:{' '}
          <a href={safeExternalUrl(booking.location.meetingUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className="mono">
            {booking.location.meetingUrl}
          </a>
        </p>
      ) : null}
      {active && booking.branding.confirmationMessage ? <p className="small">{booking.branding.confirmationMessage}</p> : null}
      {active ? (
        <div className="sch-actions">
          <a className="btn btn--primary" href={booking.icsPath} download>
            <Icon name="download" size={16} aria-hidden="true" />
            Add to calendar (.ics)
          </a>
          <a className="btn" href={googleCalendarUrl(booking)} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={16} aria-hidden="true" />
            Google Calendar
          </a>
        </div>
      ) : null}
      {children}
    </section>
  );
}
