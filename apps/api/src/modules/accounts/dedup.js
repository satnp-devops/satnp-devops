import { emailDomain, isFreeEmailDomain, normalizeDomain, normalizeEmail, normalizeName, normalizePhone } from '../../core/crm/normalize.js';

// De-duplication of institutes inside a group (docs/crm/PHASE2_CONTRACT.md §9.2, POST /accounts).
// An institute is the same one when it shares, in this order of strength:
//   1. the web domain (from the website, or from the email unless it is a free mailbox provider),
//   2. the exact email address, 3. the exact phone number,
//   4. the normalised name in the same city.
// Everything here is pure; the service runs the query and takes the locks.

export const MATCH_ORDER = ['domain', 'email', 'phone', 'name'];

/** Lower-case, trimmed city for comparing ("" when unknown); the same as SQL lower(btrim(coalesce(city, ''))). */
export const cityKey = (city) => (typeof city === 'string' ? city.trim().toLowerCase() : '');

/** The name used for matching: normalised, falling back to the lower-cased text for names made only of punctuation. */
export function accountNameKey(name) {
  const normalized = normalizeName(name ?? '');
  return normalized || String(name ?? '').trim().toLowerCase();
}

/**
 * The domain an institute is known by: its website's host, else its email's domain unless that
 * is a free provider (gmail.com says nothing about which institute someone works at).
 */
export function accountDomain({ website, email } = {}) {
  const fromWebsite = website ? normalizeDomain(website) : null;
  if (fromWebsite) return fromWebsite;
  const fromEmail = email ? emailDomain(email) : null;
  return fromEmail && !isFreeEmailDomain(fromEmail) ? fromEmail : null;
}

/**
 * Normalise what someone typed into the keys used for matching and storing.
 * Invalid phones and emails are reported (path + message) instead of being dropped.
 * @param {{ name?: string, city?: string | null, website?: string | null, phone?: string | null, email?: string | null }} input
 * @returns {{ keys: { domain: string | null, email: string | null, phone: string | null, name: string, city: string }, invalid: Array<{ path: string, message: string }> }}
 */
export function accountDedupKeys(input, { defaultCountry = 'IN', path = 'body' } = {}) {
  const invalid = [];
  let phone = null;
  if (input.phone) {
    phone = normalizePhone(input.phone, defaultCountry)?.e164 ?? null;
    if (!phone) invalid.push({ path: `${path}.phone`, message: 'Enter a valid phone number' });
  }
  let email = null;
  if (input.email) {
    email = normalizeEmail(input.email);
    if (!email) invalid.push({ path: `${path}.email`, message: 'Enter a valid email address' });
  }
  return {
    keys: {
      domain: accountDomain({ website: input.website, email }),
      email,
      phone,
      name: accountNameKey(input.name),
      city: cityKey(input.city),
    },
    invalid,
  };
}

/** Advisory lock names for the keys, sorted, so concurrent creates of one institute wait for each other. */
export function accountLockKeys(groupId, keys) {
  const out = [];
  if (keys.domain) out.push(`crm.account:${groupId}:domain:${keys.domain}`);
  if (keys.email) out.push(`crm.account:${groupId}:email:${keys.email}`);
  if (keys.phone) out.push(`crm.account:${groupId}:phone:${keys.phone}`);
  if (keys.name) out.push(`crm.account:${groupId}:name:${keys.name}|${keys.city}`);
  return out.sort();
}

/** Which keys a stored institute shares with the input. */
export function matchReasons(candidate, keys) {
  const reasons = [];
  if (keys.domain && candidate.domain && String(candidate.domain).toLowerCase() === keys.domain) reasons.push('domain');
  if (keys.email && candidate.primary_email && candidate.primary_email.toLowerCase() === keys.email) reasons.push('email');
  if (keys.phone && candidate.primary_phone === keys.phone) reasons.push('phone');
  if (keys.name && candidate.name_normalized === keys.name && cityKey(candidate.city) === keys.city) reasons.push('name');
  return reasons;
}

/**
 * Pick the stored institute that is the same as the input, or null.
 * The strongest shared key wins (domain, email, phone, then name in the same city); among equals,
 * the institute matching on more keys, then the most recently updated.
 * @param {Array<{ id: string, domain: string | null, primary_email: string | null, primary_phone: string | null, name_normalized: string, city: string | null, updated_at: Date | string }>} candidates
 * @returns {{ candidate: object, matchedBy: 'domain' | 'email' | 'phone' | 'name' } | null}
 */
export function chooseAccountMatch(candidates, keys) {
  const scored = [];
  for (const candidate of candidates) {
    const reasons = matchReasons(candidate, keys);
    if (reasons.length === 0) continue;
    const best = Math.min(...reasons.map((reason) => MATCH_ORDER.indexOf(reason)));
    scored.push({ candidate, matchedBy: MATCH_ORDER[best], best, count: reasons.length, updated: new Date(candidate.updated_at).getTime() || 0 });
  }
  scored.sort((a, b) => a.best - b.best || b.count - a.count || b.updated - a.updated);
  return scored[0] ? { candidate: scored[0].candidate, matchedBy: scored[0].matchedBy } : null;
}

const isBlank = (value) => value === null || value === undefined || value === '';

/**
 * Fill only what the stored institute is missing; never overwrite what someone entered. Pure.
 * `input` holds normalised values (phone in E.164, email lower-case, domain) as the service stores them.
 * @returns {Record<string, unknown>} column changes
 */
export function fillAccountBlanks(account, input) {
  const changes = {};
  if (account.kind === 'other' && input.kind && input.kind !== 'other') changes.kind = input.kind;
  const columns = [
    ['legal_name', input.legalName],
    ['website', input.website],
    ['domain', input.domain],
    ['primary_phone', input.phone],
    ['primary_email', input.email],
    ['city', input.city],
    ['state', input.state],
    ['country_code', input.countryCode],
    ['branch_count', input.branchCount],
    ['student_count', input.studentCount],
    ['current_software', input.currentSoftware],
  ];
  for (const [column, value] of columns) {
    if (isBlank(account[column]) && !isBlank(value)) changes[column] = value;
  }
  const storedAddress = account.address ?? {};
  if (Object.keys(storedAddress).length === 0 && input.address && Object.keys(input.address).length > 0) changes.address = input.address;
  const storedProfile = account.profile ?? {};
  const missing = Object.fromEntries(Object.entries(input.profile ?? {}).filter(([key, value]) => storedProfile[key] === undefined && value !== undefined));
  if (Object.keys(missing).length > 0) changes.profile = { ...storedProfile, ...missing };
  return changes;
}
