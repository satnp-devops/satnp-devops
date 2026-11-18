// tasks rows → Task (apps/web/src/lib/crm/types.ts). Pure.

const iso = (value) => (value ? (value instanceof Date ? value : new Date(value)).toISOString() : null);
const userRef = (user) => (user ? { id: user.id, name: user.name } : null);

/**
 * @param {object} row a tasks row
 * @param {{ users: Map, deals: Map, contacts: Map, accounts: Map, unitsById: Map, canManage: boolean, now?: Date }} context
 */
export function presentTask(row, { users, deals, contacts, accounts, unitsById, canManage, now = new Date() }) {
  const unit = unitsById.get(row.unit_id);
  const deal = row.deal_id ? deals.get(row.deal_id) : null;
  const contact = row.contact_id ? contacts.get(row.contact_id) : null;
  const account = row.account_id ? accounts.get(row.account_id) : null;
  return {
    id: row.id,
    companyId: row.company_id,
    unit: unit ? { id: unit.id, name: unit.name, type: unit.type } : { id: row.unit_id, name: '', type: '' },
    title: row.title,
    notes: row.notes ?? null,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    dueAt: iso(row.due_at),
    reminderAt: iso(row.reminder_at),
    overdue: row.status === 'open' && Boolean(row.due_at) && new Date(row.due_at).getTime() < now.getTime(),
    assignee: userRef(users.get(row.assignee_user_id)),
    createdBy: userRef(users.get(row.created_by)),
    completedAt: iso(row.completed_at),
    completedBy: userRef(users.get(row.completed_by)),
    deal: deal ? { id: deal.id, ref: deal.ref, title: deal.title, status: deal.status } : null,
    contact: contact ? { id: contact.id, displayName: contact.display_name } : null,
    account: account ? { id: account.id, name: account.name, kind: account.kind } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    can: { manage: canManage },
  };
}
