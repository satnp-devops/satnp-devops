import { z } from 'zod';

/**
 * Provider field definitions: one list per provider drives both the API's validation and the
 * connect form in the web app (rendered with components/DynamicField), so adding a provider
 * needs no frontend change.
 *
 *   { key, label, input, secret?, required?, placeholder?, help?, options?, pattern?, default?, maxLength? }
 *
 *   input     text | textarea | email | url | tel | select | boolean | number
 *   secret    true: stored encrypted in the connection's credentials, never sent back (only a hint
 *             such as "••••3f9a"); false: plain connection config, shown and editable
 *   pattern   { regex, message } checked on text values
 */

const blankToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

function baseSchema(field) {
  switch (field.input) {
    case 'boolean':
      return z.boolean();
    case 'number':
      return z.coerce.number().int().min(field.min ?? 0).max(field.max ?? 1_000_000_000);
    case 'select':
      return z.enum(field.options.map((option) => String(option.value)));
    case 'email':
      return z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.email().max(254));
    case 'url':
      return z.url({ protocol: /^https$/, error: 'Enter a full link starting with https://' }).max(2000);
    default: {
      let schema = z.string().trim().max(field.maxLength ?? (field.input === 'textarea' ? 20_000 : 500));
      if (field.pattern) schema = schema.regex(field.pattern.regex, field.pattern.message);
      else if (field.input === 'tel') schema = schema.regex(/^\+[1-9]\d{6,14}$/, 'Use an E.164 number such as +919876543210');
      return schema;
    }
  }
}

function fieldSchema(field, { partial = false } = {}) {
  const base = baseSchema(field);
  if (field.required && !partial) {
    return z.preprocess(blankToUndefined, z.unknown().refine((v) => v !== undefined && v !== null, 'Required').pipe(base));
  }
  if (!partial && field.default !== undefined) return z.preprocess(blankToUndefined, base.default(field.default));
  // Optional: blank means "not set". On partial updates null clears an optional value.
  return z.preprocess(blankToUndefined, partial && !field.required ? base.nullable().optional() : base.optional());
}

/** zod schema for the non-secret config of a provider. */
export function configSchema(fields, options) {
  return z.strictObject(Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.key, fieldSchema(f, options)])));
}

/** zod schema for the secret credentials of a provider. With partial, every key may be left out (kept as stored). */
export function credentialsSchema(fields, options) {
  return z.strictObject(Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.key, fieldSchema(f, options)])));
}

/** A secret's hint for the UI: the last four characters of long values, never the value. */
export function secretHint(value) {
  const text = String(value ?? '');
  if (!text) return null;
  return text.length >= 16 ? `••••${text.slice(-4)}` : '••••';
}

export function credentialHints(fields, credentials) {
  const hints = {};
  for (const field of fields.filter((f) => f.secret)) {
    const hint = secretHint(credentials?.[field.key]);
    if (hint) hints[field.key] = hint;
  }
  return hints;
}

/** Field definitions as the API sends them (patterns become a hint, never a RegExp). */
export function publicFields(fields) {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    input: field.input === 'number' ? 'number' : field.input,
    secret: field.secret === true,
    required: field.required === true,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.help ? { help: field.help } : {}),
    ...(field.options ? { options: field.options.map((o) => ({ value: String(o.value), label: o.label })) } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
  }));
}

/** Check a field list once at load time: keys unique, selects have options, secrets are text. */
export function assertFields(providerKey, fields) {
  const seen = new Set();
  for (const field of fields) {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(field.key ?? '')) throw new Error(`${providerKey}: field key "${field.key}" must be camelCase`);
    if (seen.has(field.key)) throw new Error(`${providerKey}: duplicate field "${field.key}"`);
    seen.add(field.key);
    if (!field.label) throw new Error(`${providerKey}: field "${field.key}" needs a label`);
    if (field.input === 'select' && !field.options?.length) throw new Error(`${providerKey}: select "${field.key}" needs options`);
    if (field.secret && !['text', 'textarea'].includes(field.input)) {
      throw new Error(`${providerKey}: secret "${field.key}" must be text or textarea`);
    }
  }
}
