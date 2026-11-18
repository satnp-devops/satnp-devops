/**
 * A small, safe expression language for flow conditions, trigger filters and
 * parameter templates. Source text is parsed to an AST and walked by a plain
 * interpreter: there is no eval, no Function constructor, no property access
 * beyond own data fields, and no way to call anything but the whitelisted
 * functions below.
 *
 *   record.stage == 'new' and record.score >= 60
 *   trigger.payload.amount.minor > 500000 or 'vip' in record.tags
 *   record.lastActivityAt < now - 3d
 *   lower(record.city) in ['pune', 'mumbai'] and not record.phone exists
 *   local_hour(now, 'Asia/Kolkata') >= 9 and local_weekday(now, 'Asia/Kolkata') <= 5
 *
 * Precedence, lowest first:
 *   or ||   ·   and &&   ·   not !   ·   == != < <= > >= in, not in, contains, not contains, exists
 *   ·   + -   ·   * / %   ·   unary -   ·   literals, paths, calls, ( ), [ ]
 * `not` applies to the whole comparison after it: `not a == b` is `not (a == b)`.
 * Comparisons don't chain: `1 < x < 5` is an error, write `1 < x and x < 5`.
 *
 * Values: null, true/false, numbers, 'text' or "text", lists, durations (3d, 1h30m),
 * instants (`now`, `date('2026-04-01T09:00:00+05:30')`, or ISO text compared with an
 * instant). A missing field is null. Comparing null with <, >, <= or >= is false.
 */
import { formatDuration, parseDuration, parseInstant, toIso, zonedParts, isValidTimeZone } from './time.js';

export const LIMITS = Object.freeze({ maxLength: 2000, maxDepth: 40, maxListItems: 200 });

const FORBIDDEN_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'contains', 'exists', 'true', 'false', 'null', 'now']);

/** An error in an expression, with the position (0-based offset and 1-based column) it was found at. */
export class ExprError extends Error {
  /**
   * @param {string} message
   * @param {number} pos
   * @param {'EXPR_SYNTAX' | 'EXPR_TYPE' | 'EXPR_LIMIT'} code
   */
  constructor(message, pos, code = 'EXPR_SYNTAX') {
    super(`${message} (column ${pos + 1})`);
    this.name = 'ExprError';
    this.code = code;
    this.pos = pos;
    this.column = pos + 1;
    this.reason = message;
  }
}

/**
 * Two lines for an editor or log: the source, then a caret under the error.
 * @param {string} source
 * @param {ExprError} error
 */
export function explainError(source, error) {
  return `${source}\n${' '.repeat(Math.max(0, error.pos))}^ ${error.reason ?? error.message}`;
}

// ---------------------------------------------------------------------------
// Lexer

/** @typedef {{ kind: 'num' | 'dur' | 'str' | 'ident' | 'op' | 'eof', value: any, pos: number, text?: string }} Token */

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['<', '>', '+', '-', '*', '/', '%', '(', ')', '[', ']', ',', '.', '!']);

