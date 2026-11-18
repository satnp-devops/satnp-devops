'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type {
  ConsentBody,
  ConsentRecord,
  ContactCheckBody,
  ContactConsents,
  ContactCreateBody,
  ContactCreateResult,
  ContactDetail,
  ContactDuplicates,
  ContactEraseBody,
  ContactExport,
  ContactKind,
  ContactListItem,
  ContactMatchCheck,
  ContactMethod,
  ContactMethodBody,
  ContactMethodPatchBody,
  ContactPatchBody,
  ContactSort,
  Household,
  HouseholdCreateBody,
  HouseholdListItem,
  HouseholdMemberBody,
} from '@/lib/crm/types';

// Queries and mutations of the contacts module (docs/crm/PHASE2_CONTRACT.md 9.1). Mutations refresh
// exactly the keys they affect: a contact edit refreshes contacts and deals (deals show names).

export interface ContactFilters {
  q: string;
  kind: ContactKind[];
  sort: ContactSort;
}

const PAGE_SIZE = 50;

/** The contacts directory: `unitId` is the scope, or the company picked in the company filter. */
export function useContactList(unitId: string, filters: ContactFilters) {
  const params = { q: filters.q, kind: filters.kind.join(','), sort: filters.sort };
  return useInfiniteQuery({
    queryKey: crmKeys.contacts.list(unitId, params),
    queryFn: ({ pageParam }) => api.page<ContactListItem>('/contacts', { unitId, ...params, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** A short people search for pickers (household members, merge targets). */
export function useContactSearch(unitId: string, q: string, enabled = true) {
  const params = { q, picker: true };
  return useQuery({
    queryKey: crmKeys.contacts.list(unitId, params),
    queryFn: () => api.page<ContactListItem>('/contacts', { unitId, q, sort: q ? 'name' : '-updatedAt', limit: 8 }),
    enabled: enabled && q.length >= 2,
    staleTime: 30_000,
  });
}

export function useContact(id: string | null) {
  return useQuery({
    queryKey: crmKeys.contacts.detail(id ?? ''),
    queryFn: () => api.get<ContactDetail>(`/contacts/${id}`),
    enabled: Boolean(id),
  });
}

export function useContactDuplicates(id: string, enabled = true) {
  return useQuery({
    queryKey: crmKeys.contacts.duplicates(id),
    queryFn: () => api.get<ContactDuplicates>(`/contacts/${id}/duplicates`),
    enabled,
  });
}

export function useContactConsents(id: string, enabled = true) {
  return useQuery({
    queryKey: crmKeys.contacts.consents(id),
    queryFn: () => api.get<ContactConsents>(`/contacts/${id}/consents`),
    enabled,
  });
}

export function useHousehold(id: string) {
  return useQuery({
    queryKey: crmKeys.households.detail(id),
    queryFn: () => api.get<Household>(`/households/${id}`),
  });
}

export function useHouseholdSearch(unitId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: crmKeys.households.list(unitId, { q }),
    queryFn: () => api.page<HouseholdListItem>('/households', { unitId, q, limit: 8 }),
    enabled,
    staleTime: 30_000,
  });
}

/** The live duplicate check of the create dialog; `body` is null until there is something to match. */
export function useContactCheck(body: ContactCheckBody | null) {
  return useQuery({
    queryKey: [...crmKeys.contacts.all, 'check', body] as const,
    queryFn: () => api.post<ContactMatchCheck>('/contacts/check', body),
    enabled: body !== null,
    staleTime: 15_000,
    retry: false,
  });
}

// ---------- Invalidation ----------

/** After a change to one person: their detail, every contacts list, and deals (which show names). */
function refreshContact(queryClient: QueryClient, id: string) {
  void queryClient.invalidateQueries({ queryKey: crmKeys.contacts.all });
  void queryClient.invalidateQueries({ queryKey: crmKeys.deals.all });
  void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('contact', id) });
}

/** After household changes: households, and the people in them (their household refs). */
function refreshHouseholds(queryClient: QueryClient, contactIds: readonly string[]) {
  void queryClient.invalidateQueries({ queryKey: crmKeys.households.all });
  void queryClient.invalidateQueries({ queryKey: crmKeys.contacts.all });
  for (const id of contactIds) void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('contact', id) });
}

