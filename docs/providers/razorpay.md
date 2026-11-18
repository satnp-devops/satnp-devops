# Razorpay (payments, INR)

Client: `apps/api/src/integrations/providers/razorpay/` · Tests: `apps/api/test/providers/razorpay/` · Facts checked against razorpay.com/docs on 2026-11-05.

The client depends only on zod and the global `fetch`. It covers orders, payment links, refunds, plans and subscriptions, checkout and payment-link signature checks, webhook verification and parsing, and error mapping. Wave 2 wraps it in the platform's payments adapter.

```js
import { createRazorpayClient } from '../integrations/providers/razorpay/index.js';

const rzp = createRazorpayClient(
  { keyId, keySecret, webhookSecret, accountId },   // from the company's connection settings
  { logger },                                       // fetch, now, sleep, random, idempotencyKey are optional
);
const order = await rzp.createOrder({ amount: 150000, currency: 'INR', receipt: 'adm_2026_0042' }); // ₹1,500.00
const event = rzp.handleWebhook(req.rawBody, req.headers); // throws RazorpayError('signature') if it fails
```

## Capabilities

All amounts are integer minor units (paise for INR) with an ISO currency (default `INR`). Times go in as `Date`, ISO-8601 with offset, or unix seconds, and come out as ISO-8601 UTC strings (`null` when Razorpay sends `0`/`null`). Results are camelCase objects with the original response on `raw`.

| Method | Razorpay call | Retries |
|---|---|---|
| `createOrder({ amount, currency, receipt, notes, partialPayment, firstPaymentMinAmount })` | `POST /v1/orders` | 429 only |
| `fetchOrder(id)` | `GET /v1/orders/:id` | safe |
| `fetchPayment(id)` | `GET /v1/payments/:id` | safe |
| `createPaymentLink({ amount, currency, description, customer{name,email,contact}, notify{sms,email}, reminderEnable, expireBy, referenceId, notes, callbackUrl, acceptPartial, firstMinPartialAmount })` | `POST /v1/payment_links/` (sets `callback_method: 'get'` when `callbackUrl` is given) | 429 only |
| `fetchPaymentLink(id)` | `GET /v1/payment_links/:id` | safe |
| `cancelPaymentLink(id)` | `POST /v1/payment_links/:id/cancel` | 429 only |
| `createRefund(paymentId, { amount?, speed: 'normal'\|'optimum', receipt, notes, idempotencyKey? })` | `POST /v1/payments/:id/refund` + `X-Refund-Idempotency` | safe (key always sent) |
| `fetchRefund(id)` | `GET /v1/refunds/:id` | safe |
| `createPlan({ period, interval, item{name,amount,currency,description}, notes })` | `POST /v1/plans` | 429 only |
| `fetchPlan(id)` | `GET /v1/plans/:id` | safe |
| `createSubscription({ planId, totalCount, quantity, startAt, expireBy, customerNotify, addons[{name,amount,currency}], offerId, notes })` | `POST /v1/subscriptions` | 429 only |
| `fetchSubscription(id)` / `getSubscriptionStatus(id)` | `GET /v1/subscriptions/:id` | safe |
| `cancelSubscription(id, { atCycleEnd })` | `POST /v1/subscriptions/:id/cancel` `{ cancel_at_cycle_end }` | 429 only |
| `checkoutOptions({ orderId, amount, ... })` | builds Standard Checkout options; includes only the public key id | none |
| `verifyPaymentSignature`, `verifySubscriptionSignature`, `verifyPaymentLinkSignature` | uses the key secret | none |
| `verifyWebhook(rawBody, headers)`, `handleWebhook(rawBody, headers)`, `parseWebhook(body, headers?)` | uses the webhook secret | none |

The pure helpers are also exported without a client: `verifyWebhook(rawBody, headers, secret, { maxAgeSeconds, now })`, `parseWebhook(body, headers)`, `verifyPaymentSignature(input, keySecret)`, and the rest.

Before a request goes out, inputs are checked locally and an invalid input throws `RazorpayError('validation')`. The checks are:

