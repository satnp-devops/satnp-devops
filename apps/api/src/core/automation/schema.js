/**
 * The shape of a flow definition (one immutable version of a flow).
 *
 * A flow is a trigger plus a graph of steps. Steps point at each other by id
 * (`next`, `then`, `else`, `cases[].next`, `otherwise`, `onTimeout`, `onError`,
 * `onReject`); a missing pointer ends the run there. Runs are pinned to the
 * version they started on: editing a flow publishes version n + 1 and leaves
 * running runs on version n (see interpreter.js, VERSION_MISMATCH).
 *
 * This file checks shape only. Graph integrity, known actions and their params,
 * loops and expression roots are checked by validate.js against a registry.
 */
import { z } from 'zod';
import { ExprError, parse } from './expr.js';
import { parseDuration, isValidTimeZone, DURATION_UNITS } from './time.js';
import { parseTemplate } from './template.js';

export const FLOW_LIMITS = Object.freeze({
  maxSteps: 200,
  maxCases: 20,
  maxWait: 365 * DURATION_UNITS.d,
  minWait: 1000,
  maxEffectTimeout: 30 * DURATION_UNITS.d,
});

/** Step ids are used in expressions (steps.<id>.output), so they are identifiers. */
export const stepIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, 'Step ids use lowercase letters, digits and _, starting with a letter (max 48)');

export const flowKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{1,63}$/, 'Flow keys use lowercase letters, digits, - and _ (2 to 64 characters)');

/** Registry keys: module.action, e.g. tasks.create, ai.run */
export const registryKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, 'Keys look like module.name (lowercase, digits and _)');

/** A condition or filter. Syntax errors carry the column where they were found. */
export const expressionSchema = z
  .string()
  .min(1, 'Enter an expression')
  .max(2000)
  .superRefine((source, ctx) => {
    try {
      parse(source);
    } catch (error) {
      if (!(error instanceof ExprError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message, params: { column: error.column, code: error.code } });
    }
  });

/** Text that may contain {{ expression }} interpolations. */
export const templateTextSchema = (max = 2000) =>
  z
    .string()
    .max(max)
    .superRefine((text, ctx) => {
      try {
        parseTemplate(text);
      } catch (error) {
        if (!(error instanceof ExprError)) throw error;
        ctx.addIssue({ code: 'custom', message: error.message, params: { column: error.column, code: error.code } });
      }
    });

/**
 * A duration such as 3d, 2h or 1h30m, within bounds.
 * @param {{ min?: number, max?: number }} [bounds] milliseconds
 */
export const durationSchema = ({ min = FLOW_LIMITS.minWait, max = FLOW_LIMITS.maxWait } = {}) =>
  z.string().max(40).superRefine((text, ctx) => {
    const ms = parseDuration(text);
    if (ms === null) ctx.addIssue({ code: 'custom', message: `"${text}" is not a duration (e.g. 30m, 2h, 3d, 1w, 1h30m)` });
    else if (ms < min || ms > max) ctx.addIssue({ code: 'custom', message: `Use a duration between ${min / 1000}s and ${max / DURATION_UNITS.d}d` });
  });

export const timeZoneSchema = z.string().refine(isValidTimeZone, 'Use an IANA time zone name, such as Asia/Kolkata');

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:30');

export const daysOfWeekSchema = z
  .array(z.int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'List each day once (1 = Monday ... 7 = Sunday)');

const base = {
  id: stepIdSchema,
  label: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
};
const next = stepIdSchema.optional();
/** Params are free-form here; their schema comes from the registry (validate.js). */
const paramsSchema = z.record(z.string(), z.unknown());

export const conditionStepSchema = z.strictObject({
  ...base,
  type: z.literal('condition'),
  if: expressionSchema,
  then: next,
  else: next,
});

export const branchStepSchema = z.strictObject({
  ...base,
  type: z.literal('branch'),
  cases: z
    .array(z.strictObject({ label: z.string().max(120).optional(), when: expressionSchema, next }))
    .min(1)
    .max(FLOW_LIMITS.maxCases),
  otherwise: next,
});

const waitDurationSchema = z.strictObject({
  ...base,
  type: z.literal('wait'),
  mode: z.literal('duration'),
  duration: durationSchema(),
  next,
});

const waitUntilSchema = z.strictObject({
  ...base,
  type: z.literal('wait'),
  mode: z.literal('until'),
  /** Either an expression giving an instant (`trigger.payload.startsAt - 1h`) or the next local time of day. */
  until: z.union([
    z.strictObject({ at: expressionSchema }),
    z.strictObject({ timeOfDay: timeOfDaySchema, timeZone: timeZoneSchema.optional(), daysOfWeek: daysOfWeekSchema.optional() }),
  ]),
  next,
});

const waitEventSchema = z.strictObject({
  ...base,
  type: z.literal('wait'),
  mode: z.literal('event'),
  event: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, 'Use a domain event type such as meeting.ended'),
  filter: expressionSchema.optional(),
  timeout: durationSchema(),
  next,
  /** Where to go when the timeout passes first; without it the run continues at `next` with timedOut = true. */
  onTimeout: next,
});

export const waitStepSchema = z.discriminatedUnion('mode', [waitDurationSchema, waitUntilSchema, waitEventSchema]);

