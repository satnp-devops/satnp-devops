// Formatting for the CRM screens: money in minor units, dates in the viewer's (or the contact's)
// time zone, relative times and SLA countdowns, masked personal data and channel names.
// Plain functions with no React, so tables, exports and scripts can share them.

const LOCALE = 'en-IN';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------- Numbers and money ----------

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

const digitsByCurrency = new Map<string, number>();

/** Decimal places in a currency's minor unit: INR and USD 2, JPY 0, KWD 3. */
export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  const known = digitsByCurrency.get(code);
  if (known !== undefined) return known;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Not a code Intl accepts: assume two decimals, like most currencies.
  }
  digitsByCurrency.set(code, digits);
  return digits;
}

/** 12500000 paise → 125000 rupees. */
export function toMajorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

/** 125000.5 rupees → 12500050 paise (for amount inputs). */
export function toMinorUnits(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDigits(currency));
}

/** Indian grouping (1,25,000) for rupees, international grouping (125,000) for everything else. */
export function moneyLocale(currency: string): string {
  return currency.toUpperCase() === 'INR' ? 'en-IN' : 'en-US';
}

export interface MoneyOptions {
  /** Short form for tight spaces: ₹12.5L, ₹1.2Cr, $1.3M. */
  compact?: boolean;
  /** Always show the minor digits (₹1,25,000.00). By default they show only when not zero. */
  exact?: boolean;
  /** Put + in front of positive amounts (adjustments, changes). */
  signed?: boolean;
}

/** "₹1,25,000" from 12500000 and "INR"; "—" when there's no amount. */
export function formatMoney(minor: number | null | undefined, currency: string, options: MoneyOptions = {}): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '—';
  const code = currency.toUpperCase();
  const digits = currencyDigits(code);
  const major = minor / 10 ** digits;
  const signDisplay = options.signed ? 'exceptZero' : 'auto';
  let style: Intl.NumberFormatOptions;
  if (options.compact) {
    style = { notation: 'compact', maximumSignificantDigits: 3 };
  } else {
    const whole = Math.round(minor) % 10 ** digits === 0;
    const fraction = options.exact || !whole ? digits : 0;
    style = { minimumFractionDigits: fraction, maximumFractionDigits: fraction };
  }
  try {
    return numberFormat(moneyLocale(code), { style: 'currency', currency: code, signDisplay, ...style }).format(major);
  } catch {
    return `${code} ${major.toFixed(digits)}`;
  }
}

/** Counts with Indian grouping: 1,25,000. */
export function formatCount(value: number): string {
  return numberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value);
}

/** "Ritika, Kabir and Dev". */
export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(items);
}

// ---------- Dates and time zones ----------

export type DateInput = string | number | Date | null | undefined;

/** How a moment is written: datetime "5 Nov 2026, 3:45 pm", date "5 Nov 2026", time "3:45 pm",
 * day "Thu, 5 Nov", short "5 Nov, 3:45 pm". */
export type DateFormat = 'datetime' | 'date' | 'time' | 'day' | 'short';

