/**
 * The flow interpreter. Pure: it reads a flow version, a run and an input (an
 * event and/or the current time) and returns the run's next state plus the
 * effects to perform. It never reads the clock, the database or the network,
 * so the same input always gives the same output — which is what makes
 * re-delivery safe:
 *
 *   - every effect carries an idempotency key `${runId}:${stepId}:${visit}`; if the
 *     caller crashes after performing effects but before saving the state, running
 *     advance() again on the old state produces the same keys, and the executor
 *     skips what it already did;
 *   - an event the run has already consumed (same event id) is ignored;
 *   - a timer that fires early or twice is ignored until the wait is due.
 *
 * Lifecycle: startRun() → advance() … → status completed | failed | cancelled.
 * Status running = has a step to execute; waiting = paused on a timer, an event,
 * an effect result or an approval (see waitingFor and nextWakeAt).
 *
 * The caller (wave 2 runner) persists { status, state, nextWakeAt, waitingFor },
 * hands effects to the executor, and feeds results back as events:
 *   { id, type: 'automation.effect_result', idempotencyKey, ok, output?, error?: { code, message } }
 *   { id, type: 'automation.approval_decided', idempotencyKey, decision: 'approved' | 'rejected', decidedBy?, comment?, data? }
 */
import { ExprError, compile, evaluate, isInstant, truthy } from './expr.js';
import { renderTemplate, resolveParams } from './template.js';
import { nextTimeOfDay, parseDuration, parseInstant, toIso, toMs } from './time.js';

export const EFFECT_RESULT = 'automation.effect_result';
export const APPROVAL_DECIDED = 'automation.approval_decided';
export const AI_RUN = 'ai.run';
export const REQUEST_APPROVAL = 'automation.request_approval';

export const RUN_LIMITS = Object.freeze({
  /** Steps one advance() may execute; validation keeps flows far below (maxChain). */
  maxStepsPerAdvance: 100,
  /** Trace entries kept on the run; older ones are dropped (and counted). */
  traceSize: 300,
  /** Consumed event ids remembered for de-duplication. */
  processedEvents: 100,
  /** Default time an awaited action or AI step may take before EFFECT_TIMEOUT. */
  actionTimeout: '1d',
  aiTimeout: '1h',
});

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
const RESERVED_ROOTS = new Set(['trigger', 'event', 'steps', 'run', 'now']);

/** A programming or data error the caller must handle (not a flow outcome). */
export class AutomationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @typedef {{ id?: string, type: string, occurredAt?: string, subject?: { type: string, id: string } | null,
 *             payload?: Record<string, unknown>, idempotencyKey?: string, [key: string]: unknown }} FlowEvent
 * @typedef {{ cursor: string | null, steps: Record<string, any>, visits: Record<string, number>, stepCount: number,
 *             waiting: null | { kind: 'timer' | 'event' | 'effect' | 'approval', stepId: string, wakeAt: string | null,
 *                               since: string, event?: string, idempotencyKey?: string, data?: unknown },
 *             lastEvent: FlowEvent | null, processedEventIds: string[], trace: any[], traceSeq: number,
 *             traceDropped: number, error: null | { stepId: string | null, code: string, message: string }, endReason?: string }} RunState
 * @typedef {{ id: string, flowKey: string, flowVersion: number, status: string, subject: { type: string, id: string } | null,
 *             trigger: FlowEvent, startedAt: string, state: RunState }} Run
 */

function checkEvent(event, what = 'event') {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string' || event.type === '') {
    throw new AutomationError('EVENT_INVALID', `The ${what} needs a type`);
  }
}

/**
 * Whether an event starts this flow: event type, the trigger's own config, then the filter.
 * @param {any} flow a validated flow
 * @param {import('./registry.js').AutomationRegistry} registry
 * @param {FlowEvent} event
 * @param {{ now: number | string | Date, context?: Record<string, unknown> }} options
 * @returns {{ matched: boolean, reason?: string, error?: { code: string, message: string } }}
 */
