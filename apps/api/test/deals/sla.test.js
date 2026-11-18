import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSla, deadlineState, slaFlagsOf } from '../../src/modules/deals/sla.js';

// SLA maths in UTC. Times are written with a Z so the machine's time zone can't change them.
const at = (iso) => new Date(iso);

test('stage SLA: entered + sla_hours while open, none without a target or once closed', () => {
  const base = { stageEnteredAt: at('2026-11-05T09:30:00Z'), createdAt: at('2026-11-05T09:00:00Z'), now: at('2026-11-05T10:00:00Z') };
  assert.equal(computeSla({ ...base, status: 'open', slaHours: 4 }).slaDueAt.toISOString(), '2026-11-05T13:30:00.000Z');
  assert.equal(computeSla({ ...base, status: 'open', slaHours: null }).slaDueAt, null);
  assert.equal(computeSla({ ...base, status: 'won', slaHours: 4 }).slaDueAt, null);
  assert.equal(computeSla({ ...base, status: 'lost', slaHours: 4 }).slaState, 'none');
});

test('stage SLA crosses midnight and month ends in UTC', () => {
  const sla = computeSla({ status: 'open', stageEnteredAt: at('2026-11-30T22:00:00Z'), slaHours: 48, createdAt: at('2026-11-30T22:00:00Z') });
  assert.equal(sla.slaDueAt.toISOString(), '2026-12-02T22:00:00.000Z');
});

test('ok, due soon (last quarter of the window) and breached', () => {
  const entered = at('2026-11-05T00:00:00Z'); // 4 h window → due soon from 03:00
  const state = (now) => computeSla({ status: 'open', stageEnteredAt: entered, slaHours: 4, createdAt: entered, now: at(now) });
  assert.equal(state('2026-11-05T02:59:00Z').slaState, 'ok');
  assert.equal(state('2026-11-05T03:00:00Z').slaState, 'due_soon');
  assert.equal(state('2026-11-05T03:00:00Z').slaDueSoon, true);
  assert.equal(state('2026-11-05T04:00:00Z').slaState, 'breached');
  assert.equal(state('2026-11-05T09:00:00Z').slaBreached, true);
});

test('first reply: created + the setting, only for channels with a first-reply target', () => {
  const created = at('2026-11-05T09:00:00Z');
  const base = { status: 'open', stageEnteredAt: created, slaHours: 4, createdAt: created, firstReplySlaMinutes: 30 };
  const due = computeSla({ ...base, channelHasFirstReplySla: true, now: created });
  assert.equal(due.firstReplyDueAt.toISOString(), '2026-11-05T09:30:00.000Z');
  assert.equal(due.firstReplyState, 'ok');
  assert.equal(computeSla({ ...base, channelHasFirstReplySla: false, now: created }).firstReplyDueAt, null);
});

test('first reply: due soon, overdue, met and missed', () => {
  const created = at('2026-11-05T09:00:00Z');
  const base = { status: 'open', stageEnteredAt: created, createdAt: created, firstReplyDueAt: at('2026-11-05T09:30:00Z') };
  assert.equal(computeSla({ ...base, now: at('2026-11-05T09:24:00Z') }).firstReplyDueSoon, true);
  assert.equal(computeSla({ ...base, now: at('2026-11-05T09:31:00Z') }).firstReplyOverdue, true);
  assert.equal(computeSla({ ...base, firstRepliedAt: at('2026-11-05T09:10:00Z'), now: at('2026-11-05T12:00:00Z') }).firstReplyState, 'met');
  assert.equal(computeSla({ ...base, firstRepliedAt: at('2026-11-05T10:10:00Z'), now: at('2026-11-05T12:00:00Z') }).firstReplyState, 'missed');
});

test('a closed deal no longer waits for its first reply', () => {
  const created = at('2026-11-05T09:00:00Z');
  const lost = computeSla({ status: 'lost', stageEnteredAt: created, createdAt: created, firstReplyDueAt: at('2026-11-05T09:30:00Z'), now: at('2026-11-06T00:00:00Z') });
  assert.equal(lost.firstReplyState, 'none');
  assert.equal(lost.firstReplyOverdue, false);
});

test('stored due times win over today\'s settings', () => {
  const created = at('2026-11-05T09:00:00Z');
  const sla = computeSla({
    status: 'open',
    stageEnteredAt: created,
    slaDueAt: at('2026-11-05T11:00:00Z'),
    slaHours: 100,
    createdAt: created,
    firstReplyDueAt: null,
    firstReplySlaMinutes: 30,
    channelHasFirstReplySla: true,
    now: created,
  });
  assert.equal(sla.slaDueAt.toISOString(), '2026-11-05T11:00:00.000Z');
  assert.equal(sla.firstReplyDueAt, null);
});

test('slaFlagsOf reads a deals row', () => {
  const flags = slaFlagsOf(
    {
      status: 'open',
      stage_entered_at: '2026-11-05T00:00:00.000Z',
      sla_due_at: '2026-11-05T04:00:00.000Z',
      created_at: '2026-11-05T00:00:00.000Z',
      first_reply_due_at: '2026-11-05T00:30:00.000Z',
      first_replied_at: null,
    },
    at('2026-11-05T03:30:00Z'),
  );
  assert.deepEqual(flags, {
    slaState: 'due_soon',
    slaBreached: false,
    slaDueSoon: true,
    firstReplyState: 'breached',
    firstReplyOverdue: true,
    firstReplyDueSoon: false,
  });
});

test('deadlineState without a start time is never "due soon"', () => {
  assert.equal(deadlineState({ dueAt: at('2026-11-05T10:00:00Z'), now: at('2026-11-05T09:59:00Z') }), 'ok');
  assert.equal(deadlineState({ dueAt: null }), 'none');
});
