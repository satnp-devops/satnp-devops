'use client';

import { useState } from 'react';
import { OrderButtons, Switch } from '@/components/config/controls';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Badge, Button, Card, EmptyState, ErrorAlert, Field, Spinner, cx } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { KIND_SHORT, moveItem } from '@/lib/config/format';
import { useConfigMutation, useLostReasons } from '@/lib/config/queries';
import type { DealKind, LostReason, LostReasonInput, LostReasonPatchInput } from '@/lib/crm/types';

type KindChoice = DealKind | 'both';
const toKind = (choice: KindChoice): DealKind | null => (choice === 'both' ? null : choice);

/** The reasons a counsellor or rep picks when a deal is lost, in the order they are offered. */
export function LostReasons({ company }: { company: ConfigCompany }) {
  const reasons = useLostReasons(company.unit.id);
  const [editing, setEditing] = useState<LostReason | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const update = useConfigMutation(({ id, body }: { id: string; body: LostReasonPatchInput }) => api.patch<LostReason>(`/lost-reasons/${id}`, body));
  // Reordering renumbers every reason whose position changes (usually two).
  const reorder = useConfigMutation((ordered: LostReason[]) =>
    Promise.all(
      ordered.flatMap((reason, index) => (reason.position === index ? [] : [api.patch<LostReason>(`/lost-reasons/${reason.id}`, { position: index })])),
    ),
  );

  const all = reasons.data ?? [];
  const list = showInactive ? all : all.filter((reason) => reason.active);
  const inactiveCount = all.length - all.filter((reason) => reason.active).length;

  return (
    <Card
      flush
      title="Lost reasons"
      description="Offered in this order when a deal is lost. Retired reasons stay on the deals that used them."
      actions={
        <>
          {inactiveCount ? <Switch label={`Show ${inactiveCount} inactive`} checked={showInactive} onChange={setShowInactive} /> : null}
          {company.canManage ? (
            <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Add reason
            </Button>
          ) : null}
        </>
      }
    >
      {reasons.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : reasons.isError ? (
        <div className="card__body">
          <ErrorAlert error={reasons.error} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon="flag" title="No lost reasons yet">
          {company.canManage ? 'Add the reasons your team sees most, like “Fee too high”.' : null}
        </EmptyState>
      ) : (
        <>
          {update.error || reorder.error ? (
            <div className="card__body">
              <ErrorAlert error={update.error ?? reorder.error} />
            </div>
          ) : null}
          <ul className="config-list" aria-label="Lost reasons">
            {list.map((reason, index) => (
              <li key={reason.id} className={cx('config-row', !reason.active && 'config-row--inactive')}>
                {company.canManage ? (
                  <OrderButtons
                    label={reason.label}
                    index={index}
                    count={list.length}
                    disabled={reorder.isPending}
                    onMove={(delta) => reorder.mutate(moveItem(list, index, delta))}
                  />
                ) : null}
                <div className="config-row__main">
                  <span className="config-row__title">
                    {reason.label}
                    <Badge>{reason.kind ? KIND_SHORT[reason.kind] : 'B2C and B2B'}</Badge>
                    {reason.requiresNote ? <Badge tone="warning">Note required</Badge> : null}
                  </span>
                </div>
                <div className="config-row__actions">
                  <Switch
                    label={reason.active ? 'Active' : 'Inactive'}
                    accessibleLabel={`Active: ${reason.label}`}
                    checked={reason.active}
                    disabled={!company.canManage || update.isPending}
                    onChange={(active) => update.mutate({ id: reason.id, body: { active } })}
                  />
                  {company.canManage ? (
                    <Button size="sm" variant="ghost" iconOnly icon="edit" aria-label={`Edit ${reason.label}`} onClick={() => setEditing(reason)} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <LostReasonDialog company={company} reason={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function LostReasonDialog({ company, reason, onClose }: { company: ConfigCompany; reason: LostReason | 'new' | null; onClose: () => void }) {
  return (
    <Dialog open={reason !== null} onClose={onClose} title={reason === 'new' ? 'Add a lost reason' : 'Edit lost reason'}>
      {reason ? <LostReasonForm company={company} reason={reason === 'new' ? null : reason} onClose={onClose} /> : null}
    </Dialog>
  );
}

function LostReasonForm({ company, reason, onClose }: { company: ConfigCompany; reason: LostReason | null; onClose: () => void }) {
  const [label, setLabel] = useState(reason?.label ?? '');
  const [kind, setKind] = useState<KindChoice>(reason?.kind ?? 'both');
  const [requiresNote, setRequiresNote] = useState(reason?.requiresNote ?? false);

  const save = useConfigMutation(
    () => {
      if (reason) {
        const body: LostReasonPatchInput = { label, kind: toKind(kind), requiresNote };
        return api.patch<LostReason>(`/lost-reasons/${reason.id}`, body);
      }
      const body: LostReasonInput = { companyId: company.unit.id, label, kind: toKind(kind), requiresNote };
      return api.post<LostReason>('/lost-reasons', body);
    },
    { onSuccess: onClose },
  );
  const errors = fieldErrorsOf(save.error);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(undefined);
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, ['label', 'kind'])} />
        <Field label="Reason" error={errors.label}>
          {(control) => (
            <input {...control} className="input" value={label} maxLength={80} required onChange={(event) => setLabel(event.target.value)} />
          )}
        </Field>
        <Field label="Offered for" error={errors.kind}>
          {(control) => (
            <select
              {...control}
              className="select"
              value={kind}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'b2c' || value === 'b2b' || value === 'both') setKind(value);
              }}
            >
              <option value="both">Every deal</option>
              <option value="b2c">B2C deals (families)</option>
              <option value="b2b">B2B deals (institutes)</option>
            </select>
          )}
        </Field>
        <label className="check">
          <input type="checkbox" checked={requiresNote} onChange={(event) => setRequiresNote(event.target.checked)} />
          <span>Ask for a note when this reason is picked</span>
        </label>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {reason ? 'Save' : 'Add reason'}
        </Button>
      </DialogFooter>
    </form>
  );
}
