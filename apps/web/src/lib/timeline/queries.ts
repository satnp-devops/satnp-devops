'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type { TimelineCreateInput, TimelineEntry, TimelineKind, TimelineListFilters, TimelineSubject } from '@/lib/crm/types';

// Timeline queries and mutations (GET/POST/PATCH/DELETE /timeline). Keys live under
// crmKeys.timeline.subject(type, id), so a deal move elsewhere refreshes this timeline too.

export type SubjectType = 'deal' | 'contact' | 'account';

export interface SubjectRef {
  type: SubjectType;
  id: string;
  /** The query parameter / body field: dealId, contactId or accountId. */
  param: 'dealId' | 'contactId' | 'accountId';
}

export function subjectRef(subject: TimelineSubject): SubjectRef {
  if ('dealId' in subject) return { type: 'deal', id: subject.dealId, param: 'dealId' };
  if ('contactId' in subject) return { type: 'contact', id: subject.contactId, param: 'contactId' };
  return { type: 'account', id: subject.accountId, param: 'accountId' };
}

const csv = (values: readonly string[] | undefined) => (values && values.length > 0 ? values.join(',') : undefined);

export function useTimelineKinds() {
  return useQuery({
    queryKey: crmKeys.timeline.kinds,
    queryFn: () => api.get<TimelineKind[]>('/timeline/kinds'),
    staleTime: 60 * 60_000,
  });
}

/** One subject's entries, newest first, a page at a time. */
export function useTimelineEntries(subject: SubjectRef, filters: TimelineListFilters) {
  return useInfiniteQuery({
    queryKey: [...crmKeys.timeline.subject(subject.type, subject.id), 'list', filters],
    queryFn: ({ pageParam }) =>
      api.page<TimelineEntry>('/timeline', {
        [subject.param]: subject.id,
        kind: csv(filters.kind),
        channel: csv(filters.channel),
        includeArchive: filters.includeArchive ? 'true' : undefined,
        limit: filters.limit ?? 30,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Pinned entries (at most 20, no paging). */
export function usePinnedEntries(subject: SubjectRef) {
  return useQuery({
    queryKey: [...crmKeys.timeline.subject(subject.type, subject.id), 'pinned'],
    queryFn: () => api.page<TimelineEntry>('/timeline', { [subject.param]: subject.id, pinned: 'true' }),
    select: (page) => page.data,
  });
}

/**
 * Writes refresh every timeline (an entry on a deal also shows on its person and institute) and,
 * for deals, the deal lists (last activity and the first reply move).
 */
function useRefresh() {
  const queryClient = useQueryClient();
  return (entry?: Pick<TimelineEntry, 'dealId' | 'kind'>) => {
    void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.all });
    if (entry?.dealId) {
      void queryClient.invalidateQueries({ queryKey: crmKeys.deals.detail(entry.dealId) });
      if (entry.kind !== 'note') void queryClient.invalidateQueries({ queryKey: crmKeys.deals.all });
    }
  };
}

export function useAddEntry() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ input, pin }: { input: TimelineCreateInput; pin: boolean }) => {
      const entry = await api.post<TimelineEntry>('/timeline', input);
      return pin && entry.canPin ? api.post<TimelineEntry>(`/timeline/${entry.id}/pin`) : entry;
    },
    onSuccess: (entry) => refresh(entry),
  });
}

export interface EntryEdit {
  title?: string | null;
  body?: string;
  occurredAt?: string;
}

export function useEditEntry() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: EntryEdit }) => api.patch<TimelineEntry>(`/timeline/${id}`, changes),
    onSuccess: (entry) => refresh(entry),
  });
}

export function usePinEntry() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api.post<TimelineEntry>(`/timeline/${id}/${pinned ? 'pin' : 'unpin'}`),
    onSuccess: () => refresh(),
  });
}

export function useDeleteEntry() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (entry: TimelineEntry) => api.delete(`/timeline/${entry.id}`),
    onSuccess: (_result, entry) => refresh(entry),
  });
}
