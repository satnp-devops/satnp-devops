// How tasks read: kind and priority labels, and the record a task is about. Plain functions.

import type { IconName } from '@/components/icons';
import type { Task, TaskKind, TaskPriority, TaskRelatedType } from '@/lib/crm/types';

export const TASK_KIND_OPTIONS: ReadonlyArray<{ value: TaskKind; label: string; icon: IconName }> = [
  { value: 'follow_up', label: 'Follow-up', icon: 'repeat' },
  { value: 'call', label: 'Call', icon: 'phone' },
  { value: 'message', label: 'Message', icon: 'message' },
  { value: 'email', label: 'Email', icon: 'mail' },
  { value: 'meeting', label: 'Meeting', icon: 'calendar' },
  { value: 'other', label: 'To-do', icon: 'check' },
];

export const TASK_PRIORITY_OPTIONS: ReadonlyArray<{ value: TaskPriority; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

export const RELATED_TYPE_OPTIONS: ReadonlyArray<{ value: TaskRelatedType; label: string; icon: IconName }> = [
  { value: 'deal', label: 'Leads', icon: 'funnel' },
  { value: 'contact', label: 'People', icon: 'user' },
  { value: 'account', label: 'Institutes', icon: 'building' },
  { value: 'none', label: 'Not linked', icon: 'dot' },
];

export function taskKindIcon(kind: TaskKind): IconName {
  return TASK_KIND_OPTIONS.find((option) => option.value === kind)?.icon ?? 'tasks';
}

export function taskKindLabel(kind: TaskKind): string {
  return TASK_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? 'Task';
}

export interface RelatedLink {
  type: Exclude<TaskRelatedType, 'none'>;
  /** Short code shown in JetBrains Mono (a deal's ref), when there is one. */
  code: string | null;
  label: string;
  href: string;
}

/** The record a task is about, most specific first: its deal, else its person, else its institute. */
export function relatedOf(task: Pick<Task, 'deal' | 'contact' | 'account'>): RelatedLink | null {
  if (task.deal) return { type: 'deal', code: task.deal.ref, label: task.deal.title, href: `/leads/${task.deal.id}` };
  if (task.contact) {
    return { type: 'contact', code: null, label: task.contact.displayName, href: `/leads/contacts?contact=${task.contact.id}` };
  }
  if (task.account) return { type: 'account', code: null, label: task.account.name, href: `/accounts/${task.account.id}` };
  return null;
}

/** Reminder choices, as minutes before the due time. */
export const REMINDER_OPTIONS: ReadonlyArray<{ value: string; label: string; minutes: number | null }> = [
  { value: 'none', label: 'No reminder', minutes: null },
  { value: '0', label: 'At the due time', minutes: 0 },
  { value: '15', label: '15 minutes before', minutes: 15 },
  { value: '60', label: '1 hour before', minutes: 60 },
  { value: '1440', label: '1 day before', minutes: 1440 },
];

/** Which reminder choice a task's reminder matches ('custom' when it's another time). */
export function reminderChoice(dueAt: string | null, reminderAt: string | null): string {
  if (!reminderAt) return 'none';
  if (!dueAt) return 'custom';
  const minutes = Math.round((new Date(dueAt).getTime() - new Date(reminderAt).getTime()) / 60_000);
  return REMINDER_OPTIONS.find((option) => option.minutes === minutes)?.value ?? 'custom';
}

export function reminderAtFor(dueAt: string | null, choice: string, current: string | null): string | null {
  if (choice === 'custom') return current;
  const option = REMINDER_OPTIONS.find((item) => item.value === choice);
  if (!dueAt || !option || option.minutes === null) return null;
  return new Date(new Date(dueAt).getTime() - option.minutes * 60_000).toISOString();
}

type TaskFields = Pick<Task, 'title' | 'notes' | 'kind' | 'priority' | 'dueAt' | 'reminderAt'> & { assigneeUserId: string | null };

/** Only the fields that changed, so an edit doesn't reset a reminder that was already sent. */
export function taskChanges(task: Task, values: TaskFields): Partial<TaskFields> {
  const before: TaskFields = {
    title: task.title,
    notes: task.notes,
    kind: task.kind,
    priority: task.priority,
    dueAt: task.dueAt,
    reminderAt: task.reminderAt,
    assigneeUserId: task.assignee?.id ?? null,
  };
  const sameTime = (a: string | null, b: string | null) => (a && b ? new Date(a).getTime() === new Date(b).getTime() : a === b);
  const changes: Partial<TaskFields> = {};
  if (values.title !== before.title) changes.title = values.title;
  if ((values.notes ?? null) !== (before.notes ?? null)) changes.notes = values.notes;
  if (values.kind !== before.kind) changes.kind = values.kind;
  if (values.priority !== before.priority) changes.priority = values.priority;
  if (!sameTime(values.dueAt, before.dueAt)) changes.dueAt = values.dueAt;
  if (!sameTime(values.reminderAt, before.reminderAt)) changes.reminderAt = values.reminderAt;
  if (values.assigneeUserId !== before.assigneeUserId) changes.assigneeUserId = values.assigneeUserId;
  return changes;
}
