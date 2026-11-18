import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { addDays, toZonedParts } from '../../src/core/scheduling/index.js';
import { macWithKey, newNonce, signToken } from '../../src/modules/scheduling/tokens.js';
import { ingestAttendanceEvents, pendingJobs, processReminderJob } from '../../src/modules/scheduling/index.js';

// Scheduling end to end against a real Postgres + Redis (migrated and seeded, seeds 01, 02 and 30).
// Test event types are hosted by the group owner and the group admin (who host nothing in the seed),
// with availability set here, so slots are predictable. Everything made here is cancelled and
// archived at the end, so the test can run repeatedly.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const MINUTE = 60_000;

function client(base) {
  let cookie = '';
  return async function call(method, path, body, { raw = false } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    if (raw) return { status: res.status, text, headers: res.headers };
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const allSlots = (data) => data.days.flatMap((d) => d.slots.map((s) => ({ ...s, date: d.date })));

test('scheduling end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const password = env.SEED_PASSWORD;
  const createdEventTypes = [];

  t.after(async () => {
    // Free the hosts' time for the next run and switch the test event types off.
    if (createdEventTypes.length) {
      // Test bookings go (meetings and reminders cascade), so the demo calendar stays clean.
      await db('bookings').whereIn('event_type_id', createdEventTypes).del();
      await db('scheduling_event_types').whereIn('id', createdEventTypes).update({ archived_at: db.fn.now(), active: false });
    }
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });

  // Repeated runs (and the many bookings below, all from one IP) would trip the public rate limits.
  const resetLimits = async () => {
    const limits = await redis.keys('rl:*');
    if (limits.length) await redis.del(...limits);
  };
  await resetLimits();

  const people = {};
  for (const email of ['owner', 'admin', 'admin.satnpaper', 'admin.pivector', 'kabir', 'ritika', 'finance', 'sales.satnpaper']) {
    people[email] = client(base);
    const login = await people[email]('POST', '/auth/login', { email: `${email}@phoenix.test`, password });
    assert.equal(login.status, 200, `${email}: ${JSON.stringify(login.body)}`);
  }
  const { owner, admin, ritika, kabir, finance } = people;
  const spAdmin = people['admin.satnpaper'];
  const pvAdmin = people['admin.pivector'];
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const unitsByCode = new Map((await db('org_units').select('id', 'code', 'type', 'path')).map((u) => [`${u.type}:${u.code}`, u]));
  const satnpaper = unitsByCode.get('company:satnpaper');
  const satAdmissions = unitsByCode.get('team:sat-admissions');
  const online = unitsByCode.get('branch:online');
  const pivector = unitsByCode.get('company:pi-vector');
  const group = unitsByCode.get('group:phoenix');

  // A date four days out (India time) that every check below uses.
  const day = addDays(toZonedParts(Date.now(), 'Asia/Kolkata').date, 4);
  const everyDay = (ranges) => Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, ranges]));

  let solo; // one host (the owner)
  let team; // owner (Kolkata) + admin (New York)
  let soloToken;
  let teamToken;

  await t.test('availability: own zone, validation, who may edit', async () => {
    await resetLimits();
    const bad = await owner('PUT', '/scheduling/availability/me', { timeZone: 'IST', weekly: {} });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.some((d) => d.path === 'body.timeZone'));
    const badRange = await owner('PUT', '/scheduling/availability/me', { timeZone: 'Asia/Kolkata', weekly: { mon: ['25:00-26:00'] } });
    assert.equal(badRange.status, 422);

    const put = await owner('PUT', '/scheduling/availability/me', { timeZone: 'asia/calcutta', weekly: everyDay(['09:00-17:00']), overrides: {} });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.data.timeZone, 'Asia/Kolkata', 'zones are stored in their current spelling');
    const adminPut = await admin('PUT', '/scheduling/availability/me', { timeZone: 'America/New_York', weekly: everyDay(['09:00-12:00']) });
    assert.equal(adminPut.status, 200);

    // A counsellor can't change a colleague's hours; their company admin can see them.
    const ritikaOnKabir = await ritika('PUT', `/scheduling/availability/${users.get('kabir@phoenix.test')}`, { timeZone: 'Asia/Kolkata', weekly: {} });
    assert.ok([403, 404].includes(ritikaOnKabir.status));
    const seen = await spAdmin('GET', `/scheduling/availability/${users.get('ritika@phoenix.test')}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.timeZone, 'Asia/Dubai');
    assert.equal(seen.body.data.canEdit, true);
    const pvOnRitika = await pvAdmin('GET', `/scheduling/availability/${users.get('ritika@phoenix.test')}`);
    assert.equal(pvOnRitika.status, 404);
  });

  await t.test('event types: create, validate, scope', async () => {
    await resetLimits();
    const base = {
      unitId: satAdmissions.id,
      durationMin: 30,
      slotIntervalMin: 30,
      minNoticeMin: 60,
      horizonDays: 14,
      locationKind: 'zoom',
      attendanceThresholdMin: 10,
      questions: [{ key: 'grade', label: 'Grade', type: 'select', required: true, options: [{ value: '11', label: 'Grade 11' }, { value: '12', label: 'Grade 12' }] }],
      attendees: { ask: true, maxGuests: 1 },
    };
    const badSlug = await spAdmin('POST', '/scheduling/event-types', { ...base, name: 'x', slug: 'Not A Slug', hosts: [] });
    assert.equal(badSlug.status, 422);
    const outsider = await spAdmin('POST', '/scheduling/event-types', { ...base, name: 'x', slug: `x-${RUN}`, hosts: [{ userId: users.get('admin.pivector@phoenix.test') }] });
    assert.equal(outsider.status, 422, 'a Pi Vector admin cannot host SatnPaper meetings');
    assert.equal(outsider.body.error.details[0].path, 'body.hosts.0.userId');
    const counsellor = await ritika('POST', '/scheduling/event-types', { ...base, name: 'x', slug: `x-${RUN}` });
    assert.equal(counsellor.status, 403);
    const elsewhere = await pvAdmin('POST', '/scheduling/event-types', { ...base, name: 'x', slug: `x-${RUN}` });
    assert.equal(elsewhere.status, 404);

    const soloRes = await spAdmin('POST', '/scheduling/event-types', {
      ...base,
      name: `Solo ${RUN}`,
      slug: `solo-${RUN}`,
      hosts: [{ userId: users.get('owner@phoenix.test') }],
    });
    assert.equal(soloRes.status, 201, JSON.stringify(soloRes.body));
    solo = soloRes.body.data;
    createdEventTypes.push(solo.id);
    assert.equal(solo.hosts.length, 1);
    assert.equal(solo.hosts[0].hasAvailability, true);
    assert.ok(solo.publicLink?.token);
    soloToken = solo.publicLink.token;

    const teamRes = await spAdmin('POST', '/scheduling/event-types', {
      ...base,
      questions: [],
      attendees: { ask: false },
      name: `Team ${RUN}`,
      slug: `team-${RUN}`,
      hosts: [{ userId: users.get('owner@phoenix.test') }, { userId: users.get('admin@phoenix.test'), weight: 2 }],
    });
    assert.equal(teamRes.status, 201);
    team = teamRes.body.data;
    createdEventTypes.push(team.id);
    teamToken = team.publicLink.token;

    const dup = await spAdmin('POST', '/scheduling/event-types', { ...base, name: 'dup', slug: `solo-${RUN}` });
    assert.equal(dup.status, 422);
    assert.equal(dup.body.error.details[0].path, 'body.slug');

    // Reading: the counsellor's team sees it; Pi Vector doesn't.
    const fromTeam = await ritika('GET', `/scheduling/event-types?unitId=${satAdmissions.id}`);
    assert.equal(fromTeam.status, 200);
    assert.ok(fromTeam.body.data.some((e) => e.id === solo.id));
    assert.equal(fromTeam.body.data.find((e) => e.id === solo.id).can.configure, false);
    assert.equal((await pvAdmin('GET', `/scheduling/event-types/${solo.id}`)).status, 404);
    assert.equal((await pvAdmin('PATCH', `/scheduling/event-types/${solo.id}`, { name: 'Hijack' })).status, 404);
    assert.equal((await ritika('PATCH', `/scheduling/event-types/${solo.id}`, { name: 'Mine' })).status, 403);
    assert.equal((await pvAdmin('GET', `/scheduling/event-types?unitId=${satnpaper.id}`)).status, 404);
    const pvList = await pvAdmin('GET', `/scheduling/event-types?unitId=${pivector.id}`);
    assert.ok(pvList.body.data.every((e) => e.companyId === pivector.id));

    const patched = await spAdmin('PATCH', `/scheduling/event-types/${solo.id}`, { bufferAfterMin: 0, description: 'Integration test' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.description, 'Integration test');
  });

  await t.test('slots: the same instants in every viewer zone', async () => {
    await resetLimits();
    const zones = ['Asia/Kolkata', 'America/Los_Angeles', 'Asia/Kathmandu', 'Europe/London'];
    const results = {};
    for (const zone of zones) {
      // Two local days around the target date, so every zone covers the IST working day.
      const res = await owner('GET', `/public/booking/${soloToken}/slots?from=${addDays(day, -1)}&to=${addDays(day, 1)}&timeZone=${encodeURIComponent(zone)}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.timeZone, zone);
      for (const slot of allSlots(res.body.data)) {
        const local = toZonedParts(slot.start, zone);
        assert.equal(slot.date, local.date, `${zone}: grouped by the viewer's local date`);
        assert.equal(slot.localTime, local.time, `${zone}: local time label`);
      }
      results[zone] = allSlots(res.body.data).map((s) => s.start);
    }
    const ist = allSlots(
      (await owner('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${day}&timeZone=Asia/Kolkata`)).body.data,
    );
    assert.ok(ist.length > 0);
    // The owner works 09:00–17:00 India time: 30-minute slots from 09:00 to 16:30 (minus anything already booked).
    for (const slot of ist) {
      const { time } = toZonedParts(slot.start, 'Asia/Kolkata');
      assert.ok(time >= '09:00' && time <= '16:30', `slot at ${time} IST`);
      assert.equal(new Date(slot.end) - new Date(slot.start), 30 * MINUTE);
    }
    const istSet = new Set(ist.map((s) => s.start));
    for (const zone of zones) assert.ok([...istSet].every((s) => results[zone].includes(s)), `${zone} offers the same instants`);

    // Two hosts in different zones: New York mornings appear as India evenings.
    const mixed = allSlots((await owner('GET', `/public/booking/${teamToken}/slots?from=${day}&to=${addDays(day, 1)}&timeZone=Asia/Kolkata`)).body.data);
    assert.ok(mixed.some((s) => toZonedParts(s.start, 'Asia/Kolkata').time >= '19:30'), 'admin in New York adds evening slots in IST');

    const tooLong = await owner('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${addDays(day, 60)}&timeZone=Asia/Kolkata`);
    assert.equal(tooLong.status, 422);
    const badZone = await owner('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${day}&timeZone=%2B05:30`);
    assert.equal(badZone.status, 422);
  });

  let booking; // booked through the solo public page
  let manageToken;

  await t.test('public booking: validation, idempotency, confirmation', async () => {
    await resetLimits();
    const visitor = client(base);
    const page = await visitor('GET', `/public/booking/${soloToken}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.eventType.name, `Solo ${RUN}`);
    assert.ok(page.body.data.branding.color.startsWith('#'));
    assert.equal(page.body.data.eventType.attendees.ask, true);

    const slots = allSlots((await visitor('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${day}&timeZone=Asia/Kolkata`)).body.data);
    const slot = slots[0];
    const body = { start: slot.start, timeZone: 'Asia/Kolkata', name: 'Test Parent', email: `it-${RUN}@example.com`, phone: '+91 90000 11111', attending: 'both', answers: { grade: '12' } };

    const missing = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, answers: {} });
    assert.equal(missing.status, 422);
    assert.ok(missing.body.error.details.some((d) => d.path === 'body.answers.grade'));
    const wrongChoice = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, attending: 'grandparent' });
    assert.equal(wrongChoice.status, 422);
    const tooManyGuests = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, guests: [{ name: 'A' }, { name: 'B' }] });
    assert.equal(tooManyGuests.status, 422);
    const badEmail = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, email: 'nope' });
    assert.equal(badEmail.status, 422);
    const naive = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, start: '2026-12-01T10:00:00' });
    assert.equal(naive.status, 422, 'a time without an offset is not an instant');
    const offGrid = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, start: new Date(new Date(slot.start).getTime() + 7 * MINUTE).toISOString() });
    assert.equal(offGrid.status, 409);
    assert.equal(offGrid.body.error.code, 'slot_unavailable');
    const night = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, start: `${day}T22:00:00+05:30` });
    assert.equal(night.status, 409);
    const past = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, start: new Date(Date.now() - 3600_000).toISOString() });
    assert.equal(past.status, 409);

    const key = `key-${RUN}-1`;
    const made = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, idempotencyKey: key });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const again = await visitor('POST', `/public/booking/${soloToken}/book`, { ...body, idempotencyKey: key });
    assert.equal(again.status, 201);
    assert.equal(again.body.data.id, made.body.data.id, 'a retried request makes one booking');
    booking = made.body.data;
    manageToken = booking.manageToken;
    assert.equal(booking.status, 'booked');
    assert.equal(booking.inviteeName, 'Test Parent');
    assert.ok(booking.location.meetingUrl?.startsWith('https://zoom.us/j/'), 'development meeting link');
    assert.equal(booking.can.reschedule, true);

    const row = await db('bookings').where({ id: booking.id }).first();
    assert.equal(row.host_user_id, users.get('owner@phoenix.test'));
    assert.equal(row.invitee_phone, '+919000011111');
    assert.ok(row.contact_id, 'the visitor became a contact');
    const events = await db('outbox_events').where({ aggregate_id: booking.id, type: 'booking.created' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.hostUserId, row.host_user_id);
    const reminders = await db('booking_reminders').where({ booking_id: booking.id });
    assert.ok(reminders.length >= 1, 'reminders planned');
    assert.ok(reminders.every((r) => r.job_id.startsWith(`reminder-${booking.id}-s0-m`)));

    const takenNow = allSlots((await visitor('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${day}&timeZone=Asia/Kolkata`)).body.data);
    assert.ok(!takenNow.some((s) => s.start === slot.start), 'the booked slot is gone');
  });

  await t.test('double booking is impossible', async () => {
    await resetLimits();
    const visitor = client(base);
    const slots = allSlots((await visitor('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${day}&timeZone=Asia/Kolkata`)).body.data);
    const slot = slots[1];
    const attempt = (n) =>
      visitor('POST', `/public/booking/${soloToken}/book`, {
        start: slot.start,
        timeZone: 'Asia/Kolkata',
        name: `Racer ${n}`,
        email: `it-${RUN}-race${n}@example.com`,
        attending: 'parent',
        answers: { grade: '11' },
      });
    const results = await Promise.all([attempt(1), attempt(2), attempt(3)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409], JSON.stringify(results.map((r) => r.body?.error ?? r.body?.data?.id)));

    // Two hosts: the same time can be booked twice (one per host), never three times.
    const teamSlots = allSlots((await visitor('GET', `/public/booking/${teamToken}/slots?from=${day}&to=${addDays(day, 1)}&timeZone=Asia/Kolkata`)).body.data);
    const shared = teamSlots.find((s) => {
      const t2 = toZonedParts(s.start, 'America/New_York').time;
      const t1 = toZonedParts(s.start, 'Asia/Kolkata').time;
      return t2 >= '09:00' && t2 < '12:00' && t1 >= '09:00' && t1 < '17:00';
    });
    if (shared) {
      const book = (n) => visitor('POST', `/public/booking/${teamToken}/book`, { start: shared.start, timeZone: 'Asia/Kolkata', name: `Team ${n}`, email: `it-${RUN}-team${n}@example.com` });
      const r = await Promise.all([book(1), book(2), book(3)]);
      assert.deepEqual(r.map((x) => x.status).sort(), [201, 201, 409]);
      const hosts = await db('bookings').where({ event_type_id: team.id, start_at: new Date(shared.start) }).whereIn('status', ['booked']).pluck('host_user_id');
      assert.equal(new Set(hosts).size, 2, 'one booking per host');
    }

    // The database refuses an overlap even without the service (exclusion constraint).
    const row = await db('bookings').where({ id: booking.id }).first();
    const { id: _id, ics_uid: _uid, source_event_id: _src, ...copy } = row;
    await assert.rejects(
      db('bookings').insert({ ...copy, start_at: new Date(new Date(row.start_at).getTime() + 10 * MINUTE), end_at: new Date(new Date(row.end_at).getTime() + 10 * MINUTE), token_nonce: newNonce() }),
      (err) => err.code === '23P01',
    );
  });

  await t.test('tokens: forged, altered, wrong kind, expired, revoked', async () => {
    await resetLimits();
    const visitor = client(base);
    const flip = (token, i) => token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
    for (const i of [3, 20, 40, 58]) assert.equal((await visitor('GET', `/public/booking/${flip(soloToken, i)}`)).status, 404, `altered at ${i}`);
    assert.equal((await visitor('GET', `/public/booking/not-a-real-token-at-all`)).status, 404);
    assert.equal((await visitor('GET', `/public/booking/${manageToken}`)).status, 404, 'a manage token is not a booking-page token');
    assert.equal((await visitor('GET', `/public/bookings/${soloToken}`)).status, 404, 'a booking-page token cannot manage bookings');

    // Signed with another key (another environment): refused before any lookup.
    const body = Buffer.from(soloToken, 'base64url').subarray(0, 28);
    const foreign = Buffer.concat([body, macWithKey(Buffer.alloc(32, 7), body)]).toString('base64url');
    assert.equal((await visitor('GET', `/public/booking/${foreign}`)).status, 404);

    const link = await db('scheduling_booking_links').where({ event_type_id: solo.id, kind: 'public' }).first();
    const expired = signToken({ kind: 'link', id: link.id, expiresAt: Date.now() - 1000 });
    const res = await visitor('GET', `/public/booking/${expired}`);
    assert.equal(res.status, 410);
    assert.equal(res.body.error.code, 'link_expired');

    // A manage link with an old nonce (rotated) no longer works.
    const row = await db('bookings').where({ id: booking.id }).first();
    const stale = signToken({ kind: 'manage', id: row.id, nonce: newNonce(), expiresAt: Date.now() + 86_400_000 });
    assert.equal((await visitor('GET', `/public/bookings/${stale}`)).status, 404);
    assert.equal((await visitor('GET', `/public/bookings/${manageToken}`)).status, 200);
  });

  await t.test('reschedule and cancel by token', async () => {
    await resetLimits();
    const visitor = client(base);
    const slots = allSlots((await visitor('GET', `/public/bookings/${manageToken}/slots?from=${day}&to=${addDays(day, 1)}&timeZone=Asia/Kolkata`)).body.data);
    assert.ok(slots.some((s) => s.start === booking.startAt), "the booking's own time stays offered when moving it");
    const target = slots.filter((s) => s.start !== booking.startAt).at(-1);
    const moved = await visitor('POST', `/public/bookings/${manageToken}/reschedule`, { start: target.start, timeZone: 'Europe/London' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.status, 'rescheduled');
    assert.equal(moved.body.data.startAt, target.start);
    assert.equal(moved.body.data.timeZone, 'Europe/London');
    const row = await db('bookings').where({ id: booking.id }).first();
    assert.equal(row.ics_sequence, 1);
    const reminders = await db('booking_reminders').where({ booking_id: booking.id });
    assert.ok(reminders.filter((r) => r.sequence === 0).every((r) => r.status === 'cancelled'), 'old reminders cancelled');
    assert.ok(reminders.some((r) => r.sequence === 1 && r.status === 'scheduled'), 'new reminders planned');

    const ics = await visitor('GET', `/public/bookings/${manageToken}/invite.ics`, undefined, { raw: true });
    assert.equal(ics.status, 200);
    assert.match(ics.headers.get('content-type'), /text\/calendar.*method=REQUEST/);
    assert.match(ics.text, /SEQUENCE:1\r\n/);
    assert.match(ics.text, new RegExp(`UID:${row.ics_uid}`));

    const taken = await visitor('POST', `/public/bookings/${manageToken}/reschedule`, { start: `${day}T23:00:00+05:30`, timeZone: 'Asia/Kolkata' });
    assert.equal(taken.status, 409);

    const asked = await visitor('POST', `/public/bookings/${manageToken}/reschedule-request`, { note: 'Weekend please' });
    assert.equal(asked.status, 200);
    assert.equal(asked.body.data.rescheduleRequested, true);
    const requests = await spAdmin('GET', `/scheduling/bookings?unitId=${satnpaper.id}&view=reschedule_requests`);
    assert.ok(requests.body.data.some((b) => b.id === booking.id && b.rescheduleRequest.note === 'Weekend please'));

    const cancelled = await visitor('POST', `/public/bookings/${manageToken}/cancel`, { reason: 'Clash' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'cancelled');
    assert.equal(cancelled.body.data.location.meetingUrl, null, 'no join link on a cancelled booking');
    const again = await visitor('POST', `/public/bookings/${manageToken}/cancel`, {});
    assert.equal(again.status, 409);
    const cancelIcs = await visitor('GET', `/public/bookings/${manageToken}/invite.ics`, undefined, { raw: true });
    assert.match(cancelIcs.text, /METHOD:CANCEL/);
    assert.match(cancelIcs.text, /SEQUENCE:2\r\n/);
    assert.equal((await db('outbox_events').where({ aggregate_id: booking.id }).whereIn('type', ['booking.rescheduled', 'booking.cancelled'])).length, 2);
    assert.ok((await db('booking_reminders').where({ booking_id: booking.id, status: 'scheduled' })).length === 0);
  });

  await t.test('staff lists are scoped', async () => {
    await resetLimits();
    const mine = await ritika('GET', `/scheduling/bookings?unitId=${satAdmissions.id}&view=all&limit=200`);
    assert.equal(mine.status, 200);
    const ritikaId = users.get('ritika@phoenix.test');
    assert.ok(mine.body.data.length > 0);
    assert.ok(mine.body.data.every((b) => b.host?.id === ritikaId || b.owner?.id === ritikaId), 'counsellors see the bookings they host or whose deal they own');

    const branch = await kabir('GET', `/scheduling/bookings?unitId=${online.id}&view=all&limit=200`);
    assert.ok(branch.body.data.some((b) => b.host?.id === ritikaId), 'a branch manager sees the whole branch');

    const pv = await pvAdmin('GET', `/scheduling/bookings?unitId=${pivector.id}&view=all&limit=200`);
    assert.ok(pv.body.data.length > 0 && pv.body.data.every((b) => b.companyId === pivector.id));
    assert.equal((await pvAdmin('GET', `/scheduling/bookings?unitId=${satnpaper.id}`)).status, 404);
    const spBooking = await db('bookings').where({ company_id: satnpaper.id }).first('id');
    assert.equal((await pvAdmin('GET', `/scheduling/bookings/${spBooking.id}`)).status, 404);
    assert.equal((await pvAdmin('POST', `/scheduling/bookings/${spBooking.id}/cancel`, {})).status, 404);
    const fromGroup = await pvAdmin('GET', `/scheduling/bookings?unitId=${group.id}&view=all&limit=200`);
    assert.equal(fromGroup.status, 200);
    assert.ok(fromGroup.body.data.every((b) => b.companyId === pivector.id), 'the group view still shows only their company');

    const all = await finance('GET', `/scheduling/bookings?unitId=${group.id}&view=all&limit=200`);
    assert.ok(new Set(all.body.data.map((b) => b.companyId)).size >= 2);
    assert.ok(all.body.data.every((b) => b.can.manage === false), 'finance only reads');

    // Keyset pagination: pages don't overlap and keep the order.
    const page1 = await finance('GET', `/scheduling/bookings?unitId=${group.id}&view=all&limit=5`);
    assert.ok(page1.body.nextCursor);
    const page2 = await finance('GET', `/scheduling/bookings?unitId=${group.id}&view=all&limit=5&cursor=${page1.body.nextCursor}`);
    const ids1 = new Set(page1.body.data.map((b) => b.id));
    assert.ok(page2.body.data.every((b) => !ids1.has(b.id)));
    assert.ok(page2.body.data[0].startAt >= page1.body.data.at(-1).startAt);

    const summary = await kabir('GET', `/scheduling/bookings/summary?unitId=${online.id}`);
    assert.equal(summary.status, 200);
    assert.equal(typeof summary.body.data.upcoming, 'number');
    for (const key of ['live', 'next24h', 'noShows30d', 'rescheduleRequests', 'awaitingOutcome']) assert.equal(typeof summary.body.data[key], 'number', key);

    const ritikaOnKabirs = mine.body.data.length
      ? await db('bookings').where({ unit_id: satAdmissions.id }).whereNot('host_user_id', ritikaId).whereNot('owner_user_id', ritikaId).first('id')
      : null;
    if (ritikaOnKabirs) assert.equal((await ritika('GET', `/scheduling/bookings/${ritikaOnKabirs.id}`)).status, 404);
  });

  await t.test('staff reschedule, reassign, outcomes', async () => {
    await resetLimits();
    const visitor = client(base);
    const slots = allSlots((await visitor('GET', `/public/booking/${teamToken}/slots?from=${day}&to=${addDays(day, 1)}&timeZone=Asia/Kolkata`)).body.data);
    const both = slots.find((s) => {
      const ny = toZonedParts(s.start, 'America/New_York').time;
      const ist = toZonedParts(s.start, 'Asia/Kolkata').time;
      return ny >= '09:00' && ny < '12:00' && ist >= '09:00' && ist < '17:00';
    }) ?? slots[0];
    const made = await visitor('POST', `/public/booking/${teamToken}/book`, { start: both.start, timeZone: 'Asia/Kolkata', name: 'Reassign me', email: `it-${RUN}-ra@example.com` });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.data.id;
    const current = await db('bookings').where({ id }).first();
    const otherHost = current.host_user_id === users.get('owner@phoenix.test') ? users.get('admin@phoenix.test') : users.get('owner@phoenix.test');

    assert.ok([403, 404].includes((await ritika('POST', `/scheduling/bookings/${id}/reassign`, { hostUserId: otherHost })).status));
    const candidates = await spAdmin('GET', `/scheduling/bookings/${id}/reassign-candidates`);
    assert.equal(candidates.status, 200);
    const candidate = candidates.body.data.find((c) => c.id === otherHost);
    assert.ok(candidate);
    if (candidate.available) {
      const moved = await spAdmin('POST', `/scheduling/bookings/${id}/reassign`, { hostUserId: otherHost });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.data.host.id, otherHost);
      assert.equal((await db('bookings').where({ id }).first()).ics_sequence, 1);
    } else {
      const refused = await spAdmin('POST', `/scheduling/bookings/${id}/reassign`, { hostUserId: otherHost });
      assert.equal(refused.status, 409);
    }
    const notHost = await spAdmin('POST', `/scheduling/bookings/${id}/reassign`, { hostUserId: users.get('kabir@phoenix.test') });
    assert.equal(notHost.status, 422);

    const early = await spAdmin('POST', `/scheduling/bookings/${id}/no-show`, {});
    assert.equal(early.status, 409, 'no outcome before the meeting starts');
    const staffMove = await spAdmin('POST', `/scheduling/bookings/${id}/reschedule`, { start: `${day}T03:00:00+05:30` });
    assert.equal(staffMove.status, 409);
    const staffCancel = await spAdmin('POST', `/scheduling/bookings/${id}/cancel`, { reason: 'Test over' });
    assert.equal(staffCancel.status, 200);
    assert.equal(staffCancel.body.data.status, 'cancelled');
    assert.equal(staffCancel.body.data.cancelledBy, 'host');

    // A meeting that has started: staff marks a no-show once.
    const past = await insertPastBooking({ hostId: null, minutesAgo: 90 });
    const noShow = await spAdmin('POST', `/scheduling/bookings/${past.id}/no-show`, { note: 'Did not join' });
    assert.equal(noShow.status, 200, JSON.stringify(noShow.body));
    assert.equal(noShow.body.data.status, 'no_show');
    assert.equal((await spAdmin('POST', `/scheduling/bookings/${past.id}/no-show`, {})).status, 409);
    assert.equal((await db('outbox_events').where({ aggregate_id: past.id, type: 'booking.no_show' })).length, 1);
  });

  async function insertPastBooking({ hostId, minutesAgo, durationMin = 30, provider = 'zoom', ref = null, email = `it-${RUN}-past@example.com` }) {
    const start = new Date(Date.now() - minutesAgo * MINUTE);
    const [row] = await db('bookings')
      .insert({
        group_id: satnpaper.path.split('/')[1],
        company_id: satnpaper.id,
        unit_id: satAdmissions.id,
        event_type_id: solo.id,
        host_user_id: hostId,
        status: 'booked',
        start_at: start,
        end_at: new Date(start.getTime() + durationMin * MINUTE),
        time_zone: 'Asia/Kolkata',
        invitee_name: 'Past Parent',
        invitee_email: email,
        location_kind: provider,
        meeting_ref: ref,
        token_nonce: newNonce(),
      })
      .returning('*');
    await db('meetings').insert({ booking_id: row.id, group_id: row.group_id, company_id: row.company_id, provider, provider_meeting_id: ref, threshold_min: 10 });
    return row;
  }

  await t.test('attendance: merged intervals against the threshold', async () => {
    await resetLimits();
    const hostEmail = 'owner@phoenix.test';
    const at = (ms) => new Date(ms).toISOString();
    const scenario = async (name, sessions, { ended, minutesAgo }) => {
      const ref = `it-${RUN}-${name}`;
      const row = await insertPastBooking({ hostId: users.get(hostEmail), minutesAgo, ref, email: `${name}-${RUN}@example.com` });
      const start = new Date(row.start_at).getTime();
      const events = [{ id: `${ref}-host`, type: 'participant.joined', occurredAt: at(start), meeting: { id: ref }, participant: { userId: 'h1', name: 'Host', email: hostEmail, joinTime: at(start) } }];
      sessions.forEach(([from, to], i) => {
        const p = { userId: `u${i}`, name: 'Past Parent', email: `${name}-${RUN}@example.com` };
        events.push({ id: `${ref}-j${i}`, type: 'participant.joined', occurredAt: at(start + from * MINUTE), meeting: { id: ref }, participant: { ...p, joinTime: at(start + from * MINUTE) } });
        events.push({ id: `${ref}-l${i}`, type: 'participant.left', occurredAt: at(start + to * MINUTE), meeting: { id: ref }, participant: { ...p, leaveTime: at(start + to * MINUTE) } });
      });
      if (ended) events.push({ id: `${ref}-end`, type: 'meeting.ended', occurredAt: at(start + 30 * MINUTE), meeting: { id: ref, endTime: at(start + 30 * MINUTE) } });
      return { row, events };
    };

    // Two devices, overlapping: 2–8 and 5–9 minutes = 7 minutes, under the 10-minute threshold.
    const short = await scenario('short', [[2, 8], [5, 9]], { ended: false, minutesAgo: 40 });
    const live = await ingestAttendanceEvents({ provider: 'zoom', events: short.events });
    assert.equal(live.meetings[0].inviteeSeconds, 7 * 60, 'overlap counted once');
    assert.equal(live.meetings[0].outcome, null, 'no verdict while the meeting may still run');
    const end = { id: `it-${RUN}-short-end`, type: 'meeting.ended', occurredAt: new Date(new Date(short.row.start_at).getTime() + 30 * MINUTE).toISOString(), meeting: { id: `it-${RUN}-short` } };
    const ended = await ingestAttendanceEvents({ provider: 'zoom', events: [end] });
    assert.equal(ended.meetings[0].outcome, 'no_show');
    assert.equal((await db('bookings').where({ id: short.row.id }).first()).status, 'no_show');

    // Drop and rejoin: 1–6 and 8–15 = 12 minutes → attended as soon as it's known.
    const enough = await scenario('enough', [[1, 6], [8, 15]], { ended: false, minutesAgo: 80 });
    const res = await ingestAttendanceEvents({ provider: 'zoom', events: enough.events });
    assert.equal(res.meetings[0].inviteeSeconds, 12 * 60);
    assert.equal(res.meetings[0].outcome, 'attended');
    const replay = await ingestAttendanceEvents({ provider: 'zoom', events: enough.events });
    assert.equal(replay.stored, 0, 'webhook retries are ignored');
    assert.equal((await db('outbox_events').where({ aggregate_id: enough.row.id, type: 'booking.attended' })).length, 1);
    assert.equal((await db('outbox_events').where({ aggregate_id: short.row.id, type: 'booking.no_show' })).length, 1);
    const meeting = await db('meetings').where({ booking_id: enough.row.id }).first();
    assert.equal(meeting.result, 'attended');
    const participants = await db('meeting_participants').where({ meeting_id: meeting.id });
    assert.ok(participants.some((p) => p.role === 'host'));
    assert.ok(participants.some((p) => p.role === 'invitee' && p.attended_seconds === 12 * 60 && p.session_count === 2));

    const unknown = await ingestAttendanceEvents({ provider: 'zoom', events: [{ ...end, id: `x-${RUN}`, meeting: { id: 'no-such-meeting' } }] });
    assert.equal(unknown.unmatched, 1);
  });

  await t.test('reminder jobs run once', async () => {
    await resetLimits();
    const visitor = client(base);
    const slots = allSlots((await visitor('GET', `/public/booking/${soloToken}/slots?from=${day}&to=${day}&timeZone=Asia/Kolkata`)).body.data);
    const made = await visitor('POST', `/public/booking/${soloToken}/book`, { start: slots.at(-1).start, timeZone: 'Asia/Kolkata', name: 'Remind me', email: `it-${RUN}-rem@example.com`, attending: 'parent', answers: { grade: '11' } });
    assert.equal(made.status, 201);
    const reminder = await db('booking_reminders').where({ booking_id: made.body.data.id, status: 'scheduled' }).first();
    const jobs = await pendingJobs();
    assert.ok(jobs.some((j) => j.jobId === reminder.job_id && j.name === 'scheduling.reminder'));
    const data = { bookingId: reminder.booking_id, sequence: reminder.sequence, offsetMin: reminder.offset_min };
    assert.equal(await processReminderJob({ data }), 'sent');
    assert.equal(await processReminderJob({ data }), 'gone', 'a retried job sends nothing');
    assert.equal((await db('booking_reminders').where({ id: reminder.id }).first()).status, 'sent');
    await visitor('POST', `/public/bookings/${made.body.data.manageToken}/cancel`, {});
    const other = await db('booking_reminders').where({ booking_id: reminder.booking_id }).whereNot({ id: reminder.id }).first();
    if (other) assert.equal(await processReminderJob({ data: { bookingId: other.booking_id, sequence: other.sequence, offsetMin: other.offset_min } }), 'gone');
  });

  await t.test('personal booking links', async () => {
    await resetLimits();
    const deal = await db('deals as d')
      .join('contacts as c', 'c.id', 'd.primary_contact_id')
      .where({ 'd.unit_id': satAdmissions.id, 'd.owner_user_id': users.get('kabir@phoenix.test'), 'd.status': 'open' })
      .whereNotNull('c.primary_email')
      .orderBy('d.number', 'desc')
      .first('d.*');
    const ritikaTry = await ritika('POST', '/scheduling/links', { eventTypeId: solo.id, dealId: deal.id });
    assert.equal(ritikaTry.status, 404, "a counsellor can't send links for a colleague's deal");
    const pvTry = await pvAdmin('POST', '/scheduling/links', { eventTypeId: solo.id, dealId: deal.id });
    assert.equal(pvTry.status, 404);
    const pvEventType = (await pvAdmin('GET', `/scheduling/event-types?unitId=${pivector.id}`)).body.data[0];
    const wrongCompany = await spAdmin('POST', '/scheduling/links', { eventTypeId: pvEventType?.id ?? solo.id, dealId: deal.id });
    assert.ok([404, 422].includes(wrongCompany.status));
    const noSubject = await spAdmin('POST', '/scheduling/links', { eventTypeId: solo.id });
    assert.equal(noSubject.status, 422);

    const made = await kabir('POST', '/scheduling/links', { eventTypeId: solo.id, dealId: deal.id, attending: 'parent' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const link = made.body.data;
    assert.equal(link.status, 'active');
    assert.equal(link.maxUses, 1);
    assert.ok(link.expiresAt);
    const listed = await kabir('GET', `/scheduling/links?dealId=${deal.id}`);
    assert.ok(listed.body.data.some((l) => l.id === link.id));

    const sent = await kabir('POST', `/scheduling/links/${link.id}/send`, { channel: 'email', message: 'Pick a time' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.ok(sent.body.data.lastSentAt);
    const entry = await db('timeline_events').where({ deal_id: deal.id }).whereRaw("meta->>'bookingLinkId' = ?", [link.id]).first();
    assert.ok(entry, 'timeline entry on the deal');

    const visitor = client(base);
    const page = await visitor('GET', `/public/booking/${link.token}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.personal, true);
    assert.equal(page.body.data.prefill.attending, 'parent');
    assert.ok(!JSON.stringify(page.body.data).includes('@'), 'no contact details on the public page');
    const slots = allSlots((await visitor('GET', `/public/booking/${link.token}/slots?from=${day}&to=${addDays(day, 1)}&timeZone=Asia/Kolkata`)).body.data);
    const made1 = await visitor('POST', `/public/booking/${link.token}/book`, { start: slots[2].start, timeZone: 'Asia/Kolkata', name: 'Deal Parent', email: `it-${RUN}-deal@example.com`, attending: 'parent', answers: { grade: '12' } });
    assert.equal(made1.status, 201, JSON.stringify(made1.body));
    const row = await db('bookings').where({ id: made1.body.data.id }).first();
    assert.equal(row.deal_id, deal.id, 'booked onto the deal');
    assert.equal(row.contact_id, deal.primary_contact_id);
    assert.equal(row.owner_user_id, deal.owner_user_id);
    assert.equal(row.unit_id, deal.unit_id);
    assert.equal(row.source, 'personal_link');
    const second = await visitor('POST', `/public/booking/${link.token}/book`, { start: slots[3].start, timeZone: 'Asia/Kolkata', name: 'Again', email: `it-${RUN}-again@example.com`, attending: 'parent', answers: { grade: '12' } });
    assert.equal(second.status, 410);
    assert.equal(second.body.error.code, 'link_used');

    // Kabir owns the deal, so he sees the booking even though the owner hosts it.
    const seen = await kabir('GET', `/scheduling/bookings/${row.id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.deal.id, deal.id);

    const link2 = (await kabir('POST', '/scheduling/links', { eventTypeId: solo.id, dealId: deal.id })).body.data;
    const revoked = await kabir('POST', `/scheduling/links/${link2.id}/revoke`, {});
    assert.equal(revoked.body.data.status, 'revoked');
    assert.equal((await visitor('GET', `/public/booking/${link2.token}`)).status, 404);
    assert.equal((await kabir('POST', `/scheduling/links/${link2.id}/send`, { channel: 'email' })).status, 409);
  });

  await t.test('archived event types close their pages', async () => {
    await resetLimits();
    const archived = await spAdmin('POST', `/scheduling/event-types/${team.id}/archive`, {});
    assert.equal(archived.status, 200);
    assert.ok(archived.body.data.archivedAt);
    const res = await client(base)('GET', `/public/booking/${teamToken}`);
    assert.equal(res.status, 410);
    const listed = await spAdmin('GET', `/scheduling/event-types?unitId=${satnpaper.id}`);
    assert.ok(!listed.body.data.some((e) => e.id === team.id));
  });
});
