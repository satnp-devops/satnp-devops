# Stripe (international payments)

Client: `apps/api/src/integrations/providers/stripe/` · Tests: `apps/api/test/providers/stripe/` · Adapter kind: `payments (international)`

Facts below were checked against Stripe's own documentation on **2026-11-05**. Anything not confirmed is listed under [Unconfirmed](#unconfirmed).

## Can an Indian business use Stripe today?

**Only with an invitation.** Stripe's support article says "Stripe services are invite-only in India". Businesses from India can't sign up on the website and must request an invite through Stripe Sales (https://stripe.com/in/contact/sales). Stripe says it supports "a select number of businesses, with a focus on international expansion". Accounts that were already active stay supported. Platforms using Connect in India can add new connected accounts by invitation only. The support page gives no date. Press coverage from May 2024, and a Stripe page quoted in search results ("starting in May 2024"), date the change to May 2024. Nothing official says when invite-only will end.

**What this means for Phoenix:**

1. **The group already has an active Stripe India account (or gets an invitation).** Use this client with `indiaExports: true`. Stripe's requirements for Indian accounts taking payments from abroad (docs.stripe.com/india-exports):
   - The account must be a registered Indian business: a sole proprietorship, LLP or company. Individuals can't apply.
   - Opt in to exports during onboarding, or later in Dashboard settings.
   - Choose **one** transaction purpose code per account. Likely codes are **P1107** for education services, such as fees for courses offered to non-residents by Indian institutions, and **P0802** or **P0807** for software for the B2B side. If a different code is needed, use a separate Stripe account.
   - Provide an Importer Exporter Code (IEC). It's required for physical goods, and for AMEX international payments even when selling services. Otherwise it's optional for services.
   - Every international payment needs the customer's name, billing address (ISO-3166 alpha-2 country) and a description of the service. Without these, "the payment [may] fail". The client enforces a description and sets `billing_address_collection=required` on Checkout and Payment Links when `indiaExports` is on.
   - Payouts arrive in INR, with a separate "International" payout. International cards require 3D Secure.
   - Indian accounts can present 134 currencies (from the currencies page's country data). Three-decimal currencies (BHD, JOD, KWD, OMR, TND) aren't among them.
2. **No Stripe India account (the likely case for a new entity). Fallback:** take international payments through the Indian gateway being integrated in parallel (Razorpay; check its international-payments terms separately, since they weren't verified here). Alternatively, use a Stripe account held by a group entity outside India, which this client supports unchanged. Either way, keep `payments (international)` behind the adapter so the provider can be swapped per company.

## Capabilities

| Method | Stripe call | Notes |
|---|---|---|
| `createCheckoutSession(input, opts)` | `POST /v1/checkout/sessions` | Modes: `payment`, `subscription`, `setup`. Line items take a `priceId` or inline `{ name, amount, currency, recurring? }`. `description` and `metadata` are copied to the PaymentIntent (payment mode) or subscription. `ui_mode` defaults to `hosted_page`. |
| `retrieveCheckoutSession(id, { expand })` / `expireCheckoutSession(id)` | `GET /v1/checkout/sessions/:id`, `POST .../expire` | `expiresAt` must be 30 min to 24 h after creation. The client allows 31 min to 23 h 59 min to leave room for clock skew. |
| `createPaymentLink(input)` / `retrievePaymentLink` / `deactivatePaymentLink` | `/v1/payment_links` | Up to 20 line items, `price` or `price_data`. Links can't be deleted, only deactivated (`active=false`). |
| `createCustomer` / `updateCustomer` / `retrieveCustomer` / `findCustomersByEmail` | `/v1/customers` | Email search is Stripe's exact-match list filter. |
| `createProduct`, `createPrice`, `retrievePrice` | `/v1/products`, `/v1/prices` | One-time or recurring (`day`, `week`, `month`, `year`). |
| `createSubscription`, `retrieveSubscription`, `cancelSubscription(id, { atPeriodEnd })` | `/v1/subscriptions` | Cancelling sends `DELETE` to cancel now, or sets `cancel_at_period_end=true` to cancel at the end of the period. |
| `createRefund({ paymentIntentId \| chargeId, amount?, reason? })`, `retrieveRefund` | `/v1/refunds` | Leave out `amount` for a full refund. `reason` is one of `duplicate`, `fraudulent` or `requested_by_customer`. |
| `retrievePaymentIntent`, `retrieveEvent`, `retrieveAccount` | | `retrieveAccount()` doubles as a connection test and shows `country` (for example `IN`) and `default_currency`. |
| `request(method, path, params, opts)` | any `/v1/...` path | Escape hatch for endpoints without a wrapper. Every high-level input also accepts `extra` (raw Stripe params, deep-merged). |
| `webhooks.verify`, `webhooks.parse`, `webhooks.constructEvent` | | Use the configured secret(s), tolerance and clock. |
| Pure exports: `verifyWebhook`, `parseWebhook`, `constructEvent`, `computeSignature`, currency helpers, `encodeForm` | | No client needed. |

Not covered: PaymentIntents/Elements (direct card UI), Customer Portal, invoices API (beyond reading `invoice.*` events), Connect onboarding, disputes, payouts, Stripe Tax, API v2 endpoints.

## Config

Validated with zod (`stripeConfigSchema`, strict). Errors name the field, never the value.

| Field | Required | Default | Where to get it |
|---|---|---|---|
| `secretKey` | yes | none | Dashboard, then **Developers / API keys**. `sk_test_...` for a sandbox, `sk_live_...` for live. A restricted key (`rk_...`) with only the needed permissions is better. The mode (`test` or `live`) is taken from the key. |
| `webhookSecret` | for webhooks | none | Workbench, then **Webhooks**, open the destination, then **Reveal secret** (`whsec_...`). Use a different one per endpoint and per mode. Accepts an array while rolling a secret. `stripe listen` prints a local one. |
| `apiVersion` | no | `2026-10-28.endive` | Pinned on purpose. Use the same version for the webhook destination. |
| `accountId` | no | none | Connect only: sends `Stripe-Account: acct_...` (can be overridden per call with `opts.stripeAccount`). |
| `apiBase` | no | `https://api.stripe.com` | For a mock server in tests. Must be https with a live key. |
| `timeoutMs` | no | 30000 | Per attempt (1000 to 120000). |
| `maxRetries` | no | 2 | 0 to 5. |
| `webhookToleranceSec` | no | 300 | 1 to 3600. Zero isn't allowed because it disables replay protection. |
| `indiaExports` | no | false | Set to true for an Indian Stripe account taking payments from abroad (see above). |

Per-call options: `idempotencyKey` (string, or `false` to send none), `stripeAccount`, `timeoutMs`, `maxRetries`, `signal` (AbortSignal), and `expand` on retrieves.

## Usage for the adapter

```js
import { createStripeClient, StripeError } from '../providers/stripe/index.js';

const stripe = createStripeClient(connection.config, { fetch, now: Date.now, logger });
const session = await stripe.createCheckoutSession(
  {
    lineItems: [{ name: 'Admission fee - Grade 6', amount: 250000, currency: 'USD' }],
    successUrl: `${appUrl}/pay/success?cs={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl}/pay/cancel`,
    customerEmail: contact.email,
    clientReferenceId: payment.id,
    description: 'Admission fee',
    metadata: { phoenix_payment_id: payment.id, company_id: company.id },
  },
  { idempotencyKey: `checkout:${payment.id}` }, // stable per business operation
);
// session.url is the hosted page; session.lastResponse.requestId is for support tickets.

// Webhook route: needs the RAW body (express.raw({ type: 'application/json' })).
const event = stripe.webhooks.constructEvent(req.body, req.headers); // throws StripeSignatureError -> 400
if (await alreadyProcessed(event.id)) return res.sendStatus(200);  // Stripe can send an event twice
res.sendStatus(200); // acknowledge quickly, then queue the work
```

`constructEvent` returns a normalised event: `{ provider, id, type, kind, format, livemode, createdAt, apiVersion, account, requestId, idempotencyKey, object: { type, id }, payment, data }`. `payment` holds `amount`, `currency` (uppercase ISO), `status`, `paid`, `customerId`, `customerEmail`, the related ids (`checkoutSessionId`, `paymentIntentId`, `chargeId`, `invoiceId`, `subscriptionId`, `paymentLinkId`), `clientReferenceId`, `metadata`, `failure { code, declineCode, message }`, `refund { amountRefunded, fullyRefunded }`, `invoice { number, hostedUrl, billingReason, attemptCount, nextPaymentAttemptAt }` and `subscription { cancelAtPeriodEnd, currentPeriodEnd, canceledAt }`.

| Stripe event | `kind` | What to do |
|---|---|---|
| `checkout.session.completed` | `checkout.completed` | If `payment.paid` is true, the payment is complete. If it's false (`unpaid`, a delayed method), wait for the async events. |
| `checkout.session.async_payment_succeeded` / `_failed` | `checkout.async_payment_succeeded` / `_failed` | |
| `checkout.session.expired` | `checkout.expired` | |
| `payment_intent.succeeded` / `payment_intent.payment_failed` / `.canceled` | `payment.succeeded` / `payment.failed` / `payment.canceled` | `failure` carries the decline code. |
| `invoice.paid` / `invoice.payment_failed` | `invoice.paid` / `invoice.payment_failed` | Handles both invoice shapes: `parent.subscription_details.subscription` (from 2025-03-31.basil) and the older top-level `subscription` and `payment_intent`. |
| `charge.refunded` | `refund.updated` | Fires for partial and full refunds. Check `refund.fullyRefunded`. |
| `customer.subscription.created/updated/deleted` | `subscription.*` | `currentPeriodEnd` is read from the item (basil and later), falling back to the subscription. |
| anything else | `null` | Parsed. `data` holds the raw object. |

`RECOMMENDED_EVENT_TYPES` lists the types to subscribe the endpoint to. Thin events (`object: 'v2.core.event'`) parse with `format: 'thin'` and `data: null`. Fetch the details with `retrieveEvent` or the related object.

## Amounts and currencies

- Amounts are integers in Stripe's smallest unit: USD/INR cents and paise (10.99 USD is `1099`), and whole units for zero-decimal currencies (500 JPY is `500`). Currency codes are sent in lowercase, and the client lowercases them for you.
- Zero-decimal currencies (docs.stripe.com/currencies): BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, UGX, VND, VUV, XAF, XOF, XPF.
- Special cases: **ISK and UGX** must be sent as two-decimal values whose decimals are always `00` (5 ISK is `500`). The client rejects amounts that aren't multiples of 100, and `isoMinorToStripe` / `stripeToIsoMinor` convert from ISO 4217 minor units (where both have 0 decimals). HUF and TWD charge with two decimals, but payouts must be divisible by 100. Payouts aren't covered here.
- Helpers: `stripeDecimals`, `majorToStripeAmount('10.99', 'usd')` (exact, no floating-point maths), `stripeAmountToMajor`, `assertStripeAmount`.
- Minimum charge is 0.50 INR / 0.50 USD (it depends on the settlement currency). For non-card methods, INR amounts can have up to 9 digits (9,999,999.99 INR) and most others up to 8 digits. For cards, Stripe allows up to 12 digits, but card networks may set lower limits. These limits aren't enforced client-side, so Stripe returns `invalid_request`.
- Times: Stripe sends Unix seconds, and normalised events carry ISO 8601 UTC strings. `expiresAt` accepts a `Date` or Unix seconds.

## Idempotency, retries, errors

- Every `POST` gets an `Idempotency-Key` header (a random UUID v4, or the caller's key, up to 255 characters). Pass a **stable** key per business operation, such as `refund:<paymentId>:<n>`, so retries after a crash or restart can't double-charge or double-refund. Stripe keeps keys for at least 24 hours, compares parameters, and replays the first result, including 500s. A replayed response shows `lastResponse.idempotentReplayed`. `GET` and `DELETE` are idempotent and never carry a key.
- Retries only happen for safe calls: `GET`, `DELETE`, or `POST` with a key. They cover network errors, timeouts, 409, 429 and 5xx, or whatever the `Stripe-Should-Retry` header says (it overrides the status code). Backoff starts at 0.5 s, doubles up to a 5 s cap, adds jitter, and waits at least as long as `Retry-After` (giving up if that's over 60 s). Cancelling through `signal` is never retried.
- Every error is a `StripeError` with `category`, `retryable`, `status`, `type`, `code`, `declineCode`, `param` and `requestId`. Messages and `toJSON()` are redacted, so they never contain the key or secret.

| HTTP / type | `category` | `retryable` |
|---|---|---|
| 400 `invalid_request_error` | `invalid_request` | no |
| 400/409 `idempotency_error` | `idempotency` | no for 400 (parameters differ), yes for 409 (same key still in flight) |
| 401 | `authentication` | no |
| 402 / `card_error` | `card` | no (show `message` to the payer) |
| 403 | `permission` | no (a restricted key is missing a permission) |
| 404 | `not_found` | no |
| 409 | `conflict` | yes |
| 424 | `external_dependency` | no, unless `Stripe-Should-Retry: true` |
| 429 (`Stripe-Rate-Limited-Reason`, or `lock_timeout`) | `rate_limit` | yes |
| 5xx `api_error` | `api` | yes, but treat the outcome as unknown and reconcile before using a new key |
| network failure, timeout, caller abort | `connection`, `timeout`, `aborted` | yes, yes, no |
| bad config or input (nothing sent) | `config` | no |
| webhook verification, unreadable event | `signature`, `invalid_event` | no |

Logs (when a `logger` is injected) include method, path, status, Request-Id, attempt and duration. They never include params, bodies or headers.

## Webhooks

**Setup:**

1. In Workbench, open **Webhooks**, then **Create an event destination**, then **Your account**.
2. Choose **Snapshot** as the payload, with API version `2026-10-28.endive`, the same as the client.
3. Select the events in `RECOMMENDED_EVENT_TYPES`, choose **Webhook endpoint**, and enter the HTTPS URL.
4. Copy the `whsec_` secret.

Each account can have at most 16 destinations per mode. Test and live endpoints have different secrets. For local work, run `stripe listen --forward-to localhost:4126/<route>`, which prints a `whsec_` for the session, and `stripe trigger payment_intent.succeeded`.

The snapshot payload's shape follows the destination's API version, not the request's. Upgrade the destination and the client together.

**Verification scheme:**

- Header: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...][,v0=<hex>]`. Split on `,` and then on the first `=`. Use only `t` and `v1`, and ignore `v0` (a test-only fake scheme) and any other scheme to prevent downgrade attacks.
- `v1 = hex(HMAC-SHA256(key = the whole "whsec_..." string as UTF-8, message = "<t>." + raw body bytes))`. The key handling is confirmed from stripe-node's `NodeCryptoProvider`.
- The body must be the exact bytes received. Re-serialised JSON fails. The client refuses parsed objects.
- Comparison is constant-time (`crypto.timingSafeEqual` on the decoded 32-byte digests), against every `v1` and every configured secret. Stripe sends several `v1` values while a secret is being rolled, for up to 24 hours.
- Timestamp tolerance is 300 s (Stripe's library default). This client rejects `|now - t| > tolerance` **in both directions**, which is stricter than stripe-node: it only rejects old timestamps. Keep the server clock on NTP. The signature is checked before the timestamp, so a tampered, stale request reports `signature_mismatch`.
- Error codes (`StripeSignatureError.code`): `missing_secret`, `invalid_tolerance`, `invalid_body`, `missing_header`, `malformed_header`, `no_v1_signature`, `signature_mismatch`, `timestamp_outside_tolerance`. Respond 400 to all of them.
- Test vectors (`webhook.test.js`) were computed with node:crypto and cross-checked with `openssl dgst -sha256 -hmac`. One example: secret `whsec_phoenix_test_vector_secret`, `t=1762300800`, body `{"id":"evt_test_vector_1","object":"event","type":"payment_intent.succeeded"}` gives `v1=b8aab76570afbca27372f612ad44d5c25307f4149e3a7b8e3673106a7ee8784b`. There's also a UTF-8 body vector and a rotated-secret vector. Stripe publishes an example header (`t=1492774577,v1=5257a869...`) but not the secret or body behind it, so only parsing is tested against it.

**Delivery behaviour:**

- Return 2xx quickly and do the work asynchronously.
- In live mode, Stripe retries for up to 3 days with exponential backoff. In a sandbox, it retries 3 times over a few hours. A retried delivery gets a new timestamp and signature.
- Order isn't guaranteed, and an event can arrive twice. Deduplicate on `event.id`, and use `data.object.id` + `type` for the rare case of two separate events for the same change.
- `stripe events resend` resends an event for up to 30 days.
- Optionally allowlist Stripe's webhook IPs (docs.stripe.com/ips).

## Rate limits

docs.stripe.com/rate-limits:

- Global limit: 100 requests per second in live mode, 25 per second in a sandbox.
- Most endpoints: 25 requests per second each.
- Concurrency: 50 requests in progress at once in live mode.
- Search API: 20 reads per second.
- Read allocation: an average of 500 GET requests per transaction, with a minimum of 10,000 per month.

A 429 carries `Stripe-Rate-Limited-Reason` (`global-rate`, `endpoint-rate`, `global-concurrency`, `endpoint-concurrency` or `resource-specific`). A 429 without that header is a `lock_timeout`, meaning concurrent writes to the same object. Send writes to the same object one at a time. Stripe discourages load testing against a sandbox, because sandbox limits are lower. Mock Stripe for load tests instead, as these tests do.

## Sandbox and test mode

- Sandboxes are separate test environments, chosen from the Dashboard account picker. They use `sk_test_` keys and test-mode webhook secrets. `client.mode` reports `test` or `live`, and `event.livemode` tells you where an event came from. Never mix the two.
- Test cards (any future expiry date and any 3-digit CVC):
  - `4242 4242 4242 4242`: Visa, succeeds.
  - `4000 0035 6000 0008`: India (IN) Visa.
  - `4000 0000 0000 0002`: generic decline.
  - `4000 0000 0000 9995`: insufficient funds.
  - `4000 0025 0000 3155`: requires authentication.
- Test clocks (docs.stripe.com/billing/testing/test-clocks) simulate subscription renewals.

## Sources

All accessed 2026-11-05.

- docs.stripe.com/webhooks: signatures, tolerance, retries, ordering, secret rolling, setup.
- docs.stripe.com/events/how-events-work: snapshot and thin events, and the 16-destination limit.
- docs.stripe.com/api/idempotent_requests and docs.stripe.com/error-low-level: idempotency, `Stripe-Should-Retry`, `Idempotent-Replayed`, 24 h retention.
- docs.stripe.com/api/errors: status codes and error types.
- docs.stripe.com/rate-limits.
- docs.stripe.com/currencies and its HTML country data: zero-decimal list, special cases, minimums, maximums, India presentment list.
- docs.stripe.com/api/versioning and docs.stripe.com/upgrades: current version `2026-10-28.endive`.
- docs.stripe.com/changelog: ui_mode enum change in dahlia 2026-03-25, and the invoice changes in basil 2025-03-31.
- docs.stripe.com/api/checkout/sessions/create, /api/payment-link/create (`?query=line_items`), /api/prices/create, /api/refunds/create, /api/subscriptions/create.
- docs.stripe.com/india-exports: export requirements and purpose codes.
- support.stripe.com/questions/stripe-accounts-are-invite-only-in-india: invite-only status.
- docs.stripe.com/testing: test cards.
- github.com/stripe/stripe-node `src/Webhooks.ts` and `src/crypto/NodeCryptoProvider.ts`: header parsing, `DEFAULT_TOLERANCE: 300`, and the HMAC key handling.

## Unconfirmed

- **Three-decimal currencies** (BHD, JOD, KWD, OMR, TND). The current currencies page mentions "three-decimal currency support" in its meta description but lists no rule. The 3-decimal scale comes from memory, and the older "last digit must be 0" rule isn't enforced. None of these can be presented from Indian accounts.
- **UGX** appears both in Stripe's zero-decimal list and as a "represent as two decimals" special case. The client follows the special case (multiply by 100). Confirm with a sandbox charge before using UGX.
- **MGA**: ISO 4217's minor unit may differ from Stripe's (zero-decimal). `isoMinorToStripe` assumes they're the same.
- **The exact start date of invite-only.** The support page gives no date, and May 2024 comes from a Stripe page quoted in search results and press coverage. Whether an invitation is realistic for an education group isn't known.
- **The 424 retry policy.** Stripe doesn't say whether 424 is retryable, so the client treats it as permanent unless `Stripe-Should-Retry: true`.
- **409 vs 400 for idempotency errors.** Docs say 409 is "perhaps due to using the same idempotent key". The client relies on the status and header rather than on which status Stripe uses for a parameter mismatch.
- **Thin-event types for v1 resources** (for example `v1.checkout.session.completed`). `v1.` prefixes are mapped by stripping them, but no such v1 thin type was seen in the docs. Use snapshot destinations.
- **`payment_intent_data.description` and `subscription_data.description/metadata` on Payment Links.** These are documented as objects, but their child fields weren't expanded in the copy reviewed.
- Whether the `invoice.payments` list is included in `invoice.*` webhook payloads by default. The parser falls back to the legacy fields.
- Razorpay's (or any Indian gateway's) international-payments terms, mentioned as the fallback, weren't checked here.
