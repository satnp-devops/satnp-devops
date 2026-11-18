import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveConnectionSecret } from '../../src/integrations/framework/credentials.js';
import { summarisePayload } from '../../src/integrations/framework/mocks/common.js';

export const TEST_KEY = randomBytes(32); // like env.encryptionKey: 32 raw bytes
export const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';
export const START = Date.parse('2026-11-06T10:00:00.000Z');

const silent = { info() {}, warn() {}, error() {}, debug() {}, child: () => silent };

/**
 * The context an adapter factory receives (framework/resolve.js adapterContext), with the sandbox
 * outbox kept in memory as rows shaped like integration_sandbox_messages.
 */
export function fakeContext({ kind, config = {}, credentials = {}, id = CONNECTION_ID, clock } = {}) {
  const records = [];
  const time = clock ?? { now: START };
  let seq = 0;
  const ctx = {
    connection: { id, kind, provider: 'mock', name: 'Test mock', groupId: 'group', companyId: 'company', config, fallback: false },
    config,
    credentials,
    now: () => time.now,
    log: silent,
    derivedSecret: (purpose) => deriveConnectionSecret(id, purpose, TEST_KEY),
    localStorage: { rootDir: mkdtempSync(join(tmpdir(), 'phx-storage-')), baseUrl: 'http://localhost:4000/api/v1/integrations/local-files' },
    async record(entry) {
      seq += 1;
      records.push({
        id: seq,
        operation: entry.operation,
        recipient: entry.recipient ?? null,
        subject: entry.subject ?? null,
        body: entry.body ?? null,
        provider_ref: entry.providerRef ?? null,
        reference: entry.reference ?? entry.payload?.reference ?? null,
        status: entry.status ?? null,
        payload: summarisePayload(entry.payload ?? {}),
        created_at: new Date(time.now),
      });
    },
    async findRecord({ providerRef, operation }) {
      const matches = records.filter((r) => r.provider_ref === providerRef && (!operation || r.operation === operation));
      return matches[matches.length - 1] ?? null;
    },
    async listRecords({ operation, reference, limit = 200 }) {
      return records
        .filter((r) => r.operation === operation && (!reference || r.reference === reference))
        .reverse()
        .slice(0, limit);
    },
  };
  return { ctx, records, clock: time };
}
