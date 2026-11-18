import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  AZURITE_ACCOUNT,
  buildServiceSasStringToSign,
  buildSharedKeyStringToSign,
  buildUserDelegationSasStringToSign,
  canonicalizeHeaders,
  canonicalizeResource,
  generateServiceSas,
  generateUserDelegationSas,
  normalisePermissions,
  signSharedKey,
} from '../../../src/integrations/providers/azblob/index.js';

// Independent HMAC (does not use the module) so vectors are checked against node:crypto directly.
const hmac = (text, base64Key) => createHmac('sha256', Buffer.from(base64Key, 'base64')).update(text, 'utf8').digest('base64');
const KEY = AZURITE_ACCOUNT.accountKey;

test('shared key: string-to-sign matches the Microsoft Learn Get Container Metadata example byte for byte', () => {
  const stringToSign = buildSharedKeyStringToSign({
    method: 'GET',
    url: 'https://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=metadata&timeout=20',
    headers: { 'x-ms-date': 'Fri, 26 Jun 2015 23:39:12 GMT', 'x-ms-version': '2015-02-21' },
    accountName: 'myaccount',
  });
  // Literal from "Authorize with Shared Key" (learn.microsoft.com, checked 2026-11-05).
  assert.equal(
    stringToSign,
    'GET\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:Fri, 26 Jun 2015 23:39:12 GMT\nx-ms-version:2015-02-21\n/myaccount/mycontainer\ncomp:metadata\nrestype:container\ntimeout:20',
  );
  // Vector computed with node:crypto using the public Azurite key.
  assert.equal(hmac(stringToSign, KEY), '1u9lui2jDxj0+fpbHjQ5m5NnastJRSYM+PSmfi8TXx4=');
});

test('shared key: zero Content-Length is an empty line (2015-02-21+), as in the Create Container example', () => {
  const stringToSign = buildSharedKeyStringToSign({
    method: 'PUT',
    url: 'http://myaccount/mycontainer?restype=container&timeout=30',
    headers: { 'Content-Length': '0', 'x-ms-version': '2015-02-21', 'x-ms-date': 'Fri, 26 Jun 2015 23:39:12 GMT' },
    accountName: 'myaccount',
  });
  assert.equal(stringToSign, 'PUT\n\n\n\n\n\n\n\n\n\n\n\nx-ms-date:Fri, 26 Jun 2015 23:39:12 GMT\nx-ms-version:2015-02-21\n/myaccount/mycontainer\nrestype:container\ntimeout:30');
});

test('shared key: canonicalized resource sorts parameters and joins repeated values (List Blobs example)', () => {
  const resource = canonicalizeResource(
    'myaccount',
    'http://myaccount.blob.core.windows.net/mycontainer?restype=container&comp=list&include=snapshots&include=metadata&include=uncommittedblobs',
  );
  assert.equal(resource, '/myaccount/mycontainer\ncomp:list\ninclude:metadata,snapshots,uncommittedblobs\nrestype:container');
});

test('shared key: query names are lowercased and values URL-decoded; the path stays encoded', () => {
  const resource = canonicalizeResource('acct', 'https://acct.blob.core.windows.net/c/a%20b/%C3%A7.txt?VersionId=2026-11-05T10%3A00%3A00.0000000Z');
  assert.equal(resource, '/acct/c/a%20b/%C3%A7.txt\nversionid:2026-11-05T10:00:00.0000000Z');
});

test('shared key: canonicalized headers are lowercased, sorted, trimmed and whitespace-collapsed outside quotes', () => {
  const headers = {
    'X-MS-Version': '2026-04-06',
    'x-ms-date': 'Thu, 05 Nov 2026 10:00:00 GMT',
    'x-ms-meta-Note': '  two   spaces\there  ',
    'x-ms-meta-quoted': 'keep "a   b" as is',
    'Content-Type': 'text/plain',
    'x-ms-meta-empty': '',
  };
  assert.equal(
    canonicalizeHeaders(headers),
    'x-ms-date:Thu, 05 Nov 2026 10:00:00 GMT\nx-ms-meta-empty:\nx-ms-meta-note:two spaces here\nx-ms-meta-quoted:keep "a   b" as is\nx-ms-version:2026-04-06\n',
  );
});

