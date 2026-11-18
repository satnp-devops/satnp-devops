import { randomUUID } from 'node:crypto';
import {
  addDays,
  amountInWords,
  computeTax,
  describeSeries,
  gstinCheckCharacter,
  localDate,
  splitInstalments,
  termEndFor,
} from '../../core/billing/index.js';
import { allocateNumber, supplierFrom } from '../../modules/money/invoicing.js';
import { invoiceLinesForAmount, presentTaxLine, priceQuote, taxInputFor, taxSummary } from '../../modules/money/pricing.js';
import { subscriptionLines } from '../../modules/money/subscriptions.js';

// Demo billing data (phase 7): a billing profile with a valid GSTIN, invoice and credit-note
// series, plans and price lists, payment accounts and agreement templates for SatnPaper, Pi Vector
// and Excel; then fee proposals, quotes, payment links, instalment plans (some overdue), payments
// with their GST invoices, a refund waiting for finance, agreements and a B2B subscription that
// renews soon. Dates are relative to today. Idempotent: skipped when billing profiles exist.
// No domain events are emitted: this is history, not something other modules should react to.

const GROUP_CODE = 'phoenix';
const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;

const COMPANIES = {
  satnpaper: { code: 'satnpaper', prefix: 'SP', state: '27', pan: 'AAKCS4821Q', legal: 'SatnPaper Education Private Limited', city: 'Mumbai', stateName: 'Maharashtra', pincode: '400051' },
  pivector: { code: 'pi-vector', prefix: 'PV', state: '29', pan: 'AAKCP7315H', legal: 'Pi Vector Learning Private Limited', city: 'Bengaluru', stateName: 'Karnataka', pincode: '560034' },
  excel: { code: 'excel', prefix: 'EX', state: '07', pan: 'AAKCE2648L', legal: 'Excel Tutorials LLP', city: 'New Delhi', stateName: 'Delhi', pincode: '110017' },
};