const DATE_OPTIONS: Record<DateFormat, Intl.DateTimeFormatOptions> = {
  datetime: { dateStyle: 'medium', timeStyle: 'short' },
  date: { dateStyle: 'medium' },
  time: { hour: 'numeric', minute: '2-digit' },
  day: { weekday: 'short', day: 'numeric', month: 'short' },
  short: { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
};

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(format: DateFormat, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${format}|${timeZone ?? ''}`;
  let result = dateFormats.get(key);
  if (!result) {
    try {
      result = new Intl.DateTimeFormat(LOCALE, { ...DATE_OPTIONS[format], timeZone });
    } catch {
      // An unknown time zone name: fall back to the viewer's own zone rather than failing.
      result = new Intl.DateTimeFormat(LOCALE, DATE_OPTIONS[format]);
    }
    dateFormats.set(key, result);
  }
  return result;
}

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A moment in a time zone (the viewer's when none is given); "—" when there's no date. */
export function formatInZone(value: DateInput, format: DateFormat = 'datetime', timeZone?: string): string {
  const date = toDate(value);
  return date ? dateFormat(format, timeZone).format(date) : '—';
}

/** The viewer's time zone as the browser reports it, e.g. "Asia/Kolkata". */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Browsers still report some zones by their old names (India is often "Asia/Calcutta").
const RENAMED_CITIES: Record<string, string> = {
  Calcutta: 'Kolkata',
  Saigon: 'Ho Chi Minh',
  Kiev: 'Kyiv',
  Rangoon: 'Yangon',
  Katmandu: 'Kathmandu',
};

/** "Kolkata" from "Asia/Kolkata" (or "Asia/Calcutta"), "New York" from "America/New_York". */
export function timeZoneCity(timeZone: string): string {
  const city = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
  return RENAMED_CITIES[city] ?? city;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes ahead of UTC in a time zone at a moment (330 for India), or null for an unknown zone. */
export function zoneOffsetMinutes(value: DateInput, timeZone: string): number | null {
  const date = toDate(value);
  if (!date) return null;
  let format = offsetFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      return null;
    }
    offsetFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const wallClock = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return Math.round((wallClock - Math.floor(date.getTime() / 1000) * 1000) / MINUTE);
}

/** True when the two zones show different clock times at that moment. */
export function zonesDiffer(value: DateInput, first: string, second: string): boolean {
  const a = zoneOffsetMinutes(value, first);
  const b = zoneOffsetMinutes(value, second);
  return a !== null && b !== null && a !== b;
}

/** "just now", "5 min ago", "in 3 h", "2 days ago", "in 4 days"; a date beyond a week. */
export function formatRelativeTime(value: DateInput, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const diff = date.getTime() - now;
  const future = diff > 0;
  const abs = Math.abs(diff);
  if (abs < 45_000) return future ? 'in a moment' : 'just now';
  const phrase = (text: string) => (future ? `in ${text}` : `${text} ago`);
  const minutes = Math.round(abs / MINUTE);
  if (minutes < 60) return phrase(`${minutes} min`);
  const hours = Math.round(abs / HOUR);
  if (hours < 24) return phrase(`${hours} h`);
  const days = Math.round(abs / DAY);
  if (days < 7) return phrase(`${days} ${days === 1 ? 'day' : 'days'}`);
  return formatInZone(date, 'date');
}

/**
 * A length of time, as precise as is useful: "45 min", "2 h 5 min", "7 h", "1 day 4 h", "5 days".
 * Minutes matter for short SLAs, not once something is hours late. Never less than a minute.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 3) return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const dayText = `${days} ${days === 1 ? 'day' : 'days'}`;
  return days < 3 && restHours ? `${dayText} ${restHours} h` : dayText;
}

// ---------- SLA ----------

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface SlaStatus {
  tone: StatusTone;
  /** "Due in 25 min", "Overdue by 2 h", "On time", "Late by 10 min". */
  label: string;
  overdue: boolean;
}

export interface SlaOptions {
  /** When the clock stopped (first reply sent, task done). */
  completedAt?: DateInput;
  now?: number;
  /** Turn amber this close to the deadline. */
  warnWithinMinutes?: number;
}

/** Where a deadline stands: on time, close (amber), overdue (red), or met. Null without a due date. */
export function slaStatus(dueAt: DateInput, options: SlaOptions = {}): SlaStatus | null {
  const due = toDate(dueAt);
  if (!due) return null;
  const done = toDate(options.completedAt);
  if (done) {
    const late = done.getTime() - due.getTime();
    return late <= 0
      ? { tone: 'success', label: 'On time', overdue: false }
      : { tone: 'danger', label: `Late by ${formatDuration(late)}`, overdue: true };
  }
  const left = due.getTime() - (options.now ?? Date.now());
  if (left <= 0) return { tone: 'danger', label: `Overdue by ${formatDuration(left)}`, overdue: true };
  const warn = (options.warnWithinMinutes ?? 60) * MINUTE;
  return { tone: left <= warn ? 'warning' : 'neutral', label: `Due in ${formatDuration(left)}`, overdue: false };
}

// ---------- Personal data ----------

const DOT = '•';

export type MaskKind = 'phone' | 'email' | 'text';

/** "+91 ••••• •3210": the country code and the last four digits stay visible. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return phone.replace(/\d/g, DOT);
  const separated = /^\s*\+(\d{1,3})[\s-]/.exec(phone)?.[1];
  const keepStart = separated ? separated.length : phone.trim().startsWith('+') ? 2 : 0;
  const keepEnd = digits.length - 4;
  let position = 0;
  return phone.replace(/\d/g, (digit) => {
    const index = position++;
    return index < keepStart || index >= keepEnd ? digit : DOT;
  });
}

/** "ri•••••@gmail.com": the start of the name and the domain stay visible. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return maskText(email);
  const name = email.slice(0, at);
  return `${name.slice(0, name.length > 3 ? 2 : 1)}${DOT.repeat(5)}${email.slice(at)}`;
}

/** "A•••••": only the first character stays visible. */
export function maskText(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `${trimmed.slice(0, 1)}${DOT.repeat(5)}` : '';
}

export function maskValue(value: string, kind: MaskKind): string {
  if (kind === 'phone') return maskPhone(value);
  if (kind === 'email') return maskEmail(value);
  return maskText(value);
}

/** What a screen reader hears instead of the dots: "ending 3 2 1 0", "at gmail.com". */
export function maskedHint(value: string, kind: MaskKind): string {
  if (kind === 'phone') {
    const digits = value.replace(/\D/g, '');
    return digits.length > 4 ? `ending ${digits.slice(-4).split('').join(' ')}` : 'hidden';
  }
  if (kind === 'email') {
    const at = value.lastIndexOf('@');
    return at > 0 ? `at ${value.slice(at + 1)}` : 'hidden';
  }
  return 'hidden';
}

// ---------- Channels ----------

/** Names for the channels enquiries arrive on. Keys added later by configuration fall back to `humanize`. */
export const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  website_form: 'Website form',
  website_checkout: 'Website checkout',
  voice_call: 'Voice call',
  email: 'Email',
  lead_ad_instagram: 'Instagram lead ad',
  lead_ad_facebook: 'Facebook lead ad',
  partner_referral: 'Partner referral',
  csv_import: 'CSV import',
  manual: 'Manual entry',
} as const satisfies Record<string, string>;

export type ChannelKey = keyof typeof CHANNEL_LABELS;

export const CHANNEL_KEYS = Object.keys(CHANNEL_LABELS) as ChannelKey[];

export function isChannelKey(value: string): value is ChannelKey {
  return Object.hasOwn(CHANNEL_LABELS, value);
}

/** Channels messages go out on that never bring in an enquiry (so they are not lead channels). */
const MESSAGE_ONLY_CHANNEL_LABELS: Record<string, string> = { sms: 'SMS' };

export function channelLabel(channel: string): string {
  return isChannelKey(channel) ? CHANNEL_LABELS[channel] : (MESSAGE_ONLY_CHANNEL_LABELS[channel] ?? humanize(channel));
}

/** "lead_ad_tiktok" → "Lead ad tiktok", for keys that arrive from configuration. */
export function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}
