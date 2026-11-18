'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Section } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { nameOf } from '@/lib/contacts/labels';
import { downloadContactExport, useEraseContact } from '@/lib/contacts/queries';
import type { ContactDetail } from '@/lib/crm/types';
import './contacts.css';

/** Data requests under the DPDP Act: download everything held about the person, or erase their personal data. */
export function PrivacySection({ contact }: { contact: ContactDetail }) {
  const [erasing, setErasing] = useState(false);
  const download = useMutation({ mutationFn: () => downloadContactExport(contact.id) });
  if (!contact.can.privacy) return null;

  return (
    <Section
      title="Privacy requests"
      level={3}
      description="For the person's own requests under the DPDP Act. Both are recorded in the audit log."
    >
      <div className="stack gap-12">
        <div className="contacts-danger-zone">
          <Button icon="download" loading={download.isPending} onClick={() => download.mutate()}>
            Download their data (JSON)
          </Button>
          {!contact.erased ? (
            <Button variant="danger" icon="trash" onClick={() => setErasing(true)}>
              Erase personal data
            </Button>
          ) : null}
        </div>
        {download.isSuccess ? <p className="contacts-sub" role="status">Download started.</p> : null}
        <ErrorAlert error={download.error} />
      </div>
      <Dialog open={erasing} onClose={() => setErasing(false)} title={`Erase ${nameOf(contact)}'s personal data?`}>
        {erasing ? <EraseForm contact={contact} onClose={() => setErasing(false)} /> : null}
      </Dialog>
    </Section>
  );
}

function EraseForm({ contact, onClose }: { contact: ContactDetail; onClose: () => void }) {
  const erase = useEraseContact(contact.id);
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const errors = fieldErrorsOf(erase.error);

  return (
    <>
      <DialogBody>
        <Alert tone="warning" title="This can't be undone">
          Names, phone numbers, emails, date of birth, address and student details are removed everywhere, along with message texts on the
          timeline. Deals, payments, tasks, consent records and the audit log stay, without the personal details.
        </Alert>
        <Field label="Reason" hint="e.g. the request reference, or what the person asked for." error={errors.reason}>
          {(control) => (
            <textarea {...control} className="textarea" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          )}
        </Field>
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
          I confirm the person asked for their personal data to be erased.
        </label>
        <ErrorAlert error={formErrorOf(erase.error, ['reason'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          loading={erase.isPending}
          disabled={!sure || !reason.trim()}
          onClick={() => erase.mutate({ reason: reason.trim(), confirm: true }, { onSuccess: onClose })}
        >
          Erase personal data
        </Button>
      </DialogFooter>
    </>
  );
}
