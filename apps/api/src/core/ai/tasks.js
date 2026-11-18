import { z } from 'zod';
import { confidence } from './agents/common.js';
import { classifyLabels } from './mock/classify.js';
import { findBoard, findCity, findEmail, findExams, findGrade, findIntents, findNames, findPhone, findTargetDate, findTimeZone } from './mock/intake.js';
import { summariseText } from './mock/meeting.js';
import { draftText } from './mock/writers.js';
import { runTask } from './runner.js';
import { clip, detectLanguage } from './text.js';

// The generic AI service for features that need a one-off call rather than a registered agent:
//   extract(input, schema)      structured data from text, validated against a zod schema or a JSON Schema
//   classify(input, labels)     one label of the caller's list
//   generate(prompt, context)   a short text (customer-facing ones get the fee, discount and link checks)
//   summarise(transcript)       summary, key points, action items
// Each goes through the same runner as the agents: company guardrails, budget, timeouts and
// retries, the ai_actions log, the timeline (when a subject is given) and the review queue.

const GENERIC_THRESHOLD = 0.6;

function taskBase(key, label, extra) {
  return {
    key,
    label,
    description: `Generic ${key} call`,
    task: key,
    purpose: `generic.${key}`,
    defaultThreshold: GENERIC_THRESHOLD,
    alwaysReview: false,
    customerFacing: false,
    onTopic: 'flag',
    maxTokens: 1024,
    facts: () => ({}),
    summarizeInput: (input) => clip(input.text ?? input.prompt ?? '', 200),
    title: (_output, status) => (status === 'pending_review' ? `AI ${key} needs a check` : `AI ${key}`),
    ...extra,
  };
}

/** A zod schema from a JSON Schema object, or the zod schema itself. */
export function toZod(schema) {
  if (schema && typeof schema.safeParse === 'function') return schema;
  if (!schema || typeof schema !== 'object') throw new TypeError('extract() needs a zod schema or a JSON Schema object');
  return z.fromJSONSchema(schema);
}

/** A value of the right shape when the rules know nothing about a field. */
function emptyFor(schema) {
  const json = schema && typeof schema === 'object' ? schema : {};
  const types = Array.isArray(json.type) ? json.type : [json.type];
  if (json.anyOf?.some((s) => s.type === 'null') || types.includes('null')) return null;
  if (types.includes('array')) return [];
  if (types.includes('object')) return Object.fromEntries(Object.entries(json.properties ?? {}).map(([k, v]) => [k, emptyFor(v)]));
  if (types.includes('boolean')) return false;
  if (types.includes('integer') || types.includes('number')) return json.minimum ?? 0;
  if (Array.isArray(json.enum)) return json.enum[0];
  return types.includes('string') ? '' : null;
}

/** The rule-based extractor's guess for a field, by its name. */
function ruleValue(name, text, now) {
  const key = name.toLowerCase();
  const names = () => findNames(text);
  if (/parent.?name|guardian.?name|father.?name|mother.?name/.test(key)) return names().parentName;
  if (/student.?name|child.?name|learner.?name/.test(key)) return names().studentName;
  if (/^(contact.?|sender.?|full.?|customer.?)?name$/.test(key)) return names().contactName;
  if (/grade|class/.test(key)) return findGrade(text);
  if (/board/.test(key)) return findBoard(text);
  if (/^exams$/.test(key)) return findExams(text);
  if (/exam|program|course/.test(key)) return findExams(text)[0] ?? null;
  if (/city|location|town/.test(key)) return findCity(text)?.name ?? null;
  if (/time.?zone/.test(key)) return findTimeZone(text, { city: findCity(text) });
  if (/phone|mobile|whatsapp/.test(key)) return findPhone(text);
  if (/email/.test(key)) return findEmail(text);
  if (/intent/.test(key)) return findIntents(text).intent;
  if (/language/.test(key)) return detectLanguage(text).language;
  if (/date/.test(key)) return findTargetDate(text, now);
  return undefined;
}

