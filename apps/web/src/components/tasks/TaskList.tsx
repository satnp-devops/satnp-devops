'use client';

import { useState } from 'react';
import { Section } from '@/components/crm';
import { Button, ErrorAlert, Spinner } from '@/components/ui';
import type { Task, TimelineSubject } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { useTaskList, useTaskTimeZone, type TaskListParams } from '@/lib/tasks/queries';
import { TaskDialog } from './TaskDialog';
import { TaskRow } from './TaskRow';
import { useTaskToggle } from './useTaskToggle';
import './tasks.css';

function subjectParams(subject: TimelineSubject): Pick<TaskListParams, 'dealId' | 'contactId' | 'accountId'> {
  if ('dealId' in subject) return { dealId: subject.dealId };
  if ('contactId' in subject) return { contactId: subject.contactId };
  return { accountId: subject.accountId };
}

/**
 * The tasks on a deal, person or institute, for every assignee: open ones by due date, done
 * ones on request. Add, edit, complete (with undo) and reopen from here. `unitId` is the deal's
 * unit when known (it decides who can be assigned new tasks).
 */
export function TaskList({
  subject,
  unitId,
  title = 'Tasks',
  level = 2,
}: {
  subject: TimelineSubject;
  unitId?: string;
  title?: string;
  level?: 2 | 3;
}) {
  const { scope, canAnywhere } = useSession();
  const timeZone = useTaskTimeZone(unitId ?? scope.id);
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const toggle = useTaskToggle();
  const base = { unitId: scope.id, ...subjectParams(subject), limit: 20 };
  const open = useTaskList({ ...base, status: ['open'], sort: 'dueAt' });
  const done = useTaskList({ ...base, status: ['done'], sort: '-completedAt' }, { enabled: showDone });
  const openTasks = (open.data?.pages ?? []).flatMap((page) => page.data);
  const doneTasks = (done.data?.pages ?? []).flatMap((page) => page.data);
  const showRelated = !('dealId' in subject);
  const canAdd = canAnywhere('tasks.manage');

  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      timeZone={timeZone}
      done={toggle.isDone(task)}
      pending={toggle.isPending(task)}
      onToggle={toggle.toggle}
      onOpen={setEditing}
      showRelated={showRelated}
      showAssignee
    />
  );

  return (
    <Section
      title={title}
      level={level}
      flush
      count={open.isSuccess && !open.hasNextPage ? openTasks.length : undefined}
      className="tasks-list"
      actions={
        canAdd ? (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add task
          </Button>
        ) : null
      }
    >
      {open.isPending ? (
        <div className="tasks-list__state">
          <Spinner label="Loading tasks" />
        </div>
      ) : !open.data ? (
        <div className="tasks-list__state">
          <ErrorAlert error={open.error} title="Tasks didn't load" />
          <Button size="sm" icon="refresh" onClick={() => void open.refetch()}>
            Try again
          </Button>
        </div>
      ) : openTasks.length === 0 ? (
        <p className="tasks-list__empty">No open tasks.{canAdd ? ' Add one for the next step.' : ''}</p>
      ) : (
        <ul className="tasks-rows">{openTasks.map(row)}</ul>
      )}
      {open.hasNextPage ? (
        <div className="load-more">
          <Button size="sm" loading={open.isFetchingNextPage} onClick={() => void open.fetchNextPage()}>
            Show more
          </Button>
        </div>
      ) : null}

      <div className="tasks-list__done">
        <Button size="sm" variant="ghost" icon={showDone ? 'chevronDown' : 'chevronRight'} aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
          Done tasks
        </Button>
        {showDone ? (
          done.isPending ? (
            <Spinner label="Loading done tasks" />
          ) : !done.data ? (
            <ErrorAlert error={done.error} />
          ) : doneTasks.length === 0 ? (
            <p className="tasks-list__empty">Nothing done yet.</p>
          ) : (
            <>
              <ul className="tasks-rows">{doneTasks.map(row)}</ul>
              {done.hasNextPage ? (
                <Button size="sm" loading={done.isFetchingNextPage} onClick={() => void done.fetchNextPage()}>
                  Show more
                </Button>
              ) : null}
            </>
          )
        ) : null}
      </div>

      {toggle.bar}
      <TaskDialog open={adding} onClose={() => setAdding(false)} subject={subject} unitId={unitId} />
      <TaskDialog open={editing !== null} onClose={() => setEditing(null)} task={editing ?? undefined} />
    </Section>
  );
}
