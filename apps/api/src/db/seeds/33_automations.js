// Automations demo data (phase 9). Idempotent: flows are found by template key per company, and
// sample runs by their trigger event ids, so running the seed again adds nothing.
//
// Per company: four active flows from the templates in modules/automations/templates.js (new
// enquiry → WhatsApp welcome + call task; lost → nurture with an AI draft the owner approves;
// missed session → rebook link; payment failed → chaser) and one draft (next-intake updates).
// Then a few runs on seeded deals through the real runner, so the Runs and Approvals screens have
// something to show: effects are recorded by the development executor (nothing is sent).

import { json } from '../../lib/db.js';
import { validateFlow } from '../../core/automation/index.js';
import { getAutomationRegistry } from '../../modules/automations/registry.js';
import { startRunForFlow, tick } from '../../modules/automations/runner.js';
import { loadDealRecords } from '../../modules/automations/subjects.js';
import { templateByKey } from '../../modules/automations/templates.js';

const GROUP_CODE = 'phoenix';
const COMPANIES = [
  { code: 'satnpaper', admin: 'admin.satnpaper@phoenix.test' },
  { code: 'pi-vector', admin: 'admin.pivector@phoenix.test' },
  { code: 'excel', admin: 'admin.excel@phoenix.test' },
];
const FLOWS = [
  { template: 'new-enquiry-welcome', status: 'active' },
  { template: 'lost-lead-nurture', status: 'active' },
  { template: 'booking-no-show-rebook', status: 'active' },
  { template: 'payment-failed-chaser', status: 'active' },
  { template: 'lost-lead-next-intake', status: 'draft' },
];
const DAY = 86_400_000;
const quiet = { info() {}, warn() {}, error: (...args) => console.error(...args), debug() {}, child() { return quiet; } };

async function ensureFlow(knex, company, spec, userId, now) {
  const existing = await knex('automation_flows').where({ company_id: company.id, template_key: spec.template }).first();
  if (existing) return existing;
  const template = templateByKey.get(spec.template);
  const result = validateFlow({ key: template.key, version: 1, name: template.name, ...template.definition }, getAutomationRegistry());
  if (!result.ok) throw new Error(`Template ${template.key} is invalid: ${JSON.stringify(result.errors)}`);
  const active = spec.status === 'active';
  const [flow] = await knex('automation_flows')
    .insert({
      group_id: company.root_id,
      company_id: company.id,
      unit_id: company.id,
      key: template.key,
      name: template.name,
      description: template.description,
      kind: template.kind,
      status: spec.status,
      trigger_type: result.flow.trigger.type,
      version: 1,
      active_version: active ? 1 : null,
      definition: json(result.flow),
      template_key: template.key,
      created_by: userId,
      updated_by: userId,
      activated_at: active ? new Date(now - 30 * DAY) : null,
      created_at: new Date(now - 30 * DAY),
      updated_at: new Date(now - 30 * DAY),
    })
    .returning('*');
  await knex('automation_flow_versions').insert({
    flow_id: flow.id,
    company_id: company.id,
    version: 1,
    trigger_type: result.flow.trigger.type,
    definition: json(result.flow),
    warnings: json(result.warnings),
    stats: json(result.stats),
    note: `From template ${template.key}`,
    created_by: userId,
    created_at: new Date(now - 30 * DAY),
  });
  return flow;
}

/** The runner's view of an active flow. */
async function runnable(knex, flow) {
  const version = await knex('automation_flow_versions').where({ flow_id: flow.id, version: flow.active_version ?? flow.version }).first('id', 'definition');
  return { id: flow.id, group_id: flow.group_id, company_id: flow.company_id, unit_id: flow.unit_id, key: flow.key, version_id: version.id, definition: version.definition };
}

const iso = (ms) => new Date(ms).toISOString();

