# Billing core: GST maths and billing rules

`apps/api/src/core/billing/` is the engine behind invoices, credit notes, instalment plans, subscription changes and discount approvals. It is pure: callers pass data and get results back. It has no tables, no I/O and no clock reads unless you leave out a date. Tests are in `apps/api/test/billing/` (113 tests, including seeded property tests).

```js
import { computeTax, computeCreditNote, nextDocumentNumber, splitInstalments } from '../core/billing/index.js';
```

## 1. Conventions

- **Money** is an integer number of minor units (paise for INR) plus an ISO currency code. Products and ratios go through BigInt and are rounded once, **half away from zero** (0.5 paisa becomes 1). No floating-point value ever holds money.
- **Rates** are basis points: 1800 = 18%, 25 = 0.25%.
- **Dates.** Invoice dates, due dates and subscription terms are calendar dates (`"2026-04-01"`). Instants (UTC ISO strings, epoch ms, `Date`) are converted to calendar dates in an IANA zone, `Asia/Kolkata` by default. `zonedDateTimeToInstant(date, zone, time)` converts back, for reminders and overdue checks.
- **Errors.** Bad input throws the platform's 422 `AppError` (`validation_failed`) with field paths, as `parseOrThrow` does, so a route can let it propagate. Programming errors such as overflow throw `RangeError`.
- **Inputs** are validated with zod. The schemas are exported (`computeTaxInputSchema`, `numberSeriesSchema`, `discountPolicySchema`, ...) so routes and settings can reuse them.

## 2. API

### gstin.js

| Function | Returns |
| --- | --- |
| `validateGstin(value, { allowSpecial? })` | `{ valid, gstin, error, message, kind, stateCode, stateName, pan, panHolderType, entityNumber, checkCharacter }`. `error` is one of `length`, `characters`, `state_code`, `format`, `checksum`. |
| `isValidGstin(value, opts)`, `gstinRefinement` | Boolean; the refinement plugs into `z.string().refine(...)`. |
| `gstinCheckCharacter(first14)` | The base-36 check character. |
| `panFromGstin`, `stateCodeFromGstin`, `isValidPan`, `normaliseGstin` | Helpers. |
| `STATE_CODES`, `stateByCode`, `normaliseStateCode`, `isValidStateCode(code, { allowRetired?, allowCentre? })`, `OUTSIDE_INDIA_CODE` (`"96"`) | The state/UT table. Each entry has `{ code, name, kind, localTax: 'SGST' or 'UTGST', active }`. |

A regular GSTIN has a 2-digit state code, a 10-character PAN, an entity number (1-9 then A-Z), `Z` and a check character. Special registrations (UIN, TDS/TCS, NRTP, OIDAR, Centre code 99) have other middle layouts. Pass `allowSpecial: true` to accept them; they are still checked for a valid state prefix and checksum.

**Checksum.** Take the base-36 value of each of the first 14 characters (0-9, then A-Z). Multiply them by 1 and 2 alternately, and add up each product's base-36 digits (`floor(p/36) + p%36`). The check character is `(36 - sum % 36) % 36`. This is the Luhn mod 36 scheme, so every single-character typo is caught; a test checks all 15 × 35 typos for each sample.

### gst.js: `computeTax(input)`

```js
computeTax({
  lines: [{ id?, description?, sac?, quantity = 1, unitPriceMinor | amountMinor, discountMinor = 0,
            taxRateBp = 0, taxability = 'taxable' | 'nil_rated' | 'exempt' | 'non_gst', priceIncludesTax = false }],
  supplierStateCode: '27',
  placeOfSupplyStateCode: '29',        // omit or '96' for an export
  exportOfService: { lut: true },      // optional: zero-rated export
  supplyToSez: { lut: false },         // optional: zero-rated supply to an SEZ unit or developer
  supplierGstin?: '27AAPF...',          // optional: checked against supplierStateCode
  roundOff: false,                     // round the grand total to the rupee
  currency: 'INR',
})
```

The result has these fields:

