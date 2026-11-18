import { maskPiiDeep, maskPiiText } from '../../core/ai/text.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';

// Row → API shape. Personal data in enquiries (phones, emails) is masked unless the caller may
// see it (contacts.view_pii where the enquiry lives); names, channel and message are shown. The
// dedup and routing explanations quote the matched phone or email ("Same phone +91…"), so their
// free text is masked too.

/** Free text (or JSON) for a viewer: as stored, or with phones and emails masked. */
const forViewer = (value, canViewPii) => (canViewPii || value === null || value === undefined ? value : maskPiiDeep(value));

const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

export function presentForm(row, { webOrigin, snippet } = {}) {
  return {
    id: row.id,
    companyId: row.company_id,
    unitId: row.unit_id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    audience: row.audience,
    productLineId: row.product_line_id,
    fields: row.fields,
    consent: row.consent,
    spam: row.spam,
    thankYou: row.thank_you,
    active: row.active,
    hasSigningSecret: Boolean(row.signing_secret_enc),
    submissionCount: row.submission_count,
    spamCount: row.spam_count,
    lastSubmissionAt: iso(row.last_submission_at),
    url: webOrigin ? `${webOrigin}/f/${row.key}` : null,
    embed: snippet ? { url: snippet.url, iframe: snippet.iframe } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function presentIdentity(row) {
  return {
    id: row.id,
    type: row.type,
    identity: row.identity,
    identityNormalized: row.identity_normalized,
    companyId: row.company_id,
    unitId: row.unit_id,
    productLineId: row.product_line_id,
    shared: row.shared,
    companyIds: row.company_ids ?? [],
    label: row.label,
    active: row.active,
    createdAt: iso(row.created_at),
  };
}

export function presentPool(row, members = []) {
  return {
    id: row.id,
    companyId: row.company_id,
    unitId: row.unit_id,
    name: row.name,
    kind: row.kind,
    productLineIds: row.product_line_ids ?? [],
    isDefault: row.is_default,
    languageMatch: row.language_match,
    workingHours: row.working_hours,
    timeZoneMatch: row.time_zone_match,
    position: row.position,
    active: row.active,
    members: members.map((m) => ({
      userId: m.user_id,
      name: m.name ?? null,
      capacity: m.capacity,
      languages: m.languages ?? [],
      timeZone: m.time_zone,
      active: m.active,
      awayUntil: iso(m.away_until),
      openLeads: num(m.open_leads) ?? 0,
      assigned: m.assigned ?? 0,
    })),
  };
}

export function presentPartnerLink(row, { webOrigin, formKey } = {}) {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    ownerUserId: row.owner_user_id,
    productLineId: row.product_line_id,
    formId: row.form_id,
    url: webOrigin && formKey ? `${webOrigin}/f/${formKey}?ref=${encodeURIComponent(row.code)}` : null,
    clickCount: row.click_count,
    active: row.active,
    createdAt: iso(row.created_at),
  };
}

/** The person in an enquiry, masked as needed. */
export function enquiryPerson(enquiry, canViewPii) {
  const c = enquiry?.contact ?? {};
  return {
    name: c.name ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || null),
    phone: c.phone ? (canViewPii ? c.phone : maskPhone(c.phone)) : null,
    email: c.email ? (canViewPii ? c.email : maskEmail(c.email)) : null,
    city: c.city ?? null,
    studentName: enquiry?.student?.name ?? null,
    grade: enquiry?.student?.grade ?? null,
    instituteName: enquiry?.institute?.name ?? null,
    message: enquiry?.interest?.message ? String(enquiry.interest.message).slice(0, 1000) : null,
    piiMasked: !canViewPii && Boolean(c.phone || c.email),
  };
}

