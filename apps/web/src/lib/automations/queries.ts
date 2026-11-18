'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { IconName } from '@/components/icons';
import type { PillTone } from '@/components/crm';
import type {
  ApprovalStatus,
  AutomationApproval,
  AutomationCatalog,
  AutomationFlow,
  AutomationFlowVersion,
  AutomationRun,
  AutomationRunDetail,
  AutomationTemplate,
  FlowStatus,
  RunStatus,
  StepType,
} from './types';

/** Query keys of the automations area; `all` prefixes every other key. */
export const automationKeys = {
  all: ['automations'] as const,
  catalog: ['automations', 'catalog'] as const,
  templates: ['automations', 'templates'] as const,
  flows: (unitId: string, filters: Record<string, unknown> = {}) => ['automations', 'flows', unitId, filters] as const,
  flow: (id: string) => ['automations', 'flow', id] as const,
  versions: (id: string) => ['automations', 'flow', id, 'versions'] as const,
  runs: (unitId: string, filters: Record<string, unknown>) => ['automations', 'runs', unitId, filters] as const,
  run: (id: string) => ['automations', 'run', id] as const,
  approvals: (unitId: string, filters: Record<string, unknown>) => ['automations', 'approvals', unitId, filters] as const,
};

export function useAutomationCatalog(enabled = true) {
  return useQuery({ queryKey: automationKeys.catalog, queryFn: () => api.get<AutomationCatalog>('/automations/catalog'), staleTime: 5 * 60_000, enabled });
}

export function useFlowTemplates(enabled = true) {
  return useQuery({ queryKey: automationKeys.templates, queryFn: () => api.get<AutomationTemplate[]>('/automations/templates'), staleTime: 5 * 60_000, enabled });
}

export function useFlows(unitId: string, filters: { status?: FlowStatus; kind?: string; q?: string }, enabled = true) {
  return useQuery({
    queryKey: automationKeys.flows(unitId, filters),
    queryFn: () => api.get<AutomationFlow[]>('/automations/flows', { unitId, ...filters }),
    enabled,
  });
}

export function useFlow(id: string) {
  return useQuery({ queryKey: automationKeys.flow(id), queryFn: () => api.get<AutomationFlow>(`/automations/flows/${id}`) });
}

export function useFlowVersions(id: string, enabled: boolean) {
  return useQuery({ queryKey: automationKeys.versions(id), queryFn: () => api.get<AutomationFlowVersion[]>(`/automations/flows/${id}/versions`), enabled });
}

export function useRuns(unitId: string, filters: { flowId?: string; status?: RunStatus; dealId?: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: automationKeys.runs(unitId, filters),
    queryFn: ({ pageParam }) => api.page<AutomationRun>('/automations/runs', { unitId, ...filters, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useRun(id: string | null) {
  return useQuery({
    queryKey: automationKeys.run(id ?? '-'),
    queryFn: () => api.get<AutomationRunDetail>(`/automations/runs/${id}`),
    enabled: Boolean(id),
  });
}

export function useApprovals(unitId: string, filters: { status: ApprovalStatus | 'decided' | 'all'; flowId?: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: automationKeys.approvals(unitId, filters),
    queryFn: ({ pageParam }) => api.page<AutomationApproval>('/automations/approvals', { unitId, ...filters, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

// ---------- Labels ----------

export const FLOW_STATUS: Record<FlowStatus, { label: string; tone: PillTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'On', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: PillTone }> = {
  running: { label: 'Running', tone: 'accent' },
  waiting: { label: 'Waiting', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: PillTone }> = {
  pending: { label: 'Waiting for you', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Withdrawn', tone: 'neutral' },
};

export const STEP_TYPES: Record<StepType, { label: string; icon: IconName; hint: string }> = {
  action: { label: 'Action', icon: 'bolt', hint: 'Send a template, create a task, move a stage, assign, update a field or call a webhook' },
  ai_step: { label: 'AI step', icon: 'sparkle', hint: 'Run an AI agent: classify, extract, draft a follow-up or a payment reminder' },
  condition: { label: 'Condition', icon: 'filter', hint: 'Go one way or the other depending on an expression' },
  branch: { label: 'Branch', icon: 'list', hint: 'Pick the first matching case' },
  wait: { label: 'Wait', icon: 'clock', hint: 'Pause for a time, until a time, or until an event' },
  approval: { label: 'Approval', icon: 'check', hint: 'Ask a person to approve, edit or reject before going on' },
  end: { label: 'End', icon: 'flag', hint: 'Finish the run here' },
};

export const WAIT_KIND: Record<string, string> = {
  timer: 'Waiting until',
  event: 'Waiting for',
  effect: 'Waiting for a result',
  approval: 'Waiting for approval',
};

/** Readable names for trace outcomes. */
export const OUTCOMES: Record<string, string> = {
  then: 'Condition true',
  else: 'Condition false',
  case: 'Matched a case',
  otherwise: 'No case matched',
  emitted: 'Done',
  waiting: 'Waiting',
  resumed: 'Resumed',
  event: 'Event arrived',
  timeout: 'Timed out',
  result: 'Result received',
  approved: 'Approved',
  rejected: 'Rejected',
  passed: 'Passed',
  error: 'Error',
  completed: 'Run completed',
  cancelled: 'Run cancelled',
  failed: 'Run failed',
  started: 'Run started',
};

export function outcomeLabel(outcome: string): string {
  return OUTCOMES[outcome] ?? outcome.replace(/_/g, ' ');
}
