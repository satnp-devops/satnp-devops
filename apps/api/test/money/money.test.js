import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { computeTax, DEFAULT_DISCOUNT_POLICY, evaluateDiscount } from '../../src/core/billing/index.js';
import { invoiceLinesForAmount, priceQuote, taxInputFor, lutValid } from '../../src/modules/money/pricing.js';
import { discountPolicyFrom } from '../../src/modules/money/settings.js';
import { moneyEventFromRazorpay, moneyEventFromStripe, normaliseMethod, parseDigioEvent, parseRazorpayMoneyEvent, parseStripeMoneyEvent } from '../../src/modules/money/gateways.js';
import { DEV_WEBHOOK_SECRETS, configureMoneyPorts, devPaymentGateway, ports, resetMoneyPorts } from '../../src/modules/money/ports.js';
import { devDigioDelivery, normaliseSignerIdentifier, renderTemplate } from '../../src/modules/money/agreements.js';
import { textPdf, wrapText } from '../../src/modules/money/pdf.js';
import { previewInstalments } from '../../src/modules/money/quotes.js';
import { subscriptionLines } from '../../src/modules/money/subscriptions.js';
import { roleKeysAt } from '../../src/modules/money/access.js';
import { presentAgreement, presentInstalment } from '../../src/modules/money/present.js';
import { AccessContext } from '../../src/core/accessContext.js';

const supplier = { stateCode: '27', gstin: '27AAPFU0939F1ZV', lutNumber: 'AD2703', lutValidUntil: '2027-03-31', roundOff: false };
const line = (over = {}) => ({ id: 'l1', planId: null, description: 'SAT weekend batch', sac: '999293', quantity: 1, unitPriceMinor: 5_500_000, discountMinor: 0, taxRateBp: 1800, taxability: 'taxable', ...over });

test('pricing: tax-inclusive fee proposal splits CGST and SGST and totals the price', () => {
  const priced = priceQuote({ lines: [line({ discountMinor: 500_000 })], pricesIncludeTax: true, supplier, recipient: {}, currency: 'INR', onDate: '2026-11-06' });
  assert.equal(priced.totalMinor, 5_000_000);
  assert.equal(priced.subtotalMinor, 5_500_000);
  assert.equal(priced.discountMinor, 500_000);
  assert.equal(priced.result.taxKind, 'cgst_sgst');
  assert.equal(priced.result.totals.cgstMinor, priced.result.totals.sgstMinor);
  assert.equal(priced.taxableMinor + priced.taxMinor, 5_000_000);
});

test('pricing: place of supply from the recipient: other state IGST, abroad zero-rated under a valid LUT', () => {
  const inter = taxInputFor({ lines: [line()], pricesIncludeTax: false, supplier, recipient: { stateCode: '29' }, currency: 'INR', onDate: '2026-11-06' });
  assert.equal(computeTax(inter).taxKind, 'igst');
  const gstin = taxInputFor({ lines: [line()], pricesIncludeTax: false, supplier, recipient: { gstin: '29AAPFU0939F1ZR' }, currency: 'INR', onDate: '2026-11-06' });
  assert.equal(gstin.placeOfSupplyStateCode, '29');
  const exported = computeTax(taxInputFor({ lines: [line()], pricesIncludeTax: false, supplier, recipient: { outsideIndia: true }, currency: 'USD', onDate: '2026-11-06' }));
  assert.equal(exported.supplyType, 'export_under_lut');
  assert.equal(exported.totals.taxMinor, 0);
  const lapsed = computeTax(taxInputFor({ lines: [line()], pricesIncludeTax: false, supplier: { ...supplier, lutValidUntil: '2026-03-31' }, recipient: { outsideIndia: true }, currency: 'USD', onDate: '2026-11-06' }));
  assert.equal(lapsed.supplyType, 'export_with_igst');
  assert.equal(lutValid({ lutNumber: null }, '2026-11-06'), false);
  assert.throws(() => taxInputFor({ lines: [], pricesIncludeTax: true, supplier, recipient: {}, currency: 'INR', onDate: '2026-11-06' }), (err) => err.status === 422);
});