- ids must have the right prefix (`order_`, `pay_`, `plink_`, `rfnd_`, `plan_`, `sub_`), which also keeps URL paths safe
- INR orders and links must be at least 100 paise
- `notes` can have at most 15 pairs of up to 256 characters each
- `receipt` and `reference_id` can be at most 40 characters
- a link description can be at most 2048 characters
- `expireBy` must be in the future
- `callbackUrl` must be http(s)
- daily plans need `interval >= 7`
- refund idempotency keys must be at least 10 characters from `[A-Za-z0-9_-]`

Not covered yet: listing endpoints, payment capture (payments are assumed to auto-capture), updating orders or links, UPI payment links, customers, invoices, QR codes, Route, and subscription pause, resume and update.

## Config fields

| Field | Required | Where to get it |
|---|---|---|
| `keyId` | yes | Dashboard → Account & Settings → API Keys (under Website and app settings) → Generate Key. Looks like `rzp_test_…` or `rzp_live_…` and is safe to show in the browser. |
| `keySecret` | yes | Shown once when the key is generated; Razorpay never shows it again (regenerate it if lost). It is secret. |
| `webhookSecret` | for webhooks | A secret you choose when adding the webhook (Account & Settings → Webhooks). It does not need to match the key secret. Pass `[new, old]` while rotating. |
| `mode` | no | `test` or `live`. Inferred from the key prefix and must agree with it. Required only if the prefix is neither. |
| `accountId` | no | Merchant account id (`acc_…`, the `account_id` in webhook bodies). When set, webhooks from another account are rejected. |
| `baseUrl` | no | Default `https://api.razorpay.com/v1`, the same host for test and live. Override it only for a proxy or a mock. |
| `timeoutMs` | no | Per-attempt timeout, default 15000. |
| `maxRetries` | no | Default 2, so at most 3 attempts. |
| `retryBaseDelayMs` / `retryMaxDelayMs` | no | Backoff, default 300 / 5000. |
| `webhookMaxAgeSeconds` | no | Off by default. This is our own policy, not a Razorpay rule. Because Razorpay retries for 24 hours, any value should be above 86400. |

Secrets live only in the client's closure. The client does not log them, `toJSON()` leaves them out, and error messages pass through `redact()`, which removes the key secret, the webhook secrets and the Basic-auth token. The logger receives only `op`, `method`, `status`, `kind`, `attempt`, `durationMs` and `retryInMs`, never headers or bodies (bodies contain customer email and phone numbers).

## Webhooks

**Setup.** In the Dashboard, go to Accounts & Settings → Webhooks (under Website and app settings) → Add New Webhook. Enter the URL, a secret, an alert email and the active events. Set up the test and live modes separately; the OTP for test-mode webhook changes is `754081`. Subscribe to these events:

- `payment.captured` and `payment.failed`
- `order.paid`
- `payment_link.paid`, `payment_link.partially_paid`, `payment_link.cancelled` and `payment_link.expired`
- `refund.processed` and `refund.failed`
- `subscription.*`

Webhook endpoints have these rules:

- The URL must be public and use port 80 or 443 with TLS 1.2 or later.
- Localhost and tunnels such as ngrok.io, loca.lt, webhook.site and requestbin.com are blocked. Razorpay suggests zrok for local testing.
- An account can have up to 30 webhook URLs.
- Allowlist Razorpay's webhook IPs if a firewall is in front of the endpoint.

**Verification scheme (implemented exactly):**

- Header `X-Razorpay-Signature` holds the lowercase hex of `HMAC-SHA256(key = webhook secret, message = raw request body bytes)`.
- The body must be raw. Re-serialising parsed JSON changes the bytes, so the client refuses a non-string, non-Buffer body (`raw_body_required`). In Express, capture the body with `express.raw({ type: 'application/json' })` or a `verify` hook on the webhook route.
- The client decodes the hex and compares it in constant time (`crypto.timingSafeEqual`). When several secrets are configured, it checks every one with no early exit.
- Razorpay defines no timestamp tolerance and sends no timestamp header. The body's `created_at` (unix seconds) is covered by the signature, and the optional `maxAgeSeconds` check uses it after the signature passes. That check allows 300 s of clock skew for future-dated events.
- `verifyWebhook` returns `{ valid, reason?, eventId }`. The possible reasons are `missing_secret`, `raw_body_required`, `missing_signature`, `malformed_signature`, `signature_mismatch`, `invalid_json`, `missing_timestamp`, `expired` and `from_future`.

