// TanStack Query keys for every CRM module, in one place, so a mutation in one slice can refresh
// another slice's lists without importing its code (docs/crm/PHASE2_CONTRACT.md §15.3).
// Each `all` key is a prefix of every key below it: invalidate it to refresh the whole area.
//
//   queryClient.invalidateQueries({ queryKey: crmKeys.deals.all });
//   useQuery({ queryKey: crmKeys.deals.detail(id), queryFn: ... });

import type { DealListQuery, PeoplePermission, TaskListQuery } from './types';

/** Filters are part of the key; keep them plain JSON (no undefined-only differences matter to TanStack). */
type Params = Record<string, unknown>;

export const crmKeys = {
  all: ['crm'] as const,

  vocabularies: ['crm', 'vocabularies'] as const,
  people: (unitId: string, permission: PeoplePermission) => ['crm', 'people', unitId, permission] as const,

  contacts: {
    all: ['crm', 'contacts'] as const,
    list: (unitId: string, filters: Params) => ['crm', 'contacts', 'list', unitId, filters] as const,
    detail: (id: string) => ['crm', 'contacts', 'detail', id] as const,
    duplicates: (id: string) => ['crm', 'contacts', 'duplicates', id] as const,
    consents: (id: string) => ['crm', 'contacts', 'consents', id] as const,
  },

  households: {
    all: ['crm', 'households'] as const,
    list: (unitId: string, filters: Params) => ['crm', 'households', 'list', unitId, filters] as const,
    detail: (id: string) => ['crm', 'households', 'detail', id] as const,
  },

  accounts: {
    all: ['crm', 'accounts'] as const,
    list: (unitId: string, filters: Params) => ['crm', 'accounts', 'list', unitId, filters] as const,
    detail: (id: string) => ['crm', 'accounts', 'detail', id] as const,
  },

  config: {
    all: ['crm', 'config'] as const,
    /** scope: { companyId } or { unitId } as sent to the API. */
    pipelines: (scope: Params) => ['crm', 'config', 'pipelines', scope] as const,
    pipeline: (id: string) => ['crm', 'config', 'pipeline', id] as const,
    requiredFieldOptions: (companyId: string) => ['crm', 'config', 'required-field-options', companyId] as const,
    lostReasons: (scope: Params) => ['crm', 'config', 'lost-reasons', scope] as const,
    productLines: (scope: Params) => ['crm', 'config', 'product-lines', scope] as const,
    products: (scope: Params) => ['crm', 'config', 'products', scope] as const,
    customFields: (scope: Params) => ['crm', 'config', 'custom-fields', scope] as const,
  },

  deals: {
    all: ['crm', 'deals'] as const,
    list: (query: Omit<DealListQuery, 'cursor'>) => ['crm', 'deals', 'list', query] as const,
    stageCounts: (query: Omit<DealListQuery, 'cursor' | 'sort' | 'limit'>) => ['crm', 'deals', 'stage-counts', query] as const,
    detail: (id: string) => ['crm', 'deals', 'detail', id] as const,
    stageHistory: (id: string) => ['crm', 'deals', 'stage-history', id] as const,
  },

  savedViews: {
    all: ['crm', 'saved-views'] as const,
    list: (unitId: string) => ['crm', 'saved-views', unitId] as const,
  },

  timeline: {
    all: ['crm', 'timeline'] as const,
    subject: (type: 'deal' | 'contact' | 'account', id: string) => ['crm', 'timeline', type, id] as const,
    kinds: ['crm', 'timeline', 'kinds'] as const,
  },

  tasks: {
    all: ['crm', 'tasks'] as const,
    list: (query: Omit<TaskListQuery, 'cursor'>) => ['crm', 'tasks', 'list', query] as const,
    counts: (unitId: string, assignee: string) => ['crm', 'tasks', 'counts', unitId, assignee] as const,
    detail: (id: string) => ['crm', 'tasks', 'detail', id] as const,
  },

  search: (unitId: string, q: string) => ['crm', 'search', unitId, q] as const,
};
