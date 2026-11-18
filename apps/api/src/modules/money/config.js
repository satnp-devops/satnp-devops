import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../core/audit.js';
import { emitEvent } from '../../core/events.js';
import { companiesInScope, requireCompany } from '../../core/crm/scope.js';
import { describeSeries, findSeriesConflicts, stateCodeFromGstin, panFromGstin, validateGstin } from '../../core/billing/index.js';
import { presentAccount, presentPlan, presentPriceList, presentProfile, presentSeries, presentTemplate } from './present.js';
import { seriesSpec } from './invoicing.js';
import { discountPolicyFrom, moneySettingsFor } from './settings.js';

// Settings > Billing: the company billing profile (GSTIN), invoice number series, plans and price
// lists, payment accounts and agreement templates. Reading needs billing.view (plans, prices and
// templates are what quotes are made from) or billing.configure anywhere in or above the company;
// writing needs billing.configure at the company itself (contract §4.1 rule 6).

const companyUnit = (company) => ({ id: company.id, root_id: company.root_id });

export const isUniqueViolation = (err) => err?.code === '23505';

async function writeConfig(trx, req, company, { action, entityType, entityId, before, after, payload }) {
  await writeAudit(trx, req, { action, entityType, entityId, unit: companyUnit(company), before, after });
  await emitEvent(trx, {
    type: action,
    groupId: company.root_id,
    unitId: company.id,
    aggregateType: entityType,
    aggregateId: entityId,
    actorUserId: req.auth.user.id,
    payload: { companyId: company.id, ...payload },
  });
}

/** Companies the Settings > Billing screen can show for a working unit, with what's still missing. */
export async function listBillingCompanies(req, unitId) {
  const companies = await companiesInScope(req, unitId, 'billing.configure');
  if (!companies.length) return [];
  const ids = companies.map((c) => c.id);
  const [profiles, series, accounts] = await Promise.all([
    db('billing_profiles').whereIn('company_id', ids).select('company_id', 'gstin'),
    db('billing_number_series').whereIn('company_id', ids).where({ active: true, is_default: true }).select('company_id', 'document_type'),
    db('billing_payment_accounts').whereIn('company_id', ids).where({ active: true }).select('company_id', 'provider'),
  ]);
  return companies.map((company) => {
    const profile = profiles.find((p) => p.company_id === company.id);
    const types = new Set(series.filter((s) => s.company_id === company.id).map((s) => s.document_type));
    const missing = [];
    if (!profile?.gstin) missing.push('gstin');
    if (!types.has('invoice')) missing.push('invoice_series');
    if (!types.has('credit_note')) missing.push('credit_note_series');
    if (!accounts.some((a) => a.company_id === company.id)) missing.push('payment_account');
    return { id: company.id, name: company.name, code: company.code, missing };
  });
}

/** Everything Settings > Billing shows for one company (one round of parallel queries). */
export async function getSetup(req, companyId) {
  const company = await requireCompany(req, companyId, 'billing.configure', { path: 'query.companyId' });
  const [profile, series, counters, accounts, templates, values] = await Promise.all([
    db('billing_profiles').where({ company_id: company.id }).first(),
    db('billing_number_series').where({ company_id: company.id }).orderBy([{ column: 'document_type' }, { column: 'created_at' }]),
    db('billing_number_counters as c')
      .join('billing_number_series as s', 's.id', 'c.series_id')
      .where('s.company_id', company.id)
      .select('c.series_id', 'c.fy_start_year', 'c.last_sequence'),
    db('billing_payment_accounts').where({ company_id: company.id }).orderBy('provider'),
    db('agreement_templates').where({ company_id: company.id }).orderBy('name'),
    moneySettingsFor(company),
  ]);
  return {
    company: { id: company.id, name: company.name, code: company.code },
    profile: presentProfile(profile),
    series: series.map((row) => {
      const last = counters.filter((c) => c.series_id === row.id).sort((a, b) => b.fy_start_year - a.fy_start_year)[0];
      return presentSeries(row, describeSeries(seriesSpec(row)).example, last ? { fyStartYear: last.fy_start_year, sequence: last.last_sequence } : null);
    }),
    accounts: accounts.map(presentAccount),
    templates: templates.map(presentTemplate),
    discountPolicy: discountPolicyFrom(values),
    settings: values,
  };
}

