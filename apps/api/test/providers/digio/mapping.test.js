import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDigioTime, parseSigningRedirect } from '../../../src/integrations/providers/digio/index.js';
import { ageOn, mapSignerStatus, normalizeIdentifier } from '../../../src/integrations/providers/digio/mapping.js';
import { retryAfterMs } from '../../../src/integrations/providers/digio/http.js';

test('Digio times become UTC ISO strings (REST = IST wall clock, webhooks = epoch ms)', () => {
  assert.equal(parseDigioTime('2026-11-05 15:30:12'), '2026-11-05T10:00:12.000Z');
  assert.equal(parseDigioTime('2026-01-01 00:10:00'), '2025-12-31T18:40:00.000Z');
  assert.equal(parseDigioTime(1612332250000), '2021-02-03T06:04:10.000Z');
  assert.equal(parseDigioTime(1612332250), '2021-02-03T06:04:10.000Z');
  assert.equal(parseDigioTime('1612332250000'), '2021-02-03T06:04:10.000Z');
  assert.equal(parseDigioTime('2026-11-05T15:30:12+05:30'), '2026-11-05T10:00:12.000Z');
  assert.equal(parseDigioTime(null), null);
  assert.equal(parseDigioTime(''), null);
  assert.equal(parseDigioTime('soon'), null);
});

test('identifiers: emails as-is, Indian mobiles as 10 digits', () => {
  assert.deepEqual(normalizeIdentifier(' parent@example.in '), { identifier: 'parent@example.in', kind: 'email' });
  for (const raw of ['9876543210', '+91 98765 43210', '919876543210', '09876543210', '(987) 654-3210']) {
    assert.deepEqual(normalizeIdentifier(raw), { identifier: '9876543210', kind: 'mobile' }, raw);
  }
  for (const raw of ['5876543210', '12345', 'a@b', 'a/b@c.in', '', '+1 415 555 0100']) {
    assert.equal(normalizeIdentifier(raw), null, raw);
  }
});

test('age is counted on the IST calendar', () => {
  assert.equal(ageOn('2008-11-06', Date.parse('2026-11-05T18:29:59Z')), 17);
  assert.equal(ageOn('2008-11-06', Date.parse('2026-11-05T18:30:00Z')), 18);
  assert.equal(ageOn('2008-02-29', Date.parse('2026-02-28T12:00:00Z')), 17);
  assert.equal(ageOn('2008-02-29', Date.parse('2026-03-01T12:00:00Z')), 18);
});

test('signer statuses map to platform values', () => {
  assert.equal(mapSignerStatus('requested'), 'pending');
  assert.equal(mapSignerStatus('sequenced'), 'waiting');
  assert.equal(mapSignerStatus('SIGNED'), 'signed');
  assert.equal(mapSignerStatus('new_value'), 'unknown');
});

test('the redirect back from Digio is parsed but marked untrusted', () => {
  assert.deepEqual(
    parseSigningRedirect('https://my_redirection.com?status=success&digio_doc_id=DID170829163815543Q3LG28D8BCZ2PK&message=Signing%20Success'),
    { trusted: false, status: 'success', documentId: 'DID170829163815543Q3LG28D8BCZ2PK', message: 'Signing Success' },
  );
});

test('Retry-After accepts seconds or an HTTP date', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('Thu, 05 Nov 2026 10:00:05 GMT', Date.parse('2026-11-05T10:00:00Z')), 5000);
  assert.equal(retryAfterMs('later'), null);
  assert.equal(retryAfterMs(null), null);
});
