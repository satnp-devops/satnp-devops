import { json } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { developmentOutput, executorFor } from './actions.js';
import { ActionError } from './errors.js';
import { deliverEffectResult } from './runner.js';
import { loadRecord } from './subjects.js';

/**
 * Performs one effect: claims the row (pending → running, so a duplicate job does nothing), runs
 * its executor (actions.js) or the development executor, stores the outcome and, for awaited
 * effects, reports the result to the run. The jobs framework calls this as the job body
 * (ports.dispatchEffects); in development it runs in-process after the run's transaction commits.
 *
 * Status afterwards: done (performed), recorded (development executor: nothing was sent),
 * failed (with error { code, message }).
 * @returns {Promise<null | { status: string, output?: unknown, error?: { code: string, message: string } }>}
 */
export async function performEffect(db, effectId, { log = logger, now = Date.now() } = {}) {
  const [effect] = await db('automation_effects')
    .where({ id: effectId, status: 'pending' })
    .update({ status: 'running', attempts: db.raw('attempts + 1'), updated_at: new Date(now) })
    .returning('*');
  if (!effect) return null; // done already, or another worker has it

  const run = await db('automation_runs').where({ id: effect.run_id }).first('id', 'flow_id', 'company_id', 'unit_id', 'subject_type', 'subject_id');
  const subject = effect.subject_type ? { type: effect.subject_type, id: effect.subject_id } : null;
  const view = {
    id: effect.id,
    idempotencyKey: effect.idempotency_key,
    action: effect.action,
    params: effect.params,
    awaited: effect.awaited,
    runId: effect.run_id,
    stepId: effect.step_id,
    flowId: run?.flow_id ?? null,
    companyId: effect.company_id,
    unitId: run?.unit_id ?? null,
    subject,
  };

  const binding = executorFor(effect.action);
  let outcome;
  try {
    if (binding?.execute) {
      const record = await loadRecord(db, subject);
      const output = await binding.execute(view, { db, log, record });
      outcome = { status: 'done', executor: binding.module, output: output ?? {} };
    } else {
      outcome = { status: 'recorded', executor: 'development', output: developmentOutput(view) };
    }
  } catch (err) {
    const known = err instanceof ActionError;
    if (!known) log.error({ err, effectId, action: effect.action }, 'Automation action threw');
    outcome = {
      status: 'failed',
      executor: binding?.module ?? 'development',
      error: { code: known ? err.code : 'ACTION_FAILED', message: known ? err.message : 'The action failed unexpectedly' },
    };
  }

  await db('automation_effects')
    .where({ id: effect.id })
    .update({
      status: outcome.status,
      executor: outcome.executor,
      output: outcome.output !== undefined ? json(outcome.output) : null,
      error: outcome.error ? json(outcome.error) : null,
      completed_at: new Date(),
      updated_at: new Date(),
    });

  if (effect.awaited) {
    await deliverEffectResult(db, { idempotencyKey: effect.idempotency_key, ok: outcome.status !== 'failed', output: outcome.output, error: outcome.error }, { log, now });
  }
  return outcome;
}
