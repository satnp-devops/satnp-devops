'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from '../api';
import { crmKeys } from '../crm/keys';
import type {
  CrmVocabularies,
  CustomFieldDefinition,
  CustomFieldEntity,
  DealKind,
  LostReason,
  Pipeline,
  Product,
  ProductLine,
  RequiredFieldOption,
} from '../crm/types';

// Queries and mutations of the configuration screens (Settings > Pipelines, Products, Custom
// fields). Every list is asked for one company at a time and includes archived or inactive rows,
// which the screens show greyed out. Query keys come from lib/crm/keys.ts.

/** Shared vocabularies (product kinds, field types, channels): cached for 5 minutes like the API. */
export function useVocabularies() {
  return useQuery({
    queryKey: crmKeys.vocabularies,
    queryFn: () => api.get<CrmVocabularies>('/crm/vocabularies'),
    staleTime: 5 * 60_000,
  });
}

export function usePipelines(companyId: string | null) {
  const scope = { companyId: companyId ?? '', includeArchived: true };
  return useQuery({
    queryKey: crmKeys.config.pipelines(scope),
    queryFn: () => api.get<Pipeline[]>('/pipelines', scope),
    enabled: Boolean(companyId),
  });
}

export function useRequiredFieldOptions(companyId: string | null, kind: DealKind | null) {
  return useQuery({
    queryKey: [...crmKeys.config.requiredFieldOptions(companyId ?? ''), kind],
    queryFn: () => api.get<RequiredFieldOption[]>('/pipelines/required-field-options', { companyId, kind }),
    enabled: Boolean(companyId && kind),
  });
}

export function useLostReasons(companyId: string | null) {
  const scope = { companyId: companyId ?? '', includeInactive: true };
  return useQuery({
    queryKey: crmKeys.config.lostReasons(scope),
    queryFn: () => api.get<LostReason[]>('/lost-reasons', scope),
    enabled: Boolean(companyId),
  });
}

export function useProductLines(companyId: string | null) {
  const scope = { companyId: companyId ?? '', includeInactive: true };
  return useQuery({
    queryKey: crmKeys.config.productLines(scope),
    queryFn: () => api.get<ProductLine[]>('/product-lines', scope),
    enabled: Boolean(companyId),
  });
}

export function useProducts(companyId: string | null) {
  const scope = { companyId: companyId ?? '', includeInactive: true };
  return useQuery({
    queryKey: crmKeys.config.products(scope),
    queryFn: () => api.get<Product[]>('/products', scope),
    enabled: Boolean(companyId),
  });
}

export function useCustomFields(companyId: string | null, entity: CustomFieldEntity) {
  const scope = { companyId: companyId ?? '', entity, includeInactive: true };
  return useQuery({
    queryKey: crmKeys.config.customFields(scope),
    queryFn: () => api.get<CustomFieldDefinition[]>('/custom-fields', scope),
    enabled: Boolean(companyId),
  });
}

/**
 * A configuration write. Afterwards every configuration list is refreshed (they are small), plus
 * any extra keys: stage and product changes show on deal lists and boards.
 */
export function useConfigMutation<TVariables, TResult = unknown>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  { alsoInvalidate = [], onSuccess }: { alsoInvalidate?: readonly QueryKey[]; onSuccess?: (result: TResult, variables: TVariables) => void } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.config.all }),
        ...alsoInvalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ]);
      onSuccess?.(result, variables);
    },
  });
}

/** Keys outside configuration that show pipeline, stage and product names. */
export const DEAL_VIEW_KEYS: readonly QueryKey[] = [crmKeys.deals.all, crmKeys.savedViews.all];
