import { maskPiiDeep } from '../../core/ai/text.js';
import { maskCustomPii } from '../../core/crm/customFields.js';
import { minorFromDb } from '../../core/crm/money.js';
import { maskEmail, maskPhone, presentContactPii } from '../../core/crm/pii.js';
import { slaFlagsOf } from './sla.js';

// Row → API shapes of apps/web/src/lib/crm/types.ts (DealListItem, DealDetail, StageHistoryEntry,
// SavedView ...). Related rows come in a context built once per page (no N+1).

/** A lead is "new" while it's open, less than this many days old and its owner hasn't opened it. */
export const NEW_LEAD_DAYS = 7;
const DAY = 86_400_000;

/**
 * The "New" highlight: open, created in the last 7 days, and its current owner hasn't opened it
 * yet (deals.owner_seen_at, set by POST /deals/:id/seen and cleared when the owner changes).
 * Unassigned leads stay new until someone takes them and opens them.
 */
export function isNewLead(row, now = new Date()) {
  if (row.status !== 'open' || row.archived_at || row.owner_seen_at) return false;
  return now.getTime() - new Date(row.created_at).getTime() < NEW_LEAD_DAYS * DAY;
}

export const presentUserRef = (user) => (user ? { id: user.id, name: user.name } : null);
export const presentUnitRef = (unit) => (unit ? { id: unit.id, name: unit.name, type: unit.type } : null);

export function presentStageRef(stage) {
  return { id: stage.id, key: stage.key, name: stage.name, category: stage.category, colour: stage.colour ?? null };
}

export function presentContactSummary(contact, canViewPii) {
  const pii = presentContactPii(contact, canViewPii);
  return {
    id: contact.id,
    kind: contact.kind,
    displayName: contact.display_name,
    firstName: contact.first_name ?? null,
    lastName: contact.last_name ?? null,
    city: contact.city ?? null,
    primaryPhone: pii.primaryPhone,
    primaryEmail: pii.primaryEmail,
    piiMasked: pii.piiMasked,
    erased: Boolean(contact.erased_at),
  };
}

/** The original message, with the sender's phone and email masked like any other personal data. */
export function presentOriginalMessage(message, canViewPii) {
  if (!message) return null;
  if (!message.from || canViewPii) return message;
  const from = { ...message.from };
  if (from.phone) from.phone = maskPhone(from.phone) ?? '••••';
  if (from.email) from.email = maskEmail(from.email) ?? '••••';
  return { ...message, from };
}

const preview = (message) => {
  const text = message?.text?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
};

/**
 * @param {object} row deals row
 * @param {{ stages: Map, units: Map, users: Map, productLines: Map, products: Map, contacts: Map,
 *           accounts: Map, studentNames: Map, canViewPii: (unitId: string) => boolean, now?: Date }} ctx
 */
export function presentDealListItem(row, ctx) {
  const now = ctx.now ?? new Date();
  const stage = ctx.stages.get(row.stage_id);
  const productLine = row.product_line_id ? ctx.productLines.get(row.product_line_id) : null;
  const product = row.product_id ? ctx.products.get(row.product_id) : null;
  const contact = row.primary_contact_id ? ctx.contacts.get(row.primary_contact_id) : null;
  const account = row.account_id ? ctx.accounts.get(row.account_id) : null;
  const pii = ctx.canViewPii(row.unit_id);
  const flags = slaFlagsOf(row, now);
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    status: row.status,
    kind: row.kind,
    companyId: row.company_id,
    stage: stage ? presentStageRef(stage) : { id: row.stage_id, key: '', name: 'Unknown stage', category: row.status, colour: null },
    owner: presentUserRef(row.owner_user_id ? ctx.users.get(row.owner_user_id) : null),
    value: { valueMinor: minorFromDb(row.value_minor), currency: row.currency },
    updatedAt: row.updated_at,
    unit: presentUnitRef(ctx.units.get(row.unit_id)) ?? { id: row.unit_id, name: '', type: '' },
    pipelineId: row.pipeline_id,
    productLine: productLine ? { id: productLine.id, name: productLine.name, kind: productLine.kind } : null,
    product: product ? { id: product.id, name: product.name, code: product.code ?? null } : null,
    primaryContact: contact ? presentContactSummary(contact, pii) : null,
    account: account ? { id: account.id, name: account.name, kind: account.kind } : null,
    studentNames: ctx.studentNames.get(row.id) ?? [],
    channel: row.channel,
    firstTouch: row.first_touch ?? null,
    messagePreview: preview(row.original_message),
    tags: row.tags ?? [],
    nurture: row.nurture === true,
    stageEnteredAt: row.stage_entered_at,
    slaDueAt: row.status === 'open' ? (row.sla_due_at ?? null) : null,
    slaBreached: flags.slaBreached,
    slaDueSoon: flags.slaDueSoon,
    firstReplyDueAt: row.first_reply_due_at ?? null,
    firstRepliedAt: row.first_replied_at ?? null,
    firstReplyOverdue: flags.firstReplyOverdue,
    firstReplyDueSoon: flags.firstReplyDueSoon,
    expectedCloseOn: row.expected_close_on ?? null,
    closedAt: row.closed_at ?? null,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at ?? null,
    isNew: isNewLead(row, now),
    createdAt: row.created_at,
  };
}