/**
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  if (typeof source !== 'string') throw new ExprError('Expression must be text', 0);
  if (source.length > LIMITS.maxLength) {
    throw new ExprError(`Expression is longer than ${LIMITS.maxLength} characters`, LIMITS.maxLength, 'EXPR_LIMIT');
  }
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    const start = i;
    if (isDigit(ch)) {
      while (isDigit(source[i])) i += 1;
      if (isLetter(source[i])) {
        while (isLetter(source[i]) || isDigit(source[i])) i += 1;
        const text = source.slice(start, i);
        const ms = parseDuration(text);
        if (ms === null) {
          throw new ExprError(`"${text}" is not a duration (use ms, s, m, h, d or w, e.g. 3d or 1h30m)`, start);
        }
        tokens.push({ kind: 'dur', value: ms, pos: start, text });
        continue;
      }
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i += 1;
        while (isDigit(source[i])) i += 1;
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isSafeInteger(value) && Number.isInteger(value)) throw new ExprError(`Number ${text} is too large`, start);
      tokens.push({ kind: 'num', value, pos: start, text });
      continue;
    }
    if (isLetter(ch) || ch === '_') {
      while (isLetter(source[i]) || isDigit(source[i]) || source[i] === '_') i += 1;
      const text = source.slice(start, i);
      tokens.push({ kind: 'ident', value: text, pos: start, text });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const { value, end } = readString(source, i);
      tokens.push({ kind: 'str', value, pos: start, text: source.slice(start, end) });
      i = end;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ kind: 'op', value: two, pos: start, text: two });
      i += 2;
      continue;
    }
    if (ch === '=') throw new ExprError('Use == to compare values', start);
    if (ch === '&' || ch === '|') throw new ExprError(`Use ${ch}${ch} or ${ch === '&' ? 'and' : 'or'}`, start);
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ kind: 'op', value: ch, pos: start, text: ch });
      i += 1;
      continue;
    }
    throw new ExprError(`Unexpected character ${JSON.stringify(ch)}`, start);
  }
  tokens.push({ kind: 'eof', value: null, pos: source.length });
  return tokens;
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isLetter(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

function readString(source, start) {
  const quote = source[start];
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === 'u') {
        const hex = source.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ExprError('Write \\u followed by four hex digits', i);
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      if (next === undefined || !(next in ESCAPES)) throw new ExprError(`Unknown escape \\${next ?? ''}`, i);
      value += ESCAPES[next];
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  throw new ExprError('Text is missing its closing quote', start);
}

// ---------------------------------------------------------------------------
// Parser

/**
 * @typedef {(
 *   | { type: 'literal', value: null | boolean | number | string, pos: number }
 *   | { type: 'duration', ms: number, pos: number }
 *   | { type: 'now', pos: number }
 *   | { type: 'path', segments: (string | number)[], pos: number }
 *   | { type: 'list', items: Node[], pos: number }
 *   | { type: 'call', name: string, args: Node[], pos: number }
 *   | { type: 'unary', op: 'not' | 'neg', arg: Node, pos: number }
 *   | { type: 'exists', arg: Node, pos: number }
 *   | { type: 'logical', op: 'and' | 'or', left: Node, right: Node, pos: number }
 *   | { type: 'binary', op: string, left: Node, right: Node, pos: number }
 * )} Node
 */

const COMPARISON_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/**
 * Parses an expression to an AST. Throws ExprError with the position of the problem.
 * @param {string} source
 * @returns {Node}
 */
