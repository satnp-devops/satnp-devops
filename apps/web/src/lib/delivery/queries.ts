'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Query } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type {
  Batch,
  BatchInput,
  ChecklistDetail,
  ChecklistSummary,
  Enrollment,
  EnrollmentCounts,
  EnrollmentDetail,
  OnboardingTemplate,
  ProjectDetail,
  ProjectSummary,
  RefundPreview,
  Renewal,
  RenewalSummary,
  Programme,
  WaitlistEntry,
} from './types';

// TanStack Query hooks for the delivery API. Every `all` key prefixes the keys below it, so a
// mutation refreshes exactly the area it changed (and the CRM timeline of the deal it touched).

type Params = Record<string, unknown>;

export const deliveryKeys = {
  all: ['delivery'] as const,
  batches: {
    all: ['delivery', 'batches'] as const,
    list: (unitId: string, filters: Params) => ['delivery', 'batches', 'list', unitId, filters] as const,
    detail: (id: string) => ['delivery', 'batches', 'detail', id] as const,
    waitlist: (id: string) => ['delivery', 'batches', 'waitlist', id] as const,
  },
  enrollments: {
    all: ['delivery', 'enrollments'] as const,
    list: (unitId: string, filters: Params) => ['delivery', 'enrollments', 'list', unitId, filters] as const,
    counts: (unitId: string) => ['delivery', 'enrollments', 'counts', unitId] as const,
    detail: (id: string) => ['delivery', 'enrollments', 'detail', id] as const,
  },
  checklists: {
    all: ['delivery', 'checklists'] as const,
    list: (unitId: string, filters: Params) => ['delivery', 'checklists', 'list', unitId, filters] as const,
    detail: (id: string) => ['delivery', 'checklists', 'detail', id] as const,
  },
  projects: {
    all: ['delivery', 'projects'] as const,
    list: (unitId: string, filters: Params) => ['delivery', 'projects', 'list', unitId, filters] as const,
    detail: (id: string) => ['delivery', 'projects', 'detail', id] as const,
  },
  renewals: {
    all: ['delivery', 'renewals'] as const,
    list: (unitId: string, filters: Params) => ['delivery', 'renewals', 'list', unitId, filters] as const,
    summary: (unitId: string) => ['delivery', 'renewals', 'summary', unitId] as const,
  },
  templates: (scope: string, kind?: string) => ['delivery', 'templates', scope, kind ?? 'all'] as const,
};

function useInfinitePage<T>(key: readonly unknown[], path: string, query: Query, enabled = true) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.page<T>(path, { ...query, cursor: pageParam, limit: query.limit ?? 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

// ---------- Batches ----------

export interface BatchFilters {
  productId?: string;
  status?: string;
  joinable?: boolean;
  q?: string;
}

export const useBatches = (unitId: string, filters: BatchFilters = {}, enabled = true) =>
  useInfinitePage<Batch>(deliveryKeys.batches.list(unitId, { ...filters }), '/batches', { unitId, ...filters }, enabled);

export const useBatch = (id: string | null) =>
  useQuery({ queryKey: deliveryKeys.batches.detail(id ?? 'none'), queryFn: () => api.get<Batch>(`/batches/${id}`), enabled: id !== null });

export const useWaitlist = (id: string | null) =>
  useQuery({ queryKey: deliveryKeys.batches.waitlist(id ?? 'none'), queryFn: () => api.get<WaitlistEntry[]>(`/batches/${id}/waitlist`), enabled: id !== null });

export function useSaveBatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: BatchInput }) =>
      id ? api.patch<Batch>(`/batches/${id}`, input) : api.post<Batch>('/batches', input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: deliveryKeys.batches.all });
      void client.invalidateQueries({ queryKey: deliveryKeys.enrollments.all });
    },
  });
}

// ---------- Enrollments ----------

export interface EnrollmentFilters {
  status?: string;
  seatStatus?: string;
  batchId?: string;
  productId?: string;
  dealId?: string;
  contactId?: string;
  owner?: string;
  q?: string;
}

