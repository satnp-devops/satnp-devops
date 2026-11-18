import { minorFromDb } from '../../core/crm/money.js';

/**
 * Subjects and events as flows see them.
 *
 * `record` in expressions and templates is the run's subject, loaded fresh before every advance.
 * It never carries personal data (phones, emails, dates of birth, addresses): executors that need
 * a phone number (messaging) look it up themselves with consent checks.
 */

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

/** The subject an outbox event is about: the deal first, then a contact or institute. */
export function subjectOf(event) {
  const payload = event?.payload ?? {};
  if (event?.subject?.type && event.subject.id) return event.subject;
  if (event?.aggregateType === 'deal' && event.aggregateId) return { type: 'deal', id: String(event.aggregateId) };
  if (typeof payload.dealId === 'string') return { type: 'deal', id: payload.dealId };
  if (event?.aggregateType === 'contact' && event.aggregateId) return { type: 'contact', id: String(event.aggregateId) };
  if (typeof payload.contactId === 'string') return { type: 'contact', id: payload.contactId };
  if (event?.aggregateType === 'account' && event.aggregateId) return { type: 'account', id: String(event.aggregateId) };
  return null;
}

/** A deal row (with the joins below) → record. */
export function presentDealRecord(row) {
  return {
    type: 'deal',
    id: row.id,
    ref: row.ref,
    title: row.title,
    name: row.contact_name ?? row.account_name ?? row.title,
    kind: row.kind,
    status: row.status,
    stage: row.stage_key ?? null,
    stageName: row.stage_name ?? null,
    stageCategory: row.stage_category ?? null,
    pipeline: row.pipeline_key ?? null,
    pipelineId: row.pipeline_id,
    productLine: row.product_line_key ?? null,
    productLineName: row.product_line_name ?? null,
    ownerId: row.owner_user_id ?? null,
    ownerName: row.owner_name ?? null,
    unitId: row.unit_id,
    companyId: row.company_id,
    groupId: row.group_id,
    channel: row.channel,
    valueMinor: minorFromDb(row.value_minor),
    currency: row.currency,
    tags: row.tags ?? [],
    custom: row.custom ?? {},
    nurture: row.nurture === true,
    lostReason: row.lost_reason_label ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastActivityAt: iso(row.last_activity_at),
    stageEnteredAt: iso(row.stage_entered_at),
    expectedCloseOn: row.expected_close_on instanceof Date ? row.expected_close_on.toISOString().slice(0, 10) : row.expected_close_on ?? null,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    contact: row.primary_contact_id
      ? { id: row.primary_contact_id, name: row.contact_name, firstName: row.contact_first_name ?? null, kind: row.contact_kind, city: row.contact_city ?? null }
      : null,
    account: row.account_id ? { id: row.account_id, name: row.account_name, kind: row.account_kind ?? null } : null,
  };
}

/** One query for any number of deals. @returns {Promise<Map<string, object>>} */
export async function loadDealRecords(trx, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await trx('deals as d')
    .leftJoin('pipeline_stages as s', 's.id', 'd.stage_id')
    .leftJoin('pipelines as p', 'p.id', 'd.pipeline_id')
    .leftJoin('product_lines as pl', 'pl.id', 'd.product_line_id')
    .leftJoin('contacts as c', 'c.id', 'd.primary_contact_id')
    .leftJoin('accounts as a', 'a.id', 'd.account_id')
    .leftJoin('users as u', 'u.id', 'd.owner_user_id')
    .leftJoin('lost_reasons as lr', 'lr.id', 'd.lost_reason_id')
    .whereIn('d.id', unique)
    .select(
      'd.id', 'd.group_id', 'd.company_id', 'd.unit_id', 'd.ref', 'd.title', 'd.kind', 'd.status', 'd.pipeline_id',
      'd.owner_user_id', 'd.channel', 'd.value_minor', 'd.currency', 'd.tags', 'd.custom', 'd.nurture', 'd.created_at',
      'd.updated_at', 'd.last_activity_at', 'd.stage_entered_at', 'd.expected_close_on', 'd.archived_at',
      'd.primary_contact_id', 'd.account_id',
      's.key as stage_key', 's.name as stage_name', 's.category as stage_category', 'p.key as pipeline_key',
      'pl.key as product_line_key', 'pl.name as product_line_name',
      'c.display_name as contact_name', 'c.first_name as contact_first_name', 'c.kind as contact_kind', 'c.city as contact_city',
      'a.name as account_name', 'a.kind as account_kind', 'u.name as owner_name', 'lr.label as lost_reason_label',
    );
  return new Map(rows.map((row) => [row.id, presentDealRecord(row)]));
}

