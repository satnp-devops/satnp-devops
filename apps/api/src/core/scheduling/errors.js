/**
 * Errors raised by the scheduling engine for bad input. Routes validate request bodies with the
 * exported zod schemas first (parseOrThrow → 422); this error covers direct calls from code.
 */
export class SchedulingInputError extends Error {
  /**
   * @param {string} message
   * @param {{ path: string, message: string }[]} [issues]
   */
  constructor(message, issues = []) {
    super(message);
    this.name = 'SchedulingInputError';
    this.code = 'scheduling_invalid_input';
    this.issues = issues;
  }
}

/**
 * Parse with a zod schema, throwing SchedulingInputError with field paths on failure.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} value
 * @param {string} label
 * @returns {T}
 */
export function parseInput(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: [label, ...issue.path].join('.'),
    message: issue.message,
  }));
  throw new SchedulingInputError(`Invalid ${label}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, issues);
}
