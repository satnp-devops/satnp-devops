import { db } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { getSetting } from '../../core/settings.js';
import {
  applyListScope,
  levelForRecord,
  listScope,
  loadVisible,
  loadVisibleAccount,
  loadVisibleContact,
  ownedColumns,
  requireCreateUnit,
  requireRecord,
  unitsIndex,
  userLevelAt,
} from '../../core/crm/scope.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { settingDefinitions } from '../settings/definitions.js';
import { loadVisibleDeal } from '../timeline/access.js';
import { dayBounds, resolveTimeZone } from './dates.js';
import { presentTask } from './present.js';

// Tasks and follow-ups (docs/crm/PHASE2_CONTRACT.md §9.9). "Own" tasks are the ones assigned to or
// created by the user. Due times are UTC; "today" is the viewer's day in their time zone (the
// query's tz, else the user's, else the working unit's locale.timeZone setting).

const OWNER_COLUMNS = ['assignee_user_id', 'created_by'];
const SCOPE_COLUMNS = { unitColumn: 't.unit_id', ownerColumns: ['t.assignee_user_id', 't.created_by'], companyColumn: 't.company_id', groupColumn: 't.group_id' };
const timeZoneSetting = settingDefinitions.find((definition) => definition.key === 'locale.timeZone');

const DUE_INFINITY = "coalesce(t.due_at, 'infinity'::timestamptz)";
const DONE_AT = "coalesce(t.completed_at, '-infinity'::timestamptz)";

/** Sort keys → SQL expression and direction (indexes: tasks_assignee_*, tasks_company_*). */
function sortSpec(sort, statuses) {
  if (sort === '-dueAt') return { expr: DUE_INFINITY, desc: true };
  if (sort === '-createdAt') return { expr: 't.created_at', desc: true };
  if (sort === '-completedAt') {
    const doneOnly = statuses.length === 1 && statuses[0] === 'done';
    return { expr: doneOnly ? 't.completed_at' : DONE_AT, desc: true };
  }
  return { expr: DUE_INFINITY, desc: false };
}

/** A sort value as text with microseconds ('infinity' stays), so cursors never skip rows. */
const cursorValueSql = (expr) =>
  `case when isfinite(${expr}) then to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') else ${expr}::text end`;

const UUID = /^[0-9a-f-]{36}$/i;

function decodeTaskCursor(cursor) {
  const after = decodeCursor(cursor);
  if (!after) return null;
  const valid = typeof after.v === 'string' && UUID.test(String(after.id)) && (/^-?infinity$/.test(after.v) || !Number.isNaN(Date.parse(after.v)));
  if (!valid) throw errors.badRequest('Invalid cursor');
  return after;
}

/** The viewer's time zone: the query's, else the user's own, else the setting at the working unit. */
export async function viewerTimeZone(req, unit, tz) {
  const own = resolveTimeZone([tz, req.auth.user.time_zone], null);
  if (own) return own;
  const setting = timeZoneSetting ? await getSetting(unit, timeZoneSetting) : null;
  return resolveTimeZone([setting]);
}

/** Assignee filter values → user ids and "none". Default: the signed-in user. */
function assigneeFilter(query, values, userId) {
  if (!values) return query;
  const ids = [...new Set(values.filter((value) => value !== 'none').map((value) => (value === 'me' ? userId : value)))];
  const unassigned = values.includes('none');
  return query.where((who) => {
    if (ids.length === 1) who.where('t.assignee_user_id', ids[0]);
    else if (ids.length > 1) who.whereIn('t.assignee_user_id', ids);
    if (unassigned) who.orWhereNull('t.assignee_user_id');
  });
}

function statusFilter(query, statuses) {
  if (statuses.length === 1) return query.where('t.status', statuses[0]);
  return query.whereIn('t.status', statuses);
}