export function matchTrigger(flow, registry, event, { now, context } = /** @type {any} */ ({})) {
  checkEvent(event);
  const nowMs = toMs(now, 'now');
  const trigger = registry.trigger(flow.trigger.type);
  if (!trigger) return { matched: false, reason: 'unknown_trigger' };
  if (!trigger.events.includes(event.type)) return { matched: false, reason: 'event_type' };
  const config = trigger.config.safeParse(flow.trigger.config ?? {});
  if (!config.success) return { matched: false, reason: 'config_invalid', error: { code: 'TRIGGER_CONFIG_INVALID', message: config.error.issues[0].message } };
  if (!trigger.match(config.data, event)) return { matched: false, reason: 'config' };
  if (flow.trigger.filter) {
    try {
      const scope = { ...extraRoots(context), trigger: event, event, record: context?.record ?? null };
      if (!truthy(evaluate(compile(flow.trigger.filter), scope, { now: nowMs }))) return { matched: false, reason: 'filter' };
    } catch (error) {
      if (!(error instanceof ExprError)) throw error;
      return { matched: false, reason: 'filter_error', error: { code: error.code, message: error.message } };
    }
  }
  return { matched: true };
}

/**
 * Applies the flow's re-entry rule. The caller counts runs for the same flow and subject.
 * @param {any} flow
 * @param {{ activeRuns: number, totalRuns: number }} counts
 */
export function canStartRun(flow, { activeRuns, totalRuns }) {
  const rule = flow.settings?.reentry ?? 'skip_if_active';
  if (rule === 'once') return totalRuns === 0;
  if (rule === 'skip_if_active') return activeRuns === 0;
  return true;
}

/**
 * A new run, pinned to this flow version, ready for its first advance().
 * @param {any} flow
 * @param {{ runId: string, event: FlowEvent, now: number | string | Date, subject?: { type: string, id: string } | null }} input
 * @returns {Run}
 */
export function startRun(flow, { runId, event, now, subject }) {
  if (typeof runId !== 'string' || runId === '') throw new AutomationError('RUN_ID_REQUIRED', 'startRun() needs a runId');
  checkEvent(event, 'trigger event');
  const at = toIso(toMs(now, 'now'));
  return {
    id: runId,
    flowKey: flow.key,
    flowVersion: flow.version,
    status: 'running',
    subject: subject ?? event.subject ?? null,
    trigger: event,
    startedAt: at,
    state: {
      cursor: flow.start,
      steps: {},
      visits: {},
      stepCount: 0,
      waiting: null,
      lastEvent: null,
      processedEventIds: event.id != null ? [String(event.id)] : [],
      trace: [],
      traceSeq: 0,
      traceDropped: 0,
      error: null,
    },
  };
}

/**
 * Stops a run where it is. Pending effects already handed out are not recalled.
 * @param {Run} run
 * @param {{ now: number | string | Date, reason?: string }} options
 */
export function cancelRun(run, { now, reason = 'cancelled' }) {
  if (TERMINAL_STATUSES.includes(run.status)) return { status: run.status, state: run.state, effects: [], changed: false };
  const state = structuredClone(run.state);
  const at = toIso(toMs(now, 'now'));
  state.waiting = null;
  state.cursor = null;
  state.endReason = reason;
  pushTrace(state, [], RUN_LIMITS.traceSize, { at, phase: 'run', stepId: null, type: 'run', outcome: 'cancelled', detail: { reason } });
  return { status: 'cancelled', state, effects: [], changed: true };
}

/**
 * Moves a run forward as far as it can go without waiting.
 * @param {any} flow the validated flow version the run is pinned to
 * @param {Run} run
 * @param {{ now: number | string | Date, event?: FlowEvent | null, context?: Record<string, unknown>,
 *           registry: import('./registry.js').AutomationRegistry, limits?: Partial<typeof RUN_LIMITS> }} options
 *   context: fresh data for expressions, e.g. { record: <the subject as loaded now> }
 */
