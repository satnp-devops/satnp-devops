import { stateByCode } from '../../core/billing/index.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { iso, minor } from './util.js';

// Row → API shape (camelCase). Money is { valueMinor, currency } (contract §10 rule 3); dates are
// YYYY-MM-DD, times ISO UTC. Types: apps/web/src/lib/money/types.ts.

export const moneyOf = (value, currency) => ({ valueMinor: minor(value), currency });
const userRef = (users, id) => (id ? (users?.get(id) ?? { id, name: 'Former user' }) : null);

export const dealRef = (row) =>
  row.deal_ref ? { id: row.deal_id, ref: row.deal_ref, title: row.deal_title, status: row.deal_status ?? 'open', kind: row.deal_kind ?? null } : null;

const placeOf = (code) => (code ? { code, name: code === '96' ? 'Outside India' : (stateByCode(code)?.name ?? code) } : null);

export function presentProfile(row) {
  if (!row) return null;
  return {
    companyId: row.company_id,
    legalName: row.legal_name,
    tradeName: row.trade_name ?? null,
    gstin: row.gstin ?? null,
    stateCode: row.state_code,
    stateName: stateByCode(row.state_code)?.name ?? null,
    pan: row.pan ?? null,
    address: row.address ?? {},
    email: row.email ?? null,
    phone: row.phone ?? null,
    lutNumber: row.lut_number ?? null,
    lutValidUntil: row.lut_valid_until ?? null,
    roundOff: row.round_off,
    invoiceNotes: row.invoice_notes ?? null,
    bankDetails: row.bank_details ?? {},
    updatedAt: iso(row.updated_at),
  };
}

export function presentSeries(row, example = null, last = null) {
  return {
    id: row.id,
    companyId: row.company_id,
    gstin: row.gstin,
    documentType: row.document_type,
    prefix: row.prefix,
    format: row.format,
    fyStyle: row.fy_style,
    padding: row.padding,
    isDefault: row.is_default,
    active: row.active,
    example,
    last: last ?? null,
  };
}

export function presentPlan(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    productId: row.product_id ?? null,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    kind: row.kind,
    audience: row.audience,
    unit: row.unit,
    interval: row.interval ?? null,
    sac: row.sac ?? null,
    taxRateBp: row.tax_rate_bp,
    taxability: row.taxability,
    position: row.position,
    active: row.active,
  };
}

export function presentPriceList(row, prices = []) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    currency: row.currency,
    pricesIncludeTax: row.prices_include_tax,
    isDefault: row.is_default,
    active: row.active,
    prices: prices.map((p) => ({ planId: p.plan_id, unitAmount: moneyOf(p.unit_amount_minor, row.currency) })),
  };
}

export function presentAccount(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    label: row.label,
    scope: row.scope,
    mode: row.mode,
    accountRef: row.account_ref ?? null,
    connected: Boolean(row.connection_id),
    entityCountry: row.entity_country,
    indiaExports: row.india_exports,
    purposeCode: row.purpose_code ?? null,
    active: row.active,
  };
}

export function presentTemplate(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    key: row.key,
    name: row.name,
    audience: row.audience,
    body: row.body,
    signType: row.sign_type,
    expiresInDays: row.expires_in_days,
    active: row.active,
  };
}

function presentQuoteLine(line, taxLine, currency) {
  return {
    id: line.id,
    planId: line.planId ?? null,
    description: line.description,
    sac: line.sac ?? null,
    quantity: line.quantity,
    unitPrice: moneyOf(line.unitPriceMinor, currency),
    discount: moneyOf(line.discountMinor ?? 0, currency),
    taxRateBp: line.taxRateBp,
    taxability: line.taxability ?? 'taxable',
    taxable: moneyOf(taxLine?.taxableValueMinor ?? 0, currency),
    tax: moneyOf(taxLine?.taxMinor ?? 0, currency),
    total: moneyOf(taxLine?.totalMinor ?? 0, currency),
  };
}

