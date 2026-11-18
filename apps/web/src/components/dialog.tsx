'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button, ErrorAlert, cx } from './ui';

/**
 * A modal built on the native <dialog> element, which handles focus trapping,
 * Escape and the backdrop. Content mounts only while open, so forms start fresh each time.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: 'md' | 'lg';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Lets the native close event (which fires after our own close()) tell user closes apart.
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('dialog', size === 'lg' && 'dialog--lg')}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (openRef.current) onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog__header">
            <div className="dialog__heading">
              <h2 id={titleId}>{title}</h2>
              {description ? <p className="dialog__description">{description}</p> : null}
            </div>
            <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="Close" onClick={onClose} />
          </div>
          {children}
        </>
      ) : null}
    </dialog>
  );
}

export function DialogBody({ children }: { children: ReactNode }) {
  return <div className="dialog__body stack gap-16">{children}</div>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="dialog__footer">{children}</div>;
}

/** "Are you sure?" with the result of the action shown in place. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  danger = false,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <DialogBody>
        <div className="stack gap-8">{children}</div>
        <ErrorAlert error={error} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
