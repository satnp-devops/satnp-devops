import { randomUUID } from 'node:crypto';
import { json } from '../../lib/db.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { candidateKeys, compareNames, findDuplicates } from '../../core/intake/index.js';
import { assignPrimaries, fillBlanks, findOrCreateContact, normalizeMethods, primaryEmailOf, primaryPhoneOf } from '../../core/crm/contacts.js';
import { displayName, normalizeName, splitFullName } from '../../core/crm/normalize.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { refreshSearchDocument } from '../../core/crm/search.js';
import { crmNormalizers } from './settings.js';

// People in an enquiry: finding who they already are in the group (the engine's dedup, fed by
// indexed lookups) and writing them (attach to an existing person, or create through
// findOrCreateContact), plus the learner of a family enquiry.

const MAX_CANDIDATES = 30;

/** Contact kind for the enquirer. */
export function enquirerKind(enquiry, kind) {
  if (kind === 'b2b') return 'staff';
  const relation = enquiry.contact?.relation;
  if (relation === 'self') return 'student';
  if (relation === 'parent' || relation === 'guardian') return 'parent';
  if (relation === 'staff') return 'staff';
  if (enquiry.student?.name) return 'parent';
  return undefined;
}

/**
 * Existing contacts in the group that might be the enquirer: same normalised phone or email
 * (contact_methods_lookup_idx), or a similar full name (pg_trgm `%` on contacts_name_trgm_idx),
 * each with its household's students and parents so the parent + student rule can fire.
 */
export async function loadCandidates(trx, groupId, enquiry) {
  const keys = candidateKeys(enquiry, { normalizers: crmNormalizers });
  const values = [...keys.phones, ...keys.emails];
  const ids = new Set();
  if (values.length) {
    const rows = await trx('contact_methods as m')
      .join('contacts as c', 'c.id', 'm.contact_id')
      .where('m.group_id', groupId)
      .whereIn('m.normalized', values)
      .whereNull('c.merged_into_id')
      .whereNull('c.erased_at')
      .distinct('c.id')
      .limit(MAX_CANDIDATES);
    for (const row of rows) ids.add(row.id);
  }
  const names = [...new Set(keys.names.map((n) => normalizeName(n)).filter((n) => n.split(' ').length >= 2))].slice(0, 3);
  for (const name of names) {
    if (ids.size >= MAX_CANDIDATES) break;
    const rows = await trx('contacts')
      .where({ group_id: groupId })
      .whereNull('merged_into_id')
      .whereNull('erased_at')
      .whereRaw('name_normalized % ?', [name])
      .orderByRaw('similarity(name_normalized, ?) desc', [name])
      .limit(10)
      .select('id');
    for (const row of rows) ids.add(row.id);
  }
  if (!ids.size) return [];
  const list = [...ids].slice(0, MAX_CANDIDATES);
  const contacts = await trx('contacts').whereIn('id', list).select('id', 'kind', 'display_name', 'first_name', 'last_name', 'city', 'updated_at');
  const methods = await trx('contact_methods').whereIn('contact_id', list).select('contact_id', 'kind', 'normalized');
  const memberships = await trx('household_members').whereIn('contact_id', list).select('household_id', 'contact_id');
  const householdIds = [...new Set(memberships.map((m) => m.household_id))];
  const members = householdIds.length
    ? await trx('household_members as hm')
        .join('contacts as c', 'c.id', 'hm.contact_id')
        .whereIn('hm.household_id', householdIds)
        .select('hm.household_id', 'hm.contact_id', 'hm.role', 'c.display_name')
    : [];
  return contacts.map((contact) => {
    const own = methods.filter((m) => m.contact_id === contact.id);
    const households = new Set(memberships.filter((m) => m.contact_id === contact.id).map((m) => m.household_id));
    const family = members.filter((m) => households.has(m.household_id) && m.contact_id !== contact.id);
    return {
      id: contact.id,
      kind: contact.kind,
      name: contact.display_name === 'Unnamed contact' ? '' : contact.display_name,
      phones: own.filter((m) => m.kind !== 'email').map((m) => m.normalized),
      emails: own.filter((m) => m.kind === 'email').map((m) => m.normalized),
      city: contact.city ?? undefined,
      students: family.filter((m) => m.role === 'student').map((m) => m.display_name),
      parents: family.filter((m) => m.role === 'parent' || m.role === 'guardian').map((m) => m.display_name),
    };
  });
}

