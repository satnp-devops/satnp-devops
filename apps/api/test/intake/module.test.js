import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toEnquiry } from '../../src/core/intake/index.js';
import { AccessContext } from '../../src/core/accessContext.js';
import { checkFormFields, defaultFields, originOf, signRenderToken, spamVerdict, submissionToEnquiry, verifyRenderToken, embedSnippet } from '../../src/modules/intake/forms.js';
import { callLeadToEnquiry, checkoutToEnquiry, emailToEnquiry, leadAdToEnquiry, signCheckout, verifyCheckout } from '../../src/modules/intake/channels.js';
import { canReview, reviewScope } from '../../src/modules/intake/review.js';
import { checkMapping, inspectCsv } from '../../src/modules/intake/imports.js';
import { crmNormalizers } from '../../src/modules/intake/settings.js';
import { DEAL_CHANNEL_BY_TYPE, originalMessageFrom, touchFrom } from '../../src/modules/intake/service.js';
import { enquirerKind, personInput } from '../../src/modules/intake/people.js';

// Unit tests for the intake module's pure parts (the engine has its own tests next to these).

const KEY = randomBytes(32);
const form = {
  id: '00000000-0000-4000-8000-000000000001',
  key: 'satForm123',
  name: 'SAT enquiry',
  audience: 'b2c',
  product_line_id: null,
  fields: [
    ...defaultFields('b2c'),
    { key: 'mode', label: 'Preferred mode', type: 'select', required: false, maps: null, options: [{ value: 'online', label: 'Online' }, { value: 'centre', label: 'At a centre' }] },
    { key: 'campaign', label: 'Campaign', type: 'hidden', required: false, maps: null, options: [], defaultValue: 'sat-dec' },
  ],
  consent: { text: 'You may contact me.', required: true, channels: ['whatsapp', 'calls'] },
  spam: { honeypot: true, minSeconds: 3, captcha: 'none', allowedOrigins: ['https://satnpaper.example'] },
  thank_you: { mode: 'message', message: 'Thanks' },
};
const parse = (input) => toEnquiry(input, { normalizers: crmNormalizers, now: Date.UTC(2026, 10, 6) });

test('form fields: unique keys and targets, a reply channel required', () => {
  assert.deepEqual(checkFormFields(defaultFields('b2c')), []);
  assert.deepEqual(checkFormFields(defaultFields('b2b')), []);
  const issues = checkFormFields([
    { key: 'a', label: 'A', type: 'text', maps: 'contact.name', options: [] },
    { key: 'a', label: 'B', type: 'text', maps: 'contact.name', options: [] },
  ]);
  assert.deepEqual(issues.map((i) => i.path), ['body.fields.1.key', 'body.fields.1.maps', 'body.fields']);
  // A checkout hand-off has no visitor fields.
  assert.deepEqual(checkFormFields([], 'checkout'), []);
});

test('submission → enquiry: mapped fields, extras in the message, consent, required checks', () => {
  const { input, issues } = submissionToEnquiry(
    form,
    { fields: { name: 'Meera Kulkarni', phone: '90000 20001', email: 'MEERA@example.com', student: 'Aditya', grade: '11', mode: 'online', message: 'Weekend batch?' }, consent: true, pageUrl: 'https://satnpaper.example/sat?utm_source=google' },
    { receivedAt: '2026-11-06T10:00:00.000Z' },
  );
  assert.deepEqual(issues, []);
  assert.equal(input.contact.name, 'Meera Kulkarni');
  assert.equal(input.student.name, 'Aditya');
  assert.match(input.interest.message, /Weekend batch\?\n\nPreferred mode: online\nCampaign: sat-dec/);
  assert.equal(input.consent.whatsapp, true);
  assert.equal(input.consent.marketing, undefined);
  const parsed = parse(input);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.enquiry.contact.phone, '+919000020001');
  assert.equal(parsed.enquiry.contact.email, 'meera@example.com');
  assert.equal(parsed.enquiry.source.utm.source, 'google');

  const bad = submissionToEnquiry(form, { fields: { name: '', phone: '12', email: 'nope', mode: 'boat' } }, { receivedAt: '2026-11-06T10:00:00.000Z' });
  assert.deepEqual(bad.issues.map((i) => i.path).sort(), ['body.consent', 'body.fields.email', 'body.fields.mode', 'body.fields.name', 'body.fields.phone'].sort());
});

test('render tokens prove when the form was shown and cannot be forged', () => {
  const now = Date.now();
  const token = signRenderToken(form.key, now - 10_000, KEY);
  assert.deepEqual(verifyRenderToken(form.key, token, KEY, now), { ok: true, ageMs: 10_000 });
  assert.equal(verifyRenderToken('otherForm1', token, KEY, now).reason, 'invalid');
  assert.equal(verifyRenderToken(form.key, `${now - 5000}.${token.split('.')[1]}`, KEY, now).reason, 'invalid');
  assert.equal(verifyRenderToken(form.key, signRenderToken(form.key, now - 25 * 3_600_000, KEY), KEY, now).reason, 'expired');
  assert.equal(verifyRenderToken(form.key, undefined, KEY, now).reason, 'missing');
});

