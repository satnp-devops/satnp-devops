import type { ReactNode } from 'react';

/** The card used by sign-in, password and invitation pages. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth__card">
      <div className="auth__brand">
        <span className="brand__mark">P</span>
        <span>Phoenix Platform</span>
      </div>
      <div className="stack gap-4">
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {children}
      {footer ? <div className="auth__footer">{footer}</div> : null}
    </div>
  );
}