export function parse(source) {
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;

  const peek = (offset = 0) => tokens[Math.min(index + offset, tokens.length - 1)];
  const next = () => tokens[index++];
  const isOp = (token, value) => token.kind === 'op' && token.value === value;
  const isWord = (token, value) => token.kind === 'ident' && token.value === value;
  const describe = (token) => (token.kind === 'eof' ? 'the end of the expression' : `"${token.text}"`);
  const expectOp = (value, what) => {
    const token = next();
    if (!isOp(token, value)) throw new ExprError(`Expected ${what} but found ${describe(token)}`, token.pos);
    return token;
  };
  const nest = (pos, fn) => {
    depth += 1;
    if (depth > LIMITS.maxDepth) throw new ExprError('Expression is nested too deeply', pos, 'EXPR_LIMIT');
    try {
      return fn();
    } finally {
      depth -= 1;
    }
  };

  function parseOr() {
    let left = parseAnd();
    while (isWord(peek(), 'or') || isOp(peek(), '||')) {
      const token = next();
      left = { type: 'logical', op: 'or', left, right: parseAnd(), pos: token.pos };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (isWord(peek(), 'and') || isOp(peek(), '&&')) {
      const token = next();
      left = { type: 'logical', op: 'and', left, right: parseNot(), pos: token.pos };
    }
    return left;
  }

  function parseNot() {
    const token = peek();
    if (isWord(token, 'not') || isOp(token, '!')) {
      next();
      return nest(token.pos, () => ({ type: 'unary', op: 'not', arg: parseNot(), pos: token.pos }));
    }
    return parseComparison();
  }

  function comparisonOperator() {
    const token = peek();
    if (token.kind === 'op' && COMPARISON_OPS.has(token.value)) return { op: token.value, width: 1, token };
    if (isWord(token, 'in') || isWord(token, 'contains')) return { op: token.value, width: 1, token };
    if (isWord(token, 'exists')) return { op: 'exists', width: 1, token };
    if (isWord(token, 'not') && (isWord(peek(1), 'in') || isWord(peek(1), 'contains'))) {
      return { op: `not ${peek(1).value}`, width: 2, token };
    }
    return null;
  }

  function parseComparison() {
    const left = parseAdditive();
    const found = comparisonOperator();
    if (!found) return left;
    index += found.width;
    let node;
    if (found.op === 'exists') {
      node = { type: 'exists', arg: left, pos: found.token.pos };
    } else {
      const right = parseAdditive();
      if (found.op.startsWith('not ')) {
        node = {
          type: 'unary',
          op: 'not',
          arg: { type: 'binary', op: found.op.slice(4), left, right, pos: found.token.pos },
          pos: found.token.pos,
        };
      } else {
        node = { type: 'binary', op: found.op, left, right, pos: found.token.pos };
      }
    }
    const again = comparisonOperator();
    if (again) {
      throw new ExprError(`Comparisons can't be chained; join them with "and" (found ${describe(again.token)})`, again.token.pos);
    }
    return node;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (isOp(peek(), '+') || isOp(peek(), '-')) {
      const token = next();
      left = { type: 'binary', op: token.value, left, right: parseMultiplicative(), pos: token.pos };
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (isOp(peek(), '*') || isOp(peek(), '/') || isOp(peek(), '%')) {
      const token = next();
      left = { type: 'binary', op: token.value, left, right: parseUnary(), pos: token.pos };
    }
    return left;
  }

  function parseUnary() {
    const token = peek();
    if (isOp(token, '-')) {
      next();
      return nest(token.pos, () => ({ type: 'unary', op: 'neg', arg: parseUnary(), pos: token.pos }));
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = next();
    switch (token.kind) {
      case 'num':
      case 'str':
        return { type: 'literal', value: token.value, pos: token.pos };
      case 'dur':
        return { type: 'duration', ms: token.value, pos: token.pos };
      case 'op':
        if (token.value === '(') {
          return nest(token.pos, () => {
            const inner = parseOr();
            expectOp(')', 'a closing ")"');
            return inner;
          });
        }
        if (token.value === '[') return nest(token.pos, () => parseList(token));
        throw new ExprError(`Unexpected ${describe(token)}`, token.pos);
      case 'ident':
        return parseIdentifier(token);
      default:
        throw new ExprError('The expression ended too early', token.pos);
    }
  }

  function parseList(open) {
    const items = [];
    if (isOp(peek(), ']')) {
      next();
      return { type: 'list', items, pos: open.pos };
    }
    for (;;) {
      items.push(parseOr());
      if (items.length > LIMITS.maxListItems) {
        throw new ExprError(`Lists can hold at most ${LIMITS.maxListItems} items`, open.pos, 'EXPR_LIMIT');
      }
      const token = next();
      if (isOp(token, ']')) return { type: 'list', items, pos: open.pos };
      if (!isOp(token, ',')) throw new ExprError(`Expected "," or "]" but found ${describe(token)}`, token.pos);
    }
  }

  function parseIdentifier(token) {
    const name = token.value;
    if (name === 'true' || name === 'false') return { type: 'literal', value: name === 'true', pos: token.pos };
    if (name === 'null') return { type: 'literal', value: null, pos: token.pos };
    if (name === 'now') return { type: 'now', pos: token.pos };
    if (KEYWORDS.has(name)) throw new ExprError(`Unexpected "${name}"`, token.pos);
    if (isOp(peek(), '(')) {
      if (!Object.hasOwn(FUNCTIONS, name)) {
        throw new ExprError(`Unknown function "${name}" (available: ${Object.keys(FUNCTIONS).join(', ')})`, token.pos);
      }
      next();
      return nest(token.pos, () => parseCall(token));
    }
    checkField(name, token.pos);
    const segments = [name];
    while (isOp(peek(), '.')) {
      next();
      const part = next();
      if (part.kind === 'ident') {
        checkField(part.value, part.pos);
        segments.push(part.value);
      } else if (part.kind === 'num' && Number.isInteger(part.value) && !part.text.includes('.')) {
        segments.push(part.value);
      } else {
        throw new ExprError(`Expected a field name after "." but found ${describe(part)}`, part.pos);
      }
    }
    if (isOp(peek(), '(')) throw new ExprError('Only built-in functions can be called', peek().pos);
    if (isOp(peek(), '[')) throw new ExprError('Use a dot for list positions, e.g. items.0', peek().pos);
    return { type: 'path', segments, pos: token.pos };
  }

  function parseCall(nameToken) {
    const fn = FUNCTIONS[nameToken.value];
    const args = [];
    if (!isOp(peek(), ')')) {
      for (;;) {
        args.push(parseOr());
        const token = next();
        if (isOp(token, ')')) break;
        if (!isOp(token, ',')) throw new ExprError(`Expected "," or ")" but found ${describe(token)}`, token.pos);
      }
    } else {
      next();
    }
    if (args.length < fn.min || args.length > fn.max) {
      const expected = fn.min === fn.max ? `${fn.min}` : fn.max === Infinity ? `at least ${fn.min}` : `${fn.min} to ${fn.max}`;
      throw new ExprError(`${nameToken.value}() takes ${expected} argument${fn.max === 1 ? '' : 's'}`, nameToken.pos);
    }
    return { type: 'call', name: nameToken.value, args, pos: nameToken.pos };
  }

  const ast = parseOr();
  const rest = peek();
  if (rest.kind !== 'eof') throw new ExprError(`Unexpected ${describe(rest)}`, rest.pos);
  return ast;
}

function checkField(name, pos) {
  if (FORBIDDEN_FIELDS.has(name)) throw new ExprError(`Field name "${name}" is not allowed`, pos);
}

const cache = new Map();

/**
 * parse() with a small memo, for the interpreter, which sees the same sources repeatedly.
 * @param {string} source
 */
export function compile(source) {
  let ast = cache.get(source);
  if (!ast) {
    ast = parse(source);
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    cache.set(source, ast);
  }
  return ast;
}

/**
 * Field paths an expression reads, e.g. [['record', 'stage'], ['steps', 'classify', 'output']].
 * Validation uses it to check roots and step references.
 * @param {Node} ast
 * @returns {(string | number)[][]}
 */
export function collectPaths(ast) {
  const out = [];
  const walk = (node) => {
    switch (node.type) {
      case 'path':
        out.push(node.segments);
        break;
      case 'list':
        node.items.forEach(walk);
        break;
      case 'call':
        node.args.forEach(walk);
        break;
      case 'unary':
      case 'exists':
        walk(node.arg);
        break;
      case 'logical':
      case 'binary':
        walk(node.left);
        walk(node.right);
        break;
      default:
        break;
    }
  };
  walk(ast);
  return out;
}

// ---------------------------------------------------------------------------
// Values

const INSTANT = Symbol('instant');
const DURATION = Symbol('duration');

/** @param {number} ms */
export const instant = (ms) => Object.freeze({ [INSTANT]: true, ms });
/** @param {number} ms */
export const duration = (ms) => Object.freeze({ [DURATION]: true, ms });
export const isInstant = (value) => value !== null && typeof value === 'object' && value[INSTANT] === true;
export const isDuration = (value) => value !== null && typeof value === 'object' && value[DURATION] === true;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function kindOf(value) {
  if (value === null) return 'null';
  if (isInstant(value)) return 'a time';
  if (isDuration(value)) return 'a duration';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'true/false';
  return 'an object';
}

/** Data from the scope as an expression value: Dates become instants, functions and class instances become null. */
function fromData(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? instant(value.getTime()) : null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value) || isPlainObject(value)) return value;
  return null;
}

/**
 * Converts a result to JSON-safe data: instants become ISO text, durations milliseconds.
 * @param {unknown} value
 */
export function toPlain(value) {
  if (isInstant(value)) return toIso(value.ms);
  if (isDuration(value)) return value.ms;
  if (Array.isArray(value)) return value.map(toPlain);
  return value === undefined ? null : value;
}

/** null, false, 0, '' and [] are false; everything else is true. */
export function truthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return !Number.isNaN(value);
}

