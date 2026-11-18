import { createHmac, timingSafeEqual } from 'node:crypto';
import { db as defaultDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { EnquiryInvalidError, ingestEnquiry } from './service.js';

// Channel handlers: each turns one provider's payload into the normalised enquiry input and
// calls ingestEnquiry. The webhook framework (platform slice) verifies the request and calls the
// handler with the parsed event and the connection it arrived on:
//
//   handleLeadAd(event, { db, registry, groupId, companyId? })     Facebook / Instagram / Google lead forms
//   handleCallLead(event, { db, registry, groupId, companyId? })   Exotel call.inbound (Passthru applet)
//   handleEmailLead(email, { db, registry, groupId, companyId? })  SendGrid Inbound Parse / Microsoft Graph message
//
// `companyId` is the connection's company: used only when no channel identity matches. Every
// handler is idempotent (the provider's event id is the enquiry's idempotency key), so webhook
// retries add nothing. Invalid payloads are recorded as failed enquiries, never thrown away.

const LEAD_AD_TYPES = { facebook: 'facebook_lead_ad', instagram: 'instagram', google: 'google_lead_form' };

/** Lead-form answers keyed by question: Meta `field_data`, Google `user_column_data`, or a plain object. */
export function leadAdAnswers(event) {
  if (Array.isArray(event.field_data)) {
    return Object.fromEntries(event.field_data.map((f) => [String(f.name ?? '').toLowerCase(), Array.isArray(f.values) ? f.values.join(', ') : String(f.values ?? '')]));
  }
  if (Array.isArray(event.user_column_data)) {
    return Object.fromEntries(event.user_column_data.map((c) => [String(c.column_id ?? c.column_name ?? '').toLowerCase(), String(c.string_value ?? '')]));
  }
  return Object.fromEntries(Object.entries(event.fields ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? '')]));
}

const ANSWER_KEYS = {
  name: ['full_name', 'name', 'parent_name'],
  firstName: ['first_name', 'given_name'],
  lastName: ['last_name', 'family_name', 'surname'],
  phone: ['phone_number', 'phone', 'mobile', 'mobile_number', 'whatsapp_number'],
  email: ['email', 'work_email', 'email_address'],
  city: ['city', 'location'],
  studentName: ['student_name', 'child_name'],
  grade: ['grade', 'class', 'current_class'],
  institute: ['company_name', 'institute_name', 'organisation', 'organization'],
};
const pickAnswer = (answers, keys) => keys.map((k) => answers[k]).find((v) => v && v.trim()) ?? undefined;

/** A lead-ad event → enquiry input. */
export function leadAdToEnquiry(event) {
  const provider = String(event.provider ?? (event.user_column_data ? 'google' : 'facebook')).toLowerCase();
  const type = LEAD_AD_TYPES[provider] ?? 'facebook_lead_ad';
  const answers = leadAdAnswers(event);
  const used = new Set(Object.values(ANSWER_KEYS).flat());
  const extra = Object.entries(answers).filter(([k, v]) => !used.has(k) && v).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  const institute = pickAnswer(answers, ANSWER_KEYS.institute);
  const studentName = pickAnswer(answers, ANSWER_KEYS.studentName);
  const formId = String(event.form_id ?? event.formId ?? '') || undefined;
  return {
    externalId: String(event.leadgen_id ?? event.lead_id ?? event.leadId ?? event.eventId ?? '') || undefined,
    receivedAt: event.created_time ? new Date(typeof event.created_time === 'number' ? event.created_time * 1000 : event.created_time).toISOString() : event.createdAt ?? undefined,
    source: {
      channel: { type, identity: formId ?? (String(event.page_id ?? event.pageId ?? '') || undefined) },
      formId,
      adId: String(event.ad_id ?? event.adId ?? '') || undefined,
      campaign: event.campaign_name ?? event.campaign ?? undefined,
      campaignId: String(event.campaign_id ?? event.campaignId ?? '') || undefined,
    },
    contact: {
      name: pickAnswer(answers, ANSWER_KEYS.name),
      firstName: pickAnswer(answers, ANSWER_KEYS.firstName),
      lastName: pickAnswer(answers, ANSWER_KEYS.lastName),
      phone: pickAnswer(answers, ANSWER_KEYS.phone),
      email: pickAnswer(answers, ANSWER_KEYS.email),
      city: pickAnswer(answers, ANSWER_KEYS.city),
    },
    ...(studentName || answers.grade ? { student: { name: studentName, grade: pickAnswer(answers, ANSWER_KEYS.grade) } } : {}),
    ...(institute ? { institute: { name: institute } } : {}),
    ...(extra.length ? { interest: { message: extra.join('\n').slice(0, 5000) } } : {}),
    raw: { provider, answers, isTest: Boolean(event.is_test ?? event.isTest) },
  };
}

/** Exotel's call.inbound event (parseWebhook) → enquiry input. A call the customer hung up on is a missed call. */
export function callLeadToEnquiry(event) {
  const lead = event.lead ?? {};
  const missed = event.outcome === 'customer_missed' || event.status === 'no_answer' || event.status === 'canceled';
  return {
    externalId: String(event.callId ?? event.eventId ?? '') || undefined,
    receivedAt: lead.receivedAt ?? event.occurredAt ?? undefined,
    source: { channel: { type: missed ? 'missed_call' : 'phone_call', identity: lead.calledNumber ?? event.to ?? undefined } },
    contact: { phone: lead.phone ?? event.from ?? undefined },
    ...(lead.digits ? { interest: { message: `Chose option ${lead.digits} in the call menu` } } : {}),
    raw: { provider: event.provider ?? 'exotel', callId: event.callId ?? null, digits: lead.digits ?? null, status: event.status ?? null },
  };
}

const addressOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(value.trim());
    return m ? { email: m[2], name: m[1].replace(/^"|"$/g, '') || null } : { email: value.trim(), name: null };
  }
  if (value.emailAddress) return { email: value.emailAddress.address, name: value.emailAddress.name ?? null }; // Microsoft Graph
  return { email: value.email ?? value.address ?? null, name: value.name ?? null };
};

/** An inbound email (SendGrid InboundEmail or a Microsoft Graph message) → enquiry input. */
export function emailToEnquiry(email) {
  const from = addressOf(email.from);
  const to = (Array.isArray(email.to) ? email.to : email.toRecipients ?? [email.to]).map(addressOf).filter(Boolean);
  const inbox = email.envelope?.to?.[0] ?? to[0]?.email ?? undefined;
  const body = typeof email.text === 'string' ? email.text : email.body?.contentType === 'text' ? email.body.content : email.bodyPreview ?? '';
  return {
    externalId: String(email.dedupeKey ?? email.messageIdHeader ?? email.internetMessageId ?? email.id ?? '') || undefined,
    receivedAt: email.date ?? email.receivedDateTime ?? undefined,
    source: { channel: { type: 'email', identity: inbox } },
    contact: { name: from?.name ?? undefined, email: from?.email ?? undefined },
    interest: { message: [email.subject ? `Subject: ${email.subject}` : null, String(body).trim().slice(0, 4500)].filter(Boolean).join('\n\n') || undefined },
    raw: { subject: email.subject ?? null, inbox: inbox ?? null },
  };
}

async function run(kind, payload, ctx, extra = {}) {
  const log = ctx.log ?? logger;
  try {
    const result = await ingestEnquiry(
      { groupId: ctx.groupId, payload, companyHint: ctx.companyId ?? undefined, ...extra },
      { db: ctx.db ?? defaultDb, registry: ctx.registry, recordFailures: true },
    );
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof EnquiryInvalidError) {
      log.warn({ kind, issues: error.issues.map((i) => i.code) }, 'Intake: unreadable enquiry');
      return { ok: false, reason: 'invalid', issues: error.issues };
    }
    throw error;
  }
}

/** Lead ads (Facebook, Instagram, Google lead forms). Test leads are ignored. */
export async function handleLeadAd(event, ctx) {
  const payload = leadAdToEnquiry(event);
  if (payload.raw.isTest && ctx.acceptTestLeads !== true) return { ok: true, skipped: 'test_lead' };
  return run('lead_ad', payload, ctx);
}

/** Incoming and missed calls. Only `call.inbound` events with a caller number make a lead. */
export async function handleCallLead(event, ctx) {
  if (event.type && event.type !== 'call.inbound') return { ok: true, skipped: 'not_inbound' };
  if (!event.lead?.phone && !event.from) return { ok: true, skipped: 'no_caller' };
  return run('call', callLeadToEnquiry(event), ctx);
}

/** Email to lead. Replies to existing threads belong to messaging (phase 5), not intake. */
export async function handleEmailLead(email, ctx) {
  if (email.inReplyTo && ctx.ignoreReplies !== false) return { ok: true, skipped: 'reply' };
  if ((email.spam?.score ?? 0) >= (ctx.spamScore ?? 5)) return { ok: true, skipped: 'spam' };
  return run('email', emailToEnquiry(email), ctx);
}

// ---------- Website checkout hand-off ----------

const CHECKOUT_TOLERANCE_S = 300;

/** HMAC-SHA256 over "<timestamp>.<payload>" with the form's signing secret (hex). */
export function signCheckout(payload, timestamp, secret) {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

/** @returns {{ ok: true, data: object } | { ok: false, reason: string }} */
export function verifyCheckout({ payload, timestamp, signature }, secret, nowS) {
  if (typeof payload !== 'string' || !Number.isInteger(timestamp) || typeof signature !== 'string') return { ok: false, reason: 'malformed' };
  if (Math.abs(nowS - timestamp) > CHECKOUT_TOLERANCE_S) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signCheckout(payload, timestamp, secret));
  const given = Buffer.from(signature.toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  try {
    const data = JSON.parse(payload);
    return data && typeof data === 'object' ? { ok: true, data } : { ok: false, reason: 'malformed' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** The site's checkout data → enquiry input. */
export function checkoutToEnquiry(form, data) {
  const customer = data.customer ?? {};
  const lines = [
    data.status && `Checkout ${data.status}`,
    data.product && `Product: ${data.product}`,
    data.amount && `Amount: ${data.amount} ${data.currency ?? ''}`.trim(),
    data.orderId && `Order: ${data.orderId}`,
  ].filter(Boolean);
  return {
    externalId: data.orderId ? String(data.orderId).slice(0, 200) : undefined,
    audience: form.audience,
    source: { channel: { type: 'website_form', identity: form.key }, formId: form.id, landingUrl: data.pageUrl ?? undefined, campaign: data.campaign ?? undefined },
    contact: { name: customer.name, phone: customer.phone, email: customer.email, city: customer.city },
    ...(data.student ? { student: { name: data.student.name, grade: data.student.grade } } : {}),
    interest: { product: data.product ? String(data.product).slice(0, 200) : undefined, message: lines.join('\n') || undefined, ...(form.product_line_id ? { productLineId: form.product_line_id } : {}) },
    raw: { checkout: { orderId: data.orderId ?? null, status: data.status ?? null, amount: data.amount ?? null, currency: data.currency ?? null } },
  };
}
