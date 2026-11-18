// API shapes of the scheduling module (apps/api/src/modules/scheduling/present.js). Times are UTC ISO strings.

export type LocationKind = 'zoom' | 'google_meet' | 'teams' | 'phone' | 'in_person';
export type Assignment = 'round_robin' | 'single';
export type BookingStatus = 'booked' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
export type BookingView = 'upcoming' | 'past' | 'live' | 'no_shows' | 'reschedule_requests' | 'cancelled' | 'all';
export type QuestionType = 'text' | 'textarea' | 'select' | 'phone' | 'email';
export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface Choice {
  value: string;
  label: string;
}

export interface Question {
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options?: Choice[] | null;
  help?: string | null;
}

export interface AttendeePolicy {
  ask: boolean;
  label?: string;
  options: Choice[];
  maxGuests: number;
}

export interface EventTypeBranding {
  color?: string;
  logoUrl?: string;
  headline?: string;
  confirmationMessage?: string;
}

export interface EventTypeHost {
  user: { id: string; name: string };
  weight: number;
  priority: number;
  languages: string[];
  active: boolean;
  hasAvailability: boolean;
}

export interface EventType {
  id: string;
  companyId: string;
  unit: { id: string; name: string; type: string };
  slug: string;
  name: string;
  description: string | null;
  durationMin: number;
  slotIntervalMin: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxPerDay: number | null;
  horizonDays: number;
  alignTimeZone: string | null;
  locationKind: LocationKind;
  locationDetail: string | null;
  assignment: Assignment;
  attendanceThresholdMin: number;
  reminderOffsetsMin: number[];
  questions: Question[];
  attendees: Partial<AttendeePolicy>;
  branding: EventTypeBranding;
  dealKind: 'b2c' | 'b2b' | null;
  active: boolean;
  archivedAt: string | null;
  hosts: EventTypeHost[];
  publicLink: { id: string; url: string; token: string } | null;
  can: { configure: boolean; book: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface HostInput {
  userId: string;
  weight: number;
  priority: number;
  languages: string[];
  active: boolean;
}

export interface EventTypeInput {
  unitId?: string;
  name: string;
  slug: string;
  description: string | null;
  durationMin: number;
  slotIntervalMin: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxPerDay: number | null;
  horizonDays: number;
  locationKind: LocationKind;
  locationDetail: string | null;
  assignment: Assignment;
  attendanceThresholdMin: number;
  reminderOffsetsMin: number[];
  questions: Question[];
  attendees: AttendeePolicy;
  branding: EventTypeBranding;
  dealKind: 'b2c' | 'b2b' | null;
  hosts?: HostInput[];
}

export interface HostCandidate {
  id: string;
  name: string;
  hasAvailability: boolean;
  /** Has a role in this unit or below (not only higher up, like a group owner). */
  worksHere: boolean;
}

export type Ranges = string[];
export type Override = 'unavailable' | Ranges;

export interface Availability {
  user: { id: string; name: string } | null;
  timeZone: string | null;
  weekly: Partial<Record<Weekday, Ranges>>;
  overrides: Record<string, Override>;
  configured: boolean;
  updatedAt: string | null;
  suggestedTimeZone: string | null;
  canEdit: boolean;
}

export interface MeetingInfo {
  provider: string;
  status: 'scheduled' | 'live' | 'ended';
  result: 'pending' | 'attended' | 'no_show';
  thresholdMin: number;
  inviteeSeconds: number;
  hostSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
  evaluatedAt: string | null;
  recording: Record<string, unknown> | null;
  aiSummary: string | null;
  aiSummaryStatus: 'none' | 'pending' | 'ready' | 'failed';
}

export interface Booking {
  id: string;
  status: BookingStatus;
  startAt: string;
  endAt: string;
  timeZone: string;
  companyId: string;
  unit: { id: string; name: string; type: string } | null;
  eventType: { id: string; name: string; slug: string; durationMin: number; locationKind: LocationKind } | null;
  host: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  invitee: { name: string; email: string | null; phone: string | null; piiMasked: boolean };
  attending: string | null;
  attendingLabel: string | null;
  guests: Array<{ name: string; email: string | null }>;
  answers: Record<string, string>;
  answerList: Array<{ key: string; label: string; value: string }>;
  notes: string | null;
  location: { kind: LocationKind; detail: string | null; meetingUrl: string | null; provider: string | null };
  deal: { id: string; ref: string; title: string; status: string } | null;
  contact: { id: string; displayName: string; kind: string } | null;
  source: string;
  assignmentReason: string | null;
  rescheduleCount: number;
  rescheduleRequest: { at: string; note: string | null } | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  completedAt: string | null;
  noShowAt: string | null;
  meeting: MeetingInfo | null;
  live: boolean;
  can: { manage: boolean; reschedule: boolean; cancel: boolean; assign: boolean; markOutcome: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface BookingSummary {
  live: number;
  next24h: number;
  upcoming: number;
  noShows30d: number;
  rescheduleRequests: number;
  awaitingOutcome: number;
}

export interface ReassignCandidate {
  id: string;
  name: string;
  timeZone: string;
  available: boolean;
}

export interface Slot {
  start: string;
  end: string;
  localTime: string;
}

export interface SlotDays {
  timeZone: string;
  days: Array<{ date: string; slots: Slot[] }>;
}

export interface BookingLink {
  id: string;
  kind: 'public' | 'personal';
  url: string;
  token: string;
  eventType: { id: string; name: string; durationMin: number } | null;
  dealId: string | null;
  contactId: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  lastSentAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'used' | 'revoked';
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  delivery?: { status: string; channel: string };
}

// ---------- Public booking page ----------

export interface Branding {
  companyName: string;
  color: string;
  logoUrl: string | null;
  headline: string | null;
  confirmationMessage: string | null;
}

export interface PublicEventType {
  name: string;
  description: string | null;
  durationMin: number;
  locationKind: LocationKind;
  locationDetail: string | null;
  questions: Question[];
  attendees: AttendeePolicy & { label: string };
  horizonDays: number;
}

export interface PublicPage {
  eventType: PublicEventType;
  branding: Branding;
  companyTimeZone: string;
  personal: boolean;
  prefill: { name: string | null; attending: string | null };
  hostName: string | null;
  expiresAt: string | null;
  usedUp: boolean;
}

export interface PublicBooking {
  id: string;
  status: BookingStatus;
  startAt: string;
  endAt: string;
  timeZone: string;
  inviteeName: string;
  attending: string | null;
  eventType: PublicEventType;
  host: { name: string } | null;
  location: { kind: LocationKind; detail: string | null; meetingUrl: string | null };
  branding: Branding;
  rescheduleRequested: boolean;
  manageToken: string;
  manageUrl: string;
  icsPath: string;
  can: { reschedule: boolean; cancel: boolean; requestReschedule: boolean };
}
