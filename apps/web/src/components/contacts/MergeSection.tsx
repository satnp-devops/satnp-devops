'use client';

import { useState } from 'react';
import { Section, StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Avatar, Button, ErrorAlert, FieldGroup, Spinner } from '@/components/ui';
import { DUPLICATE_REASON_LABELS, KIND_LABELS, nameOf } from '@/lib/contacts/labels';
import { useContactDuplicates, useMergeContacts } from '@/lib/contacts/queries';
import type { ContactDetail, ContactSummary, DuplicateCandidate } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import { ContactPicker } from './ContactPicker';
import { PiiText } from './PiiText';
import './contacts.css';

function CandidateText({ contact }: { contact: ContactSummary }) {
  return (
    <span className="contacts-candidate__text">
      <span className="strong">{nameOf(contact)}</span>
      <span className="contacts-sub">{[KIND_LABELS[contact.kind], contact.city].filter(Boolean).join(' · ')}</span>
      {contact.primaryPhone || contact.primaryEmail ? (
        <span className="contacts-sub">
          <PiiText value={contact.primaryPhone} kind="phone" masked={contact.piiMasked} />
          {contact.primaryPhone && contact.primaryEmail ? ' · ' : ''}
          <PiiText value={contact.primaryEmail} kind="email" masked={contact.piiMasked} />
        </span>
      ) : null}
    </span>
  );
}

function Reasons({ candidate }: { candidate: DuplicateCandidate }) {
  return (
    <span className="contacts-badges">
      {candidate.reasons.map((reason) => (
        <StatusPill key={reason} tone={reason === 'phone' || reason === 'email' ? 'warning' : 'neutral'}>
          {DUPLICATE_REASON_LABELS[reason]}
        </StatusPill>
      ))}
      <span className="contacts-sub">{Math.round(candidate.score * 100)}% alike</span>
    </span>
  );
}

/** Possible duplicates of the person, with Open and Merge. Hidden when there are none. */
export function DuplicatesSection({
  contact,
  onOpenContact,
  onMerge,
}: {
  contact: ContactDetail;
  onOpenContact: (id: string) => void;
  onMerge: (candidate: ContactSummary) => void;
}) {
  const duplicates = useContactDuplicates(contact.id, !contact.erased);
  if (contact.erased || duplicates.isPending) return null;
  if (duplicates.isError) {
    return (
      <Section title="Possible duplicates" level={3}>
        <ErrorAlert error={duplicates.error} />
      </Section>
    );
  }
  const { candidates, hiddenCount } = duplicates.data;
  if (candidates.length === 0 && hiddenCount === 0) return null;

  return (
    <Section title="Possible duplicates" level={3} count={candidates.length} flush description="People who share a number or email, or look alike.">
      <ul className="contacts-rows">
        {candidates.map((candidate) => (
          <li key={candidate.contact.id} className="contacts-row">
            <Avatar name={nameOf(candidate.contact)} size={28} />
            <div className="contacts-row__text">
              <button type="button" className="contacts-row__button" onClick={() => onOpenContact(candidate.contact.id)}>
                {nameOf(candidate.contact)}
              </button>
              <Reasons candidate={candidate} />
            </div>
            {contact.can.merge ? (
              <div className="contacts-row__actions">
                <Button size="sm" icon="merge" onClick={() => onMerge(candidate.contact)}>
                  Merge
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <p className="contacts-empty-line">
          {hiddenCount === 1 ? 'One more possible match is' : `${hiddenCount} more possible matches are`} known only to other teams or companies.
        </p>
      ) : null}
    </Section>
  );
}

// ---------- Merge ----------

/**
 * Merge two records of the same person. One is kept; everything of the other (numbers, households,
 * deals, timeline, tasks, consents, company links) moves to it and the other points at it.
 */
export function MergeDialog({
  contact,
  initial,
  open,
  onClose,
  onMerged,
}: {
  contact: ContactDetail;
  initial: ContactSummary | null;
  open: boolean;
  onClose: () => void;
  onMerged: (keptId: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Merge ${nameOf(contact)} with another record`}>
      {open ? <MergeForm contact={contact} initial={initial} onClose={onClose} onMerged={onMerged} /> : null}
    </Dialog>
  );
}

function MergeForm({
  contact,
  initial,
  onClose,
  onMerged,
}: {
  contact: ContactDetail;
  initial: ContactSummary | null;
  onClose: () => void;
  onMerged: (keptId: string) => void;
}) {
  const { scope } = useSession();
  const duplicates = useContactDuplicates(contact.id);
  const merge = useMergeContacts();
  const [other, setOther] = useState<ContactSummary | null>(initial);
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [searching, setSearching] = useState(false);
  const candidates = duplicates.data?.candidates ?? [];

  function submit() {
    if (!other) return;
    const targetId = keep === 'this' ? contact.id : other.id;
    const sourceId = keep === 'this' ? other.id : contact.id;
    merge.mutate({ targetId, sourceId }, { onSuccess: (kept) => onMerged(kept.id) });
  }

  return (
    <>
      <DialogBody>
        <FieldGroup label="The other record">
          {duplicates.isPending ? <Spinner label="Looking for duplicates" /> : null}
          {candidates.length > 0 ? (
            <ul className="contacts-candidates" aria-label="Possible duplicates">
              {candidates.map((candidate) => (
                <li key={candidate.contact.id}>
                  <button
                    type="button"
                    className="contacts-candidate"
                    aria-pressed={other?.id === candidate.contact.id}
                    onClick={() => setOther(candidate.contact)}
                  >
                    <Avatar name={nameOf(candidate.contact)} size={28} />
                    <CandidateText contact={candidate.contact} />
                    <Reasons candidate={candidate} />
                  </button>
                </li>
              ))}
            </ul>
          ) : duplicates.isSuccess ? (
            <p className="contacts-sub">No likely duplicates found. Search for the other record instead.</p>
          ) : null}
          {searching || candidates.length === 0 ? (
            <ContactPicker
              unitId={scope.id}
              selectedId={other?.id ?? null}
              onSelect={(picked) => setOther(picked)}
              exclude={[contact.id]}
              label="Find the other record"
            />
          ) : (
            <div>
              <button type="button" className="link-button" onClick={() => setSearching(true)}>
                Search for someone else
              </button>
            </div>
          )}
        </FieldGroup>

        {other ? (
          <FieldGroup label="Which record do you keep?">
            <div className="stack gap-8">
              <label className="check">
                <input type="radio" name="keep" checked={keep === 'this'} onChange={() => setKeep('this')} />
                <span>
                  Keep <strong>{nameOf(contact)}</strong> (this record) and fold {nameOf(other)} into it
                </span>
              </label>
              <label className="check">
                <input type="radio" name="keep" checked={keep === 'other'} onChange={() => setKeep('other')} />
                <span>
                  Keep <strong>{nameOf(other)}</strong> and fold this record into it
                </span>
              </label>
            </div>
          </FieldGroup>
        ) : null}

        <Alert tone="warning" title="Merging can't be undone">
          Phone numbers, emails, households, deals, timeline, tasks, consents and company links move to the kept record; its own details win and
          blanks are filled from the other. The other record then points to the kept one.
        </Alert>
        <ErrorAlert error={merge.error} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="merge" loading={merge.isPending} disabled={!other} onClick={submit}>
          Merge records
        </Button>
      </DialogFooter>
    </>
  );
}