test('pricing: an instalment is invoiced pro rata over the lines and totals exactly what was paid', () => {
  const lines = [line(), line({ id: 'l2', description: 'Test series', sac: '999293', unitPriceMinor: 600_000, taxRateBp: 1800 })];
  const priced = priceQuote({ lines, pricesIncludeTax: false, supplier, recipient: {}, currency: 'INR', onDate: '2026-11-06' });
  const pricedTotals = priced.result.lines.map((l) => l.totalMinor);
  for (const amount of [1, 2_399_333, priced.totalMinor - 1]) {
    const part = invoiceLinesForAmount({ lines, pricedTotals, totalMinor: priced.totalMinor, amountMinor: amount, label: 'Instalment 1 of 3', pricesIncludeTax: false });
    const result = computeTax(taxInputFor({ ...part, supplier, recipient: {}, currency: 'INR', onDate: '2026-11-06' }));
    assert.equal(result.totals.grandTotalMinor, amount);
    assert.ok(part.lines.every((l) => l.description.endsWith('(Instalment 1 of 3)')));
  }
  const whole = invoiceLinesForAmount({ lines, pricedTotals, totalMinor: priced.totalMinor, amountMinor: priced.totalMinor, label: null, pricesIncludeTax: false });
  assert.equal(whole.lines, lines);
  assert.throws(() => invoiceLinesForAmount({ lines, pricedTotals, totalMinor: 100, amountMinor: 101, label: null, pricesIncludeTax: false }), RangeError);
});

test('discount policy from settings: tiers in basis points, out-of-order limits lifted', () => {
  const policy = discountPolicyFrom({});
  assert.equal(policy.tiers[0].maxPercentBp, 500);
  assert.equal(policy.tiers[0].maxAmountMinor, 500_000);
  assert.deepEqual(policy.tiers.map((t) => t.approverRoles), [[], ['manager'], ['company_admin']]);
  const odd = discountPolicyFrom({ 'billing.discountFreePercent': 20, 'billing.discountManagerPercent': 10, 'billing.discountCompanyPercent': 15, 'billing.discountFreeAmount': 100 }, { currencyExponent: 0 });
  assert.deepEqual(odd.tiers.map((t) => t.maxPercentBp), [2000, 2000, 2000]);
  assert.equal(odd.tiers[0].maxAmountMinor, 100);
  // Same decisions as the engine's default policy for the defaults.
  for (const discount of [100_000, 500_000, 800_000, 1_500_000, 3_000_000, 4_000_000]) {
    const input = { listAmountMinor: 10_000_000, discountMinor: discount, requesterRoles: ['counsellor'] };
    assert.equal(evaluateDiscount({ policy, ...input }).decision, evaluateDiscount({ policy: DEFAULT_DISCOUNT_POLICY, ...input }).decision, `discount ${discount}`);
  }
});

test('role keys at a unit include junior roles a senior one stands in for', () => {
  const access = new AccessContext({
    userId: 'u1',
    assignments: [
      { unitPath: '/g/', roleKey: 'group_owner', permissions: ['*'] },
      { unitPath: '/g/c/', roleKey: 'counsellor', permissions: [] },
    ],
  });
  const keys = roleKeysAt(access, '/g/c/t/');
  assert.ok(keys.includes('group_owner') && keys.includes('company_admin') && keys.includes('manager') && keys.includes('counsellor'));
  assert.deepEqual(roleKeysAt(access, '/other/'), []);
});

