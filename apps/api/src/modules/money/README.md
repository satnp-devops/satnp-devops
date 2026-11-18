# Money module (phase 7): fees and billing

Plans and price lists, quotes (B2B) and fee proposals (B2C) with discount approval, agreements with
e-sign, payment links, instalment plans, B2B subscriptions, GST invoices, credit notes and refunds
with finance approval. The GST maths, numbering, instalments, proration and discount rules are the
pure engine in `core/billing` (docs/platform/BILLING_CORE.md); this module stores, scopes and wires them.

## Files

| File | Holds |
| --- | --- |
| `module.js` | permissions, role grants, settings, routes |
| `constants.js` | vocabularies (the migration builds its check constraints from them) |
| `schemas.js` | zod for every body and query |
| `access.js`, `lists.js` | scoping through the deal, keyset lists |
| `config.js` | Settings > Billing: profile (GSTIN), number series, plans, price lists, payment accounts, agreement templates |
| `quotes.js`, `pricing.js` | quotes and fee proposals, GST preview, discount policy, instalment option |
| `payments.js` | payment links, offline payments, `applyPaymentSuccess` / `applyPaymentFailure`, overview |
| `webhooks.js` | `handlePaymentWebhook` (Razorpay and Stripe), development deliveries |
| `invoicing.js`, `documents.js` | gap-free numbering, invoices and credit notes |
| `refunds.js` | request, finance approval, provider call, completion with a credit note |
| `instalments.js`, `subscriptions.js`, `agreements.js` (+ `pdf.js`) | the rest of the lifecycle |
| `dealBilling.js` | everything for one deal (FeesPanel, AgreementPanel) |
| `jobs.js` | job processors (reminders, retries, renewals, expiries) |
| `ports.js`, `gateways.js` | what the integrator connects; provider adapters |

## Scoping

Every billing record belongs to a deal (`deal_id`) and is scoped through it: a user sees it when
they hold `billing.view` at the deal's unit (own level: they own the deal), otherwise 404. Lists
filter `company_id` (or `group_id` at group scope) on the record and the deal's unit and owner.
Configuration follows contract §4.1 rule 6: read with `billing.view` or `billing.configure` at, above
or inside the company, write with `billing.configure` at the company.

| Permission | Who has it | Allows |
| --- | --- | --- |
| `billing.view` (own) | everyone working deals; finance, support, analysts | see billing of visible deals |
| `billing.manage` (own) | counsellors and account executives (own deals), managers, admins | quotes, links, agreements, subscriptions, refund requests |
| `billing.approve_discounts` | managers, company and group admins | approve within the tiers that name their role |
| `billing.finance` | finance, company and group admins | offline payments, credit notes, cancel invoices |
| `billing.approve_refunds` | finance, group admins | approve or reject refunds someone else requested |
| `billing.configure` | company and group admins | Settings > Billing |

## Settings (business rules, set on the group or a company)

`billing.discountFreePercent` (5), `billing.discountFreeAmount` (5000), `billing.discountManagerPercent`
(15), `billing.discountCompanyPercent` (30), `billing.discountSelfApproval` (true) build the
`discounts.js` policy; `billing.quoteValidityDays` (14), `billing.paymentLinkExpiryDays` (15),
`billing.reminderDaysBefore` ([3, 0]), `billing.overdueReminderDays` ([1, 7]),
`billing.paymentRetryHours` ([24, 72], counted from the failure), `billing.renewalReminderDays` (14).

## Flows

