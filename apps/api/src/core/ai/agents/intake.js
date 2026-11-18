import { z } from 'zod';
import { clip } from '../text.js';
import { INTENTS, extractIntake } from '../mock/intake.js';
import { confidence, defineAgent, nullableText } from './common.js';

// Intake extraction: who wrote, about which student, for which exam and when, what they want,
// where they are. Phase 4 maps the output onto the enquiry (core/intake/enquiry.js) and the
// student profile (contacts.student_profile).

const isoDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'An ISO 8601 date: 2027, 2027-05 or 2027-05-03')
  .nullable();

export const intakeOutput = z
  .object({
    contactName: nullableText(120).describe('The name of the person who wrote'),
    enquirer: z.enum(['parent', 'student', 'other']).nullable().describe('Who wrote: a parent, the student, or someone else'),
    relation: z.enum(['mother', 'father', 'guardian', 'parent']).nullable().describe('How the writer is related to the student, when a parent wrote'),
    parentName: nullableText(120),
    studentName: nullableText(120),
    grade: nullableText(20).describe('Class 1 to 12 as "10", or "dropper" or "college"'),
    board: nullableText(40).describe('CBSE, ICSE, ISC, IB, IGCSE, State board'),
    exam: nullableText(60).describe('The main exam or program: SAT, JEE Main, NEET, IELTS...'),
    exams: z.array(z.string().max(60)).max(10).describe('Every exam mentioned, in order'),
    targetDate: isoDate.describe('When they aim to sit the exam or start, at the precision written'),
    intent: z.enum(INTENTS),
    intents: z.array(z.enum(INTENTS)).max(INTENTS.length).describe('Every intent shown, most actionable first'),
    audience: z.enum(['b2c', 'b2b']).describe('b2b when an institute or school is asking about software'),
    language: z.string().regex(/^[a-z]{2}$/).describe('ISO 639-1 code of the language written: en, hi...'),
    hinglish: z.boolean().describe('Hindi written in Latin letters'),
    city: nullableText(80),
    timeZone: nullableText(60).describe('IANA zone such as Asia/Kolkata, from the city, a zone name or the phone number'),
    phone: nullableText(20).describe('A phone number written in the message, E.164'),
    email: nullableText(254),
    summary: z.string().max(300).describe('One sentence for the counsellor'),
    missing: z.array(z.string().max(40)).max(10).describe('Important fields the message does not give'),
    confidence,
  })
  .meta({ id: 'AiIntakeOutput' });

export const intakeAgent = defineAgent({
  key: 'intake',
  label: 'Intake extraction',
  description: 'Reads a new enquiry (WhatsApp, form, email, call notes) and extracts parent, student, grade, exam, target date, intent, language, city and time zone.',
  task: 'extract',
  purpose: 'intake.extract',
  defaultThreshold: 0.6,
  maxTokens: 1024,
  inputSchema: z.strictObject({
    message: z.string().trim().min(1, 'Paste the message').max(8000),
    channel: z.string().max(40).optional().describe('Where it arrived: whatsapp, website_form, email...'),
    senderName: z.string().max(120).optional().describe('The profile or form name, when the channel gives one'),
    senderPhone: z.string().max(20).optional().describe('The sender number in E.164, when the channel gives one'),
  }),
  outputSchema: intakeOutput,
  instructions:
    'Extract the enquiry details from the message. Indian families write in English, Hindi or Hinglish (Hindi in Latin letters), often in short WhatsApp style. ' +
    'The writer may be a parent (mother, father, guardian) or the student. Grades are classes 1 to 12 ("10th", "class X", "11 mein"). ' +
    'Exams include SAT, ACT, JEE Main, JEE Advanced, NEET, CUET, IELTS, TOEFL, GRE, GMAT and Olympiads. ' +
    'intent is the most actionable request: book_demo, fee_enquiry, admission, callback, course_info, refund, complaint, or other.',
  untrusted: (input) => input.message,
  facts: (input, context) => ({
    channel: input.channel ?? null,
    senderName: input.senderName ?? null,
    senderPhone: input.senderPhone ?? null,
    today: context.today,
  }),
  mock: (input, _context, { now }) => extractIntake(input, { now }),
  summarizeInput: (input) => clip(input.message, 200),
  title: (output, status) => (status === 'pending_review' ? 'AI intake needs a check' : `AI intake: ${clip(output.summary, 120)}`),
  sample: {
    message:
      'Namaste sir, mera beta Rohan 11th mein hai, JEE Mains ki taiyari karni hai. Hum Jaipur se hain. Weekend batch hai kya? Fees kitni hai? - Sunita Verma',
    channel: 'whatsapp',
  },
});