test('shared key: Put Blob against Azurite (account appears twice in the resource) signs to a fixed vector', () => {
  const request = {
    method: 'PUT',
    url: 'http://127.0.0.1:10000/devstoreaccount1/admissions/g/123/hello.txt',
    headers: {
      'Content-Length': '11',
      'Content-MD5': 'XrY7u+Ae7tCTyyK7j1rNww==',
      'Content-Type': 'text/plain; charset=UTF-8',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': 'text/plain; charset=UTF-8',
      'x-ms-client-request-id': '00000000-0000-4000-8000-000000000001',
      'x-ms-date': 'Thu, 05 Nov 2026 10:00:00 GMT',
      'x-ms-meta-studentid': 'G-123',
      'x-ms-version': '2026-04-06',
    },
    accountName: 'devstoreaccount1',
  };
  const expected =
    'PUT\n\n\n11\nXrY7u+Ae7tCTyyK7j1rNww==\ntext/plain; charset=UTF-8\n\n\n\n\n\n\n' +
    'x-ms-blob-content-type:text/plain; charset=UTF-8\nx-ms-blob-type:BlockBlob\nx-ms-client-request-id:00000000-0000-4000-8000-000000000001\n' +
    'x-ms-date:Thu, 05 Nov 2026 10:00:00 GMT\nx-ms-meta-studentid:G-123\nx-ms-version:2026-04-06\n' +
    '/devstoreaccount1/devstoreaccount1/admissions/g/123/hello.txt';
  assert.equal(buildSharedKeyStringToSign(request), expected);
  assert.equal(hmac(expected, KEY), 's+/wwjGKOwkZuRWf6eN0xNHQ7NeBkppqVX/bSRbOJZI=');
  assert.equal(signSharedKey({ ...request, accountKey: KEY }), 'SharedKey devstoreaccount1:s+/wwjGKOwkZuRWf6eN0xNHQ7NeBkppqVX/bSRbOJZI=');
});

test('service SAS: 2020-12-06+ string-to-sign has 16 lines in the documented order and a fixed signature', () => {
  const sas = generateServiceSas({
    accountName: 'devstoreaccount1',
    accountKey: KEY,
    container: 'admissions',
    blob: 'g/123/hello.txt',
    permissions: 'r',
    startsOn: Date.parse('2026-11-05T09:55:00Z'),
    expiresOn: Date.parse('2026-11-05T10:15:00Z'),
    version: '2026-04-06',
    contentDisposition: 'attachment; filename="hello.txt"',
  });
  const expected = ['r', '2026-11-05T09:55:00Z', '2026-11-05T10:15:00Z', '/blob/devstoreaccount1/admissions/g/123/hello.txt', '', '', '', '2026-04-06', 'b', '', '', '', 'attachment; filename="hello.txt"', '', '', ''].join('\n');
  assert.equal(sas.stringToSign, expected);
  assert.equal(sas.signature, 'Z57Bf4iYKnr+gHmb9mAQZIW1A4nrwyAqAZvCE0HWsG0=');
  assert.equal(sas.signature, hmac(expected, KEY));
  const q = new URLSearchParams(sas.token);
  assert.deepEqual(Object.fromEntries(q), {
    sv: '2026-04-06',
    st: '2026-11-05T09:55:00Z',
    se: '2026-11-05T10:15:00Z',
    sr: 'b',
    sp: 'r',
    rscd: 'attachment; filename="hello.txt"',
    sig: 'Z57Bf4iYKnr+gHmb9mAQZIW1A4nrwyAqAZvCE0HWsG0=',
  });
  assert.ok(!sas.token.includes('+'), 'signature is percent-encoded in the token');
});

test('service SAS: container scope, protocol, IP and identifier land on the right lines', () => {
  const s = buildServiceSasStringToSign({
    permissions: 'rl'.replace('l', ''),
    start: '',
    expiry: '2026-11-05T10:15:00Z',
    canonicalizedResource: '/blob/acct/c',
    identifier: 'policy1',
    ip: '198.51.100.10-198.51.100.20',
    protocol: 'https',
    version: '2026-04-06',
    resource: 'c',
    encryptionScope: '',
    rscc: '',
    rscd: '',
    rsce: '',
    rscl: '',
    rsct: '',
  });
  assert.deepEqual(s.split('\n').slice(0, 9), ['r', '', '2026-11-05T10:15:00Z', '/blob/acct/c', 'policy1', '198.51.100.10-198.51.100.20', 'https', '2026-04-06', 'c']);
});

