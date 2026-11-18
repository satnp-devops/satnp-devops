'use client';

import { DateTime, StatusPill } from '@/components/crm';
import { Icon } from '@/components/icons';
import { Button, EmptyState, ErrorAlert, Spinner, cx } from '@/components/ui';
import { CHANNEL_ICONS, CHANNEL_NAMES, MESSAGE_STATUS } from '@/lib/messaging/display';
import { useMessages } from '@/lib/messaging/queries';
import type { Message, MessagingSubject } from '@/lib/messaging/types';
import './messaging.css';

function who(message: Message): string {
  if (message.direction === 'inbound') return 'They wrote';
  if (message.agent) return message.agent.type === 'bot' ? `Bot${message.agent.name ? ` (${message.agent.name})` : ''}` : (message.agent.name ?? 'Agent');
  if (message.sentBy) return message.sentBy.name;
  return message.actorType === 'ai' ? 'AI' : 'Automation';
}

function MessageItem({ message }: { message: Message }) {
  const outbound = message.direction === 'outbound';
  const status = MESSAGE_STATUS[message.status];
  return (
    <li
      className={cx('msg-item', outbound && 'msg-item--out', message.status === 'failed' && 'msg-item--failed', message.status === 'queued' && 'msg-item--pending')}
    >
      <div className="msg-item__bubble">
        {message.subject ? <span className="msg-item__subject">{message.subject}</span> : null}
        {message.body ?? <span className="muted">{message.media.length ? `${message.media.length} attachment(s)` : 'No text'}</span>}
      </div>
      <div className="msg-item__meta">
        <Icon name={CHANNEL_ICONS[message.channel]} size={13} />
        <span className="visually-hidden">{CHANNEL_NAMES[message.channel]}:</span>
        <span>{who(message)}</span>
        {message.template ? <span className="mono">{message.template.name}</span> : null}
        <DateTime value={message.occurredAt} format="short" />
        {outbound ? (
          <StatusPill tone={status.tone} icon={message.status === 'read' || message.status === 'delivered' ? 'check' : undefined}>
            {status.label}
          </StatusPill>
        ) : null}
      </div>
      {message.error ? <p className="msg-item__meta msg-item__error">{message.error.message}</p> : null}
    </li>
  );
}

/** The messages of a deal or person, newest first, with delivery status. Shows optimistic sends from the reply box. */
export function MessageThread({ subject }: { subject: MessagingSubject }) {
  const messages = useMessages(subject);
  if (messages.isPending) return <Spinner label="Loading messages" />;
  if (messages.isError) return <ErrorAlert error={messages.error} title="Messages could not be loaded" />;
  const rows = messages.data.pages.flatMap((page) => page.data);
  if (rows.length === 0) {
    return (
      <EmptyState icon="message" title="No messages yet">
        Messages sent and received on WhatsApp, email and SMS appear here.
      </EmptyState>
    );
  }
  return (
    <div className="stack gap-12">
      <ol className="msg-thread" aria-label="Messages, newest first">
        {rows.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </ol>
      {messages.hasNextPage ? (
        <Button size="sm" variant="ghost" loading={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>
          Show older messages
        </Button>
      ) : null}
    </div>
  );
}
