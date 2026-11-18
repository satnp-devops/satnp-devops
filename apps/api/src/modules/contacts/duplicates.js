import { nameSimilarity, namesLikelySame } from '../../core/crm/normalize.js';

// Duplicate suggestions (GET /contacts/:id/duplicates, POST /contacts/check). Pure, unit-tested.
//
// Sure matches (a shared phone or email with a compatible kind and name) are merged on create by
// findOrCreateContact; everything else is only suggested here, for a person to merge:
//   phone / email  another person of the group shares a normalised number or address
//   name           similar names (pg_trgm similarity ≥ contacts.fuzzyMatchThreshold) and something
//                  else in common: the same household, the same city or a shared number
//   household      the "same family entered twice" pattern: a parent with a similar name whose
//                  household also has a member (the student) with a similar name to one of ours

const round = (value) => Math.round(value * 100) / 100;

const kindsDiffer = (a, b) => Boolean(a && b && a !== 'other' && b !== 'other' && a !== b);

/** Do any two names from the lists look like the same person? */
export function anyNamePairAlike(names, otherNames, threshold) {
  for (const name of names) {
    if (!name) continue;
    for (const other of otherNames) if (other && namesLikelySame(name, other, threshold) === true) return true;
  }
  return false;
}

/**
 * Score one candidate against the contact being checked.
 * @param {{ name: string, kind?: string, city?: string | null, householdIds?: string[], householdNames?: string[], methods?: string[] }} target
 *   householdNames: names of the target's household co-members; methods: its normalised phones and emails.
 * @param {{ name: string, kind?: string, city?: string | null, householdIds?: string[], householdNames?: string[], sharedPhones?: number, sharedEmails?: number }} candidate
 * @param {{ threshold?: number, nameAlone?: boolean }} [options] nameAlone: similar names count without anything else in common (the create form's live check)
 * @returns {{ reasons: Array<'phone' | 'email' | 'name' | 'household'>, score: number } | null} null when not a suggestion
 */
export function scoreDuplicate(target, candidate, { threshold = 0.5, nameAlone = false } = {}) {
  const reasons = [];
  const similarity = nameSimilarity(target.name ?? '', candidate.name ?? '');
  const sameName = namesLikelySame(target.name ?? '', candidate.name ?? '', threshold);
  const emailHit = (candidate.sharedEmails ?? 0) > 0;
  const phoneHit = (candidate.sharedPhones ?? 0) > 0;
  if (emailHit) reasons.push('email');
  if (phoneHit) reasons.push('phone');

  const namesClose = similarity >= threshold || sameName === true;
  const sameHousehold = (target.householdIds ?? []).some((id) => (candidate.householdIds ?? []).includes(id));
  const sameCity = Boolean(target.city && candidate.city && target.city.trim().toLowerCase() === candidate.city.trim().toLowerCase());
  if (namesClose && (nameAlone || sameHousehold || sameCity || emailHit || phoneHit)) reasons.push('name');

  const otherHousehold = (candidate.householdIds ?? []).some((id) => !(target.householdIds ?? []).includes(id));
  const familyAlike =
    namesClose &&
    otherHousehold &&
    !sameHousehold &&
    anyNamePairAlike(target.householdNames ?? [], candidate.householdNames ?? [], threshold);
  if (familyAlike) reasons.push('household');

  if (reasons.length === 0) return null;

  let score;
  if (emailHit || phoneHit) {
    score = (emailHit ? 0.6 : 0.5) + (emailHit && phoneHit ? 0.1 : 0) + 0.3 * similarity;
    // A parent and child sharing a number, or clearly different names, are probably different people.
    if (kindsDiffer(target.kind, candidate.kind)) score *= 0.5;
    if (sameName === false) score *= 0.6;
  } else {
    score = 0.6 * similarity + (familyAlike ? 0.3 : 0) + (sameHousehold || sameCity ? 0.1 : 0);
    if (kindsDiffer(target.kind, candidate.kind)) score *= 0.5;
  }
  return { reasons, score: round(Math.min(1, Math.max(0, score))) };
}

/** Sort suggestions best first (then by name, for a stable order). */
export function rankDuplicates(items) {
  return [...items].sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
}