- `supplyType`: one of `intra_state`, `inter_state`, `export_with_igst`, `export_under_lut`, `sez_with_igst`, `sez_under_lut`.
- `taxKind`: `cgst_sgst`, `igst` or `none`.
- `stateTaxLabel`: `SGST` or `UTGST`. The `sgst*` fields carry UTGST in a UT without a legislature, as the e-invoice schema does.
- `zeroRated`, `lut`, `placeOfSupplyStateCode`, `placeOfSupplyName`.
- `endorsement`: the text an export or SEZ invoice must print.
- `documentType`: `tax_invoice` or `bill_of_supply`.
- `mixedTaxableAndExempt`.
- `lines[]`: each has `grossMinor`, `discountMinor`, `taxableValueMinor`, the rates and amounts of `cgst`, `sgst` and `igst`, `taxMinor`, `totalMinor`, `appliedRateBp` and the normalised `taxability`.
- `rateSummary[]`: totals by rate.
- `sacSummary[]`: totals by SAC, taxability and rate (the HSN/SAC summary in GSTR-1).
- `totals`: `grossMinor`, `discountMinor`, `assessableValueMinor`, `taxableValueMinor`, `zeroRatedValueMinor`, `nilRatedValueMinor`, `exemptValueMinor`, `nonGstValueMinor`, `cgstMinor`, `sgstMinor`, `igstMinor`, `taxMinor`, `totalBeforeRoundOffMinor`, `roundOffMinor` and `grandTotalMinor`.
- `warnings[]`: `unusual_rate` or `missing_sac`.

`computeTax` is built from smaller pieces that are also exported:

- `determineSupply(...)`: decides how the supply is taxed.
- `defaultPlaceOfSupply({ supplierStateCode, recipientGstin?, recipientStateCode?, recipientOutsideIndia? })`: applies the default place-of-supply rule for services.
- `taxOnTaxableValue(taxable, rateBp, taxKind)`.
- `splitInclusiveAmount(inclusive, rateBp, taxKind)`.
- `sumTaxLines(lines, { zeroRated, roundOff })`.

The constants `SUPPLY_TYPES`, `ENDORSEMENTS`, `STANDARD_RATES_BP` and `TAXABILITY` are exported too.

### invoiceNumber.js

A series looks like `{ documentType: 'invoice' | 'credit_note' | 'debit_note' | 'bill_of_supply', prefix, format?, fyStyle: 'compact', padding: 5, gstin? }`.

- **Formats.** The default formats are `{prefix}/{fy}/{seq}` for invoices, and `{prefix}/CN{fy}/{seq}`, `{prefix}/DN{fy}/{seq}` and `{prefix}/BS{fy}/{seq}` for the others.
- **Year styles.** `fyStyle` writes the year as `long` (2026-27), `short` (26-27), `compact` (2627) or `startYear` (2026).
- `financialYear(dateOrInstant, zone)` returns `{ startYear, endYear, label, start, end }`. `financialYearStartingIn(year)` and `fyLabel(year, style)` are also exported.
- `describeSeries(series)` returns `{ ok, issues, warnings, maxLength, maxSequence, example, series }`. Call it before saving a series. The issues are `too_long`, `bad_first_character` and `invalid`; the warning is `no_financial_year`.
- `formatDocumentNumber(series, { sequence, fyStartYear | date, timeZone })` returns the number, for example `PVI/2627/00042`.
- `nextDocumentNumber(series, { lastSequence, fyStartYear | date })` returns `{ fyStartYear, fyLabel, sequence, number }`.
- `parseDocumentNumber(series, number)` returns `{ fy, fyStartYear, sequence }`, or null when the number doesn't belong to the series.
- `checkDocumentNumber(text)` and `isValidDocumentNumber(text)` apply the rule to any string.
- `findSeriesConflicts(seriesList)` returns pairs of series under the same GSTIN that could produce the same number.
- `counterKey(...)` and `maxSequence(series)` are helpers.

### instalments.js

- `splitInstalments({ totalMinor, count, schedule, firstAmountMinor?, roundingUnitMinor = 1, remainderOn = 'last' })` returns `{ totalMinor, instalments: [{ number, dueDate, amountMinor }] }`.
  - `schedule` is either `{ frequency: 'monthly', startDate, dayOfMonth?, intervalMonths = 1 }` or `{ frequency: 'custom', dates: [...] }`.
  - The instalments are equal, optionally in multiples of `roundingUnitMinor` (100 means whole rupees). The leftover goes on the first or last equal instalment.
  - A fixed `firstAmountMinor` (a registration fee or down payment) comes first, and the rest is split equally.
  - Monthly dates keep the anchor day and clamp in short months: Jan 31 → Feb 28 → Mar 31.
  - A plan that would contain a zero instalment is refused.
