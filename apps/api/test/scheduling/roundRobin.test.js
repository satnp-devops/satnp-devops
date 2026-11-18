import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseHost, recordAssignment } from '../../src/core/scheduling/roundRobin.js';
import { generateSlots } from '../../src/core/scheduling/slots.js';
import { SchedulingInputError } from '../../src/core/scheduling/errors.js';

const T0 = Date.UTC(2026, 10, 1);
const day = (n) => T0 + n * 86_400_000;

/** Book `rounds` times in a row with every host free; returns booking counts by host. */
function simulate(hosts, rounds, extra = {}) {
  let state = hosts;
  const counts = Object.fromEntries(hosts.map((h) => [h.id, 0]));
  const order = [];
  for (let i = 0; i < rounds; i += 1) {
    const choice = chooseHost({ candidateIds: state.map((h) => h.id), hosts: state, ...extra });
    counts[choice.hostId] += 1;
    order.push(choice.hostId);
    state = recordAssignment(state, choice.hostId, T0 + (i + 1) * 60_000);
  }
  return { counts, order };
}

test('picks the host with the fewest bookings for their weight', () => {
  const hosts = [
    { id: 'a', bookingCount: 3 },
    { id: 'b', bookingCount: 1 },
    { id: 'c', bookingCount: 2 },
  ];
  const choice = chooseHost({ candidateIds: ['a', 'b', 'c'], hosts });
  assert.equal(choice.hostId, 'b');
  assert.equal(choice.reason, 'round_robin');
  assert.deepEqual(choice.ranking.map((r) => r.id), ['b', 'c', 'a']);
  assert.match(choice.explanation, /chose b/);
});

test('ties go to the least recently booked (never booked first), then to the lowest id', () => {
  const hosts = [
    { id: 'c', bookingCount: 2, lastBookedAt: day(3) },
    { id: 'b', bookingCount: 2, lastBookedAt: day(1) },
    { id: 'a', bookingCount: 2, lastBookedAt: new Date(day(2)).toISOString() },
  ];
  assert.equal(chooseHost({ candidateIds: ['a', 'b', 'c'], hosts }).hostId, 'b');
  const withNew = [...hosts, { id: 'z', bookingCount: 2 }];
  assert.equal(chooseHost({ candidateIds: ['a', 'b', 'c', 'z'], hosts: withNew }).hostId, 'z', 'never booked beats any date');
  const twins = [{ id: 'm' }, { id: 'k' }];
  assert.equal(chooseHost({ candidateIds: ['m', 'k'], hosts: twins }).hostId, 'k');
});