function asInstantMs(value) {
  if (isInstant(value)) return value.ms;
  if (typeof value === 'string' || typeof value === 'number') return parseInstant(value);
  return null;
}

function equals(a, b) {
  if (a === null || b === null) return a === b;
  if (isInstant(a) || isInstant(b)) {
    const x = asInstantMs(a);
    const y = asInstantMs(b);
    return x !== null && y !== null && x === y;
  }
  if (isDuration(a) || isDuration(b)) return isDuration(a) && isDuration(b) && a.ms === b.ms;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equals(fromData(item), fromData(b[i])));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equals(fromData(a[k]), fromData(b[k])));
  }
  return a === b;
}

function compare(op, a, b, pos) {
  if (a === null || b === null) return false;
  let x;
  let y;
  if (isInstant(a) || isInstant(b)) {
    x = asInstantMs(a);
    y = asInstantMs(b);
    if (x === null || y === null) {
      throw new ExprError(`Cannot compare ${kindOf(isInstant(a) ? b : a)} with a time`, pos, 'EXPR_TYPE');
    }
  } else if (isDuration(a) && isDuration(b)) {
    x = a.ms;
    y = b.ms;
  } else if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
    x = a;
    y = b;
  } else {
    throw new ExprError(`Cannot compare ${kindOf(a)} with ${kindOf(b)}`, pos, 'EXPR_TYPE');
  }
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

