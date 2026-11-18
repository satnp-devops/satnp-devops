'use client';

// Recent searches, per user, in this browser only. Storage can be missing or blocked (private
// windows, strict settings), so every access is wrapped and failure just means no history.
// Queries that look like a phone number or an email address are not kept: personal data
// shouldn't linger on a shared office computer.

const MAX_RECENT = 6;
const keyFor = (userId: string) => `phoenix.search.recent.${userId}`;

/** True for queries that are (or contain) a phone number or an email address. */
export function looksPersonal(query: string): boolean {
  return query.includes('@') || /\d[\d\s().-]{5,}\d/.test(query);
}

export function readRecent(userId: string): string[] {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

/** Adds a query to the front (case-insensitive de-duplication) and returns the new list. */
export function rememberSearch(userId: string, query: string): string[] {
  const q = query.trim();
  const current = readRecent(userId);
  if (!q || looksPersonal(q)) return current;
  const next = [q, ...current.filter((item) => item.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
  write(userId, next);
  return next;
}

export function forgetSearch(userId: string, query: string): string[] {
  const next = readRecent(userId).filter((item) => item !== query);
  write(userId, next);
  return next;
}

export function clearRecent(userId: string): void {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Nothing stored, or storage blocked: either way there is no history.
  }
}

function write(userId: string, items: string[]): void {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(items));
  } catch {
    // Full or blocked storage: the search still works, it just isn't remembered.
  }
}
