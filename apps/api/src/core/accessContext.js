import { coversPermission, permissionLevel } from './permissions.js';
import { isWithin, outermostPaths } from './orgTree.js';

/**
 * Everything the platform needs to answer "can this user do X here?".
 * A role assigned at a unit applies to that unit and every unit below it.
 * Pure (no I/O) so it can be unit-tested and cached as JSON.
 */
export class AccessContext {
  constructor({ userId, assignments = [], mfaRequired = false }) {
    this.userId = userId;
    this.assignments = assignments;
    this.mfaRequired = mfaRequired;
  }

  toJSON() {
    return { userId: this.userId, assignments: this.assignments, mfaRequired: this.mfaRequired };
  }

  /** Assignments at this unit or above it. */
  covering(unitPath) {
    return this.assignments.filter((a) => isWithin(unitPath, a.unitPath));
  }

  /** 'all', 'own' or null for a permission at a unit. */
  level(permission, unitPath) {
    let best = null;
    for (const assignment of this.covering(unitPath)) {
      const level = permissionLevel(assignment.permissions, permission);
      if (level === 'all') return 'all';
      if (level === 'own') best = 'own';
    }
    return best;
  }

  can(permission, unitPath) {
    return this.level(permission, unitPath) !== null;
  }

  /** Units the user works in, plus their ancestors (shown for context, e.g. in breadcrumbs). */
  canSee(unitPath) {
    return this.assignments.some((a) => isWithin(unitPath, a.unitPath) || isWithin(a.unitPath, unitPath));
  }

  /** Does the user hold a permission at, above or anywhere inside the given unit? */
  canAnywhereWithin(permission, unitPath) {
    return this.assignments.some(
      (a) =>
        (isWithin(a.unitPath, unitPath) || isWithin(unitPath, a.unitPath)) &&
        permissionLevel(a.permissions, permission) !== null,
    );
  }

  /** Every grant that applies at a unit. */
  permissionsAt(unitPath) {
    const set = new Set();
    for (const assignment of this.covering(unitPath)) for (const p of assignment.permissions) set.add(p);
    return [...set];
  }

  /** A user may only hand out permissions they hold themselves at that unit. */
  canGrant(permissions, unitPath) {
    const held = this.permissionsAt(unitPath);
    return permissions.every((permission) => coversPermission(held, permission));
  }

  /** The outermost units where a permission applies; use these as prefixes to filter lists. */
  rootsFor(permission) {
    return outermostPaths(
      this.assignments.filter((a) => permissionLevel(a.permissions, permission) !== null).map((a) => a.unitPath),
    );
  }

  groupIds() {
    return [...new Set(this.assignments.map((a) => a.groupId))];
  }
}
