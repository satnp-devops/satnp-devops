import { z } from 'zod';
import { db } from '../../../lib/db.js';
import { clip } from '../text.js';
import { summariseMeeting } from '../mock/meeting.js';
import { confidence, defineAgent } from './common.js';

// Meeting summariser: after a demo or counselling call, a summary for the timeline and the
// catalogue program that fits what the family asked for (flow 6 of the brief).

const line = z.string().max(300);

export const meetingSummaryOutput = z
  .object({
    summary: z.string().max(800),
    keyPoints: z.array(line).max(8),
    concerns: z.array(line).max(5),
    nextSteps: z.array(line).max(5),
    suggestedProgram: z
      .object({ productId: z.uuid().nullable(), name: z.string().max(160), reason: z.string().max(300) })
      .nullable()
      .describe('One of the programs in the context, or null'),
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    confidence,
  })
  .meta({ id: 'AiMeetingSummaryOutput' });

const programSchema = z.strictObject({ id: z.uuid().optional(), name: z.string().max(160), description: z.string().max(500).optional() });

async function loadPrograms(companyId, trx = db) {
  const rows = await trx('products as p')
    .join('product_lines as l', 'l.id', 'p.product_line_id')
    .where({ 'p.company_id': companyId, 'p.active': true, 'l.active': true })
    .orderBy([{ column: 'l.position' }, { column: 'p.position' }])
    .limit(100)
    .select('p.id', 'p.name', 'p.description', 'l.name as line_name');
  return rows.map((r) => ({ id: r.id, name: r.name, description: clip([r.line_name, r.description].filter(Boolean).join('. '), 500) }));
}

export const meetingSummaryAgent = defineAgent({
  key: 'meeting_summary',
  label: 'Meeting summariser',
  description: 'Summarises a demo or counselling call (key points, concerns, next steps) and suggests the program that fits.',
  task: 'summarise',
  purpose: 'meeting.summarise',
  defaultThreshold: 0.5,
  maxTokens: 2048,
  inputSchema: z.strictObject({
    transcript: z.string().trim().min(1, 'Paste the transcript or notes').max(60_000),
    durationMinutes: z.number().int().min(0).max(600).optional(),
    attendees: z.array(z.string().max(120)).max(20).optional(),
    programs: z.array(programSchema).max(100).optional().describe('Programs to choose from; default: the company’s active products'),
  }),
  outputSchema: meetingSummaryOutput,
  instructions:
    'Summarise the call for the counsellor’s timeline: what the family wants, the student’s level and goals, concerns raised, and agreed next steps. ' +
    'Suggest at most one program, chosen only from the programs in the context, with a one-sentence reason; use null when none fits. Keep each point short.',
  async prepare({ input, company, trx }) {
    return { programs: input.programs ?? (await loadPrograms(company.id, trx)) };
  },
  untrusted: (input) => input.transcript,
  facts: (input, context) => ({ durationMinutes: input.durationMinutes ?? null, attendees: input.attendees ?? [], programs: context.programs }),
  mock: (input, context) => summariseMeeting({ transcript: input.transcript, programs: context.programs ?? [] }),
  check(output, _input, context) {
    const program = output.suggestedProgram;
    if (!program) return [{ check: 'program', outcome: 'pass', message: 'No program suggested.' }];
    const known = (context.programs ?? []).some((p) => (program.productId ? p.id === program.productId : p.name === program.name));
    return known
      ? [{ check: 'program', outcome: 'pass', message: `Suggests ${program.name} from the catalogue.` }]
      : [{ check: 'program', outcome: 'flag', message: 'The suggested program is not in the catalogue.' }];
  },
  summarizeInput: (input) => clip(input.transcript, 200),
  title: (output, status) => (status === 'pending_review' ? 'AI meeting summary needs a check' : `AI meeting summary${output.suggestedProgram ? `: suggests ${output.suggestedProgram.name}` : ''}`),
  sample: {
    transcript:
      'Counsellor: Thanks for joining. Parent: Aarav is in grade 11 and wants to apply to US colleges. His target is 1500 on the SAT. ' +
      'Parent: He is strong in maths but weak in reading. We are worried about timing because he has school till 4 pm. ' +
      'Counsellor: Our weekend group batch covers reading strategy, or a one-on-one mentorship plan if he needs more attention. ' +
      'Parent: One on one sounds better. Counsellor: I will send the program details and a payment link tomorrow.',
  },
});
