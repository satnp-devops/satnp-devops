'use client';

import { Field } from './ui';

export const MIN_PASSWORD_LENGTH = 10;

/** Check a new password and its confirmation before sending; the API checks again. */
export function newPasswordProblems(password: string, confirm: string): { password?: string; confirm?: string } {
  const problems: { password?: string; confirm?: string } = {};
  if (password.length > 0 && password.length < MIN_PASSWORD_LENGTH) {
    problems.password = `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (confirm.length > 0 && confirm !== password) problems.confirm = "The passwords don't match";
  return problems;
}

export function NewPasswordFields({
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  serverError,
  showProblems,
  label = 'New password',
}: {
  password: string;
  confirm: string;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  serverError?: string | undefined;
  /** Show local problems only after the first submit attempt, not while typing. */
  showProblems: boolean;
  label?: string;
}) {
  const problems = showProblems ? newPasswordProblems(password, confirm) : {};
  return (
    <>
      <Field label={label} hint={`At least ${MIN_PASSWORD_LENGTH} characters. A short phrase is easy to remember.`} error={problems.password ?? serverError}>
        {(control) => (
          <input
            {...control}
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
        )}
      </Field>
      <Field label="Confirm password" error={problems.confirm}>
        {(control) => (
          <input
            {...control}
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => onConfirmChange(event.target.value)}
          />
        )}
      </Field>
    </>
  );
}

export function isNewPasswordReady(password: string, confirm: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password === confirm;
}
