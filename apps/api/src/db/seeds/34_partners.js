import { env } from '../../config/env.js';
import { json } from '../../lib/db.js';
import { hashPassword } from '../../lib/crypto.js';
import { createRegistry } from '../../core/registry.js';
import { syncSystemRoles, systemRolePermissions } from '../../core/systemRoles.js';
import { normalizeName } from '../../core/crm/normalize.js';
import { modules } from '../../modules/index.js';
import { syncDealAttributions } from '../../modules/partners/attributions.js';
import { accrueCommission, clawbackCommissions } from '../../modules/partners/commissions.js';
import { PARTNER_ROLE } from '../../modules/partners/constants.js';
import { payoutHint, sealPayoutDetails } from '../../modules/partners/payoutDetails.js';
import { buildPayoutLines } from '../../modules/partners/rules.js';

// Phase 10 demo data: four brokers and referral partners working with SatnPaper, Pi Vector and
// Excel, their referral links, commission plans, attributions of the seeded partner-referral leads
// (02_crm.js puts the partner codes in deals.first_touch.partnerId), commissions from simulated
// payments, one clawback, one paid and one draft payout, and a portal sign-in for EduPath Advisors
// (partner.edupath@phoenix.test). Idempotent: run it again and nothing is added twice.

const GROUP_CODE = 'phoenix';
const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const PORTAL_EMAIL = 'partner.edupath@phoenix.test';

const PARTNERS = [
  {
    code: 'edupath-advisors',
    kind: 'organisation',
    name: 'EduPath Advisors',
    legalName: 'EduPath Advisors LLP',
    email: 'hello@edupath.example',
    phone: '+919820012345',
    city: 'Pune',
    payout: { method: 'bank_transfer', accountName: 'EduPath Advisors LLP', accountNumber: '50200012344321', ifsc: 'HDFC0001234', bankName: 'HDFC Bank', pan: 'AAKFE1234C' },
    companies: [
      { company: 'satnpaper', unit: 'sat-admissions', owner: 'ritika@phoenix.test', plan: null },
      { company: 'pivector', unit: 'admissions', owner: null, plan: null },
    ],
  },
  {
    code: 'campus-connect',
    kind: 'organisation',
    name: 'Campus Connect',
    email: 'team@campusconnect.example',
    phone: '+919811122233',
    city: 'Delhi',
    payout: { method: 'upi', accountName: 'Campus Connect', upiId: 'campusconnect@okicici' },
    companies: [{ company: 'satnpaper', unit: 'online', owner: 'kabir@phoenix.test', plan: null }],
  },
  {
    code: 'bright-future-consultants',
    kind: 'organisation',
    name: 'Bright Future Consultants',
    email: 'admissions@brightfuture.example',
    phone: '+919845098450',
    city: 'Mumbai',
    payout: { method: 'bank_transfer', accountName: 'Bright Future Consultants', accountNumber: '001234567890', ifsc: 'ICIC0000123', bankName: 'ICICI Bank' },
    companies: [
      { company: 'satnpaper', unit: 'sat-admissions', owner: 'kabir@phoenix.test', plan: null },
      { company: 'pivector', unit: 'admissions', owner: null, plan: null },
      { company: 'excel', unit: 'admissions', owner: null, plan: null },
    ],
  },
  {
    code: 'meera-iyer',
    kind: 'person',
    name: 'Meera Iyer',
    email: 'meera.iyer@example.com',
    phone: '+919900011122',
    city: 'Bengaluru',
    payout: null,
    status: 'pending',
    companies: [{ company: 'satnpaper', unit: 'sat-admissions', owner: 'ritika@phoenix.test', plan: null }],
  },
];

const COMPANIES = {
  satnpaper: { code: 'satnpaper', prefix: 'SP', landing: 'https://satnpaper.example/enquire' },
  pivector: { code: 'pi-vector', prefix: 'PV', landing: 'https://pivector.example/enquire' },
  excel: { code: 'excel', prefix: 'EX', landing: 'https://excel.example/enquire' },
};

