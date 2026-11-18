// How timeline entries read: icon, heading and a short summary of their meta. Plain functions.

import type { IconName } from '@/components/icons';
import { formatDuration, humanize } from '@/lib/crm/format';
import type { ManualTimelineKind, TimelineEntry, TimelineKindKey } from '@/lib/crm/types';

const KIND_ICONS: Record<string, IconName> = {
  note: 'note',
  message: 'message',
  call: 'phone',
  email: 'mail',
  meeting: 'calendar',
  system: 'info',
  stage_change: 'arrowRight',
  task: 'tasks',
  ai: 'sparkle',
};

export function kindIcon(kind: TimelineKindKey): IconName {
  return KIND_ICONS[kind] ?? 'dot';
}

const KIND_NOUNS: Record<string, string> = { message: 'message', call: 'call', email: 'email', meeting: 'meeting' };

/** The line an entry starts with: its title, else "Incoming call", "Outgoing message", "Note"… */
export function entryHeading(entry: TimelineEntry, kindLabel?: string): string {
  if (entry.title) return entry.title;
  const noun = KIND_NOUNS[entry.kind];
  if (noun && entry.direction === 'inbound') return `Incoming ${noun}`;
  if (noun && entry.direction === 'outbound') return `Outgoing ${noun}`;
  return kindLabel ?? humanize(entry.kind);
}

const OUTCOMES: Record<string, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  voicemail: 'Voicemail',
  wrong_number: 'Wrong number',
  left_message: 'Left a message',
};

/** "4 min · Connected", "Subject: Fee details", "3 attendees". */
export function metaSummary(entry: TimelineEntry): string[] {
  const parts: string[] = [];
  const { durationSeconds, outcome, subject, attendees } = entry.meta;
  if (typeof durationSeconds === 'number' && durationSeconds > 0) parts.push(formatDuration(durationSeconds * 1000));
  if (typeof outcome === 'string') parts.push(OUTCOMES[outcome] ?? humanize(outcome));
  if (typeof subject === 'string' && subject) parts.push(`Subject: ${subject}`);
  if (Array.isArray(attendees) && attendees.length > 0) parts.push(attendees.join(', '));
  return parts;
}

export function actorName(entry: TimelineEntry): string {
  if (entry.actor) return entry.actor.name;
  if (entry.actorType === 'ai') return 'AI assistant';
  if (entry.actorType === 'contact') return 'Contact';
  return 'System';
}

/** The kinds people can add from the composer, with their verbs. */
export const COMPOSER_KINDS: ReadonlyArray<{ kind: ManualTimelineKind; label: string; icon: IconName }> = [
  { kind: 'note', label: 'Note', icon: 'note' },
  { kind: 'call', label: 'Log call', icon: 'phone' },
  { kind: 'email', label: 'Log email', icon: 'mail' },
  { kind: 'meeting', label: 'Log meeting', icon: 'calendar' },
  { kind: 'message', label: 'Log message', icon: 'message' },
];

/** Filter chips: one per kind people look for, "Updates" for everything the system writes. */
export const KIND_FILTERS: ReadonlyArray<{ value: string; label: string; kinds: TimelineKindKey[]; icon: IconName }> = [
  { value: 'note', label: 'Notes', kinds: ['note'], icon: 'note' },
  { value: 'message', label: 'Messages', kinds: ['message'], icon: 'message' },
  { value: 'call', label: 'Calls', kinds: ['call'], icon: 'phone' },
  { value: 'email', label: 'Emails', kinds: ['email'], icon: 'mail' },
  { value: 'meeting', label: 'Meetings', kinds: ['meeting'], icon: 'calendar' },
  { value: 'task', label: 'Tasks', kinds: ['task'], icon: 'tasks' },
  { value: 'updates', label: 'Updates', kinds: ['system', 'stage_change', 'ai'], icon: 'info' },
];

export function kindsForFilters(values: readonly string[]): TimelineKindKey[] {
  return KIND_FILTERS.filter((filter) => values.includes(filter.value)).flatMap((filter) => filter.kinds);
}
