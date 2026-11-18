// Phase 10, partners: brokers and referral partners, their relationship with each company, referral
// links, attributions of leads to partners, commission plans, commissions accrued on payments (and
// clawed back on refunds), and payout batches. docs/partners/PARTNERS.md describes the rules.
//
// Conventions as in phase 2 (docs/crm/PHASE2_CONTRACT.md §5): UUID keys, timestamptz in UTC, money
// as bigint minor units plus an ISO currency. A partner is stored once per group, like a contact;
// each company works with them through a link row (partner_companies) that carries the owning
// unit, the counsellor who owns their leads, the status and an optional commission plan. Payout
// details are stored encrypted (AES-256-GCM, lib/crypto.js) with a masked summary beside them.

function id(knex, t) {
  t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
}

function timestamps(knex, t) {
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

const unitRef = (t, column) => t.uuid(column).notNullable().references('id').inTable('org_units').onDelete('RESTRICT');
const userRef = (t, column) => t.uuid(column).references('id').inTable('users').onDelete('SET NULL');
const inList = (values) => values.map((v) => `'${v}'`).join(', ');

const PARTNER_KINDS = ['person', 'organisation'];
const PAYOUT_METHODS = ['bank_transfer', 'upi'];
const LINK_STATUSES = ['pending', 'active', 'suspended', 'terminated'];
const PLAN_BASES = ['percent', 'fixed'];
const PLAN_TRIGGERS = ['first_payment', 'full_payment'];
const TOUCHES = ['first', 'last'];
const ATTRIBUTION_SOURCES = ['referral_link', 'partner_code', 'manual'];
const COMMISSION_STATUSES = ['pending', 'approved', 'rejected', 'paid', 'clawed_back'];
const RECOVERIES = ['netted', 'deduct'];
const PAYOUT_STATUSES = ['draft', 'approved', 'paid', 'cancelled'];

export async function up(knex) {
  await knex.raw('create extension if not exists citext');

  // ---------- Partners (stored once per group) ----------
  await knex.schema.createTable('partners', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    t.text('kind').notNullable().defaultTo('person');
    t.text('name').notNullable();
    t.text('name_normalized').notNullable().defaultTo('');
    // The partner's own code across the group ("agent code", "edupath-advisors"): forms and CSV
    // imports carry it as source.partnerId. Referral link codes are separate and per link.
    t.specificType('code', 'citext');
    t.text('legal_name');
    t.text('email'); // lower-case (personal data)
    t.text('phone'); // E.164 (personal data)
    t.text('city');
    // The CRM person or institute behind the partner, when they are one.
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('SET NULL');
    t.uuid('account_id').references('id').inTable('accounts').onDelete('SET NULL');
    userRef(t, 'user_id'); // portal sign-in
    t.text('payout_method');
    t.text('payout_details_enc'); // AES-256-GCM ciphertext of the JSON payout details
    t.jsonb('payout_hint').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // masked summary, safe to show
    t.timestamp('payout_details_updated_at', { useTz: true });
    userRef(t, 'payout_details_updated_by');
    t.text('notes');
    userRef(t, 'created_by');
    timestamps(knex, t);
    t.check(`kind in (${inList(PARTNER_KINDS)})`, [], 'partners_kind_chk');
    t.check(`payout_method is null or payout_method in (${inList(PAYOUT_METHODS)})`, [], 'partners_payout_method_chk');
  });
  await knex.raw('create index partners_group_name_idx on partners (group_id, name_normalized, id)');
  await knex.raw('create index partners_group_email_idx on partners (group_id, email) where email is not null');
  await knex.raw('create index partners_group_phone_idx on partners (group_id, phone) where phone is not null');
  await knex.raw('create unique index partners_user_uq on partners (user_id) where user_id is not null');
  await knex.raw('create unique index partners_group_code_uq on partners (group_id, code) where code is not null');

  // ---------- Commission plans (per company and product line) ----------
  await knex.schema.createTable('commission_plans', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT'); // null = every product line
    t.text('name').notNullable();
    t.text('description');
    t.text('basis').notNullable(); // percent | fixed
    t.integer('rate_bps'); // percent plans: basis points (1000 = 10%)
    t.bigInteger('fixed_minor'); // fixed plans
    t.specificType('currency', 'char(3)'); // fixed plans: the payout currency; percent plans: only payments in it (null = any)
    t.text('trigger').notNullable().defaultTo('first_payment');
    t.integer('clawback_days').notNullable().defaultTo(30);
    t.bigInteger('cap_minor'); // most one commission can be (in `currency`)
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('position').notNullable().defaultTo(0);
    userRef(t, 'created_by');
    timestamps(knex, t);
    t.check(`basis in (${inList(PLAN_BASES)})`, [], 'commission_plans_basis_chk');
    t.check(`trigger in (${inList(PLAN_TRIGGERS)})`, [], 'commission_plans_trigger_chk');
    t.check('clawback_days between 0 and 730', [], 'commission_plans_clawback_chk');
    t.check(
      "(basis = 'percent' and rate_bps between 1 and 10000) or (basis = 'fixed' and fixed_minor > 0 and currency is not null)",
      [],
      'commission_plans_amount_chk',
    );
    t.check('cap_minor is null or (cap_minor > 0 and currency is not null)', [], 'commission_plans_cap_chk');
    t.check("currency is null or currency ~ '^[A-Z]{3}$'", [], 'commission_plans_currency_chk');
  });
  await knex.raw('create index commission_plans_company_idx on commission_plans (company_id, position, id)');

  // ---------- A company works with a partner ----------
  await knex.schema.createTable('partner_companies', (t) => {
    id(knex, t);
    t.uuid('partner_id').notNullable().references('id').inTable('partners').onDelete('CASCADE');
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    unitRef(t, 'unit_id'); // owning unit inside the company
    userRef(t, 'owner_user_id'); // the counsellor who owns the partner's leads
    t.text('status').notNullable().defaultTo('active');
    t.uuid('commission_plan_id').references('id').inTable('commission_plans').onDelete('SET NULL'); // overrides plan matching
    t.timestamp('joined_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('ended_at', { useTz: true });
    userRef(t, 'created_by');
    timestamps(knex, t);
    t.unique(['partner_id', 'company_id'], { indexName: 'partner_companies_uq' });
    t.check(`status in (${inList(LINK_STATUSES)})`, [], 'partner_companies_status_chk');
  });
  await knex.raw('create index partner_companies_company_unit_idx on partner_companies (company_id, unit_id)');
  await knex.raw('create index partner_companies_unit_idx on partner_companies (unit_id)');
  await knex.raw('create index partner_companies_owner_idx on partner_companies (owner_user_id) where owner_user_id is not null');

  // ---------- Referral links ----------
  await knex.schema.createTable('partner_referral_links', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('partner_id').notNullable().references('id').inTable('partners').onDelete('CASCADE');
    t.uuid('product_line_id').references('id').inTable('product_lines').onDelete('RESTRICT');
    t.specificType('code', 'citext').notNullable(); // unique everywhere, so a code alone finds the partner
    t.text('label');
    t.text('landing_url');
    t.jsonb('utm').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('deactivated_at', { useTz: true });
    userRef(t, 'created_by');
    t.boolean('created_by_partner').notNullable().defaultTo(false);
    timestamps(knex, t);
    t.unique(['code'], { indexName: 'partner_referral_links_code_uq' });
  });
  await knex.raw('create index partner_referral_links_partner_idx on partner_referral_links (partner_id, created_at desc, id desc)');
  await knex.raw('create index partner_referral_links_company_idx on partner_referral_links (company_id, created_at desc, id desc)');
  await knex.raw('create index partner_referral_links_group_idx on partner_referral_links (group_id, created_at desc, id desc)');

  // ---------- Attributions: which partner brought a lead ----------
  await knex.schema.createTable('partner_attributions', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('partner_id').notNullable().references('id').inTable('partners').onDelete('RESTRICT');
    t.uuid('referral_link_id').references('id').inTable('partner_referral_links').onDelete('SET NULL');
    t.uuid('deal_id').notNullable().references('id').inTable('deals').onDelete('RESTRICT');
    t.uuid('contact_id').references('id').inTable('contacts').onDelete('SET NULL');
    t.text('touch').notNullable(); // first | last
    t.text('source').notNullable();
    t.text('code'); // the referral or partner code as it arrived
    t.text('enquiry_ref'); // the intake event that created the lead (deals.source_event_id)
    t.timestamp('touched_at', { useTz: true }).notNullable();
    userRef(t, 'created_by');
    timestamps(knex, t);
    t.unique(['deal_id', 'touch'], { indexName: 'partner_attributions_deal_touch_uq' });
    t.check(`touch in (${inList(TOUCHES)})`, [], 'partner_attributions_touch_chk');
    t.check(`source in (${inList(ATTRIBUTION_SOURCES)})`, [], 'partner_attributions_source_chk');
  });
  await knex.raw('create index partner_attributions_partner_idx on partner_attributions (partner_id, created_at desc, id desc)');
  await knex.raw('create index partner_attributions_company_idx on partner_attributions (company_id, created_at desc, id desc)');
  await knex.raw('create index partner_attributions_group_idx on partner_attributions (group_id, created_at desc, id desc)');

  // ---------- Payout batches ----------
  await knex.schema.createTable('partner_payouts', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.bigInteger('number').notNullable();
    t.text('ref').notNullable(); // SP-PO-7
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.specificType('currency', 'char(3)').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.bigInteger('commission_minor').notNullable().defaultTo(0);
    t.bigInteger('deduction_minor').notNullable().defaultTo(0);
    t.bigInteger('total_minor').notNullable().defaultTo(0); // net: commissions minus clawback deductions
    t.integer('line_count').notNullable().defaultTo(0);
    t.text('reference'); // the bank batch reference once paid
    t.text('notes');
    userRef(t, 'created_by');
    userRef(t, 'approved_by');
    t.timestamp('approved_at', { useTz: true });
    userRef(t, 'paid_by');
    t.timestamp('paid_at', { useTz: true });
    userRef(t, 'cancelled_by');
    t.timestamp('cancelled_at', { useTz: true });
    t.text('cancel_reason');
    timestamps(knex, t);
    t.unique(['company_id', 'number'], { indexName: 'partner_payouts_number_uq' });
    t.check(`status in (${inList(PAYOUT_STATUSES)})`, [], 'partner_payouts_status_chk');
    t.check('period_end >= period_start', [], 'partner_payouts_period_chk');
    t.check("currency ~ '^[A-Z]{3}$'", [], 'partner_payouts_currency_chk');
  });
  await knex.raw('create index partner_payouts_company_idx on partner_payouts (company_id, created_at desc, id desc)');
  await knex.raw('create index partner_payouts_group_idx on partner_payouts (group_id, created_at desc, id desc)');

  await knex.schema.createTable('partner_payout_lines', (t) => {
    id(knex, t);
    t.uuid('payout_id').notNullable().references('id').inTable('partner_payouts').onDelete('CASCADE');
    t.uuid('partner_id').notNullable().references('id').inTable('partners').onDelete('RESTRICT');
    t.bigInteger('commission_minor').notNullable().defaultTo(0);
    t.bigInteger('deduction_minor').notNullable().defaultTo(0);
    t.bigInteger('net_minor').notNullable().defaultTo(0);
    t.integer('commission_count').notNullable().defaultTo(0);
    t.jsonb('payout_hint').notNullable().defaultTo(knex.raw("'{}'::jsonb")); // masked details when the batch was made
    t.text('reference'); // per-partner transfer reference (UTR), when known
    timestamps(knex, t);
    t.unique(['payout_id', 'partner_id'], { indexName: 'partner_payout_lines_uq' });
  });
  await knex.raw('create index partner_payout_lines_partner_idx on partner_payout_lines (partner_id, created_at desc)');

  // ---------- Commissions: one per qualifying payment ----------
  await knex.schema.createTable('partner_commissions', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('partner_id').notNullable().references('id').inTable('partners').onDelete('RESTRICT');
    t.uuid('plan_id').notNullable().references('id').inTable('commission_plans').onDelete('RESTRICT');
    t.uuid('attribution_id').references('id').inTable('partner_attributions').onDelete('SET NULL');
    t.uuid('deal_id').notNullable().references('id').inTable('deals').onDelete('RESTRICT');
    t.text('payment_id').notNullable(); // idempotency key: one commission per payment
    t.text('source_event_id'); // the payment.succeeded outbox event
    t.text('trigger').notNullable();
    t.text('basis').notNullable();
    t.integer('rate_bps');
    t.bigInteger('base_minor').notNullable(); // what a percent was taken of (also the reference for clawbacks)
    t.specificType('base_currency', 'char(3)').notNullable();
    t.bigInteger('amount_minor').notNullable();
    t.specificType('currency', 'char(3)').notNullable();
    t.bigInteger('clawed_back_minor').notNullable().defaultTo(0);
    t.text('status').notNullable().defaultTo('pending');
    t.timestamp('earned_at', { useTz: true }).notNullable();
    t.timestamp('clawback_until', { useTz: true }).notNullable();
    userRef(t, 'approved_by');
    t.timestamp('approved_at', { useTz: true });
    userRef(t, 'rejected_by');
    t.timestamp('rejected_at', { useTz: true });
    t.text('rejection_reason');
    t.uuid('payout_id').references('id').inTable('partner_payouts').onDelete('SET NULL');
    t.timestamp('paid_at', { useTz: true });
    t.timestamp('clawed_back_at', { useTz: true });
    t.jsonb('plan_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    timestamps(knex, t);
    t.unique(['company_id', 'payment_id'], { indexName: 'partner_commissions_payment_uq' });
    t.check(`status in (${inList(COMMISSION_STATUSES)})`, [], 'partner_commissions_status_chk');
    t.check('amount_minor >= 0 and clawed_back_minor between 0 and amount_minor', [], 'partner_commissions_amount_chk');
  });
  await knex.raw('create index partner_commissions_company_idx on partner_commissions (company_id, created_at desc, id desc)');
  await knex.raw('create index partner_commissions_group_idx on partner_commissions (group_id, created_at desc, id desc)');
  await knex.raw('create index partner_commissions_partner_idx on partner_commissions (partner_id, created_at desc, id desc)');
  await knex.raw('create index partner_commissions_deal_idx on partner_commissions (deal_id)');
  await knex.raw('create index partner_commissions_payout_idx on partner_commissions (payout_id) where payout_id is not null');
  await knex.raw(
    "create index partner_commissions_payable_idx on partner_commissions (company_id, currency, earned_at) where status = 'approved' and payout_id is null",
  );

  await knex.schema.createTable('partner_commission_clawbacks', (t) => {
    id(knex, t);
    unitRef(t, 'group_id');
    unitRef(t, 'company_id');
    t.uuid('commission_id').notNullable().references('id').inTable('partner_commissions').onDelete('CASCADE');
    t.uuid('partner_id').notNullable().references('id').inTable('partners').onDelete('RESTRICT');
    t.text('refund_id').notNullable(); // idempotency key with the commission
    t.text('payment_id');
    t.text('source_event_id');
    t.bigInteger('amount_minor').notNullable();
    t.specificType('currency', 'char(3)').notNullable();
    // netted: the commission wasn't paid yet, so it is just smaller; deduct: it was paid, so the
    // amount comes off the partner's next payout.
    t.text('recovery').notNullable();
    t.uuid('payout_id').references('id').inTable('partner_payouts').onDelete('SET NULL');
    t.timestamp('recovered_at', { useTz: true });
    t.timestamp('refunded_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['commission_id', 'refund_id'], { indexName: 'partner_commission_clawbacks_uq' });
    t.check(`recovery in (${inList(RECOVERIES)})`, [], 'partner_commission_clawbacks_recovery_chk');
    t.check('amount_minor > 0', [], 'partner_commission_clawbacks_amount_chk');
  });
  await knex.raw(
    "create index partner_clawbacks_outstanding_idx on partner_commission_clawbacks (company_id, currency, partner_id) where recovery = 'deduct' and recovered_at is null",
  );
  await knex.raw('create index partner_clawbacks_payout_idx on partner_commission_clawbacks (payout_id) where payout_id is not null');
}

export async function down(knex) {
  for (const table of [
    'partner_commission_clawbacks',
    'partner_commissions',
    'partner_payout_lines',
    'partner_payouts',
    'partner_attributions',
    'partner_referral_links',
    'partner_companies',
    'commission_plans',
    'partners',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
