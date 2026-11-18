// Template variables and rendering for live previews. Mirrors apps/api/src/core/messaging/templates.js
// (the server renders and validates again on every send), so what the editor and the reply box show
// is what goes out.

import type { MessageChannel, TemplateButton, TemplateHeader } from './types';

export const VARIABLE_NAME = /^(?:[a-z][a-z0-9_]{0,39}|[1-9][0-9]?)$/;
export const TEMPLATE_NAME = /^[a-z0-9_]{1,100}$/;
export const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export interface RenderInput {
  channel: MessageChannel;
  header?: TemplateHeader | null;
  subject?: string | null;
  body: string;
  footer?: string | null;
  buttons?: TemplateButton[];
}

export interface Rendered {
  header: string | null;
  subject: string | null;
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
  missing: string[];
}

/** Variable names in a text, in order of appearance (repeats removed). Invalid names are skipped. */
export function variablesIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? '').trim();
    if (VARIABLE_NAME.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Every variable a template uses: subject, header, body, link buttons. */
export function templateVariables(input: RenderInput): string[] {
  const texts = [input.subject, input.header?.text, input.body, ...(input.buttons ?? []).map((b) => (b.type === 'url' ? b.url : null))];
  const out: string[] = [];
  for (const text of texts) for (const name of variablesIn(text)) if (!out.includes(name)) out.push(name);
  return out;
}

/** The body as the provider registers it: {{student_name}} becomes {{1}} by first appearance. */
export function toProviderText(text: string): string {
  const order = variablesIn(text);
  return text.replace(PLACEHOLDER, (whole, raw: string) => {
    const index = order.indexOf(raw.trim());
    return index === -1 ? whole : `{{${index + 1}}}`;
  });
}

export function cleanValue(value: string | undefined, channel: MessageChannel): string {
  let text = (value ?? '').trim();
  if (channel === 'whatsapp' || channel === 'sms') text = text.replace(/\s+/g, ' ');
  return text.slice(0, channel === 'sms' ? 160 : 1024);
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, raw: string) => values[raw.trim()] || whole);
}

/** Fill a template with values; variables without a value keep their {{placeholder}} and are listed in `missing`. */
export function renderTemplate(input: RenderInput, variables: Record<string, string>): Rendered {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of templateVariables(input)) {
    const value = cleanValue(variables[name], input.channel);
    if (value) values[name] = value;
    else missing.push(name);
  }
  return {
    header: input.header?.text ? fill(input.header.text, values) : null,
    subject: input.subject ? fill(input.subject, values) : null,
    body: fill(input.body, values),
    footer: input.footer ?? null,
    buttons: (input.buttons ?? []).map((button) => (button.type === 'url' ? { ...button, url: fill(button.url, values) } : button)),
    missing,
  };
}

/** Split rendered text into plain parts and still-unfilled {{placeholders}}, for highlighting. */
export function previewParts(text: string): Array<{ text: string; variable: boolean }> {
  const parts: Array<{ text: string; variable: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), variable: false });
    parts.push({ text: match[0], variable: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), variable: false });
  return parts;
}

/** Variables the sender doesn't type: the server fills them from the person, company, deal and owner. */
export const STANDARD_VARIABLES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'first_name', label: "The person's first name" },
  { name: 'contact_name', label: "The person's full name" },
  { name: 'company_name', label: 'Your company' },
  { name: 'deal_ref', label: 'The lead reference' },
  { name: 'owner_name', label: 'The lead owner' },
];

/** "booking_link" → "Booking link". */
export function variableLabel(name: string): string {
  const known = STANDARD_VARIABLES.find((v) => v.name === name);
  if (known) return known.label;
  if (/^\d+$/.test(name)) return `Value ${name}`;
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
