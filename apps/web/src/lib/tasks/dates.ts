// Due dates are stored in UTC and shown in the viewer's time zone (the one GET /tasks/counts
// reports: the user's own, else the company's locale.timeZone). Plain functions, no React.

import { formatInZone, toDate, zoneOffsetMinutes, type DateInput } from '@/lib/crm/format';

const pad = (value: number) => String(value).padStart(2, '0');

/** "YYYY-MM-DDTHH:mm" wall time of an instant in a time zone, for <input type="datetime-local">. */
export function toZonedInput(value: DateInput, timeZone: string): string {
  const date = toDate(value);
  if (!date) return '';
  const offset = zoneOffsetMinutes(date, timeZone) ?? -date.getTimezoneOffset();
  const wall = new Date(date.getTime() + offset * 60_000);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

/** The UTC instant of a "YYYY-MM-DDTHH:mm" wall time in a time zone, or null when it isn't one. */
export function fromZonedInput(input: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) return null;
  const [y, m, d, h, min] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, h, min);
  // The offset at the guess, then again at the result (they differ only around DST changes).
  const first = zoneOffsetMinutes(wallAsUtc, timeZone) ?? 0;
  let result = wallAsUtc - first * 60_000;
  const second = zoneOffsetMinutes(result, timeZone) ?? first;
  if (second !== first) result = wallAsUtc - second * 60_000;
  return new Date(result);
}

/** Quick due choices for adding a task: today 6 pm, tomorrow 10 am, next Monday 10 am (viewer's zone). */
export type QuickDue = 'none' | 'today' | 'tomorrow' | 'nextWeek';

export function quickDueAt(choice: QuickDue, timeZone: string, now: Date = new Date()): string | null {
  if (choice === 'none') return null;
  const today = toZonedInput(now, timeZone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const dayAt = (offsetDays: number, time: string) => {
    const day = new Date(Date.UTC(y, m - 1, d + offsetDays));
    const key = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    return fromZonedInput(`${key}T${time}`, timeZone);
  };
  if (choice === 'today') {
    const evening = dayAt(0, '18:00');
    // Past 6 pm already: in an hour, rounded to the quarter.
    if (evening && evening.getTime() > now.getTime()) return evening.toISOString();
    const soon = new Date(Math.ceil((now.getTime() + 3_600_000) / 900_000) * 900_000);
    return soon.toISOString();
  }
  if (choice === 'tomorrow') return dayAt(1, '10:00')?.toISOString() ?? null;
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const untilMonday = ((8 - weekday) % 7) || 7;
  return dayAt(untilMonday, '10:00')?.toISOString() ?? null;
}

/** "Today, 6:00 pm", "Tomorrow, 10:00 am", "Mon, 10 Nov, 10:00 am" in the viewer's zone. */
export function dueLabel(value: DateInput, timeZone: string, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return 'No due date';
  const day = toZonedInput(date, timeZone).slice(0, 10);
  const today = toZonedInput(now, timeZone).slice(0, 10);
  const tomorrow = toZonedInput(new Date(now.getTime() + 86_400_000), timeZone).slice(0, 10);
  const yesterday = toZonedInput(new Date(now.getTime() - 86_400_000), timeZone).slice(0, 10);
  const time = formatInZone(date, 'time', timeZone);
  if (day === today) return `Today, ${time}`;
  if (day === tomorrow) return `Tomorrow, ${time}`;
  if (day === yesterday) return `Yesterday, ${time}`;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return `${formatInZone(date, sameYear ? 'day' : 'date', timeZone)}, ${time}`;
}
