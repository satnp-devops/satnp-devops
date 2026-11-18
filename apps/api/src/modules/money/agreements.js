import { createHmac } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { canViewPiiAt, unitsIndex } from '../../core/crm/scope.js';
import { WebhookPayloadError } from './gateways.js';
import { billingLevel, loadBillingRecord, loadDealForBilling } from './access.js';
import { listRecords } from './lists.js';
import { textPdf } from './pdf.js';
import { DEV_WEBHOOK_SECRETS, notifySafely, ports } from './ports.js';
import { presentAgreement, usersById } from './present.js';
import { auditUnit, companyContext, dealTimeline, money, nextCompanyNumber, refFor } from './util.js';

// Agreements: rendered from a company template (plain text with {{placeholders}}), turned into a
// PDF and sent to e-sign through the esign port (Digio: Aadhaar, electronic or DSC signatures).
// Signer identifiers (emails, mobiles) are personal data: masked for viewers without
// contacts.view_pii and never written to the audit log. Digio's webhook (handleEsignWebhook) moves
// the status: sent → partially_signed → signed (agreement.signed), or failed / expired.

const loadAgreement = (req, id, opts = {}) => loadBillingRecord(req, 'agreements', id, { notFound: 'Agreement', ...opts });

/** Email (lower-case) or a 10-digit Indian mobile, as Digio accepts them; null when neither. */
export function normaliseSignerIdentifier(value) {
  const text = String(value ?? '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return text.toLowerCase();
  const digits = text.replace(/[^\d]/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Replace {{placeholders}} (letters, dots, underscores); unknown ones become empty. Pure. */
export function renderTemplate(body, values) {
  return body.replace(/\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g, (_m, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

async function templateValues(trx, { deal, company, quote, signers, ctx }) {
  const [contact, account] = await Promise.all([
    deal.primary_contact_id ? trx('contacts').where({ id: deal.primary_contact_id }).first('display_name') : null,
    deal.account_id ? trx('accounts').where({ id: deal.account_id }).first('name', 'legal_name') : null,
  ]);
  const profile = await trx('billing_profiles').where({ company_id: company.id }).first('legal_name', 'gstin');
  const plan = quote ? await trx('instalment_plans').where({ quote_id: quote.id, status: 'active' }).first('id') : null;
  const instalments = plan ? await trx('instalments').where({ plan_id: plan.id }).orderBy('number') : [];
  return {
    date: ctx.today(),
    'company.name': profile?.legal_name ?? company.name,
    'company.gstin': profile?.gstin ?? '',
    'customer.name': account ? account.legal_name || account.name : (contact?.display_name ?? ''),
    'deal.ref': deal.ref,
    'deal.title': deal.title,
    'quote.ref': quote?.ref ?? '',
    'quote.title': quote?.title ?? '',
    'quote.total': quote ? money(quote.total_minor, quote.currency) : '',
    'quote.validUntil': quote?.valid_until ?? '',
    'quote.lines': quote ? (quote.lines ?? []).map((l) => `- ${l.description} x ${l.quantity}: ${money(l.unitPriceMinor * l.quantity - (l.discountMinor ?? 0), quote.currency)}`).join('\n') : '',
    instalments: instalments.map((i) => `- Instalment ${i.number}: ${money(i.amount_minor, i.currency)} due ${i.due_date}`).join('\n'),
    signers: signers.map((s) => `${s.name} (${s.role})`).join(', '),
  };
}

async function agreementCan(req, row) {
  const manage = await billingLevel(req, 'billing.manage', row);
  return {
    send: Boolean(manage) && (row.status === 'draft' || row.status === 'failed'),
    cancel: Boolean(manage) && ['draft', 'sent', 'partially_signed', 'failed'].includes(row.status),
    refresh: Boolean(manage) && ['sent', 'partially_signed'].includes(row.status),
    simulate: !env.isProd && Boolean(manage) && ['sent', 'partially_signed'].includes(row.status),
  };
}

async function presentOne(req, id, { includeBody = true } = {}) {
  const row = await loadAgreement(req, id);
  const index = await unitsIndex(req);
  const users = await usersById(db, [row.created_by]);
  return presentAgreement(row, { canViewPii: canViewPiiAt(req.access, index, [row.deal_unit_id]), users, can: await agreementCan(req, row), includeBody });
}

export const getAgreement = (req, id) => presentOne(req, id);

export async function listAgreements(req, query) {
  const { page, nextCursor } = await listRecords(req, {
    table: 'agreements',
    unitId: query.unitId,
    cursor: query.cursor,
    limit: query.limit,
    filter: (q) => {
      if (query.status?.length) q.whereIn('r.status', query.status);
    },
  });
  const index = await unitsIndex(req);
  const users = await usersById(db, page.map((r) => r.created_by));
  return { data: page.map((row) => presentAgreement(row, { canViewPii: canViewPiiAt(req.access, index, [row.deal_unit_id]), users })), nextCursor };
}

export async function createAgreement(req, body) {
  const id = await db.transaction(async (trx) => {
    const { deal, unit, company } = await loadDealForBilling(req, body.dealId, 'billing.manage', { trx, forUpdate: true });
    const template = await trx('agreement_templates').where({ id: body.templateId }).first();
    if (!template || template.company_id !== company.id || !template.active) throw errors.validation([{ path: 'body.templateId', message: 'Template not found in this company' }]);
    let quote = null;
    if (body.quoteId) {
      quote = await trx('quotes').where({ id: body.quoteId }).first();
      if (!quote || quote.deal_id !== deal.id) throw errors.validation([{ path: 'body.quoteId', message: 'Quote not found on this deal' }]);
    }
    const signers = body.signers.map((signer, index) => {
      const identifier = normaliseSignerIdentifier(signer.identifier);
      if (!identifier) throw errors.validation([{ path: `body.signers.${index}.identifier`, message: 'Use an email or a 10-digit Indian mobile number' }]);
      return { name: signer.name, identifier, role: signer.role, order: signer.order ?? index + 1, signType: signer.signType ?? template.sign_type, status: 'pending', signedAt: null };
    });
    if (new Set(signers.map((s) => s.identifier)).size !== signers.length) throw errors.validation([{ path: 'body.signers', message: 'Each signer needs their own email or mobile' }]);
    const ctx = await companyContext(unit, trx);
    const number = await nextCompanyNumber(trx, company.id, 'agreement');
    const rendered = renderTemplate(template.body, await templateValues(trx, { deal, company, quote, signers, ctx }));
    const [row] = await trx('agreements')
      .insert({
        group_id: deal.group_id,
        company_id: company.id,
        deal_id: deal.id,
        quote_id: quote?.id ?? null,
        template_id: template.id,
        number,
        ref: refFor(ctx.prefix, 'AG', number),
        title: body.title || `${template.name}: ${deal.title}`.slice(0, 200),
        status: 'draft',
        body: rendered,
        signers: json(signers),
        sign_type: template.sign_type,
        expires_in_days: template.expires_in_days,
        provider: 'digio',
        created_by: req.auth.user.id,
      })
      .returning('*');
    await writeAudit(trx, req, { action: 'agreement.created', entityType: 'agreement', entityId: row.id, unit: auditUnit(deal), after: { ref: row.ref, templateId: template.id, signerCount: signers.length } });
    await agreementEvent(trx, row, deal, 'agreement.created', req.auth.user.id);
    return row.id;
  });
  if (body.send) return sendAgreement(req, id);
  return presentOne(req, id);
}

const agreementEvent = (trx, row, deal, type, actorUserId, extra = {}) =>
  emitEvent(trx, {
    type,
    groupId: deal.group_id,
    unitId: deal.unit_id,
    aggregateType: 'agreement',
    aggregateId: row.id,
    actorUserId,
    payload: { agreementId: row.id, ref: row.ref, dealId: deal.id, companyId: row.company_id, quoteId: row.quote_id ?? null, status: row.status, ...extra },
  });

export async function sendAgreement(req, id) {
  const row = await loadAgreement(req, id, { permission: 'billing.manage' });
  if (row.status !== 'draft' && row.status !== 'failed') throw errors.conflict(`A ${row.status} agreement can't be sent`);
  const deal = await db('deals').where({ id: row.deal_id }).first();
  const esign = await ports.esign({ companyId: row.company_id });
  const pdf = textPdf({ title: row.title, body: row.body, footer: row.ref });
  const attempt = row.status === 'failed' ? `:${Date.now()}` : '';
  const doc = await esign.createSignRequest({
    document: { fileName: `${row.ref}.pdf`, contentBase64: pdf.toString('base64') },
    signers: row.signers.map((s) => ({ identifier: s.identifier, name: s.name, signType: s.signType, order: s.order, reason: `Agreement ${row.ref}` })),
    expiresInDays: row.expires_in_days,
    idempotencyKey: `agreement:${row.id}${attempt}`,
  });
  const signUrls = new Map((doc.signers ?? []).map((s) => [s.identifier, s.signUrl ?? null]));
  await db.transaction(async (trx) => {
    const locked = await trx('agreements').where({ id }).forUpdate().first();
    if (locked.status !== 'draft' && locked.status !== 'failed') return;
    const signers = locked.signers.map((s) => ({ ...s, status: 'pending', signUrl: signUrls.get(s.identifier) ?? null }));
    const [saved] = await trx('agreements')
      .where({ id })
      .update({
        status: 'sent',
        provider_document_id: doc.id,
        signers: json(signers),
        sent_at: trx.fn.now(),
        expires_at: doc.expiresAt ?? new Date(Date.now() + locked.expires_in_days * 86_400_000).toISOString(),
        failure: null,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    await writeAudit(trx, req, { action: 'agreement.sent', entityType: 'agreement', entityId: id, unit: auditUnit(deal), after: { status: 'sent', providerDocumentId: doc.id } });
    await agreementEvent(trx, saved, deal, 'agreement.sent', req.auth.user.id, { expiresAt: saved.expires_at ? new Date(saved.expires_at).toISOString() : null });
    await dealTimeline(trx, deal, { kind: 'document', title: `Agreement ${saved.ref} sent for e-sign`, meta: { action: 'agreement.sent', agreementId: id }, actorUserId: req.auth.user.id });
  });
  await notifySafely({
    template: 'billing.agreement_sent',
    companyId: row.company_id,
    dealId: deal.id,
    contactId: deal.primary_contact_id,
    variables: { ref: row.ref, title: row.title, signUrls: [...signUrls.values()].filter(Boolean) },
    idempotencyKey: `agreement.sent:${id}${attempt}`,
  });
  return presentOne(req, id);
}

export async function cancelAgreement(req, id, { reason }) {
  const row = await loadAgreement(req, id, { permission: 'billing.manage' });
  if (!['draft', 'sent', 'partially_signed', 'failed'].includes(row.status)) throw errors.conflict(`A ${row.status} agreement can't be cancelled`);
  if (row.provider_document_id && ['sent', 'partially_signed'].includes(row.status)) {
    const esign = await ports.esign({ companyId: row.company_id });
    await esign.cancelSignRequest(row.provider_document_id);
  }
  await db.transaction(async (trx) => {
    const deal = await trx('deals').where({ id: row.deal_id }).first();
    const [saved] = await trx('agreements').where({ id }).update({ status: 'cancelled', cancelled_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
    await writeAudit(trx, req, { action: 'agreement.cancelled', entityType: 'agreement', entityId: id, unit: auditUnit(deal), before: { status: row.status }, after: { status: 'cancelled' }, meta: { reason } });
    await agreementEvent(trx, saved, deal, 'agreement.cancelled', req.auth.user.id, { reason });
  });
  return presentOne(req, id);
}

/** Ask the provider for the current status (when a webhook was missed). */
export async function refreshAgreement(req, id) {
  const row = await loadAgreement(req, id, { permission: 'billing.manage' });
  if (!row.provider_document_id) throw errors.conflict('This agreement has not been sent');
  const esign = await ports.esign({ companyId: row.company_id });
  const doc = await esign.getDocument(row.provider_document_id);
  await db.transaction(async (trx) => {
    const locked = await trx('agreements').where({ id }).forUpdate().first();
    await applyDocumentState(trx, locked, { status: doc.status, signers: doc.signers ?? [], error: null, sourceEventId: null, occurredAt: new Date().toISOString() });
  });
  return presentOne(req, id);
}

/**
 * Move an agreement to the provider's state. Idempotent: the same state twice changes nothing.
 * status: the provider's document status (pending | completed | expired | failed | cancelled | unknown).
 */
export async function applyDocumentState(trx, agreement, { status, signers = [], signer = null, error = null, sourceEventId = null, occurredAt = null, rejected = false }) {
  if (['signed', 'cancelled'].includes(agreement.status)) return { changed: false };
  const byId = new Map(signers.filter((s) => s.identifier).map((s) => [s.identifier, s]));
  if (signer?.identifier) byId.set(signer.identifier, { ...(byId.get(signer.identifier) ?? {}), ...signer });
  const now = occurredAt ?? new Date().toISOString();
  const nextSigners = agreement.signers.map((s) => {
    const remote = byId.get(s.identifier);
    if (!remote || !remote.status || remote.status === 'unknown') return s;
    const mapped = remote.status === 'removed' || remote.status === 'skipped' ? s.status : remote.status;
    return { ...s, status: mapped, signedAt: mapped === 'signed' ? (s.signedAt ?? now) : s.signedAt, signUrl: remote.signUrl ?? s.signUrl ?? null };
  });
  const allSigned = status === 'completed' || nextSigners.every((s) => s.status === 'signed');
  let next = agreement.status;
  if (allSigned) next = 'signed';
  else if (status === 'expired') next = 'expired';
  else if (status === 'cancelled') next = 'cancelled';
  else if (error || rejected || status === 'failed' || nextSigners.some((s) => s.status === 'failed' || s.status === 'rejected')) next = 'failed';
  else if (nextSigners.some((s) => s.status === 'signed')) next = 'partially_signed';
  const signersChanged = JSON.stringify(nextSigners) !== JSON.stringify(agreement.signers);
  if (next === agreement.status && !signersChanged) return { changed: false };
  const deal = await trx('deals').where({ id: agreement.deal_id }).first();
  const [saved] = await trx('agreements')
    .where({ id: agreement.id })
    .update({
      status: next,
      signers: json(nextSigners),
      ...(next === 'signed' ? { signed_at: now } : {}),
      ...(next === 'failed' ? { failure: json(error ?? { code: rejected ? 'rejected' : 'failed', message: null }) } : {}),
      last_event_at: now,
      updated_at: trx.fn.now(),
    })
    .returning('*');
  if (next !== agreement.status) {
    const type = { signed: 'agreement.signed', partially_signed: 'agreement.signer_signed', failed: 'agreement.failed', expired: 'agreement.expired', cancelled: 'agreement.cancelled' }[next];
    if (type) {
      await writeAudit(trx, null, { action: type, entityType: 'agreement', entityId: agreement.id, unit: auditUnit(deal), groupId: deal.group_id, before: { status: agreement.status }, after: { status: next } });
      await agreementEvent(trx, saved, deal, type, null, { signedCount: nextSigners.filter((s) => s.status === 'signed').length, signerCount: nextSigners.length });
    }
    if (next === 'signed' || next === 'failed') {
      await dealTimeline(trx, deal, {
        kind: 'document',
        title: next === 'signed' ? `Agreement ${saved.ref} signed by everyone` : `Agreement ${saved.ref} was not signed${rejected ? ' (rejected)' : ''}`,
        meta: { action: type, agreementId: agreement.id },
        sourceEventId,
      });
    }
  }
  return { changed: true, status: next };
}

/**
 * Digio callback handler function. The webhook receiver calls it with the exact raw body and
 * headers delivered to the company's e-sign webhook URL. Verify → dedupe by Digio's event id →
 * apply. Unknown documents and event types are acknowledged and ignored.
 */
export async function handleEsignWebhook({ companyId, rawBody, headers }) {
  const esign = await ports.esign({ companyId });
  const event = esign.parseWebhook(rawBody, headers); // WebhookSignatureError (401) when the checksum fails
  if (!event?.id) throw new WebhookPayloadError();
  const dedupeKey = `digio:${event.id}`;
  return db.transaction(async (trx) => {
    const inserted = await trx('billing_provider_events')
      .insert({ dedupe_key: dedupeKey, provider: 'digio', event_type: event.providerEvent ?? event.type, kind: event.type, company_id: companyId ?? null, outcome: 'received' })
      .onConflict('dedupe_key')
      .ignore()
      .returning('dedupe_key');
    if (!inserted.length) return { outcome: 'duplicate', dedupeKey };
    const agreement = event.documentId
      ? await trx('agreements').where({ provider: 'digio', provider_document_id: event.documentId }).forUpdate().first()
      : null;
    let outcome = 'unmatched';
    if (agreement && (!companyId || agreement.company_id === companyId)) {
      const result = await applyDocumentState(trx, agreement, {
        status: event.documentStatus ?? (event.completed ? 'completed' : 'pending'),
        signers: event.document?.signers ?? [],
        signer: event.signer,
        error: event.error,
        rejected: event.type === 'esign.signer.rejected',
        sourceEventId: dedupeKey,
        occurredAt: event.occurredAt,
      });
      outcome = result.changed ? 'applied' : 'ignored';
    } else if (event.type === 'unknown') outcome = 'ignored';
    await trx('billing_provider_events').where({ dedupe_key: dedupeKey }).update({ outcome, agreement_id: agreement?.id ?? null });
    if (outcome === 'unmatched') logger.warn({ dedupeKey, type: event.type }, 'money: e-sign webhook matched no agreement');
    return { outcome, dedupeKey, agreementId: agreement?.id ?? null };
  });
}

/** A Digio-shaped webhook body for an agreement, signed with the development secret. */
export function devDigioDelivery({ agreement, outcome, eventId, secret = DEV_WEBHOOK_SECRETS.digio }) {
  const signedAll = outcome === 'signed';
  const target = agreement.signers.find((s) => s.status !== 'signed') ?? agreement.signers[0];
  const document =
    outcome === 'signed'
      ? {
          id: agreement.provider_document_id,
          agreement_status: 'completed',
          file_name: `${agreement.ref}.pdf`,
          signing_parties: agreement.signers.map((s) => ({ identifier: s.identifier, name: s.name, status: 'signed', signature_type: s.signType })),
          others: { has_all_signed: signedAll, last_signed_by: target.identifier },
        }
      : { id: agreement.provider_document_id, signer_identifier: target.identifier, error_code: outcome === 'rejected' ? 'REJECTED' : 'SIGN_FAILED', error_message: outcome === 'rejected' ? 'Signer rejected the document' : 'Aadhaar OTP failed' };
  const body = JSON.stringify({
    id: eventId,
    event: outcome === 'signed' ? 'doc.signed' : outcome === 'rejected' ? 'doc.sign.rejected' : 'doc.sign.failed',
    created_at: Date.now(),
    entities: ['document'],
    payload: { document },
  });
  return { rawBody: Buffer.from(body), headers: { 'x-digio-checksum': createHmac('sha256', secret).update(body).digest('hex') } };
}

/** Development only: pretend the signers signed (or failed), through the real webhook path. */
export async function simulateAgreement(req, id, { outcome }) {
  if (env.isProd) throw errors.notFound('Route');
  const row = await loadAgreement(req, id, { permission: 'billing.manage' });
  if (!['sent', 'partially_signed'].includes(row.status)) throw errors.conflict('Only a sent agreement can be signed');
  const esign = await ports.esign({ companyId: row.company_id });
  if (!esign.dev) throw errors.conflict('This company uses a real e-sign connection: sign through Digio');
  const delivery = devDigioDelivery({ agreement: row, outcome, eventId: `NTF${row.id.replace(/-/g, '').slice(0, 12)}${Date.now()}` });
  await handleEsignWebhook({ companyId: row.company_id, ...delivery });
  return presentOne(req, id);
}

