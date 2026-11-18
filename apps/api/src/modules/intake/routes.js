import express from 'express';
import { db } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { decrypt } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { validate } from '../../lib/validate.js';
import { decodeCursor, pageOf } from '../../lib/pagination.js';
import { requireAuth } from '../../core/guards.js';
import { describe } from '../../core/openapi/describe.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { writeAudit } from '../../core/audit.js';
import { isKnownChannel } from '../../core/crm/channels.js';
import { applyListScope, canViewPiiAt, companiesInScope, listScope, requireCompany, requireCreateUnit, unitsIndex } from '../../core/crm/scope.js';
import { ENQUIRY_FIELDS } from '../../core/intake/index.js';
import { maskPiiText } from '../../core/ai/text.js';
import * as schemas from './schemas.js';
import * as config from './config.js';
import { embedSnippet, originOf, publicForm, signRenderToken, spamVerdict, submissionToEnquiry } from './forms.js';
import { checkoutToEnquiry, verifyCheckout } from './channels.js';
import { EnquiryInvalidError, ingestEnquiry } from './service.js';
import { listReviewItems, resolveReviewItem, reviewCounts } from './review.js';
import { IMPORT_FIELDS, MAX_IMPORT_BYTES, checkMapping, inspectCsv, startImport } from './imports.js';
import { port, portStatus } from './ports.js';
import { presentEnquiry, presentForm, presentIdentity, presentImportJob, presentImportRow, presentPartnerLink, presentPool, presentReviewItem } from './present.js';

// Intake endpoints. Public: the hosted form (no session; rate limited; honeypot, render token,
// optional captcha) and the signed checkout hand-off. Signed in: the review queue, CSV imports,
// the enquiry log, manual entry through the pipeline, and configuration (forms, channel
// identities, assignment pools, partner referral links).

const webOrigin = () => env.APP_URL;
const one = (rows) => rows[0] ?? null;

/** Fixed window per form and visitor: the form's own perIpPerHour. */
async function formRateLimit(form, ip) {
  const bucket = `rl:intake-form:${form.id}:${ip}`;
  const count = await redis.incr(bucket);
  if (count === 1) await redis.expire(bucket, 3600);
  if (count > (form.spam?.perIpPerHour ?? 20)) throw errors.tooMany('Too many submissions from this device. Try again later.');
}

async function activeForm(key, kind) {
  const form = await db('intake_forms').where({ key, active: true, kind }).first();
  if (!form) throw errors.notFound('Form');
  return form;
}

const notFoundAs = (label) => (e) => {
  throw e.status === 404 ? errors.notFound(label) : e;
};

/** Companies (by id) of the user's groups, for names in lists. */
const companyNames = (index) => new Map([...index.values()].filter((u) => u.type === 'company').map((u) => [u.id, u]));

