// Response shapes of the integration framework API (apps/api/src/modules/integrations,
// docs/platform/INTEGRATIONS.md). Only this area uses them, so they live here rather than in lib/types.ts.

import type { FieldInput } from '@/lib/types';

export type KindKey =
  | 'messaging.whatsapp'
  | 'messaging.email'
  | 'messaging.sms'
  | 'calling'
  | 'meetings'
  | 'calendar'
  | 'payments'
  | 'esign'
  | 'ai'
  | 'storage';

/** A provider's connection-form field. Secret fields are stored encrypted and never sent back. */
export interface ProviderField {
  key: string;
  label: string;
  input: FieldInput;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  default?: string | number | boolean;
}

export interface ProviderInfo {
  key: string;
  label: string;
  vendor: string;
  description: string;
  mock: boolean;
  /** False for providers whose adapter is still a stub: credentials save, calls fail with "not implemented". */
  implemented: boolean;
  docs: string | null;
  fields: ProviderField[];
}

export interface KindInfo {
  key: KindKey;
  label: string;
  description: string;
  methods: string[];
  webhooks: string[];
  providers: ProviderInfo[];
}

export interface IntegrationCatalog {
  mocksAllowed: boolean;
  kinds: KindInfo[];
  identityTypes: Array<{ key: string; hint: string }>;
  /** Which identity types a connection of each kind can carry. */
  kindIdentityTypes: Partial<Record<KindKey, string[]>>;
}

export interface UnitRef {
  id: string;
  name: string;
  type: string;
}

export type HealthStatus = 'unknown' | 'healthy' | 'failing';

export interface Connection {
  id: string;
  kind: KindKey;
  provider: string;
  providerLabel: string;
  mock: boolean;
  implemented: boolean;
  name: string;
  owner: UnitRef | null;
  /** Owned by the group and used by several companies. */
  shared: boolean;
  companies: Array<{ id: string; name: string; isDefault: boolean }>;
  status: 'active' | 'disabled';
  health: { status: HealthStatus; message: string | null; checkedAt: string | null; lastError: string | null };
  config: Record<string, unknown>;
  /** Secret field → hint such as "••••3f9a". */
  credentials: Record<string, string>;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionTest {
  result: { ok: boolean; message: string };
  connection: Connection;
}

export interface TryOutcome {
  method: string;
  ok: boolean;
  input: unknown;
  output: unknown;
  error: { code: string; message: string } | null;
}

export interface ChannelIdentity {
  id: string;
  type: string;
  identity: string;
  normalized: string;
  label: string | null;
  company: UnitRef | null;
  shared: boolean;
  companies: UnitRef[];
  productLineId: string | null;
  connection: { id: string; name: string; kind: KindKey; provider: string } | null;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxMessage {
  id: string;
  kind: KindKey;
  provider: string;
  operation: string;
  connection: { id: string; name: string | null } | null;
  company: UnitRef | null;
  /** Masked for people without contacts.view_pii. */
  recipient: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  providerRef: string | null;
  reference: string | null;
  payload: unknown;
  createdAt: string;
}

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  unit: UnitRef | null;
  scopes: string[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  createdBy: { id: string; name: string | null } | null;
  revokedAt: string | null;
}

/** Returned once, when the key is created. */
export interface CreatedApiKey extends ApiKey {
  secret: string;
}

export interface ScopeGroup {
  module: string;
  label: string;
  permissions: Array<{ key: string; label: string; description: string | null }>;
}
