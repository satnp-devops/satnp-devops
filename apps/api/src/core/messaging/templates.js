// Message templates: variables, validation and rendering. Pure, so the same rules run in the API,
// in automations and in unit tests (apps/web/src/lib/messaging/render.ts mirrors render for the
// editor's live preview).
//
// A template body uses named variables: "Hi {{parent_name}}, book your demo: {{booking_link}}".
// WhatsApp registers templates with positional variables ({{1}}, {{2}}), so each named variable is
// sent as the parameter at the position of its first appearance (toProviderText shows the text the
// provider sees). Positional names ({{1}}) work too.

/** A variable name: lower-case snake case, or a position 1 to 99. */
export const VARIABLE_NAME = /^(?:[a-z][a-z0-9_]{0,39}|[1-9][0-9]?)$/;
export const TEMPLATE_NAME = /^[a-z0-9_]{1,100}$/;
export const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Per channel limits, from the providers' rules (WhatsApp Cloud API, DLT SMS, email). */
export const TEMPLATE_LIMITS = Object.freeze({
  whatsapp: { body: 1024, header: 60, footer: 60, buttons: 10, buttonText: 25, bodyVariables: 20, headerVariables: 1 },
  sms: { body: 1000, bodyVariables: 20, value: 160 },
  email: { body: 20_000, subject: 200, bodyVariables: 50 },
});

const VALUE_MAX = 1024;

/**
 * Placeholders in a text, in order, and problems with the braces. Pure.
 * @returns {{ names: string[], issues: string[] }} names in order of appearance (with repeats)
 */
export function placeholdersIn(text) {
  const names = [];
  const issues = [];
  if (!text) return { names, issues };
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1].trim();
    if (!VARIABLE_NAME.test(name)) {
      issues.push(name ? `"{{${name}}}" is not a variable name: use lower-case letters, digits and underscores` : 'Empty {{ }}: name the variable');
    } else {
      names.push(name);
    }
  }
  const stripped = text.replace(PLACEHOLDER, '');
  if (stripped.includes('{{') || stripped.includes('}}')) issues.push('A {{ or }} is not closed: write variables like {{student_name}}');
  return { names, issues };
}

const unique = (names) => [...new Set(names)];

/** The body's variables in the order WhatsApp numbers them. Pure. */
export const bodyVariableOrder = (body) => unique(placeholdersIn(body).names);

/** Every variable a template uses, in order: subject, header, body, buttons. Pure. */
export function templateVariables(content) {
  const texts = [content.subject, content.header?.type === 'text' ? content.header.text : null, content.body];
  for (const button of content.buttons ?? []) if (button.type === 'url') texts.push(button.url);
  return unique(texts.flatMap((text) => placeholdersIn(text).names));
}

/** The text as the provider registers it: {{student_name}} becomes {{1}} by first appearance. Pure. */
export function toProviderText(text, order = bodyVariableOrder(text)) {
  if (!text) return text ?? null;
  return text.replace(PLACEHOLDER, (whole, raw) => {
    const index = order.indexOf(raw.trim());
    return index === -1 ? whole : `{{${index + 1}}}`;
  });
}

const issue = (path, message) => ({ path, message });

/**
 * Check a template's identity and content for a channel. Pure.
 * requireSamples: every variable needs a sample value (WhatsApp asks for them when a template is submitted).
 * @param {{ channel: string, name?: string, language?: string, category?: string,
 *           header?: { type: 'text', text: string } | null, subject?: string | null, body: string,
 *           footer?: string | null, buttons?: Array<{ type: string, text: string, url?: string, phone?: string }>,
 *           samples?: Record<string, string> }} template
 * @param {{ requireSamples?: boolean, path?: string }} [options]
 * @returns {Array<{ path: string, message: string }>} paths like "body.body" or "body.buttons.0.url"
 */
