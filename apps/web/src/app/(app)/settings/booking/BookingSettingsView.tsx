'use client';

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/dialog';
import { StatusPill } from '@/components/crm';
import { Button, Card, CopyButton, EmptyState, ErrorAlert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { LOCATION_LABELS, durationLabel, schedulingKeys, useEventTypes, useHostCandidates } from '@/lib/scheduling/api';
import type { EventType } from '@/lib/scheduling/types';
import { useSession } from '@/lib/session';
import { AvailabilityEditor } from './AvailabilityEditor';
import { EventTypeDialog } from './EventTypeDialog';
import '@/components/scheduling/scheduling.css';

export function BookingSettingsView() {
  const session = useSession();
  const scope = session.scope;
  const [showArchived, setShowArchived] = useState(false);
  const eventTypes = useEventTypes(scope.id, showArchived);
  const [editing, setEditing] = useState<EventType | 'new' | null>(null);
  const [archiving, setArchiving] = useState<EventType | null>(null);
  const insideCompany = scope.type !== 'group';
  const canCreate = insideCompany && session.can('scheduling.configure');
  const canConfigureSomewhere = session.canAnywhere('scheduling.configure');
  const canHost = session.canAnywhere('scheduling.manage');

  return (
    <div className="stack gap-20">
      <Card
        title="Event types"
        description={`Bookable meetings in ${scope.name} and the companies above it. Each has a public booking page; send personal links from a deal.`}
        actions={
          <>
            {canConfigureSomewhere ? (
              <label className="chip-toggle">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show switched off
              </label>
            ) : null}
            {canCreate ? (
              <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                New event type
              </Button>
            ) : null}
          </>
        }
      >
        {!insideCompany && canConfigureSomewhere ? <p className="small muted">Pick a company or team in “Working in” to add an event type there.</p> : null}
        <ErrorAlert error={eventTypes.error} />
        {eventTypes.isLoading ? <Spinner /> : null}
        {eventTypes.data && eventTypes.data.length === 0 ? (
          <EmptyState icon="calendar" title="No event types yet">
            {canCreate ? 'Add one, pick its hosts, and share its booking page.' : 'A manager adds event types for your team.'}
          </EmptyState>
        ) : null}
        <div className="sch-et-list">
          {(eventTypes.data ?? []).map((et) => (
            <EventTypeCard key={et.id} eventType={et} showCompany={!insideCompany} onEdit={() => setEditing(et)} onArchive={() => setArchiving(et)} />
          ))}
        </div>
      </Card>

      {canHost ? (
        <Card title="Your hours" description="When you can take bookings. Booking pages offer these times minus your existing meetings.">
          <AvailabilityEditor userId="me" />
        </Card>
      ) : null}
      {canConfigureSomewhere && insideCompany ? <TeamHours unitId={scope.id} /> : null}

      <EventTypeDialog open={editing !== null} onClose={() => setEditing(null)} unitId={scope.id} unitName={scope.name} eventType={editing === 'new' ? null : editing} />
      {archiving ? <ArchiveDialog eventType={archiving} onClose={() => setArchiving(null)} /> : null}
    </div>
  );
}

function EventTypeCard({ eventType: et, showCompany, onEdit, onArchive }: { eventType: EventType; showCompany: boolean; onEdit: () => void; onArchive: () => void }) {
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () => api.post<EventType>(`/scheduling/event-types/${et.id}/restore`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: schedulingKeys.all }),
  });
  const hostsReady = et.hosts.filter((h) => h.active && h.hasAvailability);
  return (
    <article className="sch-et" style={{ '--sch-color': et.branding.color ?? undefined } as CSSProperties}>
      <div className="stack gap-6">
        <div className="row gap-8">
          <span className="sch-et__title">{et.name}</span>
          {et.archivedAt ? <StatusPill tone="neutral">Switched off</StatusPill> : null}
          {!et.archivedAt && hostsReady.length === 0 ? <StatusPill tone="warning">No hosts with hours</StatusPill> : null}
        </div>
        <div className="sch-et__meta">
          <span>{durationLabel(et.durationMin)}</span>
          <span>{LOCATION_LABELS[et.locationKind]}</span>
          <span>{showCompany ? et.unit.name : `Owned by ${et.unit.name}`}</span>
          <span>{et.hosts.length ? `Hosts: ${et.hosts.map((h) => h.user.name).join(', ')}` : 'No hosts'}</span>
          <span>Attended after {et.attendanceThresholdMin} min</span>
        </div>
        {et.publicLink && !et.archivedAt ? (
          <div className="sch-et__link">
            <input className="input mono" readOnly value={et.publicLink.url} aria-label={`${et.name} booking page`} onFocus={(e) => e.target.select()} />
            <CopyButton text={et.publicLink.url} />
            <a className="btn btn--sm" href={`/book/${et.publicLink.token}`} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </div>
        ) : null}
        <ErrorAlert error={restore.error} />
      </div>
      {et.can.configure ? (
        <div className="row gap-8">
          {et.archivedAt ? (
            <Button size="sm" icon="restore" loading={restore.isPending} onClick={() => restore.mutate()}>
              Switch on
            </Button>
          ) : (
            <>
              <Button size="sm" icon="edit" onClick={onEdit}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" icon="archive" onClick={onArchive}>
                Switch off
              </Button>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ArchiveDialog({ eventType, onClose }: { eventType: EventType; onClose: () => void }) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: () => api.post<EventType>(`/scheduling/event-types/${eventType.id}/archive`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulingKeys.all });
      onClose();
    },
  });
  return (
    <ConfirmDialog open onClose={onClose} title={`Switch off ${eventType.name}?`} confirmLabel="Switch off" danger pending={archive.isPending} error={archive.error} onConfirm={() => archive.mutate()}>
      <p>Its booking page and personal links stop taking bookings. Existing bookings stay as they are.</p>
    </ConfirmDialog>
  );
}

/** Managers can set the hours of the people who host in their part of the company. */
function TeamHours({ unitId }: { unitId: string }) {
  const people = useHostCandidates(unitId);
  const session = useSession();
  const others = (people.data ?? []).filter((p) => p.id !== session.user.id && p.worksHere);
  const [userId, setUserId] = useState('');
  if (people.isLoading || others.length === 0) return null;
  const chosen = userId || others[0]?.id || '';
  return (
    <Card title="Team hours" description="Set or check the hours of people who host bookings here.">
      <div className="stack gap-16">
        <label className="field">
          <span className="field__label">Person</span>
          <select className="select" value={chosen} onChange={(e) => setUserId(e.target.value)}>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.hasAvailability ? '' : ' (no hours yet)'}
              </option>
            ))}
          </select>
        </label>
        {chosen ? <AvailabilityEditor userId={chosen} /> : null}
      </div>
    </Card>
  );
}
