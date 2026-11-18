'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, ErrorAlert } from '@/components/ui';
import type { Task } from '@/lib/crm/types';
import { useTaskTransition } from '@/lib/tasks/queries';

const UNDO_MS = 8000;

interface Undo {
  task: Task;
  /** What the toggle did: completed it or reopened it. */
  completed: boolean;
}

/**
 * The complete checkbox with undo: ticking completes the task (unticking reopens it) and shows
 * "Task completed · Undo" for a few seconds. The box shows its new state while the request runs.
 * Render `bar` once, anywhere on the page.
 */
export function useTaskToggle() {
  const transition = useTaskTransition();
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [undo, setUndo] = useState<Undo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const setDone = (id: string, done: boolean | null) =>
    setOptimistic((current) => {
      const next = new Map(current);
      if (done === null) next.delete(id);
      else next.set(id, done);
      return next;
    });

  const run = (task: Task, complete: boolean, offerUndo: boolean) => {
    setError(null);
    setDone(task.id, complete);
    transition.mutate(
      { id: task.id, transition: complete ? 'complete' : 'reopen' },
      {
        onSuccess: (saved) => {
          window.clearTimeout(timer.current);
          if (offerUndo) {
            setUndo({ task: saved, completed: complete });
            timer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
          } else {
            setUndo(null);
          }
        },
        onError: (failure) => setError(failure),
        onSettled: () => setDone(task.id, null),
      },
    );
  };

  const toggle = (task: Task) => run(task, task.status === 'open', true);
  const isDone = (task: Task) => optimistic.get(task.id) ?? task.status === 'done';
  const isPending = (task: Task) => optimistic.has(task.id);

  // The live region stays mounted so screen readers announce what appears in it.
  const bar = (
    <div className="tasks-undo-region" role="status" aria-live="polite">
      {undo || error ? (
        <div className="tasks-undo">
          {error ? (
            <ErrorAlert error={error} title="The task didn't change" />
          ) : undo ? (
            <>
              <span className="tasks-undo__text">
                {undo.completed ? 'Task completed' : 'Task reopened'}: <strong>{undo.task.title}</strong>
              </span>
              <Button size="sm" variant="ghost" className="tasks-undo__action" onClick={() => run(undo.task, !undo.completed, false)}>
                Undo
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="x"
            aria-label="Dismiss"
            className="tasks-undo__close"
            onClick={() => {
              setUndo(null);
              setError(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );

  return { toggle, isDone, isPending, bar };
}
