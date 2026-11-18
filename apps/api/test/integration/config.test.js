import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/config/env.js';
import { db } from '../../src/lib/db.js';
import { redis } from '../../src/lib/redis.js';
import { closeQueues } from '../../src/core/queue.js';
import { createApp } from '../../src/app.js';
import { buildRegistry } from '../../src/registry.js';
import { modules } from '../../src/modules/index.js';

// Company configuration end to end (docs/crm/PHASE2_CONTRACT.md §9.3–9.5): pipelines and stages,
// lost reasons, product lines and products, custom fields, the CRM vocabularies and people picker.
// Needs the migrated and seeded database (npm run db:migrate && npm run db:seed). Records get
// unique keys per run and are removed at the end.

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
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
}

const show = (res) => JSON.stringify(res.body);
const paths = (res) => (res.body?.error?.details ?? []).map((detail) => detail.path);

test('Config API: pipelines, catalog and custom fields', { skip: !enabled && 'set INTEGRATION=1 to run' }, async (t) => {
  const app = createApp({ registry: buildRegistry(), modules });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const password = env.SEED_PASSWORD;
  let testDealId = null;

  t.after(async () => {
    server.close();
    try {
      if (testDealId) {
        await db('timeline_events').where({ deal_id: testDealId }).delete();
        await db('deal_stage_history').where({ deal_id: testDealId }).delete();
        await db('search_documents').where({ entity_type: 'deal', entity_id: testDealId }).delete();
        await db('deals').where({ id: testDealId }).delete();
      }
      await db('products').where('name', 'like', `%${RUN}%`).delete();
      await db('product_lines').where('key', 'like', `%${RUN}`).delete();
      await db('pipelines').where('key', 'like', `%${RUN}`).delete();
      await db('lost_reasons').where('label', 'like', `%${RUN}%`).delete();
      await db('custom_field_definitions').where('key', 'like', `%${RUN}`).delete();
    } finally {
      await closeQueues();
      await db.destroy();
      await redis.quit();
    }
  });

  const limits = await redis.keys('rl:*');
  if (limits.length) await redis.del(...limits);

  const group = await db('org_units').whereNull('parent_id').where({ code: 'phoenix' }).first();
  const units = await db('org_units').where({ root_id: group.id });
  const byCode = (code) => units.find((unit) => unit.code === code);
  const satnpaper = byCode('satnpaper');
  const pivector = byCode('pi-vector');
  const satAdmissions = byCode('sat-admissions');
  const online = byCode('online');
  assert.ok(satnpaper && pivector && satAdmissions && online, 'seeded units are there');
  const spAdmissions = await db('pipelines').where({ company_id: satnpaper.id, key: 'admissions' }).first();
  assert.ok(spAdmissions, 'run the CRM seed first');

  const owner = client(base);
  const spAdmin = client(base);
  const pvAdmin = client(base);
  const ritika = client(base);
  const kabir = client(base);

  await t.test('seeded people sign in', async () => {
    for (const [call, email] of [
      [owner, 'owner@phoenix.test'],
      [spAdmin, 'admin.satnpaper@phoenix.test'],
      [pvAdmin, 'admin.pivector@phoenix.test'],
      [ritika, 'ritika@phoenix.test'],
      [kabir, 'kabir@phoenix.test'],
    ]) {
      const login = await call('POST', '/auth/login', { email, password });
      assert.equal(login.status, 200, `${email}: ${show(login)}`);
    }
  });

  await t.test('vocabularies and the people picker', async () => {
    const vocab = await ritika('GET', '/crm/vocabularies');
    assert.equal(vocab.status, 200, show(vocab));
    assert.ok(vocab.body.data.channels.some((channel) => channel.key === 'whatsapp' && channel.firstReplySla));
    assert.ok(vocab.body.data.productKinds.some((kind) => kind.key === 'software_erp' && kind.audience === 'b2b'));
    assert.ok(vocab.body.data.dealRequiredFields.some((field) => field.key === 'students'));
    assert.match(vocab.headers.get('cache-control'), /max-age=300/);

    const people = await ritika('GET', `/crm/people?unitId=${satAdmissions.id}&permission=deals.manage`);
    assert.equal(people.status, 200, show(people));
    const emails = people.body.data.map((person) => person.email);
    assert.ok(emails.includes('ritika@phoenix.test') && emails.includes('kabir@phoenix.test'));
    assert.equal(people.body.data.find((person) => person.email === 'ritika@phoenix.test').level, 'own');
    const filtered = await ritika('GET', `/crm/people?unitId=${satAdmissions.id}&permission=deals.manage&q=kab`);
    assert.deepEqual(filtered.body.data.map((person) => person.email), ['kabir@phoenix.test']);
    assert.equal((await pvAdmin('GET', `/crm/people?unitId=${satAdmissions.id}&permission=deals.view`)).status, 404);
    assert.equal((await ritika('GET', `/crm/people?unitId=${satAdmissions.id}&permission=users.manage`)).status, 422);
  });

  await t.test('reading pipelines follows the scope', async () => {
    const all = await owner('GET', `/pipelines?unitId=${group.id}`);
    assert.equal(all.status, 200, show(all));
    const companies = new Set(all.body.data.map((pipeline) => pipeline.companyId));
    assert.ok(companies.has(satnpaper.id) && companies.has(pivector.id));

    const mine = await ritika('GET', `/pipelines?unitId=${satAdmissions.id}`);
    assert.equal(mine.status, 200, show(mine));
    assert.ok(mine.body.data.length > 0);
    assert.ok(mine.body.data.every((pipeline) => pipeline.companyId === satnpaper.id));
    const admissions = mine.body.data.find((pipeline) => pipeline.id === spAdmissions.id);
    assert.equal(admissions.isDefault, true);
    assert.deepEqual(
      admissions.stages.map((stage) => stage.position),
      [...admissions.stages.map((stage) => stage.position)].sort((a, b) => a - b),
    );
    const enrolled = admissions.stages.find((stage) => stage.key === 'enrolled');
    assert.equal(enrolled.category, 'won');
    assert.deepEqual(enrolled.entryRules.allowedFrom.sort(), ['demo_done', 'fee_proposed']);
    assert.match(admissions.createdAt, /Z$/);

    const b2b = await ritika('GET', `/pipelines?unitId=${satAdmissions.id}&kind=b2b`);
    assert.ok(b2b.body.data.every((pipeline) => pipeline.kind === 'b2b'));

    assert.equal((await ritika('GET', `/pipelines?companyId=${pivector.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/pipelines?companyId=${satnpaper.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/pipelines/${spAdmissions.id}`)).status, 404);
    assert.equal((await pvAdmin('GET', `/pipelines?unitId=${satAdmissions.id}`)).status, 404);
    assert.equal((await ritika('GET', `/pipelines/${spAdmissions.id}`)).status, 200);
    assert.equal((await ritika('GET', '/pipelines')).status, 422);

    const options = await ritika('GET', `/pipelines/required-field-options?companyId=${satnpaper.id}&kind=b2c`);
    assert.equal(options.status, 200, show(options));
    const keys = options.body.data.map((option) => option.key);
    assert.ok(keys.includes('custom.grade') && keys.includes('students') && !keys.includes('accountId'));
  });

  const key = `qa_${RUN}`;
  const stage = (stageKey, category = 'open', extra = {}) => ({ key: stageKey, name: stageKey.replace('_', ' '), category, ...extra });
  let pipeline;

  await t.test('creating a pipeline: permissions and stage validation', async () => {
    const body = {
      companyId: satnpaper.id,
      key,
      name: `QA pipeline ${RUN}`,
      kind: 'b2c',
      stages: [stage('new', 'open', { slaHours: 4 }), stage('demo'), stage('enrolled', 'won', { allowedFrom: undefined }), stage('lost', 'lost')],
    };
    assert.equal((await ritika('POST', '/pipelines', body)).status, 403, 'counsellors only read');
    assert.equal((await kabir('POST', '/pipelines', body)).status, 403, 'a manager inside the company cannot change company pipelines');
    assert.equal((await pvAdmin('POST', '/pipelines', body)).status, 404, 'another company is invisible');

    const invalid = await spAdmin('POST', '/pipelines', {
      ...body,
      stages: [
        stage('new', 'open', { requiredFields: ['custom.nope', 'accountId'] }),
        stage('new'),
        stage('lost', 'lost', { entryRules: { allowedFrom: ['ghost'] } }),
      ],
    });
    assert.equal(invalid.status, 422, show(invalid));
    assert.deepEqual(paths(invalid).sort(), [
      'body.stages',
      'body.stages.0.requiredFields.0',
      'body.stages.0.requiredFields.1',
      'body.stages.1.key',
      'body.stages.2.entryRules.allowedFrom.0',
    ]);

    const created = await spAdmin('POST', '/pipelines', {
      ...body,
      stages: body.stages.map(({ allowedFrom, ...rest }) => rest),
    });
    assert.equal(created.status, 201, show(created));
    pipeline = created.body.data;
    assert.equal(pipeline.isDefault, false, 'SatnPaper already has a default B2C pipeline');
    assert.deepEqual(pipeline.stages.map((s) => [s.key, s.position]), [['new', 0], ['demo', 1], ['enrolled', 2], ['lost', 3]]);
    assert.equal(pipeline.stages[0].slaHours, 4);

    assert.equal((await spAdmin('POST', '/pipelines', body)).status, 409, 'key unique per company');

    const audit = await db('audit_logs').where({ action: 'pipeline.created', entity_id: pipeline.id }).first();
    assert.ok(audit, 'audit entry');
    assert.equal(audit.org_unit_id, satnpaper.id);
    const event = await db('outbox_events').where({ type: 'pipeline.created', aggregate_id: pipeline.id }).first();
    assert.equal(event.payload.companyId, satnpaper.id);
  });

  const stageId = (stageKey) => pipeline.stages.find((s) => s.key === stageKey).id;

  await t.test('stages: add, update and reorder', async () => {
    const added = await spAdmin('POST', `/pipelines/${pipeline.id}/stages`, stage('call_back', 'open', { probability: 30 }));
    assert.equal(added.status, 201, show(added));
    pipeline = added.body.data;
    assert.deepEqual(pipeline.stages.map((s) => s.key), ['new', 'demo', 'call_back', 'enrolled', 'lost'], 'before the first won stage');
    assert.equal((await spAdmin('POST', `/pipelines/${pipeline.id}/stages`, stage('demo'))).status, 409);
    assert.equal((await ritika('POST', `/pipelines/${pipeline.id}/stages`, stage('other'))).status, 403);
    assert.equal((await pvAdmin('POST', `/pipelines/${pipeline.id}/stages`, stage('other'))).status, 404);

    const wrong = await spAdmin('PATCH', `/pipelines/${pipeline.id}/stages/${stageId('demo')}`, {
      requiredFields: ['custom.grade', 'accountId'],
      entryRules: { allowedFrom: ['demo'] },
    });
    assert.equal(wrong.status, 422, show(wrong));
    assert.deepEqual(paths(wrong).sort(), ['body.entryRules.allowedFrom.0', 'body.requiredFields.1']);
    assert.equal((await spAdmin('PATCH', `/pipelines/${pipeline.id}/stages/${stageId('demo')}`, { category: 'won' })).status, 422);

    const patched = await spAdmin('PATCH', `/pipelines/${pipeline.id}/stages/${stageId('enrolled')}`, {
      requiredFields: ['custom.grade', 'productLineId', 'custom.grade'],
      entryRules: { allowedFrom: ['demo', 'call_back'] },
      slaHours: 24,
      colour: '#2840d8',
      name: 'Enrolled',
    });
    assert.equal(patched.status, 200, show(patched));
    pipeline = patched.body.data;
    const enrolled = pipeline.stages.find((s) => s.key === 'enrolled');
    assert.deepEqual(enrolled.requiredFields, ['custom.grade', 'productLineId']);
    assert.deepEqual(enrolled.entryRules, { allowedFrom: ['demo', 'call_back'] });
    assert.equal(enrolled.colour, '#2840D8');
    assert.equal(enrolled.slaHours, 24);

    const ids = pipeline.stages.map((s) => s.id);
    const missing = await spAdmin('PUT', `/pipelines/${pipeline.id}/stages/order`, { stageIds: ids.slice(1) });
    assert.equal(missing.status, 422);
    const order = [ids[1], ids[0], ...ids.slice(2)];
    const reordered = await spAdmin('PUT', `/pipelines/${pipeline.id}/stages/order`, { stageIds: order });
    assert.equal(reordered.status, 200, show(reordered));
    pipeline = reordered.body.data;
    assert.deepEqual(pipeline.stages.map((s) => s.id), order);
    assert.deepEqual(pipeline.stages.map((s) => s.position), [0, 1, 2, 3, 4]);
  });

  await t.test('archiving a stage that still has deals needs a target (409 with counts)', async () => {
    const contact = await db('contact_companies').where({ company_id: satnpaper.id }).first();
    const [deal] = await db('deals')
      .insert({
        group_id: group.id,
        company_id: satnpaper.id,
        unit_id: satAdmissions.id,
        number: 900_000_000 + Math.floor(Math.random() * 1_000_000),
        ref: `QA-${RUN}`,
        title: `QA deal ${RUN}`,
        kind: 'b2c',
        pipeline_id: pipeline.id,
        stage_id: stageId('new'),
        status: 'open',
        currency: 'INR',
        channel: 'manual',
        primary_contact_id: contact.contact_id,
        stage_entered_at: new Date(Date.now() - 2 * 3_600_000),
      })
      .returning('*');
    testDealId = deal.id;

    const refused = await spAdmin('POST', `/pipelines/${pipeline.id}/stages/${stageId('new')}/archive`, {});
    assert.equal(refused.status, 409, show(refused));
    assert.equal(refused.body.error.details.openDealCount, 1);
    assert.equal(refused.body.error.details.dealCount, 1);

    const wrongCategory = await spAdmin('POST', `/pipelines/${pipeline.id}/stages/${stageId('new')}/archive`, { moveToStageId: stageId('lost') });
    assert.equal(wrongCategory.status, 422);
    assert.deepEqual(paths(wrongCategory), ['body.moveToStageId']);

    const onlyWon = await spAdmin('POST', `/pipelines/${pipeline.id}/stages/${stageId('enrolled')}/archive`, {});
    assert.equal(onlyWon.status, 409, 'the last won stage stays');

    // A stage without deals goes, and leaves the entry rules that named it.
    const archived = await spAdmin('POST', `/pipelines/${pipeline.id}/stages/${stageId('call_back')}/archive`, {});
    assert.equal(archived.status, 200, show(archived));
    pipeline = archived.body.data;
    assert.deepEqual(pipeline.stages.find((s) => s.key === 'enrolled').entryRules, { allowedFrom: ['demo'] });

    // Enrolled can now only be entered from demo: archiving demo would open it to every stage.
    const blocked = await spAdmin('POST', `/pipelines/${pipeline.id}/stages/${stageId('demo')}/archive`, {});
    assert.equal(blocked.status, 409, show(blocked));
    assert.match(blocked.body.error.message, /Enrolled can only be entered from demo/);
  });

  await t.test('archiving with a target moves the deals, writes history and the timeline', async () => {
    const moved = await spAdmin('POST', `/pipelines/${pipeline.id}/stages/${stageId('new')}/archive`, { moveToStageId: stageId('demo') });
    assert.equal(moved.status, 200, show(moved));
    pipeline = moved.body.data;
    assert.ok(!pipeline.stages.some((s) => s.key === 'new'), 'archived stages are left out');
    const deal = await db('deals').where({ id: testDealId }).first();
    assert.equal(deal.stage_id, stageId('demo'));
    assert.equal(deal.sla_due_at, null, 'demo has no SLA');
    const history = await db('deal_stage_history').where({ deal_id: testDealId }).first();
    assert.equal(history.to_stage_id, stageId('demo'));
    assert.ok(Number(history.seconds_in_from_stage) >= 7000);
    const entry = await db('timeline_events').where({ deal_id: testDealId, kind: 'stage_change' }).first();
    assert.equal(entry.title, 'Moved to demo');
    assert.equal(entry.meta.action, 'pipeline_stage.archived');
    const event = await db('outbox_events').where({ type: 'pipeline_stage.archived', aggregate_id: pipeline.id }).orderBy('id', 'desc').first();
    assert.equal(event.payload.movedDealCount, 1);
  });

  await t.test('default pipeline and archiving a pipeline', async () => {
    const made = await spAdmin('PATCH', `/pipelines/${pipeline.id}`, { isDefault: true, name: `QA default ${RUN}` });
    assert.equal(made.status, 200, show(made));
    assert.equal(made.body.data.isDefault, true);
    assert.equal((await db('pipelines').where({ id: spAdmissions.id }).first()).is_default, false, 'one default per kind');

    const busy = await spAdmin('POST', `/pipelines/${pipeline.id}/archive`);
    assert.equal(busy.status, 409, show(busy));
    assert.equal(busy.body.error.details.openDealCount, 1);

    await db('deals').where({ id: testDealId }).update({ archived_at: new Date() });
    const archived = await spAdmin('POST', `/pipelines/${pipeline.id}/archive`);
    assert.equal(archived.status, 200, show(archived));
    assert.ok(archived.body.data.archivedAt);
    assert.equal(archived.body.data.isDefault, false);
    const defaults = await db('pipelines').where({ company_id: satnpaper.id, kind: 'b2c', is_default: true }).whereNull('archived_at');
    assert.equal(defaults.length, 1, 'the default passed to another pipeline');

    assert.equal((await spAdmin('PATCH', `/pipelines/${pipeline.id}`, { isDefault: true })).status, 409, 'archived pipelines cannot be the default');
    const listed = await spAdmin('GET', `/pipelines?companyId=${satnpaper.id}&includeArchived=true`);
    assert.ok(listed.body.data.some((p) => p.id === pipeline.id));
    const hidden = await spAdmin('GET', `/pipelines?companyId=${satnpaper.id}`);
    assert.ok(!hidden.body.data.some((p) => p.id === pipeline.id));

    const restored = await spAdmin('POST', `/pipelines/${pipeline.id}/restore`);
    assert.equal(restored.status, 200, show(restored));
    assert.equal(restored.body.data.archivedAt, null);
    assert.equal(restored.body.data.isDefault, false);
    // Put the seeded default back.
    assert.equal((await spAdmin('PATCH', `/pipelines/${spAdmissions.id}`, { isDefault: true })).status, 200);
  });

  await t.test('lost reasons', async () => {
    const label = `Chose another coaching ${RUN}`;
    assert.equal((await ritika('POST', '/lost-reasons', { companyId: satnpaper.id, label })).status, 403);
    const created = await spAdmin('POST', '/lost-reasons', { companyId: satnpaper.id, label, kind: 'b2c', requiresNote: true });
    assert.equal(created.status, 201, show(created));
    assert.equal(created.body.data.requiresNote, true);
    assert.equal((await spAdmin('POST', '/lost-reasons', { companyId: satnpaper.id, label: label.toUpperCase() })).status, 409, 'labels are case-insensitive');

    const off = await spAdmin('PATCH', `/lost-reasons/${created.body.data.id}`, { active: false, position: 99 });
    assert.equal(off.status, 200, show(off));
    assert.equal(off.body.data.active, false);
    const active = await ritika('GET', `/lost-reasons?unitId=${satAdmissions.id}&kind=b2c`);
    assert.equal(active.status, 200);
    assert.ok(!active.body.data.some((reason) => reason.id === created.body.data.id));
    assert.ok(active.body.data.every((reason) => reason.kind === null || reason.kind === 'b2c'));
    const everything = await spAdmin('GET', `/lost-reasons?companyId=${satnpaper.id}&includeInactive=true`);
    assert.ok(everything.body.data.some((reason) => reason.id === created.body.data.id));
    assert.equal((await pvAdmin('PATCH', `/lost-reasons/${created.body.data.id}`, { active: true })).status, 404);
  });

  await t.test('product lines and products', async () => {
    const line = await spAdmin('POST', '/product-lines', { companyId: satnpaper.id, key: `weekend_${RUN}`, name: `Weekend batches ${RUN}`, kind: 'group_batch' });
    assert.equal(line.status, 201, show(line));
    assert.equal(line.body.data.audience, 'b2c');
    assert.equal(line.body.data.productCount, 0);
    assert.equal((await spAdmin('POST', '/product-lines', { companyId: satnpaper.id, key: `weekend_${RUN}`, name: 'Again', kind: 'group_batch' })).status, 409);
    assert.equal((await spAdmin('POST', '/product-lines', { companyId: satnpaper.id, key: `x_${RUN}`, name: 'X', kind: 'rocket' })).status, 422);

    const code = `WK-${RUN}`.toUpperCase().slice(0, 30);
    const product = await spAdmin('POST', '/products', {
      productLineId: line.body.data.id,
      code: code.toLowerCase(),
      name: `Weekend SAT ${RUN}`,
      attributes: { mode: 'hybrid', sessions: 16 },
    });
    assert.equal(product.status, 201, show(product));
    assert.equal(product.body.data.code, code);
    assert.deepEqual(product.body.data.attributes, { mode: 'hybrid', sessions: 16 });
    assert.equal((await spAdmin('POST', '/products', { productLineId: line.body.data.id, code, name: 'Dup' })).status, 409);
    assert.equal((await ritika('POST', '/products', { productLineId: line.body.data.id, name: 'Nope' })).status, 403);
    const hiddenLine = await pvAdmin('POST', '/products', { productLineId: line.body.data.id, name: 'Nope' });
    assert.equal(hiddenLine.status, 422, 'another company\'s line is "not found" on the field');
    assert.deepEqual(paths(hiddenLine), ['body.productLineId']);

    const software = await db('product_lines').where({ company_id: satnpaper.id, audience: 'b2b' }).first();
    const moveToB2b = await spAdmin('PATCH', `/products/${product.body.data.id}`, { productLineId: software.id });
    assert.equal(moveToB2b.status, 422, show(moveToB2b));

    const listed = await ritika('GET', `/products?productLineId=${line.body.data.id}`);
    assert.equal(listed.status, 200, show(listed));
    assert.deepEqual(listed.body.data.map((p) => p.id), [product.body.data.id]);
    const search = await ritika('GET', `/products?unitId=${satAdmissions.id}&q=${encodeURIComponent(`weekend sat ${RUN}`)}`);
    assert.deepEqual(search.body.data.map((p) => p.id), [product.body.data.id]);
    const lines = await ritika('GET', `/product-lines?unitId=${satAdmissions.id}`);
    assert.equal(lines.body.data.find((l) => l.id === line.body.data.id).productCount, 1);
    assert.equal((await pvAdmin('GET', `/products?companyId=${satnpaper.id}`)).status, 404);
    assert.equal((await pvAdmin('PATCH', `/products/${product.body.data.id}`, { active: false })).status, 404);

    const off = await spAdmin('PATCH', `/product-lines/${line.body.data.id}`, { active: false, description: '' });
    assert.equal(off.status, 200, show(off));
    assert.equal(off.body.data.description, null);
    const activeLines = await ritika('GET', `/product-lines?unitId=${satAdmissions.id}`);
    assert.ok(!activeLines.body.data.some((l) => l.id === line.body.data.id));

    const cleared = await spAdmin('PATCH', `/products/${product.body.data.id}`, { code: '', active: false });
    assert.equal(cleared.status, 200, show(cleared));
    assert.equal(cleared.body.data.code, null);
  });

  await t.test('custom fields', async () => {
    const fieldKey = `batch_pref_${RUN}`;
    const body = {
      companyId: satnpaper.id,
      entity: 'deal',
      key: fieldKey,
      label: 'Batch preference',
      type: 'select',
      options: [
        { value: 'morning', label: 'Morning' },
        { value: 'evening', label: 'Evening' },
      ],
      appliesTo: 'b2c',
    };
    assert.equal((await ritika('POST', '/custom-fields', body)).status, 403);
    assert.equal((await pvAdmin('POST', '/custom-fields', body)).status, 404);
    const noOptions = await spAdmin('POST', '/custom-fields', { ...body, options: [] });
    assert.equal(noOptions.status, 422);
    assert.deepEqual(paths(noOptions), ['body.options']);
    assert.equal((await spAdmin('POST', '/custom-fields', { ...body, entity: 'contact' })).status, 422, 'appliesTo is for deal fields');

    const created = await spAdmin('POST', '/custom-fields', body);
    assert.equal(created.status, 201, show(created));
    const field = created.body.data;
    assert.equal(field.active, true);
    assert.equal((await spAdmin('POST', '/custom-fields', body)).status, 409);

    const options = await ritika('GET', `/pipelines/required-field-options?companyId=${satnpaper.id}`);
    assert.ok(options.body.data.some((option) => option.key === `custom.${fieldKey}`));

    // No record holds a value yet, so the type may change; the select options go with it.
    const retyped = await spAdmin('PATCH', `/custom-fields/${field.id}`, { type: 'text', help: 'Morning or evening' });
    assert.equal(retyped.status, 200, show(retyped));
    assert.equal(retyped.body.data.type, 'text');
    assert.deepEqual(retyped.body.data.options, []);

    // Seeded deals store grades, so the grade field's type is fixed; stages require it too.
    const grade = await db('custom_field_definitions').where({ company_id: satnpaper.id, entity: 'deal', key: 'grade' }).first();
    const typeChange = await spAdmin('PATCH', `/custom-fields/${grade.id}`, { type: 'text' });
    assert.equal(typeChange.status, 409, show(typeChange));
    const deactivate = await spAdmin('PATCH', `/custom-fields/${grade.id}`, { active: false });
    assert.equal(deactivate.status, 409, show(deactivate));
    assert.match(deactivate.body.error.message, /Admissions › Demo booked/);
    assert.equal((await pvAdmin('PATCH', `/custom-fields/${grade.id}`, { label: 'X' })).status, 404);

    const list = await ritika('GET', `/custom-fields?unitId=${satAdmissions.id}&entity=deal`);
    assert.equal(list.status, 200, show(list));
    assert.ok(list.body.data.every((definition) => definition.companyId === satnpaper.id && definition.entity === 'deal'));
    const ids = list.body.data.map((definition) => definition.id);
    const reordered = await spAdmin('PUT', '/custom-fields/order', { companyId: satnpaper.id, entity: 'deal', ids: [field.id] });
    assert.equal(reordered.status, 200, show(reordered));
    assert.equal(reordered.body.data[0].id, field.id);
    assert.equal(reordered.body.data[0].position, 0);
    assert.equal(reordered.body.data.length, (await db('custom_field_definitions').where({ company_id: satnpaper.id, entity: 'deal' })).length);
    assert.ok(ids.includes(field.id));
    assert.equal((await ritika('PUT', '/custom-fields/order', { companyId: satnpaper.id, entity: 'deal', ids: [field.id] })).status, 403);

    const off = await spAdmin('PATCH', `/custom-fields/${field.id}`, { active: false });
    assert.equal(off.status, 200, show(off));
    const active = await ritika('GET', `/custom-fields?companyId=${satnpaper.id}&entity=deal`);
    assert.ok(!active.body.data.some((definition) => definition.id === field.id));
    const audit = await db('audit_logs').where({ action: 'custom_field.updated', entity_id: field.id });
    assert.equal(audit.length, 2);
  });
});