const gstinFor = (state, pan) => {
  const first14 = `${state}${pan}1Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

const B2C_SAC = '999293'; // commercial training and coaching, 18%
const SOFTWARE_SAC = '997331'; // licensing the right to use computer software, 18%

const FEE_TEMPLATE = `FEE AGREEMENT {{deal.ref}}

This agreement is made on {{date}} between {{company.name}} (GSTIN {{company.gstin}}) and {{customer.name}}.

1. Programme. {{quote.title}}
{{quote.lines}}

2. Fees. The total fee is {{quote.total}}, inclusive of GST. {{instalments}}

3. Refunds. Fees are refundable in full within 7 days of the first class, and pro rata for classes not yet held within 30 days, less any material already provided.

4. Conduct. The student will follow the centre's code of conduct and attendance rules.

Signed by: {{signers}}`;

const SOFTWARE_TEMPLATE = `SOFTWARE SUBSCRIPTION AGREEMENT {{deal.ref}}

Between {{company.name}} (GSTIN {{company.gstin}}), the provider, and {{customer.name}}, the customer, dated {{date}}.

1. Licence. The provider grants the customer a non-exclusive licence to use the software listed below for the subscription term.
{{quote.lines}}

2. Fees. {{quote.total}} plus GST per term, payable in advance. The subscription renews automatically unless cancelled before the renewal date.

3. Data. Customer data stays the customer's property and is deleted within 30 days of the end of the subscription on request.

4. Support. Email and phone support on working days, 9:30 to 18:30 IST.

Signed by: {{signers}}`;

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('Billing demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  const companies = await knex('org_units').where({ root_id: group.id, type: 'company' });
  const companyIds = companies.map((c) => c.id);
  if (!companyIds.length) return;
  if (await knex('billing_profiles').whereIn('company_id', companyIds).first('company_id')) {
    console.log('Billing demo data already present; skipping.');
    return;
  }
  const products = await knex('products as p').join('product_lines as l', 'l.id', 'p.product_line_id').whereIn('p.company_id', companyIds).select('p.*', 'l.kind as line_kind', 'l.audience');
  if (!products.length) {
    console.log('Billing demo data needs the CRM seed (02_crm.js) first.');
    return;
  }
  const users = new Map((await knex('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const owner = users.get('owner@phoenix.test') ?? null;
  const finance = users.get('finance@phoenix.test') ?? null;
  const today = localDate(Date.now(), TZ);
  const at = (days, hour = 11) => new Date(Date.now() + days * DAY + (hour - 12) * 3_600_000);

  const setup = {};
  for (const [key, spec] of Object.entries(COMPANIES)) {
    const company = companies.find((c) => c.code === spec.code);
    if (!company) continue;
    setup[key] = await seedCompany(knex, { company, spec, products: products.filter((p) => p.company_id === company.id), createdBy: owner });
  }

  // ---------- Transactions on seeded deals ----------
  const issued = []; // payments to invoice, issued in date order at the end (numbers rise with dates)
  const dealsOf = async (companyKey, kind, stageKey, ownerEmail = null, limit = 3) => {
    if (!setup[companyKey]) return [];
    const q = knex('deals as d')
      .join('pipeline_stages as s', 's.id', 'd.stage_id')
      .where('d.company_id', setup[companyKey].company.id)
      .where('d.kind', kind)
      .where('s.key', stageKey)
      .whereNull('d.archived_at')
      .orderBy('d.number')
      .limit(limit)
      .select('d.*');
    if (ownerEmail) q.where('d.owner_user_id', users.get(ownerEmail) ?? null);
    return q;
  };

  const sp = setup.satnpaper;
  if (sp) {
    const [ritikaWon1, ritikaWon2] = await dealsOf('satnpaper', 'b2c', 'enrolled', 'ritika@phoenix.test');
    const [kabirWon1, kabirWon2] = await dealsOf('satnpaper', 'b2c', 'enrolled', 'kabir@phoenix.test');
    const [ritikaProp1, ritikaProp2] = await dealsOf('satnpaper', 'b2c', 'fee_proposed', 'ritika@phoenix.test');
    const [kabirProp] = await dealsOf('satnpaper', 'b2c', 'fee_proposed', 'kabir@phoenix.test');
    const [b2bWon1, b2bWon2] = await dealsOf('satnpaper', 'b2b', 'contract_signed');
    const [b2bQuote] = await dealsOf('satnpaper', 'b2b', 'quote_sent');
    const ritika = users.get('ritika@phoenix.test');
    const kabir = users.get('kabir@phoenix.test');
    const sales = users.get('sales.satnpaper@phoenix.test');
    const manager = kabir; // Kabir manages SatnPaper › Online

    if (ritikaWon1) {
      const quote = await seedQuote(knex, sp, ritikaWon1, { plan: 'SAT-GB-WKND', discount: 250_000, status: 'accepted', createdBy: ritika, sentDays: -40 });
      const plan = await seedInstalmentPlan(knex, quote, { startDate: addDays(today, -32), count: 3 });
      const first = plan.instalments[0];
      const payment = await seedPayment(knex, sp, ritikaWon1, { quote, instalment: first, plan, status: 'succeeded', method: 'upi', paidAt: at(-31), createdBy: ritika });
      issued.push({ payment, deal: ritikaWon1, setup: sp, date: localDate(at(-31), TZ) });
      await seedPayment(knex, sp, ritikaWon1, { quote, instalment: plan.instalments[1], plan, status: 'link_sent', createdBy: null, createdAt: at(-3) });
      await seedAgreement(knex, sp, ritikaWon1, { quote, template: sp.templates.fee, status: 'signed', createdBy: ritika, sentDays: -39 });
    }
    if (ritikaWon2) {
      const quote = await seedQuote(knex, sp, ritikaWon2, { plan: 'SAT-CRASH-4W', status: 'accepted', createdBy: ritika, sentDays: -12 });
      const payment = await seedPayment(knex, sp, ritikaWon2, { quote, status: 'succeeded', method: 'card', paidAt: at(-11), createdBy: ritika });
      issued.push({ payment, deal: ritikaWon2, setup: sp, date: localDate(at(-11), TZ) });
    }
    if (kabirWon1) {
      const quote = await seedQuote(knex, sp, kabirWon1, { plan: 'SAT-1ON1-12', status: 'accepted', createdBy: kabir, sentDays: -20 });
      const payment = await seedPayment(knex, sp, kabirWon1, { quote, status: 'succeeded', method: 'netbanking', paidAt: at(-18), createdBy: kabir });
      issued.push({ payment, deal: kabirWon1, setup: sp, date: localDate(at(-18), TZ), refund: { amountMinor: 500_000, reason: 'service_issue', note: 'Two sessions missed because of mentor illness', requestedBy: kabir } });
    }
    if (kabirWon2) {
      const quote = await seedQuote(knex, sp, kabirWon2, { plan: 'SAT-USADM', discount: 1_500_000, status: 'accepted', createdBy: kabir, sentDays: -70, approvedBy: manager });
      const plan = await seedInstalmentPlan(knex, quote, { startDate: addDays(today, -62), count: 4, firstAmountMinor: 5_000_000 });
      const payment = await seedPayment(knex, sp, kabirWon2, { quote, instalment: plan.instalments[0], plan, status: 'succeeded', method: 'bank_transfer', provider: 'manual', paidAt: at(-62), createdBy: finance, reference: 'NEFT-HDFC-778120' });
      issued.push({ payment, deal: kabirWon2, setup: sp, date: localDate(at(-62), TZ) });
      // The second instalment failed once and is overdue; the third is due this week.
      await seedPayment(knex, sp, kabirWon2, { quote, instalment: plan.instalments[1], plan, status: 'failed', createdBy: null, createdAt: at(-33), failure: { code: 'BAD_REQUEST_ERROR', message: 'Payment was declined by the bank', count: 1, reminders: 2 } });
    }
    if (ritikaProp1) {
      const quote = await seedQuote(knex, sp, ritikaProp1, { plan: 'SAT-GB-EVE', status: 'sent', createdBy: ritika, sentDays: -2, instalments: { count: 2, startDate: addDays(today, 7) } });
      await seedPayment(knex, sp, ritikaProp1, { quote, status: 'link_sent', purpose: 'full', createdBy: ritika, createdAt: at(-2) });
    }
    if (ritikaProp2) {
      // 15% off needs a manager (the default policy): waiting for Kabir.
      await seedQuote(knex, sp, ritikaProp2, { plan: 'SAT-1ON1-24', discount: 2_700_000, status: 'pending_approval', createdBy: ritika });
    }
    if (kabirProp) {
      const quote = await seedQuote(knex, sp, kabirProp, { plan: 'AP-PREP', status: 'sent', createdBy: kabir, sentDays: -1 });
      await seedAgreement(knex, sp, kabirProp, { quote, template: sp.templates.fee, status: 'sent', createdBy: kabir, sentDays: -1 });
    }
    if (b2bWon1) {
      const quote = await seedQuote(knex, sp, b2bWon1, { plan: 'TH-PRO', quantity: 500, status: 'accepted', createdBy: sales, sentDays: -360, priceList: 'software' });
      const sub = await seedSubscription(knex, sp, b2bWon1, { plan: 'TH-PRO', quantity: 500, startDate: addDays(today, -365 + 18), createdBy: sales });
      const payment = await seedPayment(knex, sp, b2bWon1, { quote, subscription: sub, status: 'succeeded', method: 'netbanking', paidAt: at(-346), purpose: 'subscription', createdBy: sales, source: sub.source });
      issued.push({ payment, deal: b2bWon1, setup: sp, date: localDate(at(-346), TZ) });
      await seedAgreement(knex, sp, b2bWon1, { quote, template: sp.templates.software, status: 'signed', createdBy: sales, sentDays: -358 });
    }
    if (b2bWon2) {
      const sub = await seedSubscription(knex, sp, b2bWon2, { plan: 'ERP-BRANCH', quantity: 3, startDate: addDays(today, -40), createdBy: sales, addons: [{ code: 'ERP-ADM', name: 'Campus ERP admissions add-on', quantity: 3, unitPriceMinor: 4_000_000 }] });
      const payment = await seedPayment(knex, sp, b2bWon2, { subscription: sub, status: 'succeeded', method: 'netbanking', paidAt: at(-39), purpose: 'subscription', createdBy: sales, source: sub.source });
      issued.push({ payment, deal: b2bWon2, setup: sp, date: localDate(at(-39), TZ) });
    }
    if (b2bQuote) {
      await seedQuote(knex, sp, b2bQuote, { plan: 'TH-STD', quantity: 800, discount: 1_600_000, status: 'sent', createdBy: sales, sentDays: -4, priceList: 'software', approvedBy: users.get('admin.satnpaper@phoenix.test') ?? owner });
    }
  }

  const pv = setup.pivector;
  if (pv) {
    const [won] = await dealsOf('pivector', 'b2c', 'enrolled');
    const [proposed] = await dealsOf('pivector', 'b2c', 'fee_proposed');
    const pvAdmin = users.get('admin.pivector@phoenix.test');
    if (won) {
      const quote = await seedQuote(knex, pv, won, { plan: 'JEE-DROP', status: 'accepted', createdBy: pvAdmin, sentDays: -25, instalments: { count: 2, startDate: addDays(today, -24) } });
      const plan = await seedInstalmentPlan(knex, quote, { startDate: addDays(today, -24), count: 2 });
      const payment = await seedPayment(knex, pv, won, { quote, instalment: plan.instalments[0], plan, status: 'succeeded', method: 'upi', paidAt: at(-24), createdBy: pvAdmin });
      issued.push({ payment, deal: won, setup: pv, date: localDate(at(-24), TZ) });
    }
    if (proposed) await seedQuote(knex, pv, proposed, { plan: 'JEE-AITS', status: 'sent', createdBy: pvAdmin, sentDays: -3 });
  }
  const ex = setup.excel;
  if (ex) {
    const [won] = await dealsOf('excel', 'b2c', 'enrolled');
    const exAdmin = users.get('admin.excel@phoenix.test') ?? owner;
    if (won) {
      const quote = await seedQuote(knex, ex, won, { plan: 'EX-B10-CBSE', status: 'accepted', createdBy: exAdmin, sentDays: -15 });
      const payment = await seedPayment(knex, ex, won, { quote, status: 'succeeded', method: 'upi', paidAt: at(-14), createdBy: exAdmin });
      issued.push({ payment, deal: won, setup: ex, date: localDate(at(-14), TZ) });
    }
  }

  issued.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const item of issued) {
    const invoice = await seedInvoice(knex, item);
    if (item.refund) await seedRefund(knex, item, invoice);
  }
  console.log(`Billing demo data: ${Object.keys(setup).length} companies, ${issued.length} paid invoices.`);
}

async function seedCompany(knex, { company, spec, products, createdBy }) {
  const gstin = gstinFor(spec.state, spec.pan);
  const [profile] = await knex('billing_profiles')
    .insert({
      company_id: company.id,
      group_id: company.root_id,
      legal_name: spec.legal,
      trade_name: company.name,
      gstin,
      state_code: spec.state,
      pan: spec.pan,
      address: JSON.stringify({ line1: `${company.name} House, 4th floor`, city: spec.city, state: spec.stateName, pincode: spec.pincode, country: 'India' }),
      email: `accounts@${company.code.replace('-', '')}.example.com`,
      phone: '+91 22 4000 1000',
      lut_number: company.code === 'satnpaper' ? 'AD270326012345X' : null,
      lut_valid_until: company.code === 'satnpaper' ? '2027-03-31' : null,
      invoice_notes: 'Thank you. This is a computer-generated invoice.',
      bank_details: JSON.stringify({ accountName: spec.legal, accountNumber: 'XXXXXXXX4321', ifsc: 'HDFC0000060', bank: 'HDFC Bank' }),
      updated_by: createdBy,
    })
    .returning('*');
  const series = {};
  for (const documentType of ['invoice', 'credit_note']) {
    const described = describeSeries({ documentType, prefix: spec.prefix, fyStyle: 'compact', padding: 5, gstin });
    const [row] = await knex('billing_number_series')
      .insert({ group_id: company.root_id, company_id: company.id, gstin, document_type: documentType, prefix: spec.prefix, format: described.series.format, fy_style: 'compact', padding: 5, is_default: true, created_by: createdBy })
      .returning('*');
    series[documentType] = row;
  }

  const plans = new Map();
  let position = 0;
  for (const product of products) {
    const software = product.line_kind.startsWith('software');
    const billing = product.attributes?.billing ?? null;
    const unit = billing === 'per_student_year' ? 'student' : billing === 'per_branch_year' ? 'branch' : 'flat';
    const [plan] = await knex('billing_plans')
      .insert({
        group_id: company.root_id,
        company_id: company.id,
        product_id: product.id,
        code: product.code,
        name: product.name,
        kind: software ? 'recurring' : 'one_time',
        audience: software ? 'b2b' : 'b2c',
        unit,
        interval: software ? 'year' : null,
        sac: software ? SOFTWARE_SAC : B2C_SAC,
        tax_rate_bp: 1800,
        taxability: 'taxable',
        position: position++,
        created_by: createdBy,
      })
      .returning('*');
    plans.set(product.code, { plan, fee: product.fee ?? null, software });
  }
  // Fees come from the CRM seed's indicative fees (the seed stored them on the deal values only).
  const fees = await knex('deals').whereIn('product_id', products.map((p) => p.id)).groupBy('product_id').select('product_id').max({ fee: 'value_minor' });
  const feeOf = (product) => Number(fees.find((f) => f.product_id === product.id)?.fee ?? 0) || null;
  const lists = {};
  const [feesList] = await knex('billing_price_lists').insert({ group_id: company.root_id, company_id: company.id, name: 'Fees (INR, incl. GST)', currency: 'INR', prices_include_tax: true, is_default: true, created_by: createdBy }).returning('*');
  const [softwareList] = await knex('billing_price_lists').insert({ group_id: company.root_id, company_id: company.id, name: 'Software (INR, plus GST)', currency: 'INR', prices_include_tax: false, is_default: false, created_by: createdBy }).returning('*');
  lists.fees = feesList;
  lists.software = softwareList;
  const prices = [];
  for (const product of products) {
    const entry = plans.get(product.code);
    const amount = DEFAULT_PRICES[product.code] ?? feeOf(product);
    if (!amount) continue;
    prices.push({ price_list_id: entry.software ? softwareList.id : feesList.id, plan_id: entry.plan.id, company_id: company.id, unit_amount_minor: amount });
  }
  if (company.code === 'satnpaper') {
    const [usd] = await knex('billing_price_lists').insert({ group_id: company.root_id, company_id: company.id, name: 'International families (USD)', currency: 'USD', prices_include_tax: false, is_default: true, created_by: createdBy }).returning('*');
    lists.usd = usd;
    for (const [code, amount] of Object.entries({ 'SAT-GB-WKND': 69_900, 'SAT-1ON1-24': 229_900, 'SAT-1ON1-12': 119_900, 'SAT-USADM': 449_900 })) {
      const entry = plans.get(code);
      if (entry) prices.push({ price_list_id: usd.id, plan_id: entry.plan.id, company_id: company.id, unit_amount_minor: amount });
    }
  }
  if (prices.length) await knex('billing_prices').insert(prices);

  const accounts = {};
  [accounts.razorpay] = await knex('billing_payment_accounts')
    .insert({ group_id: company.root_id, company_id: company.id, provider: 'razorpay', label: `${company.name} Razorpay (test)`, scope: 'domestic', mode: 'test', account_ref: null, created_by: createdBy })
    .returning('*');
  if (company.code === 'satnpaper') {
    [accounts.stripe] = await knex('billing_payment_accounts')
      .insert({ group_id: company.root_id, company_id: company.id, provider: 'stripe', label: 'SatnPaper Stripe India exports (test)', scope: 'international', mode: 'test', entity_country: 'IN', india_exports: true, purpose_code: 'P1107', created_by: createdBy })
      .returning('*');
  }

  const templates = {};
  [templates.fee] = await knex('agreement_templates')
    .insert({ group_id: company.root_id, company_id: company.id, key: 'fee_agreement', name: 'Fee agreement', audience: 'b2c', body: FEE_TEMPLATE, sign_type: 'aadhaar', expires_in_days: 10, created_by: createdBy })
    .returning('*');
  if (products.some((p) => p.line_kind.startsWith('software'))) {
    [templates.software] = await knex('agreement_templates')
      .insert({ group_id: company.root_id, company_id: company.id, key: 'software_subscription', name: 'Software subscription agreement', audience: 'b2b', body: SOFTWARE_TEMPLATE, sign_type: 'electronic', expires_in_days: 15, created_by: createdBy })
      .returning('*');
  }
  return { company, spec, profile, series, plans, lists, accounts, templates };
}

/** Indicative prices (minor units) where the CRM seed's deal values don't give one. */
const DEFAULT_PRICES = {
  'SAT-GB-WKND': 5_500_000,
  'SAT-GB-EVE': 4_800_000,
  'SAT-1ON1-24': 18_000_000,
  'SAT-1ON1-12': 9_500_000,
  'SAT-CRASH-4W': 1_800_000,
  'SAT-TS-10': 600_000,
  'SAT-USADM': 35_000_000,
  'AP-PREP': 7_500_000,
  'TH-STD': 40_000,
  'TH-PRO': 65_000,
  'ERP-BRANCH': 12_000_000,
  'ERP-ADM': 4_000_000,
  'JEE-DROP': 16_000_000,
  'JEE-AITS': 800_000,
  'EX-B10-CBSE': 5_500_000,
};

async function nextNumber(knex, companyId, name) {
  const { rows } = await knex.raw(
    `insert into crm_sequences (company_id, name, value) values (?, ?, 1)
     on conflict (company_id, name) do update set value = crm_sequences.value + 1 returning value`,
    [companyId, `billing.${name}`],
  );
  return Number(rows[0].value);
}

async function recipientOf(knex, deal) {
  if (deal.account_id) {
    const a = await knex('accounts').where({ id: deal.account_id }).first('name', 'legal_name');
    return { name: a?.legal_name || a?.name || null };
  }
  const c = deal.primary_contact_id ? await knex('contacts').where({ id: deal.primary_contact_id }).first('display_name') : null;
  return { name: c?.display_name ?? null };
}

async function seedQuote(knex, setup, deal, { plan: code, quantity = 1, discount = 0, status, createdBy, sentDays = null, instalments = null, approvedBy = null, priceList = 'fees' }) {
  const entry = setup.plans.get(code);
  if (!entry) return null;
  const list = setup.lists[priceList];
  const price = await knex('billing_prices').where({ price_list_id: list.id, plan_id: entry.plan.id }).first();
  const lines = [
    {
      id: randomUUID(),
      planId: entry.plan.id,
      description: entry.plan.name,
      sac: entry.plan.sac,
      quantity,
      unitPriceMinor: Number(price.unit_amount_minor),
      discountMinor: discount,
      taxRateBp: entry.plan.tax_rate_bp,
      taxability: entry.plan.taxability,
    },
  ];
  const recipient = await recipientOf(knex, deal);
  const onDate = localDate(Date.now(), TZ);
  const priced = priceQuote({ lines, pricesIncludeTax: list.prices_include_tax, supplier: supplierFrom(setup.profile), recipient, currency: list.currency, onDate });
  const number = await nextNumber(knex, setup.company.id, 'quote');
  const kind = deal.kind === 'b2c' ? 'fee_proposal' : 'quote';
  const percentBp = discount ? Math.round((discount * 10_000) / priced.subtotalMinor) : 0;
  const needsApproval = percentBp > 500 || discount > 500_000;
  const sentAt = sentDays !== null ? new Date(Date.now() + sentDays * DAY) : null;
  const [quote] = await knex('quotes')
    .insert({
      group_id: deal.group_id,
      company_id: deal.company_id,
      deal_id: deal.id,
      number,
      ref: `${setup.spec.prefix}-${kind === 'fee_proposal' ? 'FP' : 'Q'}-${String(number).padStart(4, '0')}`,
      kind,
      status,
      title: `${kind === 'fee_proposal' ? 'Fee proposal' : 'Quote'}: ${entry.plan.name}`,
      price_list_id: list.id,
      currency: list.currency,
      prices_include_tax: list.prices_include_tax,
      lines: JSON.stringify(lines),
      recipient: JSON.stringify(recipient),
      place_of_supply_state_code: priced.result.placeOfSupplyStateCode,
      subtotal_minor: priced.subtotalMinor,
      discount_minor: priced.discountMinor,
      taxable_minor: priced.taxableMinor,
      tax_minor: priced.taxMinor,
      total_minor: priced.totalMinor,
      tax_summary: JSON.stringify(taxSummary(priced.result)),
      discount_status: !discount ? 'none' : status === 'pending_approval' ? 'needs_approval' : needsApproval ? 'approved' : 'allowed',
      discount_decision: discount
        ? JSON.stringify({ decision: needsApproval ? 'needs_approval' : 'allowed', percentBp, tierIndex: needsApproval ? 1 : 0, tierLabel: needsApproval ? 'Manager' : 'Anyone', approverRoles: needsApproval ? ['manager', 'company_admin'] : [], selfApproved: false, reason: needsApproval ? 'Needs approval by manager or company_admin' : 'Within the free tier' })
        : null,
      discount_requested_by: discount ? createdBy : null,
      discount_reviewed_by: discount && approvedBy ? approvedBy : null,
      discount_reviewed_at: discount && approvedBy ? sentAt : null,
      instalment_option: instalments ? JSON.stringify({ count: instalments.count, frequency: 'monthly', startDate: instalments.startDate }) : null,
      valid_until: addDays(sentAt ? localDate(sentAt, TZ) : onDate, 14),
      sent_at: sentAt,
      accepted_at: status === 'accepted' && sentAt ? new Date(sentAt.getTime() + DAY) : null,
      created_by: createdBy,
      created_at: sentAt ? new Date(sentAt.getTime() - 3_600_000) : new Date(),
      updated_at: new Date(),
    })
    .returning('*');
  return quote;
}

async function seedInstalmentPlan(knex, quote, { startDate, count, firstAmountMinor = undefined }) {
  const option = { count, frequency: 'monthly', startDate, ...(firstAmountMinor ? { firstAmountMinor } : {}) };
  const split = splitInstalments({ totalMinor: Number(quote.total_minor), count, schedule: { frequency: 'monthly', startDate }, ...(firstAmountMinor ? { firstAmountMinor } : {}) });
  await knex('quotes').where({ id: quote.id }).update({ instalment_option: JSON.stringify(option) });
  const [plan] = await knex('instalment_plans')
    .insert({ group_id: quote.group_id, company_id: quote.company_id, deal_id: quote.deal_id, quote_id: quote.id, currency: quote.currency, total_minor: quote.total_minor, count: split.instalments.length, schedule: JSON.stringify(option), created_by: quote.created_by })
    .returning('*');
  const instalments = await knex('instalments')
    .insert(split.instalments.map((i) => ({ plan_id: plan.id, group_id: quote.group_id, company_id: quote.company_id, deal_id: quote.deal_id, number: i.number, due_date: i.dueDate, amount_minor: i.amountMinor, currency: quote.currency })))
    .returning('*');
  return { ...plan, instalments: instalments.sort((a, b) => a.number - b.number) };
}

function quoteSource(quote, label = null) {
  const lines = quote.lines;
  return {
    lines,
    pricesIncludeTax: quote.prices_include_tax,
    recipient: quote.recipient ?? {},
    label,
    pricedTotals: lines.map((l) => quote.tax_summary.lines.find((t) => t.id === l.id)?.totalMinor ?? 0),
    totalMinor: Number(quote.total_minor),
  };
}

async function seedPayment(knex, setup, deal, { quote = null, instalment = null, plan = null, subscription = null, status, method = null, provider = 'razorpay', paidAt = null, createdBy, createdAt = null, failure = null, purpose = null, reference = null, source = null }) {
  const amount = instalment ? Number(instalment.amount_minor) : subscription ? subscription.totalMinor : Number(quote.total_minor);
  const id = randomUUID();
  const label = instalment ? `Instalment ${instalment.number} of ${plan.instalments.length}` : null;
  const account = provider === 'manual' ? null : setup.accounts.razorpay;
  const linkId = provider === 'manual' ? null : `plink_seed${id.replace(/-/g, '').slice(0, 14)}`;
  const created = createdAt ?? (paidAt ? new Date(paidAt.getTime() - 3_600_000) : new Date());
  const [payment] = await knex('payments')
    .insert({
      id,
      group_id: deal.group_id,
      company_id: deal.company_id,
      deal_id: deal.id,
      quote_id: quote?.id ?? null,
      instalment_id: instalment?.id ?? null,
      subscription_id: subscription?.id ?? null,
      purpose: purpose ?? (instalment ? 'instalment' : 'full'),
      provider,
      account_id: account?.id ?? null,
      status,
      amount_minor: amount,
      currency: quote?.currency ?? subscription?.currency ?? 'INR',
      method: status === 'succeeded' ? method : null,
      description: `${quote?.title ?? subscription?.description ?? 'Payment'}${label ? ` – ${label}` : ''}`.slice(0, 250),
      provider_link_id: linkId,
      provider_payment_id: status === 'succeeded' ? (reference ?? `pay_seed${id.replace(/-/g, '').slice(0, 14)}`) : null,
      link_url: linkId ? `https://pay.example.test/razorpay/${linkId}` : null,
      expires_at: linkId ? new Date(created.getTime() + 15 * DAY) : null,
      paid_at: status === 'succeeded' ? paidAt : null,
      failed_at: status === 'failed' ? new Date(created.getTime() + 2 * 3_600_000) : null,
      failure: failure ? JSON.stringify(failure) : null,
      fee_minor: status === 'succeeded' && provider !== 'manual' ? Math.round(amount * 0.0236) : null,
      idempotency_key: provider === 'manual' && reference ? `manual:${reference}` : null,
      invoice_source: JSON.stringify(source ?? quoteSource(quote, label)),
      created_by: createdBy,
      created_at: created,
      updated_at: paidAt ?? created,
    })
    .returning('*');
  if (status === 'succeeded' && instalment) {
    await knex('instalments').where({ id: instalment.id }).update({ status: 'paid', paid_minor: instalment.amount_minor, paid_at: paidAt });
  }
  return payment;
}

