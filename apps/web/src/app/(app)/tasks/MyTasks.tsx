'use client';

import { useId, useRef, useState } from 'react';
import { ChipGroup } from '@/components/crm';
import { Guard } from '@/components/Guard';
import { useTaskUnits } from '@/components/tasks/TaskDialog';
import { TaskPanel } from '@/components/tasks/TaskPanel';
import { TaskRow } from '@/components/tasks/TaskRow';
import { useTaskToggle } from '@/components/tasks/useTaskToggle';
import { UnitSelect } from '@/components/UnitSelect';
import { Button, EmptyState, ErrorAlert, PageHeader, Spinner, cx } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { formatCount, timeZoneCity } from '@/lib/crm/format';
import type { Task, TaskRelatedType } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { quickDueAt, type QuickDue } from '@/lib/tasks/dates';
import { RELATED_TYPE_OPTIONS } from '@/lib/tasks/present';
import { useCreateTask, useTaskCounts, useTaskList, useTaskTimeZone, type TaskListParams } from '@/lib/tasks/queries';
import './tasks-page.css';

const DONE_WINDOW_DAYS = 7;

interface SectionDef {
  key: string;
  title: string;
  params: Pick<TaskListParams, 'status' | 'due' | 'sort' | 'completedAfter'>;
  count: number | undefined;
  tone?: 'danger';
  empty?: string;
}

/**
 * My tasks: what's assigned to me in the current scope, grouped by when it's due in my time
 * zone (Overdue, Today, Upcoming, No date) plus what I finished this week. Quick add on top,
 * filters by company and by what the task is about, edits in a side panel.
 */
