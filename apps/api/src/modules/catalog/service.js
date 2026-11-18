import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { listChannels } from '../../core/crm/channels.js';
import {
  ACCOUNT_CONTACT_ROLES,
  ACCOUNT_KINDS,
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONTACT_KINDS,
  CUSTOM_FIELD_TYPES,
  DEAL_COLUMNS,
  DEAL_CONTACT_ROLES,
  DEAL_KINDS,
  DEAL_SORTS,
  HOUSEHOLD_ROLES,
  LINK_STATUSES,
  MANUAL_TIMELINE_KINDS,
  PRODUCT_KINDS,
  TASK_KINDS,
  TASK_PRIORITIES,
  TIMELINE_KINDS,
  productKind,
} from '../../core/crm/constants.js';
import { requiredFieldOptions } from '../../core/crm/dealFields.js';
import { unitsIndex, usersWithPermissionAt } from '../../core/crm/scope.js';
import {
  changedKeys,
  configCompanies,
  loadConfigRow,
  nextPosition,
  recordChange,
  requireManagedCompany,
  sortByCompany,
  withUniqueConflicts,
} from '../pipelines/configAccess.js';
import { presentProduct, presentProductLine } from './present.js';

// Product lines and products (docs/crm/PHASE2_CONTRACT.md §9.4), plus the CRM vocabularies and
// the people picker used by every CRM form.

const VIEW = 'catalog.view';
const MANAGE = 'catalog.manage';

const LINE_CONFLICTS = { product_lines_key_uq: 'Another product line of this company already uses this key' };
const PRODUCT_CONFLICTS = { products_code_uq: 'Another product of this company already uses this code' };

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

// ---------- Vocabularies and people ----------

/** Every fixed list the CRM screens need, in one cacheable response (CrmVocabularies). */
export function vocabularies(registry) {
  return {
    channels: listChannels(registry),
    contactKinds: CONTACT_KINDS,
    linkStatuses: LINK_STATUSES,
    householdRoles: HOUSEHOLD_ROLES,
    accountKinds: ACCOUNT_KINDS.map(({ key, label }) => ({ key, label })),
    accountContactRoles: ACCOUNT_CONTACT_ROLES,
    dealKinds: DEAL_KINDS,
    dealContactRoles: DEAL_CONTACT_ROLES,
    dealSorts: DEAL_SORTS,
    dealColumns: DEAL_COLUMNS,
    productKinds: PRODUCT_KINDS.map(({ key, label, audience }) => ({ key, label, audience })),
    customFieldTypes: CUSTOM_FIELD_TYPES,
    dealRequiredFields: requiredFieldOptions([]),
    timelineKinds: TIMELINE_KINDS.map(({ key, label }) => ({ key, label })),
    manualTimelineKinds: MANUAL_TIMELINE_KINDS,
    taskKinds: TASK_KINDS,
    taskPriorities: TASK_PRIORITIES,
    consentChannels: CONSENT_CHANNELS,
    consentPurposes: CONSENT_PURPOSES,
    consentSources: CONSENT_SOURCES,
  };
}

/** Permissions that let someone pick owners and assignees at a unit. */
const PICKER_PERMISSIONS = ['deals.view', 'contacts.view', 'tasks.view', 'accounts.view'];
const PEOPLE_LIMIT = 200;

/** People holding `permission` at a unit, for owner and assignee pickers (PersonOption[]). */
export async function listPeople(req, { unitId, permission, q }) {
  const unit = (await unitsIndex(req)).get(unitId);
  if (!unit || !req.access.canSee(unit.path)) throw errors.notFound('Unit');
  if (!PICKER_PERMISSIONS.some((key) => req.access.canAnywhereWithin(key, unit.path))) throw errors.forbidden();
  const people = await usersWithPermissionAt(unit, permission);
  const term = q?.toLowerCase();
  return people
    .filter((person) => !term || person.name.toLowerCase().includes(term) || person.email.toLowerCase().includes(term))
    .slice(0, PEOPLE_LIMIT)
    .map(({ id, name, email, level }) => ({ id, name, email, level }));
}

// ---------- Product lines ----------

