import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl } from '../../src/middleware/requestContext.js';

// The request log keeps URLs without personal data or secrets (DPDP Act): search text, phones,
// emails, tokens and codes in the query, and long tokens anywhere, become [redacted].

test('search text, phones, emails and secrets in the query never reach the log', () => {
  const url = '/api/v1/search?q=Priya%20Sharma&unitId=a9e55102-9183-475b-b1dc-371a6f1f937b&limit=6';
  // Ids are long tokens too (as before): the log never needed them to find a request (requestId does).
  assert.equal(redactUrl(url), '/api/v1/search?q=[redacted]&unitId=[redacted]&limit=6');
  assert.equal(redactUrl('/api/v1/contacts?phone=%2B919876543210&email=a%40b.in'), '/api/v1/contacts?phone=[redacted]&email=[redacted]');
  assert.equal(redactUrl('/api/v1/webhooks/wa/x?hub.mode=subscribe&hub.verify_token=s3cr3t&hub.challenge=42'), '/api/v1/webhooks/wa/x?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=42');
  // Parameter names are decoded before they are compared, so encoding can't sneak one past.
  assert.equal(redactUrl('/api/v1/deals?%71=Priya'), '/api/v1/deals?%71=[redacted]');
});

test('long tokens are redacted in the path and the query; ordinary URLs are kept', () => {
  const token = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gH3jK5';
  assert.equal(redactUrl(`/api/v1/public/bookings/${token}/slots`), '/api/v1/public/bookings/[redacted]/slots');
  assert.equal(redactUrl(`/api/v1/x?ref=${token}`), '/api/v1/x?ref=[redacted]');
  assert.equal(redactUrl('/api/v1/deals?status=open&limit=50'), '/api/v1/deals?status=open&limit=50');
  assert.equal(redactUrl('/api/v1/health'), '/api/v1/health');
  assert.equal(redactUrl(undefined), '');
});
