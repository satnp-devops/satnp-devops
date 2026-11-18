'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DevDeal, Message, MessageChannel, MessageTemplate, MessageTemplateDetail, MessagingSubject, ReplyContext, TemplateStatus } from './types';

/** Cache keys of the messaging area. Invalidate `messagingKeys.all` after a template change. */
export const messagingKeys = {
  all: ['messaging'] as const,
  templates: (scope: Record<string, string>, filters: Record<string, string>) => ['messaging', 'templates', scope, filters] as const,
  templatesAll: ['messaging', 'templates'] as const,
  template: (id: string) => ['messaging', 'template', id] as const,
  context: (subject: MessagingSubject) => ['messaging', 'context', subject.dealId ?? null, subject.contactId ?? null, subject.companyId ?? null] as const,
  messages: (subject: MessagingSubject) => ['messaging', 'messages', subject.dealId ?? null, subject.contactId ?? null, subject.companyId ?? null] as const,
  devDeals: (unitId: string) => ['messaging', 'dev-deals', unitId] as const,
};

const subjectQuery = (subject: MessagingSubject) => ({ dealId: subject.dealId, contactId: subject.contactId, companyId: subject.companyId });

export function useTemplates(scope: { companyId?: string; unitId?: string }, filters: { channel?: MessageChannel | ''; status?: TemplateStatus | '' }, enabled = true) {
  const scopeKey: Record<string, string> = scope.companyId ? { companyId: scope.companyId } : { unitId: scope.unitId ?? '' };
  const filterKey: Record<string, string> = { channel: filters.channel ?? '', status: filters.status ?? '' };
  return useQuery({
    queryKey: messagingKeys.templates(scopeKey, filterKey),
    queryFn: () => api.get<MessageTemplate[]>('/messaging/templates', { ...scopeKey, ...filterKey }),
    enabled,
  });
}

export function useTemplate(id: string | null) {
  return useQuery({
    queryKey: messagingKeys.template(id ?? ''),
    queryFn: () => api.get<MessageTemplateDetail>(`/messaging/templates/${id}`),
    enabled: Boolean(id),
  });
}

export function useReplyContext(subject: MessagingSubject) {
  return useQuery({
    queryKey: messagingKeys.context(subject),
    queryFn: () => api.get<ReplyContext>('/messaging/context', subjectQuery(subject)),
    enabled: Boolean(subject.dealId || subject.contactId),
    // The window and connection can change while the page is open.
    refetchInterval: 60_000,
  });
}

export function useMessages(subject: MessagingSubject) {
  return useInfiniteQuery({
    queryKey: messagingKeys.messages(subject),
    queryFn: ({ pageParam }) => api.page<Message>('/messaging/messages', { ...subjectQuery(subject), cursor: pageParam, limit: 20 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(subject.dealId || subject.contactId),
  });
}

export function useDevDeals(unitId: string) {
  return useQuery({ queryKey: messagingKeys.devDeals(unitId), queryFn: () => api.get<DevDeal[]>('/messaging/dev/deals', { unitId }) });
}
