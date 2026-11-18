'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import type { OrgUnit } from '@/lib/types';
import type { AssignmentPool, ChannelIdentity, ImportField, ImportJob, ImportRow, ImportRowStatus, IntakeForm, PartnerLink, ReviewItem, ReviewKind } from './types';

// TanStack Query keys and hooks of the intake screens. Mutations invalidate exactly these keys
// (and crmKeys.deals.all when they create or reopen leads).

export const intakeKeys = {
  all: ['intake'] as const,
  forms: (unitId: string) => ['intake', 'forms', unitId] as const,
  identities: (unitId: string) => ['intake', 'identities', unitId] as const,
  pools: (unitId: string) => ['intake', 'pools', unitId] as const,
  partnerLinks: (unitId: string) => ['intake', 'partner-links', unitId] as const,
  review: (unitId: string, kind: ReviewKind, status: string) => ['intake', 'review', unitId, kind, status] as const,
  reviewAll: ['intake', 'review'] as const,
  reviewCounts: (unitId: string) => ['intake', 'review', 'counts', unitId] as const,
  imports: (unitId: string) => ['intake', 'imports', unitId] as const,
  importJob: (id: string) => ['intake', 'import', id] as const,
  importRows: (id: string, status: string) => ['intake', 'import', id, 'rows', status] as const,
  importFields: ['intake', 'import-fields'] as const,
};

export function useIntakeForms(unitId: string, enabled = true) {
  return useQuery({ queryKey: intakeKeys.forms(unitId), queryFn: () => api.get<IntakeForm[]>('/intake/forms', { unitId }), enabled });
}

export function useIdentities(unitId: string, enabled = true) {
  return useQuery({ queryKey: intakeKeys.identities(unitId), queryFn: () => api.get<ChannelIdentity[]>('/intake/identities', { unitId }), enabled });
}

export function usePools(unitId: string, enabled = true) {
  return useQuery({ queryKey: intakeKeys.pools(unitId), queryFn: () => api.get<AssignmentPool[]>('/intake/pools', { unitId }), enabled });
}

export function usePartnerLinks(unitId: string, enabled = true) {
  return useQuery({ queryKey: intakeKeys.partnerLinks(unitId), queryFn: () => api.get<PartnerLink[]>('/intake/partner-links', { unitId }), enabled });
}

export function useReviewQueue(unitId: string, kind: ReviewKind, status: 'open' | 'resolved') {
  return useInfiniteQuery({
    queryKey: intakeKeys.review(unitId, kind, status),
    queryFn: ({ pageParam }) => api.page<ReviewItem>('/intake/review', { unitId, kind, status, cursor: pageParam, limit: 20 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useReviewCounts(unitId: string, enabled = true) {
  return useQuery({ queryKey: intakeKeys.reviewCounts(unitId), queryFn: () => api.get<Record<ReviewKind, number>>('/intake/review/counts', { unitId }), enabled });
}

export function useImports(unitId: string, enabled = true) {
  return useQuery({ queryKey: intakeKeys.imports(unitId), queryFn: () => api.page<ImportJob>('/intake/imports', { unitId, limit: 10 }), enabled });
}

export function useImportJob(id: string | null) {
  return useQuery({
    queryKey: intakeKeys.importJob(id ?? ''),
    queryFn: () => api.get<ImportJob>(`/intake/imports/${id}`),
    enabled: Boolean(id),
    // Follow a running import until it finishes.
    refetchInterval: (query) => (query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2000 : false),
  });
}

export function useImportRows(id: string | null, status: ImportRowStatus | '', enabled = true) {
  return useInfiniteQuery({
    queryKey: intakeKeys.importRows(id ?? '', status),
    queryFn: ({ pageParam }) => api.page<ImportRow>(`/intake/imports/${id}/rows`, { status, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(id) && enabled,
  });
}

export function useImportFields() {
  return useQuery({ queryKey: intakeKeys.importFields, queryFn: () => api.get<ImportField[]>('/intake/imports/fields'), staleTime: 300_000 });
}

/** Upload a CSV file as text/csv (the JSON client can't send a raw body). */
export async function uploadCsv(unitId: string, file: File): Promise<ImportJob> {
  const text = await file.text();
  const params = new URLSearchParams({ unitId, fileName: file.name });
  let response: Response;
  try {
    response = await fetch(`/api/v1/intake/imports?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', 'X-Phoenix-Client': 'web', Accept: 'application/json' },
      body: text,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection and try again.");
  }
  const json = (await response.json().catch(() => null)) as { data?: ImportJob; error?: { code?: string; message?: string; details?: unknown } } | null;
  if (!response.ok || !json?.data) {
    const status = response.status;
    const message = status === 413 ? 'The file is larger than 5 MB. Split it into smaller files.' : json?.error?.message ?? `The server answered ${status}.`;
    throw new ApiError(status, json?.error?.code ?? 'http_error', message, json?.error?.details);
  }
  return json.data;
}

/** The company a unit belongs to (itself for a company), from the session's units. */
export function companyOfUnit(unit: OrgUnit, unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit | null {
  let current: OrgUnit | undefined = unit;
  while (current) {
    if (current.type === 'company') return current;
    current = current.parentId ? unitsById.get(current.parentId) : undefined;
  }
  return null;
}

/** Companies at or under a unit that the user can see (a group lists all of them). */
export function companiesUnder(unit: OrgUnit, units: readonly OrgUnit[], unitsById: ReadonlyMap<string, OrgUnit>): OrgUnit[] {
  const own = companyOfUnit(unit, unitsById);
  if (own) return [own];
  return units.filter((u) => u.type === 'company' && u.path.startsWith(unit.path)).sort((a, b) => a.name.localeCompare(b.name));
}
