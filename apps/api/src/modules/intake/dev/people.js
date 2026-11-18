import { randomUUID } from 'node:crypto';
import { json } from '../../../lib/db.js';
import { emitEvent } from '../../../core/events.js';
import { writeAudit } from '../../../core/audit.js';
import { addTimelineEvent } from '../../../core/crm/timeline.js';
import { refreshSearchDocument, refreshSearchDocuments, removeSearchDocument } from '../../../core/crm/search.js';
import { normalizeDomain, normalizeName, isFreeEmailDomain, emailDomain } from '../../../core/crm/normalize.js';

// DEVELOPMENT AND TEST implementations of the intake accounts and contacts ports, written
// against the phase 2 contract's tables. ports.js refuses them in production.
//
// TODO(integrator): connect the real services at start-up:
//   connectIntakePorts({
//     accounts: { findOrCreateAccount: accountsService.findOrCreateAccount },        // modules/accounts/service.js (§9.2)
//     contacts: { mergeContacts: contactsService.mergeContacts,                      // modules/contacts/service.js (§9.1)
//                 recordConsent: contactsService.recordConsent },                    // the POST /contacts/:id/consents writer
//   })

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', voice: 'Call', all: 'All channels' };

/**
 * Match an institute in the group by domain, else by normalised name and city (contract §9.2), or
 * create it; make sure the company knows it; add the enquirer as one of its people.
 */
export async function findOrCreateAccount(trx, input) {
  const { groupId, companyId, unitId, actorUserId = null } = input;
  const nameNormalized = normalizeName(input.name);
  const fromEmail = input.email ? emailDomain(input.email) : null;
  const domain = normalizeDomain(input.website ?? '') ?? (fromEmail && !isFreeEmailDomain(fromEmail) ? fromEmail : null);
  await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [`crm.account:${groupId}:${domain ?? nameNormalized}`]);

  let account = null;
  if (domain) account = await trx('accounts').where({ group_id: groupId, domain }).whereNull('merged_into_id').first();
  if (!account) {
    account = await trx('accounts')
      .where({ group_id: groupId, name_normalized: nameNormalized })
      .whereNull('merged_into_id')
      .modify((q) => (input.city ? q.whereRaw('lower(city) = lower(?)', [input.city]) : q.whereNull('city')))
      .first();
  }
  let created = false;
  if (!account) {
    [account] = await trx('accounts')
      .insert({
        id: randomUUID(),
        group_id: groupId,
        kind: input.kind ?? 'other',
        name: input.name,
        name_normalized: nameNormalized,
        website: input.website ?? null,
        domain,
        city: input.city ?? null,
        student_count: input.studentCount ?? null,
        created_by: actorUserId,
      })
      .returning('*');
    created = true;
  }
  const [insertedLink] = await trx('account_companies')
    .insert({
      id: randomUUID(),
      account_id: account.id,
      group_id: groupId,
      company_id: companyId,
      unit_id: unitId,
      owner_user_id: input.ownerUserId ?? null,
      status: 'lead',
      source: input.source ? json(input.source) : null,
      tags: [],
      created_by: actorUserId,
    })
    .onConflict(['account_id', 'company_id'])
    .ignore()
    .returning('*');
  if (input.contactId) {
    await trx('account_contacts')
      .insert({ account_id: account.id, contact_id: input.contactId, role: 'other', is_primary: false })
      .onConflict(['account_id', 'contact_id'])
      .ignore();
  }
  if (created || insertedLink) {
    await refreshSearchDocument(trx, 'account', account.id);
    await addTimelineEvent(trx, {
      groupId,
      companyId,
      unitId,
      accountId: account.id,
      kind: 'system',
      title: created ? 'Institute added' : 'Institute added to this company',
      meta: { action: created ? 'account.created' : 'account.company_linked' },
      actorType: actorUserId ? 'user' : 'system',
      actorUserId,
    });
    await emitEvent(trx, {
      type: created ? 'account.created' : 'account.company_linked',
      groupId,
      unitId,
      aggregateType: 'account',
      aggregateId: account.id,
      actorUserId,
      payload: { accountId: account.id, companyId, unitId, kind: account.kind, matchedBy: created ? null : domain && account.domain === domain ? 'domain' : 'name' },
    });
  }
  return { account, created, linkCreated: Boolean(insertedLink) };
}

