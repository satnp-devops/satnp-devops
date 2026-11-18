/**
 * Flow validation: shape (schema.js) plus everything that needs the whole graph
 * or the registry. Run it when a flow is saved and again before a version is
 * activated; only a flow with no errors may run.
 *
 * Errors   { code, message, path, stepId? }  block activation
 * Warnings { code, message, path, stepId? }  shown in the editor
 *
 * Codes: SCHEMA, DUPLICATE_STEP, UNKNOWN_STEP, UNREACHABLE_STEP, UNKNOWN_TRIGGER,
 * TRIGGER_CONFIG_INVALID, UNKNOWN_ACTION, INTERNAL_ACTION, PARAMS_INVALID,
 * UNKNOWN_AGENT, EXPR_SYNTAX, EXPR_LIMIT, UNKNOWN_ROOT, UNKNOWN_STEP_REF,
 * LOOP_WITHOUT_WAIT, CHAIN_TOO_LONG, AI_NEEDS_APPROVAL; warnings STEP_NOT_BEFORE.
 */
import { ExprError, collectPaths, compile } from './expr.js';
import { flowSchema, isPausingStep, stepEdges } from './schema.js';
import { collectDynamic, dynamicSources, isExprRef } from './template.js';

/** Names an expression may start with inside a run. `now` is a keyword, not a root. */
export const RUN_ROOTS = Object.freeze(['trigger', 'event', 'steps', 'record', 'run']);
/** Names a trigger filter may start with (no steps have run yet). */
export const FILTER_ROOTS = Object.freeze(['trigger', 'event', 'record']);

export const VALIDATION_LIMITS = Object.freeze({
  /** Most steps one advance() may execute between pauses (longest pause-free path). */
  maxChain: 50,
});

const isPrefix = (prefix, path) => prefix.length <= path.length && prefix.every((part, i) => path[i] === part);

/**
 * @param {unknown} input a flow definition (JSON)
 * @param {import('./registry.js').AutomationRegistry} registry
 * @param {{ roots?: string[], limits?: Partial<typeof VALIDATION_LIMITS> }} [options]
 *   roots: extra context roots the caller will provide (e.g. ['contact', 'deal'])
 */
