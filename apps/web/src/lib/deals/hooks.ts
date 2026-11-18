'use client';

// TanStack Query hooks for the Leads list: deals and saved views (deals slice), plus the
// configuration and people it reads (config slice endpoints, §9.3–9.5) and the note and task
// endpoints it writes to (timeline slice, §9.8–9.9). Keys come from lib/crm/keys.ts.

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type {
  CrmVocabularies,
  CustomFieldDefinition,
  DealBulkInput,
  DealBulkResult,
  DealCreateInput,
  DealDetail,
  DealDuplicateCheck,
  DealFieldsPatch,
  DealKind,
  DealListItem,
  DealListQuery,
  DealMoveInput,
  LostReason,
  Page,
  PersonOption,
  Pipeline,
  Product,
  ProductLine,
  SavedView,
  SavedViewInput,
  Task,
  TimelineEntry,
} from '@/lib/crm/types';
import { toQuery } from './views';

const MINUTE = 60_000;

// ---------- Reading ----------

export function useDealList(query: Omit<DealListQuery, 'cursor'>, enabled = true) {
  return useInfiniteQuery({
    queryKey: crmKeys.deals.list(query),
    queryFn: ({ pageParam }) => api.page<DealListItem>('/deals', toQuery({ ...query, cursor: pageParam })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useDeal(id: string | null) {
  return useQuery({
    queryKey: crmKeys.deals.detail(id ?? ''),
    queryFn: () => api.get<DealDetail>(`/deals/${id}`),
    enabled: id !== null,
  });
}

export function useSavedViews(unitId: string) {
  return useQuery({
    queryKey: crmKeys.savedViews.list(unitId),
    queryFn: () => api.get<SavedView[]>('/saved-views', { unitId }),
    staleTime: MINUTE,
  });
}

export function useVocabularies() {
  return useQuery({ queryKey: crmKeys.vocabularies, queryFn: () => api.get<CrmVocabularies>('/crm/vocabularies'), staleTime: 10 * MINUTE });
}

/** Pipelines of every company the working unit covers (stage filters, stage bubbles, moves). */
export function usePipelines(unitId: string) {
  const scope = { unitId };
  return useQuery({
    queryKey: crmKeys.config.pipelines(scope),
    queryFn: () => api.get<Pipeline[]>('/pipelines', scope),
    staleTime: 5 * MINUTE,
  });
}

export function useProductLines(scope: { unitId: string } | { companyId: string }, enabled = true) {
  return useQuery({
    queryKey: crmKeys.config.productLines(scope),
    queryFn: () => api.get<ProductLine[]>('/product-lines', scope),
    staleTime: 5 * MINUTE,
    enabled,
  });
}

export function useProducts(companyId: string | null, productLineId: string | null) {
  const scope = { companyId: companyId ?? '', productLineId: productLineId ?? '' };
  return useQuery({
    queryKey: crmKeys.config.products(scope),
    queryFn: () => api.get<Product[]>('/products', scope),
    staleTime: 5 * MINUTE,
    enabled: companyId !== null && productLineId !== null,
  });
}

export function useLostReasons(companyId: string | null, kind?: DealKind) {
  const scope = { companyId: companyId ?? '', kind };
  return useQuery({
    queryKey: crmKeys.config.lostReasons(scope),
    queryFn: () => api.get<LostReason[]>('/lost-reasons', scope),
    staleTime: 5 * MINUTE,
    enabled: companyId !== null,
  });
}

export function useDealCustomFields(companyId: string | null) {
  const scope = { companyId: companyId ?? '', entity: 'deal' };
  return useQuery({
    queryKey: crmKeys.config.customFields(scope),
    queryFn: () => api.get<CustomFieldDefinition[]>('/custom-fields', scope),
    staleTime: 5 * MINUTE,
    enabled: companyId !== null,
  });
}

/** People who can own leads at a unit (owner filter, assign). */
export function useDealOwners(unitId: string | null, enabled = true) {
  return useQuery({
    queryKey: crmKeys.people(unitId ?? '', 'deals.manage'),
    queryFn: () => api.get<PersonOption[]>('/crm/people', { unitId: unitId ?? '', permission: 'deals.manage' }),
    staleTime: 5 * MINUTE,
    enabled: enabled && unitId !== null,
  });
}

export function checkDuplicates(body: {
  unitId: string;
  kind?: DealKind;
  phones?: string[];
  emails?: string[];
  firstName?: string;
  lastName?: string;
}) {
  return api.post<DealDuplicateCheck>('/deals/check-duplicates', body);
}

// ---------- Cache updates ----------

interface InfiniteDeals {
  pages: Array<Page<DealListItem>>;
  pageParams: unknown[];
}

function isInfiniteDeals(value: unknown): value is InfiniteDeals {
  return typeof value === 'object' && value !== null && Array.isArray((value as { pages?: unknown }).pages);
}

/** Patches one lead in every loaded list page without refetching (e.g. it stopped being new). */
export function patchDealInLists(queryClient: QueryClient, id: string, patch: Partial<DealListItem>) {
  queryClient.setQueriesData<unknown>({ queryKey: [...crmKeys.deals.all, 'list'] }, (old: unknown) => {
    if (!isInfiniteDeals(old)) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({ ...page, data: page.data.map((deal) => (deal.id === id ? { ...deal, ...patch } : deal)) })),
    };
  });
}

/** After a change to one lead: keep its detail, refresh lists, its timeline and tasks. */
function afterDealChange(queryClient: QueryClient, deal: DealDetail) {
  queryClient.setQueryData(crmKeys.deals.detail(deal.id), deal);
  void queryClient.invalidateQueries({ queryKey: [...crmKeys.deals.all, 'list'] });
  void queryClient.invalidateQueries({ queryKey: [...crmKeys.deals.all, 'stage-counts'] });
  void queryClient.invalidateQueries({ queryKey: crmKeys.deals.stageHistory(deal.id) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', deal.id) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.tasks.all });
}

// ---------- Writing ----------

export type DealAction =
  | { type: 'move'; body: DealMoveInput }
  | { type: 'win'; body: { stageId?: string; fields?: DealFieldsPatch } }
  | { type: 'lose'; body: { stageId?: string; lostReasonId: string; lostNote?: string; nurture?: boolean } }
  | { type: 'reopen'; body: { stageId?: string } }
  | { type: 'assign'; body: { ownerUserId: string | null } }
  | { type: 'archive'; body: { reason?: string } }
  | { type: 'restore'; body?: undefined }
  | { type: 'update'; body: DealFieldsPatch };

/** One mutation for every single-lead action (move, win, lose, reopen, assign, archive, edit). */
export function useDealAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: DealAction) =>
      action.type === 'update'
        ? api.patch<DealDetail>(`/deals/${id}`, action.body)
        : api.post<DealDetail>(`/deals/${id}/${action.type}`, action.body ?? {}),
    onSuccess: (deal) => afterDealChange(queryClient, deal),
  });
}

