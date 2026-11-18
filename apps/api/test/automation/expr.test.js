import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ExprError,
  LIMITS,
  collectPaths,
  explainError,
  parse,
  run,
  test as check,
  toPlain,
  tokenize,
  truthy,
} from '../../src/core/automation/expr.js';

const NOW = Date.parse('2026-11-05T04:30:00Z'); // Thursday 10:00 in Asia/Kolkata
const scope = {
  record: {
    stage: 'new',
    score: 70,
    city: 'Pune',
    tags: ['vip', 'jee'],
    createdAt: '2026-11-01T04:30:00Z',
    lastActivityAt: '2026-11-03T04:30:00Z',
    amount: { minor: 2500000, currency: 'INR' },
    custom: { grade: '11' },
    empty: '',
    zero: 0,
    nothing: null,
    items: [{ name: 'JEE' }, { name: 'NEET' }],
  },
  trigger: { type: 'deal.created', payload: { channel: 'whatsapp' } },
};
const ev = (source, data = scope) => toPlain(run(source, data, { now: NOW }));
const fails = (source, pattern, data = scope) => assert.throws(() => run(source, data, { now: NOW }), pattern);

/** Throws ExprError at the given column (1-based). */
function parseError(source, column, pattern) {
  try {
    parse(source);
  } catch (error) {
    assert.ok(error instanceof ExprError, `expected ExprError for ${source}, got ${error}`);
    assert.equal(error.column, column, `column for ${source}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected "${source}" not to parse`);
}

test('literals: numbers, text with escapes, booleans, null, lists, durations', () => {
  assert.equal(ev('42'), 42);
  assert.equal(ev('3.25'), 3.25);
  assert.equal(ev("'it\\'s'"), "it's");
  assert.equal(ev('"line\\nnext \\u20b9"'), 'line\nnext ₹');
  assert.equal(ev('true'), true);
  assert.equal(ev('null'), null);
  assert.deepEqual(ev("[1, 'a', [true]]"), [1, 'a', [true]]);
  assert.deepEqual(ev('[]'), []);
  assert.equal(ev('3d'), 3 * 86_400_000);
  assert.equal(ev('1h30m'), 90 * 60_000);
  assert.equal(ev('250ms'), 250);
  assert.equal(ev('1w'), 7 * 86_400_000);
});

test('field paths read nested data and list positions; missing fields are null', () => {
  assert.equal(ev('record.stage'), 'new');
  assert.equal(ev('record.amount.minor'), 2500000);
  assert.equal(ev('record.items.1.name'), 'NEET');
  assert.equal(ev('record.items.9.name'), null);
  assert.equal(ev('record.nope.deeper'), null);
  assert.equal(ev('unknownRoot.x'), null);
  assert.equal(ev('record.city.length'), null, 'no properties of text');
  assert.equal(ev('record.tags.length'), null, 'no properties of lists');
  // keywords are fine as field names after a dot
  assert.equal(ev('record.in', { record: { in: 5 } }), 5);
});

test('operator precedence: or < and < not < comparison < + - < * / % < unary minus', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('10 - 4 - 3'), 3, 'left associative');
  assert.equal(ev('2 * 3 % 4'), 2);
  assert.equal(ev('-2 * 3'), -6);
  assert.equal(ev('- -2'), 2);
  assert.equal(ev('true or false and false'), true, 'and binds tighter than or');
  assert.equal(ev('(true or false) and false'), false);
  assert.equal(ev('not 1 == 2'), true, 'not applies to the whole comparison');
  assert.equal(ev('not true and false'), false, 'not binds tighter than and');
  assert.equal(ev('not (true and false)'), true);
  assert.equal(ev('!false && true || false'), true, 'symbol forms');
  assert.equal(ev('1 + 1 == 2 and 2 * 2 == 4'), true);
  assert.equal(ev("record.score >= 60 and record.stage == 'new' or record.city == 'Delhi'"), true);
  const ast = parse('a or b and c');
  assert.equal(ast.type, 'logical');
  assert.equal(ast.op, 'or');
  assert.equal(ast.right.op, 'and');
});

