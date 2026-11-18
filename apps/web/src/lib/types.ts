// Shapes returned by the API (apps/api). Keep in step with the `present*` functions there.

export type UserStatus = 'invited' | 'active' | 'disabled';
export type UnitStatus = 'active' | 'archived';
/** What the signed-in user can do with a unit: manage it, view it, or only see it as an ancestor. */
export type UnitAccess = 'manage' | 'view' | 'context';
export type PermissionLevel = 'all' | 'own';

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: UserStatus;
  timeZone: string | null;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface OrgUnit {
  id: string;
  parentId: string | null;
  groupId: string;
  type: string;
  name: string;
  code: string;
  /** Materialised path of ancestor ids: "/<group>/<company>/<id>/". */
  path: string;
  depth: number;
  status: UnitStatus;
  profile: Record<string, unknown>;
  access: UnitAccess;
  createdAt: string;
  updatedAt: string;
}

export interface RoleRef {
  id: string;
  key: string;
  name: string;
}

export interface MeAssignment {
  id: string;
  unitId: string;
  unitName: string;
  unitType: string;
  groupId: string;
  role: RoleRef;
}

export interface Grant {
  unitId: string;
  permissions: string[];
}

export interface Me {
  user: User;
  session: { mfaVerified: boolean; mfaPending: boolean; mfaSetupRequired: boolean };
  assignments: MeAssignment[];
  units: OrgUnit[];
  grants: Grant[];
}

export type FieldInput =
  | 'text'
  | 'textarea'
  | 'email'
  | 'url'
  | 'tel'
  | 'number'
  | 'color'
  | 'time'
  | 'select'
  | 'multiselect'
  | 'boolean';

export interface FieldOption {
  value: string | number;
  label: string;
}

/** A form field described by the API, so new fields appear without frontend changes. */
export interface FieldDef {
  key: string;
  label: string;
  input: FieldInput;
  placeholder?: string;
  help?: string;
  options?: FieldOption[];
}

export interface UnitType {
  key: string;
  label: string;
  pluralLabel: string;
  /** Unit types this one may sit under; empty for top-level groups. */
  parents: string[];
  fields: FieldDef[];
}

export interface Assignment {
  id: string;
  role: RoleRef;
  unit: { id: string; name: string; type: string; status: UnitStatus };
}

export interface Person extends User {
  assignments: Assignment[];
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface InviteResult {
  user: Person;
  alreadyHadAccount: boolean;
  /** Only returned outside production, so links can be tried without email. */
  inviteUrl?: string;
}

export interface Role {
  id: string;
  groupId: string | null;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  /** People in the group who have this role somewhere. */
  peopleCount?: number;
  updatedAt: string;
}

export interface PermissionDef {
  key: string;
  label: string;
  description: string | null;
  supportsOwn: boolean;
}

export interface PermissionGroup {
  module: string;
  label: string;
  permissions: PermissionDef[];
}

export interface SettingDefinition {
  key: string;
  module: string;
  category: string;
  label: string;
  description?: string;
  input: FieldInput;
  options?: FieldOption[];
  default: unknown;
  /** Unit types where a value may be set; lower levels inherit. */
  levels: string[];
}

export interface SettingValue {
  value: unknown;
  sourceUnitId: string | null;
  inherited: boolean;
  isDefault: boolean;
  settable: boolean;
}

export interface UnitSettings {
  unitId: string;
  canManage: boolean;
  values: Record<string, SettingValue>;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  unit: { id: string; name: string } | null;
  actor: { id: string; name: string; email: string } | null;
  actorType: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface DeviceSession {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export interface InviteInfo {
  email: string;
  name: string;
  invitedBy: string | null;
}
