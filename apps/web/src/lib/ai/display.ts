import type { PillTone } from '@/components/crm';
import { humanize } from '@/lib/crm/format';
import type { OrgUnit } from '@/lib/types';
import type { Session } from '@/lib/session';
import type { ActionStatus, ArticleStatus, GuardrailOutcome, Json } from './types';

// Words and colours for the AI screens.

export const STATUS_LABEL: Record<ActionStatus, string> = {
  completed: 'Used automatically',
  pending_review: 'Waiting for review',
  approved: 'Approved',
  edited: 'Edited and approved',
  rejected: 'Rejected',
  failed: 'Failed',
};

export const STATUS_TONE: Record<ActionStatus, PillTone> = {
  completed: 'success',
  pending_review: 'warning',
  approved: 'success',
  edited: 'accent',
  rejected: 'danger',
  failed: 'danger',
};

export const OUTCOME_LABEL: Record<GuardrailOutcome, string> = { pass: 'Passed', flag: 'Needs a look', block: 'Blocked', handover: 'Hand over' };
export const OUTCOME_TONE: Record<GuardrailOutcome, PillTone> = { pass: 'success', flag: 'warning', block: 'danger', handover: 'accent' };

/** Why an output waits for a person, in words. */
const REASONS: Record<string, string> = {
  low_confidence: 'Low confidence',
  approval_required: 'Always approved by a person',
  fee_amount: 'Quotes fees',
  discount: 'Mentions a discount',
  links: 'Adds a link',
  handover_topic: 'Handover topic',
  handover: 'Handed over',
  prompt_injection: 'Tries to instruct the AI',
  grounding: 'Not from the knowledge base',
  out_of_scope: 'Outside the choices',
  program: 'Unknown program',
  escalation: 'Needs the accounts team',
};
export const reasonLabel = (reason: string) => REASONS[reason] ?? humanize(reason);

const CHECKS: Record<string, string> = {
  agent_enabled: 'Agent switched on',
  handover_topic: 'Handover topics',
  prompt_injection: 'Prompt injection',
  fee_amount: 'Fees',
  discount: 'Discounts',
  links: 'Links',
  grounding: 'Knowledge base',
  handover: 'Handover',
  confidence: 'Confidence',
  approval_required: 'Approval',
  out_of_scope: 'Choices',
  program: 'Catalogue',
  escalation: 'Escalation',
};
export const checkLabel = (check: string) => CHECKS[check] ?? humanize(check);

export const ARTICLE_STATUS_LABEL: Record<ArticleStatus, string> = { draft: 'Draft', approved: 'Approved', archived: 'Archived' };
export const ARTICLE_STATUS_TONE: Record<ArticleStatus, PillTone> = { draft: 'neutral', approved: 'success', archived: 'danger' };

export const percent = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

type ScopeSession = Pick<Session, 'scope' | 'units' | 'unitsById' | 'canAnywhere'>;

/** The company the working unit is in, or null at the group. */
export function companyOfScope(session: Pick<Session, 'scope' | 'unitsById'>): OrgUnit | null {
  let unit: OrgUnit | undefined = session.scope;
  while (unit) {
    if (unit.type === 'company') return unit;
    unit = unit.parentId ? session.unitsById.get(unit.parentId) : undefined;
  }
  return null;
}

/** Companies a company-level AI screen can show: the working one, or every company of the group with the permission. */
export function aiCompanies(session: ScopeSession, permission: string): OrgUnit[] {
  const own = companyOfScope(session);
  const candidates = own
    ? [own]
    : session.units.filter((u) => u.type === 'company' && u.groupId === session.scope.groupId && u.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  return candidates.filter((company) => session.canAnywhere(permission, company));
}

/** A short line for an output: its summary, reply or message. */
export function outputHeadline(output: Json): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  for (const key of ['summary', 'reply', 'message', 'text', 'rationale']) {
    const value = output[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export const isJsonObject = (value: Json | undefined): value is { [key: string]: Json } => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Field names that read badly when split. */
const KEY_LABELS: Record<string, string> = {
  amountDueMinor: 'Amount due (minor units)',
  budgetMinor: 'Budget (minor units)',
  companyIds: 'Companies',
  productId: 'Product',
  companyId: 'Company',
  productLineId: 'Product line',
  timeZone: 'Time zone',
};

/** A schema or output key as a label: "senderName" → "Sender name", "target_date" → "Target date". */
export function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? humanize(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
}