export async function putProfile(req, body) {
  const company = await requireCompany(req, body.companyId, 'billing.configure', { write: true, path: 'body.companyId' });
  let gstin = body.gstin;
  let stateCode = body.stateCode;
  let pan = body.pan;
  if (gstin) {
    const check = validateGstin(gstin);
    gstin = check.gstin;
    const fromGstin = stateCodeFromGstin(gstin);
    if (stateCode && stateCode !== fromGstin) throw errors.validation([{ path: 'body.stateCode', message: `The GSTIN is registered in state ${fromGstin}` }]);
    stateCode = fromGstin;
    if (pan && pan !== panFromGstin(gstin)) throw errors.validation([{ path: 'body.pan', message: 'The PAN does not match the GSTIN' }]);
    pan = panFromGstin(gstin);
  }
  const row = await db.transaction(async (trx) => {
    const before = await trx('billing_profiles').where({ company_id: company.id }).forUpdate().first();
    if (!stateCode && !before?.state_code) throw errors.validation([{ path: 'body.stateCode', message: 'Pick the state of the place of business' }]);
    if (before?.gstin && gstin !== undefined && gstin !== before.gstin) {
      const issued = await trx('invoices').where({ company_id: company.id, supplier_gstin: before.gstin }).first('id');
      const series = await trx('billing_number_series').where({ company_id: company.id, gstin: before.gstin, active: true }).first('id');
      if (issued && series) throw errors.conflict('Deactivate the series of the old GSTIN and add series for the new one before changing it');
    }
    const values = {
      legal_name: body.legalName,
      ...(body.tradeName !== undefined ? { trade_name: body.tradeName } : {}),
      ...(gstin !== undefined ? { gstin } : {}),
      ...(stateCode ? { state_code: stateCode } : {}),
      ...(pan !== undefined ? { pan } : {}),
      ...(body.address !== undefined ? { address: json(body.address) } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.lutNumber !== undefined ? { lut_number: body.lutNumber } : {}),
      ...(body.lutValidUntil !== undefined ? { lut_valid_until: body.lutValidUntil } : {}),
      ...(body.roundOff !== undefined ? { round_off: body.roundOff } : {}),
      ...(body.invoiceNotes !== undefined ? { invoice_notes: body.invoiceNotes } : {}),
      ...(body.bankDetails !== undefined ? { bank_details: json(body.bankDetails) } : {}),
      updated_by: req.auth.user.id,
      updated_at: trx.fn.now(),
    };
    const [saved] = before
      ? await trx('billing_profiles').where({ company_id: company.id }).update(values).returning('*')
      : await trx('billing_profiles').insert({ company_id: company.id, group_id: company.root_id, ...values }).returning('*');
    await writeConfig(trx, req, company, {
      action: 'billing.profile_updated',
      entityType: 'billing_profile',
      entityId: company.id,
      before: before ? { legalName: before.legal_name, gstin: before.gstin, stateCode: before.state_code, lutNumber: before.lut_number } : null,
      after: { legalName: saved.legal_name, gstin: saved.gstin, stateCode: saved.state_code, lutNumber: saved.lut_number },
      payload: { gstin: saved.gstin },
    });
    return saved;
  });
  return presentProfile(row);
}

export async function createSeries(req, body) {
  const company = await requireCompany(req, body.companyId, 'billing.configure', { write: true, path: 'body.companyId' });
  const row = await db.transaction(async (trx) => {
    const profile = await trx('billing_profiles').where({ company_id: company.id }).first();
    if (!profile?.gstin) throw errors.validation([{ path: 'body.companyId', message: 'Add the company GSTIN first' }]);
    const spec = { documentType: body.documentType, prefix: body.prefix, ...(body.format ? { format: body.format } : {}), fyStyle: body.fyStyle, padding: body.padding, gstin: profile.gstin };
    const described = describeSeries(spec);
    if (!described.ok) {
      throw errors.validation(described.issues.map((issue) => ({ path: issue.code === 'too_long' ? 'body.padding' : 'body.prefix', message: issue.message })));
    }
    const active = await trx('billing_number_series').where({ gstin: profile.gstin, active: true });
    const conflicts = findSeriesConflicts([...active.map(seriesSpec), described.series]);
    if (conflicts.length) throw errors.conflict('Another series under this GSTIN could produce the same numbers: pick another prefix');
    if (body.isDefault) {
      await trx('billing_number_series').where({ company_id: company.id, document_type: body.documentType, is_default: true }).update({ is_default: false, updated_at: trx.fn.now() });
    }
    let saved;
    try {
      [saved] = await trx('billing_number_series')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          gstin: profile.gstin,
          document_type: body.documentType,
          prefix: body.prefix,
          format: described.series.format,
          fy_style: body.fyStyle,
          padding: body.padding,
          is_default: body.isDefault,
          created_by: req.auth.user.id,
        })
        .returning('*');
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.conflict('This prefix is already used for this GSTIN');
      throw err;
    }
    await writeConfig(trx, req, company, {
        action: 'billing.series_created',
        entityType: 'billing_series',
        entityId: saved.id,
        after: { documentType: saved.document_type, prefix: saved.prefix, format: saved.format },
        payload: { seriesId: saved.id, documentType: saved.document_type },
      });
    return saved;
  });
  return presentSeries(row, describeSeries(seriesSpec(row)).example);
}


