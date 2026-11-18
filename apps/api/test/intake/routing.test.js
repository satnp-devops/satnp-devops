import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLD,
  decideRoute,
  matchIdentities,
  normalizeIdentity,
  resolveChannel,
  route,
  thresholdFor,
} from '../../src/core/intake/routing.js';

// Phoenix companies: Pi Vector (test prep), SatnPaper (SAT and admissions abroad), Scholiq (B2B software).
const identities = [
  { id: 'wa-pi', type: 'whatsapp', identity: '+91 98100 00001', companyId: 'pi-vector' },
  { id: 'wa-sat', type: 'whatsapp', identity: '09810000002', companyId: 'satnpaper' },
  { id: 'wa-group', type: 'whatsapp', identity: '+919810000009', shared: true, companyIds: ['pi-vector', 'satnpaper', 'scholiq'] },
  { id: 'mail-scholiq', type: 'email', identity: 'Sales@Scholiq.in', companyId: 'scholiq' },
  { id: 'web-sat', type: 'landing_page', identity: 'satnpaper.com', companyId: 'satnpaper' },
  { id: 'web-sat-ug', type: 'landing_page', identity: 'https://www.satnpaper.com/ug-admissions/', companyId: 'satnpaper', productLineId: 'ug-abroad' },
  { id: 'fair', type: 'event', identity: 'EDU-FAIR-2026', shared: true },
  { id: 'broken', type: 'phone_call', identity: '+918000000000' },
];

const shared = { type: 'whatsapp', identity: '+91 98100 00009' };

test('identities are normalised per channel type', () => {
  assert.equal(normalizeIdentity('whatsapp', '098100 00001'), '+919810000001');
  assert.equal(normalizeIdentity('email', ' Sales@Scholiq.IN '), 'sales@scholiq.in');
  assert.equal(normalizeIdentity('landing_page', 'https://WWW.SatnPaper.com/sat/?utm_source=x#top'), 'satnpaper.com/sat');
  assert.equal(normalizeIdentity('website_form', 'Form-42'), 'form-42');
  assert.equal(normalizeIdentity('whatsapp', ''), '');
  assert.equal(normalizeIdentity('whatsapp', null), '');
});

test('an owned channel routes to its company with full confidence', async () => {
  const result = await route({ channel: { type: 'whatsapp', identity: '9810000001' }, identities });
  assert.equal(result.decision, 'route');
  assert.equal(result.companyId, 'pi-vector');
  assert.equal(result.confidence, 1);
  assert.equal(result.reason, 'owned_channel');
  assert.equal(result.identityId, 'wa-pi');
  assert.equal(result.shared, false);
  assert.equal(result.productLineId, undefined);
});

