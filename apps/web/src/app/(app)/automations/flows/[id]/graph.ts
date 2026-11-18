// Pure helpers for the flow editor: step order, edges (pointers), new steps and summaries.

import type { AutomationCatalog, EngineIssue, FlowDefinition, FlowStep, Json, JsonObject, StepType } from '@/lib/automations/types';

export interface Edge {
  /** Field holding the pointer: next, then, else, otherwise, onTimeout, onError, onReject, or cases.N.next */
  field: string;
  label: string;
  to: string | undefined;
}

/** Every pointer a step has (set or not), with a label for the editor. */
export function edgesOf(step: FlowStep): Edge[] {
  switch (step.type) {
    case 'condition':
      return [
        { field: 'then', label: 'If true', to: step.then },
        { field: 'else', label: 'If false', to: step.else },
      ];
    case 'branch':
      return [
        ...step.cases.map((c, i) => ({ field: `cases.${i}.next`, label: c.label || `Case ${i + 1}`, to: c.next })),
        { field: 'otherwise', label: 'Otherwise', to: step.otherwise },
      ];
    case 'wait':
      return step.mode === 'event'
        ? [
            { field: 'next', label: 'When it arrives', to: step.next },
            { field: 'onTimeout', label: 'If it times out', to: step.onTimeout },
          ]
        : [{ field: 'next', label: 'Then', to: step.next }];
    case 'action':
    case 'ai_step':
      return [
        { field: 'next', label: 'Then', to: step.next },
        { field: 'onError', label: 'If it fails', to: step.onError },
      ];
    case 'approval':
      return [
        { field: 'next', label: 'If approved', to: step.next },
        { field: 'onReject', label: 'If rejected', to: step.onReject },
        { field: 'onTimeout', label: 'If nobody decides', to: step.onTimeout },
      ];
    case 'end':
      return [];
    default:
      return [];
  }
}

/** A copy of the step with one pointer changed (undefined removes it). */
export function setEdge(step: FlowStep, field: string, to: string | undefined): FlowStep {
  const copy = structuredClone(step) as FlowStep & Record<string, unknown>;
  const caseMatch = /^cases\.(\d+)\.next$/.exec(field);
  if (caseMatch && copy.type === 'branch') {
    const index = Number(caseMatch[1]);
    const item = copy.cases[index];
    if (item) {
      if (to) item.next = to;
      else delete item.next;
    }
    return copy;
  }
  if (to) copy[field] = to;
  else delete copy[field];
  return copy;
}

/**
 * Steps in reading order: the main path first (depth first, following next / then / the first case
 * before the other pointers), end steps last, then anything not connected.
 */