export async function updateSeries(req, id, body) {
  const row = await db.transaction(async (trx) => {
    const series = await trx('billing_number_series').where({ id }).forUpdate().first();
    if (!series) throw errors.notFound('Series');
    const company = await requireCompany(req, series.company_id, 'billing.configure', { write: true, trx }).catch(() => {
      throw errors.notFound('Series');
    });
    const changes = { updated_at: trx.fn.now() };
    if (body.active !== undefined) changes.active = body.active;
    if (body.isDefault) {
      if (body.active === false || (!series.active && body.active !== true)) throw errors.validation([{ path: 'body.isDefault', message: 'Only an active series can be the default' }]);
      await trx('billing_number_series').where({ company_id: series.company_id, document_type: series.document_type, is_default: true }).whereNot({ id }).update({ is_default: false });
      changes.is_default = true;
    } else if (body.active === false) changes.is_default = false;
    const [saved] = await trx('billing_number_series').where({ id }).update(changes).returning('*');
    await writeConfig(trx, req, company, {
        action: 'billing.series_updated',
        entityType: 'billing_series',
        entityId: id,
        before: { active: series.active, isDefault: series.is_default },
        after: { active: saved.active, isDefault: saved.is_default },
        payload: { seriesId: id },
      });
    return saved;
  });
  return presentSeries(row, describeSeries(seriesSpec(row)).example);
}

// ---------- Plans ----------

async function configCompanies(req, { companyId, unitId }, permissions) {
  if (companyId) {
    for (const permission of permissions) {
      try {
        return [await requireCompany(req, companyId, permission, { path: 'query.companyId' })];
      } catch (err) {
        if (err.status !== 403 || permission === permissions[permissions.length - 1]) throw err;
      }
    }
  }
  const sets = await Promise.all(permissions.map((p) => companiesInScope(req, unitId, p)));
  const byId = new Map(sets.flat().map((c) => [c.id, c]));
  if (!byId.size) throw errors.forbidden();
  return [...byId.values()];
}

const READ = ['billing.view', 'billing.configure'];

export async function listPlans(req, query) {
  const companies = await configCompanies(req, query, READ);
  const rows = await db('billing_plans')
    .whereIn('company_id', companies.map((c) => c.id))
    .modify((q) => {
      if (query.includeInactive !== 'true') q.where({ active: true });
    })
    .orderBy([{ column: 'company_id' }, { column: 'position' }, { column: 'name' }])
    .limit(1000);
  return rows.map(presentPlan);
}

async function checkProduct(trx, productId, companyId) {
  if (!productId) return;
  const product = await trx('products').where({ id: productId }).first('company_id');
  if (!product || product.company_id !== companyId) throw errors.validation([{ path: 'body.productId', message: 'Product not found in this company' }]);
}

export async function createPlan(req, body) {
  const company = await requireCompany(req, body.companyId, 'billing.configure', { write: true, path: 'body.companyId' });
  const row = await db.transaction(async (trx) => {
    await checkProduct(trx, body.productId, company.id);
    let saved;
    try {
      [saved] = await trx('billing_plans')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          product_id: body.productId ?? null,
          code: body.code,
          name: body.name,
          description: body.description ?? null,
          kind: body.kind,
          audience: body.audience,
          unit: body.unit,
          interval: body.kind === 'recurring' ? body.interval : null,
          sac: body.sac ?? null,
          tax_rate_bp: body.taxRateBp,
          taxability: body.taxability,
          position: body.position ?? 0,
          active: body.active ?? true,
          created_by: req.auth.user.id,
        })
        .returning('*');
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.validation([{ path: 'body.code', message: 'Another plan uses this code' }]);
      throw err;
    }
    await writeConfig(trx, req, company, { action: 'billing.plan_created', entityType: 'billing_plan', entityId: saved.id, after: presentPlan(saved), payload: { planId: saved.id } });
    return saved;
  });
  return presentPlan(row);
}

