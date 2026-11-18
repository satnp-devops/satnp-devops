import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  isValidTimeZone,
  nextTimeOfDay,
  parseDuration,
  parseInstant,
  zonedParts,
  zonedTimeToUtc,
} from '../../src/core/automation/time.js';
import { collectDynamic, parseTemplate, renderTemplate, resolveParams } from '../../src/core/automation/template.js';
import { ExprError } from '../../src/core/automation/expr.js';

const NOW = Date.parse('2026-11-05T04:30:00Z');

test('durations parse, compound and bounded', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2w1d'), 15 * 86_400_000);
  assert.equal(parseDuration('0s'), 0);
  for (const bad of ['', '3', 'd', '3 d', '3days', '1mo', '1y', '-1d', '1.5h', 3]) assert.equal(parseDuration(bad), null, String(bad));
  assert.equal(parseDuration('3651d'), null, 'over ten years');
  assert.equal(formatDuration(5_400_000), '1h30m');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(-86_400_000), '-1d');
  assert.equal(formatDuration(1500), '1s500ms');
});

test('instants: ISO with offset, bare dates, epoch ms and Dates; ambiguous text is refused', () => {
  assert.equal(parseInstant('2026-11-05T10:00:00+05:30'), NOW);
  assert.equal(parseInstant('2026-11-05T04:30:00Z'), NOW);
  assert.equal(parseInstant('2026-11-05T04:30:00.000Z'), NOW);
  assert.equal(parseInstant('2026-11-05T04:30Z'), NOW);
  assert.equal(parseInstant('2026-11-05T05:30:00+0100'), NOW);
  assert.equal(parseInstant('2026-11-05'), Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(parseInstant(NOW), NOW);
  assert.equal(parseInstant(new Date(NOW)), NOW);
  for (const bad of ['2026-11-05T10:00:00', '2026-02-30', '2026-13-01', '2026-11-05T24:00:00Z', 'Nov 5 2026', '', NaN, Infinity, new Date('x'), null, {}]) {
    assert.equal(parseInstant(bad), null, String(bad));
  }
});

test('time zones: validity, wall-clock parts, wall-clock to UTC', () => {
  assert.ok(isValidTimeZone('Asia/Kolkata'));
  assert.ok(isValidTimeZone('UTC'));
  assert.ok(!isValidTimeZone('Asia/Nowhere'));
  assert.ok(!isValidTimeZone(''));
  assert.ok(!isValidTimeZone(42));
  assert.deepEqual(zonedParts(NOW, 'Asia/Kolkata'), { year: 2026, month: 11, day: 5, hour: 10, minute: 0, second: 0, weekday: 4 });
  assert.equal(zonedTimeToUtc({ year: 2026, month: 11, day: 5, hour: 10, minute: 0 }, 'Asia/Kolkata'), NOW);
  assert.equal(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, 'America/New_York'), Date.parse('2026-07-01T13:00:00Z'));
  assert.equal(zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 9 }, 'America/New_York'), Date.parse('2026-12-01T14:00:00Z'));
  // 02:30 on 8 March 2026 doesn't exist in New York: it moves forward to 03:30 EDT.
  assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'), Date.parse('2026-03-08T07:30:00Z'));
});

test('nextTimeOfDay: later today, tomorrow, on allowed weekdays, across DST', () => {
  const kolkata = 'Asia/Kolkata';
  assert.equal(nextTimeOfDay(NOW, '11:00', kolkata), Date.parse('2026-11-05T05:30:00Z'), 'later today');
  assert.equal(nextTimeOfDay(NOW, '10:00', kolkata), Date.parse('2026-11-06T04:30:00Z'), 'strictly after now');
  assert.equal(nextTimeOfDay(NOW, '09:00', kolkata), Date.parse('2026-11-06T03:30:00Z'), 'tomorrow');
  assert.equal(nextTimeOfDay(NOW, '09:00', kolkata, [1, 2, 3, 4, 5]), Date.parse('2026-11-06T03:30:00Z'), 'Friday is allowed');
  assert.equal(nextTimeOfDay(Date.parse('2026-11-06T05:00:00Z'), '09:00', kolkata, [1, 2, 3, 4, 5]), Date.parse('2026-11-09T03:30:00Z'), 'skips the weekend');
  assert.equal(nextTimeOfDay(NOW, '09:00', kolkata, [7]), Date.parse('2026-11-08T03:30:00Z'), 'Sundays only');
  // Clocks in New York fall back on 1 November 2026; 09:00 the next day is 14:00 UTC.
  assert.equal(nextTimeOfDay(Date.parse('2026-10-31T14:00:00Z'), '09:00', 'America/New_York'), Date.parse('2026-11-01T14:00:00Z'));
  assert.throws(() => nextTimeOfDay(NOW, '9am', kolkata), /not a time of day/);
  assert.throws(() => nextTimeOfDay(NOW, '24:00', kolkata), /not a time of day/);
});

