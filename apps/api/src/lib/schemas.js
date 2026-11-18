import { z } from 'zod';

const trimmedLower = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : value);

export const emailSchema = z.preprocess(trimmedLower, z.email('Enter a valid email address').max(254));

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Use 200 characters or fewer');

export const nameSchema = z.preprocess(trimmed, z.string().min(1, 'Enter a name').max(120));

export const phoneSchema = z.preprocess(
  trimmed,
  z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
);

export const codeSchema = z.preprocess(
  trimmedLower,
  z
    .string()
    .min(2, 'Use at least 2 characters')
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens'),
);

/** Web links only: z.url() alone also accepts javascript: and data: URLs, which are unsafe to render as links. */
export const webUrlSchema = z.url({ protocol: /^https?$/, error: 'Enter a full link starting with https://' }).max(2000);

export const idParams = z.object({ id: z.uuid() });

export const timeZoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');
