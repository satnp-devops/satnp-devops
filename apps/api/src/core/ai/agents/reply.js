import { z } from 'zod';
import { retrieveArticles } from '../knowledge.js';
import { clip, findLinks, findMoney } from '../text.js';
import { answerFromKnowledge } from '../mock/writers.js';
import { confidence, defineAgent, nullableText } from './common.js';

// Reply assistant: drafts an answer to a family's message from the company's approved knowledge
// base only, and hands over to a person when the articles don't answer it.

export const replyOutput = z
  .object({
    reply: z.string().max(1500).describe('The message to send, in the customer’s language'),
    handover: z.boolean().describe('True when a person should answer instead'),
    handoverReason: nullableText(60).describe('not_in_knowledge_base, asked_for_person, or a handover topic such as refund'),
    sources: z.array(z.uuid()).max(5).describe('Ids of the knowledge base articles the reply uses'),
    confidence,
  })
  .meta({ id: 'AiReplyOutput' });

const historyItem = z.strictObject({ from: z.enum(['contact', 'company']), text: z.string().max(2000) });

export const replyAgent = defineAgent({
  key: 'reply',
  label: 'Reply assistant',
  description: 'Suggests a reply to a family’s message using only the company’s approved knowledge base, and hands over to a person when unsure.',
  task: 'generate',
  purpose: 'reply.suggest',
  defaultThreshold: 0.7,
  customerFacing: true,
  onTopic: 'handover',
  maxTokens: 1024,
  inputSchema: z.strictObject({
    message: z.string().trim().min(1, 'Paste the customer’s message').max(4000),
    history: z.array(historyItem).max(10).optional().describe('Earlier messages in the conversation, oldest first'),
    contactName: z.string().max(120).optional(),
    channel: z.string().max(40).optional(),
    language: z.string().regex(/^[a-z]{2}$/).optional().describe('Reply in this language (ISO 639-1); default: the message’s'),
  }),
  outputSchema: replyOutput,
  instructions:
    'Answer the customer’s latest message using only the approved knowledge base articles in the context. Use facts exactly as the articles state them; ' +
    'add no facts, prices, dates, links or promises that are not in them. List the ids of the articles you used in "sources". ' +
    'If the articles do not answer the question, or the customer asks for a person, set "handover" to true, give the reason in "handoverReason", ' +
    'and write a short, polite holding reply saying a counsellor will get back to them. Reply in the customer’s language and style (English, Hindi or Hinglish), ' +
    'in at most four sentences, suitable for WhatsApp.',
  async prepare({ input, company, trx }) {
    return { articles: await retrieveArticles({ companyId: company.id, query: input.message, trx }) };
  },
  untrusted: (input) =>
    input.history?.length
      ? `Earlier messages:\n${input.history.map((m) => `[${m.from}] ${m.text}`).join('\n')}\n\nLatest message:\n${input.message}`
      : input.message,
  facts: (input) => ({ contactName: input.contactName ?? null, channel: input.channel ?? null, replyLanguage: input.language ?? null }),
  knowledge: (context) => context.articles ?? [],
  mock: (input, context) => answerFromKnowledge(input, context.articles ?? []),
  handover: (input, reason) => answerFromKnowledge(input, [], { handoverReason: reason }),
  outputText: (output) => output.reply,
  sourceAmounts: (context) => (context.articles ?? []).flatMap((a) => findMoney(a.body)),
  allowedLinks: (_input, context) => (context.articles ?? []).flatMap((a) => findLinks(a.body)),
  check(output, _input, context) {
    if (output.handover) {
      return [{ check: 'handover', outcome: 'handover', message: `The assistant hands over to a person (${output.handoverReason ?? 'no reason given'}).` }];
    }
    const known = new Set((context.articles ?? []).map((a) => a.id));
    if (output.sources.length === 0) return [{ check: 'grounding', outcome: 'block', message: 'The reply cites no knowledge base article.' }];
    if (output.sources.some((id) => !known.has(id))) return [{ check: 'grounding', outcome: 'block', message: 'The reply cites an article that was not retrieved.' }];
    return [{ check: 'grounding', outcome: 'pass', message: `Answered from ${output.sources.length} approved article${output.sources.length === 1 ? '' : 's'}.` }];
  },
  summarizeInput: (input) => clip(input.message, 200),
  title: (output, status) =>
    output.handover ? 'AI reply assistant handed over to a person' : status === 'pending_review' ? 'AI reply suggestion waiting for review' : 'AI reply suggested',
  sample: { message: 'Hi, what are the timings of the SAT weekend batch? Is it online?', contactName: 'Priya Sharma', channel: 'whatsapp' },
});
