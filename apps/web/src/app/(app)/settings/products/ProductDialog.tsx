'use client';

import { useState } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { BILLING_LABELS, MODE_LABELS } from '@/lib/config/format';
import { useConfigMutation } from '@/lib/config/queries';
import type { Product, ProductAttributes, ProductInput, ProductLine, ProductPatchInput } from '@/lib/crm/types';

type Mode = NonNullable<ProductAttributes['mode']>;
type Billing = NonNullable<ProductAttributes['billing']>;
const MODES = Object.keys(MODE_LABELS) as Mode[];
const BILLINGS = Object.keys(BILLING_LABELS) as Billing[];
const isMode = (value: string): value is Mode => MODES.some((mode) => mode === value);
const isBilling = (value: string): value is Billing => BILLINGS.some((billing) => billing === value);

/** Whole numbers typed into a form: empty means "not set". */
const toCount = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

/** Add a product to a line, or edit one (it can move to another line of the same audience). */
export function ProductDialog({
  open,
  line,
  product,
  lines,
  onClose,
}: {
  open: boolean;
  line: ProductLine | null;
  product: Product | null;
  lines: readonly ProductLine[];
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={product ? `Edit ${product.name}` : `Add a product to ${line?.name ?? 'this line'}`}>
      {open && line ? <ProductForm line={line} product={product} lines={lines} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ProductForm({ line, product, lines, onClose }: { line: ProductLine; product: Product | null; lines: readonly ProductLine[]; onClose: () => void }) {
  const attributes = product?.attributes ?? {};
  const [lineId, setLineId] = useState(product?.productLineId ?? line.id);
  const [name, setName] = useState(product?.name ?? '');
  const [code, setCode] = useState(product?.code ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [mode, setMode] = useState<Mode | ''>(attributes.mode ?? '');
  const [billing, setBilling] = useState<Billing | ''>(attributes.billing ?? '');
  const [sessions, setSessions] = useState(attributes.sessions ? String(attributes.sessions) : '');
  const [weeks, setWeeks] = useState(attributes.durationWeeks ? String(attributes.durationWeeks) : '');
  const [tests, setTests] = useState(attributes.tests ? String(attributes.tests) : '');
  const [exam, setExam] = useState(attributes.exam ?? '');
  const [grades, setGrades] = useState((attributes.grades ?? []).join(', '));
  const [addOn, setAddOn] = useState(attributes.addOn ?? false);

  const sameAudience = lines.filter((other) => other.audience === line.audience);

  const save = useConfigMutation(
    () => {
      const next: ProductAttributes = {
        mode: mode || undefined,
        billing: billing || undefined,
        sessions: toCount(sessions),
        durationWeeks: toCount(weeks),
        tests: toCount(tests),
        exam: exam.trim() || undefined,
        grades: grades.trim()
          ? grades
              .split(',')
              .map((grade) => grade.trim())
              .filter(Boolean)
          : undefined,
        addOn: addOn || undefined,
      };
      const cleaned = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as ProductAttributes;
      if (product) {
        const body: ProductPatchInput = { productLineId: lineId, name, code: code.trim() || null, description: description.trim() || null, attributes: cleaned };
        return api.patch<Product>(`/products/${product.id}`, body);
      }
      const body: ProductInput = { productLineId: line.id, name, code: code.trim() || null, description: description.trim() || undefined, attributes: cleaned };
      return api.post<Product>('/products', body);
    },
    { onSuccess: onClose },
  );

  const errors = fieldErrorsOf(save.error);
  const attributeError = (key: string) => errors[`attributes.${key}`];
  const shown = ['productLineId', 'name', 'code', 'description', ...['mode', 'billing', 'sessions', 'durationWeeks', 'tests', 'exam', 'grades'].map((k) => `attributes.${k}`)];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(undefined);
      }}
    >
      <DialogBody>
        <ErrorAlert error={formErrorOf(save.error, shown)} />
        <div className="form-grid">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <input {...control} className="input" value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field label="Code" optional hint="Short code or SKU, e.g. SAT-WKND-12" error={errors.code}>
            {(control) => (
              <input
                {...control}
                className="input mono"
                value={code}
                maxLength={30}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
            )}
          </Field>
          {product ? (
            <Field label="Product line" error={errors.productLineId}>
              {(control) => (
                <select {...control} className="select" value={lineId} onChange={(event) => setLineId(event.target.value)}>
                  {sameAudience.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.name}
                      {other.active ? '' : ' (inactive)'}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </div>
        <Field label="Description" optional error={errors.description}>
          {(control) => (
            <textarea {...control} className="textarea" rows={2} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} />
          )}
        </Field>

        <fieldset className="field field--group">
          <legend className="field__label">Details</legend>
          <div className="form-grid">
            <Field label="Mode" optional error={attributeError('mode')}>
              {(control) => (
                <select {...control} className="select" value={mode} onChange={(event) => setMode(isMode(event.target.value) ? event.target.value : '')}>
                  <option value="">Not set</option>
                  {MODES.map((value) => (
                    <option key={value} value={value}>
                      {MODE_LABELS[value]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Billing" optional error={attributeError('billing')}>
              {(control) => (
                <select
                  {...control}
                  className="select"
                  value={billing}
                  onChange={(event) => setBilling(isBilling(event.target.value) ? event.target.value : '')}
                >
                  <option value="">Not set</option>
                  {BILLINGS.map((value) => (
                    <option key={value} value={value}>
                      {BILLING_LABELS[value]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Exam" optional error={attributeError('exam')}>
              {(control) => <input {...control} className="input" value={exam} maxLength={60} onChange={(event) => setExam(event.target.value)} />}
            </Field>
            <Field label="Grades" optional hint="Separate with commas: 11, 12" error={attributeError('grades')}>
              {(control) => <input {...control} className="input" value={grades} onChange={(event) => setGrades(event.target.value)} />}
            </Field>
            <Field label="Sessions" optional error={attributeError('sessions')}>
              {(control) => (
                <input {...control} className="input" type="number" min={1} max={1000} value={sessions} onChange={(event) => setSessions(event.target.value)} />
              )}
            </Field>
            <Field label="Duration (weeks)" optional error={attributeError('durationWeeks')}>
              {(control) => (
                <input {...control} className="input" type="number" min={1} max={520} value={weeks} onChange={(event) => setWeeks(event.target.value)} />
              )}
            </Field>
            <Field label="Tests" optional error={attributeError('tests')}>
              {(control) => (
                <input {...control} className="input" type="number" min={1} max={1000} value={tests} onChange={(event) => setTests(event.target.value)} />
              )}
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={addOn} onChange={(event) => setAddOn(event.target.checked)} />
            <span>Sold as an add-on to another product</span>
          </label>
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {product ? 'Save' : 'Add product'}
        </Button>
      </DialogFooter>
    </form>
  );
}