export const actionStepSchema = z.strictObject({
  ...base,
  type: z.literal('action'),
  action: registryKeySchema,
  params: paramsSchema.default({}),
  /** Pause until the executor reports the result (output at steps.<id>.output). */
  await: z.boolean().optional(),
  /** How long an awaited result may take before the step fails with EFFECT_TIMEOUT. */
  timeout: durationSchema({ max: FLOW_LIMITS.maxEffectTimeout }).optional(),
  next,
  onError: next,
});

export const aiStepSchema = z.strictObject({
  ...base,
  type: z.literal('ai_step'),
  agent: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, 'Agent keys use lowercase letters, digits and _'),
  input: paramsSchema.default({}),
  timeout: durationSchema({ max: FLOW_LIMITS.maxEffectTimeout }).optional(),
  next,
  onError: next,
});

export const approvalStepSchema = z.strictObject({
  ...base,
  type: z.literal('approval'),
  title: templateTextSchema(200),
  body: templateTextSchema(5000).optional(),
  approvers: z
    .strictObject({
      permission: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_*]*$/).optional(),
      userIds: z.array(z.uuid()).max(20).optional(),
      /** "owner" = the owner of the run's subject record. */
      owner: z.boolean().optional(),
    })
    .refine((a) => a.permission || a.userIds?.length || a.owner, 'Say who can approve: a permission, people, or the record owner'),
  /** What the approver sees and may edit, e.g. { draft: { $expr: 'steps.write.output.draft' } }. */
  data: paramsSchema.optional(),
  timeout: durationSchema().optional(),
  next,
  onReject: next,
  onTimeout: next,
});

export const endStepSchema = z.strictObject({
  ...base,
  type: z.literal('end'),
  outcome: z.enum(['completed', 'cancelled']).default('completed'),
  reason: z.string().max(200).optional(),
});

export const stepSchema = z.discriminatedUnion('type', [
  conditionStepSchema,
  branchStepSchema,
  waitStepSchema,
  actionStepSchema,
  aiStepSchema,
  approvalStepSchema,
  endStepSchema,
]);

export const STEP_TYPES = Object.freeze(['condition', 'branch', 'wait', 'action', 'ai_step', 'approval', 'end']);

export const triggerSchema = z.strictObject({
  /** A trigger key from the registry, e.g. enquiry.new, deal.stage_changed, schedule, no_activity. */
  type: registryKeySchema.or(z.enum(['schedule', 'no_activity'])),
  /** Checked against the triggering event: `trigger.payload.toStage == 'won'`. */
  filter: expressionSchema.optional(),
  /** Validated by the trigger's own config schema (validate.js). */
  config: z.record(z.string(), z.unknown()).optional(),
});

export const flowSettingsSchema = z.strictObject({
  /** Default zone for time-of-day waits. */
  timeZone: timeZoneSchema.default('Asia/Kolkata'),
  /** Hard cap on steps one run may execute over its life. */
  maxStepsPerRun: z.int().min(1).max(10_000).default(500),
  /**
   * Whether a subject may start this flow again: allow (always), skip_if_active
   * (not while a run for the same subject is still going), once (once per subject ever).
   */
  reentry: z.enum(['allow', 'skip_if_active', 'once']).default('skip_if_active'),
});

export const flowSchema = z.strictObject({
  key: flowKeySchema,
  version: z.int().min(1),
  name: z.string().trim().min(1, 'Name the flow').max(120),
  description: z.string().max(2000).optional(),
  trigger: triggerSchema,
  start: stepIdSchema,
  steps: z.array(stepSchema).min(1, 'Add at least one step').max(FLOW_LIMITS.maxSteps),
  settings: flowSettingsSchema.default({ timeZone: 'Asia/Kolkata', maxStepsPerRun: 500, reentry: 'skip_if_active' }),
});

/**
 * Step ids a step can go to, with the field that holds each pointer.
 * @param {z.infer<typeof stepSchema>} step
 * @returns {{ field: (string | number)[], to: string }[]}
 */
export function stepEdges(step) {
  const edges = [];
  const add = (field, to) => {
    if (to) edges.push({ field, to });
  };
  switch (step.type) {
    case 'condition':
      add(['then'], step.then);
      add(['else'], step.else);
      break;
    case 'branch':
      step.cases.forEach((c, i) => add(['cases', i, 'next'], c.next));
      add(['otherwise'], step.otherwise);
      break;
    case 'wait':
      add(['next'], step.next);
      if (step.mode === 'event') add(['onTimeout'], step.onTimeout);
      break;
    case 'action':
    case 'ai_step':
      add(['next'], step.next);
      add(['onError'], step.onError);
      break;
    case 'approval':
      add(['next'], step.next);
      add(['onReject'], step.onReject);
      add(['onTimeout'], step.onTimeout);
      break;
    default:
      break;
  }
  return edges;
}

/**
 * Steps that always pause the run, so a loop through one of them is not an infinite
 * loop. A wait until an expression's time is not one: when that time has already
 * passed, the run continues straight away.
 * @param {z.infer<typeof stepSchema>} step
 */
export function isPausingStep(step) {
  if (step.type === 'wait') return !(step.mode === 'until' && 'at' in step.until);
  return step.type === 'approval' || step.type === 'ai_step' || (step.type === 'action' && step.await === true);
}
