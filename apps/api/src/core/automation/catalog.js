/**
 * Built-in triggers, actions and AI agents from the automation brief:
 *
 *   triggers  new enquiry, stage change, booking, meeting ended, payment event,
 *             time-based (schedule), no activity
 *   actions   send template, create task, change stage, assign, update field, call webhook
 *   agents    intake extraction, classifier, reply assistant, meeting summariser,
 *             follow-up writer (human approval), payment chaser, B2B qualifier
 *
 * These are declarations only: keys, labels, zod schemas and samples. Effects are
 * performed by the executor (wave 2), which binds a handler to each action key.
 * Domain event names follow the phase 1 convention (`aggregate.past_tense`); the
 * modules that emit them (deals, scheduling, payments) must use these names or
 * update `events` here.
 */
import { z } from 'zod';
import { parseDuration, nextTimeOfDay, DURATION_UNITS, toMs } from './time.js';
import { checkWebhookUrlTemplate } from './url-safety.js';
import { timeOfDaySchema, timeZoneSchema, daysOfWeekSchema, durationSchema } from './schema.js';

const uuid = z.uuid();
const text = (max) => z.string().trim().min(1).max(max);
const sampleIds = {
  deal: '6f1c7a52-3d6e-4f3a-9a51-2b8e7c1d9e01',
  contact: '0b6c4e8a-7f21-4c55-8d0e-5a9b3c2d1e02',
  owner: '9d2e5f7a-1b3c-4d6e-8f9a-0b1c2d3e4f03',
  pipeline: 'a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c04',
  booking: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e05',
  meeting: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f06',
  payment: 'e7f8a9b0-c1d2-4e3f-8a4b-5c6d7e8f9a07',
};

// ---------------------------------------------------------------------------
// Triggers

const PAYMENT_EVENTS = Object.freeze({
  succeeded: 'payment.succeeded',
  failed: 'payment.failed',
  refunded: 'payment.refunded',
  link_expired: 'payment_link.expired',
  instalment_overdue: 'instalment.overdue',
});

const BOOKING_EVENTS = Object.freeze({
  created: 'booking.created',
  rescheduled: 'booking.rescheduled',
  cancelled: 'booking.cancelled',
});

const kindsFor = (map) => z.array(z.enum(/** @type {[string, ...string[]]} */ (Object.keys(map)))).min(1).optional();

