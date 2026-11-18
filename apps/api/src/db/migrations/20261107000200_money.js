// Phase 7, money: billing profiles (GSTIN per company), invoice number series and gap-free counters,
// plans and price lists, payment accounts, quotes and fee proposals with discount approval,
// agreement templates and agreements (e-sign), instalment plans, subscriptions, payments with
// provider-event idempotency, GST invoices, credit notes and refunds.
// See apps/api/src/modules/money/README.md (and docs/platform/BILLING_CORE.md §5 for numbering).
//
// Conventions: UUID keys, timestamptz in UTC, calendar dates as `date`, money as bigint minor units
// plus an ISO currency. Company-owned rows carry group_id and company_id; customer documents also
// carry deal_id and are scoped through the deal (its unit and owner), so a reassigned deal takes its
// billing with it. Issued invoices and credit notes are never deleted (cancelled keeps the number).

import {
  AGREEMENT_STATUSES,
  AUDIENCES,
  BILLING_INTERVALS,
  DISCOUNT_STATUSES,
  INSTALMENT_PLAN_STATUSES,
  INSTALMENT_STATUSES,
  INVOICE_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  PLAN_KINDS,
  PLAN_UNITS,
  QUOTE_KINDS,
  QUOTE_STATUSES,
  REFUND_STATUSES,
  SERIES_DOCUMENT_TYPES,
  SIGN_TYPES,
  SUBSCRIPTION_STATUSES,
  TAXABILITIES,
  ACCOUNT_SCOPES,
} from '../../modules/money/constants.js';

function id(knex, t) {
  t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
}

