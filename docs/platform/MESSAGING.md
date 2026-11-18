# Messaging service

The platform's one way to talk to people on WhatsApp, email and SMS: conversations and messages,
WhatsApp's 24-hour customer-service window, consent and opt-out checks (India's DPDP Act), outbound
throttling, message templates with approval, and the webhook handlers for providers and for the
separate WhatsApp tool. Architecture phase 5 foundations; it sits on the integration framework
(docs/platform/INTEGRATIONS.md) and the phase-2 CRM tables (contacts, contact_methods, consents,
deals, timeline).

| Where | What |
| --- | --- |
| `apps/api/src/core/messaging/` | the service: `sendMessage`, `recordInboundMessage`, `recordMessageStatus`, `recordHandover`, `recordUnsubscribe`, the window, the rules, template rendering and validation, the throttle |
| `apps/api/src/modules/messaging/` | permissions, settings, HTTP API, template management, webhook handlers (`webhooks.js`), development helpers |
| `apps/api/src/db/migrations/20261106002200_messaging.js` | `message_templates`, `message_template_versions`, `conversations`, `messages` |
| `apps/api/src/db/seeds/22_messaging.js` | approved starter templates per company (booking link, reminders, payment link, welcome, ...) |
| `apps/web/src/components/messaging/` | `<ReplyBox>`, `<MessageThread>`, `<TemplatePreview>`, `<VariablesForm>` |
| `apps/web/src/app/(app)/settings/templates/` | Settings › Templates: list, editor with live preview, submit for approval |
| `apps/web/src/app/(app)/dev/messaging/` | a playground for the reply box (development only) |

## The WhatsApp tool and the CRM

WhatsApp chats are handled by a separate tool (a person or an AI bot). The CRM does not replace it:

- the tool (and the WhatsApp provider) post every message in and out, every delivery status and every
  handover to the CRM by webhook (below);
- the CRM finds or creates the person, keeps the conversation, attaches it to their open deal and shows
  it on the timeline; an enquiry with no open deal emits `message.received` with `isNewEnquiry: true`,
  which the intake service turns into a lead;
- the CRM itself sends approved templates (booking links, reminders, payment links) and, inside the
  24-hour window, short replies from the reply box. Both go through `sendMessage()`.

## Data model

| Table | Holds |
| --- | --- |
| `message_templates` | a company's template identity: channel, name (`booking_link`), language (`en`, `hi`, `en_US`), category, the latest version's status and `approved_version`, the version sends use |
| `message_template_versions` | each version's content: header, subject, body, footer, buttons, sample values, provider template name/id, status, who submitted it, rejection reason |
| `conversations` | one thread per company, channel, connection and customer address (`company_id, channel, connection_key, contact_address` unique). Holds `last_inbound_at` (the window), `last_outbound_at`, the deal it is about and `handled_by` (bot, human or crm, from handovers) |
| `messages` | every message in or out: direction, status and its timestamps (`sent_at`, `delivered_at`, `read_at`, `failed_at`, `received_at`), purpose, template id/version/name and variables, subject and rendered body, media references, addresses, connection and provider, `provider_message_id`, `reference` (the caller's idempotency key), source (`crm`, `provider`, `whatsapp_tool`), actor (user, system, ai, contact), the tool's agent, error code and message |

Idempotency lives in the database: one message per `(company_id, channel, provider_message_id)` and
per `(company_id, reference)`. A message stores the rendered body, so history stays readable after a
template changes; bodies and addresses are personal data and never go into the audit log or events,
with one exception: `message.unrouted` carries the sender's address and text, because nothing was
stored yet and intake needs them to route the message (the payload stays in the outbox).

## Sending: `sendMessage()`

```js
import { sendMessage } from '../../core/messaging/index.js';

const { message, conversation, created } = await sendMessage({
  companyId, channel: 'whatsapp',            // whatsapp | email | sms
  contactId, methodId,                       // methodId optional: default is their primary number/address
  templateId,                                // or template: { name: 'booking_link', language: 'en' }, or text
  variables: { booking_link: url },          // standard variables are filled in automatically
  dealId,                                    // optional: the timeline entry goes on the deal
  reference: `automation:${runId}:${stepId}`, // optional idempotency key
  actor: { type: 'system' },                 // user (with userId) | system | ai
}, { req });                                 // req only for the audit row's request context
```

Callers must already have scoped the company, person and deal to whoever is acting (the HTTP routes do
it with `loadSubject`, automations act for their company). In order:

1. Load the company, person, number or address, deal and template; render the template.
2. Decide (`decideSend`, pure, in `core/messaging/rules.js`). The first failure is the answer and
   nothing is written; the error is `409 message_blocked` with `details.reason`:

   | reason | when |
   | --- | --- |
   | `opted_out` | the number or address is opted out of everything (`contact_methods.opted_out_at`) |
   | `consent_withdrawn` | the person withdrew consent for this purpose on this channel (or on all channels) |
   | `marketing_consent_missing` | marketing needs a recorded grant |
   | `template_not_approved` | the template has no approved version |
   | `template_required` | SMS only sends registered templates (TRAI DLT) |
   | `outside_window` | WhatsApp free text outside the 24-hour window |

   The purpose comes from the template's category (`marketing` → marketing; `utility` and
   `authentication` → transactional) and can't be lowered by the caller. Free text is `service` (a
   reply in a conversation) unless the caller raises it. Transactional and service messages need only
   the absence of a withdrawal; marketing needs a grant (core/crm/consent.js).
