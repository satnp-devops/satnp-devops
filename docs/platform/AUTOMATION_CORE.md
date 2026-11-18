# Automation core

The engine behind phase 9 (automation and AI agents): flow definitions, a safe expression language, validation, a pure interpreter, a simulator for the editor's test panel, and the registry modules use to declare what flows can do. It performs no I/O. Callers pass data in and get results back; the runner, scheduler, event router and executor that touch the database, queues and the network are wave 2 work, and section 11 describes what they must do.

Code: `apps/api/src/core/automation/` (import from `index.js`). Tests: `apps/api/test/automation/` (run `cd apps/api && node --test test/automation/`).

| File | What it does |
| --- | --- |
| `schema.js` | zod schema for a flow version: trigger, steps, settings. `stepEdges()` and `isPausingStep()` for graph code |
| `expr.js` | the expression language: lexer, parser to an AST, evaluator, error positions |
| `template.js` | `{{ }}` text and `{ "$expr": … }` values inside params |
| `validate.js` | everything the schema can't check: graph integrity, registry lookups, params, loops, depth, AI approval rule |
| `interpreter.js` | `startRun`, `advance`, `matchTrigger`, `canStartRun`, `cancelRun` |
| `simulate.js` | dry runs with a virtual clock and scripted results |
| `registry.js` | `createAutomationRegistry`, `automationRegistryFromModules`, `catalog()` for the editor |
| `catalog.js` | the built-in triggers, actions and agents from the brief, plus scheduler helpers |
| `url-safety.js` | webhook target checks (SSRF defence) |
| `time.js` | durations, instants and wall-clock times in IANA zones |

## 1. A flow

A flow is a trigger plus a graph of steps. Each saved edit is a new **version**; versions are immutable, and every run is pinned to the version it started on.

```json
{
  "key": "new-enquiry-welcome",
  "version": 3,
  "name": "Welcome new enquiries",
  "trigger": { "type": "enquiry.new", "filter": "trigger.payload.channel != 'import'" },
  "start": "classify",
  "steps": [
    { "id": "classify", "type": "ai_step", "agent": "classifier",
      "input": { "text": "{{ trigger.payload.message }}", "labels": ["hot", "warm", "cold"] },
      "next": "route", "onError": "welcome" },
    { "id": "route", "type": "branch",
      "cases": [{ "label": "Hot", "when": "steps.classify.output.label == 'hot'", "next": "assign_senior" }],
      "otherwise": "welcome" },
    { "id": "assign_senior", "type": "action", "action": "records.assign",
      "params": { "strategy": "round_robin", "teamUnitId": "…" }, "next": "welcome" },
    { "id": "welcome", "type": "action", "action": "messaging.send_template",
      "params": { "channel": "whatsapp", "template": "welcome_v1", "variables": { "course": "{{ trigger.payload.course }}" } },
      "next": "wait_booking" },
    { "id": "wait_booking", "type": "wait", "mode": "event", "event": "booking.created",
      "filter": "event.payload.dealId == trigger.payload.dealId", "timeout": "3d",
      "next": "done", "onTimeout": "nudge" },
    { "id": "nudge", "type": "action", "action": "tasks.create", "params": { "title": "Call {{ record.name }}", "dueIn": "2h" }, "next": "done" },
    { "id": "done", "type": "end" }
  ],
  "settings": { "timeZone": "Asia/Kolkata", "maxStepsPerRun": 500, "reentry": "skip_if_active" }
}
```

- `key`: lowercase slug, stable across versions. `version`: positive integer.
- Step `id`s are identifiers (`^[a-z][a-z0-9_]{0,47}$`) because expressions read `steps.<id>`.
- A missing pointer (`next`, `then`, `else`, `otherwise`, `onTimeout`, `onError`, `onReject`) ends the run there, as completed.
- `settings.reentry`: `allow`, `skip_if_active` (default; not while the same subject has an active run) or `once` (once per subject ever). The runner counts runs and calls `canStartRun(flow, { activeRuns, totalRuns })`.
- Limits: 200 steps, 20 cases per branch, waits between 1 s and 365 days.

