import path from 'node:path';
import { createLocalDiskStorage } from '../../providers/azblob/localDisk.js';
import { IntegrationError } from '../errors.js';
import { ai, storage } from '../kinds/platform.js';
import { healthFor, maybeFail } from './common.js';

// Mock AI model and local-disk file storage.

/**
 * A value that fits a JSON Schema, built from the schema alone: the first enum value, the
 * minimum for numbers, false, empty arrays, null for nullable types, objects with every property.
 * Deterministic, so AI features can be developed and tested against the mock.
 */
export function placeholderFor(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  const options = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(options) && options.length) return placeholderFor(options[0], depth + 1);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('null')) return null;
  switch (types[0]) {
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(schema.properties ?? {})) out[key] = placeholderFor(value, depth + 1);
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return '';
    case 'integer':
    case 'number':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

const tokens = (text) => Math.max(1, Math.ceil(text.length / 4));

export function createAiMock(ctx) {
  return {
    kind: ai.key,
    provider: 'mock',
    mock: true,
    async healthCheck() {
      return healthFor(ctx, 'Mock model: answers are generated locally and recorded in the sandbox outbox');
    },
    async complete(input) {
      maybeFail(ctx, 'complete');
      const last = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const model = input.model ?? ctx.config.model ?? 'mock-model';
      let json;
      let text;
      if (input.responseFormat === 'json') {
        json = input.jsonSchema ? placeholderFor(input.jsonSchema) : { mock: true, purpose: input.purpose };
        text = JSON.stringify(json);
      } else {
        const excerpt = last.replace(/\s+/g, ' ').trim().slice(0, 160);
        text = `[mock ${input.purpose}] ${excerpt ? `You said: "${excerpt}"` : 'Ready.'}`;
      }
      const outputTokens = Math.min(input.maxTokens, tokens(text));
      const stopReason = outputTokens < tokens(text) ? 'max_tokens' : 'end_turn';
      if (stopReason === 'max_tokens') text = text.slice(0, outputTokens * 4);
      const inputTokens = tokens((input.system ?? '') + input.messages.map((m) => m.content).join(''));
      await ctx.record({
        operation: 'complete',
        recipient: null,
        subject: input.purpose,
        body: text,
        providerRef: null,
        status: stopReason,
        payload: { purpose: input.purpose, model, maxTokens: input.maxTokens, responseFormat: input.responseFormat, messageCount: input.messages.length, inputTokens, outputTokens },
      });
      return { text, ...(json !== undefined ? { json } : {}), model, stopReason, usage: { inputTokens, outputTokens } };
    },
  };
}

const CONTAINER = 'files';

function storageError(ctx, error, key) {
  if (error?.kind === 'not_found') {
    return new IntegrationError('integration_provider_error', `No file at ${key}`, { kind: storage.key, provider: 'mock', details: { reason: 'not_found' } });
  }
  if (error?.kind === 'validation') {
    return new IntegrationError('integration_invalid_input', error.message, { kind: storage.key, provider: 'mock' });
  }
  return error;
}

/**
 * Local-disk storage (development), built on integrations/providers/azblob/localDisk.js, which
 * has the same behaviour as Azure Blob for the cases the platform uses. Files live under
 * INTEGRATIONS_LOCAL_STORAGE_DIR/<connection id>/; signed links point at the dev download route
 * GET /api/v1/integrations/local-files/:connectionId/... and expire.
 */
export function createStorageMock(ctx) {
  const disk = createLocalDiskStorage(
    {
      rootDir: path.join(ctx.localStorage.rootDir, ctx.connection.id),
      baseUrl: `${ctx.localStorage.baseUrl}/${ctx.connection.id}`,
      signingSecret: ctx.derivedSecret('local-files'),
      defaultContainer: CONTAINER,
      maxDownloadUrlTtlSeconds: 86_400,
    },
    { now: ctx.now },
  );
  let containerReady = false;
  const ensureContainer = async () => {
    if (!containerReady) await disk.createContainer({ container: CONTAINER, ignoreExisting: true });
    containerReady = true;
  };
  const wrap = async (key, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw storageError(ctx, error, key);
    }
  };

  return {
    kind: storage.key,
    provider: 'mock',
    mock: true,
    disk,
    async healthCheck() {
      try {
        await ensureContainer();
      } catch (error) {
        return { ok: false, message: `The storage folder is not writable: ${error.code ?? error.message}` };
      }
      return healthFor(ctx, 'Local disk storage (development): files stay on this server');
    },
    async putObject(input) {
      maybeFail(ctx, 'putObject');
      await ensureContainer();
      const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
      const fileName = input.fileName ?? input.key.split('/').pop();
      const result = await wrap(input.key, () => disk.putBlob({ container: CONTAINER, name: input.key, body, contentType: input.contentType, filename: fileName }));
      await ctx.record({
        operation: 'putObject',
        recipient: null,
        subject: input.key,
        body: `${result.size} bytes, ${input.contentType}`,
        providerRef: input.key,
        status: 'stored',
        payload: { key: input.key, size: result.size, contentType: input.contentType },
      });
      return { key: input.key, size: result.size, etag: result.etag, contentType: input.contentType };
    },
    async getObject({ key }) {
      maybeFail(ctx, 'getObject');
      await ensureContainer();
      const blob = await wrap(key, () => disk.getBlob({ container: CONTAINER, name: key }));
      return { key, body: Buffer.from(blob.body), contentType: blob.contentType, size: blob.body.byteLength, etag: blob.etag };
    },
    async deleteObject({ key }) {
      maybeFail(ctx, 'deleteObject');
      await ensureContainer();
      const result = await wrap(key, () => disk.deleteBlob({ container: CONTAINER, name: key, ignoreMissing: true }));
      return { deleted: result.deleted };
    },
    async getSignedUrl(input) {
      maybeFail(ctx, 'getSignedUrl');
      await ensureContainer();
      const fileName = input.fileName ?? input.key.split('/').pop();
      const link = await wrap(input.key, () =>
        disk.createDownloadUrl({ container: CONTAINER, name: input.key, expiresInSeconds: input.expiresInSeconds, filename: fileName, inline: input.inline }),
      );
      return { url: link.url, expiresAt: link.expiresAt };
    },
  };
}