function membership(item, collection, pos) {
  if (collection === null || (item === null && !Array.isArray(collection))) return false;
  if (Array.isArray(collection)) return collection.some((entry) => equals(fromData(entry), item));
  if (typeof collection === 'string') {
    if (typeof item !== 'string') throw new ExprError(`Cannot look for ${kindOf(item)} inside text`, pos, 'EXPR_TYPE');
    return collection.includes(item);
  }
  if (isPlainObject(collection)) return typeof item === 'string' && Object.hasOwn(collection, item);
  throw new ExprError(`Cannot look inside ${kindOf(collection)}`, pos, 'EXPR_TYPE');
}

function finite(value, pos) {
  if (!Number.isFinite(value)) throw new ExprError('The result is not a finite number', pos, 'EXPR_TYPE');
  return value;
}

/** Largest instant a Date can hold (±100 million days). */
const MAX_INSTANT_MS = 8.64e15;

function timeAt(ms, pos) {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_INSTANT_MS) throw new ExprError('The time is out of range', pos, 'EXPR_TYPE');
  return instant(ms);
}

function arithmetic(op, a, b, pos) {
  if (a === null || b === null) return null;
  const fail = () => {
    throw new ExprError(`Cannot apply "${op}" to ${kindOf(a)} and ${kindOf(b)}`, pos, 'EXPR_TYPE');
  };
  if (typeof a === 'number' && typeof b === 'number') {
    if ((op === '/' || op === '%') && b === 0) throw new ExprError('Division by zero', pos, 'EXPR_TYPE');
    if (op === '+') return finite(a + b, pos);
    if (op === '-') return finite(a - b, pos);
    if (op === '*') return finite(a * b, pos);
    if (op === '/') return finite(a / b, pos);
    return finite(a % b, pos);
  }
  if (op === '+' && typeof a === 'string' && typeof b === 'string') {
    if (a.length + b.length > 10_000) throw new ExprError('Text is too long', pos, 'EXPR_LIMIT');
    return a + b;
  }
  // Time arithmetic. ISO text next to a duration or a time is read as a time.
  const aTime = isInstant(a) ? a.ms : typeof a === 'string' ? parseInstant(a) : null;
  const bTime = isInstant(b) ? b.ms : typeof b === 'string' ? parseInstant(b) : null;
  if (isDuration(b) && aTime !== null) {
    if (op === '+') return timeAt(aTime + b.ms, pos);
    if (op === '-') return timeAt(aTime - b.ms, pos);
    return fail();
  }
  if (op === '+' && isDuration(a) && bTime !== null) return timeAt(a.ms + bTime, pos);
  if (op === '-' && aTime !== null && bTime !== null) return duration(aTime - bTime);
  if (isDuration(a) && isDuration(b)) {
    if (op === '+') return duration(a.ms + b.ms);
    if (op === '-') return duration(a.ms - b.ms);
    return fail();
  }
  if (op === '*' && isDuration(a) && typeof b === 'number') return duration(finite(a.ms * b, pos));
  if (op === '*' && typeof a === 'number' && isDuration(b)) return duration(finite(a * b.ms, pos));
  if (op === '/' && isDuration(a) && typeof b === 'number') {
    if (b === 0) throw new ExprError('Division by zero', pos, 'EXPR_TYPE');
    return duration(finite(a.ms / b, pos));
  }
  return fail();
}

// ---------------------------------------------------------------------------
// Functions (the only things an expression can call)