/** After a merge or an erasure, which reach deals, tasks and timelines. */
function refreshEverything(queryClient: QueryClient) {
  for (const key of [crmKeys.contacts.all, crmKeys.households.all, crmKeys.deals.all, crmKeys.timeline.all, crmKeys.tasks.all]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

// ---------- Mutations ----------

export function useCreateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactCreateBody) => api.post<ContactCreateResult>('/contacts', body),
    onSuccess: (result) => {
      queryClient.setQueryData(crmKeys.contacts.detail(result.contact.id), result.contact);
      refreshContact(queryClient, result.contact.id);
      if (result.contact.households.length > 0) void queryClient.invalidateQueries({ queryKey: crmKeys.households.all });
    },
  });
}

export function useUpdateContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactPatchBody) => api.patch<ContactDetail>(`/contacts/${id}`, body),
    onSuccess: (contact) => {
      queryClient.setQueryData(crmKeys.contacts.detail(id), contact);
      refreshContact(queryClient, id);
      void queryClient.invalidateQueries({ queryKey: crmKeys.households.all });
    },
  });
}

export function useAddMethod(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactMethodBody) => api.post<ContactMethod>(`/contacts/${id}/methods`, body),
    onSuccess: () => refreshContact(queryClient, id),
  });
}

export function useUpdateMethod(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ methodId, body }: { methodId: string; body: ContactMethodPatchBody }) =>
      api.patch<ContactMethod>(`/contacts/${id}/methods/${methodId}`, body),
    onSuccess: () => refreshContact(queryClient, id),
  });
}

export function useRemoveMethod(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (methodId: string) => api.delete(`/contacts/${id}/methods/${methodId}`),
    onSuccess: () => refreshContact(queryClient, id),
  });
}

export function useRecordConsent(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ConsentBody) => api.post<ConsentRecord>(`/contacts/${id}/consents`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.contacts.consents(id) });
      void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('contact', id) });
    },
  });
}

export function useCreateHousehold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: HouseholdCreateBody) => api.post<Household>('/households', body),
    onSuccess: (household, body) => {
      queryClient.setQueryData(crmKeys.households.detail(household.id), household);
      refreshHouseholds(queryClient, body.members.map((member) => member.contactId));
    },
  });
}

export function useAddHouseholdMember(householdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: HouseholdMemberBody) => api.post<Household>(`/households/${householdId}/members`, body),
    onSuccess: (household, body) => {
      queryClient.setQueryData(crmKeys.households.detail(householdId), household);
      refreshHouseholds(queryClient, [body.contactId]);
    },
  });
}

export function useRemoveHouseholdMember(householdId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => api.delete(`/households/${householdId}/members/${contactId}`),
    onSuccess: (_result, contactId) => refreshHouseholds(queryClient, [contactId]),
  });
}

/** Keeps `targetId` and folds `sourceId` into it. */
export function useMergeContacts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targetId, sourceId }: { targetId: string; sourceId: string }) =>
      api.post<ContactDetail>(`/contacts/${targetId}/merge`, { sourceId }),
    onSuccess: (contact, { sourceId }) => {
      queryClient.setQueryData(crmKeys.contacts.detail(contact.id), contact);
      queryClient.removeQueries({ queryKey: crmKeys.contacts.detail(sourceId) });
      refreshEverything(queryClient);
    },
  });
}

export function useEraseContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactEraseBody) => api.post<ContactDetail>(`/contacts/${id}/erase`, body),
    onSuccess: (contact) => {
      // Erasure removes the person from their households: drop those cached households instead of
      // refetching them while the drawer still shows them (they may now be invisible: 404).
      const before = queryClient.getQueryData<ContactDetail>(crmKeys.contacts.detail(id));
      for (const household of before?.households ?? []) queryClient.removeQueries({ queryKey: crmKeys.households.detail(household.id) });
      queryClient.setQueryData(crmKeys.contacts.detail(id), contact);
      refreshEverything(queryClient);
    },
  });
}

/** Downloads everything the group holds about the person as a JSON file (the API audits it). */
export async function downloadContactExport(id: string): Promise<void> {
  const data = await api.get<ContactExport>(`/contacts/${id}/export`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `contact-${id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