export const CORE_TRIGGERS = [
  {
    key: 'enquiry.new',
    label: 'New enquiry',
    description: 'A new enquiry or lead arrives from any channel (form, WhatsApp, call, import, manual).',
    events: ['deal.created'],
    subject: 'deal',
    config: z.strictObject({ channels: z.array(text(40)).min(1).max(20).optional() }),
    match: (config, event) => !config.channels || config.channels.includes(event.payload?.channel),
    sample: {
      type: 'deal.created',
      subject: { type: 'deal', id: sampleIds.deal },
      payload: { dealId: sampleIds.deal, contactId: sampleIds.contact, ownerId: sampleIds.owner, pipelineKey: 'b2c-admissions', stage: 'new', channel: 'form', source: 'website', course: 'JEE 2027' },
    },
  },
  {
    key: 'deal.stage_changed',
    label: 'Stage changed',
    description: 'A deal moves from one pipeline stage to another.',
    events: ['deal.stage_changed'],
    subject: 'deal',
    config: z.strictObject({ pipelineId: uuid.optional(), fromStage: text(64).optional(), toStage: text(64).optional() }),
    match: (config, event) =>
      (!config.pipelineId || event.payload?.pipelineId === config.pipelineId) &&
      (!config.fromStage || event.payload?.fromStage === config.fromStage) &&
      (!config.toStage || event.payload?.toStage === config.toStage),
    sample: {
      type: 'deal.stage_changed',
      subject: { type: 'deal', id: sampleIds.deal },
      payload: { dealId: sampleIds.deal, pipelineId: sampleIds.pipeline, fromStage: 'new', toStage: 'counselling_booked' },
    },
  },
  {
    key: 'booking.event',
    label: 'Booking made or changed',
    description: 'A counselling session, demo or visit is booked, rescheduled or cancelled.',
    events: Object.values(BOOKING_EVENTS),
    subject: 'deal',
    config: z.strictObject({ kinds: kindsFor(BOOKING_EVENTS) }),
    match: (config, event) => !config.kinds || config.kinds.some((kind) => BOOKING_EVENTS[kind] === event.type),
    sample: {
      type: 'booking.created',
      subject: { type: 'deal', id: sampleIds.deal },
      payload: { bookingId: sampleIds.booking, dealId: sampleIds.deal, startsAt: '2026-11-10T05:30:00Z', timeZone: 'Asia/Kolkata', kind: 'counselling' },
    },
  },
  {
    key: 'meeting.ended',
    label: 'Meeting ended',
    description: 'A booked meeting has finished (with attendance, notes or a transcript when available).',
    events: ['meeting.ended'],
    subject: 'deal',
    config: z.strictObject({ attendance: z.enum(['attended', 'no_show']).optional() }),
    match: (config, event) => !config.attendance || event.payload?.attendance === config.attendance,
    sample: {
      type: 'meeting.ended',
      subject: { type: 'deal', id: sampleIds.deal },
      payload: { meetingId: sampleIds.meeting, dealId: sampleIds.deal, attendance: 'attended', durationMinutes: 32, notes: 'Parent keen on weekend batch; asked about fee instalments.' },
    },
  },
  {
    key: 'payment.event',
    label: 'Payment event',
    description: 'A payment succeeds, fails or is refunded, a payment link expires, or an instalment becomes overdue.',
    events: Object.values(PAYMENT_EVENTS),
    subject: 'deal',
    config: z.strictObject({ kinds: kindsFor(PAYMENT_EVENTS) }),
    match: (config, event) => !config.kinds || config.kinds.some((kind) => PAYMENT_EVENTS[kind] === event.type),
    sample: {
      type: 'payment.failed',
      subject: { type: 'deal', id: sampleIds.deal },
      payload: { paymentId: sampleIds.payment, dealId: sampleIds.deal, amount: { minor: 2500000, currency: 'INR' }, reason: 'card_declined' },
    },
  },
  {
    key: 'schedule',
    label: 'On a schedule',
    description: 'Runs at a local time of day, on chosen weekdays. Each firing starts one run with no subject.',
    events: ['automation.schedule_tick'],
    subject: null,
    config: z.strictObject({ timeOfDay: timeOfDaySchema, timeZone: timeZoneSchema, daysOfWeek: daysOfWeekSchema.optional() }),
    match: () => true,
    sample: { type: 'automation.schedule_tick', subject: null, payload: { scheduledFor: '2026-11-05T03:30:00Z' } },
  },
  {
    key: 'no_activity',
    label: 'No activity',
    description: 'A deal or contact has had no activity (messages, calls, notes, stage changes) for a while.',
    events: ['automation.no_activity'],
    subject: 'deal',
    config: z.strictObject({
      entity: z.enum(['deal', 'contact']).default('deal'),
      after: durationSchema({ min: DURATION_UNITS.h, max: 180 * DURATION_UNITS.d }),
      stages: z.array(text(64)).min(1).max(50).optional(),
    }),
    match: (config, event) => (!config.entity || event.subject?.type === config.entity) && (!config.stages || config.stages.includes(event.payload?.stage)),
    sample: {
      type: 'automation.no_activity',
      subject: { type: 'deal', id: sampleIds.deal },
      payload: { lastActivityAt: '2026-11-01T06:00:00Z', stage: 'counselling_done', ownerId: sampleIds.owner },
    },
  },
];

/**
 * Next firing of a schedule trigger strictly after `after`, as epoch ms.
 * The scheduler uses `${flowKey}@${iso}` as the tick event id so a firing starts one run.
 * @param {{ timeOfDay: string, timeZone: string, daysOfWeek?: number[] }} config
 * @param {number | string | Date} after
 */