export function presentQuote(row, { users, can = null, instalmentPreview = null } = {}) {
  const currency = row.currency;
  const taxLines = new Map((row.tax_summary?.lines ?? []).map((l) => [l.id, l]));
  const decision = row.discount_decision ?? null;
  return {
    id: row.id,
    ref: row.ref,
    kind: row.kind,
    status: row.status,
    title: row.title,
    companyId: row.company_id,
    deal: dealRef(row),
    currency,
    pricesIncludeTax: row.prices_include_tax,
    priceListId: row.price_list_id ?? null,
    lines: (row.lines ?? []).map((line) => presentQuoteLine(line, taxLines.get(line.id), currency)),
    recipient: row.recipient ?? {},
    placeOfSupply: placeOf(row.place_of_supply_state_code),
    supplyType: row.tax_summary?.supplyType ?? null,
    taxKind: row.tax_summary?.taxKind ?? null,
    amounts: {
      subtotal: moneyOf(row.subtotal_minor, currency),
      discount: moneyOf(row.discount_minor, currency),
      taxable: moneyOf(row.taxable_minor, currency),
      tax: moneyOf(row.tax_minor, currency),
      total: moneyOf(row.total_minor, currency),
    },
    discount: {
      status: row.discount_status,
      percentBp: decision?.percentBp ?? 0,
      tierLabel: decision?.tierLabel ?? null,
      approverRoles: decision?.approverRoles ?? [],
      reason: decision?.reason ?? null,
      requestedBy: userRef(users, row.discount_requested_by),
      reviewedBy: userRef(users, row.discount_reviewed_by),
      reviewedAt: iso(row.discount_reviewed_at),
      note: row.discount_note ?? null,
    },
    instalmentOption: row.instalment_option ?? null,
    instalmentPreview,
    validUntil: row.valid_until ?? null,
    notes: row.notes ?? null,
    terms: row.terms ?? null,
    sentAt: iso(row.sent_at),
    acceptedAt: iso(row.accepted_at),
    declinedAt: iso(row.declined_at),
    declineReason: row.decline_reason ?? null,
    createdBy: userRef(users, row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(can ? { can } : {}),
  };
}

export function presentPayment(row, { users, can = null } = {}) {
  const currency = row.currency;
  return {
    id: row.id,
    companyId: row.company_id,
    deal: dealRef(row),
    quoteId: row.quote_id ?? null,
    instalmentId: row.instalment_id ?? null,
    subscriptionId: row.subscription_id ?? null,
    invoiceId: row.invoice_id ?? null,
    invoiceNumber: row.invoice_number ?? null,
    purpose: row.purpose,
    provider: row.provider,
    status: row.status,
    amount: moneyOf(row.amount_minor, currency),
    refunded: moneyOf(row.amount_refunded_minor, currency),
    method: row.method ?? null,
    description: row.description,
    linkUrl: row.status === 'link_sent' || row.status === 'failed' || row.status === 'pending' ? (row.link_url ?? null) : null,
    providerPaymentId: row.provider_payment_id ?? null,
    expiresAt: iso(row.expires_at),
    paidAt: iso(row.paid_at),
    failedAt: iso(row.failed_at),
    failure: row.failure ?? null,
    attempt: row.attempt,
    nextRetryAt: iso(row.next_retry_at),
    invoiceError: row.invoice_error ?? null,
    createdBy: userRef(users, row.created_by),
    createdAt: iso(row.created_at),
    ...(can ? { can } : {}),
  };
}

export function presentInvoiceSummary(row) {
  return {
    id: row.id,
    number: row.number,
    companyId: row.company_id,
    deal: dealRef(row),
    paymentId: row.payment_id ?? null,
    documentType: row.document_type,
    status: row.status,
    issueDate: row.issue_date,
    recipientName: row.recipient?.name ?? null,
    supplyType: row.supply_type,
    taxable: moneyOf(row.taxable_minor, row.currency),
    tax: moneyOf(row.tax_minor, row.currency),
    total: moneyOf(row.total_minor, row.currency),
    credited: moneyOf(row.credited_minor, row.currency),
    createdAt: iso(row.created_at),
  };
}

/** The full invoice, ready to print or render as a PDF (Rule 46 fields). */
export function presentInvoice(row, { creditNotes = [], can = null } = {}) {
  const currency = row.currency;
  const totals = row.totals ?? {};
  return {
    ...presentInvoiceSummary(row),
    supplier: row.supplier ?? {},
    recipient: row.recipient ?? {},
    placeOfSupply: placeOf(row.place_of_supply_state_code),
    taxKind: row.tax_kind,
    stateTaxLabel: row.tax_kind === 'cgst_sgst' ? (stateByCode(row.place_of_supply_state_code)?.localTax ?? 'SGST') : null,
    currency,
    lines: (row.lines ?? []).map((line) => ({
      description: line.description,
      sac: line.sac,
      quantity: line.quantity,
      gross: moneyOf(line.grossMinor, currency),
      discount: moneyOf(line.discountMinor, currency),
      taxable: moneyOf(line.taxableValueMinor, currency),
      taxRateBp: line.taxRateBp,
      taxability: line.taxability,
      cgst: { rateBp: line.cgstRateBp, amount: moneyOf(line.cgstMinor, currency) },
      sgst: { rateBp: line.sgstRateBp, amount: moneyOf(line.sgstMinor, currency) },
      igst: { rateBp: line.igstRateBp, amount: moneyOf(line.igstMinor, currency) },
      total: moneyOf(line.totalMinor, currency),
    })),
    sacSummary: (row.sac_summary ?? []).map((s) => ({
      sac: s.sac ?? null,
      taxRateBp: s.rateBp ?? s.taxRateBp ?? null,
      taxable: moneyOf(s.taxableValueMinor ?? 0, currency),
      tax: moneyOf(s.taxMinor ?? (s.cgstMinor ?? 0) + (s.sgstMinor ?? 0) + (s.igstMinor ?? 0), currency),
    })),
    totals: {
      gross: moneyOf(totals.grossMinor ?? 0, currency),
      discount: moneyOf(totals.discountMinor ?? 0, currency),
      taxable: moneyOf(row.taxable_minor, currency),
      cgst: moneyOf(row.cgst_minor, currency),
      sgst: moneyOf(row.sgst_minor, currency),
      igst: moneyOf(row.igst_minor, currency),
      tax: moneyOf(row.tax_minor, currency),
      roundOff: moneyOf(row.round_off_minor, currency),
      total: moneyOf(row.total_minor, currency),
    },
    amountInWords: row.amount_in_words,
    endorsement: row.endorsement ?? null,
    notes: row.notes ?? null,
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason ?? null,
    creditNotes: creditNotes.map(presentCreditNote),
    ...(can ? { can } : {}),
  };
}

export function presentCreditNote(row) {
  return {
    id: row.id,
    number: row.number,
    companyId: row.company_id,
    deal: dealRef(row),
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number ?? null,
    refundId: row.refund_id ?? null,
    issueDate: row.issue_date,
    reason: row.reason,
    mode: row.mode,
    status: row.status,
    taxable: moneyOf(row.taxable_minor, row.currency),
    tax: moneyOf(row.tax_minor, row.currency),
    total: moneyOf(row.total_minor, row.currency),
    amountInWords: row.amount_in_words,
    createdAt: iso(row.created_at),
  };
}

export function presentInstalment(row, today) {
  const outstanding = minor(row.amount_minor) - minor(row.paid_minor);
  const overdue = row.status === 'pending' && today && row.due_date < today;
  return {
    id: row.id,
    planId: row.plan_id,
    companyId: row.company_id,
    deal: dealRef(row),
    number: row.number,
    count: row.plan_count ?? null,
    dueDate: row.due_date,
    amount: moneyOf(row.amount_minor, row.currency),
    paid: moneyOf(row.paid_minor, row.currency),
    outstanding: moneyOf(Math.max(0, outstanding), row.currency),
    status: row.status,
    state: row.status !== 'pending' ? row.status : overdue ? 'overdue' : row.due_date === today ? 'due_today' : 'upcoming',
    paidAt: iso(row.paid_at),
    lastReminderAt: iso(row.last_reminder_at),
  };
}

export function presentPlanSummary(row, instalments, today) {
  return {
    id: row.id,
    quoteId: row.quote_id ?? null,
    status: row.status,
    total: moneyOf(row.total_minor, row.currency),
    count: row.count,
    instalments: instalments.map((i) => presentInstalment({ ...i, plan_count: row.count }, today)),
  };
}

export function presentSubscription(row, { planName = null, can = null } = {}) {
  const currency = row.currency;
  const addons = row.addons ?? [];
  const perPeriod = minor(row.unit_price_minor) * row.quantity + addons.reduce((s, a) => s + a.unitPriceMinor * a.quantity, 0);
  return {
    id: row.id,
    companyId: row.company_id,
    deal: dealRef(row),
    accountId: row.account_id ?? null,
    accountName: row.account_name ?? null,
    planId: row.plan_id,
    planName: planName ?? row.plan_name ?? null,
    status: row.status,
    quantity: row.quantity,
    unit: row.unit,
    interval: row.interval,
    unitPrice: moneyOf(row.unit_price_minor, currency),
    pricesIncludeTax: row.prices_include_tax,
    addons: addons.map((a) => ({ code: a.code, name: a.name, quantity: a.quantity, unitPrice: moneyOf(a.unitPriceMinor, currency) })),
    perPeriod: moneyOf(perPeriod, currency),
    startDate: row.start_date,
    currentPeriodStart: row.current_period_start,
    renewsOn: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason ?? null,
    renewalCount: row.renewal_count,
    createdAt: iso(row.created_at),
    ...(can ? { can } : {}),
  };
}

export function presentRefund(row, { users, can = null } = {}) {
  return {
    id: row.id,
    ref: row.ref,
    companyId: row.company_id,
    deal: dealRef(row),
    paymentId: row.payment_id,
    invoiceId: row.invoice_id ?? null,
    creditNoteId: row.credit_note_id ?? null,
    amount: moneyOf(row.amount_minor, row.currency),
    reason: row.reason,
    note: row.note ?? null,
    status: row.status,
    provider: row.provider,
    requestedBy: userRef(users, row.requested_by),
    requestedAt: iso(row.requested_at),
    reviewedBy: userRef(users, row.reviewed_by),
    reviewedAt: iso(row.reviewed_at),
    reviewNote: row.review_note ?? null,
    processedAt: iso(row.processed_at),
    failure: row.failure ?? null,
    createdAt: iso(row.created_at),
    ...(can ? { can } : {}),
  };
}

/** Signer identifiers are emails or mobile numbers: masked without contacts.view_pii. */
export function presentAgreement(row, { canViewPii = false, users, can = null, includeBody = false } = {}) {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    companyId: row.company_id,
    deal: dealRef(row),
    quoteId: row.quote_id ?? null,
    templateId: row.template_id ?? null,
    status: row.status,
    signType: row.sign_type,
    provider: row.provider ?? null,
    signers: (row.signers ?? []).map((s) => ({
      name: s.name,
      role: s.role,
      order: s.order,
      identifier: canViewPii ? s.identifier : String(s.identifier).includes('@') ? maskEmail(s.identifier) : maskPhone(s.identifier),
      identifierMasked: !canViewPii,
      status: s.status,
      signedAt: s.signedAt ?? null,
      signUrl: canViewPii && (row.status === 'sent' || row.status === 'partially_signed') ? (s.signUrl ?? null) : null,
    })),
    expiresAt: iso(row.expires_at),
    sentAt: iso(row.sent_at),
    signedAt: iso(row.signed_at),
    cancelledAt: iso(row.cancelled_at),
    failure: row.failure ?? null,
    createdBy: userRef(users, row.created_by),
    createdAt: iso(row.created_at),
    ...(includeBody ? { body: row.body } : {}),
    ...(can ? { can } : {}),
  };
}

/** Load { id, name } for user ids referenced by rows (one query). */
export async function usersById(trx, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await trx('users').whereIn('id', unique).select('id', 'name');
  return new Map(rows.map((u) => [u.id, { id: u.id, name: u.name }]));
}
