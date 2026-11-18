'use client';

import { useId } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button } from '@/components/ui';
import type { Task, TaskInput, TimelineSubject } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { taskChanges } from '@/lib/tasks/present';
import { useCreateTask, useTaskTimeZone, useUpdateTask } from '@/lib/tasks/queries';
import type { OrgUnit } from '@/lib/types';
import { TaskForm, type TaskValues } from './TaskForm';
import './tasks.css';

/**
 * Where the viewer can create tasks that aren't on a deal: the companies, branches and teams
 * they work in with tasks.manage. The default is the current scope when it's one of them, else
 * the company picked in a filter, else the first.
 */
export function useTaskUnits(preferredId?: string): { units: OrgUnit[]; defaultUnitId: string } {
  const { workUnits, scope, can } = useSession();
  const units = workUnits.filter((unit) => unit.depth >= 1 && unit.status === 'active' && can('tasks.manage', unit));
  const pick = [preferredId, scope.id].find((id) => id && units.some((unit) => unit.id === id));
  return { units, defaultUnitId: pick ?? units[0]?.id ?? '' };
}

/**
 * Create a task (on a deal, person or institute, or on its own) or edit one. For a deal the
 * task belongs to the deal's unit; otherwise the viewer picks one of their units. `unitId` is
 * the deal's unit when known (it decides who can be assigned).
 */
export function TaskDialog({
  open,
  onClose,
  task,
  subject,
  unitId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  task?: Task;
  subject?: TimelineSubject;
  unitId?: string;
  onSaved?: (task: Task) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={task ? 'Edit task' : 'New task'}>
      <TaskDialogBody task={task} subject={subject} unitId={unitId} onClose={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function TaskDialogBody({
  task,
  subject,
  unitId,
  onClose,
  onSaved,
}: {
  task?: Task;
  subject?: TimelineSubject;
  unitId?: string;
  onClose: () => void;
  onSaved?: (task: Task) => void;
}) {
  const formId = useId();
  const { scope } = useSession();
  const onDeal = Boolean(subject && 'dealId' in subject);
  const { units, defaultUnitId } = useTaskUnits(unitId);
  const initialUnitId = task?.unit.id ?? (onDeal ? (unitId ?? scope.id) : defaultUnitId);
  const timeZone = useTaskTimeZone(initialUnitId || scope.id);
  const create = useCreateTask();
  const update = useUpdateTask();
  const mutation = task ? update : create;

  const done = (saved: Task) => {
    onSaved?.(saved);
    onClose();
  };

  const submit = (values: TaskValues) => {
    const { unitId: chosenUnit, ...fields } = values;
    if (task) {
      const changes = taskChanges(task, fields);
      if (Object.keys(changes).length === 0) return onClose();
      update.mutate({ id: task.id, changes }, { onSuccess: done });
      return;
    }
    const input: TaskInput = { ...fields, ...(subject ?? {}), ...(onDeal ? {} : { unitId: chosenUnit }) };
    create.mutate(input, { onSuccess: done });
  };

  return (
    <>
      <DialogBody>
        <TaskForm
          // Remount once the time zone is known, so due dates are read and entered in one zone.
          key={timeZone}
          formId={formId}
          task={task}
          initialUnitId={initialUnitId}
          units={task || onDeal ? undefined : units}
          timeZone={timeZone}
          error={mutation.error}
          onSubmit={submit}
        />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" loading={mutation.isPending}>
          {task ? 'Save' : 'Add task'}
        </Button>
      </DialogFooter>
    </>
  );
}
