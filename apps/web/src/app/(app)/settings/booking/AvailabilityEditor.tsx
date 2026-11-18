'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { detectedTimeZone, schedulingKeys, timeZoneOptions, todayIn, useAvailability } from '@/lib/scheduling/api';
import type { Availability, Override, Weekday } from '@/lib/scheduling/types';

const DAYS: Array<{ key: Weekday; label: string }> = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

interface Range {
  start: string;
  end: string;
}
type Week = Record<Weekday, Range[]>;

const toRange = (value: string | Range): Range => {
  if (typeof value !== 'string') return { start: value.start, end: value.end };
  const [start = '09:00', end = '17:00'] = value.split('-');
  return { start, end };
};
const fromRanges = (ranges: Range[]) => ranges.map((r) => `${r.start}-${r.end === '00:00' ? '24:00' : r.end}`);

function initialWeek(data: Availability | undefined): Week {
  const configured = data?.configured;
  return Object.fromEntries(
    DAYS.map(({ key }) => {
      const saved = data?.weekly[key];
      if (configured) return [key, (saved ?? []).map(toRange)];
      // Not set up yet: suggest weekday office hours.
      return [key, key === 'sat' || key === 'sun' ? [] : [{ start: '10:00', end: '13:00' }, { start: '14:00', end: '18:00' }]];
    }),
  ) as Week;
}

/** Weekly hours, date exceptions and the person's own time zone. */
export function AvailabilityEditor({ userId, title }: { userId: string; title?: string }) {
  const availability = useAvailability(userId);
  if (availability.isLoading) return <Spinner />;
  if (availability.error || !availability.data) return <ErrorAlert error={availability.error} />;
  return <Editor key={`${userId}:${availability.data.updatedAt ?? 'new'}`} data={availability.data} userId={userId} title={title} />;
}