export async function updatePlan(req, id, body) {
  const row = await db.transaction(async (trx) => {
    const plan = await trx('billing_plans').where({ id }).forUpdate().first();
    if (!plan) throw errors.notFound('Plan');
    const company = await requireCompany(req, plan.company_id, 'billing.configure', { write: true, trx }).catch((err) => {
      throw err.status === 404 ? errors.notFound('Plan') : err;
    });
    await checkProduct(trx, body.productId, company.id);
    const next = { ...presentPlan(plan), ...body };
    if (next.kind === 'recurring' ? !next.interval : next.interval) {
      throw errors.validation([{ path: 'body.interval', message: 'Recurring plans need an interval; one-time plans have none' }]);
    }
    const columns = {
      product_id: 'productId', code: 'code', name: 'name', description: 'description', kind: 'kind', audience: 'audience', unit: 'unit',
      interval: 'interval', sac: 'sac', tax_rate_bp: 'taxRateBp', taxability: 'taxability', position: 'position', active: 'active',
    };
    const changes = { updated_at: trx.fn.now() };
    for (const [column, key] of Object.entries(columns)) if (body[key] !== undefined) changes[column] = body[key];
    if (next.kind === 'one_time') changes.interval = null;
    let saved;
    try {
      [saved] = await trx('billing_plans').where({ id }).update(changes).returning('*');
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.validation([{ path: 'body.code', message: 'Another plan uses this code' }]);
      throw err;
    }
    await writeConfig(trx, req, company, { action: 'billing.plan_updated', entityType: 'billing_plan', entityId: id, before: presentPlan(plan), after: presentPlan(saved), payload: { planId: id } });
    return saved;
  });
  return presentPlan(row);
}

// ---------- Price lists ----------

export async function listPriceLists(req, query) {
  const companies = await configCompanies(req, query, READ);
  const lists = await db('billing_price_lists')
    .whereIn('company_id', companies.map((c) => c.id))
    .modify((q) => {
      if (query.includeInactive !== 'true') q.where({ active: true });
    })
    .orderBy([{ column: 'company_id' }, { column: 'is_default', order: 'desc' }, { column: 'name' }])
    .limit(200);
  const prices = lists.length ? await db('billing_prices').whereIn('price_list_id', lists.map((l) => l.id)) : [];
  return lists.map((list) => presentPriceList(list, prices.filter((p) => p.price_list_id === list.id)));
}

async function writePrices(trx, list, prices) {
  if (!prices) return;
  const planIds = [...new Set(prices.map((p) => p.planId))];
  if (planIds.length !== prices.length) throw errors.validation([{ path: 'body.prices', message: 'A plan appears twice' }]);
  const plans = planIds.length ? await trx('billing_plans').whereIn('id', planIds).select('id', 'company_id') : [];
  prices.forEach((price, index) => {
    const plan = plans.find((p) => p.id === price.planId);
    if (!plan || plan.company_id !== list.company_id) throw errors.validation([{ path: `body.prices.${index}.planId`, message: 'Plan not found in this company' }]);
  });
  await trx('billing_prices').where({ price_list_id: list.id }).whereNotIn('plan_id', planIds.length ? planIds : ['00000000-0000-0000-0000-000000000000']).del();
  if (prices.length) {
    await trx('billing_prices')
      .insert(prices.map((p) => ({ price_list_id: list.id, plan_id: p.planId, company_id: list.company_id, unit_amount_minor: p.unitAmountMinor })))
      .onConflict(['price_list_id', 'plan_id'])
      .merge({ unit_amount_minor: trx.raw('excluded.unit_amount_minor'), updated_at: trx.fn.now() });
  }
}

export async function createPriceList(req, body) {
  const company = await requireCompany(req, body.companyId, 'billing.configure', { write: true, path: 'body.companyId' });
  const { list, prices } = await db.transaction(async (trx) => {
    if (body.isDefault) await trx('billing_price_lists').where({ company_id: company.id, currency: body.currency, is_default: true }).update({ is_default: false });
    const [saved] = await trx('billing_price_lists')
      .insert({
        group_id: company.root_id,
        company_id: company.id,
        name: body.name,
        currency: body.currency,
        prices_include_tax: body.pricesIncludeTax,
        is_default: body.isDefault,
        created_by: req.auth.user.id,
      })
      .returning('*');
    await writePrices(trx, saved, body.prices);
    await writeConfig(trx, req, company, {
        action: 'billing.price_list_created',
        entityType: 'billing_price_list',
        entityId: saved.id,
        after: { name: saved.name, currency: saved.currency, priceCount: body.prices.length },
        payload: { priceListId: saved.id },
      });
    return { list: saved, prices: await trx('billing_prices').where({ price_list_id: saved.id }) };
  });
  return presentPriceList(list, prices);
}

