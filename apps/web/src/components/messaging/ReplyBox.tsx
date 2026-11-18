'use client';

import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useModifierKey, useNow } from '@/components/crm';
import { Icon } from '@/components/icons';
import { Alert, Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, isApiError } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { CATEGORY_NAMES, CHANNEL_ICONS, CHANNEL_NAMES, MESSAGE_STATUS, consentAllows, newClientId, windowLabel } from '@/lib/messaging/display';
import { messagingKeys, useReplyContext } from '@/lib/messaging/queries';
import { renderTemplate } from '@/lib/messaging/render';
import type { Message, MessageChannel, MessagingSubject, ReplyChannel, ReplyContext, ReplyTemplate, SendMessageBody } from '@/lib/messaging/types';
import { useSession } from '@/lib/session';
import type { Page } from '@/lib/types';
import { TemplatePreview } from './TemplatePreview';
import { VariablesForm } from './VariablesForm';
import './messaging.css';

type Mode = 'text' | 'template';

const BLOCK_HELP: Record<string, string> = {
  outside_window: 'The 24-hour window has closed. Pick an approved template instead.',
  marketing_consent_missing: 'This is a marketing template and they have not given marketing consent on this channel.',
  consent_withdrawn: 'They withdrew consent for this kind of message on this channel.',
  opted_out: 'This number or address is opted out of all messages.',
  template_required: 'SMS can only send registered templates.',
};

/** Which mode a channel starts in: free text when it is allowed right now, else a template. */
function defaultMode(channel: ReplyChannel | undefined, methodId: string | null, now: number): Mode {
  if (!channel || !channel.freeText) return 'template';
  if (channel.channel !== 'whatsapp') return 'text';
  const address = channel.addresses.find((a) => a.methodId === methodId);
  return windowLabel(address?.window ?? null, now).open ? 'text' : 'template';
}

function firstChannel(context: ReplyContext): MessageChannel {
  return (context.channels.find((c) => c.channel === 'whatsapp' && c.available) ?? context.channels.find((c) => c.available) ?? context.channels[0])?.channel ?? 'whatsapp';
}

/**
 * The reply box for a deal or a person: channel picker, WhatsApp's 24-hour window, free text or an
 * approved template with its variables, a live preview, and send with an optimistic update.
 *
 *   <ReplyBox dealId={deal.id} />                       the deal's primary contact
 *   <ReplyBox dealId={deal.id} contactId={studentId} />  someone else on the deal
 *   <ReplyBox contactId={id} companyId={companyId} />   a person, without a deal
 *
 * Sends invalidate the deal's and person's timeline, the deal and the message list.
 */
