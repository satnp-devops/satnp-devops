import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { KIND_LIST, getProvider } from '../../integrations/index.js';
import { encryptCredentials } from '../../integrations/framework/credentials.js';
import { normalizeChannelIdentity } from '../../integrations/framework/identities.js';

// Integration framework demo data (docs/platform/INTEGRATIONS.md): a mock connection of every
// kind for every company (each company's default, so the whole app works without accounts), one
// WhatsApp number shared by SatnPaper and Pi Vector on a group connection, and the channel
// identities intake routes with. Numbers use the fake +91 90000 1xxxx range. Skipped when the
// group already has connections.

const GROUP_CODE = 'phoenix';

// Per company: the mock's settings and the channels it owns.
const COMPANIES = {
  satnpaper: {
    code: 'satnpaper',
    whatsapp: '+919000010001',
    email: { fromEmail: 'admissions@satnpaper.example.com', fromName: 'SatnPaper Admissions' },
    senderId: 'SATNPR',
    callerId: '+918000010001',
    channels: [
      { type: 'website_form', identity: 'satnpaper.example.com/sat-enquiry', label: 'SAT enquiry form', productLine: 'sat_group_batch' },
      { type: 'facebook_lead_ad', identity: '104500000000001', label: 'SatnPaper Facebook page' },
      { type: 'partner_referral', identity: 'satnpaper.example.com/r/', label: 'Partner referral links' },
    ],
  },
  pivector: {
    code: 'pi-vector',
    whatsapp: '+919000010002',
    email: { fromEmail: 'hello@pivector.example.com', fromName: 'Pi Vector' },
    senderId: 'PIVCTR',
    callerId: '+918000010002',
    channels: [
      { type: 'website_form', identity: 'pivector.example.com/contact', label: 'Website contact form' },
      { type: 'facebook_lead_ad', identity: '104500000000002', label: 'Pi Vector Facebook page' },
      { type: 'partner_referral', identity: 'pivector.example.com/r/', label: 'Partner referral links' },
    ],
  },
  excel: {
    code: 'excel',
    whatsapp: '+919000010003',
    email: { fromEmail: 'admissions@excel.example.com', fromName: 'Excel Admissions' },
    senderId: 'EXCELA',
    callerId: '+918000010003',
    channels: [{ type: 'website_form', identity: 'excel.example.com/enquire', label: 'Website enquiry form' }],
  },
};

const SHARED_WHATSAPP = '+919000019999';

function mockConfig(kind, company) {
  switch (kind) {
    case 'messaging.whatsapp':
      return { displayPhoneNumber: company.whatsapp };
    case 'messaging.email':
      return company.email;
    case 'messaging.sms':
      return { senderId: company.senderId };
    case 'calling':
      return { callerId: company.callerId, record: true };
    default:
      return {};
  }
}

/** A mock connection row with its config checked by the provider's fields (fills the defaults). */
function connectionRow({ group, owner, kind, name, config, now }) {
  const provider = getProvider(kind.key, 'mock');
  const parsed = provider.configSchema.parse(config);
  const clean = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined && value !== ''));
  const id = randomUUID();
  return {
    id,
    group_id: group.id,
    unit_id: owner.id,
    kind: kind.key,
    provider: 'mock',
    name,
    config: JSON.stringify(clean),
    credentials_enc: encryptCredentials(id, {}, env.encryptionKey),
    credential_hints: JSON.stringify({}),
    status: 'active',
    health_status: 'healthy',
    health_message: 'Mock connection: calls are recorded in the sandbox outbox and nothing leaves this server',
    last_checked_at: now,
    created_at: now,
    updated_at: now,
  };
}

function identityRow({ group, type, identity, label, companyId = null, companyIds = [], connectionId = null, productLineId = null, now }) {
  const shared = companyIds.length > 1;
  return {
    group_id: group.id,
    connection_id: connectionId,
    type,
    identity,
    identity_normalized: normalizeChannelIdentity(type, identity),
    label,
    company_id: shared ? null : companyId,
    product_line_id: productLineId,
    shared,
    company_ids: shared ? companyIds : [],
    created_at: now,
    updated_at: now,
  };
}