async function sampleRuns(knex, company, flows, now) {
  const deals = await knex('deals')
    .where({ company_id: company.id })
    .whereNull('archived_at')
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id' }])
    .select('id', 'kind', 'status', 'nurture', 'channel', 'value_minor', 'currency', 'created_at', 'stage_id', 'pipeline_id', 'unit_id');
  const records = await loadDealRecords(knex, deals.map((d) => d.id));
  const pick = (filter, n) => deals.filter(filter).slice(0, n);
  let started = 0;
  const start = async (templateKey, deal, event, at) => {
    const flow = flows.get(templateKey);
    if (!flow || flow.status !== 'active' || !deal) return;
    const record = records.get(deal.id);
    const flowEvent = { id: `seed:${event.type}:${deal.id}`, occurredAt: iso(at), subject: { type: 'deal', id: deal.id }, groupId: company.root_id, unitId: deal.unit_id, ...event };
    const out = await startRunForFlow(knex, await runnable(knex, flow), flowEvent, { record, now: at, log: quiet });
    if (out) started += 1;
  };

  // New enquiries in the last days: welcome sent, call task created.
  for (const deal of pick((d) => d.kind === 'b2c' && d.status === 'open', 4)) {
    const at = Math.min(new Date(deal.created_at).getTime(), now - 60_000);
    await start('new-enquiry-welcome', deal, { type: 'deal.created', payload: { dealId: deal.id, companyId: company.id, unitId: deal.unit_id, channel: deal.channel, kind: deal.kind } }, at);
  }
  // Lost with nurture on, 15 days ago: past the cool-off, the follow-up draft waits for the owner.
  for (const deal of pick((d) => d.status === 'lost' && d.nurture, 2)) {
    await start(
      'lost-lead-nurture',
      deal,
      { type: 'deal.stage_changed', payload: { dealId: deal.id, companyId: company.id, unitId: deal.unit_id, pipelineId: deal.pipeline_id, toStageId: deal.stage_id, fromStatus: 'open', toStatus: 'lost' } },
      now - 15 * DAY,
    );
  }
  // A missed counselling session yesterday: rebook link sent, waiting for a new booking.
  const open = pick((d) => d.kind === 'b2c' && d.status === 'open', 6);
  await start('booking-no-show-rebook', open[5], { type: 'meeting.ended', payload: { meetingId: `seed-meeting-${open[5]?.id}`, dealId: open[5]?.id, attendance: 'no_show', rebookUrl: 'https://book.phoenix.test/r/demo' } }, now - DAY);
  // A failed instalment payment two hours ago: reminder sent, waiting for the payment.
  const won = pick((d) => d.status === 'won' && d.kind === 'b2c', 1)[0];
  if (won) {
    await start(
      'payment-failed-chaser',
      won,
      { type: 'payment.failed', payload: { paymentId: `seed-payment-${won.id}`, dealId: won.id, amount: { minor: 2_500_000, currency: won.currency ?? 'INR' }, reason: 'card_declined' } },
      now - 2 * 3_600_000,
    );
  }
  return started;
}

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('Automations demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  if (!(await knex.schema.hasTable('automation_flows'))) {
    console.log('Automations tables are missing: run the migrations first.');
    return;
  }
  const now = Date.now();
  const owner = await knex('users').where({ email: 'owner@phoenix.test' }).first('id');
  let created = 0;
  let runs = 0;
  for (const spec of COMPANIES) {
    const company = await knex('org_units').where({ root_id: group.id, type: 'company', code: spec.code }).first();
    if (!company) continue;
    const admin = (await knex('users').where({ email: spec.admin }).first('id')) ?? owner;
    const flows = new Map();
    for (const flowSpec of FLOWS) {
      const before = await knex('automation_flows').where({ company_id: company.id, template_key: flowSpec.template }).first('id');
      const flow = await ensureFlow(knex, company, flowSpec, admin?.id ?? null, now);
      if (!before) created += 1;
      flows.set(flowSpec.template, flow);
    }
    if (await knex('deals').where({ company_id: company.id }).first('id')) runs += await sampleRuns(knex, company, flows, now);
  }
  // Wake the runs whose waits are over (the nurture cool-off), as the scheduler would.
  await tick(knex, { now, log: quiet });
  console.log(created || runs ? `Automations: ${created} flows and ${runs} sample runs added.` : 'Automations demo data is already there.');
}
