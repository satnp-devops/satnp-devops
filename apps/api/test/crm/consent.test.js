import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentAllows, consentMatrix, effectiveConsent } from '../../src/core/crm/consent.js';
import { dealColumnSchema, dealFiltersSchema, dealListQuerySchema } from '../../src/core/crm/schemas.js';
import { db } from '../../src/lib/db.js';

const record = (id, overrides) => ({ id, company_id: 'sp', channel: 'whatsapp', purpose: 'marketing', status: 'granted', captured_at: '2026-10-01T10:00:00Z', created_at: '2026-10-01T10:00:00Z', ...overrides });

test('the latest applicable record wins, including group-wide and "all" records', () => {
  const records = [
    record('a'),
    record('b', { company_id: null, channel: 'all', status: 'withdrawn', captured_at: '2026-10-05T10:00:00Z' }),
    record('c', { company_id: 'pv', status: 'granted', captured_at: '2026-10-09T10:00:00Z' }),
  ];
  assert.deepEqual(effectiveConsent(records, { companyId: 'sp', channel: 'whatsapp', purpose: 'marketing' }), { status: 'withdrawn', record: records[1] });
  assert.equal(effectiveConsent(records, { companyId: 'pv', channel: 'whatsapp', purpose: 'marketing' }).status, 'granted');
  assert.equal(effectiveConsent(records, { companyId: 'sp', channel: 'email', purpose: 'marketing' }).status, 'withdrawn');
  assert.equal(effectiveConsent(records, { companyId: 'sp', channel: 'whatsapp', purpose: 'service' }).status, 'unknown');
  const later = [...records, record('d', { captured_at: '2026-10-06T10:00:00Z' })];
  assert.equal(effectiveConsent(later, { companyId: 'sp', channel: 'whatsapp', purpose: 'marketing' }).record.id, 'd');
});

test('marketing needs consent; service and transactional messages only stop on withdrawal', () => {
  assert.equal(consentAllows('unknown', 'marketing'), false);
  assert.equal(consentAllows('granted', 'marketing'), true);
  assert.equal(consentAllows('unknown', 'transactional'), true);
  assert.equal(consentAllows('withdrawn', 'service'), false);
});

test('consentMatrix covers every specific channel and purpose', () => {
  const matrix = consentMatrix([record('a')], 'sp');
  assert.equal(matrix.length, 4 * 3);
  assert.equal(matrix.find((m) => m.channel === 'whatsapp' && m.purpose === 'marketing').status, 'granted');
  assert.ok(!matrix.some((m) => m.channel === 'all'));
});

test('deal filters: saved views store arrays, the list query takes comma lists', () => {
  assert.equal(dealFiltersSchema.safeParse({ status: ['open'], owner: ['me', 'none'], slaBreached: true }).success, true);
  assert.equal(dealFiltersSchema.safeParse({ unknown: 1 }).success, false);
  const query = dealListQuerySchema.parse({ unitId: '7b0e5a7e-1111-4111-8111-111111111111', channel: 'whatsapp,email', archived: 'false' });
  assert.deepEqual(query.channel, ['whatsapp', 'email']);
  assert.equal(query.sort, '-updatedAt');
  assert.equal(query.limit, 50);
  assert.equal(dealListQuerySchema.safeParse({ unitId: '7b0e5a7e-1111-4111-8111-111111111111', sort: 'title' }).success, false);
  assert.equal(dealColumnSchema.safeParse('custom.grade').success, true);
  assert.equal(dealColumnSchema.safeParse('customXgrade').success, false);
});

test.after(() => db.destroy());