export async function seed(knex) {
  const group = await knex('org_units').whereNull('parent_id').where({ code: GROUP_CODE }).first();
  if (!group) {
    console.log('Integration demo data needs the Phoenix group: run the foundation seed first.');
    return;
  }
  if (await knex('integration_connections').where({ group_id: group.id }).first('id')) {
    console.log('Integration demo data is already there.');
    return;
  }
  const units = await knex('org_units').where({ root_id: group.id, type: 'company' });
  const now = new Date();
  const connections = [];
  const links = [];
  const identities = [];
  const byCompany = {};

  for (const [key, company] of Object.entries(COMPANIES)) {
    const unit = units.find((u) => u.code === company.code);
    if (!unit) continue;
    byCompany[key] = { unit, connections: {} };
    for (const kind of KIND_LIST) {
      const row = connectionRow({ group, owner: unit, kind, name: `Mock ${kind.label}`, config: mockConfig(kind.key, company), now });
      connections.push(row);
      links.push({ connection_id: row.id, company_id: unit.id, kind: kind.key, is_default: true, created_at: now });
      byCompany[key].connections[kind.key] = row;
    }
  }

  // One WhatsApp number shared by SatnPaper and Pi Vector: a group connection, not their default.
  const sharedCompanies = [byCompany.satnpaper?.unit, byCompany.pivector?.unit].filter(Boolean);
  const whatsappKind = KIND_LIST.find((k) => k.key === 'messaging.whatsapp');
  const shared = connectionRow({
    group,
    owner: group,
    kind: whatsappKind,
    name: 'Group WhatsApp (mock)',
    config: { displayPhoneNumber: SHARED_WHATSAPP },
    now,
  });
  if (sharedCompanies.length === 2) {
    connections.push(shared);
    for (const unit of sharedCompanies) links.push({ connection_id: shared.id, company_id: unit.id, kind: whatsappKind.key, is_default: false, created_at: now });
  }

  const productLines = await knex('product_lines').whereIn('company_id', Object.values(byCompany).map((c) => c.unit.id)).select('id', 'company_id', 'key');
  for (const [key, company] of Object.entries(COMPANIES)) {
    const entry = byCompany[key];
    if (!entry) continue;
    const { unit, connections: own } = entry;
    const base = { group, companyId: unit.id, now };
    identities.push(
      identityRow({ ...base, type: 'whatsapp', identity: company.whatsapp, label: `${unit.name} WhatsApp`, connectionId: own['messaging.whatsapp'].id }),
      identityRow({ ...base, type: 'email', identity: company.email.fromEmail, label: `${unit.name} admissions inbox`, connectionId: own['messaging.email'].id }),
      identityRow({ ...base, type: 'phone_call', identity: company.callerId, label: `${unit.name} call line`, connectionId: own.calling.id }),
    );
    for (const channel of company.channels) {
      const line = channel.productLine ? productLines.find((p) => p.company_id === unit.id && p.key === channel.productLine) : null;
      identities.push(identityRow({ ...base, type: channel.type, identity: channel.identity, label: channel.label, productLineId: line?.id ?? null }));
    }
  }
  if (sharedCompanies.length === 2) {
    identities.push(
      identityRow({
        group,
        type: 'whatsapp',
        identity: SHARED_WHATSAPP,
        label: 'Group helpline (shared)',
        companyIds: sharedCompanies.map((u) => u.id),
        connectionId: shared.id,
        now,
      }),
    );
  }

  await knex.transaction(async (trx) => {
    await trx('integration_connections').insert(connections);
    await trx('integration_connection_companies').insert(links);
    await trx('channel_identities').insert(identities);
  });
  console.log(`Integrations: ${connections.length} mock connections and ${identities.length} channel identities.`);
}