test('comparisons: numbers, text, equality of lists and objects, null rules', () => {
  assert.equal(ev('record.score > 60'), true);
  assert.equal(ev('record.score <= 70'), true);
  assert.equal(ev("record.city < 'Zzz'"), true);
  assert.equal(ev("record.stage != 'won'"), true);
  assert.equal(ev("record.tags == ['vip', 'jee']"), true);
  assert.equal(ev("record.amount == record.amount"), true);
  assert.equal(ev('record.nothing == null'), true);
  assert.equal(ev('record.missing == null'), true);
  assert.equal(ev('record.missing < 5'), false, 'null is never ordered');
  assert.equal(ev('record.missing >= 5'), false);
  assert.equal(ev('null == 0'), false);
  assert.equal(ev("'5' == 5"), false, 'no coercion between text and numbers');
});

test('in, not in, contains, not contains and exists', () => {
  assert.equal(ev("'vip' in record.tags"), true);
  assert.equal(ev("'neet' not in record.tags"), true);
  assert.equal(ev("record.tags contains 'jee'"), true);
  assert.equal(ev("record.tags not contains 'x'"), true);
  assert.equal(ev("'un' in 'Pune'"), true, 'substring');
  assert.equal(ev("record.city contains 'Pu'"), true);
  assert.equal(ev("'grade' in record.custom"), true, 'object keys');
  assert.equal(ev("'x' in record.missing"), false);
  assert.equal(ev("lower(record.city) in ['pune', 'mumbai']"), true);
  assert.equal(ev('record.city exists'), true);
  assert.equal(ev('record.nothing exists'), false);
  assert.equal(ev('not record.phone exists'), true);
  assert.equal(ev('record.empty exists'), true, 'empty text is a value');
});

test('truthiness in and/or/not and conditions', () => {
  for (const falsy of [null, false, 0, '', []]) assert.equal(truthy(falsy), false);
  for (const value of [1, 'a', [0], {}, true]) assert.equal(truthy(value), true);
  assert.equal(check('record.empty', scope, { now: NOW }), false);
  assert.equal(check('record.zero or record.city', scope, { now: NOW }), true);
  assert.equal(ev('record.tags and record.city'), true, 'and/or give true/false');
});

test('and/or short-circuit, so the right side is not evaluated', () => {
  assert.equal(ev("false and record.city < 5"), false);
  assert.equal(ev("true or record.city < 5"), true);
  fails("true and record.city < 5", /Cannot compare text with a number/);
});

test('date arithmetic: now, durations, ISO text, differences', () => {
  assert.equal(ev('now'), '2026-11-05T04:30:00.000Z');
  assert.equal(ev('now - 3d'), '2026-11-02T04:30:00.000Z');
  assert.equal(ev('now + 1h30m'), '2026-11-05T06:00:00.000Z');
  assert.equal(ev('2h + now'), '2026-11-05T06:30:00.000Z');
  assert.equal(ev('record.createdAt + 1d'), '2026-11-02T04:30:00.000Z', 'ISO text plus a duration');
  assert.equal(ev('record.lastActivityAt < now - 1d'), true);
  assert.equal(ev('record.lastActivityAt < now - 3d'), false);
  assert.equal(ev('now - record.createdAt'), 4 * 86_400_000, 'a difference is a duration');
  assert.equal(ev('now - record.createdAt > 3d'), true);
  assert.equal(ev('record.lastActivityAt - record.createdAt == 2d'), true);
  assert.equal(ev('days(now - record.createdAt)'), 4);
  assert.equal(ev('2 * 1d == 2d'), true);
  assert.equal(ev('1d / 2 == 12h'), true);
  assert.equal(ev('-1d + 2d == 1d'), true);
  assert.equal(ev("date('2026-11-05T10:00:00+05:30') == now"), true, 'offsets are honoured');
  assert.equal(ev("now == '2026-11-05T04:30:00Z'"), true, 'ISO text compared with a time');
  assert.equal(ev("now > '2026-11-05'"), true, 'bare dates are UTC midnight');
  assert.equal(ev("now == 'not a date'"), false);
  fails("now > 'soon'", /Cannot compare text with a time/);
  fails('now + 5', /Cannot apply "\+" to a time and a number/);
  fails('now * 2', /Cannot apply/);
  fails("date('2026-11-05 10:00')", /date\(\) expects an ISO 8601 time/, 'no zone means no guess');
});