/**
 * @param {object} row deals row
 * @param {object} ctx as for presentDealListItem
 * @param {{ pipeline: object, household: object | null, participants: Array<{ contact: object, role: string }>,
 *           lostReason: object | null, createdBy: object | null, can: { manage: boolean, assign: boolean, archive: boolean },
 *           piiFields?: Array<{ key: string, type: string }> }} extra  piiFields: the company's phone and email
 *           deal fields, masked for a viewer without contacts.view_pii
 */
export function presentDealDetail(row, ctx, extra) {
  const pii = ctx.canViewPii(row.unit_id);
  return {
    ...presentDealListItem(row, ctx),
    pipeline: { id: extra.pipeline.id, name: extra.pipeline.name, kind: extra.pipeline.kind },
    household: extra.household ? { id: extra.household.id, name: extra.household.name } : null,
    contacts: extra.participants.map(({ contact, role }) => ({
      contact: presentContactSummary(contact, pii),
      role,
      isPrimary: contact.id === row.primary_contact_id,
    })),
    lastTouch: row.last_touch ?? null,
    originalMessage: presentOriginalMessage(row.original_message, pii),
    // What the AI pulled out of the enquiry includes the phone and email written in it.
    aiFields: pii ? (row.ai_fields ?? {}) : maskPiiDeep(row.ai_fields ?? {}),
    custom: pii ? (row.custom ?? {}) : maskCustomPii(row.custom, extra.piiFields ?? []),
    lostReason: extra.lostReason ? { id: extra.lostReason.id, label: extra.lostReason.label } : null,
    lostNote: row.lost_note ?? null,
    createdBy: presentUserRef(extra.createdBy),
    can: extra.can,
  };
}

export function presentStageHistoryEntry(row, { stages, lostReasons, users }) {
  const from = row.from_stage_id ? stages.get(row.from_stage_id) : null;
  const to = stages.get(row.to_stage_id);
  const reason = row.lost_reason_id ? lostReasons.get(row.lost_reason_id) : null;
  return {
    id: String(row.id),
    fromStage: from ? presentStageRef(from) : null,
    toStage: to ? presentStageRef(to) : { id: row.to_stage_id, key: '', name: 'Unknown stage', category: row.to_status, colour: null },
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    lostReason: reason ? { id: reason.id, label: reason.label } : null,
    movedBy: presentUserRef(row.moved_by_user_id ? users.get(row.moved_by_user_id) : null),
    secondsInFromStage: row.seconds_in_from_stage === null || row.seconds_in_from_stage === undefined ? null : Number(row.seconds_in_from_stage),
    movedAt: row.moved_at,
  };
}

export function presentSavedView(row, { owner, canEdit }) {
  return {
    id: row.id,
    entity: row.entity,
    name: row.name,
    visibility: row.visibility,
    unitId: row.unit_id,
    companyId: row.company_id ?? null,
    owner: presentUserRef(owner) ?? { id: row.owner_user_id, name: '' },
    filters: row.filters ?? {},
    sort: row.sort,
    columns: row.columns ?? [],
    position: row.position,
    can: { edit: canEdit },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
