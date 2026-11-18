import { json } from '../../lib/db.js';
import { addDays, localDate } from '../../core/billing/dates.js';
import { createEnrollment, pauseEnrollment, withdrawEnrollment } from '../../modules/delivery/service.js';
import { ensureImplementationProject, updateProject, updateTask } from '../../modules/delivery/onboarding.js';
import { upsertRenewal } from '../../modules/delivery/renewals.js';
import { runChurnScoring, runRenewalReminders } from '../../modules/delivery/jobs.js';

// Demo data for the delivery module (docs/delivery/DELIVERY.md §11): onboarding templates per
// company, batches for every batch-style programme (one running, one open for the website
// checkout, a small one that is full with a waitlist), enrollments for the families whose deals
// are won (with their checklists), a paused and a withdrawn student, implementation projects for
// the institutes that signed, and renewals with churn scores.
//
// Idempotent: batches are matched by code, templates by name, enrollments by source key,
// projects by deal and renewals by subscription id, so running it again changes nothing.

const GROUP_CODE = 'phoenix';
const BATCH_KINDS = new Set(['group_batch', 'crash_course', 'program']);
const DEFAULT_FEES = { group_batch: 4500000, crash_course: 1800000, program: 6000000 };
const today = () => localDate(Date.now());

const B2C_ITEMS = [
  { title: 'Welcome call with the parent', ownerRole: 'record_owner', dueOffsetDays: 0, description: 'Introduce the batch, the teacher and who to call for help.' },
  { title: 'Share the timetable and joining details', ownerRole: 'batch_teacher', dueOffsetDays: 1 },
  { title: 'Student can sign in to the learning platform', ownerRole: 'record_owner', dueOffsetDays: 1 },
  { title: 'Study material handed over', ownerRole: 'record_owner', dueOffsetDays: 3 },
  { title: 'Diagnostic test taken', ownerRole: 'batch_teacher', dueOffsetDays: 7 },
  { title: 'First-week check-in with the parent', ownerRole: 'record_owner', dueOffsetDays: 7 },
];

const B2B_ITEMS = [
  { phaseKey: 'kickoff', title: 'Kickoff call with the director', dueOffsetDays: 0 },
  { phaseKey: 'kickoff', title: 'Share the implementation plan and contacts', dueOffsetDays: 1 },
  { phaseKey: 'data_import', title: 'Collect student, batch and teacher lists', dueOffsetDays: 4 },
  { phaseKey: 'data_import', title: 'Import and verify the data with the institute', dueOffsetDays: 8 },
  { phaseKey: 'training', title: 'Train the admin team', dueOffsetDays: 12 },
  { phaseKey: 'training', title: 'Train teachers on tests and reports', dueOffsetDays: 15 },
  { phaseKey: 'go_live', title: 'First live test or class on the platform', dueOffsetDays: 26 },
  { phaseKey: 'go_live', title: 'Handover to support', dueOffsetDays: 28 },
];

async function ensureTemplate(knex, company, kind, name, items) {
  const existing = await knex('onboarding_templates').where({ company_id: company.id, kind, name }).first();
  if (existing) return existing;
  const [row] = await knex('onboarding_templates')
    .insert({ group_id: company.root_id, company_id: company.id, kind, name, phases: json(kind === 'b2b' ? [
      { key: 'kickoff', name: 'Kickoff', offsetDays: 0 },
      { key: 'data_import', name: 'Data import', offsetDays: 8 },
      { key: 'training', name: 'Training', offsetDays: 15 },
      { key: 'go_live', name: 'Go-live', offsetDays: 28 },
    ] : []) })
    .returning('*');
  await knex('onboarding_template_items').insert(
    items.map((item, position) => ({
      template_id: row.id,
      phase_key: item.phaseKey ?? null,
      title: item.title,
      description: item.description ?? null,
      owner_role: item.ownerRole ?? 'record_owner',
      due_offset_days: item.dueOffsetDays,
      position,
    })),
  );
  return row;
}

const shortName = (name) => name.replace(/\s*\(.*\)\s*$/, '').replace(/,.*$/, '');
const monthLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

async function ensureBatch(knex, row) {
  const existing = await knex('batches').where({ company_id: row.company_id, code: row.code }).first();
  if (existing) return existing;
  const [inserted] = await knex('batches').insert(row).returning('*');
  return inserted;
}

