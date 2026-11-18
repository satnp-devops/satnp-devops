import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignBatch, assignOwner, initialState, isWorkingTime, localTime, zoneOffsetMinutes } from '../../src/core/intake/assign.js';
import { zonedTimeToUtc } from '../../src/core/intake/time.js';

// Thursday 5 November 2026, 11:30 in India (06:00 UTC).
const NOW = Date.UTC(2026, 10, 5, 6, 0);
const IST_EVENING = Date.UTC(2026, 10, 5, 15, 30); // 21:00 IST
const SUNDAY = Date.UTC(2026, 10, 8, 6, 0);

const counsellor = (id, extra = {}) => ({ id, languages: ['en', 'hi'], timeZone: 'Asia/Kolkata', openLeads: 0, capacity: 50, ...extra });
const pick = (lead, owners, state, now = NOW, options) => assignOwner({ lead, owners, state, now, options });

// --- time helpers --------------------------------------------------------------------------------

test('time helpers read local time and offsets with Intl', () => {
  assert.deepEqual(localTime('Asia/Kolkata', NOW), { isoDay: 4, minutes: 11 * 60 + 30 });
  assert.equal(zoneOffsetMinutes('Asia/Kolkata', NOW), 330);
  assert.equal(zoneOffsetMinutes('Asia/Dubai', NOW), 240);
  assert.equal(zoneOffsetMinutes('America/New_York', NOW), -300);
  assert.equal(zoneOffsetMinutes('America/New_York', Date.UTC(2026, 6, 1)), -240, 'daylight saving');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 11, day: 5, hour: 11, minute: 30 }, 'Asia/Kolkata'), NOW);
  assert.equal(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, 'America/New_York'), Date.UTC(2026, 6, 1, 13));
});

test('working hours: days, start inclusive, end exclusive, shifts past midnight', () => {
  const day = { days: [1, 2, 3, 4, 5], start: '09:30', end: '18:30' };
  const at = (h, m, d = 5) => zonedTimeToUtc({ year: 2026, month: 11, day: d, hour: h, minute: m }, 'Asia/Kolkata');
  assert.ok(isWorkingTime(day, 'Asia/Kolkata', at(9, 30)));
  assert.ok(!isWorkingTime(day, 'Asia/Kolkata', at(9, 29)));
  assert.ok(!isWorkingTime(day, 'Asia/Kolkata', at(18, 30)));
  assert.ok(!isWorkingTime(day, 'Asia/Kolkata', at(11, 0, 7)), 'Saturday is not a working day here');
  const night = { days: [4], start: '22:00', end: '06:00' };
  assert.ok(isWorkingTime(night, 'Asia/Kolkata', at(23, 0)));
  assert.ok(isWorkingTime(night, 'Asia/Kolkata', at(5, 59, 6)), 'Friday early morning belongs to Thursday’s shift');
  assert.ok(!isWorkingTime(night, 'Asia/Kolkata', at(5, 59, 5)), 'Thursday early morning belongs to Wednesday');
  assert.ok(isWorkingTime({ days: [4], start: '00:00', end: '00:00' }, 'Asia/Kolkata', at(3, 0)), 'equal start and end is all day');
  assert.ok(isWorkingTime({}, 'Asia/Kolkata', at(3, 0)), 'defaults to Monday to Saturday, all day');
});

// --- round-robin fairness ------------------------------------------------------------------------

test('round-robin rotates evenly and the state carries the rotation', () => {
  const owners = [counsellor('asha'), counsellor('bilal'), counsellor('chitra')];
  let state;
  const picks = [];
  for (let i = 0; i < 9; i += 1) {
    const result = pick({ companyId: 'pi-vector' }, owners, state);
    assert.equal(result.method, 'round_robin');
    picks.push(result.ownerId);
    state = result.state;
  }
  assert.deepEqual(picks, ['asha', 'bilal', 'chitra', 'asha', 'bilal', 'chitra', 'asha', 'bilal', 'chitra']);
  assert.equal(state.seq, 9);
  assert.deepEqual(state.owners.asha, { lastSeq: 7, assigned: 3 });
});

