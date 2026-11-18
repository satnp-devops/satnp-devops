import { errors } from './errors.js';

export const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw errors.badRequest('Invalid cursor');
  }
}

/** Split a "limit + 1" result into a page and the cursor for the next one. */
export function pageOf(rows, limit, cursorFrom) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { page, nextCursor: hasMore && last ? encodeCursor(cursorFrom(last)) : null };
}