function Editor({ data, userId, title }: { data: Availability; userId: string; title?: string }) {
  const queryClient = useQueryClient();
  const [zone, setZone] = useState(data.timeZone ?? data.suggestedTimeZone ?? detectedTimeZone());
  const [week, setWeek] = useState<Week>(() => initialWeek(data));
  const [overrides, setOverrides] = useState<Array<{ date: string; off: boolean; ranges: Range[] }>>(() =>
    Object.entries(data.overrides)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, off: value === 'unavailable', ranges: value === 'unavailable' ? [] : value.map(toRange) })),
  );
  const zones = useMemo(() => timeZoneOptions(zone), [zone]);
  const save = useMutation({
    mutationFn: () =>
      api.put<Availability>(`/scheduling/availability/${userId}`, {
        timeZone: zone,
        weekly: Object.fromEntries(DAYS.map(({ key }) => [key, fromRanges(week[key])])),
        overrides: Object.fromEntries(overrides.filter((o) => o.date).map((o) => [o.date, (o.off ? 'unavailable' : fromRanges(o.ranges)) as Override])),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(schedulingKeys.availability(userId), saved);
      void queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const readOnly = !data.canEdit;

  const setDay = (day: Weekday, ranges: Range[]) => setWeek({ ...week, [day]: ranges });

  return (
    <form
      className="stack gap-16"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      {title ? <h3 className="section-title">{title}</h3> : null}
      {!data.configured ? (
        <Alert tone="info" title="Not set up yet">
          Booking pages offer times only from people who have saved their hours. We have suggested weekday office hours.
        </Alert>
      ) : null}
      {save.isSuccess ? <Alert tone="success">Hours saved. Booking pages use them straight away.</Alert> : null}
      <ErrorAlert error={formErrorOf(save.error, ['timeZone'])} />
      <Field label="Time zone" hint="Hours below are in this zone; families see them in theirs." error={errors.timeZone}>
        {(control) => (
          <select {...control} className="select" value={zone} disabled={readOnly} onChange={(e) => setZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div className="sch-week-editor" role="group" aria-label="Weekly hours">
        {DAYS.map(({ key, label }) => (
          <div key={key} className="sch-week-row">
            <label className="check">
              <input type="checkbox" checked={week[key].length > 0} disabled={readOnly} onChange={(e) => setDay(key, e.target.checked ? [{ start: '10:00', end: '18:00' }] : [])} />
              <span className="strong">{label}</span>
            </label>
            <RangesEditor ranges={week[key]} onChange={(ranges) => setDay(key, ranges)} readOnly={readOnly} label={label} emptyText="Not available" />
          </div>
        ))}
      </div>
      {errors['weekly'] ? <p className="field__error">{errors['weekly']}</p> : null}

      <div className="stack gap-8">
        <h4 className="strong">Dates that differ</h4>
        <p className="small muted">Holidays, leave or extra hours on one date. These replace the weekly hours for that date.</p>
        {overrides.map((o, index) => (
          <div key={index} className="sch-week-row">
            <div className="stack gap-6">
              <input
                className="input"
                type="date"
                aria-label="Date"
                min={todayIn(zone)}
                value={o.date}
                disabled={readOnly}
                onChange={(e) => setOverrides(overrides.map((x, i) => (i === index ? { ...x, date: e.target.value } : x)))}
              />
              <label className="check small">
                <input type="checkbox" checked={o.off} disabled={readOnly} onChange={(e) => setOverrides(overrides.map((x, i) => (i === index ? { ...x, off: e.target.checked, ranges: e.target.checked ? [] : [{ start: '10:00', end: '14:00' }] } : x)))} />
                Off all day
              </label>
            </div>
            <div className="row gap-8">
              {o.off ? <span className="small muted grow">Not available</span> : <RangesEditor ranges={o.ranges} onChange={(ranges) => setOverrides(overrides.map((x, i) => (i === index ? { ...x, ranges } : x)))} readOnly={readOnly} label={o.date} emptyText="Not available" />}
              {readOnly ? null : <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label={`Remove ${o.date || 'date'}`} onClick={() => setOverrides(overrides.filter((_, i) => i !== index))} />}
            </div>
          </div>
        ))}
        {errors['overrides'] ? <p className="field__error">{errors['overrides']}</p> : null}
        {readOnly ? null : (
          <div>
            <Button size="sm" icon="plus" onClick={() => setOverrides([...overrides, { date: '', off: true, ranges: [] }])}>
              Add a date
            </Button>
          </div>
        )}
      </div>

      {readOnly ? (
        <p className="small muted">You can see these hours but not change them.</p>
      ) : (
        <div className="row gap-8">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save hours
          </Button>
        </div>
      )}
    </form>
  );
}

function RangesEditor({ ranges, onChange, readOnly, label, emptyText }: { ranges: Range[]; onChange: (r: Range[]) => void; readOnly: boolean; label: string; emptyText: string }) {
  if (ranges.length === 0) return <span className="small muted">{emptyText}</span>;
  return (
    <div className="sch-ranges">
      {ranges.map((range, index) => (
        <div key={index} className="sch-range">
          <input className="input mono" type="time" aria-label={`${label} from`} value={range.start} disabled={readOnly} onChange={(e) => onChange(ranges.map((r, i) => (i === index ? { ...r, start: e.target.value } : r)))} />
          <span aria-hidden="true">–</span>
          <input className="input mono" type="time" aria-label={`${label} until`} value={range.end === '24:00' ? '00:00' : range.end} disabled={readOnly} onChange={(e) => onChange(ranges.map((r, i) => (i === index ? { ...r, end: e.target.value } : r)))} />
          {readOnly ? null : (
            <>
              <Button size="sm" variant="ghost" iconOnly icon="x" aria-label={`Remove ${label} ${range.start}`} onClick={() => onChange(ranges.filter((_, i) => i !== index))} />
              {index === ranges.length - 1 ? (
                <Button size="sm" variant="ghost" iconOnly icon="plus" aria-label={`Add hours on ${label}`} onClick={() => onChange([...ranges, { start: range.end === '24:00' ? '18:00' : range.end, end: '20:00' }])} />
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
