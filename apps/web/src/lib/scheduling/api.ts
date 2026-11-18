'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  Availability,
  Booking,
  BookingLink,
  BookingSummary,
  BookingView,
  EventType,
  HostCandidate,
  LocationKind,
  ReassignCandidate,
  SlotDays,
} from './types';

// Query keys, hooks and small helpers for scheduling (staff pages, the booking page and the
// send-link dialog). Every key starts with 'scheduling', so invalidating schedulingKeys.all
// refreshes the whole area.

export const schedulingKeys = {
  all: ['scheduling'] as const,
  eventTypes: (unitId: string, includeArchived = false) => ['scheduling', 'event-types', unitId, includeArchived] as const,
  eventType: (id: string) => ['scheduling', 'event-type', id] as const,
  hostCandidates: (unitId: string) => ['scheduling', 'host-candidates', unitId] as const,
  availability: (userId: string) => ['scheduling', 'availability', userId] as const,
  bookings: (unitId: string, params: Record<string, unknown>) => ['scheduling', 'bookings', unitId, params] as const,
  bookingsAll: ['scheduling', 'bookings'] as const,
  booking: (id: string) => ['scheduling', 'booking', id] as const,
  summary: (unitId: string) => ['scheduling', 'summary', unitId] as const,
  reassign: (id: string) => ['scheduling', 'reassign', id] as const,
  slots: (scope: string, id: string, from: string, to: string, zone: string) => ['scheduling', 'slots', scope, id, from, to, zone] as const,
  links: (subject: { dealId?: string; contactId?: string }) => ['scheduling', 'links', subject.dealId ?? '', subject.contactId ?? ''] as const,
  publicPage: (token: string) => ['scheduling-public', 'page', token] as const,
  publicBooking: (token: string) => ['scheduling-public', 'booking', token] as const,
};

export function useEventTypes(unitId: string, includeArchived = false) {
  return useQuery({
    queryKey: schedulingKeys.eventTypes(unitId, includeArchived),
    queryFn: () => api.get<EventType[]>('/scheduling/event-types', { unitId, includeArchived: includeArchived ? 'true' : undefined }),
  });
}

export function useHostCandidates(unitId: string | null) {
  return useQuery({
    queryKey: schedulingKeys.hostCandidates(unitId ?? ''),
    queryFn: () => api.get<HostCandidate[]>('/scheduling/host-candidates', { unitId: unitId ?? '' }),
    enabled: Boolean(unitId),
  });
}

export function useAvailability(userId: string) {
  return useQuery({
    queryKey: schedulingKeys.availability(userId),
    queryFn: () => api.get<Availability>(`/scheduling/availability/${userId}`),
  });
}

export interface BookingQuery {
  view: BookingView;
  from?: string;
  to?: string;
  hostUserId?: string;
  limit?: number;
}

export function useBookings(unitId: string, query: BookingQuery, { refetchInterval }: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: schedulingKeys.bookings(unitId, { ...query }),
    queryFn: () => api.page<Booking>('/scheduling/bookings', { unitId, ...query }),
    placeholderData: keepPreviousData,
    refetchInterval,
  });
}

export function useBookingSummary(unitId: string) {
  return useQuery({
    queryKey: schedulingKeys.summary(unitId),
    queryFn: () => api.get<BookingSummary>('/scheduling/bookings/summary', { unitId }),
    refetchInterval: 60_000,
  });
}

export function useReassignCandidates(id: string | null) {
  return useQuery({
    queryKey: schedulingKeys.reassign(id ?? ''),
    queryFn: () => api.get<ReassignCandidate[]>(`/scheduling/bookings/${id}/reassign-candidates`),
    enabled: Boolean(id),
  });
}

/** Slots from one of three sources: a public booking page, a manage link, or a booking (staff). */
export type SlotSource = { kind: 'link'; token: string } | { kind: 'manage'; token: string } | { kind: 'booking'; id: string };

