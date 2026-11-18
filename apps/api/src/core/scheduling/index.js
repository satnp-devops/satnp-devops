/**
 * Scheduling engine: time zones, bookable slots, host assignment, calendar invitations and
 * reminder times. Pure functions only; callers load data and persist results.
 * See docs/platform/SCHEDULING_CORE.md.
 */
export * from './tz.js';
export * from './slots.js';
export * from './roundRobin.js';
export * from './ics.js';
export * from './reminders.js';
export { SchedulingInputError, parseInput } from './errors.js';
