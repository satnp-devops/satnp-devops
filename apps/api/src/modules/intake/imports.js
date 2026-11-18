import { db as defaultDb, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { getSetting } from '../../core/settings.js';
import { ENQUIRY_FIELDS, errorReportCsv, importCsv, parseCsv, suggestMapping } from '../../core/intake/index.js';
import { defaultCountrySetting } from '../../core/crm/settings.js';
import { settingDefinitions } from '../settings/definitions.js';
import { port } from './ports.js';
import { crmNormalizers } from './settings.js';
import { EnquiryInvalidError, ingestEnquiry } from './service.js';

// CSV imports: upload (stored through the files port, headers and a sample read for the mapping
// screen), mapping, then a background job (jobs port; processImportJob is the processor) that runs
// every row through ingestEnquiry with the same routing, dedup and assignment as live enquiries.
// Each row gets a result (created, merged, reopened, review, error, skipped) and the job keeps a
// downloadable error report.

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;
const SAMPLE_ROWS = 5;
const PROGRESS_EVERY = 25;
const timeZoneSetting = settingDefinitions.find((d) => d.key === 'locale.timeZone');

export const IMPORT_FIELDS = ENQUIRY_FIELDS.map(({ field, label }) => ({ field, label }));

/** Read the header and a few rows for the mapping screen. Throws 422 for files that can't be read. */
export function inspectCsv(text) {
  const parsed = parseCsv(text, { maxRows: SAMPLE_ROWS + 1 });
  if (parsed.errors.length) throw errors.validation(parsed.errors.slice(0, 5).map((e) => ({ path: 'body.content', message: `Line ${e.line}: ${e.message}` })));
  const [header = [], ...rows] = parsed.rows;
  if (!header.length || header.every((h) => !h.trim())) throw errors.validation([{ path: 'body.content', message: 'The file has no header row' }]);
  const headers = header.map((h, i) => h.trim() || `Column ${i + 1}`);
  const suggestion = suggestMapping(headers);
  const totalRows = Math.max(0, text.split(/\r\n|\n|\r/).filter((l) => l.trim()).length - 1);
  return { delimiter: parsed.delimiter, headers, sample: rows.slice(0, SAMPLE_ROWS), suggestions: suggestion.suggestions ?? [], mapping: suggestion.mapping ?? {}, totalRows };
}

/** Check a mapping from the client: column index → enquiry field ('' skips the column). */
export function checkMapping(mapping, headers) {
  const issues = [];
  const known = new Set(ENQUIRY_FIELDS.map((f) => f.field));
  const used = new Map();
  const clean = {};
  for (const [column, field] of Object.entries(mapping)) {
    if (!field) continue;
    const index = Number(column);
    if (!Number.isInteger(index) || index < 0 || index >= headers.length) issues.push({ path: `body.mapping.${column}`, message: 'That column is not in the file' });
    else if (!known.has(field)) issues.push({ path: `body.mapping.${column}`, message: 'Unknown field' });
    else if (used.has(field)) issues.push({ path: `body.mapping.${column}`, message: `${headers[used.get(field)]} already fills this` });
    else {
      used.set(field, index);
      clean[index] = field;
    }
  }
  if (![...used.keys()].some((f) => ['contact.phone', 'contact.altPhone', 'contact.email'].includes(f))) issues.push({ path: 'body.mapping', message: 'Map a column to Phone or Email' });
  return { mapping: clean, issues };
}

/** Background processor: run every row of a queued job. Safe to call twice (rows are idempotent). */
export async function processImportJob(jobId, { db = defaultDb, registry, log = logger } = {}) {
  const [job] = await db('intake_import_jobs')
    .where({ id: jobId })
    .whereIn('status', ['queued', 'running'])
    .update({ status: 'running', started_at: db.raw('coalesce(started_at, now())'), updated_at: db.fn.now() })
    .returning('*');
  if (!job) return { skipped: true };
  try {
    const file = await port('files').get(db, job.file_ref);
    if (!file) throw new Error('The uploaded file is no longer available');
    const company = await db('org_units').where({ id: job.company_id }).first();
    const [defaultCountry, timeZone] = await Promise.all([getSetting(company, defaultCountrySetting, db), getSetting(company, timeZoneSetting, db)]);
    const defaults = job.defaults ?? {};
    const report = importCsv(file.body, {
      mapping: job.mapping,
      defaults: {
        ...(defaults.audience ? { audience: defaults.audience } : {}),
        source: { channel: { type: 'csv_import', identity: job.id }, ...(defaults.campaign ? { campaign: defaults.campaign } : {}) },
      },
      normalizers: crmNormalizers,
      defaultCountry,
      dateOrder: defaults.dateOrder ?? 'DMY',
      timeZone,
      now: new Date(job.created_at).getTime(),
      maxRows: MAX_IMPORT_ROWS,
    });
    const fileErrors = report.fileIssues.filter((i) => i.level === 'error');
    if (!report.ok) {
      await db('intake_import_jobs').where({ id: job.id }).update({ status: 'failed', failure: fileErrors[0]?.message ?? 'The file could not be imported', file_issues: json(report.fileIssues), finished_at: db.fn.now(), updated_at: db.fn.now() });
      return { failed: true };
    }
    const done = new Set(await db('intake_import_rows').where({ job_id: job.id }).pluck('row'));
    const counts = { created: 0, merged: 0, reopened: 0, review: 0, error: 0, skipped: 0 };
    const extraErrors = [];
    // Rows rejected by the engine.
    const rejected = new Map();
    for (const e of report.errors) {
      const list = rejected.get(e.row) ?? [];
      list.push({ column: e.column ?? null, field: e.field, code: e.code, message: e.message });
      rejected.set(e.row, list);
    }
    const rejectedRows = [...rejected.entries()].filter(([row]) => !done.has(row));
    if (rejectedRows.length) {
      await db('intake_import_rows')
        .insert(rejectedRows.map(([row, issues]) => ({ job_id: job.id, row, line: null, status: 'error', issues: json(issues) })))
        .onConflict(['job_id', 'row'])
        .ignore();
    }
    let processed = 0;
    for (const item of report.enquiries) {
      processed += 1;
      if (done.has(item.row)) continue;
      const enquiry = { ...item.enquiry, audience: item.enquiry.audience ?? defaults.audience };
      if (defaults.productLineId) enquiry.interest = { ...(enquiry.interest ?? {}), productLineId: defaults.productLineId };
      let result = null;
      let status = 'error';
      let issues = (item.warnings ?? []).map((w) => ({ column: w.column ?? null, field: w.field, code: w.code, message: w.message, level: 'warning' }));
      try {
        result = await ingestEnquiry(
          {
            groupId: job.group_id,
            payload: enquiry,
            dealChannel: 'csv_import',
            owned: { companyId: job.company_id, productLineId: defaults.productLineId ?? null },
            unitId: job.unit_id,
            importJobId: job.id,
            audience: defaults.audience,
            idempotencyKey: `import:${job.id}:${item.row}`,
          },
          { db, registry, actorUserId: job.created_by },
        );
        status = result.status === 'needs_review' ? 'review' : result.outcome ?? 'skipped';
        if (result.review && status !== 'review') issues.push({ code: 'possible_duplicate', message: 'Possible duplicate: check the review queue', level: 'warning' });
      } catch (error) {
        if (!(error instanceof EnquiryInvalidError)) log.warn({ err: error, jobId: job.id, row: item.row }, 'Import row failed');
        const message = error instanceof EnquiryInvalidError ? error.issues.map((i) => i.message).join('; ') : error.expose === false ? 'Could not process the row' : error.message;
        issues = [...issues, { code: 'ingest_failed', message: String(message).slice(0, 300) }];
        extraErrors.push({ row: item.row, line: item.line, message });
      }
      counts[status] = (counts[status] ?? 0) + 1;
      await db('intake_import_rows')
        .insert({ job_id: job.id, row: item.row, line: item.line ?? null, status, enquiry_id: result?.enquiryId ?? null, contact_id: result?.contactId ?? null, deal_id: result?.dealId ?? null, issues: json(issues) })
        .onConflict(['job_id', 'row'])
        .ignore();
      if (processed % PROGRESS_EVERY === 0) await db('intake_import_jobs').where({ id: job.id }).update({ processed_rows: processed + rejected.size, updated_at: db.fn.now() });
    }
    // Totals from the stored rows, so a resumed job counts everything once.
    const totals = await db('intake_import_rows').where({ job_id: job.id }).groupBy('status').select('status').count({ count: '*' });
    const by = Object.fromEntries(totals.map((t) => [t.status, Number(t.count)]));
    const reportText = errorReportCsv({ ...report, errors: [...report.errors, ...extraErrors.map((e) => ({ row: e.row, field: '', code: 'ingest_failed', message: String(e.message) }))] });
    const reportRef = report.errors.length || report.warnings.length || extraErrors.length
      ? await port('files').put(db, { groupId: job.group_id, name: `import-${job.id}-errors.csv`, contentType: 'text/csv', body: reportText, createdBy: job.created_by })
      : null;
    await db.transaction(async (trx) => {
      await trx('intake_import_jobs').where({ id: job.id }).update({
        status: 'completed',
        total_rows: report.summary?.rows ?? report.enquiries.length + rejected.size,
        processed_rows: report.enquiries.length + rejected.size,
        created_count: by.created ?? 0,
        merged_count: by.merged ?? 0,
        reopened_count: by.reopened ?? 0,
        review_count: by.review ?? 0,
        error_count: by.error ?? 0,
        warning_count: report.warnings.length,
        file_issues: json(report.fileIssues),
        error_report_ref: reportRef,
        finished_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      await emitEvent(trx, {
        type: 'intake.import_completed',
        groupId: job.group_id,
        unitId: job.unit_id,
        aggregateType: 'intake_import',
        aggregateId: job.id,
        actorUserId: job.created_by,
        payload: { jobId: job.id, companyId: job.company_id, created: by.created ?? 0, merged: by.merged ?? 0, reopened: by.reopened ?? 0, review: by.review ?? 0, errors: by.error ?? 0 },
      });
    });
    return { completed: true, counts };
  } catch (error) {
    log.error({ err: error, jobId }, 'Import failed');
    await db('intake_import_jobs').where({ id: jobId }).update({ status: 'failed', failure: String(error.message ?? 'Import failed').slice(0, 500), finished_at: db.fn.now(), updated_at: db.fn.now() });
    return { failed: true };
  }
}

/** Queue a mapped job (status uploaded → queued) and hand it to the jobs port. */
export async function startImport(trx, req, job, { mapping, defaults }) {
  const [updated] = await trx('intake_import_jobs')
    .where({ id: job.id })
    .update({ mapping: json(mapping), defaults: json(defaults), status: 'queued', queued_at: trx.fn.now(), updated_at: trx.fn.now() })
    .returning('*');
  await port('jobs').enqueueImport(trx, { job: updated, actorUserId: req.auth.user.id });
  await writeAudit(trx, req, {
    action: 'intake.import_started',
    entityType: 'intake_import',
    entityId: job.id,
    unit: { id: job.unit_id, root_id: job.group_id },
    after: { fileName: job.file_name, totalRows: job.total_rows, fields: Object.values(mapping) },
  });
  return updated;
}
