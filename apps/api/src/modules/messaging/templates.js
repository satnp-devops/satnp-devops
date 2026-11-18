import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { companiesInScope, requireCompany } from '../../core/crm/scope.js';
import { companyMessagingConnections, pickConnection, templateVariables, validateTemplate } from '../../core/messaging/index.js';
import { presentTemplate, presentContent } from './present.js';

// Message templates per company (docs/platform/MESSAGING.md, "Templates"). A template is its
// identity (channel, name, language, category) plus numbered versions. Editing a draft changes it
// in place; editing an approved or rejected template starts a new draft version while the approved
// one keeps sending. Submitting asks for approval: email templates and templates on a mock
// connection are approved at once; on a real WhatsApp or SMS provider the version waits for the
// provider's template.status webhook.

export const VIEW = 'messaging.templates_view';
export const MANAGE = 'messaging.templates_manage';

const CONTENT_COLUMNS = {
  header: 'header',
  subject: 'subject',
  body: 'body',
  footer: 'footer',
  buttons: 'buttons',
  samples: 'samples',
  providerTemplateName: 'provider_template_name',
  providerTemplateId: 'provider_template_id',
};
const JSON_COLUMNS = new Set(['header', 'buttons', 'samples']);

export function templateQuery(trx = db) {
  return trx('message_templates as t')
    .leftJoin('message_template_versions as v', function joinLatest() {
      this.on('v.template_id', 't.id').andOn('v.version', 't.latest_version');
    })
    .leftJoin('message_template_versions as a', function joinLive() {
      this.on('a.template_id', 't.id').andOn('a.version', 't.approved_version');
    })
    .select('t.*', trx.raw('row_to_json(v) as latest'), trx.raw('row_to_json(a) as live'));
}

const contentOf = (version) => ({
  header: version.header ?? null,
  subject: version.subject ?? null,
  body: version.body,
  footer: version.footer ?? null,
  buttons: version.buttons ?? [],
  samples: version.samples ?? {},
  providerTemplateName: version.provider_template_name ?? null,
  providerTemplateId: version.provider_template_id ?? null,
});

/** Content fields as version columns. Empty strings become null; unknown sample keys are dropped. */
function versionColumns(content, variables) {
  const out = {};
  for (const [field, column] of Object.entries(CONTENT_COLUMNS)) {
    if (!(field in content)) continue;
    let value = content[field];
    if (typeof value === 'string' && !value.trim()) value = null;
    if (field === 'samples') value = Object.fromEntries(Object.entries(value ?? {}).filter(([key, sample]) => variables.includes(key) && sample !== ''));
    if (field === 'buttons') value = value ?? [];
    out[column] = JSON_COLUMNS.has(column) ? json(value) : value;
  }
  return out;
}

function checkContent(template, content, { requireSamples = false } = {}) {
  const issues = validateTemplate({ channel: template.channel, ...content }, { requireSamples, path: 'body' });
  if (issues.length) throw errors.validation(issues);
}

const unitOf = (company) => ({ id: company.id, root_id: company.root_id });

async function loadForWrite(req, trx, id) {
  const template = await trx('message_templates').where({ id }).forUpdate().first();
  if (!template) throw errors.notFound('Template');
  const company = await requireCompany(req, template.company_id, VIEW, { trx });
  if (!req.access.can(MANAGE, company.path)) throw errors.forbidden();
  if (template.archived_at) throw errors.conflict('This template is archived');
  const latest = await trx('message_template_versions').where({ template_id: id, version: template.latest_version }).first();
  return { template, company, latest };
}

async function presentById(req, id, trx = db) {
  const row = await templateQuery(trx).where('t.id', id).first();
  const company = await requireCompany(req, row.company_id, VIEW, { trx });
  return presentTemplate(row, { canManage: req.access.can(MANAGE, company.path) });
}

