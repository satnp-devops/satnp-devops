/**
 * Intake engine: everything an enquiry goes through between arriving and becoming a lead.
 * Pure functions only; see docs/platform/INTAKE_CORE.md.
 *
 *   toEnquiry()        any channel's payload → the normalised enquiry
 *   route()            enquiry → company and product line, or the review queue
 *   findDuplicates()   enquiry + candidate contacts → merge / suggest / new, with reasons
 *   mergePlan()        two contacts → which fields win and what moves
 *   assignOwner()      lead + owner pool + fairness state → owner, reasons, next state
 *   importCsv()        CSV text → enquiries and a per-row error report
 */

export * from './enquiry.js';
export * from './normalize.js';
export * from './trigram.js';
export * from './names.js';
export * from './routing.js';
export * from './dedup.js';
export * from './assign.js';
export * from './csv.js';
export * from './time.js';
