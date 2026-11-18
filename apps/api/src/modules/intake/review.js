import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { getSetting } from '../../core/settings.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { listScope, unitsIndex } from '../../core/crm/scope.js';
import { defaultCountrySetting } from '../../core/crm/settings.js';
import { port } from './ports.js';
import { processRouted } from './service.js';

// The review queue: routing decisions the classifier wasn't sure about, possible duplicates, and
// (placeholder for the AI slice) extraction results to check.
//
// Scoping: an item with a company (duplicates, extraction) is visible to people holding
// intake.review at its unit. A routing item has no company yet: it is visible to people holding
// intake.review at the group, or at one of the companies it may belong to (candidate_company_ids,
// at the company unit itself: routing is a company-level decision). Anything else is 404.

/** The working scope's reviewer view: units for company items, companies for routing items. */
export function reviewScope(scope, unitsById) {
  const groupWide = scope.allUnitIds.includes(scope.groupId) && !scope.company;
  const companyIds = scope.allUnitIds.filter((id) => unitsById.get(id)?.type === 'company' && (!scope.company || id === scope.company.id));
  return { ...scope, groupWide, companyIds };
}

export function applyReviewScope(query, rs, alias = 'r') {
  const col = (c) => `${alias}.${c}`;
  query.where(col('group_id'), rs.groupId);
  return query.where((w) => {
    w.where((dup) => {
      dup.whereNotNull(col('company_id'));
      if (rs.company) dup.where(col('company_id'), rs.company.id);
      if (rs.allUnitIds.length) dup.whereIn(col('unit_id'), rs.allUnitIds);
      else dup.whereRaw('false');
    });
    w.orWhere((rt) => {
      rt.whereNull(col('company_id'));
      if (rs.groupWide) return;
      if (rs.companyIds.length) rt.whereRaw(`${col('candidate_company_ids')} && ?::uuid[]`, [rs.companyIds]);
      else rt.whereRaw('false');
    });
  });
}

/** Can this user act on one item (pure)? */
export function canReview(access, unitsById, item) {
  if (item.company_id) {
    const unit = unitsById.get(item.unit_id ?? item.company_id);
    return Boolean(unit && access.can('intake.review', unit.path));
  }
  const group = unitsById.get(item.group_id);
  if (group && access.can('intake.review', group.path)) return true;
  return (item.candidate_company_ids ?? []).some((id) => {
    const company = unitsById.get(id);
    return company && access.can('intake.review', company.path);
  });
}

/** One page of the queue. */
export async function listReviewItems(req, query) {
  const scope = await listScope(req, 'intake.review', { unitId: query.unitId });
  const index = await unitsIndex(req);
  const rs = reviewScope(scope, index);
  const q = applyReviewScope(db('intake_review_items as r'), rs)
    .join('intake_enquiries as e', 'e.id', 'r.enquiry_id')
    .where('r.status', query.status)
    .select('r.*', 'e.enquiry as enquiry_data', 'e.channel_type', 'e.channel_identity', 'e.deal_channel', 'e.received_at', 'e.status as enquiry_status');
  if (query.kind) q.where('r.kind', query.kind);
  const cursor = decodeCursor(query.cursor);
  if (cursor) q.whereRaw('(r.created_at, r.id) < (?, ?)', [cursor.v, cursor.id]);
  const rows = await q.orderBy([{ column: 'r.created_at', order: 'desc' }, { column: 'r.id', order: 'desc' }]).limit(query.limit + 1);
  return { ...pageOf(rows, query.limit, (r) => ({ v: new Date(r.created_at).toISOString(), id: r.id })), index };
}

/** Counts per kind for the tab badges (open items only, grouped once). */
export async function reviewCounts(req, unitId) {
  const scope = await listScope(req, 'intake.review', { unitId });
  const index = await unitsIndex(req);
  const rows = await applyReviewScope(db('intake_review_items as r'), reviewScope(scope, index)).where('r.status', 'open').groupBy('r.kind').select('r.kind').count({ count: '*' });
  const counts = { routing: 0, duplicate: 0, extraction: 0 };
  for (const r of rows) counts[r.kind] = Number(r.count);
  return counts;
}

