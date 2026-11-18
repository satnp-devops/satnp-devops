# AI service

Foundations of phase 9 in docs/ARCHITECTURE.md (AI agents), as the brief puts it: "The AI provider sits behind an interface with a mock" and "Guardrails per company: never quote fees or discounts unless allowed, hand over refunds and complaints, confidence thresholds with a review queue, every AI action logged on the timeline."

Feature code never calls a model directly. It asks the **runner** to run an **agent** (or a generic task) for a company. The runner applies the company's **guardrails** and **budget**, calls the company's `ai` connection (the Claude adapter or the mock), validates the output, writes one **ai_actions** row, adds a **timeline** entry when the call is about a record, and puts doubtful outputs in the **review queue**.

| Where | What |
| --- | --- |
| `apps/api/src/core/ai/index.js` | The public API. Feature code imports only from here. |
| `core/ai/runner.js` | `runAgent()` and `runTask()`: guardrails, budget, model call, log row, timeline, review queue. |
| `core/ai/tasks.js` | The generic service API: `extract`, `classify`, `generate`, `summarise`. |
| `core/ai/agents/*.js` | The agent registry: one file per agent (schemas, prompt, guardrail hooks, mock). |
| `core/ai/guardrails.js` | The checks (pure): `preChecks`, `postChecks`, `decide`. |
| `core/ai/text.js` | Untrusted-text helpers: delimiting, prompt-injection hints, money, discounts, links, handover topics. |
| `core/ai/prompt.js` | Builds the system prompt and messages; outside text goes inside delimiters. |
| `core/ai/model.js` | One structured model call: timeout, retries with backoff, schema validation, mock substitution. |
| `core/ai/mock/*.js` | The deterministic mock model (rules and regular expressions, English and Hinglish). |
| `core/ai/settings.js` | The guardrail settings (module settings, inherited group → company). |
| `core/ai/budget.js` | Monthly token usage per company (`ai_usage`). |
| `core/ai/knowledge.js` | Knowledge base retrieval for the reply assistant. |
| `integrations/ai/anthropic.js` | The Claude adapter (Messages API over `fetch`, no SDK). |
| `integrations/ai/config.js` | `AI_*` environment variables. |
| `modules/ai/` | REST API: catalogue, config, test panel, log, review queue, knowledge base. |
| `apps/web/src/app/(app)/settings/ai/` | Settings › AI. Components in `components/ai/`, queries and types in `lib/ai/`. |

Tables (migration `20261106002300_ai.js`): `ai_actions`, `ai_knowledge_articles`, `ai_usage`. Seed `23_ai.js` adds knowledge base articles, lets Pi Vector quote fees, and runs the agents on seeded leads, so the review queue and the log have content.

## Running an agent

```js
import { runAgent } from '../../core/ai/index.js';

const result = await runAgent({
  companyId,                       // whose guardrails, budget and connection
  agent: 'intake',                 // a registry key (below)
  input: { message, channel: 'whatsapp' },
  subject: { dealId },             // optional: dealId, contactId, accountId (checked inside the company)
  reference: `msg:${messageId}`,   // optional idempotency key: the same reference returns the logged action
  trigger: 'feature',              // feature | automation | test | seed
});

if (result.status === 'completed') use(result.finalOutput);
// pending_review: wait for `ai.review_resolved`, then read the action's final output.
// failed: result.error = { code, message }. skipped: the agent is switched off (nothing logged).
```

The runner, in order:

1. Loads the company and its AI settings. A switched-off agent returns `skipped` and nothing is sent to the model.
2. With a `reference`, returns the existing action (`reused: true`) instead of calling again.
3. Validates `input` against the agent's input schema (`validation_failed` with paths).
4. Runs the **pre-checks** on the untrusted text. A handover topic on a customer-facing agent stops here: the model is not called, and the agent's handover output goes to the review queue.
5. Checks the monthly budget (`ai_budget_exceeded`, logged as a failed action).
6. Builds the prompt and calls the model (`model.js`): per-call timeout (`AI_REQUEST_TIMEOUT_MS`), up to `AI_MAX_ATTEMPTS` attempts on retryable errors with exponential backoff and jitter (honouring `retry-after` on 429/529), one more attempt with a doubled output limit when the answer was cut off, and validation of the output against the agent's zod schema. An output that never validates fails with `ai_invalid_output`.
7. Runs the **post-checks** and `decide()`: `completed`, or `pending_review` with the reasons.
8. In one transaction: the `ai_actions` row, the token usage, a timeline entry (kind `ai`) when there is a subject, and the event `ai.action_logged`.

