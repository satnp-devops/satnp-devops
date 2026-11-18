import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalDiskStorage } from '../../../src/integrations/providers/azblob/index.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'phoenix-azblob-'));
after(() => rm(root, { recursive: true, force: true }));

let clock = Date.parse('2026-11-05T10:00:00Z');
const storage = createLocalDiskStorage(
  { rootDir: root, baseUrl: 'http://localhost:4000/dev-storage', signingSecret: 'local-dev-signing-secret-0123456789', defaultContainer: 'admissions' },
  { now: () => clock },
);

test('local disk: same interface shape as the Azure client', () => {
  for (const fn of ['putBlob', 'getBlob', 'getBlobProperties', 'deleteBlob', 'createContainer', 'createDownloadUrl']) {
    assert.equal(typeof storage[fn], 'function', fn);
  }
  assert.equal(storage.kind, 'storage');
});

test('local disk: put, get, range, head, delete round trip with Azure-like errors', async () => {
  await assert.rejects(storage.putBlob({ name: 'x.txt', body: 'x' }), { kind: 'not_found', azureCode: 'ContainerNotFound' });
  assert.deepEqual(await storage.createContainer(), { container: 'admissions', created: true });
  assert.deepEqual(await storage.createContainer(), { container: 'admissions', created: false });

  const put = await storage.putBlob({ name: 'g/123/ok.txt', body: 'hello world', contentType: 'text/plain', metadata: { StudentId: 'G-123' } });
  assert.equal(put.contentMd5, 'XrY7u+Ae7tCTyyK7j1rNww==');
  assert.equal(put.size, 11);
  await assert.rejects(storage.putBlob({ name: 'g/123/ok.txt', body: 'again', overwrite: false }), { kind: 'conflict', azureCode: 'BlobAlreadyExists' });
  await assert.rejects(storage.putBlob({ name: 'g/123/ok.txt', body: 'again', ifMatch: '"0xWRONG"' }), { kind: 'precondition' });

  const got = await storage.getBlob({ name: 'g/123/ok.txt' });
  assert.equal(got.body.toString(), 'hello world');
  assert.equal(got.contentType, 'text/plain');
  assert.deepEqual(got.metadata, { studentid: 'G-123' });
  assert.equal(got.lastModified, '2026-11-05T10:00:00.000Z');
  const part = await storage.getBlob({ name: 'g/123/ok.txt', range: { offset: 6, count: 5 } });
  assert.equal(part.body.toString(), 'world');
  assert.equal(part.partial, true);
  assert.equal((await storage.getBlobProperties({ name: 'g/123/ok.txt' })).contentLength, 11);

  assert.deepEqual(await storage.deleteBlob({ name: 'g/123/ok.txt' }), { deleted: true, requestId: null });
  assert.deepEqual(await storage.deleteBlob({ name: 'g/123/ok.txt' }), { deleted: false, requestId: null });
  await assert.rejects(storage.getBlob({ name: 'g/123/ok.txt' }), { kind: 'not_found', azureCode: 'BlobNotFound' });
});

test('local disk: names are hashed on disk, so traversal-looking names never leave rootDir', async () => {
  await assert.rejects(storage.putBlob({ name: '../escape.txt', body: 'x' }), { kind: 'validation' });
  await storage.putBlob({ name: 'नाम/फ़ाइल.txt', body: 'unicode ok' });
  const files = await readdir(path.join(root, 'admissions'));
  assert.ok(files.every((f) => /^[0-9a-f]{64}\.(bin|json)$/.test(f)), files.join(','));
  assert.equal((await storage.getBlob({ name: 'नाम/फ़ाइल.txt' })).body.toString(), 'unicode ok');
});

test('local disk: signed download URLs verify, expire, and reject tampering', async () => {
  await storage.putBlob({ name: 'g/9/tc.pdf', body: 'PDF', contentType: 'application/pdf' });
  const { url, expiresAt } = await storage.createDownloadUrl({ name: 'g/9/tc.pdf', expiresInSeconds: 60, filename: 'TC.pdf' });
  assert.equal(expiresAt, '2026-11-05T10:01:00.000Z');
  const check = storage.verifyDownloadUrl(url);
  assert.equal(check.valid, true);
  assert.equal(check.name, 'g/9/tc.pdf');
  const served = await storage.readDownload(url);
  assert.equal(served.body.toString(), 'PDF');
  assert.match(served.contentDisposition, /^attachment; filename="TC.pdf"/);

  assert.deepEqual(storage.verifyDownloadUrl(url.replace('tc.pdf', 'other.pdf')), { valid: false, reason: 'bad_signature' });
  assert.deepEqual(storage.verifyDownloadUrl(url.replace(/se=\d+/, 'se=9999999999')), { valid: false, reason: 'bad_signature' });
  clock += 61_000;
  assert.deepEqual(storage.verifyDownloadUrl(url), { valid: false, reason: 'expired' });
  await assert.rejects(storage.readDownload(url), { kind: 'forbidden' });
});
