import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { idParams, timeZoneSchema } from '../../lib/schemas.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES } from '../../core/crm/constants.js';
import { csvList, dateTimeSchema, nullableText, ownerFilterSchema, pageQuery, requiredText } from '../../core/crm/schemas.js';
import { createTask, getTask, listTasks, taskCounts, transitionTask, updateTask } from './service.js';

// docs/crm/PHASE2_CONTRACT.md §9.9. Additions to the contract (reported): `companyId`, `related`,
// `completedAfter` and `due=later_today` on the list and counts; counts also return laterToday and
// the time zone used.

export const TASK_RELATED_TYPES = ['deal', 'contact', 'account', 'none'];
const DUE_FILTERS = ['overdue', 'today', 'later_today', 'upcoming', 'none'];

export const taskBody = z.strictObject({
  unitId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  title: requiredText(200),
  notes: nullableText(5000).optional(),
  kind: z.enum(TASK_KINDS).default('follow_up'),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  dueAt: dateTimeSchema.nullable().optional(),
  reminderAt: dateTimeSchema.nullable().optional(),
  assigneeUserId: z.uuid().nullable().optional(),
});

export const taskUpdateBody = z.strictObject({
  title: requiredText(200).optional(),
  notes: nullableText(5000).optional(),
  kind: z.enum(TASK_KINDS).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: dateTimeSchema.nullable().optional(),
  reminderAt: dateTimeSchema.nullable().optional(),
  assigneeUserId: z.uuid().nullable().optional(),
});

const filterFields = {
  unitId: z.uuid(),
  assignee: csvList(ownerFilterSchema, 50).optional(),
  companyId: z.uuid().optional(),
  related: csvList(z.enum(TASK_RELATED_TYPES), 4).optional(),
  tz: timeZoneSchema.optional(),
};

export const taskListQuery = z.strictObject({
  ...filterFields,
  status: csvList(z.enum(TASK_STATUSES), 3).optional(),
  due: z.enum(DUE_FILTERS).optional(),
  dealId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  priority: csvList(z.enum(TASK_PRIORITIES), 3).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  completedAfter: dateTimeSchema.optional(),
  sort: z.enum(['dueAt', '-dueAt', '-createdAt', '-completedAt']).optional(),
  ...pageQuery,
});

export const taskCountsQuery = z.strictObject(filterFields);

export function taskRoutes(router) {
  router.get(
    '/tasks/counts',
    describe({
      summary: 'Count open tasks by due group',
      description: "Overdue, today, later today, upcoming and no due date, in the viewer's time zone (tz, else the user's, else locale.timeZone).",
      permission: 'tasks.view',
      errors: [403, 404],
    }),
    requireAuth(),
    validate({ query: taskCountsQuery }),
    async (req, res) => {
      res.json({ data: await taskCounts(req, req.valid.query) });
    },
  );

  router.get(
    '/tasks',
    describe({
      summary: 'List tasks',
      description: 'My tasks by default (assignee = me, open, by due date). On a deal, person or institute every visible task is listed.',
      permission: 'tasks.view',
      list: true,
      errors: [403, 404],
    }),
    requireAuth(),
    validate({ query: taskListQuery }),
    async (req, res) => {
      res.json(await listTasks(req, req.valid.query));
    },
  );

  router.get(
    '/tasks/:id',
    describe({ summary: 'Get a task', permission: 'tasks.view', errors: [404] }),
    requireAuth(),
    validate({ params: idParams }),
    async (req, res) => {
      res.json({ data: await getTask(req, req.valid.params.id) });
    },
  );

  router.post(
    '/tasks',
    describe({
      summary: 'Create a task',
      description: 'On a deal (its unit) or at a unit, optionally about a person or institute. Emits `task.created` and adds a task entry to the related timeline.',
      permission: 'tasks.manage',
      status: 201,
      errors: [403, 404, 409, 422],
    }),
    requireAuth(),
    validate({ body: taskBody }),
    async (req, res) => {
      res.status(201).json({ data: await createTask(req, req.valid.body) });
    },
  );

  router.patch(
    '/tasks/:id',
    describe({
      summary: 'Update or reassign a task',
      description: 'Emits `task.updated`, and `task.assigned` when the assignee changes. A new due or reminder time resets the reminder.',
      permission: 'tasks.manage',
      errors: [403, 404, 422],
    }),
    requireAuth(),
    validate({ params: idParams, body: taskUpdateBody }),
    async (req, res) => {
      res.json({ data: await updateTask(req, req.valid.params.id, req.valid.body) });
    },
  );

  for (const [transition, summary] of [
    ['complete', 'Complete a task'],
    ['reopen', 'Reopen a task'],
    ['cancel', 'Cancel a task'],
  ]) {
    router.post(
      `/tasks/:id/${transition}`,
      describe({ summary, permission: 'tasks.manage', errors: [403, 404, 409] }),
      requireAuth(),
      validate({ params: idParams }),
      async (req, res) => {
        res.json({ data: await transitionTask(req, req.valid.params.id, transition) });
      },
    );
  }
}
