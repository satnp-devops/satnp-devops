'use client';

import { useId } from 'react';
import { SidePanel } from '@/components/crm';
import { Button, ButtonLink, ErrorAlert } from '@/components/ui';
import type { Task } from '@/lib/crm/types';
import { relatedOf, taskChanges } from '@/lib/tasks/present';
import { useTaskTransition, useUpdateTask } from '@/lib/tasks/queries';
import { TaskForm, type TaskValues } from './TaskForm';
import './tasks.css';

const RELATED_ACTION = { deal: 'Open lead', contact: 'Open person', account: 'Open institute' } as const;

/**
 * A task in the side panel (full screen on phones): edit every field, mark it done or reopen
 * it, or cancel it. Read-only for people who can see but not manage it.
 */
export function TaskPanel({
  task,
  onClose,
  onChanged,
  timeZone,
}: {
  task: Task | null;
  onClose: () => void;
  /** The task after a change that keeps the panel open (reopen). */
  onChanged: (task: Task) => void;
  timeZone: string;
}) {
  const related = task ? relatedOf(task) : null;
  return (
    <SidePanel
      open={task !== null}
      onClose={onClose}
      title={task ? task.title : 'Task'}
      subtitle={task?.unit.name}
      actions={
        related ? (
          <ButtonLink href={related.href} size="sm" icon="external">
            {RELATED_ACTION[related.type]}
          </ButtonLink>
        ) : null
      }
    >
      {task ? <TaskPanelBody key={`${task.id}-${task.status}`} task={task} onClose={onClose} onChanged={onChanged} timeZone={timeZone} /> : null}
    </SidePanel>
  );
}

function TaskPanelBody({
  task,
  onClose,
  onChanged,
  timeZone,
}: {
  task: Task;
  onClose: () => void;
  onChanged: (task: Task) => void;
  timeZone: string;
}) {
  const formId = useId();
  const update = useUpdateTask();
  const transition = useTaskTransition();
  const canManage = task.can.manage;

  const save = (values: TaskValues) => {
    const { unitId: _unit, ...fields } = values;
    const changes = taskChanges(task, fields);
    if (Object.keys(changes).length === 0) return onClose();
    update.mutate({ id: task.id, changes }, { onSuccess: onClose });
  };

  return (
    <div className="tasks-panel">
      <fieldset className="tasks-panel__fields" disabled={!canManage || task.status !== 'open'}>
        <legend className="visually-hidden">Task details</legend>
        <TaskForm key={timeZone} formId={formId} task={task} initialUnitId={task.unit.id} timeZone={timeZone} error={update.error} onSubmit={save} />
      </fieldset>
      {!canManage ? <p className="small muted">You can see this task but not change it.</p> : null}
      {canManage && task.status !== 'open' ? (
        <p className="small muted">{task.status === 'done' ? 'This task is done.' : 'This task was cancelled.'} Reopen it to change it.</p>
      ) : null}
      <ErrorAlert error={transition.error} />
      {canManage ? (
        <div className="tasks-panel__actions">
          {task.status === 'open' ? (
            <>
              <Button type="submit" form={formId} variant="primary" loading={update.isPending}>
                Save
              </Button>
              <Button
                icon="check"
                loading={transition.isPending && transition.variables?.transition === 'complete'}
                onClick={() => transition.mutate({ id: task.id, transition: 'complete' }, { onSuccess: onClose })}
              >
                Mark done
              </Button>
              <span className="spacer" />
              <Button
                variant="ghost"
                loading={transition.isPending && transition.variables?.transition === 'cancel'}
                onClick={() => transition.mutate({ id: task.id, transition: 'cancel' }, { onSuccess: onClose })}
              >
                Cancel task
              </Button>
            </>
          ) : (
            <Button icon="restore" loading={transition.isPending} onClick={() => transition.mutate({ id: task.id, transition: 'reopen' }, { onSuccess: onChanged })}>
              Reopen
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