const auditLine = (row) => ({
  key: row.key,
  name: row.name,
  kind: row.kind,
  description: row.description,
  position: row.position,
  active: row.active,
});

/** Product lines with the number of active products in each (one query). */
const linesQuery = (trx) =>
  trx('product_lines as pl').select(
    'pl.*',
    trx.raw('(select count(*)::int from products pr where pr.product_line_id = pl.id and pr.active) as product_count'),
  );

const loadLine = (id, trx = db) => linesQuery(trx).where('pl.id', id).first();

export async function listProductLines(req, { unitId, companyId, includeInactive = false }) {
  const companies = await configCompanies(req, { unitId, companyId }, VIEW);
  if (companies.length === 0) return [];
  const rows = await linesQuery(db)
    .whereIn('pl.company_id', companies.map((company) => company.id))
    .modify((query) => {
      if (!includeInactive) query.where('pl.active', true);
    })
    .limit(1000);
  return sortByCompany(rows, companies, (a, b) => a.position - b.position || a.name.localeCompare(b.name)).map(presentProductLine);
}

export async function createProductLine(req, body) {
  return db.transaction(async (trx) => {
    const company = await requireManagedCompany(req, body.companyId, MANAGE, { trx });
    if (await trx('product_lines').where({ company_id: company.id, key: body.key }).first()) {
      throw errors.conflict(LINE_CONFLICTS.product_lines_key_uq);
    }
    const kind = productKind(body.kind);
    const [row] = await withUniqueConflicts(LINE_CONFLICTS, async () =>
      trx('product_lines')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          key: body.key,
          name: body.name,
          kind: kind.key,
          audience: kind.audience,
          description: body.description ?? null,
          position: body.position ?? (await nextPosition(trx, 'product_lines', { company_id: company.id })),
          created_by: req.auth.user.id,
        })
        .returning('*'),
    );
    await recordChange(trx, req, {
      company,
      action: 'product_line.created',
      entityType: 'product_line',
      entityId: row.id,
      after: auditLine(row),
      event: { payload: { productLineId: row.id, companyId: company.id } },
    });
    return presentProductLine({ ...row, product_count: 0 });
  });
}

