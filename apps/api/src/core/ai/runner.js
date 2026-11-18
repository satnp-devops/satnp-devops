import { randomUUID } from 'node:crypto';
import { db, json } from '../../lib/db.js';
import { errors } from '../../lib/errors.js';
import { toFieldErrors } from '../../lib/validate.js';
import { logger } from '../../lib/logger.js';
import { emitEvent } from '../events.js';
import { addTimelineEvent } from '../crm/timeline.js';
import { getAgent } from './agents/index.js';
import { recordUsage, usageFor, withinBudget } from './budget.js';
import { decide, postChecks, preChecks } from './guardrails.js';
import { ModelCallError, callModel } from './model.js';
import { buildRequest } from './prompt.js';
import { loadAiSettings } from './settings.js';
import { clip } from './text.js';

// The AI runner (docs/platform/AI.md "Running an agent"): one call of an agent for a company,
// with the company's guardrails, the budget, the model call, the log row in ai_actions, the
// timeline entry when the call is about a deal, contact or institute, and the review queue.
//
//   const result = await runAgent({ companyId, agent: 'intake', input: { message }, subject: { dealId } });
//   result.status: completed | pending_review | failed | skipped
//   result.output: the validated output; result.finalOutput: what features may use now (null while it waits)
//
// Model calls never run inside a caller's transaction: run agents from background jobs (or the
// test panel), then act on the result. Inputs are validated; outside text is delimited in the
// prompt and never triggers anything by itself: features act only on completed or approved outputs.

export const ACTION_STATUSES = ['completed', 'pending_review', 'approved', 'edited', 'rejected', 'failed'];
export const TRIGGERS = ['feature', 'automation', 'test', 'seed'];

async function loadCompany(companyId, trx) {
  const company = await trx('org_units').where({ id: companyId }).first();
  if (!company || company.type !== 'company') throw errors.notFound('Company');
  if (company.status !== 'active') throw errors.validation([{ path: 'companyId', message: 'This company is archived' }]);
  return company;
}

/**
 * Check the deal, contact or institute an action is about, inside the company. The timeline
 * entry goes on all three (a deal's entry also carries its primary contact and institute).
 * @returns {{ dealId, contactId, accountId, unitId, ownerUserId }}
 */
export async function resolveSubject(company, subject = {}, trx = db) {
  const none = { dealId: null, contactId: null, accountId: null, unitId: company.id, ownerUserId: null };
  if (subject.dealId) {
    const deal = await trx('deals').where({ id: subject.dealId, company_id: company.id }).first('id', 'unit_id', 'owner_user_id', 'primary_contact_id', 'account_id');
    if (!deal) throw errors.validation([{ path: 'subject.dealId', message: 'Not a deal of this company' }]);
    return {
      dealId: deal.id,
      contactId: subject.contactId ?? deal.primary_contact_id ?? null,
      accountId: subject.accountId ?? deal.account_id ?? null,
      unitId: deal.unit_id,
      ownerUserId: deal.owner_user_id ?? null,
    };
  }
  if (subject.contactId) {
    const contact = await trx('contacts').where({ id: subject.contactId, group_id: company.root_id }).first('id');
    if (!contact) throw errors.validation([{ path: 'subject.contactId', message: 'Not a contact of this group' }]);
    const link = await trx('contact_companies').where({ contact_id: contact.id, company_id: company.id }).first('unit_id', 'owner_user_id');
    return { ...none, contactId: contact.id, unitId: link?.unit_id ?? company.id, ownerUserId: link?.owner_user_id ?? null };
  }
  if (subject.accountId) {
    const account = await trx('accounts').where({ id: subject.accountId, group_id: company.root_id }).first('id');
    if (!account) throw errors.validation([{ path: 'subject.accountId', message: 'Not an institute of this group' }]);
    const link = await trx('account_companies').where({ account_id: account.id, company_id: company.id }).first('unit_id', 'owner_user_id');
    return { ...none, accountId: account.id, unitId: link?.unit_id ?? company.id, ownerUserId: link?.owner_user_id ?? null };
  }
  return none;
}

/** The text a timeline entry shows for an output. */
export function timelineBody(output) {
  if (!output || typeof output !== 'object') return null;
  const text = output.summary ?? output.reply ?? output.message ?? output.text ?? output.rationale ?? null;
  return typeof text === 'string' ? clip(text, 600) : null;
}

