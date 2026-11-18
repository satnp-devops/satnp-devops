/**
 * Dry runs for the flow editor's test panel. Drives the real interpreter with a
 * virtual clock: waits are skipped by jumping the clock, sample events are
 * delivered at their times, and awaited actions, AI steps and approvals get
 * scripted (or sample) results. Nothing is performed; every effect is returned
 * with `simulated: true`.
 *
 *   simulate(flow, registry, {
 *     now: '2026-11-05T04:30:00Z',
 *     event: { type: 'deal.created', payload: { channel: 'whatsapp' } },   // default: the trigger's sample
 *     context: { record: { stage: 'new', city: 'Pune' } },
 *     events: [{ after: '2h', event: { type: 'meeting.ended', payload: { attendance: 'no_show' } } }],
 *     results: { classify: { ok: true, output: { label: 'hot', confidence: 0.9 } } },  // or a list, one per visit
 *     approvals: { review: 'rejected' },                                                 // or 'timeout', or { decision, data }
 *   })
 */
import { validateFlow } from './validate.js';
import { APPROVAL_DECIDED, EFFECT_RESULT, TERMINAL_STATUSES, advance, matchTrigger, startRun } from './interpreter.js';
import { parseDuration, toIso, toMs } from './time.js';

export const SIMULATION_LIMITS = Object.freeze({ maxIterations: 300 });

/**
 * @param {unknown} input flow definition
 * @param {import('./registry.js').AutomationRegistry} registry
 * @param {{
 *   now: number | string | Date,
 *   event?: Record<string, any>,
 *   context?: Record<string, unknown>,
 *   events?: { at?: string | number, after?: string, event: Record<string, any> }[],
 *   results?: Record<string, any>,
 *   approvals?: Record<string, any>,
 *   force?: boolean,
 *   roots?: string[],
 *   maxIterations?: number,
 * }} options
 */
