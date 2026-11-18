'use client';

import { useState, type FormEvent } from 'react';
import { BulkActionBar, Menu, type MenuItem } from '@/components/crm';
import { ConfirmDialog, Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Alert, Button, ErrorAlert, Field } from '@/components/ui';
import { formatCount } from '@/lib/crm/format';
import type { DealBulkAction, DealBulkFilter, DealBulkResult, DealListItem, PersonOption, Pipeline } from '@/lib/crm/types';
import { useBulkDeals, useLostReasons } from '@/lib/deals/hooks';
import { useSession } from '@/lib/session';
import { leadName } from './columns';

/** What the bulk action runs on: the ticked rows, or everything the filters match (the server caps it at 1000). */
export type BulkTarget = { kind: 'ids'; ids: string[] } | { kind: 'filter'; filter: DealBulkFilter };

/** The most leads one bulk request may change (POST /deals/bulk). */
export const BULK_LIMIT = 1000;

type Open = 'tags' | 'lose' | 'archive' | null;

const plural = (count: number, word: string) => `${formatCount(count)} ${count === 1 ? word : `${word}s`}`;

/** A sentence about what a bulk action did. */
function resultSummary(result: DealBulkResult, verb: string): string {
  const parts = [`${verb} ${plural(result.updated.length, 'lead')}`];
  if (result.unchanged.length > 0) parts.push(`${formatCount(result.unchanged.length)} already up to date`);
  if (result.failed.length > 0) parts.push(`${formatCount(result.failed.length)} couldn't be changed`);
  return `${parts.join(', ')}.`;
}

export interface BulkOutcome {
  summary: string;
  failed: Array<{ id: string; name: string; message: string }>;
  tone: 'success' | 'warning';
}

