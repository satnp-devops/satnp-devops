# Automations (phase 9)

Flows that act on their own: a trigger, then conditions, branches, waits, actions, AI steps and approvals. The engine (`apps/api/src/core/automation`, [AUTOMATION_CORE.md](../platform/AUTOMATION_CORE.md)) is pure; this module stores flows and runs, routes events, advances waits, performs effects and serves the editor.

Code: `apps/api/src/modules/automations/`, web `apps/web/src/app/(app)/automations/`, types `apps/web/src/lib/automations/`. Migration `20261107000400_automations.js`, seed `33_automations.js`. Tests: `test/automations/` (unit) and `test/integration/automations.test.js`.

## 1. Data

| Table | Holds |
| --- | --- |
| `automation_flows` | A company's flow: `group_id`, `company_id`, `unit_id` (applies to subjects at this unit or below; the company by default), `key` (unique per company), `name`, `kind` (`standard`, `nurture`), `status` (`draft`, `active`, `paused`, `archived`), `trigger_type`, `version` (latest), `active_version` (what new runs start on), `definition` (copy of the latest version), `template_key`, `next_fire_at` (schedule trigger), `trigger_state` (no-activity scan cursor) |
| `automation_flow_versions` | Immutable versions: the normalised definition from `validateFlow`, warnings and stats, note, author. Unique `(flow_id, version)` |
| `automation_runs` | One run of one version for one subject: `subject_type`/`subject_id`/`deal_id`, `status`, `state` (the interpreter's state), `trigger` (the event), `trigger_event_id` (unique per flow: a re-delivered event starts nothing), `waiting_kind`/`waiting_event`/`waiting_key`, `next_wake_at`, `error`. Scoped by `unit_id` = the subject's unit |
| `automation_run_steps` | The step log (trace) of every run, one row per trace entry |
| `automation_effects` | What a run asked for, one row per idempotency key (`runId:stepId:visit`, unique): action, resolved params, status (`pending`, `running`, `done`, `recorded`, `failed`), executor, output or error, attempts |
| `automation_approvals` | Approval requests (approval steps, AI drafts that need a person): title, body, proposed `data`, approvers (`approver_user_ids`, `approver_permission`, `owner_user_id`), status (`pending`, `approved`, `rejected`, `expired`, `cancelled`), decision data, decider, expiry |

Nurture flows are flows of kind `nurture` (usually triggered by `deal.stage_changed` to lost with `record.nurture`).

## 2. Runtime

- **Event router** (`eventHandlers['*']` → `runner.handleEvent`): for each outbox event, runs waiting on that event type for the same subject resume (`advance` with the event), then active flows whose trigger listens to it (at the event unit or above) are matched (`matchTrigger` with the subject as `record`, the trigger filter in the engine's expression language), the re-entry rule is checked (`canStartRun`, plus at most 20 runs per flow and subject per hour) and a run starts. Each run change is one transaction (run row, step log, effects, approvals, `automation.run_*` events); runs are locked `FOR UPDATE` while advanced. `automation.effect_result` events (from other modules' executors) are routed to the waiting run. Company setting `automations.enabled` stops new runs.
- **Scheduler job** `automations.tick` (`runner.tick(db)`, every minute; safe to run concurrently): advances runs whose `next_wake_at` has passed (`FOR UPDATE SKIP LOCKED`, a savepoint per run), fires `schedule` triggers, scans quiet deals for `no_activity` flows, re-dispatches effects left pending for over 2 minutes.
- **Executors** (`actions.js`): effects are performed after commit through `ports.dispatchEffects` (in-process in development; one job per effect at integration). Order of lookup: `registerActionExecutor(key, fn)`, a module's `automation.executors`, built-ins (`http.call_webhook`), else the **development executor**, which records the effect (status `recorded`) with the action's sample output, so flows work end to end. In production an unbound action fails with `NO_EXECUTOR`. Awaited effects report back with `deliverEffectResult` (or an `automation.effect_result` event).
- **Webhooks** (`webhook.js`): the URL is checked again (`checkWebhookUrl`), the host resolved and every answer checked (`checkResolvedAddresses`), the connection pinned to the checked address, redirects never followed (3xx fails with `WEBHOOK_REDIRECT`), no proxy, 10 s and 1 MB caps, body signed `X-Phoenix-Signature: t=<unix>,v1=<hmac-sha256("t.body")>` with the connection's secret, plus `X-Phoenix-Idempotency-Key`.
- **Approvals**: the request becomes a row in the run's transaction (`automation.approval_requested` event for notifications). Deciding locks the run, then the approval, stores the decision, audits it (field names only, never drafts) and resumes the run in the same transaction. Timeouts expire the approval; cancelled runs withdraw it.
- Pausing a flow holds its waiting runs (timers and events wait); results of effects already in flight and approval decisions are still delivered.

## 3. Permissions

| Permission | Own | Grants by default |
| --- | --- | --- |
| `automations.view` | | group/company admin, manager, marketing, analyst: flows, versions, runs, the test panel |
| `automations.manage` | | group/company admin: create, edit, turn on, pause, archive, cancel runs (at the flow's unit) |
| `automations.webhooks` | | group/company admin: put "Call webhook" steps in flows |
| `automations.approve` | yes | admins and managers (all); counsellors and account executives (own: requests sent to them as owner or listed approver) |

Saving or turning on a flow also needs, at the "all" level at the flow's unit, the permission of each action it uses (`ACTION_PERMISSIONS`): `deals.manage` (send template, change stage, update field), `tasks.manage`, `deals.assign`, `automations.webhooks`. Flows are company configuration: readable with `automations.view` at, above or inside the company; everything outside the person's scope is 404. People, teams, pipelines and connections a flow names by id (`records.assign` `userId`/`teamUnitId`, `tasks.create` `assignee`, `deals.change_stage` `pipelineId`, approval `approvers.userIds`, `http.call_webhook` `connectionId`, whose secret signs the request) must belong to the flow's company: saving or turning on a flow that names anyone or anything else is 422 on that step (`assertFlowReferences` in `flows.js`). Values computed at run time (`{ $expr }`) are checked by the executors.

## 4. API (all under `/api/v1`, `describe()`d for OpenAPI)

| Method and path | Does |
| --- | --- |
| `GET /automations/catalog` | Triggers, actions, agents (JSON Schemas), functions, where each action runs |
| `GET /automations/templates` | Flow templates (welcome, two nurture templates for lost leads, no-show rebook, payment chaser, quiet deal) |
| `GET /automations/flows?unitId&status&kind&q` | Flows of the companies in the working scope, with run counts |
| `POST /automations/flows` | Create a draft from `definition` or `templateKey` (422 with engine errors under `body.definition…`) |
| `POST /automations/validate` | Check a definition without saving (errors, warnings, missing permissions) |
| `POST /automations/simulate` | Dry run (sample deal with `sample` changes, or a real deal by `dealId`/`dealRef`; scripted `events`, `results`, `approvals`) |
| `GET/PATCH/DELETE /automations/flows/:id` | Read; save (a new version when the definition changes; `baseVersion` → 409 on conflicting saves); archive (cancels open runs) |
| `POST /automations/flows/:id/activate`, `/pause` | Turn on (re-validated) or pause |
| `GET /automations/flows/:id/versions`, `/versions/:version`, `POST …/restore` | Version history; restore saves an old version as a new one |
| `GET /automations/runs?unitId&flowId&dealId&status`, `GET /automations/runs/:id`, `POST …/cancel` | Runs (keyset, newest first), detail with step trace, effects and approvals |
| `GET /automations/approvals?unitId&status`, `GET /automations/approvals/:id` | The approvals queue (pending by default) |
| `POST /automations/approvals/:id/approve` `{ data?, comment? }`, `/reject` `{ comment? }` | Decide; `data` may edit only the proposed fields |
| `POST /automations/tick` | Development only: run the scheduler job once (404 in production) |

Events emitted: `automation.flow_created`, `.flow_updated`, `.flow_activated`, `.flow_paused`, `.flow_archived`, `.run_started`, `.run_completed`, `.run_failed`, `.run_cancelled`, `.approval_requested`, `.approval_decided`. Audit: `automation_flow.*`, `automation_run.cancelled`, `automation_approval.approved|rejected`.

## 5. Wiring at integration

- Jobs framework: schedule `automations.tick` every minute (`module.jobs`), and connect `ports.dispatchEffects` to one job per effect calling `performEffect(db, effectId)` (job id = effect id, retries with backoff).
- Executors (`registerActionExecutor` or the owner module's `automation.executors`): `messaging.send_template` (messaging: consent, opt-outs, quiet hours), `tasks.create` (tasks), `deals.change_stage`, `records.assign`, `records.update_field` (deals), `ai.run` (AI platform; validate against the agent's output schema).
- `ports.getConnectionSecret({ companyId, connectionId })` from the integration framework (webhook signing secrets).
- Event names the catalog assumes (`core/automation/catalog.js`): `booking.created|rescheduled|cancelled`, `meeting.ended` (with `attendance`, and `rebookUrl` for the rebook template), `payment.succeeded|failed|refunded`, `payment_link.expired`, `instalment.overdue`, each with `dealId` in the payload.
- WhatsApp/email templates used by the seed flows: `enquiry_welcome`, `nurture_followup`, `nurture_next_intake`, `nurture_programme_update`, `nurture_early_bird`, `meeting_rebook`, `payment_reminder`, `payment_failed_standard`.
- Deal profile (wave 2): a panel can list `GET /automations/runs?unitId=…&dealId=…`.