**Idempotency.** Delivery is at least once. Razorpay retries any non-2xx response, and any response slower than 5 s, with exponential backoff for 24 hours, then disables the webhook and emails the alert address. Events can also arrive out of order; for example, `payment.captured` may come before `payment.authorized`. Use `event.dedupeKey` as the processed-events key:

- Normally it is `razorpay:<X-Razorpay-Event-Id>`.
- If the header is missing, the client uses `razorpay:derived:<hash of type, entity id, status and created_at>`.

Reply 2xx quickly and do the work in a queue.

**Normalised event** (`parseWebhook` / `handleWebhook`):

```js
{ provider: 'razorpay', eventId, dedupeKey, type: 'payment.captured', kind: 'payment.succeeded',
  accountId: 'acc_…', occurredAt: '2019-09-05T09:10:06.000Z', contains: ['payment'],
  payment: { id, orderId, status, amount, currency, method, captured, amountRefunded, fee, tax, error, notes, email, contact, … } | null,
  order | paymentLink | refund | subscription: {…} | null,
  raw }
```

Each provider event maps to a `kind`:

| Razorpay event | `kind` |
|---|---|
| `payment.authorized` | `payment.authorized` |
| `payment.captured` | `payment.succeeded` |
| `payment.failed` | `payment.failed` |
| `payment.pending` | `payment.pending` |
| `order.paid` | `order.paid` |
| `payment_link.paid` / `.partially_paid` / `.cancelled` / `.expired` | the same name |
| `refund.created` | `refund.created` |
| `refund.processed` | `refund.succeeded` |
| `refund.failed` | `refund.failed` |
| `refund.speed_changed` | `refund.updated` |
| `subscription.authenticated` / `.activated` / `.charged` / `.completed` / `.updated` / `.pending` / `.halted` / `.paused` / `.resumed` / `.cancelled` | the same name |
| anything else | `other` |

Razorpay sends `notes: []` when there are no notes; the client normalises that to `{}`.

**Checkout signatures** use the API key secret, not the webhook secret. All three were checked against Razorpay's published examples or against our own vectors cross-checked with OpenSSL:

- Orders: `HMAC(order_id + "|" + razorpay_payment_id)`. Use the order id stored on the server. Matches Razorpay's own example (`order_IEIaMR65cu6nz3`, secret `EnLs21M47BllR3X8PSFtjtbd`).
- Subscriptions: `HMAC(razorpay_payment_id + "|" + subscription_id)`. The payment id comes first.
- Payment Link callback (query parameters): `HMAC(plink_id|reference_id|status|razorpay_payment_id)`. Matches Razorpay's own example (`plink_IH3cNucfVEgV68`).

## Errors

Every failure is a `RazorpayError` with `kind`, `retryable`, `outcomeUnknown`, `status`, `op`, and Razorpay's `providerCode`, `description`, `field`, `source`, `step`, `reason` and `metadata`. Razorpay error bodies look like `{ error: { code, description, field, source, step, reason, metadata } }`; the value `"NA"` becomes `null`.

