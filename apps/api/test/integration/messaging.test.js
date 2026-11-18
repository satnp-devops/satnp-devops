import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { bumpAccessVersion } from '../../src/core/access.js';
import { findOrCreateContact } from '../../src/core/crm/contacts.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';
import { sendMessage } from '../../src/core/messaging/index.js';
import { buildWhatsappToolRequest, handleWhatsappToolEvent, messagingWebhookHandlers, whatsappTool } from '../../src/modules/messaging/webhooks.js';

// Messaging end to end (docs/platform/MESSAGING.md): sending through the mock (sandbox row, timeline
// entry, events), the 24-hour window, consent and opt-out, inbound messages and the conversations they
// open, idempotent delivery statuses, the WhatsApp tool's events, templates and their approval, and
// scoping as the owner, admin.pivector, ritika and kabir. Needs a migrated and seeded database.
// Each run creates its own person and deal (unique numbers) and removes them afterwards.

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const DIGITS = String(Date.now()).slice(-5);
const PHONE = `+9190008${DIGITS}`;
const STRANGER = `+9190009${DIGITS}`;

function client(base) {
  let cookie = '';
  async function call(method, path, body) {
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
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  }
  call.login = async (email) => {
    const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
    assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
  };
  return call;
}

const event = (type, data, id = `evt_${randomUUID()}`) => ({ eventId: id, type, occurredAt: new Date().toISOString(), reference: null, data });

