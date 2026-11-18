// What other parts of the platform connect to scheduling (see docs/scheduling/SCHEDULING.md, "Wiring").
//
//   configureSchedulingPorts({...})   meetings, calendars, messaging and jobs implementations (ports.js)
//   jobProcessors                     { 'scheduling.reminder', 'scheduling.attendance_check' } for the jobs module
//   pendingJobs()                     reminder jobs still due (start-up reconcile)
//   sweepDueReminders(), sweepAttendanceChecks()   interval fallbacks until the jobs module lands
//   ingestAttendanceEvents({ provider, events })   verified Zoom / Meet / Teams webhook events
//   evaluateBookingAttendance({ bookingId, report })  a participant report fetched elsewhere

export { configureSchedulingPorts, resetSchedulingPorts, developmentPorts } from './ports.js';
export { jobProcessors, pendingJobs, processAttendanceCheckJob, processReminderJob, sweepAttendanceChecks, sweepDueReminders } from './jobs.js';
export { ingestAttendanceEvents, evaluateBookingAttendance, summariseAttendance, decideOutcome } from './attendance.js';
export { reminderJobs, attendanceJob, planReminders } from './bookings.js';
