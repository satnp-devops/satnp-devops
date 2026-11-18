// Vocabularies of the automations module (checked by the migration's constraints too).

export const FLOW_STATUSES = Object.freeze(['draft', 'active', 'paused', 'archived']);
export const FLOW_KINDS = Object.freeze(['standard', 'nurture']);
export const RUN_STATUSES = Object.freeze(['running', 'waiting', 'completed', 'failed', 'cancelled']);
export const ACTIVE_RUN_STATUSES = Object.freeze(['running', 'waiting']);
export const EFFECT_STATUSES = Object.freeze(['pending', 'running', 'done', 'recorded', 'failed', 'skipped']);
export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'cancelled']);

export const LIMITS = Object.freeze({
  /** Runs one flow may start for one subject within an hour: a guard against flows that trigger each other. */
  runsPerSubjectPerHour: 20,
  /** Trace rows returned with a run (the run keeps the latest 300 in its state). */
  traceRows: 500,
  /** Flows a company can hold (configuration lists return every row). */
  flowsPerCompany: 500,
  /** Waiting runs one event resumes in one go. */
  resumeBatch: 200,
  /** Subjects one no-activity scan starts per flow and tick. */
  quietBatch: 100,
});