/** Related record type of a task: its deal, else its person, else its institute, else none. */
function relatedFilter(query, related) {
  if (!related?.length) return query;
  return query.where((any) => {
    for (const type of related) {
      if (type === 'deal') any.orWhereNotNull('t.deal_id');
      if (type === 'contact') any.orWhere((w) => w.whereNull('t.deal_id').whereNotNull('t.contact_id'));
      if (type === 'account') any.orWhere((w) => w.whereNull('t.deal_id').whereNull('t.contact_id').whereNotNull('t.account_id'));
      if (type === 'none') any.orWhere((w) => w.whereNull('t.deal_id').whereNull('t.contact_id').whereNull('t.account_id'));
    }
  });
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** The shared part of the list and the counts: scope, assignee, company, subject and type filters. */
function baseQuery(scope, query, userId) {
  const builder = applyListScope(db('tasks as t'), scope, SCOPE_COLUMNS);
  const hasSubject = Boolean(query.dealId || query.contactId || query.accountId);
  // On a deal, person or institute every visible task shows; elsewhere "My tasks" by default.
  assigneeFilter(builder, query.assignee ?? (hasSubject ? null : ['me']), userId);
  if (query.companyId) builder.where('t.company_id', query.companyId);
  if (query.dealId) builder.where('t.deal_id', query.dealId);
  if (query.contactId) builder.where('t.contact_id', query.contactId);
  if (query.accountId) builder.where('t.account_id', query.accountId);
  relatedFilter(builder, query.related);
  if (query.priority?.length) builder.whereIn('t.priority', query.priority);
  if (query.q) builder.whereILike('t.title', `%${escapeLike(query.q)}%`);
  return builder;
}

/** People, deals, contacts and institutes for a page of tasks: one query each. */
async function loadRelations(rows, trx = db) {
  const ids = (column) => [...new Set(rows.map((row) => row[column]).filter(Boolean))];
  const userIds = [...new Set([...ids('assignee_user_id'), ...ids('created_by'), ...ids('completed_by')])];
  const [dealIds, contactIds, accountIds] = [ids('deal_id'), ids('contact_id'), ids('account_id')];
  const [users, deals, contacts, accounts] = await Promise.all([
    userIds.length ? trx('users').whereIn('id', userIds).select('id', 'name') : [],
    dealIds.length ? trx('deals').whereIn('id', dealIds).select('id', 'ref', 'title', 'status') : [],
    contactIds.length ? trx('contacts').whereIn('id', contactIds).select('id', 'display_name') : [],
    accountIds.length ? trx('accounts').whereIn('id', accountIds).select('id', 'name', 'kind') : [],
  ]);
  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  return { users: byId(users), deals: byId(deals), contacts: byId(contacts), accounts: byId(accounts) };
}

async function presentRows(req, rows, trx = db) {
  const [relations, unitsById] = await Promise.all([loadRelations(rows, trx), unitsIndex(req, trx)]);
  const userId = req.auth.user.id;
  const now = new Date();
  return rows.map((row) =>
    presentTask(row, {
      ...relations,
      unitsById,
      now,
      canManage: Boolean(levelForRecord(req.access, unitsById, 'tasks.manage', row, { userId, ownerColumns: OWNER_COLUMNS })),
    }),
  );
}

/** GET /tasks */
export async function listTasks(req, query) {
  const userId = req.auth.user.id;
  const scope = await listScope(req, 'tasks.view', { unitId: query.unitId });
  const statuses = query.status?.length ? [...new Set(query.status)] : ['open'];
  const sort = query.sort ?? (statuses.length === 1 && statuses[0] === 'done' ? '-completedAt' : 'dueAt');
  const { expr, desc } = sortSpec(sort, statuses);
  const after = decodeTaskCursor(query.cursor);

  const builder = statusFilter(baseQuery(scope, query, userId), statuses);
  if (query.due) {
    const now = new Date();
    if (query.due === 'overdue') builder.where('t.status', 'open').where('t.due_at', '<', now);
    else if (query.due === 'none') builder.whereNull('t.due_at');
    else {
      const { startOfToday, startOfTomorrow } = dayBounds(now, await viewerTimeZone(req, scope.unit, query.tz));
      if (query.due === 'today') builder.where('t.due_at', '>=', startOfToday).where('t.due_at', '<', startOfTomorrow);
      if (query.due === 'later_today') builder.where('t.due_at', '>=', now).where('t.due_at', '<', startOfTomorrow);
      if (query.due === 'upcoming') builder.where('t.due_at', '>=', startOfTomorrow);
    }
  }
  if (query.completedAfter) builder.where('t.completed_at', '>=', new Date(query.completedAfter));
  if (after) builder.whereRaw(`(${expr}, t.id) ${desc ? '<' : '>'} (?::timestamptz, ?::uuid)`, [after.v, after.id]);

  const direction = desc ? 'desc' : 'asc';
  const rows = await builder
    .select('t.*', db.raw(`${cursorValueSql(expr)} as cursor_v`))
    .orderByRaw(`${expr} ${direction}, t.id ${direction}`)
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    data: await presentRows(req, page),
    nextCursor: hasMore && last ? encodeCursor({ v: last.cursor_v, id: last.id }) : null,
  };
}

