'use client';

import { useState } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { api, isApiError } from '@/lib/api';
import { DEAL_VIEW_KEYS, useConfigMutation } from '@/lib/config/queries';
import { crmKeys } from '@/lib/crm/keys';
import type { DealCountConflictDetails, Pipeline, Stage, StageArchiveInput } from '@/lib/crm/types';

/** The deal counts of a 409 "this stage still has deals", if that is what the error is. */
function dealCountsOf(error: unknown): DealCountConflictDetails | null {
  if (!isApiError(error) || error.status !== 409) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('openDealCount' in details)) return null;
  return typeof details.openDealCount === 'number' ? { openDealCount: details.openDealCount } : null;
}

/**
 * Remove (archive) a stage. When it still has open deals the API answers 409 with the count;
 * then the person picks a stage of the same category to move them to.
 */
export function ArchiveStageDialog({
  pipeline,
  stages,
  stage,
  onClose,
}: {
  pipeline: Pipeline;
  stages: readonly Stage[];
  stage: Stage | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={stage !== null} onClose={onClose} title={stage ? `Remove ${stage.name}?` : 'Remove stage'}>
      {stage ? <ArchiveForm pipeline={pipeline} stages={stages} stage={stage} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ArchiveForm({ pipeline, stages, stage, onClose }: { pipeline: Pipeline; stages: readonly Stage[]; stage: Stage; onClose: () => void }) {
  const targets = stages.filter((s) => s.id !== stage.id && s.category === stage.category);
  const [moveTo, setMoveTo] = useState('');
  const [needsTarget, setNeedsTarget] = useState<number | null>(null);

  const archive = useConfigMutation(
    (body: StageArchiveInput) => api.post<Pipeline>(`/pipelines/${pipeline.id}/stages/${stage.id}/archive`, body),
    { alsoInvalidate: [...DEAL_VIEW_KEYS, crmKeys.timeline.all], onSuccess: onClose },
  );

  function submit() {
    archive.mutate(moveTo ? { moveToStageId: moveTo } : {}, {
      onError: (error) => {
        const counts = dealCountsOf(error);
        if (counts) {
          setNeedsTarget(counts.openDealCount);
          setMoveTo((current) => current || targets[0]?.id || '');
        }
      },
    });
  }

  const counts = dealCountsOf(archive.error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogBody>
        <p>
          {stage.name} disappears from {pipeline.name}. Its history stays on the deals that passed through it.
        </p>
        {counts ? null : <ErrorAlert error={archive.error} />}
        {needsTarget !== null ? (
          <Alert tone="warning" title={`${needsTarget} open ${needsTarget === 1 ? 'deal is' : 'deals are'} in ${stage.name}`}>
            {targets.length
              ? 'Pick where they go. Each deal gets a stage change on its timeline.'
              : `Add another ${stage.category} stage first, so they have somewhere to go.`}
          </Alert>
        ) : null}
        {needsTarget !== null && targets.length ? (
          <Field label="Move them to">
            {(control) => (
              <select {...control} className="select" value={moveTo} required onChange={(event) => setMoveTo(event.target.value)}>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="danger" loading={archive.isPending} disabled={needsTarget !== null && targets.length === 0}>
          {needsTarget !== null ? 'Move deals and remove' : 'Remove stage'}
        </Button>
      </DialogFooter>
    </form>
  );
}