test('the state is pure: inputs are not mutated and the same input gives the same output', () => {
  const owners = [counsellor('asha'), counsellor('bilal')];
  const state = { version: 1, seq: 4, owners: { asha: { lastSeq: 4, assigned: 2 }, bilal: { lastSeq: 3, assigned: 2 } } };
  const frozen = structuredClone(state);
  const a = pick({}, owners, state);
  const b = pick({}, owners, state);
  assert.deepEqual(a, b);
  assert.deepEqual(state, frozen);
  assert.equal(a.ownerId, 'bilal');
});

test('a missing or broken state starts fresh', () => {
  assert.deepEqual(initialState(), { version: 1, seq: 0, owners: {} });
  for (const state of [undefined, null, 'x', { seq: 'nope' }]) {
    assert.equal(pick({}, [counsellor('b'), counsellor('a')], state).ownerId, 'a', 'ties break on id');
  }
});

test('a new owner joins the rotation next, and someone back from leave waits their turn fairly', () => {
  const state = { version: 1, seq: 10, owners: { asha: { lastSeq: 9, assigned: 5 }, bilal: { lastSeq: 10, assigned: 5 } } };
  const result = pick({}, [counsellor('asha'), counsellor('bilal'), counsellor('dev')], state);
  assert.equal(result.ownerId, 'dev', 'never assigned goes first');
  const back = pick({}, [counsellor('asha'), counsellor('bilal')], { ...state, owners: { ...state.owners, chitra: { lastSeq: 2, assigned: 1 } } });
  assert.equal(back.ownerId, 'asha', 'owners not in the pool are ignored');
});

test('ties in the rotation go to the lighter load', () => {
  const result = pick({}, [counsellor('asha', { openLeads: 40 }), counsellor('bilal', { openLeads: 10 })]);
  assert.equal(result.ownerId, 'bilal');
  const ratio = pick({}, [counsellor('asha', { openLeads: 20, capacity: 100 }), counsellor('bilal', { openLeads: 10, capacity: 20 })]);
  assert.equal(ratio.ownerId, 'asha', 'load is relative to the cap');
});

// --- hard constraints ----------------------------------------------------------------------------

test('capacity: owners at their cap are skipped; no cap means unlimited', () => {
  const owners = [counsellor('asha', { openLeads: 50, capacity: 50 }), counsellor('bilal', { openLeads: 999, capacity: null }), counsellor('chitra', { openLeads: 5, capacity: 5 })];
  const result = pick({}, owners);
  assert.equal(result.ownerId, 'bilal');
  assert.deepEqual(result.excluded, [{ ownerId: 'asha', code: 'at_capacity' }, { ownerId: 'chitra', code: 'at_capacity' }]);
});