export function intakeRoutes(router) {
  const publicReadLimit = rateLimit({ name: 'intake-form-read', limit: 120, windowSeconds: 600, key: (req) => req.ip });
  const publicWriteLimit = rateLimit({ name: 'intake-form-submit', limit: 30, windowSeconds: 600, key: (req) => req.ip });
  const checkoutLimit = rateLimit({ name: 'intake-checkout', limit: 300, windowSeconds: 600, key: (req) => `${req.params.key}:${req.ip}` });

  // ---------------- Public ----------------

  router.get(
    '/public/forms/:key',
    describe({ summary: 'Get a website form to show', auth: 'public', rateLimited: true }),
    publicReadLimit,
    validate({ params: schemas.keyParams, query: schemas.publicFormQuery }),
    async (req, res) => {
      const form = await activeForm(req.valid.params.key, 'enquiry');
      if (req.valid.query.ref) {
        await db('intake_partner_links').where({ group_id: form.group_id, code: req.valid.query.ref, active: true }).increment('click_count', 1);
      }
      res.set('Cache-Control', 'no-store');
      res.json({ data: publicForm(form, { token: signRenderToken(form.key, Date.now(), env.encryptionKey) }) });
    },
  );

  router.post(
    '/public/forms/:key/submissions',
    describe({
      summary: 'Submit a website form',
      description: 'No session needed. Send the `X-Phoenix-Client` header. Spam (honeypot filled, sent too fast, a foreign origin) gets the normal answer and is not stored. Emits `enquiry.received` and `lead.*`.',
      auth: 'public',
      status: 201,
      rateLimited: true,
    }),
    publicWriteLimit,
    validate({ params: schemas.keyParams, body: schemas.submissionBody }),
    async (req, res) => {
      const form = await activeForm(req.valid.params.key, 'enquiry');
      const body = req.valid.body;
      await formRateLimit(form, req.ip);
      const now = new Date();
      const verdict = spamVerdict(form, body, { key: env.encryptionKey, nowMs: now.getTime(), origin: originOf(body.pageUrl) });
      const thankYou = form.thank_you;
      if (verdict.spam) {
        await db('intake_forms').where({ id: form.id }).increment('spam_count', 1);
        logger.info({ formId: form.id, reason: verdict.reason }, 'Intake: form spam dropped');
        return res.status(201).json({ data: { ok: true, thankYou } });
      }
      if (form.spam?.captcha && form.spam.captcha !== 'none') {
        const check = await port('captcha').verify({ provider: form.spam.captcha, token: body.captchaToken, ip: req.ip, formId: form.id });
        if (!check.ok) throw errors.validation([{ path: 'body.captchaToken', message: 'Please complete the check that you are not a robot' }]);
      }
      const ref = body.ref ?? null;
      const { input, issues } = submissionToEnquiry(form, body, { receivedAt: now.toISOString() });
      if (issues.length) throw errors.validation(issues);
      try {
        await ingestEnquiry(
          {
            groupId: form.group_id,
            payload: input,
            owned: { companyId: form.company_id, productLineId: form.product_line_id, identityId: null },
            unitId: form.unit_id,
            formId: form.id,
            partnerCode: ref ?? undefined,
            audience: form.audience,
            evidence: { formId: form.id, formName: form.name, pageUrl: body.pageUrl ?? null, ip: req.ip },
          },
          { registry: req.app.locals.registry, now },
        );
      } catch (error) {
        if (error instanceof EnquiryInvalidError) {
          // Point each problem at the form field that fills it, so the visitor sees it in place.
          throw errors.validation(error.issues.map((i) => {
            const field = form.fields.find((f) => f.maps === i.path);
            return { path: field ? `body.fields.${field.key}` : `body.${i.path}`, message: i.message };
          }));
        }
        // Stored as a failed enquiry for the team to retry; the visitor is not asked to try again.
        logger.error({ err: error, formId: form.id }, 'Intake: form enquiry could not be processed');
      }
      await db('intake_forms').where({ id: form.id }).update({ submission_count: db.raw('submission_count + 1'), last_submission_at: now });
      res.status(201).json({ data: { ok: true, thankYou } });
    },
  );

  router.post(
    '/public/checkout/:key',
    describe({
      summary: 'Hand off a website checkout',
      description: 'Server to server. Body `{ payload, timestamp, signature }`: `payload` is the JSON text of `{ orderId, status, product, amount, currency, customer: { name, phone, email, city }, student?, pageUrl?, campaign? }`, `signature` the hex HMAC-SHA256 of `"<timestamp>.<payload>"` with the form\'s signing secret. Send the `X-Phoenix-Client` header. Idempotent on `orderId`.',
      auth: 'public',
      status: 201,
      rateLimited: true,
    }),
    checkoutLimit,
    validate({ params: schemas.keyParams, body: schemas.checkoutBody }),
    async (req, res) => {
      const form = await activeForm(req.valid.params.key, 'checkout');
      if (!form.signing_secret_enc) throw errors.forbidden('This hand-off has no signing secret yet');
      const check = verifyCheckout(req.valid.body, decrypt(form.signing_secret_enc, env.encryptionKey), Math.floor(Date.now() / 1000));
      if (!check.ok) throw errors.forbidden(`Signature check failed (${check.reason})`);
      const result = await ingestEnquiry(
        {
          groupId: form.group_id,
          payload: checkoutToEnquiry(form, check.data),
          dealChannel: 'website_checkout',
          owned: { companyId: form.company_id, productLineId: form.product_line_id },
          unitId: form.unit_id,
          formId: form.id,
          audience: form.audience,
          idempotencyKey: check.data.orderId ? `checkout:${form.id}:${String(check.data.orderId).slice(0, 200)}` : undefined,
        },
        { registry: req.app.locals.registry },
      ).catch((error) => {
        if (error instanceof EnquiryInvalidError) throw errors.validation(error.issues.map((i) => ({ path: `payload.${i.path}`, message: i.message })));
        throw error;
      });
      await db('intake_forms').where({ id: form.id }).update({ submission_count: db.raw('submission_count + 1'), last_submission_at: db.fn.now() });
      res.status(result.replayed ? 200 : 201).json({ data: { enquiryId: result.enquiryId, status: result.status, outcome: result.outcome, replayed: result.replayed } });
    },
  );

  // ---------------- Status and vocabularies ----------------

  router.get('/intake/status', describe({ summary: 'Show which intake ports are connected', permission: 'intake.view' }), requireAuth(), async (req, res) => {
    const index = await unitsIndex(req);
    if (![...index.values()].some((u) => u.depth === 0 && req.access.canAnywhereWithin('intake.view', u.path))) throw errors.forbidden();
    res.json({ data: { ports: portStatus(), importFields: IMPORT_FIELDS } });
  });

  // ---------------- Enquiries ----------------

  router.get(
    '/intake/enquiries',
    describe({ summary: 'List enquiries', permission: 'intake.view', list: true }),
    requireAuth(),
    validate({ query: schemas.enquiryListQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const scope = await listScope(req, 'intake.view', { unitId: q.unitId });
      const index = await unitsIndex(req);
      const groupWide = !scope.company && scope.allUnitIds.includes(scope.groupId);
      const query = db('intake_enquiries as e').where('e.group_id', scope.groupId);
      query.where((w) => {
        w.where((routed) => applyListScope(routed.whereNotNull('e.company_id'), scope, { unitColumn: 'e.unit_id', ownerColumns: [], companyColumn: 'e.company_id', groupColumn: null }));
        if (groupWide) w.orWhereNull('e.company_id');
      });
      if (q.status) query.where('e.status', q.status);
      if (q.channel) query.where('e.deal_channel', q.channel);
      const cursor = decodeCursor(q.cursor);
      if (cursor) query.whereRaw('(e.received_at, e.id) < (?, ?)', [cursor.v, cursor.id]);
      const rows = await query.orderBy([{ column: 'e.received_at', order: 'desc' }, { column: 'e.id', order: 'desc' }]).limit(q.limit + 1).select('e.*');
      const { page, nextCursor } = pageOf(rows, q.limit, (r) => ({ v: new Date(r.received_at).toISOString(), id: r.id }));
      const dealIds = page.map((r) => r.deal_id).filter(Boolean);
      const deals = new Map(dealIds.length ? (await db('deals').whereIn('id', dealIds).select('id', 'ref')).map((d) => [d.id, d.ref]) : []);
      const companies = companyNames(index);
      res.json({
        data: page.map((r) => presentEnquiry(r, { canViewPii: canViewPiiAt(req.access, index, [r.unit_id ?? r.group_id]), companyName: companies.get(r.company_id)?.name ?? null, dealRef: deals.get(r.deal_id) ?? null })),
        nextCursor,
      });
    },
  );

  async function visibleEnquiry(req, id, trx = db) {
    const row = await trx('intake_enquiries').where({ id }).first();
    if (!row) throw errors.notFound('Enquiry');
    const index = await unitsIndex(req, trx);
    const unit = index.get(row.unit_id ?? row.company_id ?? row.group_id);
    if (!unit || !req.access.can('intake.view', unit.path)) throw errors.notFound('Enquiry');
    return { row, index, unit };
  }

  router.get('/intake/enquiries/:id', describe({ summary: 'Get an enquiry with its routing, dedup and assignment decisions', permission: 'intake.view' }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    const { row, index, unit } = await visibleEnquiry(req, req.valid.params.id);
    const deal = row.deal_id ? await db('deals').where({ id: row.deal_id }).first('ref') : null;
    res.json({ data: presentEnquiry(row, { canViewPii: canViewPiiAt(req.access, index, [unit.id]), companyName: companyNames(index).get(row.company_id)?.name ?? null, dealRef: deal?.ref ?? null, detail: true }) });
  });

  router.post('/intake/enquiries/:id/retry', describe({ summary: 'Process a failed enquiry again', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    const { row, unit } = await visibleEnquiry(req, req.valid.params.id);
    if (!req.access.can('intake.manage', unit.path)) throw errors.forbidden();
    if (row.status !== 'failed') throw errors.conflict('Only failed enquiries can be retried');
    const options = row.ingest_options ?? {};
    const result = await ingestEnquiry(
      { ...options, groupId: row.group_id, payload: { ...row.enquiry, raw: row.raw }, idempotencyKey: row.idempotency_key.replace(/:failed:\d+$/, '') },
      { registry: req.app.locals.registry, actorUserId: req.auth.user.id, recordFailures: false },
    );
    await db.transaction(async (trx) => {
      await trx('intake_enquiries').where({ id: row.id }).update({ status: 'discarded', failure: `${row.failure ?? ''} (retried as ${result.enquiryId})`.slice(0, 500), updated_at: trx.fn.now() });
      await writeAudit(trx, req, { action: 'intake.enquiry_retried', entityType: 'intake_enquiry', entityId: row.id, unit: { id: unit.id, root_id: row.group_id }, after: { retriedAs: result.enquiryId } });
    });
    res.json({ data: result });
  });

  router.post(
    '/intake/enquiries',
    describe({ summary: 'Add an enquiry by hand through intake (de-duplication, reopen, assignment)', permission: 'deals.manage', status: 201 }),
    requireAuth(),
    validate({ body: schemas.manualEnquiryBody }),
    async (req, res) => {
      const b = req.valid.body;
      const { unit, company, level } = await requireCreateUnit(req, b.unitId, 'deals.manage');
      if (!isKnownChannel(req.app.locals.registry, b.channel)) throw errors.validation([{ path: 'body.channel', message: 'Unknown channel' }]);
      if (b.assign === 'auto' && level !== 'all' && !req.access.can('deals.assign', unit.path)) throw errors.forbidden('Automatic assignment needs the assign permission here');
      const result = await ingestEnquiry(
        {
          groupId: unit.root_id,
          payload: {
            audience: b.audience,
            source: { channel: { type: 'other', identity: req.auth.user.id }, campaign: b.campaign, capturedById: req.auth.user.id },
            contact: b.contact,
            ...(b.student ? { student: b.student } : {}),
            ...(b.institute ? { institute: b.institute } : {}),
            interest: { message: b.message, ...(b.productLineId ? { productLineId: b.productLineId } : {}) },
          },
          dealChannel: b.channel,
          owned: { companyId: company.id, productLineId: b.productLineId ?? null },
          unitId: unit.id,
          audience: b.audience,
          ...(b.assign === 'me' ? { ownerUserId: req.auth.user.id } : {}),
        },
        { registry: req.app.locals.registry, req, actorUserId: req.auth.user.id, recordFailures: false },
      ).catch((error) => {
        if (error instanceof EnquiryInvalidError) throw errors.validation(error.issues.map((i) => ({ path: `body.${i.path}`, message: i.message })));
        throw error;
      });
      res.status(result.outcome === 'created' ? 201 : 200).json({ data: result });
    },
  );

  // ---------------- Review queue ----------------

  router.get('/intake/review/counts', describe({ summary: 'Count open review items by kind', permission: 'intake.review' }), requireAuth(), validate({ query: schemas.scopeQuery }), async (req, res) => {
    res.json({ data: await reviewCounts(req, req.valid.query.unitId) });
  });

  router.get('/intake/review', describe({ summary: 'List the review queue', permission: 'intake.review', list: true }), requireAuth(), validate({ query: schemas.reviewListQuery }), async (req, res) => {
    const { page, nextCursor, index } = await listReviewItems(req, req.valid.query);
    const contactIds = [...new Set(page.flatMap((r) => [r.contact_id, r.candidate_contact_id]).filter(Boolean))];
    const dealIds = [...new Set(page.map((r) => r.deal_id).filter(Boolean))];
    const [contacts, deals] = await Promise.all([
      contactIds.length ? db('contacts').whereIn('id', contactIds).select('id', 'display_name', 'kind', 'city', 'primary_phone', 'primary_email', 'merged_into_id') : [],
      dealIds.length ? db('deals').whereIn('id', dealIds).select('id', 'ref', 'title', 'status') : [],
    ]);
    const maps = { companies: companyNames(index), contacts: new Map(contacts.map((c) => [c.id, c])), deals: new Map(deals.map((d) => [d.id, d])) };
    const piiAt = (r) => (r.company_id ? [r.unit_id ?? r.company_id] : [r.group_id, ...(r.candidate_company_ids ?? [])]);
    res.json({ data: page.map((r) => presentReviewItem(r, { ...maps, canViewPii: canViewPiiAt(req.access, index, piiAt(r)) })), nextCursor });
  });

  router.post('/intake/review/:id/resolve', describe({ summary: 'Approve, override or dismiss a review item', permission: 'intake.review' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.resolveBody }), async (req, res) => {
    const { item, result } = await resolveReviewItem(req, req.valid.params.id, req.valid.body);
    res.json({ data: { id: item.id, status: item.status, resolution: item.resolution, result } });
  });

  // ---------------- CSV imports ----------------

  router.get('/intake/imports/fields', describe({ summary: 'List the fields a CSV column can fill' }), requireAuth(), (_req, res) => {
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ data: ENQUIRY_FIELDS.map(({ field, label }) => ({ field, label })) });
  });

  router.get('/intake/imports', describe({ summary: 'List CSV imports', permission: 'intake.import', list: true }), requireAuth(), validate({ query: schemas.enquiryListQuery.pick({ unitId: true, cursor: true, limit: true }) }), async (req, res) => {
    const q = req.valid.query;
    const scope = await listScope(req, 'intake.import', { unitId: q.unitId });
    const query = applyListScope(db('intake_import_jobs as j'), scope, { unitColumn: 'j.unit_id', ownerColumns: [], companyColumn: 'j.company_id', groupColumn: 'j.group_id' });
    const cursor = decodeCursor(q.cursor);
    if (cursor) query.whereRaw('(j.created_at, j.id) < (?, ?)', [cursor.v, cursor.id]);
    const rows = await query.orderBy([{ column: 'j.created_at', order: 'desc' }, { column: 'j.id', order: 'desc' }]).limit(q.limit + 1).select('j.*');
    const { page, nextCursor } = pageOf(rows, q.limit, (r) => ({ v: new Date(r.created_at).toISOString(), id: r.id }));
    const index = await unitsIndex(req);
    res.json({ data: page.map((job) => presentImportJob(job, { masked: importMasked(req, index, job) })), nextCursor });
  });

  router.post(
    '/intake/imports',
    describe({ summary: 'Upload a CSV file to import', description: 'Send the file as the request body with `Content-Type: text/csv` (at most 5 MB); `unitId` and `fileName` in the query. Returns the headers, a sample and suggested mapping.', permission: 'intake.import', status: 201 }),
    requireAuth(),
    express.text({ type: ['text/csv', 'text/plain', 'application/csv', 'text/tab-separated-values'], limit: MAX_IMPORT_BYTES }),
    validate({ query: schemas.importUploadQuery }),
    async (req, res) => {
      const q = req.valid.query;
      const target = await requireCreateUnit(req, q.unitId, 'intake.import', { path: 'query.unitId' });
      if (typeof req.body !== 'string' || !req.body.trim()) throw errors.validation([{ path: 'body', message: 'Upload a CSV file (Content-Type: text/csv)' }]);
      const text = req.body.replace(/^﻿/, '');
      const info = inspectCsv(text);
      const row = await db.transaction(async (trx) => {
        const ref = await port('files').put(trx, { groupId: target.unit.root_id, name: q.fileName, contentType: 'text/csv', body: text, createdBy: req.auth.user.id });
        const [job] = await trx('intake_import_jobs')
          .insert({
            group_id: target.unit.root_id,
            company_id: target.company.id,
            unit_id: target.unit.id,
            file_ref: ref,
            file_name: q.fileName,
            file_size: Buffer.byteLength(text),
            delimiter: info.delimiter,
            headers: JSON.stringify(info.headers),
            sample: JSON.stringify(info.sample),
            suggestions: JSON.stringify(info.suggestions),
            mapping: JSON.stringify(info.mapping),
            total_rows: info.totalRows,
            created_by: req.auth.user.id,
          })
          .returning('*');
        await writeAudit(trx, req, { action: 'intake.import_uploaded', entityType: 'intake_import', entityId: job.id, unit: { id: job.unit_id, root_id: job.group_id }, after: { fileName: job.file_name, size: job.file_size } });
        return job;
      });
      res.status(201).json({ data: presentImportJob(row) });
    },
  );

  /**
   * Imports hold the raw rows of the file. Someone without contacts.view_pii there sees phones and
   * emails masked, except in files they uploaded themselves.
   */
  function importMasked(req, index, job) {
    return job.created_by !== req.auth.user.id && !canViewPiiAt(req.access, index, [job.unit_id]);
  }
  const presentImportFor = async (req, job) => presentImportJob(job, { masked: importMasked(req, await unitsIndex(req), job) });

  async function visibleImport(req, id, trx = db) {
    const job = await trx('intake_import_jobs').where({ id }).first();
    if (!job) throw errors.notFound('Import');
    const index = await unitsIndex(req, trx);
    const unit = index.get(job.unit_id);
    if (!unit || !req.access.can('intake.import', unit.path)) throw errors.notFound('Import');
    return job;
  }

  router.get('/intake/imports/:id', describe({ summary: 'Get a CSV import and its progress', permission: 'intake.import' }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    res.json({ data: await presentImportFor(req, await visibleImport(req, req.valid.params.id)) });
  });

  router.get('/intake/imports/:id/rows', describe({ summary: 'List the per-row results of an import', permission: 'intake.import', list: true }), requireAuth(), validate({ params: schemas.idParams, query: schemas.importRowsQuery }), async (req, res) => {
    const job = await visibleImport(req, req.valid.params.id);
    const q = req.valid.query;
    const query = db('intake_import_rows').where({ job_id: job.id });
    if (q.status) query.where('status', q.status);
    if (q.cursor !== undefined) query.where('row', '>', q.cursor);
    const rows = await query.orderBy('row').limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const dealIds = page.map((r) => r.deal_id).filter(Boolean);
    const deals = new Map(dealIds.length ? (await db('deals').whereIn('id', dealIds).select('id', 'ref')).map((d) => [d.id, d]) : []);
    const masked = importMasked(req, await unitsIndex(req), job);
    res.json({ data: page.map((r) => presentImportRow(r, deals, { masked })), nextCursor: hasMore ? String(page[page.length - 1].row) : null });
  });

  router.post('/intake/imports/:id/start', describe({ summary: 'Map the columns and start the import', permission: 'intake.import' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.importStartBody }), async (req, res) => {
    const row = await db.transaction(async (trx) => {
      const job = await visibleImport(req, req.valid.params.id, trx);
      const locked = await trx('intake_import_jobs').where({ id: job.id }).forUpdate().first();
      if (locked.status !== 'uploaded') throw errors.conflict('This import has already started');
      const { mapping, issues } = checkMapping(req.valid.body.mapping, locked.headers);
      if (issues.length) throw errors.validation(issues);
      const defaults = req.valid.body.defaults;
      if (defaults.productLineId) {
        const line = await trx('product_lines').where({ id: defaults.productLineId, company_id: locked.company_id, active: true }).first('id');
        if (!line) throw errors.validation([{ path: 'body.defaults.productLineId', message: 'Pick an active product line of this company' }]);
      }
      return startImport(trx, req, locked, { mapping, defaults });
    });
    res.json({ data: await presentImportFor(req, row) });
  });

  router.post('/intake/imports/:id/cancel', describe({ summary: 'Cancel an import that has not started', permission: 'intake.import' }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    const job = await visibleImport(req, req.valid.params.id);
    const updated = one(await db('intake_import_jobs').where({ id: job.id }).whereIn('status', ['uploaded', 'queued']).update({ status: 'cancelled', finished_at: db.fn.now(), updated_at: db.fn.now() }).returning('*'));
    if (!updated) throw errors.conflict('This import is already running or finished');
    res.json({ data: await presentImportFor(req, updated) });
  });

  router.get('/intake/imports/:id/error-report', describe({ summary: 'Download the error report of an import (CSV)', permission: 'intake.import', responses: { 200: { description: 'CSV file', raw: true } } }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    const job = await visibleImport(req, req.valid.params.id);
    if (!job.error_report_ref) throw errors.notFound('Error report');
    const file = await port('files').get(db, job.error_report_ref);
    if (!file) throw errors.notFound('Error report');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="import-${job.id}-errors.csv"`);
    res.send(importMasked(req, await unitsIndex(req), job) ? maskPiiText(String(file.body)) : file.body);
  });

  // ---------------- Forms ----------------

  router.get('/intake/forms', describe({ summary: 'List website forms', permission: 'intake.view' }), requireAuth(), validate({ query: schemas.configQuery }), async (req, res) => {
    const q = req.valid.query;
    const companies = q.companyId ? [await requireCompany(req, q.companyId, 'intake.view', { path: 'query.companyId' })] : await companiesInScope(req, q.unitId, 'intake.view');
    const rows = companies.length ? await db('intake_forms').whereIn('company_id', companies.map((c) => c.id)).orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(1000) : [];
    res.json({ data: rows.map((r) => presentForm(r, { webOrigin: webOrigin(), snippet: embedSnippet(r, { webOrigin: webOrigin() }) })) });
  });

  async function visibleForm(req, id) {
    const row = await db('intake_forms').where({ id }).first();
    if (!row) throw errors.notFound('Form');
    await requireCompany(req, row.company_id, 'intake.view').catch(notFoundAs('Form'));
    return row;
  }

  router.get('/intake/forms/:id', describe({ summary: 'Get a website form with its embed snippet', permission: 'intake.view' }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    const row = await visibleForm(req, req.valid.params.id);
    res.json({ data: presentForm(row, { webOrigin: webOrigin(), snippet: embedSnippet(row, { webOrigin: webOrigin() }) }) });
  });

  router.post('/intake/forms', describe({ summary: 'Create a website form', permission: 'intake.manage', status: 201 }), requireAuth(), validate({ body: schemas.formCreateBody }), async (req, res) => {
    const { row, secret } = await config.createForm(req, req.valid.body);
    res.status(201).json({ data: { ...presentForm(row, { webOrigin: webOrigin(), snippet: embedSnippet(row, { webOrigin: webOrigin() }) }), ...(secret ? { signingSecret: secret } : {}) } });
  });

  router.patch('/intake/forms/:id', describe({ summary: 'Edit a website form', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.formPatchBody }), async (req, res) => {
    const row = await config.updateForm(req, req.valid.params.id, req.valid.body);
    res.json({ data: presentForm(row, { webOrigin: webOrigin(), snippet: embedSnippet(row, { webOrigin: webOrigin() }) }) });
  });

  router.post('/intake/forms/:id/secret', describe({ summary: 'Create a new signing secret for a checkout hand-off (shown once)', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    const { row, secret } = await config.rotateFormSecret(req, req.valid.params.id);
    res.json({ data: { ...presentForm(row, { webOrigin: webOrigin() }), signingSecret: secret } });
  });

  // ---------------- Routing: channel identities ----------------

  router.get('/intake/identities', describe({ summary: 'List channel identities (routing)', permission: 'intake.view' }), requireAuth(), validate({ query: schemas.configQuery }), async (req, res) => {
    const q = req.valid.query;
    const companies = q.companyId ? [await requireCompany(req, q.companyId, 'intake.view', { path: 'query.companyId' })] : await companiesInScope(req, q.unitId, 'intake.view');
    const ids = companies.map((c) => c.id);
    const rows = ids.length
      ? await db('intake_channel_identities').where((w) => w.whereIn('company_id', ids).orWhereRaw('company_ids && ?::uuid[]', [ids])).orderBy([{ column: 'type' }, { column: 'identity_normalized' }]).limit(1000)
      : [];
    res.json({ data: rows.map(presentIdentity) });
  });

  router.post('/intake/identities', describe({ summary: 'Register a channel identity', permission: 'intake.manage', status: 201 }), requireAuth(), validate({ body: schemas.identityBody }), async (req, res) => {
    res.status(201).json({ data: presentIdentity(await config.createIdentity(req, req.valid.body)) });
  });

  router.patch('/intake/identities/:id', describe({ summary: 'Edit a channel identity', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.identityPatchBody }), async (req, res) => {
    res.json({ data: presentIdentity(await config.updateIdentity(req, req.valid.params.id, req.valid.body)) });
  });

  router.delete('/intake/identities/:id', describe({ summary: 'Remove a channel identity', permission: 'intake.manage', status: 204 }), requireAuth(), validate({ params: schemas.idParams }), async (req, res) => {
    await config.deleteIdentity(req, req.valid.params.id);
    res.status(204).end();
  });

  // ---------------- Routing: assignment pools ----------------

  async function poolsWithMembers(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [members, states] = await Promise.all([
      db('intake_pool_members as m').join('users as u', 'u.id', 'm.user_id').whereIn('m.pool_id', ids).select('m.*', 'u.name').orderBy('u.name'),
      db('intake_assignment_state').whereIn('pool_id', ids),
    ]);
    const userIds = [...new Set(members.map((m) => m.user_id))];
    const companyIds = [...new Set(rows.map((r) => r.company_id))];
    const counts = userIds.length
      ? await db('deals').whereIn('company_id', companyIds).where({ status: 'open' }).whereNull('archived_at').whereIn('owner_user_id', userIds).groupBy('company_id', 'owner_user_id').select('company_id', 'owner_user_id').count({ count: '*' })
      : [];
    const open = new Map(counts.map((c) => [`${c.company_id}:${c.owner_user_id}`, Number(c.count)]));
    const stateOf = new Map(states.map((s) => [s.pool_id, s.state]));
    return rows.map((r) =>
      presentPool(
        r,
        members.filter((m) => m.pool_id === r.id).map((m) => ({ ...m, open_leads: open.get(`${r.company_id}:${m.user_id}`) ?? 0, assigned: stateOf.get(r.id)?.owners?.[m.user_id]?.assigned ?? 0 })),
      ),
    );
  }

  router.get('/intake/pools', describe({ summary: 'List assignment pools with their members and loads', permission: 'intake.view' }), requireAuth(), validate({ query: schemas.configQuery }), async (req, res) => {
    const q = req.valid.query;
    const companies = q.companyId ? [await requireCompany(req, q.companyId, 'intake.view', { path: 'query.companyId' })] : await companiesInScope(req, q.unitId, 'intake.view');
    const rows = companies.length ? await db('intake_assignment_pools').whereIn('company_id', companies.map((c) => c.id)).orderBy([{ column: 'company_id' }, { column: 'position' }, { column: 'name' }]).limit(1000) : [];
    res.json({ data: await poolsWithMembers(rows) });
  });

  router.post('/intake/pools', describe({ summary: 'Create an assignment pool', permission: 'intake.manage', status: 201 }), requireAuth(), validate({ body: schemas.poolCreateBody }), async (req, res) => {
    const row = await config.createPool(req, req.valid.body);
    res.status(201).json({ data: (await poolsWithMembers([row]))[0] });
  });

  router.patch('/intake/pools/:id', describe({ summary: 'Edit an assignment pool', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.poolPatchBody }), async (req, res) => {
    const row = await config.updatePool(req, req.valid.params.id, req.valid.body);
    res.json({ data: (await poolsWithMembers([row]))[0] });
  });

  router.put('/intake/pools/:id/members', describe({ summary: 'Set the members of an assignment pool', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.poolMembersBody }), async (req, res) => {
    const row = await config.replacePoolMembers(req, req.valid.params.id, req.valid.body.members);
    res.json({ data: (await poolsWithMembers([row]))[0] });
  });

  // ---------------- Partner referral links ----------------

  async function presentLinks(rows) {
    const formIds = [...new Set(rows.map((r) => r.form_id).filter(Boolean))];
    const companyIds = [...new Set(rows.map((r) => r.company_id))];
    const forms = formIds.length || companyIds.length
      ? await db('intake_forms').where({ kind: 'enquiry', active: true }).where((w) => w.whereIn('id', formIds).orWhereIn('company_id', companyIds)).orderBy('created_at').select('id', 'key', 'company_id')
      : [];
    return rows.map((r) => presentPartnerLink(r, { webOrigin: webOrigin(), formKey: (forms.find((f) => f.id === r.form_id) ?? forms.find((f) => f.company_id === r.company_id))?.key }));
  }

  router.get('/intake/partner-links', describe({ summary: 'List partner referral links', permission: 'intake.view' }), requireAuth(), validate({ query: schemas.configQuery }), async (req, res) => {
    const q = req.valid.query;
    const companies = q.companyId ? [await requireCompany(req, q.companyId, 'intake.view', { path: 'query.companyId' })] : await companiesInScope(req, q.unitId, 'intake.view');
    const rows = companies.length ? await db('intake_partner_links').whereIn('company_id', companies.map((c) => c.id)).orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(1000) : [];
    res.json({ data: await presentLinks(rows) });
  });

  router.post('/intake/partner-links', describe({ summary: 'Create a partner referral link', permission: 'intake.manage', status: 201 }), requireAuth(), validate({ body: schemas.partnerLinkBody }), async (req, res) => {
    const row = await config.createPartnerLink(req, req.valid.body);
    res.status(201).json({ data: (await presentLinks([row]))[0] });
  });

  router.patch('/intake/partner-links/:id', describe({ summary: 'Edit a partner referral link', permission: 'intake.manage' }), requireAuth(), validate({ params: schemas.idParams, body: schemas.partnerLinkPatchBody }), async (req, res) => {
    const row = await config.updatePartnerLink(req, req.valid.params.id, req.valid.body);
    res.json({ data: (await presentLinks([row]))[0] });
  });
}
