import { z } from 'zod';

// Response shapes for the OpenAPI document (docs/platform/OPENAPI.md section 4). They match
// present.js; apps/web/src/lib/integrations/types.ts mirrors them for the web app.

const unitRef = z.object({ id: z.uuid(), name: z.string(), type: z.string() });
const time = z.iso.datetime();

export const connectionSchema = z
  .object({
    id: z.uuid(),
    kind: z.string().describe('Adapter kind, e.g. messaging.whatsapp'),
    provider: z.string().describe('Provider key, e.g. razorpay or mock'),
    providerLabel: z.string(),
    mock: z.boolean(),
    implemented: z.boolean().describe('False while the provider adapter is a stub (calls fail with integration_not_implemented)'),
    name: z.string(),
    owner: unitRef.nullable(),
    shared: z.boolean().describe('Owned by the group and used by several companies'),
    companies: z.array(z.object({ id: z.uuid(), name: z.string(), isDefault: z.boolean() })),
    status: z.enum(['active', 'disabled']),
    health: z.object({
      status: z.enum(['unknown', 'healthy', 'failing']),
      message: z.string().nullable(),
      checkedAt: time.nullable(),
      lastError: z.string().nullable(),
    }),
    config: z.record(z.string(), z.unknown()).describe('Non-secret settings'),
    credentials: z.record(z.string(), z.string()).describe('Secret field → hint such as ••••3f9a; values are never returned'),
    canManage: z.boolean(),
    createdAt: time,
    updatedAt: time,
  })
  .meta({ id: 'IntegrationConnection', description: "A company's (or the group's) connection to a provider" });

export const identitySchema = z
  .object({
    id: z.uuid(),
    type: z.string().describe('Intake channel type, e.g. whatsapp or website_form'),
    identity: z.string(),
    normalized: z.string(),
    label: z.string().nullable(),
    company: unitRef.nullable(),
    shared: z.boolean(),
    companies: z.array(unitRef),
    productLineId: z.uuid().nullable(),
    connection: z.object({ id: z.uuid(), name: z.string(), kind: z.string(), provider: z.string() }).nullable(),
    canManage: z.boolean(),
    createdAt: time,
    updatedAt: time,
  })
  .meta({ id: 'ChannelIdentity', description: 'A number, inbox, form, page or link enquiries arrive on' });

export const sandboxMessageSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    provider: z.string(),
    operation: z.string().describe('The adapter method, e.g. sendTemplate'),
    connection: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
    company: unitRef.nullable(),
    recipient: z.string().nullable().describe('Masked without contacts.view_pii'),
    subject: z.string().nullable(),
    body: z.string().nullable(),
    status: z.string().nullable(),
    providerRef: z.string().nullable(),
    reference: z.string().nullable(),
    payload: z.unknown().describe('null without contacts.view_pii'),
    createdAt: time,
  })
  .meta({ id: 'SandboxMessage', description: 'What a mock adapter "sent"' });

export const testResultSchema = z.object({ result: z.object({ ok: z.boolean(), message: z.string() }), connection: connectionSchema });

export const tryResultSchema = z.object({
  method: z.string(),
  ok: z.boolean(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
