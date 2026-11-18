'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, CopyButton, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { partnerKeys, usePartnerOwners, usePlans } from '@/lib/partners/queries';
import type {
  PartnerDetail,
  Partnership,
  PartnershipPatch,
  PartnershipStatus,
  PayoutDetailsInput,
  PortalAccessResult,
  ReferralLink,
  ReferralLinkInput,
} from '@/lib/partners/types';

// Dialogs of the partner profile: a partnership, a referral link, payout details, portal access.

function useRefresh(partnerId: string) {
  const queryClient = useQueryClient();
  return (partner?: PartnerDetail) => {
    if (partner) queryClient.setQueryData(partnerKeys.detail(partnerId), partner);
    void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
  };
}

// ---------- Partnership ----------

export function PartnershipDialog({ partnerId, partnership, onClose }: { partnerId: string; partnership: Partnership | null; onClose: () => void }) {
  return (
    <Dialog open={partnership !== null} onClose={onClose} title={`Partnership with ${partnership?.company?.name ?? ''}`} description="Who looks after their leads, which plan pays them, and whether the partnership is active.">
      {partnership ? <PartnershipForm partnerId={partnerId} partnership={partnership} onClose={onClose} /> : null}
    </Dialog>
  );
}

function PartnershipForm({ partnerId, partnership, onClose }: { partnerId: string; partnership: Partnership; onClose: () => void }) {
  const refresh = useRefresh(partnerId);
  const [status, setStatus] = useState<PartnershipStatus>(partnership.status);
  const [ownerUserId, setOwnerUserId] = useState(partnership.owner?.id ?? '');
  const [planId, setPlanId] = useState(partnership.commissionPlan?.id ?? '');
  const owners = usePartnerOwners(partnership.unit?.id ?? null);
  const plans = usePlans({ companyId: partnership.company?.id }, Boolean(partnership.company));
  const save = useMutation({
    mutationFn: () => {
      const body: PartnershipPatch = {};
      if (status !== partnership.status) body.status = status;
      if (ownerUserId !== (partnership.owner?.id ?? '')) body.ownerUserId = ownerUserId || null;
      if (planId !== (partnership.commissionPlan?.id ?? '')) body.commissionPlanId = planId || null;
      if (Object.keys(body).length === 0) return Promise.resolve(null);
      return api.patch<PartnerDetail>(`/partners/${partnerId}/companies/${partnership.company?.id}`, body);
    },
    onSuccess: (partner) => {
      refresh(partner ?? undefined);
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
        <ErrorAlert error={formErrorOf(save.error, ['status', 'ownerUserId', 'commissionPlanId'])} />
        <Field label="Status" hint="Only active partnerships earn commissions and keep links working" error={errors.status}>
          {(control) => (
            <select {...control} className="select" value={status} onChange={(e) => setStatus(e.target.value as PartnershipStatus)}>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="suspended">Suspended</option>
              <option value="terminated">Ended</option>
            </select>
          )}
        </Field>
        <Field label="Their counsellor" error={errors.ownerUserId}>
          {(control) => (
            <select {...control} className="select" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
              <option value="">Assign as usual</option>
              {partnership.owner && !(owners.data ?? []).some((o) => o.id === partnership.owner?.id) ? (
                <option value={partnership.owner.id}>{partnership.owner.name}</option>
              ) : null}
              {(owners.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Commission plan" error={errors.commissionPlanId}>
          {(control) => (
            <select {...control} className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Match by product line</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id} disabled={!p.active && p.id !== planId}>
                  {p.name}
                  {p.active ? '' : ' (off)'}
                </option>
              ))}
            </select>
          )}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------- Referral link ----------

export function LinkDialog({ partner, open, onClose }: { partner: PartnerDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New referral link" description="A code and a link the partner shares. Enquiries that arrive with it are credited to them.">
      {open ? <LinkForm partner={partner} onClose={onClose} /> : null}
    </Dialog>
  );
}

function LinkForm({ partner, onClose }: { partner: PartnerDetail; onClose: () => void }) {
  const refresh = useRefresh(partner.id);
  const companies = partner.companies.filter((c) => c.status === 'active' && c.company);
  const [companyId, setCompanyId] = useState(companies[0]?.company?.id ?? '');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [landingUrl, setLandingUrl] = useState('');
  const [campaign, setCampaign] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const body: ReferralLinkInput = {
        partnerId: partner.id,
        companyId,
        label: label.trim() || undefined,
        code: code.trim() || undefined,
        landingUrl: landingUrl.trim() || undefined,
        utm: { source: 'partner', medium: 'referral', ...(campaign.trim() ? { campaign: campaign.trim() } : {}) },
      };
      return api.post<ReferralLink>('/partner-links', body);
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);
  if (companies.length === 0) {
    return (
      <DialogBody>
        <Alert tone="info" title="No active partnership">
          Links can only be made while a partnership is active.
        </Alert>
      </DialogBody>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, ['companyId', 'label', 'code', 'landingUrl', 'utm.campaign'])} />
        <Field label="Company" error={errors.companyId}>
          {(control) => (
            <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((c) => (
                <option key={c.id} value={c.company?.id}>
                  {c.company?.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Label" optional hint="For you and the partner, like “Pune seminar”" error={errors.label}>
          {(control) => <input {...control} className="input" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <Field label="Code" optional hint="Leave empty to generate one like SP-7KQ2MX" error={errors.code}>
          {(control) => <input {...control} className="input mono" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label="Landing page" optional hint="Leave empty for the company’s default enquiry page" error={errors.landingUrl}>
          {(control) => <input {...control} className="input" type="url" placeholder="https://" value={landingUrl} onChange={(e) => setLandingUrl(e.target.value)} />}
        </Field>
        <Field label="Campaign tag" optional hint="Sent as utm_campaign" error={errors['utm.campaign']}>
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

// ---------- Payout details ----------

export function PayoutDetailsDialog({ partner, open, onClose }: { partner: PartnerDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Payout details" description="Stored encrypted. Lists and the partner portal only show the last digits.">
      {open ? <PayoutDetailsForm partner={partner} onClose={onClose} /> : null}
    </Dialog>
  );
}

function PayoutDetailsForm({ partner, onClose }: { partner: PartnerDetail; onClose: () => void }) {
  const refresh = useRefresh(partner.id);
  const [method, setMethod] = useState<'bank_transfer' | 'upi'>(partner.payout?.method ?? 'bank_transfer');
  const [accountName, setAccountName] = useState(partner.payout?.accountName ?? partner.legalName ?? partner.name);
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState(partner.payout?.ifsc ?? '');
  const [bankName, setBankName] = useState(partner.payout?.bankName ?? '');
  const [upiId, setUpiId] = useState('');
  const [pan, setPan] = useState('');
  const save = useMutation({
    mutationFn: () => {
      const extra = pan.trim() ? { pan: pan.trim() } : {};
      const body: PayoutDetailsInput =
        method === 'bank_transfer'
          ? { method, accountName, accountNumber, ifsc, ...(bankName.trim() ? { bankName: bankName.trim() } : {}), ...extra }
          : { method, upiId, ...(accountName.trim() ? { accountName: accountName.trim() } : {}), ...extra };
      return api.put<PartnerDetail>(`/partners/${partner.id}/payout-details`, body);
    },
    onSuccess: (updated) => {
      refresh(updated);
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
      autoComplete="off"
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, ['method', 'accountName', 'accountNumber', 'ifsc', 'bankName', 'upiId', 'pan'])} />
        <fieldset className="field partners-fieldset">
          <legend className="field__label">Paid by</legend>
          <div className="partners-radio">
            <label>
              <input type="radio" name="method" checked={method === 'bank_transfer'} onChange={() => setMethod('bank_transfer')} />
              Bank transfer (NEFT/IMPS)
            </label>
            <label>
              <input type="radio" name="method" checked={method === 'upi'} onChange={() => setMethod('upi')} />
              UPI
            </label>
          </div>
        </fieldset>
        <Field label="Name on the account" optional={method === 'upi'} error={errors.accountName}>
          {(control) => <input {...control} className="input" maxLength={120} value={accountName} onChange={(e) => setAccountName(e.target.value)} />}
        </Field>
        {method === 'bank_transfer' ? (
          <>
            <Field label="Account number" hint={partner.payout?.accountLast4 ? `Now ending ${partner.payout.accountLast4}; enter it in full to change` : undefined} error={errors.accountNumber}>
              {(control) => <input {...control} className="input mono" inputMode="numeric" required value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />}
            </Field>
            <Field label="IFSC" error={errors.ifsc}>
              {(control) => <input {...control} className="input mono" required maxLength={11} value={ifsc} onChange={(e) => setIfsc(e.target.value)} />}
            </Field>
            <Field label="Bank" optional error={errors.bankName}>
              {(control) => <input {...control} className="input" maxLength={120} value={bankName} onChange={(e) => setBankName(e.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label="UPI id" hint="Like name@okhdfcbank" error={errors.upiId}>
            {(control) => <input {...control} className="input mono" required value={upiId} onChange={(e) => setUpiId(e.target.value)} />}
          </Field>
        )}
        <Field label="PAN" optional hint="For TDS on commissions" error={errors.pan}>
          {(control) => <input {...control} className="input mono" maxLength={10} value={pan} onChange={(e) => setPan(e.target.value)} />}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={save.isPending}>
          Save details
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------- Portal access ----------

export function PortalAccessDialog({ partner, open, onClose }: { partner: PartnerDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Partner portal sign-in" description="They see only their own links, referred leads (names and phones masked), commissions and payouts.">
      {open ? <PortalAccessForm partner={partner} onClose={onClose} /> : null}
    </Dialog>
  );
}

function PortalAccessForm({ partner, onClose }: { partner: PartnerDetail; onClose: () => void }) {
  const refresh = useRefresh(partner.id);
  // A sign-in another company already gave them is reused: same email, your partnership added.
  const [email, setEmail] = useState(partner.piiMasked ? '' : (partner.portalUser?.email ?? partner.email ?? ''));
  const grant = useMutation({
    mutationFn: () => api.post<PortalAccessResult>(`/partners/${partner.id}/portal-access`, { email }),
    onSuccess: (result) => refresh(result.partner),
  });
  const errors = fieldErrorsOf(grant.error);
  if (grant.isSuccess) {
    return (
      <>
        <DialogBody>
          <Alert tone="success" title={`Invitation sent to ${email}`}>
            The link works once and expires in 7 days.
          </Alert>
          {grant.data.inviteUrl ? (
            <div className="stack gap-8">
              <p className="small muted">Development only: open the invitation without waiting for email.</p>
              <div className="row gap-8 nowrap">
                <input className="input mono" readOnly value={grant.data.inviteUrl} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
                <CopyButton text={grant.data.inviteUrl} />
              </div>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        grant.mutate();
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(grant.error, ['email'])} />
        <Field label="Their email" hint="Use an address that isn’t a staff account" error={errors.email}>
          {(control) => <input {...control} className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={grant.isPending}>
          Send invitation
        </Button>
      </DialogFooter>
    </form>
  );
}