export async function updatePriceList(req, id, body) {
  const { list, prices } = await db.transaction(async (trx) => {
    const before = await trx('billing_price_lists').where({ id }).forUpdate().first();
    if (!before) throw errors.notFound('Price list');
    const company = await requireCompany(req, before.company_id, 'billing.configure', { write: true, trx }).catch((err) => {
      throw err.status === 404 ? errors.notFound('Price list') : err;
    });
    if (body.isDefault) {
      await trx('billing_price_lists').where({ company_id: before.company_id, currency: before.currency, is_default: true }).whereNot({ id }).update({ is_default: false });
    }
    const changes = { updated_at: trx.fn.now() };
    if (body.name !== undefined) changes.name = body.name;
    if (body.pricesIncludeTax !== undefined) changes.prices_include_tax = body.pricesIncludeTax;
    if (body.isDefault !== undefined) changes.is_default = body.isDefault;
    if (body.active !== undefined) {
      changes.active = body.active;
      if (!body.active) changes.is_default = false;
    }
    const [saved] = await trx('billing_price_lists').where({ id }).update(changes).returning('*');
    await writePrices(trx, saved, body.prices);
    await writeConfig(trx, req, company, {
        action: 'billing.price_list_updated',
        entityType: 'billing_price_list',
        entityId: id,
        before: { name: before.name, active: before.active, isDefault: before.is_default },
        after: { name: saved.name, active: saved.active, isDefault: saved.is_default, ...(body.prices ? { priceCount: body.prices.length } : {}) },
        payload: { priceListId: id },
      });
    return { list: saved, prices: await trx('billing_prices').where({ price_list_id: id }) };
  });
  return presentPriceList(list, prices);
}

// ---------- Payment accounts ----------

function checkAccount(account) {
  if (account.provider === 'stripe' && account.entity_country === 'IN' && account.scope !== 'domestic' && !account.india_exports) {
    // docs/providers/stripe.md: an Indian Stripe account takes payments from abroad only with exports enabled.
    throw errors.validation([{ path: 'body.indiaExports', message: 'A Stripe India account needs exports enabled (and a purpose code) to take international payments' }]);
  }
  if (account.provider === 'stripe' && account.india_exports && !account.purpose_code) {
    throw errors.validation([{ path: 'body.purposeCode', message: 'Stripe India exports need one purpose code per account, e.g. P1107 for education' }]);
  }
}

/**
 * A payment account may name only a payment-gateway connection of its own company (connected,
 * not disconnected). The integration framework refuses anything else when it builds the client;
 * this keeps the setting itself honest and the error on the field (422).
 */
async function checkConnection(trx, companyId, connectionId) {
  if (!connectionId) return;
  const linked = await trx('integration_connection_companies as l')
    .join('integration_connections as c', 'c.id', 'l.connection_id')
    .where({ 'l.company_id': companyId, 'l.connection_id': connectionId, 'l.kind': 'payments' })
    .whereNull('c.disconnected_at')
    .first('c.id');
  if (!linked) throw errors.validation([{ path: 'body.connectionId', message: 'Pick a payment gateway connected for this company' }]);
}

export async function createAccount(req, body) {
  const company = await requireCompany(req, body.companyId, 'billing.configure', { write: true, path: 'body.companyId' });
  await checkConnection(db, company.id, body.connectionId);
  const values = {
    group_id: company.root_id,
    company_id: company.id,
    provider: body.provider,
    label: body.label,
    scope: body.scope,
    mode: body.mode,
    account_ref: body.accountRef ?? null,
    connection_id: body.connectionId ?? null,
    entity_country: body.entityCountry,
    india_exports: body.indiaExports,
    purpose_code: body.purposeCode ?? null,
    created_by: req.auth.user.id,
  };
  checkAccount(values);
  const row = await db.transaction(async (trx) => {
    let saved;
    try {
      [saved] = await trx('billing_payment_accounts').insert(values).returning('*');
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.conflict(`This company already has a ${body.provider === 'stripe' ? 'Stripe' : 'Razorpay'} account`);
      throw err;
    }
    await writeConfig(trx, req, company, {
        action: 'billing.account_created',
        entityType: 'billing_payment_account',
        entityId: saved.id,
        after: { provider: saved.provider, scope: saved.scope, mode: saved.mode },
        payload: { accountId: saved.id, provider: saved.provider },
      });
    return saved;
  });
  return presentAccount(row);
}