/** Append a consent record (contract §5.12) with its timeline entry and event. */
export async function recordConsent(trx, { groupId, companyId, unitId, contactId, channel, purpose, status, source, evidence = {}, capturedAt, actorUserId = null }) {
  const [row] = await trx('consents')
    .insert({
      id: randomUUID(),
      group_id: groupId,
      contact_id: contactId,
      company_id: companyId,
      channel,
      purpose,
      status,
      source,
      evidence: json(evidence),
      captured_at: capturedAt ?? new Date(),
      captured_by: actorUserId,
    })
    .returning('*');
  await addTimelineEvent(trx, {
    groupId,
    companyId,
    unitId,
    contactId,
    kind: 'system',
    title: `${CHANNEL_LABELS[channel] ?? channel} ${purpose} consent ${status}`,
    meta: { action: 'consent.recorded', consentId: row.id, channel, purpose, status, source },
    actorType: actorUserId ? 'user' : 'system',
    actorUserId,
  });
  await emitEvent(trx, {
    type: 'consent.recorded',
    groupId,
    unitId,
    aggregateType: 'contact',
    aggregateId: contactId,
    actorUserId,
    payload: { consentId: row.id, contactId, companyId, channel, purpose, status, source },
  });
  return row;
}

const FILLABLE = ['first_name', 'last_name', 'display_name', 'name_normalized', 'primary_phone', 'primary_email', 'date_of_birth', 'city', 'country_code', 'time_zone', 'language'];

/**
 * Merge `sourceId` into `targetId` keeping all history (contract §9.1 POST /contacts/:id/merge).
 * The caller has checked both are visible and mergeable.
 */
