'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, type Query } from '@/lib/api';
import type {
  Attribution,
  Commission,
  CommissionDetail,
  CommissionPlan,
  CommissionSummary,
  PartnerDetail,
  PartnerSummary,
  Payout,
  PayoutDetail,
  PortalCommission,
  PortalLead,
  PortalMe,
  PortalPayout,
  ReferralLink,
} from './types';

// TanStack Query keys and hooks of the partners area. Every key starts with 'partners', so a
// mutation can refresh the whole area with partnerKeys.all when it touches several lists.

export const partnerKeys = {
  all: ['partners'] as const,
  list: (unitId: string, filters: Query) => ['partners', 'list', unitId, filters] as const,
  detail: (id: string) => ['partners', 'detail', id] as const,
  owners: (unitId: string) => ['partners', 'owners', unitId] as const,
  links: (unitId: string, filters: Query) => ['partners', 'links', unitId, filters] as const,
  attributions: (unitId: string, filters: Query) => ['partners', 'attributions', unitId, filters] as const,
  commissions: (unitId: string, filters: Query) => ['partners', 'commissions', unitId, filters] as const,
  commission: (id: string) => ['partners', 'commission', id] as const,
  summary: (unitId: string, partnerId?: string) => ['partners', 'summary', unitId, partnerId ?? ''] as const,
  plans: (scope: Query) => ['partners', 'plans', scope] as const,
  payouts: (unitId: string, filters: Query) => ['partners', 'payouts', unitId, filters] as const,
  payout: (id: string) => ['partners', 'payout', id] as const,
  portal: ['partners', 'portal'] as const,
  portalMe: ['partners', 'portal', 'me'] as const,
  portalList: (kind: string, filters: Query) => ['partners', 'portal', kind, filters] as const,
};

function usePaged<T>(key: readonly unknown[], path: string, query: Query, enabled = true) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.page<T>(path, { ...query, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export const usePartners = (unitId: string, filters: Query) => usePaged<PartnerSummary>(partnerKeys.list(unitId, filters), '/partners', { unitId, ...filters });

export const usePartner = (id: string) => useQuery({ queryKey: partnerKeys.detail(id), queryFn: () => api.get<PartnerDetail>(`/partners/${id}`) });

export const usePartnerOwners = (unitId: string | null) =>
  useQuery({
    queryKey: partnerKeys.owners(unitId ?? 'none'),
    queryFn: () => api.get<Array<{ id: string; name: string }>>('/partners/owners', { unitId }),
    enabled: Boolean(unitId),
  });

export const useReferralLinks = (unitId: string, filters: Query, enabled = true) =>
  usePaged<ReferralLink>(partnerKeys.links(unitId, filters), '/partner-links', { unitId, ...filters }, enabled);

export const useAttributions = (unitId: string, filters: Query, enabled = true) =>
  usePaged<Attribution>(partnerKeys.attributions(unitId, filters), '/partner-attributions', { unitId, ...filters }, enabled);

export const useCommissions = (unitId: string, filters: Query, enabled = true) =>
  usePaged<Commission>(partnerKeys.commissions(unitId, filters), '/partner-commissions', { unitId, ...filters }, enabled);

export const useCommission = (id: string | null) =>
  useQuery({ queryKey: partnerKeys.commission(id ?? 'none'), queryFn: () => api.get<CommissionDetail>(`/partner-commissions/${id}`), enabled: Boolean(id) });

export const useCommissionSummary = (unitId: string, partnerId?: string) =>
  useQuery({
    queryKey: partnerKeys.summary(unitId, partnerId),
    queryFn: () => api.get<CommissionSummary>('/partner-commissions/summary', { unitId, partnerId }),
  });

export const usePlans = (scope: { unitId?: string; companyId?: string }, enabled = true) =>
  useQuery({ queryKey: partnerKeys.plans(scope), queryFn: () => api.get<CommissionPlan[]>('/commission-plans', scope), enabled });

export const usePayouts = (unitId: string, filters: Query, enabled = true) =>
  usePaged<Payout>(partnerKeys.payouts(unitId, filters), '/partner-payouts', { unitId, ...filters }, enabled);

export const usePayout = (id: string) => useQuery({ queryKey: partnerKeys.payout(id), queryFn: () => api.get<PayoutDetail>(`/partner-payouts/${id}`) });

// ---------- Portal ----------

export const usePortalMe = () => useQuery({ queryKey: partnerKeys.portalMe, queryFn: () => api.get<PortalMe>('/partner-portal/me') });
export const usePortalLinks = (filters: Query) => usePaged<ReferralLink>(partnerKeys.portalList('links', filters), '/partner-portal/links', filters);
export const usePortalLeads = (filters: Query) => usePaged<PortalLead>(partnerKeys.portalList('leads', filters), '/partner-portal/leads', filters);
export const usePortalCommissions = (filters: Query) =>
  usePaged<PortalCommission>(partnerKeys.portalList('commissions', filters), '/partner-portal/commissions', filters);
export const usePortalPayouts = (filters: Query) => usePaged<PortalPayout>(partnerKeys.portalList('payouts', filters), '/partner-portal/payouts', filters);
