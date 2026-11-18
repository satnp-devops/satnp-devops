import type { CustomFieldEntity } from '@/lib/crm/types';

// The record types that carry custom fields, as the screens name them.

export const ENTITIES: readonly CustomFieldEntity[] = ['deal', 'contact', 'account'];

export const ENTITY_PLURAL: Record<CustomFieldEntity, string> = { deal: 'Deals', contact: 'Contacts', account: 'Institutes' };

export const ENTITY_SINGULAR: Record<CustomFieldEntity, string> = { deal: 'deal', contact: 'contact', account: 'institute' };

export const ENTITY_HINTS: Record<CustomFieldEntity, string> = {
  deal: 'Kept on each deal. Stages can require them before a deal moves on.',
  contact: 'What this company keeps about a person (people themselves are shared across the group).',
  account: 'What this company keeps about an institute it sells to.',
};
