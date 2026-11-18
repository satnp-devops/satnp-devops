'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChannelBadge, Mono } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { Button, ErrorAlert, cx } from '@/components/ui';
import type { TimelineEntry } from '@/lib/crm/types';
import { useDeleteEntry, useEditEntry, usePinEntry } from '@/lib/timeline/queries';
import { actorName, entryHeading, kindIcon, metaSummary } from '@/lib/timeline/present';
import { RelativeStamp } from './RelativeStamp';

/** One timeline entry: kind icon, heading, channel, body, who and when, and its actions. */
export function TimelineItem({
  entry,
  kindLabel,
  showDeal,
  timeZone,
}: {
  entry: TimelineEntry;
  kindLabel?: string;
  /** On person and institute timelines, link each entry to its deal. */
  showDeal: boolean;
  timeZone?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.body ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const edit = useEditEntry();
  const pin = usePinEntry();
  const remove = useDeleteEntry();
  const heading = entryHeading(entry, kindLabel);
  const meta = metaSummary(entry);
  const isNote = entry.kind === 'note';

  const save = () => {
    const body = draft.trim();
    if (isNote && !body) return;
    edit.mutate({ id: entry.id, changes: { body } }, { onSuccess: () => setEditing(false) });
  };

  return (
    <li className={cx('timeline-item', `timeline-item--${entry.kind}`, entry.pinnedAt && 'timeline-item--pinned')}>
      <span className="timeline-item__icon" aria-hidden="true">
        <Icon name={kindIcon(entry.kind)} size={16} />
      </span>
      <article className="timeline-item__card" aria-label={`${heading}, ${actorName(entry)}`}>
        <header className="timeline-item__head">
          <span className="timeline-item__title">{isNote && !entry.title ? 'Note' : heading}</span>
          {entry.channel ? <ChannelBadge channel={entry.channel} /> : null}
          {entry.pinnedAt ? (
            <span className="timeline-item__flag">
              <Icon name="pin" size={12} aria-hidden="true" /> Pinned
            </span>
          ) : null}
          {entry.archived ? <span className="timeline-item__flag">Archived</span> : null}
          {showDeal && entry.deal ? (
            <Link href={`/leads/${entry.deal.id}`} className="timeline-item__deal" title={entry.deal.title}>
              <Mono>{entry.deal.ref}</Mono>
            </Link>
          ) : null}
        </header>

        {editing ? (
          <div className="timeline-item__edit">
            <label className="visually-hidden" htmlFor={`edit-${entry.id}`}>
              Edit entry
            </label>
            <textarea
              id={`edit-${entry.id}`}
              className="textarea"
              value={draft}
              rows={3}
              maxLength={20_000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
                if (event.key === 'Escape') setEditing(false);
              }}
              autoFocus
            />
            <ErrorAlert error={edit.error} />
            <div className="row gap-8">
              <Button size="sm" variant="primary" onClick={save} loading={edit.isPending} disabled={isNote && !draft.trim()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : entry.body ? (
          <p className={cx('timeline-item__body', entry.kind === 'message' && entry.direction === 'inbound' && 'timeline-item__body--quote')}>
            {entry.body}
          </p>
        ) : null}

        {meta.length > 0 ? <p className="timeline-item__meta">{meta.join(' · ')}</p> : null}

        <footer className="timeline-item__foot">
          <span className="timeline-item__actor">{actorName(entry)}</span>
          <span aria-hidden="true">·</span>
          <RelativeStamp value={entry.occurredAt} timeZone={timeZone} />
          {entry.editedAt ? <span className="timeline-item__edited">edited</span> : null}
          <span className="spacer" />
          {!editing && (entry.canPin || entry.canEdit || entry.canDelete) ? (
            <span className="timeline-item__actions">
              {entry.canPin ? (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="pin"
                  aria-label={entry.pinnedAt ? 'Unpin' : 'Pin'}
                  aria-pressed={Boolean(entry.pinnedAt)}
                  title={entry.pinnedAt ? 'Unpin' : 'Pin to the top'}
                  loading={pin.isPending}
                  onClick={() => pin.mutate({ id: entry.id, pinned: !entry.pinnedAt })}
                />
              ) : null}
              {entry.canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="edit"
                  aria-label="Edit"
                  title="Edit"
                  onClick={() => {
                    setDraft(entry.body ?? '');
                    setEditing(true);
                  }}
                />
              ) : null}
              {entry.canDelete ? (
                <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label="Delete" title="Delete" onClick={() => setConfirmDelete(true)} />
              ) : null}
            </span>
          ) : null}
        </footer>
        {pin.error ? <ErrorAlert error={pin.error} /> : null}
      </article>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={isNote ? 'Delete this note?' : 'Delete this entry?'}
        confirmLabel="Delete"
        danger
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(entry, { onSuccess: () => setConfirmDelete(false) })}
      >
        It disappears from every timeline it shows on. The audit log keeps a record that it was deleted.
      </ConfirmDialog>
    </li>
  );
}
