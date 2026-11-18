import { getAgent } from '../../core/ai/index.js';
import { maskPiiDeep, maskPiiText } from '../../core/ai/text.js';

// Rows → API shapes (schemas.js). Phones and emails inside inputs and outputs are masked for
// people without contacts.view_pii where the action belongs (core/crm/pii.js rules).

const iso = (value) => (value ? new Date(value).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const ref = (id, name) => (id ? { id, name: name ?? 'Unknown' } : null);

export const GENERIC_TASKS = [
  { key: 'extract', label: 'Extract (generic)' },
  { key: 'classify', label: 'Classify (generic)' },
  { key: 'generate', label: 'Generate (generic)' },
  { key: 'summarise', label: 'Summarise (generic)' },
];

export const agentLabel = (key) => getAgent(key)?.label ?? GENERIC_TASKS.find((t) => t.key === key)?.label ?? key;

/**
 * @param {object} row ai_actions row, joined with company_name, deal_ref, deal_title, contact_name, account_name, reviewer_name
 * @param {{ canViewPii: boolean, canReview: boolean, withInput?: boolean }} options
 */
export function presentAction(row, { canViewPii, canReview, withInput = false }) {
  const mask = (value) => (canViewPii ? value : maskPiiDeep(value));
  return {
    id: row.id,
    company: { id: row.company_id, name: row.company_name ?? 'Company' },
    unitId: row.unit_id,
    agent: row.agent,
    agentLabel: agentLabel(row.agent),
    trigger: row.trigger,
    reference: row.reference ?? null,
    subject: {
      dealId: row.deal_id ?? null,
      dealRef: row.deal_ref ?? null,
      dealTitle: row.deal_title ?? null,
      contactId: row.contact_id ?? null,
      contactName: row.contact_name ?? null,
      accountId: row.account_id ?? null,
      accountName: row.account_name ?? null,
    },
    ownerUserId: row.owner_user_id ?? null,
    status: row.status,
    inputSummary: row.input_summary ? (canViewPii ? row.input_summary : maskPiiText(row.input_summary)) : null,
    ...(withInput ? { input: mask(row.input) } : {}),
    output: mask(row.output ?? null),
    finalOutput: mask(row.final_output ?? null),
    confidence: num(row.confidence),
    threshold: num(row.threshold),
    guardrails: mask(row.guardrails ?? []),
    reviewReasons: row.review_reasons ?? [],
    provider: row.provider ?? null,
    model: row.model ?? null,
    mock: Boolean(row.mock),
    usage: { inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 },
    latencyMs: row.latency_ms ?? 0,
    attempts: row.attempts ?? 0,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? null } : null,
    reviewer: ref(row.reviewer_user_id, row.reviewer_name),
    reviewedAt: iso(row.reviewed_at),
    reviewNote: row.review_note ?? null,
    piiMasked: !canViewPii,
    canReview: canReview && row.status === 'pending_review',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function presentArticle(row, { canEdit }) {
  return {
    id: row.id,
    company: { id: row.company_id, name: row.company_name ?? 'Company' },
    title: row.title,
    body: row.body,
    tags: row.tags ?? [],
    status: row.status,
    owner: ref(row.owner_user_id, row.owner_name),
    approvedBy: ref(row.approved_by, row.approved_by_name),
    approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    canEdit,
  };
}
