'use client';

import { useState } from 'react';
import { StageBubbles } from '@/components/crm';
import { ChipChecklist, OrderButtons, Segmented, errorFor } from '@/components/config/controls';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { CATEGORY_LABELS, KIND_LABELS, moveItem, toKey } from '@/lib/config/format';
import { DEAL_VIEW_KEYS, useConfigMutation } from '@/lib/config/queries';
import type { DealKind, Pipeline, PipelineCreateInput, PipelinePatchInput, ProductLine, StageCategory } from '@/lib/crm/types';
import { bubblesOf } from './PipelineEditor';

interface DraftStage {
  id: number;
  name: string;
  category: StageCategory;
}

const STARTER: Record<DealKind, Array<Omit<DraftStage, 'id'>>> = {
  b2c: [
    { name: 'New enquiry', category: 'open' },
    { name: 'Contacted', category: 'open' },
    { name: 'Demo booked', category: 'open' },
    { name: 'Enrolled', category: 'won' },
    { name: 'Lost', category: 'lost' },
  ],
  b2b: [
    { name: 'New', category: 'open' },
    { name: 'Qualified', category: 'open' },
    { name: 'Product demo', category: 'open' },
    { name: 'Contract signed', category: 'won' },
    { name: 'Lost', category: 'lost' },
  ],
};

const KINDS: ReadonlyArray<{ value: DealKind; label: string }> = [
  { value: 'b2c', label: KIND_LABELS.b2c },
  { value: 'b2b', label: KIND_LABELS.b2b },
];

let nextDraftId = 1;
const starterFor = (kind: DealKind): DraftStage[] => STARTER[kind].map((stage) => ({ ...stage, id: nextDraftId++ }));

/** Create a pipeline (with starter stages) or edit one's name and product lines. */
export function PipelineDialog({
  open,
  onClose,
  company,
  productLines,
  pipeline,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  company: ConfigCompany;
  productLines: readonly ProductLine[];
  /** Given: edit this pipeline. */
  pipeline?: Pipeline;
  onSaved?: (pipeline: Pipeline) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={pipeline ? `Edit ${pipeline.name}` : `New pipeline for ${company.unit.name}`}
      description={pipeline ? 'Key and kind stay as they are.' : 'Start from a few stages; you can add rules, SLAs and more stages afterwards.'}
    >
      {open ? <PipelineForm company={company} productLines={productLines} pipeline={pipeline} onClose={onClose} onSaved={onSaved} /> : null}
    </Dialog>
  );
}

