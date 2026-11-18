import { z } from 'zod';
import { db } from '../../../lib/db.js';
import { clip } from '../text.js';
import { classifyCompany } from '../mock/classify.js';
import { confidence, defineAgent } from './common.js';

// Company and product-line classifier for shared channels (one WhatsApp number for several
// companies). Its output is what core/intake/routing.js route() expects from `classify`:
// { companyId, productLineId?, confidence, rationale?, alternatives? }.

const candidateSchema = z.strictObject({
  companyId: z.uuid(),
  companyName: z.string().max(120),
  keywords: z.array(z.string().max(40)).max(30).optional(),
  productLines: z
    .array(z.strictObject({ id: z.uuid(), name: z.string().max(120), keywords: z.array(z.string().max(40)).max(30).optional() }))
    .max(50)
    .optional(),
});

export const classifierOutput = z
  .object({
    companyId: z.uuid().nullable().describe('The chosen company, one of the candidates'),
    productLineId: z.uuid().nullable().describe('The chosen product line of that company, when clear'),
    rationale: z.string().max(300),
    alternatives: z
      .array(z.object({ companyId: z.uuid(), productLineId: z.uuid().nullable(), confidence }))
      .max(5)
      .describe('Other plausible companies, best first'),
    confidence,
  })
  .meta({ id: 'AiClassifierOutput' });

const GENERIC_KEY_WORDS = new Set(['group', 'batch', 'course', 'program', 'classroom', 'coaching', 'tuition', 'online', 'offline', 'plan', 'b2b', 'b2c']);

/** Companies of the group (or the given ones) with their active product lines, as candidates. */
async function loadCandidates({ company, companyIds, trx = db }) {
  const query = trx('org_units').where({ root_id: company.root_id, type: 'company', status: 'active' }).orderBy('name');
  if (companyIds?.length) query.whereIn('id', companyIds);
  const companies = await query.select('id', 'name');
  const lines = companies.length
    ? await trx('product_lines').whereIn('company_id', companies.map((c) => c.id)).where({ active: true }).orderBy(['company_id', 'position']).select('id', 'company_id', 'key', 'name')
    : [];
  return companies.map((c) => ({
    companyId: c.id,
    companyName: c.name,
    productLines: lines
      .filter((l) => l.company_id === c.id)
      .map((l) => ({ id: l.id, name: l.name, keywords: String(l.key).split(/[_-]+/).filter((w) => w.length > 1 && !GENERIC_KEY_WORDS.has(w)) })),
  }));
}

export const classifierAgent = defineAgent({
  key: 'classifier',
  label: 'Company and product classifier',
  description: 'On a shared channel, picks which company and product line an enquiry is for. Low confidence goes to the review queue.',
  task: 'classify',
  purpose: 'intake.classify',
  defaultThreshold: 0.75,
  maxTokens: 512,
  inputSchema: z.strictObject({
    message: z.string().trim().min(1, 'Paste the message').max(8000),
    companyIds: z.array(z.uuid()).max(50).optional().describe('Limit the choice to these companies (the channel’s companies)'),
    candidates: z.array(candidateSchema).max(50).optional().describe('Give the candidates yourself instead of loading them'),
  }),
  outputSchema: classifierOutput,
  instructions:
    'Decide which company the message is for, and the product line when it is clear. Choose only from the candidates in the context. ' +
    'Prefer explicit mentions of a company or product; otherwise match the exam, course or software asked about. ' +
    'If nothing points to one company, pick the most likely one and give a low confidence.',
  async prepare({ input, company, trx }) {
    return { candidates: input.candidates ?? (await loadCandidates({ company, companyIds: input.companyIds, trx })) };
  },
  untrusted: (input) => input.message,
  facts: (_input, context) => ({ candidates: context.candidates }),
  mock: (input, context) => {
    const result = classifyCompany(input.message, context.candidates ?? []);
    return { companyId: result.companyId, productLineId: result.productLineId, rationale: result.rationale, alternatives: result.alternatives, confidence: result.confidence };
  },
  check(output, _input, context) {
    const candidates = context.candidates ?? [];
    const chosen = candidates.find((c) => c.companyId === output.companyId);
    if (!chosen) return [{ check: 'out_of_scope', outcome: 'block', message: 'The answer names a company that was not a candidate.' }];
    if (output.productLineId && !(chosen.productLines ?? []).some((l) => l.id === output.productLineId)) {
      return [{ check: 'out_of_scope', outcome: 'block', message: 'The product line does not belong to the chosen company.' }];
    }
    return [{ check: 'out_of_scope', outcome: 'pass', message: 'The company is one of the candidates.' }];
  },
  summarizeInput: (input) => clip(input.message, 200),
  title: (output, status) => (status === 'pending_review' ? 'AI routing needs a check' : `AI routed the enquiry (${Math.round(output.confidence * 100)}% sure)`),
  sample: { message: 'Hi, I want details of the SAT weekend batch for my daughter in grade 11. Is this SatnPaper?' },
});

export { loadCandidates };