export function orderSteps(definition: FlowDefinition): FlowStep[] {
  const byId = new Map(definition.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: FlowStep[] = [];
  const ends: FlowStep[] = [];
  const stack = [definition.start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const step = byId.get(id);
    if (!step) continue;
    seen.add(id);
    (step.type === 'end' ? ends : out).push(step);
    const targets = edgesOf(step).map((e) => e.to).filter((to): to is string => Boolean(to) && !seen.has(to as string));
    for (let i = targets.length - 1; i >= 0; i -= 1) stack.push(targets[i]!);
  }
  for (const step of definition.steps) if (!seen.has(step.id)) out.push(step);
  return [...out, ...ends];
}

/** Ids of steps no pointer reaches (other than the start). */
export function unreachableIds(definition: FlowDefinition): Set<string> {
  const reachable = new Set(orderStepsReachable(definition));
  return new Set(definition.steps.filter((s) => !reachable.has(s.id)).map((s) => s.id));
}

function orderStepsReachable(definition: FlowDefinition): string[] {
  const byId = new Map(definition.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = [definition.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const e of edgesOf(byId.get(id)!)) if (e.to) stack.push(e.to);
  }
  return [...seen];
}

const BASE_IDS: Record<StepType, string> = {
  action: 'action',
  ai_step: 'ai',
  condition: 'check',
  branch: 'branch',
  wait: 'wait',
  approval: 'review',
  end: 'end',
};

/** A free step id like wait_2 (ids are identifiers: expressions read steps.<id>). */
export function newStepId(definition: FlowDefinition, type: StepType, hint?: string): string {
  const base = (hint ?? BASE_IDS[type]).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || BASE_IDS[type];
  const taken = new Set(definition.steps.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`;
}

/** A new step of a type with sensible defaults. */
export function createStep(definition: FlowDefinition, type: StepType, catalog: AutomationCatalog | undefined): FlowStep {
  switch (type) {
    case 'action': {
      const id = newStepId(definition, type, 'task');
      return { id, type, action: 'tasks.create', params: { title: 'Call {{ record.name }}', dueIn: '2h', assignee: 'owner', priority: 'normal' } };
    }
    case 'ai_step': {
      const agent = catalog?.agents.find((a) => a.key === 'classifier') ?? catalog?.agents[0];
      return { id: newStepId(definition, type), type, agent: agent?.key ?? 'classifier', input: { text: '{{ trigger.payload.message }}', labels: ['hot', 'warm', 'cold'] } };
    }
    case 'condition':
      return { id: newStepId(definition, type), type, if: "record.stage == 'new_enquiry'" };
    case 'branch':
      return { id: newStepId(definition, type), type, cases: [{ label: 'Hot', when: "record.custom.temperature == 'hot'" }] };
    case 'wait':
      return { id: newStepId(definition, type), type, mode: 'duration', duration: '1d' };
    case 'approval':
      return { id: newStepId(definition, type), type, title: 'Approve this for {{ record.name }}?', approvers: { owner: true }, timeout: '2d' };
    case 'end':
      return { id: newStepId(definition, type), type };
    default:
      return { id: newStepId(definition, 'end'), type: 'end' };
  }
}

/** Remove a step and every pointer to it (the start moves to the first remaining step). */
export function removeStep(definition: FlowDefinition, id: string): FlowDefinition {
  const steps = definition.steps
    .filter((s) => s.id !== id)
    .map((s) => edgesOf(s).reduce<FlowStep>((step, edge) => (edge.to === id ? setEdge(step, edge.field, undefined) : step), s));
  const start = definition.start === id ? (steps[0]?.id ?? '') : definition.start;
  return { ...definition, steps, start };
}

const text = (value: Json | undefined): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonObject).$expr === 'string') return `ƒ ${(value as JsonObject).$expr as string}`;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** One line saying what a step does. */
export function stepSummary(step: FlowStep, catalog: AutomationCatalog | undefined): string {
  switch (step.type) {
    case 'action': {
      const action = catalog?.actions.find((a) => a.key === step.action);
      const p = step.params ?? {};
      const detail =
        step.action === 'messaging.send_template'
          ? `${text(p.channel)} · ${text(p.template)}`
          : step.action === 'tasks.create'
            ? text(p.title)
            : step.action === 'deals.change_stage'
              ? `to ${text(p.stage)}`
              : step.action === 'http.call_webhook'
                ? text(p.url)
                : step.action === 'records.update_field'
                  ? `${text(p.field)} = ${text(p.value)}`
                  : step.action === 'records.assign'
                    ? text(p.strategy)
                    : '';
      return [action?.label ?? step.action, detail].filter(Boolean).join(': ');
    }
    case 'ai_step':
      return catalog?.agents.find((a) => a.key === step.agent)?.label ?? step.agent;
    case 'condition':
      return step.if;
    case 'branch':
      return `${step.cases.length} case${step.cases.length === 1 ? '' : 's'}`;
    case 'wait':
      if (step.mode === 'duration') return `for ${step.duration ?? '?'}`;
      if (step.mode === 'event') return `for ${step.event ?? '?'} (up to ${step.timeout ?? '?'})`;
      return step.until?.timeOfDay ? `until ${step.until.timeOfDay}` : `until ${step.until?.at ?? '?'}`;
    case 'approval':
      return step.title;
    case 'end':
      return step.outcome === 'cancelled' ? 'Cancel the run' : 'Finish';
    default:
      return '';
  }
}

/** Engine issues grouped by step id (or 'trigger' / 'flow'), from paths like body.definition.steps.2.params.url. */
export function issuesByStep(issues: readonly EngineIssue[], definition: FlowDefinition): Map<string, EngineIssue[]> {
  const out = new Map<string, EngineIssue[]>();
  for (const issue of issues) {
    const parts = issue.path.replace(/^body\.definition\.?/, '').split('.');
    let key = issue.stepId ?? 'flow';
    if (!issue.stepId && parts[0] === 'steps' && parts[1] !== undefined) key = definition.steps[Number(parts[1])]?.id ?? 'flow';
    else if (!issue.stepId && (parts[0] === 'trigger' || parts[0] === 'settings')) key = 'trigger';
    out.set(key, [...(out.get(key) ?? []), issue]);
  }
  return out;
}

/** The param name an issue is about (steps.N.params.<name>…), for showing it next to the field. */
export function issueField(issue: EngineIssue): string | null {
  const m = /\.(?:params|input|config|data)\.([A-Za-z0-9_]+)/.exec(issue.path);
  if (m) return m[1] ?? null;
  const top = /steps\.\d+\.([A-Za-z]+)/.exec(issue.path);
  return top ? `@${top[1]}` : null;
}

/** JSON with sorted keys, to tell whether the draft differs from what was saved. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The editable part of a saved definition (key, version and name belong to the flow). */
export function editable(definition: FlowDefinition): FlowDefinition {
  const { key: _k, version: _v, name: _n, ...rest } = definition;
  return structuredClone(rest);
}