const PLANS = [
  { company: 'satnpaper', name: 'Standard referral', description: '10% of the course fee on the first payment, up to ₹25,000.', basis: 'percent', rate_bps: 1000, trigger: 'first_payment', clawback_days: 30, cap_minor: 2_500_000, currency: 'INR', position: 0 },
  { company: 'satnpaper', productLine: 'us_admissions', name: 'US admissions programmes', description: '₹15,000 when the programme fee is fully paid.', basis: 'fixed', fixed_minor: 1_500_000, currency: 'INR', trigger: 'full_payment', clawback_days: 60, position: 1 },
  { company: 'satnpaper', productLine: 'campus_erp', name: 'Campus ERP referral', description: '8% of the first-year licence.', basis: 'percent', rate_bps: 800, trigger: 'first_payment', clawback_days: 45, position: 2 },
  { company: 'pivector', name: 'Standard referral', description: '7.5% of the course fee on the first payment.', basis: 'percent', rate_bps: 750, trigger: 'first_payment', clawback_days: 30, position: 0 },
  { company: 'excel', name: 'Flat fee per enrolment', description: '₹2,000 for each enrolled student.', basis: 'fixed', fixed_minor: 200_000, currency: 'INR', trigger: 'first_payment', clawback_days: 15, position: 0 },
];

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('Partner demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  const units = await knex('org_units').where({ root_id: group.id });
  const company = (key) => units.find((u) => u.type === 'company' && u.code === COMPANIES[key].code);
  const unitIn = (key, code) => {
    const c = company(key);
    return units.find((u) => u.code === code && u.path.startsWith(c.path) && u.id !== c.id) ?? c;
  };
  if (!company('satnpaper') || !(await knex('pipelines').where({ group_id: group.id }).first())) {
    console.log('Partner demo data needs the CRM demo data (02_crm.js).');
    return;
  }

  // Built-in roles gain the partners grants; the partner role is created here until
  // core/systemRoles.js lists it.
  const registry = createRegistry(modules);
  await syncSystemRoles(knex, registry);
  let role = await knex('roles').whereNull('group_id').where({ key: PARTNER_ROLE.key }).first();
  const rolePermissions = systemRolePermissions(registry, PARTNER_ROLE.key);
  if (!role) {
    [role] = await knex('roles')
      .insert({ key: PARTNER_ROLE.key, name: PARTNER_ROLE.name, description: PARTNER_ROLE.description, permissions: rolePermissions, is_system: true, group_id: null })
      .returning('*');
  } else {
    await knex('roles').where({ id: role.id }).update({ permissions: rolePermissions, updated_at: knex.fn.now() });
  }

  const users = new Map((await knex('users').select('id', 'email', 'name')).map((u) => [u.email, u]));
  const owner = users.get('owner@phoenix.test');

  // ----- Settings -----
  for (const [key, setup] of Object.entries(COMPANIES)) {
    const c = company(key);
    if (!c) continue;
    await knex('settings').insert({ org_unit_id: c.id, key: 'partners.defaultLandingUrl', value: json(setup.landing) }).onConflict(['org_unit_id', 'key']).ignore();
  }

  // ----- Commission plans -----
  const plans = new Map();
  for (const plan of PLANS) {
    const c = company(plan.company);
    if (!c) continue;
    let row = await knex('commission_plans').where({ company_id: c.id, name: plan.name }).first();
    if (!row) {
      const line = plan.productLine ? await knex('product_lines').where({ company_id: c.id, key: plan.productLine }).first('id') : null;
      [row] = await knex('commission_plans')
        .insert({
          group_id: group.id,
          company_id: c.id,
          product_line_id: line?.id ?? null,
          name: plan.name,
          description: plan.description,
          basis: plan.basis,
          rate_bps: plan.rate_bps ?? null,
          fixed_minor: plan.fixed_minor ?? null,
          currency: plan.currency ?? null,
          trigger: plan.trigger,
          clawback_days: plan.clawback_days,
          cap_minor: plan.cap_minor ?? null,
          position: plan.position,
          created_by: owner?.id ?? null,
        })
        .returning('*');
    }
    plans.set(`${plan.company}:${plan.name}`, row);
  }

  // ----- Partners, partnerships, referral links -----
  let addedPartners = 0;
  for (const spec of PARTNERS) {
    let partner = await knex('partners').where({ group_id: group.id, code: spec.code }).first();
    if (!partner) {
      [partner] = await knex('partners')
        .insert({
          group_id: group.id,
          code: spec.code,
          kind: spec.kind,
          name: spec.name,
          name_normalized: normalizeName(spec.name),
          legal_name: spec.legalName ?? null,
          email: spec.email,
          phone: spec.phone,
          city: spec.city,
          payout_method: spec.payout?.method ?? null,
          payout_details_enc: spec.payout ? sealPayoutDetails(spec.payout) : null,
          payout_hint: json(payoutHint(spec.payout)),
          payout_details_updated_at: spec.payout ? daysAgo(60) : null,
          created_by: owner?.id ?? null,
          created_at: daysAgo(90),
          updated_at: daysAgo(90),
        })
        .returning('*');
      addedPartners += 1;
    }
    for (const link of spec.companies) {
      const c = company(link.company);
      if (!c) continue;
      const unit = unitIn(link.company, link.unit);
      await knex('partner_companies')
        .insert({
          partner_id: partner.id,
          group_id: group.id,
          company_id: c.id,
          unit_id: unit.id,
          owner_user_id: link.owner ? (users.get(link.owner)?.id ?? null) : null,
          status: spec.status ?? 'active',
          joined_at: daysAgo(90),
          created_by: owner?.id ?? null,
        })
        .onConflict(['partner_id', 'company_id'])
        .ignore();
      const prefix = COMPANIES[link.company].prefix;
      const slug = spec.code.split('-')[0].toUpperCase();
      const links = [
        { code: `${prefix}-${slug}`, label: 'Main link', productLine: null, campaign: spec.code },
        ...(link.company === 'satnpaper' && spec.code === 'edupath-advisors'
          ? [{ code: `${prefix}-${slug}-US`, label: 'US admissions seminar', productLine: 'us_admissions', campaign: 'us-seminar-nov' }]
          : []),
      ];
      for (const l of links) {
        const line = l.productLine ? await knex('product_lines').where({ company_id: c.id, key: l.productLine }).first('id') : null;
        await knex('partner_referral_links')
          .insert({
            group_id: group.id,
            company_id: c.id,
            partner_id: partner.id,
            product_line_id: line?.id ?? null,
            code: l.code,
            label: l.label,
            utm: json({ source: 'partner', medium: 'referral', campaign: l.campaign }),
            active: spec.status !== 'pending',
            created_by: owner?.id ?? null,
            created_at: daysAgo(80),
            updated_at: daysAgo(80),
          })
          .onConflict(['code'])
          .ignore();
      }
    }
  }

  // ----- Portal sign-in for EduPath Advisors -----
  const edupath = await knex('partners').where({ group_id: group.id, code: 'edupath-advisors' }).first();
  let portalUser = users.get(PORTAL_EMAIL);
  if (!portalUser) {
    [portalUser] = await knex('users')
      .insert({ email: PORTAL_EMAIL, name: 'Anil Deshpande', status: 'active', password_hash: await hashPassword(env.SEED_PASSWORD) })
      .returning(['id', 'email', 'name']);
    console.log(`Added ${PORTAL_EMAIL} (partner portal, EduPath Advisors).`);
  }
  if (!edupath.user_id) await knex('partners').where({ id: edupath.id }).update({ user_id: portalUser.id });
  for (const link of await knex('partner_companies').where({ partner_id: edupath.id })) {
    await knex('role_assignments').insert({ user_id: portalUser.id, role_id: role.id, org_unit_id: link.unit_id }).onConflict(['user_id', 'role_id', 'org_unit_id']).ignore();
  }

  // ----- Attributions of the seeded partner leads -----
  const referred = await knex('deals')
    .where({ group_id: group.id })
    .where((w) => w.whereRaw("first_touch->>'partnerId' is not null").orWhereRaw("last_touch->>'partnerId' is not null"))
    .orderBy('created_at')
    .select('id', 'ref', 'status', 'value_minor', 'currency', 'company_id', 'product_line_id', 'created_at');
  let attributed = 0;
  for (const deal of referred) {
    const result = await knex.transaction((trx) => syncDealAttributions(trx, deal.id));
    attributed += result.created;
  }

  // ----- Commissions from simulated payments (the money module sends payment.succeeded later) -----
  let accrued = 0;
  for (const deal of referred) {
    const value = Number(deal.value_minor);
    if (!(value > 0)) continue;
    const won = deal.status === 'won';
    const payload = {
      paymentId: `seed-pay-${deal.ref}`,
      companyId: deal.company_id,
      dealId: deal.id,
      amountMinor: won ? value : Math.round(value * 0.3),
      currency: deal.currency ?? 'INR',
      paidAt: (won ? daysAgo(40) : daysAgo(5)).toISOString(),
      isFirstPayment: true,
      fullyPaid: won,
      totalMinor: value,
      paidTotalMinor: won ? value : Math.round(value * 0.3),
    };
    const result = await knex.transaction((trx) => accrueCommission(trx, payload, { eventId: `seed:${deal.ref}` }));
    if (result.status === 'accrued') accrued += 1;
  }

  // A family asked for half its deposit back: claw back half of one open lead's commission.
  const openCommission = await knex('partner_commissions as c')
    .join('deals as d', 'd.id', 'c.deal_id')
    .where('c.group_id', group.id)
    .where('d.status', 'open')
    .orderBy('c.amount_minor', 'desc')
    .first('c.id', 'c.payment_id', 'c.base_minor', 'c.base_currency', 'c.company_id');
  if (openCommission) {
    const payment = await knex('partner_commissions').where({ id: openCommission.id }).first('payment_id');
    await knex.transaction((trx) =>
      clawbackCommissions(trx, {
        refundId: `seed-refund-${payment.payment_id}`,
        paymentId: payment.payment_id,
        companyId: openCommission.company_id,
        amountMinor: Math.round(Number(openCommission.base_minor) * 0.15),
        currency: openCommission.base_currency,
        processedAt: daysAgo(2).toISOString(),
      }),
    );
  }

  // ----- Approvals and payouts (SatnPaper) -----
  const satnpaper = company('satnpaper');
  const approver = users.get('admin.satnpaper@phoenix.test');
  const finance = users.get('finance@phoenix.test');
  const wonCommissions = await knex('partner_commissions as c')
    .join('deals as d', 'd.id', 'c.deal_id')
    .where({ 'c.company_id': satnpaper.id, 'd.status': 'won', 'c.status': 'pending' })
    .whereNull('c.payout_id')
    .orderBy('c.earned_at')
    .select('c.*');
  if (wonCommissions.length && !(await knex('partner_payouts').where({ company_id: satnpaper.id }).first('id'))) {
    await knex('partner_commissions')
      .whereIn(
        'id',
        wonCommissions.map((c) => c.id),
      )
      .update({ status: 'approved', approved_by: approver?.id ?? null, approved_at: daysAgo(12) });
    const [first, ...rest] = wonCommissions;
    let number = 0;
    const makePayout = async (commissions, { status, periodStart, periodEnd, createdAt }) => {
      const { lines } = buildPayoutLines(commissions, []);
      if (!lines.length) return;
      number += 1;
      const total = lines.reduce((s, l) => s + l.netMinor, 0);
      const paid = status === 'paid';
      const [payout] = await knex('partner_payouts')
        .insert({
          group_id: group.id,
          company_id: satnpaper.id,
          number,
          ref: `SP-PO-${number}`,
          period_start: periodStart,
          period_end: periodEnd,
          currency: 'INR',
          status,
          commission_minor: total,
          deduction_minor: 0,
          total_minor: total,
          line_count: lines.length,
          reference: paid ? 'HDFC-NEFT-B20261101-0042' : null,
          created_by: finance?.id ?? null,
          created_at: createdAt,
          updated_at: createdAt,
          approved_by: paid ? (approver?.id ?? null) : null,
          approved_at: paid ? daysAgo(6) : null,
          paid_by: paid ? (finance?.id ?? null) : null,
          paid_at: paid ? daysAgo(5) : null,
        })
        .returning('*');
      const hints = new Map((await knex('partners').whereIn('id', lines.map((l) => l.partnerId)).select('id', 'payout_hint')).map((p) => [p.id, p.payout_hint]));
      for (const line of lines) {
        await knex('partner_payout_lines').insert({
          payout_id: payout.id,
          partner_id: line.partnerId,
          commission_minor: line.commissionMinor,
          deduction_minor: 0,
          net_minor: line.netMinor,
          commission_count: line.commissionIds.length,
          payout_hint: json(hints.get(line.partnerId) ?? {}),
          reference: paid ? 'UTR HDFCN52026110112345' : null,
        });
      }
      await knex('partner_commissions')
        .whereIn(
          'id',
          commissions.map((c) => c.id),
        )
        .update({ payout_id: payout.id, ...(paid ? { status: 'paid', paid_at: daysAgo(5) } : {}) });
    };
    await makePayout([first], { status: 'paid', periodStart: '2026-10-01', periodEnd: '2026-10-31', createdAt: daysAgo(7) });
    if (rest.length) await makePayout(rest, { status: 'draft', periodStart: '2026-11-01', periodEnd: '2026-11-30', createdAt: daysAgo(1) });
    await knex('crm_sequences').insert({ company_id: satnpaper.id, name: 'partner_payout', value: number }).onConflict(['company_id', 'name']).merge({ value: number });
  }

  console.log(`Partner demo data: ${addedPartners} partners added, ${attributed} leads attributed, ${accrued} commissions accrued.`);
}