export function validateTemplate(template, { requireSamples = false, path = 'body' } = {}) {
  const { channel } = template;
  const limits = TEMPLATE_LIMITS[channel];
  const out = [];
  if (!limits) return [issue(`${path}.channel`, 'Pick WhatsApp, email or SMS')];
  if (template.name !== undefined && !TEMPLATE_NAME.test(template.name)) {
    out.push(issue(`${path}.name`, 'Use lower-case letters, digits and underscores, like booking_link'));
  }
  if (template.language !== undefined && !TEMPLATE_LANGUAGE.test(template.language)) {
    out.push(issue(`${path}.language`, 'Use a language code like en, hi or en_US'));
  }

  const body = template.body ?? '';
  if (!body.trim()) out.push(issue(`${path}.body`, 'Write the message'));
  if (body.length > limits.body) out.push(issue(`${path}.body`, `Keep the message under ${limits.body} characters`));
  const bodyCheck = placeholdersIn(body);
  for (const message of bodyCheck.issues) out.push(issue(`${path}.body`, message));
  const bodyNames = unique(bodyCheck.names);
  if (bodyNames.length > limits.bodyVariables) out.push(issue(`${path}.body`, `Use at most ${limits.bodyVariables} variables`));

  if (channel === 'whatsapp') {
    // Meta rejects templates whose body starts or ends with a variable.
    const trimmed = body.trim();
    if (/^\{\{[^{}]*\}\}/.test(trimmed) || /\{\{[^{}]*\}\}$/.test(trimmed)) {
      out.push(issue(`${path}.body`, "WhatsApp doesn't accept a message that starts or ends with a variable: add some words around it"));
    }
    if (template.header) {
      const text = template.header.text ?? '';
      if (!text.trim()) out.push(issue(`${path}.header.text`, 'Write the header or remove it'));
      if (text.length > limits.header) out.push(issue(`${path}.header.text`, `Keep the header under ${limits.header} characters`));
      const headerCheck = placeholdersIn(text);
      for (const message of headerCheck.issues) out.push(issue(`${path}.header.text`, message));
      if (unique(headerCheck.names).length > limits.headerVariables) out.push(issue(`${path}.header.text`, 'A header can have one variable'));
    }
    if (template.footer) {
      if (template.footer.length > limits.footer) out.push(issue(`${path}.footer`, `Keep the footer under ${limits.footer} characters`));
      if (placeholdersIn(template.footer).names.length || template.footer.includes('{{')) {
        out.push(issue(`${path}.footer`, "A footer can't have variables"));
      }
    }
    const buttons = template.buttons ?? [];
    if (buttons.length > limits.buttons) out.push(issue(`${path}.buttons`, `Use at most ${limits.buttons} buttons`));
    buttons.forEach((button, i) => {
      const at = `${path}.buttons.${i}`;
      if (!button.text?.trim()) out.push(issue(`${at}.text`, 'Name the button'));
      else if (button.text.length > limits.buttonText) out.push(issue(`${at}.text`, `Keep button text under ${limits.buttonText} characters`));
      if (button.type === 'url') {
        const url = button.url ?? '';
        const check = placeholdersIn(url);
        for (const message of check.issues) out.push(issue(`${at}.url`, message));
        if (check.names.length > 1) out.push(issue(`${at}.url`, 'A link can have one variable, at the end'));
        else if (check.names.length === 1 && !/\{\{[^{}]*\}\}$/.test(url)) out.push(issue(`${at}.url`, 'Put the variable at the end of the link'));
        if (!/^https:\/\/[^\s/{}]+(\/\S*)?$/.test(url)) out.push(issue(`${at}.url`, 'Use a full link starting with https://'));
      } else if (button.type === 'phone') {
        if (!/^\+[1-9]\d{6,14}$/.test(button.phone ?? '')) out.push(issue(`${at}.phone`, 'Use a number with its country code, like +919876543210'));
      } else if (button.type !== 'quick_reply') {
        out.push(issue(`${at}.type`, 'Pick a quick reply, link or phone button'));
      }
    });
  } else {
    if (template.header) out.push(issue(`${path}.header`, 'Only WhatsApp templates have a header'));
    if (template.footer) out.push(issue(`${path}.footer`, 'Only WhatsApp templates have a footer'));
    if ((template.buttons ?? []).length) out.push(issue(`${path}.buttons`, 'Only WhatsApp templates have buttons'));
  }

  if (channel === 'email') {
    const subject = template.subject ?? '';
    if (!subject.trim()) out.push(issue(`${path}.subject`, 'Write a subject'));
    if (subject.length > limits.subject) out.push(issue(`${path}.subject`, `Keep the subject under ${limits.subject} characters`));
    for (const message of placeholdersIn(subject).issues) out.push(issue(`${path}.subject`, message));
  } else if (template.subject) {
    out.push(issue(`${path}.subject`, 'Only email templates have a subject'));
  }

  if (requireSamples) {
    const samples = template.samples ?? {};
    for (const name of templateVariables(template)) {
      if (!String(samples[name] ?? '').trim()) out.push(issue(`${path}.samples.${name}`, `Give a sample for {{${name}}}`));
    }
  }
  return out;
}

