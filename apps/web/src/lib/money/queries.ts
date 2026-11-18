'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Query } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type {
  Agreement,
  AgreementInput,
  AgreementTemplate,
  BillingCompany,
  BillingOverview,
  BillingSetup,
  DealBilling,
  Instalment,
  Invoice,
  InvoiceSummary,
  Payment,
  PaymentLinkInput,
  Plan,
  PriceList,
  Quote,
  QuoteInput,
  Refund,
  Subscription,
} from './types';

// TanStack Query keys and hooks for fees and billing. Every key starts with ['money'], so a
// mutation can refresh the whole area; deal-level keys sit under ['money', 'deal', id].

type Params = Record<string, unknown>;

export const moneyKeys = {
  all: ['money'] as const,
  overview: (unitId: string) => ['money', 'overview', unitId] as const,
  list: (kind: string, unitId: string, filters: Params) => ['money', 'list', kind, unitId, filters] as const,
  deal: (dealId: string) => ['money', 'deal', dealId] as const,
  invoice: (id: string) => ['money', 'invoice', id] as const,
  agreement: (id: string) => ['money', 'agreement', id] as const,
  subscription: (id: string) => ['money', 'subscription', id] as const,
  companies: (unitId: string) => ['money', 'companies', unitId] as const,
  setup: (companyId: string) => ['money', 'setup', companyId] as const,
  plans: (scope: Params) => ['money', 'plans', scope] as const,
  priceLists: (scope: Params) => ['money', 'price-lists', scope] as const,
  templates: (scope: Params) => ['money', 'templates', scope] as const,
};

export function useBillingOverview(unitId: string, enabled = true) {
  return useQuery({ queryKey: moneyKeys.overview(unitId), queryFn: () => api.get<BillingOverview>('/billing/overview', { unitId }), enabled });
}

function useBillingList<T>(kind: string, path: string, unitId: string, filters: Query, enabled = true) {
  return useInfiniteQuery({
    queryKey: moneyKeys.list(kind, unitId, filters),
    queryFn: ({ pageParam }) => api.page<T>(path, { unitId, ...filters, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export const usePayments = (unitId: string, filters: Query, enabled = true) => useBillingList<Payment>('payments', '/billing/payments', unitId, filters, enabled);
export const useInvoices = (unitId: string, filters: Query, enabled = true) => useBillingList<InvoiceSummary>('invoices', '/billing/invoices', unitId, filters, enabled);
export const useInstalments = (unitId: string, filters: Query, enabled = true) => useBillingList<Instalment>('instalments', '/billing/instalments', unitId, filters, enabled);
export const useRefunds = (unitId: string, filters: Query, enabled = true) => useBillingList<Refund>('refunds', '/billing/refunds', unitId, filters, enabled);
export const useAgreements = (unitId: string, filters: Query, enabled = true) => useBillingList<Agreement>('agreements', '/billing/agreements', unitId, filters, enabled);
export const useQuotes = (unitId: string, filters: Query, enabled = true) => useBillingList<Quote>('quotes', '/billing/quotes', unitId, filters, enabled);
export const useSubscriptions = (unitId: string, filters: Query, enabled = true) => useBillingList<Subscription>('subscriptions', '/billing/subscriptions', unitId, filters, enabled);

export function useDealBilling(dealId: string) {
  return useQuery({ queryKey: moneyKeys.deal(dealId), queryFn: () => api.get<DealBilling>(`/billing/deals/${dealId}`) });
}

export function useInvoice(id: string | null) {
  return useQuery({ queryKey: moneyKeys.invoice(id ?? 'none'), queryFn: () => api.get<Invoice>(`/billing/invoices/${id}`), enabled: id !== null });
}

export function useAgreement(id: string | null) {
  return useQuery({ queryKey: moneyKeys.agreement(id ?? 'none'), queryFn: () => api.get<Agreement>(`/billing/agreements/${id}`), enabled: id !== null });
}

export function useSubscription(id: string | null) {
  return useQuery({ queryKey: moneyKeys.subscription(id ?? 'none'), queryFn: () => api.get<Subscription>(`/billing/subscriptions/${id}`), enabled: id !== null });
}

export function useBillingCompanies(unitId: string, enabled = true) {
  return useQuery({ queryKey: moneyKeys.companies(unitId), queryFn: () => api.get<BillingCompany[]>('/billing/companies', { unitId }), enabled });
}

export function useBillingSetup(companyId: string | null) {
  return useQuery({ queryKey: moneyKeys.setup(companyId ?? 'none'), queryFn: () => api.get<BillingSetup>('/billing/setup', { companyId: companyId ?? '' }), enabled: companyId !== null });
}

export function usePlans(scope: { companyId?: string; unitId?: string; includeInactive?: boolean }, enabled = true) {
  return useQuery({ queryKey: moneyKeys.plans(scope), queryFn: () => api.get<Plan[]>('/billing/plans', scope), enabled, staleTime: 60_000 });
}

export function usePriceLists(scope: { companyId?: string; unitId?: string; includeInactive?: boolean }, enabled = true) {
  return useQuery({ queryKey: moneyKeys.priceLists(scope), queryFn: () => api.get<PriceList[]>('/billing/price-lists', scope), enabled, staleTime: 60_000 });
}

export function useTemplates(scope: { companyId?: string; unitId?: string; includeInactive?: boolean }, enabled = true) {
  return useQuery({ queryKey: moneyKeys.templates(scope), queryFn: () => api.get<AgreementTemplate[]>('/billing/agreement-templates', scope), enabled });
}

/**
 * A billing mutation that refreshes the money area, and the deal's timeline and lists (billing
 * writes timeline entries and moves last_activity_at).
 */
export function useMoneyMutation<TInput, TResult = unknown>(fn: (input: TInput) => Promise<TResult>, { dealId }: { dealId?: string } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: moneyKeys.all }),
        ...(dealId ? [client.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', dealId) })] : []),
      ]);
    },
  });
}

export const moneyApi = {
  previewQuote: (input: QuoteInput) => api.post<Quote>('/billing/quotes/preview', input),
  createQuote: (input: QuoteInput) => api.post<Quote>('/billing/quotes', input),
  quoteAction: (id: string, action: 'send' | 'accept' | 'cancel' | 'approve-discount' | 'reject-discount' | 'decline', body: unknown = {}) =>
    api.post<Quote>(`/billing/quotes/${id}/${action}`, body),
  createLink: (input: PaymentLinkInput) => api.post<Payment>('/billing/payments/links', input),
  paymentAction: (id: string, action: 'cancel' | 'resend' | 'invoice') => api.post<Payment>(`/billing/payments/${id}/${action}`),
  simulatePayment: (id: string, outcome: 'succeeded' | 'failed') => api.post<Payment>(`/billing/payments/${id}/simulate`, { outcome }),
  requestRefund: (input: { paymentId: string; amountMinor: number; reason: string; note?: string }) => api.post<Refund>('/billing/refunds', input),
  refundAction: (id: string, action: 'approve' | 'reject' | 'retry', note?: string) => api.post<Refund>(`/billing/refunds/${id}/${action}`, action === 'retry' ? undefined : { note }),
  createAgreement: (input: AgreementInput) => api.post<Agreement>('/billing/agreements', input),
  agreementAction: (id: string, action: 'send' | 'cancel' | 'refresh' | 'simulate', body?: unknown) => api.post<Agreement>(`/billing/agreements/${id}/${action}`, body),
  subscriptionAction: (id: string, action: 'cancel' | 'renew', body?: unknown) => api.post<Subscription>(`/billing/subscriptions/${id}/${action}`, body),
};