/** GET /messaging/templates: every template of the companies in scope (config list, capped at 1000). */
export async function listTemplates(req, { unitId, companyId, channel, status, includeArchived }) {
  const companies = companyId ? [await requireCompany(req, companyId, VIEW)] : await companiesInScope(req, unitId, VIEW);
  if (companies.length === 0) {
    if (unitId) throw errors.forbidden();
    return [];
  }
  const query = templateQuery()
    .whereIn(
      't.company_id',
      companies.map((c) => c.id),
    )
    .orderBy([{ column: 't.channel' }, { column: 't.name' }, { column: 't.language' }, { column: 't.id' }])
    .limit(1000);
  if (channel) query.where('t.channel', channel);
  if (status) query.where('t.status', status);
  if (!includeArchived) query.whereNull('t.archived_at');
  const rows = await query;
  const manage = new Map(companies.map((c) => [c.id, req.access.can(MANAGE, c.path)]));
  return rows.map((row) => presentTemplate(row, { canManage: manage.get(row.company_id) === true }));
}

/** GET /messaging/templates/:id with every version, newest first. */
export async function getTemplate(req, id) {
  const row = await templateQuery().where('t.id', id).first();
  if (!row) throw errors.notFound('Template');
  const company = await requireCompany(req, row.company_id, VIEW);
  const versions = await db('message_template_versions').where({ template_id: id }).orderBy('version', 'desc').limit(50);
  return {
    ...presentTemplate(row, { canManage: req.access.can(MANAGE, company.path) }),
    versions: versions.map(presentContent),
  };
}

export async function createTemplate(req, body) {
  const company = await requireCompany(req, body.companyId, MANAGE, { write: true, path: 'body.companyId' });
  const content = {
    header: body.header ?? null,
    subject: body.subject ?? null,
    body: body.body,
    footer: body.footer ?? null,
    buttons: body.buttons ?? [],
    samples: body.samples ?? {},
    providerTemplateName: body.providerTemplateName ?? null,
    providerTemplateId: body.providerTemplateId ?? null,
  };
  const issues = validateTemplate({ channel: body.channel, name: body.name, language: body.language, ...content }, { path: 'body' });
  if (issues.length) throw errors.validation(issues);
  const variables = templateVariables({ channel: body.channel, ...content });

  const id = await db.transaction(async (trx) => {
    const clash = await trx('message_templates')
      .where({ company_id: company.id, channel: body.channel, name: body.name, language: body.language })
      .whereNull('archived_at')
      .first('id');
    if (clash) throw errors.conflict('This company already has a template with that name and language', { field: 'name' });
    const [template] = await trx('message_templates')
      .insert({
        group_id: company.root_id,
        company_id: company.id,
        channel: body.channel,
        name: body.name,
        language: body.language,
        category: body.category,
        description: body.description ?? null,
        latest_version: 1,
        status: 'draft',
        created_by: req.auth.user.id,
        updated_by: req.auth.user.id,
      })
      .returning('*');
    await trx('message_template_versions').insert({
      template_id: template.id,
      version: 1,
      status: 'draft',
      ...versionColumns(content, variables),
      created_by: req.auth.user.id,
    });
    await writeAudit(trx, req, {
      action: 'message_template.created',
      entityType: 'message_template',
      entityId: template.id,
      unit: unitOf(company),
      after: { channel: template.channel, name: template.name, language: template.language, category: template.category },
    });
    await emitEvent(trx, {
      type: 'message_template.created',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'message_template',
      aggregateId: template.id,
      actorUserId: req.auth.user.id,
      payload: { templateId: template.id, companyId: company.id, channel: template.channel, name: template.name, language: template.language, category: template.category },
    });
    return template.id;
  });
  return presentById(req, id);
}

