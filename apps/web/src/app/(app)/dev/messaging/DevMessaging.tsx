'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageThread, ReplyBox } from '@/components/messaging';
import { Alert, Button, Card, EmptyState, ErrorAlert, Field, PageHeader, PageLoading } from '@/components/ui';
import { api } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { CHANNEL_NAMES, MESSAGE_CHANNELS } from '@/lib/messaging/display';
import { messagingKeys, useDevDeals, useMessages } from '@/lib/messaging/queries';
import type { DevDeal, Message, MessageChannel } from '@/lib/messaging/types';
import { useSession } from '@/lib/session';
import './dev-messaging.css';

/** Try the reply box on a real deal, pretend the person wrote back, pretend the provider delivered. */
export function DevMessaging() {
  const { scope } = useSession();
  const deals = useDevDeals(scope.id);
  const [dealId, setDealId] = useState('');
  const deal = deals.data?.find((d) => d.id === dealId) ?? deals.data?.[0] ?? null;

  return (
    <>
      <PageHeader title="Messaging playground" description="Development only: the reply box and message thread on a deal in your working scope, sending through the mock connections." />
      <div className="content stack gap-16">
        {deals.isPending ? (
          <PageLoading />
        ) : deals.isError ? (
          <ErrorAlert error={deals.error} title="Deals could not be loaded" />
        ) : !deal ? (
          <Card>
            <EmptyState icon="inbox" title="No open deals here">
              Pick another place in &ldquo;Working in&rdquo;, or seed the demo data.
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card>
              <Field label="Deal" hint={`${deal.company.name} · ${deal.contact.displayName}`}>
                {(control) => (
                  <select {...control} className="select" value={deal.id} onChange={(e) => setDealId(e.target.value)}>
                    {(deals.data ?? []).map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.ref}: {d.title} ({d.contact.displayName})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </Card>
            <div className="devmsg-grid">
              <div className="stack gap-16">
                <ReplyBox dealId={deal.id} />
                <Pretend deal={deal} />
              </div>
              <Card title="Messages" description="Newest first. Sends appear here at once (optimistic) and settle when the server answers.">
                <MessageThread subject={{ dealId: deal.id }} />
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Pretend({ deal }: { deal: DevDeal }) {
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<MessageChannel>('whatsapp');
  const [text, setText] = useState('Hi! Is the weekend batch still open?');
  const messages = useMessages({ dealId: deal.id });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: messagingKeys.messages({ dealId: deal.id }) }),
      queryClient.invalidateQueries({ queryKey: messagingKeys.context({ dealId: deal.id }) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.timeline.subject('deal', deal.id) }),
    ]);
  const inbound = useMutation({
    mutationFn: () => api.post<Message>('/messaging/dev/inbound', { dealId: deal.id, channel, text }),
    onSuccess: refresh,
  });
  const status = useMutation({
    mutationFn: (input: { messageId: string; status: 'delivered' | 'read' | 'failed' }) => api.post<Message>('/messaging/dev/status', input),
    onSuccess: refresh,
  });
  const outbound = (messages.data?.pages.flatMap((p) => p.data) ?? []).filter((m) => m.direction === 'outbound' && m.providerMessageId).slice(0, 4);

  return (
    <Card title="Pretend" description="What a provider webhook would do.">
      <div className="stack gap-12">
        <div className="devmsg-row">
          <Field label="They write on">
            {(control) => (
              <select {...control} className="select" value={channel} onChange={(e) => setChannel(e.target.value as MessageChannel)}>
                {MESSAGE_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_NAMES[c]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Message">
            {(control) => <input {...control} className="input" value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        </div>
        <div>
          <Button icon="inbox" onClick={() => inbound.mutate()} loading={inbound.isPending} disabled={!text.trim()}>
            They wrote back
          </Button>
        </div>
        {inbound.isSuccess ? <Alert tone="success">Received. On WhatsApp this opens the 24-hour window.</Alert> : null}
        <ErrorAlert error={inbound.error ?? status.error} />
        {outbound.length > 0 ? (
          <ul className="devmsg-list" aria-label="Recent sends">
            {outbound.map((m) => (
              <li key={m.id}>
                <span className="small">
                  {CHANNEL_NAMES[m.channel]} {m.template?.name ?? 'message'}: <strong>{m.status}</strong>
                </span>
                <span className="row gap-6">
                  <Button size="sm" onClick={() => status.mutate({ messageId: m.id, status: 'delivered' })}>
                    Delivered
                  </Button>
                  <Button size="sm" onClick={() => status.mutate({ messageId: m.id, status: 'read' })}>
                    Read
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