/** A variable's value as the channel accepts it. WhatsApp parameters can't hold new lines, tabs or long runs of spaces. */
export function cleanValue(value, channel) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (channel === 'whatsapp' || channel === 'sms') text = text.replace(/\s+/g, ' ');
  const max = channel === 'sms' ? TEMPLATE_LIMITS.sms.value : VALUE_MAX;
  return text.slice(0, max);
}

function fill(text, values) {
  if (!text) return text ?? null;
  return text.replace(PLACEHOLDER, (whole, raw) => {
    const name = raw.trim();
    return Object.hasOwn(values, name) && values[name] !== '' ? values[name] : whole;
  });
}

/**
 * Fill a template with values. Pure.
 *   missing     variables without a value (the text keeps their {{placeholder}})
 *   parameters  what the WhatsApp adapter takes: body values by position, the header value, button values
 *   values      the cleaned values that were used, by name
 * @param {{ channel: string, header?: object | null, subject?: string | null, body: string, footer?: string | null, buttons?: object[] }} content
 * @param {Record<string, unknown>} variables
 */
export function renderTemplate(content, variables = {}) {
  const names = templateVariables(content);
  const values = {};
  const missing = [];
  for (const name of names) {
    const value = cleanValue(variables[name], content.channel);
    if (value) values[name] = value;
    else missing.push(name);
  }
  const headerText = content.header?.type === 'text' ? content.header.text : null;
  const buttons = (content.buttons ?? []).map((button) => (button.type === 'url' ? { ...button, url: fill(button.url, values) } : { ...button }));
  return {
    subject: fill(content.subject, values),
    header: headerText ? { type: 'text', text: fill(headerText, values) } : null,
    body: fill(content.body, values),
    footer: content.footer ?? null,
    buttons,
    missing,
    values,
    parameters: {
      body: bodyVariableOrder(content.body).map((name) => values[name] ?? ''),
      header: headerText ? unique(placeholdersIn(headerText).names).map((name) => values[name] ?? '') : [],
      buttons: (content.buttons ?? [])
        .filter((button) => button.type === 'url' && placeholdersIn(button.url).names.length === 1)
        .map((button) => values[placeholdersIn(button.url).names[0]] ?? ''),
    },
  };
}

/** The text of a rendered template as one plain message (timeline body, email text, previews). Pure. */
export function renderedText(rendered) {
  return [rendered.header?.text, rendered.body, rendered.footer].filter(Boolean).join('\n\n');
}

/** Variables every template may use without the sender typing them: filled from the person, company, deal and owner. */
export const STANDARD_VARIABLES = Object.freeze([
  { name: 'first_name', label: "The person's first name" },
  { name: 'contact_name', label: "The person's full name" },
  { name: 'company_name', label: 'Your company' },
  { name: 'deal_ref', label: 'The lead reference, like SP-1042' },
  { name: 'owner_name', label: 'The lead owner' },
]);

/**
 * Values for the standard variables. Pure. Names are never personal data that needs masking
 * (docs/crm/PHASE2_CONTRACT.md §4.1), so these are safe to show to anyone who sees the person.
 * @param {{ contact: { first_name?: string | null, display_name?: string | null, erased_at?: unknown }, company?: { name: string } | null, deal?: { ref: string } | null, ownerName?: string | null }} input
 * @returns {Record<string, string>}
 */
export function standardVariables({ contact, company = null, deal = null, ownerName = null }) {
  const out = {};
  const fullName = contact?.erased_at ? null : contact?.display_name;
  const first = contact?.erased_at ? null : contact?.first_name || fullName?.split(/\s+/)[0];
  if (first && fullName !== 'Unnamed contact') out.first_name = first;
  if (fullName && fullName !== 'Unnamed contact') out.contact_name = fullName;
  if (company?.name) out.company_name = company.name;
  if (deal?.ref) out.deal_ref = deal.ref;
  if (ownerName) out.owner_name = ownerName;
  return out;
}
