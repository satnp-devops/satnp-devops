// Vocabularies of the delivery module (docs/delivery/DELIVERY.md). The migration's check
// constraints use the same lists; keep them in step.

export const BATCH_MODES = ['online', 'centre', 'hybrid'];
export const BATCH_STATUSES = ['planned', 'open', 'closed', 'completed', 'cancelled'];
/** Batches people can still join (enroll, waitlist, checkout). */
export const JOINABLE_BATCH_STATUSES = ['planned', 'open'];
export const REFUND_UNITS = ['days', 'classes'];
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const ENROLLMENT_STATUSES = ['active', 'paused', 'withdrawn', 'completed'];
/** Statuses that hold a seat in their batch. */
export const SEAT_HOLDING_STATUSES = ['active', 'paused'];
export const SEAT_STATUSES = ['seated', 'waitlisted', 'unassigned'];
export const ACCESS_STATUSES = ['not_required', 'pending', 'granted', 'suspended', 'revoked'];
export const ENROLLMENT_SOURCES = ['checkout', 'payment', 'manual'];

export const WAITLIST_STATUSES = ['waiting', 'promoted', 'removed'];
export const WITHDRAWAL_CHANNELS = ['form', 'whatsapp', 'email', 'phone', 'counter', 'portal', 'other'];
export const REFUND_STATUSES = ['requested', 'processing', 'paid', 'not_applicable', 'failed'];
export const CHECKOUT_STATUSES = ['pending', 'paid', 'completed', 'expired', 'failed'];

export const TEMPLATE_KINDS = ['b2c', 'b2b'];
export const OWNER_ROLES = ['record_owner', 'batch_teacher', 'unassigned'];
export const ITEM_STATUSES = ['pending', 'done', 'skipped'];
export const PROJECT_STATUSES = ['planned', 'in_progress', 'live', 'on_hold', 'cancelled'];
export const PHASE_STATUSES = ['pending', 'in_progress', 'done'];

export const RENEWAL_STATUSES = ['active', 'cancelled', 'ended'];
export const CHURN_LEVELS = ['low', 'medium', 'high'];

/** The B2B phases a company starts with (its templates can rename, reorder or add phases). */
export const DEFAULT_IMPLEMENTATION_PHASES = [
  { key: 'kickoff', name: 'Kickoff', offsetDays: 0 },
  { key: 'data_import', name: 'Data import', offsetDays: 7 },
  { key: 'training', name: 'Training', offsetDays: 14 },
  { key: 'go_live', name: 'Go-live', offsetDays: 28 },
];

/** Renewal reminder offsets the setting may use (days before the renewal date). */
export const REMINDER_DAY_OPTIONS = [120, 90, 60, 45, 30, 14, 7, 3, 1];