test('functions: text, numbers, coalesce, min/max, local time in a zone', () => {
  assert.equal(ev("upper('abc') + lower('DEF')"), 'ABCdef');
  assert.equal(ev("trim('  x ')"), 'x');
  assert.equal(ev('len(record.tags)'), 2);
  assert.equal(ev('len(record.missing)'), 0);
  assert.equal(ev("len('hello')"), 5);
  assert.equal(ev("starts_with(record.city, 'Pu') and ends_with(record.city, 'ne')"), true);
  assert.equal(ev("starts_with(record.missing, 'x')"), false);
  assert.equal(ev("coalesce(record.missing, record.nothing, 'fallback')"), 'fallback');
  assert.equal(ev('abs(-3) + round(2.5) + floor(2.9)'), 8);
  assert.equal(ev('min(3, 1, 2)'), 1);
  assert.equal(ev('max(now, record.createdAt)'), '2026-11-05T04:30:00.000Z');
  assert.equal(ev('lower(record.missing)'), null);
  assert.equal(ev("local_hour(now, 'Asia/Kolkata')"), 10);
  assert.equal(ev("local_weekday(now, 'Asia/Kolkata')"), 4);
  assert.equal(ev("local_date(now - 5h, 'Asia/Kolkata')"), '2026-11-05');
  assert.equal(ev("local_date(now - 11h, 'Asia/Kolkata')"), '2026-11-04');
  assert.equal(ev("local_hour(now, 'America/New_York')"), 23);
  fails("local_hour(now, 'Mars/Olympus')", /time zone name/);
  fails('lower(5)', /lower\(\) expects text, not a number/);
  fails('len(5)', /len\(\) expects text or a list/);
});

test('arithmetic errors: type mismatches, division by zero, null propagation', () => {
  assert.equal(ev('record.missing + 1'), null);
  assert.equal(ev('-record.missing'), null);
  assert.equal(ev("'a' + 'b'"), 'ab');
  fails("'a' + 1", /Cannot apply "\+" to text and a number/);
  fails('1 / 0', /Division by zero/);
  fails('5 % 0', /Division by zero/);
  fails("-'x'", /Cannot negate text/);
  fails('1d / 0', /Division by zero/);
  fails('[1] - [1]', /Cannot apply/);
});

test('runtime errors carry the column of the operator', () => {
  try {
    run("record.score > 'high'", scope, { now: NOW });
    assert.fail('should throw');
  } catch (error) {
    assert.ok(error instanceof ExprError);
    assert.equal(error.code, 'EXPR_TYPE');
    assert.equal(error.column, 14);
  }
});