const UDK = {
  signedObjectId: '11111111-1111-1111-1111-111111111111',
  signedTenantId: '22222222-2222-2222-2222-222222222222',
  signedStart: '2026-11-05T09:00:00Z',
  signedExpiry: '2026-11-06T09:00:00Z',
  signedService: 'b',
  value: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
};
const udkInput = (version) => ({
  accountName: 'phoenixdocs',
  container: 'admissions',
  blob: 'g/123/hello.txt',
  permissions: 'r',
  startsOn: Date.parse('2026-11-05T09:55:00Z'),
  expiresOn: Date.parse('2026-11-05T10:15:00Z'),
  version,
  protocol: 'https',
  userDelegationKey: { ...UDK, signedVersion: version },
});
const head = (v) => ['r', '2026-11-05T09:55:00Z', '2026-11-05T10:15:00Z', '/blob/phoenixdocs/admissions/g/123/hello.txt', UDK.signedObjectId, UDK.signedTenantId, UDK.signedStart, UDK.signedExpiry, 'b', v];

test('user delegation SAS: 2020-12-06 layout (24 lines)', () => {
  const sas = generateUserDelegationSas(udkInput('2020-12-06'));
  const expected = [...head('2020-12-06'), '', '', '', '', 'https', '2020-12-06', 'b', '', '', '', '', '', '', ''].join('\n');
  assert.equal(sas.stringToSign, expected);
  assert.equal(sas.signature, 'rsUD6OH+ULMabyC4VQIotqVCUh6ZEamvacOSXkCzmkI=');
  assert.equal(sas.signature, hmac(expected, UDK.value));
  const q = new URLSearchParams(sas.token);
  assert.equal(q.get('skoid'), UDK.signedObjectId);
  assert.equal(q.get('sks'), 'b');
  assert.equal(q.get('skv'), '2020-12-06');
  assert.equal(q.get('spr'), 'https');
  assert.equal(q.get('skdutid'), null);
});

test('user delegation SAS: 2025-07-05 adds skdutid and sduoid lines (26 lines)', () => {
  const sas = generateUserDelegationSas(udkInput('2025-07-05'));
  const expected = [...head('2025-07-05'), '', '', '', '', '', '', 'https', '2025-07-05', 'b', '', '', '', '', '', '', ''].join('\n');
  assert.equal(sas.stringToSign, expected);
  assert.equal(sas.signature, 'ZSMr6fmBsv9KQDsr424KJjRpY+hF2oW5FJq4VYtcXYs=');
});

test('user delegation SAS: 2026-04-06 adds empty signed-request-header/query lines (28 lines)', () => {
  const sas = generateUserDelegationSas(udkInput('2026-04-06'));
  const expected = [...head('2026-04-06'), '', '', '', '', '', '', 'https', '2026-04-06', 'b', '', '', '', '', '', '', '', '', ''].join('\n');
  assert.equal(sas.stringToSign, expected);
  assert.equal(sas.stringToSign.split('\n').length, 28);
  assert.equal(sas.signature, 'KS/O8Ehyl7PIgJUijeIFOjxAUWd71TGqoX505q1arow=');
});

test('user delegation SAS: user-bound fields are placed after the correlation id', () => {
  const s = buildUserDelegationSasStringToSign({
    permissions: 'r', start: '', expiry: 'E', canonicalizedResource: '/blob/a/c/b', ip: '', protocol: 'https', version: '2026-04-06', resource: 'b',
    encryptionScope: '', rscc: '', rscd: '', rsce: '', rscl: '', rsct: '',
    key: { ...UDK, signedVersion: '2026-04-06', signedDelegatedUserTenantId: 'TID' },
    correlationId: 'CID', delegatedUserObjectId: 'DUOID',
  }).split('\n');
  assert.deepEqual(s.slice(12, 15), ['CID', 'TID', 'DUOID']);
});

test('SAS validation: permission order, unknown letters, expiry rules and minimum version', () => {
  assert.equal(normalisePermissions('wdr'), 'rwd');
  assert.throws(() => normalisePermissions('rl'), { kind: 'validation' });
  assert.throws(() => generateServiceSas({ ...udkInput('2026-04-06'), accountKey: KEY, version: '2019-12-12' }), /2020-12-06/);
  assert.throws(() => generateServiceSas({ ...udkInput('2026-04-06'), accountKey: KEY, startsOn: Date.parse('2026-11-05T11:00:00Z') }), /before its expiry/);
  assert.throws(() => generateUserDelegationSas({ ...udkInput('2026-04-06'), expiresOn: Date.parse('2026-11-07T00:00:00Z') }), /user delegation key expiry/);
});
