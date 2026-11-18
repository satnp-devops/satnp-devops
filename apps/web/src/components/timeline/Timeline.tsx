'use client';

import { useId, useMemo, useState } from 'react';
import { ChipGroup, Section, useNow } from '@/components/crm';
import { Button, EmptyState, ErrorAlert } from '@/components/ui';
import { CHANNEL_KEYS, channelLabel, formatInZone, viewerTimeZone } from '@/lib/crm/format';
import type { ChannelKey, CompanyRef, TimelineEntry, TimelineSubject } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { KIND_FILTERS, kindsForFilters } from '@/lib/timeline/present';
import { subjectRef, usePinnedEntries, useTimelineEntries, useTimelineKinds } from '@/lib/timeline/queries';
import { NoteComposer } from './NoteComposer';
import { TimelineItem } from './TimelineItem';
import './timeline.css';

const PAGE_SIZE = 30;

interface DayGroup {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

/** Entries grouped by the day they happened in the viewer's zone: "Today", "Yesterday", "Mon, 3 Nov". */
function groupByDay(entries: readonly TimelineEntry[], timeZone: string, now: number): DayGroup[] {
  const dayKey = (value: string | number) => formatInZone(value, 'date', timeZone);
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const thisYear = formatInZone(now, 'date', timeZone).slice(-4);
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.occurredAt);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      const label =
        key === today ? 'Today' : key === yesterday ? 'Yesterday' : key.endsWith(thisYear) ? formatInZone(entry.occurredAt, 'day', timeZone) : key;
      group = { key, label, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/**
 * One timeline for a deal, a person or an institute: every channel and kind merged, newest
 * first, a page at a time. People add notes (optionally pinned) and log calls, emails, meetings
 * and messages from the composer; pinned entries stay on top. Person and institute timelines
 * only show what the viewer may see across companies (the server decides).
 *
 * `companies`: for a person or institute linked to several companies, the ones the viewer can
 * pick for a new entry (the server asks when it can't tell).
 */
export function Timeline({
  subject,
  companies,
  title = 'Timeline',
  composer = true,
  timeZone,
  level = 2,
}: {
  subject: TimelineSubject;
  companies?: readonly CompanyRef[];
  title?: string;
  /** Show the note composer (people with timeline.write somewhere). */
  composer?: boolean;
  /** Times show in this zone; default the viewer's own. */
  timeZone?: string;
  level?: 2 | 3;
}) {
  const { canAnywhere, user } = useSession();
  const ref = subjectRef(subject);
  const zone = timeZone ?? user.timeZone ?? viewerTimeZone();
  const now = useNow();
  const channelId = useId();
  const [kindFilter, setKindFilter] = useState<string[]>([]);
  const [channel, setChannel] = useState<ChannelKey | ''>('');
  const [includeArchive, setIncludeArchive] = useState(false);
  const filtered = kindFilter.length > 0 || channel !== '';

  const kinds = useTimelineKinds();
  const kindLabels = useMemo(() => new Map((kinds.data ?? []).map((kind) => [kind.key, kind.label])), [kinds.data]);
  const list = useTimelineEntries(ref, {
    kind: kindsForFilters(kindFilter),
    channel: channel ? [channel] : undefined,
    includeArchive,
    limit: PAGE_SIZE,
  });
  const pinned = usePinnedEntries(ref);

  const entries = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.data), [list.data]);
  const pinnedIds = useMemo(() => new Set((pinned.data ?? []).map((entry) => entry.id)), [pinned.data]);
  // Pinned entries show once, on top; filters apply to the list below them.
  const shown = filtered ? entries : entries.filter((entry) => !pinnedIds.has(entry.id));
  const groups = groupByDay(shown, zone, now);
  const showDeal = ref.type !== 'deal';
  const pinnedEntries = filtered ? [] : (pinned.data ?? []);

  const clearFilters = () => {
    setKindFilter([]);
    setChannel('');
  };

  const item = (entry: TimelineEntry) => (
    <TimelineItem key={entry.id} entry={entry} kindLabel={kindLabels.get(entry.kind)} showDeal={showDeal} timeZone={zone} />
  );

  return (
    <Section title={title} level={level} flush className="timeline">
      {composer && canAnywhere('timeline.write') ? (
        <div className="timeline__composer">
          <NoteComposer subject={subject} companies={companies} />
        </div>
      ) : null}

      <div className="timeline__filters">
        <ChipGroup
          label="Show"
          options={KIND_FILTERS.map(({ value, label, icon }) => ({ value, label, icon }))}
          selected={kindFilter}
          onChange={setKindFilter}
        />
        <div className="timeline__channel">
          <label className="visually-hidden" htmlFor={channelId}>
            Channel
          </label>
          <select id={channelId} className="select" value={channel} onChange={(event) => setChannel(event.target.value as ChannelKey | '')}>
            <option value="">All channels</option>
            {CHANNEL_KEYS.map((key) => (
              <option key={key} value={key}>
                {channelLabel(key)}
              </option>
            ))}
          </select>
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {pinnedEntries.length > 0 ? (
        <div className="timeline__pinned">
          <h3 className="timeline__day">Pinned</h3>
          <ol className="timeline__list">{pinnedEntries.map(item)}</ol>
        </div>
      ) : null}

      {list.isPending ? (
        <ol className="timeline__list timeline__list--loading" aria-busy="true" aria-label="Loading the timeline">
          {[0, 1, 2].map((index) => (
            <li key={index} className="timeline-item timeline-item--skeleton">
              <span className="timeline-item__icon" />
              <span className="timeline-item__card">
                <span className="timeline-skeleton timeline-skeleton--title" />
                <span className="timeline-skeleton" />
              </span>
            </li>
          ))}
        </ol>
      ) : !list.data ? (
        <div className="timeline__state">
          <ErrorAlert error={list.error} title="The timeline didn't load" />
          <Button size="sm" icon="refresh" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : shown.length === 0 && pinnedEntries.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="filter"
            title="Nothing matches these filters"
            action={
              <Button size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState icon="history" title="No activity yet">
            Notes, calls, messages, stage changes and tasks show up here as they happen.
          </EmptyState>
        )
      ) : (
        groups.map((group) => (
          <div key={group.key} className="timeline__group">
            <h3 className="timeline__day">{group.label}</h3>
            <ol className="timeline__list">{group.entries.map(item)}</ol>
          </div>
        ))
      )}

      {list.data ? (
        <div className="timeline__more">
          {list.hasNextPage ? (
            <Button size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Show older activity
            </Button>
          ) : !includeArchive && entries.length > 0 ? (
            <Button size="sm" variant="ghost" icon="archive" onClick={() => setIncludeArchive(true)}>
              Include archived activity
            </Button>
          ) : entries.length > 0 ? (
            <span className="timeline__end">That&apos;s everything{includeArchive ? ', archive included' : ''}.</span>
          ) : null}
          {list.isFetchNextPageError ? <ErrorAlert error={list.error} /> : null}
        </div>
      ) : null}
    </Section>
  );
}
