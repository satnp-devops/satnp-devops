import { env } from '../../config/env.js';
import { db, json } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { getProvider } from './catalog.js';
import { decryptCredentials, deriveConnectionSecret } from './credentials.js';
import { IntegrationError } from './errors.js';
import { getKind } from './kinds/index.js';
import { buildMockWebhook, summarisePayload } from './mocks/common.js';
import { guardAdapter } from './shape.js';

/** Are mock adapters allowed in this process? INTEGRATIONS_MOCKS: auto (not in production), on, off. */
export function mocksAllowed() {
  return env.integrationMocks;
}

/**
 * Choose the connection for a company and kind. Pure, so the rules are unit-tested:
 *
 *   1. connectionId given: it must be linked to the company, of this kind, active, and not a mock
 *      while mocks are off. Otherwise integration_unavailable / integration_mocks_disabled.
 *      There is no fallback: a caller that names a connection gets that one or an error.
 *   2. Otherwise the company's default connection for the kind, if it is active (mocks only when allowed).
 *   3. Otherwise its oldest active connection of the kind.
 *   4. Otherwise, when mocks are allowed, the built-in mock (`fallback: true`, nothing stored),
 *      so development works for a company nobody has connected yet.
 *   5. Otherwise integration_not_connected. Production never falls back to a mock silently.
 *
 * @param {{ candidates: Array<{ id: string, provider: string, status: string, kind: string, is_default: boolean, created_at: Date | string }>,
 *           kind: string, connectionId?: string | null, mocksAllowed: boolean, companyName?: string }} input
 * @returns {{ connection: object } | { fallback: true }}
 */
export function chooseConnection({ candidates, kind, connectionId, mocksAllowed: allowMocks, companyName = 'This company' }) {
  const label = getKind(kind)?.label ?? kind;
  const usable = (c) => c.status === 'active' && (allowMocks || c.provider !== 'mock');
  if (connectionId) {
    const named = candidates.find((c) => c.id === connectionId);
    if (!named || named.kind !== kind) {
      throw new IntegrationError('integration_unavailable', `That ${label} connection is not available to ${companyName}`, { kind });
    }
    if (named.provider === 'mock' && !allowMocks) {
      throw new IntegrationError('integration_mocks_disabled', 'Mock connections are switched off on this server', { kind, provider: 'mock' });
    }
    if (named.status !== 'active') throw new IntegrationError('integration_unavailable', `The ${label} connection is disabled`, { kind });
    return { connection: named };
  }
  const active = candidates
    .filter((c) => c.kind === kind && usable(c))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || new Date(a.created_at) - new Date(b.created_at) || a.id.localeCompare(b.id));
  if (active[0]) return { connection: active[0] };
  if (allowMocks) return { fallback: true };
  throw new IntegrationError('integration_not_connected', `${companyName} has no active ${label} connection`, { kind });
}

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

function sandboxScope(query, connection) {
  if (connection.fallback) {
    return query.whereNull('connection_id').where({ company_id: connection.companyId, kind: connection.kind });
  }
  return query.where({ connection_id: connection.id });
}

/** What an adapter factory receives. Mocks use record/findRecord/listRecords; real adapters use config and credentials. */
export function adapterContext({ connection, credentials, now = Date.now, log = logger }) {
  return {
    connection,
    config: connection.config ?? {},
    credentials: credentials ?? {},
    now,
    log,
    derivedSecret: (purpose) => deriveConnectionSecret(connection.id, purpose, env.encryptionKey),
    localStorage: { rootDir: env.localStorageDir, baseUrl: `${env.APP_URL}/api/v1/integrations/local-files` },
    /** Record an outbound mock call in the sandbox outbox. Written outside the caller's transaction: a "sent" message stays sent. */
    async record(entry) {
      await db('integration_sandbox_messages').insert({
        group_id: connection.groupId,
        company_id: connection.companyId ?? null,
        connection_id: connection.fallback ? null : connection.id,
        kind: connection.kind,
        provider: connection.provider,
        operation: entry.operation,
        recipient: clip(entry.recipient, 500),
        subject: clip(entry.subject, 500),
        body: clip(entry.body, 4000),
        provider_ref: clip(entry.providerRef, 300),
        reference: clip(entry.reference ?? entry.payload?.reference, 300),
        status: clip(entry.status, 40),
        payload: json(summarisePayload(entry.payload ?? {})),
      });
    },
    async findRecord({ providerRef, operation }) {
      const query = sandboxScope(db('integration_sandbox_messages'), connection).where({ provider_ref: providerRef });
      if (operation) query.where({ operation });
      return (await query.orderBy('id', 'desc').first()) ?? null;
    },
    async listRecords({ operation, reference, limit = 200 }) {
      const query = sandboxScope(db('integration_sandbox_messages'), connection).where({ operation });
      if (reference) query.where({ reference });
      return query.orderBy('id', 'desc').limit(limit);
    },
  };
}

/** A connection row as adapters see it. */
export function connectionView(row, companyId) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    name: row.name,
    groupId: row.group_id,
    companyId: companyId ?? null,
    config: row.config ?? {},
    fallback: false,
  };
}