/** GET /tasks/counts: one query over the open tasks with count(*) filter (where …). */
export async function taskCounts(req, query) {
  const userId = req.auth.user.id;
  const scope = await listScope(req, 'tasks.view', { unitId: query.unitId });
  const now = new Date();
  const timeZone = await viewerTimeZone(req, scope.unit, query.tz);
  const { startOfToday, startOfTomorrow } = dayBounds(now, timeZone);
  const [row] = await baseQuery(scope, query, userId)
    .where('t.status', 'open')
    .select(
      db.raw('count(*) filter (where t.due_at < ?)::int as overdue', [now]),
      db.raw('count(*) filter (where t.due_at >= ? and t.due_at < ?)::int as today', [startOfToday, startOfTomorrow]),
      db.raw('count(*) filter (where t.due_at >= ? and t.due_at < ?)::int as later_today', [now, startOfTomorrow]),
      db.raw('count(*) filter (where t.due_at >= ?)::int as upcoming', [startOfTomorrow]),
      db.raw('count(*) filter (where t.due_at is null)::int as no_due_date'),
      db.raw('count(*)::int as open'),
    );
  return {
    overdue: row.overdue,
    today: row.today,
    laterToday: row.later_today,
    upcoming: row.upcoming,
    noDueDate: row.no_due_date,
    open: row.open,
    timeZone,
    startOfToday: startOfToday.toISOString(),
    startOfTomorrow: startOfTomorrow.toISOString(),
  };
}

const loadTask = (req, id, { trx = db, forUpdate = false } = {}) =>
  loadVisible(req, { table: 'tasks', id, permission: 'tasks.view', ownerColumns: OWNER_COLUMNS, notFound: 'Task', trx, forUpdate });

/** GET /tasks/:id */
export async function getTask(req, id) {
  const { row } = await loadTask(req, id);
  const [task] = await presentRows(req, [row]);
  return task;
}

/** A person or institute named on a task must be visible and known to the task's company. */
async function checkLinked(req, type, id, company, trx) {
  const path = `body.${type}Id`;
  let loaded;
  try {
    loaded = type === 'contact' ? await loadVisibleContact(req, id, { trx }) : await loadVisibleAccount(req, id, { trx });
  } catch (err) {
    if (err?.status === 404) throw errors.validation([{ path, message: type === 'contact' ? 'Contact not found' : 'Institute not found' }]);
    throw err;
  }
  if (!loaded.links.some((link) => link.company_id === company.id && !link.archived_at)) {
    throw errors.validation([{ path, message: `Not known to ${company.name}` }]);
  }
}

async function checkAssignee(assigneeId, unit, trx) {
  if (!assigneeId) return;
  if (!(await userLevelAt(assigneeId, unit, 'tasks.view', { trx }))) {
    throw errors.validation([{ path: 'body.assigneeUserId', message: "This person doesn't work on tasks here" }]);
  }
}

function checkReminder(reminderAt, dueAt) {
  if (reminderAt && dueAt && new Date(reminderAt).getTime() > new Date(dueAt).getTime()) {
    throw errors.validation([{ path: 'body.reminderAt', message: 'Remind before the task is due' }]);
  }
}

const auditUnit = (task) => ({ id: task.unit_id, root_id: task.group_id });
const isoOrNull = (value) => (value ? new Date(value).toISOString() : null);

async function emitTaskEvent(trx, req, task, type, payload) {
  await emitEvent(trx, {
    type,
    groupId: task.group_id,
    unitId: task.unit_id,
    aggregateType: 'task',
    aggregateId: task.id,
    actorUserId: req.auth.user.id,
    payload,
  });
}

