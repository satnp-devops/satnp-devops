'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { DynamicField } from '@/components/DynamicField';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf, isApiError } from '@/lib/api';
import { formatList, toMinorUnits } from '@/lib/crm/format';
import type { CustomFieldDefinition, CustomValue, DealDetail, DealFieldsPatch, Stage, StageRulesErrorDetails } from '@/lib/crm/types';
import { useDealAction, useDealCustomFields, useLostReasons, useProductLines, useProducts } from '@/lib/deals/hooks';
import type { FieldDef, FieldInput } from '@/lib/types';

/** Required fields the move dialog can fill in place; the rest are filled on the lead's profile. */
const INLINE_FIELDS = new Set(['productLineId', 'productId', 'valueMinor', 'expectedCloseOn']);

const CUSTOM_INPUT: Partial<Record<CustomFieldDefinition['type'], FieldInput>> = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  select: 'select',
  multiselect: 'multiselect',
  boolean: 'boolean',
  phone: 'tel',
  email: 'email',
  url: 'url',
};

export function isStageRulesError(error: unknown): error is { details: StageRulesErrorDetails; message: string } {
  if (!isApiError(error) || error.code !== 'stage_rules') return false;
  const details = error.details as Partial<StageRulesErrorDetails> | null;
  return typeof details === 'object' && details !== null && Array.isArray(details.missing);
}

/** What the dialog is asked to do: fill required fields for a move, or record a loss. */
export type MoveRequest =
  | {
      mode: 'fields';
      stage: Stage;
      details: StageRulesErrorDetails;
      message: string;
      /** Names of the stages in details.allowedFrom. */ allowedNames: string[];
    }
  | { mode: 'lose'; stage: Stage | null };

function CustomInput({
  definition,
  value,
  onChange,
  error,
}: {
  definition: CustomFieldDefinition;
  value: CustomValue | undefined;
  onChange: (value: CustomValue) => void;
  error?: string;
}) {
  const input = CUSTOM_INPUT[definition.type];
  if (!input) {
    return (
      <Field label={definition.label} hint={definition.help ?? undefined} error={error}>
        {(control) => (
          <input
            {...control}
            type="date"
            className="input"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value || null)}
          />
        )}
      </Field>
    );
  }
  const field: FieldDef = { key: definition.key, label: definition.label, input, help: definition.help ?? undefined, options: definition.options };
  return (
    <DynamicField
      field={field}
      value={value ?? (input === 'multiselect' ? [] : input === 'boolean' ? false : '')}
      error={error}
      onChange={(next) => {
        if (input === 'number') onChange(next === '' || next === null ? null : Number(next));
        else if (Array.isArray(next)) onChange(next.map(String));
        else if (typeof next === 'boolean' || typeof next === 'string') onChange(next);
        else onChange(next === null || next === undefined ? null : String(next));
      }}
    />
  );
}