const text = (value, name, pos) => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ExprError(`${name}() expects text, not ${kindOf(value)}`, pos, 'EXPR_TYPE');
  return value;
};
const number = (value, name, pos) => {
  if (value === null) return null;
  if (typeof value !== 'number') throw new ExprError(`${name}() expects a number, not ${kindOf(value)}`, pos, 'EXPR_TYPE');
  return value;
};
const zoned = (args, name, pos) => {
  const ms = asInstantMs(args[0]);
  if (args[0] === null) return null;
  if (ms === null) throw new ExprError(`${name}() expects a time`, pos, 'EXPR_TYPE');
  const zone = args[1];
  if (!isValidTimeZone(zone)) throw new ExprError(`${name}() needs a time zone name such as 'Asia/Kolkata'`, pos, 'EXPR_TYPE');
  return zonedParts(ms, zone);
};

/** @type {Record<string, { min: number, max: number, fn: (args: any[], pos: number) => any, doc: string }>} */
const FUNCTIONS = Object.freeze({
  lower: { min: 1, max: 1, doc: 'lower(text)', fn: ([v], pos) => text(v, 'lower', pos)?.toLowerCase() ?? null },
  upper: { min: 1, max: 1, doc: 'upper(text)', fn: ([v], pos) => text(v, 'upper', pos)?.toUpperCase() ?? null },
  trim: { min: 1, max: 1, doc: 'trim(text)', fn: ([v], pos) => text(v, 'trim', pos)?.trim() ?? null },
  len: {
    min: 1,
    max: 1,
    doc: 'len(text or list); null is 0',
    fn: ([v], pos) => {
      if (v === null) return 0;
      if (typeof v === 'string' || Array.isArray(v)) return v.length;
      if (isPlainObject(v)) return Object.keys(v).length;
      throw new ExprError(`len() expects text or a list, not ${kindOf(v)}`, pos, 'EXPR_TYPE');
    },
  },
  starts_with: {
    min: 2,
    max: 2,
    doc: 'starts_with(text, prefix)',
    fn: ([v, p], pos) => (v === null ? false : text(v, 'starts_with', pos).startsWith(text(p, 'starts_with', pos) ?? '')),
  },
  ends_with: {
    min: 2,
    max: 2,
    doc: 'ends_with(text, suffix)',
    fn: ([v, p], pos) => (v === null ? false : text(v, 'ends_with', pos).endsWith(text(p, 'ends_with', pos) ?? '')),
  },
  coalesce: { min: 1, max: 20, doc: 'coalesce(a, b, ...) first non-null', fn: (args) => args.find((v) => v !== null) ?? null },
  abs: { min: 1, max: 1, doc: 'abs(number)', fn: ([v], pos) => (number(v, 'abs', pos) === null ? null : Math.abs(v)) },
  round: { min: 1, max: 1, doc: 'round(number)', fn: ([v], pos) => (number(v, 'round', pos) === null ? null : Math.round(v)) },
  floor: { min: 1, max: 1, doc: 'floor(number)', fn: ([v], pos) => (number(v, 'floor', pos) === null ? null : Math.floor(v)) },
  min: {
    min: 2,
    max: 20,
    doc: 'min(a, b, ...)',
    fn: (args, pos) => args.reduce((m, v) => (m === null || v === null ? null : compare('<', v, m, pos) ? v : m)),
  },
  max: {
    min: 2,
    max: 20,
    doc: 'max(a, b, ...)',
    fn: (args, pos) => args.reduce((m, v) => (m === null || v === null ? null : compare('>', v, m, pos) ? v : m)),
  },
  date: {
    min: 1,
    max: 1,
    doc: "date('2026-04-01T09:00:00+05:30') or date(epochMs)",
    fn: ([v], pos) => {
      if (v === null) return null;
      const ms = asInstantMs(v);
      if (ms === null) throw new ExprError('date() expects an ISO 8601 time with a zone, e.g. 2026-04-01T09:00:00Z', pos, 'EXPR_TYPE');
      return instant(ms);
    },
  },
  days: {
    min: 1,
    max: 1,
    doc: 'days(duration) as a number, e.g. days(now - record.createdAt) > 7',
    fn: ([v], pos) => {
      if (v === null) return null;
      if (!isDuration(v)) throw new ExprError(`days() expects a duration, not ${kindOf(v)}`, pos, 'EXPR_TYPE');
      return v.ms / 86_400_000;
    },
  },
  local_hour: { min: 2, max: 2, doc: "local_hour(time, 'Asia/Kolkata') 0-23", fn: (args, pos) => zoned(args, 'local_hour', pos)?.hour ?? null },
  local_weekday: {
    min: 2,
    max: 2,
    doc: "local_weekday(time, 'Asia/Kolkata') 1 = Monday ... 7 = Sunday",
    fn: (args, pos) => zoned(args, 'local_weekday', pos)?.weekday ?? null,
  },
  local_date: {
    min: 2,
    max: 2,
    doc: "local_date(time, 'Asia/Kolkata') as YYYY-MM-DD",
    fn: (args, pos) => {
      const p = zoned(args, 'local_date', pos);
      return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : null;
    },
  },
});

