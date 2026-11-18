import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveConsent } from '../../src/core/crm/consent.js';
import { decideSend, isOptOutText, parseKeywords, purposeFor } from '../../src/core/messaging/rules.js';
import { applyStatus } from '../../src/core/messaging/status.js';
import { takeFromBucket } from '../../src/core/messaging/throttle.js';
import { pickMethod } from '../../src/core/messaging/send.js';
import { pickConnection } from '../../src/core/messaging/connections.js';

// Consent and opt-out rules (DPDP), the SMS template rule, delivery statuses, the throttle bucket,
// and picking the number and connection a message goes out on.

const open = { open: true };
const decide = (overrides) => decideSend({ channel: 'whatsapp', purpose: 'transactional', consentStatus: 'unknown', optedOut: false, content: 'template', templateApproved: true, window: open, ...overrides });

test('templates send under their category; free text defaults to service and may be raised', () => {
  assert.equal(purposeFor({ category: 'marketing' }), 'marketing');
  assert.equal(purposeFor({ category: 'utility' }), 'transactional');
  assert.equal(purposeFor({ category: 'authentication' }), 'transactional');
  // A marketing template can't be downgraded by the caller.
  assert.equal(purposeFor({ category: 'marketing', purpose: 'transactional' }), 'marketing');
  assert.equal(purposeFor({ category: 'utility', purpose: 'marketing' }), 'marketing');
  assert.equal(purposeFor({}), 'service');
  assert.equal(purposeFor({ purpose: 'marketing' }), 'marketing');
  assert.throws(() => purposeFor({ category: 'promo' }), TypeError);
});

test('marketing needs a grant; transactional and service go out unless withdrawn', () => {
  assert.equal(decide({ purpose: 'marketing', consentStatus: 'granted' }).allowed, true);
  assert.deepEqual(decide({ purpose: 'marketing', consentStatus: 'unknown' }), {
    allowed: false,
    reason: 'marketing_consent_missing',
    message: 'Marketing messages on WhatsApp need their consent first',
  });
  assert.equal(decide({ purpose: 'marketing', consentStatus: 'withdrawn' }).reason, 'consent_withdrawn');
  assert.equal(decide({ purpose: 'transactional', consentStatus: 'unknown' }).allowed, true);
  assert.equal(decide({ purpose: 'transactional', consentStatus: 'withdrawn' }).reason, 'consent_withdrawn');
  assert.equal(decide({ purpose: 'service', consentStatus: 'withdrawn', content: 'text' }).reason, 'consent_withdrawn');
  assert.equal(decide({ purpose: 'service', consentStatus: 'granted', content: 'text' }).allowed, true);
});

test('an opted-out number blocks everything, before consent is even looked at', () => {
  assert.equal(decide({ optedOut: true, consentStatus: 'granted' }).reason, 'opted_out');
  assert.equal(decide({ channel: 'email', optedOut: true }).message, 'This address is opted out of all messages');
});

test('templates must be approved; SMS sends templates only', () => {
  assert.equal(decide({ templateApproved: false }).reason, 'template_not_approved');
  assert.equal(decide({ channel: 'sms', content: 'text', purpose: 'service' }).reason, 'template_required');
  assert.equal(decide({ channel: 'sms' }).allowed, true);
});

test('consent records feed the decision: a group-wide withdrawal on "all" channels blocks a company send', () => {
  const records = [
    { id: 'a', company_id: 'sp', channel: 'whatsapp', purpose: 'marketing', status: 'granted', captured_at: '2026-10-01T00:00:00Z' },
    { id: 'b', company_id: null, channel: 'all', purpose: 'marketing', status: 'withdrawn', captured_at: '2026-10-02T00:00:00Z' },
  ];
  const { status } = effectiveConsent(records, { companyId: 'sp', channel: 'whatsapp', purpose: 'marketing' });
  assert.equal(decide({ purpose: 'marketing', consentStatus: status }).reason, 'consent_withdrawn');
  const transactional = effectiveConsent(records, { companyId: 'sp', channel: 'whatsapp', purpose: 'transactional' }).status;
  assert.equal(decide({ purpose: 'transactional', consentStatus: transactional }).allowed, true);
});

test('opt-out keywords match the whole reply, ignoring case, punctuation and spacing', () => {
  const keywords = parseKeywords('STOP, UNSUBSCRIBE, stop all, बंद करें,');
  assert.deepEqual(keywords, ['STOP', 'UNSUBSCRIBE', 'stop all', 'बंद करें']);
  assert.equal(isOptOutText('stop', keywords), true);
  assert.equal(isOptOutText('  Stop! ', keywords), true);
  assert.equal(isOptOutText('STOP   ALL', keywords), true);
  assert.equal(isOptOutText('बंद करें', keywords), true);
  assert.equal(isOptOutText('Please stop calling me at work', keywords), false);
  assert.equal(isOptOutText('', keywords), false);
  assert.equal(isOptOutText(null, keywords), false);
});

