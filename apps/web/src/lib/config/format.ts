import type { CustomFieldType, DealKind, ProductAttributes, StageCategory } from '../crm/types';
import type { FieldInput } from '../types';

// Labels and small helpers for the configuration screens.

/** "Demo booked" → "demo_booked": the API's key format (lowercase letters, digits, underscores, a letter first). */
export function toKey(text: string): string {
  const key = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return key;
}

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const CATEGORY_LABELS: Record<StageCategory, string> = { open: 'Open', won: 'Won', lost: 'Lost' };

export const KIND_LABELS: Record<DealKind, string> = { b2c: 'Families (B2C)', b2b: 'Institutes (B2B)' };
export const KIND_SHORT: Record<DealKind, string> = { b2c: 'B2C', b2b: 'B2B' };

export const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  number: 'Number',
  date: 'Date',
  select: 'Pick one',
  multiselect: 'Pick several',
  boolean: 'Yes / no',
  phone: 'Phone number',
  email: 'Email address',
  url: 'Web link',
};

export const isChoiceType = (type: CustomFieldType): boolean => type === 'select' || type === 'multiselect';

/** The form control used to preview a custom field (dates use a native date input). */
export const FIELD_INPUTS: Record<Exclude<CustomFieldType, 'date'>, FieldInput> = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  select: 'select',
  multiselect: 'multiselect',
  boolean: 'boolean',
  phone: 'tel',
  email: 'email',
  url: 'url',
};

export const MODE_LABELS: Record<NonNullable<ProductAttributes['mode']>, string> = { online: 'Online', centre: 'At a centre', hybrid: 'Hybrid' };

export const BILLING_LABELS: Record<NonNullable<ProductAttributes['billing']>, string> = {
  one_time: 'One-time fee',
  monthly: 'Monthly',
  annual: 'Annual',
  per_student_year: 'Per student per year',
  per_branch_year: 'Per branch per year',
  per_institute_year: 'Per institute per year',
  per_seat_month: 'Per seat per month',
};

/** "Online · 24 sessions · 12 weeks · Monthly" */
export function describeAttributes(attributes: ProductAttributes): string {
  const parts: string[] = [];
  if (attributes.mode) parts.push(MODE_LABELS[attributes.mode]);
  if (attributes.exam) parts.push(attributes.exam);
  if (attributes.grades?.length) parts.push(`Grades ${attributes.grades.join(', ')}`);
  if (attributes.sessions) parts.push(`${attributes.sessions} sessions`);
  if (attributes.durationWeeks) parts.push(`${attributes.durationWeeks} weeks`);
  if (attributes.tests) parts.push(`${attributes.tests} tests`);
  if (attributes.billing) parts.push(BILLING_LABELS[attributes.billing]);
  if (attributes.addOn) parts.push('Add-on');
  return parts.join(' · ');
}

/** "24 h", "3 days", "2 weeks" for SLA hours. */
export function formatSlaHours(hours: number | null): string {
  if (!hours) return 'No target';
  if (hours % 168 === 0) return `${hours / 168} ${hours === 168 ? 'week' : 'weeks'}`;
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? 'day' : 'days'}`;
  return `${hours} h`;
}

/** Move an item one place up (-1) or down (+1); returns a new array (unchanged at the ends). */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

/** Move an item to another index (drag and drop). */
export function moveTo<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
