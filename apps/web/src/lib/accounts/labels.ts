import { humanize } from '@/lib/crm/format';
import type { AccountContactRole, AccountKind, LinkStatus } from '@/lib/crm/types';

// Words for the institutes screens. Kinds mirror ACCOUNT_KINDS in apps/api/src/core/crm/constants.js;
// a kind added there later shows humanised until it gets a label here.

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  coaching_institute: 'Coaching institute',
  school: 'School',
  college: 'College',
  independent_mentor: 'Independent mentor',
  other: 'Other',
};

export const ACCOUNT_KINDS = Object.keys(ACCOUNT_KIND_LABELS) as AccountKind[];

export function accountKindLabel(kind: string): string {
  return kind in ACCOUNT_KIND_LABELS ? ACCOUNT_KIND_LABELS[kind as AccountKind] : humanize(kind);
}

/** A company's relationship with an institute. The stored values are the shared link statuses. */
export const ACCOUNT_STATUS_LABELS: Record<LinkStatus, string> = {
  lead: 'Prospect',
  customer: 'Customer',
  former: 'Churned',
};

export const ACCOUNT_STATUSES = Object.keys(ACCOUNT_STATUS_LABELS) as LinkStatus[];

export type StatusTone = 'success' | 'warning' | 'neutral' | 'accent';

export const ACCOUNT_STATUS_TONES: Record<LinkStatus, StatusTone> = {
  lead: 'accent',
  customer: 'success',
  former: 'warning',
};

export const CONTACT_ROLE_LABELS: Record<AccountContactRole, string> = {
  decision_maker: 'Decision maker',
  influencer: 'Influencer',
  champion: 'Champion',
  user: 'User',
  billing: 'Billing',
  other: 'Other',
};

export const CONTACT_ROLES = Object.keys(CONTACT_ROLE_LABELS) as AccountContactRole[];

/** "1,200 students · 3 branches", leaving out what isn't known. */
export function sizeSummary(studentCount: number | null, branchCount: number | null): string {
  const parts: string[] = [];
  if (studentCount !== null) parts.push(`${studentCount.toLocaleString('en-IN')} ${studentCount === 1 ? 'student' : 'students'}`);
  if (branchCount !== null && branchCount > 0) parts.push(`${branchCount.toLocaleString('en-IN')} ${branchCount === 1 ? 'branch' : 'branches'}`);
  return parts.join(' · ');
}

/** Show a website without the scheme: "https://www.sunrise.example/" → "www.sunrise.example". */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