export async function mergeContacts(trx, { targetId, sourceId }, { req = null } = {}) {
  const locked = await trx('contacts').whereIn('id', [targetId, sourceId]).orderBy('id').forUpdate();
  const target = locked.find((c) => c.id === targetId);
  const source = locked.find((c) => c.id === sourceId);
  const fill = {};
  for (const key of FILLABLE) {
    if ((target[key] === null || target[key] === '' || (key === 'display_name' && target.display_name === 'Unnamed contact')) && source[key]) fill[key] = source[key];
  }
  if (fill.display_name && !fill.name_normalized) fill.name_normalized = source.name_normalized;
  if (Object.keys(fill).length) await trx('contacts').where({ id: target.id }).update({ ...fill, updated_at: trx.fn.now() });

  // Methods: move the ones the target doesn't have; primaries only where the target has none.
  const targetMethods = await trx('contact_methods').where({ contact_id: target.id });
  const have = new Set(targetMethods.map((m) => `${m.kind}:${m.normalized}`));
  const primaryKinds = new Set(targetMethods.filter((m) => m.is_primary).map((m) => m.kind));
  for (const method of await trx('contact_methods').where({ contact_id: source.id })) {
    if (have.has(`${method.kind}:${method.normalized}`)) continue;
    const isPrimary = method.is_primary && !primaryKinds.has(method.kind);
    if (isPrimary) primaryKinds.add(method.kind);
    await trx('contact_methods').where({ id: method.id }).update({ contact_id: target.id, is_primary: isPrimary, updated_at: trx.fn.now() });
  }
  await trx('contact_methods').where({ contact_id: source.id }).delete();

  // Company links: keep the target's in a shared company (union tags, earliest first seen).
  const companyIds = [];
  const targetLinks = new Map((await trx('contact_companies').where({ contact_id: target.id })).map((l) => [l.company_id, l]));
  for (const link of await trx('contact_companies').where({ contact_id: source.id })) {
    companyIds.push(link.company_id);
    const kept = targetLinks.get(link.company_id);
    if (!kept) {
      await trx('contact_companies').where({ id: link.id }).update({ contact_id: target.id, updated_at: trx.fn.now() });
      continue;
    }
    await trx('contact_companies')
      .where({ id: kept.id })
      .update({
        tags: [...new Set([...(kept.tags ?? []), ...(link.tags ?? [])])],
        owner_user_id: kept.owner_user_id ?? link.owner_user_id,
        source: kept.source ? json(kept.source) : link.source ? json(link.source) : null,
        first_seen_at: kept.first_seen_at && link.first_seen_at && link.first_seen_at < kept.first_seen_at ? link.first_seen_at : kept.first_seen_at ?? link.first_seen_at,
        custom: json({ ...(link.custom ?? {}), ...(kept.custom ?? {}) }),
        updated_at: trx.fn.now(),
      });
    await trx('contact_companies').where({ id: link.id }).delete();
  }

  // Memberships and participations, dropping duplicates.
  await trx.raw(
    `insert into household_members (household_id, contact_id, role, relation, is_primary, created_at)
     select household_id, ?, role, relation, is_primary, created_at from household_members where contact_id = ?
     on conflict (household_id, contact_id) do nothing`,
    [target.id, source.id],
  );
  await trx('household_members').where({ contact_id: source.id }).delete();
  await trx.raw(
    `insert into account_contacts (account_id, contact_id, title, role, is_primary, created_at, updated_at)
     select account_id, ?, title, role, is_primary, created_at, now() from account_contacts where contact_id = ?
     on conflict (account_id, contact_id) do nothing`,
    [target.id, source.id],
  );
  await trx('account_contacts').where({ contact_id: source.id }).delete();
  await trx.raw(
    `insert into deal_contacts (deal_id, contact_id, role, created_at)
     select deal_id, ?, role, created_at from deal_contacts where contact_id = ?
     on conflict (deal_id, contact_id) do nothing`,
    [target.id, source.id],
  );
  await trx('deal_contacts').where({ contact_id: source.id }).delete();
  const dealIds = await trx('deals').where({ primary_contact_id: source.id }).pluck('id');
  await trx('deals').where({ primary_contact_id: source.id }).update({ primary_contact_id: target.id, updated_at: trx.fn.now() });
  await trx('tasks').where({ contact_id: source.id }).update({ contact_id: target.id });
  await trx('consents').where({ contact_id: source.id }).update({ contact_id: target.id });
  await trx('timeline_events').where({ contact_id: source.id }).update({ contact_id: target.id });
  await trx('timeline_events_archive').where({ contact_id: source.id }).update({ contact_id: target.id });
  await trx('intake_enquiries').where({ contact_id: source.id }).update({ contact_id: target.id });

  await trx('contacts').where({ id: source.id }).update({ merged_into_id: target.id, merged_at: trx.fn.now(), updated_at: trx.fn.now() });
  await removeSearchDocument(trx, 'contact', source.id);
  await refreshSearchDocument(trx, 'contact', target.id);
  const participantDeals = await trx('deal_contacts').where({ contact_id: target.id }).pluck('deal_id');
  await refreshSearchDocuments(trx, 'deal', [...dealIds, ...participantDeals]);

  const actorUserId = req?.auth?.user?.id ?? null;
  const link = targetLinks.values().next().value;
  await addTimelineEvent(trx, {
    groupId: target.group_id,
    contactId: target.id,
    kind: 'system',
    title: `Merged with ${source.display_name}`,
    meta: { action: 'contact.merged', sourceId: source.id },
    actorType: actorUserId ? 'user' : 'system',
    actorUserId,
  });
  await emitEvent(trx, {
    type: 'contact.merged',
    groupId: target.group_id,
    unitId: link?.unit_id ?? null,
    aggregateType: 'contact',
    aggregateId: target.id,
    actorUserId,
    payload: { targetId: target.id, sourceId: source.id, companyIds: [...new Set([...companyIds, ...targetLinks.keys()])] },
  });
  await writeAudit(trx, req, {
    action: 'contact.merged',
    entityType: 'contact',
    entityId: target.id,
    unit: link ? { id: link.unit_id, root_id: target.group_id } : { id: target.group_id, root_id: target.group_id },
    after: { sourceId: source.id, filled: Object.keys(fill) },
  });
  return trx('contacts').where({ id: target.id }).first();
}