/** Load an item the user may review, locked. 404 outside scope. */
export async function loadReviewItem(trx, req, id) {
  const item = await trx('intake_review_items').where({ id }).forUpdate().first();
  const index = await unitsIndex(req, trx);
  if (!item || !canReview(req.access, index, item)) throw errors.notFound('Review item');
  return { item, index };
}

async function closeItem(trx, req, item, { resolution, note, extra = {} }) {
  const [updated] = await trx('intake_review_items')
    .where({ id: item.id })
    .update({ status: 'resolved', resolution, resolution_note: note ?? null, resolved_by: req.auth.user.id, resolved_at: trx.fn.now(), updated_at: trx.fn.now(), ...extra })
    .returning('*');
  await emitEvent(trx, {
    type: 'intake.review_resolved',
    groupId: item.group_id,
    unitId: updated.unit_id ?? null,
    aggregateType: 'intake_review',
    aggregateId: item.id,
    actorUserId: req.auth.user.id,
    payload: { reviewId: item.id, enquiryId: item.enquiry_id, kind: item.kind, resolution, companyId: updated.company_id ?? null, contactId: item.contact_id ?? null, candidateContactId: item.candidate_contact_id ?? null },
  });
  await writeAudit(trx, req, {
    action: 'intake.review_resolved',
    entityType: 'intake_review',
    entityId: item.id,
    unit: { id: updated.unit_id ?? updated.company_id ?? item.group_id, root_id: item.group_id },
    after: { kind: item.kind, resolution, companyId: updated.company_id ?? null },
  });
  return updated;
}

/**
 * Resolve an item.
 *   routing:    approve (the suggestion) | override (body.companyId) | discard (spam, not a lead)
 *   duplicate:  merge (same person: the new contact is merged into the existing one) | keep_separate | dismiss
 *   extraction: approve | dismiss (placeholder for the AI slice, which acts on intake.review_resolved)
 */
