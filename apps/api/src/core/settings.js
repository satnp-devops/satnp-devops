import { db } from '../lib/db.js';
import { idsFromPath } from './orgTree.js';

/**
 * Settings inherit down the org tree: a value set on the group applies to every company,
 * unless a company (or a branch, or a team) sets its own.
 *
 * Pure function so it can be unit-tested without a database.
 * @param {{ definitions: Array<{key: string, default: unknown}>, chainIds: string[], rows: Array<{org_unit_id: string, key: string, value: unknown}> }} input
 */
export function resolveSettings({ definitions, chainIds, rows }) {
  const byUnit = new Map();
  for (const row of rows) {
    if (!byUnit.has(row.org_unit_id)) byUnit.set(row.org_unit_id, new Map());
    byUnit.get(row.org_unit_id).set(row.key, row.value);
  }
  const targetId = chainIds[chainIds.length - 1];
  const result = {};
  for (const definition of definitions) {
    let found = null;
    for (let i = chainIds.length - 1; i >= 0; i -= 1) {
      const values = byUnit.get(chainIds[i]);
      if (values?.has(definition.key)) {
        found = { value: values.get(definition.key), sourceUnitId: chainIds[i] };
        break;
      }
    }
    result[definition.key] = found
      ? { value: found.value, sourceUnitId: found.sourceUnitId, inherited: found.sourceUnitId !== targetId, isDefault: false }
      : { value: definition.default, sourceUnitId: null, inherited: true, isDefault: true };
  }
  return result;
}

/** Effective settings for a unit, resolved through all of its ancestors. */
export async function getEffectiveSettings(unit, definitions, trx = db) {
  const chainIds = idsFromPath(unit.path);
  const rows = await trx('settings')
    .whereIn('org_unit_id', chainIds)
    .whereIn(
      'key',
      definitions.map((d) => d.key),
    );
  return resolveSettings({ definitions, chainIds, rows });
}

/** One effective value, for use inside other modules. */
export async function getSetting(unit, definition, trx = db) {
  const resolved = await getEffectiveSettings(unit, [definition], trx);
  return resolved[definition.key].value;
}
