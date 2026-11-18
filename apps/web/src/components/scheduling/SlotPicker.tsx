'use client';

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { Button, ErrorAlert, Spinner } from '@/components/ui';
import { addDays, clockLabel, dayLabel, timeZoneOptions, todayIn, useSlots, type SlotSource } from '@/lib/scheduling/api';
import type { Slot } from '@/lib/scheduling/types';
import './scheduling.css';

/**
 * A week of days and the free times on the chosen day, in the viewer's time zone (which they can
 * change). Used by the public booking page, the manage page and staff rescheduling.
 */
export function SlotPicker({
  source,
  timeZone,
  onTimeZoneChange,
  horizonDays,
  selected,
  onSelect,
  keepStart,
}: {
  source: SlotSource;
  timeZone: string;
  onTimeZoneChange: (zone: string) => void;
  horizonDays: number;
  selected: string | null;
  onSelect: (slot: Slot) => void;
  /** A start that is offered but already the booking's time (moving a booking). */
  keepStart?: string;
}) {
  const today = todayIn(timeZone);
  const lastDay = addDays(today, horizonDays);
  const [from, setFrom] = useState(today);
  const to = addDays(from, 6);
  const slots = useSlots(source, from, to, timeZone);
  const [day, setDay] = useState<string | null>(null);
  const zones = useMemo(() => timeZoneOptions(timeZone), [timeZone]);

  const byDate = useMemo(() => new Map((slots.data?.days ?? []).map((d) => [d.date, d.slots.filter((s) => s.start !== keepStart)])), [slots.data, keepStart]);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const firstOpen = dates.find((date) => (byDate.get(date)?.length ?? 0) > 0) ?? null;
  const shownDay = day && dates.includes(day) && (byDate.get(day)?.length ?? 0) > 0 ? day : firstOpen;

  // When the zone changes, start again from that zone's today.
  useEffect(() => {
    setFrom(todayIn(timeZone));
    setDay(null);
  }, [timeZone]);

  const daySlots = shownDay ? (byDate.get(shownDay) ?? []) : [];
  const nothingThisWeek = !slots.isLoading && !firstOpen;

  return (
    <div className="sch-picker">
      <label className="sch-zone">
        <Icon name="clock" size={16} aria-hidden="true" />
        <span>Times shown in</span>
        <select className="select" value={timeZone} onChange={(event) => onTimeZoneChange(event.target.value)} aria-label="Time zone">
          {zones.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </select>
      </label>

      <div className="sch-picker__nav">
        <Button
          size="sm"
          iconOnly
          icon="chevronRight"
          className="sch-prev"
          aria-label="Previous week"
          disabled={from <= today}
          onClick={() => {
            setFrom(addDays(from, -7) < today ? today : addDays(from, -7));
            setDay(null);
          }}
        />
        <span className="sch-picker__range" aria-live="polite">
          {dayLabel(from, { day: 'numeric', month: 'short' })} – {dayLabel(to, { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <Button
          size="sm"
          iconOnly
          icon="chevronRight"
          aria-label="Next week"
          disabled={addDays(from, 7) > lastDay}
          onClick={() => {
            setFrom(addDays(from, 7));
            setDay(null);
          }}
        />
      </div>

      <div className="sch-days" role="group" aria-label="Days">
        {dates.map((date) => {
          const count = byDate.get(date)?.length ?? 0;
          return (
            <button
              key={date}
              type="button"
              className="sch-day"
              disabled={count === 0}
              aria-pressed={date === shownDay}
              aria-label={`${dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${count ? `${count} times free` : 'no times'}`}
              onClick={() => setDay(date)}
            >
              <span className="sch-day__dow">{dayLabel(date, { weekday: 'short' })}</span>
              <span className="sch-day__num">{dayLabel(date, { day: 'numeric' })}</span>
              <span className="sch-day__count">{slots.isLoading ? '…' : count ? `${count} free` : '—'}</span>
            </button>
          );
        })}
      </div>

      <ErrorAlert error={slots.error} />
      {slots.isLoading ? (
        <div className="row gap-8">
          <Spinner label="Loading times" />
          <span className="small muted">Finding free times…</span>
        </div>
      ) : nothingThisWeek ? (
        <p className="small muted">No free times this week. Try the next week{addDays(from, 7) > lastDay ? ', or ask us for another time' : ''}.</p>
      ) : shownDay ? (
        <div className="stack gap-8">
          <p className="small strong">{dayLabel(shownDay, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <div className="sch-slots" role="group" aria-label="Free times">
            {daySlots.map((slot) => (
              <button key={slot.start} type="button" className="sch-slot" aria-pressed={selected === slot.start} onClick={() => onSelect(slot)}>
                {clockLabel(slot.localTime)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
