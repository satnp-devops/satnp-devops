import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/core/registry.js';
import { modules } from '../../src/modules/index.js';
import enrollments from '../../src/modules/delivery/module.js';
import onboarding from '../../src/modules/delivery/onboardingModule.js';
import { paymentFrom } from '../../src/modules/delivery/handlers.js';
import { connectDeliveryPorts, usingDevPayments } from '../../src/modules/delivery/ports.js';
import { policyVersion } from '../../src/modules/delivery/settings.js';

test('the delivery modules register cleanly with the platform', () => {
  const registry = createRegistry(modules);
  for (const key of ['enrollments.view', 'enrollments.withdraw', 'onboarding.configure', 'onboarding.view_renewals']) assert.ok(registry.permissions.has(key), key);
  assert.ok(registry.settings.has('enrollments.refundSlaDays'));
  assert.equal(registry.settings.get('enrollments.refundSlaDays').default, 10);
  assert.ok(registry.eventHandlers.get('payment.succeeded')?.length);
  assert.ok(registry.eventHandlers.get('deal.won')?.length);
  assert.ok(modules.includes(enrollments) && modules.includes(onboarding));
});

test('payment events are read with the field names the money module may use', () => {
  const sessionId = '2b7d1d4e-9a77-4f9c-8f40-0c0a9b7d5e11';
  const p = paymentFrom({ id: 'evt-1', aggregateId: 'pay_9', occurredAt: '2026-11-05T10:00:00.000Z', payload: { amountMinor: 500, currency: 'INR', metadata: { checkoutSessionId: sessionId } } });
  assert.equal(p.paymentId, 'pay_9');
  assert.equal(p.checkoutSessionId, sessionId);
  assert.equal(p.paidAt, '2026-11-05T10:00:00.000Z');
  assert.equal(p.sourceEventId, 'event:evt-1');
  const q = paymentFrom({ payload: { id: 'pay_1', reference: 'not-a-uuid', dealId: 'x', amountMinor: 1.5, currency: 'rupees' } });
  assert.equal(q.checkoutSessionId, null);
  assert.equal(q.dealId, null);
  assert.equal(q.amountMinor, 0);
  assert.equal(q.currency, 'INR');
});

test('ports: development payments until connected, unknown ports rejected', () => {
  assert.equal(usingDevPayments(), true);
  assert.throws(() => connectDeliveryPorts({ sendWhatsApp: () => {} }), /Unknown delivery port/);
  assert.throws(() => connectDeliveryPorts({ createPaymentLink: 'nope' }), TypeError);
});

test('the policy version changes with the text', () => {
  assert.equal(policyVersion('a'), policyVersion('a'));
  assert.notEqual(policyVersion('a'), policyVersion('b'));
  assert.equal(policyVersion('a').length, 12);
});