test('equal weights rotate evenly', () => {
  const { counts, order } = simulate([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 300);
  assert.deepEqual(counts, { a: 100, b: 100, c: 100 });
  assert.deepEqual(order.slice(0, 6), ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('weights split bookings in proportion (2:1:1 and 3:1)', () => {
  const { counts } = simulate([{ id: 'senior', weight: 2 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }], 400);
  assert.deepEqual(counts, { senior: 200, b: 100, c: 100 });
  const { counts: lopsided } = simulate([{ id: 'full', weight: 3 }, { id: 'part', weight: 1 }], 100);
  assert.deepEqual(lopsided, { full: 75, part: 25 });
  // At every prefix the split stays close to the target (never more than one booking off per host).
  const { order } = simulate([{ id: 'x', weight: 2 }, { id: 'y', weight: 1 }], 90);
  for (let n = 1; n <= order.length; n += 1) {
    const xs = order.slice(0, n).filter((id) => id === 'x').length;
    assert.ok(Math.abs(xs - (2 * n) / 3) <= 1, `prefix ${n}`);
  }
});

test('a new host with calibration does not get flooded', () => {
  // Existing hosts have 40 bookings this month; the newcomer is calibrated to the average.
  const hosts = [
    { id: 'old1', bookingCount: 40 },
    { id: 'old2', bookingCount: 40 },
    { id: 'new', bookingCount: 40 },
  ];
  const { counts } = simulate(hosts, 30);
  assert.deepEqual(counts, { old1: 10, old2: 10, new: 10 });
});

test('least_recent strategy ignores counts and weights', () => {
  const hosts = [
    { id: 'busy', bookingCount: 50, weight: 1, lastBookedAt: day(1) },
    { id: 'idle', bookingCount: 0, weight: 5, lastBookedAt: day(4) },
  ];
  assert.equal(chooseHost({ candidateIds: ['busy', 'idle'], hosts, strategy: 'least_recent' }).hostId, 'busy');
  assert.equal(chooseHost({ candidateIds: ['busy', 'idle'], hosts }).hostId, 'idle');
  const { order } = simulate([{ id: 'a', weight: 9 }, { id: 'b' }, { id: 'c' }], 6, { strategy: 'least_recent' });
  assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b', 'c']);
  assert.equal(chooseHost({ candidateIds: ['busy'], hosts, strategy: 'least_recent' }).ranking[0].quotient, null);
});

test('higher priority tiers win; lower tiers take over only when the top tier is not free', () => {
  const hosts = [
    { id: 'lead', priority: 2, bookingCount: 30 },
    { id: 'team1', priority: 1, bookingCount: 0 },
    { id: 'team2', priority: 1, bookingCount: 1 },
  ];
  assert.equal(chooseHost({ candidateIds: ['lead', 'team1', 'team2'], hosts }).hostId, 'lead');
  assert.equal(chooseHost({ candidateIds: ['team1', 'team2'], hosts }).hostId, 'team1');
});

test('weight 0 hosts are a last resort within their tier', () => {
  const hosts = [{ id: 'backup', weight: 0 }, { id: 'main', weight: 1, bookingCount: 99 }];
  assert.equal(chooseHost({ candidateIds: ['backup', 'main'], hosts }).hostId, 'main');
  const only = chooseHost({ candidateIds: ['backup'], hosts });
  assert.equal(only.hostId, 'backup');
  assert.equal(only.reason, 'only_candidate');
  assert.equal(only.ranking[0].quotient, Infinity);
});

test('only candidates that are known and active are considered', () => {
  const hosts = [{ id: 'a', bookingCount: 0, active: false }, { id: 'b', bookingCount: 9 }, { id: 'c', bookingCount: 0 }];
  const choice = chooseHost({ candidateIds: ['a', 'b', 'ghost'], hosts });
  assert.equal(choice.hostId, 'b', 'c has fewer bookings but is not free for this slot');
  assert.deepEqual(choice.excluded, { a: 'inactive', ghost: 'unknown' });
  const none = chooseHost({ candidateIds: [], hosts });
  assert.deepEqual([none.hostId, none.reason], [null, 'no_candidates']);
  assert.equal(chooseHost({ candidateIds: ['a'], hosts }).reason, 'no_candidates');
});

test('sticky preferred host: the lead owner wins when free, even against fairness and priority', () => {
  const hosts = [
    { id: 'owner', bookingCount: 50, priority: 0 },
    { id: 'partnerCounsellor', bookingCount: 10 },
    { id: 'pool', bookingCount: 0, priority: 5 },
  ];
  const sticky = chooseHost({ candidateIds: ['owner', 'pool'], hosts, preferredHostIds: ['owner', 'partnerCounsellor'] });
  assert.deepEqual([sticky.hostId, sticky.reason, sticky.preferredFallback], ['owner', 'preferred_host', false]);
  assert.match(sticky.explanation, /Preferred host owner is free/);

  const second = chooseHost({ candidateIds: ['partnerCounsellor', 'pool'], hosts, preferredHostIds: ['owner', 'partnerCounsellor'] });
  assert.deepEqual([second.hostId, second.reason, second.preferredFallback], ['partnerCounsellor', 'preferred_host', true]);
  assert.match(second.explanation, /owner is not available/);

  const fallback = chooseHost({ candidateIds: ['pool'], hosts, preferredHostIds: ['owner'] });
  assert.deepEqual([fallback.hostId, fallback.reason, fallback.preferredFallback], ['pool', 'only_candidate', true]);
  assert.match(fallback.explanation, /Preferred host owner is not available; chose pool/);

  const strict = chooseHost({ candidateIds: ['pool'], hosts, preferredHostIds: ['owner'], fallback: 'none' });
  assert.deepEqual([strict.hostId, strict.reason], [null, 'preferred_unavailable']);
});

test('language filter matches primary subtags and can be relaxed', () => {
  const hosts = [
    { id: 'en', languages: ['en-IN'] },
    { id: 'hi', languages: ['hi-IN', 'en'], bookingCount: 5 },
    { id: 'ta', languages: ['ta'] },
  ];
  const all = ['en', 'hi', 'ta'];
  const hindi = chooseHost({ candidateIds: all, hosts, filters: { language: 'hi' } });
  assert.equal(hindi.hostId, 'hi');
  assert.deepEqual(hindi.excluded, { en: 'language', ta: 'language' });
  assert.equal(chooseHost({ candidateIds: all, hosts, filters: { language: 'EN-us' } }).hostId, 'en');

  const marathi = chooseHost({ candidateIds: all, hosts, filters: { language: 'mr' } });
  assert.deepEqual([marathi.hostId, marathi.reason], [null, 'no_host_matches_filters']);
  const relaxed = chooseHost({ candidateIds: all, hosts, filters: { language: 'mr' }, relaxFilters: true });
  assert.deepEqual([relaxed.hostId, relaxed.filtersRelaxed], ['en', true]);
  assert.match(relaxed.explanation, /filters relaxed/);

  const owner = chooseHost({ candidateIds: all, hosts, filters: { language: 'ta' }, preferredHostIds: ['hi'] });
  assert.equal(owner.hostId, 'ta', 'filters apply to preferred hosts too');
});

test('time-zone band keeps hosts near the attendee, using offsets at the slot instant', () => {
  const hosts = [
    { id: 'kol', timeZone: 'Asia/Kolkata' },
    { id: 'ktm', timeZone: 'Asia/Kathmandu', bookingCount: 3 },
    { id: 'dxb', timeZone: 'Asia/Dubai' },
    { id: 'lon', timeZone: 'Europe/London' },
    { id: 'nozone' },
  ];
  const all = hosts.map((h) => h.id);
  const near = chooseHost({
    candidateIds: all,
    hosts,
    slotStart: '2026-11-09T04:00:00Z',
    filters: { timeZoneBand: { aroundTimeZone: 'Asia/Kolkata', maxDifferenceMin: 60 } },
  });
  assert.deepEqual(near.ranking.map((r) => r.id), ['kol', 'ktm']);
  assert.deepEqual(near.excluded, { dxb: 'time_zone_band', lon: 'time_zone_band', nozone: 'time_zone_band' });

  const band = { minOffsetMin: 30, maxOffsetMin: 120 };
  const summer = chooseHost({ candidateIds: ['lon', 'kol'], hosts, slotStart: '2026-07-01T10:00:00Z', filters: { timeZoneBand: band } });
  const winter = chooseHost({ candidateIds: ['lon', 'kol'], hosts, slotStart: '2026-12-01T10:00:00Z', filters: { timeZoneBand: band } });
  assert.equal(summer.hostId, 'lon', 'BST is +60');
  assert.equal(winter.hostId, null, 'GMT is +0');
  const noSlot = chooseHost({ candidateIds: ['kol'], hosts, filters: { timeZoneBand: band } });
  assert.equal(noSlot.hostId, null, 'a band needs slotStart');
});

test('the result does not depend on input order', () => {
  const hosts = [
    { id: 'a', bookingCount: 2, lastBookedAt: day(2) },
    { id: 'b', bookingCount: 2, lastBookedAt: day(1) },
    { id: 'c', bookingCount: 4 },
  ];
  const first = chooseHost({ candidateIds: ['a', 'b', 'c'], hosts });
  const second = chooseHost({ candidateIds: ['c', 'b', 'a', 'b'], hosts: [...hosts].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.hostId, 'b');
});

test('bad input is refused', () => {
  assert.throws(() => chooseHost({ candidateIds: ['a'], hosts: [{ id: 'a', weight: -1 }] }), SchedulingInputError);
  assert.throws(() => chooseHost({ candidateIds: ['a'], hosts: [{ id: 'a', timeZone: 'IST' }] }), SchedulingInputError);
  assert.throws(
    () => chooseHost({ candidateIds: ['a'], hosts: [{ id: 'a' }], filters: { timeZoneBand: { aroundTimeZone: 'Asia/Kolkata' } } }),
    SchedulingInputError,
  );
  assert.throws(() => chooseHost({ candidateIds: ['a'], hosts: [{ id: 'a', lastBookedAt: 'yesterday' }] }), SchedulingInputError);
  assert.throws(() => recordAssignment([{ id: 'a' }], 'a', 'later'), RangeError);
});

test('end to end: a week of slots across three counsellors in two zones is shared fairly', () => {
  const weekly = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, ['10:00-13:00']]));
  const slotHosts = [
    { id: 'priya', timeZone: 'Asia/Kolkata', weekly },
    { id: 'rahul', timeZone: 'Asia/Kolkata', weekly },
    { id: 'sita', timeZone: 'Asia/Kathmandu', weekly },
  ];
  const book = (eventType) => {
    const slots = generateSlots({
      eventType,
      hosts: slotHosts,
      range: { from: '2026-11-09T00:00:00Z', to: '2026-11-14T00:00:00Z' },
      now: '2026-11-01T00:00:00Z',
    });
    let rr = [{ id: 'priya' }, { id: 'rahul' }, { id: 'sita' }];
    const counts = { priya: 0, rahul: 0, sita: 0 };
    for (const slot of slots) {
      const choice = chooseHost({ candidateIds: slot.hostIds, hosts: rr, slotStart: slot.start });
      assert.ok(slot.hostIds.includes(choice.hostId));
      counts[choice.hostId] += 1;
      rr = recordAssignment(rr, choice.hostId, slot.start);
    }
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), slots.length);
    return { slots, counts };
  };

  // Without a shared grid, Kathmandu's +05:45 puts Sita's slots 15 minutes off everyone else's,
  // so she never competes with the Kolkata counsellors.
  const separate = book({ durationMin: 30 });
  assert.equal(separate.slots.length, 60);
  assert.deepEqual(separate.counts, { priya: 15, rahul: 15, sita: 30 });

  // alignTimeZone puts every host on the IST half-hour grid; the team then shares slots fairly.
  const shared = book({ durationMin: 30, alignTimeZone: 'Asia/Kolkata' });
  assert.equal(shared.slots.length, 30, '10:00–12:30 IST, six a day');
  assert.ok(shared.slots.every((s) => ['00', '30'].includes(s.start.slice(14, 16))), 'all on :00/:30 IST (= :30/:00 UTC)');
  // Sita is not free for the 12:30 IST slot (her day ends 12:45 IST), and assignment is online
  // (slot by slot, no look-ahead), so the split can be one off in each direction.
  const values = Object.values(shared.counts);
  assert.ok(Math.max(...values) - Math.min(...values) <= 2, JSON.stringify(shared.counts));
  assert.ok(shared.counts.sita >= 9, JSON.stringify(shared.counts));
});
