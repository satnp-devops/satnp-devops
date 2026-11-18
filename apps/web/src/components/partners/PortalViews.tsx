'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, DateTime, Mono, Section, StatusPill, infiniteRows, type Column } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field, Spinner } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { moneyList } from '@/lib/partners/format';
import { partnerKeys, usePortalCommissions, usePortalLeads, usePortalLinks, usePortalMe, usePortalPayouts } from '@/lib/partners/queries';
import type { PortalCommission, PortalLead, PortalMe, PortalPayout, ReferralLink } from '@/lib/partners/types';
import { Amount, Code, CommissionPill, LeadPill, PartnershipPill, PayoutPill, ShareLink, Stat } from './Parts';

// The partner portal: what a broker or referral partner sees of their own work. Every list comes
// from /partner-portal/*, which only ever returns the signed-in partner's rows.

export function PortalOverview() {
  const me = usePortalMe();
  if (me.isPending) return <Spinner />;
  if (me.isError) return <ErrorAlert error={me.error} />;
  const m = me.data;
  return (
    <div className="stack gap-16">
      <div className="partners-portal-hero">
        <div>
          <h2>{m.name}</h2>
          <p>
            Partner of {m.companies.map((c) => c.company?.name).join(', ')}
            {m.code ? ' · your code ' : ''}
            {m.code ? <Code>{m.code}</Code> : null}
          </p>
        </div>
        <p>{m.payout?.summary ? `Payouts to ${m.payout.summary}` : 'Send your bank or UPI details to your contact to get paid.'}</p>
      </div>
      <div className="partners-stats">
        <Stat label="Leads referred" value={m.stats.referredLeads} meta={`${m.stats.enrolled} enrolled`} />
        <Stat label="Active links" value={m.stats.activeLinks} />
        <Stat label="Earned, awaiting approval" value={moneyList(m.stats.commissions.pending)} />
        <Stat label="Approved, to be paid" value={moneyList(m.stats.commissions.approved)} />
        <Stat label="Paid to you" value={moneyList(m.stats.commissions.paid)} />
      </div>
      <Section title="Your partnerships" flush>
        <ul className="partners-list">
          {m.companies.map((c) => (
            <li key={c.company?.id}>
              <div className="partners-list__text">
                <p className="partners-list__title">
                  {c.company?.name} <PartnershipPill status={c.status} />
                </p>
                <p className="partners-sub">
                  {c.contactName ? `Your contact: ${c.contactName} · ` : ''}Since <DateTime value={c.joinedAt} format="date" sans />
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function PortalLinks() {
  const me = usePortalMe();
  const links = usePortalLinks({});
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const toggle = useMutation({
    mutationFn: (link: ReferralLink) => api.patch<ReferralLink>(`/partner-portal/links/${link.id}`, { active: !link.active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: partnerKeys.portal }),
  });
  const canCreate = (me.data?.companies ?? []).some((c) => c.canCreateLinks);
  const columns: Column<ReferralLink>[] = [
    {
      id: 'code',
      header: 'Code',
      card: 'title',
      width: 190,
      cell: (l) => (
        <span className="partners-name">
          <Code>{l.code}</Code>
          <span className="partners-sub">
            {l.label ?? 'No label'} · {l.company?.name}
          </span>
        </span>
      ),
    },
    { id: 'share', header: 'Link to share', cell: (l) => <ShareLink url={l.shareUrl} /> },
    { id: 'leads', header: 'Leads', width: 70, align: 'end', cell: (l) => l.leadCount },
    {
      id: 'status',
      header: 'Status',
      width: 170,
      cell: (l) => (
        <span className="row gap-8 nowrap">
          {l.active ? <StatusPill tone="success">On</StatusPill> : <StatusPill tone="neutral">Off</StatusPill>}
          <button type="button" className="link-button" disabled={toggle.isPending} onClick={() => toggle.mutate(l)} aria-label={`${l.active ? 'Turn off' : 'Turn on'} ${l.code}`}>
            {l.active ? 'Turn off' : 'Turn on'}
          </button>
        </span>
      ),
    },
  ];
  return (
    <>
      <ErrorAlert error={toggle.error} />
      <DataTable
        {...infiniteRows(links)}
        columns={columns}
        rowId={(l) => l.id}
        label="Your referral links"
        toolbar={
          <div className="partners-toolbar">
            <p className="small muted">Share a link or tell families your code. Enquiries that come with it are credited to you.</p>
            {canCreate ? (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                New link
              </Button>
            ) : null}
          </div>
        }
        empty="No links yet."
      />
      {me.data ? <PortalLinkDialog me={me.data} open={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function PortalLinkDialog({ me, open, onClose }: { me: PortalMe; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New referral link" description="We make a code and a link to the company’s enquiry page. Label it so you know where you shared it.">
      {open ? <PortalLinkForm me={me} onClose={onClose} /> : null}
    </Dialog>
  );
}

function PortalLinkForm({ me, onClose }: { me: PortalMe; onClose: () => void }) {
  const queryClient = useQueryClient();
  const companies = me.companies.filter((c) => c.canCreateLinks && c.company);
  const [companyId, setCompanyId] = useState(companies[0]?.company?.id ?? '');
  const [label, setLabel] = useState('');
  const [campaign, setCampaign] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.post<ReferralLink>('/partner-portal/links', {
        companyId,
        label: label.trim() || undefined,
        utm: { source: 'partner', medium: 'referral', ...(campaign.trim() ? { campaign: campaign.trim() } : {}) },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: partnerKeys.portal });
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, ['companyId', 'label', 'utm.campaign'])} />
        <Field label="For" error={errors.companyId}>
          {(control) => (
            <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((c) => (
                <option key={c.company?.id} value={c.company?.id}>
                  {c.company?.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Label" optional hint="Like “School seminar, Pune”" error={errors.label}>
          {(control) => <input {...control} className="input" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <Field label="Campaign tag" optional error={errors['utm.campaign']}>
          {(control) => <input {...control} className="input" maxLength={200} value={campaign} onChange={(e) => setCampaign(e.target.value)} />}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={!companyId}>
          Create link
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PortalLeads() {
  const leads = usePortalLeads({});
  const columns: Column<PortalLead>[] = [
    {
      id: 'name',
      header: 'Family',
      card: 'title',
      cell: (l) => (
        <span className="partners-name">
          <span>{l.name}</span>
          {l.phone ? <Mono>{l.phone}</Mono> : null}
        </span>
      ),
    },
    { id: 'ref', header: 'Reference', width: 110, cell: (l) => <Mono>{l.ref}</Mono> },
    { id: 'for', header: 'Interested in', hideBelow: 'md', cell: (l) => `${l.productLine?.name ?? 'Enquiry'} · ${l.company?.name ?? ''}` },
    { id: 'status', header: 'Status', width: 130, cell: (l) => <LeadPill status={l.status} /> },
    { id: 'at', header: 'Referred', width: 130, cell: (l) => <DateTime value={l.referredAt} format="date" /> },
  ];
  return (
    <>
      <p className="small muted">Names and numbers are shortened to protect families’ privacy. Your contact at the company can tell you more.</p>
      <DataTable {...infiniteRows(leads)} columns={columns} rowId={(l) => l.id} label="Leads you referred" empty="No referred leads yet. Share a link to get started." />
    </>
  );
}

export function PortalCommissions() {
  const commissions = usePortalCommissions({});
  const columns: Column<PortalCommission>[] = [
    {
      id: 'ref',
      header: 'Lead',
      card: 'title',
      cell: (c) => (
        <span className="partners-name">
          <Mono>{c.ref}</Mono>
          <span className="partners-sub">{c.company?.name}</span>
        </span>
      ),
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'end',
      width: 130,
      cell: (c) => (
        <span className="partners-name">
          <Amount value={c.payable} />
          {c.clawedBack.valueMinor > 0 ? <span className="partners-sub">after a refund</span> : null}
        </span>
      ),
    },
    { id: 'status', header: 'Status', width: 170, cell: (c) => <CommissionPill status={c.status} /> },
    { id: 'earned', header: 'Earned', width: 130, cell: (c) => <DateTime value={c.earnedAt} format="date" /> },
    { id: 'window', header: 'Final after', width: 130, hideBelow: 'md', cell: (c) => <DateTime value={c.clawbackUntil} format="date" /> },
  ];
  return (
    <>
      <p className="small muted">A commission is final once its refund window ends. Approved commissions are paid in the next payout.</p>
      <DataTable {...infiniteRows(commissions)} columns={columns} rowId={(c) => c.id} label="Your commissions" empty="No commissions yet: they’re earned when a family you referred pays." />
    </>
  );
}

export function PortalPayouts() {
  const payouts = usePortalPayouts({});
  const columns: Column<PortalPayout>[] = [
    {
      id: 'ref',
      header: 'Payout',
      card: 'title',
      cell: (p) => (
        <span className="partners-name">
          <Mono>{p.payoutRef}</Mono>
          <span className="partners-sub">{p.company?.name}</span>
        </span>
      ),
    },
    {
      id: 'period',
      header: 'Period',
      hideBelow: 'md',
      cell: (p) => (
        <span>
          <DateTime value={p.periodStart} format="date" sans /> – <DateTime value={p.periodEnd} format="date" sans />
        </span>
      ),
    },
    { id: 'net', header: 'Amount', align: 'end', width: 130, cell: (p) => <Amount value={p.net} /> },
    { id: 'status', header: 'Status', width: 170, cell: (p) => <PayoutPill status={p.status} /> },
    { id: 'ref2', header: 'Transfer ref', hideBelow: 'md', cell: (p) => (p.reference ? <Mono>{p.reference}</Mono> : '—') },
  ];
  return <DataTable {...infiniteRows(payouts)} columns={columns} rowId={(p) => p.id} label="Your payouts" empty="No payouts yet." />;
}