test('spam protection: honeypot, too fast, foreign origin; a person passes', () => {
  const now = Date.now();
  const ok = { fields: {}, token: signRenderToken(form.key, now - 8000, KEY), pageUrl: 'https://satnpaper.example/sat' };
  assert.deepEqual(spamVerdict(form, ok, { key: KEY, nowMs: now, origin: originOf(ok.pageUrl) }), { spam: false, reason: null });
  assert.equal(spamVerdict(form, { ...ok, hp: 'http://spam.example' }, { key: KEY, nowMs: now, origin: null }).reason, 'honeypot');
  assert.equal(spamVerdict(form, { ...ok, token: signRenderToken(form.key, now - 1000, KEY) }, { key: KEY, nowMs: now, origin: null }).reason, 'too_fast');
  assert.equal(spamVerdict(form, { ...ok, token: undefined }, { key: KEY, nowMs: now, origin: null }).reason, 'token_missing');
  assert.equal(spamVerdict(form, ok, { key: KEY, nowMs: now, origin: 'https://evil.example' }).reason, 'origin');
  // No origin known (direct link to the hosted page) is not spam.
  assert.equal(spamVerdict(form, ok, { key: KEY, nowMs: now, origin: null }).spam, false);
  assert.equal(originOf('javascript:alert(1)'), null);
});

test('embed snippet points at the hosted page and listens only to it', () => {
  const s = embedSnippet(form, { webOrigin: 'https://crm.phoenix.example/' });
  assert.equal(s.url, 'https://crm.phoenix.example/f/satForm123');
  assert.match(s.iframe, /<iframe src="https:\/\/crm\.phoenix\.example\/f\/satForm123"/);
  assert.match(s.iframe, /e\.origin!=='https:\/\/crm\.phoenix\.example'/);
});

