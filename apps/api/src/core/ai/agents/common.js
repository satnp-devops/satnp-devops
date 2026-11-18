import { z } from 'zod';

// Building blocks for agent definitions (docs/platform/AI.md "Agents").
//
// An agent is configuration plus a few functions:
//   key, label, description, task ('extract' | 'classify' | 'generate' | 'summarise'), purpose,
//   defaultThreshold, alwaysReview, customerFacing, onTopic ('handover' | 'flag'), maxTokens,
//   inputSchema, outputSchema                 zod; outputs use .nullable() so every key is always present
//   instructions                              the job, in the system prompt (rules and policies are added by prompt.js)
//   untrusted(input)                          the outside text: delimited in the prompt, scanned by the pre-checks
//   facts(input, context)                     trusted facts for the prompt (JSON)
//   prepare?({ input, company, trx })         loads what the agent needs (knowledge articles, catalogue, companies)
//   mock(input, context, { now, settings })   the deterministic answer of the mock model
//   handover?(input, reason, context)         the output when a pre-check hands over (no model call)
//   outputText?(output)                       the customer-facing text the post-checks scan
//   factAmounts?(input) / sourceAmounts?(context) / allowedLinks?(input, context)   what the output may quote
//   check?(output, input, context)            agent-specific post-checks: [{ check, outcome, message }]
//   summarizeInput(input), title(output, status)   for the log and the timeline
//   sample                                    an input for the test panel

export const confidence = z.number().min(0).max(1).describe('How sure the model is that the whole answer is right (0 to 1)');
export const text = (max = 300) => z.string().max(max);
export const nullableText = (max = 200) => z.string().max(max).nullable();

export const AGENT_TASKS = ['extract', 'classify', 'generate', 'summarise'];

const REQUIRED = ['key', 'label', 'description', 'task', 'purpose', 'defaultThreshold', 'inputSchema', 'outputSchema', 'instructions', 'untrusted', 'mock', 'summarizeInput', 'title', 'sample'];

/** Check an agent definition when the module loads (a missing piece is a programming error). */
export function defineAgent(definition) {
  for (const field of REQUIRED) {
    if (definition[field] === undefined) throw new Error(`AI agent "${definition.key ?? '?'}" is missing ${field}`);
  }
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(definition.key)) throw new Error(`AI agent key "${definition.key}" must be lower_snake_case`);
  if (!AGENT_TASKS.includes(definition.task)) throw new Error(`AI agent "${definition.key}" has an unknown task ${definition.task}`);
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(definition.purpose)) throw new Error(`AI agent "${definition.key}" has a bad purpose`);
  const parsed = definition.inputSchema.safeParse(definition.sample);
  if (!parsed.success) throw new Error(`AI agent "${definition.key}" has a sample that fails its input schema`);
  return Object.freeze({
    alwaysReview: false,
    customerFacing: false,
    onTopic: 'flag',
    maxTokens: 1024,
    facts: () => ({}),
    ...definition,
  });
}
