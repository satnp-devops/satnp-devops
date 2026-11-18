import { toFieldErrors } from '../../lib/validate.js';
import { IntegrationError, isIntegrationError } from './errors.js';
import { requiredMethods } from './kinds/index.js';

/**
 * What is wrong with an adapter object for a kind, as sentences (empty when it fits).
 * An adapter is a plain object: { kind, provider, mock, healthCheck(), ...the kind's methods,
 * and verifyWebhook/parseWebhook/webhookChallenge when the kind has webhooks }.
 */
export function adapterProblems(kind, adapter) {
  if (!adapter || typeof adapter !== 'object') return ['The adapter must be an object'];
  const problems = [];
  if (adapter.kind !== kind.key) problems.push(`kind must be "${kind.key}" (got "${adapter.kind}")`);
  if (typeof adapter.provider !== 'string' || !adapter.provider) problems.push('provider must be a non-empty string');
  if (typeof adapter.mock !== 'boolean') problems.push('mock must be true or false');
  for (const name of Object.keys(requiredMethods(kind))) {
    if (typeof adapter[name] !== 'function') problems.push(`${name}() is missing`);
  }
  return problems;
}

/** Throw when an adapter doesn't implement its kind. Called whenever an adapter is built. */
export function assertAdapterShape(kind, adapter) {
  const problems = adapterProblems(kind, adapter);
  if (problems.length > 0) {
    const label = adapter?.provider ? `${adapter.provider} (${kind.key})` : kind.key;
    throw new Error(`Adapter ${label} does not match its interface: ${problems.join('; ')}`);
  }
  return adapter;
}

/**
 * Wrap an adapter so every call is checked against the kind's schemas:
 *   - inputs are parsed (defaults filled, unknown keys refused) before the provider sees them,
 *     and a bad call throws integration_invalid_input with field errors under "input.";
 *   - outputs are checked when `checkOutputs` is on (default outside production), so a mock or a
 *     provider adapter that drifts from the interface fails loudly in development and tests;
 *   - anything a provider throws that isn't an IntegrationError becomes integration_provider_error
 *     (the original error stays on `cause` for logs; its message is not shown to people).
 */
export function guardAdapter(kind, adapter, { checkOutputs = true, onCall } = {}) {
  assertAdapterShape(kind, adapter);
  const guarded = { kind: adapter.kind, provider: adapter.provider, mock: adapter.mock };
  for (const [name, method] of Object.entries(requiredMethods(kind))) {
    guarded[name] = async (rawInput) => {
      let input;
      if (method.input) {
        const parsed = method.input.safeParse(rawInput ?? {});
        if (!parsed.success) {
          throw new IntegrationError('integration_invalid_input', `The ${name} call is missing or has invalid fields`, {
            details: toFieldErrors(parsed.error, 'input'),
            kind: kind.key,
            provider: adapter.provider,
          });
        }
        input = parsed.data;
      }
      const started = Date.now();
      let result;
      try {
        result = await adapter[name](input);
      } catch (error) {
        onCall?.({ method: name, ok: false, ms: Date.now() - started, error });
        if (isIntegrationError(error)) throw error;
        throw new IntegrationError('integration_provider_error', `${adapter.provider} could not complete ${name}`, {
          retryable: error?.retryable === true,
          kind: kind.key,
          provider: adapter.provider,
          cause: error,
        });
      }
      onCall?.({ method: name, ok: true, ms: Date.now() - started });
      if (checkOutputs && method.output) {
        const checked = method.output.safeParse(result);
        if (!checked.success) {
          const fields = toFieldErrors(checked.error, 'output').map((e) => `${e.path}: ${e.message}`);
          throw new Error(`${adapter.provider} ${name}() returned a result that breaks the ${kind.key} interface: ${fields.join('; ')}`);
        }
      }
      return result;
    };
  }
  return Object.freeze(guarded);
}