function PipelineForm({
  company,
  productLines,
  pipeline,
  onClose,
  onSaved,
}: {
  company: ConfigCompany;
  productLines: readonly ProductLine[];
  pipeline?: Pipeline;
  onClose: () => void;
  onSaved?: (pipeline: Pipeline) => void;
}) {
  const [name, setName] = useState(pipeline?.name ?? '');
  const [key, setKey] = useState(pipeline?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(Boolean(pipeline));
  const [kind, setKind] = useState<DealKind>(pipeline?.kind ?? 'b2c');
  const [isDefault, setIsDefault] = useState(false);
  const [lineIds, setLineIds] = useState<string[]>(pipeline?.productLineIds ?? []);
  const [stages, setStages] = useState<DraftStage[]>(() => starterFor('b2c'));
  const effectiveKey = keyTouched ? key : toKey(name);

  const save = useConfigMutation(
    () => {
      if (pipeline) {
        const body: PipelinePatchInput = { name, productLineIds: lineIds };
        return api.patch<Pipeline>(`/pipelines/${pipeline.id}`, body);
      }
      const body: PipelineCreateInput = {
        companyId: company.unit.id,
        key: effectiveKey,
        name,
        kind,
        isDefault,
        productLineIds: lineIds,
        stages: stages.map((stage) => ({ key: toKey(stage.name), name: stage.name, category: stage.category })),
      };
      return api.post<Pipeline>('/pipelines', body);
    },
    {
      alsoInvalidate: DEAL_VIEW_KEYS,
      onSuccess: (saved) => {
        onSaved?.(saved);
        onClose();
      },
    },
  );

  const errors = fieldErrorsOf(save.error);
  const shown = Object.keys(errors).filter((path) => ['name', 'key', 'kind', 'productLineIds', 'stages'].some((p) => path === p || path.startsWith(`${p}.`)));
  const lineOptions = productLines
    .filter((line) => line.audience === kind && (line.active || lineIds.includes(line.id)))
    .map((line) => ({ value: line.id, label: line.active ? line.name : `${line.name} (inactive)` }));
  const stageError = (index: number) => errorFor(errors, `stages.${index}`);

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
              <input {...control} className="input" value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field label="Key" hint={pipeline ? undefined : 'Used by saved views and automations; it never changes.'} error={errors.key}>
            {(control) => (
              <input
                {...control}
                className="input mono"
                value={effectiveKey}
                maxLength={40}
                required
                disabled={Boolean(pipeline)}
                onChange={(event) => {
                  setKeyTouched(true);
                  setKey(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        {pipeline ? null : (
          <div className="field">
            <span className="field__label">Who it sells to</span>
            <Segmented
              label="Who it sells to"
              options={KINDS}
              value={kind}
              onChange={(next) => {
                setKind(next);
                setLineIds([]);
                setStages(starterFor(next));
              }}
            />
          </div>
        )}

        <ChipChecklist
          label="Product lines"
          hint="Leave all unticked to use this pipeline for every product line."
          error={errorFor(errors, 'productLineIds')}
          options={lineOptions}
          value={lineIds}
          onChange={setLineIds}
          empty={`${company.unit.name} has no ${kind.toUpperCase()} product lines yet.`}
        />

        {pipeline ? null : (
          <>
            <label className="check">
              <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
              <span>Make it the default {kind.toUpperCase()} pipeline (new leads start here)</span>
            </label>

            <fieldset className="field field--group">
              <legend className="field__label">Stages</legend>
              <ol className="config-draft">
                {stages.map((stage, index) => (
                  <li key={stage.id}>
                    <div className="config-draft__row">
                      <OrderButtons
                        label={stage.name || `stage ${index + 1}`}
                        index={index}
                        count={stages.length}
                        onMove={(delta) => setStages(moveItem(stages, index, delta))}
                      />
                      <input
                        className="input grow"
                        aria-label={`Stage ${index + 1} name`}
                        value={stage.name}
                        maxLength={60}
                        required
                        onChange={(event) => setStages(stages.map((s) => (s.id === stage.id ? { ...s, name: event.target.value } : s)))}
                      />
                      <select
                        className="select config-draft__category"
                        aria-label={`Stage ${index + 1} category`}
                        value={stage.category}
                        onChange={(event) => {
                          const category = event.target.value;
                          if (category === 'open' || category === 'won' || category === 'lost') {
                            setStages(stages.map((s) => (s.id === stage.id ? { ...s, category } : s)));
                          }
                        }}
                      >
                        {(['open', 'won', 'lost'] as const).map((category) => (
                          <option key={category} value={category}>
                            {CATEGORY_LABELS[category]}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="trash"
                        aria-label={`Remove stage ${stage.name || index + 1}`}
                        disabled={stages.length <= 3}
                        onClick={() => setStages(stages.filter((s) => s.id !== stage.id))}
                      />
                    </div>
                    {stageError(index) ? <p className="config-draft__error">{stageError(index)}</p> : null}
                  </li>
                ))}
              </ol>
              <div className="row gap-8">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="plus"
                  disabled={stages.length >= 30}
                  onClick={() => {
                    const at = stages.findIndex((s) => s.category !== 'open');
                    const added = { id: nextDraftId++, name: '', category: 'open' as const };
                    setStages(at === -1 ? [...stages, added] : [...stages.slice(0, at), added, ...stages.slice(at)]);
                  }}
                >
                  Add a stage
                </Button>
              </div>
              <p className="field__hint">Every pipeline needs at least one open, one won and one lost stage.</p>
              {errors.stages ? <p className="field__error">{errors.stages}</p> : null}
            </fieldset>

            <div className="config-preview">
              <p className="config-preview__label">Preview</p>
              <StageBubbles
                stages={bubblesOf(stages.map((stage) => ({ id: String(stage.id), name: stage.name || 'Unnamed', category: stage.category })))}
                currentId={stages[0] ? String(stages[0].id) : null}
                size="full"
                label="Preview of the new pipeline"
              />
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {pipeline ? 'Save' : 'Create pipeline'}
        </Button>
      </DialogFooter>
    </form>
  );
}