export const useEnrollments = (unitId: string, filters: EnrollmentFilters = {}, enabled = true) =>
  useInfinitePage<Enrollment>(deliveryKeys.enrollments.list(unitId, { ...filters }), '/enrollments', { unitId, ...filters }, enabled);

export const useEnrollmentCounts = (unitId: string, enabled = true) =>
  useQuery({ queryKey: deliveryKeys.enrollments.counts(unitId), queryFn: () => api.get<EnrollmentCounts>('/enrollments/counts', { unitId }), enabled });

export const useEnrollment = (id: string | null) =>
  useQuery({ queryKey: deliveryKeys.enrollments.detail(id ?? 'none'), queryFn: () => api.get<EnrollmentDetail>(`/enrollments/${id}`), enabled: id !== null });

/** Refresh what an enrollment change touches: enrollments, batches, checklists and the deal's timeline. */
function useEnrollmentRefresh() {
  const client = useQueryClient();
  return (enrollment: EnrollmentDetail) => {
    client.setQueryData(deliveryKeys.enrollments.detail(enrollment.id), enrollment);
    void client.invalidateQueries({ queryKey: deliveryKeys.enrollments.all });
    void client.invalidateQueries({ queryKey: deliveryKeys.batches.all });
    void client.invalidateQueries({ queryKey: deliveryKeys.checklists.all });
    if (enrollment.deal) void client.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', enrollment.deal.id) });
    if (enrollment.student) void client.invalidateQueries({ queryKey: crmKeys.timeline.subject('contact', enrollment.student.id) });
  };
}

export type EnrollmentAction =
  | { kind: 'batch'; batchId: string; joinWaitlist: boolean }
  | { kind: 'pause'; resumeOn: string | null; reason: string | null }
  | { kind: 'resume' }
  | { kind: 'complete' }
  | { kind: 'withdraw'; channel: string; receivedAt?: string; reason?: string | null; effectiveOn?: string; classesAttended?: number | null }
  | { kind: 'update'; ownerUserId?: string | null; accessStatus?: string };

export function useEnrollmentAction(id: string) {
  const refresh = useEnrollmentRefresh();
  return useMutation({
    mutationFn: (action: EnrollmentAction) => {
      const { kind, ...body } = action;
      if (kind === 'update') return api.patch<EnrollmentDetail>(`/enrollments/${id}`, body);
      if (kind === 'resume' || kind === 'complete') return api.post<EnrollmentDetail>(`/enrollments/${id}/${kind}`, {});
      return api.post<EnrollmentDetail>(`/enrollments/${id}/${kind}`, body);
    },
    onSuccess: refresh,
  });
}

export function useCreateEnrollment() {
  const refresh = useEnrollmentRefresh();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<EnrollmentDetail>('/enrollments', input),
    onSuccess: refresh,
  });
}

export const useRefundPreview = () =>
  useMutation({
    mutationFn: ({ id, ...body }: { id: string; receivedAt?: string; effectiveOn?: string; classesAttended?: number | null }) =>
      api.post<RefundPreview>(`/enrollments/${id}/withdraw/preview`, body),
  });

// ---------- Onboarding ----------

export interface ChecklistFilters {
  status?: string;
  owner?: string;
  overdue?: boolean;
}

export const useChecklists = (unitId: string, filters: ChecklistFilters = {}, enabled = true) =>
  useInfinitePage<ChecklistSummary>(deliveryKeys.checklists.list(unitId, { ...filters }), '/onboarding/checklists', { unitId, ...filters }, enabled);

export const useChecklist = (id: string | null) =>
  useQuery({ queryKey: deliveryKeys.checklists.detail(id ?? 'none'), queryFn: () => api.get<ChecklistDetail>(`/onboarding/checklists/${id}`), enabled: id !== null });