export function nextScheduleFire(config, after) {
  return nextTimeOfDay(toMs(after), config.timeOfDay, config.timeZone, config.daysOfWeek);
}

/**
 * For the no-activity scanner: subjects whose last activity is before this instant are quiet.
 * @param {{ after: string }} config
 * @param {number | string | Date} now
 */
export function noActivityCutoff(config, now) {
  const ms = parseDuration(config.after);
  if (ms === null) throw new RangeError(`"${config.after}" is not a duration`);
  return toMs(now) - ms;
}

/**
 * The event id for one quiet period of one subject, so rescans don't start a second run
 * until there has been new activity.
 * @param {string} flowKey
 * @param {{ type: string, id: string }} subject
 * @param {string} lastActivityAt ISO instant
 */
export function noActivityEventId(flowKey, subject, lastActivityAt) {
  return `${flowKey}:no_activity:${subject.type}:${subject.id}:${lastActivityAt}`;
}

// ---------------------------------------------------------------------------
// Actions

const BLOCKED_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'trailer',
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-phoenix-signature', 'x-phoenix-client',
]);

const webhookUrl = z
  .string()
  .max(2000)
  .superRefine((url, ctx) => {
    const result = checkWebhookUrlTemplate(url);
    // static: judged on the saved text even when it contains {{ }} (the host part is fixed).
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.message, params: { code: result.code, static: true } });
  });

const jsonValue = z.unknown().superRefine((value, ctx) => {
  let size;
  try {
    size = JSON.stringify(value ?? null).length;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Must be plain JSON data' });
    return;
  }
  if (size > 64 * 1024) ctx.addIssue({ code: 'custom', message: 'Keep the body under 64 KB' });
});

const PROTECTED_FIELDS = new Set(['id', 'groupId', 'unitId', 'ownerId', 'stage', 'pipelineId', 'createdAt', 'updatedAt', 'deletedAt']);