Model calls never run inside a caller's transaction. Run agents from background jobs (or the test panel) and act on the result afterwards. Features act only on `completed` or approved outputs: an AI answer never triggers an action by itself.

### The generic service API

For features that need a one-off call without a registered agent (`core/ai/tasks.js`). Each returns the same result as `runAgent`, with `output.confidence`:

| Function | Input | Output |
| --- | --- | --- |
| `extract({ companyId, text, schema, instructions? })` | `schema`: a JSON Schema object (flat properties) | the fields of `schema` |
| `classify({ companyId, text, labels })` | `labels`: `[{ key, description? }]` | `{ label, confidence, rationale }` |
| `generate({ companyId, prompt, context?, customerFacing?, maxLength? })` | | `{ text, confidence }`; customer-facing text gets the fee, discount and link checks |
| `summarise({ companyId, transcript })` | | `{ summary, keyPoints, actionItems, confidence }` |

Their log rows use the agent names `extract`, `classify`, `generate` and `summarise`, and the default threshold 0.6.

### Routing on shared channels

`routingClassifier({ billingCompanyId })` returns the `classify` function that `core/intake/routing.js` `route()` takes. The call is logged and budgeted under `billingCompanyId` (default: the first company the channel routes to).

## Agents

Each agent is configuration plus a few functions (`core/ai/agents/common.js` lists them): an input and an output schema (outputs use `nullable()` so every key is always present), the job for the prompt, which input is untrusted text, trusted facts, optional data loading (`prepare`), guardrail hooks, the mock answer, and the log and timeline wording. Feature engineers wire them to their flows.

| Key | Agent | Task | Threshold | Notes |
| --- | --- | --- | --- | --- |
| `intake` | Intake extraction | extract | 0.60 | Parent, student, grade, exam, target date, intent, language, city, time zone, phone, email from an enquiry. |
| `classifier` | Company and product classifier | classify | 0.75 | Picks the company and product line on a shared channel; only from the companies it is given. |
| `reply` | Reply assistant | generate | 0.70 | Answers only from approved knowledge base articles (`sources`); hands over when unsure. Customer-facing. |
| `meeting_summary` | Meeting summariser | summarise | 0.50 | Summary, key points, concerns, next steps and at most one suggested program from the catalogue. |
| `follow_up` | Follow-up writer | generate | 0.60 | Always waits for a person before it is sent. Customer-facing. |
| `payment_chaser` | Payment chaser | generate | 0.70 | States only the amount and dates it was given; long-overdue payments escalate to the accounts team. Customer-facing. |
| `b2b_qualifier` | B2B qualifier | extract | 0.55 | Students, branches, current tools, budget, timeline, decision maker, and a hot, warm or cold fit. |

`GET /ai/agents` returns the registry with JSON Schemas and a sample input for each agent.

### The mock model

The mock is deterministic and works offline, so seeds, tests and local runs need no account. It really reads typical Indian enquiries in English and Hinglish ("mera beta Rohan 11th mein hai, JEE Mains ki taiyari"): names of the parent and student, grade, exam, target month or year, intent, language, city (and from it the time zone), phone and email; the company and product line from names and keywords; replies built from the best matching approved article; summaries from the transcript's sentences. Its confidence comes from how much it found. With a mock connection the call still goes through the mock adapter (recorded in the sandbox outbox, with its failure simulation), and the answer comes from `core/ai/mock/`.

## Guardrails

Settings per company (module settings, so the group can set a default and a company override it; change them in Settings › AI › Guardrails or with `PUT /settings/:key`):

