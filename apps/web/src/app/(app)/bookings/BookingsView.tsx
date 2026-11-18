'use client';

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { StatusPill } from '@/components/crm';
import { BookingPanel } from '@/components/scheduling/BookingPanel';
import { Button, EmptyState, ErrorAlert, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import {
  STATUS_LABELS,
  addDays,
  dayLabel,
  detectedTimeZone,
  offsetLabel,
  schedulingKeys,
  startOfWeek,
  statusTone,
  timeLabel,
  todayIn,
  useBookingSummary,
  useBookings,
  zonedParts,
} from '@/lib/scheduling/api';
import type { Booking, BookingView } from '@/lib/scheduling/types';
import { useSession } from '@/lib/session';
import '@/components/scheduling/scheduling.css';

type Mode = 'day' | 'week' | 'awaiting' | Exclude<BookingView, 'all' | 'past'>;

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'live', label: 'Live' },
  { key: 'reschedule_requests', label: 'Requests' },
  { key: 'no_shows', label: 'No-shows' },
  { key: 'awaiting', label: 'Outcome due' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** Local midnight of a date in a zone, as an instant (good enough for range queries: ±1 h on DST days is covered by the day grouping). */
function startOfLocalDay(date: string, zone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const local = zonedParts(guess, zone);
  const [h, m] = local.time.split(':').map(Number) as [number, number];
  const shift = local.date === date ? h * 60 + m : local.date < date ? h * 60 + m - 1440 : h * 60 + m + 1440;
  return guess - shift * 60_000;
}

export function BookingsView() {
  const session = useSession();
  const scope = session.scope;
  const zone = session.user.timeZone ?? detectedTimeZone();
  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState(() => todayIn(zone));
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<Booking | null>(null);
  // Deep link: /bookings?booking=<id> opens that booking (from a deal timeline or a notification).
  const deepId = useSearchParams().get('booking');
  const [deepClosed, setDeepClosed] = useState(false);
  const deep = useQuery({ queryKey: schedulingKeys.booking(deepId ?? ''), queryFn: () => api.get<Booking>(`/scheduling/bookings/${deepId}`), enabled: Boolean(deepId) });
  const shownBooking = open ?? (deepClosed ? null : (deep.data ?? null));
  const summary = useBookingSummary(scope.id);
  const canSeeOthers = session.level('scheduling.view') === 'all';

  const range = useMemo(() => {
    const from = mode === 'week' ? startOfWeek(anchor) : anchor;
    const days = mode === 'week' ? 7 : 1;
    return { from, days, fromIso: new Date(startOfLocalDay(from, zone)).toISOString(), toIso: new Date(startOfLocalDay(addDays(from, days), zone)).toISOString() };
  }, [mode, anchor, zone]);
  const hostUserId = mine ? session.user.id : undefined;
  const calendar = useBookings(scope.id, { view: 'all', from: range.fromIso, to: range.toIso, hostUserId, limit: 200 }, { refetchInterval: 60_000 });

  const isCalendar = mode === 'day' || mode === 'week';
  const today = todayIn(zone);

  return (
    <>
      <PageHeader
        title="Bookings"
        description={`Meetings booked with families and institutes. Times in ${zone.replace(/_/g, ' ')} (${offsetLabel(zone)}).`}
      />
      <div className="content stack gap-16">
        <div className="sch-stats" role="group" aria-label="Summary">
          <Stat label="Live now" value={summary.data?.live} tone="live" pressed={mode === 'live'} onClick={() => setMode('live')} />
          <Stat label="Next 24 hours" value={summary.data?.next24h} pressed={mode === 'upcoming'} onClick={() => setMode('upcoming')} />
          <Stat label="Reschedule requests" value={summary.data?.rescheduleRequests} pressed={mode === 'reschedule_requests'} onClick={() => setMode('reschedule_requests')} />
          <Stat label="No-shows, 30 days" value={summary.data?.noShows30d} tone="danger" pressed={mode === 'no_shows'} onClick={() => setMode('no_shows')} />
          <Stat label="Outcome due" value={summary.data?.awaitingOutcome} pressed={mode === 'awaiting'} onClick={() => setMode('awaiting')} />
        </div>

        <div className="sch-toolbar">
          <div className="sch-segment" role="group" aria-label="View">
            {MODES.map((m) => (
              <button key={m.key} type="button" aria-pressed={mode === m.key} onClick={() => setMode(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
          {isCalendar ? (
            <div className="row gap-8">
              <Button size="sm" iconOnly icon="chevronRight" className="sch-prev" aria-label={mode === 'week' ? 'Previous week' : 'Previous day'} onClick={() => setAnchor(addDays(anchor, mode === 'week' ? -7 : -1))} />
              <Button size="sm" onClick={() => setAnchor(today)}>
                Today
              </Button>
              <Button size="sm" iconOnly icon="chevronRight" aria-label={mode === 'week' ? 'Next week' : 'Next day'} onClick={() => setAnchor(addDays(anchor, mode === 'week' ? 7 : 1))} />
              <span className="strong small" aria-live="polite">
                {mode === 'week'
                  ? `${dayLabel(range.from, { day: 'numeric', month: 'short' })} – ${dayLabel(addDays(range.from, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`
                  : dayLabel(anchor, { weekday: 'long', day: 'numeric', month: 'long' })}
              </span>
            </div>
          ) : null}
          <span className="spacer" />
          {canSeeOthers ? (
            <label className="chip-toggle">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Only mine
            </label>
          ) : null}
        </div>

        {isCalendar ? (
          <>
            <ErrorAlert error={calendar.error} />
            {calendar.isLoading ? <Spinner /> : null}
            {calendar.data ? (
              mode === 'week' ? (
                <WeekGrid bookings={calendar.data.data} from={range.from} zone={zone} today={today} onOpen={setOpen} />
              ) : (
                <Agenda bookings={calendar.data.data} zone={zone} onOpen={setOpen} empty="Nothing booked on this day." />
              )
            ) : null}
            {calendar.data?.nextCursor ? <p className="small muted">Showing the first 200 bookings. Pick a team or “Only mine” to narrow it.</p> : null}
          </>
        ) : (
          <BookingList unitId={scope.id} view={mode === 'awaiting' ? 'past' : mode} status={mode === 'awaiting' ? 'booked,rescheduled' : undefined} hostUserId={hostUserId} zone={zone} onOpen={setOpen} />
        )}
      </div>
      <BookingPanel
        booking={shownBooking}
        zone={zone}
        onClose={() => {
          setOpen(null);
          setDeepClosed(true);
        }}
      />
    </>
  );
}

function Stat({ label, value, tone, pressed = false, onClick }: { label: string; value: number | undefined; tone?: 'live' | 'danger'; pressed?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`sch-stat${tone ? ` sch-stat--${tone}` : ''}`} aria-pressed={pressed} onClick={onClick}>
      <span className="sch-stat__value">{value ?? '–'}</span>
      <span className="sch-stat__label">{label}</span>
    </button>
  );
}

function groupByDate(bookings: Booking[], zone: string): Map<string, Booking[]> {
  const out = new Map<string, Booking[]>();
  for (const b of bookings) {
    const date = zonedParts(b.startAt, zone).date;
    if (!out.has(date)) out.set(date, []);
    out.get(date)?.push(b);
  }
  return out;
}

function WeekGrid({ bookings, from, zone, today, onOpen }: { bookings: Booking[]; from: string; zone: string; today: string; onOpen: (b: Booking) => void }) {
  const byDate = groupByDate(bookings, zone);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  if (bookings.length === 0) return <EmptyState icon="calendar" title="Nothing booked this week">Bookings made on booking pages and personal links appear here.</EmptyState>;
  return (
    <div className="sch-week">
      {days.map((date) => (
        <section key={date} className="sch-col" aria-label={dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}>
          <h2 className="sch-col__head" data-today={date === today}>
            {dayLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })}
          </h2>
          {(byDate.get(date) ?? []).map((b) => (
            <button key={b.id} type="button" className="sch-event" data-status={b.status} data-live={b.live} onClick={() => onOpen(b)}>
              <span className="sch-event__time">
                {b.live ? <span className="sch-live-dot" aria-hidden="true" /> : null} {timeLabel(b.startAt, zone)}
              </span>
              <span className="sch-event__title">{b.invitee.name}</span>
              <span className="sch-event__meta">
                {b.eventType?.name ?? ''}
                {b.host ? ` · ${b.host.name}` : ''}
              </span>
              <span className="visually-hidden">{b.live ? 'Live now' : STATUS_LABELS[b.status]}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function Agenda({ bookings, zone, onOpen, empty }: { bookings: Booking[]; zone: string; onOpen: (b: Booking) => void; empty: string }) {
  if (bookings.length === 0) return <EmptyState icon="calendar" title={empty} />;
  return (
    <div className="sch-agenda">
      {bookings.map((b) => (
        <button key={b.id} type="button" className="sch-agenda__row" onClick={() => onOpen(b)}>
          <span className="sch-agenda__time">
            {dayLabel(zonedParts(b.startAt, zone).date, { day: 'numeric', month: 'short' })}
            <br />
            {timeLabel(b.startAt, zone)}
          </span>
          <span className="sch-agenda__main">
            <span className="sch-agenda__title">
              {b.invitee.name}
              {b.deal ? <span className="muted mono small"> · {b.deal.ref}</span> : null}
            </span>
            <span className="sch-agenda__meta">
              {b.eventType?.name ?? 'Meeting'}
              {b.host ? ` with ${b.host.name}` : ''}
              {b.rescheduleRequest?.note ? ` · “${b.rescheduleRequest.note}”` : ''}
            </span>
          </span>
          <StatusPill tone={statusTone(b)}>{b.live ? 'Live now' : b.rescheduleRequest ? 'Wants another time' : STATUS_LABELS[b.status]}</StatusPill>
        </button>
      ))}
    </div>
  );
}

const EMPTY: Record<string, string> = {
  upcoming: 'No upcoming bookings.',
  live: 'No meetings are running right now.',
  reschedule_requests: 'Nobody has asked for another time.',
  no_shows: 'No no-shows. Nice.',
  cancelled: 'No cancelled bookings.',
  past: 'Every meeting that has passed has an outcome.',
};

function BookingList({ unitId, view, status, hostUserId, zone, onOpen }: { unitId: string; view: BookingView; status?: string; hostUserId?: string; zone: string; onOpen: (b: Booking) => void }) {
  const params = { view, status, hostUserId, limit: 30 };
  const list = useInfiniteQuery({
    queryKey: schedulingKeys.bookings(unitId, { ...params, list: true }),
    queryFn: ({ pageParam }) => api.page<Booking>('/scheduling/bookings', { unitId, ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: view === 'live' ? 30_000 : undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="stack gap-12">
      <ErrorAlert error={list.error} />
      {list.isLoading ? <Spinner /> : <Agenda bookings={rows} zone={zone} onOpen={onOpen} empty={EMPTY[view] ?? 'Nothing here.'} />}
      {list.hasNextPage ? (
        <div>
          <Button size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            Show more
          </Button>
        </div>
      ) : null}
      {rows.length ? <p className="small muted">{`Times in ${zone.replace(/_/g, ' ')}. Opened bookings show the invitee's own time too.`}</p> : null}
    </div>
  );
}

