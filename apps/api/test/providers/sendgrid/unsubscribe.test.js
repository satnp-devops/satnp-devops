import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListUnsubscribeHeaders,
  isOneClickUnsubscribePost,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../../../src/integrations/providers/sendgrid/index.js';

const SECRET = 'test-only-unsubscribe-secret-0123456789abcdef';

test('builds RFC 8058 headers with mailto first and the https URI', () => {
  assert.deepEqual(buildListUnsubscribeHeaders({ url: 'https://crm.phoenix.example/u/opaque123', mailto: 'unsub@phoenix.example?subject=unsubscribe' }), {
    'List-Unsubscribe': '<mailto:unsub@phoenix.example?subject=unsubscribe>, <https://crm.phoenix.example/u/opaque123>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  assert.deepEqual(buildListUnsubscribeHeaders({ url: 'https://crm.phoenix.example/u/x' })['List-Unsubscribe'], '<https://crm.phoenix.example/u/x>');
});

test('rejects non-https URLs and malformed mailto', () => {
  assert.throws(() => buildListUnsubscribeHeaders({ url: 'http://crm.phoenix.example/u/x' }), /https/);
  assert.throws(() => buildListUnsubscribeHeaders({ url: 'not a url' }), /absolute/);
  assert.throws(() => buildListUnsubscribeHeaders({ url: 'https://crm.phoenix.example/u/x', mailto: 'nobody' }), /mailto/);
});

test('recognises the one-click POST in both encodings from RFC 8058 section 8', () => {
  assert.equal(isOneClickUnsubscribePost('List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded'), true);
  const multipart = [
    '-----FormBoundaryjWmhtjORrn',
    'Content-Disposition: form-data; name="List-Unsubscribe"',
    '',
    'One-Click',
    '-----FormBoundaryjWmhtjORrn--',
    '',
  ].join('\r\n');
  assert.equal(isOneClickUnsubscribePost(Buffer.from(multipart), 'multipart/form-data; boundary=---FormBoundaryjWmhtjORrn'), true);
});

test('anything else is not a one-click request', () => {
  assert.equal(isOneClickUnsubscribePost('', 'application/x-www-form-urlencoded'), false);
  assert.equal(isOneClickUnsubscribePost('List-Unsubscribe=Yes', 'application/x-www-form-urlencoded'), false);
  assert.equal(isOneClickUnsubscribePost('{"List-Unsubscribe":"One-Click"}', 'application/json'), false);
  assert.equal(isOneClickUnsubscribePost('garbage', 'multipart/form-data; boundary=zzz'), false);
});

test('unsubscribe tokens round-trip and reject tampering or the wrong secret', () => {
  const token = createUnsubscribeToken({ c: 'contact_42', t: 'admissions-newsletter' }, SECRET);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyUnsubscribeToken(token, SECRET), { c: 'contact_42', t: 'admissions-newsletter' });
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ c: 'contact_43', t: 'admissions-newsletter' })).toString('base64url');
  assert.equal(verifyUnsubscribeToken(`${forged}.${mac}`, SECRET), null);
  assert.equal(verifyUnsubscribeToken(`${body}.${mac.slice(0, -1)}A`, SECRET), null);
  assert.equal(verifyUnsubscribeToken(`${body}.${mac}.extra`, SECRET), null);
  assert.equal(verifyUnsubscribeToken(token, `${SECRET}-other`), null);
  assert.equal(verifyUnsubscribeToken('', SECRET), null);
  assert.throws(() => createUnsubscribeToken({ c: '1' }, 'short'), /32 characters/);
});