| Situation | `kind` | `retryable` |
|---|---|---|
| Bad input caught locally | `validation` | no |
| Invalid config | `config` | no |
| 400 / 422 | `bad_request` | no |
| 400 whose description says "does not exist", or 404 | `not_found` | no |
| 401 | `auth` | no |
| 403 | `forbidden` | no |
| 409 (idempotent refund still in progress) | `conflict` | yes on refunds |
| 429 | `rate_limited` | yes (`retryAfterMs` set if a Retry-After header was sent) |
| 5xx | `server` | yes on safe calls; otherwise `outcomeUnknown: true` |
| Network failure | `network` | yes on safe calls; otherwise `outcomeUnknown: true` |
| Timeout (AbortSignal) | `timeout` | yes on safe calls; otherwise `outcomeUnknown: true` |
| Caller aborted | `aborted` | no |
| 2xx that is not JSON | `invalid_response` | no |
| Webhook failed verification or came from another account | `signature` | no |
| Unparseable webhook body | `invalid_payload` | no |

`outcomeUnknown: true` means the create may have happened. Look the object up by `receipt` or `reference_id` before trying again. Razorpay requires `reference_id` to be unique per payment link.

## Retries, timeouts, idempotency

- Each attempt has its own `AbortSignal.timeout(timeoutMs)`, combined with the caller's `signal` through `AbortSignal.any`.
- Backoff is exponential with full jitter, `random(0, min(max, base·2^(n-1)))`. A `Retry-After` header, when present, sets the minimum wait, capped at `retryMaxDelayMs`. Razorpay asks for exponential backoff with randomisation on 429.
- Safe calls (GETs and refunds) are retried on network errors, timeouts, 409, 429 and 5xx.
- Other POSTs are retried only on 429. Razorpay documents no idempotency key for orders, payment links, plans or subscriptions.
- Refunds always send `X-Refund-Idempotency`. Without a caller key the client generates a UUID and returns it as `idempotencyKey`; persist it with the refund request to retry later. Razorpay rejects the same key with a different body as `BAD_REQUEST`.

## Rate limits

Razorpay documents a request rate limiter that answers HTTP 429, and asks clients to retry with exponential or stepped backoff and randomisation. It publishes no per-endpoint numbers for these payment APIs (see Unconfirmed). Separately, test mode allows at most 30 Payment Links per business.

## Sandbox / test mode

- There is no separate sandbox host. Test-mode API keys (`rzp_test_…`) on the same `api.razorpay.com` give a simulation: no money moves, and checkout shows a mock bank page with Success and Failure buttons. The client exposes `mode` and `isTestMode`, and refuses a config whose `mode` contradicts the key prefix.
- Test cards include Visa `4100 2800 0000 1007` and Mastercard `5555 5100 0008 1006`, with any CVV and a future expiry. An OTP of 4 to 10 digits succeeds and a shorter one fails. Error-scenario cards are listed in Razorpay's test card page.
- Test webhooks fire for test-mode transactions, and their payloads have the same shape as live ones.
- In this repository, tests use a fake `fetch` and make no network calls. For a manual end-to-end run, use a test key pair and a public tunnel such as zrok; ngrok is blocked.

## India-specific notes

- Amounts are in paise and the INR minimum is ₹1 (100 paise). Do not send floats; the client rejects them.
- The payment entity's `fee` is Razorpay's fee including GST, and `tax` is the GST part. Both are in paise. Book them in billing when settlements are reconciled.
- Payment links are valid for 6 months by default, and `expire_by` cannot be more than 6 months after creation. Razorpay can send SMS and email for a link (`notify`) and reminders (`reminder_enable`). Turn these off if the CRM sends its own WhatsApp or email messages.
- `customer.contact` and `email` are personal data under the DPDP Act. They arrive in webhook payloads, so keep them out of logs. The client never logs payloads.
- Refunds can be `normal` (bank timelines) or `optimum` (instant where possible, otherwise normal). Instant refunds can carry a fee.
- Plans support `daily`, `weekly`, `monthly`, `quarterly` and `yearly` periods, and daily plans need an interval of at least 7. Subscriptions move through these states: created → authenticated → active, then pending, halted, paused, cancelled, completed or expired.
- Each Phoenix company can have its own Razorpay account. Create one client per company connection, and set `accountId` so a webhook cannot be credited to the wrong company.

## Sources (fetched 2026-11-05 unless noted)