test('lead ads: Meta field_data and Google user_column_data become enquiries', () => {
  const meta = leadAdToEnquiry({ provider: 'facebook', leadgen_id: 'L1', form_id: 'fb-sat-2026', ad_id: 'A9', campaign_name: 'SAT Dec', created_time: 1762423200, field_data: [{ name: 'full_name', values: ['Rohit Verma'] }, { name: 'phone_number', values: ['+919000020005'] }, { name: 'which_exam?', values: ['SAT'] }] });
  assert.equal(meta.source.channel.type, 'facebook_lead_ad');
  assert.equal(meta.source.channel.identity, 'fb-sat-2026');
  assert.equal(meta.externalId, 'L1');
  assert.match(meta.interest.message, /which exam\?: SAT/);
  assert.equal(parse(meta).ok, true);
  const google = leadAdToEnquiry({ lead_id: 'G1', form_id: 77, is_test: true, user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Anjali Nair' }, { column_id: 'EMAIL', string_value: 'anjali@example.com' }] });
  assert.equal(google.source.channel.type, 'google_lead_form');
  assert.equal(google.raw.isTest, true);
  assert.equal(parse(google).enquiry.contact.email, 'anjali@example.com');
});

test('call leads: answered and missed calls; inbound email from SendGrid and Graph', () => {
  const call = callLeadToEnquiry({ provider: 'exotel', type: 'call.inbound', callId: 'CA1', status: 'in_progress', lead: { phone: '+919000020007', calledNumber: '+919000010002', digits: '2', receivedAt: '2026-11-06T09:00:00.000Z' } });
  assert.equal(call.source.channel.type, 'phone_call');
  assert.equal(call.source.channel.identity, '+919000010002');
  assert.equal(parse(call).ok, true);
  assert.equal(callLeadToEnquiry({ outcome: 'customer_missed', lead: { phone: '+919000020007' } }).source.channel.type, 'missed_call');

  const sg = emailToEnquiry({ dedupeKey: '<m1@example.com>', from: { email: 'anjali@example.com', name: 'Anjali Nair' }, to: [{ email: 'info@phoenix.example', name: null }], subject: 'Admissions', text: 'Which batches start in January?' });
  assert.equal(sg.source.channel.identity, 'info@phoenix.example');
  assert.equal(sg.contact.name, 'Anjali Nair');
  assert.match(sg.interest.message, /^Subject: Admissions/);
  const graph = emailToEnquiry({ id: 'AAMk', from: { emailAddress: { address: 'ravi@example.com', name: 'Ravi' } }, toRecipients: [{ emailAddress: { address: 'admissions@satnpaper.example' } }], subject: 'Hi', bodyPreview: 'Demo please' });
  assert.equal(graph.contact.email, 'ravi@example.com');
  assert.equal(graph.source.channel.identity, 'admissions@satnpaper.example');
  assert.equal(parse(graph).ok, true);
});

test('checkout hand-off: signature, freshness and the enquiry', () => {
  const secret = 'a'.repeat(64);
  const payload = JSON.stringify({ orderId: 'ORD-1', status: 'abandoned', product: 'SAT batch', amount: 45000, currency: 'INR', customer: { name: 'Farhan', phone: '+919000020002' } });
  const ts = 1_762_423_200;
  const signature = signCheckout(payload, ts, secret);
  assert.equal(verifyCheckout({ payload, timestamp: ts, signature }, secret, ts + 10).ok, true);
  assert.equal(verifyCheckout({ payload, timestamp: ts, signature }, secret, ts + 1000).reason, 'stale');
  assert.equal(verifyCheckout({ payload: payload.replace('45000', '1'), timestamp: ts, signature }, secret, ts).reason, 'bad_signature');
  const enquiry = checkoutToEnquiry({ id: form.id, key: form.key, audience: 'b2c', product_line_id: null }, JSON.parse(payload));
  assert.equal(enquiry.externalId, 'ORD-1');
  assert.equal(parse(enquiry).ok, true);
});

test('touches, original messages and people from an enquiry', () => {
  const { enquiry } = parse({ source: { channel: { type: 'website_form', identity: 'k' }, landingUrl: 'https://x.example/?utm_campaign=sat' }, contact: { name: 'Sunita Rao', phone: '9000020003', relation: 'parent' }, student: { name: 'Kiran Rao', grade: '10' }, interest: { message: 'Hello' } });
  assert.deepEqual(touchFrom(enquiry, 'website_form'), { channel: 'website_form', campaign: 'sat', utm: { campaign: 'sat' }, landingUrl: 'https://x.example/?utm_campaign=sat', at: enquiry.receivedAt });
  assert.match(originalMessageFrom(enquiry, 'website_form').text, /Hello\nStudent: Kiran Rao, grade 10/);
  assert.equal(enquirerKind(enquiry, 'b2c'), 'parent');
  assert.equal(enquirerKind(enquiry, 'b2b'), 'staff');
  const person = personInput(enquiry, { kind: 'parent' });
  assert.equal(person.firstName, 'Sunita');
  assert.equal(person.lastName, 'Rao');
  assert.equal(person.phones[0].value, '+919000020003');
  assert.equal(DEAL_CHANNEL_BY_TYPE.missed_call, 'voice_call');
});

test('CSV: inspect the header and check the mapping', () => {
  const info = inspectCsv('Name,Mobile No.,Email ID,Class\nMeera,9000020001,meera@example.com,11\n');
  assert.deepEqual(info.headers, ['Name', 'Mobile No.', 'Email ID', 'Class']);
  assert.equal(info.mapping[1], 'contact.phone');
  assert.equal(info.totalRows, 1);
  assert.deepEqual(checkMapping({ 0: 'contact.name', 1: 'contact.phone', 3: '' }, info.headers).issues, []);
  const bad = checkMapping({ 0: 'contact.name', 2: 'contact.name', 9: 'contact.phone' }, info.headers);
  assert.deepEqual(bad.issues.map((i) => i.path), ['body.mapping.2', 'body.mapping.9', 'body.mapping']);
  assert.throws(() => inspectCsv('"unterminated\n'), /fields need attention|Some fields/);
});

// ---------- Review queue scoping (pure) ----------

const G = '/g/';
const SP = '/g/sp/';
const PV = '/g/pv/';
const TEAM = '/g/sp/online/sat/';
const units = new Map([
  ['g', { id: 'g', type: 'group', path: G }],
  ['sp', { id: 'sp', type: 'company', path: SP }],
  ['pv', { id: 'pv', type: 'company', path: PV }],
  ['sat', { id: 'sat', type: 'team', path: TEAM }],
]);
const access = (unitPath, permissions) => new AccessContext({ userId: 'u', assignments: [{ unitPath, permissions }] });

test('review items: routing items need review at the group or a candidate company; others at their unit', () => {
  const routing = { group_id: 'g', company_id: null, candidate_company_ids: ['sp', 'pv'] };
  const duplicate = { group_id: 'g', company_id: 'sp', unit_id: 'sat' };
  assert.equal(canReview(access(G, ['intake.review']), units, routing), true);
  assert.equal(canReview(access(SP, ['intake.review']), units, routing), true);
  assert.equal(canReview(access(PV, ['intake.review']), units, { ...routing, candidate_company_ids: ['sp'] }), false);
  // A team reviewer can't take a company-level routing decision but works their duplicates.
  assert.equal(canReview(access(TEAM, ['intake.review']), units, routing), false);
  assert.equal(canReview(access(TEAM, ['intake.review']), units, duplicate), true);
  assert.equal(canReview(access(PV, ['intake.review']), units, duplicate), false);
  assert.equal(canReview(access(SP, ['intake.view']), units, duplicate), false);

  const scope = { groupId: 'g', company: null, allUnitIds: ['g', 'sp', 'pv', 'sat'] };
  assert.equal(reviewScope(scope, units).groupWide, true);
  const spScope = reviewScope({ groupId: 'g', company: units.get('sp'), allUnitIds: ['sp', 'sat'] }, units);
  assert.deepEqual([spScope.groupWide, spScope.companyIds], [false, ['sp']]);
  assert.deepEqual(reviewScope({ groupId: 'g', company: units.get('sp'), allUnitIds: ['sat'] }, units).companyIds, []);
});