export const CORE_ACTIONS = [
  {
    key: 'messaging.send_template',
    label: 'Send template',
    description: 'Send an approved WhatsApp, email or SMS template to the contact, their guardian or the record owner. The executor applies consent and quiet hours.',
    sideEffect: true,
    params: z.strictObject({
      channel: z.enum(['whatsapp', 'email', 'sms']),
      template: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/, 'Use the template key'),
      recipient: z.enum(['contact', 'guardian', 'owner']).default('contact'),
      variables: z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.union([z.string().max(1000), z.number()])).optional(),
      locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
    }),
    output: z.object({ messageId: z.string() }).loose(),
    sampleOutput: { messageId: 'msg_sample_1' },
  },
  {
    key: 'tasks.create',
    label: 'Create task',
    description: 'Create a task on the record, for its owner or a named person.',
    sideEffect: true,
    params: z
      .strictObject({
        title: text(200),
        description: z.string().max(2000).optional(),
        /** Due this long after the task is created, e.g. 2h. */
        dueIn: durationSchema({ min: 0, max: 365 * DURATION_UNITS.d }).optional(),
        /** Or due at an instant. */
        dueAt: z.iso.datetime({ offset: true }).optional(),
        assignee: z.union([z.literal('owner'), uuid]).default('owner'),
        priority: z.enum(['low', 'normal', 'high']).default('normal'),
      })
      .refine((p) => !(p.dueIn && p.dueAt), 'Use dueIn or dueAt, not both'),
    output: z.object({ taskId: z.string() }).loose(),
    sampleOutput: { taskId: 'task_sample_1' },
  },
  {
    key: 'deals.change_stage',
    label: 'Change stage',
    description: "Move the run's deal to another stage of its pipeline.",
    sideEffect: true,
    params: z.strictObject({ stage: text(64), pipelineId: uuid.optional(), reason: z.string().max(200).optional() }),
  },
  {
    key: 'records.assign',
    label: 'Assign',
    description: "Give the run's record to a person, or to someone in a team by round robin or lowest load.",
    sideEffect: true,
    params: z
      .strictObject({
        strategy: z.enum(['user', 'round_robin', 'least_loaded']),
        userId: uuid.optional(),
        teamUnitId: uuid.optional(),
      })
      .refine((p) => (p.strategy === 'user' ? Boolean(p.userId) : Boolean(p.teamUnitId)), 'Choose a person for "user", or a team for round robin and lowest load'),
    output: z.object({ userId: z.string() }).loose(),
    sampleOutput: { userId: sampleIds.owner },
  },
  {
    key: 'records.update_field',
    label: 'Update field',
    description: "Set a field (including custom fields, e.g. custom.grade) on the run's record. Stage and owner have their own actions.",
    sideEffect: true,
    params: z.strictObject({
      field: z
        .string()
        .max(100)
        .regex(/^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/, 'Use a field key such as city or custom.grade')
        .refine((f) => !PROTECTED_FIELDS.has(f) && !f.split('.').includes('__proto__'), 'This field cannot be changed by a flow'),
      value: jsonValue,
    }),
  },
  {
    key: 'http.call_webhook',
    label: 'Call webhook',
    description: 'POST JSON to an external https endpoint, signed with the secret of a connection. Private and internal addresses are refused.',
    sideEffect: true,
    /** The link must be written out ({{ }} allowed after the host), never a whole { $expr }. */
    staticParams: ['url'],
    params: z.strictObject({
      url: webhookUrl,
      method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
      headers: z
        .record(
          z
            .string()
            .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'Not a valid header name')
            .refine((h) => !BLOCKED_HEADERS.has(h.toLowerCase()) && !h.toLowerCase().startsWith('proxy-'), 'This header is set by the platform or not allowed'),
          z.string().max(1000).regex(/^[^\r\n]*$/, 'Header values must be one line'),
        )
        .refine((h) => Object.keys(h).length <= 20, 'Use at most 20 headers')
        .optional(),
      body: jsonValue.optional(),
      /** Integration connection whose secret signs the request (X-Phoenix-Signature). */
      connectionId: uuid.optional(),
      timeoutMs: z.int().min(1000).max(10_000).default(10_000),
    }),
    output: z.object({ status: z.int() }).loose(),
    sampleOutput: { status: 200 },
  },
  // Emitted by the interpreter for ai_step and approval steps; not usable as action steps.
  {
    key: 'ai.run',
    label: 'Run AI agent',
    internal: true,
    sideEffect: false,
    params: z.strictObject({ agent: z.string(), input: z.record(z.string(), z.unknown()) }),
  },
  {
    key: 'automation.request_approval',
    label: 'Ask for approval',
    internal: true,
    sideEffect: true,
    params: z.strictObject({
      title: z.string().max(200),
      body: z.string().max(5000).optional(),
      approvers: z.strictObject({ permission: z.string().optional(), userIds: z.array(z.string()).optional(), owner: z.boolean().optional() }),
      data: z.record(z.string(), z.unknown()).optional(),
      expiresAt: z.string().nullable(),
    }),
  },
];

// ---------------------------------------------------------------------------
// AI agents

const confidence = z.number().min(0).max(1);
const channel = z.enum(['whatsapp', 'email', 'sms', 'call', 'form', 'other']);

