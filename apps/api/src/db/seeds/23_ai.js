import { runAgent } from '../../core/ai/index.js';
import { searchVector } from '../../core/ai/knowledge.js';
import { meetingSummaryAgent } from '../../core/ai/agents/meetingSummary.js';

// AI demo data (docs/platform/AI.md): approved knowledge base articles per company, Pi Vector
// allowed to quote fees (the others are not), and AI actions made by running the agents through
// the mock model on seeded leads, so the log, the review queue and the timelines have entries.
// Skipped when the group already has articles. Needs 01_foundation, 02_crm and 20_integrations.

const GROUP_CODE = 'phoenix';

const ARTICLES = {
  satnpaper: [
    {
      title: 'SAT weekend group batch: timings and format',
      tags: ['sat', 'batch', 'timings', 'online'],
      body:
        'The SAT weekend group batch meets on Saturdays and Sundays from 10 am to 1 pm IST, online on Zoom. Each batch has at most 20 students. ' +
        'Every class is recorded, so students can catch up if they miss one. Students take a full-length practice test every second weekend.',
    },
    {
      title: 'SAT program fees',
      tags: ['sat', 'fees', 'instalments'],
      body:
        'The SAT weekend group batch fee is ₹45,000 for 12 weeks. One-to-one SAT mentorship is ₹95,000 for 40 hours with a dedicated mentor. ' +
        'Fees can be paid in up to three instalments.',
    },
    {
      title: 'Booking a free demo session',
      tags: ['demo', 'booking', 'counselling'],
      body:
        'Families can book a free 45-minute demo session with a counsellor. The counsellor shares a personal booking link on WhatsApp or email, ' +
        'and the family picks a time that suits them in their own time zone. Both the parent and the student are welcome to join.',
    },
    {
      title: 'One-to-one SAT mentorship',
      tags: ['sat', 'mentorship', 'one-to-one'],
      body:
        'One-to-one SAT mentorship pairs the student with a mentor who has scored 1550 or above. Sessions are scheduled around school hours, ' +
        'including weekday evenings, and the plan is adjusted after every practice test.',
    },
    {
      title: 'Digital SAT dates and registration',
      tags: ['sat', 'exam dates', 'registration'],
      body:
        'The digital SAT is offered several times a year, including March, May, June, August, October, November and December. ' +
        'Students register on the College Board website. Our counsellors help families choose a test date that fits the college application timeline.',
    },
    {
      title: 'Refund requests',
      tags: ['refund', 'policy'],
      body: 'Refund requests are handled by our accounts team, who reply within two working days. Counsellors pass every refund request to them.',
    },
  ],
  pivector: [
    {
      title: 'JEE classroom batches: timings',
      tags: ['jee', 'batch', 'timings', 'delhi'],
      body:
        'JEE classroom batches run at our Delhi centre on weekdays from 4 pm to 7 pm, with doubt-clearing sessions on Saturday mornings. ' +
        'An online batch with the same timetable is available for students outside Delhi.',
    },
    {
      title: 'JEE program fees',
      tags: ['jee', 'fees'],
      body: 'The one-year JEE classroom program fee is ₹1,20,000. The JEE test series is ₹8,000 for the full year. Fees can be paid in four instalments.',
    },
    {
      title: 'Olympiad programs',
      tags: ['olympiad', 'maths', 'science'],
      body: 'Our Olympiad programs prepare students of classes 8 to 10 for IOQM and NSO with weekend classes and monthly mock tests.',
    },
  ],
  excel: [
    {
      title: 'Board exam batches',
      tags: ['board', 'cbse', 'batch'],
      body: 'Excel runs Class 10 CBSE and Class 12 Science board batches at the Pune centre, from 5 pm to 8 pm on weekdays, with a mock board exam every month.',
    },
  ],
};

const COMPANY_CODES = { satnpaper: 'satnpaper', pivector: 'pi-vector', excel: 'excel' };

/**
 * Open leads with an original message, newest first, with the names the message talks about.
 * `preferOwner` puts that user's leads first (so a counsellor's own review queue has items).
 */
async function originalMessages(knex, companyId, kind, limit, { preferOwner = null } = {}) {
  const query = knex('deals as d')
    .leftJoin('product_lines as pl', 'pl.id', 'd.product_line_id')
    .where({ 'd.company_id': companyId, 'd.kind': kind, 'd.status': 'open' })
    .whereNotNull('d.original_message')
    .whereNull('d.archived_at');
  if (preferOwner) query.orderByRaw('(d.owner_user_id = ?) desc nulls last', [preferOwner]);
  const rows = await query
    .orderBy([{ column: 'd.created_at', order: 'desc' }, { column: 'd.id' }])
    .limit(limit)
    .select(
      'd.id',
      'd.original_message',
      'pl.name as line_name',
      knex.raw("(select c.first_name from deal_contacts dc join contacts c on c.id = dc.contact_id where dc.deal_id = d.id and dc.role = 'student' limit 1) as student_name"),
      knex.raw("(select c.student_profile->>'grade' from deal_contacts dc join contacts c on c.id = dc.contact_id where dc.deal_id = d.id and dc.role = 'student' limit 1) as grade"),
    );
  return rows.map((row) => ({ ...row, text: fill(row.original_message.text, row), from: row.original_message.from ?? {} }));
}

