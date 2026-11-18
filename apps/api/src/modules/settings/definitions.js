import { z } from 'zod';
import { timeZoneSchema, webUrlSchema } from '../../lib/schemas.js';

// Settings any module can read with getSetting(unit, definition).
// `levels` lists the unit types where a value may be set; lower levels inherit from above.
// `input` and `options` tell the web app how to render the control.

const ALL_LEVELS = ['group', 'company', 'region', 'branch', 'team'];

const TIME_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Riyadh',
  'Asia/Qatar',
  'Asia/Kathmandu',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

const CURRENCIES = [
  { value: 'INR', label: 'Indian rupee (₹)' },
  { value: 'USD', label: 'US dollar ($)' },
  { value: 'AED', label: 'UAE dirham (AED)' },
  { value: 'SGD', label: 'Singapore dollar (S$)' },
  { value: 'GBP', label: 'British pound (£)' },
  { value: 'EUR', label: 'Euro (€)' },
];

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time like 09:30');

export const settingDefinitions = [
  {
    key: 'locale.timeZone',
    category: 'Region and language',
    label: 'Time zone',
    description: 'Used for schedules, reminders and reports.',
    input: 'select',
    options: TIME_ZONES.map((tz) => ({ value: tz, label: tz.replace('_', ' ') })),
    schema: timeZoneSchema,
    default: 'Asia/Kolkata',
    levels: ALL_LEVELS,
  },
  {
    key: 'locale.currency',
    category: 'Region and language',
    label: 'Default currency',
    description: 'Used for prices, fees and invoices.',
    input: 'select',
    options: CURRENCIES,
    schema: z.enum(CURRENCIES.map((c) => c.value)),
    default: 'INR',
    levels: ['group', 'company', 'region', 'branch'],
  },
  {
    key: 'locale.language',
    category: 'Region and language',
    label: 'Default language',
    description: 'Language for messages and public pages when the contact has none.',
    input: 'select',
    options: [
      { value: 'en', label: 'English' },
      { value: 'hi', label: 'Hindi' },
    ],
    schema: z.enum(['en', 'hi']),
    default: 'en',
    levels: ALL_LEVELS,
  },
  {
    key: 'branding.primaryColor',
    category: 'Branding',
    label: 'Brand colour',
    description: 'Accent colour for booking pages, forms and portals.',
    input: 'color',
    schema: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2840D8'),
    default: '#2840D8',
    levels: ['group', 'company'],
  },
  {
    key: 'branding.logoUrl',
    category: 'Branding',
    label: 'Logo URL',
    description: 'Shown on public pages and emails.',
    input: 'url',
    schema: webUrlSchema.nullable(),
    default: null,
    levels: ['group', 'company'],
  },
  {
    key: 'security.requireMfa',
    category: 'Security',
    label: 'Require two-step verification',
    description: 'Everyone working here must use an authenticator app to sign in.',
    input: 'boolean',
    schema: z.boolean(),
    default: false,
    levels: ['group', 'company'],
  },
  {
    key: 'workingHours.days',
    category: 'Working hours',
    label: 'Working days',
    description: 'Used for routing, reply targets and booking availability.',
    input: 'multiselect',
    options: DAYS,
    schema: z.array(z.number().int().min(1).max(7)).min(1, 'Pick at least one day'),
    default: [1, 2, 3, 4, 5, 6],
    levels: ['company', 'region', 'branch', 'team'],
  },
  {
    key: 'workingHours.start',
    category: 'Working hours',
    label: 'Day starts',
    input: 'time',
    schema: timeOfDay,
    default: '09:30',
    levels: ['company', 'region', 'branch', 'team'],
  },
  {
    key: 'workingHours.end',
    category: 'Working hours',
    label: 'Day ends',
    input: 'time',
    schema: timeOfDay,
    default: '18:30',
    levels: ['company', 'region', 'branch', 'team'],
  },
];