export const CORE_AGENTS = [
  {
    key: 'intake_extraction',
    label: 'Intake extraction',
    description: 'Reads a free-text enquiry (WhatsApp, email, call notes) and pulls out the student, course, city, grade and contact details.',
    requiresApproval: false,
    input: z.strictObject({ text: text(20_000), channel: channel.optional() }),
    output: z.strictObject({ fields: z.record(z.string(), z.unknown()), confidence, missing: z.array(z.string()).max(50) }),
    sampleOutput: { fields: { studentName: 'Aarav Sharma', course: 'JEE 2027', city: 'Pune', grade: '11' }, confidence: 0.86, missing: ['email'] },
  },
  {
    key: 'classifier',
    label: 'Classifier',
    description: 'Puts a message or record into one of the labels you list (intent, urgency, segment).',
    requiresApproval: false,
    input: z.strictObject({ text: text(20_000), labels: z.array(text(60)).min(2).max(20) }),
    output: z.strictObject({ label: z.string().max(60), confidence }),
    sampleOutput: { label: 'admission_enquiry', confidence: 0.91 },
  },
  {
    key: 'reply_assistant',
    label: 'Reply assistant',
    description: 'Drafts a reply to an incoming message for a person to check and send.',
    requiresApproval: true,
    input: z.strictObject({ message: text(20_000), tone: z.enum(['warm', 'formal', 'brief']).default('warm'), context: z.string().max(5000).optional() }),
    output: z.strictObject({ draft: z.string().max(5000), confidence }),
    sampleOutput: { draft: 'Thank you for your interest in our JEE 2027 programme. Could we call you this evening?', confidence: 0.8 },
  },
  {
    key: 'meeting_summariser',
    label: 'Meeting summariser',
    description: 'Summarises a meeting from its notes or transcript and lists the action items.',
    requiresApproval: false,
    input: z
      .strictObject({ transcript: z.string().max(200_000).optional(), notes: z.string().max(20_000).optional() })
      .refine((i) => Boolean(i.transcript || i.notes), 'Give a transcript or notes'),
    output: z.strictObject({
      summary: z.string().max(5000),
      actionItems: z.array(z.strictObject({ text: z.string().max(500), owner: z.string().max(120).optional(), due: z.string().max(40).optional() })).max(30),
      nextStep: z.string().max(500).optional(),
    }),
    sampleOutput: { summary: 'Parent wants the weekend batch and asked about instalments.', actionItems: [{ text: 'Send instalment plan', owner: 'counsellor' }], nextStep: 'Share fee plan' },
  },
  {
    key: 'followup_writer',
    label: 'Follow-up writer',
    description: 'Writes a follow-up message. A person must approve it before it is sent.',
    requiresApproval: true,
    input: z.strictObject({ purpose: text(500), channel: z.enum(['whatsapp', 'email', 'sms']), facts: z.string().max(5000).optional() }),
    output: z.strictObject({ draft: z.string().max(5000), subject: z.string().max(200).optional() }),
    sampleOutput: { draft: 'Hi Aarav, following up on your counselling session yesterday...', subject: 'Your JEE 2027 plan' },
  },
  {
    key: 'payment_chaser',
    label: 'Payment chaser',
    description: 'Writes a polite reminder for a pending payment or instalment, and says when to hand over to a person.',
    requiresApproval: false,
    input: z.strictObject({
      amountMinor: z.int().min(1),
      currency: z.string().regex(/^[A-Z]{3}$/, 'Use an ISO 4217 currency code'),
      dueAt: z.iso.datetime({ offset: true }),
      attempt: z.int().min(1).max(20),
    }),
    output: z.strictObject({ message: z.string().max(2000), tone: z.enum(['gentle', 'firm', 'final']), escalate: z.boolean() }),
    sampleOutput: { message: 'A gentle reminder that the instalment of ₹25,000 was due on 1 November.', tone: 'gentle', escalate: false },
  },
  {
    key: 'b2b_qualifier',
    label: 'B2B qualifier',
    description: 'Scores an institute lead for the ERP and test software and explains why.',
    requiresApproval: false,
    input: z.strictObject({
      institute: z.strictObject({ name: text(200), city: z.string().max(100).optional(), students: z.int().min(0).optional(), currentSoftware: z.string().max(200).optional() }),
      notes: z.string().max(10_000).optional(),
    }),
    output: z.strictObject({ score: z.int().min(0).max(100), tier: z.enum(['hot', 'warm', 'cold']), reasons: z.array(z.string().max(300)).max(10) }),
    sampleOutput: { score: 78, tier: 'hot', reasons: ['1,200 students', 'Unhappy with current ERP'] },
  },
];