/** Fill the fields a stage requires, then move. Shown when a move came back 422 "stage_rules". */
function FieldsForm({
  deal,
  request,
  onDone,
  onClose,
}: {
  deal: DealDetail;
  request: Extract<MoveRequest, { mode: 'fields' }>;
  onDone: (deal: DealDetail) => void;
  onClose: () => void;
}) {
  const action = useDealAction(deal.id);
  const customFields = useDealCustomFields(deal.companyId);
  const lines = useProductLines({ companyId: deal.companyId });
  const [productLineId, setProductLineId] = useState(deal.productLine?.id ?? '');
  const products = useProducts(deal.companyId, productLineId || null);
  const [productId, setProductId] = useState(deal.product?.id ?? '');
  const [value, setValue] = useState('');
  const [closeOn, setCloseOn] = useState(deal.expectedCloseOn ?? '');
  const [custom, setCustom] = useState<Record<string, CustomValue>>({});
  const missing = request.details.missing;
  const keys = new Set(missing.map((field) => field.key));
  const definitions = new Map((customFields.data ?? []).map((definition) => [definition.key, definition]));
  const inline = missing.filter((field) => INLINE_FIELDS.has(field.key) || (field.key.startsWith('custom.') && definitions.has(field.key.slice(7))));
  const elsewhere = missing.filter((field) => !inline.includes(field));
  const errors = fieldErrorsOf(action.error);
  // A move sends the fields inside the move (body.fields.*); a reopen saves them first with PATCH (body.*).
  const fieldError = (key: string) => errors[`fields.${key}`] ?? errors[key];
  const needsProduct = keys.has('productId');

  function submit(event: FormEvent) {
    event.preventDefault();
    const fields: DealFieldsPatch = {};
    if (keys.has('productLineId') || (needsProduct && productLineId && productLineId !== deal.productLine?.id))
      fields.productLineId = productLineId || null;
    if (needsProduct) fields.productId = productId || null;
    if (keys.has('valueMinor')) {
      const major = Number(value);
      if (value.trim() !== '' && Number.isFinite(major)) fields.valueMinor = toMinorUnits(major, deal.value.currency);
    }
    if (keys.has('expectedCloseOn')) fields.expectedCloseOn = closeOn || null;
    const customValues = Object.fromEntries(Object.entries(custom).filter(([key]) => keys.has(`custom.${key}`)));
    if (Object.keys(customValues).length > 0) fields.custom = customValues;
    const run = async () => {
      if (deal.status === 'open')
        return action.mutateAsync({ type: 'move', body: { stageId: request.stage.id, fromStageId: deal.stage.id, fields } });
      if (Object.keys(fields).length > 0) await action.mutateAsync({ type: 'update', body: fields });
      return action.mutateAsync({ type: 'reopen', body: { stageId: request.stage.id } });
    };
    run().then(onDone, () => undefined);
  }

  const audienceLines = (lines.data ?? []).filter((line) => line.active && line.audience === deal.kind);
  const allowedFrom = request.allowedNames;
  const shownErrors = Object.keys(errors);

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        {allowedFrom && allowedFrom.length > 0 ? (
          <Alert tone="warning" title="Not from this stage">
            {request.stage.name} can only be entered from {formatList(allowedFrom)}. Move the lead there first.
          </Alert>
        ) : null}
        {missing.length > 0 ? <p className="muted">{request.stage.name} needs these details first.</p> : null}
        {keys.has('productLineId') || needsProduct ? (
          <Field label="Product line" error={fieldError('productLineId')}>
            {(control) => (
              <select
                {...control}
                className="select"
                value={productLineId}
                onChange={(event) => {
                  setProductLineId(event.target.value);
                  setProductId('');
                }}
              >
                <option value="">Choose a product line</option>
                {audienceLines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {needsProduct ? (
          <Field label="Product" error={fieldError('productId')} hint={productLineId ? undefined : 'Pick a product line first'}>
            {(control) => (
              <select
                {...control}
                className="select"
                value={productId}
                disabled={!productLineId}
                onChange={(event) => setProductId(event.target.value)}
              >
                <option value="">Choose a product</option>
                {(products.data ?? [])
                  .filter((product) => product.active)
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        ) : null}
        {keys.has('valueMinor') ? (
          <Field label={`Value (${deal.value.currency})`} error={fieldError('valueMinor')}>
            {(control) => (
              <input
                {...control}
                className="input"
                inputMode="decimal"
                type="number"
                min="0"
                step="any"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
        ) : null}
        {keys.has('expectedCloseOn') ? (
          <Field label="Expected close date" error={fieldError('expectedCloseOn')}>
            {(control) => <input {...control} type="date" className="input" value={closeOn} onChange={(event) => setCloseOn(event.target.value)} />}
          </Field>
        ) : null}
        {missing
          .filter((field) => field.key.startsWith('custom.'))
          .map((field) => {
            const key = field.key.slice(7);
            const definition = definitions.get(key);
            if (!definition) return null;
            return (
              <CustomInput
                key={field.key}
                definition={definition}
                value={custom[key] ?? deal.custom[key]}
                error={fieldError(`custom.${key}`)}
                onChange={(next) => setCustom((current) => ({ ...current, [key]: next }))}
              />
            );
          })}
        {elsewhere.length > 0 ? (
          <Alert tone="info" title="Fill these on the profile">
            {formatList(elsewhere.map((field) => field.label))} can&apos;t be filled here.{' '}
            <Link href={`/leads/${deal.id}`}>Open the full profile</Link>.
          </Alert>
        ) : null}
        <ErrorAlert
          error={
            isStageRulesError(action.error)
              ? null
              : formErrorOf(
                  action.error,
                  shownErrors.map((key) => key),
                )
          }
        />
        {isStageRulesError(action.error) ? <Alert tone="error">{action.error.message}</Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={action.isPending} disabled={inline.length === 0 && missing.length > 0}>
          Move to {request.stage.name}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Mark a lead lost: a reason (from the company's list), a note when the reason asks for one, and the nurture flag. */
function LoseForm({
  deal,
  stage,
  onDone,
  onClose,
}: {
  deal: DealDetail;
  stage: Stage | null;
  onDone: (deal: DealDetail) => void;
  onClose: () => void;
}) {
  const action = useDealAction(deal.id);
  const reasons = useLostReasons(deal.companyId, deal.kind);
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [nurture, setNurture] = useState(true);
  const reason = reasons.data?.find((item) => item.id === reasonId);
  const errors = fieldErrorsOf(action.error);
  const [missingReason, setMissingReason] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!reasonId) {
      setMissingReason(true);
      return;
    }
    action.mutate(
      { type: 'lose', body: { stageId: stage?.id, lostReasonId: reasonId, lostNote: note.trim() || undefined, nurture } },
      { onSuccess: onDone },
    );
  }

  const active = (reasons.data ?? []).filter((item) => item.active);
  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <Field label="Reason" error={missingReason && !reasonId ? 'Pick a reason' : errors.lostReasonId}>
          {(control) => (
            <select
              {...control}
              className="select"
              value={reasonId}
              onChange={(event) => setReasonId(event.target.value)}
              disabled={reasons.isPending}
            >
              <option value="">{reasons.isPending ? 'Loading reasons…' : 'Choose a reason'}</option>
              {active.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {reasons.isError ? <ErrorAlert error={reasons.error} title="Couldn't load the lost reasons" /> : null}
        <Field
          label="Note"
          optional={!reason?.requiresNote}
          error={errors.lostNote}
          hint={reason?.requiresNote ? 'This reason needs a short note' : undefined}
        >
          {(control) => (
            <textarea {...control} className="textarea" rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
          )}
        </Field>
        <label className="check">
          <input type="checkbox" checked={nurture} onChange={(event) => setNurture(event.target.checked)} />
          <span>Keep in touch: add to the nurture flow</span>
        </label>
        <ErrorAlert error={formErrorOf(action.error, ['lostReasonId', 'lostNote'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="danger" loading={action.isPending}>
          Mark lost
        </Button>
      </DialogFooter>
    </form>
  );
}

export function StageMoveDialog({
  deal,
  request,
  onClose,
  onDone,
}: {
  deal: DealDetail;
  request: MoveRequest | null;
  onClose: () => void;
  onDone: (deal: DealDetail) => void;
}) {
  const title = request?.mode === 'lose' ? 'Mark as lost' : request ? `Move to ${request.stage.name}` : '';
  return (
    <Dialog open={request !== null} onClose={onClose} title={title} description={request?.mode === 'fields' ? request.message : undefined}>
      {request?.mode === 'fields' ? <FieldsForm deal={deal} request={request} onDone={onDone} onClose={onClose} /> : null}
      {request?.mode === 'lose' ? <LoseForm deal={deal} stage={request.stage} onDone={onDone} onClose={onClose} /> : null}
    </Dialog>
  );
}