export async function updateTemplate(req, id, body) {
  await db.transaction(async (trx) => {
    const { template, company, latest } = await loadForWrite(req, trx, id);
    if (latest.status === 'submitted') throw errors.conflict('Waiting for approval: you can edit it once the provider decides');
    if (body.category && body.category !== template.category && template.approved_version) {
      throw errors.conflict('An approved template keeps its category: create a new template for another category', { field: 'category' });
    }
    const changes = Object.keys(body);
    const content = { ...contentOf(latest), ...Object.fromEntries(Object.entries(body).filter(([key]) => key in CONTENT_COLUMNS)) };
    checkContent(template, content);
    const variables = templateVariables({ channel: template.channel, ...content });

    let version = latest.version;
    const contentChanged = changes.some((key) => key in CONTENT_COLUMNS);
    if (contentChanged) {
      if (latest.status === 'draft') {
        await trx('message_template_versions')
          .where({ id: latest.id })
          .update({ ...versionColumns(content, variables), updated_at: trx.fn.now() });
      } else {
        version = latest.version + 1;
        await trx('message_template_versions').insert({
          template_id: template.id,
          version,
          status: 'draft',
          ...versionColumns(content, variables),
          created_by: req.auth.user.id,
        });
      }
    }
    await trx('message_templates')
      .where({ id })
      .update({
        ...(body.category ? { category: body.category } : {}),
        ...('description' in body ? { description: body.description ?? null } : {}),
        latest_version: version,
        status: contentChanged ? 'draft' : template.status,
        updated_by: req.auth.user.id,
        updated_at: trx.fn.now(),
      });
    await writeAudit(trx, req, {
      action: 'message_template.updated',
      entityType: 'message_template',
      entityId: id,
      unit: unitOf(company),
      meta: { changed: changes, version },
    });
    await emitEvent(trx, {
      type: 'message_template.updated',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'message_template',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { templateId: id, companyId: company.id, version, changes },
    });
  });
  return presentById(req, id);
}

/** Who approves a submitted version: email templates and mock connections approve at once. */
async function approvalRoute(template, company, trx) {
  if (template.channel === 'email') return { autoApprove: true, via: 'email' };
  const candidates = await companyMessagingConnections(company.id, trx);
  const chosen = pickConnection({ candidates, channel: template.channel, companyName: company.name });
  if (chosen.fallback || chosen.connection?.mock) return { autoApprove: true, via: 'mock' };
  return { autoApprove: false, via: chosen.connection?.provider ?? null };
}

export async function submitTemplate(req, id) {
  await db.transaction(async (trx) => {
    const { template, company, latest } = await loadForWrite(req, trx, id);
    if (latest.status === 'approved') throw errors.conflict('This version is already approved');
    if (latest.status === 'submitted') throw errors.conflict('This version is already waiting for approval');
    if (latest.status === 'rejected') throw errors.conflict('Edit the template before submitting it again');
    checkContent(template, contentOf(latest), { requireSamples: true });
    const route = await approvalRoute(template, company, trx);
    const status = route.autoApprove ? 'approved' : 'submitted';
    await trx('message_template_versions')
      .where({ id: latest.id })
      .update({
        status,
        submitted_at: trx.fn.now(),
        submitted_by: req.auth.user.id,
        decided_at: route.autoApprove ? trx.fn.now() : null,
        updated_at: trx.fn.now(),
      });
    await trx('message_templates')
      .where({ id })
      .update({
        status,
        ...(route.autoApprove ? { approved_version: latest.version } : {}),
        updated_by: req.auth.user.id,
        updated_at: trx.fn.now(),
      });
    const unit = unitOf(company);
    const base = { groupId: company.root_id, unitId: company.id, aggregateType: 'message_template', aggregateId: id, actorUserId: req.auth.user.id };
    await writeAudit(trx, req, { action: 'message_template.submitted', entityType: 'message_template', entityId: id, unit, meta: { version: latest.version, via: route.via } });
    await emitEvent(trx, { ...base, type: 'message_template.submitted', payload: { templateId: id, companyId: company.id, version: latest.version } });
    if (route.autoApprove) {
      await writeAudit(trx, req, { action: 'message_template.approved', entityType: 'message_template', entityId: id, unit, meta: { version: latest.version, via: route.via } });
      await emitEvent(trx, { ...base, type: 'message_template.approved', payload: { templateId: id, companyId: company.id, version: latest.version, via: route.via } });
    }
  });
  return presentById(req, id);
}