/**
 * Build the raw (unchecked) adapter for one connection row. Most code wants getAdapter();
 * this is for health checks, the dev file route and tests.
 */
export function rawAdapterForConnection(row, { companyId = null, now, log } = {}) {
  const provider = getProvider(row.kind, row.provider);
  if (!provider) throw new IntegrationError('integration_unavailable', `Unknown provider "${row.provider}" for ${row.kind}`, { kind: row.kind });
  if (provider.mock && !mocksAllowed()) {
    throw new IntegrationError('integration_mocks_disabled', 'Mock connections are switched off on this server', { kind: row.kind, provider: 'mock' });
  }
  const credentials = decryptCredentials(row.id, row.credentials_enc, env.encryptionKey);
  return provider.create(adapterContext({ connection: connectionView(row, companyId), credentials, now, log }));
}

/** The checked adapter for one connection row (inputs parsed, outputs checked outside production). */
export function adapterForConnection(row, options = {}) {
  const kind = getKind(row.kind);
  const adapter = guardAdapter(kind, rawAdapterForConnection(row, options), { checkOutputs: !env.isProd });
  return Object.freeze({ ...adapter, connection: { id: row.id, name: row.name, provider: row.provider, kind: row.kind, companyId: options.companyId ?? null, fallback: false } });
}

const warnedFallbacks = new Set();

function fallbackAdapter({ company, kind, now, log }) {
  const key = `${company.id}:${kind.key}`;
  if (!warnedFallbacks.has(key)) {
    warnedFallbacks.add(key);
    log.warn({ companyId: company.id, kind: kind.key }, `No ${kind.key} connection for ${company.name}: using the built-in mock (INTEGRATIONS_MOCKS)`);
  }
  const provider = getProvider(kind.key, 'mock');
  const connection = {
    id: `fallback-${company.id}-${kind.key.replace('.', '-')}`,
    kind: kind.key,
    provider: 'mock',
    name: `Built-in mock ${kind.label}`,
    groupId: company.root_id,
    companyId: company.id,
    config: {},
    fallback: true,
  };
  const adapter = guardAdapter(kind, provider.create(adapterContext({ connection, credentials: {}, now, log })), { checkOutputs: !env.isProd });
  return Object.freeze({ ...adapter, connection: { id: null, name: connection.name, provider: 'mock', kind: kind.key, companyId: company.id, fallback: true } });
}

/** Connections linked to a company for a kind, with the company's default flag. */
export function linkedConnections(companyId, kind, trx = db) {
  return trx('integration_connection_companies as l')
    .join('integration_connections as c', 'c.id', 'l.connection_id')
    .where({ 'l.company_id': companyId, 'l.kind': kind })
    .whereNull('c.disconnected_at')
    .select('c.*', 'l.is_default');
}

/**
 * The adapter feature code uses:
 *
 *   const whatsapp = await getAdapter({ companyId, kind: 'messaging.whatsapp' });
 *   await whatsapp.sendTemplate({ to, template: { name: 'booking_link', language: 'en', bodyVariables: [...] } });
 *
 * Resolution rules: chooseConnection() above. The result is the kind's methods (checked against the
 * kind's schemas) plus `connection: { id, name, provider, kind, companyId, fallback }`.
 * companyId must be a company the caller has already scoped; this function does no permission checks.
 *
 * @param {{ companyId: string, kind: string, connectionId?: string, trx?: import('knex').Knex, now?: () => number, log?: object }} input
 */
export async function getAdapter({ companyId, kind: kindKey, connectionId, trx = db, now, log = logger }) {
  const kind = getKind(kindKey);
  if (!kind) throw new Error(`Unknown adapter kind "${kindKey}"`);
  const company = await trx('org_units').where({ id: companyId }).first();
  if (!company || company.type !== 'company' || company.status !== 'active') {
    throw new IntegrationError('integration_not_connected', 'Unknown or archived company', { kind: kind.key });
  }
  const candidates = await linkedConnections(company.id, kind.key, trx);
  const choice = chooseConnection({ candidates, kind: kind.key, connectionId, mocksAllowed: mocksAllowed(), companyName: company.name });
  if (choice.fallback) return fallbackAdapter({ company, kind, now, log });
  return adapterForConnection(choice.connection, { companyId: company.id, now, log });
}

/**
 * A signed mock webhook for a mock connection, for tests and local development of webhook routes:
 *   const { rawBody, headers } = await buildMockWebhookRequest({ connectionId, events: [{ id, type, occurredAt, data }] });
 */
export async function buildMockWebhookRequest({ connectionId, events, trx = db }) {
  const row = await trx('integration_connections').where({ id: connectionId }).first();
  if (!row || row.provider !== 'mock') throw new Error('buildMockWebhookRequest needs a mock connection');
  const credentials = decryptCredentials(row.id, row.credentials_enc, env.encryptionKey);
  const secret = credentials.webhookSecret || deriveConnectionSecret(row.id, 'mock-webhook', env.encryptionKey);
  return buildMockWebhook(secret, events);
}