test('instalment preview: equal split with a first payment; bad options are 422', () => {
  const plan = previewInstalments({ count: 3, frequency: 'monthly', startDate: '2026-01-31', firstAmountMinor: 1_000_000 }, 4_000_000);
  assert.deepEqual(plan.map((i) => i.amountMinor), [1_000_000, 1_500_000, 1_500_000]);
  assert.deepEqual(plan.map((i) => i.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.throws(() => previewInstalments({ count: 3, frequency: 'monthly', startDate: '2026-01-31', firstAmountMinor: 4_000_000 }, 4_000_000), (err) => err.status === 422);
});

test('subscription lines: plan seats and add-ons at the plan SAC and rate', () => {
  const lines = subscriptionLines(
    { quantity: 3, unit: 'branch', unit_price_minor: '12000000', addons: [{ code: 'ADM', name: 'Admissions', quantity: 3, unitPriceMinor: 4_000_000 }] },
    { id: 'p1', name: 'Campus ERP', sac: '997331', tax_rate_bp: 1800, taxability: 'taxable' },
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].description, 'Campus ERP: 3 branches');
  assert.equal(lines[0].unitPriceMinor, 12_000_000);
  assert.equal(lines[1].sac, '997331');
});

// ---------- Webhook verification and normalisation ----------

const razorpayBody = (event, extra = {}) =>
  JSON.stringify({
    entity: 'event',
    account_id: 'acc_1',
    event,
    contains: ['payment'],
    payload: {
      payment: { entity: { id: 'pay_1', amount: 180000, currency: 'INR', status: event === 'payment.failed' ? 'failed' : 'captured', method: 'upi', notes: { phoenix_payment_id: '11111111-1111-4111-8111-111111111111' }, error_code: event === 'payment.failed' ? 'BAD_REQUEST_ERROR' : null, error_description: event === 'payment.failed' ? 'Declined' : null, fee: 4248, tax: 648 } },
      ...extra,
    },
    created_at: Math.floor(Date.now() / 1000),
  });
const sign = (body, secret = DEV_WEBHOOK_SECRETS.razorpay) => createHmac('sha256', secret).update(body).digest('hex');

test('razorpay webhooks: verified and normalised; bad signatures and other accounts are 401', () => {
  const body = razorpayBody('payment.captured');
  const event = parseRazorpayMoneyEvent(Buffer.from(body), { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_1' }, DEV_WEBHOOK_SECRETS.razorpay);
  assert.equal(event.action, 'payment_succeeded');
  assert.equal(event.dedupeKey, 'razorpay:evt_1');
  assert.equal(event.reference, '11111111-1111-4111-8111-111111111111');
  assert.equal(event.payment.amountMinor, 180000);
  assert.equal(event.payment.method, 'upi');
  assert.equal(event.payment.feeMinor, 4248);
  assert.throws(() => parseRazorpayMoneyEvent(Buffer.from(body), { 'x-razorpay-signature': sign(body, 'wrong') }, DEV_WEBHOOK_SECRETS.razorpay), (err) => err.status === 401 && err.details.reason === 'signature_mismatch');
  assert.throws(() => parseRazorpayMoneyEvent(Buffer.from(body), {}, DEV_WEBHOOK_SECRETS.razorpay), (err) => err.status === 401);
  assert.throws(() => parseRazorpayMoneyEvent(Buffer.from(body), { 'x-razorpay-signature': sign(body) }, DEV_WEBHOOK_SECRETS.razorpay, { accountRef: 'acc_other' }), (err) => err.status === 401);
  const failed = razorpayBody('payment.failed');
  const failure = parseRazorpayMoneyEvent(Buffer.from(failed), { 'x-razorpay-signature': sign(failed) }, DEV_WEBHOOK_SECRETS.razorpay);
  assert.equal(failure.action, 'payment_failed');
  assert.equal(failure.payment.failure.code, 'BAD_REQUEST_ERROR');
  assert.match(failure.dedupeKey, /^razorpay:derived:/);
  assert.equal(moneyEventFromRazorpay({ kind: 'subscription.charged', dedupeKey: 'k', type: 'subscription.charged' }).action, null);
});

test('stripe webhooks: t=/v1= signature with tolerance; checkout completion is a success', () => {
  const gateway = devPaymentGateway('stripe');
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: 'evt_s1',
    object: 'event',
    type: 'checkout.session.completed',
    created,
    data: { object: { id: 'cs_1', object: 'checkout.session', amount_total: 69900, currency: 'usd', payment_status: 'paid', status: 'complete', payment_intent: 'pi_1', payment_link: 'plink_1', metadata: { phoenix_payment_id: '22222222-2222-4222-8222-222222222222' } } },
  });
  const signature = createHmac('sha256', DEV_WEBHOOK_SECRETS.stripe).update(`${created}.${body}`).digest('hex');
  const event = gateway.parseWebhook(Buffer.from(body), { 'stripe-signature': `t=${created},v1=${signature}` });
  assert.equal(event.action, 'payment_succeeded');
  assert.equal(event.dedupeKey, 'stripe:evt_s1');
  assert.equal(event.payment.amountMinor, 69900);
  assert.equal(event.payment.currency, 'USD');
  assert.equal(event.linkId, 'plink_1');
  const old = created - 3600;
  const oldSig = createHmac('sha256', DEV_WEBHOOK_SECRETS.stripe).update(`${old}.${body}`).digest('hex');
  assert.throws(() => parseStripeMoneyEvent(Buffer.from(body), { 'stripe-signature': `t=${old},v1=${oldSig}` }, DEV_WEBHOOK_SECRETS.stripe), (err) => err.status === 401);
  assert.equal(moneyEventFromStripe({ id: 'e', type: 'checkout.session.completed', kind: 'checkout.completed', payment: { paid: false } }).action, 'payment_pending');
});

test('digio webhooks: checksum verified, completion and failure normalised', () => {
  const agreement = { ref: 'SP-AG-0001', provider_document_id: 'DID1', signers: [{ name: 'Priya', identifier: '9000001234', status: 'pending', signType: 'aadhaar' }] };
  const signed = devDigioDelivery({ agreement, outcome: 'signed', eventId: 'NTF1' });
  const event = parseDigioEvent(signed.rawBody, signed.headers, DEV_WEBHOOK_SECRETS.digio);
  assert.equal(event.type, 'esign.document.completed');
  assert.equal(event.documentId, 'DID1');
  assert.equal(event.completed, true);
  const failed = devDigioDelivery({ agreement, outcome: 'rejected', eventId: 'NTF2' });
  assert.equal(parseDigioEvent(failed.rawBody, failed.headers, DEV_WEBHOOK_SECRETS.digio).type, 'esign.signer.rejected');
  assert.throws(() => parseDigioEvent(signed.rawBody, { 'x-digio-checksum': '0'.repeat(64) }, DEV_WEBHOOK_SECRETS.digio), (err) => err.status === 401);
});

test('payment methods are normalised to the platform vocabulary', () => {
  assert.equal(normaliseMethod('UPI'), 'upi');
  assert.equal(normaliseMethod('cardless_emi'), 'emi');
  assert.equal(normaliseMethod('crypto'), 'other');
  assert.equal(normaliseMethod(null), null);
});

test('ports: stubs can be replaced (integrator, tests) and reset', async () => {
  configureMoneyPorts({ notify: async () => ({ queued: true }) });
  assert.deepEqual(await ports.notify({}), { queued: true });
  assert.throws(() => configureMoneyPorts({ nope: () => {} }), /Unknown money port/);
  resetMoneyPorts();
  assert.deepEqual(await ports.notify({ template: 't', idempotencyKey: 'k' }), { queued: false });
});

// ---------- Agreements and documents ----------

test('agreement templates: placeholders filled, unknown ones blank; signer identifiers normalised', () => {
  assert.equal(renderTemplate('Dear {{customer.name}}, fee {{quote.total}}{{nope}}.', { 'customer.name': 'Priya', 'quote.total': '₹18,000' }), 'Dear Priya, fee ₹18,000.');
  assert.equal(normaliseSignerIdentifier('+91 90000-01234'), '9000001234');
  assert.equal(normaliseSignerIdentifier('09000001234'), '9000001234');
  assert.equal(normaliseSignerIdentifier(' Priya@Example.com '), 'priya@example.com');
  assert.equal(normaliseSignerIdentifier('12345'), null);
  assert.equal(normaliseSignerIdentifier('+1 415 555 0100'), null);
});

test('agreement signers are masked without contacts.view_pii, and sign links hidden', () => {
  const row = { id: 'a', ref: 'SP-AG-1', title: 't', company_id: 'c', status: 'sent', sign_type: 'aadhaar', signers: [{ name: 'P', role: 'parent', order: 1, identifier: '9000001234', status: 'pending', signUrl: 'https://x' }, { name: 'Q', role: 'parent', order: 2, identifier: 'q@example.com', status: 'pending' }], created_at: new Date() };
  const masked = presentAgreement(row, { canViewPii: false });
  assert.notEqual(masked.signers[0].identifier, '9000001234');
  assert.ok(!masked.signers[1].identifier.startsWith('q@example'));
  assert.equal(masked.signers[0].signUrl, null);
  assert.equal(masked.signers[0].identifierMasked, true);
  const open = presentAgreement(row, { canViewPii: true });
  assert.equal(open.signers[0].identifier, '9000001234');
  assert.equal(open.signers[0].signUrl, 'https://x');
});

test('instalment state: overdue, due today, upcoming', () => {
  const base = { id: 'i', plan_id: 'p', company_id: 'c', number: 1, amount_minor: '100', paid_minor: '0', currency: 'INR', status: 'pending' };
  assert.equal(presentInstalment({ ...base, due_date: '2026-11-01' }, '2026-11-06').state, 'overdue');
  assert.equal(presentInstalment({ ...base, due_date: '2026-11-06' }, '2026-11-06').state, 'due_today');
  assert.equal(presentInstalment({ ...base, due_date: '2026-12-06' }, '2026-11-06').state, 'upcoming');
  assert.equal(presentInstalment({ ...base, status: 'paid', paid_minor: '100', due_date: '2026-11-01' }, '2026-11-06').state, 'paid');
});

test('agreement PDF: a valid PDF with every line, Latin-1 only', () => {
  const body = Array.from({ length: 120 }, (_, i) => `Clause ${i + 1}: the fee of ₹18,000 is payable — in advance (see "terms").`).join('\n');
  const pdf = textPdf({ title: 'Fee agreement SP-AG-0001', body, footer: 'SP-AG-0001' });
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 3 /);
  assert.ok(text.includes('Rs. 18,000'));
  assert.ok(!text.includes('₹'));
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  assert.deepEqual(wrapText('a '.repeat(100).trim(), 20).every((l) => l.length <= 20), true);
  assert.equal(wrapText('x'.repeat(45), 20).length, 3);
});
