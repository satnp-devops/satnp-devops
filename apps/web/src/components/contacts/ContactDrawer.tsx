'use client';

import { useEffect, useState } from 'react';
import { DateTime, SidePanel } from '@/components/crm';
import { Timeline } from '@/components/timeline';
import { Alert, Button, ErrorAlert, Spinner } from '@/components/ui';
import { isApiError } from '@/lib/api';
import { KIND_LABELS, nameOf } from '@/lib/contacts/labels';
import { useContact } from '@/lib/contacts/queries';
import type { ContactDetail, ContactSummary } from '@/lib/crm/types';
import { ConsentsSection } from './ConsentsSection';
import { DealsSection } from './DealsSection';
import { DetailsSection } from './DetailsSection';
import { HouseholdsSection } from './HouseholdsSection';
import { DuplicatesSection, MergeDialog } from './MergeSection';
import { MethodsSection } from './MethodsSection';
import { PrivacySection } from './PrivacySection';
import './contacts.css';

/**
 * The contact drawer: details, phones and emails, household and siblings, consent, deals,
 * duplicates and merge, and privacy requests. Reusable anywhere a person is shown:
 *
 *   <ContactDrawer contactId={id} onClose={() => setId(null)} />
 *
 * Opening another person from inside (a household member, a duplicate) calls `onOpenContact`
 * when given (e.g. to update the URL); otherwise the drawer switches on its own.
 */
export function ContactDrawer({
  contactId,
  onClose,
  onOpenContact,
}: {
  contactId: string | null;
  onClose: () => void;
  onOpenContact?: (id: string) => void;
}) {
  // When the parent doesn't track which person is shown, remember jumps made inside the drawer.
  const [jump, setJump] = useState<{ from: string; to: string } | null>(null);
  const id = contactId && jump && jump.from === contactId ? jump.to : contactId;
  const open = (next: string) => {
    if (onOpenContact) onOpenContact(next);
    else if (contactId) setJump({ from: contactId, to: next });
  };

  // Open only after the first commit: a panel that mounts open is closed again by the extra
  // effect pass of React's development Strict Mode, which would drop a ?contact= deep link.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const contact = useContact(id);
  const data = contact.data;

  return (
    <SidePanel
      open={mounted && contactId !== null}
      onClose={onClose}
      size="lg"
      title={data ? nameOf(data) : contact.isError ? 'Contact' : 'Loading contact'}
      subtitle={data ? <Subtitle contact={data} /> : undefined}
    >
      {contact.isPending ? (
        <div className="page-loading">
          <Spinner label="Loading contact" />
        </div>
      ) : contact.isError ? (
        <LoadError error={contact.error} onOpenContact={open} onRetry={() => void contact.refetch()} />
      ) : (
        <DrawerBody key={contact.data.id} contact={contact.data} onOpenContact={open} />
      )}
    </SidePanel>
  );
}

function Subtitle({ contact }: { contact: ContactDetail }) {
  const companies = contact.links.map((link) => link.company.name);
  const parts = [KIND_LABELS[contact.kind], contact.city, companies.length > 0 ? `Known to ${companies.join(', ')}` : null];
  return <span className="contacts-subtitle">{parts.filter(Boolean).join(' · ')}</span>;
}

function LoadError({ error, onOpenContact, onRetry }: { error: unknown; onOpenContact: (id: string) => void; onRetry: () => void }) {
  if (isApiError(error) && error.code === 'merged') {
    const details = error.details;
    const mergedIntoId =
      typeof details === 'object' && details !== null && 'mergedIntoId' in details && typeof details.mergedIntoId === 'string'
        ? details.mergedIntoId
        : null;
    return (
      <Alert
        tone="info"
        title="This record was merged into another one"
        action={
          mergedIntoId ? (
            <Button size="sm" onClick={() => onOpenContact(mergedIntoId)}>
              Open the kept record
            </Button>
          ) : null
        }
      >
        Its numbers, households, deals and history now live on the kept record.
      </Alert>
    );
  }
  if (isApiError(error) && error.status === 404) {
    return <Alert tone="warning" title="Contact not found">It doesn&apos;t exist, or it isn&apos;t shared with your teams.</Alert>;
  }
  return (
    <div className="stack gap-12">
      <ErrorAlert error={error} title="Couldn't load the contact" />
      <div>
        <Button size="sm" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function DrawerBody({ contact, onOpenContact }: { contact: ContactDetail; onOpenContact: (id: string) => void }) {
  const [merging, setMerging] = useState<{ initial: ContactSummary | null } | null>(null);
  return (
    <div className="contacts-drawer">
      {contact.erasedAt ? (
        <Alert tone="warning" title="Personal data erased">
          Erased on <DateTime value={contact.erasedAt} format="date" sans /> at the person&apos;s request. Deals, payments and consent records are
          kept without personal details.
        </Alert>
      ) : null}
      {contact.piiMasked && !contact.erased ? (
        <p className="contacts-sub">Phone numbers, emails, date of birth and address are hidden: your role doesn&apos;t include personal data.</p>
      ) : null}
      {contact.can.merge ? (
        <div className="row">
          <Button size="sm" icon="merge" onClick={() => setMerging({ initial: null })}>
            Merge with another record
          </Button>
        </div>
      ) : null}

      <DetailsSection contact={contact} />
      {!contact.erased ? <MethodsSection contact={contact} /> : null}
      {!contact.erased ? <HouseholdsSection contact={contact} onOpenContact={onOpenContact} /> : null}
      <DealsSection contact={contact} />
      <Timeline subject={{ contactId: contact.id }} companies={contact.links.map((link) => link.company)} level={3} />
      <ConsentsSection contact={contact} />
      <DuplicatesSection contact={contact} onOpenContact={onOpenContact} onMerge={(candidate) => setMerging({ initial: candidate })} />
      <PrivacySection contact={contact} />

      <MergeDialog
        contact={contact}
        initial={merging?.initial ?? null}
        open={merging !== null}
        onClose={() => setMerging(null)}
        onMerged={(keptId) => {
          setMerging(null);
          if (keptId !== contact.id) onOpenContact(keptId);
        }}
      />
    </div>
  );
}