function timestamps(knex, t) {
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

const unitRef = (t, column, { nullable = false } = {}) => {
  const col = t.uuid(column).references('id').inTable('org_units').onDelete('RESTRICT');
  if (!nullable) col.notNullable();
  return col;
};
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const dealRef = (t, { nullable = false } = {}) => {
  const col = t.uuid('deal_id').references('id').inTable('deals').onDelete('RESTRICT');
  if (!nullable) col.notNullable();
  return col;
};
const money = (t, column) => t.bigInteger(column).notNullable().defaultTo(0);
const currency = (t, column = 'currency') => t.specificType(column, 'char(3)').notNullable();
const jsonb = (knex, t, column, fallback = "'{}'::jsonb") => t.jsonb(column).notNullable().defaultTo(knex.raw(fallback));
const inList = (values) => values.map((v) => `'${v}'`).join(', ');

async function check(knex, table, name, predicate) {
  await knex.raw(`alter table ${table} add constraint ${name} check (${predicate})`);
}

export async function up(knex) {
  // ---------- Company billing profile (GSTIN, place of business, LUT) ----------
  await knex.schema.createTable('billing_profiles', (t) => {
    unitRef(t, 'company_id').primary();
    unitRef(t, 'group_id');
    t.text('legal_name').notNullable();
    t.text('trade_name');
    t.text('gstin'); // normalised, checksum-validated; null = not registered (no tax invoices)
    t.text('state_code').notNullable(); // supplier state ("27"), from the GSTIN when set
    t.text('pan');
    jsonb(knex, t, 'address'); // registered place of business (printed on invoices)
    t.text('email'); // business contact printed on invoices (not personal data)
    t.text('phone');
    t.text('lut_number'); // letter of undertaking for zero-rated exports
    t.date('lut_valid_until');
    t.boolean('round_off').notNullable().defaultTo(false);
    t.text('invoice_notes');
    jsonb(knex, t, 'bank_details'); // { accountName, accountNumber, ifsc, bank } for offline payments
    userRef(t, 'updated_by');
    timestamps(knex, t);
  });

  // ---------- Invoice number series and counters (BILLING_CORE §5) ----------
  await knex.schema.createTable('billing_number_series', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('gstin').notNullable();
    t.text('document_type').notNullable();
    t.text('prefix').notNullable();
    t.text('format').notNullable();
    t.text('fy_style').notNullable().defaultTo('compact');
    t.integer('padding').notNullable().defaultTo(5);
    t.boolean('is_default').notNullable().defaultTo(true);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'billing_number_series', 'billing_number_series_type_chk', `document_type in (${inList(SERIES_DOCUMENT_TYPES)})`);
  await check(knex, 'billing_number_series', 'billing_number_series_padding_chk', 'padding between 1 and 10');
  await knex.raw('create unique index billing_number_series_uq on billing_number_series (gstin, document_type, prefix)');
  await knex.raw(
    'create unique index billing_number_series_default_uq on billing_number_series (company_id, document_type) where is_default and active',
  );

  await knex.schema.createTable('billing_number_counters', (t) => {
    t.uuid('series_id').notNullable().references('id').inTable('billing_number_series').onDelete('RESTRICT');
    t.integer('fy_start_year').notNullable();
    t.integer('last_sequence').notNullable();
    t.date('last_document_date').notNullable();
    t.primary(['series_id', 'fy_start_year']);
  });

  // ---------- Plans and price lists ----------
  await knex.schema.createTable('billing_plans', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('product_id').references('id').inTable('products').onDelete('RESTRICT');
    t.specificType('code', 'citext').notNullable();
    t.text('name').notNullable();
    t.text('description');
    t.text('kind').notNullable().defaultTo('one_time');
    t.text('audience').notNullable().defaultTo('b2c');
    t.text('unit').notNullable().defaultTo('flat');
    t.text('interval'); // month | year for recurring plans
    t.text('sac'); // services accounting code, e.g. 999293 (coaching), 997331 (software licences)
    t.integer('tax_rate_bp').notNullable().defaultTo(1800);
    t.text('taxability').notNullable().defaultTo('taxable');
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'billing_plans', 'billing_plans_kind_chk', `kind in (${inList(PLAN_KINDS)})`);
  await check(knex, 'billing_plans', 'billing_plans_audience_chk', `audience in (${inList(AUDIENCES)})`);
  await check(knex, 'billing_plans', 'billing_plans_unit_chk', `unit in (${inList(PLAN_UNITS)})`);
  await check(
    knex,
    'billing_plans',
    'billing_plans_interval_chk',
    `(kind = 'recurring' and interval in (${inList(BILLING_INTERVALS)})) or (kind = 'one_time' and interval is null)`,
  );
  await check(knex, 'billing_plans', 'billing_plans_taxability_chk', `taxability in (${inList(TAXABILITIES)})`);
  await check(knex, 'billing_plans', 'billing_plans_rate_chk', 'tax_rate_bp between 0 and 10000');
  await knex.raw('create unique index billing_plans_code_uq on billing_plans (company_id, code)');
  await knex.raw('create index billing_plans_company_idx on billing_plans (company_id, position, id)');

  await knex.schema.createTable('billing_price_lists', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('name').notNullable();
    currency(t);
    t.boolean('prices_include_tax').notNullable().defaultTo(true);
    t.boolean('is_default').notNullable().defaultTo(false);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'billing_price_lists', 'billing_price_lists_currency_chk', "currency ~ '^[A-Z]{3}$'");
  await knex.raw(
    'create unique index billing_price_lists_default_uq on billing_price_lists (company_id, currency) where is_default and active',
  );
  await knex.raw('create index billing_price_lists_company_idx on billing_price_lists (company_id, name)');

  await knex.schema.createTable('billing_prices', (t) => {
    id(knex, t);
    t.uuid('price_list_id').notNullable().references('id').inTable('billing_price_lists').onDelete('CASCADE');
    t.uuid('plan_id').notNullable().references('id').inTable('billing_plans').onDelete('RESTRICT');
    unitRef(t, 'company_id');
    t.bigInteger('unit_amount_minor').notNullable();
    timestamps(knex, t);
  });
  await check(knex, 'billing_prices', 'billing_prices_amount_chk', 'unit_amount_minor >= 0');
  await knex.raw('create unique index billing_prices_uq on billing_prices (price_list_id, plan_id)');
  await knex.raw('create index billing_prices_plan_idx on billing_prices (plan_id)');

  // ---------- Payment accounts (no secrets: credentials live in the integration connection) ----------
  await knex.schema.createTable('billing_payment_accounts', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.text('provider').notNullable(); // razorpay | stripe
    t.text('label').notNullable();
    t.text('scope').notNullable().defaultTo('domestic'); // domestic (INR) | international | both
    t.text('mode').notNullable().defaultTo('test'); // test | live
    t.text('account_ref'); // acc_… (Razorpay) / acct_… (Stripe), checked against webhook bodies
    t.uuid('connection_id'); // integration framework connection holding the keys (phase 3)
    t.specificType('entity_country', 'char(2)').notNullable().defaultTo('IN');
    t.boolean('india_exports').notNullable().defaultTo(false); // Stripe India: export payments enabled
    t.text('purpose_code'); // Stripe India: one transaction purpose code per account (P1107, P0802…)
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'billing_payment_accounts', 'billing_payment_accounts_provider_chk', "provider in ('razorpay', 'stripe')");
  await check(knex, 'billing_payment_accounts', 'billing_payment_accounts_scope_chk', `scope in (${inList(ACCOUNT_SCOPES)})`);
  await check(knex, 'billing_payment_accounts', 'billing_payment_accounts_mode_chk', "mode in ('test', 'live')");
  await knex.raw('create unique index billing_payment_accounts_uq on billing_payment_accounts (company_id, provider)');

  // ---------- Quotes (B2B) and fee proposals (B2C) ----------
  await knex.schema.createTable('quotes', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.bigInteger('number').notNullable(); // per company (crm_sequences 'quote')
    t.text('ref').notNullable(); // "SP-Q-0042"
    t.text('kind').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.text('title').notNullable();
    t.uuid('price_list_id').references('id').inTable('billing_price_lists').onDelete('RESTRICT');
    currency(t);
    t.boolean('prices_include_tax').notNullable().defaultTo(true);
    jsonb(knex, t, 'lines', "'[]'::jsonb"); // [{ id, planId, description, sac, quantity, unitPriceMinor, discountMinor, taxRateBp, taxability }]
    jsonb(knex, t, 'recipient'); // { name, gstin, stateCode, outsideIndia, address } (business details)
    t.text('place_of_supply_state_code');
    money(t, 'subtotal_minor'); // list amount before discounts (as entered: incl. or excl. tax)
    money(t, 'discount_minor');
    money(t, 'taxable_minor');
    money(t, 'tax_minor');
    money(t, 'total_minor');
    jsonb(knex, t, 'tax_summary'); // computeTax preview: supplyType, taxKind, per-line split, totals
    t.text('discount_status').notNullable().defaultTo('none');
    t.jsonb('discount_decision'); // evaluateDiscount result
    userRef(t, 'discount_requested_by');
    userRef(t, 'discount_reviewed_by');
    t.timestamp('discount_reviewed_at', { useTz: true });
    t.text('discount_note');
    t.jsonb('instalment_option'); // fee proposals: { count, frequency, startDate, dayOfMonth?, firstAmountMinor?, dates? }
    t.date('valid_until');
    t.text('notes');
    t.text('terms');
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('accepted_at', { useTz: true });
    t.timestamp('declined_at', { useTz: true });
    t.text('decline_reason');
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'quotes', 'quotes_kind_chk', `kind in (${inList(QUOTE_KINDS)})`);
  await check(knex, 'quotes', 'quotes_status_chk', `status in (${inList(QUOTE_STATUSES)})`);
  await check(knex, 'quotes', 'quotes_discount_status_chk', `discount_status in (${inList(DISCOUNT_STATUSES)})`);
  await check(knex, 'quotes', 'quotes_currency_chk', "currency ~ '^[A-Z]{3}$'");
  await check(knex, 'quotes', 'quotes_amounts_chk', 'subtotal_minor >= 0 and discount_minor >= 0 and total_minor >= 0');
  await knex.raw('create unique index quotes_number_uq on quotes (company_id, number)');
  await knex.raw('create index quotes_company_created_idx on quotes (company_id, created_at desc, id desc)');
  await knex.raw('create index quotes_group_created_idx on quotes (group_id, created_at desc, id desc)');
  await knex.raw('create index quotes_deal_idx on quotes (deal_id, created_at desc)');
  await knex.raw("create index quotes_pending_approval_idx on quotes (company_id, updated_at desc) where status = 'pending_approval'");

  // ---------- Agreements and e-sign ----------
  await knex.schema.createTable('agreement_templates', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.specificType('key', 'citext').notNullable();
    t.text('name').notNullable();
    t.text('audience').notNullable().defaultTo('b2c');
    t.text('body').notNullable(); // plain text with {{placeholders}}
    t.text('sign_type').notNullable().defaultTo('aadhaar');
    t.integer('expires_in_days').notNullable().defaultTo(10);
    t.boolean('active').notNullable().defaultTo(true);
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'agreement_templates', 'agreement_templates_audience_chk', `audience in (${inList(AUDIENCES)})`);
  await check(knex, 'agreement_templates', 'agreement_templates_sign_type_chk', `sign_type in (${inList(SIGN_TYPES)})`);
  await check(knex, 'agreement_templates', 'agreement_templates_expiry_chk', 'expires_in_days between 1 and 90');
  await knex.raw('create unique index agreement_templates_key_uq on agreement_templates (company_id, key)');

  await knex.schema.createTable('agreements', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.uuid('quote_id').references('id').inTable('quotes').onDelete('RESTRICT');
    t.uuid('template_id').references('id').inTable('agreement_templates').onDelete('RESTRICT');
    t.bigInteger('number').notNullable();
    t.text('ref').notNullable(); // "SP-AG-0007"
    t.text('title').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.text('body').notNullable(); // rendered text that becomes the PDF
    jsonb(knex, t, 'signers', "'[]'::jsonb"); // [{ name, identifier (PII), role, order, signType, status, signedAt }]
    t.text('sign_type').notNullable().defaultTo('aadhaar');
    t.integer('expires_in_days').notNullable().defaultTo(10);
    t.text('provider'); // digio
    t.text('provider_document_id');
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('signed_at', { useTz: true });
    t.timestamp('cancelled_at', { useTz: true });
    t.jsonb('failure'); // { code, message } from the provider
    t.timestamp('last_event_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'agreements', 'agreements_status_chk', `status in (${inList(AGREEMENT_STATUSES)})`);
  await check(knex, 'agreements', 'agreements_sign_type_chk', `sign_type in (${inList(SIGN_TYPES)})`);
  await knex.raw('create unique index agreements_number_uq on agreements (company_id, number)');
  await knex.raw('create index agreements_company_created_idx on agreements (company_id, created_at desc, id desc)');
  await knex.raw('create index agreements_group_created_idx on agreements (group_id, created_at desc, id desc)');
  await knex.raw('create index agreements_deal_idx on agreements (deal_id, created_at desc)');
  await knex.raw(
    'create unique index agreements_provider_doc_uq on agreements (provider, provider_document_id) where provider_document_id is not null',
  );
  await knex.raw("create index agreements_expiry_idx on agreements (expires_at) where status in ('sent', 'partially_signed')");

  // ---------- Instalment plans ----------
  await knex.schema.createTable('instalment_plans', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.uuid('quote_id').references('id').inTable('quotes').onDelete('RESTRICT');
    currency(t);
    t.bigInteger('total_minor').notNullable();
    t.integer('count').notNullable();
    jsonb(knex, t, 'schedule');
    t.text('status').notNullable().defaultTo('active');
    t.uuid('replaces_plan_id').references('id').inTable('instalment_plans').onDelete('RESTRICT');
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'instalment_plans', 'instalment_plans_status_chk', `status in (${inList(INSTALMENT_PLAN_STATUSES)})`);
  await knex.raw('create index instalment_plans_deal_idx on instalment_plans (deal_id)');
  await knex.raw("create unique index instalment_plans_quote_active_uq on instalment_plans (quote_id) where status = 'active'");

  await knex.schema.createTable('instalments', (t) => {
    id(knex, t);
    t.uuid('plan_id').notNullable().references('id').inTable('instalment_plans').onDelete('CASCADE');
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.integer('number').notNullable();
    t.date('due_date').notNullable();
    t.bigInteger('amount_minor').notNullable();
    money(t, 'paid_minor');
    currency(t);
    t.text('status').notNullable().defaultTo('pending');
    t.timestamp('paid_at', { useTz: true });
    t.specificType('reminder_keys', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]")); // reminders already sent
    t.timestamp('last_reminder_at', { useTz: true });
    timestamps(knex, t);
  });
  await check(knex, 'instalments', 'instalments_status_chk', `status in (${inList(INSTALMENT_STATUSES)})`);
  await check(knex, 'instalments', 'instalments_amounts_chk', 'amount_minor > 0 and paid_minor >= 0');
  await knex.raw('create unique index instalments_number_uq on instalments (plan_id, number)');
  await knex.raw("create index instalments_company_due_idx on instalments (company_id, due_date, id) where status = 'pending'");
  await knex.raw("create index instalments_due_idx on instalments (due_date) where status = 'pending'");
  await knex.raw('create index instalments_deal_idx on instalments (deal_id)');

  // ---------- Subscriptions (B2B software) ----------
  await knex.schema.createTable('subscriptions', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.uuid('account_id').references('id').inTable('accounts').onDelete('RESTRICT');
    t.uuid('plan_id').notNullable().references('id').inTable('billing_plans').onDelete('RESTRICT');
    t.text('status').notNullable().defaultTo('pending');
    t.integer('quantity').notNullable().defaultTo(1);
    t.text('unit').notNullable().defaultTo('flat');
    t.text('interval').notNullable();
    t.bigInteger('unit_price_minor').notNullable();
    currency(t);
    t.boolean('prices_include_tax').notNullable().defaultTo(false);
    jsonb(knex, t, 'addons', "'[]'::jsonb"); // [{ code, name, quantity, unitPriceMinor }]
    t.date('start_date').notNullable();
    t.date('current_period_start').notNullable();
    t.date('current_period_end').notNullable(); // the renewal date (exclusive end of the term)
    t.boolean('cancel_at_period_end').notNullable().defaultTo(false);
    t.timestamp('cancelled_at', { useTz: true });
    t.text('cancel_reason');
    t.integer('renewal_count').notNullable().defaultTo(0);
    t.timestamp('renewal_reminded_at', { useTz: true });
    t.jsonb('pending_change'); // a downgrade that waits for renewal: { quantity, addons, requestedBy, requestedAt }
    t.text('provider');
    t.text('provider_subscription_id');
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'subscriptions', 'subscriptions_status_chk', `status in (${inList(SUBSCRIPTION_STATUSES)})`);
  await check(knex, 'subscriptions', 'subscriptions_interval_chk', `interval in (${inList(BILLING_INTERVALS)})`);
  await check(knex, 'subscriptions', 'subscriptions_unit_chk', `unit in (${inList(PLAN_UNITS)})`);
  await check(knex, 'subscriptions', 'subscriptions_quantity_chk', 'quantity > 0 and unit_price_minor >= 0');
  await knex.raw('create index subscriptions_company_created_idx on subscriptions (company_id, created_at desc, id desc)');
  await knex.raw('create index subscriptions_group_created_idx on subscriptions (group_id, created_at desc, id desc)');
  await knex.raw(
    "create index subscriptions_renewal_idx on subscriptions (company_id, current_period_end, id) where status in ('active', 'past_due')",
  );
  await knex.raw("create index subscriptions_period_end_idx on subscriptions (current_period_end) where status in ('active', 'past_due')");
  await knex.raw('create index subscriptions_deal_idx on subscriptions (deal_id)');

  // ---------- Payments ----------
  await knex.schema.createTable('payments', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.uuid('quote_id').references('id').inTable('quotes').onDelete('RESTRICT');
    t.uuid('instalment_id').references('id').inTable('instalments').onDelete('RESTRICT');
    t.uuid('subscription_id').references('id').inTable('subscriptions').onDelete('RESTRICT');
    t.uuid('invoice_id'); // FK added below (invoices reference payments too)
    t.text('purpose').notNullable();
    t.text('provider').notNullable();
    t.uuid('account_id').references('id').inTable('billing_payment_accounts').onDelete('RESTRICT');
    t.text('status').notNullable().defaultTo('creating');
    t.bigInteger('amount_minor').notNullable();
    currency(t);
    money(t, 'amount_refunded_minor');
    t.text('method');
    t.text('description').notNullable();
    t.text('provider_link_id'); // plink_… / Stripe Checkout session or payment link id
    t.text('provider_order_id');
    t.text('provider_payment_id'); // pay_… / pi_…
    t.text('link_url');
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('paid_at', { useTz: true });
    t.timestamp('failed_at', { useTz: true });
    t.jsonb('failure'); // { code, message } of the latest failure (no card or bank details)
    t.integer('attempt').notNullable().defaultTo(1);
    t.timestamp('next_retry_at', { useTz: true });
    t.uuid('retry_of_id').references('id').inTable('payments').onDelete('RESTRICT');
    t.text('idempotency_key');
    t.text('invoice_error'); // why an invoice couldn't be issued on payment (billing not set up)
    t.jsonb('invoice_source'); // { lines, pricesIncludeTax, recipient, label, pricedTotals, totalMinor }: what the invoice will bill
    t.bigInteger('fee_minor'); // provider fee incl. GST, from the payment entity
    t.bigInteger('provider_tax_minor');
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'payments', 'payments_status_chk', `status in (${inList(PAYMENT_STATUSES)})`);
  await check(knex, 'payments', 'payments_provider_chk', `provider in (${inList(PAYMENT_PROVIDERS)})`);
  await check(knex, 'payments', 'payments_purpose_chk', `purpose in (${inList(PAYMENT_PURPOSES)})`);
  await check(knex, 'payments', 'payments_amounts_chk', 'amount_minor > 0 and amount_refunded_minor >= 0 and amount_refunded_minor <= amount_minor');
  await check(knex, 'payments', 'payments_paid_chk', "(status = 'succeeded') = (paid_at is not null)");
  await knex.raw('create unique index payments_idempotency_uq on payments (company_id, idempotency_key) where idempotency_key is not null');
  await knex.raw('create unique index payments_link_uq on payments (provider, provider_link_id) where provider_link_id is not null');
  await knex.raw('create index payments_company_created_idx on payments (company_id, created_at desc, id desc)');
  await knex.raw('create index payments_group_created_idx on payments (group_id, created_at desc, id desc)');
  await knex.raw('create index payments_deal_idx on payments (deal_id, created_at desc)');
  await knex.raw('create index payments_instalment_idx on payments (instalment_id) where instalment_id is not null');
  await knex.raw('create index payments_quote_idx on payments (quote_id) where quote_id is not null');
  await knex.raw('create index payments_subscription_idx on payments (subscription_id) where subscription_id is not null');
  await knex.raw("create index payments_retry_idx on payments (next_retry_at) where status = 'failed' and next_retry_at is not null");

  // Webhook idempotency: one row per provider event, written in the transaction that applies it.
  await knex.schema.createTable('billing_provider_events', (t) => {
    t.text('dedupe_key').primary(); // razorpay:<event id>, stripe:<evt id>, digio:<notification id>
    t.text('provider').notNullable();
    t.text('event_type').notNullable();
    t.text('kind');
    t.uuid('company_id');
    t.uuid('payment_id');
    t.uuid('refund_id');
    t.uuid('agreement_id');
    t.text('outcome').notNullable(); // applied | ignored | unmatched
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('create index billing_provider_events_company_idx on billing_provider_events (company_id, received_at desc)');

  // ---------- Invoices ----------
  await knex.schema.createTable('invoices', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t, { nullable: true });
    t.uuid('payment_id').references('id').inTable('payments').onDelete('RESTRICT');
    t.uuid('subscription_id').references('id').inTable('subscriptions').onDelete('RESTRICT');
    t.uuid('series_id').notNullable().references('id').inTable('billing_number_series').onDelete('RESTRICT');
    t.text('supplier_gstin').notNullable();
    t.text('series_document_type').notNullable(); // invoice | bill_of_supply
    t.integer('fy_start_year').notNullable();
    t.integer('sequence').notNullable();
    t.text('number').notNullable(); // "SPI/2627/00042"
    t.text('document_type').notNullable(); // tax_invoice | bill_of_supply (computeTax)
    t.text('status').notNullable().defaultTo('issued');
    t.date('issue_date').notNullable();
    jsonb(knex, t, 'supplier');
    jsonb(knex, t, 'recipient');
    t.text('place_of_supply_state_code').notNullable();
    t.text('supply_type').notNullable();
    t.text('tax_kind').notNullable();
    currency(t);
    jsonb(knex, t, 'lines', "'[]'::jsonb"); // computeTax lines with the CGST/SGST/IGST split
    jsonb(knex, t, 'tax_input'); // the exact computeTax input (credit notes need it)
    jsonb(knex, t, 'totals');
    jsonb(knex, t, 'sac_summary', "'[]'::jsonb");
    money(t, 'taxable_minor');
    money(t, 'cgst_minor');
    money(t, 'sgst_minor');
    money(t, 'igst_minor');
    money(t, 'tax_minor');
    t.bigInteger('round_off_minor').notNullable().defaultTo(0);
    money(t, 'total_minor');
    money(t, 'credited_minor');
    t.text('amount_in_words').notNullable();
    t.text('endorsement');
    t.text('notes');
    t.timestamp('cancelled_at', { useTz: true });
    t.text('cancel_reason');
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'invoices', 'invoices_status_chk', `status in (${inList(INVOICE_STATUSES)})`);
  await check(knex, 'invoices', 'invoices_series_type_chk', "series_document_type in ('invoice', 'bill_of_supply')");
  await knex.raw('create unique index invoices_number_uq on invoices (supplier_gstin, series_document_type, fy_start_year, number)');
  await knex.raw('create unique index invoices_payment_uq on invoices (payment_id) where payment_id is not null');
  await knex.raw('create index invoices_company_created_idx on invoices (company_id, created_at desc, id desc)');
  await knex.raw('create index invoices_group_created_idx on invoices (group_id, created_at desc, id desc)');
  await knex.raw('create index invoices_deal_idx on invoices (deal_id) where deal_id is not null');
  await knex.raw('alter table payments add constraint payments_invoice_fk foreign key (invoice_id) references invoices(id) on delete restrict');

  // ---------- Refunds and credit notes ----------
  await knex.schema.createTable('refunds', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t);
    t.uuid('payment_id').notNullable().references('id').inTable('payments').onDelete('RESTRICT');
    t.uuid('invoice_id').references('id').inTable('invoices').onDelete('RESTRICT');
    t.uuid('credit_note_id'); // FK below
    t.bigInteger('number').notNullable();
    t.text('ref').notNullable(); // "SP-RF-0003"
    t.bigInteger('amount_minor').notNullable();
    currency(t);
    t.text('reason').notNullable();
    t.text('note');
    t.text('status').notNullable().defaultTo('requested');
    userRef(t, 'requested_by');
    t.timestamp('requested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    userRef(t, 'reviewed_by');
    t.timestamp('reviewed_at', { useTz: true });
    t.text('review_note');
    t.text('provider').notNullable();
    t.text('provider_refund_id');
    t.text('idempotency_key').notNullable(); // sent to the provider; stable across retries
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('processed_at', { useTz: true });
    t.jsonb('failure');
    timestamps(knex, t);
  });
  await check(knex, 'refunds', 'refunds_status_chk', `status in (${inList(REFUND_STATUSES)})`);
  await check(knex, 'refunds', 'refunds_amount_chk', 'amount_minor > 0');
  await knex.raw('create unique index refunds_number_uq on refunds (company_id, number)');
  await knex.raw('create unique index refunds_idempotency_uq on refunds (idempotency_key)');
  await knex.raw('create unique index refunds_provider_uq on refunds (provider, provider_refund_id) where provider_refund_id is not null');
  await knex.raw('create index refunds_company_created_idx on refunds (company_id, created_at desc, id desc)');
  await knex.raw('create index refunds_group_created_idx on refunds (group_id, created_at desc, id desc)');
  await knex.raw("create index refunds_awaiting_idx on refunds (company_id, requested_at) where status = 'requested'");
  await knex.raw('create index refunds_payment_idx on refunds (payment_id)');

  await knex.schema.createTable('credit_notes', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    dealRef(t, { nullable: true });
    t.uuid('invoice_id').notNullable().references('id').inTable('invoices').onDelete('RESTRICT');
    t.uuid('refund_id').references('id').inTable('refunds').onDelete('RESTRICT');
    t.uuid('series_id').notNullable().references('id').inTable('billing_number_series').onDelete('RESTRICT');
    t.text('supplier_gstin').notNullable();
    t.integer('fy_start_year').notNullable();
    t.integer('sequence').notNullable();
    t.text('number').notNullable();
    t.date('issue_date').notNullable();
    t.text('reason').notNullable();
    t.text('mode').notNullable(); // full | partial
    currency(t);
    jsonb(knex, t, 'lines', "'[]'::jsonb");
    jsonb(knex, t, 'result'); // computeCreditNote result (previousCredits for the next note)
    money(t, 'taxable_minor');
    money(t, 'tax_minor');
    money(t, 'total_minor');
    t.text('amount_in_words').notNullable();
    t.text('status').notNullable().defaultTo('issued');
    t.text('notes');
    userRef(t, 'created_by');
    timestamps(knex, t);
  });
  await check(knex, 'credit_notes', 'credit_notes_status_chk', `status in (${inList(INVOICE_STATUSES)})`);
  await knex.raw('create unique index credit_notes_number_uq on credit_notes (supplier_gstin, fy_start_year, number)');
  await knex.raw('create index credit_notes_invoice_idx on credit_notes (invoice_id)');
  await knex.raw('create index credit_notes_company_created_idx on credit_notes (company_id, created_at desc, id desc)');
  await knex.raw('create index credit_notes_group_created_idx on credit_notes (group_id, created_at desc, id desc)');
  await knex.raw(
    'alter table refunds add constraint refunds_credit_note_fk foreign key (credit_note_id) references credit_notes(id) on delete restrict',
  );
}

export async function down(knex) {
  await knex.raw('alter table if exists refunds drop constraint if exists refunds_credit_note_fk');
  await knex.raw('alter table if exists payments drop constraint if exists payments_invoice_fk');
  for (const table of [
    'credit_notes',
    'refunds',
    'invoices',
    'billing_provider_events',
    'payments',
    'subscriptions',
    'instalments',
    'instalment_plans',
    'agreements',
    'agreement_templates',
    'quotes',
    'billing_payment_accounts',
    'billing_prices',
    'billing_price_lists',
    'billing_plans',
    'billing_number_counters',
    'billing_number_series',
    'billing_profiles',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
