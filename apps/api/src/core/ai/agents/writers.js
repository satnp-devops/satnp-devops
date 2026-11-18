import { z } from 'zod';
import { clip } from '../text.js';
import { writeFollowUp, writePaymentReminder } from '../mock/writers.js';
import { confidence, defineAgent, nullableText } from './common.js';

// The follow-up writer (a person approves every draft before it is sent) and the payment chaser.

const CHANNELS = ['whatsapp', 'email', 'sms'];
const language = z.string().regex(/^[a-z]{2}$/).optional().describe('ISO 639-1; hi writes Hinglish');

export const followUpOutput = z
  .object({
    channel: z.enum(CHANNELS),
    subject: nullableText(200).describe('Email subject; null for WhatsApp and SMS'),
    message: z.string().max(1500),
    confidence,
  })
  .meta({ id: 'AiFollowUpOutput' });

export const followUpAgent = defineAgent({
  key: 'follow_up',
  label: 'Follow-up writer',
  description: 'Drafts a personal follow-up for a lead (book a demo, share details, check in, re-engage). A person approves every draft before it is sent.',
  task: 'generate',
  purpose: 'followup.write',
  defaultThreshold: 0.6,
  alwaysReview: true,
  customerFacing: true,
  onTopic: 'handover',
  maxTokens: 1024,
  inputSchema: z.strictObject({
    contactName: z.string().max(120).optional(),
    studentName: z.string().max(120).optional(),
    exam: z.string().max(60).optional(),
    channel: z.enum(CHANNELS).default('whatsapp'),
    goal: z.enum(['book_demo', 'share_details', 'check_in', 'reengage', 'next_step']).default('check_in'),
    lastInteraction: z.string().max(4000).optional().describe('What happened last: notes or the last messages'),
    counsellorName: z.string().max(120).optional(),
    bookingLink: z.url({ protocol: /^https$/ }).max(500).optional(),
    language,
  }),
  outputSchema: followUpOutput,
  instructions:
    'Write one short, warm, personal follow-up message from the counsellor for the goal given. Use the names and facts in the context only. ' +
    'Match the language asked for (Hinglish for hi). WhatsApp and SMS: no subject, at most three sentences. Email: a subject and a short body. ' +
    'Include the booking link only if one is given. Never promise anything that is not in the facts.',
  untrusted: (input) => input.lastInteraction ?? '',
  facts: (input, context) => ({
    company: context.companyName,
    contactName: input.contactName ?? null,
    studentName: input.studentName ?? null,
    exam: input.exam ?? null,
    channel: input.channel,
    goal: input.goal,
    counsellorName: input.counsellorName ?? null,
    bookingLink: input.bookingLink ?? null,
    language: input.language ?? 'en',
  }),
  mock: (input, context) => writeFollowUp(input, { companyName: context.companyName }),
  handover: (input, reason) => ({
    channel: input.channel,
    subject: null,
    message: `Not drafted: the last interaction is about ${reason}. Please reply personally.`,
    confidence: 0.9,
  }),
  outputText: (output) => [output.subject, output.message].filter(Boolean).join('\n'),
  allowedLinks: (input) => (input.bookingLink ? [input.bookingLink] : []),
  summarizeInput: (input) => clip(`${input.goal.replace('_', ' ')} for ${input.contactName ?? 'a lead'}${input.lastInteraction ? `: ${input.lastInteraction}` : ''}`, 200),
  title: (_output, status) => (status === 'pending_review' ? 'AI follow-up draft waiting for approval' : 'AI follow-up draft'),
  sample: {
    contactName: 'Sunita Verma',
    studentName: 'Rohan',
    exam: 'JEE Main',
    channel: 'whatsapp',
    goal: 'book_demo',
    lastInteraction: 'Asked about weekend batches and fees on WhatsApp two days ago; has not replied since.',
    counsellorName: 'Ritika Rao',
    language: 'hi',
  },
});