test('inactive, unavailable and on-leave owners are skipped', () => {
  const owners = [
    counsellor('asha', { active: false }),
    counsellor('bilal', { status: 'disabled' }),
    counsellor('chitra', { available: false }),
    counsellor('dev', { away: [{ from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' }] }),
    counsellor('esha', { away: [{ from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' }] }),
  ];
  const result = pick({}, owners);
  assert.equal(result.ownerId, 'esha');
  assert.deepEqual(result.excluded.map((e) => e.code), ['inactive', 'inactive', 'unavailable', 'away']);
});

test('scope: company, product line and org unit', () => {
  const owners = [
    counsellor('asha', { companyIds: ['satnpaper'] }),
    counsellor('bilal', { companyIds: ['pi-vector'], productLineIds: ['neet'] }),
    counsellor('chitra', { unitPaths: ['/g/pi/delhi/'] }),
    counsellor('dev', { unitPaths: ['/g/pi/mumbai/'] }),
  ];
  const result = pick({ companyId: 'pi-vector', productLineId: 'jee', unitPath: '/g/pi/delhi/team-a/' }, owners);
  assert.equal(result.ownerId, 'chitra');
  assert.deepEqual(result.excluded, [
    { ownerId: 'asha', code: 'out_of_scope' },
    { ownerId: 'bilal', code: 'product_line' },
    { ownerId: 'dev', code: 'out_of_scope' },
  ]);
  const companyWide = pick({ unitPath: '/g/pi/' }, [counsellor('chitra', { unitPaths: ['/g/pi/delhi/'] })]);
  assert.equal(companyWide.ownerId, 'chitra', 'a counsellor inside the lead’s unit is in scope');
});

test('nobody eligible: unassigned, with the reasons counted', () => {
  const result = pick({}, [counsellor('asha', { openLeads: 50 }), counsellor('bilal', { available: false }), counsellor('chitra', { openLeads: 60 })]);
  assert.equal(result.decision, 'unassigned');
  assert.equal(result.ownerId, null);
  assert.equal(result.method, null);
  assert.match(result.reasons.at(-1).message, /2 at their open-lead cap, 1 marked unavailable/);
  assert.deepEqual(result.state, initialState());
  assert.equal(pick({}, []).reasons[0].message, 'Nobody is in the pool');
});

// --- soft preferences ----------------------------------------------------------------------------

test('language: speakers are preferred, others are used when nobody speaks it', () => {
  const owners = [counsellor('asha'), counsellor('bilal', { languages: ['ta', 'en'] }), counsellor('chitra', { languages: ['TA'] })];
  let state;
  const picks = [];
  for (let i = 0; i < 4; i += 1) {
    const result = pick({ language: 'ta' }, owners, state);
    picks.push(result.ownerId);
    state = result.state;
  }
  assert.deepEqual(picks, ['bilal', 'chitra', 'bilal', 'chitra'], 'round-robin within the Tamil speakers');
  const fallback = pick({ language: 'ml' }, owners);
  assert.equal(fallback.decision, 'assigned');
  assert.ok(fallback.reasons.some((r) => r.code === 'no_language_match'));
  const many = pick({ languages: ['ml', 'hi'] }, owners);
  assert.equal(many.ownerId, 'asha', 'any of the lead’s languages counts');
});

test('language can be required', () => {
  const result = pick({ language: 'ml' }, [counsellor('asha')], undefined, NOW, { languageMatch: 'require' });
  assert.equal(result.decision, 'unassigned');
  assert.deepEqual(result.excluded, [{ ownerId: 'asha', code: 'language' }]);
  const ignored = pick({ language: 'ta' }, [counsellor('asha'), counsellor('bilal', { languages: ['ta'] })], undefined, NOW, { languageMatch: 'ignore' });
  assert.equal(ignored.ownerId, 'asha');
});

test('working hours: people on shift are preferred; off-shift is a fallback unless required', () => {
  const owners = [
    counsellor('asha', { workingHours: { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' } }),
    counsellor('bilal', { workingHours: { days: [1, 2, 3, 4, 5, 6], start: '14:00', end: '23:00' } }),
  ];
  assert.equal(pick({}, owners, undefined, NOW).ownerId, 'asha', '11:30 IST: only Asha is on shift');
  assert.equal(pick({}, owners, undefined, IST_EVENING).ownerId, 'bilal', '21:00 IST: only Bilal is on shift');
  const sunday = pick({}, owners, undefined, SUNDAY);
  assert.equal(sunday.decision, 'assigned');
  assert.ok(sunday.reasons.some((r) => r.code === 'outside_hours_fallback'));
  const strict = pick({}, owners, undefined, SUNDAY, { workingHours: 'require' });
  assert.equal(strict.decision, 'unassigned');
  assert.deepEqual(strict.excluded.map((e) => e.code), ['outside_hours', 'outside_hours']);
});

test('owners without hours or a zone use the defaults (Asia/Kolkata, Mon–Sat 09:30–18:30)', () => {
  const owners = [{ id: 'asha' }, { id: 'bilal', timeZone: 'America/New_York' }];
  assert.equal(pick({}, owners, undefined, NOW).ownerId, 'asha', 'New York is at 01:00');
});

test('time zone: owners near the lead’s zone are preferred', () => {
  const owners = [
    counsellor('asha'),
    counsellor('dubai', { timeZone: 'Asia/Dubai', workingHours: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '00:00' } }),
    counsellor('nyc', { timeZone: 'America/New_York', workingHours: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '00:00' } }),
  ];
  assert.equal(pick({ timeZone: 'America/Chicago' }, owners).ownerId, 'nyc');
  // India and Dubai are 1h30 apart, both within the default 3 hours.
  const gulf = pick({ timeZone: 'Asia/Dubai' }, owners);
  assert.ok(['asha', 'dubai'].includes(gulf.ownerId));
  assert.equal(pick({ timeZone: 'Asia/Dubai' }, owners, undefined, NOW, { maxOffsetMinutes: 60 }).ownerId, 'dubai');
  const far = pick({ timeZone: 'Pacific/Auckland' }, owners, undefined, NOW, { maxOffsetMinutes: 60 });
  assert.equal(far.decision, 'assigned');
  assert.ok(far.reasons.some((r) => r.code === 'no_time_zone_match'));
  const off = pick({ timeZone: 'America/Chicago' }, owners, undefined, NOW, { timeZoneMatch: 'ignore' });
  assert.equal(off.ownerId, 'asha');
});

test('preferences apply in order: language before working hours before time zone', () => {
  const owners = [
    counsellor('tamil-off-shift', { languages: ['ta'], workingHours: { start: '20:00', end: '23:00' } }),
    counsellor('hindi-on-shift'),
  ];
  const result = pick({ language: 'ta' }, owners);
  assert.equal(result.ownerId, 'tamil-off-shift');
  assert.deepEqual(result.reasons.map((r) => r.code), ['prefer_language', 'outside_hours_fallback', 'round_robin']);
});

// --- stickiness ----------------------------------------------------------------------------------

test('partner leads stay with the partner’s counsellor, even at capacity and off shift', () => {
  const owners = [counsellor('asha'), counsellor('pooja', { partnerIds: ['partner-77'], openLeads: 80, capacity: 50, workingHours: { start: '20:00', end: '21:00' } })];
  const state = { version: 1, seq: 3, owners: { asha: { lastSeq: 3, assigned: 3 } } };
  const result = pick({ partnerId: 'partner-77' }, owners, state);
  assert.equal(result.ownerId, 'pooja');
  assert.equal(result.method, 'partner');
  assert.equal(result.state.seq, 3, 'a sticky assignment does not use a round-robin turn');
  assert.deepEqual(result.state.owners.pooja, { lastSeq: 0, assigned: 1 });
  const named = pick({ partnerId: 'partner-77', partnerOwnerId: 'asha' }, owners);
  assert.equal(named.ownerId, 'asha', 'the caller may name the partner’s counsellor');
});

test('partner stickiness falls back to round-robin when the counsellor cannot take it', () => {
  const away = pick({ partnerId: 'p1' }, [counsellor('asha'), counsellor('pooja', { partnerIds: ['p1'], available: false })]);
  assert.equal(away.ownerId, 'asha');
  assert.equal(away.method, 'round_robin');
  assert.equal(away.reasons[0].code, 'partner_owner_unavailable');
  const missing = pick({ partnerId: 'p2' }, [counsellor('asha')]);
  assert.equal(missing.reasons[0].code, 'partner_owner_missing');
  const capped = pick({ partnerId: 'p1' }, [counsellor('asha'), counsellor('pooja', { partnerIds: ['p1'], openLeads: 50 })], undefined, NOW, { stickyIgnoresCapacity: false });
  assert.equal(capped.ownerId, 'asha');
  const wrongCompany = pick({ partnerId: 'p1', companyId: 'pi-vector' }, [counsellor('asha'), counsellor('pooja', { partnerIds: ['p1'], companyIds: ['satnpaper'] })]);
  assert.equal(wrongCompany.ownerId, 'asha');
});

test('returning families go back to their counsellor', () => {
  const owners = [counsellor('asha'), counsellor('bilal', { openLeads: 50 })];
  const result = pick({ existingOwnerId: 'bilal', existingOwnerLastActivityAt: '2026-09-01T00:00:00Z' }, owners);
  assert.equal(result.ownerId, 'bilal');
  assert.equal(result.method, 'existing_owner');
});

test('returning-family stickiness expires and respects availability', () => {
  const owners = [counsellor('asha'), counsellor('bilal')];
  const old = pick({ existingOwnerId: 'bilal', existingOwnerLastActivityAt: '2025-01-01T00:00:00Z' }, owners);
  assert.equal(old.method, 'round_robin');
  assert.equal(old.reasons[0].code, 'existing_owner_expired');
  const shortWindow = pick({ existingOwnerId: 'bilal', existingOwnerLastActivityAt: '2026-09-01T00:00:00Z' }, owners, undefined, NOW, { returningWindowDays: 30 });
  assert.equal(shortWindow.reasons[0].code, 'existing_owner_expired');
  const gone = pick({ existingOwnerId: 'zoya' }, owners);
  assert.equal(gone.reasons[0].code, 'existing_owner_not_in_pool');
  const leave = pick({ existingOwnerId: 'bilal' }, [counsellor('asha'), counsellor('bilal', { away: [{ from: NOW - 1, to: NOW + 1 }] })]);
  assert.equal(leave.ownerId, 'asha');
  assert.equal(leave.reasons[0].code, 'existing_owner_unavailable');
});

test('partner stickiness wins over the returning family’s counsellor', () => {
  const owners = [counsellor('asha'), counsellor('pooja', { partnerIds: ['p1'] })];
  assert.equal(pick({ partnerId: 'p1', existingOwnerId: 'asha' }, owners).ownerId, 'pooja');
  const fallback = pick({ partnerId: 'p1', existingOwnerId: 'asha' }, [counsellor('asha'), counsellor('pooja', { partnerIds: ['p1'], active: false })]);
  assert.deepEqual([fallback.ownerId, fallback.method], ['asha', 'existing_owner']);
});

test('now is required', () => {
  assert.throws(() => assignOwner({ lead: {}, owners: [counsellor('a')] }), /now/);
});

// --- batches -------------------------------------------------------------------------------------

test('assignBatch carries loads forward so caps hold across an import', () => {
  const owners = [counsellor('asha', { openLeads: 48, capacity: 50 }), counsellor('bilal', { openLeads: 0, capacity: 3 })];
  const leads = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}` }));
  const { results, state, openLeads } = assignBatch({ leads, owners, now: NOW });
  // First pick is a tie on the rotation, so the lighter load (Bilal, 0/3) goes first.
  assert.deepEqual(results.map((r) => r.ownerId), ['bilal', 'asha', 'bilal', 'asha', 'bilal', null]);
  assert.deepEqual(openLeads, { asha: 50, bilal: 3 });
  assert.equal(results[5].decision, 'unassigned');
  assert.equal(results[0].leadId, 'l0');
  assert.equal('state' in results[0], false);
  assert.equal(state.seq, 5);
  assert.equal(owners[0].openLeads, 48, 'owners are not mutated');
});

test('assignBatch continues an earlier rotation', () => {
  const owners = [counsellor('asha'), counsellor('bilal')];
  const first = assignBatch({ leads: [{ id: 'a' }], owners, now: NOW });
  const second = assignBatch({ leads: [{ id: 'b' }], owners, state: first.state, now: NOW });
  assert.deepEqual([first.results[0].ownerId, second.results[0].ownerId], ['asha', 'bilal']);
});