export function advance(flow, run, options) {
  const { event = null, context, registry } = options ?? /** @type {any} */ ({});
  const nowMs = toMs(options?.now, 'now');
  if (!registry || typeof registry.action !== 'function') throw new AutomationError('REGISTRY_REQUIRED', 'advance() needs the automation registry');
  if (run.flowKey !== flow.key || run.flowVersion !== flow.version) {
    throw new AutomationError(
      'VERSION_MISMATCH',
      `Run ${run.id} is pinned to ${run.flowKey} v${run.flowVersion}; load that version instead of ${flow.key} v${flow.version}`,
      { flowKey: run.flowKey, flowVersion: run.flowVersion },
    );
  }
  if (event !== null) checkEvent(event);
  const limits = { ...RUN_LIMITS, ...options.limits };
  const unchanged = (ignored, extra = {}) => ({
    status: run.status,
    state: run.state,
    effects: [],
    trace: [],
    nextWakeAt: run.state.waiting?.wakeAt ?? null,
    waitingFor: waitingView(run.state.waiting),
    changed: false,
    consumed: false,
    ignored,
    error: run.state.error ?? null,
    ...extra,
  });

  if (TERMINAL_STATUSES.includes(run.status)) return unchanged('finished');
  if (event?.id != null && run.state.processedEventIds.includes(String(event.id))) return unchanged('duplicate');

  const ctx = {
    flow,
    run,
    registry,
    context,
    limits,
    nowMs,
    at: toIso(nowMs),
    state: /** @type {RunState} */ (structuredClone(run.state)),
    status: run.status,
    effects: [],
    trace: [],
    steps: new Map(flow.steps.map((step) => [step.id, step])),
    /** 'resume' while handling the wait the run was paused on, then 'run' while executing steps. */
    phase: 'resume',
  };

  let consumed = false;
  if (ctx.state.waiting) {
    const outcome = resume(ctx, event);
    if (!outcome.resumed) return unchanged(outcome.ignored, outcome.error ? { eventError: outcome.error } : {});
    consumed = outcome.consumed;
    if (consumed && event?.id != null) {
      ctx.state.processedEventIds = [...ctx.state.processedEventIds, String(event.id)].slice(-limits.processedEvents);
    }
  } else if (run.status === 'waiting') {
    throw new AutomationError('RUN_STATE_INVALID', `Run ${run.id} is waiting but has nothing to wait for`);
  }

  ctx.phase = 'run';
  if (ctx.status === 'running') execute(ctx);

  return {
    status: ctx.status,
    state: ctx.state,
    effects: ctx.effects,
    trace: ctx.trace,
    nextWakeAt: ctx.state.waiting?.wakeAt ?? null,
    waitingFor: waitingView(ctx.state.waiting),
    changed: true,
    consumed,
    ignored: null,
    error: ctx.state.error,
  };
}

/** What a waiting run is waiting for, for indexing (event router, timer queue, effect results). */
function waitingView(waiting) {
  if (!waiting) return null;
  const view = { kind: waiting.kind, stepId: waiting.stepId, until: waiting.wakeAt ?? null };
  if (waiting.event) view.event = waiting.event;
  if (waiting.idempotencyKey) view.idempotencyKey = waiting.idempotencyKey;
  return view;
}

function extraRoots(context) {
  const out = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (!RESERVED_ROOTS.has(key) && key !== '__proto__') out[key] = value;
  }
  return out;
}

function scopeOf(ctx) {
  const { run, state, context } = ctx;
  return {
    ...extraRoots(context),
    trigger: run.trigger,
    event: state.lastEvent ?? run.trigger,
    steps: state.steps,
    record: context?.record ?? null,
    run: { id: run.id, flowKey: run.flowKey, flowVersion: run.flowVersion, startedAt: run.startedAt, subject: run.subject },
  };
}

