/** Sample flows and helpers shared by the automation tests. */
import { createAutomationRegistry } from '../../src/core/automation/registry.js';

export const registry = createAutomationRegistry();

export const NOW = Date.parse('2026-11-05T04:30:00Z'); // 10:00 in Asia/Kolkata, a Thursday
export const ids = {
  deal: '6f1c7a52-3d6e-4f3a-9a51-2b8e7c1d9e01',
  senior: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  team: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
};

export const enquiryEvent = (payload = {}) => ({
  id: 'evt-enquiry-1',
  type: 'deal.created',
  occurredAt: '2026-11-05T04:30:00Z',
  subject: { type: 'deal', id: ids.deal },
  payload: { dealId: ids.deal, channel: 'whatsapp', source: 'instagram', course: 'JEE 2027', ...payload },
});

/** New enquiry: classify, route hot leads to a senior counsellor, welcome, then wait for a booking. */
export const welcomeFlow = () => ({
  key: 'new-enquiry-welcome',
  version: 1,
  name: 'Welcome new enquiries',
  trigger: { type: 'enquiry.new', filter: "trigger.payload.channel != 'import'" },
  start: 'classify',
  steps: [
    {
      id: 'classify',
      type: 'ai_step',
      agent: 'classifier',
      input: { text: '{{ trigger.payload.course }} enquiry from {{ trigger.payload.source }}', labels: ['hot', 'warm', 'cold'] },
      next: 'route',
      onError: 'welcome',
    },
    {
      id: 'route',
      type: 'branch',
      cases: [{ label: 'Hot', when: "steps.classify.output.label == 'hot'", next: 'assign_senior' }],
      otherwise: 'welcome',
    },
    { id: 'assign_senior', type: 'action', action: 'records.assign', params: { strategy: 'user', userId: ids.senior }, next: 'welcome' },
    {
      id: 'welcome',
      type: 'action',
      action: 'messaging.send_template',
      params: { channel: 'whatsapp', template: 'welcome_v1', variables: { course: '{{ trigger.payload.course }}' } },
      next: 'wait_booking',
    },
    {
      id: 'wait_booking',
      type: 'wait',
      mode: 'event',
      event: 'booking.created',
      filter: 'event.payload.dealId == trigger.payload.dealId',
      timeout: '3d',
      next: 'done',
      onTimeout: 'nudge',
    },
    { id: 'nudge', type: 'action', action: 'tasks.create', params: { title: 'Call the {{ trigger.payload.course }} enquiry', dueIn: '2h' }, next: 'done' },
    { id: 'done', type: 'end' },
  ],
});

/** After a meeting: AI writes a follow-up, a person approves (and may edit) it, then it is sent. */
export const followupFlow = () => ({
  key: 'meeting-followup',
  version: 2,
  name: 'Follow up after meetings',
  trigger: { type: 'meeting.ended', config: { attendance: 'attended' } },
  start: 'write',
  steps: [
    { id: 'write', type: 'ai_step', agent: 'followup_writer', input: { purpose: 'Follow up on {{ trigger.payload.notes }}', channel: 'whatsapp' }, next: 'review' },
    {
      id: 'review',
      type: 'approval',
      title: 'Approve the follow-up for deal {{ trigger.payload.dealId }}',
      approvers: { owner: true },
      data: { draft: { $expr: 'steps.write.output.draft' } },
      timeout: '1d',
      next: 'send',
      onReject: 'task',
      onTimeout: 'task',
    },
    {
      id: 'send',
      type: 'action',
      action: 'messaging.send_template',
      params: { channel: 'whatsapp', template: 'free_text', variables: { body: '{{ steps.review.output.data.draft }}' } },
    },
    { id: 'task', type: 'action', action: 'tasks.create', params: { title: 'Write the follow-up yourself', priority: 'high' } },
  ],
});

/** Payment chaser: up to three reminders a day apart, looping through a wait. */
export const chaserFlow = () => ({
  key: 'payment-chaser',
  version: 1,
  name: 'Chase failed payments',
  trigger: { type: 'payment.event', config: { kinds: ['failed'] } },
  start: 'chase',
  steps: [
    {
      id: 'chase',
      type: 'ai_step',
      agent: 'payment_chaser',
      input: {
        amountMinor: { $expr: 'trigger.payload.amount.minor' },
        currency: { $expr: 'trigger.payload.amount.currency' },
        dueAt: { $expr: 'trigger.occurredAt' },
        attempt: { $expr: 'coalesce(steps.chase.visit, 0) + 1' },
      },
      next: 'remind',
    },
    {
      id: 'remind',
      type: 'action',
      action: 'messaging.send_template',
      params: { channel: 'sms', template: 'payment_reminder', variables: { text: '{{ steps.chase.output.message }}' } },
      next: 'pause',
    },
    { id: 'pause', type: 'wait', mode: 'duration', duration: '1d', next: 'again' },
    { id: 'again', type: 'condition', if: 'steps.chase.visit < 3', then: 'chase', else: 'stop' },
    { id: 'stop', type: 'end', reason: 'three reminders sent' },
  ],
});

export const paymentEvent = () => ({
  id: 'evt-pay-1',
  type: 'payment.failed',
  occurredAt: '2026-11-05T04:30:00Z',
  subject: { type: 'deal', id: ids.deal },
  payload: { dealId: ids.deal, amount: { minor: 2500000, currency: 'INR' } },
});

/** A minimal valid flow with the given steps (start = first step). */
export const flowWith = (steps, extra = {}) => ({
  key: 'test-flow',
  version: 1,
  name: 'Test flow',
  trigger: { type: 'enquiry.new' },
  start: steps[0]?.id ?? 'a',
  steps,
  ...extra,
});

export const at = (offsetMs) => NOW + offsetMs;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