export async function archiveTemplate(req, id) {
  await db.transaction(async (trx) => {
    const { template, company } = await loadForWrite(req, trx, id);
    await trx('message_templates').where({ id }).update({ archived_at: trx.fn.now(), updated_by: req.auth.user.id, updated_at: trx.fn.now() });
    await writeAudit(trx, req, {
      action: 'message_template.archived',
      entityType: 'message_template',
      entityId: id,
      unit: unitOf(company),
      after: { name: template.name, language: template.language },
    });
    await emitEvent(trx, {
      type: 'message_template.archived',
      groupId: company.root_id,
      unitId: company.id,
      aggregateType: 'message_template',
      aggregateId: id,
      actorUserId: req.auth.user.id,
      payload: { templateId: id, companyId: company.id },
    });
  });
}

const PROVIDER_STATUS = { approved: 'approved', rejected: 'rejected', paused: 'rejected', disabled: 'rejected' };

/**
 * A provider's decision on a template (the WhatsApp template.status webhook). Applies to the
 * templates of every company using the connection with that provider name and language. A paused
 * or disabled template stops sending (its approval is withdrawn). Idempotent.
 * @returns {Promise<number>} templates changed
 */
export async function applyProviderTemplateStatus({ connectionId, name, language, status, reason = null }) {
  const next = PROVIDER_STATUS[status];
  if (!next) return 0;
  return db.transaction(async (trx) => {
    const companyIds = await trx('integration_connection_companies').where({ connection_id: connectionId }).pluck('company_id');
    if (companyIds.length === 0) return 0;
    const rows = await trx('message_templates as t')
      .join('message_template_versions as v', function joinLatest() {
        this.on('v.template_id', 't.id').andOn('v.version', 't.latest_version');
      })
      .whereIn('t.company_id', companyIds)
      .where({ 't.channel': 'whatsapp', 't.language': language })
      .whereNull('t.archived_at')
      .where((where) => where.where('v.provider_template_name', name).orWhere((w) => w.whereNull('v.provider_template_name').where('t.name', name)))
      .forUpdate('t')
      .select('t.id', 't.group_id', 't.company_id', 't.approved_version', 'v.id as version_id', 'v.version', 'v.status as version_status');
    let changed = 0;
    for (const row of rows) {
      const pausedLive = next === 'rejected' && row.version_status === 'approved';
      if (row.version_status === next || (row.version_status !== 'submitted' && !pausedLive)) continue;
      const rejectionReason = next === 'rejected' ? (reason ?? (status === 'rejected' ? 'Rejected by the provider' : `The provider ${status} it`)) : null;
      await trx('message_template_versions')
        .where({ id: row.version_id })
        .update({ status: next, decided_at: trx.fn.now(), rejection_reason: rejectionReason, updated_at: trx.fn.now() });
      await trx('message_templates')
        .where({ id: row.id })
        .update({
          status: next,
          approved_version: next === 'approved' ? row.version : pausedLive ? null : row.approved_version,
          updated_at: trx.fn.now(),
        });
      const unit = { id: row.company_id, root_id: row.group_id };
      await writeAudit(trx, null, { action: `message_template.${next}`, entityType: 'message_template', entityId: row.id, unit, meta: { version: row.version, via: 'provider', providerStatus: status } });
      await emitEvent(trx, {
        type: `message_template.${next}`,
        groupId: row.group_id,
        unitId: row.company_id,
        aggregateType: 'message_template',
        aggregateId: row.id,
        payload: { templateId: row.id, companyId: row.company_id, version: row.version, via: 'provider', providerStatus: status },
      });
      changed += 1;
    }
    return changed;
  });
}
