'use client';

import { useState, type ReactNode } from 'react';
import {
  formatInZone,
  formatMoney,
  formatRelativeTime,
  maskValue,
  maskedHint,
  timeZoneCity,
  toDate,
  viewerTimeZone,
  zonesDiffer,
  type DateFormat,
  type DateInput,
  type MaskKind,
} from '@/lib/crm/format';
import { errorMessage } from '@/lib/api';
import { cx } from '../ui';
import { useNow } from './hooks';
import './crm.css';

function NotSet() {
  return (
    <span className="muted">
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">Not set</span>
    </span>
  );
}

// ---------- Money ----------

/** An amount stored in minor units: <Money minor={12500000} currency="INR" /> shows ₹1,25,000. */
export function Money({
  minor,
  currency,
  compact = false,
  exact = false,
  signed = false,
  className,
}: {
  minor: number | null | undefined;
  currency: string;
  /** ₹12.5L instead of ₹12,50,000 (the full amount is in the tooltip). */
  compact?: boolean;
  exact?: boolean;
  signed?: boolean;
  className?: string;
}) {
  if (minor === null || minor === undefined) return <NotSet />;
  const text = formatMoney(minor, currency, { compact, exact, signed });
  const full = compact ? formatMoney(minor, currency, { exact: true, signed }) : undefined;
  return (
    <span className={cx('crm-money', className)} title={full}>
      {text}
    </span>
  );
}

// ---------- Dates and times ----------

/**
 * A moment in the viewer's time zone, in JetBrains Mono. Pass `contactTimeZone` to add the
 * contact's local time when it differs: "5 Nov, 3:45 pm · 5:15 am New York".
 */
export function DateTime({
  value,
  format = 'datetime',
  timeZone,
  contactTimeZone,
  contactLabel,
  sans = false,
}: {
  value: DateInput;
  format?: DateFormat;
  /** The viewer's zone; the browser's when not given (pass the user's profile zone if they set one). */
  timeZone?: string;
  contactTimeZone?: string | null;
  /** Shown after the contact's time instead of the city name, e.g. "for Aarav". */
  contactLabel?: string;
  /** Use the UI font instead of mono (long dates in running text). */
  sans?: boolean;
}) {
  const date = toDate(value);
  if (!date) return <NotSet />;
  const viewerZone = timeZone ?? viewerTimeZone();
  const text = formatInZone(date, format, viewerZone);
  const showContact = Boolean(contactTimeZone) && zonesDiffer(date, viewerZone, contactTimeZone ?? viewerZone);
  const title = `${formatInZone(date, 'datetime', viewerZone)} (${timeZoneCity(viewerZone)} time)`;
  return (
    <span className="crm-dt">
      <time className={cx('crm-time', sans && 'crm-time--sans')} dateTime={date.toISOString()} title={title} suppressHydrationWarning>
        {text}
      </time>
      {showContact && contactTimeZone ? (
        <span className="crm-dt__alt" suppressHydrationWarning>
          <span aria-hidden="true">· </span>
          {formatInZone(date, format === 'date' || format === 'day' ? format : 'time', contactTimeZone)}{' '}
          {contactLabel ?? timeZoneCity(contactTimeZone)}
        </span>
      ) : null}
    </span>
  );
}

/** "5 min ago", "in 2 h": updates by itself; the exact time is in the tooltip. */
export function RelativeTime({ value, timeZone, sans = false }: { value: DateInput; timeZone?: string; sans?: boolean }) {
  const now = useNow();
  const date = toDate(value);
  if (!date) return <NotSet />;
  return (
    <time
      className={cx('crm-time', sans && 'crm-time--sans')}
      dateTime={date.toISOString()}
      title={formatInZone(date, 'datetime', timeZone)}
      suppressHydrationWarning
    >
      {formatRelativeTime(date, now)}
    </time>
  );
}

// ---------- IDs ----------

/** IDs, codes and references in JetBrains Mono. `short` keeps the first 8 characters (full value in the tooltip). */
export function Mono({ children, short = false, className }: { children: string; short?: boolean; className?: string }) {
  const text = short && children.length > 10 ? `${children.slice(0, 8)}…` : children;
  return (
    <span className={cx('crm-mono', className)} title={text === children ? undefined : children}>
      {text}
    </span>
  );
}

// ---------- Masked personal data ----------

/**
 * A phone number, email or other personal detail shown masked: "+91 ••••• •3210".
 * People allowed to see it get a Show button; `onReveal` can fetch (and audit) the full value.
 * If the API already masked the value, pass it as is and leave `canReveal` off.
 */
export function Masked({
  value,
  kind = 'text',
  label,
  canReveal = false,
  onReveal,
}: {
  value: string;
  kind?: MaskKind;
  /** What it is, for the button and screen readers: "Phone". */
  label?: string;
  canReveal?: boolean;
  /** Called on Show. Return the full value when it comes from the server; otherwise `value` is shown. */
  onReveal?: () => void | string | Promise<string | void>;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = label ?? (kind === 'phone' ? 'Phone' : kind === 'email' ? 'Email' : 'Value');

  async function reveal() {
    setError(null);
    if (!onReveal) {
      setRevealed(value);
      return;
    }
    setPending(true);
    try {
      const full = await onReveal();
      setRevealed(typeof full === 'string' ? full : value);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  let shown: ReactNode;
  if (revealed !== null) {
    shown = revealed;
  } else {
    shown = (
      <>
        <span aria-hidden="true">{maskValue(value, kind)}</span>
        <span className="visually-hidden">
          {name} hidden, {maskedHint(value, kind)}
        </span>
      </>
    );
  }

  return (
    <span className="crm-masked">
      <span className={cx('crm-masked__value', kind === 'phone' && 'crm-masked__value--mono')}>{shown}</span>
      {canReveal ? (
        <button
          type="button"
          className="link-button crm-masked__toggle"
          aria-label={`${revealed !== null ? 'Hide' : 'Show'} ${name.toLowerCase()}`}
          aria-busy={pending || undefined}
          disabled={pending}
          onClick={() => {
            if (revealed !== null) setRevealed(null);
            else void reveal();
          }}
        >
          {pending ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
          {revealed !== null ? 'Hide' : 'Show'}
        </button>
      ) : null}
      {error ? (
        <span className="crm-masked__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
