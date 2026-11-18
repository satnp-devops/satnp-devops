import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { partnerEventHandlers as handlers } from '../../src/modules/partners/handlers.js';
import { resolveReferralCode } from '../../src/modules/partners/referrals.js';

// Partners end to end against the seeded database (01_foundation, 02_crm, 34_partners): scoping as
// different seeded users, attribution from deal events, commission accrual and clawback
// idempotency, payout maker-checker, the partner portal and PII masking.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 node --test test/integration/partners.test.js
// It makes uniquely named records and removes the deal, commission and payout it made.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);

function client(base) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

const show = (res) => JSON.stringify(res.body);
const noop = { info() {}, warn() {} };

test('Partners', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn().catch((err) => console.error('cleanup failed', err.message));
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });
  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const byCode = (code) => units.find((u) => u.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  const excel = byCode('excel');
  const satAdmissions = byCode('sat-admissions');
  const seeded = await db('partners').where({ group_id: group.id, code: 'edupath-advisors' }).first();
  assert.ok(seeded, 'run the partners seed (34_partners.js) first');
  const campus = await db('partners').where({ group_id: group.id, code: 'campus-connect' }).first();
  const userIds = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));

  const signIn = async (email) => {
    const call = client(base);
    const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(res.status, 200, `${email}: ${show(res)}`);
    return call;
  };
  const owner = await signIn('owner@phoenix.test');
  const spAdmin = await signIn('admin.satnpaper@phoenix.test');
  const pvAdmin = await signIn('admin.pivector@phoenix.test');
  const ritika = await signIn('ritika@phoenix.test');
  const kabir = await signIn('kabir@phoenix.test');
  const finance = await signIn('finance@phoenix.test');
  const partnerUser = await signIn('partner.edupath@phoenix.test');

  const names = (res) => res.body.data.map((p) => p.name).sort();

  await t.test('partner lists follow the working scope and the own level', async () => {
    const all = await owner('GET', `/partners?unitId=${group.id}`);
    assert.equal(all.status, 200, show(all));
    assert.ok(['Bright Future Consultants', 'Campus Connect', 'EduPath Advisors', 'Meera Iyer'].every((n) => names(all).includes(n)));

    const pv = await pvAdmin('GET', `/partners?unitId=${pivector.id}`);
    assert.equal(pv.status, 200);
    assert.ok(names(pv).includes('EduPath Advisors') && !names(pv).includes('Campus Connect'));
    // Only Pi Vector's partnership is shown to Pi Vector.
    const edupathAtPv = pv.body.data.find((p) => p.name === 'EduPath Advisors');
    assert.deepEqual(
      edupathAtPv.companies.map((c) => c.company.id),
      [pivector.id],
    );
    assert.equal((await pvAdmin('GET', `/partners?unitId=${satnpaper.id}`)).status, 404, 'SatnPaper is invisible to Pi Vector');
    assert.equal((await pvAdmin('GET', `/partners/${campus.id}`)).status, 404, 'a SatnPaper-only partner is 404');

    // Ritika (partners.view:own) sees the partners whose leads she owns.
    const mine = await ritika('GET', `/partners?unitId=${satnpaper.id}`);
    assert.equal(mine.status, 200, show(mine));
    assert.ok(names(mine).includes('EduPath Advisors') && !names(mine).includes('Campus Connect'), names(mine).join());
    assert.equal((await ritika('GET', `/partners/${campus.id}`)).status, 404);
    const kab = await kabir('GET', `/partners?unitId=${satnpaper.id}`);
    assert.ok(names(kab).includes('Campus Connect'));

    // Keyset pagination.
    const page1 = await owner('GET', `/partners?unitId=${group.id}&limit=2`);
    assert.equal(page1.body.data.length, 2);
    assert.ok(page1.body.nextCursor);
    const page2 = await owner('GET', `/partners?unitId=${group.id}&limit=2&cursor=${page1.body.nextCursor}`);
    assert.ok(page2.body.data.every((p) => !page1.body.data.some((q) => q.id === p.id)));
    assert.equal((await owner('GET', `/partners?unitId=${group.id}&cursor=garbage`)).status, 400);
  });

  let partner;
  let refLink;
  await t.test('adding a partner validates input; Pi Vector can’t touch it', async () => {
    const bad = await spAdmin('POST', '/partners', { unitId: satAdmissions.id, kind: 'person', name: 'X', email: 'nope', surprise: 1 });
    assert.equal(bad.status, 422);
    const paths = bad.body.error.details.map((d) => d.path);
    assert.ok(paths.includes('body.email'), paths.join());
    const taken = await spAdmin('POST', '/partners', { unitId: satAdmissions.id, kind: 'person', name: `Taken ${RUN}`, code: 'campus-connect' });
    assert.equal(taken.status, 422, show(taken));
    const notOwner = await spAdmin('POST', '/partners', { unitId: satAdmissions.id, kind: 'person', name: `X ${RUN}`, ownerUserId: userIds.get('admin.pivector@phoenix.test') });
    assert.equal(notOwner.status, 422, 'a Pi Vector admin can’t own SatnPaper partner leads');

    const owners = await spAdmin('GET', `/partners/owners?unitId=${satAdmissions.id}`);
    assert.ok(owners.body.data.some((o) => o.id === userIds.get('ritika@phoenix.test')), show(owners));
    assert.equal((await pvAdmin('GET', `/partners/owners?unitId=${satAdmissions.id}`)).status, 404);
    const created = await spAdmin('POST', '/partners', {
      unitId: satAdmissions.id,
      kind: 'organisation',
      name: `Test Agency ${RUN}`,
      code: `test-agency-${RUN}`,
      email: `agency.${RUN}@example.com`,
      phone: '98200 55555',
      city: 'Pune',
      ownerUserId: userIds.get('ritika@phoenix.test'),
    });
    assert.equal(created.status, 201, show(created));
    partner = created.body.data;
    cleanup.push(async () => {
      await db('partner_referral_links').where({ partner_id: partner.id }).del();
      await db('partner_companies').where({ partner_id: partner.id }).del();
      await db('partners').where({ id: partner.id }).del();
    });
    assert.equal(partner.phone, '+919820055555');
    assert.equal(partner.companies[0].owner.id, userIds.get('ritika@phoenix.test'));
    assert.equal(partner.payout, null);

    assert.equal((await pvAdmin('PATCH', `/partners/${partner.id}`, { city: 'Delhi' })).status, 404);
    assert.equal((await ritika('PATCH', `/partners/${partner.id}`, { city: 'Delhi' })).status, 403, 'counsellors only see partners');
    const renamed = await spAdmin('PATCH', `/partners/${partner.id}`, { city: 'Mumbai' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.city, 'Mumbai');
  });

  await t.test('referral links: generated codes, share links, scoping and the intake resolver', async () => {
    const res = await spAdmin('POST', '/partner-links', { partnerId: partner.id, companyId: satnpaper.id, label: 'Seminar', utm: { campaign: 'seminar' } });
    assert.equal(res.status, 201, show(res));
    refLink = res.body.data;
    assert.match(refLink.code, /^SP-[A-Z0-9]{6}$/);
    assert.ok(refLink.shareUrl.startsWith('https://satnpaper.example/enquire?ref='), refLink.shareUrl);
    assert.ok(refLink.shareUrl.includes('utm_campaign=seminar'));
    assert.equal((await pvAdmin('POST', '/partner-links', { partnerId: partner.id, companyId: satnpaper.id })).status, 404);
    assert.equal((await spAdmin('POST', '/partner-links', { partnerId: partner.id, companyId: pivector.id })).status, 404, 'no partnership with Pi Vector');
    const dup = await spAdmin('POST', '/partner-links', { partnerId: partner.id, companyId: satnpaper.id, code: 'SP-EDUPATH' });
    assert.equal(dup.status, 422, show(dup));

    const resolved = await resolveReferralCode(refLink.code.toLowerCase(), { companyId: satnpaper.id });
    assert.equal(resolved.partnerId, partner.id);
    assert.equal(resolved.referralLinkId, refLink.id);
    assert.equal(resolved.partnerOwnerId, userIds.get('ritika@phoenix.test'));
    assert.equal(await resolveReferralCode(refLink.code, { companyId: pivector.id }), null, 'another company’s code');
    const byPartnerCode = await resolveReferralCode(`test-agency-${RUN}`, { companyId: satnpaper.id });
    assert.equal(byPartnerCode.source, 'partner_code');
    assert.equal(await resolveReferralCode(`test-agency-${RUN}`, {}), null, 'a partner code needs the company');
    assert.equal(await resolveReferralCode('nonsense code', { companyId: satnpaper.id }), null);

    const off = await spAdmin('PATCH', `/partner-links/${refLink.id}`, { active: false });
    assert.equal(off.body.data.active, false);
    assert.equal(await resolveReferralCode(refLink.code, { companyId: satnpaper.id }), null, 'inactive links don’t resolve');
    await spAdmin('PATCH', `/partner-links/${refLink.id}`, { active: true });

    const pvLinks = await pvAdmin('GET', `/partner-links?unitId=${pivector.id}`);
    assert.ok(pvLinks.body.data.every((l) => l.company.id === pivector.id));
  });

  // ---------- A referred lead, its commission, a refund and a payout ----------
  let deal;
  let plan;
  let commissionId;
  await t.test('a lead with the referral code is attributed once, first and last touch', async () => {
    const template = await db('deals').where({ ref: 'SP-1022' }).first();
    const touch = { channel: 'partner_referral', landingUrl: `https://satnpaper.example/enquire?ref=${refLink.code}`, at: new Date().toISOString() };
    const max = await db('deals').where({ company_id: satnpaper.id }).max({ n: 'number' }).first();
    [deal] = await db('deals')
      .insert({
        group_id: group.id,
        company_id: satnpaper.id,
        unit_id: satAdmissions.id,
        number: Number(max.n) + 1000 + Math.floor(Math.random() * 1000),
        ref: `T-${RUN}`,
        title: `Partner test ${RUN}`,
        kind: 'b2c',
        pipeline_id: template.pipeline_id,
        stage_id: template.stage_id,
        status: 'open',
        product_line_id: template.product_line_id,
        owner_user_id: userIds.get('ritika@phoenix.test'),
        value_minor: 4_000_000,
        currency: 'INR',
        primary_contact_id: template.primary_contact_id,
        channel: 'partner_referral',
        first_touch: JSON.stringify(touch),
        last_touch: JSON.stringify(touch),
        stage_entered_at: new Date(),
      })
      .returning('*');
    cleanup.push(async () => {
      await db('partner_commission_clawbacks').whereIn('commission_id', db('partner_commissions').select('id').where({ deal_id: deal.id })).del();
      await db('partner_commissions').where({ deal_id: deal.id }).del();
      await db('partner_attributions').where({ deal_id: deal.id }).del();
      await db('deals').where({ id: deal.id }).del();
    });
    const event = { id: `test-${RUN}`, type: 'deal.created', payload: { dealId: deal.id }, aggregateType: 'deal', aggregateId: deal.id };
    await handlers['deal.created'](event, { db, log: noop });
    await handlers['deal.created'](event, { db, log: noop }); // retried job
    await handlers['deal.updated']({ ...event, type: 'deal.updated', payload: { dealId: deal.id, changes: ['lastTouch'] } }, { db, log: noop });
    const rows = await db('partner_attributions').where({ deal_id: deal.id }).orderBy('touch');
    assert.deepEqual(
      rows.map((r) => [r.touch, r.partner_id, r.referral_link_id, r.source]),
      [
        ['first', partner.id, refLink.id, 'referral_link'],
        ['last', partner.id, refLink.id, 'referral_link'],
      ],
    );

    const listed = await spAdmin('GET', `/partner-attributions?unitId=${satnpaper.id}&dealId=${deal.id}`);
    assert.equal(listed.status, 200, show(listed));
    assert.equal(listed.body.data.length, 2);
    assert.equal(listed.body.data[0].deal.visible, true);
    assert.ok(listed.body.data[0].contact.primaryPhone.startsWith('+91'));
    const one = await spAdmin('GET', `/partner-attributions?unitId=${satnpaper.id}&dealId=${deal.id}&onePerLead=true`);
    assert.equal(one.body.data.length, 1, 'one row per lead');
    assert.equal(one.body.data[0].bothTouches, true);
    const pvList = await pvAdmin('GET', `/partner-attributions?unitId=${pivector.id}&dealId=${deal.id}`);
    assert.equal(pvList.body.data.length, 0, 'Pi Vector sees nothing of it');

    const links = await spAdmin('GET', `/partner-links?unitId=${satnpaper.id}&partnerId=${partner.id}`);
    assert.equal(links.body.data[0].leadCount, 1);
  });

  await t.test('commission plans: company admins set them up, others can’t', async () => {
    const bad = await spAdmin('POST', '/commission-plans', { companyId: satnpaper.id, name: 'Bad', basis: 'fixed', trigger: 'first_payment', clawbackDays: 30 });
    assert.equal(bad.status, 422, 'a fixed plan needs an amount and a currency');
    assert.equal(
      (await ritika('POST', '/commission-plans', { companyId: satnpaper.id, name: 'X', basis: 'percent', rateBps: 100, trigger: 'first_payment', clawbackDays: 30 })).status,
      403,
    );
    assert.equal(
      (await pvAdmin('POST', '/commission-plans', { companyId: satnpaper.id, name: 'X', basis: 'percent', rateBps: 100, trigger: 'first_payment', clawbackDays: 30 })).status,
      404,
    );
    const created = await spAdmin('POST', '/commission-plans', {
      companyId: satnpaper.id,
      name: `Test plan ${RUN}`,
      basis: 'percent',
      rateBps: 1250,
      trigger: 'first_payment',
      clawbackDays: 30,
      productLineId: deal.product_line_id,
      position: 0,
    });
    assert.equal(created.status, 201, show(created));
    plan = created.body.data;
    // Runs last: commissions refer to the plan.
    cleanup.unshift(async () => {
      await db('commission_plans').where({ id: plan.id }).del();
    });
    // This partnership uses the test plan whatever the product line.
    const linked = await spAdmin('PATCH', `/partners/${partner.id}/companies/${satnpaper.id}`, { commissionPlanId: plan.id });
    assert.equal(linked.status, 200, show(linked));
    const pvPlans = await pvAdmin('GET', `/commission-plans?unitId=${pivector.id}`);
    assert.ok(pvPlans.body.data.every((p) => p.companyId === pivector.id));
  });

  await t.test('payment.succeeded accrues one commission per payment, once per deal', async () => {
    const payment = { paymentId: `pay_${RUN}_1`, companyId: satnpaper.id, dealId: deal.id, amountMinor: 1_000_000, currency: 'INR', totalMinor: 4_000_000, isFirstPayment: true };
    const event = { id: `evt-${RUN}-1`, type: 'payment.succeeded', payload: payment };
    await handlers['payment.succeeded'](event, { db, log: noop });
    await handlers['payment.succeeded']({ ...event, id: `evt-${RUN}-1b` }, { db, log: noop }); // the same payment again
    await handlers['payment.succeeded']({ id: `evt-${RUN}-2`, type: 'payment.succeeded', payload: { ...payment, paymentId: `pay_${RUN}_2`, isFirstPayment: false } }, { db, log: noop });
    await handlers['payment.succeeded']({ id: `evt-${RUN}-3`, type: 'payment.succeeded', payload: { nonsense: true } }, { db, log: noop });
    const rows = await db('partner_commissions').where({ deal_id: deal.id });
    assert.equal(rows.length, 1);
    commissionId = rows[0].id;
    assert.equal(Number(rows[0].amount_minor), 500_000, '12.5% of ₹40,000');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].plan_id, plan.id);

    const listed = await ritika('GET', `/partner-commissions?unitId=${satnpaper.id}&partnerId=${partner.id}`);
    assert.equal(listed.status, 200, show(listed));
    assert.equal(listed.body.data[0].can.approve, false);
    assert.equal((await pvAdmin('GET', `/partner-commissions/${commissionId}`)).status, 404);
    const summary = await spAdmin('GET', `/partner-commissions/summary?unitId=${satnpaper.id}&partnerId=${partner.id}`);
    assert.deepEqual(summary.body.data.statuses.map((s) => [s.status, s.count, s.total.valueMinor]), [['pending', 1, 500_000]]);
  });

  await t.test('refund.processed claws back inside the window, once per refund', async () => {
    const refund = { refundId: `rfnd_${RUN}_1`, paymentId: `pay_${RUN}_1`, companyId: satnpaper.id, amountMinor: 1_000_000, currency: 'INR' };
    await handlers['refund.processed']({ id: `evt-${RUN}-r1`, type: 'refund.processed', payload: refund }, { db, log: noop });
    await handlers['refund.processed']({ id: `evt-${RUN}-r1b`, type: 'refund.processed', payload: refund }, { db, log: noop });
    await handlers['refund.succeeded']({ id: `evt-${RUN}-r1c`, type: 'refund.succeeded', payload: refund }, { db, log: noop });
    const row = await db('partner_commissions').where({ id: commissionId }).first();
    assert.equal(Number(row.clawed_back_minor), 125_000, 'a quarter of the fee refunded → a quarter of the commission');
    const clawbacks = await db('partner_commission_clawbacks').where({ commission_id: commissionId });
    assert.equal(clawbacks.length, 1);
    assert.equal(clawbacks[0].recovery, 'netted');
    // Outside the window: nothing.
    await db('partner_commissions').where({ id: commissionId }).update({ clawback_until: new Date(Date.now() - 1000) });
    await handlers['refund.processed']({ id: `evt-${RUN}-r2`, type: 'refund.processed', payload: { ...refund, refundId: `rfnd_${RUN}_2` } }, { db, log: noop });
    assert.equal((await db('partner_commission_clawbacks').where({ commission_id: commissionId })).length, 1);
    await db('partner_commissions').where({ id: commissionId }).update({ clawback_until: new Date(Date.now() + 86_400_000) });
  });

  await t.test('finance approves commissions; counsellors can’t', async () => {
    assert.equal((await ritika('POST', `/partner-commissions/${commissionId}/approve`)).status, 403);
    const ok = await finance('POST', `/partner-commissions/${commissionId}/approve`);
    assert.equal(ok.status, 200, show(ok));
    assert.equal(ok.body.data.status, 'approved');
    assert.equal(ok.body.data.payable.valueMinor, 375_000);
    assert.equal((await finance('POST', `/partner-commissions/${commissionId}/approve`)).status, 409);
    const bulk = await finance('POST', '/partner-commissions/approve', { ids: [commissionId, '00000000-0000-4000-8000-000000000000'] });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.data.skipped.length, 2);
  });

  await t.test('payout details are encrypted, masked everywhere, and only finance reads them', async () => {
    const details = { method: 'bank_transfer', accountName: `Test Agency ${RUN}`, accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' };
    assert.equal((await ritika('PUT', `/partners/${partner.id}/payout-details`, details)).status, 403);
    assert.equal((await pvAdmin('PUT', `/partners/${partner.id}/payout-details`, details)).status, 404);
    assert.equal((await finance('PUT', `/partners/${partner.id}/payout-details`, { ...details, ifsc: 'bad' })).status, 422);
    const set = await finance('PUT', `/partners/${partner.id}/payout-details`, details);
    assert.equal(set.status, 200, show(set));
    assert.equal(set.body.data.payout.accountLast4, '9012');
    assert.ok(!JSON.stringify(set.body).includes('123456789012'));
    const stored = await db('partners').where({ id: partner.id }).first('payout_details_enc');
    assert.ok(!stored.payout_details_enc.includes('123456789012'));
    const read = await finance('GET', `/partners/${partner.id}/payout-details`);
    assert.equal(read.body.data.details.accountNumber, '123456789012');
    assert.equal((await ritika('GET', `/partners/${partner.id}/payout-details`)).status, 403);
    const audit = await db('audit_logs').where({ action: 'partner.payout_details_viewed', entity_id: partner.id }).first();
    assert.ok(audit, 'reading payout details is audited');
    const changed = await db('audit_logs').where({ action: 'partner.payout_details_changed', entity_id: partner.id }).first();
    assert.ok(!JSON.stringify(changed).includes('123456789012'), 'the audit log never holds the number');
  });

  let payoutId;
  await t.test('payout batches: held during the clawback window, maker-checker approval, paid', async () => {
    const body = { companyId: satnpaper.id, periodStart: '2026-11-01', periodEnd: '2099-12-31', currency: 'INR' };
    const held = await finance('POST', '/partner-payouts/preview', body);
    assert.equal(held.status, 200, show(held));
    assert.ok(!held.body.data.lines.some((l) => l.partner.id === partner.id), 'inside the clawback window: waits');
    await db('partner_commissions').where({ id: commissionId }).update({ clawback_until: new Date(Date.now() - 1000) });
    assert.equal((await ritika('POST', '/partner-payouts', body)).status, 403);
    assert.equal((await pvAdmin('POST', '/partner-payouts', body)).status, 404);
    const created = await finance('POST', '/partner-payouts', body);
    assert.equal(created.status, 201, show(created));
    payoutId = created.body.data.id;
    cleanup.push(async () => {
      await db('partner_commissions').where({ payout_id: payoutId }).update({ payout_id: null, status: 'approved', paid_at: null });
      await db('partner_commission_clawbacks').where({ payout_id: payoutId }).update({ payout_id: null, recovered_at: null });
      await db('partner_payouts').where({ id: payoutId }).del();
    });
    const line = created.body.data.lines.find((l) => l.partner.id === partner.id);
    assert.equal(line.net.valueMinor, 375_000);
    assert.equal(line.payout.accountLast4, '9012');
    assert.equal(created.body.data.status, 'draft');
    assert.equal(created.body.data.can.approve, false, 'the preparer can’t approve');
    // The same commission can't go into a second batch.
    const again = await finance('POST', '/partner-payouts/preview', body);
    assert.ok(!again.body.data.lines.some((l) => l.partner.id === partner.id));

    const own = await finance('POST', `/partner-payouts/${payoutId}/approve`);
    assert.equal(own.status, 403, 'maker-checker');
    assert.equal((await pvAdmin('POST', `/partner-payouts/${payoutId}/approve`)).status, 404);
    assert.equal((await ritika('GET', `/partner-payouts/${payoutId}`)).status, 404);
    assert.equal((await finance('POST', `/partner-payouts/${payoutId}/mark-paid`, { reference: 'NEFT-1' })).status, 409, 'approve first');
    const approved = await spAdmin('POST', `/partner-payouts/${payoutId}/approve`);
    assert.equal(approved.status, 200, show(approved));
    assert.equal(approved.body.data.status, 'approved');
    const paid = await finance('POST', `/partner-payouts/${payoutId}/mark-paid`, { reference: `NEFT-${RUN}`, lines: [{ partnerId: partner.id, reference: `UTR-${RUN}` }] });
    assert.equal(paid.status, 200, show(paid));
    assert.equal(paid.body.data.status, 'paid');
    assert.equal((await db('partner_commissions').where({ id: commissionId }).first()).status, 'paid');
    assert.equal((await finance('POST', `/partner-payouts/${payoutId}/cancel`, { reason: 'too late' })).status, 409);
  });

  await t.test('a refund after payout is deducted from the next batch', async () => {
    await db('partner_commissions').where({ id: commissionId }).update({ clawback_until: new Date(Date.now() + 86_400_000) });
    await handlers['refund.processed'](
      { id: `evt-${RUN}-r3`, type: 'refund.processed', payload: { refundId: `rfnd_${RUN}_3`, paymentId: `pay_${RUN}_1`, companyId: satnpaper.id, full: true } },
      { db, log: noop },
    );
    const clawback = await db('partner_commission_clawbacks').where({ commission_id: commissionId, refund_id: `rfnd_${RUN}_3` }).first();
    assert.equal(clawback.recovery, 'deduct');
    assert.equal(Number(clawback.amount_minor), 375_000);
    const row = await db('partner_commissions').where({ id: commissionId }).first();
    assert.equal(row.status, 'clawed_back');
  });

  await t.test('the partner portal shows only the partner’s own data, masked', async () => {
    const me = await partnerUser('GET', '/partner-portal/me');
    assert.equal(me.status, 200, show(me));
    assert.equal(me.body.data.id, seeded.id);
    const leads = await partnerUser('GET', '/partner-portal/leads?limit=100');
    assert.equal(leads.status, 200);
    const expected = await db('partner_attributions').where({ partner_id: seeded.id }).countDistinct({ n: 'deal_id' }).first();
    assert.equal(leads.body.data.length, Number(expected.n), 'one row per referred lead');
    for (const lead of leads.body.data) {
      assert.match(lead.name, /^\S+( [A-Z]\.)?$|^Erased$|^Unnamed$/, lead.name);
      if (lead.phone) assert.ok(lead.phone.includes('•'), lead.phone);
      assert.ok(!('stage' in lead) && !('owner' in lead) && !('value' in lead));
    }
    const commissions = await partnerUser('GET', '/partner-portal/commissions?limit=100');
    const mine = await db('partner_commissions').where({ partner_id: seeded.id }).count({ n: '*' }).first();
    assert.equal(commissions.body.data.length, Number(mine.n));
    const payouts = await partnerUser('GET', '/partner-portal/payouts');
    assert.ok(payouts.body.data.every((p) => p.status === 'approved' || p.status === 'paid'), 'drafts are internal');
    const links = await partnerUser('GET', '/partner-portal/links?limit=100');
    assert.ok(links.body.data.length > 0 && links.body.data.every((l) => l.partner.id === seeded.id));

    // Creating links: only for their own partnerships; the code is generated.
    const made = await partnerUser('POST', '/partner-portal/links', { companyId: satnpaper.id, label: `Portal ${RUN}` });
    assert.equal(made.status, 201, show(made));
    cleanup.push(async () => {
      await db('partner_referral_links').where({ id: made.body.data.id }).del();
    });
    assert.equal(made.body.data.createdByPartner, true);
    assert.equal((await partnerUser('POST', '/partner-portal/links', { companyId: excel.id })).status, 422, 'no partnership with Excel');
    assert.equal((await partnerUser('POST', '/partner-portal/links', { companyId: satnpaper.id, landingUrl: 'https://evil.example' })).status, 422);
    assert.equal((await partnerUser('PATCH', `/partner-portal/links/${refLink.id}`, { active: false })).status, 404, 'someone else’s link');

    // Nothing of the staff CRM.
    assert.equal((await partnerUser('GET', `/partners?unitId=${satnpaper.id}`)).status, 403);
    assert.equal((await partnerUser('GET', `/partner-commissions?unitId=${satnpaper.id}`)).status, 403);
    assert.equal((await partnerUser('GET', `/partners/${seeded.id}`)).status, 404);
    // Staff have no portal profile.
    assert.equal((await owner('GET', '/partner-portal/me')).status, 404);
    assert.equal((await ritika('GET', '/partner-portal/me')).status, 403);
  });

  await t.test('portal access: invitation for a new email, never a staff account', async () => {
    const staff = await spAdmin('POST', `/partners/${partner.id}/portal-access`, { email: 'ritika@phoenix.test' });
    assert.equal(staff.status, 409, show(staff));
    const email = `agency.portal.${RUN}@example.com`;
    const granted = await spAdmin('POST', `/partners/${partner.id}/portal-access`, { email });
    assert.equal(granted.status, 200, show(granted));
    assert.equal(granted.body.data.partner.hasPortalAccess, true);
    assert.ok(granted.body.data.inviteUrl?.includes('/accept-invite?token='));
    const user = await db('users').where({ email }).first();
    cleanup.push(async () => {
      await db('role_assignments').where({ user_id: user.id }).del();
      await db('user_tokens').where({ user_id: user.id }).del();
      await db('partners').where({ id: partner.id }).update({ user_id: null });
      await db('users').where({ id: user.id }).del();
    });
    const revoked = await spAdmin('DELETE', `/partners/${partner.id}/portal-access`);
    assert.equal(revoked.body.data.hasPortalAccess, false);
    assert.equal((await db('role_assignments').where({ user_id: user.id })).length, 0);
  });

  await t.test('PII is masked for people without contacts.view_pii', async () => {
    const email = `analyst.${RUN}@phoenix.test`;
    const role = await db('roles').whereNull('group_id').where({ key: 'analyst' }).first();
    const [user] = await db('users').insert({ email, name: `Analyst ${RUN}`, status: 'active', password_hash: await hashPassword(env.SEED_PASSWORD) }).returning('*');
    await db('role_assignments').insert({ user_id: user.id, role_id: role.id, org_unit_id: satnpaper.id });
    cleanup.push(async () => {
      await db('sessions').where({ user_id: user.id }).del();
      await db('role_assignments').where({ user_id: user.id }).del();
      await db('users').where({ id: user.id }).del();
    });
    const analyst = await signIn(email);
    const got = await analyst('GET', `/partners/${seeded.id}`);
    assert.equal(got.status, 200, show(got));
    assert.equal(got.body.data.piiMasked, true);
    assert.notEqual(got.body.data.email, seeded.email);
    assert.ok(got.body.data.phone.includes('•'));
    const attributions = await analyst('GET', `/partner-attributions?unitId=${satnpaper.id}&partnerId=${seeded.id}&limit=100`);
    assert.equal(attributions.status, 200);
    for (const a of attributions.body.data) if (a.contact?.primaryPhone) assert.ok(a.contact.primaryPhone.includes('•'));
    assert.equal((await analyst('GET', `/partners/${seeded.id}/payout-details`)).status, 403);
    const full = await spAdmin('GET', `/partners/${seeded.id}`);
    assert.equal(full.body.data.email, seeded.email);
  });
});