export function validateFlow(input, registry, options = {}) {
  const limits = { ...VALIDATION_LIMITS, ...options.limits };
  const extraRoots = options.roots ?? [];
  /** @type {{ code: string, message: string, path: (string | number)[], stepId?: string }[]} */
  const errors = [];
  /** @type {typeof errors} */
  const warnings = [];

  const parsed = flowSchema.safeParse(input);
  if (!parsed.success) {
    const steps = /** @type {any} */ (input)?.steps;
    for (const issue of parsed.error.issues) {
      const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
      const stepId = path[0] === 'steps' && typeof path[1] === 'number' ? steps?.[path[1]]?.id : undefined;
      const code = /** @type {any} */ (issue).params?.code?.startsWith?.('EXPR_') ? issue.params.code : 'SCHEMA';
      errors.push({ code, message: describeIssue(issue), path, ...(typeof stepId === 'string' ? { stepId } : {}) });
    }
    return { ok: false, errors, warnings, flow: null, stats: null };
  }
  const flow = parsed.data;

  // Step ids and pointers.
  /** @type {Map<string, { step: any, index: number }>} */
  const byId = new Map();
  flow.steps.forEach((step, index) => {
    if (byId.has(step.id)) errors.push({ code: 'DUPLICATE_STEP', message: `Two steps are called "${step.id}"`, path: ['steps', index, 'id'], stepId: step.id });
    else byId.set(step.id, { step, index });
  });
  if (!byId.has(flow.start)) errors.push({ code: 'UNKNOWN_STEP', message: `The first step "${flow.start}" doesn't exist`, path: ['start'] });
  /** @type {Map<string, string[]>} */
  const successors = new Map();
  for (const [id, { step, index }] of byId) {
    const targets = [];
    for (const edge of stepEdges(step)) {
      if (!byId.has(edge.to)) {
        errors.push({ code: 'UNKNOWN_STEP', message: `"${edge.to}" is not a step in this flow`, path: ['steps', index, ...edge.field], stepId: id });
      } else {
        targets.push(edge.to);
      }
    }
    successors.set(id, [...new Set(targets)]);
  }

  // Reachability and "which steps can run before this one".
  const reachableFrom = (from, { skip } = {}) => {
    const seen = new Set();
    const queue = [...(successors.get(from) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      if (skip?.(byId.get(id).step)) continue;
      queue.push(...(successors.get(id) ?? []));
    }
    return seen;
  };
  if (byId.has(flow.start)) {
    const reachable = reachableFrom(flow.start);
    reachable.add(flow.start);
    for (const [id, { index }] of byId) {
      if (!reachable.has(id)) {
        errors.push({ code: 'UNREACHABLE_STEP', message: `No path leads to "${id}" from the first step`, path: ['steps', index], stepId: id });
      }
    }
  }
  const descendants = new Map([...byId.keys()].map((id) => [id, reachableFrom(id)]));
  const runsBefore = (refId, stepId) => descendants.get(refId)?.has(stepId) ?? false;

  // Expressions: syntax was checked by the schema; here, the names they read.
  const checkExpression = (source, path, { roots, stepId }) => {
    let ast;
    try {
      ast = compile(source);
    } catch (error) {
      if (!(error instanceof ExprError)) throw error;
      errors.push({ code: error.code, message: error.message, path, ...(stepId ? { stepId } : {}) });
      return [];
    }
    return checkPaths(collectPaths(ast), path, { roots, stepId });
  };
  const checkPaths = (paths, path, { roots, stepId }) => {
    const allowed = [...roots, ...extraRoots];
    const refs = [];
    for (const segments of paths) {
      const root = String(segments[0]);
      if (!allowed.includes(root)) {
        errors.push({
          code: 'UNKNOWN_ROOT',
          message: `Unknown name "${root}". Start with one of: ${allowed.join(', ')}`,
          path,
          ...(stepId ? { stepId } : {}),
        });
        continue;
      }
      if (root !== 'steps' || segments.length < 2) continue;
      const ref = String(segments[1]);
      refs.push(ref);
      if (!byId.has(ref)) {
        errors.push({ code: 'UNKNOWN_STEP_REF', message: `There is no step "${ref}" to read from`, path, ...(stepId ? { stepId } : {}) });
      } else if (stepId && !runsBefore(ref, stepId)) {
        warnings.push({ code: 'STEP_NOT_BEFORE', message: `"${ref}" doesn't run before this step, so steps.${ref} will be empty here`, path, stepId });
      }
    }
    return refs;
  };
  const checkDynamic = (value, path, stepId) => {
    const dynamic = collectDynamic(value);
    const refs = [];
    for (const item of dynamic) {
      const at = [...path, ...item.path];
      let sources;
      try {
        sources = dynamicSources(item);
      } catch (error) {
        if (!(error instanceof ExprError)) throw error;
        errors.push({ code: error.code, message: error.message, path: at, stepId });
        continue;
      }
      for (const source of sources) refs.push(...checkExpression(source, at, { roots: RUN_ROOTS, stepId }));
    }
    return { dynamic, refs };
  };
  const checkParams = (schema, value, path, stepId, dynamic) => {
    const result = schema.safeParse(value);
    if (result.success) return;
    for (const issue of result.error.issues) {
      const issuePath = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
      // Dynamic values are checked again once resolved, unless the check is about the saved text itself.
      if (!issue.params?.static && dynamic.some((d) => isPrefix(d.path, issuePath))) continue;
      errors.push({ code: 'PARAMS_INVALID', message: describeIssue(issue), path: [...path, ...issuePath], stepId });
    }
  };

  // Trigger.
  const trigger = registry.trigger(flow.trigger.type);
  if (!trigger) {
    errors.push({ code: 'UNKNOWN_TRIGGER', message: `Unknown trigger "${flow.trigger.type}"`, path: ['trigger', 'type'] });
  } else {
    const config = trigger.config.safeParse(flow.trigger.config ?? {});
    if (!config.success) {
      for (const issue of config.error.issues) {
        errors.push({ code: 'TRIGGER_CONFIG_INVALID', message: describeIssue(issue), path: ['trigger', 'config', ...issue.path.map(String)] });
      }
    }
  }
  if (flow.trigger.filter) checkExpression(flow.trigger.filter, ['trigger', 'filter'], { roots: FILTER_ROOTS });

  // Steps.
  /** @type {Map<string, Set<string>>} steps whose output each action step's params read */
  const paramRefs = new Map();
  for (const [id, { step, index }] of byId) {
    const at = (...rest) => ['steps', index, ...rest];
    const ctx = { roots: RUN_ROOTS, stepId: id };
    switch (step.type) {
      case 'condition':
        checkExpression(step.if, at('if'), ctx);
        break;
      case 'branch':
        step.cases.forEach((c, i) => checkExpression(c.when, at('cases', i, 'when'), ctx));
        break;
      case 'wait':
        if (step.mode === 'until' && 'at' in step.until) checkExpression(step.until.at, at('until', 'at'), ctx);
        if (step.mode === 'event' && step.filter) checkExpression(step.filter, at('filter'), ctx);
        break;
      case 'action': {
        const action = registry.action(step.action);
        const { dynamic, refs } = checkDynamic(step.params, at('params'), id);
        paramRefs.set(id, new Set(refs));
        if (!action) {
          errors.push({ code: 'UNKNOWN_ACTION', message: `Unknown action "${step.action}"`, path: at('action'), stepId: id });
        } else if (action.internal) {
          errors.push({ code: 'INTERNAL_ACTION', message: `"${step.action}" is used by the engine itself; use the matching step type`, path: at('action'), stepId: id });
        } else {
          for (const name of action.staticParams ?? []) {
            if (isExprRef(step.params[name])) {
              errors.push({ code: 'PARAMS_INVALID', message: `Write ${name} out in full ({{ }} is allowed after the host), not as one expression`, path: at('params', name), stepId: id });
            }
          }
          checkParams(action.params, step.params, at('params'), id, dynamic);
        }
        break;
      }
      case 'ai_step': {
        const agent = registry.agent(step.agent);
        const { dynamic } = checkDynamic(step.input, at('input'), id);
        if (!agent) errors.push({ code: 'UNKNOWN_AGENT', message: `Unknown AI agent "${step.agent}"`, path: at('agent'), stepId: id });
        else checkParams(agent.input, step.input, at('input'), id, dynamic);
        break;
      }
      case 'approval': {
        checkDynamic(step.title, at('title'), id);
        if (step.body !== undefined) checkDynamic(step.body, at('body'), id);
        if (step.data !== undefined) checkDynamic(step.data, at('data'), id);
        break;
      }
      default:
        break;
    }
  }

  // Loops: a cycle made only of steps that never pause would spin forever.
  const pauseFree = (id) => !isPausingStep(byId.get(id).step);
  const loops = findCycles([...byId.keys()].filter(pauseFree), (id) => (successors.get(id) ?? []).filter(pauseFree));
  for (const cycle of loops) {
    const first = byId.get(cycle[0]);
    errors.push({
      code: 'LOOP_WITHOUT_WAIT',
      message: `Steps ${[...cycle, cycle[0]].join(' → ')} loop without a wait; add a wait or approval inside the loop`,
      path: ['steps', first.index],
      stepId: cycle[0],
    });
  }

  // Longest stretch executed in one go (only meaningful without pause-free loops).
  let maxChain = null;
  if (loops.length === 0) {
    const memo = new Map();
    const chain = (id) => {
      if (memo.has(id)) return memo.get(id);
      const { step } = byId.get(id);
      const length = isPausingStep(step) ? 1 : 1 + Math.max(0, ...(successors.get(id) ?? []).map(chain));
      memo.set(id, length);
      return length;
    };
    maxChain = Math.max(0, ...[...byId.keys()].map(chain));
    if (maxChain > limits.maxChain) {
      errors.push({
        code: 'CHAIN_TOO_LONG',
        message: `Up to ${maxChain} steps run back to back without a pause; the limit is ${limits.maxChain}. Split the flow or add a wait`,
        path: ['steps'],
      });
    }
  }

  // AI output that needs a person's approval must pass an approval step before a side-effect action uses it.
  for (const [id, { step }] of byId) {
    if (step.type !== 'ai_step' || !registry.agent(step.agent)?.requiresApproval) continue;
    const beforeApproval = reachableFrom(id, { skip: (s) => s.type === 'approval' });
    for (const [actionId, refs] of paramRefs) {
      const action = registry.action(byId.get(actionId).step.action);
      if (!refs.has(id) || !action?.sideEffect || !beforeApproval.has(actionId) || byId.get(actionId).step.type === 'approval') continue;
      errors.push({
        code: 'AI_NEEDS_APPROVAL',
        message: `"${actionId}" uses the output of "${id}" (${registry.agent(step.agent).label}), which a person must approve first; add an approval step between them`,
        path: ['steps', byId.get(actionId).index],
        stepId: actionId,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    flow: errors.length === 0 ? flow : null,
    stats: { steps: flow.steps.length, maxChain, pausingSteps: flow.steps.filter(isPausingStep).length },
  };
}

/**
 * Throws an error listing the problems when a flow isn't valid; returns the normalised flow.
 * @param {unknown} input
 * @param {import('./registry.js').AutomationRegistry} registry
 * @param {Parameters<typeof validateFlow>[2]} [options]
 */
export function assertValidFlow(input, registry, options) {
  const result = validateFlow(input, registry, options);
  if (!result.ok) {
    const error = new Error(`Flow is not valid: ${result.errors.map((e) => e.message).join('; ')}`);
    Object.assign(error, { code: 'FLOW_INVALID', errors: result.errors });
    throw error;
  }
  return result.flow;
}

/** Strongly connected components with a cycle (Tarjan), each as a list of ids in walk order. */
function findCycles(nodes, next) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of next(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || next(v).includes(v)) cycles.push(component.reverse());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return cycles;
}

function describeIssue(issue) {
  if (issue.code === 'invalid_union' && issue.note === 'No matching discriminator') {
    const options = Array.isArray(issue.options) ? `: ${issue.options.join(', ')}` : '';
    return `Unknown ${issue.discriminator ?? 'type'}; use one of${options}`;
  }
  if (issue.code === 'unrecognized_keys') return `Unknown field${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`;
  return issue.message;
}
