import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { normalizeEmail, toE164 } from '../../core/crm/normalize.js';
import { crmSetting, defaultCountrySetting, referencePrefixSetting } from '../../core/crm/settings.js';

// Small helpers shared by the partners services.

/** Select this next to a page's columns: created_at with microseconds, for exact keyset cursors. */
export const cursorAt = (column) => db.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at`);

/** Keyset "newest first" on (created_at desc, id desc), matching the (…, created_at desc, id desc) indexes. */
export function newestFirst(query, { cursor, limit, createdColumn, idColumn }) {
  const after = decodeCursor(cursor);
  if (after) {
    if (typeof after.t !== 'string' || typeof after.id !== 'string') throw errors.badRequest('Invalid cursor');
    query.whereRaw(`(${createdColumn}, ${idColumn}) < (?::timestamptz, ?::uuid)`, [after.t, after.id]);
  }
  return query
    .orderBy([
      { column: createdColumn, order: 'desc' },
      { column: idColumn, order: 'desc' },
    ])
    .limit(limit + 1);
}

/** Split a limit + 1 page made with newestFirst. */
export function newestPage(rows, limit) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return { page, nextCursor: hasMore && last ? encodeCursor({ t: last.cursor_at, id: last.id }) : null };
}

/** Next value of a per-company counter in crm_sequences. */
export async function nextSequence(trx, companyId, name) {
  const { rows } = await trx.raw(
    `insert into crm_sequences (company_id, name, value) values (?, ?, 1)
     on conflict (company_id, name) do update set value = crm_sequences.value + 1
     returning value`,
    [companyId, name],
  );
  return Number(rows[0].value);
}

/** The company's reference prefix (SP, PV…), used for referral codes and payout refs. */
export const companyPrefix = (company, trx = db) => crmSetting(company, referencePrefixSetting, trx);

/** Normalise a partner's email and phone, with the company's default country. 422 with the field path when invalid. */
export async function normalizeContactPoints(company, { email, phone }, trx = db) {
  const out = {};
  if (email !== undefined) {
    out.email = email === null ? null : normalizeEmail(email);
    if (email !== null && !out.email) throw errors.validation([{ path: 'body.email', message: 'Enter a valid email address' }]);
  }
  if (phone !== undefined) {
    if (phone === null) out.phone = null;
    else {
      const country = await crmSetting(company, defaultCountrySetting, trx);
      out.phone = toE164(phone, country);
      if (!out.phone) throw errors.validation([{ path: 'body.phone', message: 'Enter a valid phone number' }]);
    }
  }
  return out;
}

/** A transaction-scoped advisory lock on a string key. */
export const lockKey = (trx, key) => trx.raw('select pg_advisory_xact_lock(hashtext(?))', [key]);

const ISO = /^\d{4}-\d{2}-\d{2}T/;
/** A valid instant from an event payload, else the fallback. */
export function instantOr(value, fallback) {
  if (typeof value === 'string' && ISO.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(fallback ?? Date.now());
}
