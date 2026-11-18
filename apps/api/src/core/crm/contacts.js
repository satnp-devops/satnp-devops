import { randomUUID } from 'node:crypto';
import { json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { CONTACT_KINDS } from './constants.js';
import { displayName, namesLikelySame, normalizeEmail, normalizeName, normalizePhone, splitFullName } from './normalize.js';
import { contactDocument, upsertSearchDocument } from './search.js';
import { addTimelineEvent } from './timeline.js';

// People are stored once per group and de-duplicated across it (docs/crm/PHASE2_CONTRACT.md §5.2).
// findOrCreateContact is the one way to turn "someone with this name, phone and email" into a
// contact: manual entry, deals, institute contacts now; channel intake and imports later.

export const UNNAMED_CONTACT = 'Unnamed contact';

/**
 * Normalise phone and email inputs into contact_methods rows.
 * Items are strings or { value, kind?: 'phone' | 'whatsapp', label?, isPrimary? }.
 * @returns {{ methods: Array<{ kind: string, value: string, normalized: string, label: string | null, isPrimary: boolean }>, invalid: Array<{ path: string, message: string }> }}
 */
export function normalizeMethods({ phones = [], emails = [] } = {}, { defaultCountry = 'IN', path = 'body' } = {}) {
  const methods = [];
  const invalid = [];
  const seen = new Set();
  const add = (method) => {
    const key = `${method.kind}:${method.normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    methods.push(method);
  };
  phones.forEach((item, index) => {
    const entry = typeof item === 'string' ? { value: item } : item;
    const phone = normalizePhone(entry.value, defaultCountry);
    if (!phone) {
      invalid.push({ path: `${path}.phones.${index}`, message: 'Enter a valid phone number' });
      return;
    }
    add({
      kind: entry.kind === 'whatsapp' ? 'whatsapp' : 'phone',
      value: String(entry.value).trim(),
      normalized: phone.e164,
      label: entry.label ?? null,
      isPrimary: entry.isPrimary === true,
    });
  });
  emails.forEach((item, index) => {
    const entry = typeof item === 'string' ? { value: item } : item;
    const email = normalizeEmail(entry.value);
    if (!email) {
      invalid.push({ path: `${path}.emails.${index}`, message: 'Enter a valid email address' });
      return;
    }
    add({ kind: 'email', value: String(entry.value).trim(), normalized: email, label: entry.label ?? null, isPrimary: entry.isPrimary === true });
  });
  return { methods, invalid };
}

/**
 * Mark one method per kind as primary: the first one asked for, else the first of its kind.
 * Kinds in `hasPrimary` already have a primary on the stored contact and get none. Phone and
 * WhatsApp are separate kinds. Pure.
 */
export function assignPrimaries(methods, { hasPrimary = {} } = {}) {
  const taken = { ...hasPrimary };
  const out = methods.map((method) => ({ ...method, isPrimary: false }));
  methods.forEach((method, index) => {
    if (method.isPrimary && !taken[method.kind]) {
      out[index].isPrimary = true;
      taken[method.kind] = true;
    }
  });
  for (const method of out) {
    if (!taken[method.kind]) {
      method.isPrimary = true;
      taken[method.kind] = true;
    }
  }
  return out;
}

/** The phone shown on a contact: primary phone, else primary WhatsApp number. */
export function primaryPhoneOf(methods) {
  return (
    methods.find((m) => m.kind === 'phone' && m.isPrimary)?.normalized ??
    methods.find((m) => m.kind === 'whatsapp' && m.isPrimary)?.normalized ??
    null
  );
}

export const primaryEmailOf = (methods) => methods.find((m) => m.kind === 'email' && m.isPrimary)?.normalized ?? null;

/**
 * Pick the existing contact that is the same person, or null. Pure.
 * A candidate shares a normalised phone or email with the input. It is ruled out when
 *   - both kinds are known and differ (a parent and their child often share a number), or
 *   - both names are known and clearly differ (namesLikelySame → false).
 * Email matches beat phone matches; then a matching name; then the most recently updated.
 * @param {Array<{ id: string, kind: string, first_name: string | null, last_name: string | null, updated_at: Date | string, matchedEmails: string[], matchedPhones: string[] }>} candidates
 * @param {{ kind?: string, name?: string }} input
 * @returns {{ candidate: object, matchedBy: 'email' | 'phone' } | null}
 */
export function chooseContactMatch(candidates, input, { threshold = 0.5 } = {}) {
  const scored = [];
  for (const candidate of candidates) {
    const kindsKnown = input.kind && input.kind !== 'other' && candidate.kind && candidate.kind !== 'other';
    if (kindsKnown && input.kind !== candidate.kind) continue;
    const same = namesLikelySame(input.name ?? '', displayName(candidate.first_name, candidate.last_name), threshold);
    if (same === false) continue;
    const emailHit = candidate.matchedEmails.length > 0;
    const phoneHit = candidate.matchedPhones.length > 0;
    if (!emailHit && !phoneHit) continue;
    scored.push({
      candidate,
      matchedBy: emailHit ? 'email' : 'phone',
      score: (emailHit ? 4 : 0) + (phoneHit ? 2 : 0) + (same === true ? 1 : 0),
      updated: new Date(candidate.updated_at).getTime(),
    });
  }
  scored.sort((a, b) => b.score - a.score || b.updated - a.updated);
  return scored[0] ? { candidate: scored[0].candidate, matchedBy: scored[0].matchedBy } : null;
}

/** Fill only what the stored contact is missing; never overwrite what someone entered. Pure. */
export function fillBlanks(contact, input) {
  const changes = {};
  if (!contact.first_name && input.firstName) {
    changes.first_name = input.firstName;
    if (!contact.last_name && input.lastName) changes.last_name = input.lastName;
  }
  if (contact.kind === 'other' && input.kind && input.kind !== 'other') changes.kind = input.kind;
  for (const [column, key] of [
    ['city', 'city'],
    ['country_code', 'countryCode'],
    ['time_zone', 'timeZone'],
    ['language', 'language'],
  ]) {
    if (!contact[column] && input[key]) changes[column] = input[key];
  }
  const profile = input.studentProfile ?? {};
  const stored = contact.student_profile ?? {};
  const missing = Object.fromEntries(Object.entries(profile).filter(([key, value]) => stored[key] === undefined && value !== undefined));
  if (Object.keys(missing).length > 0) changes.student_profile = { ...stored, ...missing };
  return changes;
}

function contactName(first, last) {
  const name = displayName(first, last);
  return { display_name: name || UNNAMED_CONTACT, name_normalized: normalizeName(name) };
}

/**
 * Find the person (same normalised phone or email in the group, compatible kind and name) or
 * create them, and make sure the company knows them (a contact_companies link).
 *
 * Runs inside the caller's transaction and writes, as needed: the contact and its methods, the
 * company link, a timeline entry, the search document, the contact.created /
 * contact.company_linked / contact.updated event, and (when `req` is given) the audit entry.
 * Concurrent calls for the same phone or email wait for each other (advisory locks).
 *
 * @param {import('knex').Knex.Transaction} trx
 * @param {FindOrCreateInput} input
 * @param {{ req?: import('express').Request | null }} [context]
 * @typedef {{
 *   groupId: string, companyId: string, unitId: string,
 *   kind?: 'parent' | 'student' | 'staff' | 'other',
 *   firstName?: string, lastName?: string, fullName?: string,
 *   phones?: Array<string | { value: string, kind?: 'phone' | 'whatsapp', label?: string, isPrimary?: boolean }>,
 *   emails?: Array<string | { value: string, label?: string, isPrimary?: boolean }>,
 *   city?: string, countryCode?: string, timeZone?: string, language?: string,
 *   studentProfile?: Record<string, unknown>,
 *   ownerUserId?: string | null, source?: object | null, tags?: string[],
 *   actorUserId?: string | null, actorType?: 'user' | 'system' | 'ai',
 *   defaultCountry?: string, nameThreshold?: number,
 *   mode?: 'link' | 'create', invalidMethods?: 'throw' | 'skip', path?: string,
 *   writeTimeline?: boolean
 * }} FindOrCreateInput
 * @returns {Promise<{ contact: object, created: boolean, matchedBy: 'email' | 'phone' | null, link: object, linkCreated: boolean, addedMethods: number }>}
 */
export async function findOrCreateContact(trx, input, { req = null } = {}) {
  const { groupId, companyId, unitId } = input;
  if (!groupId || !companyId || !unitId) throw new TypeError('findOrCreateContact needs groupId, companyId and unitId');
  if (input.kind && !CONTACT_KINDS.includes(input.kind)) throw new TypeError(`Unknown contact kind "${input.kind}"`);
  const path = input.path ?? 'body';
  const actorUserId = input.actorUserId ?? req?.auth?.user?.id ?? null;
  const actorType = input.actorType ?? (actorUserId ? 'user' : 'system');

  const names = input.fullName ? splitFullName(input.fullName) : { firstName: input.firstName?.trim() || '', lastName: input.lastName?.trim() || null };
  const { methods: incoming, invalid } = normalizeMethods(input, { defaultCountry: input.defaultCountry ?? 'IN', path });
  if (invalid.length > 0 && input.invalidMethods !== 'skip') throw errors.validation(invalid);
  const fullName = displayName(names.firstName, names.lastName);
  if (!fullName && incoming.length === 0) {
    throw errors.validation([{ path, message: 'Give a name, a phone number or an email' }]);
  }

  // Serialise concurrent find-or-create calls for the same number or address in this group.
  const keys = [...new Set(incoming.map((m) => m.normalized))].sort();
  if (keys.length > 0) {
    await trx.raw('select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(?::text[]) as k order by k', [
      keys.map((key) => `crm.contact:${groupId}:${key}`),
    ]);
  }

  let match = null;
  if (input.mode !== 'create' && keys.length > 0) {
    const rows = await trx('contact_methods as m')
      .join('contacts as c', 'c.id', 'm.contact_id')
      .where('m.group_id', groupId)
      .whereIn('m.normalized', keys)
      .whereNull('c.merged_into_id')
      .whereNull('c.erased_at')
      .select('c.*', 'm.kind as method_kind', 'm.normalized as method_normalized')
      // Lock the candidates, so two calls adding numbers to the same person can't race.
      .forUpdate('c');
    const candidates = new Map();
    for (const row of rows) {
      const { method_kind: kind, method_normalized: normalized, ...contact } = row;
      const candidate = candidates.get(contact.id) ?? { ...contact, matchedEmails: [], matchedPhones: [] };
      (kind === 'email' ? candidate.matchedEmails : candidate.matchedPhones).push(normalized);
      candidates.set(contact.id, candidate);
    }
    match = chooseContactMatch([...candidates.values()], { kind: input.kind, name: fullName }, { threshold: input.nameThreshold ?? 0.5 });
  }

  const details = {
    firstName: names.firstName || null,
    lastName: names.lastName || null,
    kind: input.kind,
    city: input.city,
    countryCode: input.countryCode,
    timeZone: input.timeZone,
    language: input.language,
    studentProfile: input.studentProfile,
  };

  let contact;
  let created = false;
  let addedMethods = 0;
  let changedFields = [];

  if (match) {
    const { matchedEmails, matchedPhones, ...stored } = match.candidate;
    contact = stored;
    // New numbers become primary only for kinds the person has no primary for yet.
    const primaryKinds = incoming.length
      ? await trx('contact_methods').where({ contact_id: contact.id, is_primary: true }).pluck('kind')
      : [];
    const methods = assignPrimaries(incoming, { hasPrimary: Object.fromEntries(primaryKinds.map((kind) => [kind, true])) });
    if (methods.length > 0) {
      const inserted = await trx('contact_methods')
        .insert(methods.map((m) => methodRow(contact.id, groupId, m)))
        .onConflict(['contact_id', 'kind', 'normalized'])
        .ignore()
        .returning(['kind', 'normalized', 'is_primary']);
      addedMethods = inserted.length;
    }
    const changes = fillBlanks(contact, details);
    if (!contact.primary_phone) {
      const phone = primaryPhoneOf(methods);
      if (phone) changes.primary_phone = phone;
    }
    if (!contact.primary_email) {
      const email = primaryEmailOf(methods);
      if (email) changes.primary_email = email;
    }
    changedFields = Object.keys(changes);
    if (changedFields.length > 0 || addedMethods > 0) {
      if (changes.first_name !== undefined) Object.assign(changes, contactName(changes.first_name, changes.last_name ?? contact.last_name));
      if (changes.student_profile) changes.student_profile = json(changes.student_profile);
      [contact] = await trx('contacts')
        .where({ id: contact.id })
        .update({ ...changes, updated_at: trx.fn.now() })
        .returning('*');
    }
  } else {
    const methods = assignPrimaries(incoming);
    const id = randomUUID();
    [contact] = await trx('contacts')
      .insert({
        id,
        group_id: groupId,
        kind: input.kind ?? 'other',
        first_name: details.firstName,
        last_name: details.lastName,
        ...contactName(details.firstName, details.lastName),
        primary_phone: primaryPhoneOf(methods),
        primary_email: primaryEmailOf(methods),
        city: details.city ?? null,
        country_code: details.countryCode ?? null,
        time_zone: details.timeZone ?? null,
        language: details.language ?? null,
        student_profile: json(details.studentProfile ?? {}),
        created_by: actorUserId,
      })
      .returning('*');
    if (methods.length > 0) await trx('contact_methods').insert(methods.map((m) => methodRow(id, groupId, m)));
    created = true;
    addedMethods = methods.length;
  }

  // The company's link to the person.
  const [insertedLink] = await trx('contact_companies')
    .insert({
      id: randomUUID(),
      contact_id: contact.id,
      group_id: groupId,
      company_id: companyId,
      unit_id: unitId,
      owner_user_id: input.ownerUserId ?? null,
      status: 'lead',
      source: input.source ? json(input.source) : null,
      tags: input.tags ?? [],
      created_by: actorUserId,
    })
    .onConflict(['contact_id', 'company_id'])
    .ignore()
    .returning('*');
  const link = insertedLink ?? (await trx('contact_companies').where({ contact_id: contact.id, company_id: companyId }).first());
  const linkCreated = Boolean(insertedLink);

  if (created || linkCreated || changedFields.length > 0 || addedMethods > 0) {
    const allMethods = created
      ? assignPrimaries(incoming).map((m) => ({ kind: m.kind, normalized: m.normalized }))
      : await trx('contact_methods').where({ contact_id: contact.id }).select('kind', 'normalized');
    await upsertSearchDocument(trx, contactDocument(contact, allMethods));
  }

  if ((created || linkCreated) && input.writeTimeline !== false) {
    await addTimelineEvent(trx, {
      groupId,
      companyId,
      unitId: link.unit_id,
      contactId: contact.id,
      kind: 'system',
      title: created ? 'Contact added' : 'Contact added to this company',
      meta: { action: created ? 'contact.created' : 'contact.company_linked', channel: input.source?.channel ?? null },
      actorType,
      actorUserId,
    });
  }

  const event = created ? 'contact.created' : linkCreated ? 'contact.company_linked' : changedFields.length || addedMethods ? 'contact.updated' : null;
  if (event) {
    await emitEvent(trx, {
      type: event,
      groupId,
      unitId: link.unit_id,
      aggregateType: 'contact',
      aggregateId: contact.id,
      actorUserId,
      payload: {
        contactId: contact.id,
        companyId,
        unitId: link.unit_id,
        kind: contact.kind,
        matchedBy: match?.matchedBy ?? null,
        changes: event === 'contact.updated' ? [...changedFields, ...(addedMethods ? ['methods'] : [])] : undefined,
        source: input.source?.channel ? { channel: input.source.channel } : null,
      },
    });
    if (req) {
      await writeAudit(trx, req, {
        action: event === 'contact.company_linked' ? 'contact.linked' : event,
        entityType: 'contact',
        entityId: contact.id,
        unit: { id: link.unit_id, root_id: groupId },
        after: { kind: contact.kind, name: contact.display_name, companyId, matchedBy: match?.matchedBy ?? null },
      });
    }
  }

  return { contact, created, matchedBy: match?.matchedBy ?? null, link, linkCreated, addedMethods };
}

function methodRow(contactId, groupId, method) {
  return {
    id: randomUUID(),
    contact_id: contactId,
    group_id: groupId,
    kind: method.kind,
    value: method.value,
    normalized: method.normalized,
    label: method.label ?? null,
    is_primary: method.isPrimary === true,
  };
}