test('an owned channel never calls the classifier by default', async () => {
  let calls = 0;
  const result = await route({
    channel: { type: 'email', identity: 'sales@scholiq.in' },
    identities,
    classify: () => {
      calls += 1;
      return { companyId: 'pi-vector', confidence: 1 };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.companyId, 'scholiq');
});

test('web channels match by host and path prefix, most specific first', () => {
  const page = (url) => resolveChannel({ type: 'landing_page', identity: url }, identities);
  const ug = page('https://satnpaper.com/ug-admissions/canada?utm_source=google');
  assert.equal(ug.kind, 'owned');
  assert.equal(ug.identity.productLineId, 'ug-abroad');
  assert.equal(page('https://blog.satnpaper.com/post').identity.id, 'web-sat', 'subdomains are covered by the host');
  assert.equal(page('https://satnpaper.com/sat').identity.id, 'web-sat');
  assert.equal(page('https://notsatnpaper.com/').kind, 'unknown', 'a different host that ends the same way is not covered');
  assert.equal(page('https://satnpaper.com/ug-admissionsX').identity.id, 'web-sat', 'path prefixes stop at a segment');
});

test('a registration that fixes the product line routes there', async () => {
  const result = await route({ channel: { type: 'landing_page', identity: 'https://satnpaper.com/ug-admissions' }, identities });
  assert.deepEqual([result.decision, result.companyId, result.productLineId], ['route', 'satnpaper', 'ug-abroad']);
});

test('on a shared channel a confident classification routes', async () => {
  const seen = [];
  const result = await route({
    channel: shared,
    identities,
    enquiry: { interest: { message: 'SAT coaching for my daughter' } },
    classify: (request) => {
      seen.push(request);
      return { companyId: 'satnpaper', productLineId: 'sat-prep', confidence: 0.91, rationale: 'Mentions SAT' };
    },
  });
  assert.equal(result.decision, 'route');
  assert.equal(result.reason, 'classified');
  assert.equal(result.companyId, 'satnpaper');
  assert.equal(result.productLineId, 'sat-prep');
  assert.equal(result.confidence, 0.91);
  assert.equal(result.threshold, DEFAULT_THRESHOLD);
  assert.equal(result.shared, true);
  assert.deepEqual(seen[0].companyIds, ['pi-vector', 'satnpaper', 'scholiq'], 'the classifier is told which companies are possible');
  assert.deepEqual(seen[0].enquiry, { interest: { message: 'SAT coaching for my daughter' } });
});

test('low confidence goes to review, keeping the best guess', async () => {
  const result = await route({ channel: shared, identities, classify: async () => ({ companyId: 'pi-vector', confidence: 0.6 }) });
  assert.equal(result.decision, 'review');
  assert.equal(result.reason, 'low_confidence');
  assert.equal(result.companyId, 'pi-vector');
  assert.equal(result.confidence, 0.6);
  assert.equal(result.threshold, 0.75);
});

test('thresholds are per company', async () => {
  const thresholds = { default: 0.7, byCompany: { scholiq: 0.9 } };
  const classify = (companyId, confidence) => () => ({ companyId, confidence });
  const a = await route({ channel: shared, identities, thresholds, classify: classify('pi-vector', 0.72) });
  assert.equal(a.decision, 'route');
  const b = await route({ channel: shared, identities, thresholds, classify: classify('scholiq', 0.85) });
  assert.equal(b.decision, 'review');
  assert.equal(b.threshold, 0.9);
  const c = await route({ channel: shared, identities, thresholds, classify: classify('scholiq', 0.9) });
  assert.equal(c.decision, 'route', 'the threshold itself passes');
  assert.equal(thresholdFor(0.5, 'x'), 0.5);
  assert.equal(thresholdFor(undefined, 'x'), DEFAULT_THRESHOLD);
  assert.equal(thresholdFor({ byCompany: { y: 0.1 } }, 'x'), DEFAULT_THRESHOLD);
});

test('two companies too close to call go to review', async () => {
  const result = await route({
    channel: shared,
    identities,
    classify: () => ({ companyId: 'satnpaper', confidence: 0.86, alternatives: [{ companyId: 'pi-vector', confidence: 0.8 }, { companyId: 'satnpaper', productLineId: 'ug', confidence: 0.85 }] }),
  });
  assert.equal(result.decision, 'review');
  assert.equal(result.reason, 'ambiguous');
  const clear = await route({
    channel: shared,
    identities,
    minMargin: 0.05,
    classify: () => ({ companyId: 'satnpaper', confidence: 0.86, alternatives: [{ companyId: 'pi-vector', confidence: 0.8 }] }),
  });
  assert.equal(clear.decision, 'route');
});

test('alternatives outside the channel scope do not make it ambiguous', async () => {
  const result = await route({
    channel: shared,
    identities,
    classify: () => ({ companyId: 'satnpaper', confidence: 0.9, alternatives: [{ companyId: 'excel', confidence: 0.89 }] }),
  });
  assert.equal(result.decision, 'route');
});

test('a classification outside the channel scope goes to review', async () => {
  const result = await route({ channel: shared, identities, classify: () => ({ companyId: 'excel', confidence: 0.99 }) });
  assert.equal(result.decision, 'review');
  assert.equal(result.reason, 'out_of_scope');
});

test('a shared channel without a company list accepts any company', async () => {
  const result = await route({ channel: { type: 'event', identity: 'edu-fair-2026' }, identities, classify: () => ({ companyId: 'excel', confidence: 0.95 }) });
  assert.equal(result.decision, 'route');
  assert.equal(result.companyId, 'excel');
});

test('classifier failures go to review', async () => {
  const thrown = await route({ channel: shared, identities, classify: async () => { throw new Error('timeout'); } });
  assert.equal(thrown.reason, 'classifier_error');
  const missing = await route({ channel: shared, identities });
  assert.equal(missing.reason, 'no_classifier');
  for (const answer of [{ companyId: 'satnpaper' }, { companyId: 'satnpaper', confidence: 1.4 }, { companyId: '', confidence: 0.9 }, 'satnpaper', 42]) {
    const invalid = await route({ channel: shared, identities, classify: () => answer });
    assert.equal(invalid.reason, 'classifier_invalid', JSON.stringify(answer));
    assert.equal(invalid.decision, 'review');
  }
});

test('null product lines from the classifier are dropped', async () => {
  const result = await route({ channel: shared, identities, classify: () => ({ companyId: 'satnpaper', productLineId: null, confidence: 0.9, alternatives: [{ companyId: 'pi-vector', productLineId: null, confidence: 0.1 }] }) });
  assert.equal(result.decision, 'route');
  assert.equal('productLineId' in result, false);
  assert.equal('productLineId' in result.classification.alternatives[0], false);
});

test('unknown and misconfigured channels go to review', async () => {
  const unknown = await route({ channel: { type: 'whatsapp', identity: '+919999911111' }, identities, classify: () => ({ companyId: 'pi-vector', confidence: 1 }) });
  assert.deepEqual([unknown.decision, unknown.reason, unknown.companyId], ['review', 'unknown_channel', null]);
  const noIdentity = await route({ channel: { type: 'whatsapp' }, identities });
  assert.equal(noIdentity.reason, 'unknown_channel');
  const broken = await route({ channel: { type: 'phone_call', identity: '8000000000' }, identities });
  assert.equal(broken.reason, 'misconfigured_identity');
  const otherType = await route({ channel: { type: 'sms', identity: '+919810000001' }, identities });
  assert.equal(otherType.reason, 'unknown_channel', 'identities only match their own channel type');
});

test('the same number registered by two companies is treated as shared between them', async () => {
  const clash = [...identities, { type: 'whatsapp', identity: '+919810000001', companyId: 'scholiq' }];
  const resolved = resolveChannel({ type: 'whatsapp', identity: '+919810000001' }, clash);
  assert.equal(resolved.kind, 'shared');
  assert.deepEqual(resolved.companyIds, ['pi-vector', 'scholiq']);
  assert.deepEqual(resolved.warnings, ['conflicting_identities']);
  const result = await route({ channel: { type: 'whatsapp', identity: '+919810000001' }, identities: clash, classify: () => ({ companyId: 'satnpaper', confidence: 1 }) });
  assert.equal(result.reason, 'out_of_scope');
});

test('two registrations of one company with different product lines drop the product line', () => {
  const twice = [
    { type: 'whatsapp', identity: '+919810000005', companyId: 'pi-vector', productLineId: 'jee' },
    { type: 'whatsapp', identity: '+919810000005', companyId: 'pi-vector', productLineId: 'neet' },
  ];
  const result = decideRoute({ channel: { type: 'whatsapp', identity: '+919810000005' }, identities: twice });
  assert.equal(result.companyId, 'pi-vector');
  assert.equal(result.productLineId, undefined);
  assert.deepEqual(result.warnings, ['conflicting_product_lines']);
});

test('classifyOwned picks a product line on an owned channel but never changes the company', async () => {
  const channel = { type: 'whatsapp', identity: '+919810000001' };
  const confident = await route({ channel, identities, classifyOwned: true, classify: (req) => ({ companyId: req.companyIds[0], productLineId: 'jee', confidence: 0.9 }) });
  assert.deepEqual([confident.decision, confident.companyId, confident.productLineId], ['route', 'pi-vector', 'jee']);
  const unsure = await route({ channel, identities, classifyOwned: true, classify: () => ({ companyId: 'pi-vector', productLineId: 'jee', confidence: 0.3 }) });
  assert.equal(unsure.decision, 'route');
  assert.equal(unsure.productLineId, undefined);
  assert.ok(unsure.warnings.includes('product_line_low_confidence'));
  const otherCompany = await route({ channel, identities, classifyOwned: true, classify: () => ({ companyId: 'satnpaper', productLineId: 'sat', confidence: 1 }) });
  assert.deepEqual([otherCompany.companyId, otherCompany.productLineId], ['pi-vector', undefined]);
  const failing = await route({ channel, identities, classifyOwned: true, classify: () => { throw new Error('down'); } });
  assert.equal(failing.decision, 'route');
  assert.ok(failing.warnings.includes('classifier_error'));
});

test('decideRoute is the synchronous core', () => {
  const result = decideRoute({ channel: shared, identities, classification: { companyId: 'pi-vector', confidence: 0.8 } });
  assert.equal(result.decision, 'route');
  assert.equal(decideRoute({ channel: shared, identities }).reason, 'no_classifier');
});

test('matchIdentities returns nothing for an empty registry', () => {
  assert.deepEqual(matchIdentities(shared, []), []);
});
