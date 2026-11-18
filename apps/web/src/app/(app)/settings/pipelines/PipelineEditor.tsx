'use client';

import { useMemo, useState, type DragEvent } from 'react';
import { StageBubbles, StatusPill, type StageBubble } from '@/components/crm';
import { ColourDot, OrderButtons } from '@/components/config/controls';
import { ConfirmDialog } from '@/components/dialog';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, ErrorAlert, cx } from '@/components/ui';
import { api } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { CATEGORY_LABELS, KIND_LABELS, formatSlaHours, moveItem, moveTo } from '@/lib/config/format';
import { DEAL_VIEW_KEYS, useConfigMutation, useRequiredFieldOptions } from '@/lib/config/queries';
import type { Pipeline, PipelinePatchInput, ProductLine, Stage, StageCategory } from '@/lib/crm/types';
import { ArchiveStageDialog } from './ArchiveStageDialog';
import { PipelineDialog } from './PipelineDialog';
import { StageDialog } from './StageDialog';

const CATEGORY_TONE: Record<StageCategory, 'accent' | 'success' | 'danger'> = { open: 'accent', won: 'success', lost: 'danger' };

/** Stages as StageBubbles input: won and lost stages carry their outcome. */
export function bubblesOf(stages: readonly Pick<Stage, 'id' | 'name' | 'category'>[]): StageBubble[] {
  return stages.map((stage) => ({ id: stage.id, name: stage.name, outcome: stage.category === 'open' ? null : stage.category }));
}

type StageDialogState = { mode: 'add' } | { mode: 'edit'; stage: Stage } | null;