test('messaging end to end', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const created = { contacts: [], deals: [], templates: [], assignments: [] };
  let smsConnection = null;

  t.after(async () => {
    try {
      if (smsConnection) await db('integration_connections').where({ id: smsConnection.id }).update({ config: JSON.stringify(smsConnection.config) });
      if (created.assignments.length) {
        await db('role_assignments').whereIn('id', created.assignments).delete();
        await bumpAccessVersion();
      }
      const contacts = created.contacts;
      if (contacts.length) {
        await db('messages').whereIn('contact_id', contacts).delete();
        await db('conversations').whereIn('contact_id', contacts).delete();
        await db('timeline_events').whereIn('contact_id', contacts).delete();
        await db('consents').whereIn('contact_id', contacts).delete();
      }
      if (created.deals.length) {
        await db('timeline_events').whereIn('deal_id', created.deals).delete();
        await db('deals').whereIn('id', created.deals).delete();
      }
      if (contacts.length) {
        await db('search_documents').where({ entity_type: 'contact' }).whereIn('entity_id', contacts).delete();
        await db('contacts').whereIn('id', contacts).delete();
      }
      if (created.templates.length) await db('message_templates').whereIn('id', created.templates).delete();
    } finally {
      server.close();
      await closeQueues();
      await db.destroy();
      await redis.quit();
    }
  });

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const owner = client(base);
  const spAdmin = client(base);
  const pvAdmin = client(base);
  const ritika = client(base);
  const kabir = client(base);
  await Promise.all([
    owner.login('owner@phoenix.test'),
    spAdmin.login('admin.satnpaper@phoenix.test'),
    pvAdmin.login('admin.pivector@phoenix.test'),
    ritika.login('ritika@phoenix.test'),
    kabir.login('kabir@phoenix.test'),
  ]);

  // ---------- Test data: a person and a deal of Ritika's in SatnPaper › Online › SAT admissions ----------
  const [satnpaper, satAdmissions, ritikaUser, kabirUser] = await Promise.all([
    db('org_units').where({ code: 'satnpaper', type: 'company' }).first(),
    db('org_units').where({ name: 'SAT admissions', type: 'team' }).first(),
    db('users').where({ email: 'ritika@phoenix.test' }).first(),
    db('users').where({ email: 'kabir@phoenix.test' }).first(),
  ]);
  const { contact } = await db.transaction((trx) =>
    findOrCreateContact(trx, {
      groupId: satnpaper.root_id,
      companyId: satnpaper.id,
      unitId: satAdmissions.id,
      kind: 'parent',
      fullName: `Meera Test${RUN}`,
      phones: [{ value: PHONE, kind: 'whatsapp' }],
      emails: [`meera.${RUN}@example.com`],
      ownerUserId: ritikaUser.id,
      mode: 'create',
    }),
  );
  created.contacts.push(contact.id);
  const template = await db('deals').where({ company_id: satnpaper.id, owner_user_id: ritikaUser.id, status: 'open' }).whereNull('archived_at').first();
  const dealId = randomUUID();
  await db('deals').insert({
    ...template,
    id: dealId,
    number: 900_000 + Number(DIGITS),
    ref: `SP-T${DIGITS}`,
    title: `Messaging test ${RUN}`,
    primary_contact_id: contact.id,
    household_id: null,
    account_id: null,
    first_replied_at: null,
    first_reply_due_at: new Date(Date.now() + 30 * 60_000),
    source_event_id: null,
    original_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    last_activity_at: new Date(Date.now() - 86_400_000),
    first_touch: template.first_touch ? JSON.stringify(template.first_touch) : null,
    last_touch: template.last_touch ? JSON.stringify(template.last_touch) : null,
    ai_fields: JSON.stringify(template.ai_fields ?? {}),
    custom: JSON.stringify(template.custom ?? {}),
  });
  created.deals.push(dealId);
  const kabirDeal = await db('deals').where({ company_id: satnpaper.id, owner_user_id: kabirUser.id, status: 'open' }).whereNull('archived_at').first();
  const whatsappConnection = await db('integration_connection_companies as l')
    .join('integration_connections as c', 'c.id', 'l.connection_id')
    .where({ 'l.company_id': satnpaper.id, 'l.kind': 'messaging.whatsapp', 'l.is_default': true })
    .first('c.*');
  const connection = { id: whatsappConnection.id, kind: 'messaging.whatsapp', provider: 'mock' };
  const templateId = async (name, language = 'en') => (await db('message_templates').where({ company_id: satnpaper.id, name, language }).whereNull('archived_at').first('id')).id;
  const bookingLink = await templateId('booking_link');
  const welcome = await templateId('welcome_family');
  const smsReminder = await templateId('demo_reminder_sms');
  const send = (who, body) => who('POST', '/messaging/messages', { dealId, ...body });
  const sendBooking = (who = ritika, extra = {}) =>
    send(who, { channel: 'whatsapp', templateId: bookingLink, variables: { booking_link: 'https://book.example.com/demo/QA1', booking_code: 'QA1' }, ...extra });
  const inbound = (text, { from = PHONE, id = `wamid.in.${randomUUID()}` } = {}) =>
    messagingWebhookHandlers['messaging.whatsapp']['message.received'](event('message.received', { from, to: '+919000010001', providerMessageId: id, text, contactName: 'Meera' }), { connection });

  let sent;

  await t.test('the reply box context: channels, a closed window, approved templates and defaults', async () => {
    const res = await ritika('GET', `/messaging/context?dealId=${dealId}`);
    assert.equal(res.status, 200, res.text);
    const ctx = res.body.data;
    assert.equal(ctx.company.id, satnpaper.id);
    assert.equal(ctx.can.send, true);
    const whatsapp = ctx.channels.find((c) => c.channel === 'whatsapp');
    assert.equal(whatsapp.available, true);
    assert.equal(whatsapp.addresses[0].value, PHONE);
    assert.equal(whatsapp.addresses[0].window.open, false);
    assert.equal(whatsapp.addresses[0].connection.id, whatsappConnection.id);
    assert.equal(whatsapp.consent.marketing, 'unknown');
    assert.equal(ctx.channels.find((c) => c.channel === 'sms').freeText, false);
    assert.ok(ctx.templates.some((tpl) => tpl.name === 'booking_link' && tpl.variables.includes('booking_link')));
    assert.ok(!ctx.templates.some((tpl) => tpl.name === 'fee_offer'), 'rejected templates are not offered');
    assert.deepEqual(
      { first: ctx.defaults.first_name, company: ctx.defaults.company_name, ref: ctx.defaults.deal_ref, owner: ctx.defaults.owner_name },
      { first: 'Meera', company: 'SatnPaper', ref: `SP-T${DIGITS}`, owner: ritikaUser.name },
    );
  });

  await t.test('a template send: recorded by the mock, on the timeline, first reply, message.sent', async () => {
    const missing = await send(ritika, { channel: 'whatsapp', templateId: bookingLink });
    assert.equal(missing.status, 422);
    assert.ok(missing.body.error.details.some((d) => d.path === 'body.variables.booking_link'));

    const res = await sendBooking();
    assert.equal(res.status, 201, res.text);
    sent = res.body.data;
    assert.equal(sent.status, 'sent');
    assert.equal(sent.direction, 'outbound');
    assert.equal(sent.template.name, 'booking_link');
    assert.equal(sent.sentBy.id, ritikaUser.id);
    assert.match(sent.providerMessageId, /^wamid\.mock_/);
    assert.match(sent.body, /Hi Meera, thank you for your interest in SatnPaper/);

    const sandbox = await db('integration_sandbox_messages').where({ provider_ref: sent.providerMessageId }).first();
    assert.ok(sandbox, 'the mock recorded the send');
    assert.equal(sandbox.recipient, PHONE);
    assert.equal(sandbox.subject, 'Template booking_link (en)');
    assert.equal(sandbox.reference, sent.id);

    const entry = await db('timeline_events').where({ source_event_id: `message:${sent.id}` }).first();
    assert.equal(entry.kind, 'message');
    assert.equal(entry.deal_id, dealId);
    assert.equal(entry.contact_id, contact.id);
    assert.equal(entry.direction, 'outbound');
    assert.equal(entry.actor_user_id, ritikaUser.id);
    assert.equal(entry.meta.templateKey, 'booking_link');
    const deal = await db('deals').where({ id: dealId }).first();
    assert.ok(deal.first_replied_at, 'the first outbound reply sets first_replied_at');
    const events = await db('outbox_events').where({ aggregate_id: sent.id }).pluck('type');
    assert.deepEqual(events, ['message.sent']);
    const audit = await db('audit_logs').where({ entity_type: 'message', entity_id: sent.id }).first();
    assert.equal(audit.action, 'message.sent');
    assert.ok(!JSON.stringify(audit.after).includes(PHONE), 'no number in the audit entry');
  });

  await t.test('a client retry with the same clientId never sends twice', async () => {
    const clientId = `retry-${RUN}`;
    const first = await sendBooking(ritika, { clientId });
    const again = await sendBooking(ritika, { clientId });
    assert.equal(first.status, 201);
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(await db('integration_sandbox_messages').where({ reference: first.body.data.id }).count({ n: '*' }).first().then((r) => Number(r.n)), 1);

    // A double click: two sends with one clientId at once still send once.
    const raceId = `race-${RUN}`;
    const [x, y] = await Promise.all([sendBooking(ritika, { clientId: raceId }), sendBooking(ritika, { clientId: raceId })]);
    assert.equal(x.status, 201);
    assert.equal(y.status, 201);
    assert.equal(x.body.data.id, y.body.data.id);
    assert.equal(await db('messages').where('reference', 'like', `client:%:${raceId}`).count({ n: '*' }).first().then((r) => Number(r.n)), 1);
  });

  await t.test('free text needs the 24-hour window; an inbound message opens it', async () => {
    const outside = await send(ritika, { channel: 'whatsapp', text: 'Hello Meera, any questions?' });
    assert.equal(outside.status, 409, outside.text);
    assert.equal(outside.body.error.code, 'message_blocked');
    assert.equal(outside.body.error.details.reason, 'outside_window');

    const result = await inbound('Hi, what are the batch timings?');
    assert.equal(result.status, 'processed');
    const conversation = await db('conversations').where({ contact_id: contact.id, channel: 'whatsapp' }).first();
    assert.ok(conversation.last_inbound_at);
    assert.equal(conversation.deal_id, dealId);
    const received = await db('messages').where({ id: result.messageId }).first();
    assert.equal(received.direction, 'inbound');
    assert.equal(received.deal_id, dealId, 'inbound messages attach to the open deal');
    const entry = await db('timeline_events').where({ source_event_id: `message:${received.id}` }).first();
    assert.equal(entry.actor_type, 'contact');
    assert.equal(entry.direction, 'inbound');
    const payload = (await db('outbox_events').where({ aggregate_id: received.id, type: 'message.received' }).first()).payload;
    assert.equal(payload.isNewEnquiry, false);
    assert.equal(payload.contactCreated, false);

    const ctx = (await ritika('GET', `/messaging/context?dealId=${dealId}`)).body.data;
    const window = ctx.channels.find((c) => c.channel === 'whatsapp').addresses[0].window;
    assert.equal(window.open, true);
    assert.ok(window.remainingSeconds > 23 * 3600);

    const inside = await send(ritika, { channel: 'whatsapp', text: 'Evening batches run 6 to 8 pm.' });
    assert.equal(inside.status, 201, inside.text);
    assert.equal(inside.body.data.purpose, 'service');
  });

  await t.test('email takes free text with a subject; SMS only registered templates', async () => {
    const noSubject = await send(ritika, { channel: 'email', text: 'Details attached.' });
    assert.equal(noSubject.status, 422);
    const email = await send(ritika, { channel: 'email', text: 'Here are the details.', subject: 'Your SAT batch' });
    assert.equal(email.status, 201, email.text);
    assert.equal((await db('timeline_events').where({ source_event_id: `message:${email.body.data.id}` }).first()).kind, 'email');
    const smsText = await send(ritika, { channel: 'sms', text: 'Hello' });
    assert.equal(smsText.body.error.details.reason, 'template_required');
  });

  await t.test('a provider failure is recorded as failed with message.failed', async () => {
    smsConnection = await db('integration_connection_companies as l')
      .join('integration_connections as c', 'c.id', 'l.connection_id')
      .where({ 'l.company_id': satnpaper.id, 'l.kind': 'messaging.sms', 'l.is_default': true })
      .first('c.id', 'c.config');
    await db('integration_connections').where({ id: smsConnection.id }).update({ config: JSON.stringify({ ...smsConnection.config, simulate: 'failing_sends' }) });
    const res = await send(ritika, { channel: 'sms', templateId: smsReminder, variables: { demo_time: 'Sat 5 pm' } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.data.status, 'failed');
    assert.equal(res.body.data.error.code, 'integration_provider_error');
    assert.deepEqual(await db('outbox_events').where({ aggregate_id: res.body.data.id }).pluck('type'), ['message.failed']);
    assert.equal(await db('timeline_events').where({ source_event_id: `message:${res.body.data.id}` }).first(), undefined);
    await db('integration_connections').where({ id: smsConnection.id }).update({ config: JSON.stringify(smsConnection.config) });
    smsConnection = null;
  });

  await t.test('delivery statuses are idempotent and only move forward', async () => {
    const status = (value) =>
      messagingWebhookHandlers['messaging.whatsapp']['message.status'](event('message.status', { providerMessageId: sent.providerMessageId, status: value }), { connection });
    assert.equal((await status('delivered')).status, 'processed');
    assert.equal((await status('delivered')).status, 'duplicate');
    assert.equal((await status('read')).status, 'processed');
    assert.equal((await status('delivered')).status, 'duplicate');
    assert.equal((await status('failed')).status, 'duplicate');
    const row = await db('messages').where({ id: sent.id }).first();
    assert.equal(row.status, 'read');
    assert.ok(row.delivered_at && row.read_at);
    assert.equal((await db('timeline_events').where({ source_event_id: `message:${sent.id}` }).first()).meta.status, 'read');
    const changes = await db('outbox_events').where({ aggregate_id: sent.id, type: 'message.status_changed' }).count({ n: '*' }).first();
    assert.equal(Number(changes.n), 2);
    const unknown = await messagingWebhookHandlers['messaging.whatsapp']['message.status'](event('message.status', { providerMessageId: 'wamid.nobody', status: 'read' }), { connection });
    assert.equal(unknown.status, 'ignored');
  });

  await t.test('marketing needs consent; a STOP reply withdraws it; an opted-out number blocks everything', async () => {
    const noConsent = await send(ritika, { channel: 'whatsapp', templateId: welcome });
    assert.equal(noConsent.status, 409);
    assert.equal(noConsent.body.error.details.reason, 'marketing_consent_missing');

    await db('consents').insert({ group_id: satnpaper.root_id, contact_id: contact.id, company_id: satnpaper.id, channel: 'whatsapp', purpose: 'marketing', status: 'granted', source: 'web_form', captured_at: new Date(Date.now() - 60_000) });
    const granted = await send(ritika, { channel: 'whatsapp', templateId: welcome });
    assert.equal(granted.status, 201, granted.text);
    assert.equal(granted.body.data.purpose, 'marketing');

    await inbound('STOP');
    const withdrawal = await db('consents').where({ contact_id: contact.id, status: 'withdrawn' }).first();
    assert.equal(withdrawal.purpose, 'marketing');
    assert.equal(withdrawal.source, 'whatsapp');
    assert.ok(await db('outbox_events').where({ type: 'consent.recorded', aggregate_id: contact.id }).first());
    const blocked = await send(ritika, { channel: 'whatsapp', templateId: welcome });
    assert.equal(blocked.body.error.details.reason, 'consent_withdrawn');
    assert.equal((await sendBooking()).status, 201, 'transactional templates still go out');

    await db('contact_methods').where({ contact_id: contact.id, kind: 'whatsapp' }).update({ opted_out_at: new Date() });
    const optedOut = await sendBooking();
    assert.equal(optedOut.body.error.details.reason, 'opted_out');
    await db('contact_methods').where({ contact_id: contact.id, kind: 'whatsapp' }).update({ opted_out_at: null });
  });

  await t.test('an unknown number writing in creates the person and a conversation, once', async () => {
    const id = `wamid.stranger.${RUN}`;
    const first = await inbound('Hello, I want SAT coaching for my son', { from: STRANGER, id });
    assert.equal(first.status, 'processed');
    const message = await db('messages').where({ id: first.messageId }).first();
    created.contacts.push(message.contact_id);
    const person = await db('contacts').where({ id: message.contact_id }).first();
    assert.equal(person.primary_phone, STRANGER);
    const conversation = await db('conversations').where({ id: message.conversation_id }).first();
    assert.equal(conversation.connection_id, whatsappConnection.id);
    assert.equal(conversation.contact_address, STRANGER);
    assert.equal(conversation.company_id, satnpaper.id);
    const payload = (await db('outbox_events').where({ aggregate_id: message.id, type: 'message.received' }).first()).payload;
    assert.equal(payload.contactCreated, true);
    assert.equal(payload.isNewEnquiry, true);
    assert.ok(payload.windowExpiresAt);

    const again = await inbound('Hello, I want SAT coaching for my son', { from: STRANGER, id });
    assert.equal(again.status, 'duplicate');
    assert.equal(await db('messages').where({ contact_id: message.contact_id }).count({ n: '*' }).first().then((r) => Number(r.n)), 1);
    assert.equal(await db('contact_methods').where({ normalized: STRANGER }).count({ n: '*' }).first().then((r) => Number(r.n)), 1);

    // The provider and the WhatsApp tool deliver the same message at the same moment: stored once.
    const raced = await Promise.all([1, 2].map(() => inbound('Is the weekend batch open?', { from: STRANGER, id: `${id}.race` })));
    assert.deepEqual(raced.map((r) => r.status).sort(), ['duplicate', 'processed']);
    assert.equal(raced[0].messageId, raced[1].messageId);
  });

  await t.test('the WhatsApp tool: signed events, bot replies, status and handover', async () => {
    const events = [
      { id: `tool-out-${RUN}`, type: 'message.out', occurredAt: new Date().toISOString(), data: { messageId: `wamid.tool.${RUN}`, to: PHONE, text: 'Our counsellor will call you shortly.', agent: { type: 'bot', name: 'Asha bot' } } },
      { id: `tool-hand-${RUN}`, type: 'conversation.handover', occurredAt: new Date().toISOString(), data: { from: PHONE, to: 'human', reason: 'Asked about fees', summary: 'Parent wants the fee structure for the SAT batch.' } },
    ];
    const request = buildWhatsappToolRequest(whatsappConnection.id, events);
    assert.deepEqual(await whatsappTool.verifyWebhook(request, { connectionId: whatsappConnection.id }), { ok: true });
    assert.equal((await whatsappTool.verifyWebhook({ ...request, rawBody: Buffer.from('{"events":[]}') }, { connectionId: whatsappConnection.id })).ok, false);
    assert.equal((await whatsappTool.verifyWebhook(request, { connectionId: randomUUID() })).reason, 'bad_signature');
    const parsed = await whatsappTool.parseWebhook(request);
    assert.equal(parsed.events.length, 2);
    for (const item of parsed.events) assert.equal((await handleWhatsappToolEvent(item, { connection })).status, 'processed');
    for (const item of parsed.events) assert.equal((await handleWhatsappToolEvent(item, { connection })).status, 'duplicate');

    const botReply = await db('messages').where({ provider_message_id: `wamid.tool.${RUN}` }).first();
    assert.equal(botReply.direction, 'outbound');
    assert.equal(botReply.source, 'whatsapp_tool');
    assert.equal(botReply.actor_type, 'ai');
    const conversation = await db('conversations').where({ id: botReply.conversation_id }).first();
    assert.equal(conversation.handled_by, 'human');
    const handover = await db('timeline_events').where({ source_event_id: `whatsapp_tool:tool-hand-${RUN}` }).first();
    assert.equal(handover.title, 'WhatsApp chat handed over to a person: Asked about fees');
    assert.equal(handover.deal_id, dealId);
    const status = await handleWhatsappToolEvent({ eventId: `tool-st-${RUN}`, type: 'message.status', occurredAt: new Date().toISOString(), data: { messageId: `wamid.tool.${RUN}`, status: 'delivered' } }, { connection });
    assert.equal(status.status, 'processed');
    await assert.rejects(() => whatsappTool.parseWebhook({ rawBody: Buffer.from('nope') }), (err) => err.status === 422);
  });

  await t.test('messages list: newest first, keyset pages, the deal\'s own messages', async () => {
    const first = await ritika('GET', `/messaging/messages?dealId=${dealId}&limit=2`);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.data.length, 2);
    assert.ok(first.body.nextCursor);
    const second = await ritika('GET', `/messaging/messages?dealId=${dealId}&limit=2&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.data.length, 2);
    const ids = new Set([...first.body.data, ...second.body.data].map((m) => m.id));
    assert.equal(ids.size, 4);
    const times = [...first.body.data, ...second.body.data].map((m) => m.occurredAt);
    assert.deepEqual(times, [...times].sort().reverse());
    const byContact = await ritika('GET', `/messaging/messages?contactId=${contact.id}&channel=email`);
    assert.equal(byContact.status, 200, byContact.text);
    assert.ok(byContact.body.data.every((m) => m.channel === 'email'));
    assert.equal(byContact.body.data.length, 1);
  });

  await t.test('scoping: other companies 404, own-only counsellors, managers see their branch', async () => {
    assert.equal((await pvAdmin('GET', `/messaging/context?dealId=${dealId}`)).status, 404);
    assert.equal((await sendBooking(pvAdmin)).status, 404);
    assert.equal((await pvAdmin('GET', `/messaging/messages?contactId=${contact.id}`)).status, 404);
    assert.equal((await ritika('GET', `/messaging/context?dealId=${kabirDeal.id}`)).status, 404, "ritika can't see kabir's deals");
    const asKabir = await kabir('GET', `/messaging/context?dealId=${dealId}`);
    assert.equal(asKabir.status, 200, asKabir.text);
    assert.equal(asKabir.body.data.can.send, true);
    const asOwner = await owner('GET', `/messaging/context?contactId=${contact.id}`);
    assert.equal(asOwner.status, 200, asOwner.text);
    assert.equal((await owner('GET', `/messaging/messages?contactId=${contact.id}`)).body.data.length >= 8, true);
    const kabirSends = await sendBooking(kabir);
    assert.equal(kabirSends.status, 201, kabirSends.text);
  });

  await t.test('numbers are masked for a role without contacts.view_pii, which also cannot send', async () => {
    const marketing = await db('roles').where({ key: 'marketing' }).first('id');
    const pvUser = await db('users').where({ email: 'admin.pivector@phoenix.test' }).first('id');
    const [assignment] = await db('role_assignments').insert({ user_id: pvUser.id, role_id: marketing.id, org_unit_id: satnpaper.id }).returning('id');
    created.assignments.push(assignment.id);
    await bumpAccessVersion();
    const res = await pvAdmin('GET', `/messaging/context?contactId=${contact.id}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.can.send, false);
    assert.equal(res.body.data.contact.piiMasked, true);
    const address = res.body.data.channels.find((c) => c.channel === 'whatsapp').addresses[0].value;
    assert.notEqual(address, PHONE);
    assert.match(address, /•/);
    const list = await pvAdmin('GET', `/messaging/messages?contactId=${contact.id}`);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.data.length > 0);
    assert.ok(list.body.data.every((m) => m.piiMasked && (!m.to || m.to.includes('•'))));
    const refused = await pvAdmin('POST', '/messaging/messages', { contactId: contact.id, channel: 'email', text: 'Hi', subject: 'Hi' });
    assert.equal(refused.status, 403);
    await db('role_assignments').where({ id: assignment.id }).delete();
    created.assignments = [];
    await bumpAccessVersion();
  });

  await t.test('sendMessage for automations: a system actor, by template name, idempotent by reference', async () => {
    const input = {
      companyId: satnpaper.id,
      channel: 'whatsapp',
      contactId: contact.id,
      dealId,
      template: { name: 'demo_reminder', language: 'en' },
      variables: { demo_time: 'Sat 14 Nov, 5 pm' },
      reference: `reminder-${RUN}`,
      actor: { type: 'system' },
    };
    const first = await sendMessage(input);
    const again = await sendMessage(input);
    assert.equal(first.message.status, 'sent');
    assert.equal(again.created, false);
    assert.equal(again.message.id, first.message.id);
    const entry = await db('timeline_events').where({ source_event_id: `message:${first.message.id}` }).first();
    assert.equal(entry.actor_type, 'system');
  });

  await t.test('templates: list, create, edit, submit (the mock approves), new versions, scoping', async () => {
    const list = await spAdmin('GET', `/messaging/templates?companyId=${satnpaper.id}`);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.data.length >= 10);
    assert.ok(list.body.data.every((tpl) => tpl.companyId === satnpaper.id && tpl.can.manage));
    const forGroup = await owner('GET', `/messaging/templates?unitId=${satnpaper.root_id}&channel=sms`);
    assert.ok(forGroup.body.data.length >= 6 && forGroup.body.data.every((tpl) => tpl.channel === 'sms'));

    const name = `qa_${RUN}`;
    const body = { companyId: satnpaper.id, channel: 'whatsapp', name, language: 'en', category: 'utility', body: 'Hi {{first_name}}, your class starts at {{class_time}} today.' };
    const createdRes = await spAdmin('POST', '/messaging/templates', body);
    assert.equal(createdRes.status, 201, createdRes.text);
    const tpl = createdRes.body.data;
    created.templates.push(tpl.id);
    assert.deepEqual([tpl.status, tpl.latestVersion, tpl.approvedVersion], ['draft', 1, null]);
    assert.deepEqual(tpl.variables, ['first_name', 'class_time']);
    assert.equal(tpl.providerBody, 'Hi {{1}}, your class starts at {{2}} today.');
    assert.equal((await spAdmin('POST', '/messaging/templates', body)).status, 409);
    const invalid = await spAdmin('POST', '/messaging/templates', { ...body, name: 'Bad Name', body: '{{first_name}} hi' });
    assert.equal(invalid.status, 422);
    assert.deepEqual(invalid.body.error.details.map((d) => d.path).sort(), ['body.body', 'body.name']);

    const noSamples = await spAdmin('POST', `/messaging/templates/${tpl.id}/submit`);
    assert.equal(noSamples.status, 422);
    const edited = await spAdmin('PATCH', `/messaging/templates/${tpl.id}`, { samples: { first_name: 'Priya', class_time: '5 pm' } });
    assert.equal(edited.body.data.latestVersion, 1, 'a draft is edited in place');
    const submitted = await spAdmin('POST', `/messaging/templates/${tpl.id}/submit`);
    assert.equal(submitted.status, 200, submitted.text);
    assert.deepEqual([submitted.body.data.status, submitted.body.data.approvedVersion], ['approved', 1]);
    assert.equal((await spAdmin('POST', `/messaging/templates/${tpl.id}/submit`)).status, 409);

    const v2 = await spAdmin('PATCH', `/messaging/templates/${tpl.id}`, { body: 'Hi {{first_name}}, your class starts at {{class_time}} today. See you!' });
    assert.deepEqual([v2.body.data.status, v2.body.data.latestVersion, v2.body.data.approvedVersion], ['draft', 2, 1]);
    assert.match(v2.body.data.live.body, /today\.$/, 'the approved version keeps sending');
    assert.equal((await spAdmin('PATCH', `/messaging/templates/${tpl.id}`, { category: 'marketing' })).status, 409);
    const detail = await spAdmin('GET', `/messaging/templates/${tpl.id}`);
    assert.deepEqual(detail.body.data.versions.map((v) => [v.version, v.status]), [[2, 'draft'], [1, 'approved']]);

    assert.equal((await ritika('GET', `/messaging/templates/${tpl.id}`)).status, 200);
    assert.equal((await ritika('PATCH', `/messaging/templates/${tpl.id}`, { description: 'x' })).status, 403);
    assert.equal((await ritika('POST', '/messaging/templates', { ...body, name: `${name}_r` })).status, 403);
    assert.equal((await pvAdmin('GET', `/messaging/templates/${tpl.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/messaging/templates?companyId=${satnpaper.id}`)).status, 404);

    assert.equal((await spAdmin('DELETE', `/messaging/templates/${tpl.id}`)).status, 204);
    const ctx = (await ritika('GET', `/messaging/context?dealId=${dealId}`)).body.data;
    assert.ok(!ctx.templates.some((x) => x.id === tpl.id), 'archived templates are not offered');
    assert.equal((await spAdmin('PATCH', `/messaging/templates/${tpl.id}`, { description: 'x' })).status, 409);
  });
});
