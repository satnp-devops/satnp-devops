'use client';

import Link from 'next/link';
import { Mono } from '@/components/crm';
import { Icon } from '@/components/icons';
import { cx } from '@/components/ui';
import { formatInZone } from '@/lib/crm/format';
import type { Task } from '@/lib/crm/types';
import { dueLabel } from '@/lib/tasks/dates';
import { relatedOf, taskKindIcon, taskKindLabel } from '@/lib/tasks/present';

/**
 * One task: the complete checkbox, its title (opens it), when it's due in the viewer's zone, the
 * record it's about (a link) and, where it helps, who has it.
 */
export function TaskRow({
  task,
  timeZone,
  done,
  pending,
  onToggle,
  onOpen,
  showRelated = true,
  showAssignee = false,
}: {
  task: Task;
  timeZone: string;
  /** The checkbox state (the new state while a toggle is saving). */
  done: boolean;
  pending: boolean;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  showRelated?: boolean;
  showAssignee?: boolean;
}) {
  const related = showRelated ? relatedOf(task) : null;
  const cancelled = task.status === 'cancelled';
  const checkboxId = `task-${task.id}`;
  return (
    <li className={cx('tasks-row', done && 'is-done', cancelled && 'is-cancelled', task.overdue && !done && 'is-overdue')}>
      <span className="tasks-row__check">
        <input
          id={checkboxId}
          type="checkbox"
          checked={done}
          disabled={!task.can.manage || pending || cancelled}
          aria-label={done ? `Reopen “${task.title}”` : `Mark “${task.title}” done`}
          onChange={() => onToggle(task)}
        />
      </span>
      <div className="tasks-row__main">
        <button type="button" className="tasks-row__title" onClick={() => onOpen(task)}>
          {task.priority === 'high' && !done ? (
            <span className="tasks-row__priority" title="High priority">
              <Icon name="flag" size={13} aria-hidden="true" />
              <span className="visually-hidden">High priority: </span>
            </span>
          ) : null}
          {task.title}
        </button>
        <div className="tasks-row__meta">
          <span className="tasks-row__kind">
            <Icon name={taskKindIcon(task.kind)} size={13} aria-hidden="true" />
            {taskKindLabel(task.kind)}
          </span>
          {done && task.completedAt ? (
            <span className="tasks-row__due">
              <Icon name="check" size={13} aria-hidden="true" />
              Done <time dateTime={task.completedAt}>{dueLabel(task.completedAt, timeZone)}</time>
            </span>
          ) : cancelled ? (
            <span className="tasks-row__due">Cancelled</span>
          ) : task.dueAt ? (
            <span className={cx('tasks-row__due', task.overdue && 'is-overdue')} title={formatInZone(task.dueAt, 'datetime', timeZone)}>
              <Icon name="clock" size={13} aria-hidden="true" />
              {task.overdue ? <span className="visually-hidden">Overdue, was due </span> : null}
              <time dateTime={task.dueAt}>{dueLabel(task.dueAt, timeZone)}</time>
            </span>
          ) : (
            <span className="tasks-row__due">No due date</span>
          )}
          {related ? (
            <Link href={related.href} className="tasks-row__related">
              {related.code ? <Mono>{related.code}</Mono> : null}
              <span className="tasks-row__related-label">{related.label}</span>
            </Link>
          ) : null}
          {showAssignee ? <span className="tasks-row__assignee">{task.assignee ? task.assignee.name : 'Unassigned'}</span> : null}
        </div>
      </div>
    </li>
  );
}