async function seedInvoice(knex, { payment, deal, setup, date }) {
  const source = payment.invoice_source;
  const lines =
    Number(payment.amount_minor) === source.totalMinor
      ? { lines: source.lines, pricesIncludeTax: source.pricesIncludeTax }
      : invoiceLinesForAmount({ ...source, amountMinor: Number(payment.amount_minor) });
  const taxInput = taxInputFor({ ...lines, supplier: supplierFrom(setup.profile), recipient: source.recipient, currency: payment.currency, onDate: date });
  const result = computeTax(taxInput);
  const allocated = await allocateNumber(knex, setup.series.invoice, date, TZ);
  const totals = result.totals;
  const [invoice] = await knex('invoices')
    .insert({
      group_id: payment.group_id,
      company_id: payment.company_id,
      deal_id: deal.id,
      payment_id: payment.id,
      subscription_id: payment.subscription_id,
      series_id: setup.series.invoice.id,
      supplier_gstin: setup.series.invoice.gstin,
      series_document_type: 'invoice',
      fy_start_year: allocated.fyStartYear,
      sequence: allocated.sequence,
      number: allocated.number,
      document_type: result.documentType,
      issue_date: date,
      supplier: JSON.stringify(supplierFrom(setup.profile)),
      recipient: JSON.stringify(source.recipient ?? {}),
      place_of_supply_state_code: result.placeOfSupplyStateCode,
      supply_type: result.supplyType,
      tax_kind: result.taxKind,
      currency: payment.currency,
      lines: JSON.stringify(result.lines.map(presentTaxLine)),
      tax_input: JSON.stringify(taxInput),
      totals: JSON.stringify(totals),
      sac_summary: JSON.stringify(result.sacSummary ?? []),
      taxable_minor: totals.taxableValueMinor,
      cgst_minor: totals.cgstMinor,
      sgst_minor: totals.sgstMinor,
      igst_minor: totals.igstMinor,
      tax_minor: totals.taxMinor,
      round_off_minor: totals.roundOffMinor,
      total_minor: totals.grandTotalMinor,
      amount_in_words: amountInWords(totals.grandTotalMinor, { currency: payment.currency }),
      endorsement: result.endorsement ?? null,
      notes: setup.profile.invoice_notes,
      created_by: payment.created_by,
      created_at: payment.paid_at,
      updated_at: payment.paid_at,
    })
    .returning('*');
  await knex('payments').where({ id: payment.id }).update({ invoice_id: invoice.id });
  return invoice;
}

