import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_CHANNELS, assertChannelDefinition, channelHasFirstReplySla, listChannels } from '../../src/core/crm/channels.js';
import { requiredFieldOptions, unknownRequiredFields } from '../../src/core/crm/dealFields.js';
import { accountDocument, contactDocument, dealDocument, searchKeywords } from '../../src/core/crm/search.js';
import { isFirstReplyCandidate, presentTimelineEntry, timelineRow } from '../../src/core/crm/timeline.js';
import { createRegistry } from '../../src/core/registry.js';
import { modules } from '../../src/modules/index.js';
import { db } from '../../src/lib/db.js';

test('timelineRow checks subjects, kinds and actors', () => {
  assert.throws(() => timelineRow({ groupId: 'g', kind: 'note' }), /deal, a contact or an account/);
  assert.throws(() => timelineRow({ groupId: 'g', contactId: 'c', kind: 'Bad Kind' }), /Unknown timeline kind/);
  assert.throws(() => timelineRow({ groupId: 'g', dealId: 'd', kind: 'note' }), /belong to its company/);
  assert.throws(() => timelineRow({ groupId: 'g', contactId: 'c', kind: 'note', actorType: 'robot' }), /actor type/);
  assert.throws(() => timelineRow({ groupId: 'g', contactId: 'c', kind: 'note', direction: 'sideways' }), /direction/);

  const row = timelineRow({ groupId: 'g', companyId: 'co', dealId: 'd', kind: 'note', body: 'Called back', actorUserId: 'u', meta: { a: 1 } });
  assert.equal(row.actor_type, 'user');
  assert.equal(row.company_id, 'co');
  assert.equal(row.meta, '{"a":1}');
  assert.ok(row.occurred_at instanceof Date);
  assert.equal(timelineRow({ groupId: 'g', contactId: 'c', kind: 'system' }).actor_type, 'system');
});

test('only outbound replies by a person or the AI count as a first reply', () => {
  assert.equal(isFirstReplyCandidate({ direction: 'outbound', kind: 'message', actor_type: 'user' }), true);
  assert.equal(isFirstReplyCandidate({ direction: 'outbound', kind: 'call', actor_type: 'ai' }), true);
  assert.equal(isFirstReplyCandidate({ direction: 'inbound', kind: 'message', actor_type: 'contact' }), false);
  assert.equal(isFirstReplyCandidate({ direction: 'outbound', kind: 'note', actor_type: 'user' }), false);
  assert.equal(isFirstReplyCandidate({ direction: 'outbound', kind: 'message', actor_type: 'system' }), false);
});

test('presentTimelineEntry returns string ids and camelCase fields', () => {
  const entry = presentTimelineEntry({ id: 42n, kind: 'note', actor_type: 'user', occurred_at: 'x', created_at: 'y', meta: null });
  assert.equal(entry.id, '42');
  assert.deepEqual(entry.meta, {});
  assert.equal(entry.dealId, null);
});

test('searchKeywords expands phones and normalises the rest', () => {
  const keywords = searchKeywords({ phones: ['+919812345678'], emails: ['A@Example.com'], codes: ['SP-1042', null], words: ['Dr. Rao'] }).split(' ');
  assert.deepEqual(keywords, ['+919812345678', '919812345678', '9812345678', 'a@example.com', 'sp-1042', 'rao']);
});

test('search documents carry no personal details in titles and subtitles', () => {
  const contact = contactDocument(
    { id: 'c', group_id: 'g', kind: 'student', display_name: 'Aarav Shah', city: 'Pune', student_profile: { grade: '11' } },
    [{ kind: 'phone', normalized: '+919812345678' }],
  );
  assert.equal(contact.company_id, null, 'contacts are group-level documents');
  assert.equal(contact.subtitle, 'Student · Pune · Grade 11');
  assert.ok(!contact.title.includes('9812') && !contact.subtitle.includes('9812'));
  assert.ok(contact.keywords.includes('9812345678'));

  const account = accountDocument({ id: 'a', group_id: 'g', kind: 'coaching_institute', name: 'Apex Classes', city: 'Kota', domain: 'apex.example' });
  assert.equal(account.subtitle, 'Coaching institute · Kota');

  const deal = dealDocument(
    { id: 'd', group_id: 'g', company_id: 'co', unit_id: 'u', owner_user_id: 'o', title: 'SAT prep for Aarav', ref: 'SP-1', number: 1 },
    { stageName: 'Contacted', productLineName: 'SAT', contactName: 'Priya Shah', phones: ['+919812345678'] },
  );
  assert.equal(deal.subtitle, 'SP-1 · SAT · Contacted');
  assert.equal(deal.owner_user_id, 'o');
  assert.ok(deal.keywords.includes('priya'));
});

test('channels come from the module registry', () => {
  const registry = createRegistry(modules);
  const channels = listChannels(registry);
  // The deals module's ten built-in channels, plus any that other modules contribute (intake adds five).
  for (const builtIn of BUILT_IN_CHANNELS) assert.ok(channels.some((c) => c.key === builtIn.key), builtIn.key);
  assert.ok(channels.every((c) => typeof c.label === 'string' && typeof c.firstReplySla === 'boolean'));
  assert.equal(channelHasFirstReplySla(registry, 'whatsapp'), true);
  assert.equal(channelHasFirstReplySla(registry, 'csv_import'), false);
  assert.equal(channelHasFirstReplySla(registry, 'nope'), false);
  assert.throws(() => assertChannelDefinition({ key: 'Bad Key', label: 'x' }));
  assert.throws(() => assertChannelDefinition({ key: 'ok_key', label: 'x', group: 'mystery' }));
  assert.throws(() => createRegistry([...modules, { name: 'dupe', label: 'Dupe', channels: [{ key: 'whatsapp', label: 'Again' }] }]), /Duplicate channel/);
});

test('stage required fields accept built-in and custom deal fields', () => {
  const custom = [
    { entity: 'deal', key: 'budget_band', label: 'Budget', active: true },
    { entity: 'contact', key: 'school', label: 'School', active: true },
    { entity: 'deal', key: 'old', label: 'Old', active: false },
  ];
  const options = requiredFieldOptions(custom).map((o) => o.key);
  assert.ok(options.includes('productLineId'));
  assert.ok(options.includes('custom.budget_band'));
  assert.ok(!options.includes('custom.school'));
  assert.ok(!options.includes('custom.old'));
  assert.deepEqual(unknownRequiredFields(['students', 'custom.budget_band', 'custom.school', 'nope'], custom), ['custom.school', 'nope']);
});

test.after(() => db.destroy());
