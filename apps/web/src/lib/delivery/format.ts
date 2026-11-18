import type { PillTone } from '@/components/crm';
import type {
  AccessStatus,
  BatchMode,
  BatchSchedule,
  BatchStatus,
  ChurnLevel,
  EnrollmentStatus,
  ProjectStatus,
  RefundStatus,
  SeatStatus,
  WithdrawalChannel,
} from './types';

// Labels and tones for the delivery screens.

export const ENROLLMENT_STATUS: Record<EnrollmentStatus, { label: string; tone: PillTone }> = {
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  withdrawn: { label: 'Withdrawn', tone: 'danger' },
  completed: { label: 'Completed', tone: 'neutral' },
};

export const SEAT_STATUS: Record<SeatStatus, { label: string; tone: PillTone }> = {
  seated: { label: 'Seated', tone: 'success' },
  waitlisted: { label: 'Waitlisted', tone: 'warning' },
  unassigned: { label: 'No batch yet', tone: 'neutral' },
};

export const ACCESS_STATUS: Record<AccessStatus, { label: string; tone: PillTone }> = {
  not_required: { label: 'Not needed', tone: 'neutral' },
  pending: { label: 'To set up', tone: 'warning' },
  granted: { label: 'Has access', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'warning' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

export const BATCH_STATUS: Record<BatchStatus, { label: string; tone: PillTone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  open: { label: 'Open', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

export const BATCH_MODES: Record<BatchMode, string> = { online: 'Online', centre: 'At the centre', hybrid: 'Hybrid' };

export const REFUND_STATUS: Record<RefundStatus, { label: string; tone: PillTone }> = {
  requested: { label: 'Refund requested', tone: 'warning' },
  processing: { label: 'Refund in progress', tone: 'accent' },
  paid: { label: 'Refund paid', tone: 'success' },
  not_applicable: { label: 'No refund due', tone: 'neutral' },
  failed: { label: 'Refund failed', tone: 'danger' },
};

export const WITHDRAWAL_CHANNELS: Record<WithdrawalChannel, string> = {
  whatsapp: 'WhatsApp',
  phone: 'Phone call',
  email: 'Email',
  counter: 'At the centre',
  form: 'Withdrawal form',
  portal: 'Student portal',
  other: 'Other',
};

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: PillTone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'accent' },
  live: { label: 'Live', tone: 'success' },
  on_hold: { label: 'On hold', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

export const CHURN_LEVEL: Record<ChurnLevel, { label: string; tone: PillTone }> = {
  low: { label: 'Low risk', tone: 'success' },
  medium: { label: 'Medium risk', tone: 'warning' },
  high: { label: 'High risk', tone: 'danger' },
};

const DAY_LABELS: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** "Sat, Sun · 10:00–13:00" */
export function scheduleLabel(schedule: BatchSchedule | null | undefined): string {
  if (!schedule) return '';
  const days = (schedule.days ?? []).map((d) => DAY_LABELS[d] ?? d).join(', ');
  const time = schedule.startTime ? `${schedule.startTime}${schedule.endTime ? `–${schedule.endTime}` : ''}` : '';
  return [days, time].filter(Boolean).join(' · ');
}

/** "12 Jan – 28 Mar 2027" for a calendar date range (YYYY-MM-DD, no time zone involved). */
export function dateRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return '';
  const fmt = (value: string, withYear: boolean) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  if (!to) return fmt(from, true);
  return `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`;
}

/** "12 Jan 2027" for a calendar date. */
export function dateLabel(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Today as YYYY-MM-DD in India. */
export function todayInIndia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/** Whole days from today (India) to a date; negative when it has passed. */
export function daysUntil(date: string): number {
  const today = Date.parse(`${todayInIndia()}T00:00:00Z`);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

export function percent(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}
