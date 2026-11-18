'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ActionFilters, AiAction, AiCatalog, AiConfig, ArticleStatus, KnowledgeArticle, RetrievedArticle, ReviewSummary } from './types';

/** Cache keys of the AI area; invalidate `aiKeys.all` after a change that touches several lists. */
export const aiKeys = {
  all: ['ai'] as const,
  catalog: ['ai', 'catalog'] as const,
  config: (companyId: string) => ['ai', 'config', companyId] as const,
  configAll: ['ai', 'config'] as const,
  actions: (unitId: string, filters: ActionFilters) => ['ai', 'actions', unitId, filters] as const,
  action: (id: string) => ['ai', 'action', id] as const,
  reviews: (unitId: string, agent: string) => ['ai', 'reviews', unitId, agent] as const,
  reviewSummary: (unitId: string) => ['ai', 'review-summary', unitId] as const,
  knowledge: (unitId: string, q: string, status: ArticleStatus | 'all' | '') => ['ai', 'knowledge', unitId, q, status] as const,
  knowledgeAll: ['ai', 'knowledge'] as const,
  retrieval: (companyId: string, q: string) => ['ai', 'retrieval', companyId, q] as const,
};

export function useAiCatalog() {
  return useQuery({ queryKey: aiKeys.catalog, queryFn: () => api.get<AiCatalog>('/ai/agents'), staleTime: Infinity });
}

export function useAiConfig(companyId: string | null) {
  return useQuery({
    queryKey: aiKeys.config(companyId ?? ''),
    queryFn: () => api.get<AiConfig>('/ai/config', { companyId: companyId ?? '' }),
    enabled: Boolean(companyId),
  });
}

export function useAiActions(unitId: string, filters: ActionFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: aiKeys.actions(unitId, filters),
    queryFn: ({ pageParam }) => api.page<AiAction>('/ai/actions', { unitId, ...filters, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useAiAction(id: string | null) {
  return useQuery({ queryKey: aiKeys.action(id ?? ''), queryFn: () => api.get<AiAction>(`/ai/actions/${id ?? ''}`), enabled: Boolean(id) });
}

export function useAiReviews(unitId: string, agent: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: aiKeys.reviews(unitId, agent),
    queryFn: ({ pageParam }) => api.page<AiAction>('/ai/reviews', { unitId, agent, cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useReviewSummary(unitId: string, enabled = true) {
  return useQuery({ queryKey: aiKeys.reviewSummary(unitId), queryFn: () => api.get<ReviewSummary>('/ai/reviews/summary', { unitId }), enabled });
}

export function useKnowledge(unitId: string, q: string, status: ArticleStatus | 'all' | '', enabled = true) {
  return useInfiniteQuery({
    queryKey: aiKeys.knowledge(unitId, q, status),
    queryFn: ({ pageParam }) => api.page<KnowledgeArticle>('/ai/knowledge', { unitId, q, status, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useRetrieval(companyId: string | null, q: string) {
  return useQuery({
    queryKey: aiKeys.retrieval(companyId ?? '', q),
    queryFn: () => api.get<RetrievedArticle[]>('/ai/knowledge/search', { companyId: companyId ?? '', q }),
    enabled: Boolean(companyId) && q.trim().length > 0,
  });
}
