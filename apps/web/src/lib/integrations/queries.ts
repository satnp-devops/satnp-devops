'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApiKey, ChannelIdentity, Connection, IntegrationCatalog, KindKey, SandboxMessage, ScopeGroup } from './types';

/** Cache keys of the integrations area; invalidate `integrationKeys.all` after any change. */
export const integrationKeys = {
  all: ['integrations'] as const,
  catalog: ['integrations', 'catalog'] as const,
  connections: (unitId: string) => ['integrations', 'connections', unitId] as const,
  identities: (unitId: string) => ['integrations', 'identities', unitId] as const,
  sandbox: (unitId: string, kind: KindKey | '') => ['integrations', 'sandbox', unitId, kind] as const,
  apiKeys: (unitId: string, status: 'active' | 'all') => ['integrations', 'api-keys', unitId, status] as const,
  apiKeysAll: ['integrations', 'api-keys'] as const,
  scopes: (unitId: string) => ['integrations', 'scopes', unitId] as const,
};

export function useIntegrationCatalog() {
  return useQuery({
    queryKey: integrationKeys.catalog,
    queryFn: () => api.get<IntegrationCatalog>('/integrations/kinds'),
    staleTime: Infinity,
  });
}

export function useConnections(unitId: string, enabled = true) {
  return useQuery({
    queryKey: integrationKeys.connections(unitId),
    queryFn: () => api.get<Connection[]>('/integrations/connections', { unitId }),
    enabled,
  });
}

export function useChannelIdentities(unitId: string, enabled = true) {
  return useQuery({
    queryKey: integrationKeys.identities(unitId),
    queryFn: () => api.get<ChannelIdentity[]>('/integrations/identities', { unitId }),
    enabled,
  });
}

export function useSandbox(unitId: string, kind: KindKey | '', enabled = true) {
  return useInfiniteQuery({
    queryKey: integrationKeys.sandbox(unitId, kind),
    queryFn: ({ pageParam }) => api.page<SandboxMessage>('/integrations/sandbox', { unitId, kind, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useApiKeys(unitId: string, status: 'active' | 'all', enabled = true) {
  return useInfiniteQuery({
    queryKey: integrationKeys.apiKeys(unitId, status),
    queryFn: ({ pageParam }) => api.page<ApiKey>('/api-keys', { unitId, status, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useGrantableScopes(unitId: string | null) {
  return useQuery({
    queryKey: integrationKeys.scopes(unitId ?? ''),
    queryFn: () => api.get<ScopeGroup[]>('/api-keys/scopes', { unitId: unitId ?? '' }),
    enabled: Boolean(unitId),
  });
}