export function PipelineEditor({
  pipeline,
  company,
  productLines,
}: {
  pipeline: Pipeline;
  company: ConfigCompany;
  productLines: ProductLine[];
}) {
  const archived = Boolean(pipeline.archivedAt);
  const canManage = company.canManage && !archived;
  const requiredOptions = useRequiredFieldOptions(company.unit.id, pipeline.kind);
  const labelOf = useMemo(() => new Map((requiredOptions.data ?? []).map((option) => [option.key, option.label])), [requiredOptions.data]);

  const saved = pipeline.stages.filter((stage) => !stage.archivedAt);
  // While a new order is being saved, show it straight away.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const stages = pendingOrder
    ? pendingOrder.map((id) => saved.find((stage) => stage.id === id)).filter((stage): stage is Stage => stage !== undefined)
    : saved;

  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = stages.find((stage) => stage.id === previewId) ?? stages[0] ?? null;
  const [stageDialog, setStageDialog] = useState<StageDialogState>(null);
  const [archiving, setArchiving] = useState<Stage | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const reorder = useConfigMutation((stageIds: string[]) => api.put<Pipeline>(`/pipelines/${pipeline.id}/stages/order`, { stageIds }), {
    alsoInvalidate: DEAL_VIEW_KEYS,
    onSuccess: () => setPendingOrder(null),
  });
  const update = useConfigMutation((body: PipelinePatchInput) => api.patch<Pipeline>(`/pipelines/${pipeline.id}`, body));
  const archive = useConfigMutation(() => api.post<Pipeline>(`/pipelines/${pipeline.id}/archive`), {
    alsoInvalidate: DEAL_VIEW_KEYS,
    onSuccess: () => setConfirm(null),
  });
  const restore = useConfigMutation(() => api.post<Pipeline>(`/pipelines/${pipeline.id}/restore`), { alsoInvalidate: DEAL_VIEW_KEYS });

  function saveOrder(ids: string[]) {
    if (ids.every((id, index) => id === stages[index]?.id)) return;
    setPendingOrder(ids);
    reorder.mutate(ids, { onError: () => setPendingOrder(null) });
  }

  function onDrop(event: DragEvent<HTMLLIElement>, index: number) {
    event.preventDefault();
    const from = stages.findIndex((stage) => stage.id === dragId);
    setDragId(null);
    setDropIndex(null);
    if (from < 0) return;
    saveOrder(moveTo(stages, from, from < index ? index - 1 : index).map((stage) => stage.id));
  }

  const lineNames = pipeline.productLineIds
    .map((id) => productLines.find((line) => line.id === id)?.name)
    .filter((name): name is string => Boolean(name));

  return (
    <div className="stack gap-16">
      <Card
        title={
          <span className="row gap-8">
            {pipeline.name}
            {pipeline.isDefault ? <Badge tone="accent">Default</Badge> : null}
            {archived ? <Badge tone="warning">Archived</Badge> : null}
          </span>
        }
        description={
          <>
            {KIND_LABELS[pipeline.kind]} · <span className="config-key">{pipeline.key}</span> ·{' '}
            {lineNames.length ? `For ${lineNames.join(', ')}` : 'For every product line'}
          </>
        }
        actions={
          company.canManage ? (
            archived ? (
              <Button size="sm" icon="restore" loading={restore.isPending} onClick={() => restore.mutate(undefined)}>
                Restore
              </Button>
            ) : (
              <>
                {pipeline.isDefault ? null : (
                  <Button size="sm" icon="star" loading={update.isPending} onClick={() => update.mutate({ isDefault: true })}>
                    Make default
                  </Button>
                )}
                <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon="archive" onClick={() => setConfirm('archive')}>
                  Archive
                </Button>
              </>
            )
          ) : undefined
        }
      >
        <div className="card__body stack gap-12">
          <ErrorAlert error={update.error ?? restore.error ?? reorder.error} />
          {archived ? (
            <Alert tone="warning">This pipeline is archived: new deals can&apos;t use it. Restore it to change its stages.</Alert>
          ) : null}
          <div className="config-preview">
            <p className="config-preview__label">Preview: how a deal moves</p>
            {stages.length ? (
              <StageBubbles
                stages={bubblesOf(stages)}
                currentId={preview?.id ?? null}
                size="full"
                label={`Preview of ${pipeline.name}`}
                onSelect={(bubble) => setPreviewId(bubble.id)}
              />
            ) : (
              <p className="small muted">No active stages.</p>
            )}
            {preview ? <StageRules stage={preview} stages={stages} labelOf={labelOf} /> : null}
          </div>
        </div>
      </Card>

      <Card
        flush
        title="Stages"
        description={canManage ? 'Drag a stage, or use the arrows, to change the order. Deals keep their stage.' : undefined}
        actions={
          canManage ? (
            <Button size="sm" variant="primary" icon="plus" onClick={() => setStageDialog({ mode: 'add' })}>
              Add stage
            </Button>
          ) : undefined
        }
      >
        <ol className="config-list config-stages" aria-label={`Stages of ${pipeline.name}`}>
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              className={cx(
                'config-row config-stage',
                dragId === stage.id && 'config-stage--dragging',
                dropIndex === index && dragId !== stage.id && 'config-stage--drop',
              )}
              draggable={canManage && !reorder.isPending}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', stage.id);
                setDragId(stage.id);
              }}
              onDragOver={(event) => {
                if (!dragId) return;
                event.preventDefault();
                setDropIndex(index);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              onDrop={(event) => onDrop(event, index)}
            >
              {canManage ? (
                <>
                  <span className="config-stage__handle" aria-hidden="true" title="Drag to reorder">
                    <Icon name="more" size={16} />
                  </span>
                  <OrderButtons
                    label={stage.name}
                    index={index}
                    count={stages.length}
                    disabled={reorder.isPending}
                    onMove={(delta) => saveOrder(moveItem(stages, index, delta).map((s) => s.id))}
                  />
                </>
              ) : null}
              <span className="config-stage__number mono" aria-hidden="true">
                {index + 1}
              </span>
              <div className="config-row__main">
                <span className="config-row__title">
                  <ColourDot colour={stage.colour} />
                  {stage.name}
                  <span className="config-key">{stage.key}</span>
                  <StatusPill tone={CATEGORY_TONE[stage.category]}>{CATEGORY_LABELS[stage.category]}</StatusPill>
                </span>
                <span className="config-row__meta">
                  {stage.probability}% likely · SLA {formatSlaHours(stage.slaHours)}
                  {stage.requiredFields.length ? ` · Needs ${stage.requiredFields.map((key) => labelOf.get(key) ?? key).join(', ')}` : ''}
                  {stage.entryRules.allowedFrom?.length
                    ? ` · Only from ${stage.entryRules.allowedFrom.map((key) => stages.find((s) => s.key === key)?.name ?? key).join(', ')}`
                    : ''}
                </span>
              </div>
              {canManage ? (
                <div className="config-row__actions">
                  <Button size="sm" icon="edit" aria-label={`Edit ${stage.name}`} onClick={() => setStageDialog({ mode: 'edit', stage })}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" iconOnly icon="archive" aria-label={`Remove ${stage.name}`} onClick={() => setArchiving(stage)} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>

      <StageDialog
        open={stageDialog !== null}
        onClose={() => setStageDialog(null)}
        pipeline={pipeline}
        stages={stages}
        stage={stageDialog?.mode === 'edit' ? stageDialog.stage : null}
        requiredOptions={requiredOptions.data ?? []}
      />
      <ArchiveStageDialog pipeline={pipeline} stages={stages} stage={archiving} onClose={() => setArchiving(null)} />
      <PipelineDialog
        open={editing}
        onClose={() => setEditing(false)}
        company={company}
        productLines={productLines}
        pipeline={pipeline}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onClose={() => {
          setConfirm(null);
          archive.reset();
        }}
        title={`Archive ${pipeline.name}?`}
        confirmLabel="Archive pipeline"
        danger
        pending={archive.isPending}
        error={archive.error}
        onConfirm={() => archive.mutate(undefined)}
      >
        <p>New deals can&apos;t use an archived pipeline. Won and lost deals keep it, and you can restore it later.</p>
        <p className="small muted">A pipeline with open deals can&apos;t be archived. {pipeline.isDefault ? 'Another pipeline becomes the default.' : ''}</p>
      </ConfirmDialog>
    </div>
  );
}

/** What the previewed stage asks of a deal. */
function StageRules({ stage, stages, labelOf }: { stage: Stage; stages: readonly Stage[]; labelOf: ReadonlyMap<string, string> }) {
  const from = stage.entryRules.allowedFrom ?? [];
  return (
    <dl className="config-rules">
      <div>
        <dt>To enter {stage.name}</dt>
        <dd>{stage.requiredFields.length ? stage.requiredFields.map((key) => labelOf.get(key) ?? key).join(', ') : 'Nothing required'}</dd>
      </div>
      <div>
        <dt>Comes from</dt>
        <dd>{from.length ? from.map((key) => stages.find((s) => s.key === key)?.name ?? key).join(' or ') : 'Any stage'}</dd>
      </div>
      <div>
        <dt>Time allowed</dt>
        <dd>{formatSlaHours(stage.slaHours)}</dd>
      </div>
      <div>
        <dt>Win probability</dt>
        <dd>{stage.probability}%</dd>
      </div>
    </dl>
  );
}
