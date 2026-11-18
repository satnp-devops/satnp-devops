'use client';

import { useId } from 'react';
import { useNow } from '@/components/crm';
import { formatInZone, formatRelativeTime, timeZoneCity, toDate, viewerTimeZone, type DateInput } from '@/lib/crm/format';

/**
 * "5 min ago" that shows the exact time, in JetBrains Mono, on hover and on keyboard focus.
 * The exact time is also the element's accessible description.
 */
export function RelativeStamp({ value, timeZone }: { value: DateInput; timeZone?: string }) {
  const now = useNow();
  const tipId = useId();
  const date = toDate(value);
  if (!date) return null;
  const zone = timeZone ?? viewerTimeZone();
  const exact = `${formatInZone(date, 'datetime', zone)} · ${timeZoneCity(zone)}`;
  return (
    <span className="timeline-stamp" tabIndex={0} aria-describedby={tipId}>
      <time dateTime={date.toISOString()} suppressHydrationWarning>
        {/* A few seconds of clock skew must not read "in a moment" for something that just happened. */}
        {formatRelativeTime(Math.min(date.getTime(), now), now)}
      </time>
      <span id={tipId} role="tooltip" className="timeline-stamp__tip" suppressHydrationWarning>
        {exact}
      </span>
    </span>
  );
}
