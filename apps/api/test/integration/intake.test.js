import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { defaultFields, signRenderToken } from '../../src/modules/intake/forms.js';
import { signCheckout, handleCallLead } from '../../src/modules/intake/channels.js';
import { processImportJob } from '../../src/modules/intake/imports.js';
import { connectIntakePorts, resetIntakePorts } from '../../src/modules/intake/ports.js';

// Intake end to end against Postgres + Redis (migrated and seeded: db:migrate, db:seed, roles:sync).
// Unique numbers and names per run, so it can run repeatedly.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const LETTERS = RUN.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]).replace(/^./, (c) => c.toUpperCase());
const phone = () => `+9198${String(randomInt(10_000_000, 99_999_999))}`;

function client(base) {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* CSV downloads */
    }
    return { status: res.status, body: parsed };
  };
}

test('Intake end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const registry = buildRegistry();
  const app = createApp({ registry, modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => {
    resetIntakePorts();
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
  const sp = byCode('satnpaper');
  const pv = byCode('pi-vector');
  const satTeam = byCode('sat-admissions');
  const online = byCode('online');
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  assert.ok(await db('intake_assignment_pools').where({ company_id: sp.id }).first(), 'run the intake seed (32_intake.js) first');

  const signIn = async (email) => {
    const c = client(base);
    const res = await c('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
    return c;
  };
  const owner = await signIn('owner@phoenix.test');
  const spAdmin = await signIn('admin.satnpaper@phoenix.test');
  const pvAdmin = await signIn('admin.pivector@phoenix.test');
  const kabir = await signIn('kabir@phoenix.test');
  const ritika = await signIn('ritika@phoenix.test');
  const visitor = client(base);

  const pool = await db('intake_assignment_pools').where({ company_id: sp.id, kind: 'b2c', is_default: true }).first();
  let form;
  const submit = async (f, fields, extra = {}) =>
    visitor('POST', `/public/forms/${f.key}/submissions`, { fields, consent: true, token: signRenderToken(f.key, Date.now() - 10_000, env.encryptionKey), pageUrl: 'https://satnpaper.example/sat', ...extra });
  const latestEnquiry = (formId) => db('intake_enquiries').where({ form_id: formId }).orderBy('created_at', 'desc').first();

  await t.test('forms: a company admin builds one; another company cannot see it', async () => {
    const fields = [...defaultFields('b2c'), { key: 'city', label: 'City', type: 'text', maps: 'contact.city' }];
    const res = await spAdmin('POST', '/intake/forms', { companyId: sp.id, name: `Test form ${RUN}`, audience: 'b2c', unitId: satTeam.id, fields, consent: { text: 'You may contact me on WhatsApp and by phone.', required: true, channels: ['whatsapp', 'calls'] }, spam: { honeypot: true, minSeconds: 3, captcha: 'none', allowedOrigins: [], perIpPerHour: 50 } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    form = res.body.data;
    assert.match(form.embed.iframe, new RegExp(`/f/${form.key}`));
    const bad = await spAdmin('POST', '/intake/forms', { companyId: sp.id, name: 'No reply', audience: 'b2c', fields: [{ key: 'name', label: 'Name', type: 'text', maps: 'contact.name' }] });
    assert.equal(bad.status, 422);
    assert.equal((await pvAdmin('GET', `/intake/forms/${form.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/intake/forms?companyId=${sp.id}`)).status, 404);
    assert.equal((await kabir('POST', '/intake/forms', { companyId: sp.id, name: 'x', audience: 'b2c' })).status, 403);
    const shown = await visitor('GET', `/public/forms/${form.key}`);
    assert.equal(shown.status, 200);
    assert.ok(shown.body.data.token);
    assert.equal(shown.body.data.fields.find((f) => f.key === 'phone').required, true);
    // Predictable round-robin for this run: no caps.
    const members = await spAdmin('PUT', `/intake/pools/${pool.id}/members`, {
      members: [
        { userId: users.get('kabir@phoenix.test'), capacity: null, languages: ['en', 'hi'] },
        { userId: users.get('ritika@phoenix.test'), capacity: null, languages: ['en'] },
      ],
    });
    assert.equal(members.status, 200, JSON.stringify(members.body));
    assert.equal((await spAdmin('PUT', `/intake/pools/${pool.id}/members`, { members: [{ userId: users.get('admin.pivector@phoenix.test') }] })).status, 422);
  });

  await t.test('form spam protection: honeypot, too fast, captcha, per-form rate limit', async () => {
    const before = await db('intake_forms').where({ id: form.id }).first('spam_count', 'submission_count');
    const honeypot = await submit(form, { name: 'Bot', phone: phone() }, { hp: 'http://spam.example' });
    assert.equal(honeypot.status, 201);
    const fast = await visitor('POST', `/public/forms/${form.key}/submissions`, { fields: { name: 'Bot', phone: phone() }, consent: true, token: signRenderToken(form.key, Date.now() - 500, env.encryptionKey) });
    assert.equal(fast.status, 201);
    const noToken = await visitor('POST', `/public/forms/${form.key}/submissions`, { fields: { name: 'Bot', phone: phone() }, consent: true });
    assert.equal(noToken.status, 201);
    const after = await db('intake_forms').where({ id: form.id }).first('spam_count', 'submission_count');
    assert.equal(after.spam_count - before.spam_count, 3);
    assert.equal(after.submission_count, before.submission_count, 'spam is not stored');
    assert.equal((await submit(form, { name: 'No consent', phone: phone() }, { consent: false })).status, 422);
    assert.equal((await submit(form, { name: 'Bad', phone: '12' })).status, 422);
    assert.equal((await visitor('POST', `/public/forms/${form.key}/submissions`, { fields: {} }, { 'x-phoenix-client': '' })).status, 403, 'the client header is required');

    const captcha = await spAdmin('POST', '/intake/forms', { companyId: sp.id, name: `Captcha ${RUN}`, audience: 'b2c', unitId: satTeam.id, spam: { honeypot: true, minSeconds: 0, captcha: 'turnstile', allowedOrigins: [], perIpPerHour: 2 } });
    assert.equal(captcha.status, 201);
    const cf = captcha.body.data;
    assert.equal((await submit(cf, { name: `Cap ${LETTERS}`, phone: phone() })).status, 422);
    assert.equal((await submit(cf, { name: `Cap ${LETTERS}`, phone: phone() }, { captchaToken: 'dev-pass' })).status, 201);
    assert.equal((await submit(cf, { name: `Cap ${LETTERS}`, phone: phone() }, { captchaToken: 'dev-pass' })).status, 429, 'perIpPerHour');
    assert.equal((await visitor('GET', `/public/forms/${cf.key}x`)).status, 404);
  });

  let meeraPhone;
  let meeraDealId;
  await t.test('owned channel → new person, new lead, round-robin owner, first-reply SLA, consent', async () => {
    meeraPhone = phone();
    const ownersSeen = new Set();
    for (const [i, name] of [`Meera ${LETTERS}`, `Farhan ${LETTERS}`].entries()) {
      const res = await submit(form, { name, phone: i === 0 ? meeraPhone : phone(), student: `Child ${LETTERS}`, message: 'Weekend batch?' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.thankYou.mode, 'message');
      const e = await latestEnquiry(form.id);
      assert.equal(e.status, 'processed', e.failure);
      assert.equal(e.outcome, 'created');
      assert.equal(e.dedup_decision, 'new');
      assert.equal(e.routing_reason, 'owned_channel');
      assert.equal(e.company_id, sp.id);
      const deal = await db('deals').where({ id: e.deal_id }).first();
      assert.equal(deal.unit_id, satTeam.id, 'lands in the pool unit');
      assert.equal(deal.channel, 'website_form');
      assert.ok(deal.first_reply_due_at, 'first-reply SLA started');
      assert.equal(deal.source_event_id, `intake:${e.id}`);
      assert.equal(e.assignment.method, 'round_robin');
      ownersSeen.add(deal.owner_user_id);
      const students = await db('deal_contacts').where({ deal_id: deal.id, role: 'student' });
      assert.equal(students.length, 1);
      if (i === 0) {
        meeraDealId = deal.id;
        const consents = await db('consents').where({ contact_id: e.contact_id });
        assert.deepEqual(consents.map((c) => `${c.channel}:${c.purpose}`).sort(), ['voice:service', 'whatsapp:service']);
        const events = await db('outbox_events').where({ aggregate_id: deal.id, type: 'lead.created' });
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.contactMatch, 'new');
      }
    }
    assert.equal(ownersSeen.size, 2, 'consecutive leads go to different counsellors');
  });

  await t.test('dedup: the same person again is merged into their open lead (history kept)', async () => {
    const res = await submit(form, { name: `Meera ${LETTERS}`, phone: meeraPhone.replace('+91', ''), email: `meera.${RUN}@example.com`, message: 'Also mentorship?' });
    assert.equal(res.status, 201);
    const e = await latestEnquiry(form.id);
    assert.equal(e.dedup_decision, 'merge');
    assert.equal(e.outcome, 'merged');
    assert.equal(e.deal_id, meeraDealId);
    const methods = await db('contact_methods').where({ contact_id: e.contact_id });
    assert.deepEqual(methods.map((m) => m.kind).sort(), ['email', 'phone'], 'the new email was added to the person');
    const entries = await db('timeline_events').where({ deal_id: meeraDealId }).orderBy('id');
    assert.ok(entries.some((x) => x.meta?.action === 'intake.enquiry'));
    assert.equal((await db('outbox_events').where({ aggregate_id: meeraDealId, type: 'lead.merged' })).length, 1);
  });

  await t.test('a lost lead is reopened and keeps its owner (returning family)', async () => {
    const deal = await db('deals').where({ id: meeraDealId }).first();
    const lostStage = await db('pipeline_stages').where({ pipeline_id: deal.pipeline_id, category: 'lost' }).first();
    const reason = await db('lost_reasons').where({ company_id: sp.id }).first();
    await db('deals').where({ id: deal.id }).update({ stage_id: lostStage.id, status: 'lost', lost_reason_id: reason.id, closed_at: db.fn.now() });
    const res = await submit(form, { name: `Meera ${LETTERS}`, phone: meeraPhone });
    assert.equal(res.status, 201);
    const e = await latestEnquiry(form.id);
    assert.equal(e.outcome, 'reopened', e.failure);
    const reopened = await db('deals').where({ id: deal.id }).first();
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.owner_user_id, deal.owner_user_id);
    assert.equal(e.assignment.method, 'existing_owner');
  });

  let duplicateItem;
  await t.test('dedup: a similar name in the same city with a new number is suggested, and a reviewer merges', async () => {
    const first = await submit(form, { name: `Rahul ${LETTERS} Sharma`, phone: phone(), city: 'Nagpur' });
    assert.equal(first.status, 201);
    const a = await latestEnquiry(form.id);
    assert.equal(a.dedup_decision, 'new');
    const second = await submit(form, { name: `Rahul ${LETTERS} Sharma`, phone: phone(), city: 'Nagpur' });
    assert.equal(second.status, 201);
    const b = await latestEnquiry(form.id);
    assert.equal(b.dedup_decision, 'suggest', JSON.stringify(b.dedup));
    assert.notEqual(b.contact_id, a.contact_id, 'a suggestion never merges by itself');
    duplicateItem = await db('intake_review_items').where({ enquiry_id: b.id, kind: 'duplicate' }).first();
    assert.equal(duplicateItem.candidate_contact_id, a.contact_id);
    assert.equal(duplicateItem.unit_id, satTeam.id);
  });

  await t.test('review queue scoping', async () => {
    const asOwner = await owner('GET', `/intake/review?unitId=${group.id}&kind=duplicate`);
    assert.equal(asOwner.status, 200);
    const item = asOwner.body.data.find((i) => i.id === duplicateItem.id);
    assert.ok(item);
    assert.match(item.candidate.primaryPhone, /^\+91/, 'owner sees personal data');
    // Kabir (manager of SatnPaper › Online) reviews duplicates in his units, not company routing decisions.
    const asKabir = await kabir('GET', `/intake/review?unitId=${online.id}`);
    assert.equal(asKabir.status, 200);
    assert.ok(asKabir.body.data.some((i) => i.id === duplicateItem.id));
    assert.ok(asKabir.body.data.every((i) => i.kind !== 'routing'));
    // Pi Vector's admin sees nothing of SatnPaper.
    assert.equal((await pvAdmin('GET', `/intake/review?unitId=${sp.id}`)).status, 404);
    const pvQueue = await pvAdmin('GET', `/intake/review?unitId=${pv.id}`);
    assert.equal(pvQueue.status, 200);
    assert.ok(pvQueue.body.data.every((i) => i.kind === 'routing' || i.companyId === pv.id));
    assert.equal((await pvAdmin('POST', `/intake/review/${duplicateItem.id}/resolve`, { action: 'merge' })).status, 404);
    // Counsellors don't review.
    assert.equal((await ritika('GET', `/intake/review?unitId=${satTeam.id}`)).status, 403);
    const counts = await spAdmin('GET', `/intake/review/counts?unitId=${sp.id}`);
    assert.ok(counts.body.data.duplicate >= 1);
  });

  await t.test('a reviewer merges the possible duplicate: one person, the lead moves with them', async () => {
    assert.equal((await kabir('POST', `/intake/review/${duplicateItem.id}/resolve`, { action: 'approve' })).status, 422);
    const res = await kabir('POST', `/intake/review/${duplicateItem.id}/resolve`, { action: 'merge' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const merged = await db('contacts').where({ id: duplicateItem.contact_id }).first();
    assert.equal(merged.merged_into_id, duplicateItem.candidate_contact_id);
    const deal = await db('deals').where({ id: duplicateItem.deal_id }).first();
    assert.equal(deal.primary_contact_id, duplicateItem.candidate_contact_id);
    assert.equal((await kabir('POST', `/intake/review/${duplicateItem.id}/resolve`, { action: 'merge' })).status, 409);
  });

  let sharedNumber;
  await t.test('routing: shared channel with the classifier, low confidence goes to review, approve and override', async () => {
    sharedNumber = phone();
    const shared = await owner('POST', '/intake/identities', { type: 'whatsapp', identity: sharedNumber, shared: true, companyIds: [sp.id, pv.id], label: `Shared ${RUN}` });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    assert.equal((await spAdmin('POST', '/intake/identities', { type: 'whatsapp', identity: phone(), shared: true, companyIds: [sp.id, pv.id] })).status, 404, 'a shared channel needs intake.manage at every company');
    assert.equal((await owner('POST', '/intake/identities', { type: 'whatsapp', identity: sharedNumber, shared: true, companyIds: [sp.id, pv.id] })).status, 409);
    connectIntakePorts({
      classifier: async ({ enquiry, companyIds }) => {
        assert.deepEqual([...companyIds].sort(), [sp.id, pv.id].sort());
        return /SAT/.test(enquiry.interest?.message ?? '') ? { companyId: sp.id, confidence: 0.95 } : { companyId: pv.id, confidence: 0.4, rationale: 'mentions classes' };
      },
    });
    const { ingestEnquiry } = await import('../../src/modules/intake/service.js');
    const sure = await ingestEnquiry({ groupId: group.id, payload: { externalId: `wa-${RUN}-1`, source: { channel: { type: 'whatsapp', identity: sharedNumber } }, contact: { name: `Sara ${LETTERS}`, phone: phone() }, interest: { message: 'SAT fees?' } } }, { registry });
    assert.equal(sure.status, 'processed');
    const routed = await db('intake_enquiries').where({ id: sure.enquiryId }).first();
    assert.equal(routed.company_id, sp.id);
    assert.equal(routed.routing_reason, 'classified');
    assert.equal(routed.deal_channel, 'whatsapp');
    // Same message id again: nothing new.
    const again = await ingestEnquiry({ groupId: group.id, payload: { externalId: `wa-${RUN}-1`, source: { channel: { type: 'whatsapp', identity: sharedNumber } }, contact: { phone: phone() } } }, { registry });
    assert.equal(again.replayed, true);
    assert.equal(again.enquiryId, sure.enquiryId);

    const unsure = await ingestEnquiry({ groupId: group.id, payload: { externalId: `wa-${RUN}-2`, source: { channel: { type: 'whatsapp', identity: sharedNumber } }, contact: { name: `Ved ${LETTERS}`, phone: phone() }, interest: { message: 'classes?' } } }, { registry });
    assert.equal(unsure.status, 'needs_review');
    const item = await db('intake_review_items').where({ enquiry_id: unsure.enquiryId, kind: 'routing' }).first();
    assert.equal(item.reason, 'low_confidence');
    assert.deepEqual([...item.candidate_company_ids].sort(), [sp.id, pv.id].sort());
    // Pi Vector's admin sees it (a candidate) and may route it to Pi Vector, not to SatnPaper.
    const pvQueue = await pvAdmin('GET', `/intake/review?unitId=${pv.id}&kind=routing`);
    const shown = pvQueue.body.data.find((i) => i.id === item.id);
    assert.ok(shown);
    assert.equal(shown.suggestion.companyId, pv.id);
    assert.ok(shown.enquiry.person.phone, 'a candidate company reviewer sees who wrote');
    assert.equal((await pvAdmin('POST', `/intake/review/${item.id}/resolve`, { action: 'override', companyId: sp.id })).status, 403);
    const approved = await pvAdmin('POST', `/intake/review/${item.id}/resolve`, { action: 'approve' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const done = await db('intake_enquiries').where({ id: unsure.enquiryId }).first();
    assert.equal(done.status, 'processed');
    assert.equal(done.company_id, pv.id);
    assert.ok(done.deal_id);

    // No classifier: the engine's deterministic fallback queues the enquiry.
    resetIntakePorts();
    const fallback = await ingestEnquiry({ groupId: group.id, payload: { externalId: `wa-${RUN}-3`, source: { channel: { type: 'whatsapp', identity: sharedNumber } }, contact: { phone: phone() } } }, { registry });
    assert.equal(fallback.status, 'needs_review');
    const fbItem = await db('intake_review_items').where({ enquiry_id: fallback.enquiryId }).first();
    assert.equal(fbItem.reason, 'no_classifier');
    const override = await owner('POST', `/intake/review/${fbItem.id}/resolve`, { action: 'override', companyId: sp.id });
    assert.equal(override.status, 200, JSON.stringify(override.body));
    assert.equal((await db('intake_enquiries').where({ id: fallback.enquiryId }).first()).company_id, sp.id);
  });

  await t.test('partner referral links: attribution and the partner\'s counsellor keeps the lead', async () => {
    const code = `T${RUN}`.slice(0, 20);
    const link = await spAdmin('POST', '/intake/partner-links', { companyId: sp.id, code, partnerId: '7e0f1b8e-0000-4000-8000-000000000001', partnerName: `Partner ${RUN}`, ownerUserId: users.get('ritika@phoenix.test'), formId: form.id });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    assert.match(link.body.data.url, new RegExp(`/f/${form.key}\\?ref=${code}`));
    assert.equal((await spAdmin('POST', '/intake/partner-links', { companyId: sp.id, code, partnerId: '7e0f1b8e-0000-4000-8000-000000000001', partnerName: 'x' })).status, 409);
    for (let i = 0; i < 2; i += 1) {
      const res = await submit(form, { name: `Partner Kid ${LETTERS}${'ab'[i]}`, phone: phone() }, { ref: code });
      assert.equal(res.status, 201);
      const e = await latestEnquiry(form.id);
      const deal = await db('deals').where({ id: e.deal_id }).first();
      assert.equal(deal.owner_user_id, users.get('ritika@phoenix.test'));
      assert.equal(deal.channel, 'partner_referral');
      assert.equal(deal.first_touch.partnerId, '7e0f1b8e-0000-4000-8000-000000000001');
      assert.equal(e.assignment.method, 'partner');
    }
  });

  await t.test('call leads and the checkout hand-off are idempotent', async () => {
    const number = phone();
    const id = await pvAdmin('POST', '/intake/identities', { type: 'phone_call', identity: number, companyId: pv.id });
    assert.equal(id.status, 201, JSON.stringify(id.body));
    const event = { provider: 'exotel', type: 'call.inbound', callId: `CA${RUN}`, status: 'in_progress', lead: { phone: phone(), calledNumber: number, receivedAt: new Date().toISOString() } };
    const first = await handleCallLead(event, { groupId: group.id, registry });
    assert.equal(first.ok, true);
    assert.equal(first.status, 'processed');
    const deal = await db('deals').where({ id: first.dealId }).first();
    assert.equal(deal.company_id, pv.id);
    assert.equal(deal.channel, 'voice_call');
    const retry = await handleCallLead(event, { groupId: group.id, registry });
    assert.equal(retry.replayed, true);

    const checkout = await spAdmin('POST', '/intake/forms', { companyId: sp.id, kind: 'checkout', name: `Checkout ${RUN}`, audience: 'b2c', unitId: satTeam.id, fields: [] });
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const secret = checkout.body.data.signingSecret;
    assert.ok(secret);
    const payload = JSON.stringify({ orderId: `ORD-${RUN}`, status: 'abandoned', product: 'SAT batch', amount: 45000, currency: 'INR', customer: { name: `Buyer ${LETTERS}`, phone: phone() } });
    const ts = Math.floor(Date.now() / 1000);
    const send = (signature) => visitor('POST', `/public/checkout/${checkout.body.data.key}`, { payload, timestamp: ts, signature });
    assert.equal((await send('0'.repeat(64))).status, 403);
    const ok = await send(signCheckout(payload, ts, secret));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const replay = await send(signCheckout(payload, ts, secret));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.enquiryId, ok.body.data.enquiryId);
    const e = await db('intake_enquiries').where({ id: ok.body.data.enquiryId }).first();
    assert.equal((await db('deals').where({ id: e.deal_id }).first()).channel, 'website_checkout');
  });

  await t.test('CSV import: upload, mapping, background processing, row results and the error report', async () => {
    const p1 = phone();
    const csv = [
      'Parent Name,Mobile No.,Email ID,Student Name,Class,Remarks',
      `Asha ${LETTERS},${p1.slice(3)},asha.${RUN}@example.com,Riya,10,Wants weekend batch`,
      `Bad Row ${LETTERS},12,,,,`,
      `Meera ${LETTERS},${meeraPhone},,,,again`,
      `Asha ${LETTERS},${p1},,,,duplicate in file`,
    ].join('\r\n');
    const upload = await spAdmin('POST', `/intake/imports?unitId=${satTeam.id}&fileName=leads.csv`, csv, { 'content-type': 'text/csv' });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const job = upload.body.data;
    assert.equal(job.headers[1], 'Mobile No.');
    assert.equal(job.totalRows, 4);
    assert.equal((await pvAdmin('GET', `/intake/imports/${job.id}`)).status, 404);
    assert.equal((await ritika('POST', `/intake/imports?unitId=${satTeam.id}&fileName=x.csv`, csv, { 'content-type': 'text/csv' })).status, 403);
    assert.equal((await spAdmin('POST', `/intake/imports/${job.id}/start`, { mapping: { 0: 'contact.name' } })).status, 422);
    const mapping = Object.fromEntries(job.suggestions.filter((s) => s.field).map((s) => [String(s.index), s.field]));
    const started = await spAdmin('POST', `/intake/imports/${job.id}/start`, { mapping, defaults: { audience: 'b2c', campaign: `import-${RUN}` } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'queued');
    assert.equal((await spAdmin('POST', `/intake/imports/${job.id}/start`, { mapping })).status, 409);
    const queued = await db('outbox_events').where({ type: 'intake.import_queued', aggregate_id: job.id });
    assert.equal(queued.length, 1, 'the jobs port queued it');
    await processImportJob(job.id, { registry });
    await processImportJob(job.id, { registry }); // a second delivery does nothing
    const done = await spAdmin('GET', `/intake/imports/${job.id}`);
    assert.equal(done.body.data.status, 'completed', done.body.data.failure);
    assert.equal(done.body.data.counts.error, 1);
    assert.equal(done.body.data.counts.created + done.body.data.counts.merged + done.body.data.counts.reopened, 3);
    const rows = await spAdmin('GET', `/intake/imports/${job.id}/rows`);
    assert.deepEqual(rows.body.data.map((r) => r.status), ['created', 'error', 'merged', 'merged']);
    assert.ok(rows.body.data[0].dealRef);
    const report = await spAdmin('GET', `/intake/imports/${job.id}/error-report`);
    assert.equal(report.status, 200);
    assert.match(report.body, /^Row,Level,Column,Field,Problem,Value/);
    assert.match(report.body, /duplicate_in_file|Same phone or email as row 2/);
    const imported = await db('intake_enquiries').where({ import_job_id: job.id }).whereNotNull('deal_id');
    assert.equal(imported.length, 3);
  });

  await t.test('manual entry goes through the same pipeline', async () => {
    const res = await kabir('POST', '/intake/enquiries', { unitId: satTeam.id, channel: 'walk_in', contact: { name: `Walk In ${LETTERS}`, phone: phone() }, student: { name: 'Dev' }, message: 'Came to the centre' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const deal = await db('deals').where({ id: res.body.data.dealId }).first();
    assert.equal(deal.owner_user_id, users.get('kabir@phoenix.test'));
    assert.equal(deal.channel, 'walk_in');
    assert.equal((await kabir('POST', '/intake/enquiries', { unitId: satTeam.id, channel: 'nope_channel', contact: { phone: phone() } })).status, 422);
    assert.equal((await pvAdmin('POST', '/intake/enquiries', { unitId: satTeam.id, contact: { phone: phone() } })).status, 404);
    const list = await kabir('GET', `/intake/enquiries?unitId=${online.id}&limit=5`);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((e) => e.companyId === sp.id), 'a manager sees only their company');
    const log = await spAdmin('GET', `/intake/enquiries?unitId=${sp.id}&limit=5`);
    assert.equal(log.status, 200);
    assert.ok(log.body.data.length > 0 && log.body.data.every((e) => e.companyId === sp.id));
    assert.equal((await pvAdmin('GET', `/intake/enquiries/${log.body.data[0].id}`)).status, 404);
  });
});