| Setting | Default | |
| --- | --- | --- |
| `ai.enabledAgents` | every agent | Agents that may run. |
| `ai.mayQuoteFees` | off | Off: any amount of money in a customer-facing answer blocks it. On: amounts must come from the record or an approved article (otherwise flagged). |
| `ai.mayQuoteDiscounts` | off | Off: answers offering a discount, scholarship, waiver or coupon are blocked. |
| `ai.handoverTopics` | refunds, complaints, cancellations and withdrawals, legal threats, payment disputes, safety and wellbeing | Messages on these are handed to a person. |
| `ai.monthlyTokenBudget` | 2,000,000 | Input plus output tokens per calendar month (UTC); 0 switches AI off. |
| `ai.threshold.<agent>` | the agent's default | Confidence below it waits for review. |

Checks (`guardrails.js`), each recorded on the action with its outcome (`pass`, `flag`, `block`, `handover`) and a reason:

- **Before the call:** agent switched on; handover topics in the untrusted text; prompt-injection hints ("ignore previous instructions", fake system tags, attempts to change the rules). Injection is flagged and the text is still treated as data only.
- **After the call:** fee amounts, discounts, links not given in the input or context, grounding (the reply assistant must cite approved articles), the model's own handover, plus agent checks (classifier choices, catalogue programs, payment escalation).
- **Decision:** any flag, block or handover, confidence below the threshold, or an agent that always needs approval puts the output in the review queue with `reviewReasons`.

### Untrusted input

Message text, transcripts and form fields are treated as untrusted. The prompt wraps them in `<untrusted_input>` delimiters (with any delimiter look-alikes in the text neutralised) and the system prompt says they are data, never instructions. Outputs are validated against the schema and checked before use, and no output triggers an action by itself. Phones and emails in stored inputs are masked for people without `contacts.view_pii`.

## The log and the timeline

