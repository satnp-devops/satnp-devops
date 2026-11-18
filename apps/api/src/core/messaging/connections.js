import { db } from '../../lib/db.js';
import { chooseConnection, isIntegrationError, mocksAllowed } from '../../integrations/index.js';
import { CHANNEL_KINDS } from './constants.js';

// Which connection carries a message. A reply goes out on the connection the person last wrote to
// (the same WhatsApp number or inbox) while it is still usable; otherwise the company's default
// for the kind, following the integration framework's rules (chooseConnection), including the
// built-in mock outside production.

const KINDS = Object.values(CHANNEL_KINDS);

/** Every messaging connection linked to a company, with its default flag. One query. */
export function companyMessagingConnections(companyId, trx = db) {
  return trx('integration_connection_companies as l')
    .join('integration_connections as c', 'c.id', 'l.connection_id')
    .where('l.company_id', companyId)
    .whereIn('l.kind', KINDS)
    .whereNull('c.disconnected_at')
    .select('c.id', 'c.kind', 'c.provider', 'c.name', 'c.status', 'c.created_at', 'l.is_default');
}

/**
 * The connection for a channel. Pure.
 * @param {{ candidates: object[], channel: string, preferredConnectionId?: string | null, companyName?: string, allowMocks?: boolean }} input
 * @returns {{ connection: { id: string, name: string, provider: string, mock: boolean } | null, fallback: boolean, key: string, error: object | null }}
 *   key is the conversation's connection_key: the connection id, or "fallback" for the built-in mock.
 */
export function pickConnection({ candidates, channel, preferredConnectionId = null, companyName, allowMocks = mocksAllowed() }) {
  const kind = CHANNEL_KINDS[channel];
  const attempt = (connectionId) => chooseConnection({ candidates, kind, connectionId, mocksAllowed: allowMocks, companyName });
  let choice = null;
  if (preferredConnectionId) {
    try {
      choice = attempt(preferredConnectionId);
    } catch (err) {
      if (!isIntegrationError(err)) throw err;
    }
  }
  try {
    choice ??= attempt(null);
  } catch (err) {
    if (!isIntegrationError(err)) throw err;
    return { connection: null, fallback: false, key: null, error: err };
  }
  if (choice.fallback) return { connection: null, fallback: true, key: 'fallback', error: null };
  const { id, name, provider } = choice.connection;
  return { connection: { id, name, provider, mock: provider === 'mock' }, fallback: false, key: id, error: null };
}
