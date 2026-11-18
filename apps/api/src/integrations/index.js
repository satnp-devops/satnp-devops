// The integration framework's public API (docs/platform/INTEGRATIONS.md). Feature code imports
// from here, never from framework/ files directly, so the internals can move.
//
//   import { getAdapter, IntegrationError } from '../../integrations/index.js';
//   const email = await getAdapter({ companyId, kind: 'messaging.email' });
//   await email.send({ to: [{ email }], subject, text });

export { getAdapter, adapterForConnection, buildMockWebhookRequest, chooseConnection, mocksAllowed } from './framework/resolve.js';
export { IntegrationError, isIntegrationError, INTEGRATION_ERROR_CODES } from './framework/errors.js';
export { KINDS, KIND_KEYS, KIND_LIST, getKind, requiredMethods } from './framework/kinds/index.js';
export { PROVIDER_LIST, getProvider, providersFor } from './framework/catalog.js';
export { adapterProblems, assertAdapterShape, guardAdapter } from './framework/shape.js';
export { loadChannelIdentities, normalizeChannelIdentity, IDENTITY_TYPES } from './framework/identities.js';
export { buildMockWebhook, MOCK_SIGNATURE_HEADER } from './framework/mocks/index.js';