function pushTrace(state, callTrace, size, entry) {
  const full = { seq: state.traceSeq ?? 0, ...entry };
  state.traceSeq = full.seq + 1;
  callTrace.push(full);
  state.trace.push(full);
  if (state.trace.length > size) {
    const drop = state.trace.length - size;
    state.trace.splice(0, drop);
    state.traceDropped = (state.traceDropped ?? 0) + drop;
  }
}

/**
 * Records what a step did, for the editor's run view and the test panel.
 * phase: 'run' when the step executed, 'resume' when its wait ended.
 * next: where the run goes next (the step itself while it waits).
 */
function trace(ctx, step, outcome, detail) {
  pushTrace(ctx.state, ctx.trace, ctx.limits.traceSize, {
    at: ctx.at,
    phase: ctx.phase,
    stepId: step.id,
    type: step.type,
    outcome,
    next: ctx.state.cursor,
    ...(detail ? { detail } : {}),
  });
}

function setStep(ctx, step, record) {
  ctx.state.steps[step.id] = { ...record, at: ctx.at, visit: ctx.state.visits[step.id] ?? 1 };
}

function goTo(ctx, id) {
  ctx.state.cursor = id ?? null;
}

function wait(ctx, step, waiting) {
  ctx.state.waiting = { stepId: step.id, since: ctx.at, ...waiting };
  ctx.status = 'waiting';
}

function fail(ctx, stepId, code, message) {
  ctx.state.error = { stepId, code, message };
  ctx.state.waiting = null;
  ctx.status = 'failed';
  pushTrace(ctx.state, ctx.trace, ctx.limits.traceSize, { at: ctx.at, phase: ctx.phase, stepId, type: 'run', outcome: 'failed', detail: { code, message } });
}

/** Sends a step's error to its onError step, or fails the run. */
function routeError(ctx, step, error) {
  setStep(ctx, step, { status: 'error', error });
  if (step.onError) {
    goTo(ctx, step.onError);
    trace(ctx, step, 'error', error);
    return;
  }
  trace(ctx, step, 'error', error);
  fail(ctx, step.id, error.code, error.message);
}

function idempotencyKey(ctx, step) {
  return `${ctx.run.id}:${step.id}:${ctx.state.visits[step.id]}`;
}

function paramsError(issues) {
  return {
    code: 'PARAMS_INVALID',
    message: issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
  };
}

function exprError(error) {
  return { code: error.code, message: error.path?.length ? `${error.path.join('.')}: ${error.message}` : error.message };
}

// ---------------------------------------------------------------------------
// Resuming a paused run