/** The task timeline entry on the related record, if any (contract §11.2). */
async function addTaskEntry(trx, req, task, action, title) {
  if (!task.deal_id && !task.contact_id && !task.account_id) return;
  await addTimelineEvent(trx, {
    groupId: task.group_id,
    companyId: task.company_id,
    unitId: task.unit_id,
    dealId: task.deal_id,
    contactId: task.contact_id,
    accountId: task.account_id,
    kind: 'task',
    direction: 'internal',
    title,
    meta: { action, taskId: task.id, ...(task.due_at ? { dueAt: isoOrNull(task.due_at) } : {}) },
    actorType: 'user',
    actorUserId: req.auth.user.id,
    // Planning a follow-up is not activity with the customer.
    touchDeal: false,
  });
}

/** POST /tasks */
export async function createTask(req, body) {
  checkReminder(body.reminderAt, body.dueAt);
  const userId = req.auth.user.id;
  const task = await db.transaction(async (trx) => {
    let deal = null;
    let target;
    if (body.dealId) {
      deal = await loadVisibleDeal(req, body.dealId, { trx });
      target = await requireCreateUnit(req, deal.unit_id, 'tasks.manage', { trx, path: 'body.dealId' });
    } else {
      if (!body.unitId) throw errors.validation([{ path: 'body.unitId', message: 'Pick where this task belongs' }]);
      target = await requireCreateUnit(req, body.unitId, 'tasks.manage', { trx });
    }
    const { unit, company } = target;
    if (body.contactId && body.contactId !== deal?.primary_contact_id) await checkLinked(req, 'contact', body.contactId, company, trx);
    if (body.accountId && body.accountId !== deal?.account_id) await checkLinked(req, 'account', body.accountId, company, trx);
    const assigneeId = body.assigneeUserId === undefined ? userId : body.assigneeUserId;
    await checkAssignee(assigneeId, unit, trx);

    const [row] = await trx('tasks')
      .insert({
        ...ownedColumns({ unit, company }),
        title: body.title,
        notes: body.notes ?? null,
        kind: body.kind,
        priority: body.priority,
        status: 'open',
        due_at: body.dueAt ?? null,
        reminder_at: body.reminderAt ?? null,
        assignee_user_id: assigneeId,
        deal_id: deal?.id ?? null,
        // A task on a deal also shows for its main person and institute.
        contact_id: body.contactId ?? deal?.primary_contact_id ?? null,
        account_id: body.accountId ?? deal?.account_id ?? null,
        created_by: userId,
      })
      .returning('*');

    await addTaskEntry(trx, req, row, 'task.created', `Task: ${row.title}`);
    await writeAudit(trx, req, {
      action: 'task.created',
      entityType: 'task',
      entityId: row.id,
      unit: auditUnit(row),
      after: { title: row.title, kind: row.kind, priority: row.priority, dueAt: isoOrNull(row.due_at), assigneeUserId: row.assignee_user_id, dealId: row.deal_id, contactId: row.contact_id, accountId: row.account_id },
    });
    await emitTaskEvent(trx, req, row, 'task.created', {
      taskId: row.id,
      companyId: row.company_id,
      unitId: row.unit_id,
      assigneeUserId: row.assignee_user_id,
      dueAt: isoOrNull(row.due_at),
      dealId: row.deal_id,
      contactId: row.contact_id,
      accountId: row.account_id,
    });
    return row;
  });
  const [presented] = await presentRows(req, [task]);
  return presented;
}

const EDITABLE = {
  title: 'title',
  notes: 'notes',
  kind: 'kind',
  priority: 'priority',
  dueAt: 'due_at',
  reminderAt: 'reminder_at',
  assigneeUserId: 'assignee_user_id',
};

