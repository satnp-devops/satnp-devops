'use client';

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError, type Query } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type {
  AccountContact,
  AccountContactInput,
  AccountContactPatchInput,
  AccountCreateInput,
  AccountCreateResult,
  AccountDetail,
  AccountListItem,
  AccountListQuery,
  AccountPatchInput,
  CompanyLinkPatchInput,
  ContactListItem,
  CustomFieldDefinition,
  PeoplePermission,
  PersonOption,
} from '@/lib/crm/types';

// Data hooks of the institutes screens (docs/crm/PHASE2_CONTRACT.md §9.2). Mutations refresh the
// institute lists and page, and the other areas a change shows up in (contacts, deals, timeline).

type Filters = Omit<AccountListQuery, 'unitId' | 'cursor'>;

/** GET /accounts query string: lists comma-separated, empty values left out. */
export function accountListParams(unitId: string, filters: Filters, cursor?: string): Query {
  const csv = (values: readonly string[] | undefined) => (values && values.length > 0 ? values.join(',') : undefined);
  return {
    unitId,
    q: filters.q || undefined,
    kind: csv(filters.kind),
    status: csv(filters.status),
    owner: csv(filters.owner),
    tag: csv(filters.tag),
    city: csv(filters.city),
    state: csv(filters.state),
    currentSoftware: filters.currentSoftware || undefined,
    studentCountMin: filters.studentCountMin,
    studentCountMax: filters.studentCountMax,
    includeArchived: filters.includeArchived ? 'true' : undefined,
    sort: filters.sort,
    limit: filters.limit ?? 50,
    cursor,
  };
}

export function useAccounts(unitId: string, filters: Filters) {
  return useInfiniteQuery({
    queryKey: crmKeys.accounts.list(unitId, { ...filters }),
    queryFn: ({ pageParam }) => api.page<AccountListItem>('/accounts', accountListParams(unitId, filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useAccount(id: string) {
  return useQuery({
    queryKey: crmKeys.accounts.detail(id),
    queryFn: () => api.get<AccountDetail>(`/accounts/${id}`),
    retry: (count, error) => count < 2 && !(isApiError(error) && (error.status === 404 || error.status === 403)),
  });
}

/** The company's active custom fields for institutes (config slice: GET /custom-fields). */
export function useAccountFields(companyId: string | null) {
  const scope = { companyId: companyId ?? '', entity: 'account' };
  return useQuery({
    queryKey: crmKeys.config.customFields(scope),
    queryFn: () => api.get<CustomFieldDefinition[]>('/custom-fields', scope),
    enabled: companyId !== null,
    staleTime: 60_000,
    select: (definitions) => definitions.filter((definition) => definition.entity === 'account' && definition.active),
  });
}

/** People who may own or work institutes at a unit (GET /crm/people). */
export function useCrmPeople(unitId: string | null, permission: PeoplePermission) {
  return useQuery({
    queryKey: crmKeys.people(unitId ?? '', permission),
    queryFn: () => api.get<PersonOption[]>('/crm/people', { unitId: unitId ?? '', permission }),
    enabled: unitId !== null,
    staleTime: 60_000,
  });
}

/** Contacts search for linking an existing person (contacts slice: GET /contacts). */
export function useContactSearch(unitId: string, q: string) {
  return useQuery({
    queryKey: crmKeys.contacts.list(unitId, { q, limit: 8, purpose: 'account-link' }),
    queryFn: () => api.page<ContactListItem>('/contacts', { unitId, q, limit: 8 }),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return (accountId: string | null, extra: ReadonlyArray<readonly unknown[]> = []) => {
    const keys: Array<readonly unknown[]> = [crmKeys.accounts.all, ...extra];
    if (accountId) keys.push(crmKeys.timeline.subject('account', accountId));
    return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
}

export function useCreateAccount() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: AccountCreateInput) => api.post<AccountCreateResult>('/accounts', input),
    onSuccess: (result, input) =>
      refresh(result.account.id, (input.contacts?.length ?? 0) > 0 ? [crmKeys.contacts.all] : []),
  });
}

export function useUpdateAccount(accountId: string) {
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AccountPatchInput) => api.patch<AccountDetail>(`/accounts/${accountId}`, input),
    onSuccess: (account, input) => {
      queryClient.setQueryData(crmKeys.accounts.detail(accountId), account);
      // Deals and contacts show the institute's name.
      return refresh(null, input.name !== undefined ? [crmKeys.deals.all, crmKeys.contacts.all] : []);
    },
  });
}

export function useUpdateAccountLink(accountId: string) {
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, input }: { companyId: string; input: CompanyLinkPatchInput }) =>
      api.patch<AccountDetail>(`/accounts/${accountId}/links/${companyId}`, input),
    onSuccess: (account) => {
      queryClient.setQueryData(crmKeys.accounts.detail(accountId), account);
      return refresh(null);
    },
  });
}

export function useAddAccountContact(accountId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: AccountContactInput) => api.post<AccountContact>(`/accounts/${accountId}/contacts`, input),
    onSuccess: () => refresh(accountId, [crmKeys.contacts.all]),
  });
}

export function useUpdateAccountContact(accountId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ contactId, input }: { contactId: string; input: AccountContactPatchInput }) =>
      api.patch<AccountContact>(`/accounts/${accountId}/contacts/${contactId}`, input),
    onSuccess: () => refresh(null, [crmKeys.contacts.all]),
  });
}

export function useRemoveAccountContact(accountId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (contactId: string) => api.delete(`/accounts/${accountId}/contacts/${contactId}`),
    onSuccess: () => refresh(accountId, [crmKeys.contacts.all]),
  });
}
