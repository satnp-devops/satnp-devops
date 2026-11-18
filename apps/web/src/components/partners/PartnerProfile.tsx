'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, DateTime, KeyValue, Masked, Mono, Section, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { ConfirmDialog } from '@/components/dialog';
import { Button, EmptyState, ErrorAlert, PageHeader, PageLoading } from '@/components/ui';
import { api, isApiError } from '@/lib/api';
import { SOURCE_LABEL, kindLabel, moneyList } from '@/lib/partners/format';
import { partnerKeys, useAttributions, useCommissions, usePartner, useReferralLinks } from '@/lib/partners/queries';
import type { Attribution, Commission, PartnerDetail, Partnership, PayoutDetailsRead, ReferralLink } from '@/lib/partners/types';
import { useSession } from '@/lib/session';
import { Amount, BackLink, Code, CommissionPill, PartnershipPill, ShareLink, Stat } from './Parts';
import { LinkDialog, PartnershipDialog, PayoutDetailsDialog, PortalAccessDialog } from './ProfileDialogs';

export function PartnerProfile({ id }: { id: string }) {
  const partner = usePartner(id);
  if (partner.isPending) return <PageLoading />;
  if (partner.isError) {
    return (
      <div className="content">
        {isApiError(partner.error) && partner.error.status === 404 ? (
          <EmptyState icon="handshake" title="Partner not found" action={<Link href="/partners">Back to partners</Link>}>
            They may belong to a company outside your work.
          </EmptyState>
        ) : (
          <ErrorAlert error={partner.error} />
        )}
      </div>
    );
  }
  return <Profile partner={partner.data} />;
}

