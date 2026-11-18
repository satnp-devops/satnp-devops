'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ChannelBadge,
  DateTime,
  KeyValue,
  Masked,
  Menu,
  Money,
  Mono,
  NewBadge,
  RelativeTime,
  Section,
  SidePanel,
  SlaBadge,
  StageBubbles,
  StatusPill,
  type KeyValueItem,
  type MenuItem,
  type StageBubble,
} from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Alert, Avatar, Button, ButtonLink, ErrorAlert, Spinner } from '@/components/ui';
import { formatPhone } from '@/lib/contacts/labels';
import { channelLabel, formatInZone, humanize } from '@/lib/crm/format';
import type { ContactSummary, DealDetail, DealListItem, Pipeline, Stage } from '@/lib/crm/types';
import { useDeal, useDealAction, useMarkSeen } from '@/lib/deals/hooks';
import { useSession } from '@/lib/session';
import { leadName, stageBubbles } from './columns';
import { AssignDialog, NoteDialog, TaskDialog } from './QuickDialogs';
import { StageMoveDialog, isStageRulesError, type MoveRequest } from './StageMoveDialog';

const AI_LABELS: Record<string, string> = {
  parentName: 'Parent',
  studentName: 'Student',
  grade: 'Grade',
  exam: 'Exam',
  targetDate: 'Target date',
  intent: 'Intent',
  language: 'Language',
  city: 'City',
  timeZone: 'Time zone',
};

function ContactLine({ contact }: { contact: ContactSummary }) {
  return (
    <span className="leads-person__methods">
      {contact.primaryPhone ? (
        contact.piiMasked ? (
          <Masked value={contact.primaryPhone} kind="phone" />
        ) : (
          <a href={`tel:${contact.primaryPhone.replace(/\s+/g, '')}`}>{formatPhone(contact.primaryPhone)}</a>
        )
      ) : null}
      {contact.primaryEmail ? (
        contact.piiMasked ? (
          <Masked value={contact.primaryEmail} kind="email" />
        ) : (
          <a href={`mailto:${contact.primaryEmail}`}>{contact.primaryEmail}</a>
        )
      ) : null}
      {!contact.primaryPhone && !contact.primaryEmail ? <span className="muted">No phone or email</span> : null}
    </span>
  );
}

function People({ deal }: { deal: DealDetail }) {
  const primary = deal.contacts.find((item) => item.isPrimary);
  const students = deal.contacts.filter((item) => item.role === 'student');
  const others = deal.contacts.filter((item) => !item.isPrimary && item.role !== 'student');
  return (
    <Section level={3} title={deal.kind === 'b2b' ? 'Institute' : 'Family'} description={deal.household ? deal.household.name : undefined}>
      <ul className="leads-people">
        {deal.kind === 'b2b' && deal.account ? (
          <li className="leads-person">
            <span className="leads-person__name">
              <Link href={`/accounts/${deal.account.id}`}>{deal.account.name}</Link>
            </span>
            <span className="muted small">{humanize(deal.account.kind)}</span>
          </li>
        ) : null}
        {primary ? (
          <li className="leads-person">
            <span className="leads-person__name">
              <Link href={`/leads/contacts?contact=${primary.contact.id}`}>{primary.contact.displayName}</Link>
              <span className="muted small"> · {humanize(primary.role)}</span>
            </span>
            <ContactLine contact={primary.contact} />
          </li>
        ) : null}
        {students.map((item) => (
          <li key={item.contact.id} className="leads-person">
            <span className="leads-person__name">
              <Link href={`/leads/contacts?contact=${item.contact.id}`}>{item.contact.displayName}</Link>
              <span className="muted small"> · Student</span>
            </span>
          </li>
        ))}
        {others.map((item) => (
          <li key={item.contact.id} className="leads-person">
            <span className="leads-person__name">
              <Link href={`/leads/contacts?contact=${item.contact.id}`}>{item.contact.displayName}</Link>
              <span className="muted small"> · {humanize(item.role)}</span>
            </span>
          </li>
        ))}
        {deal.kind === 'b2c' && students.length === 0 ? <li className="muted small">No student added yet</li> : null}
      </ul>
    </Section>
  );
}

