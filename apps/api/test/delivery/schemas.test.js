import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutSessionSchema, createBatchSchema, createTemplateSchema, updateBatchSchema, withdrawSchema } from '../../src/modules/delivery/schemas.js';

const id = '7548ee4e-8712-4fef-a7f0-a475a7322fc9';
const batch = { unitId: id, productId: id, name: 'SAT Weekend, Jan 2027', startsOn: '2027-01-09', endsOn: '2027-03-28', capacity: 25 };
const paths = (result) => result.error.issues.map((i) => i.path.join('.'));

test('batches get defaults on create and none on update', () => {
  const created = createBatchSchema.parse(batch);
  assert.equal(created.mode, 'online');
  assert.equal(created.waitlistEnabled, true);
  assert.equal(created.status, 'open');
  assert.deepEqual(updateBatchSchema.parse({ capacity: 30 }), { capacity: 30 });
  assert.equal(updateBatchSchema.safeParse({}).success, false);
});

test('batch rules: dates in order, a fee to sell online, classes to refund by class, no unknown keys', () => {
  assert.deepEqual(paths(createBatchSchema.safeParse({ ...batch, endsOn: '2027-01-01' })), ['endsOn']);
  assert.deepEqual(paths(createBatchSchema.safeParse({ ...batch, checkoutEnabled: true })), ['fee']);
  assert.deepEqual(paths(createBatchSchema.safeParse({ ...batch, refundUnit: 'classes' })), ['totalClasses']);
  assert.equal(createBatchSchema.safeParse({ ...batch, capacity: 0 }).success, false);
  assert.equal(createBatchSchema.safeParse({ ...batch, fee: { valueMinor: 12.5, currency: 'INR' } }).success, false);
  assert.equal(createBatchSchema.safeParse({ ...batch, extra: 1 }).success, false);
  assert.equal(createBatchSchema.safeParse({ ...batch, schedule: { startTime: '19:00', endTime: '18:00' } }).success, false);
  assert.equal(createBatchSchema.parse({ ...batch, code: '' }).code, null);
});

test('checkout needs the policy accepted and real contact details', () => {
  const body = {
    batchId: id,
    parent: { firstName: 'Neha', lastName: 'Sharma', phone: '98200 12345', email: 'NEHA@example.com' },
    student: { firstName: 'Aarav', email: '' },
    consent: { acceptPolicy: true, policyVersion: 'abcdef123456' },
  };
  const parsed = checkoutSessionSchema.parse(body);
  assert.equal(parsed.parent.email, 'neha@example.com');
  assert.equal(parsed.student.email, undefined);
  assert.equal(parsed.consent.marketing, false);
  assert.deepEqual(paths(checkoutSessionSchema.safeParse({ ...body, consent: { ...body.consent, acceptPolicy: false } })), ['consent.acceptPolicy']);
  assert.deepEqual(paths(checkoutSessionSchema.safeParse({ ...body, parent: { ...body.parent, email: 'nope' } })), ['parent.email']);
});

test('a withdrawal names its channel; the reason is optional', () => {
  assert.equal(withdrawSchema.safeParse({ channel: 'whatsapp' }).success, true);
  assert.equal(withdrawSchema.safeParse({}).success, false);
  assert.equal(withdrawSchema.safeParse({ channel: 'whatsapp', receivedAt: '2026-11-05' }).success, false);
});

test('implementation templates need distinct phase keys; checklists have none', () => {
  const phases = [
    { key: 'kickoff', name: 'Kickoff' },
    { key: 'kickoff', name: 'Again' },
  ];
  assert.equal(createTemplateSchema.safeParse({ companyId: id, kind: 'b2b', name: 'X', phases }).success, false);
  assert.equal(createTemplateSchema.safeParse({ companyId: id, kind: 'b2c', name: 'X', phases: [{ key: 'kickoff', name: 'K' }] }).success, false);
  assert.equal(createTemplateSchema.parse({ companyId: id, kind: 'b2c', name: 'X' }).items.length, 0);
});