export async function seed(knex) {
  const group = await knex('org_units').where({ type: 'group', code: GROUP_CODE }).first();
  if (!group) return;
  const companies = await knex('org_units').where({ root_id: group.id, type: 'company' }).orderBy('name');
  if ((await knex('products').where({ group_id: group.id }).count({ n: '*' }))[0].n === '0') return;
  const units = new Map((await knex('org_units').where({ root_id: group.id })).map((u) => [u.id, u]));
  const byCode = (code) => [...units.values()].find((u) => u.code === code);

  // Website checkout on for SatnPaper and Pi Vector.
  for (const code of ['satnpaper', 'pi-vector']) {
    const company = companies.find((c) => c.code === code);
    if (company) {
      await knex('settings').insert({ org_unit_id: company.id, key: 'enrollments.checkoutEnabled', value: json(true) }).onConflict(['org_unit_id', 'key']).ignore();
    }
  }

  const stats = { batches: 0, enrollments: 0, projects: 0, renewals: 0 };
  const teacherByCompany = new Map();
  for (const company of companies) {
    await ensureTemplate(knex, company, 'b2c', 'New student onboarding', B2C_ITEMS);
    const hasB2b = await knex('product_lines').where({ company_id: company.id, audience: 'b2b' }).first('id');
    if (hasB2b) await ensureTemplate(knex, company, 'b2b', 'Institute implementation', B2B_ITEMS.map((i) => ({ ...i, ownerRole: 'record_owner' })));
    const manager = await knex('role_assignments as ra')
      .join('roles as r', 'r.id', 'ra.role_id')
      .join('org_units as o', 'o.id', 'ra.org_unit_id')
      .where('o.path', 'like', `${company.path}%`)
      .whereIn('r.key', ['manager', 'company_admin'])
      .orderBy('r.key', 'desc')
      .first('ra.user_id');
    teacherByCompany.set(company.id, manager?.user_id ?? null);
  }

  // ----- Batches -----
  const products = await knex('products as p')
    .join('product_lines as l', 'l.id', 'p.product_line_id')
    .where('p.group_id', group.id)
    .where('l.audience', 'b2c')
    .select('p.*', 'l.kind as line_kind')
    .orderBy(['p.company_id', 'p.position']);
  const batchesByProduct = new Map();
  for (const product of products.filter((p) => BATCH_KINDS.has(p.line_kind))) {
    const company = units.get(product.company_id);
    const unit = company.code === 'satnpaper' ? byCode('online') ?? company : company;
    const weeks = product.attributes?.durationWeeks ?? (product.line_kind === 'program' ? 40 : 12);
    const [{ fee }] = await knex('deals')
      .where({ product_id: product.id, currency: 'INR' })
      .whereNotNull('value_minor')
      .select(knex.raw('percentile_disc(0.5) within group (order by value_minor) as fee'));
    const feeMinor = fee ? Number(fee) : DEFAULT_FEES[product.line_kind];
    const mode = product.attributes?.mode ?? 'online';
    const code = (product.code ?? product.name.slice(0, 8)).toUpperCase();
    const runningStart = addDays(today(), -21);
    const nextStart = addDays(today(), 24);
    const evening = { days: ['mon', 'wed', 'fri'], startTime: '17:30', endTime: '19:30', timeZone: 'Asia/Kolkata' };
    const weekend = { days: ['sat', 'sun'], startTime: '10:00', endTime: '13:00', timeZone: 'Asia/Kolkata' };
    const base = {
      group_id: group.id,
      company_id: company.id,
      unit_id: unit.id,
      product_id: product.id,
      product_line_id: product.product_line_id,
      mode,
      fee_minor: feeMinor,
      currency: 'INR',
      teacher_user_id: teacherByCompany.get(company.id),
      location: mode === 'online' ? 'Zoom' : { excel: 'Mumbai centre', satnpaper: 'Pune centre' }[company.code] ?? 'Delhi centre',
    };
    const running = await ensureBatch(knex, {
      ...base,
      code: `${code}-R1`,
      name: `${shortName(product.name)}, ${monthLabel(runningStart)}`,
      schedule: json(/weekend/i.test(product.name) ? weekend : evening),
      starts_on: runningStart,
      ends_on: addDays(runningStart, weeks * 7),
      capacity: 30,
      status: 'open',
    });
    const upcoming = await ensureBatch(knex, {
      ...base,
      code: `${code}-N1`,
      name: `${shortName(product.name)}, ${monthLabel(nextStart)}`,
      schedule: json(/weekend/i.test(product.name) ? weekend : evening),
      starts_on: nextStart,
      ends_on: addDays(nextStart, weeks * 7),
      capacity: 25,
      status: 'open',
      checkout_enabled: true,
    });
    batchesByProduct.set(product.id, { running, upcoming });
    stats.batches += 2;
  }
  // A small, full batch with a waitlist (SatnPaper's SAT weekday evening batch).
  const sat = products.find((p) => p.code === 'SAT-GB-EVE');
  if (sat) {
    const small = await ensureBatch(knex, {
      group_id: group.id,
      company_id: sat.company_id,
      unit_id: (byCode('online') ?? units.get(sat.company_id)).id,
      product_id: sat.id,
      product_line_id: sat.product_line_id,
      code: 'SAT-GB-EVE-X1',
      name: 'SAT Weekday Evening, small group (Dec)',
      mode: 'online',
      schedule: json({ days: ['tue', 'thu'], startTime: '19:00', endTime: '21:00', timeZone: 'Asia/Kolkata' }),
      starts_on: addDays(today(), 10),
      ends_on: addDays(today(), 80),
      capacity: 1,
      waitlist_enabled: true,
      waitlist_limit: 10,
      fee_minor: 6500000,
      currency: 'INR',
      teacher_user_id: teacherByCompany.get(sat.company_id),
      location: 'Zoom',
      status: 'open',
      checkout_enabled: true,
    });
    batchesByProduct.set(`${sat.id}:small`, { running: small });
    stats.batches += 1;
  }

  // ----- Enrollments for won family deals -----
  const won = await knex('deals as d')
    .join('product_lines as l', 'l.id', 'd.product_line_id')
    .where('d.group_id', group.id)
    .where('d.status', 'won')
    .whereNull('d.account_id')
    .whereNotNull('d.product_id')
    .where('l.audience', 'b2c')
    .orderBy('d.ref')
    .select('d.*');
  const created = [];
  for (const [index, deal] of won.entries()) {
    const student = await knex('deal_contacts as dc').join('contacts as c', 'c.id', 'dc.contact_id').where({ 'dc.deal_id': deal.id, 'dc.role': 'student' }).first('c.id');
    if (!student) continue;
    const parent = await knex('deal_contacts').where({ deal_id: deal.id }).whereIn('role', ['parent', 'guardian']).first('contact_id');
    const household = await knex('household_members').where({ contact_id: student.id }).first('household_id');
    const batches = batchesByProduct.get(deal.product_id);
    const smallSat = sat && deal.product_id === sat.id ? batchesByProduct.get(`${sat.id}:small`)?.running : null;
    const batch = smallSat && index % 2 === 0 ? smallSat : batches?.running ?? null;
    const paid = deal.currency === 'INR' && deal.value_minor ? (index % 3 === 0 ? Math.round(Number(deal.value_minor) / 2) : Number(deal.value_minor)) : 0;
    const result = await knex.transaction((trx) =>
      createEnrollment(trx, {}, {
        groupId: deal.group_id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        studentContactId: student.id,
        payerContactId: parent?.contact_id ?? null,
        householdId: household?.household_id ?? null,
        dealId: deal.id,
        productId: deal.product_id,
        productLineId: deal.product_line_id,
        batchId: batch?.id ?? null,
        ownerUserId: deal.owner_user_id,
        source: 'payment',
        sourceKey: `seed:${deal.id}:${student.id}`,
        feeMinor: deal.value_minor === null ? null : Number(deal.value_minor),
        currency: deal.currency,
        accessStatus: index % 4 === 1 ? 'pending' : 'pending',
        payment: paid > 0 ? { paymentId: `seed_pay_${deal.ref}`, amountMinor: paid, currency: deal.currency, paidAt: deal.closed_at ?? new Date() } : null,
      }),
    );
    if (result.created) {
      stats.enrollments += 1;
      created.push(result.enrollment);
    }
  }
  // Platform access granted for most, one paused, one withdrawn (refund requested), on a fresh seed only.
  for (const [index, enrollment] of created.entries()) {
    if (enrollment.seat_status === 'seated' && index % 4 !== 1) {
      await knex('enrollments').where({ id: enrollment.id }).update({ access_status: 'granted', access_updated_at: knex.fn.now() });
    }
  }
  const seated = created.filter((e) => e.seat_status === 'seated');
  if (seated[2]) {
    await knex.transaction(async (trx) => {
      const row = await trx('enrollments').where({ id: seated[2].id }).forUpdate().first();
      await pauseEnrollment(trx, {}, row, { resumeOn: addDays(today(), 14), reason: 'Family travelling; resumes after the exams' });
    });
  }
  if (seated[4]) {
    await knex.transaction(async (trx) => {
      const row = await trx('enrollments').where({ id: seated[4].id }).forUpdate().first();
      await withdrawEnrollment(trx, {}, row, { channel: 'whatsapp', receivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), reason: 'Moving to another city' });
    });
  }
  // Some checklist items ticked off.
  const items = await knex('onboarding_checklist_items as i')
    .join('onboarding_checklists as k', 'k.id', 'i.checklist_id')
    .whereIn('k.enrollment_id', created.map((e) => e.id))
    .where('i.position', '<', 2)
    .select('i.id', 'i.checklist_id');
  if (items.length) {
    await knex('onboarding_checklist_items').whereIn('id', items.map((i) => i.id)).update({ status: 'done', completed_at: knex.fn.now() });
    await knex.raw(
      `update onboarding_checklists k set items_done = (select count(*) from onboarding_checklist_items i where i.checklist_id = k.id and i.status <> 'pending')
        where k.id = any(?::uuid[])`,
      [[...new Set(items.map((i) => i.checklist_id))]],
    );
  }

  // ----- Implementation projects for institutes that signed -----
  const signed = await knex('deals as d')
    .join('product_lines as l', 'l.id', 'd.product_line_id')
    .where('d.group_id', group.id)
    .whereNotNull('d.account_id')
    .where('l.audience', 'b2b')
    .where('d.status', 'won')
    .orderBy('d.ref')
    .select('d.*');
  for (const [index, deal] of signed.entries()) {
    const kickoff = deal.closed_at ? localDate(new Date(deal.closed_at).getTime()) : addDays(today(), -10);
    const { project, created: isNew } = await knex.transaction((trx) =>
      ensureImplementationProject(trx, {}, {
        groupId: deal.group_id,
        companyId: deal.company_id,
        unitId: deal.unit_id,
        accountId: deal.account_id,
        dealId: deal.id,
        productId: deal.product_id,
        productLineId: deal.product_line_id,
        ownerUserId: deal.owner_user_id,
        kickoffOn: kickoff,
        trigger: 'deal_won',
      }),
    );
    if (!isNew) continue;
    stats.projects += 1;
    // Move the first projects along: tick off tasks in order (the last one goes live).
    const doneCount = [3, 5, 8][index % 3];
    const tasks = await knex('implementation_tasks').where({ project_id: project.id }).orderBy('position').limit(doneCount);
    await knex.transaction(async (trx) => {
      let current = project;
      for (const task of tasks) ({ project: current } = await updateTask(trx, {}, task, current, { status: 'done' }));
      if (doneCount >= 8) await updateProject(trx, {}, current, { status: 'live' });
    });
  }

  // ----- Renewals (subscriptions of the money module, simulated) -----
  const accounts = await knex('deals as d')
    .join('product_lines as l', 'l.id', 'd.product_line_id')
    .join('accounts as a', 'a.id', 'd.account_id')
    .where('d.group_id', group.id)
    .where('l.audience', 'b2b')
    .whereIn('d.status', ['won', 'open'])
    .orderBy([{ column: 'd.status', order: 'desc' }, { column: 'd.ref' }])
    .select('d.*', 'a.student_count');
  const offsets = [6, 18, 27, 45, 58, 75, 88, 110, 150, 200];
  const picked = accounts.filter((d) => d.status === 'won').concat(accounts.filter((d) => d.status === 'open').slice(0, 5)).slice(0, offsets.length);
  for (const [index, deal] of picked.entries()) {
    if (await knex('renewals').where({ subscription_id: `seed_sub_${deal.ref}` }).first('id')) continue;
    const termEnd = addDays(today(), offsets[index]);
    const amount = deal.value_minor ? Number(deal.value_minor) : 30000000;
    await knex.transaction((trx) =>
      upsertRenewal(trx, {
        group_id: deal.group_id,
        company_id: deal.company_id,
        unit_id: deal.unit_id,
        subscription_id: `seed_sub_${deal.ref}`,
        account_id: deal.account_id,
        contact_id: null,
        deal_id: deal.status === 'won' ? deal.id : null,
        product_id: deal.product_id,
        product_line_id: deal.product_line_id,
        plan_name: index % 2 === 0 ? 'Yearly, per institute' : 'Yearly, per branch',
        status: 'active',
        term_start: addDays(termEnd, -365),
        term_end: termEnd,
        auto_renew: index % 3 === 0,
        amount_minor: amount,
        currency: deal.currency ?? 'INR',
        seats: deal.student_count ? Math.max(50, Math.round(deal.student_count * (index % 2 ? 0.7 : 1.1))) : null,
        owner_user_id: deal.owner_user_id,
        last_event_at: new Date(Date.now() - (index + 1) * 86_400_000),
      }),
    );
    stats.renewals += 1;
  }
  await runChurnScoring({ db: knex });
  await runRenewalReminders({ db: knex });

  console.log(`Seeded delivery: ${stats.batches} batches, ${stats.enrollments} enrollments, ${stats.projects} implementation projects, ${stats.renewals} renewals.`);
}
