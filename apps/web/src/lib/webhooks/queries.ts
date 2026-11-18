'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BackgroundJob,
  BackgroundJobDetail,
  JobFilters,
  ReplayResult,
  WebhookEvent,
  WebhookEventDetail,
  WebhookFilters,
  WebhookSummary,
} from './types';

/** Cache keys of the webhooks and jobs area; invalidate `webhookKeys.all` after a replay or retry. */
export const webhookKeys = {
  all: ['webhooks'] as const,
  events: (unitId: string, filters: WebhookFilters) => ['webhooks', 'events', unitId, filters] as const,
  event: (id: string) => ['webhooks', 'event', id] as const,
  summary: (unitId: string) => ['webhooks', 'summary', unitId] as const,
  jobs: (unitId: string, filters: JobFilters) => ['webhooks', 'jobs', unitId, filters] as const,
  job: (id: string) => ['webhooks', 'job', id] as const,
};

const PAGE = 25;

/** Lists refresh on their own while something is still moving (queued, retrying, running). */
const LIVE_MS = 5000;

export function useWebhookEvents(unitId: string, filters: WebhookFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: webhookKeys.events(unitId, filters),
    queryFn: ({ pageParam }) =>
      api.page<WebhookEvent>('/webhook-events', {
        unitId,
        provider: filters.provider || undefined,
        status: filters.status || undefined,
        connectionId: filters.connectionId || undefined,
        cursor: pageParam,
        limit: PAGE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.data.some((e) => e.status === 'queued' || e.status === 'processing' || e.status === 'retrying'))
        ? LIVE_MS
        : false,
    enabled,
  });
}

export function useWebhookEvent(id: string | null) {
  return useQuery({
    queryKey: webhookKeys.event(id ?? ''),
    queryFn: () => api.get<WebhookEventDetail>(`/webhook-events/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

export function useWebhookSummary(unitId: string, enabled = true) {
  return useQuery({
    queryKey: webhookKeys.summary(unitId),
    queryFn: () => api.get<WebhookSummary>('/webhook-events/summary', { unitId }),
    enabled,
  });
}

export function useReplayEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<WebhookEventDetail>(`/webhook-events/${id}/replay`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: webhookKeys.all }),
  });
}

export function useReplayAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { unitId: string; provider?: string; connectionId?: string }) => api.post<ReplayResult>('/webhook-events/replay', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: webhookKeys.all }),
  });
}

export function useJobs(unitId: string, filters: JobFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: webhookKeys.jobs(unitId, filters),
    queryFn: ({ pageParam }) =>
      api.page<BackgroundJob>('/jobs', {
        unitId,
        status: filters.status || undefined,
        mine: filters.mine ? 'true' : undefined,
        cursor: pageParam,
        limit: PAGE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.data.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'retrying'))
        ? LIVE_MS
        : false,
    enabled,
  });
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: webhookKeys.job(id ?? ''),
    queryFn: () => api.get<BackgroundJobDetail>(`/jobs/${id ?? ''}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' || status === 'retrying' ? 2000 : false;
    },
  });
}

export function useJobAction(action: 'retry' | 'cancel') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<BackgroundJobDetail>(`/jobs/${id}/${action}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: webhookKeys.all }),
  });
}