### Steps

| Type | Fields | Behaviour |
| --- | --- | --- |
| `condition` | `if`, `then`, `else` | evaluates `if`; goes to `then` or `else` |
| `branch` | `cases: [{ label?, when, next }]`, `otherwise` | first case whose `when` is true wins |
| `wait` `mode: duration` | `duration` (`2h`, `1d12h`), `next` | pauses for that long |
| `wait` `mode: until` | `until: { at: <expr> }` or `until: { timeOfDay: 'HH:MM', timeZone?, daysOfWeek? }`, `next` | `at`: pauses until the instant the expression gives (continues at once if it has passed; fails with `WAIT_TIME_INVALID` if it's empty). `timeOfDay`: the next such local time strictly after now, in the step's zone or the flow's, on ISO weekdays 1 (Monday) to 7 |
| `wait` `mode: event` | `event` (domain event type), `filter?`, `timeout` (required), `next`, `onTimeout?` | pauses until a matching event arrives (output: the event, which also becomes `event` for later steps) or the timeout passes (goes to `onTimeout`, or to `next` with `steps.<id>.timedOut = true`) |
| `action` | `action` (registry key), `params`, `await?`, `timeout?`, `next`, `onError?` | emits an effect. With `await: true` it pauses for the result (`steps.<id>.output`), and failures or a timeout (default 1 d) go to `onError` or fail the run |
| `ai_step` | `agent`, `input`, `timeout?` (default 1 h), `next`, `onError?` | emits an `ai.run` effect and pauses for the agent's output, which is checked against the agent's output schema |
| `approval` | `title`, `body?` (both `{{ }}` text), `approvers: { permission?, userIds?, owner? }`, `data?`, `timeout?`, `next`, `onReject?`, `onTimeout?` | emits `automation.request_approval` and pauses for the decision. The approver may edit `data`; the result is `steps.<id>.output = { decision, decidedBy, comment, data, edited }`. Rejection or timeout without a pointer ends the run |
| `end` | `outcome?` (`completed` or `cancelled`), `reason?` | ends the run |

What later steps can read about a step: `steps.<id>.status` (`done`, `emitted`, `error`, `timed_out`, `approved`, `rejected`), `.output`, `.error { code, message }`, `.timedOut`, `.visit` (how many times it has run, useful in loops), `.at`.

## 2. Expressions

Used for conditions, branch cases, trigger and wait filters, `until.at`, and inside params. Parsed to an AST and walked by a small interpreter. There is no `eval`, no `Function`, no property access beyond own data fields, and nothing callable except the functions listed below. A test checks the source for `eval` and `Function`.

```
record.stage == 'new' and record.score >= 60
trigger.payload.amount.minor > 500000 or 'vip' in record.tags
record.lastActivityAt < now - 3d
lower(record.city) in ['pune', 'mumbai'] and not record.phone exists
local_hour(now, 'Asia/Kolkata') >= 9 and local_weekday(now, 'Asia/Kolkata') <= 5
days(now - record.createdAt) > 7
```

**Names** an expression can start with in a run: `trigger` (the event that started the run), `event` (the latest event a wait consumed, else the trigger), `steps`, `record` (the subject as the runner loaded it, passed as `context.record`), `run` (`id`, `flowKey`, `flowVersion`, `startedAt`, `subject`), plus any extra roots the caller declares (`validateFlow(…, { roots: ['contact'] })` and `advance(…, { context: { contact } })`). Trigger filters can read `trigger`, `event` and `record`. `now` is a keyword. Context cannot replace `trigger`, `event`, `steps` or `run`.

**Precedence**, lowest first:

| Level | Operators |
| --- | --- |
| 1 | `or`, `\|\|` |
| 2 | `and`, `&&` |
| 3 | `not`, `!` (applies to the whole comparison: `not a == b` is `not (a == b)`) |
| 4 | `==` `!=` `<` `<=` `>` `>=` `in` `not in` `contains` `not contains`, postfix `exists`. These don't chain: `1 < x < 5` is an error |
| 5 | `+` `-` |
| 6 | `*` `/` `%` |
| 7 | unary `-` |
| 8 | literals, field paths (`a.b.0.c`), function calls, `( )`, `[ ]` lists |

**Values**: `null`, `true`/`false`, numbers, `'text'` or `"text"` (escapes `\n \t \r \\ \' \" \0 \uXXXX`), lists, durations (`250ms 30s 15m 2h 3d 1w`, compounds like `1h30m`; no months or years because their length varies), and instants (`now`, `date('2026-04-01T09:00:00+05:30')`, or ISO text next to a time).

**Rules**:
- A missing field is `null`. `null == null` is true; `<`, `<=`, `>`, `>=` with `null` are false; arithmetic with `null` gives `null`.
- No coercion between text and numbers (`'5' == 5` is false; `'5' < 3` is an error). ISO 8601 text *is* read as a time when compared with or added to a time or a duration. Text without a zone offset is never read as a time.
- Time arithmetic: time ± duration → time; time − time → duration; duration × or ÷ number → duration.
- `in` / `contains`: list membership, substring, or object key.
- Truthiness (for `and`, `or`, `not` and conditions): `null`, `false`, `0`, `''` and `[]` are false.
- Type errors (`record.city > 5`), division by zero and unknown zones throw `ExprError` with code `EXPR_TYPE` and a column. In a condition, branch or wait, the run fails with that error. In an action or AI step, it goes to `onError`. In a trigger filter, the event doesn't match and `matchTrigger` reports `filter_error`.

**Functions**: `lower`, `upper`, `trim`, `len` (text, list or object; `null` is 0), `starts_with`, `ends_with`, `coalesce(a, b, …)`, `abs`, `round`, `floor`, `min`, `max`, `date`, `days(duration)`, `local_hour(time, zone)`, `local_weekday(time, zone)` (1 = Monday), `local_date(time, zone)` (`YYYY-MM-DD`). `FUNCTION_DOCS` lists them for the editor.

**Safety**: field names `__proto__`, `prototype` and `constructor` are refused when parsing, and so are bracket access, calls on paths, and unknown functions. Lookups use own data properties only, so no prototype chain, no getters and no class instances; Dates become instants. There are limits on source length (2000), nesting depth (40) and list literals (200 items). Errors read like `Use == to compare values (column 14)`, and `explainError(source, error)` draws a caret under the column.

**API**: `parse(source)` → AST (throws `ExprError`), `compile(source)` (memoised parse), `evaluate(ast, scope, { now })`, `evaluateSource(source, scope, { now })`, `testCondition(...)` → boolean, `collectPaths(ast)` (fields read), `toPlain(value)`.

## 3. Params: literals, templates and expressions

Inside `params` (actions), `input` (AI steps) and `data`/`title`/`body` (approvals):

- `"Call {{ record.name }} about {{ trigger.payload.course }}"`: text with interpolations. The result is always text: `null` becomes empty, times become ISO text, durations become text like `3d`, and lists are joined with commas.
- `{ "$expr": "record.ownerId" }`: the raw value of one expression (numbers, lists and times stay typed).
- Anything else is a literal. Keys named `__proto__` are dropped.

The registry's zod schema validates params twice. When the flow is saved, dynamic values are skipped, unless an issue is marked `params.static` (see webhook URLs). Before each effect is emitted, the resolved values are checked in full and the schema's defaults are applied.

## 4. Validation

`validateFlow(flow, registry, { roots?, limits? })` → `{ ok, errors, warnings, flow, stats }`. Each error or warning is `{ code, message, path, stepId? }`, where `path` points into the JSON for the editor. `flow` is the normalised flow (with defaults); store that. `assertValidFlow` throws `FLOW_INVALID` with `errors`.

| Code | Rule |
| --- | --- |
| `SCHEMA` | shape errors from `schema.js` (unknown step type or wait mode, unknown fields, bad durations, ids, zones, times) |
| `EXPR_SYNTAX`, `EXPR_LIMIT` | an expression doesn't parse (message has the column) |
| `DUPLICATE_STEP`, `UNKNOWN_STEP` | ids are unique; `start` and every pointer name an existing step |
| `UNREACHABLE_STEP` | every step can be reached from `start` |
| `UNKNOWN_TRIGGER`, `TRIGGER_CONFIG_INVALID` | the trigger exists and its config passes its schema |
| `UNKNOWN_ACTION`, `INTERNAL_ACTION`, `PARAMS_INVALID` | actions exist, aren't engine-internal (`ai.run`, `automation.request_approval`), and their params are valid |
| `UNKNOWN_AGENT` | AI agents exist; their `input` is checked like params |
| `UNKNOWN_ROOT`, `UNKNOWN_STEP_REF` | expressions only read known roots and existing steps |
| `LOOP_WITHOUT_WAIT` | every cycle contains a step that always pauses (duration, time-of-day or event wait, approval, AI step, awaited action). A `wait until { at }` doesn't count, because its time may already have passed |
| `CHAIN_TOO_LONG` | the longest pause-free path (what one `advance` executes) is at most 50 steps (the max depth) |
| `AI_NEEDS_APPROVAL` | the output of an agent with `requiresApproval` (follow-up writer, reply assistant) may only reach a side-effect action through an approval step, on every path |
| warning `STEP_NOT_BEFORE` | an expression reads `steps.x` where `x` can't have run yet |

## 5. Running flows: the interpreter

Pure and deterministic: the same `(flow, run, input)` always gives the same output, and no input is mutated. The clock is a parameter.

```js
import { matchTrigger, canStartRun, startRun, advance } from '../core/automation/index.js';

const match = matchTrigger(flow, registry, event, { now, context: { record } });   // { matched, reason?, error? }
if (match.matched && canStartRun(flow, counts)) {
  const run = startRun(flow, { runId: uuid, event, now });                          // status 'running'
  const result = advance(flow, run, { registry, now, context: { record } });
  // result: { status, state, effects, nextWakeAt, waitingFor, trace, changed, consumed, ignored, error }
}
```

- `advance(flow, run, { registry, now, event?, context?, limits? })` executes steps until the run pauses or ends. Status is `running`, `waiting`, `completed`, `failed` or `cancelled`.
- `effects`: `[{ action, params, idempotencyKey, runId, stepId, subject, await }]`. `params` are resolved and validated, with schema defaults applied.
- `nextWakeAt` (ISO or null): when to call `advance` again with no event (timer, event timeout, effect timeout or approval expiry).
- `waitingFor`: `{ kind: 'timer' | 'event' | 'effect' | 'approval', stepId, until, event?, idempotencyKey? }`. Index it to route events.
- `changed: false` and `ignored` (`not_due`, `not_matching`, `not_waiting_for_event`, `duplicate`, `finished`, `filter_error`, `bad_decision`) mean nothing happened. Don't save anything in that case.
- `trace`: what this call did, as entries `{ seq, at, phase: 'run' | 'resume', stepId, type, outcome, next, detail? }`. Outcomes include `then`/`else`, `case` (with `{ index, label }`), `otherwise`, `emitted`, `waiting`, `resumed`, `event`, `timeout`, `result`, `approved`, `rejected`, `passed` and `error`. The run keeps the last 300 entries in `state.trace` (with a `traceDropped` count) for the run view.
- Results come back as events:
  - `{ id, type: 'automation.effect_result', idempotencyKey, ok, output?, error?: { code, message } }`
  - `{ id, type: 'automation.approval_decided', idempotencyKey, decision: 'approved' | 'rejected', decidedBy?, comment?, data? }`
- `cancelRun(run, { now, reason })` stops a run (for example when its deal closes).

**Version pinning**: if `run.flowKey`/`run.flowVersion` doesn't match the flow passed in, `advance` throws `AutomationError('VERSION_MISMATCH')`. Load the pinned version.

**Idempotency** (handlers must be safe to run twice; see ARCHITECTURE §9):
1. Every effect has the key `${runId}:${stepId}:${visit}`. `visit` counts executions of that step in the run, so each time round a loop gets a fresh key, and replaying the same state gives the same key. The executor stores keys with a unique constraint and skips any key it has seen.
2. Event ids the run has consumed (the last 100) are remembered; a re-delivered event returns `ignored: 'duplicate'`. Events must therefore carry ids: the outbox event id, or the result or decision id.
3. A timer that fires early or twice returns `not_due` or `finished`.
4. Crash safety: perform effects only after saving `state`, or save first and replay. Either way the keys make the replay harmless.

**Limits**: 100 steps per `advance` (`STEP_LIMIT`; validated flows stay at 50 or fewer), `settings.maxStepsPerRun` (`RUN_STEP_LIMIT`, default 500). The defaults for awaited results are 1 day for actions and 1 hour for AI steps. A failed run keeps `state.error = { stepId, code, message }`.

Run state (`run.state`, stored as JSON): `cursor`, `steps` (per-step records), `visits`, `stepCount`, `waiting`, `lastEvent`, `processedEventIds`, `trace`, `traceSeq`, `traceDropped`, `error`, `endReason`.

## 6. Simulation

`simulate(flow, registry, options)` validates the flow, then drives the real interpreter with a virtual clock. Nothing is performed.

```js
simulate(flow, registry, {
  now: '2026-11-05T04:30:00Z',                         // required: the engine never reads the clock
  event: { type: 'deal.created', payload: { channel: 'whatsapp' } },   // default: the trigger's sample
  context: { record: { stage: 'new' } },
  events: [{ after: '2h', event: { type: 'booking.created', payload: { dealId } } }],  // or at: ISO
  results: { classify: { label: 'hot', confidence: 0.9 } },   // or { ok: false, error }, 'timeout', or a list per visit
  approvals: { review: 'rejected' },                    // 'approved' (default), 'rejected', 'timeout' or { decision, data }
  force: false,                                         // run even if the trigger doesn't match
});
// → { ok, matched, matchReason, status, path: [stepIds], branches: [{ stepId, outcome, detail? }],
//     effects: [{ ...effect, at, simulated: true, sideEffect }], waits, deliveries, trace, error, endedAt, finalState }
```

Waits are skipped by jumping the clock to whichever comes first, the next sample event or the wake-up time. Awaited actions and AI steps without a scripted result get the registry's `sampleOutput`. A run that could only continue with an event that never arrives stops with `WAITS_FOREVER`, and runaway loops stop with `SIMULATION_LIMIT` (300 iterations).

## 7. The registry

Modules declare what flows can use, next to their permissions:

```js
// src/modules/payments/module.js
automation: {
  actions: [{ key: 'payments.send_link', label: 'Send payment link', sideEffect: true,
              params: z.strictObject({ amountMinor: z.int().min(1), currency: z.string().regex(/^[A-Z]{3}$/) }),
              output: z.object({ linkId: z.string() }).loose(), sampleOutput: { linkId: 'pl_1' } }],
  triggers: [{ key: 'payments.mandate_failed', label: 'Mandate failed', events: ['mandate.failed'], subject: 'deal' }],
  agents: [],
}
```

`automationRegistryFromModules(modules)` collects these after the core declarations. Duplicate keys, a bad key format, a missing schema, or a missing `sideEffect`/`requiresApproval` throw at start-up. Lookups: `registry.action(key)`, `.trigger(key)`, `.agent(key)`, `.triggersForEvent(type)` (for the event router), `.eventTypes()`, and `.catalog()` (JSON Schemas for the editor, built with `z.toJSONSchema`).

Action fields: `key` (`module.action`), `label`, `description?`, `params` (zod), `sideEffect` (true if it changes the world; the simulator reports it), `output?`, `sampleOutput?`, `internal?`, `staticParams?`. `staticParams` lists params that must be written out as text, never a whole `{ $expr }`. Trigger fields: `key`, `label`, `events` (domain event types), `subject`, `config?` (zod), `match?(config, event)` (pure), `sample`. Agent fields: `key`, `label`, `input`, `output` (zod), `requiresApproval`, `sampleOutput`.

### Built-in triggers

| Key | Label | Events | Config |
| --- | --- | --- | --- |
| `enquiry.new` | New enquiry | `deal.created` | `channels?` |
| `deal.stage_changed` | Stage changed | `deal.stage_changed` | `pipelineId?`, `fromStage?`, `toStage?` |
| `booking.event` | Booking made or changed | `booking.created`, `booking.rescheduled`, `booking.cancelled` | `kinds?` |
| `meeting.ended` | Meeting ended | `meeting.ended` | `attendance?` (`attended`, `no_show`) |
| `payment.event` | Payment event | `payment.succeeded`, `payment.failed`, `payment.refunded`, `payment_link.expired`, `instalment.overdue` | `kinds?` |
| `schedule` | On a schedule | `automation.schedule_tick` | `timeOfDay`, `timeZone`, `daysOfWeek?` |
| `no_activity` | No activity | `automation.no_activity` | `entity`, `after` (1 h to 180 d), `stages?` |

The event names follow the phase 1 `aggregate.past_tense` convention. They are assumptions until the deals, scheduling and payments modules exist: those modules must emit these names, or the integrator updates `events` in `catalog.js`. Payloads are expected to carry the ids that filters compare (`dealId` and so on), and events carry `subject: { type, id }`.

Scheduler helpers: `nextScheduleFire(config, after)` gives the next firing, with tick event id `${flowKey}@${iso}`. `noActivityCutoff(config, now)` gives the instant before which a subject counts as quiet. `noActivityEventId(flowKey, subject, lastActivityAt)` gives one event id per quiet period, so rescans don't start duplicate runs.

### Built-in actions

| Key | Params (main) | Notes |
| --- | --- | --- |
| `messaging.send_template` | `channel` (`whatsapp`/`email`/`sms`), `template`, `recipient` (`contact`/`guardian`/`owner`), `variables?`, `locale?` | the executor applies consent, opt-outs and quiet hours |
| `tasks.create` | `title`, `description?`, `dueIn?` or `dueAt?`, `assignee` (`owner` or user id), `priority` | |
| `deals.change_stage` | `stage`, `pipelineId?`, `reason?` | acts on the run's subject |
| `records.assign` | `strategy` (`user`, `round_robin`, `least_loaded`), `userId?`, `teamUnitId?` | |
| `records.update_field` | `field` (e.g. `custom.grade`), `value` (JSON ≤ 64 KB) | `id`, `ownerId`, `stage` and similar fields are refused; they have their own actions |
| `http.call_webhook` | `url`, `method` (`POST`/`PUT`/`PATCH`), `headers?`, `body?`, `connectionId?`, `timeoutMs` (≤ 10 s) | see section 8; `Authorization`, `Cookie`, `Host`, hop-by-hop and forwarding headers are refused (secrets come from the connection) |

Engine-internal: `ai.run` (`{ agent, input }`) and `automation.request_approval` (`{ title, body?, approvers, data?, expiresAt }`).

### Built-in AI agents

| Key | Input | Output | Approval |
| --- | --- | --- | --- |
| `intake_extraction` | `text`, `channel?` | `fields`, `confidence`, `missing` | no |
| `classifier` | `text`, `labels` (2 to 20) | `label`, `confidence` | no |
| `reply_assistant` | `message`, `tone`, `context?` | `draft`, `confidence` | **required** |
| `meeting_summariser` | `transcript?` or `notes?` | `summary`, `actionItems`, `nextStep?` | no |
| `followup_writer` | `purpose`, `channel`, `facts?` | `draft`, `subject?` | **required** |
| `payment_chaser` | `amountMinor` (integer minor units), `currency` (ISO 4217), `dueAt`, `attempt` | `message`, `tone`, `escalate` | no (add an approval step if wanted) |
| `b2b_qualifier` | `institute { name, city?, students?, currentSoftware? }`, `notes?` | `score` (0 to 100), `tier`, `reasons` | no |

## 8. Webhook URL safety

`checkWebhookUrl(url, { allowHttp?, allowedHosts?, allowedPorts? })` runs when a flow is saved, through the action's params schema, and again on the resolved URL before the effect is emitted. It refuses:

- schemes other than `https:` (`http:` only with `allowHttp`, for development), user names or passwords in the link, whitespace, control characters and backslashes;
- IP literals in blocked ranges, after WHATWG URL parsing, which normalises `0x7f.1`, `2130706433`, `0177.0.0.1` and `127.1` to `127.0.0.1`. Ranges come from the IANA special-purpose registries (RFC 6890):
  - IPv4: `0/8`, `10/8`, `100.64/10` (RFC 6598), `127/8`, `169.254/16` (link-local; cloud metadata `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.31.196/24`, `192.52.193/24`, `192.88.99/24`, `192.168/16`, `192.175.48/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24` (RFC 5737), `224/4`, `240/4`;
  - IPv6: `::`, `::1`, `64:ff9b:1::/48` (RFC 8215), `100::/64`, `100:0:0:1::/64`, `2001::/23` (includes Teredo, RFC 4380), `2001:db8::/32` (RFC 3849), `2001:20::/28`, `3fff::/20` (RFC 9637), `5f00::/16`, `fc00::/7` (RFC 4193; AWS metadata `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`, and anything outside `2000::/3`;
  - embedded IPv4: IPv4-mapped `::ffff:a.b.c.d` and translated `::ffff:0:a.b.c.d` (RFC 4291, RFC 2765), NAT64 `64:ff9b::/96` (RFC 6052) and 6to4 `2002::/16` (RFC 3056) are judged by the IPv4 address inside them; IPv4-compatible `::a.b.c.d` is always refused;
- internal names: `localhost` and `*.localhost`, `*.local`, `*.localdomain`, `*.internal` (including `metadata.google.internal`), `*.intranet`, `*.lan`, `*.home`, `*.corp`, `*.home.arpa`, `*.arpa`, and single-label names such as `metadata`;
- in saved flows, a host that isn't fixed: `{{ }}` is only allowed after the first `/` following the host (`checkWebhookUrlTemplate`), and `url` can't be a whole `{ $expr }` (`staticParams`).

**These checks are necessary but not enough.** A public name can resolve to a private address. The executor must:

1. resolve the host itself and pass every answer to `checkResolvedAddresses()`, which refuses the call if *any* answer is blocked;
2. connect to the address it checked (pin it with a custom `lookup`), so a second DNS answer can't swap in a private address (DNS rebinding);
3. not follow redirects: treat a 3xx as the result, or re-run both checks on every hop;
4. ignore `HTTP(S)_PROXY`, cap the time (`timeoutMs`, at most 10 s) and the response size (1 MB), sign the body with the connection's secret (`X-Phoenix-Signature`, HMAC-SHA256), and never forward cookies or internal headers.

`checkIp(address)` / `isBlockedIp(address)` fail closed: anything that isn't a canonical IPv4 or IPv6 address is blocked. References: OWASP Server-Side Request Forgery Prevention Cheat Sheet; WHATWG URL Standard §3.5 (IPv4 parser).

## 9. Times and money

- Instants are UTC ISO 8601 text with an offset (or epoch ms). Text without an offset is rejected rather than guessed.
- Wall-clock times use IANA zone names through `Intl.DateTimeFormat`, so daylight-saving changes are handled. A time in a spring-forward gap moves forward (02:30 becomes 03:30). Indian zones have no DST.
- Money in params and agent inputs is integer minor units plus an ISO 4217 code (`amountMinor: 2500000, currency: 'INR'` is ₹25,000).

## 10. Persistence contract (for wave 2; not implemented)

The engine has no tables. Suggested shape, consistent with ARCHITECTURE §13 (UUID keys, JSONB, audit and outbox in the same transaction):

| Table | Holds |
| --- | --- |
| `automation_flows` | id, group, unit (scope), key (unique per group), name, status (`draft`, `active`, `paused`, `archived`), `current_version`, created and updated by |
| `automation_flow_versions` | flow, version (unique per flow), `definition` JSONB (the normalised flow from `validateFlow`), created by and when. Immutable |
| `automation_runs` | id, flow, version, subject type and id, status, `state` JSONB, `next_wake_at` (indexed, partial on `status = 'waiting'`), `waiting_kind`, `waiting_event` and `waiting_key` (indexed for routing), trigger event id (unique per flow, so a re-delivered trigger can't start a second run), started, ended, error |
| `automation_effects` | `idempotency_key` (unique), run, step, action, params JSONB, status (`pending`, `done`, `failed`), result or error, attempts, timestamps |
| `automation_approvals` | `idempotency_key` (unique), run, title, body, approvers, data, `expires_at`, decision, decided by and when, comment |

Saving a run and inserting its effects happen in one transaction. Use a version check (`state` updated `WHERE id = ? AND updated_at = ?`) or `FOR UPDATE` so two workers can't advance the same run at once.

## 11. How wave 2 wires it in

1. **Registry**: build once at start-up with `automationRegistryFromModules(modules)` next to `createRegistry(modules)`, and let modules add `automation` declarations.
2. **Event router** (an outbox event handler for `*`): for `registry.triggersForEvent(event.type)`, load active flows with that trigger in the event's unit or above, call `matchTrigger` with `context.record`, check `canStartRun`, then `startRun` and `advance`. Runs waiting on `waiting_event = event.type` (for the same subject) get `advance` with the event. Effect results and approval decisions are routed by `waiting_key = idempotencyKey`.
3. **Timer worker**: every minute, take runs with `next_wake_at <= now()` (`FOR UPDATE SKIP LOCKED`), call `advance` with no event, and save. The same loop fires `schedule` triggers (`nextScheduleFire`) and scans for `no_activity` (`noActivityCutoff` and `noActivityEventId`).
4. **Executor**: a BullMQ job per effect, keyed by `idempotencyKey`. Bind a handler to each action key, check permissions and consent, apply section 8 for webhooks, then emit `automation.effect_result` for awaited effects. Non-awaited effects are fire-and-forget, so use `await: true` when a failure should change the flow's path.
5. **AI**: the `ai.run` handler calls the model with the agent's prompt, validates the reply against the agent's output schema (the interpreter checks again), and returns it as the result. `automation.request_approval` creates an approval item for the listed approvers. Their decision becomes `automation.approval_decided`.
6. **API**: CRUD for flows and versions (validate on save, block activation while there are errors), `GET /automation/catalog` (`registry.catalog()`), `POST /automation/flows/:id/simulate` (pass the server clock as `now`), and run lists with `state.trace` for the run view. Writes are audited, and flow activation emits outbox events.
7. **Permissions** to add with the module: `automation.view`, `automation.manage`, and a separate one for webhooks, since they send data out of the platform.

## 12. Decisions and limits

- **Pure engine, explicit clock**: easy to test and to replay; the runner owns time and storage.
- **Effects are emitted, not awaited, by default**: keeps runs fast. Use `await: true` when a later step needs the result or must react to failure.
- **One cursor per run, no parallel branches**: a flow is a state machine, not a DAG scheduler. Parallel work is two flows on the same trigger.
- **No months or years in durations**; use days or weeks.
- **Expression errors fail the run** rather than silently taking a branch, so bad data shows up in the run view. Missing fields are `null`, not errors.
- **Not done here**: the runner, executor, scheduler, tables, API routes and editor UI (wave 2); i18n of engine messages (English only); quiet-hours and consent checks (executor and messaging module).
