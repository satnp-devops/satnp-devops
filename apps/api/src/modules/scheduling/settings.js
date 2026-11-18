import { z } from 'zod';

// Scheduling settings (Settings › General shows them under "Scheduling"). Read with getSetting(unit, definition).

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time like 21:00');

export const quietHoursStartSetting = {
  key: 'scheduling.quietHoursStart',
  category: 'Scheduling',
  label: 'Quiet hours start',
  description: "No reminders between this time and the end of quiet hours, in the invitee's time zone.",
  input: 'time',
  schema: timeOfDay,
  default: '21:00',
  levels: ['group', 'company'],
};

export const quietHoursEndSetting = {
  key: 'scheduling.quietHoursEnd',
  category: 'Scheduling',
  label: 'Quiet hours end',
  input: 'time',
  schema: timeOfDay,
  default: '08:00',
  levels: ['group', 'company'],
};

export const fairnessWindowSetting = {
  key: 'scheduling.fairnessWindowDays',
  category: 'Scheduling',
  label: 'Round-robin fairness window (days)',
  description: 'Bookings in this many past days count when sharing new bookings between hosts.',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(365),
  default: 30,
  levels: ['group', 'company'],
};

export const personalLinkDaysSetting = {
  key: 'scheduling.personalLinkDays',
  category: 'Scheduling',
  label: 'Personal booking links expire after (days)',
  input: 'number',
  schema: z.coerce.number().int().min(1).max(90),
  default: 14,
  levels: ['group', 'company', 'region', 'branch', 'team'],
};

export const attendanceCheckSetting = {
  key: 'scheduling.attendanceCheckMinutes',
  category: 'Scheduling',
  label: 'Check attendance after the end (minutes)',
  description: 'When no "meeting ended" notification arrives, attendance is fetched from the meeting provider this long after the booked end.',
  input: 'number',
  schema: z.coerce.number().int().min(5).max(1440),
  default: 30,
  levels: ['group', 'company'],
};

export const schedulingSettings = [
  quietHoursStartSetting,
  quietHoursEndSetting,
  fairnessWindowSetting,
  personalLinkDaysSetting,
  attendanceCheckSetting,
];