3. Pick the connection: the thread's own while it is usable, else the company's default connection
   for the channel (`getAdapter`), else the built-in mock outside production. Take a throttle token.
4. Transaction 1: upsert the conversation and insert the message as `queued`.
5. Call the provider, outside any transaction.
6. Transaction 2: `sent` (with the provider message id) or `failed` (error code and message), the
   timeline entry (kind `message`, or `email` for email; `source_event_id = message:<id>`), first-reply
   SLA via the timeline, `message.sent` or `message.failed`, and the audit row.

A provider refusal is not an exception: the message is stored as failed and returned. A row left
`queued` means the process died between steps 4 and 6 (`messages_queued_idx` finds them).

### The 24-hour window

`customerServiceWindow(lastInboundAt, { now })` in `core/messaging/window.js`: open for 24 hours after
the person's last inbound message on that thread, closed with no inbound message, closes exactly at 24
hours; a timestamp slightly in the future (clock skew) counts as now. It returns `open`, `expiresAt`
and `remainingSeconds`, which the reply box turns into "Free text allowed for 13 h more" or "Outside
the 24-hour window: send a template". Templates are allowed either way.

### Throttling

`core/messaging/throttle.js`: a token bucket per connection in Redis (a Lua script on the Redis clock,
so every API process and worker shares one budget per number, inbox or sender). Limits per channel are
in `THROTTLE_LIMITS` of `core/messaging/constants.js` (WhatsApp and SMS 20/s with a burst of 40, email 10/s with a burst of 20, below
the providers' limits). A send waits up to 3 s for a token, then fails with `429 message_throttled`,
which a background job simply retries. If Redis is down the send goes ahead and a warning is logged.
The webhooks and jobs service now has a shared throttle (`core/jobs/throttle.js`, overridable with the
`THROTTLE_LIMITS` environment variable); sends don't use it yet, so that variable doesn't change these
limits. Pointing `throttleOutbound({ key, ratePerSecond, burst })` at it needs no change in callers.

## Receiving: `recordInboundMessage()` and statuses

`recordInboundMessage({ companyId, channel, connectionId, from, to, contactName, text, subject, media,
providerMessageId, occurredAt, source, direction })` is provider-neutral. In one transaction it:

- returns `{ created: false }` for a provider message id it already has (also when two deliveries race);
- normalises the address (E.164 with the company's default country, or lower-case email), finds the
  person by it (core/crm/contacts.js de-duplication) or creates them, and links them to the company;
- opens or updates the conversation (`last_inbound_at` opens the window), attaches the message to the
  person's open deal in that company, if any;
- writes the timeline entry and emits `message.received` with `contactCreated`, `isNewEnquiry` (no open
  deal) and `windowExpiresAt`;
- if the whole reply is an opt-out keyword (setting `messaging.optOutKeywords`, default
  `STOP, UNSUBSCRIBE, STOP ALL, बंद करें`), records a marketing-consent withdrawal on that channel
  (`consent.recorded`). Transactional messages such as receipts still go out.

`direction: 'outbound'` records a message someone else sent (the WhatsApp tool's bot or agent):
`message.sent` with `source: 'whatsapp_tool'`.

`recordMessageStatus({ channel, connectionId, providerMessageId, status, occurredAt, errorCode,
errorMessage })` applies `sent`, `delivered`, `read` or `failed`. Statuses only move forward (a late
`delivered` after `read` fills `delivered_at` but keeps `read`), each timestamp is set once, failure is
final, and a repeat changes nothing. A change updates the timeline entry's `meta.status` and emits
`message.status_changed` (or `message.failed`). Unknown message ids are ignored.

`recordUnsubscribe` (email unsubscribe and spam reports) withdraws marketing consent on that channel;
`recordHandover` stores who handles a WhatsApp chat now and puts a system entry on the timeline.

### Routing an inbound message to a company

`resolveInboundCompany`: the connection's company when it serves one; on a shared connection, the
company hint from the WhatsApp tool when the connection serves that company, else the company of the
person's most recent thread on that connection. When none fits, the handler
emits `message.unrouted` (with the connection, address and text) and the intake service's classifier
picks the company.

## Webhooks

The webhooks service owns the HTTP route, signature checks, de-duplication by `(connection, eventId)`,
the queue, retries and the dead-letter queue. The messaging module provides handlers; each one is
idempotent, resolves to `{ status: 'processed' | 'duplicate' | 'ignored' | 'unrouted', ... }`, throws
`AppError 422 webhook_invalid` for a payload it can't read (don't retry: dead-letter it) and throws
anything else only for problems a retry can fix.

### Provider events

`messagingWebhookHandlers[connection.kind][event.type](event, { connection })` in
`modules/messaging/webhooks.js`, for the normalised events adapters' `parseWebhook()` return
(`{ eventId, type, occurredAt, data }`):

| Kind | Event types and `data` |
| --- | --- |
| `messaging.whatsapp` | `message.received` `{ from, to?, providerMessageId, text?, mediaType?, contactName?, replyToProviderMessageId? }`; `message.status` `{ providerMessageId, status: sent\|delivered\|read\|failed, errorCode?, errorMessage? }`; `template.status` `{ name, language, status: APPROVED\|REJECTED\|..., reason? }` |
| `messaging.email` | `email.received` `{ from, to?, subject?, text?, messageIdHeader?, inReplyTo? }`; `email.delivered`, `email.opened`, `email.clicked` (→ read), `email.bounced` (hard → failed, soft ignored), `email.unsubscribed`, `email.spam_reported` (→ marketing withdrawn), all `{ providerMessageId, email?, bounceType?, reason? }` |
| `messaging.sms` | `sms.delivered`, `sms.failed` `{ providerMessageId, to?, reason? }` |

`handleMessagingWebhookEvent(kind, event, context)` runs the right one (or returns `ignored`).

**Registration.** `modules/messaging/module.js` declares them as `webhookHandlers` (`messagingWebhookHandlerMap`: `'<kind>:<event>'` and `'whatsapp_tool:<event>'`), so the webhooks worker runs them for every connection of those kinds. The wrapper passes `{ connection: { id, kind, provider } }` from the stored event and turns a 4xx `AppError` (an unreadable payload) into `PermanentJobError`, so the event is dead-lettered at once instead of retried.

### The WhatsApp tool's webhook

The tool posts to `POST /api/v1/webhooks/whatsapp_tool/:connectionId`, where the connection is the
company's (or the group's shared) active `messaging.whatsapp` connection, whatever its provider.
`whatsappTool` in `modules/messaging/webhooks.js` is shaped like an adapter's webhook methods
(`verifyWebhook`, `parseWebhook`, `webhookChallenge`, `handlers`); the module declares it as the
webhook source `whatsapp_tool` (`webhookSources`, docs/platform/WEBHOOKS_AND_JOBS.md), so its events
are stored, de-duplicated and retried like a provider's, with `provider = 'whatsapp_tool'`, and only
the tool's handlers run for them.

**Signing.** Header `X-Phoenix-Signature: sha256=<hex HMAC-SHA256 of the exact raw body>`. The secret
is derived per connection from `ENCRYPTION_KEY` (`whatsappToolSecret(connectionId)`), never stored;
show it to an admin once when they set the tool up. `GET ...?challenge=x` echoes `x` for set-up checks.

**Body.** Up to 100 events per request:

```json
{
  "events": [
    {
      "id": "evt_01J9...",
      "type": "message.in",
      "occurredAt": "2026-11-06T09:30:00Z",
      "data": { "messageId": "wamid.HBgM...", "from": "+919812345678", "contactName": "Asha Rao", "text": "Is the SAT batch full?" }
    }
  ]
}
```

| `type` | `data` | What the CRM does |
| --- | --- | --- |
| `message.in` | `messageId` (WhatsApp's wamid), `from`, `to?`, `contactName?`, `text?`, `media[]?`, `replyToMessageId?`, `companyId?` | records an inbound message; the same wamid from the provider and the tool is stored once |
| `message.out` | `messageId`, `to`, `from?`, `text?`, `media[]?`, `template?: { name, language? }`, `agent: { type: bot\|human, name?, email? }`, `companyId?` | records the bot's or agent's reply (`source: whatsapp_tool`; a human agent is matched to a CRM user by email) and sets `handled_by` |
| `message.status` | `messageId`, `status: sent\|delivered\|read\|failed`, `errorCode?`, `errorMessage?` | applies the status (idempotent) |
| `conversation.handover` | `from` (the person's number), `to: human\|bot\|crm`, `reason?`, `summary?`, `agent?`, `companyId?` | sets `handled_by`, puts the handover and the bot's summary on the timeline, emits `conversation.handover` |

`media[]` items are `{ type: image|video|audio|document|sticker|location|contact|other, url?, fileId?,
mimeType?, caption?, fileName? }`; the CRM keeps the references, not the files. `companyId` is a hint
for shared numbers and is only used when that company is under the connection's group.

`buildWhatsappToolRequest(connectionId, events)` builds a signed request for tests and local tries.

## Templates

A template belongs to one company and is identified by channel, name and language. Categories:
`utility` (booking links, reminders, receipts), `marketing`, `authentication` (codes). Content: body
with `{{variables}}` (named like `{{first_name}}`, or WhatsApp-style `{{1}}`), and per channel a text
header, footer and buttons (WhatsApp: quick reply, URL, phone; up to 10), or a subject (email).
`validateTemplate` checks names, braces, limits (WhatsApp body 1024, header and footer 60, 25-character
buttons; SMS 1000; email subject 200), variables at the edges of a WhatsApp body, and on submit that
every variable has a sample value.

Rendering (`renderTemplate(content, variables)`) fills every placeholder, reports missing ones, cleans
values per channel (no line breaks on WhatsApp, 160 characters on SMS) and gives adapters positional
parameters in order of first appearance (`toProviderText` turns `{{first_name}}` into `{{1}}`). The
standard variables `first_name`, `contact_name`, `company_name`, `deal_ref` and `owner_name` are filled
in from the person, company, deal and owner; callers pass the rest.

**Versions and approval.** A template starts as version 1, `draft`. Editing a draft changes it in
place; a submitted version can't be edited until the provider decides (409); editing an approved or
rejected one starts a new draft version while sends keep using the approved one (`approved_version`),
and an approved template keeps its category. Submitting: email templates and companies on the mock (or
the built-in fallback) are approved at once; with a real WhatsApp or SMS provider the version stays
`submitted` until the provider's `template.status` webhook approves or rejects it (with a reason; a
provider pausing or disabling a live template takes it out of use). The adapters have no "submit
template" call yet, so registering the template with Meta or MSG91 DLT is done in their consoles.
Archiving hides a template from lists and sends. Events: `message_template.created`, `.updated`,
`.submitted`, `.approved`, `.rejected`, `.archived`.

## Endpoints (`/api/v1`)

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /messaging/context?dealId=\|contactId=&companyId=` | `messaging.view` | the reply box in one call: channels with numbers or addresses (masked without `contacts.view_pii`), the connection each would use, the window per WhatsApp number, consent per purpose, approved templates, default variable values, `can.send` |
| `GET /messaging/messages?dealId=\|contactId=&channel=&cursor=&limit=` | `messaging.view` | newest first, keyset pages (`occurred_at, id`) |
| `POST /messaging/messages` | `messaging.send` | `{ dealId \| contactId, companyId?, channel, methodId?, templateId \| text, variables, subject?, purpose?, clientId? }` → 201 `{ data: message }`; `clientId` makes retries safe. Refusals are 409 `message_blocked` |
| `GET /messaging/templates?unitId=\|companyId=&channel=&status=&includeArchived=` | `messaging.templates_view` | |
| `POST /messaging/templates` | `messaging.templates_manage` | 201, a draft |
| `GET /messaging/templates/:id` | `messaging.templates_view` | with its versions |
| `PATCH /messaging/templates/:id` | `messaging.templates_manage` | edits, or a new version |
| `POST /messaging/templates/:id/submit` | `messaging.templates_manage` | |
| `DELETE /messaging/templates/:id` | `messaging.templates_manage` | 204, archives |
| `GET /messaging/dev/deals`, `POST /messaging/dev/inbound`, `POST /messaging/dev/status` | `deals.view` / `messaging.send` | development only (404 in production or when mocks are off): pretend a person wrote in or a provider reported a status |

## Access

A request is about a deal or a person in one company (`modules/messaging/access.js`). With a deal: the
deal must be visible (`deals.view`, own respected), the permission is checked on the deal (counsellors
have `messaging.view:own` and `messaging.send:own`: deals they own), and the person must be on the
deal. With a person: they must be visible and known to the company; the permission is checked on the
company's link to them. Records you can't see are 404, visible ones without the permission 403.
Numbers and email addresses are masked for roles without `contacts.view_pii`.

| Permission | Granted to |
| --- | --- |
| `messaging.view` | group and company admins, managers, finance, marketing, support; counsellors and account executives (own) |
| `messaging.send` | group and company admins, managers, finance, support; counsellors and account executives (own) |
| `messaging.templates_view` | everyone except partners |
| `messaging.templates_manage` | group and company admins, marketing |

## Privacy

`contact.merged` moves the source person's conversations and messages to the surviving one;
`contact.erased` blanks message bodies, subjects, addresses, media and variables and the conversation
addresses, keeping the rows (status and timestamps) for the record.

## Web

- `<ReplyBox dealId contactId? companyId? onSent? />` (`@/components/messaging`): channel picker,
  number picker, window indicator, template picker with a variables form and a live preview, free text
  (with subject for email), send with an optimistic message and clear errors for each refusal.
- `<MessageThread dealId | contactId />`: the conversation with delivery ticks.
- Settings › Templates: templates per company and channel with status; the editor has the content on
  the left and a live preview with sample variables on the right, Save, Submit for approval, versions.
- `/dev/messaging` (development only): pick a deal, then use the reply box, pretend the person replied
  (opens the window) or that the provider delivered or read a message.

## Tests

- Unit (`apps/api/test/messaging/`): the window, template parsing, validation and rendering, the send
  rules (consent, opt-out, templates, window), opt-out keywords, status ordering, the token bucket,
  number and connection choice.
- Integration (`apps/api/test/integration/messaging.test.js`, `INTEGRATION=1`): a template send recorded
  by the mock with its timeline entry and event, idempotent client retries, the window, email and SMS
  rules, provider failures, idempotent statuses, consent and STOP replies, an unknown sender creating a
  person and a conversation once, the WhatsApp tool's signed events and handover, keyset pages, scoping
  (other companies 404, own-only counsellors, masked numbers), automation sends by template name, and
  the template lifecycle.