function resume(ctx, event) {
  const { state, nowMs } = ctx;
  const waiting = state.waiting;
  const step = ctx.steps.get(waiting.stepId);
  if (!step) throw new AutomationError('RUN_STATE_INVALID', `Run ${ctx.run.id} waits on unknown step "${waiting.stepId}"`);
  const due = waiting.wakeAt !== null && waiting.wakeAt !== undefined && nowMs >= Date.parse(waiting.wakeAt);
  const ignore = (reason, error) => ({ resumed: false, consumed: false, ignored: reason, error });
  const proceed = (consumed) => {
    state.waiting = null;
    ctx.status = 'running';
    return { resumed: true, consumed };
  };

  switch (waiting.kind) {
    case 'timer': {
      if (!due) return ignore(event ? 'not_waiting_for_event' : 'not_due');
      const resumed = proceed(false);
      setStep(ctx, step, { status: 'done' });
      goTo(ctx, step.next);
      trace(ctx, step, 'resumed');
      return resumed;
    }
    case 'event': {
      if (event && event.type === waiting.event) {
        let matches = true;
        if (step.filter) {
          try {
            matches = truthy(evaluate(compile(step.filter), { ...scopeOf(ctx), event }, { now: nowMs }));
          } catch (error) {
            if (!(error instanceof ExprError)) throw error;
            if (!due) return ignore('filter_error', exprError(error));
            matches = false;
          }
        }
        if (matches) {
          const resumed = proceed(true);
          state.lastEvent = event;
          setStep(ctx, step, { status: 'done', output: event, timedOut: false });
          goTo(ctx, step.next);
          trace(ctx, step, 'event', { eventType: event.type, eventId: event.id ?? null });
          return resumed;
        }
      }
      if (!due) return ignore(event ? 'not_matching' : 'not_due');
      const resumed = proceed(false);
      setStep(ctx, step, { status: 'timed_out', output: null, timedOut: true });
      goTo(ctx, step.onTimeout ?? step.next);
      trace(ctx, step, 'timeout');
      return resumed;
    }
    case 'effect': {
      if (event && event.type === EFFECT_RESULT && event.idempotencyKey === waiting.idempotencyKey) {
        const resumed = proceed(true);
        if (event.ok !== true) {
          routeError(ctx, step, {
            code: typeof event.error?.code === 'string' ? event.error.code : 'EFFECT_FAILED',
            message: typeof event.error?.message === 'string' ? event.error.message : 'The action failed',
          });
          return resumed;
        }
        let output = event.output ?? null;
        if (step.type === 'ai_step') {
          const checked = ctx.registry.agent(step.agent)?.output.safeParse(output);
          if (checked && !checked.success) {
            routeError(ctx, step, { code: 'AI_OUTPUT_INVALID', message: paramsError(checked.error.issues).message });
            return resumed;
          }
          if (checked) output = checked.data;
        }
        setStep(ctx, step, { status: 'done', output, idempotencyKey: waiting.idempotencyKey });
        goTo(ctx, step.next);
        trace(ctx, step, 'result');
        return resumed;
      }
      if (!due) return ignore(event ? 'not_matching' : 'not_due');
      const resumed = proceed(false);
      routeError(ctx, step, { code: 'EFFECT_TIMEOUT', message: `No result within the time allowed (since ${waiting.since})` });
      return resumed;
    }
    case 'approval': {
      if (event && event.type === APPROVAL_DECIDED && event.idempotencyKey === waiting.idempotencyKey) {
        if (event.decision !== 'approved' && event.decision !== 'rejected') return ignore('bad_decision');
        const resumed = proceed(true);
        const edited = event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data);
        const output = {
          decision: event.decision,
          decidedBy: event.decidedBy ?? null,
          comment: typeof event.comment === 'string' ? event.comment : null,
          data: edited ? event.data : (waiting.data ?? null),
          edited,
        };
        setStep(ctx, step, { status: event.decision, output });
        goTo(ctx, event.decision === 'approved' ? step.next : step.onReject);
        trace(ctx, step, event.decision, { decidedBy: output.decidedBy });
        return resumed;
      }
      if (!due) return ignore(event ? 'not_matching' : 'not_due');
      const resumed = proceed(false);
      setStep(ctx, step, { status: 'timed_out', output: null, timedOut: true });
      goTo(ctx, step.onTimeout);
      trace(ctx, step, 'timeout');
      return resumed;
    }
    default:
      throw new AutomationError('RUN_STATE_INVALID', `Unknown wait kind "${waiting.kind}"`);
  }
}

// ---------------------------------------------------------------------------
// Executing steps