- `rescheduleInstalments({ instalments: [{ dueDate, amountMinor, paidMinor }], count, schedule, ...same options })` returns `{ totalMinor, paidMinor, outstandingMinor, settled, rescheduled, instalments }`.
  - An instalment with any payment is closed at the amount paid; its unpaid balance moves into the new plan.
  - Unpaid instalments are replaced. The total never changes.

### proration.js

- `prorateChange({ termStart, termEnd? | interval: 'month' | 'year', changeAt, timeZone?, from, to, downgrade = 'at_renewal' })`.
  - `from` and `to` are each `{ unitPriceMinor, quantity }` or `{ amountMinor }`, as the price of a whole term.
  - The result is `{ termStart, termEnd, changeDate, termDays, usedDays, remainingDays, fromAmountMinor, toAmountMinor, direction, effective, effectiveDate, creditMinor, chargeMinor, netMinor }`.
- `termEndFor(start, interval, count)` and `prorateAmount(amount, days, termDays)` are also exported.

Proration rule:

- The customer gets credit for the unused part of the old plan and is charged for the rest of the term at the new plan, both counted in days.
- Days are calendar days in the company's zone. The change date counts as a day on the new plan, and the term end is exclusive: it is the renewal date.
- Each amount is rounded once.
- By default, downgrades wait for renewal and produce no money now. Pass `downgrade: 'immediate'` to credit the difference immediately.
- Amounts are before GST.

### discounts.js

- `evaluateDiscount({ policy, listAmountMinor, discountMinor, requesterRoles })` returns `{ decision: 'allowed' | 'needs_approval' | 'not_allowed', percentBp, tierIndex, tierLabel, approverRoles, selfApproved, reason }`.
- `canApproveDiscount({ policy, decision, approverRoles, approverUserId, requesterUserId })` returns a boolean.
- `parseDiscountPolicy`, `discountPolicySchema` and `DEFAULT_DISCOUNT_POLICY` are also exported.

A policy is `{ tiers: [{ label?, maxPercentBp?, maxAmountMinor?, approverRoles: [] }], inheritApprovers = true, allowSelfApproval = true }`.

- A discount falls in the first tier whose limits it fits.
- A tier with no approver roles needs no approval.
- With `inheritApprovers`, approvers of later tiers can also approve earlier ones.
- A discount above the last tier is not allowed.
- Percentages are compared exactly (`discount × 10000 ≤ limit × list`), so a 5.0025% discount never passes a 5% limit, even though it displays as 500 bp.
- The default policy: up to 5% and ₹5,000 needs no approval, up to 15% needs `manager`, up to 30% needs `company_admin`, and anything larger is not allowed.

### amountInWords.js

- `amountInWords(minor, { currency = 'INR', hyphenate?, upperCase? })` returns words such as "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only".
- Above 99 crore, the crore count is itself read in Indian words ("One Lakh Crore").
- INR, USD, EUR, GBP, AED, SGD, AUD and CAD have names.
- `toIndianWords(n)` reads a whole number.
- `formatInr(minor, { symbol? })` formats with Indian grouping, for example "1,23,45,678.90". It matches `Intl.NumberFormat('en-IN')`.

### creditNote.js

`computeCreditNote({ invoice, mode: 'full' | 'partial', lines?, refundAmountMinor?, previousCredits = [], roundOff?, reason = 'refund', against? })`:

- `invoice` is the exact `computeTax` input the invoice was issued with, so the credit note uses the same supply type, place of supply and rates.
- `lines` takes `{ line, quantity }` for a quantity return, `{ line, taxableValueMinor }` for a value excluding tax, or `{ line, amountMinor }` for an amount including tax. `refundAmountMinor` instead spreads one tax-inclusive amount over the lines in proportion to what is left on each.
- `previousCredits` are earlier `computeCreditNote` results for the same invoice. Cumulative credits can never exceed the invoice, and the credit that closes a line takes exactly what is left on it, so there is no paisa drift.
- A quantity return worth more than the line has left (after earlier refunds by amount) is refused.
- The result has the same shape as `computeTax`, plus `documentType: 'credit_note'`, `mode`, `reason`, `against`, `remaining[]` per line and `fullyCredited`.
- `reason` is one of `refund`, `cancellation`, `post_supply_discount`, `deficiency`, `excess_value`, `excess_tax` or `other`.
- `creditNoteTaxDeadline(invoiceDate, { annualReturnFiledOn? })` returns the last day the note can still reduce output tax.