/** The result panel after a bulk action: what changed, and why each failure failed. */
export function BulkResultAlert({ outcome, onDismiss }: { outcome: BulkOutcome; onDismiss: () => void }) {
  const shown = outcome.failed.slice(0, 10);
  return (
    <Alert
      tone={outcome.tone}
      title={outcome.summary}
      action={<Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss" onClick={onDismiss} />}
    >
      {shown.length > 0 ? (
        <ul className="leads-bulk-failures">
          {shown.map((item) => (
            <li key={item.id}>
              <strong>{item.name}</strong>: {item.message}
            </li>
          ))}
          {outcome.failed.length > shown.length ? <li>…and {formatCount(outcome.failed.length - shown.length)} more.</li> : null}
        </ul>
      ) : null}
    </Alert>
  );
}

export function LeadBulkActions({
  target,
  rows,
  pipelines,
  owners,
  onClear,
  onDone,
}: {
  target: BulkTarget;
  /** Loaded rows, to name leads in the result and pick stages and lost reasons. */
  rows: readonly DealListItem[];
  pipelines: readonly Pipeline[];
  owners: readonly PersonOption[];
  onClear: () => void;
  onDone: (outcome: BulkOutcome) => void;
}) {
  const session = useSession();
  const bulk = useBulkDeals();
  const [open, setOpen] = useState<Open>(null);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const selectedRows = target.kind === 'ids' ? target.ids.flatMap((id) => byId.get(id) ?? []) : rows;
  const count = target.kind === 'ids' ? target.ids.length : 0;
  const noun = target.kind === 'ids' ? (count === 1 ? 'lead' : 'leads') : 'leads';
  const what = target.kind === 'ids' ? plural(count, 'lead') : `every lead matching the filters (up to ${formatCount(BULK_LIMIT)})`;

  function run(action: DealBulkAction, verb: string) {
    const body = target.kind === 'ids' ? { ...action, ids: target.ids } : { ...action, filter: target.filter };
    bulk.mutate(body, {
      onSuccess: (result) => {
        setOpen(null);
        onClear();
        onDone({
          summary: resultSummary(result, verb),
          tone: result.failed.length > 0 ? 'warning' : 'success',
          failed: result.failed.map((item) => {
            const row = byId.get(item.id);
            return { id: item.id, name: row ? `${leadName(row)} (${row.ref})` : 'A lead', message: item.message };
          }),
        });
      },
    });
  }

  // Stages of the pipelines the selected leads are in (every pipeline in scope for a filter).
  const pipelineIds = new Set(selectedRows.map((row) => row.pipelineId));
  const shownPipelines =
    target.kind === 'filter' || pipelineIds.size === 0 ? pipelines : pipelines.filter((pipeline) => pipelineIds.has(pipeline.id));
  const stageItems: MenuItem[] = shownPipelines.flatMap((pipeline) =>
    pipeline.stages
      .filter((stage) => stage.archivedAt === null && stage.category !== 'lost')
      .sort((a, b) => a.position - b.position)
      .map((stage) => ({
        key: stage.id,
        label: shownPipelines.length > 1 ? `${pipeline.name} › ${stage.name}` : stage.name,
        icon: 'arrowRight' as const,
        onSelect: () => run({ action: 'move', stageId: stage.id }, `Moved to ${stage.name}:`),
      })),
  );

  const canAssign = session.canAnywhere('deals.assign');
  const assignItems: MenuItem[] = [
    { key: 'me', label: 'Me', icon: 'user', onSelect: () => run({ action: 'assign', ownerUserId: session.user.id }, 'Assigned to you:') },
    { key: 'none', label: 'Nobody (unassign)', icon: 'eyeOff', onSelect: () => run({ action: 'assign', ownerUserId: null }, 'Unassigned') },
    ...owners
      .filter((person) => person.id !== session.user.id)
      .map((person) => ({
        key: person.id,
        label: person.name,
        icon: 'user' as const,
        onSelect: () => run({ action: 'assign', ownerUserId: person.id }, `Assigned to ${person.name}:`),
      })),
  ];

  const companyId = selectedRows[0]?.companyId ?? null;
  const kind = selectedRows[0]?.kind;
  const mixedCompanies = new Set(selectedRows.map((row) => row.companyId)).size > 1;

  return (
    <>
      <BulkActionBar count={target.kind === 'ids' ? count : rows.length} noun="lead" onClear={onClear} label="Bulk actions on leads">
        {target.kind === 'filter' ? <span className="leads-bulk__scope">and every other match, up to {formatCount(BULK_LIMIT)}</span> : null}
        {canAssign ? (
          <Menu
            label={`Assign ${what} to`}
            heading="Assign to…"
            items={assignItems}
            trigger={(trigger) => (
              <Button {...trigger} size="sm" icon="user" loading={bulk.isPending && bulk.variables?.action === 'assign'}>
                Assign
              </Button>
            )}
          />
        ) : null}
        <Menu
          label={`Move ${what} to`}
          heading="Move to…"
          items={stageItems}
          emptyText="No stages to move to"
          trigger={(trigger) => (
            <Button {...trigger} size="sm" icon="move" loading={bulk.isPending && bulk.variables?.action === 'move'}>
              Change stage
            </Button>
          )}
        />
        <Button size="sm" icon="tag" onClick={() => setOpen('tags')}>
          Tags
        </Button>
        <Button size="sm" icon="x" onClick={() => setOpen('lose')}>
          Mark lost
        </Button>
        {session.canAnywhere('deals.archive') ? (
          <Button size="sm" icon="archive" onClick={() => setOpen('archive')}>
            Archive
          </Button>
        ) : null}
      </BulkActionBar>

      {bulk.isError && open === null ? (
        <div className="leads-bulk__error">
          <ErrorAlert error={bulk.error} title="The bulk action didn't run" />
        </div>
      ) : null}

      <Dialog open={open === 'tags'} onClose={() => setOpen(null)} title={`Tags on ${what}`} description="Separate several tags with commas.">
        <TagsForm
          pending={bulk.isPending}
          error={bulk.error}
          onCancel={() => setOpen(null)}
          onSubmit={(tags, remove) =>
            run(remove ? { action: 'removeTags', tags } : { action: 'addTags', tags }, remove ? 'Removed the tags from' : 'Tagged')
          }
        />
      </Dialog>

      <Dialog open={open === 'lose'} onClose={() => setOpen(null)} title={`Mark ${what} as lost`}>
        <LoseForm
          companyId={companyId}
          kind={kind}
          mixedCompanies={mixedCompanies}
          pending={bulk.isPending}
          error={bulk.error}
          onCancel={() => setOpen(null)}
          onSubmit={(lostReasonId, lostNote, nurture) => run({ action: 'lose', lostReasonId, lostNote, nurture }, 'Marked lost:')}
        />
      </Dialog>

      <ConfirmDialog
        open={open === 'archive'}
        onClose={() => setOpen(null)}
        title={`Archive ${what}?`}
        confirmLabel="Archive"
        danger
        pending={bulk.isPending}
        error={open === 'archive' ? bulk.error : null}
        onConfirm={() => run({ action: 'archive' }, 'Archived')}
      >
        <p>Archived {noun} leave every list and search. People who can archive leads can restore them.</p>
      </ConfirmDialog>
    </>
  );
}

function TagsForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (tags: string[], remove: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [empty, setEmpty] = useState(false);
  const tags = text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const submit = (remove: boolean) => (event?: FormEvent) => {
    event?.preventDefault();
    if (tags.length === 0) {
      setEmpty(true);
      return;
    }
    onSubmit(tags, remove);
  };
  return (
    <form onSubmit={submit(false)} noValidate>
      <DialogBody>
        <Field label="Tags" error={empty && tags.length === 0 ? 'Type at least one tag' : undefined}>
          {(control) => (
            <input
              {...control}
              className="input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="scholarship, sibling"
              autoFocus
            />
          )}
        </Field>
        <ErrorAlert error={error} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={() => submit(true)()} loading={pending}>
          Remove tags
        </Button>
        <Button type="submit" variant="primary" loading={pending}>
          Add tags
        </Button>
      </DialogFooter>
    </form>
  );
}

function LoseForm({
  companyId,
  kind,
  mixedCompanies,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  companyId: string | null;
  kind: DealListItem['kind'] | undefined;
  mixedCompanies: boolean;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (lostReasonId: string, lostNote: string | undefined, nurture: boolean) => void;
}) {
  const reasons = useLostReasons(companyId, kind);
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [nurture, setNurture] = useState(true);
  const [tried, setTried] = useState(false);
  const reason = reasons.data?.find((item) => item.id === reasonId);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!reasonId) return;
    onSubmit(reasonId, note.trim() || undefined, nurture);
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        {mixedCompanies ? (
          <Alert tone="warning">
            These leads belong to several companies. The reasons below are one company&apos;s; leads of other companies will be reported as not
            changed.
          </Alert>
        ) : null}
        <Field label="Reason" error={tried && !reasonId ? 'Pick a reason' : undefined}>
          {(control) => (
            <select
              {...control}
              className="select"
              value={reasonId}
              onChange={(event) => setReasonId(event.target.value)}
              disabled={reasons.isPending}
            >
              <option value="">{reasons.isPending ? 'Loading reasons…' : 'Choose a reason'}</option>
              {(reasons.data ?? [])
                .filter((item) => item.active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Note" optional={!reason?.requiresNote} hint={reason?.requiresNote ? 'This reason needs a short note' : undefined}>
          {(control) => (
            <textarea {...control} className="textarea" rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
          )}
        </Field>
        <label className="check">
          <input type="checkbox" checked={nurture} onChange={(event) => setNurture(event.target.checked)} />
          <span>Keep in touch: add them to the nurture flow</span>
        </label>
        {reasons.isError ? <ErrorAlert error={reasons.error} title="Couldn't load the lost reasons" /> : null}
        <ErrorAlert error={error} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="danger" loading={pending}>
          Mark lost
        </Button>
      </DialogFooter>
    </form>
  );
}
