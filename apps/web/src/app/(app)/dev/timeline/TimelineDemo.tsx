'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Mono } from '@/components/crm';
import { TaskList } from '@/components/tasks';
import { Timeline } from '@/components/timeline';
import { EmptyState, ErrorAlert, PageHeader, PageLoading, cx } from '@/components/ui';
import { api } from '@/lib/api';
import type { Task, TimelineSubject } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import type { Person } from '@/lib/types';
import './timeline-demo.css';

type SubjectType = 'deal' | 'contact' | 'account';

interface SubjectOption {
  id: string;
  label: string;
  code?: string;
  unitId: string;
}

const TYPES: ReadonlyArray<{ value: SubjectType; label: string }> = [
  { value: 'deal', label: 'Deal' },
  { value: 'contact', label: 'Person' },
  { value: 'account', label: 'Institute' },
];

/**
 * Seeded deals, people and institutes to try the components on, found through the tasks of the
 * people in scope (the deals, contacts and accounts slices have their own lists).
 */
function useSeededSubjects() {
  const { scope, can, user } = useSession();
  const canListPeople = can('users.view');
  return useQuery({
    queryKey: ['dev', 'timeline', 'subjects', scope.id, canListPeople],
    queryFn: async () => {
      const people = canListPeople ? await api.page<Person>('/users', { unitId: scope.id, status: 'active', limit: 50 }) : null;
      const assignee = people ? people.data.map((person) => person.id).slice(0, 50) : [user.id];
      const tasks = await api.page<Task>('/tasks', { unitId: scope.id, assignee: assignee.join(','), status: 'open,done', sort: '-createdAt', limit: 100 });
      const found: Record<SubjectType, Map<string, SubjectOption>> = { deal: new Map(), contact: new Map(), account: new Map() };
      for (const task of tasks.data) {
        if (task.deal) found.deal.set(task.deal.id, { id: task.deal.id, label: task.deal.title, code: task.deal.ref, unitId: task.unit.id });
        if (task.contact) found.contact.set(task.contact.id, { id: task.contact.id, label: task.contact.displayName, unitId: task.unit.id });
        if (task.account) found.account.set(task.account.id, { id: task.account.id, label: task.account.name, unitId: task.unit.id });
      }
      return { deal: [...found.deal.values()], contact: [...found.contact.values()], account: [...found.account.values()] };
    },
    staleTime: 5 * 60_000,
  });
}

function subjectOf(type: SubjectType, id: string): TimelineSubject {
  if (type === 'deal') return { dealId: id };
  if (type === 'contact') return { contactId: id };
  return { accountId: id };
}

/** <Timeline /> and <TaskList /> on seeded records (development only). */
export function TimelineDemo() {
  const selectId = useId();
  const subjects = useSeededSubjects();
  const [type, setType] = useState<SubjectType>('deal');
  const [chosen, setChosen] = useState<Partial<Record<SubjectType, string>>>({});
  const options = useMemo(() => subjects.data?.[type] ?? [], [subjects.data, type]);
  const current = options.find((option) => option.id === chosen[type]) ?? options[0];

  return (
    <>
      <PageHeader title="Timeline and tasks" description="The deal, person and institute building blocks with seeded records. Development only." />
      <div className="content">
        <div className="timeline-demo">
          <div className="timeline-demo__picker card">
            <div className="timeline-demo__tabs" role="group" aria-label="Record type">
              {TYPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={type === option.value}
                  className={cx('timeline-demo__tab', type === option.value && 'is-active')}
                  onClick={() => setType(option.value)}
                >
                  {option.label}
                  {subjects.data ? <span className="timeline-demo__count">{subjects.data[option.value].length}</span> : null}
                </button>
              ))}
            </div>
            {options.length > 0 && current ? (
              <div className="timeline-demo__select">
                <label htmlFor={selectId} className="field__label">
                  Record
                </label>
                <select
                  id={selectId}
                  className="select"
                  value={current.id}
                  onChange={(event) => setChosen({ ...chosen, [type]: event.target.value })}
                >
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.code ? `${option.code} · ${option.label}` : option.label}
                    </option>
                  ))}
                </select>
                <span className="small muted">
                  id <Mono short>{current.id}</Mono>
                </span>
              </div>
            ) : null}
          </div>

          {subjects.isPending ? (
            <PageLoading />
          ) : subjects.isError ? (
            <ErrorAlert error={subjects.error} title="Seeded records didn't load" />
          ) : !current ? (
            <div className="card">
              <EmptyState icon="search" title="No records with tasks in this scope">
                Run the seed, or pick another company in the switcher.
              </EmptyState>
            </div>
          ) : (
            <div className="timeline-demo__grid" key={`${type}-${current.id}`}>
              <Timeline subject={subjectOf(type, current.id)} />
              <TaskList subject={subjectOf(type, current.id)} unitId={type === 'deal' ? current.unitId : undefined} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
