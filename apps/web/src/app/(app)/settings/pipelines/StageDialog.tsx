'use client';

import { useState } from 'react';
import { StageBubbles } from '@/components/crm';
import { FieldControl } from '@/components/DynamicField';
import { ChipChecklist, Segmented, errorFor } from '@/components/config/controls';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { CATEGORY_LABELS, toKey } from '@/lib/config/format';
import { DEAL_VIEW_KEYS, useConfigMutation } from '@/lib/config/queries';
import type { Pipeline, RequiredFieldOption, Stage, StageCategory, StageCreateInput, StagePatchInput } from '@/lib/crm/types';
import { bubblesOf } from './PipelineEditor';

const CATEGORIES: ReadonlyArray<{ value: StageCategory; label: string }> = [
  { value: 'open', label: CATEGORY_LABELS.open },
  { value: 'won', label: CATEGORY_LABELS.won },
  { value: 'lost', label: CATEGORY_LABELS.lost },
];

const DRAFT_ID = 'draft-stage';

/** Add a stage, or edit one: name, category, probability, SLA, colour, required fields and entry rule. */
export function StageDialog({
  open,
  onClose,
  pipeline,
  stages,
  stage,
  requiredOptions,
}: {
  open: boolean;
  onClose: () => void;
  pipeline: Pipeline;
  /** Active stages in order. */
  stages: readonly Stage[];
  /** The stage to edit; null adds one. */
  stage: Stage | null;
  requiredOptions: readonly RequiredFieldOption[];
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={stage ? `Edit ${stage.name}` : `Add a stage to ${pipeline.name}`}
      description="Rules apply when a deal enters the stage. A new time limit applies to deals that enter from now on."
    >
      {open ? <StageForm pipeline={pipeline} stages={stages} stage={stage} requiredOptions={requiredOptions} onClose={onClose} /> : null}
    </Dialog>
  );
}