function slotsPath(source: SlotSource): string {
  if (source.kind === 'link') return `/public/booking/${source.token}/slots`;
  if (source.kind === 'manage') return `/public/bookings/${source.token}/slots`;
  return `/scheduling/bookings/${source.id}/slots`;
}

export function useSlots(source: SlotSource, from: string, to: string, timeZone: string, enabled = true) {
  const id = source.kind === 'booking' ? source.id : source.token;
  return useQuery({
    queryKey: schedulingKeys.slots(source.kind, id, from, to, timeZone),
    queryFn: () => api.get<SlotDays>(slotsPath(source), { from, to, timeZone }),
    enabled: enabled && Boolean(timeZone),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useBookingLinks(subject: { dealId?: string; contactId?: string }) {
  return useQuery({
    queryKey: schedulingKeys.links(subject),
    queryFn: () => api.get<BookingLink[]>('/scheduling/links', subject),
    enabled: Boolean(subject.dealId || subject.contactId),
  });
}

// ---------- Labels ----------

export const LOCATION_LABELS: Record<LocationKind, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  phone: 'Phone call',
  in_person: 'In person',
};

export const LOCATION_ICONS: Record<LocationKind, 'device' | 'phone' | 'pin'> = {
  zoom: 'device',
  google_meet: 'device',
  teams: 'device',
  phone: 'phone',
  in_person: 'pin',
};

export const STATUS_LABELS: Record<Booking['status'], string> = {
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  completed: 'Attended',
  no_show: 'No-show',
};

export function statusTone(booking: Pick<Booking, 'status' | 'live'>): 'success' | 'warning' | 'danger' | 'neutral' | 'accent' {
  if (booking.live) return 'accent';
  if (booking.status === 'completed') return 'success';
  if (booking.status === 'no_show') return 'danger';
  if (booking.status === 'cancelled') return 'neutral';
  if (booking.status === 'rescheduled') return 'warning';
  return 'accent';
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// ---------- Dates in a time zone (no libraries) ----------

const partsFormats = new Map<string, Intl.DateTimeFormat>();
function partsIn(zone: string): Intl.DateTimeFormat {
  let format = partsFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    partsFormats.set(zone, format);
  }
  return format;
}

/** "2026-11-10" and "14:30" for an instant in a zone. */
export function zonedParts(value: string | number | Date, zone: string): { date: string; time: string } {
  const parts = Object.fromEntries(partsIn(zone).formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export const todayIn = (zone: string): string => zonedParts(Date.now(), zone).date;

/** Calendar arithmetic on YYYY-MM-DD (no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Monday on or before a date. */
export const startOfWeek = (date: string): string => addDays(date, -((weekdayOf(date) + 6) % 7));

/** "Tue 10 Nov" for a local date. */
export function dayLabel(date: string, options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "4:30 pm" in a zone. */
export function timeLabel(value: string | number | Date, zone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

/** "4:30 pm" from a local "16:30". */
export function clockLabel(clock: string): string {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "GMT+5:30" for a zone right now. */
export function offsetLabel(zone: string, at: number = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

const COMMON_ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Kathmandu', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

/** Every zone the browser knows, common ones first, as { value, label } with the current offset. */
export function timeZoneOptions(current?: string | null): Array<{ value: string; label: string }> {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = COMMON_ZONES;
  }
  const ordered = [...new Set([...(current ? [current] : []), ...COMMON_ZONES, ...all])];
  return ordered.map((zone) => ({ value: zone, label: `${zone.replace(/_/g, ' ')} (${offsetLabel(zone)})` }));
}

/** The visitor's zone, with old names mapped to today's (Asia/Calcutta → Asia/Kolkata). */
export function detectedTimeZone(fallback = 'Asia/Kolkata'): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const renamed: Record<string, string> = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Europe/Kiev': 'Europe/Kyiv' };
    return zone ? (renamed[zone] ?? zone) : fallback;
  } catch {
    return fallback;
  }
}