export const paymentChaserOutput = z
  .object({
    message: z.string().max(1500),
    tone: z.enum(['friendly', 'gentle', 'firm', 'final']),
    escalate: z.boolean().describe('True when the accounts team should take over'),
    confidence,
  })
  .meta({ id: 'AiPaymentChaserOutput' });

export const paymentChaserAgent = defineAgent({
  key: 'payment_chaser',
  label: 'Payment chaser',
  description: 'Writes a payment reminder whose tone follows how overdue it is, stating only the amount and dates on the invoice. Long-overdue payments go to the accounts team.',
  task: 'generate',
  purpose: 'payment.chase',
  defaultThreshold: 0.7,
  customerFacing: true,
  onTopic: 'handover',
  maxTokens: 768,
  inputSchema: z.strictObject({
    contactName: z.string().max(120).optional(),
    studentName: z.string().max(120).optional(),
    amountDueMinor: z.number().int().min(1).max(1e12).describe('Integer minor units'),
    currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
    dueDate: z.iso.date(),
    daysOverdue: z.number().int().min(-60).max(3650).describe('Negative: due in that many days'),
    invoiceNumber: z.string().max(40).optional(),
    paymentLink: z.url({ protocol: /^https$/ }).max(500).optional(),
    remindersSent: z.number().int().min(0).max(50).default(0),
    lastReply: z.string().max(2000).optional().describe('The family’s last message, if any'),
    channel: z.enum(CHANNELS).default('whatsapp'),
    language,
  }),
  outputSchema: paymentChaserOutput,
  instructions:
    'Write one payment reminder. State the amount due, the due date and the invoice number exactly as given, and the payment link only if one is given. ' +
    'Tone: friendly before the due date, gentle up to 7 days late, firm up to 30 days, and after that a short note that the accounts team will be in touch (set escalate to true; ' +
    'also when three or more reminders were already sent). Never offer discounts, waivers, extensions or instalments, and never threaten.',
  untrusted: (input) => input.lastReply ?? '',
  facts: (input, context) => ({
    company: context.companyName,
    contactName: input.contactName ?? null,
    studentName: input.studentName ?? null,
    amountDueMinor: input.amountDueMinor,
    currency: input.currency,
    dueDate: input.dueDate,
    daysOverdue: input.daysOverdue,
    invoiceNumber: input.invoiceNumber ?? null,
    paymentLink: input.paymentLink ?? null,
    remindersSent: input.remindersSent,
    channel: input.channel,
    language: input.language ?? 'en',
  }),
  mock: (input, context) => writePaymentReminder(input, { companyName: context.companyName }),
  handover: (_input, reason) => ({ message: `Not sent: the family’s last reply is about ${reason}. The accounts team should respond personally.`, tone: 'gentle', escalate: true, confidence: 0.9 }),
  outputText: (output) => output.message,
  factAmounts: (input) => [{ amountMinor: input.amountDueMinor, currency: input.currency }],
  allowedLinks: (input) => (input.paymentLink ? [input.paymentLink] : []),
  check(output) {
    return output.escalate
      ? [{ check: 'escalation', outcome: 'flag', message: 'Long overdue or chased three times: the accounts team should decide the next step.' }]
      : [{ check: 'escalation', outcome: 'pass', message: 'No escalation needed.' }];
  },
  summarizeInput: (input) => clip(`${input.currency} ${(input.amountDueMinor / 100).toLocaleString('en-IN')} due ${input.dueDate} (${input.daysOverdue} days overdue)${input.invoiceNumber ? `, ${input.invoiceNumber}` : ''}`, 200),
  title: (output, status) => (status === 'pending_review' ? 'AI payment reminder waiting for review' : `AI payment reminder (${output.tone})`),
  sample: {
    contactName: 'Priya Sharma',
    studentName: 'Aarav',
    amountDueMinor: 1_500_000,
    currency: 'INR',
    dueDate: '2026-11-01',
    daysOverdue: 5,
    invoiceNumber: 'SP/2026-27/0142',
    paymentLink: 'https://pay.example.com/l/sp0142',
    remindersSent: 1,
    channel: 'whatsapp',
  },
});

