'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError, withQuery } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import type { SearchEntityType, SearchHit, SearchQuery, SearchResponse } from '@/lib/crm/types';

// GET /api/v1/search (docs/crm/PHASE2_CONTRACT.md §9.10) for the palette and the /search page.

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

/** Group order and labels in the palette and on /search. */
export const SEARCH_GROUPS: ReadonlyArray<{ type: SearchEntityType; label: string }> = [
  { type: 'deal', label: 'Leads and deals' },
  { type: 'contact', label: 'Contacts' },
  { type: 'account', label: 'Accounts' },
];

export function groupLabel(type: SearchEntityType): string {
  return SEARCH_GROUPS.find((group) => group.type === type)?.label ?? type;
}

/** Where a hit opens (contract §9.10). */
export function hitHref(hit: Pick<SearchHit, 'type' | 'id'>): string {
  if (hit.type === 'deal') return `/leads/${hit.id}`;
  if (hit.type === 'contact') return `/leads/contacts?contact=${encodeURIComponent(hit.id)}`;
  return `/accounts/${hit.id}`;
}

/** The query as the API will see it, or null while it is too short to send. */
export function searchableQuery(input: string): string | null {
  const q = input.trim().slice(0, MAX_QUERY_LENGTH);
  return q.length >= MIN_QUERY_LENGTH ? q : null;
}

/**
 * The search request. lib/api.ts has no AbortSignal, and an abandoned keystroke's request should
 * stop on the wire, so this one call uses fetch directly with the same headers and error format.
 */
export async function fetchSearch(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
  const path = withQuery('/api/v1/search', {
    unitId: query.unitId,
    q: query.q,
    types: query.types?.length ? query.types.join(',') : undefined,
    limit: query.limit,
  });
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: 'application/json', 'X-Phoenix-Client': 'web' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection and try again.");
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = isRecord(json) && isRecord(json.error) ? json.error : {};
    throw new ApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'http_error',
      typeof body.message === 'string' ? body.message : `The server answered ${response.status}. Please try again.`,
      body.details,
      typeof body.requestId === 'string' ? body.requestId : undefined,
    );
  }
  if (!isRecord(json) || !isRecord(json.data)) throw new ApiError(response.status, 'bad_response', 'The search answer was unreadable.');
  return json.data as unknown as SearchResponse;
}

/**
 * Search results for a (debounced) query. Each query string is its own cache entry; when the
 * query changes, TanStack Query aborts the previous request (the signal is passed to fetch) and
 * the last results stay on screen until the new ones arrive.
 */
export function useSearch(
  unitId: string,
  q: string | null,
  { types, limit, enabled = true }: { types?: SearchEntityType[]; limit?: number; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: [...crmKeys.search(unitId, q ?? ''), { types: types ?? [], limit: limit ?? null }] as const,
    queryFn: ({ signal }) => fetchSearch({ unitId, q: q ?? '', types, limit }, signal),
    enabled: enabled && q !== null,
    // Keep the last results while typing, but never show one scope's results in another.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === unitId ? keepPreviousData(previous) : undefined,
    staleTime: 15_000,
    retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status > 0 && error.status < 500),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