- **Fee proposal / quote.** Lines come from plans (SAC, rate, taxability) and a price list
  (currency, tax-inclusive or not). `computeTax` prices it; the place of supply comes from the
  recipient (GSTIN, state, or abroad: export under LUT when the company's LUT is valid). A discount
  is checked with `evaluateDiscount` and the role keys the user holds at the deal's unit:
  `allowed`, `needs_approval` (status `pending_approval`) or 422 when the policy forbids it.
- **Payment link.** `POST /billing/payments/links` with `purpose` `full` (what's left of the quote),
  `instalment`, `emi` (full amount, EMI offered at checkout), `subscription` or `adjustment`
  (finance). INR → the company's Razorpay account; other currencies → its Stripe account (an Indian
  Stripe account must have exports enabled and a purpose code, docs/providers/stripe.md: Stripe is
  invite-only in India) or, as the docs' fallback, a Razorpay account enabled for international
  payments. The row is written first, the provider called outside the transaction, then the link
  stored. One open link per thing paid for; a client `idempotencyKey` returns the first link.
- **Paid.** Webhook (or offline payment) → payment `succeeded`, instalment settled, sent quote
  accepted, subscription activated or renewed, GST invoice issued in a savepoint (billing not set
  up leaves `invoice_error`; finance issues it later with `POST /billing/payments/:id/invoice`),
  `payment.succeeded`, timeline entry with the provider event id as `sourceEventId`.
- **Invoice numbers** are allocated inside the issuing transaction from `billing_number_counters`
  (BILLING_CORE §5): gap-free, unique per GSTIN, document type and financial year, never backdated.
- **Refund.** Requested (`billing.manage`) → approved by someone else (`billing.approve_refunds`) →
  provider refund with the refund's own idempotency key → `refund.processed` from the webhook, with
  a credit note (`computeCreditNote`) against the invoice.
- **Agreement.** Template `{{placeholders}}` rendered, turned into a PDF, sent through the e-sign
  port; the Digio callback moves it to `partially_signed` / `signed` (`agreement.signed`) or `failed`.

## Wiring (for the integrator)

1. **Payment gateways.** Replace the development stub once at start-up:
   ```js
   import { configureMoneyPorts } from './modules/money/ports.js';
   import { razorpayGateway, stripeGateway, digioEsign } from './modules/money/gateways.js';
   configureMoneyPorts({
     paymentGateway: async ({ companyId, provider, account }) => {
       const client = await getAdapter('payments', { companyId, provider, connectionId: account?.connection_id });
       return provider === 'stripe' ? stripeGateway(client) : razorpayGateway(client, { accountRef: account?.account_ref });
     },
     esign: async ({ companyId }) => digioEsign(await getAdapter('esign', { companyId, provider: 'digio' })),
     notify: (message) => messaging.sendTemplate(message), // { template, companyId, dealId, contactId, variables, idempotencyKey }
   });
   ```
   Without this, development uses fake links and checks webhook signatures with `DEV_WEBHOOK_SECRETS`;
   production answers 503 `not_connected`.
2. **Webhooks.** Register one URL per payment account and one per company for Digio, and call the
   handler functions with the exact raw body (no JSON re-serialisation) and headers:
   - `handlePaymentWebhook({ accountId, rawBody, headers })` (webhooks.js)
   - `handleEsignWebhook({ companyId, rawBody, headers })` (agreements.js)
   They throw 401 `webhook_signature` on a bad signature and 400 `webhook_payload` for a body that
   isn't an event; answer 2xx for every other result (`applied`, `duplicate`, `ignored`, `unmatched`).
   Subscribe Razorpay to `payment.captured`, `payment.failed`, `payment_link.paid`,
   `payment_link.expired`, `payment_link.cancelled`, `refund.processed`, `refund.failed`; Stripe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded|failed`,
   `payment_intent.payment_failed`, `charge.refunded`; Digio to `doc.signed`, `doc.sign.failed`, `doc.sign.rejected`.
3. **Jobs.** Register the processors in `moneyJobs` (jobs.js) as repeatable jobs:
   `money.instalmentReminders` (every 30 min), `money.paymentRetries` (15 min),
   `money.subscriptionRenewals` (hourly), `money.expiries` (hourly). Each is idempotent.
4. **Web.** `FeesPanel` and `AgreementPanel` (`apps/web/src/components/money/`) take `dealId` and
   go on the deal profile (`/leads/[id]`, wave 2).

## Events

`quote.created`, `quote.updated`, `quote.discount_requested`, `quote.discount_approved`,
`quote.discount_rejected`, `quote.sent`, `quote.accepted`, `quote.declined`, `quote.cancelled`,
`quote.expired`, `instalment_plan.created`, `instalment_plan.rescheduled`, `instalment.reminder_due`,
`instalment.overdue`, `payment.link_created`, `payment.cancelled`, `payment.link_expired`,
`payment.succeeded`, `payment.failed`, `payment.retry_due`, `invoice.issued`, `invoice.cancelled`,
`credit_note.issued`, `refund.requested`, `refund.approved`, `refund.rejected`, `refund.processed`,
`refund.failed`, `subscription.created`, `subscription.activated`, `subscription.updated`,
`subscription.renewal_due`, `subscription.renewed`, `subscription.past_due`,
`subscription.cancel_scheduled`, `subscription.cancelled`, `agreement.created`, `agreement.sent`,
`agreement.signer_signed`, `agreement.signed`, `agreement.failed`, `agreement.expired`,
`agreement.cancelled`, and `billing.*` for setup changes. Deals and delivery react to them at
integration (for example `payment.succeeded` with `quoteFullyPaid` → move the deal to Enrolled).
