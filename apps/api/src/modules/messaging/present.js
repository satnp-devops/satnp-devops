import { maskEmail, maskPhone } from '../../core/crm/pii.js';
import { PURPOSE_OF_CATEGORY, templateVariables, toProviderText, bodyVariableOrder } from '../../core/messaging/index.js';

// Rows → API shapes (apps/web/src/lib/messaging/types.ts). Addresses are personal data: masked
// unless the viewer holds contacts.view_pii where they see the message. Message text is not masked
// (as on the timeline, docs/crm/PHASE2_CONTRACT.md §10).

const iso = (value) => (value ? new Date(value).toISOString() : null);

const maskAddress = (channel, value, canViewPii) => {
  if (!value) return null;
  if (canViewPii) return value;
  return channel === 'email' ? maskEmail(value) : maskPhone(value);
};

/**
 * @param {object} row a messages row
 * @param {{ canViewPii: boolean, users?: Map<string, { id: string, name: string }> }} options
 */
export function presentMessage(row, { canViewPii, users = new Map() }) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    dealId: row.deal_id ?? null,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    purpose: row.purpose ?? null,
    template: row.template_name ? { id: row.template_id ?? null, name: row.template_name, version: row.template_version ?? null } : null,
    variables: row.variables ?? {},
    subject: row.subject ?? null,
    body: row.body ?? null,
    media: row.media ?? [],
    to: maskAddress(row.channel, row.to_address, canViewPii),
    from: maskAddress(row.channel, row.from_address, canViewPii),
    piiMasked: !canViewPii,
    provider: row.provider ?? null,
    providerMessageId: row.provider_message_id ?? null,
    source: row.source,
    actorType: row.actor_type,
    sentBy: row.sent_by_user_id ? (users.get(row.sent_by_user_id) ?? { id: row.sent_by_user_id, name: 'Former user' }) : null,
    agent: row.agent ?? null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'The message could not be sent' } : null,
    occurredAt: iso(row.occurred_at),
    sentAt: iso(row.sent_at),
    deliveredAt: iso(row.delivered_at),
    readAt: iso(row.read_at),
    failedAt: iso(row.failed_at),
    receivedAt: iso(row.received_at),
    createdAt: iso(row.created_at),
  };
}

/** One version's content (row_to_json or a row). */
export function presentContent(version) {
  if (!version) return null;
  return {
    version: version.version,
    status: version.status,
    header: version.header ?? null,
    subject: version.subject ?? null,
    body: version.body,
    footer: version.footer ?? null,
    buttons: version.buttons ?? [],
    samples: version.samples ?? {},
    providerTemplateName: version.provider_template_name ?? null,
    providerTemplateId: version.provider_template_id ?? null,
    rejectionReason: version.rejection_reason ?? null,
    createdAt: iso(version.created_at),
    submittedAt: iso(version.submitted_at),
    decidedAt: iso(version.decided_at),
  };
}

/**
 * @param {object} row a message_templates row with `latest` and `live` (row_to_json of the versions)
 * @param {{ canManage: boolean }} options
 */
export function presentTemplate(row, { canManage }) {
  const latest = presentContent(row.latest);
  const content = { channel: row.channel, ...(row.latest ?? {}) };
  return {
    id: row.id,
    companyId: row.company_id,
    channel: row.channel,
    name: row.name,
    language: row.language,
    category: row.category,
    purpose: PURPOSE_OF_CATEGORY[row.category],
    description: row.description ?? null,
    status: row.status,
    latestVersion: row.latest_version,
    approvedVersion: row.approved_version ?? null,
    latest,
    live: row.live ? presentContent(row.live) : null,
    variables: row.latest ? templateVariables(content) : [],
    providerBody: row.latest ? toProviderText(row.latest.body, bodyVariableOrder(row.latest.body)) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: iso(row.archived_at),
    can: { manage: canManage && !row.archived_at },
  };
}

/** An approved template as the reply box needs it: the live version's content. */
export function presentReplyTemplate(row) {
  const live = row.live;
  const content = { channel: row.channel, header: live.header, subject: live.subject, body: live.body, footer: live.footer, buttons: live.buttons ?? [] };
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    language: row.language,
    category: row.category,
    purpose: PURPOSE_OF_CATEGORY[row.category],
    version: live.version,
    header: live.header ?? null,
    subject: live.subject ?? null,
    body: live.body,
    footer: live.footer ?? null,
    buttons: live.buttons ?? [],
    samples: live.samples ?? {},
    variables: templateVariables(content),
  };
}