/** Run the engine's dedup over the candidates; keep ids, scores and reasons (no personal data). */
export function decideDuplicates(enquiry, candidates, { thresholds }) {
  const result = findDuplicates(enquiry, candidates, { normalizers: crmNormalizers, thresholds });
  return {
    decision: result.decision,
    contactId: result.contactId ?? null,
    score: result.score,
    explanation: result.explanation,
    matchedAs: result.matchedAs ?? null,
    candidates: result.candidates.map((c) => ({
      contactId: c.contactId,
      score: c.score,
      decision: c.decision,
      matchedAs: c.matchedAs ?? null,
      rules: c.rules.map((r) => ({ rule: r.rule, score: r.score })),
      explanation: c.explanation,
    })),
  };
}

/** The person's details from the enquiry, in findOrCreateContact's input shape. */
export function personInput(enquiry, { kind }) {
  const c = enquiry.contact ?? {};
  const names = c.firstName || c.lastName ? { firstName: c.firstName ?? '', lastName: c.lastName ?? null } : splitFullName(c.name ?? '');
  const phones = [c.phone, c.altPhone].filter(Boolean).map((value, i) => ({ value, kind: 'phone', isPrimary: i === 0 }));
  return {
    kind,
    firstName: names.firstName || undefined,
    lastName: names.lastName || undefined,
    phones,
    emails: c.email ? [c.email] : [],
    city: c.city,
    countryCode: c.country,
    timeZone: c.timeZone,
    language: c.language,
    studentProfile: kind === 'student' ? studentProfileOf(enquiry.student) : undefined,
  };
}

export function studentProfileOf(student) {
  if (!student) return undefined;
  const profile = {};
  if (student.grade) profile.grade = String(student.grade).slice(0, 40);
  if (student.board) profile.board = String(student.board).slice(0, 60);
  if (student.school) profile.school = String(student.school).slice(0, 200);
  if (student.targetExam) profile.targetExam = String(student.targetExam).slice(0, 100);
  return Object.keys(profile).length ? profile : undefined;
}

/**
 * Add the enquiry to an existing person: new phones and emails (primary only where they have
 * none), blanks filled, the company link ensured. History stays where it is. Follows merges.
 * @returns {Promise<{ contact: object, linkCreated: boolean, addedMethods: number } | null>} null when the person was erased
 */
export async function attachToContact(trx, contactId, person, ctx) {
  const { groupId, companyId, unitId, ownerUserId = null, source = null, defaultCountry = 'IN', actorUserId = null, req = null, keepName = false } = ctx;
  let contact = await trx('contacts').where({ id: contactId }).forUpdate().first();
  for (let hops = 0; contact?.merged_into_id && hops < 5; hops += 1) {
    contact = await trx('contacts').where({ id: contact.merged_into_id }).forUpdate().first();
  }
  if (!contact || contact.erased_at || contact.group_id !== groupId) return null;

  const { methods: incoming } = normalizeMethods(person, { defaultCountry });
  const keys = [...new Set(incoming.map((m) => m.normalized))].sort();
  if (keys.length) {
    await trx.raw('select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(?::text[]) as k order by k', [
      keys.map((key) => `crm.contact:${groupId}:${key}`),
    ]);
  }
  const existing = await trx('contact_methods').where({ contact_id: contact.id }).select('kind', 'normalized', 'is_primary');
  const have = new Set(existing.map((m) => `${m.kind}:${m.normalized}`));
  const hasPrimary = Object.fromEntries(existing.filter((m) => m.is_primary).map((m) => [m.kind, true]));
  const fresh = assignPrimaries(incoming.filter((m) => !have.has(`${m.kind}:${m.normalized}`)), { hasPrimary });
  let addedMethods = 0;
  if (fresh.length) {
    const inserted = await trx('contact_methods')
      .insert(fresh.map((m) => ({ id: randomUUID(), contact_id: contact.id, group_id: groupId, kind: m.kind, value: m.value, normalized: m.normalized, label: m.label ?? null, is_primary: m.isPrimary })))
      .onConflict(['contact_id', 'kind', 'normalized'])
      .ignore()
      .returning('id');
    addedMethods = inserted.length;
  }
  const details = keepName ? { ...person, firstName: undefined, lastName: undefined, kind: undefined } : person;
  const changes = fillBlanks(contact, details);
  if (!contact.primary_phone && primaryPhoneOf(fresh)) changes.primary_phone = primaryPhoneOf(fresh);
  if (!contact.primary_email && primaryEmailOf(fresh)) changes.primary_email = primaryEmailOf(fresh);
  if (changes.first_name !== undefined) {
    const name = displayName(changes.first_name, changes.last_name ?? contact.last_name);
    changes.display_name = name;
    changes.name_normalized = normalizeName(name);
  }
  if (changes.student_profile) changes.student_profile = json(changes.student_profile);
  const changed = Object.keys(changes);
  if (changed.length) [contact] = await trx('contacts').where({ id: contact.id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');

  const [insertedLink] = await trx('contact_companies')
    .insert({
      id: randomUUID(),
      contact_id: contact.id,
      group_id: groupId,
      company_id: companyId,
      unit_id: unitId,
      owner_user_id: ownerUserId,
      status: 'lead',
      source: source ? json(source) : null,
      tags: [],
      created_by: actorUserId,
    })
    .onConflict(['contact_id', 'company_id'])
    .ignore()
    .returning('*');
  const link = insertedLink ?? (await trx('contact_companies').where({ contact_id: contact.id, company_id: companyId }).first());
  if (insertedLink || changed.length || addedMethods) await refreshSearchDocument(trx, 'contact', contact.id);
  if (insertedLink) {
    await addTimelineEvent(trx, {
      groupId,
      companyId,
      unitId: link.unit_id,
      contactId: contact.id,
      kind: 'system',
      title: 'Contact added to this company',
      meta: { action: 'contact.company_linked', channel: source?.channel ?? null },
      actorType: actorUserId ? 'user' : 'system',
      actorUserId,
    });
  }
  const event = insertedLink ? 'contact.company_linked' : changed.length || addedMethods ? 'contact.updated' : null;
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
        matchedBy: 'intake',
        changes: event === 'contact.updated' ? [...changed, ...(addedMethods ? ['methods'] : [])] : undefined,
        source: source?.channel ? { channel: source.channel } : null,
      },
    });
    await writeAudit(trx, req, {
      action: event === 'contact.company_linked' ? 'contact.linked' : 'contact.updated',
      entityType: 'contact',
      entityId: contact.id,
      unit: { id: link.unit_id, root_id: groupId },
      actorType: actorUserId ? 'user' : 'system',
      after: { companyId, matchedBy: 'intake', changed: [...changed, ...(addedMethods ? ['methods'] : [])] },
    });
  }
  return { contact, linkCreated: Boolean(insertedLink), addedMethods };
}