- API overview: methods, status codes, conventions, rate limiting and notes limits. https://razorpay.com/docs/api/understand.md
- Authentication: Basic auth and key generation. https://razorpay.com/docs/api/authentication.md
- Error format. https://razorpay.com/docs/errors.md
- Orders: https://razorpay.com/docs/api/orders/create.md and https://razorpay.com/docs/api/orders/fetch-with-id.md
- Payment Links:
  - https://razorpay.com/docs/api/payments/payment-links/create-standard.md
  - https://razorpay.com/docs/api/payments/payment-links/fetch-id-standard.md
  - https://razorpay.com/docs/api/payments/payment-links/cancel-standard.md
  - Callback and signature: https://razorpay.com/docs/payments/payment-links/apis.md
- Refunds:
  - https://razorpay.com/docs/api/refunds/create-normal.md
  - https://razorpay.com/docs/api/refunds/create-instant.md
  - https://razorpay.com/docs/api/refunds/normal-refunds-idempotent.md
  - https://razorpay.com/docs/api/refunds/fetch-with-id.md
- Subscriptions:
  - https://razorpay.com/docs/api/payments/subscriptions/create-plan.md
  - https://razorpay.com/docs/api/payments/subscriptions/fetch-a-plan.md
  - https://razorpay.com/docs/api/payments/subscriptions/create-subscription.md
  - https://razorpay.com/docs/api/payments/subscriptions/fetch-subscription-id.md
  - https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription.md
  - https://razorpay.com/docs/api/payments/subscriptions/entity.md
  - Signature: https://razorpay.com/docs/payments/subscriptions/integration-guide.md
- Checkout signature: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration.md
- Webhooks:
  - https://razorpay.com/docs/webhooks.md
  - https://razorpay.com/docs/webhooks/validate-test.md
  - https://razorpay.com/docs/webhooks/best-practices.md
  - https://razorpay.com/docs/webhooks/setup-edit-payments.md
  - Sample payloads, used as test fixtures: https://razorpay.com/docs/webhooks/payments.md, https://razorpay.com/docs/webhooks/orders.md, https://razorpay.com/docs/webhooks/payment-links.md, https://razorpay.com/docs/webhooks/refunds.md and https://razorpay.com/docs/webhooks/subscriptions.md
- Test cards: https://razorpay.com/docs/payments/payments/test-card-details.md
- llms.txt index, "Last Updated: 30 April 2026": https://razorpay.com/docs/llms.txt

## Unconfirmed

- **Rate limit numbers.** No published requests-per-second figures for these payment APIs, and it is not documented whether a 429 carries `Retry-After`. The client honours the header if present.
- **Key id format.** Only `rzp_live_XXXXXXXXXXXXXX` appears in the docs; `rzp_test_` is inferred by symmetry. Keys with other prefixes, such as partner keys, need an explicit `mode`.
- **Not-found answers.** The docs list 404 for missing resources, and the "does not exist" check on 400s is a heuristic.
- **Payment Link callback without a reference id.** The client assumes an empty segment (`plink||status|pay`); there is no official example for this case.
- **Payment link create path.** The docs show a trailing slash (`/v1/payment_links/`) and the client uses it as written. The SDKs reportedly use `/v1/payment_links`, which was not checked.
- **`X-Razorpay-Event-Id` format.** The header is documented as unique per event, but its format is not.
- **Webhook IP list.** Not copied here; see razorpay.com/docs/security/whitelists.
- **Live-or-test flag in webhooks.** The webhook body has no field saying whether an event is live or test. Use separate webhook URLs or secrets per mode.
- **`quarterly` plan period.** It appears in the current create-plan page; it was not cross-checked against any other source.
- **Undocumented limits that are ours.** Plan and add-on name length (255), add-on count (10) and the idempotency key maximum length (255) are our own guards, not Razorpay limits.
- **Optimum refund fees and instant-refund method coverage.** Not checked in detail.
- **Malformed official samples.** The official `refund.speed_changed` sample has `created_at` inside `payload`, and the official `payment_link.paid` sample has an order id without the `order_` prefix. The parser does not depend on either.
