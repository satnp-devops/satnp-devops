/**
 * Dynamic parameter values for actions, AI steps and approvals.
 *
 *   'Call {{ record.name }} about {{ record.course }}'   text with interpolations (always text)
 *   { "$expr": "record.ownerId" }                         the raw value of one expression
 *
 * Anything else is a literal. `{{` always starts an interpolation.
 */
import { ExprError, compile, evaluate, toPlain, toText } from './expr.js';

/**
 * Splits template text into literal and expression parts.
 * Expression errors are re-positioned to the offset inside the whole template.
 * @param {string} template
 * @returns {({ text: string } | { source: string, offset: number })[]}
 */
export function parseTemplate(template) {
  const parts = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open === -1) {
      parts.push({ text: template.slice(i) });
      break;
    }
    if (open > i) parts.push({ text: template.slice(i, open) });
    const close = template.indexOf('}}', open + 2);
    if (close === -1) throw new ExprError('"{{" is missing its closing "}}"', open);
    const source = template.slice(open + 2, close);
    if (source.trim() === '') throw new ExprError('Empty {{ }} in text', open);
    try {
      compile(source);
    } catch (error) {
      if (error instanceof ExprError) throw new ExprError(error.reason, open + 2 + error.pos, error.code);
      throw error;
    }
    parts.push({ source, offset: open + 2 });
    i = close + 2;
  }
  return parts;
}

/** @param {unknown} value */
export const isTemplate = (value) => typeof value === 'string' && value.includes('{{');

/** @param {unknown} value */
export function isExprRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.$expr === 'string'
  );
}

/**
 * Renders template text.
 * @param {string} template
 * @param {Record<string, unknown>} scope
 * @param {{ now: number }} options
 */
export function renderTemplate(template, scope, options) {
  let out = '';
  for (const part of parseTemplate(template)) {
    if ('text' in part) {
      out += part.text;
      continue;
    }
    try {
      out += toText(evaluate(compile(part.source), scope, options));
    } catch (error) {
      if (error instanceof ExprError) throw new ExprError(error.reason, part.offset + error.pos, error.code);
      throw error;
    }
  }
  return out;
}

/**
 * Resolves every dynamic value inside params (deeply) to plain JSON data.
 * Keys named __proto__ are dropped so the result is always a safe plain object.
 * @param {unknown} value
 * @param {Record<string, unknown>} scope
 * @param {{ now: number }} options
 * @param {(string | number)[]} [path] where errors are reported
 */
export function resolveParams(value, scope, options, path = []) {
  try {
    if (isTemplate(value)) return renderTemplate(/** @type {string} */ (value), scope, options);
    if (isExprRef(value)) return toPlain(evaluate(compile(value.$expr), scope, options));
  } catch (error) {
    if (error instanceof ExprError) throw Object.assign(error, { path });
    throw error;
  }
  if (Array.isArray(value)) return value.map((item, i) => resolveParams(item, scope, options, [...path, i]));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__') continue;
      out[key] = resolveParams(item, scope, options, [...path, key]);
    }
    return out;
  }
  return value;
}

/**
 * Every dynamic value inside params, with its location, for validation.
 * @param {unknown} value
 * @param {(string | number)[]} [path]
 * @returns {{ path: (string | number)[], kind: 'template' | 'expr', source: string }[]}
 */
export function collectDynamic(value, path = []) {
  if (isTemplate(value)) return [{ path, kind: 'template', source: /** @type {string} */ (value) }];
  if (isExprRef(value)) return [{ path, kind: 'expr', source: value.$expr }];
  if (Array.isArray(value)) return value.flatMap((item, i) => collectDynamic(item, [...path, i]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => collectDynamic(item, [...path, key]));
  }
  return [];
}

/**
 * The expression sources inside one dynamic value (one for $expr, one per {{ }}).
 * Throws ExprError with a position inside the template when a part doesn't parse.
 * @param {{ kind: 'template' | 'expr', source: string }} dynamic
 */
export function dynamicSources(dynamic) {
  if (dynamic.kind === 'expr') {
    compile(dynamic.source);
    return [dynamic.source];
  }
  return parseTemplate(dynamic.source)
    .filter((part) => 'source' in part)
    .map((part) => /** @type {{ source: string }} */ (part).source);
}
