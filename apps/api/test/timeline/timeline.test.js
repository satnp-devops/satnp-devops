import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFlags, entryPermissionPaths, pickSubject } from '../../src/modules/timeline/access.js';
import { parseArchiveArgs } from '../../src/modules/timeline/archive.js';
import { maskTimelineMeta, presentEntry } from '../../src/modules/timeline/present.js';

// Pure parts of the timeline module: subjects, permission flags, masking and the archive CLI.

const access = (grants) => ({ can: (permission, path) => (grants[path] ?? []).includes(permission) });
const me = 'u-me';
const unitsById = new Map([
  ['team', { id: 'team', path: '/g/c/team/' }],
  ['other', { id: 'other', path: '/g/c/other/' }],
]);

test('exactly one subject', () => {
  assert.deepEqual(pickSubject({ dealId: 'd1' }, 'query'), { key: 'dealId', column: 'deal_id', type: 'deal', id: 'd1' });
  assert.equal(pickSubject({ accountId: 'a1' }, 'body').type, 'account');
  assert.throws(() => pickSubject({}, 'query'), (err) => err.status === 422 && err.details[0].path === 'query.dealId');
  assert.throws(() => pickSubject({ dealId: 'd', contactId: 'c' }, 'body'), (err) => err.status === 422);
});

test('authors edit and delete their notes; moderators delete; system entries stay', () => {
  const writer = access({ '/g/c/team/': ['timeline.write'] });
  const moderator = access({ '/g/c/team/': ['timeline.write', 'timeline.moderate'] });
  const paths = ['/g/c/team/'];
  const myNote = { kind: 'note', actor_user_id: me, actor_type: 'user', direction: 'internal' };
  const theirNote = { ...myNote, actor_user_id: 'someone' };
  assert.deepEqual(entryFlags(writer, myNote, paths, me), { canEdit: true, canDelete: true, canPin: true });
  assert.deepEqual(entryFlags(writer, theirNote, paths, me), { canEdit: false, canDelete: false, canPin: true });
  assert.deepEqual(entryFlags(moderator, theirNote, paths, me), { canEdit: false, canDelete: true, canPin: true });
  for (const kind of ['system', 'stage_change', 'task', 'ai']) {
    assert.equal(entryFlags(moderator, { ...theirNote, kind }, paths, me).canDelete, false, kind);
  }
  const inbound = { kind: 'message', direction: 'inbound', actor_type: 'contact', actor_user_id: null };
  assert.equal(entryFlags(moderator, inbound, paths, me).canDelete, false);
  const receivedEmail = { kind: 'email', direction: 'inbound', actor_type: 'contact', actor_user_id: null };
  assert.equal(entryFlags(moderator, receivedEmail, paths, me).canDelete, false, 'channel records stay');
  assert.equal(entryFlags(moderator, { ...myNote, archived: true }, paths, me).canPin, false, 'archived entries are read-only');
  assert.equal(entryFlags(access({}), myNote, paths, me).canPin, false);
});

test("permission paths: the entry's unit, else the subject's", () => {
  const context = { deal: null, visibleLinks: [{ unit_id: 'team' }, { unit_id: 'other' }] };
  assert.deepEqual(entryPermissionPaths({ unit_id: 'team' }, context, unitsById), ['/g/c/team/']);
  assert.deepEqual(entryPermissionPaths({ unit_id: null }, context, unitsById), ['/g/c/team/', '/g/c/other/']);
  assert.deepEqual(entryPermissionPaths({ unit_id: null }, { deal: { unit_id: 'other' }, visibleLinks: [] }, unitsById), ['/g/c/other/']);
});

test('meta phones and emails are masked, other keys are not', () => {
  const masked = maskTimelineMeta({ from: '+919812345678', to: 'ravi.k@school.example', email: 'a@b.co', durationSeconds: 60, providerMessageId: 'wamid.1' });
  assert.equal(masked.from, '+91 •••••••678');
  assert.equal(masked.to, 'r•••@school.example');
  assert.equal(masked.email, 'a•••@b.co');
  assert.equal(masked.durationSeconds, 60);
  assert.equal(masked.providerMessageId, 'wamid.1');
  assert.deepEqual(maskTimelineMeta({ from: { name: 'Priya', phone: '+919812345678' } }).from, { name: 'Priya', phone: '+91 •••••••678' });
  assert.deepEqual(maskTimelineMeta(null), {});
});

test('presentEntry: string ids, ISO times, deal ref and flags', () => {
  const row = {
    id: 42n,
    kind: 'note',
    channel: null,
    direction: 'internal',
    title: null,
    body: 'Hello',
    meta: { phone: '+919812345678' },
    actor_type: 'user',
    actor_user_id: me,
    company_id: 'c',
    unit_id: 'team',
    deal_id: 'd',
    contact_id: null,
    account_id: null,
    occurred_at: new Date('2026-11-06T10:00:00Z'),
    created_at: new Date('2026-11-06T10:00:01Z'),
    edited_at: null,
    pinned_at: null,
  };
  const entry = presentEntry(row, {
    actor: { id: me, name: 'Ritika Rao', email: 'x' },
    deal: { id: 'd', ref: 'SP-1', title: 'T', status: 'open', unit_id: 'team' },
    canViewPii: false,
    canEdit: true,
    canDelete: true,
    canPin: false,
  });
  assert.equal(entry.id, '42');
  assert.equal(entry.occurredAt, '2026-11-06T10:00:00.000Z');
  assert.deepEqual(entry.actor, { id: me, name: 'Ritika Rao' });
  assert.deepEqual(entry.deal, { id: 'd', ref: 'SP-1', title: 'T', status: 'open' });
  assert.equal(entry.meta.phone, '+91 •••••••678');
  assert.equal(entry.archived, false);
  assert.equal(entry.canPin, false);
});

test('archive CLI arguments', () => {
  const options = parseArchiveArgs(['--before', '2025-01-01']);
  assert.equal(options.before.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(options.batchSize, 5000);
  assert.equal(options.dryRun, false);
  assert.equal(parseArchiveArgs(['--before=2025-01-01', '--batch=200', '--dry-run']).batchSize, 200);
  assert.throws(() => parseArchiveArgs([]), /--before/);
  assert.throws(() => parseArchiveArgs(['--before', 'soon']), /not a date/);
  assert.throws(() => parseArchiveArgs(['--before', '2999-01-01']), /past/);
  assert.throws(() => parseArchiveArgs(['--before', '2025-01-01', '--batch', '0']), /batch/);
  assert.throws(() => parseArchiveArgs(['--before', '2025-01-01', '--wat']), /Unknown option/);
});