export function useMarkSeen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/deals/${id}/seen`),
    onSuccess: (_result, id) => {
      patchDealInLists(queryClient, id, { isNew: false });
      queryClient.setQueryData<DealDetail>(crmKeys.deals.detail(id), (old) => (old ? { ...old, isNew: false } : old));
    },
  });
}

export function useCreateDeal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DealCreateInput) => api.post<DealDetail>('/deals', body),
    onSuccess: (deal) => {
      afterDealChange(queryClient, deal);
      void queryClient.invalidateQueries({ queryKey: crmKeys.contacts.all });
      void queryClient.invalidateQueries({ queryKey: crmKeys.households.all });
    },
  });
}

export function useBulkDeals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DealBulkInput) => api.post<DealBulkResult>('/deals/bulk', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.deals.all });
      void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.all });
      void queryClient.invalidateQueries({ queryKey: crmKeys.tasks.all });
    },
  });
}

/** A note on the lead's timeline (POST /timeline, timeline slice). */
export function useAddNote(dealId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.post<TimelineEntry>('/timeline', { dealId, kind: 'note', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', dealId) });
      void queryClient.invalidateQueries({ queryKey: crmKeys.deals.detail(dealId) });
      void queryClient.invalidateQueries({ queryKey: [...crmKeys.deals.all, 'list'] });
    },
  });
}

/** A follow-up task on the lead (POST /tasks, timeline slice). */
export function useAddTask(dealId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; dueAt: string | null; assigneeUserId?: string | null }) => api.post<Task>('/tasks', { dealId, ...body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.tasks.all });
      void queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', dealId) });
    },
  });
}

export function useSavedViewMutations(unitId: string) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: crmKeys.savedViews.all });
  const create = useMutation({ mutationFn: (body: SavedViewInput) => api.post<SavedView>('/saved-views', body), onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<Omit<SavedViewInput, 'unitId' | 'entity'>>) =>
      api.patch<SavedView>(`/saved-views/${id}`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/saved-views/${id}`), onSuccess: refresh });
  return { create, update, remove, unitId };
}

/** Reopen an existing lead instead of creating a new one (the duplicate warning in the new-lead dialog). */
export function useReopenDeal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DealDetail>(`/deals/${id}/reopen`, {}),
    onSuccess: (deal) => afterDealChange(queryClient, deal),
  });
}

export interface DuplicateCheckInput {
  unitId: string;
  kind?: DealKind;
  phones?: string[];
  emails?: string[];
  firstName?: string;
  lastName?: string;
}

/** The live duplicate warning: who this person already is, and their open or recently lost leads. */
export function useDuplicateCheck(input: DuplicateCheckInput | null) {
  return useQuery({
    queryKey: [...crmKeys.deals.all, 'duplicate-check', input],
    queryFn: () => checkDuplicates(input ?? { unitId: '' }),
    enabled: input !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