test('syntax errors name the problem and its column', () => {
  parseError('record.stage = 1', 14, /Use == to compare/);
  parseError('a & b', 3, /Use && or and/);
  parseError('1 < x < 5', 7, /can't be chained/);
  parseError('(1 + 2', 7, /closing "\)"/);
  parseError('1 +', 4, /ended too early/);
  parseError('1 2', 3, /Unexpected "2"/);
  parseError("'open", 1, /closing quote/);
  parseError("'bad \\q'", 6, /Unknown escape/);
  parseError('3days', 1, /not a duration/);
  parseError('a.', 3, /field name after "."/);
  parseError('a.1.5', 3, /field name after "."/);
  parseError('[1, 2', 6, /"," or "]"/);
  parseError('foo(1)', 1, /Unknown function "foo"/);
  parseError('len(1, 2)', 1, /takes 1 argument/);
  parseError('coalesce()', 1, /at least 1|1 to 20/);
  parseError('a and or b', 7, /Unexpected "or"/);
  parseError('x # y', 3, /Unexpected character "#"/);
  parseError('exists', 1, /Unexpected "exists"/);
  const error = parseError('score >> 2', 8);
  assert.equal(explainError('score >> 2', error), 'score >> 2\n       ^ Unexpected ">"');
});

test('injection attempts are rejected at parse time', () => {
  parseError('constructor', 1, /not allowed/);
  parseError('record.constructor.constructor', 8, /not allowed/);
  parseError("trigger.constructor('return process')()", 9, /not allowed/);
  parseError('__proto__.polluted', 1, /not allowed/);
  parseError('record.__proto__', 8, /not allowed/);
  parseError('record.prototype', 8, /not allowed/);
  parseError("record['stage']", 7, /Use a dot/);
  parseError('record.stage()', 13, /Only built-in functions/);
  parseError('eval(1)', 1, /Unknown function "eval"/);
  parseError("Function('x')", 1, /Unknown function "Function"/);
  parseError('process.exit(1)', 13, /Only built-in functions/);
  parseError('`${1}`', 1, /Unexpected character "`"/);
  parseError("1; process.exit()", 2, /Unexpected character ";"/);
  parseError("'a' + require('fs')", 7, /Unknown function "require"/);
  parseError('x => x', 3, /Use == to compare/);
  parseError('{ a: 1 }', 1, /Unexpected character "\{"/);
  parseError('a = 1', 3, /Use ==/);
});

test('scope data cannot reach prototypes, getters, functions or class instances', () => {
  const sneaky = {
    record: Object.create({ inherited: 'from proto' }),
    fn: () => 'called',
    klass: new (class Secret {
      constructor() {
        this.value = 'hidden';
      }
    })(),
    viaGetter: Object.defineProperty({}, 'secret', { get: () => 'getter ran', enumerable: true }),
    parsed: JSON.parse('{"__proto__": {"admin": true}}'),
  };
  assert.equal(ev('record.inherited', sneaky), null, 'own fields only');
  assert.equal(ev('fn', sneaky), null);
  assert.equal(ev('klass.value', sneaky), null);
  assert.equal(ev('viaGetter.secret', sneaky), null, 'getters are never invoked');
  assert.equal(ev('parsed.admin', sneaky), null);
  assert.equal(ev('record.toString', sneaky), null);
  assert.equal(ev('record.hasOwnProperty', { record: {} }), null);
  assert.equal(({}).admin, undefined, 'no prototype pollution');
  // Dates in data are read as instants.
  assert.equal(ev('when > now', { when: new Date(NOW + 1000) }), true);
});

test('injected text in data stays data', () => {
  const data = { record: { name: "'; process.exit(); '", code: 'constructor' } };
  assert.equal(ev("record.name == \"'; process.exit(); '\"", data), true);
  assert.equal(ev("record.code == 'constructor'", data), true, 'forbidden names are fine as values');
});

test('the evaluator never uses eval or the Function constructor', () => {
  const source = readFileSync(new URL('../../src/core/automation/expr.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\beval\s*\(/);
  assert.doesNotMatch(code, /new\s+Function\b/);
  assert.doesNotMatch(code, /\bFunction\s*\(/);
});

test('limits: length, nesting depth and list size', () => {
  assert.throws(() => parse('1+'.repeat(LIMITS.maxLength)), (e) => e.code === 'EXPR_LIMIT' && /longer than/.test(e.message));
  assert.throws(() => parse('('.repeat(60) + '1' + ')'.repeat(60)), (e) => e.code === 'EXPR_LIMIT' && /nested too deeply/.test(e.message));
  assert.throws(() => parse('not '.repeat(60) + 'true'), /nested too deeply/);
  assert.throws(() => parse('-'.repeat(60) + '1'), /nested too deeply/);
  assert.throws(() => parse(`[${Array(LIMITS.maxListItems + 1).fill('1').join(',')}]`), /at most/);
  assert.doesNotThrow(() => parse('('.repeat(20) + '1' + ')'.repeat(20)));
  assert.throws(() => parse('99999999999999999999'), /too large/);
});

test('tokenize reports kinds and positions', () => {
  const tokens = tokenize("a.b >= 3d and 'x'");
  assert.deepEqual(
    tokens.map((t) => [t.kind, t.pos]),
    [['ident', 0], ['op', 1], ['ident', 2], ['op', 4], ['dur', 7], ['ident', 10], ['str', 14], ['eof', 17]],
  );
});

test('collectPaths lists every field an expression reads', () => {
  const paths = collectPaths(parse("steps.classify.output.label == 'hot' and lower(record.city) in [trigger.payload.city] and not x exists"));
  assert.deepEqual(paths, [['steps', 'classify', 'output', 'label'], ['record', 'city'], ['trigger', 'payload', 'city'], ['x']]);
  assert.deepEqual(collectPaths(parse('record.items.0.name')), [['record', 'items', 0, 'name']]);
});

test('evaluation needs the caller to pass the time', () => {
  assert.throws(() => run('now', {}, {}), /needs \{ now \}/);
});