export async function updateAccount(req, id, body) {
  const row = await db.transaction(async (trx) => {
    const before = await trx('billing_payment_accounts').where({ id }).forUpdate().first();
    if (!before) throw errors.notFound('Payment account');
    const company = await requireCompany(req, before.company_id, 'billing.configure', { write: true, trx }).catch((err) => {
      throw err.status === 404 ? errors.notFound('Payment account') : err;
    });
    const map = { label: 'label', scope: 'scope', mode: 'mode', account_ref: 'accountRef', connection_id: 'connectionId', entity_country: 'entityCountry', india_exports: 'indiaExports', purpose_code: 'purposeCode', active: 'active' };
    const changes = {};
    for (const [column, key] of Object.entries(map)) if (body[key] !== undefined) changes[column] = body[key];
    checkAccount({ ...before, ...changes });
    if (changes.connection_id && changes.connection_id !== before.connection_id) await checkConnection(trx, before.company_id, changes.connection_id);
    const [saved] = await trx('billing_payment_accounts').where({ id }).update({ ...changes, updated_at: trx.fn.now() }).returning('*');
    await writeConfig(trx, req, company, {
        action: 'billing.account_updated',
        entityType: 'billing_payment_account',
        entityId: id,
        before: presentAccount(before),
        after: presentAccount(saved),
        payload: { accountId: id, provider: saved.provider },
      });
    return saved;
  });
  return presentAccount(row);
}

// ---------- Agreement templates ----------

export async function listTemplates(req, query) {
  const companies = await configCompanies(req, query, READ);
  const rows = await db('agreement_templates')
    .whereIn('company_id', companies.map((c) => c.id))
    .modify((q) => {
      if (query.includeInactive !== 'true') q.where({ active: true });
    })
    .orderBy([{ column: 'company_id' }, { column: 'name' }])
    .limit(500);
  return rows.map(presentTemplate);
}

export async function createTemplate(req, body) {
  const company = await requireCompany(req, body.companyId, 'billing.configure', { write: true, path: 'body.companyId' });
  const row = await db.transaction(async (trx) => {
    let saved;
    try {
      [saved] = await trx('agreement_templates')
        .insert({
          group_id: company.root_id,
          company_id: company.id,
          key: body.key,
          name: body.name,
          audience: body.audience,
          body: body.body,
          sign_type: body.signType,
          expires_in_days: body.expiresInDays,
          created_by: req.auth.user.id,
        })
        .returning('*');
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.validation([{ path: 'body.key', message: 'Another template uses this key' }]);
      throw err;
    }
    await writeConfig(trx, req, company, { action: 'billing.template_created', entityType: 'agreement_template', entityId: saved.id, after: { key: saved.key, name: saved.name }, payload: { templateId: saved.id } });
    return saved;
  });
  return presentTemplate(row);
}

export async function updateTemplate(req, id, body) {
  const row = await db.transaction(async (trx) => {
    const before = await trx('agreement_templates').where({ id }).forUpdate().first();
    if (!before) throw errors.notFound('Template');
    const company = await requireCompany(req, before.company_id, 'billing.configure', { write: true, trx }).catch((err) => {
      throw err.status === 404 ? errors.notFound('Template') : err;
    });
    const map = { name: 'name', audience: 'audience', body: 'body', sign_type: 'signType', expires_in_days: 'expiresInDays', active: 'active' };
    const changes = { updated_at: trx.fn.now() };
    for (const [column, key] of Object.entries(map)) if (body[key] !== undefined) changes[column] = body[key];
    const [saved] = await trx('agreement_templates').where({ id }).update(changes).returning('*');
    await writeConfig(trx, req, company, {
        action: 'billing.template_updated',
        entityType: 'agreement_template',
        entityId: id,
        before: { name: before.name, active: before.active, signType: before.sign_type },
        after: { name: saved.name, active: saved.active, signType: saved.sign_type, ...(body.body ? { changed: ['body'] } : {}) },
        payload: { templateId: id },
      });
    return saved;
  });
  return presentTemplate(row);
}
