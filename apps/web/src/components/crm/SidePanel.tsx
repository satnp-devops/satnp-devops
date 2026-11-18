'use client';

import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { Button, cx } from '../ui';
import './crm.css';

/**
 * A preview drawer on the right (full screen on phones), built on the native modal <dialog>:
 * focus stays inside while it's open, Escape and a click outside close it, and focus goes back
 * to whatever opened it. The title labels the dialog and takes focus first, so screen readers
 * hear which record opened. Content mounts only while open.
 */
export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  size = 'md',
  closeLabel = 'Close',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons beside the close button: Open full profile, Previous / Next. */
  actions?: ReactNode;
  /** One-click actions pinned to the bottom. */
  footer?: ReactNode;
  /** md 480 px, lg 640 px, xl 860 px. */
  size?: 'md' | 'lg' | 'xl';
  closeLabel?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Lets the native close event (which also follows our own close()) tell user closes apart.
  const openRef = useRef(open);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    openRef.current = open;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      titleRef.current?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    }
  }, [open]);

  // Close if the panel unmounts while open (navigating away), so the page isn't left inert.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) onClose();
  }

  return (
    <dialog
      ref={ref}
      className={cx('crm-panel', size !== 'md' && `crm-panel--${size}`)}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
      // React passes cancel and close events of a dialog opened from inside the panel up to these
      // handlers too: only the panel's own events close it.
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => {
        if (event.target === event.currentTarget && openRef.current) onClose();
      }}
      onClick={onBackdropClick}
    >
      {open ? (
        <>
          <header className="crm-panel__header">
            <div className="crm-panel__heading">
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="crm-panel__title">
                {title}
              </h2>
              {subtitle ? (
                <div id={subtitleId} className="crm-panel__subtitle">
                  {subtitle}
                </div>
              ) : null}
            </div>
            <div className="crm-panel__actions">
              {actions}
              <Button variant="ghost" size="sm" iconOnly icon="x" aria-label={closeLabel} onClick={onClose} />
            </div>
          </header>
          <div className="crm-panel__body">{children}</div>
          {footer ? <footer className="crm-panel__footer">{footer}</footer> : null}
        </>
      ) : null}
    </dialog>
  );
}
