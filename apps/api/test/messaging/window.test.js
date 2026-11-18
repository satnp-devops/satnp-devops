import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerServiceWindow, latestTime } from '../../src/core/messaging/window.js';
import { decideSend } from '../../src/core/messaging/rules.js';

// WhatsApp's 24-hour customer-service window (docs/platform/MESSAGING.md).

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

test('no inbound message: the window is closed', () => {
  assert.deepEqual(customerServiceWindow(null, { now: NOW }), { open: false, lastInboundAt: null, expiresAt: null, remainingSeconds: 0 });
  assert.equal(customerServiceWindow(undefined, { now: NOW }).open, false);
});

test('open for 24 hours after the last inbound message, with the time left', () => {
  const window = customerServiceWindow(hoursAgo(11), { now: NOW });
  assert.equal(window.open, true);
  assert.equal(window.expiresAt, '2026-11-07T01:00:00.000Z');
  assert.equal(window.remainingSeconds, 13 * 3600);
  assert.equal(window.lastInboundAt, hoursAgo(11));
});

test('closes exactly at 24 hours', () => {
  const justInside = customerServiceWindow(new Date(NOW - 24 * 3_600_000 + 1000), { now: NOW });
  assert.equal(justInside.open, true);
  assert.equal(justInside.remainingSeconds, 1);
  const atTheEdge = customerServiceWindow(hoursAgo(24), { now: NOW });
  assert.equal(atTheEdge.open, false);
  assert.equal(atTheEdge.remainingSeconds, 0);
  assert.equal(customerServiceWindow(hoursAgo(30), { now: NOW }).open, false);
});

test('accepts Date, string and number inputs; a future stamp (clock skew) counts as now', () => {
  const fromDate = customerServiceWindow(new Date(NOW - 3_600_000), { now: new Date(NOW) });
  const fromNumber = customerServiceWindow(NOW - 3_600_000, { now: NOW });
  assert.deepEqual(fromDate, fromNumber);
  const skewed = customerServiceWindow(new Date(NOW + 120_000), { now: NOW });
  assert.equal(skewed.open, true);
  assert.equal(skewed.remainingSeconds, 24 * 3600);
  assert.throws(() => customerServiceWindow('not a date', { now: NOW }), TypeError);
});

test('the window decides whether WhatsApp free text may go out; templates go out either way', () => {
  const base = { channel: 'whatsapp', purpose: 'service', consentStatus: 'unknown', optedOut: false };
  const open = customerServiceWindow(hoursAgo(2), { now: NOW });
  const closed = customerServiceWindow(hoursAgo(25), { now: NOW });
  assert.equal(decideSend({ ...base, content: 'text', window: open }).allowed, true);
  assert.deepEqual(decideSend({ ...base, content: 'text', window: closed }), {
    allowed: false,
    reason: 'outside_window',
    message: 'Outside the 24-hour window: send an approved template',
  });
  assert.equal(decideSend({ ...base, content: 'text', window: null }).reason, 'outside_window');
  assert.equal(decideSend({ ...base, purpose: 'transactional', content: 'template', templateApproved: true, window: closed }).allowed, true);
  // Email has no window.
  assert.equal(decideSend({ ...base, channel: 'email', content: 'text', window: null }).allowed, true);
});

test('latestTime picks the newest stamp and skips blanks', () => {
  assert.equal(latestTime([null, hoursAgo(5), hoursAgo(1), undefined, hoursAgo(3)]), hoursAgo(1));
  assert.equal(latestTime([]), null);
});
