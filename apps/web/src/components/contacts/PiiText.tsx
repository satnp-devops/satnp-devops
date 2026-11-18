'use client';

import { Icon } from '@/components/icons';
import { cx } from '@/components/ui';
import { formatPhone } from '@/lib/contacts/labels';
import './contacts.css';

/**
 * A phone number or email from the API. When the viewer lacks contacts.view_pii the API sends it
 * already masked ("+91 •••••••678", "a•••@school.in"): we show a lock and tell screen readers
 * what is left visible instead of reading out the dots.
 */
export function PiiText({ value, kind, masked }: { value: string | null; kind: 'phone' | 'email'; masked: boolean }) {
  if (!value) return null;
  if (!masked) {
    return <span className={cx('contacts-pii', kind === 'phone' && 'contacts-pii--phone')}>{kind === 'phone' ? formatPhone(value) : value}</span>;
  }
  return (
    <span
      className={cx('contacts-pii contacts-pii--masked', kind === 'phone' && 'contacts-pii--phone')}
      title="Hidden: you don't have permission to see personal data"
    >
      <Icon name="lock" size={12} className="contacts-pii__lock" aria-hidden="true" />
      <span aria-hidden="true">{value}</span>
      <span className="visually-hidden">{hint(value, kind)}</span>
    </span>
  );
}

function hint(value: string, kind: 'phone' | 'email'): string {
  if (kind === 'email') {
    const at = value.lastIndexOf('@');
    return at >= 0 ? `Email hidden, at ${value.slice(at + 1)}` : 'Email hidden';
  }
  const visible = value.replace(/^\+\d+\s/, '').replace(/\D/g, '');
  return visible ? `Phone hidden, ending ${visible.split('').join(' ')}` : 'Phone hidden';
}
