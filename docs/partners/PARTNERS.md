# Partners (phase 10): brokers and referral partners

Brokers, agencies and individual counsellors refer families (B2C) and institutes (B2B) to the
companies of the group. This module keeps the partners, their referral links, which leads they
brought, the commissions those leads earn when they pay, refunds that claw commissions back, the
payout batches finance pays them in, and a small portal where partners see their own work.

Code: `apps/api/src/modules/partners/`, migration `20261107000500_partners.js`, seed
`34_partners.js`, web `apps/web/src/app/(app)/partners/**`, `app/(app)/partner-portal/**`,
`app/(app)/settings/partner-programmes/`, `components/partners/**`, `lib/partners/**`.

## 1. Data model

| Table | Holds |
| --- | --- |
| `partners` | Once per group, like a contact: kind (`person`, `organisation`), name, `code` (the partner's own code across the group, unique per group, e.g. `edupath-advisors`; forms and CSV imports carry it as `source.partnerId`), legal name, email and phone (personal data, masked without `contacts.view_pii`), city, optional `contact_id` / `account_id`, `user_id` (portal sign-in), payout details (`payout_details_enc`: AES-256-GCM of the JSON, `payout_hint`: masked summary). |
| `partner_companies` | A company works with a partner: owning unit, `owner_user_id` (the counsellor who owns their leads), status `pending`, `active`, `suspended`, `terminated`, optional `commission_plan_id` override. Unique per partner and company. |
| `partner_referral_links` | Code (citext, unique everywhere so a code alone finds the partner), company, partner, optional product line, landing URL, UTM tags, active, `created_by_partner`. |
| `partner_attributions` | Deal → partner, `touch` `first` or `last` (unique per deal and touch), source `referral_link`, `partner_code` or `manual`, the code as it arrived, the referral link, the intake event. |
| `commission_plans` | Per company and optionally product line: `percent` (`rate_bps`) or `fixed` (`fixed_minor` + currency), trigger `first_payment` or `full_payment`, `clawback_days`, optional cap, active, position. Never deleted (turn off). |
| `partner_commissions` | One per qualifying payment (unique company + `payment_id`): plan snapshot, base, amount, `clawed_back_minor`, status `pending`, `approved`, `rejected`, `paid`, `clawed_back`, `clawback_until`, payout. |
| `partner_commission_clawbacks` | One per commission and refund (unique): amount, recovery `netted` (the unpaid commission just gets smaller) or `deduct` (it was paid or is in an approved batch: deducted from the next payout), recovered when that payout is paid. |
| `partner_payouts`, `partner_payout_lines` | Batches per company and currency (`SP-PO-7`), period, status `draft` → `approved` → `paid` (or `cancelled`), totals; one line per partner with the masked payout details at the time and the transfer reference. |

Money is minor units plus an ISO currency. Payout batch numbers use `crm_sequences` (name `partner_payout`) and the company's `deals.referencePrefix`.

## 2. Scoping

- A user sees a partner when they hold `partners.view` at one of the partner's company links' units (`:own`: links whose `owner_user_id` is them). Only the visible links are shown; another company's partnership is invisible. Anything outside scope is 404.
- Referral links, attributions and commissions belong to a company and are visible through the partner's link with that company (`scopeThroughLink`).
- What a partner record shows about a lead follows the deal: the title and family only when the viewer can see the deal (`deals.view`), phones masked without `contacts.view_pii` at the deal's unit.
- Payout batches belong to the company: visible with `partners.manage_payouts` or `partners.approve_payouts` at the company or above.
- The portal (`/partner-portal/*`) needs `partners.portal` and returns only rows of the partner whose `user_id` is the signed-in person, and only of the companies whose partnership unit the person holds `partners.portal` at (each company invites the partner to its own side). Nothing takes a partner id from the client; a company id only narrows the list.

## 3. Rules

**Attribution.** On `deal.created` (and `deal.updated` when the touch sources change) the handler reads `deals.first_touch` / `last_touch`: `partnerId` (a referral link code, a partner code or a partner id) and then `?ref=` (or `referral=`, `partner=`) on `landingUrl`. A code resolves only when the link is active and the partnership with the deal's company is active. The first touch is set once; the last touch is the latest touch that named a partner (the first touch when there's no other) and is replaced when a later touch names another partner. Attributions set by hand are never replaced. Idempotent (unique deal + touch, advisory lock per deal).