/** Create the person (no matching: dedup already decided they are new or only possibly known). */
export async function createContact(trx, person, ctx) {
  const result = await findOrCreateContact(
    trx,
    {
      ...person,
      groupId: ctx.groupId,
      companyId: ctx.companyId,
      unitId: ctx.unitId,
      ownerUserId: ctx.ownerUserId ?? null,
      source: ctx.source ?? null,
      actorUserId: ctx.actorUserId ?? null,
      actorType: ctx.actorUserId ? 'user' : 'system',
      defaultCountry: ctx.defaultCountry,
      mode: 'create',
      invalidMethods: 'skip',
    },
    { req: ctx.req ?? null },
  );
  return { contact: result.contact, linkCreated: result.linkCreated, addedMethods: result.addedMethods };
}

/**
 * The learner of a family enquiry: a student already in one of the parent's households with
 * the same name (compareNames ≥ 0.85), else a new student contact.
 */
export async function resolveStudent(trx, { parentId, name, profile }, ctx) {
  if (!name) return null;
  if (parentId) {
    const siblings = await trx('household_members as mine')
      .join('household_members as hm', 'hm.household_id', 'mine.household_id')
      .join('contacts as c', 'c.id', 'hm.contact_id')
      .where('mine.contact_id', parentId)
      .where('hm.role', 'student')
      .whereNull('c.merged_into_id')
      .whereNull('c.erased_at')
      .select('c.id', 'c.display_name');
    const match = siblings
      .map((s) => ({ id: s.id, score: compareNames(name, s.display_name).score }))
      .filter((s) => s.score >= 0.85)
      .sort((a, b) => b.score - a.score)[0];
    if (match) {
      await trx('contact_companies')
        .insert({ id: randomUUID(), contact_id: match.id, group_id: ctx.groupId, company_id: ctx.companyId, unit_id: ctx.unitId, owner_user_id: ctx.ownerUserId ?? null, status: 'lead', source: ctx.source ? json(ctx.source) : null, tags: [], created_by: ctx.actorUserId ?? null })
        .onConflict(['contact_id', 'company_id'])
        .ignore();
      return match.id;
    }
  }
  const names = splitFullName(name);
  const { contact } = await createContact(trx, { kind: 'student', firstName: names.firstName, lastName: names.lastName ?? undefined, phones: [], emails: [], studentProfile: profile }, ctx);
  return contact.id;
}
