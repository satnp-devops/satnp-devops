import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { AppError, errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { validate } from '../../lib/validate.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { env } from '../../config/env.js';
import { describe } from '../../core/openapi/describe.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { getSetting } from '../../core/settings.js';
import { findOrCreateContact } from '../../core/crm/contacts.js';
import { addTimelineEvent } from '../../core/crm/timeline.js';
import { namesLikelySame, displayName } from '../../core/crm/normalize.js';
import { localDate } from '../../core/billing/dates.js';
import { JOINABLE_BATCH_STATUSES } from './constants.js';
import { checkoutCompanyParams, checkoutSessionSchema, checkoutTokenBody, checkoutTokenQuery, idParams } from './schemas.js';
import { checkoutEnabledSetting, deliverySettings, policyVersion, refundPolicySetting, refundSlaDaysSetting } from './settings.js';
import { createPaymentLink, usingDevPayments } from './ports.js';
import { createEnrollment } from './service.js';

// The public website checkout (docs/delivery/DELIVERY.md §8.3): a family picks a programme and
// batch, gives parent and student details, accepts the fee and refund policy and pays through
// the money module's payment link. The enrollment is created when payment.succeeded arrives
// (completeCheckout, called from the event handler), never from the browser.

export const CHECKOUT_TTL_MINUTES = 60;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function tokenMatches(session, token) {
  const a = Buffer.from(session.token_hash, 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The company of a public checkout URL, by code or id, with checkout switched on. 404 otherwise. */
async function checkoutCompany(key, trx = db) {
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const company = await trx('org_units')
    .where({ type: 'company', status: 'active' })
    .where((w) => (isId ? w.where('id', key) : w.whereRaw('lower(code) = lower(?)', [key])))
    .first();
  if (!company || !(await getSetting(company, checkoutEnabledSetting, trx))) throw errors.notFound('Checkout');
  return company;
}

const joinableToday = (query, alias = 'b') =>
  query
    .where(`${alias}.checkout_enabled`, true)
    .whereIn(`${alias}.status`, JOINABLE_BATCH_STATUSES)
    .where(`${alias}.ends_on`, '>=', localDate(Date.now()));

function presentPublicBatch(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    mode: row.mode,
    schedule: row.schedule ?? {},
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    location: row.location ?? null,
    fee: { valueMinor: Number(row.fee_minor), currency: row.currency },
    seatsLeft: Math.max(0, row.capacity - row.seats_taken),
    product: { id: row.product_id, name: row.product_name, description: row.product_description ?? null },
    productLine: { id: row.product_line_id, name: row.line_name },
  };
}

async function presentSession(session) {
  const [batch, company, enrollment] = await Promise.all([
    db('batches').where({ id: session.batch_id }).first('name', 'starts_on', 'ends_on', 'mode'),
    db('org_units').where({ id: session.company_id }).first('name', 'code'),
    session.enrollment_id ? db('enrollments').where({ id: session.enrollment_id }).first('id', 'ref', 'seat_status', 'status') : null,
  ]);
  let waitlistPosition = null;
  if (enrollment?.seat_status === 'waitlisted') {
    const { rows } = await db.raw(
      `select (select count(*) from waitlist_entries x where x.batch_id = w.batch_id and x.status = 'waiting' and x.queued_seq <= w.queued_seq)::int as position
         from waitlist_entries w where w.enrollment_id = ? and w.status = 'waiting'`,
      [enrollment.id],
    );
    waitlistPosition = rows[0]?.position ?? null;
  }
  return {
    id: session.id,
    status: session.status,
    company: { name: company.name, code: company.code },
    batch: { name: batch.name, startsOn: batch.starts_on, endsOn: batch.ends_on, mode: batch.mode },
    amount: { valueMinor: Number(session.amount_minor), currency: session.currency },
    paymentUrl: session.status === 'pending' ? session.payment_link_url : null,
    expiresAt: new Date(session.expires_at).toISOString(),
    paidAt: session.paid_at ? new Date(session.paid_at).toISOString() : null,
    enrollment: enrollment ? { ref: enrollment.ref, seatStatus: enrollment.seat_status, waitlistPosition } : null,
  };
}

async function loadSessionWithToken(id, token) {
  const session = await db('checkout_sessions').where({ id }).first();
  if (!session || !tokenMatches(session, token)) throw errors.notFound('Checkout');
  return session;
}

export function checkoutRoutes(router) {
  const viewLimit = rateLimit({ name: 'checkout-view', limit: 120, windowSeconds: 600, key: (req) => req.ip });
  const startLimit = rateLimit({ name: 'checkout-start', limit: 10, windowSeconds: 900, key: (req) => req.ip });

  router.get(
    '/public/checkout/:company',
    describe({ summary: 'Get the public checkout of a company', auth: 'public', rateLimited: true, description: 'Batches on sale (checkout on, open or planned, not ended), the fee and refund policy and its version. 404 when the company has no website checkout.' }),
    viewLimit,
    validate({ params: checkoutCompanyParams }),
    async (req, res) => {
      const company = await checkoutCompany(req.valid.params.company);
      const settings = await deliverySettings(company, [refundPolicySetting, refundSlaDaysSetting]);
      const rows = await joinableToday(db('batches as b'))
        .join('products as p', 'p.id', 'b.product_id')
        .join('product_lines as l', 'l.id', 'b.product_line_id')
        .where('b.company_id', company.id)
        .where('p.active', true)
        .select('b.*', 'p.name as product_name', 'p.description as product_description', 'l.name as line_name')
        .orderBy([{ column: 'l.position' }, { column: 'p.position' }, { column: 'b.starts_on' }, { column: 'b.id' }])
        .limit(200);
      const policy = settings[refundPolicySetting.key];
      res.json({
        data: {
          company: { id: company.id, name: company.name, code: company.code },
          policy: { text: policy, version: policyVersion(policy), refundDays: settings[refundSlaDaysSetting.key] },
          batches: rows.map(presentPublicBatch),
        },
      });
    },
  );

  router.post(
    '/public/checkout/:company/sessions',
    describe({
      summary: 'Start a checkout',
      auth: 'public',
      status: 201,
      rateLimited: true,
      errors: [409, 503],
      description:
        'Checks the batch has a seat, records the details and the policy acceptance, and asks the money module for a payment link (ports.createPaymentLink). Returns the session id, a token to follow it and the payment URL. 409 `batch_full`, 409 `policy_changed` (show the new policy).',
    }),
    startLimit,
    validate({ params: checkoutCompanyParams, body: checkoutSessionSchema }),
    async (req, res) => {
      const body = req.valid.body;
      const company = await checkoutCompany(req.valid.params.company);
      const policy = await getSetting(company, refundPolicySetting);
      if (body.consent.policyVersion !== policyVersion(policy)) {
        throw new AppError(409, 'policy_changed', 'The fee and refund policy has changed. Read it again before you pay.', { policyVersion: policyVersion(policy) });
      }
      const batch = await joinableToday(db('batches as b')).where({ 'b.id': body.batchId, 'b.company_id': company.id }).first('b.*');
      if (!batch) throw errors.validation([{ path: 'body.batchId', message: 'This batch is not open for online admission' }]);
      if (batch.seats_taken >= batch.capacity) {
        throw new AppError(409, 'batch_full', `${batch.name} is full. Pick another batch or call us to join the waitlist.`, { batchId: batch.id });
      }
      const product = await db('products').where({ id: batch.product_id }).first('name');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60_000);
      const acceptedAt = new Date().toISOString();
      const session = await db.transaction(async (trx) => {
        const [row] = await trx('checkout_sessions')
          .insert({
            group_id: batch.group_id,
            company_id: batch.company_id,
            unit_id: batch.unit_id,
            batch_id: batch.id,
            product_id: batch.product_id,
            token_hash: hashToken(token),
            status: 'pending',
            amount_minor: batch.fee_minor,
            currency: batch.currency,
            details: json({ parent: body.parent, student: body.student, utm: body.utm ?? null }),
            consent: json({
              acceptedPolicy: true,
              policyVersion: body.consent.policyVersion,
              acceptedAt,
              whatsappUpdates: body.consent.whatsappUpdates,
              marketing: body.consent.marketing,
              ip: req.ip,
              userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
            }),
            expires_at: expiresAt,
          })
          .returning('*');
        await emitEvent(trx, {
          type: 'checkout.started',
          groupId: row.group_id,
          unitId: row.unit_id,
          aggregateType: 'checkout_session',
          aggregateId: row.id,
          payload: { checkoutSessionId: row.id, companyId: row.company_id, batchId: row.batch_id, productId: row.product_id, amountMinor: Number(row.amount_minor), currency: row.currency },
        });
        await writeAudit(trx, req, { action: 'checkout.started', entityType: 'checkout_session', entityId: row.id, unit: { id: row.unit_id, root_id: row.group_id }, after: { batchId: row.batch_id, amountMinor: Number(row.amount_minor) } });
        return row;
      });

      let link;
      try {
        link = await createPaymentLink({
          companyId: company.id,
          unitId: batch.unit_id,
          amountMinor: Number(batch.fee_minor),
          currency: batch.currency,
          reference: session.id,
          description: `${product.name}: ${batch.name}`,
          customer: { name: displayName(body.parent.firstName, body.parent.lastName), phone: body.parent.phone, email: body.parent.email },
          returnUrl: `${env.APP_URL}/checkout/${encodeURIComponent(company.code)}/done?session=${session.id}&token=${encodeURIComponent(token)}`,
          expiresAt: expiresAt.toISOString(),
          metadata: { checkoutSessionId: session.id, companyCode: company.code, batchId: batch.id, productId: batch.product_id },
          token,
        });
      } catch (err) {
        logger.error({ err, checkoutSessionId: session.id }, 'Payment link failed');
        await db('checkout_sessions').where({ id: session.id }).update({ status: 'failed', details: json({}), purged_at: db.fn.now(), updated_at: db.fn.now() });
        throw new AppError(503, 'payments_unavailable', "We couldn't start the payment. Please try again in a few minutes.");
      }
      const [updated] = await db('checkout_sessions')
        .where({ id: session.id })
        .update({ payment_link_id: link.id, payment_link_url: link.url, payment_provider: link.provider, updated_at: db.fn.now() })
        .returning('*');
      res.status(201).json({ data: { ...(await presentSession(updated)), token } });
    },
  );

  router.get(
    '/public/checkout/sessions/:id',
    describe({ summary: 'Follow a checkout', auth: 'public', rateLimited: true, description: 'Status of a checkout for the browser that started it (needs its token). Shows the enrollment reference once payment is confirmed.' }),
    viewLimit,
    validate({ params: idParams, query: checkoutTokenQuery }),
    async (req, res) => {
      const session = await loadSessionWithToken(req.valid.params.id, req.valid.query.token);
      res.json({ data: await presentSession(session) });
    },
  );

  router.post(
    '/public/checkout/sessions/:id/simulate-payment',
    describe({ summary: 'Simulate a payment (development)', auth: 'public', status: 202, errors: [409], description: 'Development only (404 otherwise): while the payment-link port is the development stub: emits payment.succeeded for the session exactly as the money module will.' }),
    startLimit,
    validate({ params: idParams, body: checkoutTokenBody }),
    async (req, res) => {
      if (!usingDevPayments()) throw errors.notFound('Route');
      const session = await loadSessionWithToken(req.valid.params.id, req.valid.body.token);
      if (session.status !== 'pending') throw errors.conflict('This checkout is already paid or closed');
      await db.transaction(async (trx) => {
        await emitEvent(trx, {
          type: 'payment.succeeded',
          groupId: session.group_id,
          unitId: session.unit_id,
          aggregateType: 'payment',
          aggregateId: `dev_pay_${randomUUID()}`,
          payload: {
            paymentId: `dev_pay_${randomUUID()}`,
            provider: 'dev',
            companyId: session.company_id,
            checkoutSessionId: session.id,
            reference: session.id,
            amountMinor: Number(session.amount_minor),
            currency: session.currency,
            paidAt: new Date().toISOString(),
            isFirstPayment: true,
          },
        });
      });
      res.status(202).json({ data: await presentSession(session) });
    },
  );
}

// ---------- Completing a checkout (event handler) ----------

/** The parent's household (the one they are primary in, else the oldest), or a new one; the student joins it. */
async function linkFamily(trx, { groupId, unitId, parent, student, relation, city, lastName }) {
  const memberships = await trx('household_members as m')
    .join('households as h', 'h.id', 'm.household_id')
    .where('m.contact_id', parent.id)
    .whereNull('h.archived_at')
    .orderBy([{ column: 'm.is_primary', order: 'desc' }, { column: 'h.created_at' }])
    .select('h.*');
  let household = memberships[0] ?? null;
  const event = async (type, payload) =>
    emitEvent(trx, { type, groupId, unitId, aggregateType: 'household', aggregateId: household.id, payload: { householdId: household.id, ...payload } });
  const addedTimeline = (contact) =>
    addTimelineEvent(trx, {
      groupId,
      contactId: contact.id,
      kind: 'system',
      title: `Added to the ${household.name}`,
      meta: { action: 'household.member_added', householdId: household.id },
      actorType: 'system',
    });
  if (!household) {
    [household] = await trx('households')
      .insert({ group_id: groupId, name: `${lastName || parent.first_name || parent.display_name} family`, city: city ?? parent.city ?? null })
      .returning('*');
    await trx('household_members').insert({ household_id: household.id, contact_id: parent.id, role: 'parent', relation: relation ?? null, is_primary: true });
    await event('household.created', { memberIds: [parent.id] });
    await event('household.member_added', { contactId: parent.id, role: 'parent' });
    await addedTimeline(parent);
  }
  const inserted = await trx('household_members')
    .insert({ household_id: household.id, contact_id: student.id, role: 'student', is_primary: false })
    .onConflict(['household_id', 'contact_id'])
    .ignore()
    .returning('contact_id');
  if (inserted.length) {
    await event('household.member_added', { contactId: student.id, role: 'student' });
    await addedTimeline(student);
  }
  return household;
}

/** The company link findOrCreateContact would make, for a person found through their family (no phone or email to match on). */
async function ensureCompanyLink(trx, contact, { groupId, companyId, unitId }, source) {
  const [link] = await trx('contact_companies')
    .insert({ id: randomUUID(), contact_id: contact.id, group_id: groupId, company_id: companyId, unit_id: unitId, status: 'lead', source: json(source) })
    .onConflict(['contact_id', 'company_id'])
    .ignore()
    .returning('*');
  if (!link) return;
  await addTimelineEvent(trx, {
    groupId,
    companyId,
    unitId,
    contactId: contact.id,
    kind: 'system',
    title: 'Contact added to this company',
    meta: { action: 'contact.company_linked', channel: source.channel },
    actorType: 'system',
  });
  await emitEvent(trx, {
    type: 'contact.company_linked',
    groupId,
    unitId,
    aggregateType: 'contact',
    aggregateId: contact.id,
    payload: { contactId: contact.id, companyId, unitId, kind: contact.kind, matchedBy: 'household', source: { channel: source.channel } },
  });
}

/** A student of the parent's family with the same name (siblings have different names). */
async function familyStudent(trx, parentId, student) {
  const name = displayName(student.firstName, student.lastName);
  const rows = await trx('household_members as pm')
    .join('household_members as sm', 'sm.household_id', 'pm.household_id')
    .join('contacts as c', 'c.id', 'sm.contact_id')
    .where('pm.contact_id', parentId)
    .whereNot('sm.contact_id', parentId)
    .whereNull('c.merged_into_id')
    .whereNull('c.erased_at')
    .where((w) => w.where('c.kind', 'student').orWhere('sm.role', 'student'))
    .select('c.*');
  return rows.find((c) => namesLikelySame(c.display_name, name) === true) ?? null;
}

async function recordConsents(trx, { groupId, companyId, unitId, contact, consent, sessionId }) {
  const records = [];
  if (consent.whatsappUpdates) records.push({ channel: 'whatsapp', purpose: 'service', label: 'WhatsApp updates consent given' });
  if (consent.marketing) records.push({ channel: 'all', purpose: 'marketing', label: 'Marketing consent given' });
  for (const record of records) {
    const [row] = await trx('consents')
      .insert({
        group_id: groupId,
        contact_id: contact.id,
        company_id: companyId,
        channel: record.channel,
        purpose: record.purpose,
        status: 'granted',
        source: 'checkout',
        evidence: json({ checkoutSessionId: sessionId, policyVersion: consent.policyVersion, ip: consent.ip ?? null, userAgent: consent.userAgent ?? null, form: 'website checkout' }),
        captured_at: consent.acceptedAt ?? new Date(),
      })
      .returning('*');
    await emitEvent(trx, {
      type: 'consent.recorded',
      groupId,
      unitId,
      aggregateType: 'contact',
      aggregateId: contact.id,
      payload: { consentId: row.id, contactId: contact.id, companyId, channel: record.channel, purpose: record.purpose, status: 'granted', source: 'checkout' },
    });
    await addTimelineEvent(trx, {
      groupId,
      companyId,
      unitId,
      contactId: contact.id,
      kind: 'system',
      title: record.label,
      meta: { action: 'consent.recorded', consentId: row.id, channel: record.channel, purpose: record.purpose, status: 'granted' },
      actorType: 'contact',
    });
  }
}

/** An open (or just won) family deal in the company for this programme, to attach the enrollment to. */
async function matchingDeal(trx, { companyId, contactIds, productLineId, productId }) {
  const rows = await trx('deals as d')
    .where('d.company_id', companyId)
    .whereNull('d.archived_at')
    .whereNull('d.account_id')
    .whereIn('d.status', ['open', 'won'])
    .where((w) =>
      w.whereIn('d.primary_contact_id', contactIds).orWhereExists(trx('deal_contacts as dc').whereRaw('dc.deal_id = d.id').whereIn('dc.contact_id', contactIds).select(trx.raw('1'))),
    )
    .whereNotExists(trx('enrollments as e').whereRaw('e.deal_id = d.id').whereIn('e.status', ['active', 'paused']).select(trx.raw('1')))
    .select('d.id', 'd.unit_id', 'd.owner_user_id', 'd.product_id', 'd.product_line_id', 'd.status', 'd.updated_at')
    .orderBy('d.updated_at', 'desc')
    .limit(20);
  const score = (d) => (d.product_id === productId ? 0 : d.product_line_id === productLineId ? 1 : !d.product_line_id ? 2 : 9) + (d.status === 'open' ? 0 : 0.5);
  return rows.filter((d) => score(d) < 9).sort((a, b) => score(a) - score(b))[0] ?? null;
}

/**
 * Turn a paid checkout into an enrollment, once. Safe to call again for the same payment (or a
 * second delivery of the event): the session lock and the enrollment's source key stop duplicates.
 * @returns {Promise<{ enrollment: object | null, created: boolean }>}
 */
export async function completeCheckout(trx, sessionId, payment) {
  const session = await trx('checkout_sessions').where({ id: sessionId }).forUpdate().first();
  if (!session) return { enrollment: null, created: false };
  if (session.enrollment_id) {
    const existing = await trx('enrollments').where({ id: session.enrollment_id }).first();
    const result = await createEnrollment(trx, {}, {
      groupId: existing.group_id,
      companyId: existing.company_id,
      unitId: existing.unit_id,
      studentContactId: existing.student_contact_id,
      productId: existing.product_id,
      source: 'checkout',
      sourceKey: `checkout:${session.id}`,
      checkoutSessionId: session.id,
      payment,
    });
    return { enrollment: result.enrollment, created: false };
  }
  const details = session.details ?? {};
  if (!details.parent || !details.student) {
    logger.warn({ checkoutSessionId: session.id }, 'Paid checkout has no details (purged before payment); needs a person to enroll');
    await trx('checkout_sessions').where({ id: session.id }).update({ status: 'paid', payment_id: payment.paymentId, paid_at: payment.paidAt, updated_at: trx.fn.now() });
    // Someone has to enroll this family by hand (or refund them): tell automations.
    await emitEvent(trx, {
      type: 'checkout.needs_attention',
      groupId: session.group_id,
      unitId: session.unit_id,
      aggregateType: 'checkout_session',
      aggregateId: session.id,
      payload: { checkoutSessionId: session.id, companyId: session.company_id, batchId: session.batch_id, paymentId: payment.paymentId, reason: 'paid_after_expiry' },
    });
    return { enrollment: null, created: false };
  }
  const base = { groupId: session.group_id, companyId: session.company_id, unitId: session.unit_id };
  const source = { channel: 'website_checkout', ...(details.utm ? { utm: details.utm } : {}) };
  const { contact: parent } = await findOrCreateContact(trx, {
    ...base,
    kind: 'parent',
    firstName: details.parent.firstName,
    lastName: details.parent.lastName,
    phones: [{ value: details.parent.phone, kind: 'phone' }],
    emails: [details.parent.email],
    city: details.student.city,
    source,
    actorType: 'system',
    invalidMethods: 'skip',
  });
  let student = await familyStudent(trx, parent.id, details.student);
  if (!student) {
    ({ contact: student } = await findOrCreateContact(trx, {
      ...base,
      kind: 'student',
      firstName: details.student.firstName,
      lastName: details.student.lastName ?? details.parent.lastName,
      phones: details.student.phone ? [details.student.phone] : [],
      emails: details.student.email ? [details.student.email] : [],
      city: details.student.city,
      studentProfile: { ...(details.student.grade ? { grade: details.student.grade } : {}), ...(details.student.school ? { school: details.student.school } : {}) },
      source,
      actorType: 'system',
      invalidMethods: 'skip',
    }));
  } else {
    // Known to the family already: make sure this company knows them too.
    await ensureCompanyLink(trx, student, base, source);
  }
  const household = await linkFamily(trx, {
    ...base,
    parent,
    student,
    relation: details.parent.relation,
    city: details.student.city,
    lastName: details.parent.lastName,
  });
  await recordConsents(trx, { ...base, contact: parent, consent: session.consent ?? {}, sessionId: session.id });

  const batch = await trx('batches').where({ id: session.batch_id }).first();
  const deal = await matchingDeal(trx, { companyId: session.company_id, contactIds: [parent.id, student.id], productLineId: batch.product_line_id, productId: batch.product_id });
  const result = await createEnrollment(trx, {}, {
    ...base,
    unitId: deal?.unit_id ?? session.unit_id,
    studentContactId: student.id,
    payerContactId: parent.id,
    householdId: household.id,
    dealId: deal?.id ?? null,
    productId: batch.product_id,
    productLineId: batch.product_line_id,
    batchId: batch.id,
    joinWaitlist: true,
    ownerUserId: deal?.owner_user_id ?? null,
    source: 'checkout',
    sourceKey: `checkout:${session.id}`,
    checkoutSessionId: session.id,
    feeMinor: Number(session.amount_minor),
    currency: session.currency,
    accessStatus: 'pending',
    payment,
  });
  await trx('checkout_sessions')
    .where({ id: session.id })
    .update({
      status: 'completed',
      payment_id: payment.paymentId,
      paid_at: payment.paidAt,
      enrollment_id: result.enrollment.id,
      // The details now live in the contact records; the session keeps no personal data.
      details: json({}),
      purged_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
  await emitEvent(trx, {
    type: 'checkout.session_completed',
    groupId: session.group_id,
    unitId: session.unit_id,
    aggregateType: 'checkout_session',
    aggregateId: session.id,
    payload: { checkoutSessionId: session.id, companyId: session.company_id, enrollmentId: result.enrollment.id, paymentId: payment.paymentId, dealId: deal?.id ?? null },
  });
  return result;
}

/** Expire unpaid checkouts and drop their personal data (worker job). */
export async function expireCheckoutSessions({ now = new Date(), trx = db } = {}) {
  const rows = await trx('checkout_sessions')
    .where('status', 'pending')
    .where('expires_at', '<', now)
    .update({ status: 'expired', details: json({}), purged_at: trx.fn.now(), updated_at: trx.fn.now() })
    .returning('id');
  return { expired: rows.length };
}
