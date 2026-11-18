import { assertFields, configSchema, credentialsSchema, publicFields } from './fields.js';
import { KINDS, KIND_LIST } from './kinds/index.js';
import { MOCK_FACTORIES, SIMULATE_OPTIONS } from './mocks/index.js';
import { createProviderStub } from './stubs.js';
import { createClaudeAdapter } from '../ai/anthropic.js';

/**
 * The provider catalogue: which providers implement each kind, the fields their connection form
 * asks for, and how to build their adapter. The architecture names no providers; these are the
 * choices for Phoenix (India first, international where needed):
 *
 *   messaging.whatsapp  WhatsApp Cloud API (Meta)
 *   messaging.email     SendGrid
 *   messaging.sms       MSG91 (DLT templates)
 *   calling             Exotel
 *   meetings            Zoom, Google Meet
 *   calendar            Google Calendar, Microsoft 365
 *   payments            Razorpay (INR), Stripe (international)
 *   esign               Digio
 *   ai                  Anthropic Claude
 *   storage             Azure Blob Storage (local disk in development)
 *
 * Every kind also has a `mock` provider (works without accounts; see mocks/common.js).
 * Real providers are stubs until their adapters are written (stubs.js); `client` names the
 * provider client already in integrations/providers/ that the adapter will wrap.
 */

const secret = (key, label, extra = {}) => ({ key, label, input: 'text', secret: true, ...extra });
const webhookSecretField = (help) => secret('webhookSecret', 'Webhook secret', { help });

const mockFields = (kind, extra = []) => [
  {
    key: 'simulate',
    label: 'Behaviour',
    input: 'select',
    options: SIMULATE_OPTIONS,
    default: 'healthy',
    help: 'Make the mock fail on purpose to try error handling.',
  },
  ...extra,
  ...(KINDS[kind].webhooks
    ? [secret('webhookSecret', 'Webhook signing secret', { help: 'Optional. Signs mock webhooks (x-phoenix-mock-signature); a per-connection secret is derived when blank.' })]
    : []),
];

const MOCK_EXTRA_FIELDS = {
  'messaging.whatsapp': [{ key: 'displayPhoneNumber', label: 'Number shown to customers', input: 'tel', placeholder: '+919000010001' }],
  'messaging.email': [
    { key: 'fromEmail', label: 'Sender email', input: 'email', placeholder: 'admissions@example.com' },
    { key: 'fromName', label: 'Sender name', input: 'text', placeholder: 'SatnPaper Admissions' },
  ],
  'messaging.sms': [{ key: 'senderId', label: 'Sender id', input: 'text', placeholder: 'PHXSAT', pattern: { regex: /^[A-Z]{6}$/, message: 'Six capital letters' } }],
  calling: [
    { key: 'callerId', label: 'Caller id', input: 'tel', placeholder: '+918000000000' },
    { key: 'record', label: 'Record calls', input: 'boolean', placeholder: 'Record calls' },
  ],
  ai: [{ key: 'model', label: 'Model name shown in results', input: 'text', placeholder: 'mock-model' }],
};

const GUID = { regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message: 'A GUID such as 2f6b...-...' };