/** What callers get back (also what the test panel shows). */
export function resultFromRow(row, { reused = false, logged = true } = {}) {
  return {
    actionId: logged ? row.id : null,
    agent: row.agent,
    companyId: row.company_id,
    status: row.status,
    output: row.output ?? null,
    finalOutput: row.final_output ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    threshold: row.threshold === null || row.threshold === undefined ? null : Number(row.threshold),
    guardrails: row.guardrails ?? [],
    reviewReasons: row.review_reasons ?? [],
    provider: row.provider ?? null,
    model: row.model ?? null,
    mock: Boolean(row.mock),
    usage: { inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 },
    latencyMs: row.latency_ms ?? 0,
    attempts: row.attempts ?? 0,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    reused,
    logged,
  };
}

/**
 * Run one task (a registered agent, or a generic extract/classify/generate/summarise task).
 * @param {object} task an agent definition (agents/common.js)
 * @param {{
 *   companyId: string, input: unknown, subject?: { dealId?, contactId?, accountId? }, reference?: string,
 *   trigger?: string, actorUserId?: string | null, dryRun?: boolean, threshold?: number,
 *   now?: Date, log?: object, sleep?: (ms: number) => Promise<void>, adapter?: object, maxAttempts?: number,
 * }} options
 */
export async function runTask(task, options) {
  const { companyId, subject = {}, reference = null, trigger = 'feature', actorUserId = null, dryRun = false, now = new Date(), log = logger } = options;
  if (!TRIGGERS.includes(trigger)) throw new TypeError(`Unknown AI trigger "${trigger}"`);
  const company = await loadCompany(companyId, db);
  const parsedInput = task.inputSchema.safeParse(options.input ?? {});
  if (!parsedInput.success) throw errors.validation(toFieldErrors(parsedInput.error, 'input'));
  const input = parsedInput.data;
  const settings = await loadAiSettings(company);
  const registered = Boolean(getAgent(task.key)) && getAgent(task.key) === task;

  if (!dryRun && registered && !settings.enabledAgents.includes(task.key)) {
    return { ...resultFromRow({ agent: task.key, company_id: company.id, status: 'skipped' }, { logged: false }), reason: 'agent_disabled' };
  }
  if (!dryRun && reference) {
    const existing = await db('ai_actions').where({ company_id: company.id, agent: task.key, reference }).first();
    if (existing) return resultFromRow(existing, { reused: true });
  }

  const target = await resolveSubject(company, subject);
  const context = { companyName: company.name, today: now.toISOString().slice(0, 10), ...((await task.prepare?.({ input, company, trx: db })) ?? {}) };
  const threshold = options.threshold ?? settings.thresholds[task.key] ?? task.defaultThreshold;
  const pre = preChecks({ agent: task, input, settings });
  const request = buildRequest({ agent: task, input, context, settings, reference });

  const id = randomUUID();
  const row = {
    id,
    group_id: company.root_id,
    company_id: company.id,
    unit_id: target.unitId,
    agent: task.key,
    trigger,
    reference,
    deal_id: target.dealId,
    contact_id: target.contactId,
    account_id: target.accountId,
    owner_user_id: target.ownerUserId,
    input,
    input_summary: clip(task.summarizeInput(input), 300),
    threshold,
    created_by: actorUserId,
    created_at: now,
    updated_at: now,
  };

  const started = Date.now();
  let call = null;
  let failure = null;
  const usage = await usageFor(company.id, { now });
  if (!withinBudget(usage, settings.monthlyTokenBudget)) {
    failure = {
      code: 'ai_budget_exceeded',
      message: settings.monthlyTokenBudget === 0 ? 'AI is switched off for this company (budget 0)' : 'This month’s AI budget is used up',
    };
  } else if (pre.handover && task.handover) {
    call = { output: task.handover(input, pre.handover.reason, context), model: null, provider: null, mock: false, connectionId: null, usage: { inputTokens: 0, outputTokens: 0 }, attempts: 0 };
  } else {
    try {
      call = await callModel({
        companyId: company.id,
        request,
        schema: task.outputSchema,
        mockAnswer: () => task.mock(input, context, { now, settings }),
        maxAttempts: options.maxAttempts,
        sleep: options.sleep,
        log,
        adapter: options.adapter,
      });
    } catch (error) {
      if (!(error instanceof ModelCallError)) throw error;
      failure = { code: error.code, message: error.message, error };
    }
  }
  const latencyMs = Date.now() - started;

  if (failure) {
    const spent = failure.error?.usage ?? { inputTokens: 0, outputTokens: 0 };
    Object.assign(row, {
      status: 'failed',
      output: null,
      final_output: null,
      confidence: null,
      guardrails: pre.results,
      review_reasons: [],
      provider: failure.error?.provider ?? null,
      model: failure.error?.model ?? null,
      mock: failure.error?.mock ?? false,
      connection_id: failure.error?.connectionId ?? null,
      input_tokens: spent.inputTokens,
      output_tokens: spent.outputTokens,
      latency_ms: latencyMs,
      attempts: failure.error?.attempts ?? 0,
      error_code: failure.code,
      error_message: failure.message,
    });
    log.warn({ companyId: company.id, agent: task.key, code: failure.code }, 'AI call failed');
  } else {
    const post = postChecks({ agent: task, input, context, output: call.output, settings });
    const decision = decide({ agent: task, results: [...pre.results, ...post], confidence: call.output.confidence, threshold });
    Object.assign(row, {
      status: decision.status,
      output: call.output,
      final_output: decision.status === 'completed' ? call.output : null,
      confidence: call.output.confidence,
      guardrails: decision.guardrails,
      review_reasons: decision.reviewReasons,
      provider: call.provider,
      model: call.model,
      mock: call.mock,
      connection_id: call.connectionId,
      input_tokens: call.usage.inputTokens,
      output_tokens: call.usage.outputTokens,
      latency_ms: latencyMs,
      attempts: call.attempts,
      error_code: null,
      error_message: null,
    });
  }

  const timeline =
    row.status !== 'failed' && (row.deal_id || row.contact_id || row.account_id)
      ? {
          groupId: row.group_id,
          companyId: row.company_id,
          unitId: row.unit_id,
          dealId: row.deal_id,
          contactId: row.contact_id,
          accountId: row.account_id,
          kind: 'ai',
          direction: 'internal',
          actorType: 'ai',
          title: task.title(row.output, row.status),
          body: timelineBody(row.output),
          meta: { agent: task.key, actionId: id, status: row.status, confidence: row.confidence, model: row.model, reviewReasons: row.review_reasons },
          sourceEventId: `ai:${id}`,
          occurredAt: now,
          touchDeal: false,
        }
      : null;

  const spentTokens = row.input_tokens + row.output_tokens > 0;
  if (dryRun) {
    // The test panel: nothing is logged, but tokens the model used still count against the budget.
    if (spentTokens) await recordUsage(db, { companyId: company.id, groupId: company.root_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens, now });
    return {
      ...resultFromRow(row, { logged: false }),
      preview: {
        request: { purpose: request.purpose, system: request.system, messages: request.messages, maxTokens: request.maxTokens },
        log: { table: 'ai_actions', ...row, id: null },
        timeline,
        context: Object.fromEntries(Object.entries(context).filter(([key]) => !['companyName', 'today'].includes(key))),
      },
    };
  }

  await db.transaction(async (trx) => {
    await trx('ai_actions').insert({
      ...row,
      input: json(row.input),
      output: row.output === null ? null : json(row.output),
      final_output: row.final_output === null ? null : json(row.final_output),
      guardrails: json(row.guardrails),
      review_reasons: row.review_reasons,
    });
    if (spentTokens || !failure) {
      await recordUsage(trx, { companyId: company.id, groupId: company.root_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens, now });
    }
    if (timeline) await addTimelineEvent(trx, timeline);
    await emitEvent(trx, {
      type: 'ai.action_logged',
      groupId: row.group_id,
      unitId: row.unit_id,
      aggregateType: 'ai_action',
      aggregateId: id,
      actorUserId,
      payload: {
        actionId: id,
        agent: task.key,
        companyId: row.company_id,
        status: row.status,
        reviewReasons: row.review_reasons,
        dealId: row.deal_id,
        contactId: row.contact_id,
        accountId: row.account_id,
        reference,
        trigger,
      },
    });
  });
  return resultFromRow(row);
}

/**
 * Run a registered agent (agents/index.js) for a company.
 * @param {Parameters<typeof runTask>[1] & { agent: string }} options
 */
export async function runAgent({ agent: key, ...options }) {
  const agent = getAgent(key);
  if (!agent) throw errors.validation([{ path: 'agent', message: `Unknown AI agent "${key}"` }]);
  return runTask(agent, options);
}
