import type { IconName } from '@/components/icons';
import type { SearchEntityType, SearchHit } from '@/lib/crm/types';

// Small display helpers for search hits (palette and /search page).

export const TYPE_ICONS: Record<SearchEntityType, IconName> = {
  deal: 'funnel',
  contact: 'user',
  account: 'building',
};

export const TYPE_NAMES: Record<SearchEntityType, string> = {
  deal: 'Lead',
  contact: 'Contact',
  account: 'Account',
};

const REASON_ICONS: Record<SearchHit['matchedOn'], IconName> = {
  phone: 'phone',
  email: 'mail',
  ref: 'tag',
  text: 'note',
  name: 'user',
};

export function reasonIcon(matchedOn: SearchHit['matchedOn']): IconName {
  return REASON_ICONS[matchedOn];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the typed words appear in a title, as word prefixes: "pri sha" in "Priya Sharma" gives
 * [[0, 3], [6, 9]]. Only words with a letter count (numbers match on hidden keywords, not titles).
 */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .sort((a, b) => b.length - a.length);
  if (words.length === 0 || !text) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escapeRegExp).join('|')})`, 'giu');
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length > 0) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** A spoken summary of the results, for the live region: "3 leads and deals, 1 contact". */
export function resultsSummary(groups: ReadonlyArray<{ type: SearchEntityType; hits: readonly unknown[] }>): string {
  const names: Record<SearchEntityType, [string, string]> = {
    deal: ['lead or deal', 'leads and deals'],
    contact: ['contact', 'contacts'],
    account: ['account', 'accounts'],
  };
  const parts = groups
    .filter((group) => group.hits.length > 0)
    .map((group) => `${group.hits.length} ${group.hits.length === 1 ? names[group.type][0] : names[group.type][1]}`);
  return parts.length ? parts.join(', ') : 'No matches';
}