Every call writes one `ai_actions` row: company and unit, agent, trigger, reference, subject (deal, contact, account), status, input and its summary, output, final output (the output, or the reviewer's edit), confidence and threshold, guardrail results and review reasons, provider, model, mock flag, connection, tokens, latency, attempts, error, reviewer, review time and note. Test-panel runs are dry runs and write nothing.

When the call is about a deal, contact or account, the runner adds a timeline entry (kind `ai`) to it, and resolving a review adds another.

## Review queue

Outputs with status `pending_review` wait for a person with `ai.review` (managers; counsellors and account executives with "own" access see the ones on their own records). They can **approve**, **edit** (the edited output must pass the agent's output schema) or **reject** it, with a note. One transaction updates the action, writes the audit entry, adds the timeline entry and emits:

```js
{ type: 'ai.review_resolved',
  payload: { actionId, agent, companyId, decision, status, dealId, contactId, accountId, reference, trigger } }
```

Features continue from that event: on `approved` or `edited`, read the action's `final_output`; on `rejected` there is none. A second decision returns 409.

## Knowledge base

`ai_knowledge_articles` per company: title, body, tags, status (`draft`, `approved`, `archived`), owner, who approved it and when. Only approved articles are used. Retrieval (`retrieveArticles`) is Postgres full text over title, tags and body (weighted), plus a trigram match on the title, re-ranked by how many of the question's words each article covers; `GET /ai/knowledge/search` shows what the reply assistant would use.

## The Claude adapter

`integrations/ai/anthropic.js`, provider `anthropic` of the `ai` kind (docs/platform/INTEGRATIONS.md). The API key is a credential of the company's AI connection (stored encrypted), never an environment variable. Choices:

- `POST /v1/messages` with `anthropic-version: 2026-10-21`, over `fetch`.
- Model: the connection's "Model" field, else `AI_MODEL` (default `claude-opus-5-5`).
- Structured output: `output_config.format = { type: 'json_schema', schema }`. The schema is reduced to what structured outputs accept (closed objects, no length or range keywords); the runner validates the full zod schema afterwards.
- Effort from the connection (`output_config.effort`, default `medium`). Thinking is left to the model's default (adaptive, always on with Claude Opus 5.5), so the request adds 4,096 tokens of headroom to the agent's output limit (capped at 16,000; only tokens used are billed). No sampling parameters are sent.
- Refusals: on models that support it, `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` re-runs a declined request on the model Anthropic recommends. A final refusal fails the action (`ai_refused`). `AI_REFUSAL_FALLBACK=off` turns fallbacks off.
- Errors map to `IntegrationError` with `retryable`; 429 and 529 carry `retryAfterSeconds`. Vendor messages are never shown to users or logged with secrets.

Tests never call the real API: the adapter is tested with a fake `fetch`.

## Endpoints (`/api/v1`)

| Method and path | Permission | |
| --- | --- | --- |
| `GET /ai/agents` | signed in | The agent registry and handover topics. |
| `GET /ai/config?companyId` | `ai.view` | Effective guardrails, this month's usage, the AI connection in use. |
| `POST /ai/test` | `ai.manage` | Dry run of an agent: output, confidence, guardrails, prompt, would-be log row and timeline entry. Rate limited; audited as `ai.test_run`; tokens count against the budget. |
| `GET /ai/actions?unitId&agent&status&trigger&dealId&contactId&accountId` | `ai.view` (own) | The log, newest first, keyset pages. |
| `GET /ai/actions/:id` | `ai.view` or `ai.review` | With its input and `names` (names of the companies, teams, product lines and products it mentions, within the reader's scope). |
| `POST /ai/actions/:id/review` | `ai.review` (own) | `{ decision: approve \| edit \| reject, output?, note? }`. |
| `GET /ai/reviews?unitId&agent` | `ai.review` (own) | The queue, oldest first. |
| `GET /ai/reviews/summary?unitId` | `ai.review` (own) | Count, per agent, oldest. |
| `GET /ai/knowledge?unitId&q&status&tag` | `ai.view` | Articles. |
| `GET /ai/knowledge/search?companyId&q` | `ai.view` | What the reply assistant would retrieve. |
| `POST /ai/knowledge`, `PATCH /ai/knowledge/:id`, `DELETE /ai/knowledge/:id` | `ai.knowledge` | Write, approve, archive (DELETE archives). |

Records outside the user's scope return 404. Permissions: `ai.view` and `ai.review` support "own"; role grants are in `modules/ai/module.js`.

## Settings › AI (web)

Tabs: **Review queue** (also for managers and counsellors), **Activity** (the log), **Guardrails** (per company: what the AI may say, handover topics, budget, agents and thresholds, with where each value comes from and a reset to the inherited value), **Knowledge base** (editor and a retrieval check), and **Test an agent** (pick a company and an agent, paste an input, see the output, confidence, guardrail decisions, the prompt and what would be logged).

## Events

| Event | When |
| --- | --- |
| `ai.action_logged` | Every logged call (payload: actionId, agent, companyId, status, reviewReasons, subject ids, reference, trigger). |
| `ai.review_resolved` | A review decision (above). |
| `ai_knowledge.created`, `ai_knowledge.updated`, `ai_knowledge.archived` | Knowledge base changes. |

## Environment

| Variable | Default | |
| --- | --- | --- |
| `AI_MODEL` | `claude-opus-5-5` | Model when the connection sets none. |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | Per model call. |
| `AI_MAX_ATTEMPTS` | `3` | Attempts on retryable errors. |
| `AI_REFUSAL_FALLBACK` | `on` | Server-side fallbacks on refusals. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | For a proxy. |

## Tests

- Unit (`apps/api/test/ai/`): text helpers and injection hints, the intake mock on realistic English and Hinglish messages, every agent's mock, guardrail checks and decisions, the model call (retries, timeouts, invalid output), and the Claude adapter with a fake `fetch`.
- Integration (`apps/api/test/integration/ai.test.js`, `INTEGRATION=1`): logging with timeline entries, idempotent references, the review queue per user (owner, company admins of other companies get 404, counsellor "own", manager), PII masking, review decisions with events, handover without a model call, switched-off agents and budgets, the knowledge base, the test panel, and the routing classifier.
