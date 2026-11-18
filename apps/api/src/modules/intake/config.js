import { randomBytes, randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { encrypt } from '../../lib/crypto.js';
import { emitEvent } from '../../core/events.js';
import { writeAudit } from '../../core/audit.js';
import { isWithin } from '../../core/orgTree.js';
import { normalizeIdentity } from '../../core/intake/index.js';
import { requireCompany, unitsIndex, usersWithPermissionAt } from '../../core/crm/scope.js';
import { checkFormFields, defaultFields } from './forms.js';
import { crmNormalizers } from './settings.js';
import { loadAccess } from '../../core/access.js';

/** The partner's counsellor must work leads somewhere in the company. */
async function checkPartnerOwner(req, company, userId) {
  if (!userId) return;
  const user = await db('users').where({ id: userId, status: 'active' }).first('id');
  const access = user ? await loadAccess(userId, req.app.locals.registry) : null;
  if (!access?.canAnywhereWithin('deals.manage', company.path)) throw errors.validation([{ path: 'body.ownerUserId', message: 'This person cannot work leads in this company' }]);
}

// Intake configuration, per company: forms, channel identities (routing), assignment pools and
// partner referral links. Reading needs intake.view at, above or inside the company; writing needs
// intake.manage at the company itself (contract §4.1 rule 6). One transaction per write with audit
// and an event.

const audit = (trx, req, action, entityType, row, after) =>
  writeAudit(trx, req, { action, entityType, entityId: row.id, unit: { id: row.company_id ?? row.group_id, root_id: row.group_id }, after });
const event = (trx, req, type, row, payload) =>
  emitEvent(trx, { type, groupId: row.group_id, unitId: row.company_id ?? null, aggregateType: type.split('.')[0], aggregateId: row.id, actorUserId: req.auth.user.id, payload });

/** A unit inside the company (422 otherwise). */
async function unitInside(req, company, unitId, path) {
  if (!unitId) return company;
  const index = await unitsIndex(req);
  const unit = index.get(unitId);
  if (!unit || !isWithin(unit.path, company.path) || unit.status !== 'active') throw errors.validation([{ path, message: 'Pick an active team or branch of this company' }]);
  return unit;
}

async function productLineOf(trx, company, id, path, audience) {
  if (!id) return null;
  const line = await trx('product_lines').where({ id, company_id: company.id }).first();
  if (!line) throw errors.validation([{ path, message: 'Pick a product line of this company' }]);
  if (audience && line.audience !== audience) throw errors.validation([{ path, message: `That product line is for ${line.audience === 'b2b' ? 'institutes' : 'families'}` }]);
  return line;
}

const formKey = () => randomBytes(9).toString('base64url');

// ---------- Forms ----------

export async function createForm(req, body) {
  const company = await requireCompany(req, body.companyId, 'intake.manage', { write: true, path: 'body.companyId' });
  const unit = await unitInside(req, company, body.unitId, 'body.unitId');
  const fields = body.fields ?? defaultFields(body.audience);
  const issues = checkFormFields(fields, body.kind);
  if (issues.length) throw errors.validation(issues);
  return db.transaction(async (trx) => {
    await productLineOf(trx, company, body.productLineId, 'body.productLineId', body.audience);
    const secret = body.kind === 'checkout' ? randomBytes(32).toString('hex') : null;
    const [row] = await trx('intake_forms')
      .insert({
        id: randomUUID(),
        group_id: company.root_id,
        company_id: company.id,
        unit_id: unit.id,
        key: formKey(),
        name: body.name,
        kind: body.kind,
        audience: body.audience,
        product_line_id: body.productLineId ?? null,
        fields: json(fields),
        consent: json(body.consent),
        spam: json(body.spam),
        thank_you: json(body.thankYou),
        signing_secret_enc: secret ? encrypt(secret, env.encryptionKey) : null,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await audit(trx, req, 'intake.form_created', 'intake_form', row, { name: row.name, kind: row.kind, audience: row.audience });
    await event(trx, req, 'intake_form.created', row, { formId: row.id, companyId: row.company_id, kind: row.kind });
    return { row, secret };
  });
}

export async function updateForm(req, id, body) {
  return db.transaction(async (trx) => {
    const form = await trx('intake_forms').where({ id }).forUpdate().first();
    if (!form) throw errors.notFound('Form');
    const company = await requireCompany(req, form.company_id, 'intake.manage', { write: true }).catch((e) => {
      throw e.status === 404 ? errors.notFound('Form') : e;
    });
    const changes = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.audience !== undefined) changes.audience = body.audience;
    if (body.unitId !== undefined) changes.unit_id = (await unitInside(req, company, body.unitId, 'body.unitId')).id;
    if (body.productLineId !== undefined) changes.product_line_id = (await productLineOf(trx, company, body.productLineId, 'body.productLineId', body.audience ?? form.audience))?.id ?? null;
    if (body.fields !== undefined) {
      const issues = checkFormFields(body.fields, form.kind);
      if (issues.length) throw errors.validation(issues);
      changes.fields = json(body.fields);
    }
    if (body.consent !== undefined) changes.consent = json(body.consent);
    if (body.spam !== undefined) changes.spam = json(body.spam);
    if (body.thankYou !== undefined) changes.thank_you = json(body.thankYou);
    if (body.active !== undefined) changes.active = body.active;
    if (!Object.keys(changes).length) return form;
    const [row] = await trx('intake_forms').where({ id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, req, 'intake.form_updated', 'intake_form', row, { changed: Object.keys(body) });
    await event(trx, req, 'intake_form.updated', row, { formId: row.id, companyId: row.company_id, changes: Object.keys(body) });
    return row;
  });
}

/** A new signing secret for a checkout form; shown once. */
export async function rotateFormSecret(req, id) {
  return db.transaction(async (trx) => {
    const form = await trx('intake_forms').where({ id }).forUpdate().first();
    if (!form) throw errors.notFound('Form');
    await requireCompany(req, form.company_id, 'intake.manage', { write: true }).catch((e) => {
      throw e.status === 404 ? errors.notFound('Form') : e;
    });
    if (form.kind !== 'checkout') throw errors.conflict('Only checkout hand-off forms have a signing secret');
    const secret = randomBytes(32).toString('hex');
    const [row] = await trx('intake_forms').where({ id }).update({ signing_secret_enc: encrypt(secret, env.encryptionKey), updated_at: trx.fn.now() }).returning('*');
    await audit(trx, req, 'intake.form_secret_rotated', 'intake_form', row, { rotated: true });
    return { row, secret };
  });
}

// ---------- Channel identities ----------

async function checkIdentityCompanies(req, body) {
  const ids = body.shared ? [...new Set(body.companyIds)] : [body.companyId];
  const companies = [];
  for (const [i, companyId] of ids.entries()) {
    companies.push(await requireCompany(req, companyId, 'intake.manage', { write: true, path: body.shared ? `body.companyIds.${i}` : 'body.companyId' }));
  }
  const groupId = companies[0].root_id;
  if (companies.some((c) => c.root_id !== groupId)) throw errors.validation([{ path: 'body.companyIds', message: 'Companies must be in one group' }]);
  return companies;
}

export async function createIdentity(req, body) {
  const companies = await checkIdentityCompanies(req, body);
  const owner = body.shared ? null : companies[0];
  const normalized = normalizeIdentity(body.type, body.identity, crmNormalizers);
  if (!normalized) throw errors.validation([{ path: 'body.identity', message: 'That is not a valid number, inbox or address for this channel' }]);
  const unit = owner ? await unitInside(req, owner, body.unitId, 'body.unitId') : null;
  return db.transaction(async (trx) => {
    if (owner) await productLineOf(trx, owner, body.productLineId, 'body.productLineId');
    const exists = await trx('intake_channel_identities').where({ group_id: companies[0].root_id, type: body.type, identity_normalized: normalized }).first('id');
    if (exists) throw errors.conflict('This channel is already registered; edit the existing entry instead');
    const [row] = await trx('intake_channel_identities')
      .insert({
        id: randomUUID(),
        group_id: companies[0].root_id,
        type: body.type,
        identity: body.identity,
        identity_normalized: normalized,
        company_id: owner?.id ?? null,
        unit_id: owner && unit.id !== owner.id ? unit.id : null,
        product_line_id: owner ? body.productLineId ?? null : null,
        shared: body.shared,
        company_ids: body.shared ? companies.map((c) => c.id) : [],
        label: body.label ?? null,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await audit(trx, req, 'intake.identity_created', 'intake_identity', row, { type: row.type, shared: row.shared });
    await event(trx, req, 'intake_identity.created', row, { identityId: row.id, type: row.type, shared: row.shared, companyIds: row.shared ? row.company_ids : [row.company_id] });
    return row;
  });
}

/** Load an identity the user may manage (every company it serves); 404 when they can't see it. */
async function manageableIdentity(trx, req, id) {
  const row = await trx('intake_channel_identities').where({ id }).forUpdate().first();
  if (!row) throw errors.notFound('Channel');
  const ids = row.shared ? row.company_ids : [row.company_id];
  for (const companyId of ids) {
    await requireCompany(req, companyId, 'intake.manage', { write: true }).catch((e) => {
      throw e.status === 404 ? errors.notFound('Channel') : e;
    });
  }
  return row;
}

export async function updateIdentity(req, id, body) {
  return db.transaction(async (trx) => {
    const row = await manageableIdentity(trx, req, id);
    const changes = {};
    if (body.label !== undefined) changes.label = body.label;
    if (body.active !== undefined) changes.active = body.active;
    if (!row.shared && row.company_id) {
      const index = await unitsIndex(req);
      const owner = index.get(row.company_id);
      if (body.unitId !== undefined) changes.unit_id = body.unitId ? (await unitInside(req, owner, body.unitId, 'body.unitId')).id : null;
      if (body.productLineId !== undefined) changes.product_line_id = (await productLineOf(trx, owner, body.productLineId, 'body.productLineId'))?.id ?? null;
    }
    if (body.companyIds !== undefined) {
      if (!row.shared) throw errors.validation([{ path: 'body.companyIds', message: 'Only shared channels serve several companies' }]);
      const companies = await checkIdentityCompanies(req, { shared: true, companyIds: body.companyIds });
      changes.company_ids = companies.map((c) => c.id);
    }
    if (!Object.keys(changes).length) return row;
    const [updated] = await trx('intake_channel_identities').where({ id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, req, 'intake.identity_updated', 'intake_identity', updated, { changed: Object.keys(body) });
    await event(trx, req, 'intake_identity.updated', updated, { identityId: id, changes: Object.keys(body) });
    return updated;
  });
}

export async function deleteIdentity(req, id) {
  return db.transaction(async (trx) => {
    const row = await manageableIdentity(trx, req, id);
    await trx('intake_channel_identities').where({ id }).delete();
    await audit(trx, req, 'intake.identity_deleted', 'intake_identity', row, { type: row.type });
    await event(trx, req, 'intake_identity.deleted', row, { identityId: id });
  });
}

// ---------- Assignment pools ----------

async function checkMembers(trx, unit, members) {
  if (!members.length) return [];
  const ids = members.map((m) => m.userId);
  if (new Set(ids).size !== ids.length) throw errors.validation([{ path: 'body.members', message: 'Each person once' }]);
  const eligible = new Set((await usersWithPermissionAt(unit, 'deals.manage', { trx, userIds: ids })).map((u) => u.id));
  const issues = members.map((m, i) => (!eligible.has(m.userId) ? { path: `body.members.${i}.userId`, message: 'This person cannot work leads in that team' } : null)).filter(Boolean);
  if (issues.length) throw errors.validation(issues);
  return members;
}

async function writeMembers(trx, poolId, members) {
  await trx('intake_pool_members').where({ pool_id: poolId }).delete();
  if (!members.length) return;
  await trx('intake_pool_members').insert(
    members.map((m) => ({ pool_id: poolId, user_id: m.userId, capacity: m.capacity, languages: m.languages, time_zone: m.timeZone, active: m.active, away_until: m.awayUntil })),
  );
}

async function checkPoolLines(trx, company, ids) {
  if (!ids.length) return;
  const found = await trx('product_lines').where({ company_id: company.id }).whereIn('id', ids).pluck('id');
  const missing = ids.findIndex((id) => !found.includes(id));
  if (missing >= 0) throw errors.validation([{ path: `body.productLineIds.${missing}`, message: 'Pick a product line of this company' }]);
}

export async function createPool(req, body) {
  const company = await requireCompany(req, body.companyId, 'intake.manage', { write: true, path: 'body.companyId' });
  const unit = await unitInside(req, company, body.unitId, 'body.unitId');
  return db.transaction(async (trx) => {
    await checkPoolLines(trx, company, body.productLineIds);
    await checkMembers(trx, unit, body.members);
    if (body.isDefault) await trx('intake_assignment_pools').where({ company_id: company.id, is_default: true }).update({ is_default: false });
    const [row] = await trx('intake_assignment_pools')
      .insert({
        id: randomUUID(),
        group_id: company.root_id,
        company_id: company.id,
        unit_id: unit.id,
        name: body.name,
        kind: body.kind,
        product_line_ids: body.productLineIds,
        is_default: body.isDefault,
        language_match: body.languageMatch,
        working_hours: body.workingHours,
        time_zone_match: body.timeZoneMatch,
        position: body.position,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await writeMembers(trx, row.id, body.members);
    await audit(trx, req, 'intake.pool_created', 'intake_pool', row, { name: row.name, members: body.members.length });
    await event(trx, req, 'intake_pool.created', row, { poolId: row.id, companyId: row.company_id });
    return row;
  });
}

async function manageablePool(trx, req, id) {
  const row = await trx('intake_assignment_pools').where({ id }).forUpdate().first();
  if (!row) throw errors.notFound('Pool');
  const company = await requireCompany(req, row.company_id, 'intake.manage', { write: true }).catch((e) => {
    throw e.status === 404 ? errors.notFound('Pool') : e;
  });
  return { row, company };
}

export async function updatePool(req, id, body) {
  return db.transaction(async (trx) => {
    const { row, company } = await manageablePool(trx, req, id);
    const changes = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.unitId !== undefined) changes.unit_id = (await unitInside(req, company, body.unitId, 'body.unitId')).id;
    if (body.kind !== undefined) changes.kind = body.kind;
    if (body.productLineIds !== undefined) {
      await checkPoolLines(trx, company, body.productLineIds);
      changes.product_line_ids = body.productLineIds;
    }
    for (const [key, column] of [['languageMatch', 'language_match'], ['workingHours', 'working_hours'], ['timeZoneMatch', 'time_zone_match'], ['position', 'position'], ['active', 'active']]) {
      if (body[key] !== undefined) changes[column] = body[key];
    }
    if (body.isDefault !== undefined) {
      if (body.isDefault) await trx('intake_assignment_pools').where({ company_id: company.id, is_default: true }).whereNot({ id }).update({ is_default: false });
      changes.is_default = body.isDefault;
    }
    if (!Object.keys(changes).length) return row;
    const [updated] = await trx('intake_assignment_pools').where({ id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, req, 'intake.pool_updated', 'intake_pool', updated, { changed: Object.keys(body) });
    await event(trx, req, 'intake_pool.updated', updated, { poolId: id, changes: Object.keys(body) });
    return updated;
  });
}

export async function replacePoolMembers(req, id, members) {
  return db.transaction(async (trx) => {
    const { row } = await manageablePool(trx, req, id);
    const unit = await trx('org_units').where({ id: row.unit_id }).first();
    await checkMembers(trx, unit, members);
    await writeMembers(trx, id, members);
    await trx('intake_assignment_pools').where({ id }).update({ updated_at: trx.fn.now() });
    await audit(trx, req, 'intake.pool_members_updated', 'intake_pool', row, { members: members.length });
    await event(trx, req, 'intake_pool.updated', row, { poolId: id, changes: ['members'] });
    return row;
  });
}

// ---------- Partner referral links ----------

export async function createPartnerLink(req, body) {
  const company = await requireCompany(req, body.companyId, 'intake.manage', { write: true, path: 'body.companyId' });
  return db.transaction(async (trx) => {
    await productLineOf(trx, company, body.productLineId, 'body.productLineId');
    if (body.formId) {
      const form = await trx('intake_forms').where({ id: body.formId, company_id: company.id, kind: 'enquiry' }).first('id');
      if (!form) throw errors.validation([{ path: 'body.formId', message: 'Pick an enquiry form of this company' }]);
    }
    await checkPartnerOwner(req, company, body.ownerUserId);
    const exists = await trx('intake_partner_links').where({ group_id: company.root_id, code: body.code }).first('id');
    if (exists) throw errors.conflict('That referral code is taken');
    const [row] = await trx('intake_partner_links')
      .insert({
        id: randomUUID(),
        group_id: company.root_id,
        company_id: company.id,
        code: body.code,
        partner_id: body.partnerId,
        partner_name: body.partnerName,
        owner_user_id: body.ownerUserId,
        product_line_id: body.productLineId,
        form_id: body.formId,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await audit(trx, req, 'intake.partner_link_created', 'intake_partner_link', row, { code: row.code, partnerId: row.partner_id });
    await event(trx, req, 'intake_partner_link.created', row, { partnerLinkId: row.id, partnerId: row.partner_id, companyId: row.company_id });
    return row;
  });
}

export async function updatePartnerLink(req, id, body) {
  return db.transaction(async (trx) => {
    const row = await trx('intake_partner_links').where({ id }).forUpdate().first();
    if (!row) throw errors.notFound('Referral link');
    const company = await requireCompany(req, row.company_id, 'intake.manage', { write: true }).catch((e) => {
      throw e.status === 404 ? errors.notFound('Referral link') : e;
    });
    const changes = {};
    if (body.partnerName !== undefined) changes.partner_name = body.partnerName;
    if (body.active !== undefined) changes.active = body.active;
    if (body.productLineId !== undefined) changes.product_line_id = (await productLineOf(trx, company, body.productLineId, 'body.productLineId'))?.id ?? null;
    if (body.formId !== undefined) {
      if (body.formId && !(await trx('intake_forms').where({ id: body.formId, company_id: company.id }).first('id'))) throw errors.validation([{ path: 'body.formId', message: 'Pick a form of this company' }]);
      changes.form_id = body.formId;
    }
    if (body.ownerUserId !== undefined) {
      await checkPartnerOwner(req, company, body.ownerUserId);
      changes.owner_user_id = body.ownerUserId;
    }
    if (!Object.keys(changes).length) return row;
    const [updated] = await trx('intake_partner_links').where({ id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    await audit(trx, req, 'intake.partner_link_updated', 'intake_partner_link', updated, { changed: Object.keys(body) });
    await event(trx, req, 'intake_partner_link.updated', updated, { partnerLinkId: id, changes: Object.keys(body) });
    return updated;
  });
}