export function MyTasks() {
  const { scope, workUnits } = useSession();
  const [companyId, setCompanyId] = useState('');
  const [related, setRelated] = useState<TaskRelatedType[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  // Fixed for the visit, so the "done recently" list keeps one cache key.
  const [doneSince] = useState(() => new Date(Date.now() - DONE_WINDOW_DAYS * 86_400_000).toISOString());
  const filters = { companyId: companyId || undefined, related: related.length > 0 ? related : undefined };
  const counts = useTaskCounts(scope.id, filters);
  const timeZone = useTaskTimeZone(scope.id);
  const toggle = useTaskToggle();
  const companies = workUnits.filter((unit) => unit.type === 'company' && unit.status === 'active' && unit.path.startsWith(scope.path));
  const filtered = companyId !== '' || related.length > 0;

  const sections: SectionDef[] = [
    { key: 'overdue', title: 'Overdue', params: { status: ['open'], due: 'overdue' }, count: counts.data?.overdue, tone: 'danger' },
    { key: 'today', title: 'Today', params: { status: ['open'], due: 'later_today' }, count: counts.data?.laterToday },
    { key: 'upcoming', title: 'Upcoming', params: { status: ['open'], due: 'upcoming' }, count: counts.data?.upcoming },
    { key: 'none', title: 'No date', params: { status: ['open'], due: 'none' }, count: counts.data?.noDueDate },
    {
      key: 'done',
      title: 'Done recently',
      params: { status: ['done'], completedAfter: doneSince, sort: '-completedAt' },
      count: undefined,
      empty: `Nothing completed in the last ${DONE_WINDOW_DAYS} days.`,
    },
  ];
  const allClear = counts.isSuccess && counts.data.open === 0;

  return (
    <>
      <PageHeader
        title="My tasks"
        description={
          <>
            Calls, follow-ups and to-dos assigned to you. Due times are in <strong>{timeZoneCity(timeZone)}</strong> time.
          </>
        }
      />
      <div className="content">
        <Guard anyOf={['tasks.view']} anywhere>
          <div className="tasks-page">
            <QuickAdd preferredUnitId={companyId || undefined} timeZone={timeZone} />

            <div className="tasks-page__toolbar">
              {companies.length > 1 ? (
                <CompanyFilter companies={companies} value={companyId} onChange={setCompanyId} />
              ) : null}
              <ChipGroup label="About" options={RELATED_TYPE_OPTIONS} selected={related} onChange={(next) => setRelated(next as TaskRelatedType[])} />
              {filtered ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCompanyId('');
                    setRelated([]);
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>

            {counts.isError ? <ErrorAlert error={counts.error} title="Task counts didn't load" /> : null}

            <nav className="tasks-summary" aria-label="Jump to">
              {sections.slice(0, 4).map((section) => (
                <a key={section.key} href={`#tasks-${section.key}`} className={cx('tasks-summary__item', section.tone === 'danger' && Boolean(section.count) && 'is-danger')}>
                  <span className="tasks-summary__count">{section.count === undefined ? '–' : formatCount(section.count)}</span>
                  <span className="tasks-summary__label">{section.title}</span>
                </a>
              ))}
            </nav>

            {allClear ? (
              <div className="card">
                <EmptyState icon="check" title={filtered ? 'No open tasks match these filters' : "You're all caught up"}>
                  {filtered ? 'Clear the filters to see everything assigned to you.' : 'Nothing open is assigned to you. Add a task above for your next step.'}
                </EmptyState>
              </div>
            ) : null}

            {sections.map((section) =>
              section.count === 0 ? null : (
                <TaskSection
                  key={section.key}
                  section={section}
                  params={{ unitId: scope.id, ...filters, ...section.params, limit: 25 }}
                  timeZone={timeZone}
                  toggle={toggle}
                  onOpen={setSelected}
                />
              ),
            )}
          </div>
          {toggle.bar}
          <TaskPanel task={selected} onClose={() => setSelected(null)} onChanged={setSelected} timeZone={timeZone} />
        </Guard>
      </div>
    </>
  );
}

function TaskSection({
  section,
  params,
  timeZone,
  toggle,
  onOpen,
}: {
  section: SectionDef;
  params: TaskListParams;
  timeZone: string;
  toggle: ReturnType<typeof useTaskToggle>;
  onOpen: (task: Task) => void;
}) {
  const headingId = useId();
  const list = useTaskList(params);
  const tasks = (list.data?.pages ?? []).flatMap((page) => page.data);
  const count = section.count ?? (list.isSuccess && !list.hasNextPage ? tasks.length : undefined);
  if (list.isSuccess && tasks.length === 0 && !section.empty) return null;

  return (
    <section id={`tasks-${section.key}`} className={cx('card card--flush tasks-section', section.tone && `tasks-section--${section.tone}`)} aria-labelledby={headingId}>
      <header className="tasks-section__head">
        <h2 id={headingId} className="tasks-section__title">
          {section.title}
          {count !== undefined ? <span className="tasks-section__count">{formatCount(count)}</span> : null}
        </h2>
        {list.isFetching && !list.isPending && !list.isFetchingNextPage ? <Spinner label="Refreshing" /> : null}
      </header>
      {list.isPending ? (
        <div className="tasks-list__state">
          <Spinner label={`Loading ${section.title.toLowerCase()} tasks`} />
        </div>
      ) : !list.data ? (
        <div className="tasks-list__state">
          <ErrorAlert error={list.error} title="These tasks didn't load" />
          <Button size="sm" icon="refresh" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : tasks.length === 0 ? (
        <p className="tasks-list__empty">{section.empty}</p>
      ) : (
        <ul className="tasks-rows">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              timeZone={timeZone}
              done={toggle.isDone(task)}
              pending={toggle.isPending(task)}
              onToggle={toggle.toggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <div className="load-more">
          <Button size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function CompanyFilter({
  companies,
  value,
  onChange,
}: {
  companies: ReadonlyArray<{ id: string; name: string }>;
  value: string;
  onChange: (companyId: string) => void;
}) {
  const id = useId();
  return (
    <div className="tasks-page__company">
      <label className="visually-hidden" htmlFor={id}>
        Company
      </label>
      <select id={id} className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All companies</option>
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name}
          </option>
        ))}
      </select>
    </div>
  );
}

const QUICK_DUE_OPTIONS: ReadonlyArray<{ value: QuickDue; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'nextWeek', label: 'Next week' },
  { value: 'none', label: 'No date' },
];

/** One line to add a task for yourself: title, when, and (when you work in several places) where. */
function QuickAdd({ preferredUnitId, timeZone }: { preferredUnitId?: string; timeZone: string }) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { units, defaultUnitId } = useTaskUnits(preferredUnitId);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState<QuickDue>('today');
  const [unitId, setUnitId] = useState('');
  const create = useCreateTask();
  const chosenUnit = units.some((unit) => unit.id === unitId) ? unitId : defaultUnitId;
  const errors = fieldErrorsOf(create.error);

  if (units.length === 0) return null;

  return (
    <form
      className="card tasks-quick"
      aria-label="Add a task"
      onSubmit={(event) => {
        event.preventDefault();
        const text = title.trim();
        if (!text || create.isPending) return;
        create.mutate(
          { unitId: chosenUnit, title: text, dueAt: quickDueAt(due, timeZone) },
          {
            onSuccess: () => {
              setTitle('');
              inputRef.current?.focus();
            },
          },
        );
      }}
    >
      <div className="tasks-quick__row">
        <label className="visually-hidden" htmlFor={`${id}-title`}>
          New task
        </label>
        <input
          ref={inputRef}
          id={`${id}-title`}
          className="input tasks-quick__title"
          value={title}
          maxLength={200}
          placeholder="Add a task, e.g. Call back Mrs Sharma about the demo"
          aria-invalid={errors.title ? true : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="visually-hidden" htmlFor={`${id}-due`}>
          Due
        </label>
        <select id={`${id}-due`} className="select tasks-quick__due" value={due} onChange={(event) => setDue(event.target.value as QuickDue)}>
          {QUICK_DUE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {units.length > 1 ? (
          <>
            <label className="visually-hidden" htmlFor={`${id}-unit`}>
              Belongs to
            </label>
            <UnitSelect control={{ id: `${id}-unit` }} className="select tasks-quick__unit" units={units} value={chosenUnit} onChange={setUnitId} />
          </>
        ) : null}
        <Button type="submit" variant="primary" icon="plus" loading={create.isPending} disabled={!title.trim()}>
          Add
        </Button>
      </div>
      {errors.title || errors.unitId ? <p className="field__error">{errors.title ?? errors.unitId}</p> : null}
      <ErrorAlert error={formErrorOf(create.error, ['title', 'unitId'])} />
    </form>
  );
}