const scope = { record: { name: 'Aarav', score: 70, tags: ['vip', 'jee'], ownerId: 'u-1', when: '2026-11-05T04:30:00Z' }, steps: { a: { output: { draft: 'Hi' } } } };

test('templates interpolate {{ }} as text', () => {
  assert.equal(renderTemplate('Hello {{ record.name }}!', scope, { now: NOW }), 'Hello Aarav!');
  assert.equal(renderTemplate('{{record.score}} points', scope, { now: NOW }), '70 points');
  assert.equal(renderTemplate('Tags: {{ record.tags }}', scope, { now: NOW }), 'Tags: vip, jee');
  assert.equal(renderTemplate('Missing: [{{ record.missing }}]', scope, { now: NOW }), 'Missing: []');
  assert.equal(renderTemplate('Due {{ now + 1d }}', scope, { now: NOW }), 'Due 2026-11-06T04:30:00.000Z');
  assert.equal(renderTemplate('Wait {{ 90m }}', scope, { now: NOW }), 'Wait 1h30m');
  assert.equal(renderTemplate('{{ record.score >= 60 }}', scope, { now: NOW }), 'true');
  assert.equal(renderTemplate('no braces', scope, { now: NOW }), 'no braces');
  assert.deepEqual(parseTemplate('a {{ b }} c'), [{ text: 'a ' }, { source: ' b ', offset: 4 }, { text: ' c' }]);
});

test('template errors are positioned inside the whole text', () => {
  assert.throws(() => parseTemplate('Hi {{ record.name'), (e) => e instanceof ExprError && e.column === 4 && /closing "}}"/.test(e.message));
  assert.throws(() => parseTemplate('Hi {{ }}'), /Empty/);
  assert.throws(() => parseTemplate('Hi {{ record.name = 1 }}'), (e) => e.column === 19 && /Use ==/.test(e.message));
  assert.throws(() => renderTemplate('Hi {{ record.name + 1 }}', scope, { now: NOW }), (e) => e.column === 19 && e.code === 'EXPR_TYPE');
  assert.throws(() => parseTemplate('{{ constructor }}'), /not allowed/);
});

test('resolveParams: literals, templates, $expr values, deep structures, no __proto__ keys', () => {
  const params = {
    title: 'Call {{ record.name }}',
    assignee: { $expr: 'record.ownerId' },
    score: { $expr: 'record.score + 5' },
    due: { $expr: 'now + 2h' },
    nested: { list: ['{{ record.tags.0 }}', 3, { $expr: 'len(record.tags)' }], flag: true, none: null },
    notExpr: { $expr: 'x', other: 1 },
  };
  assert.deepEqual(resolveParams(params, scope, { now: NOW }), {
    title: 'Call Aarav',
    assignee: 'u-1',
    score: 75,
    due: '2026-11-05T06:30:00.000Z',
    nested: { list: ['vip', 3, 2], flag: true, none: null },
    notExpr: { $expr: 'x', other: 1 },
  });
  const polluted = resolveParams(JSON.parse('{"__proto__": {"admin": true}, "ok": 1}'), scope, { now: NOW });
  assert.deepEqual(Object.keys(polluted), ['ok']);
  assert.equal(polluted.admin, undefined);
  assert.throws(
    () => resolveParams({ a: { b: { $expr: "record.name > 1" } } }, scope, { now: NOW }),
    (e) => e instanceof ExprError && e.path.join('.') === 'a.b',
  );
});

test('collectDynamic finds every dynamic value with its path', () => {
  const found = collectDynamic({ a: 'x {{ y }}', b: { $expr: 'z' }, c: [1, '{{ w }}'], d: 'plain', e: { f: { $expr: 'v' } } });
  assert.deepEqual(found, [
    { path: ['a'], kind: 'template', source: 'x {{ y }}' },
    { path: ['b'], kind: 'expr', source: 'z' },
    { path: ['c', 1], kind: 'template', source: '{{ w }}' },
    { path: ['e', 'f'], kind: 'expr', source: 'v' },
  ]);
});
