import { z } from 'zod';
import { defineKind, isoTime, optionalReference } from './common.js';

// The AI model and file storage. Neither receives webhooks.

export const ai = defineKind({
  key: 'ai',
  label: 'AI model',
  description: 'The language model behind intake extraction, routing, reply suggestions, summaries and follow-ups.',
  methods: {
    complete: {
      description:
        'One model call. `purpose` names the feature (intake.extract, reply.suggest, meeting.summarise...) for logs and per-purpose limits. ' +
        'With responseFormat "json" the adapter returns parsed JSON in `json` (validated against jsonSchema when given).',
      input: z.strictObject({
        purpose: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/, 'Lowercase words joined by . _ or -'),
        system: z.string().max(100_000).optional(),
        messages: z
          .array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(400_000) }))
          .min(1)
          .max(200)
          .refine((list) => list[0]?.role === 'user', { message: 'The first message must come from the user', path: [0, 'role'] }),
        maxTokens: z.number().int().min(1).max(64_000).default(1024),
        responseFormat: z.enum(['text', 'json']).default('text'),
        jsonSchema: z.record(z.string(), z.unknown()).optional().describe('A JSON Schema for the answer when responseFormat is json'),
        model: z.string().min(1).max(100).optional().describe("Overrides the connection's model"),
        reference: optionalReference,
      }),
      output: z.object({
        text: z.string(),
        json: z.unknown().optional(),
        model: z.string(),
        stopReason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'refusal', 'other']),
        usage: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }),
      }),
    },
  },
  sample: {
    method: 'complete',
    input: () => ({ purpose: 'connection.check', messages: [{ role: 'user', content: 'Reply with the word ready.' }], maxTokens: 20 }),
  },
});

/** Object keys are "folder/name.ext" paths: no leading slash, no "..", no backslashes. */
const objectKey = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => !key.startsWith('/') && !key.includes('\\') && !key.split('/').includes('..') && !key.split('/').includes(''), {
    message: 'Use a relative path such as invoices/2026/INV-1.pdf',
  });

export const storage = defineKind({
  key: 'storage',
  label: 'File storage',
  description: 'Where uploaded and generated files live (agreements, invoices, recordings, imports).',
  methods: {
    putObject: {
      description: 'Store a file, replacing one with the same key.',
      input: z.strictObject({
        key: objectKey,
        body: z.union([z.instanceof(Buffer), z.instanceof(Uint8Array), z.string()]),
        contentType: z.string().min(3).max(255),
        fileName: z.string().min(1).max(255).optional().describe('The download name; defaults to the last part of the key'),
      }),
      output: z.object({ key: z.string(), size: z.number().int().min(0), etag: z.string(), contentType: z.string() }),
    },
    getObject: {
      description: 'Read a file. Throws integration_provider_error with details.reason "not_found" when it does not exist.',
      input: z.strictObject({ key: objectKey }),
      output: z.object({ key: z.string(), body: z.instanceof(Buffer), contentType: z.string(), size: z.number().int().min(0), etag: z.string() }),
    },
    deleteObject: {
      description: 'Remove a file. Removing one that is already gone returns deleted: false.',
      input: z.strictObject({ key: objectKey }),
      output: z.object({ deleted: z.boolean() }),
    },
    getSignedUrl: {
      description: 'A link anyone holding it can download from until it expires. Hand it only to people allowed to see the file.',
      input: z.strictObject({
        key: objectKey,
        expiresInSeconds: z.number().int().min(60).max(86_400).default(900),
        fileName: z.string().min(1).max(255).optional(),
        inline: z.boolean().default(false),
      }),
      output: z.object({ url: z.string().url(), expiresAt: isoTime }),
    },
  },
  sample: {
    method: 'putObject',
    input: () => ({ key: 'connection-check/hello.txt', body: 'Hello from Phoenix', contentType: 'text/plain' }),
  },
});
