/**
 * Background job definitions, as modules declare them in module.js:
 *
 *   jobs: {
 *     'deals.bulk': async (data, ctx) => { ... },                         // one-off, run with enqueueJob()
 *     'scheduling.reminder': { handler, attempts: 3, label: 'Booking reminder' },
 *     'integrations.health_sweep': { handler, repeat: { pattern: '*\/15 * * * *' } },  // cron, in UTC unless tz
 *     'webhooks.sweep': { handler, repeat: { every: 60_000 }, attempts: 1 },
 *   }
 *
 * The registry validates them at start-up (core/registry.js), so a typo fails loudly.
 */

const JOB_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const KEYS = new Set(['handler', 'label', 'attempts', 'backoffMs', 'repeat', 'data']);
// Five or six cron fields (seconds optional): digits, ranges, steps, lists, names and the ?LW# extensions.
const CRON = /^\s*([0-9A-Za-z*?/,#LW-]+\s+){4,5}[0-9A-Za-z*?/,#LW-]+\s*$/;

export function isJobName(name) {
  return typeof name === 'string' && name.length <= 100 && JOB_NAME.test(name);
}

function fail(name, message) {
  throw new Error(`Job "${name}": ${message}`);
}

function normaliseRepeat(name, repeat) {
  if (repeat === undefined) return null;
  if (!repeat || typeof repeat !== 'object') fail(name, 'repeat must be { pattern } or { every }');
  const keys = Object.keys(repeat);
  if (keys.some((key) => !['pattern', 'every', 'tz'].includes(key))) fail(name, `repeat takes pattern, every and tz (got ${keys.join(', ')})`);
  if ((repeat.pattern === undefined) === (repeat.every === undefined)) fail(name, 'repeat needs exactly one of pattern (cron) or every (ms)');
  if (repeat.pattern !== undefined && (typeof repeat.pattern !== 'string' || !CRON.test(repeat.pattern))) {
    fail(name, `"${repeat.pattern}" is not a cron pattern with 5 or 6 fields`);
  }
  if (repeat.every !== undefined && (!Number.isInteger(repeat.every) || repeat.every < 1000)) fail(name, 'repeat.every must be at least 1000 ms');
  if (repeat.tz !== undefined) {
    if (repeat.pattern === undefined) fail(name, 'repeat.tz only applies to a cron pattern');
    try {
      new Intl.DateTimeFormat('en', { timeZone: repeat.tz });
    } catch {
      fail(name, `unknown time zone "${repeat.tz}"`);
    }
  }
  return Object.freeze({ ...repeat });
}

/** Check one declared job and fill its defaults. Throws a sentence naming the job when it is wrong. */
export function normaliseJobDefinition(name, definition, moduleName) {
  if (!isJobName(name)) fail(name, 'the name must look like module.action (lower case, e.g. deals.bulk)');
  const def = typeof definition === 'function' ? { handler: definition } : definition;
  if (!def || typeof def !== 'object') fail(name, 'declare a handler function or { handler, ... }');
  const unknown = Object.keys(def).filter((key) => !KEYS.has(key));
  if (unknown.length) fail(name, `unknown option(s) ${unknown.join(', ')}`);
  if (typeof def.handler !== 'function') fail(name, 'handler must be a function (data, ctx) => result');
  if (def.label !== undefined && (typeof def.label !== 'string' || !def.label.trim() || def.label.length > 120)) {
    fail(name, 'label must be a short text');
  }
  if (def.attempts !== undefined && (!Number.isInteger(def.attempts) || def.attempts < 1 || def.attempts > 50)) {
    fail(name, 'attempts must be a whole number from 1 to 50');
  }
  if (def.backoffMs !== undefined && (!Number.isInteger(def.backoffMs) || def.backoffMs < 10)) fail(name, 'backoffMs must be at least 10');
  const repeat = normaliseRepeat(name, def.repeat);
  if (def.data !== undefined && (!repeat || typeof def.data !== 'object' || def.data === null)) {
    fail(name, 'data is the payload of a repeating job: an object, with repeat');
  }
  return Object.freeze({
    name,
    module: moduleName,
    label: def.label?.trim() ?? name,
    handler: def.handler,
    attempts: def.attempts ?? null, // null: the platform default (JOB_MAX_ATTEMPTS)
    backoffMs: def.backoffMs ?? null,
    repeat,
    data: def.data ?? {},
  });
}