export function ReplyBox({ dealId, contactId, companyId, onSent }: MessagingSubject & { onSent?: (message: Message) => void }) {
  const subject = useMemo(() => ({ dealId, contactId, companyId }), [dealId, contactId, companyId]);
  const context = useReplyContext(subject);

  if (context.isPending) {
    return (
      <section className="msg-reply" aria-label="Reply" aria-busy="true">
        <Spinner label="Loading the reply box" />
      </section>
    );
  }
  if (context.isError) {
    return (
      <section className="msg-reply" aria-label="Reply">
        <ErrorAlert error={context.error} title="The reply box could not be loaded" />
        <div>
          <Button size="sm" icon="refresh" onClick={() => void context.refetch()}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  // Keyed by subject so switching deal or person starts a fresh draft.
  return <Composer key={`${dealId ?? ''}:${contactId ?? ''}:${companyId ?? ''}`} context={context.data} subject={subject} onSent={onSent} />;
}

function Composer({ context, subject, onSent }: { context: ReplyContext; subject: MessagingSubject; onSent?: (message: Message) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const now = useNow();
  const modifier = useModifierKey();
  const ids = useId();

  const [channelKey, setChannelKey] = useState<MessageChannel>(() => firstChannel(context));
  const channel = context.channels.find((c) => c.channel === channelKey);
  const [methods, setMethods] = useState<Partial<Record<MessageChannel, string>>>({});
  const methodId = methods[channelKey] ?? channel?.defaultMethodId ?? null;
  const address = channel?.addresses.find((a) => a.methodId === methodId) ?? null;
  const window = channelKey === 'whatsapp' ? windowLabel(address?.window ?? null, now) : null;

  const [modes, setModes] = useState<Partial<Record<MessageChannel, Mode>>>({});
  const mode: Mode = modes[channelKey] ?? defaultMode(channel, methodId, now);
  const [text, setText] = useState('');
  const [subjectLine, setSubjectLine] = useState('');
  const [templateIds, setTemplateIds] = useState<Partial<Record<MessageChannel, string>>>({});
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...context.defaults }));
  const [clientId, setClientId] = useState(newClientId);
  const [lastSent, setLastSent] = useState<Message | null>(null);

  const templates = context.templates.filter((t) => t.channel === channelKey);
  const template: ReplyTemplate | null = templates.find((t) => t.id === templateIds[channelKey]) ?? null;

  const textBlocked = channel?.channel === 'whatsapp' && window !== null && !window.open;
  const purpose = mode === 'template' ? (template?.purpose ?? null) : 'service';
  const consentState = purpose && channel ? channel.consent[purpose] : 'unknown';
  const consentOk = !purpose || consentAllows(consentState, purpose);
  const rendered = template ? renderTemplate(template, values) : null;

  const messagesKey = messagingKeys.messages(subject);
  const send = useMutation({
    mutationFn: (body: SendMessageBody) => api.post<Message>('/messaging/messages', body),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: messagesKey });
      const optimistic: Message = {
        id: `pending-${body.clientId ?? clientId}`,
        conversationId: address?.conversationId ?? '',
        companyId: context.company.id,
        contactId: context.contact.id,
        dealId: context.deal?.id ?? null,
        channel: body.channel,
        direction: 'outbound',
        status: 'queued',
        purpose: purpose ?? 'service',
        template: template ? { id: template.id, name: template.name, version: template.version } : null,
        variables: {},
        subject: body.subject ?? rendered?.subject ?? null,
        body: body.text ?? (rendered ? [rendered.header, rendered.body, rendered.footer].filter(Boolean).join('\n\n') : null),
        media: [],
        to: address?.value ?? null,
        from: null,
        piiMasked: context.contact.piiMasked,
        provider: address?.connection?.provider ?? null,
        providerMessageId: null,
        source: 'crm',
        actorType: 'user',
        sentBy: { id: session.user.id, name: session.user.name },
        agent: null,
        error: null,
        occurredAt: new Date().toISOString(),
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        failedAt: null,
        receivedAt: null,
        createdAt: new Date().toISOString(),
      };
      queryClient.setQueryData<InfiniteData<Page<Message>>>(messagesKey, (old) => {
        const first = old?.pages[0];
        if (!old || !first) return old;
        return { ...old, pages: [{ data: [optimistic, ...first.data], nextCursor: first.nextCursor }, ...old.pages.slice(1)] };
      });
      return { optimisticId: optimistic.id };
    },
    onSuccess: (message, _body, result) => {
      queryClient.setQueryData<InfiniteData<Page<Message>>>(messagesKey, (old) =>
        old ? { ...old, pages: old.pages.map((page) => ({ ...page, data: page.data.map((m) => (m.id === result?.optimisticId ? message : m)) })) } : old,
      );
      setLastSent(message);
      if (message.status !== 'failed') {
        setText('');
        setSubjectLine('');
        setValues({ ...context.defaults });
      }
      setClientId(newClientId());
      onSent?.(message);
    },
    onError: (_error, _body, result) => {
      // Roll the optimistic message back; the draft stays so the person can try again.
      queryClient.setQueryData<InfiniteData<Page<Message>>>(messagesKey, (old) =>
        old ? { ...old, pages: old.pages.map((page) => ({ ...page, data: page.data.filter((m) => m.id !== result?.optimisticId) })) } : old,
      );
    },
    onSettled: async () => {
      const keys = [
        messagesKey,
        messagingKeys.context(subject),
        crmKeys.timeline.subject('contact', context.contact.id),
        ...(context.deal ? [crmKeys.timeline.subject('deal', context.deal.id), crmKeys.deals.detail(context.deal.id)] : []),
      ];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
  });

  const serverFields = isApiError(send.error) ? send.error.fieldErrors : {};
  const variableErrors = Object.fromEntries(
    Object.entries(serverFields)
      .filter(([key]) => key.startsWith('variables.'))
      .map(([key, message]) => [key.slice('variables.'.length), message]),
  );
  const blockReason = isApiError(send.error) && send.error.code === 'message_blocked' && typeof send.error.details === 'object' && send.error.details !== null && 'reason' in send.error.details ? String(send.error.details.reason) : null;

  if (!context.can.send) {
    return (
      <section className="msg-reply" aria-label="Reply">
        <p className="msg-reply__note">
          {context.contact.erased ? "This person's data was erased on request, so they can't be messaged." : 'You can see these messages but not send them here.'}
        </p>
      </section>
    );
  }

  const canSendNow =
    Boolean(channel?.available) &&
    Boolean(address) &&
    !address?.optedOut &&
    consentOk &&
    !send.isPending &&
    (mode === 'text' ? !textBlocked && text.trim().length > 0 && (channelKey !== 'email' || subjectLine.trim().length > 0) : Boolean(template) && rendered?.missing.length === 0);

  function submit() {
    if (!canSendNow || !channel) return;
    const base: SendMessageBody = { ...subject, channel: channelKey, methodId: methodId ?? undefined, clientId };
    if (context.deal) base.dealId = context.deal.id;
    if (mode === 'text') {
      send.mutate({ ...base, text: text.trim(), ...(channelKey === 'email' ? { subject: subjectLine.trim() } : {}) });
    } else if (template) {
      const variables: Record<string, string> = {};
      for (const name of template.variables) {
        const value = (values[name] ?? '').trim();
        if (value) variables[name] = value;
      }
      send.mutate({ ...base, templateId: template.id, variables });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  }

  function pickTemplate(id: string) {
    setTemplateIds((current) => ({ ...current, [channelKey]: id }));
    send.reset();
  }

  const hints: Record<string, string> = {};
  for (const name of Object.keys(context.defaults)) hints[name] = 'Filled in for you';

  return (
    <section className="msg-reply" aria-label={`Message ${context.contact.displayName}`}>
      <div className="msg-reply__top">
        <fieldset className="msg-segment">
          <legend>Channel</legend>
          {context.channels.map((c) => (
            <label key={c.channel} title={c.available ? undefined : (c.unavailableReason ?? undefined)}>
              <input
                type="radio"
                name={`${ids}-channel`}
                value={c.channel}
                checked={channelKey === c.channel}
                disabled={!c.available}
                onChange={() => {
                  setChannelKey(c.channel);
                  send.reset();
                }}
              />
              <Icon name={CHANNEL_ICONS[c.channel]} size={15} />
              {c.label}
              {!c.available ? <span className="visually-hidden">(unavailable: {c.unavailableReason})</span> : null}
            </label>
          ))}
        </fieldset>
        {window ? (
          <span className={`msg-window ${window.open ? 'msg-window--open' : 'msg-window--closed'}`} role="status">
            <Icon name="clock" size={14} />
            {window.text}
          </span>
        ) : null}
      </div>

      {channel && !channel.available ? (
        <Alert tone="warning" title={`${channel.label} isn't available`}>
          {channel.unavailableReason}
        </Alert>
      ) : null}

      {channel && channel.addresses.length > 0 ? (
        <div className="msg-reply__to">
          <label htmlFor={`${ids}-to`}>To</label>
          {channel.addresses.length > 1 ? (
            <select
              id={`${ids}-to`}
              className="select"
              value={methodId ?? ''}
              onChange={(e) => setMethods((current) => ({ ...current, [channelKey]: e.target.value }))}
            >
              {channel.addresses.map((a) => (
                <option key={a.methodId} value={a.methodId} disabled={a.optedOut}>
                  {a.value}
                  {a.label ? ` (${a.label})` : ''}
                  {a.optedOut ? ' (opted out)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <output id={`${ids}-to`} className="mono">
              {address?.value}
              {address?.label ? ` (${address.label})` : ''}
            </output>
          )}
          <span>{context.contact.displayName}</span>
        </div>
      ) : null}

      {address?.handledBy === 'bot' ? <p className="msg-reply__note">The WhatsApp tool&apos;s bot is handling this chat.</p> : null}
      {address?.handledBy === 'human' ? <p className="msg-reply__note">Someone is answering this chat in the WhatsApp tool.</p> : null}

      {channel?.available ? (
        <>
          {channel.freeText ? (
            <fieldset className="msg-segment">
              <legend>What to send</legend>
              <label title={textBlocked ? 'Outside the 24-hour window' : undefined}>
                <input type="radio" name={`${ids}-mode`} checked={mode === 'text'} disabled={textBlocked} onChange={() => setModes((m) => ({ ...m, [channelKey]: 'text' }))} />
                Message
              </label>
              <label>
                <input type="radio" name={`${ids}-mode`} checked={mode === 'template'} onChange={() => setModes((m) => ({ ...m, [channelKey]: 'template' }))} />
                Template
              </label>
            </fieldset>
          ) : null}

          {mode === 'text' ? (
            <div className="stack gap-10">
              {channelKey === 'email' ? (
                <Field label="Subject" error={serverFields.subject}>
                  {(control) => <input {...control} className="input" value={subjectLine} maxLength={200} onChange={(e) => setSubjectLine(e.target.value)} />}
                </Field>
              ) : null}
              <Field label="Message" hint={`${modifier}+Enter to send`} error={serverFields.text}>
                {(control) => (
                  <textarea
                    {...control}
                    className="textarea"
                    rows={4}
                    value={text}
                    maxLength={4096}
                    disabled={textBlocked}
                    placeholder={textBlocked ? 'Outside the 24-hour window: send a template' : `Write to ${context.contact.firstName ?? context.contact.displayName}`}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                  />
                )}
              </Field>
            </div>
          ) : (
            <div className="msg-reply__grid">
              <div className="stack gap-10">
                <Field label="Template" hint={templates.length === 0 ? `No approved ${CHANNEL_NAMES[channelKey]} templates yet` : undefined}>
                  {(control) => (
                    <select {...control} className="select" value={template?.id ?? ''} onChange={(e) => pickTemplate(e.target.value)} disabled={templates.length === 0}>
                      <option value="">Pick a template</option>
                      {templates.map((t) => {
                        const allowed = consentAllows(channel.consent[t.purpose], t.purpose);
                        return (
                          <option key={t.id} value={t.id} disabled={!allowed}>
                            {t.name} ({t.language}, {CATEGORY_NAMES[t.category].toLowerCase()}){allowed ? '' : ' needs consent'}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </Field>
                {template ? (
                  <VariablesForm
                    idPrefix={ids}
                    variables={template.variables}
                    values={values}
                    hints={hints}
                    errors={variableErrors}
                    onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
                  />
                ) : null}
              </div>
              {template ? <TemplatePreview template={template} variables={values} /> : null}
            </div>
          )}

          {!consentOk && purpose ? (
            <Alert tone="warning" title="They haven't agreed to this">
              {purpose === 'marketing'
                ? `Marketing messages on ${CHANNEL_NAMES[channelKey]} need their consent first.`
                : `They withdrew consent for ${purpose} messages on ${CHANNEL_NAMES[channelKey]}.`}
            </Alert>
          ) : null}
        </>
      ) : null}

      {send.error ? (
        <Alert tone="error" title={blockReason ? "This message can't be sent" : 'Not sent'}>
          {send.error instanceof Error ? send.error.message : 'Something went wrong.'}
          {blockReason && BLOCK_HELP[blockReason] ? ` ${BLOCK_HELP[blockReason]}` : ''}
        </Alert>
      ) : null}
      {lastSent?.status === 'failed' && !send.isPending ? (
        <Alert tone="error" title="The provider didn't accept it">
          {lastSent.error?.message ?? 'The message could not be sent.'} Your draft is still here: try again.
        </Alert>
      ) : null}

      <div className="msg-reply__footer">
        <span className="msg-reply__via">
          {address?.connection ? (
            <>
              <Icon name="plug" size={13} />
              via {address.connection.name}
              {address.connection.mock ? ' (sandbox: nothing leaves this server)' : ''}
            </>
          ) : null}
        </span>
        <div className="row gap-10">
          {send.isPending ? (
            <span className="msg-reply__status" role="status">
              Sending…
            </span>
          ) : lastSent && lastSent.status !== 'failed' ? (
            <span className="msg-reply__status" role="status">
              <Icon name="check" size={14} />
              {MESSAGE_STATUS[lastSent.status].label}
            </span>
          ) : null}
          <Button variant="primary" icon="arrowRight" onClick={submit} disabled={!canSendNow} loading={send.isPending}>
            Send
          </Button>
        </div>
      </div>
    </section>
  );
}
