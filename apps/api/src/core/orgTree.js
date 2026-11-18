/**
 * Org units form a tree of any depth: group → company → region → branch → team → ...
 * Each unit stores a materialised path of ancestor ids, e.g. "/<group>/<company>/<branch>/",
 * so "everything under X" is a single indexed prefix match.
 */

export const childPath = (parentPath, id) => `${parentPath ?? '/'}${id}/`;

/** Ids from the root down to the unit itself. */
export const idsFromPath = (path) => String(path).split('/').filter(Boolean);

export const isWithin = (path, ancestorPath) => String(path).startsWith(ancestorPath);

export const depthOfPath = (path) => idsFromPath(path).length - 1;

export function rebasePath(path, oldPrefix, newPrefix) {
  if (!isWithin(path, oldPrefix)) throw new Error('Path is not inside the given prefix');
  return newPrefix + path.slice(oldPrefix.length);
}

/** Keep only the outermost paths: ["/a/", "/a/b/", "/c/"] → ["/a/", "/c/"]. */
export function outermostPaths(paths) {
  const sorted = [...new Set(paths)].sort((x, y) => x.length - y.length);
  const out = [];
  for (const path of sorted) if (!out.some((kept) => isWithin(path, kept))) out.push(path);
  return out;
}

/** The deepest unit shared by every path (their lowest common ancestor), or null if none. */
export function commonAncestorId(paths) {
  if (paths.length === 0) return null;
  let common = idsFromPath(paths[0]);
  for (const path of paths.slice(1)) {
    const ids = idsFromPath(path);
    let i = 0;
    while (i < common.length && i < ids.length && common[i] === ids[i]) i += 1;
    common = common.slice(0, i);
  }
  return common[common.length - 1] ?? null;
}

/** Can a unit of `childType` sit under a unit of `parentType`? Root units have parentType null. */
export function isAllowedParent(unitTypes, childType, parentType) {
  const definition = unitTypes.get(childType);
  if (!definition) return false;
  if (parentType === null) return definition.parents.length === 0;
  return definition.parents.includes(parentType);
}