const sameValue = (column, a, b) => {
  if (column === 'due_at' || column === 'reminder_at') return (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
  return (a ?? null) === (b ?? null);
};

/** Load a task to change: visible (404) and tasks.manage on it (403, own respected). */
async function loadTaskToManage(req, id, trx) {
  const { row } = await loadTask(req, id, { trx, forUpdate: true });
  await requireRecord(req, 'tasks.manage', row, { ownerColumns: OWNER_COLUMNS, trx, message: "You can't change this task" });
  return row;
}

/** PATCH /tasks/:id */
export async function updateTask(req, id, body) {
  const task = await db.transaction(async (trx) => {
    const row = await loadTaskToManage(req, id, trx);
    const changes = {};
    for (const [key, column] of Object.entries(EDITABLE)) {
      if (body[key] === undefined) continue;
      if (!sameValue(column, row[column], body[key])) changes[column] = body[key];
    }
    const dueAt = 'due_at' in changes ? changes.due_at : row.due_at;
    const reminderAt = 'reminder_at' in changes ? changes.reminder_at : row.reminder_at;
    checkReminder(reminderAt, dueAt);
    if (Object.keys(changes).length === 0) return row;

    if ('assignee_user_id' in changes) {
      const unit = (await unitsIndex(req, trx)).get(row.unit_id);
      if (!unit) throw errors.notFound('Task');
      await checkAssignee(changes.assignee_user_id, unit, trx);
    }
    if ('due_at' in changes || 'reminder_at' in changes) changes.reminder_sent_at = null;
    const [updated] = await trx('tasks')
      .where({ id: row.id })
      .update({ ...changes, updated_at: trx.fn.now() })
      .returning('*');

    const changed = Object.entries(EDITABLE)
      .filter(([, column]) => column in changes)
      .map(([key]) => key);
    const before = {};
    const after = {};
    for (const key of changed) {
      if (key === 'notes') continue; // free text: logged by name only
      before[key] = key === 'dueAt' || key === 'reminderAt' ? isoOrNull(row[EDITABLE[key]]) : row[EDITABLE[key]];
      after[key] = key === 'dueAt' || key === 'reminderAt' ? isoOrNull(updated[EDITABLE[key]]) : updated[EDITABLE[key]];
    }
    await writeAudit(trx, req, {
      action: 'task.updated',
      entityType: 'task',
      entityId: row.id,
      unit: auditUnit(row),
      before,
      after,
      meta: { changed },
    });
    await emitTaskEvent(trx, req, updated, 'task.updated', { taskId: row.id, changes: changed });
    if ('assignee_user_id' in changes) {
      await emitTaskEvent(trx, req, updated, 'task.assigned', {
        taskId: row.id,
        fromUserId: row.assignee_user_id ?? null,
        toUserId: updated.assignee_user_id ?? null,
      });
    }
    return updated;
  });
  const [presented] = await presentRows(req, [task]);
  return presented;
}

const TRANSITIONS = {
  complete: { from: ['open'], status: 'done', action: 'task.completed', conflict: 'This task is already done or cancelled' },
  reopen: { from: ['done', 'cancelled'], status: 'open', action: 'task.reopened', conflict: 'This task is already open' },
  cancel: { from: ['open'], status: 'cancelled', action: 'task.cancelled', conflict: 'Only open tasks can be cancelled' },
};

/** POST /tasks/:id/complete, /reopen, /cancel */
export async function transitionTask(req, id, transition) {
  const spec = TRANSITIONS[transition];
  const userId = req.auth.user.id;
  const task = await db.transaction(async (trx) => {
    const row = await loadTaskToManage(req, id, trx);
    if (!spec.from.includes(row.status)) throw errors.conflict(spec.conflict, { status: row.status });
    const done = spec.status === 'done';
    const [updated] = await trx('tasks')
      .where({ id: row.id })
      .update({
        status: spec.status,
        completed_at: done ? trx.fn.now() : null,
        completed_by: done ? userId : null,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    if (done) await addTaskEntry(trx, req, updated, 'task.completed', `Completed: ${updated.title}`);
    await writeAudit(trx, req, {
      action: spec.action,
      entityType: 'task',
      entityId: row.id,
      unit: auditUnit(row),
      before: { status: row.status },
      after: { status: updated.status },
    });
    const payload = done
      ? { taskId: row.id, companyId: row.company_id, completedBy: userId, dealId: row.deal_id, contactId: row.contact_id, accountId: row.account_id }
      : { taskId: row.id };
    await emitTaskEvent(trx, req, updated, spec.action, payload);
    return updated;
  });
  const [presented] = await presentRows(req, [task]);
  return presented;
}