## 3. Rules and sources

The source files are the research downloads (`scratchpad/research/gst-dl/`).

**Confirmed** means the rule was read in those files. **Unconfirmed** means it comes from general knowledge of the Acts and was not in the downloads. Check those rows against the bare Acts on cbic-gst.gov.in before go-live.

| Rule | Where it is used | Source | Status |
| --- | --- | --- | --- |
| A document number has at most 16 characters, uses letters, digits, `-` and `/`, belongs to one or more series and is unique for a financial year. | invoiceNumber.js | CGST Rules 46(b) (`cbicti/rule46_v1.00.txt`), 49(b), 53(1)(d) and 53(1A)(c) (`cbicti/rule53_v1.00.txt`, `cgst-rules-2021.txt`) | Confirmed |
| A document number may not start with `0`, `/` or `-`; the schema pattern is `^([a-zA-Z1-9]{1}[a-zA-Z0-9/-]{0,15})$`. | `checkDocumentNumber`, `describeSeries` | NIC e-invoice API v1.03, generate IRN (`nic/version1.03_generate-irn.txt`) | Confirmed |
| The taxable value is net of discount; the invoice shows the HSN/SAC code, the rate and amount of each of CGST/SGST/UTGST/IGST, and the place of supply. | gst.js lines and totals | Rule 46(g), (k), (l), (m), (n) | Confirmed |
| Export and SEZ invoices carry the endorsement "... ON PAYMENT OF INTEGRATED TAX" or "... UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX". | `ENDORSEMENTS` | Rule 46, export proviso (text substituted by Notification 17/2017-CT) | Confirmed |
| An exporter who files an LUT (FORM GST RFD-11) supplies without paying IGST. | `exportOfService.lut` | Rule 96A (`cbicti/rule96a_v1.00.txt`) | Confirmed |
| Only exempt or nil-rated supplies get a bill of supply; a combined invoice-cum-bill of supply is allowed for an unregistered recipient. | `documentType`, `mixedTaxableAndExempt` | Rules 49 and 46A (`cgst-rules-2021.txt`) | Confirmed |
| A credit note shows the original invoice's number and date, plus the taxable value, rate and tax credited. | `against`, credit lines | Rule 53(1A)(g) and (h) | Confirmed |
| The place of supply outside India is code 96. | `OUTSIDE_INDIA_CODE` | e-invoice schema, `Pos` ("If POS lies outside the country, the code shall be 96") | Confirmed |
| The invoice round-off is a separate amount, between -99.99 and +99.99 on e-invoices. Tax values may differ from the computed value by up to ₹1 (the tolerance), so either per-line or per-invoice rounding passes. | `roundOff`, `roundOffMinor` (this engine stays within ±50 paise) | e-invoice schema `RndOffAmt`; NIC release notes on tolerance (`nic/release-notes.txt`) | Confirmed |
| Foreign-currency value: for services, the exchange rate follows generally accepted accounting principles on the date of time of supply. | Not converted here (see section 6) | Rule 34 (`cbicti/rule34_v1.00.txt`) | Confirmed |
| From 1 Nov 2026, a post-supply discount reduces value only through a s.34 credit note, with ITC reversed by the recipient. | `reason: 'post_supply_discount'` | Finance Act 2026 ss.153-154 (`fa2026-extract.txt`), in force from 1.11.2026 by Notification 03/2026-CT (`ct-03-2026.txt`) | Confirmed |
| A credit note does not reduce the supplier's tax if the recipient has not reversed the ITC (registered recipient) or the tax was passed on (others). | Documented; features record it | s.34(2) proviso as substituted by Finance Act 2025 s.126 (`fa2025-extract.txt`) | Confirmed |
| Services rates were rationalised from 22 Sep 2025. Rates are passed in by the caller; `STANDARD_RATES_BP` only drives warnings. | `STANDARD_RATES_BP` | Notification 15/2025-CT(Rate) (`15-2025-CTR.txt`) | Confirmed (effective date) |
| GSTIN layout and the Luhn mod-36 check character. | gstin.js | Verified against 6 NIC sandbox GSTINs (`nic/sandbox-home.html`) and the GSTN API sample 27AAPFU0939F1ZV. The downloads contain no official algorithm text. | Verified empirically |
| State/UT code table; 25 and 28 are retired, 97 is Other Territory, 99 is Centre Jurisdiction. | `STATE_CODES` | GST portal state-code list (not in the downloads) | Unconfirmed |
| UTGST instead of SGST in Chandigarh, Ladakh, Lakshadweep, A&N, DNH&DD and Other Territory; Delhi, Puducherry and J&K charge SGST. | `localTax`, `stateTaxLabel` | CGST Act s.2(114) and the UTGST Act | Unconfirmed |
| Same state → CGST + SGST, different state → IGST; supplies to an SEZ are inter-state; exports and SEZ supplies are zero-rated. | `determineSupply` | IGST Act ss.7, 8 and 16 | Unconfirmed |
| Default place of supply for services: a registered recipient's location, else the recipient's address on record, else the supplier's location. Training to an unregistered person is where it is performed. | `defaultPlaceOfSupply` (the default rule only) | IGST Act s.12(2); training s.12(5) | Unconfirmed |
| Credit-note deadline: 30 November after the end of the financial year, or the annual return date if earlier. | `creditNoteTaxDeadline` | CGST Act s.34(2) as amended by Finance Act 2022 | Unconfirmed |
| HSN/SAC digits: 4 up to ₹5 crore turnover (B2B), 6 above. | Only a generic `missing_sac` warning | Notification 78/2020-CT (the PDF was downloaded but could not be read here) | Unconfirmed |
| Coaching (SAC 999293) is taxable at 18%; the exemption covers only "educational institutions". | Caller's choice of rate and taxability | Notification 12/2017-CT(Rate) | Unconfirmed |