function execute(ctx) {
  const { state, flow, limits } = ctx;
  const maxStepsPerRun = flow.settings?.maxStepsPerRun ?? 500;
  let executed = 0;
  while (ctx.status === 'running') {
    const id = state.cursor;
    if (!id) {
      ctx.status = 'completed';
      pushTrace(state, ctx.trace, limits.traceSize, { at: ctx.at, phase: ctx.phase, stepId: null, type: 'run', outcome: 'completed' });
      return;
    }
    if (executed >= limits.maxStepsPerAdvance) {
      fail(ctx, id, 'STEP_LIMIT', `More than ${limits.maxStepsPerAdvance} steps ran without a pause`);
      return;
    }
    if (state.stepCount >= maxStepsPerRun) {
      fail(ctx, id, 'RUN_STEP_LIMIT', `The run reached its limit of ${maxStepsPerRun} steps`);
      return;
    }
    const step = ctx.steps.get(id);
    if (!step) {
      fail(ctx, id, 'UNKNOWN_STEP', `There is no step "${id}"`);
      return;
    }
    executed += 1;
    state.stepCount += 1;
    state.visits[id] = (state.visits[id] ?? 0) + 1;
    try {
      runStep(ctx, step);
    } catch (error) {
      if (!(error instanceof ExprError)) throw error;
      const problem = exprError(error);
      if (step.type === 'action' || step.type === 'ai_step') {
        routeError(ctx, step, problem);
      } else {
        setStep(ctx, step, { status: 'error', error: problem });
        trace(ctx, step, 'error', problem);
        fail(ctx, step.id, problem.code, problem.message);
      }
    }
  }
}

function runStep(ctx, step) {
  const { nowMs, registry } = ctx;
  const options = { now: nowMs };
  switch (step.type) {
    case 'condition': {
      const result = truthy(evaluate(compile(step.if), scopeOf(ctx), options));
      setStep(ctx, step, { status: 'done', output: result });
      goTo(ctx, result ? step.then : step.else);
      trace(ctx, step, result ? 'then' : 'else');
      return;
    }
    case 'branch': {
      const scope = scopeOf(ctx);
      const index = step.cases.findIndex((c) => truthy(evaluate(compile(c.when), scope, options)));
      if (index === -1) {
        setStep(ctx, step, { status: 'done', output: 'otherwise' });
        goTo(ctx, step.otherwise);
        trace(ctx, step, 'otherwise');
      } else {
        const chosen = step.cases[index];
        setStep(ctx, step, { status: 'done', output: chosen.label ?? index });
        goTo(ctx, chosen.next);
        trace(ctx, step, 'case', { index, label: chosen.label ?? null });
      }
      return;
    }
    case 'wait':
      runWait(ctx, step);
      return;
    case 'action': {
      const action = registry.action(step.action);
      if (!action || action.internal) {
        routeError(ctx, step, { code: 'UNKNOWN_ACTION', message: `Unknown action "${step.action}"` });
        return;
      }
      const resolved = resolveParams(step.params ?? {}, scopeOf(ctx), options, ['params']);
      const checked = action.params.safeParse(resolved);
      if (!checked.success) {
        routeError(ctx, step, paramsError(checked.error.issues));
        return;
      }
      const key = idempotencyKey(ctx, step);
      emit(ctx, step, step.action, checked.data, key, step.await === true);
      if (step.await) {
        const timeout = parseDuration(step.timeout ?? ctx.limits.actionTimeout);
        wait(ctx, step, { kind: 'effect', idempotencyKey: key, wakeAt: toIso(nowMs + timeout) });
        trace(ctx, step, 'waiting', { action: step.action, idempotencyKey: key });
      } else {
        setStep(ctx, step, { status: 'emitted', idempotencyKey: key });
        goTo(ctx, step.next);
        trace(ctx, step, 'emitted', { action: step.action, idempotencyKey: key });
      }
      return;
    }
    case 'ai_step': {
      const agent = registry.agent(step.agent);
      if (!agent) {
        routeError(ctx, step, { code: 'UNKNOWN_AGENT', message: `Unknown AI agent "${step.agent}"` });
        return;
      }
      const input = resolveParams(step.input ?? {}, scopeOf(ctx), options, ['input']);
      const checked = agent.input.safeParse(input);
      if (!checked.success) {
        routeError(ctx, step, paramsError(checked.error.issues));
        return;
      }
      const key = idempotencyKey(ctx, step);
      emit(ctx, step, AI_RUN, { agent: step.agent, input: checked.data }, key, true);
      const timeout = parseDuration(step.timeout ?? ctx.limits.aiTimeout);
      wait(ctx, step, { kind: 'effect', idempotencyKey: key, wakeAt: toIso(nowMs + timeout) });
      trace(ctx, step, 'waiting', { agent: step.agent, idempotencyKey: key });
      return;
    }
    case 'approval': {
      const scope = scopeOf(ctx);
      const title = renderTemplate(step.title, scope, options);
      const body = step.body !== undefined ? renderTemplate(step.body, scope, options) : undefined;
      const data = step.data !== undefined ? resolveParams(step.data, scope, options, ['data']) : undefined;
      const expiresAt = step.timeout ? toIso(nowMs + parseDuration(step.timeout)) : null;
      const key = idempotencyKey(ctx, step);
      const params = { title, approvers: step.approvers, expiresAt };
      if (body !== undefined) params.body = body;
      if (data !== undefined) params.data = data;
      emit(ctx, step, REQUEST_APPROVAL, params, key, true);
      wait(ctx, step, { kind: 'approval', idempotencyKey: key, wakeAt: expiresAt, data: data ?? null });
      trace(ctx, step, 'waiting', { idempotencyKey: key });
      return;
    }
    case 'end': {
      setStep(ctx, step, { status: 'done' });
      goTo(ctx, null);
      ctx.status = step.outcome === 'cancelled' ? 'cancelled' : 'completed';
      if (step.reason) ctx.state.endReason = step.reason;
      trace(ctx, step, step.outcome ?? 'completed');
      return;
    }
    default:
      throw new AutomationError('STEP_TYPE_UNKNOWN', `Unknown step type "${step.type}"`);
  }
}