**Which partner earns.** Setting `partners.attributionModel` (`first_touch` default, or `last_touch`); falls back to the other touch.

**Plan.** The plan set on the partnership (if active), else the active plan for the payment's (or the deal's) product line, else the active company-wide plan; ties by position, then age. A percent plan with a currency only applies to payments in it.

**Accrual (`payment.succeeded`).** Payload `{ paymentId, companyId, dealId, amountMinor, currency, paidAt?, isFirstPayment?, fullyPaid?, totalMinor?, paidTotalMinor?, productLineId? }` (also accepted nested under `payload.payment`). `first_payment` plans earn on the first payment (`isFirstPayment !== false` and nothing earned yet); `full_payment` plans when `fullyPaid` is true. A deal earns one commission (a rejected one doesn't count). Percent of: `paidTotalMinor` (full payment) or `totalMinor` (the fee), else the deal value in the same currency, else the payment; rounded half up; capped. Only active partnerships earn. Idempotent per company + payment id.

**Clawback (`refund.processed`, also `refund.succeeded`).** Payload `{ refundId, paymentId? | dealId?, companyId?, amountMinor?, currency?, full?, processedAt? }`. Inside the window (`earned_at + clawback_days`) only. A full refund takes back what is left; a partial refund the same share of the commission as the refund is of the commission's base. Not paid yet → netted (a draft batch holding it is recounted; fully clawed back commissions leave it). Paid or in an approved batch → deducted from the partner's next payout. Cancelling an approved batch turns its pending deductions back into netted ones. Idempotent per commission + refund id.

**Approval.** Finance (`partners.approve_commissions`) approves or rejects pending commissions (rejecting approved ones only before they are in a batch). Bulk approve: up to 100, one transaction each.

**Payouts.** `partners.manage_payouts` prepares a batch for a company, period and currency: approved commissions without a batch earned up to the end of the period (older waiting ones included), of active partnerships, minus outstanding deductions; partners without payout details, or whose deductions exceed their commissions, wait. With `partners.holdDuringClawback` (default on) commissions still inside their window wait. Someone other than the preparer with `partners.approve_payouts` approves (maker-checker); finance marks it paid with the bank reference (and optional per-partner UTRs), which pays the commissions and recovers the deductions. Draft and approved batches can be cancelled; their commissions wait for the next batch.

**Payout details.** Validated (IFSC, 6–18 digit account, UPI id, PAN, GSTIN), stored encrypted; lists, batches and the portal show only the hint (bank, last four digits, IFSC, masked UPI). Reading the full details needs `partners.payout_details` at one of the partner's companies and is audited (`partner.payout_details_viewed`); the audit log never holds the numbers. The details are shared by every company that pays the partner, so changing them needs `partners.payout_details` at every one of the partner's companies (group finance once a partner is shared): one company can't redirect what another company pays. `can.changePayoutDetails` on the partner says whether the viewer may.

## 4. Endpoints (all under `/api/v1`)

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /partners?unitId&q&status&ownerUserId&cursor&limit` | partners.view | by name (keyset) |
| `POST /partners` | partners.manage at the unit | links the existing partner with the same email or phone (409 when already a partner of that company) |
| `GET /partners/owners?unitId` | partners.manage | people with `deals.manage` at the unit |
| `GET /partners/:id`, `PATCH /partners/:id` | view / manage | |
| `POST /partners/:id/companies`, `PATCH /partners/:id/companies/:companyId` | manage | partnership status, unit, counsellor, plan |
| `GET`, `PUT /partners/:id/payout-details` | partners.payout_details (PUT: at every company of the partner) | GET is audited, `Cache-Control: no-store` |
| `POST`, `DELETE /partners/:id/portal-access` | manage | `{ data: { partner, inviteUrl } }` (inviteUrl only outside production); both act on the requester's partnerships only (see below) |
| `GET /partner-links`, `POST /partner-links`, `PATCH /partner-links/:id` | view / manage | codes are generated (`SP-7KQ2MX`) unless given; never change; `partners.maxLinksPerPartner` active links per partner and company |
| `GET /partner-attributions?…&onePerLead=true`, `POST /partner-attributions`, `DELETE /partner-attributions/:id` | view / manage (+ deals.view on the deal) | |
| `GET /commission-plans?unitId|companyId`, `POST`, `PATCH /commission-plans/:id` | view / partners.manage_plans at the company | |
| `GET /partner-commissions`, `GET /partner-commissions/summary`, `GET /partner-commissions/:id` | view | |
| `POST /partner-commissions/:id/approve`, `/:id/reject`, `POST /partner-commissions/approve` | partners.approve_commissions | |
| `GET /partner-payouts`, `GET /partner-payouts/:id` | manage_payouts or approve_payouts | |
| `POST /partner-payouts/preview`, `POST /partner-payouts`, `/:id/mark-paid`, `/:id/cancel` | partners.manage_payouts | |
| `POST /partner-payouts/:id/approve` | partners.approve_payouts, not the preparer | |
| `GET /partner-portal/me`, `/links`, `/leads`, `/commissions`, `/payouts`; `POST /partner-portal/links`; `PATCH /partner-portal/links/:id` | partners.portal | own data only; leads masked ("Priya S.", masked phone, outcome only); portal links always use the company's landing page |

## 5. Permissions and roles

`partners.view` (own), `partners.manage` (own), `partners.manage_plans`, `partners.approve_commissions`, `partners.manage_payouts`, `partners.approve_payouts`, `partners.payout_details`, `partners.portal`.

| Role | Grants |
| --- | --- |
| group_admin, company_admin | everything except portal |
| manager, marketing | view, manage |
| counsellor, account_executive | view:own |
| finance | view, approve_commissions, manage_payouts, approve_payouts, payout_details |
| analyst | view (personal data masked) |
| partner (new built-in role) | portal |

The partner role is assigned at the unit of each partnership the requester manages when portal access is given, and moves with the partnership when its unit changes. A partner has one sign-in: a second company adds its partnership by inviting the same email (another email is 409, so one company can't replace the sign-in another company gave). Removing portal access takes only the requester's partnerships out; the sign-in is detached (and its sessions end) when no partnership is left, or at once when the requester manages every partnership. `hasPortalAccess` on a partner says whether the sign-in covers a partnership the viewer can see. One person is either staff or a partner: staff accounts can't be given portal access.

## 6. Settings (category "Partner programmes")

`partners.attributionModel` (group, company), `partners.holdDuringClawback` (group, company), `partners.maxLinksPerPartner` (group, company), `partners.defaultLandingUrl` (company).

## 7. Events and audit

Emitted: `partner.created`, `partner.company_linked`, `partner.updated`, `partner.link_updated`, `partner.payout_details_changed`, `partner.portal_access_granted`, `partner.portal_access_revoked`, `partner.link_created`, `partner.referral_link_updated`, `partner.lead_attributed`, `partner.attribution_removed`, `commission_plan.created`, `commission_plan.updated`, `partner.commission_accrued`, `partner.commission_clawed_back`, `partner.commission_approved`, `partner.commission_rejected`, `partner.payout_created`, `partner.payout_approved`, `partner.payout_paid`, `partner.payout_cancelled`. Audit actions use the same names (plus `partner.attribution_set`, `partner.payout_details_viewed`).

Consumed: `deal.created`, `deal.updated`, `payment.succeeded`, `refund.processed`, `refund.succeeded`.

No timeline entries: commissions are internal to finance and the partner, and counsellors who work the deal shouldn't see what the partner earns.

## 8. Intake

`resolveReferralCode(code, { companyId?, groupId?, trx? })` in `modules/partners/referrals.js` returns `{ partnerId, partnerName, partnerOwnerId, referralLinkId, code, companyId, unitId, groupId, productLineId, landingUrl, utm, source }` or null. Intake passes `partnerId` and `partnerOwnerId` to `assignOwner` (partner stickiness), stores the code or partner id in the deal's `first_touch.partnerId` (and `?ref=` in `landingUrl`), and may default the product line from `productLineId`. `partnerIdsByOwner(companyId)` gives the owner pool's `partnerIds`.
