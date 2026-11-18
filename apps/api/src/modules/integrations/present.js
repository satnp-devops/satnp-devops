import { maskPiiText } from '../../core/ai/text.js';
import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { getProvider } from '../../integrations/index.js';
import { unitRef } from './scope.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * A connection as the API returns it. Credentials never leave the server: only which secret
 * fields are set, as hints ("••••3f9a").
 * @param {object} row integration_connections row
 * @param {{ links: object[], index: Map<string, object>, canManage: boolean, canSeeUnit: (unit: object) => boolean }} ctx
 */
export function presentConnection(row, { links, index, canManage, canSeeUnit }) {
  const provider = getProvider(row.kind, row.provider);
  const owner = index.get(row.unit_id);
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    providerLabel: provider?.label ?? row.provider,
    mock: provider?.mock ?? false,
    implemented: provider?.implemented ?? false,
    name: row.name,
    owner: unitRef(owner),
    shared: owner?.type === 'group',
    companies: links
      .map((link) => ({ link, unit: index.get(link.company_id) }))
      .filter(({ unit }) => unit && canSeeUnit(unit))
      .map(({ link, unit }) => ({ id: unit.id, name: unit.name, isDefault: link.is_default }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    status: row.status,
    health: {
      status: row.health_status,
      message: row.health_message ?? null,
      checkedAt: iso(row.last_checked_at),
      lastError: row.last_error ?? null,
    },
    config: row.config ?? {},
    credentials: row.credential_hints ?? {},
    canManage,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** canSeeUnit hides the names of companies outside the user's scope on shared channels (as for connections). */
export function presentIdentity(row, { index, connection, canManage, canSeeUnit = () => true }) {
  const company = row.company_id ? index.get(row.company_id) : null;
  return {
    id: row.id,
    type: row.type,
    identity: row.identity,
    normalized: row.identity_normalized,
    label: row.label ?? null,
    company: unitRef(company),
    shared: row.shared,
    companies: row.shared
      ? row.company_ids.map((id) => index.get(id)).filter((unit) => unit && canSeeUnit(unit)).map(unitRef)
      : company
        ? [unitRef(company)]
        : [],
    productLineId: row.product_line_id ?? null,
    connection: connection ? { id: connection.id, name: connection.name, kind: connection.kind, provider: connection.provider } : null,
    canManage,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Mask each recipient in a "a@x.com, +9198..." list for people without contacts.view_pii. */
export function maskRecipients(value) {
  if (!value) return null;
  return value
    .split(/,\s*/)
    .map((part) => (part.includes('@') ? maskEmail(part) : /\d{4}/.test(part) ? maskPhone(part) : part))
    .join(', ');
}

export function presentSandboxMessage(row, { index, connectionName, canViewPii }) {
  const company = row.company_id ? index.get(row.company_id) : null;
  return {
    id: String(row.id),
    kind: row.kind,
    provider: row.provider,
    operation: row.operation,
    connection: row.connection_id ? { id: row.connection_id, name: connectionName ?? null } : null,
    company: unitRef(company),
    recipient: canViewPii ? row.recipient : maskRecipients(row.recipient),
    // Message text quotes numbers and addresses too ("call me on +91 98...").
    subject: canViewPii ? row.subject : maskPiiText(row.subject),
    body: canViewPii ? row.body : maskPiiText(row.body),
    status: row.status,
    providerRef: row.provider_ref,
    reference: row.reference,
    payload: canViewPii ? row.payload : null,
    createdAt: iso(row.created_at),
  };
}