function runWait(ctx, step) {
  const { nowMs, flow } = ctx;
  if (step.mode === 'duration') {
    const wakeAt = toIso(nowMs + parseDuration(step.duration));
    wait(ctx, step, { kind: 'timer', wakeAt });
    trace(ctx, step, 'waiting', { until: wakeAt });
    return;
  }
  if (step.mode === 'event') {
    const wakeAt = toIso(nowMs + parseDuration(step.timeout));
    wait(ctx, step, { kind: 'event', event: step.event, wakeAt });
    trace(ctx, step, 'waiting', { event: step.event, until: wakeAt });
    return;
  }
  // mode: until
  let target;
  if ('at' in step.until) {
    const value = evaluate(compile(step.until.at), scopeOf(ctx), { now: nowMs });
    target = isInstant(value) ? value.ms : typeof value === 'string' || typeof value === 'number' ? parseInstant(value) : null;
    if (target === null) {
      setStep(ctx, step, { status: 'error', error: { code: 'WAIT_TIME_INVALID', message: 'The wait time is empty or not a time' } });
      trace(ctx, step, 'error', { code: 'WAIT_TIME_INVALID' });
      fail(ctx, step.id, 'WAIT_TIME_INVALID', `"${step.until.at}" did not give a time`);
      return;
    }
    if (target <= nowMs) {
      setStep(ctx, step, { status: 'done', skipped: true });
      goTo(ctx, step.next);
      trace(ctx, step, 'passed', { until: toIso(target) });
      return;
    }
  } else {
    const zone = step.until.timeZone ?? flow.settings?.timeZone ?? 'Asia/Kolkata';
    target = nextTimeOfDay(nowMs, step.until.timeOfDay, zone, step.until.daysOfWeek);
  }
  const wakeAt = toIso(target);
  wait(ctx, step, { kind: 'timer', wakeAt });
  trace(ctx, step, 'waiting', { until: wakeAt });
}

function emit(ctx, step, action, params, key, awaited) {
  ctx.effects.push({
    action,
    params,
    idempotencyKey: key,
    runId: ctx.run.id,
    stepId: step.id,
    subject: ctx.run.subject,
    await: awaited,
  });
}