const REAL_PROVIDERS = [
  {
    key: 'whatsapp_cloud',
    kind: 'messaging.whatsapp',
    label: 'WhatsApp Cloud API',
    vendor: 'Meta',
    description: 'Official WhatsApp Business Platform hosted by Meta.',
    client: null,
    docs: null,
    fields: [
      { key: 'phoneNumberId', label: 'Phone number id', input: 'text', required: true, pattern: { regex: /^\d{5,20}$/, message: 'Digits from WhatsApp Manager › API setup' } },
      { key: 'businessAccountId', label: 'WhatsApp Business Account id', input: 'text', required: true, pattern: { regex: /^\d{5,20}$/, message: 'Digits' } },
      { key: 'displayPhoneNumber', label: 'Display number', input: 'tel', placeholder: '+919876543210' },
      { key: 'apiVersion', label: 'Graph API version', input: 'text', placeholder: 'v23.0', help: 'Leave blank for the adapter default.' },
      secret('accessToken', 'Access token', { required: true, help: 'A permanent system-user token with whatsapp_business_messaging.' }),
      secret('appSecret', 'App secret', { required: true, help: 'Verifies X-Hub-Signature-256 on webhooks.' }),
      secret('webhookVerifyToken', 'Webhook verify token', { help: 'The value you enter as "Verify token" in the Meta app.' }),
    ],
  },
  {
    key: 'sendgrid',
    kind: 'messaging.email',
    label: 'SendGrid',
    vendor: 'Twilio SendGrid',
    description: 'Transactional email with delivery events and inbound parse.',
    client: 'integrations/providers/sendgrid',
    docs: 'docs/providers/sendgrid.md',
    fields: [
      { key: 'fromEmail', label: 'Sender email', input: 'email', required: true, help: 'A verified sender or an address on an authenticated domain.' },
      { key: 'fromName', label: 'Sender name', input: 'text' },
      { key: 'region', label: 'Region', input: 'select', options: [{ value: 'global', label: 'Global' }, { value: 'eu', label: 'EU' }], default: 'global' },
      { key: 'sandboxMode', label: 'Sandbox mode', input: 'boolean', placeholder: 'Validate but never deliver', default: false },
      { key: 'eventWebhookPublicKey', label: 'Event webhook public key', input: 'textarea', help: 'From Settings › Mail Settings › Signed Event Webhook.' },
      secret('apiKey', 'API key', { required: true, pattern: { regex: /^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, message: 'SendGrid keys start with SG.' } }),
    ],
  },
  {
    key: 'msg91',
    kind: 'messaging.sms',
    label: 'MSG91',
    vendor: 'MSG91',
    description: 'SMS on Indian routes with DLT-registered templates.',
    client: 'integrations/providers/msg91',
    docs: 'docs/providers/msg91.md',
    fields: [
      { key: 'senderId', label: 'Sender id (DLT header)', input: 'text', required: true, pattern: { regex: /^[A-Z]{6}$/, message: 'Six capital letters' } },
      { key: 'principalEntityId', label: 'DLT principal entity id', input: 'text', pattern: { regex: /^\d{19}$/, message: '19 digits' } },
      { key: 'defaultCountryCode', label: 'Default country code', input: 'text', default: '91', pattern: { regex: /^\d{1,3}$/, message: 'Digits, e.g. 91' } },
      secret('authKey', 'Auth key', { required: true }),
      webhookSecretField('Sent by MSG91 as a header on delivery reports; at least 16 characters.'),
    ],
  },
  {
    key: 'exotel',
    kind: 'calling',
    label: 'Exotel',
    vendor: 'Exotel',
    description: 'Click-to-call, call records and recordings on Indian numbers.',
    client: 'integrations/providers/exotel',
    docs: 'docs/providers/exotel.md',
    fields: [
      { key: 'accountSid', label: 'Account SID', input: 'text', required: true, pattern: { regex: /^[A-Za-z0-9_-]{2,64}$/, message: 'From API Settings' } },
      { key: 'region', label: 'Cluster', input: 'select', options: [{ value: 'singapore', label: 'Singapore' }, { value: 'mumbai', label: 'Mumbai' }], default: 'singapore' },
      { key: 'callerId', label: 'ExoPhone (caller id)', input: 'tel', required: true },
      { key: 'record', label: 'Record calls', input: 'boolean', placeholder: 'Record calls', default: false },
      secret('apiKey', 'API key', { required: true }),
      secret('apiToken', 'API token', { required: true }),
      webhookSecretField('Signs our status-callback URLs.'),
    ],
  },
  {
    key: 'zoom',
    kind: 'meetings',
    label: 'Zoom',
    vendor: 'Zoom',
    description: 'Meetings through a Server-to-Server OAuth app.',
    client: 'integrations/providers/zoom',
    docs: 'docs/providers/zoom.md',
    fields: [
      { key: 'accountId', label: 'Account id', input: 'text', required: true },
      { key: 'clientId', label: 'Client id', input: 'text', required: true },
      { key: 'defaultHostUserId', label: 'Default host', input: 'text', default: 'me', help: 'A Zoom user id or email; "me" is the app owner.' },
      secret('clientSecret', 'Client secret', { required: true }),
      secret('webhookSecretToken', 'Webhook secret token', { help: 'From the app’s Feature › Event subscriptions.' }),
    ],
  },
  {
    key: 'google_meet',
    kind: 'meetings',
    label: 'Google Meet',
    vendor: 'Google Workspace',
    description: 'Meet links and attendance through a Workspace service account.',
    client: 'integrations/providers/google',
    docs: 'docs/providers/google.md',
    fields: [
      { key: 'delegatedUser', label: 'Act as user', input: 'email', required: true, help: 'A Workspace user the service account impersonates (domain-wide delegation).' },
      secret('serviceAccountJson', 'Service account key (JSON)', { input: 'textarea', required: true }),
    ],
  },
  {
    key: 'google_calendar',
    kind: 'calendar',
    label: 'Google Calendar',
    vendor: 'Google Workspace',
    description: 'Busy times and events through a Workspace service account.',
    client: 'integrations/providers/google',
    docs: 'docs/providers/google.md',
    fields: [
      { key: 'delegatedUser', label: 'Act as user', input: 'email', required: true },
      { key: 'calendarId', label: 'Default calendar', input: 'text', default: 'primary' },
      secret('serviceAccountJson', 'Service account key (JSON)', { input: 'textarea', required: true }),
      secret('channelSecret', 'Push channel secret', { help: 'At least 32 characters; signs push-notification channel tokens.', pattern: { regex: /^.{32,}$/, message: 'At least 32 characters' } }),
    ],
  },
  {
    key: 'microsoft_365',
    kind: 'calendar',
    label: 'Microsoft 365',
    vendor: 'Microsoft',
    description: 'Outlook calendars through Microsoft Graph (application permissions).',
    client: 'integrations/providers/msgraph',
    docs: 'docs/providers/msgraph.md',
    fields: [
      { key: 'tenantId', label: 'Directory (tenant) id', input: 'text', required: true, pattern: GUID },
      { key: 'clientId', label: 'Application (client) id', input: 'text', required: true, pattern: GUID },
      secret('clientSecret', 'Client secret', { required: true }),
      secret('webhookSecret', 'Subscription client state', { required: true, help: 'At least 32 characters; Graph echoes it on every notification.', pattern: { regex: /^.{32,}$/, message: 'At least 32 characters' } }),
    ],
  },
  {
    key: 'razorpay',
    kind: 'payments',
    label: 'Razorpay',
    vendor: 'Razorpay',
    description: 'INR payments: UPI, cards, netbanking, EMI, payment links and subscriptions.',
    client: 'integrations/providers/razorpay',
    docs: 'docs/providers/razorpay.md',
    fields: [
      { key: 'keyId', label: 'Key id', input: 'text', required: true, pattern: { regex: /^rzp_(test|live)_[A-Za-z0-9]+$/, message: 'Starts with rzp_test_ or rzp_live_' } },
      { key: 'accountId', label: 'Account id', input: 'text', pattern: { regex: /^acc_[A-Za-z0-9]+$/, message: 'Starts with acc_' }, help: 'Checked on webhooks, so an event is never credited to another company.' },
      secret('keySecret', 'Key secret', { required: true }),
      webhookSecretField('The secret set on the Razorpay webhook.'),
    ],
  },
  {
    key: 'stripe',
    kind: 'payments',
    label: 'Stripe',
    vendor: 'Stripe',
    description: 'International card payments, payment links and subscriptions.',
    client: 'integrations/providers/stripe',
    docs: 'docs/providers/stripe.md',
    fields: [
      { key: 'accountId', label: 'Connected account id', input: 'text', pattern: { regex: /^acct_[A-Za-z0-9]+$/, message: 'Starts with acct_' }, help: 'Only for Stripe Connect.' },
      secret('secretKey', 'Secret key', { required: true, pattern: { regex: /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, message: 'Starts with sk_ or rk_' } }),
      secret('webhookSecret', 'Webhook signing secret', { pattern: { regex: /^whsec_[A-Za-z0-9]+$/, message: 'Starts with whsec_' } }),
    ],
  },
  {
    key: 'digio',
    kind: 'esign',
    label: 'Digio',
    vendor: 'Digio',
    description: 'Aadhaar eSign and electronic signatures.',
    client: 'integrations/providers/digio',
    docs: 'docs/providers/digio.md',
    fields: [
      { key: 'environment', label: 'Environment', input: 'select', options: [{ value: 'sandbox', label: 'Sandbox' }, { value: 'production', label: 'Production' }], default: 'sandbox' },
      { key: 'clientId', label: 'Client id', input: 'text', required: true },
      secret('clientSecret', 'Client secret', { required: true }),
      webhookSecretField('The secret of the Digio webhook group.'),
    ],
  },
  {
    key: 'anthropic',
    kind: 'ai',
    label: 'Anthropic Claude',
    vendor: 'Anthropic',
    description: 'Claude models through the Messages API.',
    client: 'integrations/ai',
    docs: 'docs/platform/AI.md',
    implemented: true,
    create: (ctx) => createClaudeAdapter(ctx),
    fields: [
      {
        key: 'model',
        label: 'Model',
        input: 'select',
        options: [
          { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (default)' },
          { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
          { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
        ],
        default: 'claude-opus-5-5',
      },
      {
        key: 'effort',
        label: 'Effort',
        input: 'select',
        options: [
          { value: 'low', label: 'Low (fastest, cheapest)' },
          { value: 'medium', label: 'Medium (default)' },
          { value: 'high', label: 'High (most thorough)' },
        ],
        default: 'medium',
        help: 'How much the model thinks before answering. Extraction and routing work well on low or medium.',
      },
      secret('apiKey', 'API key', { required: true, pattern: { regex: /^sk-ant-[A-Za-z0-9_-]+$/, message: 'Starts with sk-ant-' } }),
    ],
  },
  {
    key: 'azure_blob',
    kind: 'storage',
    label: 'Azure Blob Storage',
    vendor: 'Microsoft Azure',
    description: 'Private containers with short-lived download links.',
    client: 'integrations/providers/azblob',
    docs: 'docs/providers/azblob.md',
    fields: [
      { key: 'accountName', label: 'Storage account', input: 'text', required: true, pattern: { regex: /^[a-z0-9]{3,24}$/, message: '3 to 24 lowercase letters or digits' } },
      { key: 'container', label: 'Container', input: 'text', required: true, pattern: { regex: /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/, message: 'Lowercase letters, digits and single hyphens' } },
      {
        key: 'authType',
        label: 'Sign in with',
        input: 'select',
        options: [
          { value: 'managedIdentity', label: 'Managed identity (recommended)' },
          { value: 'sharedKey', label: 'Account key' },
        ],
        default: 'managedIdentity',
      },
      secret('accountKey', 'Account key', { help: 'Only for "Account key" sign-in.' }),
    ],
  },
];

function mockProvider(kind) {
  return {
    key: 'mock',
    kind: kind.key,
    label: kind.key === 'storage' ? 'Local disk (development)' : `Mock ${kind.label}`,
    vendor: 'Phoenix',
    description:
      kind.key === 'storage'
        ? 'Files on this server’s disk with signed download links. For development and tests.'
        : 'Works without an account: calls are recorded in the sandbox outbox. For development and tests.',
    client: null,
    docs: 'docs/platform/INTEGRATIONS.md',
    mock: true,
    implemented: true,
    fields: mockFields(kind.key, MOCK_EXTRA_FIELDS[kind.key]),
    create: (ctx) => MOCK_FACTORIES[kind.key](ctx),
  };
}

function finish(provider) {
  assertFields(`${provider.kind}:${provider.key}`, provider.fields);
  const kind = KINDS[provider.kind];
  if (!kind) throw new Error(`Provider ${provider.key} has an unknown kind ${provider.kind}`);
  const full = {
    mock: false,
    implemented: false,
    create: (_ctx) => createProviderStub(kind, provider),
    ...provider,
  };
  return Object.freeze({
    ...full,
    configSchema: configSchema(full.fields),
    configUpdateSchema: configSchema(full.fields, { partial: true }),
    credentialsSchema: credentialsSchema(full.fields),
    credentialsUpdateSchema: credentialsSchema(full.fields, { partial: true }),
  });
}

export const PROVIDER_LIST = Object.freeze([...KIND_LIST.map(mockProvider), ...REAL_PROVIDERS].map(finish));

const byKey = new Map(PROVIDER_LIST.map((p) => [`${p.kind}:${p.key}`, p]));

export function getProvider(kind, key) {
  return byKey.get(`${kind}:${key}`) ?? null;
}

export function providersFor(kind) {
  return PROVIDER_LIST.filter((p) => p.kind === kind);
}

/** The kinds and their providers as the API sends them (GET /integrations/kinds). */
export function presentCatalog({ mocksAllowed }) {
  return KIND_LIST.map((kind) => ({
    key: kind.key,
    label: kind.label,
    description: kind.description,
    methods: Object.keys(kind.methods),
    webhooks: kind.webhooks ? Object.keys(kind.webhooks.events) : [],
    providers: providersFor(kind.key)
      .filter((p) => mocksAllowed || !p.mock)
      .map((p) => ({
        key: p.key,
        label: p.label,
        vendor: p.vendor,
        description: p.description,
        mock: p.mock,
        implemented: p.implemented,
        docs: p.docs,
        fields: publicFields(p.fields),
      })),
  }));
}