/** Function names and one-line help, for the editor. */
export const FUNCTION_DOCS = Object.freeze(Object.fromEntries(Object.entries(FUNCTIONS).map(([name, f]) => [name, f.doc])));

// ---------------------------------------------------------------------------
// Evaluation

/**
 * Evaluates an AST against a scope of plain data. Throws ExprError on type errors.
 * @param {Node} ast
 * @param {Record<string, unknown>} scope roots such as trigger, event, record, steps
 * @param {{ now: number }} options now in epoch ms (the caller's clock; never read here)
 */
export function evaluate(ast, scope, { now }) {
  if (!Number.isFinite(now)) throw new TypeError('evaluate() needs { now } in epoch milliseconds');
  const walk = (node) => {
    switch (node.type) {
      case 'literal':
        return node.value;
      case 'duration':
        return duration(node.ms);
      case 'now':
        return instant(now);
      case 'path':
        return lookup(scope, node.segments);
      case 'list':
        return node.items.map(walk);
      case 'call':
        return FUNCTIONS[node.name].fn(node.args.map(walk), node.pos);
      case 'exists':
        return walk(node.arg) !== null;
      case 'unary': {
        const value = walk(node.arg);
        if (node.op === 'not') return !truthy(value);
        if (value === null) return null;
        if (typeof value === 'number') return -value;
        if (isDuration(value)) return duration(-value.ms);
        throw new ExprError(`Cannot negate ${kindOf(value)}`, node.pos, 'EXPR_TYPE');
      }
      case 'logical': {
        const left = truthy(walk(node.left));
        if (node.op === 'and') return left ? truthy(walk(node.right)) : false;
        return left ? true : truthy(walk(node.right));
      }
      case 'binary': {
        const left = walk(node.left);
        const right = walk(node.right);
        switch (node.op) {
          case '==':
            return equals(left, right);
          case '!=':
            return !equals(left, right);
          case '<':
          case '<=':
          case '>':
          case '>=':
            return compare(node.op, left, right, node.pos);
          case 'in':
            return membership(left, right, node.pos);
          case 'contains':
            return membership(right, left, node.pos);
          default:
            return arithmetic(node.op, left, right, node.pos);
        }
      }
      default:
        throw new ExprError(`Unknown expression node "${node.type}"`, node.pos ?? 0);
    }
  };
  return walk(ast);
}

/** Own data fields only; never the prototype chain, never getters on class instances. */
function lookup(scope, segments) {
  let current = scope;
  for (const segment of segments) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current)) {
      if (typeof segment !== 'number') return null;
      current = current[segment];
    } else if (isPlainObject(current)) {
      const key = String(segment);
      if (!Object.hasOwn(current, key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) return null;
      current = descriptor.value;
    } else {
      return null;
    }
  }
  return fromData(current);
}

/**
 * Parses (memoised) and evaluates in one go.
 * @param {string} source
 * @param {Record<string, unknown>} scope
 * @param {{ now: number }} options
 */
export function run(source, scope, options) {
  return evaluate(compile(source), scope, options);
}

/**
 * Evaluates a condition to true/false.
 * @param {string} source
 * @param {Record<string, unknown>} scope
 * @param {{ now: number }} options
 */
export function test(source, scope, options) {
  return truthy(run(source, scope, options));
}

/** Text for templates: null is empty, times are ISO, durations like 3d, lists are comma-separated. */
export function toText(value) {
  if (value === null || value === undefined) return '';
  if (isInstant(value)) return toIso(value.ms);
  if (isDuration(value)) return formatDuration(value.ms);
  if (Array.isArray(value)) return value.map((item) => toText(fromData(item))).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
