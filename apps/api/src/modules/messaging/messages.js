import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { applyUnitFilter, loadVisibleContact, scopeFromPaths, scopePaths, unitsIndex } from '../../core/crm/scope.js';
import { sendMessage } from '../../core/messaging/index.js';
import { loadSubject } from './access.js';
import { presentMessage } from './present.js';

// Message lists and the send endpoint.
//
// Which messages a user sees (one query per page, like the timeline, docs/crm/PHASE2_CONTRACT.md §9.8):
//   - on a deal: the deal is visible and they hold messaging.view on it (own: deals they own);
//   - on a person: messages on deals they can see with messaging.view, plus messages with no deal
//     whose company link is in their messaging.view scope (own: links they own).

async function usersById(rows) {
  const ids = [...new Set(rows.map((row) => row.sent_by_user_id).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db('users').whereIn('id', ids).select('id', 'name');
  return new Map(users.map((user) => [user.id, { id: user.id, name: user.name }]));
}

function applyCursor(query, cursor) {
  const after = decodeCursor(cursor);
  if (!after) return query;
  if (typeof after.v !== 'string' || typeof after.id !== 'string') throw errors.badRequest('Invalid cursor');
  return query.whereRaw('(m.occurred_at, m.id) < (?::timestamptz, ?::uuid)', [after.v, after.id]);
}

export async function listMessages(req, { dealId, contactId, companyId, channel, cursor, limit }) {
  let query = db('messages as m').select('m.*');
  let piiFor;
  if (dealId) {
    const subject = await loadSubject(req, { dealId, permission: 'messaging.view' });
    query.where('m.deal_id', subject.deal.id);
    piiFor = () => subject.canViewPii;
  } else {
    const visible = await loadVisibleContact(req, contactId);
    const index = await unitsIndex(req);
    const group = index.get(visible.contact.group_id);
    const scope = scopeFromPaths({
      permission: 'messaging.view',
      userId: req.auth.user.id,
      unit: group,
      unitsById: index,
      paths: scopePaths(req.access, 'messaging.view'),
    });
    query
      .leftJoin('deals as d', 'd.id', 'm.deal_id')
      .leftJoin('contact_companies as cc', function joinLink() {
        this.on('cc.contact_id', 'm.contact_id').andOn('cc.company_id', 'm.company_id');
      })
      .where('m.contact_id', visible.contact.id)
      .where((where) =>
        where
          .where((onDeal) => applyUnitFilter(onDeal.whereNotNull('m.deal_id'), scope, { unitColumn: 'd.unit_id', ownerColumns: ['d.owner_user_id'] }))
          .orWhere((noDeal) => applyUnitFilter(noDeal.whereNull('m.deal_id'), scope, { unitColumn: 'cc.unit_id', ownerColumns: ['cc.owner_user_id'] })),
      );
    if (companyId) query.where('m.company_id', companyId);
    piiFor = (row) => {
      const unit = index.get(row.unit_id);
      return unit ? req.access.can('contacts.view_pii', unit.path) : false;
    };
  }
  if (channel) query.where('m.channel', channel);
  query = applyCursor(query, cursor)
    .orderBy([
      { column: 'm.occurred_at', order: 'desc' },
      { column: 'm.id', order: 'desc' },
    ])
    .limit(limit + 1);
  const rows = await query;
  const { page, nextCursor } = pageOf(rows, limit, (row) => ({ v: new Date(row.occurred_at).toISOString(), id: row.id }));
  const users = await usersById(page);
  return { data: page.map((row) => presentMessage(row, { canViewPii: piiFor(row), users })), nextCursor };
}

/** POST /messaging/messages: a person sends from the reply box. */
export async function sendFromRequest(req, body) {
  const subject = await loadSubject(req, {
    dealId: body.dealId ?? null,
    contactId: body.contactId ?? null,
    companyId: body.companyId ?? null,
    permission: 'messaging.send',
    path: 'body',
  });
  if (subject.contact.erased_at) throw errors.conflict("This person's data was erased on request");
  const { message } = await sendMessage(
    {
      companyId: subject.company.id,
      channel: body.channel,
      contactId: subject.contact.id,
      dealId: subject.deal?.id ?? null,
      methodId: body.methodId,
      templateId: body.templateId,
      variables: body.variables,
      text: body.text,
      subject: body.subject,
      purpose: body.purpose,
      reference: body.clientId ? `client:${req.auth.user.id}:${body.clientId}` : undefined,
      actor: { type: 'user', userId: req.auth.user.id },
    },
    { req, log: req.log, path: 'body' },
  );
  const users = await usersById([message]);
  return presentMessage(message, { canViewPii: subject.canViewPii, users });
}