## 4. Rounding

- **Tax per line.** Tax is computed for each line and each component separately, rounded to the paisa half up, then summed. CGST and SGST are each `round(taxable × rate / 2)`, so they are always equal. On a 50-paise line at 18% intra-state, CGST is 5 and SGST is 5 (10 paise in total), while IGST would be 9. The e-invoice tolerance of ±₹1 accepts this.
- **Tax-inclusive prices.** The engine estimates `taxable = round(price × 10000 / (10000 + rate))`, computes the tax on that estimate, then sets the taxable value to the price minus that tax. The line still totals exactly the price the customer saw. For example, ₹1.05 at 5% intra-state becomes 99 + 3 + 3.
- **Quantities** can have three decimals (as on e-invoices); `quantity × unit price` is rounded once.
- **Round-off** is optional. When it is on, the grand total is rounded to the nearest rupee (50 paise rounds up), and `roundOffMinor` (from -49 to +50) is shown as its own line. A full credit note inherits the invoice's round-off, so it matches the invoice's grand total.
- **Proration and instalment splits** round once per figure. Instalments always add up to the total, with the leftover placed deterministically.

## 5. Allocating numbers (database contract)

The engine formats numbers; the database hands out sequences. Rule 46(b) requires consecutive numbers that are unique per financial year, so numbers are allocated **inside the transaction that issues the document**:

```sql
create table billing_number_series (
  id uuid primary key,
  company_unit_id uuid not null references org_units(id),
  gstin text not null,                  -- normalised, validated with validateGstin
  document_type text not null,          -- invoice | credit_note | debit_note | bill_of_supply
  prefix text not null, format text not null, fy_style text not null, padding int not null,
  active boolean not null default true,
  unique (gstin, document_type, prefix)
);
create table billing_number_counters (
  series_id uuid not null references billing_number_series(id),
  fy_start_year int not null,
  last_sequence int not null,
  last_document_date date not null,
  primary key (series_id, fy_start_year)
);
-- every issued document: unique (supplier_gstin, document_type, fy_start_year, number)
```