function OriginalMessage({ deal }: { deal: DealDetail }) {
  const message = deal.originalMessage;
  return (
    <Section
      level={3}
      title="Original message"
      description={
        message ? (
          <>
            {channelLabel(message.channel)} · <DateTime value={message.receivedAt} format="short" />
          </>
        ) : undefined
      }
    >
      {message ? (
        <div className="stack gap-6">
          {message.subject ? <p className="strong">{message.subject}</p> : null}
          <blockquote className="leads-quote">{message.text}</blockquote>
          {message.from ? (
            <p className="small muted">
              From {message.from.name ?? 'the sender'}
              {message.from.phone ? <> · {formatPhone(message.from.phone)}</> : null}
              {message.from.email ? <> · {message.from.email}</> : null}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted small">{deal.channel === 'manual' ? 'Entered by hand: there is no message.' : 'No message came with this lead.'}</p>
      )}
    </Section>
  );
}

function AiFields({ deal }: { deal: DealDetail }) {
  const extracted = deal.aiFields.extracted ?? {};
  const items: KeyValueItem[] = Object.entries(extracted)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({
      key,
      label: AI_LABELS[key] ?? humanize(key),
      value: String(value),
    }));
  const confidence = deal.aiFields.confidence;
  return (
    <Section
      level={3}
      title="Captured by AI"
      actions={
        items.length > 0 && confidence !== undefined ? (
          <StatusPill tone={confidence >= 0.8 ? 'accent' : 'warning'} icon="sparkle">
            {Math.round(confidence * 100)}% confidence
          </StatusPill>
        ) : null
      }
    >
      {items.length > 0 ? (
        <KeyValue layout="stacked" items={items} />
      ) : (
        <p className="muted small">Not captured yet. The intake assistant fills these in from the first conversation.</p>
      )}
    </Section>
  );
}

function sourceText(deal: DealDetail): string {
  const touch = deal.firstTouch;
  if (!touch) return channelLabel(deal.channel);
  const parts = [channelLabel(touch.channel)];
  if (touch.campaign) parts.push(touch.campaign);
  else if (touch.utm?.campaign) parts.push(touch.utm.campaign);
  if (touch.utm?.source) parts.push(`${touch.utm.source}${touch.utm.medium ? ` / ${touch.utm.medium}` : ''}`);
  return parts.join(' · ');
}

function Details({ deal }: { deal: DealDetail }) {
  const items: KeyValueItem[] = [
    {
      label: 'Owner',
      value: deal.owner ? (
        <span className="row gap-6">
          <Avatar name={deal.owner.name} size={20} />
          {deal.owner.name}
        </span>
      ) : (
        'Unassigned'
      ),
    },
    {
      label: 'Value',
      value: deal.value.valueMinor > 0 ? <Money minor={deal.value.valueMinor} currency={deal.value.currency} exact /> : null,
    },
    {
      label: 'Product',
      value: [deal.productLine?.name, deal.product?.name].filter(Boolean).join(' › ') || null,
    },
    { label: 'Source', value: sourceText(deal) },
    { label: 'Pipeline', value: deal.pipeline.name },
    { label: 'Team', value: deal.unit.name },
    {
      label: 'Expected close',
      value: deal.expectedCloseOn ? <DateTime value={`${deal.expectedCloseOn}T00:00:00`} format="date" sans /> : null,
    },
    {
      label: 'Tags',
      value:
        deal.tags.length > 0 ? (
          <span className="leads-tags">
            {deal.tags.map((tag) => (
              <span key={tag} className="badge">
                {tag}
              </span>
            ))}
          </span>
        ) : null,
    },
    { label: 'Created', value: <RelativeTime value={deal.createdAt} /> },
    {
      label: 'Last activity',
      value: <RelativeTime value={deal.lastActivityAt} />,
    },
  ];
  return (
    <Section level={3} title="Details">
      <KeyValue items={items} />
    </Section>
  );
}

function StatusLine({ deal }: { deal: DealDetail }) {
  return (
    <div className="leads-status">
      {deal.archivedAt ? <StatusPill icon="archive">Archived</StatusPill> : null}
      {deal.status === 'won' ? <StatusPill tone="success">Won {deal.closedAt ? formatInZone(deal.closedAt, 'date') : ''}</StatusPill> : null}
      {deal.status === 'lost' ? <StatusPill tone="danger">Lost{deal.lostReason ? `: ${deal.lostReason.label}` : ''}</StatusPill> : null}
      {deal.isNew ? <NewBadge /> : null}
      {deal.nurture ? (
        <StatusPill tone="accent" icon="repeat">
          Nurture
        </StatusPill>
      ) : null}
      {deal.status === 'open' && deal.firstReplyDueAt ? (
        <SlaBadge dueAt={deal.firstReplyDueAt} completedAt={deal.firstRepliedAt} prefix="Reply" />
      ) : null}
      {deal.status === 'open' && deal.slaDueAt ? <SlaBadge dueAt={deal.slaDueAt} prefix="Stage SLA" warnWithinMinutes={120} /> : null}
    </div>
  );
}

type Open = 'assign' | 'note' | 'task' | 'archive' | null;

/**
 * The side preview of a lead: stage bubbles (click one to move), the original message, AI-captured
 * fields, the family or institute, details, and one-click actions. Opening a new lead you own marks it seen.
 */
export function LeadPreview({
  id,
  fallback,
  pipelines,
  onClose,
  onPrevious,
  onNext,
}: {
  id: string | null;
  /** The list row, shown while the detail loads. */
  fallback: DealListItem | null;
  pipelines: ReadonlyMap<string, Pipeline>;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const session = useSession();
  const detail = useDeal(id);
  const deal = detail.data && detail.data.id === id ? detail.data : null;
  const action = useDealAction(id ?? '');
  const markSeen = useMarkSeen();
  const [request, setRequest] = useState<MoveRequest | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seenRef = useRef<string | null>(null);
  // Which lead the last action was about, so an error never shows on the next lead.
  const [actedOn, setActedOn] = useState<string | null>(null);

  // A new lead stops being new once its owner opens it.
  useEffect(() => {
    if (!deal || !deal.isNew || deal.owner?.id !== session.user.id || seenRef.current === deal.id) return;
    seenRef.current = deal.id;
    markSeen.mutate(deal.id);
  }, [deal, session.user.id, markSeen]);

  // Messages belong to the lead they were about.
  const [noticeFor, setNoticeFor] = useState(id);
  if (noticeFor !== id) {
    setNoticeFor(id);
    setNotice(null);
    setRequest(null);
    setOpen(null);
    setActedOn(null);
  }
  const actionError = actedOn === id ? action.error : null;
  const run: typeof action.mutate = (variables, options) => {
    setActedOn(id);
    action.mutate(variables, options);
  };

  const pipeline = deal ? pipelines.get(deal.pipelineId) : undefined;
  const stages = stageBubbles(pipeline);
  const stageOf = (bubble: StageBubble): Stage | undefined => pipeline?.stages.find((stage) => stage.id === bubble.id);
  const unit = deal ? session.unitsById.get(deal.unit.id) : undefined;
  const canNote = unit ? session.can('timeline.write', unit) : false;
  const canTask = unit ? session.can('tasks.manage', unit) : false;
  const working = Boolean(deal && deal.can.manage && !deal.archivedAt);

  const done = (message: string) => (updated: DealDetail) => {
    setRequest(null);
    setOpen(null);
    setNotice(message.replace('{stage}', updated.stage.name));
  };

  function moveTo(bubble: StageBubble) {
    if (!deal) return;
    const stage = stageOf(bubble);
    if (!stage) return;
    setNotice(null);
    if (stage.category === 'lost') {
      setRequest({ mode: 'lose', stage });
      return;
    }
    const reopening = deal.status !== 'open' && stage.category === 'open';
    run(
      reopening
        ? { type: 'reopen', body: { stageId: stage.id } }
        : {
            type: 'move',
            body: { stageId: stage.id, fromStageId: deal.stage.id },
          },
      {
        onSuccess: done(reopening ? 'Reopened in {stage}.' : 'Moved to {stage}.'),
        onError: (error) => {
          if (!isStageRulesError(error)) return;
          const names = (error.details.allowedFrom ?? []).map((key) => pipeline?.stages.find((item) => item.key === key)?.name ?? key);
          setRequest({
            mode: 'fields',
            stage,
            details: error.details,
            message: error.message,
            allowedNames: names,
          });
        },
      },
    );
  }

  const firstWon = pipeline?.stages
    .filter((stage) => stage.category === 'won' && stage.archivedAt === null)
    .sort((a, b) => a.position - b.position)[0];
  const moreItems: MenuItem[] = deal
    ? [
        ...(deal.can.assign && !deal.archivedAt
          ? [
              {
                key: 'assign',
                label: 'Assign to…',
                icon: 'user' as const,
                onSelect: () => setOpen('assign'),
              },
            ]
          : []),
        ...(working && deal.status === 'open' && firstWon
          ? [
              {
                key: 'won',
                label: `Mark won (${firstWon.name})`,
                icon: 'check' as const,
                onSelect: () =>
                  moveTo({
                    id: firstWon.id,
                    name: firstWon.name,
                    outcome: 'won',
                  }),
              },
            ]
          : []),
        ...(working && deal.status !== 'open'
          ? [
              {
                key: 'reopen',
                label: 'Reopen',
                icon: 'restore' as const,
                onSelect: () => run({ type: 'reopen', body: {} }, { onSuccess: done('Reopened in {stage}.') }),
              },
            ]
          : []),
        ...(deal.can.archive && !deal.archivedAt
          ? [
              {
                key: 'archive',
                label: 'Archive',
                icon: 'archive' as const,
                danger: true,
                onSelect: () => setOpen('archive'),
              },
            ]
          : []),
        ...(deal.can.archive && deal.archivedAt
          ? [
              {
                key: 'restore',
                label: 'Restore',
                icon: 'restore' as const,
                onSelect: () => run({ type: 'restore' }, { onSuccess: done('Restored.') }),
              },
            ]
          : []),
      ]
    : [];

  const name = deal ? leadName(deal) : fallback ? leadName(fallback) : 'Lead';
  const summary = deal ?? fallback;

  const footer = deal ? (
    <>
      {deal.can.assign && !deal.archivedAt && deal.owner?.id !== session.user.id ? (
        <Button
          variant="primary"
          icon="user"
          loading={action.isPending && action.variables?.type === 'assign'}
          onClick={() => run({ type: 'assign', body: { ownerUserId: session.user.id } }, { onSuccess: done('Assigned to you.') })}
        >
          Assign to me
        </Button>
      ) : null}
      {canNote ? (
        <Button icon="note" onClick={() => setOpen('note')}>
          Add note
        </Button>
      ) : null}
      {canTask ? (
        <Button icon="tasks" onClick={() => setOpen('task')}>
          Add task
        </Button>
      ) : null}
      {working && deal.status === 'open' ? (
        <Button icon="x" onClick={() => setRequest({ mode: 'lose', stage: null })}>
          Mark lost
        </Button>
      ) : null}
      {moreItems.length > 0 ? (
        <Menu
          label={`More actions for ${name}`}
          items={moreItems}
          placement="bottom-end"
          trigger={(trigger) => <Button {...trigger} iconOnly icon="more" aria-label="More actions" />}
        />
      ) : null}
    </>
  ) : undefined;

  return (
    <>
      <SidePanel
        open={id !== null}
        onClose={onClose}
        size="lg"
        title={
          <span className="leads-preview__title">
            {name}
            {summary?.isNew ? <NewBadge /> : null}
          </span>
        }
        subtitle={
          summary ? (
            <span className="row gap-8">
              <ChannelBadge channel={summary.channel} />
              <Mono>{summary.ref}</Mono>
              <span className="muted small">
                Created <RelativeTime value={summary.createdAt} sans />
              </span>
            </span>
          ) : null
        }
        actions={
          <>
            <Button size="sm" variant="ghost" iconOnly icon="arrowUp" aria-label="Previous lead" disabled={!onPrevious} onClick={onPrevious} />
            <Button size="sm" variant="ghost" iconOnly icon="arrowDown" aria-label="Next lead" disabled={!onNext} onClick={onNext} />
            {id ? (
              <ButtonLink href={`/leads/${id}`} size="sm" icon="external">
                Open full profile
              </ButtonLink>
            ) : null}
          </>
        }
        footer={footer}
      >
        {detail.isError && !deal ? (
          <ErrorAlert error={detail.error} title="Couldn't load this lead" />
        ) : !deal ? (
          <div className="leads-preview__loading">
            <Spinner label="Loading the lead" />
          </div>
        ) : (
          <div className="stack gap-20">
            <div className="stack gap-8">
              {stages.length > 0 ? (
                <StageBubbles
                  size="full"
                  stages={stages}
                  currentId={deal.stage.id}
                  label={working ? `Move ${name} to a stage` : `Stage of ${name}`}
                  onSelect={working ? moveTo : undefined}
                  disabled={action.isPending}
                />
              ) : (
                <p>
                  Stage: <strong>{deal.stage.name}</strong>
                </p>
              )}
              <StatusLine deal={deal} />
            </div>
            <p className="visually-hidden" role="status">
              {notice ?? ''}
            </p>
            {notice ? (
              <Alert
                tone="success"
                action={<Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss" onClick={() => setNotice(null)} />}
              >
                {notice}
              </Alert>
            ) : null}
            {actionError && !isStageRulesError(actionError) && request === null && open === null ? <ErrorAlert error={actionError} /> : null}
            {deal.status === 'lost' && deal.lostNote ? <p className="small muted">Lost note: {deal.lostNote}</p> : null}
            <OriginalMessage deal={deal} />
            <AiFields deal={deal} />
            <People deal={deal} />
            <Details deal={deal} />
          </div>
        )}
      </SidePanel>
      {/* Outside the panel in the React tree: a nested dialog's cancel and close events would otherwise bubble to the panel and close it. */}
      {deal ? (
        <>
          <StageMoveDialog
            deal={deal}
            request={request}
            onClose={() => setRequest(null)}
            onDone={done(request?.mode === 'lose' ? 'Marked lost.' : 'Moved to {stage}.')}
          />
          <AssignDialog deal={deal} open={open === 'assign'} onClose={() => setOpen(null)} onDone={done('Owner changed.')} />
          <NoteDialog
            deal={deal}
            open={open === 'note'}
            onClose={() => setOpen(null)}
            onDone={() => {
              setOpen(null);
              setNotice('Note added to the timeline.');
            }}
          />
          <TaskDialog
            deal={deal}
            open={open === 'task'}
            onClose={() => setOpen(null)}
            onDone={() => {
              setOpen(null);
              setNotice('Task added.');
            }}
          />
          <ConfirmDialog
            open={open === 'archive'}
            onClose={() => setOpen(null)}
            title="Archive this lead?"
            confirmLabel="Archive"
            danger
            pending={action.isPending}
            error={open === 'archive' ? actionError : null}
            onConfirm={() => run({ type: 'archive', body: {} }, { onSuccess: done('Archived. It no longer shows in lists.') })}
          >
            <p>
              {name} ({deal.ref}) leaves every list and search. People who can archive leads can restore it.
            </p>
          </ConfirmDialog>
        </>
      ) : null}
    </>
  );
}