export async function resolveReviewItem(req, id, body) {
  const registry = req.app.locals.registry;
  return db.transaction(async (trx) => {
    const { item, index } = await loadReviewItem(trx, req, id);
    if (item.status !== 'open') throw errors.conflict('This item has already been resolved');
    const enquiryRow = await trx('intake_enquiries').where({ id: item.enquiry_id }).forUpdate().first();

    if (item.kind === 'routing') {
      if (!['approve', 'override', 'discard'].includes(body.action)) throw errors.validation([{ path: 'body.action', message: 'Approve, override or discard a routing decision' }]);
      if (body.action === 'discard') {
        await trx('intake_enquiries').where({ id: enquiryRow.id }).update({ status: 'discarded', updated_at: trx.fn.now() });
        return { item: await closeItem(trx, req, item, { resolution: 'discarded', note: body.note }), result: null };
      }
      const companyId = body.action === 'override' ? body.companyId : item.suggestion?.companyId;
      if (!companyId) throw errors.validation([{ path: 'body.companyId', message: 'Pick the company this enquiry belongs to' }]);
      const company = index.get(companyId);
      if (!company || company.type !== 'company' || company.root_id !== item.group_id) throw errors.validation([{ path: 'body.companyId', message: 'Pick a company of this group' }]);
      if (!req.access.can('intake.review', company.path)) throw errors.forbidden('You can only route enquiries to companies where you review intake');
      const productLineId = body.action === 'override' ? body.productLineId ?? null : item.suggestion?.productLineId ?? null;
      if (productLineId) {
        const line = await trx('product_lines').where({ id: productLineId, company_id: company.id }).first('id');
        if (!line) throw errors.validation([{ path: 'body.productLineId', message: 'Pick a product line of that company' }]);
      }
      const defaultCountry = await getSetting(company, defaultCountrySetting, trx);
      const routing = { ...(enquiryRow.routing ?? {}), decision: 'route', companyId: company.id, productLineId, confidence: 1, reason: 'reviewed', message: `Routed by a reviewer (${body.action})`, unitId: null };
      const options = enquiryRow.ingest_options ?? {};
      const result = await processRouted(
        trx,
        { row: enquiryRow, enquiry: enquiryRow.enquiry, routing, input: { audience: options.audience, evidence: options.evidence }, dealChannel: enquiryRow.deal_channel, defaultCountry },
        { req, registry, actorUserId: req.auth.user.id },
      );
      const updated = await closeItem(trx, req, item, { resolution: body.action === 'override' ? 'overridden' : 'approved', note: body.note, extra: { company_id: company.id, unit_id: (await trx('deals').where({ id: result.dealId }).first('unit_id'))?.unit_id ?? company.id, deal_id: result.dealId, contact_id: result.contactId } });
      return { item: updated, result };
    }

    if (item.kind === 'duplicate') {
      if (!['merge', 'keep_separate', 'dismiss'].includes(body.action)) throw errors.validation([{ path: 'body.action', message: 'Merge, keep separate or dismiss a possible duplicate' }]);
      if (body.action === 'merge') {
        const unit = index.get(item.unit_id);
        if (!unit || !req.access.can('contacts.merge', unit.path)) throw errors.forbidden('Merging people needs the merge permission here');
        const locked = await trx('contacts').whereIn('id', [item.contact_id, item.candidate_contact_id]).orderBy('id').forUpdate();
        const newer = locked.find((c) => c.id === item.contact_id);
        const existing = locked.find((c) => c.id === item.candidate_contact_id);
        if (!newer || !existing || newer.merged_into_id || existing.merged_into_id || newer.erased_at || existing.erased_at) throw errors.conflict('One of these people was merged or erased since; refresh the queue');
        await port('contacts').mergeContacts(trx, { targetId: existing.id, sourceId: newer.id }, { req });
        // Other suggestions for the merged person are settled by this decision.
        await trx('intake_review_items')
          .where({ kind: 'duplicate', status: 'open', contact_id: newer.id })
          .whereNot({ id: item.id })
          .update({ status: 'resolved', resolution: 'dismissed', resolution_note: 'Merged with another person', resolved_by: req.auth.user.id, resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
        await trx('intake_enquiries').where({ id: item.enquiry_id }).update({ contact_id: existing.id, updated_at: trx.fn.now() });
        return { item: await closeItem(trx, req, item, { resolution: 'merged', note: body.note }), result: { contactId: existing.id } };
      }
      if (body.action === 'keep_separate') {
        const [a, b] = [item.contact_id, item.candidate_contact_id].sort();
        if (a && b) await trx('intake_not_duplicates').insert({ group_id: item.group_id, contact_a: a, contact_b: b, created_by: req.auth.user.id }).onConflict(['contact_a', 'contact_b']).ignore();
      }
      return { item: await closeItem(trx, req, item, { resolution: body.action === 'keep_separate' ? 'kept_separate' : 'dismissed', note: body.note }), result: null };
    }

    if (!['approve', 'dismiss'].includes(body.action)) throw errors.validation([{ path: 'body.action', message: 'Approve or dismiss the extracted details' }]);
    return { item: await closeItem(trx, req, item, { resolution: body.action === 'approve' ? 'approved' : 'dismissed', note: body.note }), result: null };
  });
}

/**
 * For the AI slice: queue extracted details for a person to check (placeholder kind).
 * Call inside the transaction that stores the extraction.
 */
export async function queueExtractionReview(trx, { enquiryId, dealId = null, confidence = null, fields = {}, message = null }) {
  const enquiry = await trx('intake_enquiries').where({ id: enquiryId }).first();
  if (!enquiry) throw errors.notFound('Enquiry');
  const [item] = await trx('intake_review_items')
    .insert({
      group_id: enquiry.group_id,
      company_id: enquiry.company_id,
      unit_id: enquiry.unit_id,
      kind: 'extraction',
      enquiry_id: enquiryId,
      contact_id: enquiry.contact_id,
      deal_id: dealId ?? enquiry.deal_id,
      reason: 'low_extraction_confidence',
      message,
      confidence,
      suggestion: json({ fields }),
    })
    .onConflict(trx.raw('(enquiry_id, kind, candidate_contact_id)'))
    .ignore()
    .returning('*');
  return item ?? null;
}

