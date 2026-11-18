import type { OrgUnit, UnitType } from './types';

// The org tree is stored as materialised paths ("/<group>/<company>/<id>/"),
// so "is X inside Y" is a prefix check and ancestors are the ids in the path.

export const idsFromPath = (path: string): string[] => path.split('/').filter(Boolean);

export const isWithin = (path: string, ancestorPath: string): boolean => path.startsWith(ancestorPath);

export interface TreeNode {
  unit: OrgUnit;
  children: TreeNode[];
}

/** Units arrive sorted by depth, then name, so children keep that order. */
export function buildTree(units: readonly OrgUnit[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const unit of units) nodes.set(unit.id, { unit, children: [] });
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.unit.parentId ? nodes.get(node.unit.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface FlatUnit {
  unit: OrgUnit;
  /** Depth relative to the shallowest unit in the list. */
  level: number;
}

/** Depth-first order with levels, for indented lists and selects. */
export function flattenTree(nodes: readonly TreeNode[], level = 0, out: FlatUnit[] = []): FlatUnit[] {
  for (const node of nodes) {
    out.push({ unit: node.unit, level });
    flattenTree(node.children, level + 1, out);
  }
  return out;
}

export function flattenUnits(units: readonly OrgUnit[]): FlatUnit[] {
  return flattenTree(buildTree(units));
}

/** Ancestors from the top down to the unit itself (only those the user can see). */
export function trailOf(unit: OrgUnit, byId: ReadonlyMap<string, OrgUnit>): OrgUnit[] {
  return idsFromPath(unit.path)
    .map((id) => byId.get(id))
    .filter((item): item is OrgUnit => item !== undefined);
}

export function unitTypeLabel(types: readonly UnitType[] | undefined, key: string): string {
  return types?.find((type) => type.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Unit types that may be added directly under a unit of `parentType`. */
export function childTypesFor(types: readonly UnitType[], parentType: string): UnitType[] {
  return types.filter((type) => type.parents.includes(parentType));
}

/** Indent for option labels in a native <select>, which can't be styled per level. */
export function indentLabel(label: string, level: number): string {
  return `${'   '.repeat(level)}${label}`;
}