export async function updateProductLine(req, id, body) {
  await db.transaction(async (trx) => {
    const { row, company } = await loadConfigRow(req, { table: 'product_lines', id, view: VIEW, manage: MANAGE, notFound: 'Product line', trx, forUpdate: true });
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.position !== undefined) patch.position = body.position;
    if (body.active !== undefined) patch.active = body.active;
    if (Object.keys(patch).length === 0) return;
    const [updated] = await trx('product_lines').where({ id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*');
    const before = auditLine(row);
    const after = auditLine(updated);
    await recordChange(trx, req, {
      company,
      action: 'product_line.updated',
      entityType: 'product_line',
      entityId: id,
      before,
      after,
      event: { payload: { productLineId: id, companyId: company.id, changes: changedKeys(before, after) } },
    });
  });
  return presentProductLine(await loadLine(id));
}

// ---------- Products ----------

const auditProduct = (row) => ({
  productLineId: row.product_line_id,
  code: row.code,
  name: row.name,
  description: row.description,
  attributes: row.attributes,
  position: row.position,
  active: row.active,
});

/**
 * A product line named in a body: it must exist in a company the user can read (else 422 on the
 * field, never saying whether it exists elsewhere). Returns the line and its company.
 */
async function lineForProduct(req, trx, lineId, path = 'body.productLineId') {
  const line = await trx('product_lines').where({ id: lineId }).first();
  const company = line ? (await unitsIndex(req, trx)).get(line.company_id) : null;
  if (!line || !company || !req.access.canSee(company.path) || !req.access.canAnywhereWithin(VIEW, company.path)) {
    throw errors.validation([{ path, message: 'Product line not found' }]);
  }
  return { line, company };
}

export async function listProducts(req, { unitId, companyId, productLineId, q, includeInactive = false }) {
  let companies;
  if (!unitId && !companyId) {
    const line = await db('product_lines').where({ id: productLineId }).first();
    if (!line) throw errors.notFound('Product line');
    companies = await configCompanies(req, { companyId: line.company_id }, VIEW).catch((error) => {
      throw error.status === 403 ? error : errors.notFound('Product line');
    });
  } else {
    companies = await configCompanies(req, { unitId, companyId }, VIEW);
  }
  if (companies.length === 0) return [];
  const rows = await db('products as p')
    .join('product_lines as pl', 'pl.id', 'p.product_line_id')
    .whereIn('p.company_id', companies.map((company) => company.id))
    .modify((query) => {
      if (productLineId) query.where('p.product_line_id', productLineId);
      if (!includeInactive) query.where('p.active', true);
      if (q) {
        const term = escapeLike(q);
        query.where((w) => w.whereILike('p.name', `%${term}%`).orWhereILike('p.code', `${term}%`));
      }
    })
    .select('p.*', 'pl.position as line_position', 'pl.name as line_name')
    .limit(1000);
  return sortByCompany(
    rows,
    companies,
    (a, b) => a.line_position - b.line_position || a.line_name.localeCompare(b.line_name) || a.position - b.position || a.name.localeCompare(b.name),
  ).map(presentProduct);
}

export async function createProduct(req, body) {
  return db.transaction(async (trx) => {
    const { line, company } = await lineForProduct(req, trx, body.productLineId);
    if (!req.access.can(MANAGE, company.path)) throw errors.forbidden();
    if (body.code && (await trx('products').where({ company_id: company.id, code: body.code }).first())) {
      throw errors.conflict(PRODUCT_CONFLICTS.products_code_uq);
    }
    const [row] = await withUniqueConflicts(PRODUCT_CONFLICTS, async () =>
      trx('products')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          product_line_id: line.id,
          code: body.code ?? null,
          name: body.name,
          description: body.description ?? null,
          attributes: json(body.attributes ?? {}),
          position: body.position ?? (await nextPosition(trx, 'products', { product_line_id: line.id })),
          created_by: req.auth.user.id,
        })
        .returning('*'),
    );
    await recordChange(trx, req, {
      company,
      action: 'product.created',
      entityType: 'product',
      entityId: row.id,
      after: auditProduct(row),
      event: { payload: { productId: row.id, companyId: company.id, productLineId: line.id } },
    });
    return presentProduct(row);
  });
}

export async function updateProduct(req, id, body) {
  return db.transaction(async (trx) => {
    const { row, company } = await loadConfigRow(req, { table: 'products', id, view: VIEW, manage: MANAGE, notFound: 'Product', trx, forUpdate: true });
    const patch = {};
    if (body.productLineId !== undefined && body.productLineId !== row.product_line_id) {
      const [current, next] = await Promise.all([
        trx('product_lines').where({ id: row.product_line_id }).first(),
        trx('product_lines').where({ id: body.productLineId }).first(),
      ]);
      if (!next || next.company_id !== company.id) {
        throw errors.validation([{ path: 'body.productLineId', message: 'Pick a product line of the same company' }]);
      }
      if (next.audience !== current.audience) {
        throw errors.validation([{ path: 'body.productLineId', message: `Pick a product line that also sells to ${current.audience.toUpperCase()} buyers` }]);
      }
      patch.product_line_id = next.id;
    }
    if (body.code !== undefined && (body.code ?? null) !== (row.code ?? null)) {
      if (body.code) {
        const clash = await trx('products').where({ company_id: company.id, code: body.code }).whereNot({ id }).first();
        if (clash) throw errors.conflict(PRODUCT_CONFLICTS.products_code_uq);
      }
      patch.code = body.code;
    }
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.attributes !== undefined) patch.attributes = json(body.attributes);
    if (body.position !== undefined) patch.position = body.position;
    if (body.active !== undefined) patch.active = body.active;
    if (Object.keys(patch).length === 0) return presentProduct(row);

    const [updated] = await withUniqueConflicts(PRODUCT_CONFLICTS, () =>
      trx('products').where({ id }).update({ ...patch, updated_at: trx.fn.now() }).returning('*'),
    );
    const before = auditProduct(row);
    const after = auditProduct(updated);
    await recordChange(trx, req, {
      company,
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      before,
      after,
      event: { payload: { productId: id, companyId: company.id, changes: changedKeys(before, after) } },
    });
    return presentProduct(updated);
  });
}