function StageForm({
  pipeline,
  stages,
  stage,
  requiredOptions,
  onClose,
}: {
  pipeline: Pipeline;
  stages: readonly Stage[];
  stage: Stage | null;
  requiredOptions: readonly RequiredFieldOption[];
  onClose: () => void;
}) {
  const firstWon = stages.findIndex((s) => s.category === 'won');
  const [name, setName] = useState(stage?.name ?? '');
  const [key, setKey] = useState(stage?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(Boolean(stage));
  const [category, setCategory] = useState<StageCategory>(stage?.category ?? 'open');
  const [probability, setProbability] = useState(String(stage?.probability ?? 0));
  const [slaHours, setSlaHours] = useState(stage?.slaHours ? String(stage.slaHours) : '');
  const [colour, setColour] = useState(stage?.colour ?? '');
  const [requiredFields, setRequiredFields] = useState<string[]>(stage?.requiredFields ?? []);
  const [allowedFrom, setAllowedFrom] = useState<string[]>(stage?.entryRules.allowedFrom ?? []);
  const [position, setPosition] = useState(String(firstWon === -1 ? stages.length : firstWon));

  const effectiveKey = keyTouched ? key : toKey(name);

  const save = useConfigMutation(
    () => {
      const common = {
        name,
        probability: Number(probability) || 0,
        slaHours: slaHours.trim() ? Number(slaHours) : null,
        colour: colour.trim() ? colour.trim() : null,
        requiredFields,
        entryRules: allowedFrom.length ? { allowedFrom } : {},
      };
      if (stage) return api.patch<Pipeline>(`/pipelines/${pipeline.id}/stages/${stage.id}`, common satisfies StagePatchInput);
      const body: StageCreateInput = { ...common, key: effectiveKey, category, position: Number(position) };
      return api.post<Pipeline>(`/pipelines/${pipeline.id}/stages`, body);
    },
    { alsoInvalidate: DEAL_VIEW_KEYS, onSuccess: onClose },
  );

  const errors = fieldErrorsOf(save.error);
  const shown = Object.keys(errors).filter((path) =>
    ['name', 'key', 'category', 'probability', 'slaHours', 'colour', 'requiredFields', 'entryRules', 'position'].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}.`),
    ),
  );

  // Live preview: the stage list with this stage as it would be saved.
  const draft = { id: stage?.id ?? DRAFT_ID, name: name.trim() || 'New stage', category };
  const previewStages = stage
    ? stages.map((s) => (s.id === stage.id ? { ...s, ...draft } : s))
    : [...stages.slice(0, Number(position)), draft, ...stages.slice(Number(position))];

  const otherStages = stages.filter((s) => s.id !== stage?.id).map((s) => ({ value: s.key, label: s.name }));
  const options = requiredOptions.map((option) => ({ value: option.key, label: option.label }));
  // A required field that is no longer offered (e.g. limited to the other kind) still shows, so it can be removed.
  for (const key of requiredFields) if (!options.some((o) => o.value === key)) options.push({ value: key, label: key });

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
              <input {...control} className="input" value={name} maxLength={60} required onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          <Field
            label="Key"
            hint={stage ? 'Keys never change: saved views and automations use them.' : 'Lowercase letters, numbers and underscores.'}
            error={errors.key}
          >
            {(control) => (
              <input
                {...control}
                className="input mono"
                value={effectiveKey}
                maxLength={40}
                disabled={Boolean(stage)}
                required
                onChange={(event) => {
                  setKeyTouched(true);
                  setKey(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        {stage ? null : (
          <div className="form-grid">
            <div className="field">
              <span className="field__label" id="stage-category-label">
                Category
              </span>
              <Segmented label="Category" options={CATEGORIES} value={category} onChange={setCategory} />
              <p className="field__hint">A deal&apos;s status follows its stage: open, won or lost.</p>
              {errors.category ? <p className="field__error">{errors.category}</p> : null}
            </div>
            <Field label="Place it" error={errors.position}>
              {(control) => (
                <select {...control} className="select" value={position} onChange={(event) => setPosition(event.target.value)}>
                  {stages.map((s, index) => (
                    <option key={s.id} value={index}>
                      Before {s.name}
                    </option>
                  ))}
                  <option value={stages.length}>At the end</option>
                </select>
              )}
            </Field>
          </div>
        )}

        <div className="form-grid">
          <Field label="Win probability (%)" error={errors.probability}>
            {(control) => (
              <input
                {...control}
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                value={probability}
                onChange={(event) => setProbability(event.target.value)}
              />
            )}
          </Field>
          <Field label="Time allowed (hours)" optional hint="Deals past this are flagged. Leave empty for no target." error={errors.slaHours}>
            {(control) => (
              <input
                {...control}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={8760}
                step={1}
                value={slaHours}
                onChange={(event) => setSlaHours(event.target.value)}
              />
            )}
          </Field>
          <Field label="Colour" optional error={errors.colour}>
            {(control) => (
              <FieldControl
                field={{ key: 'colour', label: 'Colour', input: 'color', placeholder: '#2840D8' }}
                value={colour}
                onChange={(value) => setColour(typeof value === 'string' ? value : '')}
                control={control}
              />
            )}
          </Field>
        </div>

        <ChipChecklist
          label="Needed to enter this stage"
          hint="A deal can't move here until these are filled in."
          error={errorFor(errors, 'requiredFields')}
          options={options}
          value={requiredFields}
          onChange={setRequiredFields}
        />
        <ChipChecklist
          label="Can only be entered from"
          hint="Leave all unticked to allow any stage. Reopening a deal ignores this rule."
          error={errorFor(errors, 'entryRules')}
          options={otherStages}
          value={allowedFrom}
          onChange={setAllowedFrom}
          empty="There are no other stages yet."
        />

        <div className="config-preview">
          <p className="config-preview__label">Preview</p>
          <StageBubbles stages={bubblesOf(previewStages)} currentId={draft.id} size="full" label="Preview of the pipeline with this stage" />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {stage ? 'Save stage' : 'Add stage'}
        </Button>
      </DialogFooter>
    </form>
  );
}