export function presentEnquiry(row, { canViewPii, companyName = null, dealRef = null, detail = false } = {}) {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName,
    unitId: row.unit_id,
    channelType: row.channel_type,
    channelIdentity: row.channel_identity,
    channel: row.deal_channel,
    formId: row.form_id,
    importJobId: row.import_job_id,
    partnerId: row.partner_id,
    status: row.status,
    outcome: row.outcome,
    routingReason: row.routing_reason,
    dedupDecision: row.dedup_decision,
    assignment: row.assignment ? { decision: row.assignment.decision, method: row.assignment.method, ownerId: row.assignment.ownerId ?? null, reasons: detail ? row.assignment.reasons ?? [] : undefined } : null,
    contactId: row.contact_id,
    dealId: row.deal_id,
    dealRef,
    failure: forViewer(row.failure, canViewPii),
    person: enquiryPerson(row.enquiry, canViewPii),
    receivedAt: iso(row.received_at),
    processedAt: iso(row.processed_at),
    ...(detail
      ? {
          routing: forViewer(row.routing, canViewPii),
          dedup: row.dedup ? { decision: row.dedup.decision, score: row.dedup.score, explanation: forViewer(row.dedup.explanation, canViewPii), matchedAs: row.dedup.matchedAs, candidates: (row.dedup.candidates ?? []).map((c) => ({ contactId: c.contactId, score: c.score, decision: c.decision, rules: c.rules })) } : null,
          warnings: forViewer(row.warnings ?? [], canViewPii),
          source: row.enquiry?.source ? forViewer({ ...row.enquiry.source }, canViewPii) : null,
        }
      : {}),
  };
}

export function presentReviewItem(row, { canViewPii, companies, contacts, deals }) {
  const contactOf = (id) => {
    const c = id ? contacts.get(id) : null;
    if (!c) return null;
    return {
      id: c.id,
      displayName: c.display_name,
      kind: c.kind,
      city: c.city,
      primaryPhone: c.primary_phone ? (canViewPii ? c.primary_phone : maskPhone(c.primary_phone)) : null,
      primaryEmail: c.primary_email ? (canViewPii ? c.primary_email : maskEmail(c.primary_email)) : null,
      merged: Boolean(c.merged_into_id),
    };
  };
  const deal = row.deal_id ? deals.get(row.deal_id) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    message: canViewPii ? row.message : maskPiiText(row.message),
    confidence: num(row.confidence),
    companyId: row.company_id,
    unitId: row.unit_id ?? null,
    companyName: row.company_id ? companies.get(row.company_id)?.name ?? null : null,
    candidateCompanies: (row.candidate_company_ids ?? []).map((id) => ({ id, name: companies.get(id)?.name ?? null })).filter((c) => c.name),
    suggestion: {
      companyId: row.suggestion?.companyId ?? null,
      companyName: row.suggestion?.companyId ? companies.get(row.suggestion.companyId)?.name ?? null : null,
      productLineId: row.suggestion?.productLineId ?? null,
      confidence: num(row.suggestion?.confidence),
      rationale: row.suggestion?.rationale ?? null,
      rules: row.suggestion?.rules ?? [],
      fields: row.suggestion?.fields ?? null,
    },
    enquiry: {
      id: row.enquiry_id,
      channelType: row.channel_type,
      channelIdentity: row.channel_identity,
      channel: row.deal_channel,
      receivedAt: iso(row.received_at),
      status: row.enquiry_status,
      person: enquiryPerson(row.enquiry_data, canViewPii),
    },
    contact: contactOf(row.contact_id),
    candidate: contactOf(row.candidate_contact_id),
    deal: deal ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status } : null,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    resolvedAt: iso(row.resolved_at),
    createdAt: iso(row.created_at),
  };
}

/**
 * A CSV import. `masked`: the viewer may not see personal data here (no contacts.view_pii and not
 * the person who uploaded the file), so phones and emails in the sample and messages are masked.
 */
export function presentImportJob(row, { masked = false } = {}) {
  const shown = (value) => forViewer(value, !masked);
  return {
    id: row.id,
    companyId: row.company_id,
    unitId: row.unit_id,
    fileName: row.file_name,
    fileSize: row.file_size,
    delimiter: row.delimiter,
    headers: row.headers,
    sample: shown(row.sample),
    suggestions: row.suggestions,
    mapping: row.mapping,
    defaults: row.defaults,
    status: row.status,
    totalRows: row.total_rows,
    processedRows: row.processed_rows,
    counts: { created: row.created_count, merged: row.merged_count, reopened: row.reopened_count, review: row.review_count, error: row.error_count, warning: row.warning_count },
    fileIssues: shown(row.file_issues),
    hasErrorReport: Boolean(row.error_report_ref),
    failure: shown(row.failure),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    queuedAt: iso(row.queued_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export function presentImportRow(row, deals, { masked = false } = {}) {
  const deal = row.deal_id ? deals.get(row.deal_id) : null;
  return { row: row.row, line: row.line, status: row.status, enquiryId: row.enquiry_id, contactId: row.contact_id, dealId: row.deal_id, dealRef: deal?.ref ?? null, issues: forViewer(row.issues ?? [], !masked) };
}
