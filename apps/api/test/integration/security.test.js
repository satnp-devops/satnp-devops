import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Security review of the CRM (wave 1 and the wave-2a modules) against the seeded database:
//   - admin.pivector (company admin of Pi Vector) can neither see nor change SatnPaper data in any
//     module, nor reach it by putting SatnPaper ids into Pi Vector writes; group-level lists and
//     search hold nothing of SatnPaper;
//   - ritika (counsellor, ":own" grants) works only her own leads;
//   - an analyst (no contacts.view_pii) sees phones and emails masked everywhere, including intake
//     explanations, phone and email custom fields and other people's CSV imports;
//   - erasing or merging a person keeps the AI log in step;
//   - the public webhook URL limits refused deliveries per IP and deliveries per connection;
//   - API keys stay inside their company and their scopes.
// Needs a migrated and seeded database (npm run db:migrate && npm run db:seed && npm run roles:sync).
//   INTEGRATION=1 node --test test/integration/security.test.js

const enabled = process.env.INTEGRATION === '1';
// Low webhook limits for this process only (node --test runs each file in its own process).
process.env.WEBHOOK_FAILURE_LIMIT = '6';
process.env.WEBHOOK_RATE_LIMIT = '8';

const RUN = Date.now().toString(36);
let phoneSeq = Math.floor(Math.random() * 50_000);
const fakePhone = () => `+9190007${String((phoneSeq += 7) % 100_000).padStart(5, '0')}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

test('Security: company isolation, own scope, PII masking, webhooks and API keys', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const { env } = await import('../../src/config/env.js');
  const { db } = await import('../../src/lib/db.js');
  const { redis } = await import('../../src/lib/redis.js');
  const { hashPassword } = await import('../../src/lib/crypto.js');
  const { bumpAccessVersion } = await import('../../src/core/access.js');
  const { closeQueues } = await import('../../src/core/queue.js');
  const { dispatchEvent, toEvent } = await import('../../src/core/events.js');
  const { createApp } = await import('../../src/app.js');
  const { buildRegistry } = await import('../../src/registry.js');
  const { modules } = await import('../../src/modules/index.js');
  const { buildMockWebhookRequest } = await import('../../src/integrations/index.js');

  const registry = buildRegistry();
  const app = createApp({ registry, modules });
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/v1`;

  const cleanup = { assignments: [], contacts: [], deals: [], importJobs: [], aiActions: [], apiKeys: [], fieldIds: [], webhookIds: [], partners: [], users: [], restore: [] };
  t.after(async () => {
    for (const undo of cleanup.restore.reverse()) await undo().catch(() => {});
    if (cleanup.partners.length) {
      await db('partner_attributions').whereIn('partner_id', cleanup.partners).delete();
      await db('partner_referral_links').whereIn('partner_id', cleanup.partners).delete();
      await db('partner_companies').whereIn('partner_id', cleanup.partners).delete();
      await db('partners').whereIn('id', cleanup.partners).delete();
    }
    if (cleanup.users.length) {
      const ids = await db('users').whereIn('email', cleanup.users).pluck('id');
      await db('sessions').whereIn('user_id', ids).delete();
      await db('user_tokens').whereIn('user_id', ids).delete();
      await db('role_assignments').whereIn('user_id', ids).delete();
      await db('users').whereIn('id', ids).delete();
      await bumpAccessVersion();
    }
    if (cleanup.assignments.length) {
      await db('role_assignments').whereIn('id', cleanup.assignments).delete();
      await bumpAccessVersion();
    }
    if (cleanup.fieldIds.length) await db('custom_field_definitions').whereIn('id', cleanup.fieldIds).update({ active: false });
    if (cleanup.importJobs.length) {
      const refs = await db('intake_import_jobs').whereIn('id', cleanup.importJobs).pluck('file_ref');
      await db('intake_import_rows').whereIn('job_id', cleanup.importJobs).delete();
      await db('intake_import_jobs').whereIn('id', cleanup.importJobs).delete();
      const fileIds = refs.filter(Boolean).map((ref) => String(ref).replace(/^intake-file:/, ''));
      if (fileIds.length) await db('intake_files').whereIn('id', fileIds).delete();
    }
    if (cleanup.apiKeys.length) await db('api_keys').whereIn('id', cleanup.apiKeys).whereNull('revoked_at').update({ revoked_at: new Date() });
    if (cleanup.aiActions.length) await db('ai_actions').whereIn('id', cleanup.aiActions).delete();
    if (cleanup.deals.length) await db('deals').whereIn('id', cleanup.deals).whereNull('archived_at').update({ archived_at: new Date() });
    await db('webhook_events').where('external_event_id', 'like', `sec_${RUN}%`).delete();
    if (cleanup.webhookIds.length) {
      await db('webhook_events').whereIn('connection_id', cleanup.webhookIds).where({ status: 'rejected' }).where('received_at', '>=', startedAt).delete();
    }
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(...keys);
    server.close();
    await closeQueues();
    await db.destroy();
    await redis.quit();
  });
  const startedAt = new Date();
  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  function client({ bearer } = {}) {
    let cookie = '';
    async function call(method, path, body, { headers = {}, raw } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(raw === undefined ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : { 'x-phoenix-client': 'integration-test' }),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      });
      for (const header of res.headers.getSetCookie()) {
        const [pair] = header.split(';');
        if (pair.startsWith(`${env.SESSION_COOKIE_NAME}=`)) cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, body: json, text, headers: res.headers };
    }
    call.login = async (email) => {
      const res = await call('POST', '/auth/login', { email, password: env.SEED_PASSWORD });
      assert.equal(res.status, 200, `${email}: ${res.text}`);
    };
    return call;
  }

  // ---------- Seeded units, people and a temporary analyst and marketer at SatnPaper ----------
  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const unitByCode = (code) => units.find((u) => u.code === code);
  const satnpaper = unitByCode('satnpaper');
  const pivector = unitByCode('pi-vector');
  const satAdmissions = unitByCode('sat-admissions');
  const pvTeam = units.find((u) => u.parent_id === pivector.id && u.status === 'active') ?? pivector;
  assert.ok(satnpaper && pivector && satAdmissions, 'seeded units');
  const userId = async (email) => (await db('users').where({ email }).first('id'))?.id;
  const ritikaId = await userId('ritika@phoenix.test');
  const kabirId = await userId('kabir@phoenix.test');

  async function tempUser(email, name, roleKey, unit) {
    let id = await userId(email);
    if (!id) {
      [{ id }] = await db('users').insert({ email, name, status: 'active', password_hash: await hashPassword(env.SEED_PASSWORD) }).returning('id');
    }
    const role = await db('roles').whereNull('group_id').where({ key: roleKey }).first();
    const [assignment] = await db('role_assignments').insert({ user_id: id, role_id: role.id, org_unit_id: unit.id }).returning('id');
    cleanup.assignments.push(assignment.id ?? assignment);
    return id;
  }
  await tempUser('sec.analyst@phoenix.test', 'Security Analyst', 'analyst', satnpaper);
  await tempUser('sec.marketer@phoenix.test', 'Security Marketer', 'marketing', satnpaper);
  await bumpAccessVersion();

  const owner = client();
  const pvAdmin = client();
  const ritika = client();
  const analyst = client();
  const marketer = client();
  await Promise.all([
    owner.login('owner@phoenix.test'),
    pvAdmin.login('admin.pivector@phoenix.test'),
    ritika.login('ritika@phoenix.test'),
    analyst.login('sec.analyst@phoenix.test'),
    marketer.login('sec.marketer@phoenix.test'),
  ]);

  // ---------- SatnPaper records and their ids ----------
  const satIds = new Set();
  const satRows = {};
  const companyTables = [
    'deals', 'tasks', 'pipelines', 'message_templates', 'ai_actions', 'ai_knowledge_articles', 'scheduling_event_types', 'bookings',
    'scheduling_booking_links', 'quotes', 'payments', 'invoices', 'refunds', 'subscriptions', 'agreements', 'instalment_plans', 'intake_forms',
    'intake_enquiries', 'automation_flows', 'automation_runs', 'automation_approvals', 'partner_commissions', 'partner_payouts', 'batches',
    'enrollments', 'onboarding_checklists', 'implementation_projects', 'saved_views', 'lost_reasons', 'product_lines', 'products',
  ];
  for (const table of companyTables) {
    satRows[table] = await db(table).where({ company_id: satnpaper.id }).orderBy('id').limit(200).pluck('id');
    for (const id of satRows[table]) satIds.add(id);
  }
  // People, institutes and families known only to SatnPaper (no link or deal elsewhere).
  satRows.contacts = await db('contacts as c')
    .whereExists(db('contact_companies').whereRaw('contact_id = c.id').where('company_id', satnpaper.id))
    .whereNotExists(db('contact_companies').whereRaw('contact_id = c.id').whereNot('company_id', satnpaper.id))
    .whereNotExists(db('deal_contacts as dc').join('deals as d', 'd.id', 'dc.deal_id').whereRaw('dc.contact_id = c.id').whereNot('d.company_id', satnpaper.id))
    .whereNull('c.merged_into_id')
    .orderBy('c.id')
    .limit(300)
    .pluck('c.id');
  satRows.accounts = await db('accounts as a')
    .whereExists(db('account_companies').whereRaw('account_id = a.id').where('company_id', satnpaper.id))
    .whereNotExists(db('account_companies').whereRaw('account_id = a.id').whereNot('company_id', satnpaper.id))
    .whereNotExists(db('deals').whereRaw('account_id = a.id').whereNot('company_id', satnpaper.id))
    .orderBy('a.id')
    .pluck('a.id');
  satRows.households = await db('households as h')
    .whereExists(db('household_members as m').whereRaw('m.household_id = h.id'))
    .whereNotExists(db('household_members as m').whereRaw('m.household_id = h.id').whereNotIn('m.contact_id', satRows.contacts))
    .orderBy('h.id')
    .pluck('h.id');
  satRows.partners = await db('partners as p')
    .whereExists(db('partner_companies').whereRaw('partner_id = p.id').where('company_id', satnpaper.id))
    .whereNotExists(db('partner_companies').whereRaw('partner_id = p.id').whereNot('company_id', satnpaper.id))
    .pluck('p.id');
  for (const table of ['contacts', 'accounts', 'households', 'partners']) for (const id of satRows[table]) satIds.add(id);
  const satIdsIn = (text) => [...new Set(String(text).match(UUID) ?? [])].filter((id) => satIds.has(id));

  // Every phone and email of every seeded person, to spot unmasked personal data.
  const pii = new Set();
  for (const m of await db('contact_methods').select('kind', 'normalized', 'value')) {
    const value = String(m.normalized || m.value || '');
    if (m.kind === 'email') pii.add(value.toLowerCase());
    else if (value.replace(/\D/g, '').length >= 10) pii.add(value.replace(/\D/g, '').slice(-10));
  }
  const unmaskedIn = (text) => {
    const lower = String(text).toLowerCase();
    const digits = String(text).replace(/\D+/g, ' ');
    return [...pii].filter((value) => (value.includes('@') ? lower.includes(value) : digits.includes(value)));
  };

  const pick = (table, n = 2) => (satRows[table] ?? []).slice(0, n);
  const pathsById = {
    deals: ['/deals/:id', '/deals/:id/stage-history', '/billing/deals/:id', '/timeline?dealId=:id', '/messaging/messages?dealId=:id', '/messaging/context?dealId=:id', '/scheduling/links?dealId=:id'],
    contacts: ['/contacts/:id', '/contacts/:id/duplicates', '/contacts/:id/consents', '/contacts/:id/export', '/timeline?contactId=:id', '/messaging/context?contactId=:id'],
    accounts: ['/accounts/:id', '/timeline?accountId=:id'],
    households: ['/households/:id'],
    tasks: ['/tasks/:id'],
    pipelines: ['/pipelines/:id'],
    message_templates: ['/messaging/templates/:id'],
    ai_actions: ['/ai/actions/:id'],
    ai_knowledge_articles: ['/ai/knowledge/:id'],
    scheduling_event_types: ['/scheduling/event-types/:id'],
    bookings: ['/scheduling/bookings/:id'],
    scheduling_booking_links: ['/scheduling/links/:id'],
    quotes: ['/billing/quotes/:id'],
    payments: ['/billing/payments/:id'],
    invoices: ['/billing/invoices/:id'],
    refunds: ['/billing/refunds/:id'],
    subscriptions: ['/billing/subscriptions/:id'],
    agreements: ['/billing/agreements/:id'],
    instalment_plans: ['/billing/instalment-plans/:id'],
    intake_forms: ['/intake/forms/:id'],
    intake_enquiries: ['/intake/enquiries/:id'],
    automation_flows: ['/automations/flows/:id', '/automations/flows/:id/versions'],
    automation_runs: ['/automations/runs/:id'],
    automation_approvals: ['/automations/approvals/:id'],
    partners: ['/partners/:id', '/partners/:id/payout-details'],
    partner_commissions: ['/partner-commissions/:id'],
    partner_payouts: ['/partner-payouts/:id'],
    batches: ['/batches/:id', '/batches/:id/waitlist'],
    enrollments: ['/enrollments/:id'],
    onboarding_checklists: ['/onboarding/checklists/:id'],
    implementation_projects: ['/implementation-projects/:id'],
  };

  await t.test('admin.pivector gets 404 for every SatnPaper record, in every module', async () => {
    let checked = 0;
    for (const [table, paths] of Object.entries(pathsById)) {
      const ids = pick(table);
      assert.ok(ids.length, `the seed has SatnPaper ${table}`);
      for (const id of ids) {
        for (const path of paths) {
          const res = await pvAdmin('GET', path.replace(':id', id));
          assert.equal(res.status, 404, `GET ${path} (${table}) as admin.pivector: ${res.status} ${res.text.slice(0, 160)}`);
          checked += 1;
        }
      }
    }
    for (const id of [ritikaId, kabirId]) {
      assert.equal((await pvAdmin('GET', `/users/${id}`)).status, 404, 'a SatnPaper person');
      assert.equal((await pvAdmin('GET', `/scheduling/availability/${id}`)).status, 404, "a SatnPaper person's hours");
    }
    assert.equal((await pvAdmin('GET', `/org/units/${satnpaper.id}`)).status, 404);
    assert.ok(checked > 60, `checked ${checked} paths`);
  });

  await t.test('admin.pivector cannot change SatnPaper records', async () => {
    const [dealId] = pick('deals');
    const deal = await db('deals').where({ id: dealId }).first();
    const [contactId] = pick('contacts');
    const stage = await db('pipeline_stages').where({ pipeline_id: deal.pipeline_id }).whereNot('id', deal.stage_id).first();
    const [flowId] = pick('automation_flows');
    const writes = [
      ['PATCH', `/deals/${dealId}`, { title: `pwned ${RUN}` }],
      ['POST', `/deals/${dealId}/move`, { stageId: stage.id }],
      ['POST', `/deals/${dealId}/archive`, { reason: 'x' }],
      ['POST', `/deals/${dealId}/assign`, { ownerUserId: null }],
      ['PATCH', `/contacts/${contactId}`, { firstName: 'pwned' }],
      ['POST', `/contacts/${contactId}/erase`, { reason: 'x', confirm: true }],
      ['POST', `/contacts/${contactId}/consents`, { companyId: satnpaper.id, channel: 'whatsapp', purpose: 'marketing', status: 'granted', source: 'manual' }],
      ['PATCH', `/accounts/${pick('accounts')[0]}`, { name: 'pwned' }],
      ['PATCH', `/tasks/${pick('tasks')[0]}`, { title: 'pwned' }],
      ['PATCH', `/pipelines/${pick('pipelines')[0]}`, { name: 'pwned' }],
      ['PATCH', `/messaging/templates/${pick('message_templates')[0]}`, { description: 'pwned' }],
      ['PATCH', `/ai/knowledge/${pick('ai_knowledge_articles')[0]}`, { title: 'pwned' }],
      ['PATCH', `/scheduling/event-types/${pick('scheduling_event_types')[0]}`, { name: 'pwned' }],
      ['POST', `/scheduling/bookings/${pick('bookings')[0]}/cancel`, { reason: 'x' }],
      ['PATCH', `/billing/quotes/${pick('quotes')[0]}`, { title: 'pwned' }],
      ['POST', `/billing/payments/${pick('payments')[0]}/cancel`, {}],
      ['POST', `/billing/subscriptions/${pick('subscriptions')[0]}/cancel`, { reason: 'pwned' }],
      ['PATCH', `/intake/forms/${pick('intake_forms')[0]}`, { name: 'pwned' }],
      ['PATCH', `/automations/flows/${flowId}`, { name: 'pwned' }],
      ['DELETE', `/automations/flows/${flowId}`],
      ['PATCH', `/partners/${pick('partners')[0]}`, { name: 'pwned' }],
      ['POST', `/partner-payouts/${pick('partner_payouts')[0]}/mark-paid`, { reference: 'pwned-ref' }],
      ['PATCH', `/batches/${pick('batches')[0]}`, { name: 'pwned' }],
      ['POST', `/enrollments/${pick('enrollments')[0]}/withdraw`, { channel: 'other', reason: 'x' }],
      ['PATCH', `/implementation-projects/${pick('implementation_projects')[0]}`, { name: 'pwned' }],
    ];
    for (const [method, path, body] of writes) {
      const res = await pvAdmin(method, path, body);
      assert.equal(res.status, 404, `${method} ${path} as admin.pivector: ${res.status} ${res.text.slice(0, 200)}`);
    }
    const after = await db('deals').where({ id: dealId }).first();
    assert.equal(after.title, deal.title);
    assert.equal(after.stage_id, deal.stage_id);
    assert.equal(after.archived_at, deal.archived_at);
    // Bulk actions skip what is out of scope.
    const bulk = await pvAdmin('POST', '/deals/bulk', { action: 'assign', ids: [dealId], ownerUserId: null });
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body.data.updated, []);
    assert.equal(bulk.body.data.failed[0]?.code, 'not_found');
  });

  await t.test('SatnPaper ids in Pi Vector writes are refused as not found', async () => {
    const pvDeal = await db('deals').where({ company_id: pivector.id, status: 'open', kind: 'b2c' }).whereNull('archived_at').first();
    const pvPartner = await db('partners as p').whereExists(db('partner_companies').whereRaw('partner_id = p.id').where('company_id', pivector.id)).first('p.id');
    const pvEventType = await db('scheduling_event_types').where({ company_id: pivector.id }).first();
    const pvProduct = await db('products as p').join('product_lines as l', 'l.id', 'p.product_line_id').where({ 'p.company_id': pivector.id, 'l.audience': 'b2c' }).first('p.id');
    const pvAccount = await db('accounts as a').whereExists(db('account_companies').whereRaw('account_id = a.id').where('company_id', pivector.id)).first('a.id');
    const [satDeal] = pick('deals');
    const [satContact] = pick('contacts');
    const [satAccount] = pick('accounts');
    const satDealRow = await db('deals').where({ id: satDeal }).first();
    const satLost = await db('lost_reasons').where({ company_id: satnpaper.id }).first();
    const satTemplate = pick('message_templates')[0];
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const refs = [
      ['POST', '/tasks', { dealId: satDeal, title: `probe ${RUN}`, dueAt: soon }],
      ['POST', '/tasks', { contactId: satContact, unitId: pvTeam.id, title: `probe ${RUN}`, dueAt: soon }],
      ['POST', '/tasks', { accountId: satAccount, unitId: pvTeam.id, title: `probe ${RUN}`, dueAt: soon }],
      ['POST', '/tasks', { dealId: pvDeal.id, title: `probe ${RUN}`, dueAt: soon, assigneeUserId: ritikaId }],
      ['POST', '/timeline', { dealId: satDeal, kind: 'note', body: `probe ${RUN}` }],
      ['POST', '/timeline', { contactId: satContact, companyId: pivector.id, kind: 'note', body: `probe ${RUN}` }],
      ['POST', `/deals/${pvDeal.id}/contacts`, { contactId: satContact, role: 'parent' }],
      ['POST', `/deals/${pvDeal.id}/move`, { stageId: satDealRow.stage_id }],
      ['POST', `/deals/${pvDeal.id}/lose`, { lostReasonId: satLost.id }],
      ['POST', `/deals/${pvDeal.id}/assign`, { ownerUserId: ritikaId }],
      ['PATCH', `/deals/${pvDeal.id}`, { primaryContactId: satContact }],
      ['PATCH', `/deals/${pvDeal.id}`, { productId: pick('products')[0] }],
      ['POST', '/deals', { unitId: pvTeam.id, kind: 'b2c', contact: { firstName: 'Probe', phones: [fakePhone()] }, pipelineId: pick('pipelines')[0] }],
      ['POST', `/accounts/${pvAccount.id}/contacts`, { contactId: satContact, role: 'other' }],
      ['POST', '/households', { unitId: pvTeam.id, name: `probe ${RUN}`, members: [{ contactId: satContact, role: 'parent' }] }],
      ['POST', '/messaging/messages', { contactId: satContact, channel: 'whatsapp', text: `probe ${RUN}` }],
      ['POST', '/messaging/messages', { dealId: satDeal, channel: 'whatsapp', text: `probe ${RUN}` }],
      ['POST', '/messaging/messages', { dealId: pvDeal.id, channel: 'whatsapp', templateId: satTemplate }],
      ['POST', '/scheduling/links', { eventTypeId: pvEventType.id, dealId: satDeal }],
      ['POST', '/scheduling/links', { eventTypeId: pick('scheduling_event_types')[0], dealId: pvDeal.id }],
      ['POST', '/billing/quotes', { dealId: satDeal, lines: [{ description: 'x', quantity: 1, unitPriceMinor: 100 }] }],
      ['POST', '/billing/payments/links', { dealId: satDeal, purpose: 'full' }],
      ['POST', '/billing/payments/links', { dealId: pvDeal.id, purpose: 'full', quoteId: pick('quotes')[0] }],
      ['POST', '/billing/refunds', { paymentId: pick('payments')[0], amountMinor: 100, reason: 'other' }],
      ['POST', '/partner-attributions', { dealId: satDeal, partnerId: pvPartner.id, touch: 'first' }],
      ['POST', '/partner-attributions', { dealId: pvDeal.id, partnerId: pick('partners')[0], touch: 'first' }],
      ['POST', '/enrollments', { unitId: pvTeam.id, productId: pvProduct.id, studentContactId: satContact }],
      ['POST', '/implementation-projects', { unitId: pvTeam.id, accountId: pvAccount.id, dealId: satDeal, name: 'x' }],
      ['POST', '/automations/simulate', { companyId: pivector.id, flowId: pick('automation_flows')[0] }],
    ];
    for (const [method, path, body] of refs) {
      const res = await pvAdmin(method, path, body);
      assert.ok([404, 422].includes(res.status), `${method} ${path} ${JSON.stringify(body)}: ${res.status} ${res.text.slice(0, 200)}`);
      if (res.status === 422) assert.ok(res.body.error.details?.length, 'the refusal names the field');
    }
    assert.equal(await db('tasks').where('title', `probe ${RUN}`).count({ n: '*' }).first().then((r) => Number(r.n)), 0);
    assert.equal(await db('timeline_events').where('body', `probe ${RUN}`).count({ n: '*' }).first().then((r) => Number(r.n)), 0);
  });

  await t.test('SatnPaper lists are 404 for admin.pivector; its group-level lists and search hold nothing of SatnPaper', async () => {
    const lists = [
      '/deals', '/contacts', '/accounts', '/households', '/tasks', '/saved-views', '/ai/actions', '/ai/knowledge', '/automations/flows', '/automations/runs',
      '/scheduling/event-types', '/scheduling/bookings', '/billing/quotes', '/billing/payments', '/billing/invoices', '/billing/subscriptions', '/billing/agreements',
      '/intake/enquiries', '/intake/review', '/partners', '/partner-commissions', '/batches', '/enrollments', '/implementation-projects', '/renewals',
    ];
    for (const path of lists) {
      const sat = await pvAdmin('GET', `${path}?unitId=${satnpaper.id}`);
      assert.ok([403, 404].includes(sat.status), `GET ${path}?unitId=SatnPaper: ${sat.status}`);
      for (const unitId of [group.id, pivector.id]) {
        const res = await pvAdmin('GET', `${path}?unitId=${unitId}`);
        if (res.status >= 300) continue; // some lists need a company
        assert.deepEqual(satIdsIn(res.text), [], `GET ${path}?unitId=${unitId === group.id ? 'group' : 'Pi Vector'} lists SatnPaper records`);
      }
    }
    const people = await db('contacts').whereIn('id', pick('contacts', 4)).select('id', 'display_name', 'primary_phone');
    for (const person of people) {
      for (const q of [person.display_name, person.primary_phone].filter((v) => v && v.length >= 2)) {
        for (const unitId of [group.id, pivector.id]) {
          const search = await pvAdmin('GET', `/search?${new URLSearchParams({ q, unitId })}`);
          assert.equal(search.status, 200);
          assert.deepEqual(satIdsIn(search.text), [], `search "${q}" finds a SatnPaper record`);
          const contacts = await pvAdmin('GET', `/contacts?${new URLSearchParams({ q, unitId })}`);
          if (contacts.status === 200) assert.deepEqual(satIdsIn(contacts.text), [], `contacts q="${q}"`);
        }
      }
    }
  });

  await t.test('ritika (counsellor) works only her own leads', async () => {
    const page = await ritika('GET', `/deals?unitId=${satnpaper.id}&limit=100`);
    assert.equal(page.status, 200);
    assert.ok(page.body.data.length > 0);
    assert.deepEqual(page.body.data.filter((d) => d.owner?.id !== ritikaId).map((d) => d.ref), [], 'deals she does not own');
    const tasks = await ritika('GET', `/tasks?unitId=${satnpaper.id}&limit=100`);
    assert.equal(tasks.status, 200);

    const kabirDeals = await db('deals').where({ company_id: satnpaper.id, owner_user_id: kabirId }).whereNull('archived_at').limit(3).pluck('id');
    assert.ok(kabirDeals.length, "the seed has kabir's leads");
    for (const id of kabirDeals) {
      for (const path of pathsById.deals) {
        const res = await ritika('GET', path.replace(':id', id));
        assert.equal(res.status, 404, `ritika GET ${path} for kabir's lead: ${res.status}`);
      }
      for (const [method, path, body] of [
        ['PATCH', `/deals/${id}`, { title: 'x' }],
        ['POST', `/deals/${id}/seen`, {}],
        ['POST', '/tasks', { dealId: id, title: `probe ${RUN}`, dueAt: new Date(Date.now() + 86_400_000).toISOString() }],
        ['POST', '/timeline', { dealId: id, kind: 'note', body: `probe ${RUN}` }],
        ['POST', '/messaging/messages', { dealId: id, channel: 'whatsapp', text: `probe ${RUN}` }],
      ]) {
        const res = await ritika(method, path, body);
        assert.ok([404, 422].includes(res.status), `ritika ${method} ${path}: ${res.status} ${res.text.slice(0, 160)}`);
      }
      assert.ok(!tasks.text.includes(id), "a task on kabir's lead in her list");
    }
    // Records tied to kabir's leads in other modules.
    for (const [table, path] of [['quotes', '/billing/quotes/:id'], ['payments', '/billing/payments/:id'], ['bookings', '/scheduling/bookings/:id'], ['ai_actions', '/ai/actions/:id'], ['enrollments', '/enrollments/:id']]) {
      const cols = Object.keys(await db(table).columnInfo());
      let query = db(table).where({ company_id: satnpaper.id }).whereIn('deal_id', db('deals').where({ owner_user_id: kabirId }).select('id'));
      if (cols.includes('owner_user_id')) query = query.whereNot('owner_user_id', ritikaId);
      if (cols.includes('host_user_id')) query = query.whereNot('host_user_id', ritikaId);
      for (const id of await query.limit(3).pluck('id')) {
        assert.equal((await ritika('GET', path.replace(':id', id))).status, 404, `ritika ${path} on kabir's lead`);
      }
    }
  });

  await t.test('an analyst (no contacts.view_pii) sees phones and emails masked everywhere', async () => {
    const paths = [
      `/deals?unitId=${satnpaper.id}&limit=100`, `/contacts?unitId=${satnpaper.id}&limit=100`, `/accounts?unitId=${satnpaper.id}&limit=100`,
      `/households?unitId=${satnpaper.id}`, `/intake/enquiries?unitId=${satnpaper.id}`, `/intake/review?unitId=${satnpaper.id}`,
      `/scheduling/bookings?unitId=${satnpaper.id}`, `/billing/quotes?unitId=${satnpaper.id}`, `/billing/payments?unitId=${satnpaper.id}`,
      `/billing/invoices?unitId=${satnpaper.id}`, `/billing/agreements?unitId=${satnpaper.id}`, `/enrollments?unitId=${satnpaper.id}`,
      `/ai/actions?unitId=${satnpaper.id}`, `/partners?unitId=${satnpaper.id}`, `/partner-commissions?unitId=${satnpaper.id}`,
    ];
    for (const table of ['deals', 'contacts', 'accounts', 'households', 'intake_enquiries', 'bookings', 'quotes', 'payments', 'invoices', 'agreements', 'enrollments', 'ai_actions', 'partners']) {
      const [template] = pathsById[table];
      for (const id of pick(table, 4)) paths.push(template.replace(':id', id));
    }
    for (const person of await db('contacts').whereIn('id', pick('contacts', 3)).select('display_name', 'primary_phone')) {
      for (const q of [person.display_name, person.primary_phone].filter(Boolean)) paths.push(`/search?${new URLSearchParams({ q, unitId: satnpaper.id })}`);
    }
    let seen = 0;
    for (const path of paths) {
      const res = await analyst('GET', path);
      if (res.status !== 200) continue;
      seen += 1;
      // Search answers with the text the analyst typed (`query`); only what it found must be masked.
      const shown = path.startsWith('/search') ? JSON.stringify(res.body.data.groups ?? res.body.data) : res.text;
      assert.deepEqual(unmaskedIn(shown), [], `GET ${path} as an analyst shows personal data`);
    }
    assert.ok(seen >= paths.length - 4, `the analyst can read the lists (${seen} of ${paths.length})`);

    // The intake log explains its decisions with the matched number ("Same phone +91…").
    const merged = await db('intake_enquiries').where({ company_id: satnpaper.id }).whereRaw("dedup->>'explanation' ~ '[0-9]{8}'").first('id');
    assert.ok(merged, 'the seed has an enquiry matched on a phone');
    const detail = await analyst('GET', `/intake/enquiries/${merged.id}`);
    assert.equal(detail.status, 200);
    assert.match(detail.body.data.dedup.explanation, /•/);
    assert.deepEqual(unmaskedIn(detail.text), []);
    const full = await owner('GET', `/intake/enquiries/${merged.id}`);
    assert.doesNotMatch(full.body.data.dedup.explanation, /•/, 'people with contacts.view_pii see it as it is');
  });

  await t.test('phone and email custom fields are masked like the person’s own details', async () => {
    const key = 'sec_alt_phone';
    let field = await db('custom_field_definitions').where({ company_id: satnpaper.id, entity: 'deal', key }).first();
    if (!field) {
      const created = await owner('POST', '/custom-fields', { companyId: satnpaper.id, entity: 'deal', key, label: 'Alternate phone', type: 'phone' });
      assert.equal(created.status, 201, created.text);
      field = { id: created.body.data.id };
    } else {
      assert.equal((await owner('PATCH', `/custom-fields/${field.id}`, { active: true })).status, 200);
    }
    cleanup.fieldIds.push(field.id);
    const deal = await db('deals').where({ company_id: satnpaper.id, status: 'open' }).whereNull('archived_at').first();
    const phone = fakePhone();
    const set = await owner('PATCH', `/deals/${deal.id}`, { custom: { [key]: phone } });
    assert.equal(set.status, 200, set.text);
    const digits = phone.replace(/\D/g, '');
    const seenByOwner = await owner('GET', `/deals/${deal.id}`);
    assert.equal(seenByOwner.body.data.custom[key], phone);
    const seenByAnalyst = await analyst('GET', `/deals/${deal.id}`);
    assert.equal(seenByAnalyst.status, 200);
    assert.ok(!seenByAnalyst.text.includes(digits.slice(-10)), 'the analyst sees the custom phone masked');
    assert.match(seenByAnalyst.body.data.custom[key], /•/);
    await owner('PATCH', `/deals/${deal.id}`, { custom: { [key]: null } });
  });

  await t.test("CSV imports: a marketer without contacts.view_pii sees other people's files masked", async () => {
    const csv = (name, phone, email) => `Name,Phone,Email\n${name},${phone},${email}\n`;
    const upload = async (as, body) => {
      const res = await as('POST', `/intake/imports?${new URLSearchParams({ unitId: satnpaper.id, fileName: `sec-${RUN}.csv` })}`, undefined, {
        headers: { 'content-type': 'text/csv' },
        raw: body,
      });
      assert.equal(res.status, 201, res.text);
      cleanup.importJobs.push(res.body.data.id);
      return res.body.data;
    };
    const ownersPhone = fakePhone();
    const ownersFile = await upload(owner, csv('Asha Sec', ownersPhone, `asha.${RUN}@example.com`));
    const marketersPhone = fakePhone();
    const marketersFile = await upload(marketer, csv('Ravi Sec', marketersPhone, `ravi.${RUN}@example.com`));

    const others = await marketer('GET', `/intake/imports/${ownersFile.id}`);
    assert.equal(others.status, 200);
    assert.ok(!others.text.includes(ownersPhone.slice(-10)), "someone else's file: the phone is masked");
    assert.ok(!others.text.includes(`asha.${RUN}@example.com`), "someone else's file: the email is masked");
    assert.ok(others.text.includes('Asha Sec'), 'names stay readable for mapping');
    const own = await marketer('GET', `/intake/imports/${marketersFile.id}`);
    assert.ok(own.text.includes(marketersPhone.slice(-10)), 'their own file is shown as uploaded');
    const list = await marketer('GET', `/intake/imports?unitId=${satnpaper.id}`);
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes(ownersPhone.slice(-10)));
    assert.ok(list.text.includes(marketersPhone.slice(-10)));
    const ownerView = await owner('GET', `/intake/imports/${marketersFile.id}`);
    assert.ok(ownerView.text.includes(marketersPhone.slice(-10)), 'contacts.view_pii sees every file');
  });

  await t.test('erasing or merging a person keeps the AI log in step', async () => {
    const make = async () => {
      const res = await owner('POST', '/contacts', { unitId: satAdmissions.id, firstName: 'Erase', lastName: `Sec${RUN}`, phones: [fakePhone()] });
      assert.equal(res.status, 201, res.text);
      cleanup.contacts.push(res.body.data.contact.id);
      return res.body.data.contact.id;
    };
    const aiAction = async (contactId) => {
      const [row] = await db('ai_actions')
        .insert({
          group_id: group.id,
          company_id: satnpaper.id,
          unit_id: satAdmissions.id,
          agent: 'reply',
          trigger: 'feature',
          contact_id: contactId,
          status: 'pending_review',
          input: JSON.stringify({ message: 'Call me on +91 98765 43210' }),
          input_summary: 'Asked for a call on +91 98765 43210',
          output: JSON.stringify({ reply: 'Sure, we will call +91 98765 43210' }),
          guardrails: JSON.stringify([{ check: 'pii', outcome: 'pass', message: 'quoted +91 98765 43210' }]),
        })
        .returning('id');
      cleanup.aiActions.push(row.id);
      return row.id;
    };
    const dispatchFor = async (type, aggregateId) => {
      const row = await db('outbox_events').where({ type, aggregate_id: aggregateId }).orderBy('created_at', 'desc').first();
      assert.ok(row, `${type} was emitted`);
      await dispatchEvent(registry, toEvent(row), { db, registry });
      await dispatchEvent(registry, toEvent(row), { db, registry }); // delivered twice: same result
    };

    const erased = await make();
    const erasedAction = await aiAction(erased);
    assert.equal((await owner('POST', `/contacts/${erased}/erase`, { reason: 'Asked on the phone', confirm: true })).status, 200);
    await dispatchFor('contact.erased', erased);
    const scrubbed = await db('ai_actions').where({ id: erasedAction }).first();
    assert.deepEqual(scrubbed.input, {});
    assert.equal(scrubbed.input_summary, null);
    assert.equal(scrubbed.output, null);
    assert.deepEqual(scrubbed.guardrails, [{ check: 'pii', outcome: 'pass' }]);
    assert.equal(scrubbed.status, 'rejected', 'a waiting review is closed');

    const target = await make();
    const source = await make();
    const movedAction = await aiAction(source);
    const merge = await owner('POST', `/contacts/${target}/merge`, { sourceId: source });
    assert.equal(merge.status, 200, merge.text);
    await dispatchFor('contact.merged', target);
    assert.equal((await db('ai_actions').where({ id: movedAction }).first()).contact_id, target);
  });

  await t.test('the public webhook URL limits refused deliveries per IP and deliveries per connection', async () => {
    const spPay = await db('integration_connections').where({ unit_id: satnpaper.id, kind: 'payments', provider: 'mock', status: 'active' }).whereNull('disconnected_at').orderBy('created_at').first();
    assert.ok(spPay, 'seeded mock payments connection');
    cleanup.webhookIds.push(spPay.id);
    const path = `/webhooks/mock/${spPay.id}`;
    const deliver = async ({ rawBody, headers }) => {
      const res = await fetch(base + path, { method: 'POST', headers, body: rawBody });
      return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
    };
    const event = (n) => ({ id: `sec_${RUN}_${n}`, type: 'payment.captured', occurredAt: new Date().toISOString(), reference: `sec-${RUN}`, data: { amountMinor: 100, currency: 'INR' } });
    const keys = async () => {
      const found = await redis.keys('rl:webhook*');
      if (found.length) await redis.del(...found);
    };
    await keys();

    // Unsigned deliveries are refused; after WEBHOOK_FAILURE_LIMIT of them the address gets 429s,
    // even for a correctly signed delivery.
    const unsigned = { headers: { 'content-type': 'application/json' }, rawBody: JSON.stringify({ events: [event('u')] }) };
    for (let i = 0; i < Number(env.WEBHOOK_FAILURE_LIMIT); i += 1) assert.equal((await deliver(unsigned)).status, 401);
    const blocked = await deliver(unsigned);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.retryAfter) > 0, 'Retry-After is set');
    assert.equal((await deliver(await buildMockWebhookRequest({ connectionId: spPay.id, events: [event('blocked')] }))).status, 429);

    // A flood on one connection: WEBHOOK_RATE_LIMIT deliveries a minute, then 429.
    await keys();
    for (let i = 0; i < Number(env.WEBHOOK_RATE_LIMIT); i += 1) {
      const res = await deliver(await buildMockWebhookRequest({ connectionId: spPay.id, events: [event(`ok${i}`)] }));
      assert.equal(res.status, 200, res.text);
    }
    const flooded = await deliver(await buildMockWebhookRequest({ connectionId: spPay.id, events: [event('flood')] }));
    assert.equal(flooded.status, 429);
    assert.equal(await db('webhook_events').where({ connection_id: spPay.id, external_event_id: `sec_${RUN}_flood` }).first(), undefined, 'a refused delivery is not stored');
    await keys();
  });

  await t.test('API keys stay inside their company and their scopes', async () => {
    const grantable = await pvAdmin('GET', `/api-keys/scopes?unitId=${pivector.id}`);
    assert.equal(grantable.status, 200);
    const keysOf = (groups) => groups.flatMap((g) => g.permissions.map((p) => p.key));
    const allowed = new Set(keysOf(grantable.body.data));
    const scopes = ['deals.view', 'contacts.view', 'billing.view', 'scheduling.view', 'enrollments.view', 'tasks.view'].filter((s) => allowed.has(s));
    assert.ok(scopes.includes('deals.view') && scopes.includes('contacts.view'));
    const created = await pvAdmin('POST', '/api-keys', { unitId: pivector.id, name: `security ${RUN}`, scopes });
    assert.equal(created.status, 201, created.text);
    const key = created.body.data;
    cleanup.apiKeys.push(key.id);
    const machine = client({ bearer: key.secret });

    // Its own company works; SatnPaper is 404 whatever the path.
    assert.equal((await machine('GET', `/deals?unitId=${pivector.id}`)).status, 200);
    assert.ok([403, 404].includes((await machine('GET', `/deals?unitId=${satnpaper.id}`)).status));
    for (const [table, path] of [['deals', '/deals/:id'], ['contacts', '/contacts/:id'], ['quotes', '/billing/quotes/:id'], ['bookings', '/scheduling/bookings/:id'], ['enrollments', '/enrollments/:id'], ['tasks', '/tasks/:id']]) {
      assert.equal((await machine('GET', path.replace(':id', pick(table)[0]))).status, 404, `API key GET ${path}`);
    }
    const groupList = await machine('GET', `/deals?unitId=${group.id}`);
    if (groupList.status === 200) assert.deepEqual(satIdsIn(groupList.text), []);
    // No write scope: 403 even on its own company's records, and no session or CSRF header needed to be refused.
    const pvDeal = await db('deals').where({ company_id: pivector.id }).whereNull('archived_at').first();
    assert.equal((await machine('PATCH', `/deals/${pvDeal.id}`, { title: 'x' })).status, 403);
    // A key can't make keys, and can't be made with more than its creator holds or above their company.
    assert.equal((await machine('POST', '/api-keys', { unitId: pivector.id, name: 'child', scopes: ['deals.view'] })).status, 403);
    assert.equal((await pvAdmin('POST', '/api-keys', { unitId: group.id, name: 'group', scopes: ['deals.view'] })).status, 403);
    const notHeld = keysOf((await owner('GET', '/permissions')).body.data).find((k) => !allowed.has(k) && !k.startsWith('api_keys.'));
    assert.ok(notHeld, 'a permission admin.pivector does not hold');
    assert.ok([403, 422].includes((await pvAdmin('POST', '/api-keys', { unitId: pivector.id, name: 'too much', scopes: [notHeld] })).status));
    // Revoked: refused at once.
    assert.equal((await pvAdmin('DELETE', `/api-keys/${key.id}`)).status, 204);
    assert.equal((await machine('GET', `/deals?unitId=${pivector.id}`)).status, 401);
  });

  await t.test('a Pi Vector flow cannot name SatnPaper people, teams or pipelines', async () => {
    const pvAdminId = await userId('admin.pivector@phoenix.test');
    const satPipeline = pick('pipelines')[0];
    const flow = (steps) => ({
      companyId: pivector.id,
      name: `Security ${RUN} ${randomUUID().slice(0, 6)}`,
      definition: { trigger: { type: 'enquiry.new' }, start: steps[0].id, steps, settings: { timeZone: 'Asia/Kolkata', reentry: 'allow' } },
    });
    const end = { id: 'done', type: 'end' };
    const refused = [
      [{ id: 'a', type: 'action', action: 'records.assign', params: { strategy: 'user', userId: ritikaId }, next: 'done' }, end],
      [{ id: 'a', type: 'action', action: 'records.assign', params: { strategy: 'round_robin', teamUnitId: satAdmissions.id }, next: 'done' }, end],
      [{ id: 'a', type: 'action', action: 'tasks.create', params: { title: 'Call', dueIn: '2h', assignee: kabirId }, next: 'done' }, end],
      [{ id: 'a', type: 'action', action: 'deals.change_stage', params: { stage: 'contacted', pipelineId: satPipeline }, next: 'done' }, end],
      [{ id: 'a', type: 'approval', title: 'Approve', approvers: { userIds: [ritikaId] }, next: 'done', onReject: 'done' }, end],
    ];
    for (const steps of refused) {
      const res = await pvAdmin('POST', '/automations/flows', flow(steps));
      assert.equal(res.status, 422, `${JSON.stringify(steps[0].params ?? steps[0].approvers)}: ${res.status} ${res.text.slice(0, 200)}`);
      assert.match(res.body.error.details[0].path, /^body\.definition\.steps\.0\./);
    }
    // Their own people are fine.
    const ok = await pvAdmin('POST', '/automations/flows', flow([{ id: 'a', type: 'action', action: 'records.assign', params: { strategy: 'user', userId: pvAdminId }, next: 'done' }, end]));
    assert.equal(ok.status, 201, ok.text);
    await db('automation_flow_versions').where({ flow_id: ok.body.data.id }).delete();
    await db('automation_flows').where({ id: ok.body.data.id }).delete();

    // A webhook step signs with an integration connection: only one of the flow's own company.
    const satConnection = await db('integration_connection_companies as l')
      .join('integration_connections as c', 'c.id', 'l.connection_id')
      .where('c.unit_id', satnpaper.id)
      .whereNull('c.disconnected_at')
      .whereNotIn('l.connection_id', db('integration_connection_companies').where({ company_id: pivector.id }).select('connection_id'))
      .first('l.connection_id');
    assert.ok(satConnection, 'a connection only SatnPaper uses');
    const webhook = (connectionId) => flow([{ id: 'a', type: 'action', action: 'http.call_webhook', params: { url: 'https://hooks.example.com/phoenix', connectionId }, next: 'done' }, end]);
    for (const connectionId of [satConnection.connection_id, randomUUID()]) {
      const res = await owner('POST', '/automations/flows', webhook(connectionId));
      assert.equal(res.status, 422, `webhook signed with ${connectionId}: ${res.status} ${res.text.slice(0, 200)}`);
      assert.equal(res.body.error.details[0].path, 'body.definition.steps.0.params.connectionId');
    }
    const pvConnection = await db('integration_connection_companies as l')
      .join('integration_connections as c', 'c.id', 'l.connection_id')
      .where('l.company_id', pivector.id)
      .whereNull('c.disconnected_at')
      .first('l.connection_id');
    const own = await owner('POST', '/automations/flows', webhook(pvConnection.connection_id));
    assert.equal(own.status, 201, own.text);
    await db('automation_flow_versions').where({ flow_id: own.body.data.id }).delete();
    await db('automation_flows').where({ id: own.body.data.id }).delete();
  });

  await t.test('a partner shared with SatnPaper: admin.pivector cannot take over its portal sign-in, see SatnPaper’s side through it, or change its bank details', async () => {
    const spAdmin = client();
    await spAdmin.login('admin.satnpaper@phoenix.test');
    const pvUnit = units.find((u) => u.code === 'admissions' && u.path.startsWith(pivector.path)) ?? pvTeam;
    const made = await owner('POST', '/partners', { unitId: satAdmissions.id, kind: 'organisation', name: `Shared Agency ${RUN}`, email: `shared.agency.${RUN}@example.com` });
    assert.equal(made.status, 201, made.text);
    const partnerId = made.body.data.id;
    cleanup.partners.push(partnerId);
    assert.equal((await owner('POST', `/partners/${partnerId}/companies`, { unitId: pvUnit.id })).status, 201);
    const satLink = await spAdmin('POST', '/partner-links', { partnerId, companyId: satnpaper.id, label: `SatnPaper ${RUN}` });
    const pvLink = await pvAdmin('POST', '/partner-links', { partnerId, companyId: pivector.id, label: `Pi Vector ${RUN}` });
    assert.equal(satLink.status, 201, satLink.text);
    assert.equal(pvLink.status, 201, pvLink.text);
    // A SatnPaper lead the partner referred.
    const satDeal = await db('deals as d')
      .where({ 'd.company_id': satnpaper.id, 'd.status': 'open' })
      .whereNull('d.archived_at')
      .whereNotExists(db('partner_attributions as a').whereRaw('a.deal_id = d.id'))
      .first('d.id');
    assert.equal((await spAdmin('POST', '/partner-attributions', { dealId: satDeal.id, partnerId, touch: 'first' })).status, 201);

    const partnerRole = await db('roles').whereNull('group_id').where({ key: 'partner' }).first('id');
    const portalUnits = async (email) =>
      (await db('role_assignments as ra').join('users as u', 'u.id', 'ra.user_id').where({ 'u.email': email, 'ra.role_id': partnerRole.id }).pluck('ra.org_unit_id')).sort();
    const signInAs = async (email) => {
      await db('users').where({ email }).update({ status: 'active', password_hash: await hashPassword(env.SEED_PASSWORD) });
      const portal = client();
      await portal.login(email);
      return portal;
    };
    const portalUserId = async () => (await db('partners').where({ id: partnerId }).first('user_id')).user_id;

    // 1. Pi Vector gives a sign-in to an address of its own: that portal shows Pi Vector's side only.
    const pvEmail = `pv.portal.${RUN}@example.com`;
    cleanup.users.push(pvEmail);
    assert.equal((await pvAdmin('POST', `/partners/${partnerId}/portal-access`, { email: pvEmail })).status, 200);
    assert.deepEqual(await portalUnits(pvEmail), [pvUnit.id], 'the partner role is given at Pi Vector’s partnership only');
    const pvPortal = await signInAs(pvEmail);
    const me = await pvPortal('GET', '/partner-portal/me');
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(me.body.data.companies.map((c) => c.company.id), [pivector.id], 'the portal covers only the company that gave the sign-in');
    assert.equal(me.body.data.stats.referredLeads, 0, 'SatnPaper’s referred lead is not counted');
    const links = await pvPortal('GET', '/partner-portal/links');
    assert.deepEqual(links.body.data.map((l) => l.id), [pvLink.body.data.id], 'only Pi Vector’s referral link');
    assert.deepEqual((await pvPortal('GET', `/partner-portal/links?companyId=${satnpaper.id}`)).body.data, []);
    assert.deepEqual((await pvPortal('GET', '/partner-portal/leads')).body.data, [], 'no SatnPaper leads');
    assert.equal((await pvPortal('POST', '/partner-portal/links', { companyId: satnpaper.id, label: 'x' })).status, 422);
    assert.equal((await pvPortal('PATCH', `/partner-portal/links/${satLink.body.data.id}`, { active: false })).status, 404);
    // Someone who manages every partnership removes it everywhere.
    const removed = await owner('DELETE', `/partners/${partnerId}/portal-access`);
    assert.equal(removed.body.data.hasPortalAccess, false);
    assert.equal(await portalUserId(), null);
    assert.deepEqual(await portalUnits(pvEmail), []);

    // 2. SatnPaper gives the partner their sign-in. Pi Vector can neither remove nor replace it.
    const satEmail = `sat.portal.${RUN}@example.com`;
    cleanup.users.push(satEmail);
    assert.equal((await spAdmin('POST', `/partners/${partnerId}/portal-access`, { email: satEmail })).status, 200);
    const satUser = await portalUserId();
    assert.deepEqual(await portalUnits(satEmail), [satAdmissions.id]);
    const pvView = await pvAdmin('GET', `/partners/${partnerId}`);
    assert.equal(pvView.body.data.hasPortalAccess, false, 'Pi Vector sees that the portal does not cover its partnership yet');
    const pvRemoves = await pvAdmin('DELETE', `/partners/${partnerId}/portal-access`);
    assert.equal(pvRemoves.status, 200, pvRemoves.text);
    assert.equal(await portalUserId(), satUser, 'SatnPaper’s sign-in is still there');
    assert.deepEqual(await portalUnits(satEmail), [satAdmissions.id]);
    const replaced = await pvAdmin('POST', `/partners/${partnerId}/portal-access`, { email: `pv.takeover.${RUN}@example.com` });
    assert.equal(replaced.status, 409, replaced.text);
    assert.equal(await db('users').where({ email: `pv.takeover.${RUN}@example.com` }).first(), undefined);
    assert.equal(await portalUserId(), satUser);
    // The partner sees SatnPaper only, until Pi Vector adds its partnership to the same sign-in.
    const satPortal = await signInAs(satEmail);
    assert.deepEqual((await satPortal('GET', '/partner-portal/links')).body.data.map((l) => l.id), [satLink.body.data.id]);
    assert.equal((await satPortal('GET', '/partner-portal/leads')).body.data.length, 1);
    assert.equal((await pvAdmin('POST', `/partners/${partnerId}/portal-access`, { email: satEmail })).status, 200);
    assert.deepEqual(await portalUnits(satEmail), [satAdmissions.id, pvUnit.id].sort());
    assert.equal((await pvAdmin('GET', `/partners/${partnerId}`)).body.data.hasPortalAccess, true);
    assert.equal((await satPortal('GET', '/partner-portal/links')).body.data.length, 2);
    // Pi Vector takes its part back: SatnPaper's stays.
    assert.equal((await pvAdmin('DELETE', `/partners/${partnerId}/portal-access`)).status, 200);
    assert.deepEqual(await portalUnits(satEmail), [satAdmissions.id]);
    assert.equal(await portalUserId(), satUser);
    assert.deepEqual((await satPortal('GET', '/partner-portal/links')).body.data.map((l) => l.id), [satLink.body.data.id]);

    // 3. Bank details are shared by every company that pays the partner: changing them needs
    //    partners.payout_details at all of them; each company's finance can still read them (audited).
    const details = { method: 'bank_transfer', accountName: `Shared Agency ${RUN}`, accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' };
    assert.equal((await owner('PUT', `/partners/${partnerId}/payout-details`, details)).status, 200);
    for (const [who, as] of [['admin.pivector', pvAdmin], ['admin.satnpaper', spAdmin]]) {
      const tamper = await as('PUT', `/partners/${partnerId}/payout-details`, { ...details, accountNumber: '999999999999' });
      assert.equal(tamper.status, 403, `${who} changes the shared bank details: ${tamper.status} ${tamper.text.slice(0, 200)}`);
      const seen = await as('GET', `/partners/${partnerId}`);
      assert.equal(seen.body.data.can.payoutDetails, true);
      assert.equal(seen.body.data.can.changePayoutDetails, false);
    }
    const kept = await owner('GET', `/partners/${partnerId}/payout-details`);
    assert.equal(kept.body.data.details.accountNumber, '123456789012');
    assert.equal((await owner('GET', `/partners/${partnerId}`)).body.data.can.changePayoutDetails, true);
    assert.equal((await pvAdmin('GET', `/partners/${partnerId}/payout-details`)).status, 200);
  });

  await t.test('a payment account uses only a payments connection of its own company', async () => {
    const account = await db('billing_payment_accounts').where({ company_id: pivector.id }).first();
    assert.ok(account, 'Pi Vector has a payment account');
    cleanup.restore.push(() => db('billing_payment_accounts').where({ id: account.id }).update({ connection_id: account.connection_id }));
    const connectionOf = (companyId, kind, sign = '=') =>
      db('integration_connection_companies as l')
        .join('integration_connections as c', 'c.id', 'l.connection_id')
        .where('l.company_id', companyId)
        .where('l.kind', sign, kind)
        .whereNull('c.disconnected_at')
        .whereNotIn('l.connection_id', db('integration_connection_companies').whereNot({ company_id: companyId }).select('connection_id'))
        .first('l.connection_id')
        .then((row) => row?.connection_id);
    const satPayments = await connectionOf(satnpaper.id, 'payments');
    const pvPayments = await connectionOf(pivector.id, 'payments');
    const pvOther = await connectionOf(pivector.id, 'payments', '<>');
    assert.ok(satPayments && pvPayments && pvOther, 'seeded connections');
    for (const [what, connectionId] of [['SatnPaper’s gateway', satPayments], ['an unknown connection', randomUUID()], ['a connection that is not a payment gateway', pvOther]]) {
      const res = await pvAdmin('PATCH', `/billing/payment-accounts/${account.id}`, { connectionId });
      assert.equal(res.status, 422, `${what}: ${res.status} ${res.text.slice(0, 200)}`);
      assert.equal(res.body.error.details[0].path, 'body.connectionId');
    }
    assert.equal((await db('billing_payment_accounts').where({ id: account.id }).first()).connection_id, account.connection_id);
    const own = await pvAdmin('PATCH', `/billing/payment-accounts/${account.id}`, { connectionId: pvPayments });
    assert.equal(own.status, 200, own.text);
    assert.equal((await pvAdmin('PATCH', `/billing/payment-accounts/${account.id}`, { connectionId: null })).status, 200);
    // The same check when an account is added (Pi Vector has no Stripe account in the seed).
    if (!(await db('billing_payment_accounts').where({ company_id: pivector.id, provider: 'stripe' }).first())) {
      const added = await pvAdmin('POST', '/billing/payment-accounts', { companyId: pivector.id, provider: 'stripe', label: `Security ${RUN}`, scope: 'international', entityCountry: 'US', connectionId: satPayments });
      assert.equal(added.status, 422, added.text);
      assert.equal(await db('billing_payment_accounts').where({ company_id: pivector.id, provider: 'stripe' }).first(), undefined);
    }
  });

  await t.test('a batch’s teacher works for its company, and an enrollment’s family is the student’s own', async () => {
    const batch = await db('batches').where({ company_id: pivector.id }).whereNot('status', 'cancelled').first();
    assert.ok(batch, 'Pi Vector has a batch');
    cleanup.restore.push(() => db('batches').where({ id: batch.id }).update({ teacher_user_id: batch.teacher_user_id }));
    const outsider = await pvAdmin('PATCH', `/batches/${batch.id}`, { teacherUserId: ritikaId });
    assert.equal(outsider.status, 422, `a SatnPaper counsellor as the teacher: ${outsider.status} ${outsider.text.slice(0, 200)}`);
    assert.equal(outsider.body.error.details[0].path, 'body.teacherUserId');
    assert.ok(!outsider.text.includes('Ritika'));
    const pvAdminId = await userId('admin.pivector@phoenix.test');
    assert.equal((await pvAdmin('PATCH', `/batches/${batch.id}`, { teacherUserId: pvAdminId })).status, 200);

    // A family the student does not belong to (here: a SatnPaper family) is refused on the field.
    const product = await db('products as p').join('product_lines as l', 'l.id', 'p.product_line_id').where({ 'p.company_id': pivector.id, 'l.audience': 'b2c' }).first('p.id');
    const student = await db('contacts as c')
      .whereExists(db('contact_companies').whereRaw('contact_id = c.id').where('company_id', pivector.id))
      .whereNotExists(db('household_members').whereRaw('contact_id = c.id'))
      .whereNotExists(db('enrollments').whereRaw('student_contact_id = c.id'))
      .whereNull('c.merged_into_id')
      .whereNull('c.erased_at')
      .whereIn('c.kind', ['student', 'other'])
      .first('c.id');
    const satHousehold = pick('households')[0];
    assert.ok(product && student && satHousehold, 'seeded programme, student and family');
    const res = await pvAdmin('POST', '/enrollments', { unitId: pvTeam.id, productId: product.id, studentContactId: student.id, householdId: satHousehold });
    assert.equal(res.status, 422, `${res.status} ${res.text.slice(0, 200)}`);
    assert.equal(res.body.error.details[0].path, 'body.householdId');
    assert.equal(await db('enrollments').where({ student_contact_id: student.id }).first(), undefined);
  });

  await t.test('cookie writes need the X-Phoenix-Client header (CSRF); provider webhooks and API keys do not use cookies', async () => {
    const pvDeal = await db('deals').where({ company_id: pivector.id }).whereNull('archived_at').first();
    const cookieOnly = await fetch(`${base}/deals/${pvDeal.id}/seen`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: (await (async () => {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-client': 'integration-test' }, body: JSON.stringify({ email: 'admin.pivector@phoenix.test', password: env.SEED_PASSWORD }) });
      return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    })()) }, body: '{}' });
    assert.equal(cookieOnly.status, 403);
  });
});