export function simulate(input, registry, options) {
  const validation = validateFlow(input, registry, { roots: options.roots });
  if (!validation.ok) return { ok: false, errors: validation.errors, warnings: validation.warnings };
  const flow = validation.flow;
  const startMs = toMs(options.now, 'now');
  const trigger = registry.trigger(flow.trigger.type);
  const sample = trigger?.sample ?? { type: trigger?.events[0] ?? 'automation.test', payload: {} };
  const event = { id: 'sim-trigger', occurredAt: toIso(startMs), ...structuredClone(sample), ...(options.event ?? {}) };
  if (options.event?.payload === undefined && sample.payload) event.payload = structuredClone(sample.payload);

  const match = matchTrigger(flow, registry, event, { now: startMs, context: options.context });
  const base = { ok: true, warnings: validation.warnings, matched: match.matched, matchReason: match.reason ?? null, matchError: match.error ?? null, event };
  if (!match.matched && !options.force) {
    return { ...base, status: 'not_started', path: [], branches: [], effects: [], waits: [], deliveries: [], trace: [], error: null, endedAt: toIso(startMs) };
  }

  const queue = (options.events ?? [])
    .map((item, i) => ({
      time: item.at !== undefined ? toMs(item.at, 'events[].at') : startMs + (item.after ? requireDuration(item.after) : 0),
      order: i,
      event: { id: `sim-event-${i + 1}`, occurredAt: undefined, ...item.event },
    }))
    .sort((a, b) => a.time - b.time || a.order - b.order);

  let clock = startMs;
  let run = startRun(flow, { runId: 'sim', event, now: clock });
  const effects = [];
  const waits = [];
  const deliveries = [];
  const visits = {};
  const maxIterations = options.maxIterations ?? SIMULATION_LIMITS.maxIterations;
  let note = null;
  let resultCounter = 0;

  const step = (incoming) => {
    const result = advance(flow, run, { now: clock, event: incoming ?? null, context: options.context, registry });
    if (result.changed) run = { ...run, status: result.status, state: result.state };
    for (const effect of result.effects) {
      const def = registry.action(effect.action);
      effects.push({ ...effect, at: toIso(clock), simulated: true, sideEffect: def?.sideEffect ?? true });
    }
    if (result.waitingFor) waits.push({ ...result.waitingFor, from: toIso(clock) });
    return result;
  };

  let last = step(null);
  let iterations = 0;
  while (!TERMINAL_STATUSES.includes(run.status)) {
    iterations += 1;
    if (iterations > maxIterations) {
      note = 'SIMULATION_LIMIT';
      break;
    }
    const waitingFor = last.waitingFor ?? run.state.waiting;
    if (!waitingFor) {
      last = step(null);
      continue;
    }
    if (waitingFor.kind === 'effect' || waitingFor.kind === 'approval') {
      const visit = run.state.visits[waitingFor.stepId] ?? 1;
      visits[waitingFor.stepId] = visit;
      const scripted = waitingFor.kind === 'effect'
        ? effectOutcome(flow, registry, waitingFor.stepId, pick(options.results?.[waitingFor.stepId], visit))
        : approvalOutcome(pick(options.approvals?.[waitingFor.stepId], visit));
      if (scripted === 'timeout') {
        const until = waitingFor.until ?? run.state.waiting?.wakeAt ?? null;
        if (!until) {
          note = 'WAITS_FOREVER';
          break;
        }
        clock = Math.max(clock, Date.parse(until));
        last = step(null);
        continue;
      }
      resultCounter += 1;
      const type = waitingFor.kind === 'effect' ? EFFECT_RESULT : APPROVAL_DECIDED;
      last = step({ id: `sim-result-${resultCounter}`, type, idempotencyKey: waitingFor.idempotencyKey, ...scripted });
      continue;
    }
    // Timers and event waits: whichever comes first, the next sample event or the wake-up time.
    const wake = waitingFor.until ? Date.parse(waitingFor.until) : null;
    const next = queue[0];
    if (next && (wake === null || next.time < wake || (next.time === wake && waitingFor.kind === 'event'))) {
      queue.shift();
      clock = Math.max(clock, next.time);
      const delivered = { ...next.event, occurredAt: next.event.occurredAt ?? toIso(clock) };
      last = step(delivered);
      deliveries.push({ eventId: delivered.id, type: delivered.type, at: toIso(clock), consumed: last.consumed, ignored: last.ignored ?? null });
      continue;
    }
    if (wake === null) {
      note = 'WAITS_FOREVER';
      break;
    }
    clock = Math.max(clock, wake);
    last = step(null);
  }

  const trace = run.state.trace;
  return {
    ...base,
    status: run.status,
    path: trace.filter((t) => t.phase === 'run' && t.stepId).map((t) => t.stepId),
    branches: trace.filter((t) => t.type === 'condition' || t.type === 'branch').map(({ stepId, outcome, detail }) => ({ stepId, outcome, ...(detail ? { detail } : {}) })),
    effects,
    waits,
    deliveries,
    trace,
    error: run.state.error ?? (note ? { stepId: run.state.waiting?.stepId ?? null, code: note, message: noteMessage(note) } : null),
    endedAt: toIso(clock),
    finalState: run.state,
  };
}

function requireDuration(text) {
  const ms = parseDuration(text);
  if (ms === null) throw new RangeError(`"${text}" is not a duration`);
  return ms;
}

/** A scripted value for one visit: lists give one entry per visit, the last repeating. */
function pick(value, visit) {
  if (Array.isArray(value)) return value.length ? value[Math.min(visit, value.length) - 1] : undefined;
  return value;
}

function effectOutcome(flow, registry, stepId, scripted) {
  if (scripted === 'timeout') return 'timeout';
  if (scripted && typeof scripted === 'object' && 'ok' in scripted) return scripted;
  if (scripted !== undefined) return { ok: true, output: scripted };
  const step = flow.steps.find((s) => s.id === stepId);
  const sample = step?.type === 'ai_step' ? registry.agent(step.agent)?.sampleOutput : registry.action(step?.action)?.sampleOutput;
  return { ok: true, output: structuredClone(sample ?? null) };
}

function approvalOutcome(scripted) {
  if (scripted === undefined || scripted === 'approved' || scripted === 'rejected') {
    return { decision: scripted ?? 'approved', decidedBy: 'simulator' };
  }
  if (scripted === 'timeout') return 'timeout';
  return { decidedBy: 'simulator', ...scripted };
}

function noteMessage(note) {
  return note === 'SIMULATION_LIMIT'
    ? 'The simulation stopped after too many steps; check for loops that keep waiting'
    : 'The run is waiting for something that never comes in this simulation';
}
