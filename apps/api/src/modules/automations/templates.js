/**
 * Flow templates: starting points offered by "New flow" and used by the seed. A template is only a
 * definition; creating a flow from it copies the definition into the company (which then owns and
 * edits it). Template keys are stable, so the seed can find the flows it made.
 *
 * Message templates (`template` params) are keys of the messaging module's approved templates;
 * the integrator makes sure each company has them (WhatsApp templates need Meta approval).
 * Stage and status checks use keys and statuses, not ids, so a template works in every company.
 */

const TZ = 'Asia/Kolkata';
const firstName = '{{ coalesce(record.contact.firstName, record.name) }}';

/** @type {{ key: string, name: string, description: string, kind: 'standard' | 'nurture', category: string, definition: object }[]} */
export const FLOW_TEMPLATES = [
  {
    key: 'new-enquiry-welcome',
    name: 'New enquiry: WhatsApp welcome and call task',
    description: 'Sends the welcome template on WhatsApp as soon as a family enquires, and gives the owner a call-back task due in two hours.',
    kind: 'standard',
    category: 'Admissions',
    definition: {
      trigger: { type: 'enquiry.new', filter: "record.kind == 'b2c' and trigger.payload.channel != 'import'" },
      start: 'welcome',
      steps: [
        {
          id: 'welcome',
          type: 'action',
          label: 'WhatsApp welcome',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'enquiry_welcome', recipient: 'contact', variables: { name: firstName, course: '{{ coalesce(record.productLineName, "our programmes") }}' } },
          next: 'call_task',
        },
        {
          id: 'call_task',
          type: 'action',
          label: 'Call-back task',
          action: 'tasks.create',
          params: { title: 'Call {{ record.name }} about their enquiry', dueIn: '2h', assignee: 'owner', priority: 'high' },
          next: 'done',
        },
        { id: 'done', type: 'end' },
      ],
      settings: { timeZone: TZ, maxStepsPerRun: 500, reentry: 'once' },
    },
  },
  {
    key: 'lost-lead-nurture',
    name: 'Lost lead: AI follow-up with approval',
    description: 'Two weeks after a lead is lost (with nurture on), the follow-up writer drafts a message; the owner approves or edits it before it goes out. A month later, a family still not enrolled gets the next-intake offer.',
    kind: 'nurture',
    category: 'Nurture',
    definition: {
      trigger: { type: 'deal.stage_changed', filter: "trigger.payload.toStatus == 'lost' and record.nurture" },
      start: 'cool_off',
      steps: [
        { id: 'cool_off', type: 'wait', label: 'Wait two weeks', mode: 'duration', duration: '14d', next: 'still_lost' },
        { id: 'still_lost', type: 'condition', label: 'Still lost?', if: "record.status == 'lost' and record.nurture", then: 'write', else: 'done' },
        {
          id: 'write',
          type: 'ai_step',
          label: 'Draft a follow-up',
          agent: 'followup_writer',
          input: {
            purpose: 'Re-engage a family who did not enrol in {{ coalesce(record.productLineName, "our programme") }}, warmly and without pressure',
            channel: 'whatsapp',
            facts: 'Lost reason: {{ coalesce(record.lostReason, "not given") }}. Student: {{ record.name }}.',
          },
          next: 'review',
          onError: 'done',
        },
        {
          id: 'review',
          type: 'approval',
          label: 'Owner approves',
          title: 'Send this follow-up to {{ record.name }}?',
          body: 'The follow-up writer drafted this WhatsApp message. Edit it if needed, then approve or reject.',
          approvers: { owner: true },
          data: { draft: { $expr: 'steps.write.output.draft' } },
          timeout: '3d',
          next: 'send',
          onReject: 'done',
          onTimeout: 'done',
        },
        {
          id: 'send',
          type: 'action',
          label: 'Send the follow-up',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'nurture_followup', recipient: 'contact', variables: { name: firstName, message: '{{ steps.review.output.data.draft }}' } },
          next: 'later',
        },
        { id: 'later', type: 'wait', label: 'Wait a month', mode: 'duration', duration: '30d', next: 'still_lost_later' },
        { id: 'still_lost_later', type: 'condition', label: 'Still lost?', if: "record.status == 'lost' and record.nurture", then: 'offer', else: 'done' },
        {
          id: 'offer',
          type: 'action',
          label: 'Next-intake offer',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'nurture_next_intake', recipient: 'contact', variables: { name: firstName } },
          next: 'done',
        },
        { id: 'done', type: 'end' },
      ],
      settings: { timeZone: TZ, maxStepsPerRun: 500, reentry: 'skip_if_active' },
    },
  },
  {
    key: 'lost-lead-next-intake',
    name: 'Lost lead: next-intake updates',
    description: 'For lost leads with nurture on: a programme update after a month and the early-bird offer two months later, each only while the lead is still lost. No AI.',
    kind: 'nurture',
    category: 'Nurture',
    definition: {
      trigger: { type: 'deal.stage_changed', filter: "trigger.payload.toStatus == 'lost' and record.nurture" },
      start: 'month',
      steps: [
        { id: 'month', type: 'wait', label: 'Wait a month', mode: 'duration', duration: '30d', next: 'check_1' },
        { id: 'check_1', type: 'condition', label: 'Still lost?', if: "record.status == 'lost' and record.nurture", then: 'update', else: 'done' },
        {
          id: 'update',
          type: 'action',
          label: 'Programme update',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'nurture_programme_update', recipient: 'contact', variables: { name: firstName } },
          next: 'two_months',
        },
        { id: 'two_months', type: 'wait', label: 'Wait two months', mode: 'duration', duration: '60d', next: 'check_2' },
        { id: 'check_2', type: 'condition', label: 'Still lost?', if: "record.status == 'lost' and record.nurture", then: 'early_bird', else: 'done' },
        {
          id: 'early_bird',
          type: 'action',
          label: 'Early-bird offer',
          action: 'messaging.send_template',
          params: { channel: 'email', template: 'nurture_early_bird', recipient: 'contact', variables: { name: firstName } },
          next: 'done',
        },
        { id: 'done', type: 'end' },
      ],
      settings: { timeZone: TZ, maxStepsPerRun: 500, reentry: 'skip_if_active' },
    },
  },
  {
    key: 'booking-no-show-rebook',
    name: 'Missed session: send a rebook link',
    description: 'When a family misses a counselling session or demo, sends the rebook link on WhatsApp. If they have not booked again within two days, the owner gets a call task.',
    kind: 'standard',
    category: 'Bookings',
    definition: {
      trigger: { type: 'meeting.ended', config: { attendance: 'no_show' } },
      start: 'rebook',
      steps: [
        {
          id: 'rebook',
          type: 'action',
          label: 'Rebook link',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'meeting_rebook', recipient: 'contact', variables: { name: firstName, link: '{{ trigger.payload.rebookUrl }}' } },
          next: 'wait_booking',
        },
        {
          id: 'wait_booking',
          type: 'wait',
          label: 'Booked again?',
          mode: 'event',
          event: 'booking.created',
          filter: 'event.payload.dealId == trigger.payload.dealId',
          timeout: '2d',
          next: 'done',
          onTimeout: 'call_task',
        },
        {
          id: 'call_task',
          type: 'action',
          label: 'Call to rebook',
          action: 'tasks.create',
          params: { title: 'Call {{ record.name }} to rebook the missed session', dueIn: '4h', assignee: 'owner', priority: 'high' },
          next: 'done',
        },
        { id: 'done', type: 'end' },
      ],
      settings: { timeZone: TZ, maxStepsPerRun: 500, reentry: 'allow' },
    },
  },
  {
    key: 'payment-failed-chaser',
    name: 'Payment failed: reminder and follow-up',
    description: 'When a fee payment fails, the payment chaser writes a polite reminder that goes out on WhatsApp. If nothing is paid within three days, the owner gets a task.',
    kind: 'standard',
    category: 'Fees',
    definition: {
      trigger: { type: 'payment.event', config: { kinds: ['failed'] } },
      start: 'chase',
      steps: [
        {
          id: 'chase',
          type: 'ai_step',
          label: 'Write the reminder',
          agent: 'payment_chaser',
          input: {
            amountMinor: { $expr: 'trigger.payload.amount.minor' },
            currency: { $expr: 'trigger.payload.amount.currency' },
            dueAt: { $expr: 'coalesce(trigger.payload.dueAt, trigger.occurredAt)' },
            attempt: 1,
          },
          next: 'remind',
          onError: 'remind_plain',
        },
        {
          id: 'remind',
          type: 'action',
          label: 'Send the reminder',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'payment_reminder', recipient: 'contact', variables: { name: firstName, message: '{{ steps.chase.output.message }}' } },
          next: 'wait_paid',
        },
        {
          id: 'remind_plain',
          type: 'action',
          label: 'Standard reminder',
          action: 'messaging.send_template',
          params: { channel: 'whatsapp', template: 'payment_failed_standard', recipient: 'contact', variables: { name: firstName } },
          next: 'wait_paid',
        },
        {
          id: 'wait_paid',
          type: 'wait',
          label: 'Paid?',
          mode: 'event',
          event: 'payment.succeeded',
          filter: 'event.payload.dealId == trigger.payload.dealId',
          timeout: '3d',
          next: 'done',
          onTimeout: 'escalate',
        },
        {
          id: 'escalate',
          type: 'action',
          label: 'Owner follows up',
          action: 'tasks.create',
          params: { title: 'Payment still pending for {{ record.name }}', description: 'The automatic reminder went out three days ago and nothing has been paid.', dueIn: '1d', assignee: 'owner', priority: 'high' },
          next: 'done',
        },
        { id: 'done', type: 'end' },
      ],
      settings: { timeZone: TZ, maxStepsPerRun: 500, reentry: 'allow' },
    },
  },
  {
    key: 'quiet-deal-nudge',
    name: 'Quiet deal: nudge the owner',
    description: 'When an open deal has had no activity for five days in an early stage, the owner gets a task to get back in touch.',
    kind: 'standard',
    category: 'Admissions',
    definition: {
      trigger: { type: 'no_activity', config: { entity: 'deal', after: '5d', stages: ['contacted', 'demo_done', 'qualified', 'discovery_call'] } },
      start: 'nudge',
      steps: [
        {
          id: 'nudge',
          type: 'action',
          label: 'Nudge the owner',
          action: 'tasks.create',
          params: { title: 'No activity on {{ record.name }} for 5 days', dueIn: '4h', assignee: 'owner', priority: 'normal' },
          next: 'done',
        },
        { id: 'done', type: 'end' },
      ],
      settings: { timeZone: TZ, maxStepsPerRun: 500, reentry: 'skip_if_active' },
    },
  },
];

export const templateByKey = new Map(FLOW_TEMPLATES.map((t) => [t.key, t]));

/** API shape (types.ts AutomationTemplate). */
export function presentTemplate(template) {
  return {
    key: template.key,
    name: template.name,
    description: template.description,
    kind: template.kind,
    category: template.category,
    triggerType: template.definition.trigger.type,
    stepCount: template.definition.steps.length,
    definition: structuredClone(template.definition),
  };
}