async function loadContactRecords(trx, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await trx('contacts').whereIn('id', unique).select('id', 'group_id', 'kind', 'display_name', 'first_name', 'city', 'language', 'created_at', 'updated_at');
  return new Map(
    rows.map((row) => [
      row.id,
      { type: 'contact', id: row.id, groupId: row.group_id, name: row.display_name, firstName: row.first_name, kind: row.kind, city: row.city, language: row.language, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) },
    ]),
  );
}

/**
 * Records for many subjects, one query per subject type.
 * @param {{ type: string, id: string }[]} subjects
 * @returns {Promise<Map<string, object>>} keyed by `${type}:${id}`
 */
export async function loadRecords(trx, subjects) {
  const byType = { deal: [], contact: [] };
  for (const subject of subjects) if (subject && byType[subject.type]) byType[subject.type].push(subject.id);
  const [deals, contacts] = await Promise.all([loadDealRecords(trx, byType.deal), loadContactRecords(trx, byType.contact)]);
  const out = new Map();
  for (const [id, record] of deals) out.set(`deal:${id}`, record);
  for (const [id, record] of contacts) out.set(`contact:${id}`, record);
  return out;
}

export async function loadRecord(trx, subject) {
  if (!subject) return null;
  return (await loadRecords(trx, [subject])).get(`${subject.type}:${subject.id}`) ?? null;
}

/**
 * An outbox event (ARCHITECTURE §9) → the engine's event shape: `subject`, and stage keys next
 * to stage ids (triggers and filters compare keys, which read better and survive copying a flow
 * between companies): deal.stage_changed gains fromStage / toStage, deal.created / won / lost /
 * reopened gain stage. One query, only for deal events with stage ids.
 */
export async function toFlowEvent(trx, event) {
  const payload = { ...(event.payload ?? {}) };
  const stageIds = ['fromStageId', 'toStageId', 'stageId'].map((k) => payload[k]).filter((v) => typeof v === 'string');
  if (stageIds.length > 0 && event.type.startsWith('deal.')) {
    const rows = await trx('pipeline_stages').whereIn('id', [...new Set(stageIds)]).select('id', 'key');
    const keyOf = new Map(rows.map((r) => [r.id, r.key]));
    if (payload.fromStageId !== undefined) payload.fromStage = keyOf.get(payload.fromStageId) ?? null;
    if (payload.toStageId !== undefined) payload.toStage = keyOf.get(payload.toStageId) ?? null;
    if (payload.stageId !== undefined) payload.stage = keyOf.get(payload.stageId) ?? null;
  }
  return {
    id: event.id != null ? String(event.id) : undefined,
    type: event.type,
    occurredAt: event.occurredAt ?? null,
    subject: subjectOf(event),
    payload,
    groupId: event.groupId ?? null,
    unitId: event.unitId ?? null,
    actorUserId: event.actorUserId ?? null,
  };
}

/** A made-up deal for the test panel when no real deal is picked. */
export function sampleDealRecord({ companyId, unitId } = {}) {
  return {
    type: 'deal',
    id: '6f1c7a52-3d6e-4f3a-9a51-2b8e7c1d9e01',
    ref: 'SP-1042',
    title: 'Priya Sharma – SAT group batches',
    name: 'Priya Sharma',
    kind: 'b2c',
    status: 'open',
    stage: 'new_enquiry',
    stageName: 'New enquiry',
    stageCategory: 'open',
    pipeline: 'admissions',
    pipelineId: 'a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c04',
    productLine: 'sat_group_batch',
    productLineName: 'SAT group batches',
    ownerId: '9d2e5f7a-1b3c-4d6e-8f9a-0b1c2d3e4f03',
    ownerName: 'Ritika Sharma',
    unitId: unitId ?? null,
    companyId: companyId ?? null,
    groupId: null,
    channel: 'whatsapp',
    valueMinor: 8500000,
    currency: 'INR',
    tags: ['sat-2027'],
    custom: { grade: '11', target_exam: 'sat' },
    nurture: false,
    lostReason: null,
    createdAt: '2026-11-05T04:00:00.000Z',
    updatedAt: '2026-11-05T04:00:00.000Z',
    lastActivityAt: '2026-11-05T04:00:00.000Z',
    stageEnteredAt: '2026-11-05T04:00:00.000Z',
    expectedCloseOn: null,
    archived: false,
    contact: { id: '0b6c4e8a-7f21-4c55-8d0e-5a9b3c2d1e02', name: 'Priya Sharma', firstName: 'Priya', kind: 'parent', city: 'Pune' },
    account: null,
  };
}