function Profile({ partner }: { partner: PartnerDetail }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partnership | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [portalOpen, setPortalOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.delete(`/partners/${partner.id}/portal-access`),
    onSuccess: () => {
      setRevoking(false);
      void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
    },
  });
  const pending = partner.stats.commissions.pending;
  const approved = partner.stats.commissions.approved;
  const paid = partner.stats.commissions.paid;

  return (
    <>
      <PageHeader
        title={
          <span className="row gap-8">
            {partner.name}
            {partner.code ? <Code>{partner.code}</Code> : null}
          </span>
        }
        description={`${kindLabel(partner.kind)}${partner.city ? ` · ${partner.city}` : ''} · Partner since ${new Date(partner.createdAt).getFullYear()}`}
        actions={
          partner.can.manage ? (
            <Button variant="primary" icon="link" onClick={() => setLinkOpen(true)}>
              New referral link
            </Button>
          ) : null
        }
      />
      <div className="content stack gap-16">
        <BackLink href="/partners">All partners</BackLink>
        <div className="partners-stats">
          <Stat label="Referred leads" value={partner.stats.referredLeads} />
          <Stat label="Active links" value={partner.stats.activeLinks} />
          <Stat label="Awaiting approval" value={moneyList(pending)} />
          <Stat label="Approved, unpaid" value={moneyList(approved)} />
          <Stat label="Paid out" value={moneyList(paid)} />
        </div>
        <div className="partners-profile">
          <div className="partners-profile__main">
            <Section title="Partnerships" count={partner.companies.length} flush>
              <ul className="partners-list">
                {partner.companies.map((c) => (
                  <li key={c.id}>
                    <div className="partners-list__text">
                      <p className="partners-list__title">
                        {c.company?.name} <PartnershipPill status={c.status} />
                      </p>
                      <p className="partners-sub">
                        {c.unit?.name} · Counsellor: {c.owner?.name ?? 'assigned as usual'} · Plan: {c.commissionPlan?.name ?? 'matched by product line'}
                      </p>
                    </div>
                    {partner.can.manage ? (
                      <Button size="sm" icon="edit" onClick={() => setEditing(c)} aria-label={`Change the partnership with ${c.company?.name}`}>
                        Change
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
            <LinksSection partner={partner} unitId={scope.id} />
            <LeadsSection partnerId={partner.id} unitId={scope.id} />
            <CommissionsSection partnerId={partner.id} unitId={scope.id} />
          </div>
          <div className="partners-profile__side">
            <Section title="Details">
              <KeyValue
                layout="stacked"
                items={[
                  { label: 'Legal name', value: partner.legalName ?? '—' },
                  {
                    label: 'Email',
                    value: partner.email ? (partner.piiMasked ? <Masked value={partner.email} kind="email" label="Email" /> : partner.email) : '—',
                  },
                  {
                    label: 'Phone',
                    value: partner.phone ? (partner.piiMasked ? <Masked value={partner.phone} kind="phone" label="Phone" /> : <Mono>{partner.phone}</Mono>) : '—',
                  },
                  { label: 'Notes', value: partner.notes ?? '—' },
                ]}
              />
            </Section>
            <Section
              title="Payouts to"
              actions={
                partner.can.changePayoutDetails ? (
                  <Button size="sm" icon="edit" onClick={() => setPayoutOpen(true)}>
                    {partner.payout ? 'Change' : 'Add'}
                  </Button>
                ) : null
              }
            >
              {partner.payout ? (
                <div className="stack gap-8">
                  <p className="strong">{partner.payout.summary}</p>
                  <p className="small muted">
                    {partner.payout.accountName}
                    {partner.payout.panOnFile ? ' · PAN on file' : ' · No PAN yet'}
                  </p>
                  {partner.can.payoutDetails ? <RevealDetails partnerId={partner.id} /> : null}
                </div>
              ) : (
                <p className="small muted">No bank or UPI details yet. Their commissions wait until finance adds them.</p>
              )}
            </Section>
            <Section
              title="Partner portal"
              actions={
                partner.can.manage ? (
                  partner.hasPortalAccess ? (
                    <Button size="sm" variant="danger" onClick={() => setRevoking(true)}>
                      Remove sign-in
                    </Button>
                  ) : (
                    <Button size="sm" icon="mail" onClick={() => setPortalOpen(true)}>
                      Invite
                    </Button>
                  )
                ) : null
              }
            >
              {partner.hasPortalAccess ? (
                <p className="small">
                  {partner.portalUser?.status === 'invited' ? 'Invited, not signed in yet' : 'Signs in to see their links, leads and commissions'}
                  {partner.portalUser?.email ? ` · ${partner.portalUser.email}` : ''}
                </p>
              ) : partner.portalUser ? (
                <p className="small muted">
                  Another company gave them a sign-in
                  {partner.portalUser.email ? ` (${partner.portalUser.email})` : ''}. Invite that email to add your partnership to it.
                </p>
              ) : (
                <p className="small muted">No sign-in. Invite them to see their own referral links, leads, commissions and payouts.</p>
              )}
            </Section>
          </div>
        </div>
      </div>
      <PartnershipDialog partnerId={partner.id} partnership={editing} onClose={() => setEditing(null)} />
      <LinkDialog partner={partner} open={linkOpen} onClose={() => setLinkOpen(false)} />
      <PayoutDetailsDialog partner={partner} open={payoutOpen} onClose={() => setPayoutOpen(false)} />
      <PortalAccessDialog partner={partner} open={portalOpen} onClose={() => setPortalOpen(false)} />
      <ConfirmDialog
        open={revoking}
        onClose={() => setRevoking(false)}
        title="Remove their portal sign-in?"
        confirmLabel="Remove sign-in"
        danger
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoke.mutate()}
      >
        Your partnership leaves their portal. If no other company gave them a sign-in, they are signed out everywhere and can’t open the portal until
        you invite them again. Links keep working.
      </ConfirmDialog>
    </>
  );
}

function RevealDetails({ partnerId }: { partnerId: string }) {
  const [details, setDetails] = useState<PayoutDetailsRead | null>(null);
  const reveal = useMutation({ mutationFn: () => api.get<PayoutDetailsRead>(`/partners/${partnerId}/payout-details`), onSuccess: setDetails });
  if (details?.details) {
    const d = details.details;
    return (
      <div className="partners-note">
        <KeyValue
          items={
            d.method === 'bank_transfer'
              ? [
                  { label: 'Account', value: <Mono>{d.accountNumber}</Mono> },
                  { label: 'IFSC', value: <Mono>{d.ifsc}</Mono> },
                  ...(d.pan ? [{ label: 'PAN', value: <Mono>{d.pan}</Mono> }] : []),
                ]
              : [{ label: 'UPI', value: <Mono>{d.upiId}</Mono> }, ...(d.pan ? [{ label: 'PAN', value: <Mono>{d.pan}</Mono> }] : [])]
          }
        />
        <Button size="sm" variant="ghost" onClick={() => setDetails(null)}>
          Hide
        </Button>
      </div>
    );
  }
  return (
    <div>
      <Button size="sm" variant="ghost" icon="eye" loading={reveal.isPending} onClick={() => reveal.mutate()}>
        Show full details
      </Button>
      <p className="small muted">Showing them is recorded in the audit log.</p>
      <ErrorAlert error={reveal.error} />
    </div>
  );
}

function LinksSection({ partner, unitId }: { partner: PartnerDetail; unitId: string }) {
  const links = useReferralLinks(unitId, { partnerId: partner.id });
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (link: ReferralLink) => api.patch<ReferralLink>(`/partner-links/${link.id}`, { active: !link.active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: partnerKeys.all }),
  });
  const columns: Column<ReferralLink>[] = [
    {
      id: 'code',
      header: 'Code',
      card: 'title',
      width: 170,
      cell: (l) => (
        <span className="partners-name">
          <Code>{l.code}</Code>
          <span className="partners-sub">{l.label ?? l.company?.name}</span>
        </span>
      ),
    },
    { id: 'share', header: 'Share link', cell: (l) => <ShareLink url={l.shareUrl} /> },
    { id: 'leads', header: 'Leads', width: 70, align: 'end', cell: (l) => l.leadCount },
    {
      id: 'active',
      header: 'Status',
      width: 150,
      cell: (l) => (
        <span className="row gap-8 nowrap">
          {l.active ? <StatusPill tone="success">On</StatusPill> : <StatusPill tone="neutral">Off</StatusPill>}
          {partner.can.manage ? (
            <Button size="sm" variant="ghost" loading={toggle.isPending && toggle.variables?.id === l.id} onClick={() => toggle.mutate(l)} aria-label={`${l.active ? 'Turn off' : 'Turn on'} ${l.code}`}>
              {l.active ? 'Turn off' : 'Turn on'}
            </Button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <Section title="Referral links" flush>
      <ErrorAlert error={toggle.error} />
      <DataTable {...infiniteRows(links)} columns={columns} rowId={(l) => l.id} label="Referral links" framed={false} empty="No referral links yet." />
    </Section>
  );
}

function LeadsSection({ partnerId, unitId }: { partnerId: string; unitId: string }) {
  const leads = useAttributions(unitId, { partnerId, onePerLead: true });
  const columns: Column<Attribution>[] = [
    {
      id: 'deal',
      header: 'Lead',
      card: 'title',
      cell: (a) => (
        <span className="partners-name">
          {a.deal.visible ? <Link href={`/leads/${a.deal.id}`}>{a.deal.title ?? a.deal.ref}</Link> : <span>{a.deal.ref}</span>}
          <span className="partners-sub">
            <Mono>{a.deal.ref}</Mono> · {a.company?.name}
          </span>
        </span>
      ),
    },
    { id: 'touch', header: 'Touch', width: 120, cell: (a) => (a.bothTouches ? 'First and last' : a.touch === 'first' ? 'First' : 'Last') },
    { id: 'source', header: 'How', hideBelow: 'md', cell: (a) => `${SOURCE_LABEL[a.source]}${a.code ? ` · ${a.code}` : ''}` },
    { id: 'at', header: 'When', width: 150, cell: (a) => <DateTime value={a.touchedAt} format="date" /> },
  ];
  return (
    <Section title="Referred leads" flush>
      <DataTable {...infiniteRows(leads)} columns={columns} rowId={(a) => a.id} label="Referred leads" framed={false} empty="No leads from this partner yet." />
    </Section>
  );
}

function CommissionsSection({ partnerId, unitId }: { partnerId: string; unitId: string }) {
  const commissions = useCommissions(unitId, { partnerId });
  const columns: Column<Commission>[] = [
    {
      id: 'deal',
      header: 'For',
      card: 'title',
      cell: (c) => (
        <span className="partners-name">
          <Link href={`/partners/commissions?commission=${c.id}`}>{c.deal.ref}</Link>
          <span className="partners-sub">{c.plan.name}</span>
        </span>
      ),
    },
    { id: 'status', header: 'Status', width: 170, cell: (c) => <CommissionPill status={c.status} /> },
    { id: 'amount', header: 'Payable', width: 120, align: 'end', cell: (c) => <Amount value={c.payable} /> },
    { id: 'earned', header: 'Earned', width: 130, hideBelow: 'md', cell: (c) => <DateTime value={c.earnedAt} format="date" /> },
  ];
  return (
    <Section title="Commissions" flush>
      <DataTable {...infiniteRows(commissions)} columns={columns} rowId={(c) => c.id} label="Commissions" framed={false} empty="No commissions yet: they accrue when a referred family pays." />
    </Section>
  );
}
