import { toIso } from '../pipelines/configAccess.js';

// Row → API shapes of apps/web/src/lib/crm/types.ts (ProductLine, Product).

export function presentProductLine(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    companyId: row.company_id,
    key: row.key,
    audience: row.audience,
    description: row.description ?? null,
    position: row.position,
    active: row.active === true,
    productCount: Number(row.product_count ?? 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function presentProduct(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    companyId: row.company_id,
    productLineId: row.product_line_id,
    description: row.description ?? null,
    attributes: row.attributes ?? {},
    position: row.position,
    active: row.active === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