```sql
-- inside the issuing transaction, after totals are computed, just before inserting the document:
insert into billing_number_counters (series_id, fy_start_year, last_sequence, last_document_date)
values (:seriesId, :fyStartYear, 1, :documentDate)
on conflict (series_id, fy_start_year) do update
  set last_sequence = billing_number_counters.last_sequence + 1,
      last_document_date = greatest(billing_number_counters.last_document_date, excluded.last_document_date)
returning last_sequence;
```

- **Row lock.** The upsert locks the counter row until commit, so concurrent issuers queue and each gets the next number. A rollback undoes the increment, so a failed issue leaves no gap.
- **No Postgres sequences.** `nextval` is not transactional and leaves gaps.
- **Short transactions.** Validate and compute before allocating, then allocate, insert, audit (`writeAudit`), emit (`emitEvent`) and commit.
- **Rendering.** The number is `formatDocumentNumber(series, { sequence: last_sequence, fyStartYear })`. The financial year comes from `financialYear(documentDate, companyZone)`.
- **A full series.** If the sequence exceeds `maxSequence(series)`, refuse the issue and ask an admin to add a series.
- **Drafts** have no number. A cancelled document keeps its number; GSTR-1 Table 13 reports cancelled documents. Numbers are never reused.
- **Backdating.** Refuse a document date earlier than `last_document_date` for the same counter, so numbers rise with dates. Allow it only with an explicit finance override.
- **Saving a series.** Require `describeSeries(series).ok`, and require `findSeriesConflicts` to return nothing across the GSTIN's active series. Credit notes, debit notes and bills of supply each have their own series, and therefore their own counter.

## 6. How features use it

**Issuing an invoice (phase 7)**

1. Get the place of supply from `defaultPlaceOfSupply` (the contact's GSTIN or address).
2. Build the lines from products, with each product's SAC, rate and taxability.
3. Call `computeTax`.
4. Store the input as a JSONB snapshot next to the result. Credit notes need that snapshot, and rates may change later.
5. Allocate the number as in section 5.
6. Print `amountInWords(totals.grandTotalMinor)`, `formatInr`, the endorsement and `stateTaxLabel`.

**B2C fees with instalments**

- `splitInstalments` builds the schedule when an enrolment is confirmed.
- Reminders fire at `zonedDateTimeToInstant(dueDate, companyZone, '23:59:59')`.
- When a family misses payments or asks for more time, `rescheduleInstalments` gives the new plan; record the old one in the audit log.

**B2B seat or plan changes**

- Run `prorateChange`.
- If `netMinor > 0`, invoice it as one line, for example "15 seats from 1 Oct 2026, replacing 10", with the software SAC and rate.
- If `netMinor < 0`, call `computeCreditNote` against the term's invoice with `lines: [{ line, taxableValueMinor: -netMinor }]` and `reason: 'post_supply_discount'` or `'excess_value'`.

**Refunds**

1. Load the invoice's stored `computeTax` input and its earlier credit notes.
2. Call `computeCreditNote`.
3. Check `creditNoteTaxDeadline(invoiceDate)`. After the deadline, issue a financial credit note with no GST reversal (not modelled here).

**Discounts**

- Register a setting `billing.discountPolicy` with `schema: discountPolicySchema`, `default: DEFAULT_DISCOUNT_POLICY` and `levels: ['group', 'company']`.
- When a quote or deal is saved, call `evaluateDiscount` with the role keys the user holds at the deal's unit.
- Store the decision. The approver screen uses `canApproveDiscount`.

**GSTIN fields**

- Validate GSTIN fields with `z.string().refine(gstinRefinement, 'Enter a valid GSTIN')`.
- The phase 1 org profile (`modules/org/unitTypes.js`) checks only the pattern, and its placeholder `27ABCDE1234F1Z5` fails the checksum. Switch the field to `isValidGstin` and change the placeholder to `27AAPFU0939F1ZV`.

## 7. Not covered (yet)

- **Reverse charge.** Phoenix's outward supplies aren't under reverse charge.
- **Compensation cess.**
- **TCS/TDS.**
- **Receipt and refund vouchers for advances** (Rules 50 and 51).
- **E-invoice IRN and QR generation**, which belongs in the phase 3 integration framework.
- **Foreign-currency conversion to INR** (Rule 34). An export with IGST billed in a foreign currency needs the tax reported in INR; the caller must convert.
- **Turnover-based HSN digit checks.**
- **Special place-of-supply rules** beyond the default.
