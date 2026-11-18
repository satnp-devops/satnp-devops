import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { bumpAccessVersion } from '../../src/core/access.js';
import { dispatchEvent, toEvent } from '../../src/core/events.js';
import { addDays, localDate } from '../../src/core/billing/dates.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { runChurnScoring, runRenewalReminders } from '../../src/modules/delivery/jobs.js';

// The delivery module end to end (docs/delivery/DELIVERY.md): enrollments from duplicate payment
// events, capacity and the waitlist, withdrawal with its refund request, the public checkout
// linking to an existing family, implementation projects from B2B events, renewals, and scoping
// as different seeded users. Needs the seeds (02_crm.js, 35_delivery.js); creates unique records.
//   npm run db:migrate && npm run db:seed && INTEGRATION=1 node --test test/integration/delivery.test.js

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

test('delivery module', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const registry = buildRegistry();
  const app = createApp({ registry, modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const deps = { db, redis, registry, log: { info() {}, warn() {}, error() {} } };
  const dispatch = (event) => dispatchEvent(registry, { id: randomUUID(), occurredAt: new Date().toISOString(), ...event }, deps);
  let temporaryAssignment = null;

  t.after(async () => {
    if (temporaryAssignment) {
      await db('role_assignments').where({ id: temporaryAssignment }).delete();
      await bumpAccessVersion();
    }
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
  const online = byCode('online');
  const satAdmissions = byCode('sat-admissions');
  assert.ok(await db('batches').where({ company_id: satnpaper.id }).first(), 'run the delivery seed first');
  const users = new Map((await db('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const product = await db('products').where({ company_id: satnpaper.id, code: 'SAT-GB-WKND' }).first();

  const signIn = async (email) => {
    const call = client(base);
    const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
    return call;
  };
  const owner = await signIn('owner@phoenix.test');
  const spAdmin = await signIn('admin.satnpaper@phoenix.test');
  const pvAdmin = await signIn('admin.pivector@phoenix.test');
  const ritika = await signIn('ritika@phoenix.test');
  const kabir = await signIn('kabir@phoenix.test');
  const sales = await signIn('sales.satnpaper@phoenix.test');
  const publicClient = client(base);

  // Two family deals with a student and no enrollment yet; the first is Ritika's.
  const freeDeals = (ownerId) =>
    db('deals as d')
      .join('product_lines as l', 'l.id', 'd.product_line_id')
      .where({ 'd.company_id': satnpaper.id, 'd.status': 'open', 'l.audience': 'b2c', 'd.currency': 'INR' })
      .whereNull('d.account_id')
      .whereNull('d.archived_at')
      .modify((q) => (ownerId ? q.where('d.owner_user_id', ownerId) : q.whereNot('d.owner_user_id', users.get('ritika@phoenix.test'))))
      .whereExists(db('deal_contacts as dc').whereRaw('dc.deal_id = d.id').where('dc.role', 'student').select(db.raw('1')))
      .whereNotExists(db('enrollments as e').whereRaw('e.deal_id = d.id').select(db.raw('1')))
      .orderBy('d.ref')
      .select('d.*');
  const [deal1] = await freeDeals(users.get('ritika@phoenix.test'));
  const [deal2] = await freeDeals(null);
  assert.ok(deal1 && deal2, 'free deals are left in the seed');

  let batch;
  await t.test('batches: create, validate, scope', async () => {
    const startsOn = addDays(localDate(Date.now()), 5);
    const bad = await spAdmin('POST', '/batches', { unitId: online.id, productId: product.id, name: 'Bad', startsOn, endsOn: addDays(startsOn, -1), capacity: 1 });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.some((d) => d.path === 'body.endsOn'), JSON.stringify(bad.body));
    const unknown = await spAdmin('POST', '/batches', { unitId: online.id, productId: product.id, name: 'Bad', startsOn, endsOn: startsOn, capacity: 1, colour: 'red' });
    assert.equal(unknown.status, 422);
    const noFee = await spAdmin('POST', '/batches', { unitId: online.id, productId: product.id, name: 'Bad', startsOn, endsOn: startsOn, capacity: 1, checkoutEnabled: true });
    assert.equal(noFee.status, 422);
    const res = await spAdmin('POST', '/batches', {
      unitId: online.id,
      productId: product.id,
      code: `T-${RUN}`,
      name: `Test batch ${RUN}`,
      startsOn,
      endsOn: addDays(startsOn, 69),
      capacity: 1,
      fee: { valueMinor: 1200000, currency: 'INR' },
      checkoutEnabled: true,
      schedule: { days: ['sat', 'sun'], startTime: '10:00', endTime: '12:00' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    batch = res.body.data;
    assert.equal(batch.seatsLeft, 1);
    assert.equal(batch.can.manage, true);
    const dup = await spAdmin('POST', '/batches', { unitId: online.id, productId: product.id, code: `T-${RUN}`, name: 'Dup', startsOn, endsOn: startsOn, capacity: 1 });
    assert.equal(dup.status, 422);
    assert.equal((await pvAdmin('GET', `/batches/${batch.id}`)).status, 404);
    assert.equal((await pvAdmin('PATCH', `/batches/${batch.id}`, { capacity: 5 })).status, 404);
    assert.equal((await ritika('PATCH', `/batches/${batch.id}`, { capacity: 5 })).status, 403);
    const list = await ritika('GET', `/batches?unitId=${satAdmissions.id}&joinable=true&limit=100`);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((b) => b.companyId === satnpaper.id));
    assert.equal((await pvAdmin('GET', `/batches?unitId=${satnpaper.id}`)).status, 404);
  });

  let e1;
  let e2;
  await t.test('payment events create one enrollment, however often they arrive', async () => {
    const paymentId = `pay_${RUN}_1`;
    const event = {
      type: 'payment.succeeded',
      groupId: group.id,
      unitId: deal1.unit_id,
      aggregateType: 'payment',
      aggregateId: paymentId,
      payload: { paymentId, dealId: deal1.id, productId: product.id, batchId: batch.id, amountMinor: 600000, currency: 'INR', paidAt: new Date().toISOString() },
    };
    await dispatch(event);
    await dispatch(event);
    await Promise.all([dispatch(event), dispatch(event)]);
    const rows = await db('enrollments').where({ deal_id: deal1.id });
    assert.equal(rows.length, 1);
    e1 = rows[0];
    assert.equal(e1.seat_status, 'seated');
    assert.equal(e1.batch_id, batch.id);
    assert.equal(e1.owner_user_id, deal1.owner_user_id);
    assert.equal(Number(e1.paid_minor), 600000);
    assert.equal((await db('enrollment_payments').where({ enrollment_id: e1.id })).length, 1);
    assert.ok(await db('onboarding_checklists').where({ enrollment_id: e1.id }).first(), 'checklist started');
    const created = await db('outbox_events').where({ type: 'enrollment.created', aggregate_id: e1.id });
    assert.equal(created.length, 1);
    // A second instalment is recorded on the same enrollment.
    await dispatch({ ...event, aggregateId: `pay_${RUN}_2`, payload: { ...event.payload, paymentId: `pay_${RUN}_2` } });
    assert.equal((await db('enrollments').where({ deal_id: deal1.id })).length, 1);
    assert.equal(Number((await db('enrollments').where({ id: e1.id }).first()).paid_minor), 1200000);
  });

  await t.test('a full batch puts the next student on the waitlist', async () => {
    await dispatch({
      type: 'payment.succeeded',
      groupId: group.id,
      payload: { paymentId: `pay_${RUN}_3`, dealId: deal2.id, productId: product.id, batchId: batch.id, amountMinor: 1200000, currency: 'INR' },
    });
    e2 = await db('enrollments').where({ deal_id: deal2.id }).first();
    assert.equal(e2.seat_status, 'waitlisted');
    assert.equal(e2.batch_id, null);
    const b = await spAdmin('GET', `/batches/${batch.id}`);
    assert.equal(b.body.data.seatsTaken, 1);
    assert.equal(b.body.data.waitlistCount, 1);
    const waitlist = await spAdmin('GET', `/batches/${batch.id}/waitlist`);
    assert.equal(waitlist.status, 200);
    assert.deepEqual(waitlist.body.data.map((w) => [w.enrollment.id, w.position]), [[e2.id, 1]]);
    const filtered = await spAdmin('GET', `/enrollments?unitId=${satnpaper.id}&batchId=${batch.id}`);
    assert.deepEqual(filtered.body.data.map((e) => e.id).sort(), [e1.id, e2.id].sort());
    const detail = await spAdmin('GET', `/enrollments/${e2.id}`);
    assert.equal(detail.body.data.waitlist.position, 1);
    // Manual enrollment into the full batch without the waitlist is a 409.
    const student = await db('deal_contacts').where({ deal_id: deal2.id, role: 'student' }).first();
    const again = await spAdmin('POST', '/enrollments', { unitId: online.id, studentContactId: student.contact_id, productId: product.id, batchId: batch.id });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_enrolled');
  });

  await t.test('scoping: own records for counsellors, 404 across companies, masking without the PII right', async () => {
    const mine = await ritika('GET', `/enrollments?unitId=${satAdmissions.id}&limit=100`);
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.length > 0);
    assert.ok(mine.body.data.every((e) => e.owner?.id === users.get('ritika@phoenix.test')));
    assert.ok(mine.body.data.some((e) => e.id === e1.id));
    if (deal2.owner_user_id !== users.get('ritika@phoenix.test')) assert.equal((await ritika('GET', `/enrollments/${e2.id}`)).status, 404);
    const kabirs = await kabir('GET', `/enrollments?unitId=${online.id}&limit=100`);
    assert.equal(kabirs.status, 200);
    assert.ok(kabirs.body.data.some((e) => e.id === e2.id));
    assert.equal((await pvAdmin('GET', `/enrollments/${e1.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/enrollments?unitId=${satnpaper.id}`)).status, 404);
    assert.equal((await pvAdmin('POST', `/enrollments/${e1.id}/pause`, {})).status, 404);
    const all = await owner('GET', `/enrollments?unitId=${group.id}&limit=5`);
    assert.equal(all.status, 200);
    assert.ok(all.body.nextCursor);
    const next = await owner('GET', `/enrollments?unitId=${group.id}&limit=5&cursor=${all.body.nextCursor}`);
    assert.equal(next.status, 200);
    assert.equal(new Set([...all.body.data, ...next.body.data].map((e) => e.id)).size, all.body.data.length + next.body.data.length);
    assert.equal(all.body.data[0].student.piiMasked, false);

    // An analyst at SatnPaper (no contacts.view_pii) sees enrollments with masked details.
    const analyst = await db('roles').where({ key: 'analyst' }).whereNull('group_id').first().catch(() => null) ?? (await db('roles').where({ key: 'analyst' }).first());
    [{ id: temporaryAssignment }] = await db('role_assignments').insert({ user_id: users.get('admin.pivector@phoenix.test'), role_id: analyst.id, org_unit_id: satnpaper.id }).returning('id');
    await bumpAccessVersion();
    const masked = await pvAdmin('GET', `/enrollments?unitId=${satnpaper.id}&limit=20`);
    assert.equal(masked.status, 200, JSON.stringify(masked.body));
    const withPhone = masked.body.data.find((e) => e.student.primaryPhone || e.payer?.primaryPhone);
    assert.ok(withPhone, 'some enrollment has a phone');
    assert.equal(withPhone.student.piiMasked, true);
    assert.equal((await pvAdmin('POST', `/enrollments/${e1.id}/pause`, {})).status, 403);
    await db('role_assignments').where({ id: temporaryAssignment }).delete();
    temporaryAssignment = null;
    await bumpAccessVersion();
  });

  await t.test('withdrawal requests the pro-rata refund and frees the seat for the waitlist', async () => {
    assert.equal((await ritika('POST', `/enrollments/${e1.id}/withdraw`, { channel: 'phone' })).status, 403);
    const preview = await spAdmin('POST', `/enrollments/${e1.id}/withdraw/preview`, {});
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    // The batch has not started: nothing of it was used, so everything paid comes back.
    assert.equal(preview.body.data.refund.valueMinor, 1200000);
    const bad = await spAdmin('POST', `/enrollments/${e1.id}/withdraw`, { channel: 'pigeon' });
    assert.equal(bad.status, 422);
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    const res = await spAdmin('POST', `/enrollments/${e1.id}/withdraw`, { channel: 'whatsapp', receivedAt });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'withdrawn');
    assert.equal(res.body.data.accessStatus, 'revoked');
    assert.equal(res.body.data.withdrawal.refundStatus, 'requested');
    const due = new Date(res.body.data.withdrawal.refundDueAt).getTime();
    assert.equal(due, new Date(receivedAt).getTime() + 10 * 86_400_000);
    const [requested] = await db('outbox_events').where({ type: 'refund.requested', aggregate_id: res.body.data.withdrawal.id });
    assert.ok(requested, 'refund.requested emitted');
    assert.equal(requested.payload.amountMinor, 1200000);
    assert.equal(requested.payload.enrollmentId, e1.id);
    assert.deepEqual(requested.payload.paymentIds.sort(), [`pay_${RUN}_1`, `pay_${RUN}_2`]);
    assert.equal((await spAdmin('POST', `/enrollments/${e1.id}/withdraw`, { channel: 'whatsapp' })).status, 409);
    // The person waiting got the seat.
    const promoted = await db('enrollments').where({ id: e2.id }).first();
    assert.equal(promoted.seat_status, 'seated');
    assert.equal(promoted.batch_id, batch.id);
    const b = await db('batches').where({ id: batch.id }).first();
    assert.equal(b.seats_taken, 1);
    assert.equal(b.waitlist_count, 0);
    // The money module reports the refund paid.
    await dispatch({ type: 'refund.completed', groupId: group.id, payload: { withdrawalId: res.body.data.withdrawal.id, refundId: `rfnd_${RUN}` } });
    const after = await spAdmin('GET', `/enrollments/${e1.id}`);
    assert.equal(after.body.data.withdrawal.refundStatus, 'paid');
    assert.equal(after.body.data.withdrawal.refundReference, `rfnd_${RUN}`);
  });

  await t.test('pause and resume keep the seat', async () => {
    const paused = await spAdmin('POST', `/enrollments/${e2.id}/pause`, { resumeOn: addDays(localDate(Date.now()), 7) });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.data.status, 'paused');
    assert.equal((await db('batches').where({ id: batch.id }).first()).seats_taken, 1);
    const resumed = await spAdmin('POST', `/enrollments/${e2.id}/resume`, {});
    assert.equal(resumed.body.data.status, 'active');
    assert.equal((await spAdmin('POST', `/enrollments/${e2.id}/resume`, {})).status, 409);
  });

  await t.test('website checkout links to the existing family and enrolls on payment', async () => {
    const [family] = (
      await db.raw(
        `select h.id as household_id, p.contact_id as parent_id, s.contact_id as student_id,
                (select m.value from contact_methods m where m.contact_id = p.contact_id and m.kind in ('phone', 'whatsapp') order by m.is_primary desc limit 1) as phone,
                (select m.value from contact_methods m where m.contact_id = p.contact_id and m.kind = 'email' order by m.is_primary desc limit 1) as email
           from households h
           join household_members p on p.household_id = h.id and p.role = 'parent'
           join household_members s on s.household_id = h.id and s.role = 'student'
           join contact_companies cc on cc.contact_id = p.contact_id and cc.company_id = ?
          where exists (select 1 from contact_methods m where m.contact_id = p.contact_id and m.kind = 'email')
            and exists (select 1 from contact_methods m where m.contact_id = p.contact_id and m.kind in ('phone', 'whatsapp'))
            and not exists (select 1 from enrollments e where e.student_contact_id = s.contact_id and e.product_id = ?)
          order by h.created_at limit 1`,
        [satnpaper.id, product.id],
      )
    ).rows;
    assert.ok(family, 'a seeded family with phone and email');
    const parent = await db('contacts').where({ id: family.parent_id }).first();
    const student = await db('contacts').where({ id: family.student_id }).first();
    const contactsBefore = Number((await db('contacts').where({ group_id: group.id }).count({ n: '*' }))[0].n);

    assert.equal((await publicClient('GET', '/public/checkout/no-such-company')).status, 404);
    assert.equal((await publicClient('GET', '/public/checkout/excel')).status, 404, 'checkout is off for Excel');
    const page = await publicClient('GET', '/public/checkout/satnpaper');
    assert.equal(page.status, 200);
    // Make room in the test batch for the checkout.
    assert.equal((await spAdmin('PATCH', `/batches/${batch.id}`, { capacity: 0 })).status, 422);
    assert.equal((await spAdmin('PATCH', `/batches/${batch.id}`, { capacity: 3 })).status, 200);
    const listed = (await publicClient('GET', '/public/checkout/satnpaper')).body.data.batches.find((b) => b.id === batch.id);
    assert.equal(listed.seatsLeft, 2);
    const body = {
      batchId: batch.id,
      parent: { firstName: parent.first_name ?? 'Parent', lastName: parent.last_name ?? undefined, phone: family.phone, email: family.email.toUpperCase() },
      student: { firstName: student.first_name, lastName: student.last_name ?? undefined, grade: '11' },
      consent: { acceptPolicy: true, policyVersion: page.body.data.policy.version, whatsappUpdates: true },
    };
    const stale = await publicClient('POST', '/public/checkout/satnpaper/sessions', { ...body, consent: { ...body.consent, policyVersion: 'oldversion' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'policy_changed');
    const noConsent = await publicClient('POST', '/public/checkout/satnpaper/sessions', { ...body, consent: { ...body.consent, acceptPolicy: false } });
    assert.equal(noConsent.status, 422);
    const started = await publicClient('POST', '/public/checkout/satnpaper/sessions', body);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { id: sessionId, token } = started.body.data;
    assert.ok(started.body.data.paymentUrl.includes(sessionId));
    assert.equal((await publicClient('GET', `/public/checkout/sessions/${sessionId}?token=${'x'.repeat(43)}`)).status, 404);

    const simulated = await publicClient('POST', `/public/checkout/sessions/${sessionId}/simulate-payment`, { token });
    assert.equal(simulated.status, 202, JSON.stringify(simulated.body));
    const outbox = await db('outbox_events').where({ type: 'payment.succeeded' }).whereRaw("payload->>'checkoutSessionId' = ?", [sessionId]).first();
    assert.ok(outbox);
    const event = toEvent(outbox);
    await dispatchEvent(registry, event, deps);
    await dispatchEvent(registry, event, deps);

    const status = await publicClient('GET', `/public/checkout/sessions/${sessionId}?token=${token}`);
    assert.equal(status.body.data.status, 'completed');
    assert.match(status.body.data.enrollment.ref, /^SP-E\d+$/);
    const enrollments = await db('enrollments').where({ checkout_session_id: sessionId });
    assert.equal(enrollments.length, 1);
    const [enrollment] = enrollments;
    assert.equal(enrollment.student_contact_id, student.id, 'the existing student');
    assert.equal(enrollment.payer_contact_id, parent.id, 'the existing parent');
    assert.equal(enrollment.household_id, family.household_id);
    assert.equal(enrollment.source, 'checkout');
    assert.equal(Number(enrollment.paid_minor), 1200000);
    assert.equal(Number((await db('contacts').where({ group_id: group.id }).count({ n: '*' }))[0].n), contactsBefore, 'nobody new');
    assert.ok(await db('consents').where({ contact_id: parent.id, source: 'checkout', channel: 'whatsapp', status: 'granted' }).first());
    const session = await db('checkout_sessions').where({ id: sessionId }).first();
    assert.deepEqual(session.details, {}, 'personal data purged from the session');
    assert.equal((await publicClient('POST', `/public/checkout/sessions/${sessionId}/simulate-payment`, { token })).status, 409);
    // Take the test batch off the public page again.
    assert.equal((await spAdmin('PATCH', `/batches/${batch.id}`, { checkoutEnabled: false, status: 'closed' })).status, 200);
  });

  let project;
  await t.test('a signed contract starts one implementation project; the subscription attaches to it', async () => {
    const b2b = await db('deals as d')
      .join('product_lines as l', 'l.id', 'd.product_line_id')
      .where({ 'd.company_id': satnpaper.id, 'd.status': 'open', 'l.audience': 'b2b' })
      .whereNotNull('d.account_id')
      .whereNotExists(db('implementation_projects as p').whereRaw('p.deal_id = d.id').select(db.raw('1')))
      .orderBy('d.ref')
      .first('d.*');
    assert.ok(b2b, 'an open institute deal is left');
    const signed = { type: 'contract.signed', groupId: group.id, unitId: b2b.unit_id, payload: { contractId: `ct_${RUN}`, dealId: b2b.id, accountId: b2b.account_id, companyId: satnpaper.id } };
    await dispatch(signed);
    await dispatch(signed);
    const projects = await db('implementation_projects').where({ deal_id: b2b.id });
    assert.equal(projects.length, 1);
    [project] = projects;
    assert.equal(project.contract_id, `ct_${RUN}`);
    assert.equal(project.owner_user_id, b2b.owner_user_id);
    const phases = await db('implementation_phases').where({ project_id: project.id }).orderBy('position');
    assert.deepEqual(phases.map((p) => p.key), ['kickoff', 'data_import', 'training', 'go_live']);
    assert.ok((await db('implementation_tasks').where({ project_id: project.id })).length >= 4);

    const termEnd = addDays(localDate(Date.now()), 25);
    await dispatch({
      type: 'subscription.created',
      groupId: group.id,
      payload: { subscriptionId: `sub_${RUN}`, dealId: b2b.id, accountId: b2b.account_id, companyId: satnpaper.id, termStart: addDays(termEnd, -365), termEnd, amountMinor: 30000000, currency: 'INR', autoRenew: false, seats: 100 },
    });
    assert.equal((await db('implementation_projects').where({ deal_id: b2b.id })).length, 1);
    assert.equal((await db('implementation_projects').where({ id: project.id }).first()).subscription_id, `sub_${RUN}`);
    const renewal = await db('renewals').where({ subscription_id: `sub_${RUN}` }).first();
    assert.equal(renewal.term_end, termEnd);
    assert.equal(renewal.account_id, b2b.account_id);

    // Reminders: 30 days reached once (60 and 90 count as passed), never twice.
    await runRenewalReminders({ db });
    await runRenewalReminders({ db });
    const reminders = await db('outbox_events').where({ type: 'renewal.reminder_due', aggregate_id: renewal.id });
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].payload.daysBefore, 30);
    await runChurnScoring({ db, companyId: satnpaper.id });
    const scored = await db('renewals').where({ id: renewal.id }).first();
    assert.ok(scored.scored_at);
    assert.ok(scored.churn_signals.some((s) => s.key === 'renewal_unattended') || scored.churn_score >= 0);

    const detail = await spAdmin('GET', `/implementation-projects/${project.id}`);
    assert.equal(detail.status, 200);
    const task = detail.body.data.phases[0].tasks[0];
    const done = await spAdmin('PATCH', `/implementation-projects/${project.id}/tasks/${task.id}`, { status: 'done' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.status, 'in_progress');
    assert.equal(done.body.data.phases[0].status, done.body.data.phases[0].tasks.length === 1 ? 'done' : 'in_progress');
    assert.equal((await pvAdmin('GET', `/implementation-projects/${project.id}`)).status, 404);

    const renewals = await spAdmin('GET', `/renewals?unitId=${satnpaper.id}&dueWithinDays=30&limit=100`);
    assert.equal(renewals.status, 200);
    assert.ok(renewals.body.data.some((r) => r.subscriptionId === `sub_${RUN}`));
    assert.ok(renewals.body.data.every((r, i, all) => i === 0 || all[i - 1].termEnd <= r.termEnd));
    const risky = await spAdmin('GET', `/renewals?unitId=${satnpaper.id}&sort=risk&limit=3`);
    assert.equal(risky.status, 200);
    assert.equal((await pvAdmin('GET', `/renewals?unitId=${satnpaper.id}`)).status, 404);
    assert.equal((await ritika('GET', `/renewals?unitId=${satAdmissions.id}`)).status, 403);
    const own = await sales('GET', `/implementation-projects?unitId=${byCode('software-sales').id}&limit=100`);
    assert.equal(own.status, 200);
    assert.ok(own.body.data.every((p) => p.owner?.id === users.get('sales.satnpaper@phoenix.test')));
  });

  await t.test('manual implementation project: one per deal', async () => {
    const res = await spAdmin('POST', '/implementation-projects', { unitId: project.unit_id, accountId: project.account_id, dealId: project.deal_id });
    assert.equal(res.status, 409);
    const unknown = await spAdmin('POST', '/implementation-projects', { unitId: satnpaper.id, accountId: randomUUID() });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.details[0].path, 'body.accountId');
  });
});