/** The CRM seed keeps some message templates unfilled ({student}, {grade}...): fill them from the lead. */
function fill(text, row) {
  const values = {
    student: row.student_name ?? 'my child',
    parent: row.original_message.from?.name ?? 'The parent',
    child: 'son',
    their: 'his',
    grade: /^\d+$/.test(row.grade ?? '') ? row.grade : '11',
    line: row.line_name ?? 'your courses',
    when: 'this evening',
  };
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

/** Run an agent and ignore the result: seeds only want the log rows. */
async function run(options) {
  try {
    await runAgent({ trigger: 'seed', ...options });
  } catch (error) {
    console.warn(`AI seed: ${options.agent} failed: ${error.message}`);
  }
}

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('AI demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  if (await knex('ai_knowledge_articles').where({ group_id: group.id }).first('id')) {
    console.log('AI demo data is already there.');
    return;
  }
  const companies = Object.fromEntries(
    await Promise.all(
      Object.entries(COMPANY_CODES).map(async ([key, code]) => [key, await knex('org_units').where({ root_id: group.id, type: 'company', code }).first()]),
    ),
  );
  const owner = await knex('users').where({ email: 'owner@phoenix.test' }).first('id');

  for (const [key, articles] of Object.entries(ARTICLES)) {
    const company = companies[key];
    if (!company) continue;
    for (const article of articles) {
      await knex('ai_knowledge_articles').insert({
        group_id: group.id,
        company_id: company.id,
        title: article.title,
        body: article.body,
        tags: article.tags,
        status: 'approved',
        owner_user_id: owner?.id ?? null,
        search_tsv: searchVector(knex, article),
        approved_by: owner?.id ?? null,
        approved_at: knex.fn.now(),
        created_by: owner?.id ?? null,
        updated_by: owner?.id ?? null,
      });
    }
  }

  // Pi Vector lets the reply assistant quote fees from its knowledge base; the others don't.
  if (companies.pivector) {
    await knex('settings').insert({ org_unit_id: companies.pivector.id, key: 'ai.mayQuoteFees', value: JSON.stringify(true), updated_by: owner?.id ?? null }).onConflict(['org_unit_id', 'key']).ignore();
  }

  const sp = companies.satnpaper;
  const pv = companies.pivector;
  for (const company of [sp, pv].filter(Boolean)) {
    for (const deal of await originalMessages(knex, company.id, 'b2c', 3)) {
      await run({ companyId: company.id, agent: 'intake', input: { message: deal.text, channel: deal.original_message.channel, ...(deal.from.name ? { senderName: deal.from.name } : {}), ...(deal.from.phone ? { senderPhone: deal.from.phone } : {}) }, subject: { dealId: deal.id }, reference: `seed:intake:${deal.id}` });
    }
    for (const deal of await originalMessages(knex, company.id, 'b2b', 1)) {
      await run({ companyId: company.id, agent: 'b2b_qualifier', input: { text: deal.text }, subject: { dealId: deal.id }, reference: `seed:b2b:${deal.id}` });
    }
  }

  if (sp) {
    const counsellor = await knex('users').where({ email: 'ritika@phoenix.test' }).first('id', 'name');
    const [first, second, third] = await originalMessages(knex, sp.id, 'b2c', 3, { preferOwner: counsellor?.id ?? null });
    if (first) {
      await run({ companyId: sp.id, agent: 'reply', input: { message: 'What are the timings of the SAT weekend batch? Is it online?', channel: 'whatsapp' }, subject: { dealId: first.id }, reference: `seed:reply-timings:${first.id}` });
      await run({ companyId: sp.id, agent: 'meeting_summary', input: { transcript: meetingSummaryAgent.sample.transcript }, subject: { dealId: first.id }, reference: `seed:summary:${first.id}` });
    }
    if (second) {
      await run({ companyId: sp.id, agent: 'reply', input: { message: 'SAT weekend batch ki fees kitni hai? Koi discount milega?', channel: 'whatsapp' }, subject: { dealId: second.id }, reference: `seed:reply-fees:${second.id}` });
      await run({
        companyId: sp.id,
        agent: 'follow_up',
        input: { goal: 'book_demo', channel: 'whatsapp', lastInteraction: 'Asked about the SAT weekend batch two days ago and has not replied since.', counsellorName: counsellor?.name ?? 'Ritika' },
        subject: { dealId: second.id },
        reference: `seed:follow-up:${second.id}`,
      });
    }
    if (third) {
      await run({ companyId: sp.id, agent: 'reply', input: { message: 'I paid the fee last month but my son cannot attend any more. I want a refund.', channel: 'whatsapp' }, subject: { dealId: third.id }, reference: `seed:reply-refund:${third.id}` });
      await run({
        companyId: sp.id,
        agent: 'payment_chaser',
        input: { contactName: 'Priya Sharma', amountDueMinor: 1_500_000, currency: 'INR', dueDate: '2026-10-20', daysOverdue: 17, invoiceNumber: 'SP/2026-27/0142', remindersSent: 2, channel: 'whatsapp' },
        subject: { dealId: third.id },
        reference: `seed:payment:${third.id}`,
      });
    }
    await run({ companyId: sp.id, agent: 'classifier', input: { message: 'Hello, is this SatnPaper? Need SAT weekend batch details for my daughter in grade 11.', companyIds: [sp.id, pv?.id].filter(Boolean) }, reference: 'seed:classifier:1' });
    await run({ companyId: sp.id, agent: 'classifier', input: { message: 'Hi, coaching ke baare mein jaankari chahiye.', companyIds: [sp.id, pv?.id].filter(Boolean) }, reference: 'seed:classifier:2' });
  }
  console.log('AI demo data: knowledge base articles, guardrails and agent runs on seeded leads.');
}
