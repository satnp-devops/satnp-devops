'use client';

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { viewerTimeZone } from '@/lib/crm/format';
import { useSession } from '@/lib/session';
import type { PersonOption, Task, TaskCounts, TaskInput, TaskListQuery, TaskRelatedType } from '@/lib/crm/types';

// Tasks queries and mutations (GET/POST/PATCH /tasks). Every key sits under crmKeys.tasks.all.

const csv = (values: readonly string[] | undefined) => (values && values.length > 0 ? values.join(',') : undefined);

export type TaskListParams = Omit<TaskListQuery, 'cursor'>;

/** A task list, a page at a time (keyset cursor). */
export function useTaskList(params: TaskListParams, { enabled = true }: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: crmKeys.tasks.list(params),
    queryFn: ({ pageParam }) =>
      api.page<Task>('/tasks', {
        unitId: params.unitId,
        assignee: csv(params.assignee),
        status: csv(params.status),
        due: params.due,
        dealId: params.dealId,
        contactId: params.contactId,
        accountId: params.accountId,
        priority: csv(params.priority),
        q: params.q,
        tz: params.tz,
        companyId: params.companyId,
        related: csv(params.related),
        completedAfter: params.completedAfter,
        sort: params.sort,
        limit: params.limit,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export interface TaskCountFilters {
  companyId?: string;
  related?: TaskRelatedType[];
}

/** Open task counts by due group, in the viewer's time zone (which the server also returns). */
export function useTaskCounts(unitId: string, filters: TaskCountFilters = {}, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...crmKeys.tasks.counts(unitId, 'me'), filters],
    queryFn: () => api.get<TaskCounts>('/tasks/counts', { unitId, companyId: filters.companyId, related: csv(filters.related) }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * The zone due dates are grouped and entered in: the user's own, else the company's
 * locale.timeZone (which GET /tasks/counts reports), else the browser's while that loads.
 */
export function useTaskTimeZone(unitId: string): string {
  const { user } = useSession();
  const counts = useTaskCounts(unitId, {}, { enabled: !user.timeZone });
  return user.timeZone ?? counts.data?.timeZone ?? viewerTimeZone();
}

/** People who can be given a task at a unit (GET /crm/people, permission tasks.view). */
export function useAssignees(unitId: string | null) {
  return useQuery({
    queryKey: crmKeys.people(unitId ?? '', 'tasks.view'),
    queryFn: () => api.get<PersonOption[]>('/crm/people', { unitId: unitId ?? '', permission: 'tasks.view' }),
    enabled: Boolean(unitId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Task writes change task lists and add task entries to timelines. */
function useRefresh() {
  const queryClient = useQueryClient();
  return (task: Task) => {
    void queryClient.invalidateQueries({ queryKey: crmKeys.tasks.all });
    if (task.deal || task.contact || task.account) void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.all });
  };
}

export function useCreateTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: TaskInput) => api.post<Task>('/tasks', input),
    onSuccess: refresh,
  });
}

export type TaskChanges = Partial<Omit<TaskInput, 'unitId' | 'dealId' | 'contactId' | 'accountId'>>;

export function useUpdateTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: TaskChanges }) => api.patch<Task>(`/tasks/${id}`, changes),
    onSuccess: refresh,
  });
}

export type TaskTransition = 'complete' | 'reopen' | 'cancel';

export function useTaskTransition() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, transition }: { id: string; transition: TaskTransition }) => api.post<Task>(`/tasks/${id}/${transition}`),
    onSuccess: refresh,
  });
}
