import { IntegrationError } from './errors.js';

/**
 * The adapter for a real provider whose implementation hasn't been written yet. Connections can
 * be created for it (credentials are validated against its fields and stored encrypted), but every
 * call throws integration_not_implemented, its health check reports that, and webhooks are refused.
 *
 * To implement a provider, replace `create` in catalog.js with a function that builds the
 * provider's client (integrations/providers/<client>/) from ctx.config and ctx.credentials and
 * maps it onto the kind's methods. docs/platform/INTEGRATIONS.md, "Adding a provider", has the steps.
 */
export function createProviderStub(kind, provider) {
  const message = `${provider.label} is not implemented yet. Its credentials are saved; use a mock connection until the adapter ships.`;
  const fail = (method) => async () => {
    throw new IntegrationError('integration_not_implemented', message, {
      kind: kind.key,
      provider: provider.key,
      details: { method, client: provider.client ?? null },
    });
  };
  const adapter = { kind: kind.key, provider: provider.key, mock: false };
  adapter.healthCheck = async () => ({ ok: false, message, details: { notImplemented: true } });
  for (const name of Object.keys(kind.methods)) adapter[name] = fail(name);
  if (kind.webhooks) {
    adapter.verifyWebhook = async () => ({ ok: false, reason: 'not_implemented' });
    adapter.parseWebhook = fail('parseWebhook');
    adapter.webhookChallenge = async () => null;
  }
  return adapter;
}
