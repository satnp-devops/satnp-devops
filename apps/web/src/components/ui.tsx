'use client';

import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { errorMessage } from '@/lib/api';
import { initials } from '@/lib/format';
import { Icon, type IconName } from './icons';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// ---------- Buttons ----------

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  block?: boolean;
  iconOnly?: boolean;
}

function buttonClass({ variant = 'default', size = 'md', block = false, iconOnly = false }: ButtonStyleProps, extra?: string) {
  return cx(
    'btn',
    variant !== 'default' && `btn--${variant}`,
    size === 'sm' && 'btn--sm',
    block && 'btn--block',
    iconOnly && 'btn--icon',
    extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {
  icon?: IconName;
  loading?: boolean;
}

export function Button({
  variant,
  size,
  block,
  iconOnly,
  icon,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, block, iconOnly }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner spinner--sm" aria-hidden="true" /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  icon,
  children,
  ...style
}: ButtonStyleProps & { href: string; icon?: IconName; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass(style)}>
      {icon ? <Icon name={icon} size={style.size === 'sm' ? 14 : 16} /> : null}
      {children}
    </Link>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button size="sm" icon={copied ? 'check' : 'copy'} onClick={copy}>
      {copied ? 'Copied' : label}
    </Button>
  );
}

// ---------- Form fields ----------

export interface ControlProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** A labelled control. The control is rendered by `children` so it gets the right id and aria links. */
export function Field({
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  optional?: boolean;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {optional ? <span className="field__optional"> (optional)</span> : null}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A group of related controls (checkboxes, chips) under one label. */
export function FieldGroup({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset className="field field--group">
      <legend className="field__label">{label}</legend>
      {children}
      {hint ? <p className="field__hint">{hint}</p> : null}
      {error ? <p className="field__error">{error}</p> : null}
    </fieldset>
  );
}

// ---------- Feedback ----------

type Tone = 'info' | 'success' | 'warning' | 'error';
const TONE_ICON: Record<Tone, IconName> = { info: 'info', success: 'check', warning: 'alert', error: 'alert' };

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={TONE_ICON[tone]} size={18} className="alert__icon" />
      <div className="alert__body">
        {title ? <p className="alert__title">{title}</p> : null}
        {children}
      </div>
      {action ? <div className="alert__action">{action}</div> : null}
    </div>
  );
}

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  return (
    <Alert tone="error" title={title}>
      {errorMessage(error)}
    </Alert>
  );
}

type BadgeTone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'new';

export function Badge({ tone = 'default', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={cx('badge', tone !== 'default' && `badge--${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <Spinner />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={28} className="empty__icon" /> : null}
      <p className="empty__title">{title}</p>
      {children ? <div className="empty__text">{children}</div> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

// ---------- Layout ----------

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  flush = false,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const header =
    title || actions ? (
      <div className={cx('card__header', flush && 'card__header--padded')}>
        <div className="card__heading">
          {title ? <h2>{title}</h2> : null}
          {description ? <p className="card__description">{description}</p> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
    ) : null;
  return (
    <section className={cx('card', flush && 'card--flush', className)}>
      {header}
      {children}
    </section>
  );
}