export function useUpdateChecklistItem(checklistId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, ...body }: { itemId: string; status?: string; ownerUserId?: string | null; dueOn?: string | null }) =>
      api.patch<ChecklistDetail>(`/onboarding/checklists/${checklistId}/items/${itemId}`, body),
    onSuccess: (checklist) => {
      client.setQueryData(deliveryKeys.checklists.detail(checklist.id), checklist);
      void client.invalidateQueries({ queryKey: deliveryKeys.checklists.all });
      void client.invalidateQueries({ queryKey: deliveryKeys.enrollments.all });
    },
  });
}

export interface ProjectFilters {
  status?: string;
  owner?: string;
  accountId?: string;
  dealId?: string;
}

export const useProjects = (unitId: string, filters: ProjectFilters = {}, enabled = true) =>
  useInfinitePage<ProjectSummary>(deliveryKeys.projects.list(unitId, { ...filters }), '/implementation-projects', { unitId, ...filters }, enabled);

export const useProject = (id: string | null) =>
  useQuery({ queryKey: deliveryKeys.projects.detail(id ?? 'none'), queryFn: () => api.get<ProjectDetail>(`/implementation-projects/${id}`), enabled: id !== null });

export type ProjectAction =
  | { kind: 'update'; body: Record<string, unknown> }
  | { kind: 'task'; taskId: string; body: Record<string, unknown> }
  | { kind: 'addTask'; body: Record<string, unknown> }
  | { kind: 'phase'; phaseId: string; body: Record<string, unknown> };

export function useProjectAction(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ProjectAction) => {
      if (action.kind === 'update') return api.patch<ProjectDetail>(`/implementation-projects/${id}`, action.body);
      if (action.kind === 'task') return api.patch<ProjectDetail>(`/implementation-projects/${id}/tasks/${action.taskId}`, action.body);
      if (action.kind === 'phase') return api.patch<ProjectDetail>(`/implementation-projects/${id}/phases/${action.phaseId}`, action.body);
      return api.post<ProjectDetail>(`/implementation-projects/${id}/tasks`, action.body);
    },
    onSuccess: (project) => {
      client.setQueryData(deliveryKeys.projects.detail(project.id), project);
      void client.invalidateQueries({ queryKey: deliveryKeys.projects.all });
      if (project.deal) void client.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', project.deal.id) });
      if (project.account) void client.invalidateQueries({ queryKey: crmKeys.timeline.subject('account', project.account.id) });
    },
  });
}

export interface RenewalFilters {
  risk?: string;
  dueWithinDays?: number;
  owner?: string;
  upsell?: boolean;
  sort?: 'due' | 'risk';
}

export const useRenewals = (unitId: string, filters: RenewalFilters = {}, enabled = true) =>
  useInfinitePage<Renewal>(deliveryKeys.renewals.list(unitId, { ...filters }), '/renewals', { unitId, ...filters }, enabled);

export const useRenewalSummary = (unitId: string, enabled = true) =>
  useQuery({ queryKey: deliveryKeys.renewals.summary(unitId), queryFn: () => api.get<RenewalSummary>('/renewals/summary', { unitId }), enabled });

export const useTemplates = (scope: { unitId?: string; companyId?: string }, kind?: 'b2c' | 'b2b') =>
  useQuery({
    queryKey: deliveryKeys.templates(scope.companyId ?? scope.unitId ?? 'none', kind),
    queryFn: () => api.get<OnboardingTemplate[]>('/onboarding/templates', { ...scope, kind }),
    enabled: Boolean(scope.companyId ?? scope.unitId),
  });

export function useSaveTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: Record<string, unknown> }) =>
      id ? api.put<OnboardingTemplate>(`/onboarding/templates/${id}`, input) : api.post<OnboardingTemplate>('/onboarding/templates', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['delivery', 'templates'] }),
  });
}

export const useProgrammes = (unitId: string, enabled = true) =>
  useQuery({ queryKey: ['delivery', 'programmes', unitId], queryFn: () => api.get<Programme[]>('/batches/programmes', { unitId }), enabled, staleTime: 300_000 });