async function seedRefund(knex, { payment, deal, setup, refund }, invoice) {
  const number = await nextNumber(knex, setup.company.id, 'refund');
  const id = randomUUID();
  await knex('refunds').insert({
    id,
    group_id: payment.group_id,
    company_id: payment.company_id,
    deal_id: deal.id,
    payment_id: payment.id,
    invoice_id: invoice.id,
    number,
    ref: `${setup.spec.prefix}-RF-${String(number).padStart(4, '0')}`,
    amount_minor: refund.amountMinor,
    currency: payment.currency,
    reason: refund.reason,
    note: refund.note,
    status: 'requested',
    requested_by: refund.requestedBy,
    requested_at: new Date(Date.now() - 2 * DAY),
    provider: payment.provider,
    idempotency_key: `refund:${id}`,
  });
}

async function seedAgreement(knex, setup, deal, { quote, template, status, createdBy, sentDays }) {
  if (!template) return;
  const number = await nextNumber(knex, setup.company.id, 'agreement');
  const recipient = await recipientOf(knex, deal);
  const signerName = recipient.name ?? 'Customer';
  const contact = deal.primary_contact_id ? await knex('contacts').where({ id: deal.primary_contact_id }).first('primary_email', 'primary_phone') : null;
  const identifier = contact?.primary_email ?? (contact?.primary_phone ? contact.primary_phone.replace(/^\+91/, '') : `signer${number}@example.com`);
  const sentAt = new Date(Date.now() + sentDays * DAY);
  const signed = status === 'signed';
  const ref = `${setup.spec.prefix}-AG-${String(number).padStart(4, '0')}`;
  const body = template.body
    .replace(/\{\{date\}\}/g, localDate(sentAt, TZ))
    .replace(/\{\{company\.name\}\}/g, setup.profile.legal_name)
    .replace(/\{\{company\.gstin\}\}/g, setup.profile.gstin)
    .replace(/\{\{customer\.name\}\}/g, signerName)
    .replace(/\{\{deal\.ref\}\}/g, deal.ref)
    .replace(/\{\{quote\.title\}\}/g, quote.title)
    .replace(/\{\{quote\.total\}\}/g, `Rs. ${(Number(quote.total_minor) / 100).toLocaleString('en-IN')}`)
    .replace(/\{\{quote\.lines\}\}/g, quote.lines.map((l) => `- ${l.description} x ${l.quantity}`).join('\n'))
    .replace(/\{\{signers\}\}/g, `${signerName} (${deal.kind === 'b2c' ? 'parent' : 'signatory'})`)
    .replace(/\{\{[^}]+\}\}/g, '');
  await knex('agreements').insert({
    group_id: deal.group_id,
    company_id: deal.company_id,
    deal_id: deal.id,
    quote_id: quote.id,
    template_id: template.id,
    number,
    ref,
    title: `${template.name}: ${deal.title}`.slice(0, 200),
    status,
    body,
    signers: JSON.stringify([{ name: signerName, identifier, role: deal.kind === 'b2c' ? 'parent' : 'signatory', order: 1, signType: template.sign_type, status: signed ? 'signed' : 'pending', signedAt: signed ? new Date(sentAt.getTime() + DAY).toISOString() : null }]),
    sign_type: template.sign_type,
    expires_in_days: template.expires_in_days,
    provider: 'digio',
    provider_document_id: `DIDseed${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    sent_at: sentAt,
    expires_at: new Date(sentAt.getTime() + template.expires_in_days * DAY),
    signed_at: signed ? new Date(sentAt.getTime() + DAY) : null,
    created_by: createdBy,
    created_at: new Date(sentAt.getTime() - 600_000),
    updated_at: signed ? new Date(sentAt.getTime() + DAY) : sentAt,
  });
}

async function seedSubscription(knex, setup, deal, { plan: code, quantity, startDate, createdBy, addons = [] }) {
  const entry = setup.plans.get(code);
  if (!entry) return null;
  const price = await knex('billing_prices').where({ price_list_id: setup.lists.software.id, plan_id: entry.plan.id }).first();
  const row = {
    group_id: deal.group_id,
    company_id: deal.company_id,
    deal_id: deal.id,
    account_id: deal.account_id ?? null,
    plan_id: entry.plan.id,
    status: 'active',
    quantity,
    unit: entry.plan.unit,
    interval: entry.plan.interval,
    unit_price_minor: Number(price.unit_amount_minor),
    currency: 'INR',
    prices_include_tax: false,
    addons: JSON.stringify(addons),
    start_date: startDate,
    current_period_start: startDate,
    current_period_end: termEndFor(startDate, entry.plan.interval, 1),
    created_by: createdBy,
    created_at: new Date(`${startDate}T06:00:00Z`),
  };
  const [sub] = await knex('subscriptions').insert(row).returning('*');
  const lines = subscriptionLines(sub, entry.plan);
  const recipient = await recipientOf(knex, deal);
  const result = computeTax(taxInputFor({ lines, pricesIncludeTax: false, supplier: supplierFrom(setup.profile), recipient, currency: 'INR', onDate: startDate }));
  return {
    ...sub,
    totalMinor: result.totals.grandTotalMinor,
    description: `${entry.plan.name}, first term (${sub.current_period_start} to ${sub.current_period_end})`,
    source: { lines, pricesIncludeTax: false, recipient, label: null, pricedTotals: result.lines.map((l) => l.totalMinor), totalMinor: result.totals.grandTotalMinor },
  };
}