/** The mock answer for extract(): rules for fields it knows by name, empty values elsewhere. */
export function mockExtract(text, jsonSchema, now = new Date()) {
  const properties = jsonSchema?.properties ?? {};
  const data = {};
  let known = 0;
  for (const [name, sub] of Object.entries(properties)) {
    const value = ruleValue(name, text, now);
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) known += 1;
    data[name] = value === undefined || value === null ? emptyFor(sub) : value;
  }
  const total = Object.keys(properties).length;
  return { data, confidence: total ? Math.round((0.3 + 0.65 * (known / total)) * 100) / 100 : 0.3 };
}

const textInput = (max) => z.strictObject({ text: z.string().trim().min(1).max(max) });

/**
 * Structured extraction.
 * @param {{ companyId: string, text: string, schema: import('zod').ZodType | object, instructions?: string } & object} options
 *   plus the runner options (subject, reference, trigger, threshold, actorUserId, now...)
 * @returns the runner result; `output.data` is the extracted object, `output.confidence` the model's
 */
export function extract({ text, schema, instructions, ...options }) {
  const dataSchema = toZod(schema);
  const jsonSchema = z.toJSONSchema(dataSchema, { io: 'output' });
  const task = taskBase('extract', 'Extract', {
    inputSchema: textInput(20_000),
    outputSchema: z.object({ data: dataSchema, confidence }),
    instructions: `Extract the fields of "data" from the text. ${instructions ?? ''}`.trim(),
    untrusted: (input) => input.text,
    mock: (input, _context, { now }) => mockExtract(input.text, jsonSchema, now),
  });
  return runTask(task, { ...options, input: { text } });
}

/**
 * Pick one label. labels: [{ key, label, description?, keywords? }].
 * @returns the runner result; `output.label` is a key or null
 */
export function classify({ text, labels, ...options }) {
  if (!Array.isArray(labels) || labels.length < 2) throw new TypeError('classify() needs at least two labels');
  const keys = labels.map((l) => l.key);
  const task = taskBase('classify', 'Classify', {
    inputSchema: textInput(8000),
    outputSchema: z.object({ label: z.enum(keys).nullable(), rationale: z.string().max(300), confidence }),
    instructions: 'Choose the one label in the context that fits the text best, or null when none does, and say why in one sentence.',
    untrusted: (input) => input.text,
    facts: () => ({ labels }),
    mock: (input) => {
      const result = classifyLabels(input.text, labels);
      return { label: result.label, rationale: result.rationale, confidence: result.confidence };
    },
  });
  return runTask(task, { ...options, input: { text } });
}

/**
 * Write a short text. `customerFacing: true` (the default) applies the fee, discount and link guardrails.
 * @returns the runner result; `output.text`
 */
export function generate({ prompt, context = {}, customerFacing = true, maxLength = 2000, ...options }) {
  const task = taskBase('generate', 'Generate', {
    customerFacing,
    inputSchema: z.strictObject({ prompt: z.string().trim().min(1).max(8000), context: z.record(z.string(), z.unknown()).default({}) }),
    outputSchema: z.object({ text: z.string().max(maxLength), confidence }),
    instructions: 'Write the text the request in the context asks for, using only the facts in the context.',
    untrusted: () => '',
    facts: (input) => ({ request: input.prompt, facts: input.context }),
    mock: (input) => draftText(input.prompt, input.context),
    outputText: (output) => output.text,
    allowedLinks: (input) => Object.values(input.context).filter((v) => typeof v === 'string' && /^https?:\/\//.test(v)),
    summarizeInput: (input) => clip(input.prompt, 200),
  });
  return runTask(task, { ...options, input: { prompt, context } });
}

/**
 * Summarise a transcript or long text.
 * @returns the runner result; `output.summary`, `output.keyPoints`, `output.actionItems`
 */
export function summarise({ transcript, ...options }) {
  const line = z.string().max(300);
  const task = taskBase('summarise', 'Summarise', {
    inputSchema: z.strictObject({ text: z.string().trim().min(1).max(60_000) }),
    outputSchema: z.object({ summary: z.string().max(800), keyPoints: z.array(line).max(8), actionItems: z.array(line).max(8), confidence }),
    instructions: 'Summarise the text: a short summary, the key points, and any action items agreed.',
    untrusted: (input) => input.text,
    maxTokens: 2048,
    mock: (input) => summariseText(input.text),
  });
  return runTask(task, { ...options, input: { text: transcript } });
}
