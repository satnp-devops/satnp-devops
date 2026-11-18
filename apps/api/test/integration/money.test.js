import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { allocateNumber } from '../../src/modules/money/invoicing.js';
import { devRazorpayDelivery, devRazorpayRefundDelivery, handlePaymentWebhook } from '../../src/modules/money/webhooks.js';
import { paymentRetriesJob, instalmentRemindersJob, expiriesJob, subscriptionRenewalsJob } from '../../src/modules/money/jobs.js';

// Fees and billing end to end against a real Postgres + Redis (phase 7). Needs the migrated and
// seeded database (01_foundation, 02_crm, 31_money). Creates its own quotes and payments on seeded
// deals each run, so it can run repeatedly.

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

const ok = (res, status = 200) => assert.equal(res.status, status, JSON.stringify(res.body));

test('fees and billing end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => {
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
  const satAdmissions = byCode('sat-admissions');
  assert.ok(await db('billing_profiles').where({ company_id: satnpaper.id }).first(), 'run the money seed (31_money.js) first');
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));

  const sessions = {};
  for (const email of ['owner', 'finance', 'ritika', 'kabir', 'admin.pivector', 'admin.satnpaper', 'sales.satnpaper']) {
    const call = client(base);
    ok(await call('POST', '/auth/login', { email: `${email}@phoenix.test`, password: env.SEED_PASSWORD }));
    sessions[email] = call;
  }
  const { owner, finance, ritika, kabir } = sessions;
  const pvAdmin = sessions['admin.pivector'];
  const sales = sessions['sales.satnpaper'];

  const openDeal = async (email, kind = 'b2c') =>
    db('deals')
      .where({ company_id: satnpaper.id, owner_user_id: users.get(email), status: 'open', kind })
      .whereNull('archived_at')
      .orderBy('number', 'desc')
      .first();
  const ritikaDeal = await openDeal('ritika@phoenix.test');
  const kabirDeal = await openDeal('kabir@phoenix.test');
  const b2bDeal = await openDeal('sales.satnpaper@phoenix.test', 'b2b');
  assert.ok(ritikaDeal && kabirDeal && b2bDeal, 'seeded open deals for ritika, kabir and sales');
  const plans = await db('billing_plans').where({ company_id: satnpaper.id });
  const plan = (code) => plans.find((p) => p.code === code);

  const eventsFor = (aggregateId, type) => db('outbox_events').where({ aggregate_id: aggregateId, type }).count('* as n').first().then((r) => Number(r.n));

  await t.test('setup: counsellors read plans, only billing.configure writes, other companies are 404', async () => {
    const list = await ritika('GET', `/billing/plans?unitId=${satAdmissions.id}`);
    ok(list);
    assert.ok(list.body.data.some((p) => p.code === 'SAT-CRASH-4W'));
    const create = await ritika('POST', '/billing/plans', { companyId: satnpaper.id, code: `T${RUN}`, name: 'Test', kind: 'one_time', audience: 'b2c' });
    ok(create, 403);
    ok(await pvAdmin('GET', `/billing/setup?companyId=${satnpaper.id}`), 404);
    const setup = await sessions['admin.satnpaper']('GET', `/billing/setup?companyId=${satnpaper.id}`);
    ok(setup);
    assert.match(setup.body.data.profile.gstin, /^27[A-Z]{5}\d{4}[A-Z]1Z[0-9A-Z]$/);
    const badGstin = await sessions['admin.satnpaper']('PUT', '/billing/profile', { companyId: satnpaper.id, legalName: 'X', gstin: '27AAPFU0939F1ZW' });
    ok(badGstin, 422);
    assert.equal(badGstin.body.error.details[0].path, 'body.gstin');
    const unknownKey = await sessions['admin.satnpaper']('POST', '/billing/plans', { companyId: satnpaper.id, code: `T${RUN}`, name: 'Test', kind: 'one_time', audience: 'b2c', hacked: true });
    ok(unknownKey, 422);
  });

  let paidPaymentId;
  let invoiceId;
  await t.test('GST invoice end to end: fee proposal → send → link → paid → invoice', async () => {
    const created = await ritika('POST', '/billing/quotes', { dealId: ritikaDeal.id, lines: [{ planId: plan('SAT-CRASH-4W').id }], recipient: { stateCode: '27' } });
    ok(created, 201);
    const quote = created.body.data;
    assert.equal(quote.kind, 'fee_proposal');
    assert.equal(quote.status, 'draft');
    assert.equal(quote.amounts.total.valueMinor, 1_800_000); // price list is tax-inclusive
    assert.equal(quote.taxKind, 'cgst_sgst');
    assert.equal(quote.amounts.taxable.valueMinor + quote.amounts.tax.valueMinor, 1_800_000);
    ok(await ritika('POST', `/billing/payments/links`, { dealId: ritikaDeal.id, purpose: 'full', quoteId: quote.id }), 409); // not sent yet
    const sent = await ritika('POST', `/billing/quotes/${quote.id}/send`);
    ok(sent);
    assert.equal(sent.body.data.status, 'sent');
    assert.equal(await eventsFor(quote.id, 'quote.sent'), 1);

    const link = await ritika('POST', '/billing/payments/links', { dealId: ritikaDeal.id, purpose: 'full', quoteId: quote.id, idempotencyKey: `it-${RUN}-1` });
    ok(link, 201);
    assert.equal(link.body.data.status, 'link_sent');
    assert.equal(link.body.data.provider, 'razorpay');
    assert.ok(link.body.data.linkUrl.startsWith('https://'));
    const again = await ritika('POST', '/billing/payments/links', { dealId: ritikaDeal.id, purpose: 'full', quoteId: quote.id, idempotencyKey: `it-${RUN}-1` });
    ok(again, 201);
    assert.equal(again.body.data.id, link.body.data.id, 'same idempotency key → same link');

    const paid = await ritika('POST', `/billing/payments/${link.body.data.id}/simulate`, { outcome: 'succeeded', method: 'upi' });
    ok(paid);
    assert.equal(paid.body.data.status, 'succeeded');
    assert.equal(paid.body.data.method, 'upi');
    assert.ok(paid.body.data.invoiceId, 'invoice issued on payment');
    paidPaymentId = paid.body.data.id;
    invoiceId = paid.body.data.invoiceId;

    const invoice = await ritika('GET', `/billing/invoices/${invoiceId}`);
    ok(invoice);
    const inv = invoice.body.data;
    assert.match(inv.number, /^SP\/\d{4}\/\d{5}$/);
    assert.equal(inv.total.valueMinor, 1_800_000);
    assert.equal(inv.totals.cgst.valueMinor, inv.totals.sgst.valueMinor);
    assert.equal(inv.totals.taxable.valueMinor + inv.totals.cgst.valueMinor + inv.totals.sgst.valueMinor, 1_800_000);
    assert.equal(inv.totals.igst.valueMinor, 0);
    assert.equal(inv.lines[0].sac, '999293');
    assert.equal(inv.placeOfSupply.code, '27');
    assert.match(inv.amountInWords, /^Rupees Eighteen Thousand Only$/);
    assert.equal(inv.supplier.gstin.slice(0, 2), '27');
    assert.equal(await eventsFor(paidPaymentId, 'payment.succeeded'), 1);
    assert.equal(await eventsFor(invoiceId, 'invoice.issued'), 1);
    const quoteAfter = await ritika('GET', `/billing/quotes/${quote.id}`);
    assert.equal(quoteAfter.body.data.status, 'accepted', 'paying a sent proposal accepts it');
    const timeline = await db('timeline_events').where({ deal_id: ritikaDeal.id, kind: 'payment' }).orderBy('id', 'desc').first();
    assert.match(timeline.title, /Payment received/);
  });

  await t.test('place of supply: another state is IGST, an export under LUT has no GST', async () => {
    const other = await ritika('POST', '/billing/quotes/preview', { dealId: ritikaDeal.id, lines: [{ planId: plan('SAT-CRASH-4W').id }], recipient: { stateCode: '29' } });
    ok(other);
    assert.equal(other.body.data.supplyType, 'inter_state');
    assert.equal(other.body.data.taxKind, 'igst');
    const usd = await db('billing_price_lists').where({ company_id: satnpaper.id, currency: 'USD' }).first();
    const exported = await ritika('POST', '/billing/quotes/preview', { dealId: ritikaDeal.id, priceListId: usd.id, lines: [{ planId: plan('SAT-1ON1-12').id }], recipient: { outsideIndia: true } });
    ok(exported);
    assert.equal(exported.body.data.supplyType, 'export_under_lut');
    assert.equal(exported.body.data.amounts.tax.valueMinor, 0);
    assert.equal(exported.body.data.currency, 'USD');
  });

  await t.test('discounts follow the policy: 15% needs a manager, the counsellor cannot approve', async () => {
    const created = await ritika('POST', '/billing/quotes', { dealId: ritikaDeal.id, lines: [{ planId: plan('SAT-1ON1-24').id, discountMinor: 2_700_000 }] });
    ok(created, 201);
    const quote = created.body.data;
    assert.equal(quote.status, 'pending_approval');
    assert.equal(quote.discount.status, 'needs_approval');
    assert.equal(quote.discount.percentBp, 1500);
    ok(await ritika('POST', `/billing/quotes/${quote.id}/approve-discount`, {}), 403);
    ok(await ritika('POST', `/billing/quotes/${quote.id}/send`), 409);
    const tooMuch = await ritika('POST', '/billing/quotes', { dealId: ritikaDeal.id, lines: [{ planId: plan('SAT-1ON1-24').id, discountMinor: 9_000_000 }] });
    ok(tooMuch, 422);
    const approved = await kabir('POST', `/billing/quotes/${quote.id}/approve-discount`, { note: 'Sibling discount' });
    ok(approved);
    assert.equal(approved.body.data.status, 'approved');
    assert.equal(approved.body.data.discount.reviewedBy.id, users.get('kabir@phoenix.test'));
    ok(await ritika('POST', `/billing/quotes/${quote.id}/send`));
    assert.equal(await eventsFor(quote.id, 'quote.discount_approved'), 1);
  });

  await t.test('webhooks: signature failures change nothing, redeliveries are idempotent, other companies are not touched', async () => {
    const created = await kabir('POST', '/billing/quotes', { dealId: kabirDeal.id, lines: [{ planId: plan('SAT-TS-10').id }] });
    ok(created, 201);
    ok(await kabir('POST', `/billing/quotes/${created.body.data.id}/send`));
    const link = await kabir('POST', '/billing/payments/links', { dealId: kabirDeal.id, purpose: 'full', quoteId: created.body.data.id });
    ok(link, 201);
    const payment = await db('payments').where({ id: link.body.data.id }).first();
    const delivery = devRazorpayDelivery({ event: 'payment_link.paid', payment, eventId: `evt_it${RUN}a` });

    const tampered = { ...delivery, rawBody: Buffer.from(delivery.rawBody.toString().replace('"captured"', '"CAPTURED"')) };
    await assert.rejects(handlePaymentWebhook({ accountId: payment.account_id, ...tampered }), (err) => err.status === 401 && err.code === 'webhook_signature');
    await assert.rejects(handlePaymentWebhook({ accountId: payment.account_id, rawBody: delivery.rawBody, headers: { ...delivery.headers, 'x-razorpay-signature': 'ab'.repeat(32) } }), (err) => err.status === 401);
    assert.equal((await db('payments').where({ id: payment.id }).first()).status, 'link_sent');

    // The same delivery to Pi Vector's account verifies (shared dev secret) but must not touch SatnPaper's payment.
    const pvAccount = await db('billing_payment_accounts').where({ company_id: pivector.id, provider: 'razorpay' }).first();
    const foreign = await handlePaymentWebhook({ accountId: pvAccount.id, ...devRazorpayDelivery({ event: 'payment_link.paid', payment, eventId: `evt_it${RUN}pv` }) });
    assert.equal(foreign.outcome, 'unmatched');
    assert.equal((await db('payments').where({ id: payment.id }).first()).status, 'link_sent');

    // Two concurrent deliveries of one event, then a redelivery: applied once.
    const results = await Promise.all([
      handlePaymentWebhook({ accountId: payment.account_id, ...delivery }),
      handlePaymentWebhook({ accountId: payment.account_id, ...delivery }),
    ]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['applied', 'duplicate']);
    const redelivery = await handlePaymentWebhook({ accountId: payment.account_id, ...delivery });
    assert.equal(redelivery.outcome, 'duplicate');
    // payment.captured for the same payment arrives with its own event id: ignored, already paid.
    const captured = await handlePaymentWebhook({ accountId: payment.account_id, ...devRazorpayDelivery({ event: 'payment.captured', payment, eventId: `evt_it${RUN}b` }) });
    assert.equal(captured.outcome, 'ignored');
    assert.equal(await eventsFor(payment.id, 'payment.succeeded'), 1);
    assert.equal(Number((await db('invoices').where({ payment_id: payment.id }).count('* as n').first()).n), 1);
    assert.equal(Number((await db('timeline_events').where({ source_event_id: `razorpay:evt_it${RUN}a` }).count('* as n').first()).n), 1);
  });

  await t.test('failed payments: payment.failed and a retry on the schedule', async () => {
    const created = await kabir('POST', '/billing/quotes', { dealId: kabirDeal.id, lines: [{ planId: plan('SAT-TS-10').id }] });
    ok(await kabir('POST', `/billing/quotes/${created.body.data.id}/send`));
    const link = await kabir('POST', '/billing/payments/links', { dealId: kabirDeal.id, purpose: 'full', quoteId: created.body.data.id });
    ok(link, 201);
    const failed = await kabir('POST', `/billing/payments/${link.body.data.id}/simulate`, { outcome: 'failed' });
    ok(failed);
    assert.equal(failed.body.data.status, 'failed');
    assert.ok(failed.body.data.nextRetryAt, 'a retry is scheduled from billing.paymentRetryHours');
    assert.equal(await eventsFor(link.body.data.id, 'payment.failed'), 1);
    await db('payments').where({ id: link.body.data.id }).update({ next_retry_at: new Date(Date.now() - 1000) });
    const run = await paymentRetriesJob();
    assert.ok(run.reminded + run.relinked >= 1);
    assert.equal(await eventsFor(link.body.data.id, 'payment.retry_due'), 1);
    const second = await paymentRetriesJob();
    assert.equal(await eventsFor(link.body.data.id, 'payment.retry_due'), 1, 'not reminded twice for one step');
    assert.ok(second.checked >= 0);
    ok(await kabir('POST', `/billing/payments/${link.body.data.id}/cancel`));
  });

  await t.test('refunds need someone with billing.approve_refunds, and end in a credit note', async () => {
    // Ritika's payment from the first test.
    const req = await ritika('POST', '/billing/refunds', { paymentId: paidPaymentId, amountMinor: 300_000, reason: 'requested_by_customer', note: 'Moving abroad' });
    ok(req, 201);
    const refund = req.body.data;
    assert.equal(refund.status, 'requested');
    assert.equal(await eventsFor(refund.id, 'refund.requested'), 1);
    ok(await ritika('POST', `/billing/refunds/${refund.id}/approve`, {}), 403);
    ok(await kabir('POST', `/billing/refunds/${refund.id}/approve`, {}), 403); // managers can't approve refunds
    const tooMuch = await ritika('POST', '/billing/refunds', { paymentId: paidPaymentId, amountMinor: 1_600_000, reason: 'other' });
    ok(tooMuch, 422);
    const approved = await finance('POST', `/billing/refunds/${refund.id}/approve`, { note: 'OK per policy' });
    ok(approved);
    assert.equal(approved.body.data.status, 'processing');
    assert.equal(await eventsFor(refund.id, 'refund.approved'), 1);
    const row = await db('refunds').where({ id: refund.id }).first();
    const payment = await db('payments').where({ id: paidPaymentId }).first();
    const result = await handlePaymentWebhook({ accountId: payment.account_id, ...devRazorpayRefundDelivery({ refund: row, providerPaymentId: payment.provider_payment_id, eventId: `evt_it${RUN}r` }) });
    assert.equal(result.outcome, 'applied');
    const done = await finance('GET', `/billing/refunds/${refund.id}`);
    assert.equal(done.body.data.status, 'processed');
    assert.ok(done.body.data.creditNoteId);
    assert.equal(await eventsFor(refund.id, 'refund.processed'), 1);
    const invoice = await finance('GET', `/billing/invoices/${invoiceId}`);
    assert.equal(invoice.body.data.credited.valueMinor, 300_000);
    assert.match(invoice.body.data.creditNotes[0].number, /^SP\/CN\d{4}\/\d{5}$/);
    assert.equal((await db('payments').where({ id: paidPaymentId }).first()).amount_refunded_minor, '300000');

    // The owner may request and approve, but not their own request.
    const own = await owner('POST', '/billing/refunds', { paymentId: paidPaymentId, amountMinor: 100_000, reason: 'other' });
    ok(own, 201);
    ok(await owner('POST', `/billing/refunds/${own.body.data.id}/approve`, {}), 403);
    ok(await finance('POST', `/billing/refunds/${own.body.data.id}/reject`, { note: 'Not eligible' }));
    // Finance approves but does not work deals: no requests.
    ok(await finance('POST', '/billing/refunds', { paymentId: paidPaymentId, amountMinor: 100_000, reason: 'other' }), 403);
  });

  await t.test('invoice numbers are gap-free under concurrency', async () => {
    const created = await sessions['admin.satnpaper']('POST', '/billing/series', { companyId: satnpaper.id, documentType: 'debit_note', prefix: `Z${RUN.slice(-2).toUpperCase()}`, isDefault: false });
    ok(created, 201);
    const series = await db('billing_number_series').where({ id: created.body.data.id }).first();
    const date = new Date().toISOString().slice(0, 10);
    const numbers = await Promise.all(Array.from({ length: 20 }, () => db.transaction((trx) => allocateNumber(trx, series, date, 'Asia/Kolkata'))));
    const sequences = numbers.map((n) => n.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(numbers.map((n) => n.number)).size, 20);
    // A rolled-back issue leaves no gap.
    await assert.rejects(
      db.transaction(async (trx) => {
        await allocateNumber(trx, series, date, 'Asia/Kolkata');
        throw new Error('issue failed');
      }),
      /issue failed/,
    );
    const next = await db.transaction((trx) => allocateNumber(trx, series, date, 'Asia/Kolkata'));
    assert.equal(next.sequence, 21);
    // Backdating below the last document date is refused.
    await assert.rejects(db.transaction((trx) => allocateNumber(trx, series, '2026-04-01', 'Asia/Kolkata')), (err) => err.status === 409);
    ok(await sessions['admin.satnpaper']('PATCH', `/billing/series/${series.id}`, { active: false }));
    // The test series held no documents: remove it so repeated runs don't pile up spare series.
    await db('billing_number_counters').where({ series_id: series.id }).del();
    await db('billing_number_series').where({ id: series.id }).del();
  });

  await t.test('scoping: finance sees every payment, counsellors only their deals, other companies nothing', async () => {
    const kabirPayment = await db('payments').where({ deal_id: kabirDeal.id }).first();
    ok(await ritika('GET', `/billing/payments/${kabirPayment.id}`), 404);
    ok(await finance('GET', `/billing/payments/${kabirPayment.id}`));
    ok(await kabir('GET', `/billing/payments/${paidPaymentId}`)); // Kabir manages SatnPaper › Online
    ok(await pvAdmin('GET', `/billing/payments/${kabirPayment.id}`), 404);
    ok(await pvAdmin('GET', `/billing/invoices/${invoiceId}`), 404);
    ok(await pvAdmin('GET', `/billing/payments?unitId=${satnpaper.id}`), 404);
    ok(await pvAdmin('GET', `/billing/deals/${kabirDeal.id}`), 404);
    ok(await ritika('GET', `/billing/deals/${kabirDeal.id}`), 404);
    ok(await finance('POST', '/billing/quotes', { dealId: kabirDeal.id, lines: [{ planId: plan('SAT-TS-10').id }] }), 403);

    const mine = await ritika('GET', `/billing/payments?unitId=${satnpaper.id}&limit=100`);
    ok(mine);
    const dealIds = new Set(mine.body.data.map((p) => p.deal.id));
    const owners = await db('deals').whereIn('id', [...dealIds]).distinct('owner_user_id');
    assert.deepEqual(owners.map((o) => o.owner_user_id), [users.get('ritika@phoenix.test')]);
    const all = await finance('GET', `/billing/payments?unitId=${group.id}&limit=100`);
    ok(all);
    assert.ok(all.body.data.some((p) => p.companyId === pivector.id) && all.body.data.some((p) => p.companyId === satnpaper.id));
    const pvList = await pvAdmin('GET', `/billing/payments?unitId=${pivector.id}`);
    ok(pvList);
    assert.ok(pvList.body.data.every((p) => p.companyId === pivector.id));
    // Keyset pages don't repeat rows.
    const first = await finance('GET', `/billing/payments?unitId=${group.id}&limit=3`);
    const second = await finance('GET', `/billing/payments?unitId=${group.id}&limit=3&cursor=${first.body.nextCursor}`);
    ok(second);
    assert.equal(new Set([...first.body.data, ...second.body.data].map((p) => p.id)).size, first.body.data.length + second.body.data.length);
    ok(await finance('GET', `/billing/payments?unitId=${group.id}&cursor=bad`), 400);
    const overview = await ritika('GET', `/billing/overview?unitId=${satAdmissions.id}`);
    ok(overview);
    assert.equal(overview.body.data.canApproveRefunds, false);
  });

  await t.test('fee proposal with instalments: plan on acceptance, instalment links, reminders', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const created = await ritika('POST', '/billing/quotes', {
      dealId: ritikaDeal.id,
      lines: [{ planId: plan('SAT-GB-EVE').id }],
      instalmentOption: { count: 3, frequency: 'monthly', startDate: start },
    });
    ok(created, 201);
    assert.equal(created.body.data.instalmentPreview.length, 3);
    ok(await ritika('POST', `/billing/quotes/${created.body.data.id}/send`));
    ok(await ritika('POST', `/billing/quotes/${created.body.data.id}/accept`));
    const deal = await ritika('GET', `/billing/deals/${ritikaDeal.id}`);
    ok(deal);
    const planRow = deal.body.data.instalmentPlans.find((p) => p.quoteId === created.body.data.id);
    assert.equal(planRow.instalments.length, 3);
    assert.equal(planRow.instalments.reduce((s, i) => s + i.amount.valueMinor, 0), 4_800_000);
    ok(await ritika('POST', '/billing/payments/links', { dealId: ritikaDeal.id, purpose: 'full', quoteId: created.body.data.id }), 409);
    const link = await ritika('POST', '/billing/payments/links', { dealId: ritikaDeal.id, purpose: 'instalment', instalmentId: planRow.instalments[0].id });
    ok(link, 201);
    assert.equal(link.body.data.amount.valueMinor, planRow.instalments[0].amount.valueMinor);
    const paid = await ritika('POST', `/billing/payments/${link.body.data.id}/simulate`, { outcome: 'succeeded' });
    ok(paid);
    const invoice = await ritika('GET', `/billing/invoices/${paid.body.data.invoiceId}`);
    assert.equal(invoice.body.data.total.valueMinor, planRow.instalments[0].amount.valueMinor, 'the instalment is invoiced, not the whole fee');
    const due = await ritika('GET', `/billing/instalments?unitId=${satAdmissions.id}&state=due&dealId=${ritikaDeal.id}`);
    ok(due);
    // The default reminder is 3 days before the due date: the second instalment is a month out.
    const reminders = await instalmentRemindersJob();
    assert.ok(reminders.checked >= 1);
    const again = await instalmentRemindersJob();
    assert.equal(again.sent, 0, 'each reminder goes once');
    const expired = await expiriesJob();
    assert.ok(expired.quotes >= 0);
  });

  await t.test('B2B subscription: first payment activates, seat changes are prorated', async () => {
    const created = await sales('POST', '/billing/subscriptions', { dealId: b2bDeal.id, planId: plan('TH-STD').id, quantity: 100 });
    ok(created, 201);
    const sub = created.body.data;
    assert.equal(sub.status, 'pending');
    assert.equal(sub.interval, 'year');
    const link = sub.payments[0];
    assert.ok(link);
    // TestHub Standard is ₹400 a student a year plus GST: 100 students = ₹47,200.
    assert.equal(link.amount.valueMinor, 4_720_000);
    ok(await sales('POST', `/billing/payments/${link.id}/simulate`, { outcome: 'succeeded' }));
    const active = await sales('GET', `/billing/subscriptions/${sub.id}`);
    assert.equal(active.body.data.status, 'active');
    const preview = await sales('PATCH', `/billing/subscriptions/${sub.id}`, { quantity: 150, preview: true });
    ok(preview);
    assert.equal(preview.body.data.proration.direction, 'upgrade');
    assert.ok(preview.body.data.proration.netMinor > 0);
    const renewals = await subscriptionRenewalsJob();
    assert.ok(renewals.checked >= 0);
    ok(await ritika('GET', `/billing/subscriptions/${sub.id}`), 404);
  });

  await t.test('agreements: sent for e-sign, signed through the Digio callback', async () => {
    const template = await db('agreement_templates').where({ company_id: satnpaper.id, key: 'fee_agreement' }).first();
    const created = await ritika('POST', '/billing/agreements', {
      dealId: ritikaDeal.id,
      templateId: template.id,
      signers: [{ name: 'Priya Sharma', identifier: '+91 90000 01234', role: 'parent' }],
      send: true,
    });
    ok(created, 201);
    assert.equal(created.body.data.status, 'sent');
    assert.equal(created.body.data.signers[0].identifier, '9000001234');
    assert.ok(!created.body.data.body.includes('{{'), 'placeholders are filled');
    const signed = await ritika('POST', `/billing/agreements/${created.body.data.id}/simulate`, { outcome: 'signed' });
    ok(signed);
    assert.equal(signed.body.data.status, 'signed');
    assert.equal(await eventsFor(created.body.data.id, 'agreement.signed'), 1);
    const audit = await db('audit_logs').where({ entity_id: created.body.data.id }).select('after');
    assert.ok(audit.every((a) => !JSON.stringify(a.after ?? {}).includes('9000001234')), 'no signer identifiers in the audit log');
    ok(await pvAdmin('GET', `/billing/agreements/${created.body.data.id}`), 404);
  });
});
