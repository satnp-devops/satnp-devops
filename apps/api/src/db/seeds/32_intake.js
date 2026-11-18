import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { encrypt } from '../../lib/crypto.js';
import { normalizeIdentity } from '../../core/intake/index.js';
import { buildRegistry } from '../../registry.js';
import { defaultFields } from '../../modules/intake/forms.js';
import { crmNormalizers } from '../../modules/intake/settings.js';
import { ingestEnquiry } from '../../modules/intake/service.js';

// Demo intake setup (phase 4): website forms (SatnPaper SAT enquiry, software demo request and a
// checkout hand-off; Pi Vector JEE enquiry; Excel board batches enquiry), the channel registry
// (owned numbers and inboxes, a shared group WhatsApp number and inbox), assignment pools,
// a partner referral link, and a handful of enquiries run through the real pipeline so the
// review queue and the enquiry log have something in them.
//
// Idempotent: skipped when the Phoenix group already has intake forms. Phone numbers use the fake
// +91 90000 1xxxx (business numbers) and +91 90000 2xxxx (new enquirers) ranges.

const GROUP_CODE = 'phoenix';
const json = (v) => JSON.stringify(v);

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) return console.log('Intake demo data needs the Phoenix group: run the foundation seed first.');
  if (await knex('intake_forms').where({ group_id: group.id }).first('id')) return console.log('Intake demo data already present.');
  if (!(await knex('pipelines').where({ group_id: group.id }).first('id'))) return console.log('Intake demo data needs the CRM seed (02_crm.js) first.');

  const units = await knex('org_units').where({ root_id: group.id });
  const company = (code) => units.find((u) => u.type === 'company' && u.code === code);
  const unitIn = (companyCode, code) => units.find((u) => u.code === code && u.path.startsWith(company(companyCode).path));
  const users = new Map((await knex('users').select('id', 'email')).map((u) => [u.email, u.id]));
  const lines = await knex('product_lines').where({ group_id: group.id }).select('id', 'key', 'company_id');
  const line = (key) => lines.find((l) => l.key === key)?.id ?? null;
  const owner = users.get('owner@phoenix.test') ?? null;

  const sp = company('satnpaper');
  const pv = company('pi-vector');
  const ex = company('excel');
  const satTeam = unitIn('satnpaper', 'sat-admissions');
  const swTeam = unitIn('satnpaper', 'software-sales');
  const pvTeam = unitIn('pi-vector', 'admissions');
  const exTeam = unitIn('excel', 'admissions');

  // ---------- Forms ----------
  const consent = { text: 'I agree that the team may contact me on WhatsApp and by phone about this enquiry.', required: true, channels: ['whatsapp', 'calls'] };
  const spam = { honeypot: true, minSeconds: 3, captcha: 'none', allowedOrigins: [], perIpPerHour: 20 };
  const form = (over) => ({
    id: randomUUID(),
    group_id: group.id,
    key: randomBytes(9).toString('base64url'),
    kind: 'enquiry',
    audience: 'b2c',
    fields: json(defaultFields(over.audience ?? 'b2c')),
    consent: json(consent),
    spam: json(spam),
    thank_you: json({ mode: 'message', message: 'Thank you! A counsellor will call you within a few hours.' }),
    created_by: owner,
    ...over,
  });
  const satForm = form({ company_id: sp.id, unit_id: satTeam.id, name: 'SAT enquiry (website)', product_line_id: line('sat_group_batch') });
  const swForm = form({ company_id: sp.id, unit_id: swTeam.id, name: 'Software demo request', audience: 'b2b', fields: json(defaultFields('b2b')), product_line_id: line('testhub'), thank_you: json({ mode: 'message', message: 'Thanks. Our team will set up a demo.' }) });
  const checkoutForm = form({ company_id: sp.id, unit_id: satTeam.id, name: 'SAT batch checkout', kind: 'checkout', product_line_id: line('sat_group_batch'), fields: json([]), consent: json({ required: false, channels: [] }), signing_secret_enc: encrypt(randomBytes(32).toString('hex'), env.encryptionKey) });
  const pvForm = form({ company_id: pv.id, unit_id: pvTeam?.id ?? pv.id, name: 'JEE enquiry (website)', product_line_id: line('jee_classroom') });
  const exForm = form({ company_id: ex.id, unit_id: exTeam?.id ?? ex.id, name: 'Board batches enquiry', product_line_id: line('board_batches') });
  await knex('intake_forms').insert([satForm, swForm, checkoutForm, pvForm, exForm]);

  // ---------- Channel registry ----------
  const identity = (type, value, over) => ({
    id: randomUUID(),
    group_id: group.id,
    type,
    identity: value,
    identity_normalized: normalizeIdentity(type, value, crmNormalizers),
    created_by: owner,
    ...over,
  });
  await knex('intake_channel_identities').insert([
    identity('whatsapp', '+91 90000 10001', { company_id: sp.id, unit_id: satTeam.id, label: 'SatnPaper admissions WhatsApp' }),
    identity('email', 'admissions@satnpaper.example', { company_id: sp.id, label: 'SatnPaper admissions inbox' }),
    identity('email', 'software@satnpaper.example', { company_id: sp.id, unit_id: swTeam.id, product_line_id: line('testhub'), label: 'SatnPaper software inbox' }),
    identity('facebook_lead_ad', 'fb-sat-2026', { company_id: sp.id, unit_id: satTeam.id, product_line_id: line('sat_group_batch'), label: 'SAT 2026 lead form' }),
    identity('phone_call', '+91 90000 10002', { company_id: pv.id, label: 'Pi Vector call centre' }),
    identity('whatsapp', '+91 90000 10003', { company_id: ex.id, label: 'Excel WhatsApp' }),
    identity('whatsapp', '+91 90000 10000', { shared: true, company_ids: [sp.id, pv.id, ex.id], label: 'Phoenix group WhatsApp' }),
    identity('email', 'info@phoenix.example', { shared: true, company_ids: [sp.id, pv.id, ex.id], label: 'Phoenix group inbox' }),
  ]);

  // ---------- Assignment pools ----------
  const pool = (over) => ({ id: randomUUID(), group_id: group.id, created_by: owner, ...over });
  const satPool = pool({ company_id: sp.id, unit_id: satTeam.id, name: 'SAT admissions', kind: 'b2c', is_default: true });
  const swPool = pool({ company_id: sp.id, unit_id: swTeam.id, name: 'Software sales', kind: 'b2b', position: 1 });
  const pvPool = pool({ company_id: pv.id, unit_id: pvTeam?.id ?? pv.id, name: 'Delhi admissions', kind: 'b2c', is_default: true });
  const exPool = pool({ company_id: ex.id, unit_id: exTeam?.id ?? ex.id, name: 'Mumbai admissions', kind: 'b2c', is_default: true });
  await knex('intake_assignment_pools').insert([satPool, swPool, pvPool, exPool]);
  const member = (poolId, email, over = {}) => (users.get(email) ? { pool_id: poolId, user_id: users.get(email), languages: ['en'], ...over } : null);
  await knex('intake_pool_members').insert(
    [
      member(satPool.id, 'kabir@phoenix.test', { capacity: 60, languages: ['en', 'hi'] }),
      member(satPool.id, 'ritika@phoenix.test', { capacity: 40, languages: ['en'] }),
      member(swPool.id, 'sales.satnpaper@phoenix.test', { capacity: 50 }),
      member(pvPool.id, 'admin.pivector@phoenix.test', { languages: ['en', 'hi'] }),
      member(exPool.id, 'admin.excel@phoenix.test', { languages: ['en', 'mr'] }),
    ].filter(Boolean),
  );

  // ---------- Partner referral link ----------
  const partnerId = randomUUID();
  await knex('intake_partner_links').insert({
    id: randomUUID(),
    group_id: group.id,
    company_id: sp.id,
    code: 'EDUADV-PUNE',
    partner_id: partnerId,
    partner_name: 'EduAdvisors Pune',
    owner_user_id: users.get('ritika@phoenix.test') ?? null,
    product_line_id: line('sat_group_batch'),
    form_id: satForm.id,
    created_by: owner,
  });

  // ---------- Enquiries through the pipeline ----------
  const registry = buildRegistry();
  const ctx = { db: knex, registry };
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const owned = (f) => ({ owned: { companyId: f.company_id, productLineId: f.product_line_id }, unitId: f.unit_id, formId: f.id, audience: f.audience });
  const runs = [
    // New families on the SAT form (round-robin between Kabir and Ritika).
    { ...owned(satForm), payload: { receivedAt: at(50), source: { channel: { type: 'website_form', identity: satForm.key }, formId: satForm.id, landingUrl: 'https://satnpaper.example/sat?utm_source=google&utm_medium=cpc&utm_campaign=sat-dec' }, contact: { name: 'Meera Kulkarni', phone: '+91 90000 20001', email: 'meera.kulkarni@example.com', city: 'Pune' }, student: { name: 'Aditya Kulkarni', grade: '11' }, interest: { message: 'Looking for the December SAT batch, weekend classes.' }, consent: { whatsapp: true, calls: true, text: consent.text } } },
    { ...owned(satForm), payload: { receivedAt: at(42), source: { channel: { type: 'website_form', identity: satForm.key }, formId: satForm.id }, contact: { name: 'Farhan Siddiqui', phone: '+91 90000 20002', city: 'Mumbai' }, student: { name: 'Zoya Siddiqui', grade: '12' }, interest: { message: 'Need a crash course before the March SAT.' } } },
    // The same family again, a day later: added to their open lead.
    { ...owned(satForm), payload: { receivedAt: at(30), source: { channel: { type: 'website_form', identity: satForm.key }, formId: satForm.id }, contact: { name: 'Meera Kulkarni', phone: '90000 20001' }, interest: { message: 'Also asking about 1:1 mentorship.' } } },
    // Through the partner's referral link: stays with Ritika.
    { ...owned(satForm), partnerCode: 'EDUADV-PUNE', payload: { receivedAt: at(25), source: { channel: { type: 'website_form', identity: satForm.key }, formId: satForm.id }, contact: { name: 'Sunita Rao', phone: '+91 90000 20003', city: 'Pune' }, student: { name: 'Kiran Rao', grade: '10' } } },
    // Institute demo request (B2B).
    { ...owned(swForm), payload: { receivedAt: at(20), source: { channel: { type: 'website_form', identity: swForm.key }, formId: swForm.id }, contact: { name: 'Vikram Bhatia', phone: '+91 90000 20004', email: 'vikram@brightminds.example' }, institute: { name: 'Bright Minds Academy', city: 'Nagpur', studentCount: 800 }, interest: { message: 'Want online tests for 800 students.' } } },
    // Shared group WhatsApp: no classifier connected yet, so these wait in the review queue.
    { payload: { externalId: 'wamid.seed-1', receivedAt: at(15), source: { channel: { type: 'whatsapp', identity: '+91 90000 10000' } }, contact: { name: 'Rohit Verma', phone: '+91 90000 20005' }, interest: { message: 'Hi, do you have JEE classes in Delhi?' } } },
    { payload: { externalId: 'wamid.seed-2', receivedAt: at(12), source: { channel: { type: 'whatsapp', identity: '+91 90000 10000' } }, contact: { phone: '+91 90000 20006' }, interest: { message: 'Fees for SAT coaching?' } } },
    { payload: { externalId: 'seed-mail-1', receivedAt: at(10), source: { channel: { type: 'email', identity: 'info@phoenix.example' } }, contact: { name: 'Anjali Nair', email: 'anjali.nair@example.com' }, interest: { message: 'Subject: Admissions\n\nWhich batches start in January?' } } },
    // Pi Vector call centre (owned number) and Excel's form.
    { payload: { externalId: 'exotel-seed-1', receivedAt: at(8), source: { channel: { type: 'phone_call', identity: '+91 90000 10002' } }, contact: { phone: '+91 90000 20007' } } },
    { ...owned(exForm), payload: { receivedAt: at(5), source: { channel: { type: 'website_form', identity: exForm.key }, formId: exForm.id }, contact: { name: 'Prakash Patil', phone: '+91 90000 20008', city: 'Mumbai' }, student: { name: 'Sneha Patil', grade: '9' } } },
  ];
  // A possible duplicate: an existing seeded parent's name and city with a new number.
  const known = await knex('contacts as c').join('household_members as hm', 'hm.contact_id', 'c.id').where({ 'c.group_id': group.id, 'hm.role': 'parent' }).whereNotNull('c.city').whereNotNull('c.last_name').orderBy('c.created_at').first('c.display_name', 'c.city');
  if (known) {
    runs.push({ ...owned(satForm), payload: { receivedAt: at(3), source: { channel: { type: 'website_form', identity: satForm.key }, formId: satForm.id }, contact: { name: known.display_name, phone: '+91 90000 20009', city: known.city }, interest: { message: 'Following up about batches.' } } });
  }
  let done = 0;
  for (const run of runs) {
    const { payload, ...input } = run;
    try {
      await ingestEnquiry({ groupId: group.id, payload, ...input }, ctx);
      done += 1;
    } catch (error) {
      console.log(`Intake seed: an enquiry was not processed (${error.message})`);
    }
  }
  console.log(`Intake demo data: 5 forms, 8 channels, 4 pools, 1 referral link, ${done} enquiries.`);
}
