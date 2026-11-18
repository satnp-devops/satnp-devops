'use client';

import { useState } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { KIND_SHORT, toKey } from '@/lib/config/format';
import { DEAL_VIEW_KEYS, useConfigMutation, useVocabularies } from '@/lib/config/queries';
import type { ProductKindKey, ProductLine, ProductLineInput, ProductLinePatchInput } from '@/lib/crm/types';

/** Create a product line, or edit one's name and description (key and kind are fixed). */
export function ProductLineDialog({ company, line, onClose }: { company: ConfigCompany; line: ProductLine | 'new' | null; onClose: () => void }) {
  return (
    <Dialog
      open={line !== null}
      onClose={onClose}
      title={line === 'new' ? `New product line for ${company.unit.name}` : 'Edit product line'}
      description="The kind decides who buys it: families (B2C) or institutes (B2B)."
    >
      {line ? <LineForm company={company} line={line === 'new' ? null : line} onClose={onClose} /> : null}
    </Dialog>
  );
}

function LineForm({ company, line, onClose }: { company: ConfigCompany; line: ProductLine | null; onClose: () => void }) {
  const vocabularies = useVocabularies();
  const kinds = vocabularies.data?.productKinds ?? [];
  const [name, setName] = useState(line?.name ?? '');
  const [key, setKey] = useState(line?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(Boolean(line));
  const [kind, setKind] = useState<ProductKindKey | ''>(line?.kind ?? '');
  const [description, setDescription] = useState(line?.description ?? '');
  const effectiveKey = keyTouched ? key : toKey(name);

  const save = useConfigMutation(
    () => {
      if (line) {
        const body: ProductLinePatchInput = { name, description: description.trim() || null };
        return api.patch<ProductLine>(`/product-lines/${line.id}`, body);
      }
      const chosen = kinds.find((option) => option.key === kind);
      if (!chosen) return Promise.reject(new Error('Pick a kind'));
      const body: ProductLineInput = { companyId: company.unit.id, key: effectiveKey, name, kind: chosen.key, description: description.trim() || undefined };
      return api.post<ProductLine>('/product-lines', body);
    },
    { alsoInvalidate: DEAL_VIEW_KEYS, onSuccess: onClose },
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
        <ErrorAlert error={formErrorOf(save.error, ['name', 'key', 'kind', 'description'])} />
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input {...control} className="input" value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field label="Key" error={errors.key} hint={line ? 'Keys never change.' : undefined}>
            {(control) => (
              <input
                {...control}
                className="input mono"
                value={effectiveKey}
                maxLength={40}
                required
                disabled={Boolean(line)}
                onChange={(event) => {
                  setKeyTouched(true);
                  setKey(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Field label="Kind" error={errors.kind}>
          {(control) => (
            <select
              {...control}
              className="select"
              value={kind}
              required
              disabled={Boolean(line)}
              onChange={(event) => {
                const next = kinds.find((option) => option.key === event.target.value);
                setKind(next ? next.key : '');
              }}
            >
              <option value="">Choose…</option>
              {kinds.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label} ({KIND_SHORT[option.audience]})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Description" optional error={errors.description}>
          {(control) => (
            <textarea
              {...control}
              className="textarea"
              rows={3}
              maxLength={500}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {line ? 'Save' : 'Add product line'}
        </Button>
      </DialogFooter>
    </form>
  );
}
