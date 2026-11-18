'use client';

import { useState } from 'react';
import { StageBubbles } from '@/components/crm';
import { ConfigShell } from '@/components/config/ConfigShell';
import { Badge, Button, Card, EmptyState, ErrorAlert, Spinner, cx } from '@/components/ui';
import type { ConfigCompany } from '@/lib/config/companies';
import { KIND_SHORT } from '@/lib/config/format';
import { usePipelines, useProductLines } from '@/lib/config/queries';
import type { Pipeline } from '@/lib/crm/types';
import { LostReasons } from './LostReasons';
import { PipelineDialog } from './PipelineDialog';
import { PipelineEditor, bubblesOf } from './PipelineEditor';
import './pipelines.css';

export function PipelinesView() {
  return (
    <ConfigShell
      view="pipelines.view"
      manage="pipelines.manage"
      intro="Each company sets up its own pipelines: the stages a lead moves through, how long each may take, what a deal needs before it enters a stage, and why deals are lost."
    >
      {(company) => <CompanyPipelines company={company} />}
    </ConfigShell>
  );
}

function CompanyPipelines({ company }: { company: ConfigCompany }) {
  const pipelines = usePipelines(company.unit.id);
  const productLines = useProductLines(company.unit.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = pipelines.data ?? [];
  const selected = list.find((pipeline) => pipeline.id === selectedId) ?? list.find((pipeline) => !pipeline.archivedAt) ?? list[0] ?? null;

  return (
    <div className="stack gap-16">
      <div className="split">
        <div className="split__side">
          <Card
            flush
            title="Pipelines"
            description={`${company.unit.name}: B2C pipelines for families, B2B for institutes`}
            actions={
              company.canManage ? (
                <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  New pipeline
                </Button>
              ) : undefined
            }
          >
            {pipelines.isPending ? (
              <div className="empty">
                <Spinner />
              </div>
            ) : pipelines.isError ? (
              <div className="card__body">
                <ErrorAlert error={pipelines.error} />
              </div>
            ) : list.length === 0 ? (
              <EmptyState icon="kanban" title="No pipelines yet">
                {company.canManage ? 'Create the first pipeline to start tracking leads.' : 'An admin has not set up pipelines here yet.'}
              </EmptyState>
            ) : (
              <ul className="config-list" aria-label="Pipelines">
                {list.map((pipeline) => (
                  <li key={pipeline.id}>
                    <PipelineItem pipeline={pipeline} selected={pipeline.id === selected?.id} onSelect={() => setSelectedId(pipeline.id)} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="split__main">
          {selected ? (
            <PipelineEditor
              key={selected.id}
              pipeline={selected}
              company={company}
              productLines={productLines.data ?? []}
            />
          ) : null}
        </div>
      </div>

      <LostReasons company={company} />

      <PipelineDialog
        open={creating}
        onClose={() => setCreating(false)}
        company={company}
        productLines={productLines.data ?? []}
        onSaved={(pipeline) => setSelectedId(pipeline.id)}
      />
    </div>
  );
}

function PipelineItem({ pipeline, selected, onSelect }: { pipeline: Pipeline; selected: boolean; onSelect: () => void }) {
  const stages = pipeline.stages.filter((stage) => !stage.archivedAt);
  return (
    <button
      type="button"
      className={cx('config-pipeline', selected && 'config-pipeline--selected', pipeline.archivedAt && 'config-pipeline--archived')}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="config-pipeline__title">
        <span className="strong">{pipeline.name}</span>
        <Badge>{KIND_SHORT[pipeline.kind]}</Badge>
        {pipeline.isDefault ? <Badge tone="accent">Default</Badge> : null}
        {pipeline.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
      </span>
      <span className="config-pipeline__stages">
        <StageBubbles stages={bubblesOf(stages)} currentId={null} showCurrent={false} label={`Stages of ${pipeline.name}`} />
        <span className="small muted">
          {stages.length} {stages.length === 1 ? 'stage' : 'stages'}
        </span>
      </span>
    </button>
  );
}
