'use client';

import { useState } from 'react';
import { UnitSelect } from '@/components/UnitSelect';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { timeZoneCity } from '@/lib/crm/format';
import type { PersonOption, Task, TaskKind, TaskPriority } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { fromZonedInput, quickDueAt, toZonedInput, type QuickDue } from '@/lib/tasks/dates';
import { REMINDER_OPTIONS, TASK_KIND_OPTIONS, TASK_PRIORITY_OPTIONS, reminderAtFor, reminderChoice } from '@/lib/tasks/present';
import { useAssignees } from '@/lib/tasks/queries';
import type { OrgUnit } from '@/lib/types';

/** What the form produces: every editable field, due dates as UTC ISO strings. */
export interface TaskValues {
  unitId: string;
  title: string;
  notes: string | null;
  kind: TaskKind;
  priority: TaskPriority;
  dueAt: string | null;
  reminderAt: string | null;
  assigneeUserId: string | null;
}

const QUICK_DUE: ReadonlyArray<{ value: Exclude<QuickDue, 'none'>; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'nextWeek', label: 'Next week' },
];

const SHOWN_FIELDS = ['unitId', 'title', 'notes', 'kind', 'priority', 'dueAt', 'reminderAt', 'assigneeUserId'];

/**
 * The task fields, used by TaskDialog (create and edit) and the My tasks side panel. It renders
 * only the fields inside <form id={formId}>; the caller puts the submit button where it fits
 * (a dialog footer, a panel footer) with form={formId}. Due dates are entered in `timeZone`.
 *
 * `units`: when creating a task that isn't on a deal, the places it can belong to (the first is
 * the default). Leave it out to keep the unit given in `initial`.
 */
export function TaskForm({
  formId,
  task,
  initialUnitId,
  units,
  timeZone,
  error,
  onSubmit,
}: {
  formId: string;
  task?: Task;
  initialUnitId: string;
  units?: readonly OrgUnit[];
  timeZone: string;
  error: unknown;
  onSubmit: (values: TaskValues) => void;
}) {
  const { user } = useSession();
  const [unitId, setUnitId] = useState(initialUnitId);
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [kind, setKind] = useState<TaskKind>(task?.kind ?? 'follow_up');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'normal');
  const [initialDue] = useState(task?.dueAt ? toZonedInput(task.dueAt, timeZone) : '');
  const [due, setDue] = useState(initialDue);
  const [reminder, setReminder] = useState(reminderChoice(task?.dueAt ?? null, task?.reminderAt ?? null));
  const [assigneeId, setAssigneeId] = useState(task ? (task.assignee?.id ?? '') : user.id);
  const [touched, setTouched] = useState(false);

  const assignees = useAssignees(unitId || null);
  const errors = fieldErrorsOf(error);
  // The input holds minutes: an untouched due date keeps its exact stored value.
  const dueAt = task && due === initialDue ? task.dueAt : due ? (fromZonedInput(due, timeZone)?.toISOString() ?? null) : null;
  const titleError = touched && !title.trim() ? 'Give the task a title' : errors.title;

  // Who can be picked: the people with tasks.view at the unit; while that list is unavailable,
  // yourself and whoever has the task now.
  const people: Array<Pick<PersonOption, 'id' | 'name'>> = assignees.data ? [...assignees.data] : [{ id: user.id, name: user.name }];
  if (task?.assignee && !people.some((person) => person.id === task.assignee?.id)) people.push(task.assignee);
  if (!people.some((person) => person.id === user.id)) people.unshift({ id: user.id, name: user.name });

  const submit = () => {
    setTouched(true);
    if (!title.trim()) return;
    onSubmit({
      unitId,
      title: title.trim(),
      notes: notes.trim() || null,
      kind,
      priority,
      dueAt,
      reminderAt: reminderAtFor(dueAt, reminder, task?.reminderAt ?? null),
      assigneeUserId: assigneeId || null,
    });
  };

  return (
    <form
      id={formId}
      className="tasks-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ErrorAlert error={formErrorOf(error, SHOWN_FIELDS)} />

      <Field label="Task" error={titleError}>
        {(control) => (
          <input
            {...control}
            className="input"
            value={title}
            maxLength={200}
            placeholder="Call back about the demo slot"
            autoFocus={!task}
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </Field>

      {units && units.length > 1 ? (
        <Field label="Belongs to" hint="Who can see and work on the task" error={errors.unitId}>
          {(control) => <UnitSelect control={control} units={units} value={unitId} onChange={setUnitId} />}
        </Field>
      ) : null}

      <div className="tasks-form__grid">
        <Field label="Type" error={errors.kind}>
          {(control) => (
            <select {...control} className="select" value={kind} onChange={(event) => setKind(event.target.value as TaskKind)}>
              {TASK_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Priority" error={errors.priority}>
          {(control) => (
            <select {...control} className="select" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
              {TASK_PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field label="Due" optional hint={`${timeZoneCity(timeZone)} time`} error={errors.dueAt}>
        {(control) => (
          <div className="tasks-form__due">
            <input {...control} className="input mono" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} />
            <div className="tasks-form__quick" role="group" aria-label="Quick due dates">
              {QUICK_DUE.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const at = quickDueAt(option.value, timeZone);
                    setDue(at ? toZonedInput(at, timeZone) : '');
                  }}
                >
                  {option.label}
                </Button>
              ))}
              {due ? (
                <Button size="sm" variant="ghost" onClick={() => setDue('')}>
                  No date
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </Field>

      <div className="tasks-form__grid">
        <Field label="Reminder" error={errors.reminderAt}>
          {(control) => (
            <select {...control} className="select" value={dueAt ? reminder : 'none'} disabled={!dueAt} onChange={(event) => setReminder(event.target.value)}>
              {REMINDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {reminder === 'custom' ? <option value="custom">As set before</option> : null}
            </select>
          )}
        </Field>
        <Field label="Assigned to" error={errors.assigneeUserId}>
          {(control) => (
            <select {...control} className="select" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.id === user.id ? `${person.name} (me)` : person.name}
                </option>
              ))}
              <option value="">Nobody yet</option>
            </select>
          )}
        </Field>
      </div>

      <Field label="Notes" optional error={errors.notes}>
        {(control) => (
          <textarea {...control} className="textarea" rows={3} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        )}
      </Field>
    </form>
  );
}