test('delivery statuses only move forward, set each time once, and failure is final', () => {
  const at = new Date('2026-11-06T10:00:00Z');
  const later = new Date('2026-11-06T10:05:00Z');
  const sent = { direction: 'outbound', status: 'sent', sent_at: at };
  assert.deepEqual(applyStatus(sent, { status: 'delivered', at }), { changed: true, patch: { status: 'delivered', delivered_at: at } });
  // Read before delivered: both stamps.
  assert.deepEqual(applyStatus(sent, { status: 'read', at: later }), { changed: true, patch: { status: 'read', delivered_at: later, read_at: later } });
  // A repeat changes nothing.
  assert.deepEqual(applyStatus({ ...sent, status: 'delivered', delivered_at: at }, { status: 'delivered', at: later }), { changed: false, patch: {} });
  // A late "delivered" after "read" keeps read.
  assert.deepEqual(applyStatus({ ...sent, status: 'read', delivered_at: at, read_at: at }, { status: 'delivered', at: later }), { changed: false, patch: {} });
  // A queued message whose provider receipt beats our own update.
  assert.deepEqual(applyStatus({ direction: 'outbound', status: 'queued' }, { status: 'delivered', at }).patch, { status: 'delivered', sent_at: at, delivered_at: at });
  const failed = applyStatus(sent, { status: 'failed', at, errorCode: '131026' });
  assert.equal(failed.changed, true);
  assert.equal(failed.patch.status, 'failed');
  assert.equal(failed.patch.error_code, '131026');
  assert.deepEqual(applyStatus({ ...sent, status: 'delivered', delivered_at: at }, { status: 'failed', at }), { changed: false, patch: {} });
  assert.deepEqual(applyStatus({ direction: 'outbound', status: 'failed' }, { status: 'delivered', at }), { changed: false, patch: {} });
  // Inbound messages take no statuses.
  assert.deepEqual(applyStatus({ direction: 'inbound', status: 'received' }, { status: 'read', at }), { changed: false, patch: {} });
  assert.throws(() => applyStatus(sent, { status: 'bounced', at }), TypeError);
});

test('the token bucket allows a burst, then refills at the rate', () => {
  const limits = { ratePerSecond: 10, burst: 3 };
  let state = { tokens: null, updatedAtMs: null };
  const take = (now) => {
    const result = takeFromBucket(state, now, limits);
    state = { tokens: result.tokens, updatedAtMs: now };
    return result;
  };
  assert.equal(take(0).allowed, true);
  assert.equal(take(0).allowed, true);
  assert.equal(take(0).allowed, true);
  const refused = take(0);
  assert.equal(refused.allowed, false);
  assert.equal(refused.waitMs, 100);
  assert.equal(take(100).allowed, true);
  // Long idle time never overfills the bucket.
  assert.ok(take(60_000).tokens <= 2);
});

test('the number a message goes to: the one asked for, else the primary of the preferred kind', () => {
  const methods = [
    { id: 'p1', kind: 'phone', is_primary: true, created_at: '2026-01-01' },
    { id: 'w2', kind: 'whatsapp', is_primary: false, created_at: '2026-01-03' },
    { id: 'w1', kind: 'whatsapp', is_primary: true, created_at: '2026-01-02' },
    { id: 'e1', kind: 'email', is_primary: true, created_at: '2026-01-01' },
  ];
  assert.equal(pickMethod(methods, 'whatsapp').id, 'w1');
  assert.equal(pickMethod(methods, 'sms').id, 'p1');
  assert.equal(pickMethod(methods, 'email').id, 'e1');
  assert.equal(pickMethod(methods, 'whatsapp', 'w2').id, 'w2');
  assert.equal(pickMethod(methods, 'email', 'w2'), null);
  assert.equal(pickMethod([methods[0]], 'whatsapp').id, 'p1');
  assert.equal(pickMethod([], 'whatsapp'), null);
});

test('the connection: the thread\'s own while usable, else the default, else the mock outside production', () => {
  const candidates = [
    { id: 'own', kind: 'messaging.whatsapp', provider: 'mock', name: 'Own', status: 'active', is_default: true, created_at: '2026-01-01' },
    { id: 'shared', kind: 'messaging.whatsapp', provider: 'whatsapp_cloud', name: 'Shared', status: 'active', is_default: false, created_at: '2026-01-02' },
    { id: 'off', kind: 'messaging.whatsapp', provider: 'mock', name: 'Off', status: 'disabled', is_default: false, created_at: '2026-01-03' },
  ];
  assert.equal(pickConnection({ candidates, channel: 'whatsapp', allowMocks: true }).key, 'own');
  const shared = pickConnection({ candidates, channel: 'whatsapp', preferredConnectionId: 'shared', allowMocks: true });
  assert.deepEqual(shared.connection, { id: 'shared', name: 'Shared', provider: 'whatsapp_cloud', mock: false });
  assert.equal(pickConnection({ candidates, channel: 'whatsapp', preferredConnectionId: 'off', allowMocks: true }).key, 'own');
  assert.deepEqual(pickConnection({ candidates: [], channel: 'email', allowMocks: true }), { connection: null, fallback: true, key: 'fallback', error: null });
  const none = pickConnection({ candidates: [], channel: 'sms', allowMocks: false, companyName: 'Excel' });
  assert.equal(none.error.code, 'integration_not_connected');
  assert.equal(pickConnection({ candidates, channel: 'whatsapp', allowMocks: false }).key, 'shared');
});
