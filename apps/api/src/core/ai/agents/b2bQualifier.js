import { z } from 'zod';
import { clip } from '../text.js';
import { qualifyInstitute } from '../mock/b2b.js';
import { confidence, defineAgent, nullableText } from './common.js';

// B2B qualifier: from an institute's enquiry or discovery-call notes, the facts sales qualifies
// on (students, branches, current tools, budget, timeline, decision maker) and a fit rating.

export const b2bQualifierOutput = z
  .object({
    instituteName: nullableText(160),
    instituteType: z.enum(['coaching_institute', 'school', 'independent_mentor']).nullable(),
    city: nullableText(80),
    students: z.number().int().min(0).nullable(),
    branches: z.number().int().min(0).nullable(),
    currentTools: z.array(z.string().max(60)).max(15),
    interestedIn: z.array(z.enum(['test_platform', 'erp', 'lms'])).max(3),
    budget: z
      .object({ amountMinor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(['year', 'month']).nullable(), text: z.string().max(60) })
      .nullable()
      .describe('Integer minor units'),
    timeline: z.object({ text: z.string().max(80), date: z.string().max(10).nullable() }).nullable(),
    decisionMaker: z.object({ name: nullableText(120), role: z.string().max(40), isContact: z.boolean() }).nullable(),
    phone: nullableText(20),
    email: nullableText(254),
    fit: z.enum(['hot', 'warm', 'cold']),
    missing: z.array(z.string().max(40)).max(10).describe('Qualification facts still unknown'),
    summary: z.string().max(400),
    confidence,
  })
  .meta({ id: 'AiB2bQualifierOutput' });

export const b2bQualifierAgent = defineAgent({
  key: 'b2b_qualifier',
  label: 'B2B qualifier',
  description: 'Qualifies an institute’s enquiry or call notes: students, branches, current tools, budget, timeline and decision maker, with a hot, warm or cold rating.',
  task: 'extract',
  purpose: 'b2b.qualify',
  defaultThreshold: 0.55,
  maxTokens: 1024,
  inputSchema: z.strictObject({
    text: z.string().trim().min(1, 'Paste the enquiry or call notes').max(20_000),
    channel: z.string().max(40).optional(),
  }),
  outputSchema: b2bQualifierOutput,
  instructions:
    'Extract the B2B qualification facts from an institute’s enquiry or the sales rep’s call notes. Budget is integer minor units with an ISO currency ' +
    '(₹3 lakh = 30000000 INR minor units) and the period it covers. fit: hot when size, budget and a near timeline are all clear, warm when some are, cold otherwise. ' +
    'List in "missing" which of students, branches, currentTools, budget, timeline and decisionMaker are unknown.',
  untrusted: (input) => input.text,
  facts: (input, context) => ({ channel: input.channel ?? null, today: context.today }),
  mock: (input, _context, { now }) => qualifyInstitute(input, { now }),
  summarizeInput: (input) => clip(input.text, 200),
  title: (output, status) => (status === 'pending_review' ? 'AI qualification needs a check' : `AI qualification: ${output.fit}`),
  sample: {
    text:
      'We are Sunrise Academy, a coaching institute in Kota with 3 branches and around 1,200 students. We currently use Excel and Google Forms for tests. ' +
      'Looking for an online test platform and an ERP for fees and attendance. Budget is about 3 lakh per year and we want to go live before April 2027. ' +
      'I am the director, Anil Mehta.',
  },
});
