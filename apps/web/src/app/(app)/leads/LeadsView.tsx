'use client';

import { useState } from 'react';
import { DataTable, SavedViewsMenu, infiniteRows, useRowSelection, type SavedView as MenuView } from '@/components/crm';
import { BulkResultAlert, LeadBulkActions, type BulkOutcome, type BulkTarget } from '@/components/leads/BulkActions';
import { ColumnsMenu } from '@/components/leads/ColumnsMenu';
import { LeadFilters } from '@/components/leads/LeadFilters';
import { LeadPreview } from '@/components/leads/LeadPreview';
import { NewLeadDialog } from '@/components/leads/NewLeadDialog';
import { leadColumns, leadName } from '@/components/leads/columns';
import '@/components/leads/leads.css';
import { Button, EmptyState } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { formatCount } from '@/lib/crm/format';
import type { DealFilters, DealListQuery, Pipeline } from '@/lib/crm/types';
import { useDealList, useDealOwners, usePipelines, useProductLines, useSavedViewMutations, useSavedViews, useVocabularies } from '@/lib/deals/hooks';
import {
  BUILT_IN_VIEWS,
  DEFAULT_VIEW_ID,
  cleanFilters,
  filterCount,
  sameState,
  savedViewState,
  sortFromState,
  sortState,
  visibleColumns,
  type LeadsState,
} from '@/lib/deals/views';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 50;

function initialState(): LeadsState {
  return (
    (BUILT_IN_VIEWS.find((view) => view.id === DEFAULT_VIEW_ID) ?? BUILT_IN_VIEWS[0])?.state() ?? { filters: {}, sort: '-updatedAt', columns: [] }
  );
}

/**
 * The unified Leads list (/leads): every enquiry in the working scope, filtered and sorted on the
 * server, with saved views, bulk actions and a side preview. "New" marks open leads from the last
 * 7 days that their owner hasn't opened yet; opening one in the preview clears it.
 */
export function LeadsView() {
  const session = useSession();
  const scope = session.scope;
  const canView = session.canAnywhere('deals.view');
  const canCreate = session.canAnywhere('deals.manage');

  const [viewId, setViewId] = useState(DEFAULT_VIEW_ID);
  const [state, setState] = useState<LeadsState>(initialState);
  const [base, setBase] = useState<LeadsState>(state);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [allMatchingKey, setAllMatchingKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  // A different working scope starts from the default view.
  const [scopeId, setScopeId] = useState(scope.id);
  if (scopeId !== scope.id) {
    const fresh = initialState();
    setScopeId(scope.id);
    setViewId(DEFAULT_VIEW_ID);
    setState(fresh);
    setBase(fresh);
    setPreviewId(null);
    setOutcome(null);
  }

  const query: Omit<DealListQuery, 'cursor'> = { unitId: scope.id, ...cleanFilters(state.filters), sort: state.sort, limit: PAGE_SIZE };
  const queryKey = JSON.stringify(query);
  const leads = useDealList(query, canView);
  const table = infiniteRows(leads);
  const rows = table.rows;
  const selection = useRowSelection(queryKey);
  const allMatching = allMatchingKey === queryKey && selection.count > 0 && selection.count === rows.length;

  const pipelinesQuery = usePipelines(scope.id);
  const pipelines: Pipeline[] = pipelinesQuery.data ?? [];
  const pipelinesById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const vocabularies = useVocabularies();
  const productLines = useProductLines({ unitId: scope.id }, canView);
  const owners = useDealOwners(scope.id, canView);
  const savedViews = useSavedViews(scope.id);
  const viewMutations = useSavedViewMutations(scope.id);

  const visible = visibleColumns(state.columns);
  const columns = leadColumns(visible, pipelinesById);

  const menuViews: MenuView[] = [
    ...BUILT_IN_VIEWS.map((view) => ({ id: view.id, name: view.name, shared: false, builtIn: true })),
    ...(savedViews.data ?? []).map((view) => ({ id: view.id, name: view.name, shared: view.visibility === 'shared', canEdit: view.can.edit })),
  ];
  const currentSaved = savedViews.data?.find((view) => view.id === viewId) ?? null;
  const modified = !sameState(state, base);

  const update = (next: Partial<LeadsState>) => {
    setState((current) => ({ ...current, ...next }));
    setOutcome(null);
  };
  const setFilters = (filters: DealFilters) => update({ filters });

  function selectView(view: MenuView) {
    const builtIn = BUILT_IN_VIEWS.find((item) => item.id === view.id);
    const saved = savedViews.data?.find((item) => item.id === view.id);
    const next = builtIn ? builtIn.state() : saved ? savedViewState(saved) : null;
    if (!next) return;
    setViewId(view.id);
    setState(next);
    setBase(next);
    setOutcome(null);
    setViewError(null);
  }

  async function saveCurrentView() {
    if (!currentSaved) return;
    setViewError(null);
    try {
      await viewMutations.update.mutateAsync({ id: currentSaved.id, filters: cleanFilters(state.filters), sort: state.sort, columns: visible });
      setBase(state);
    } catch (error) {
      setViewError(errorMessage(error));
    }
  }

  const previewIndex = rows.findIndex((row) => row.id === previewId);
  const previewRow = previewIndex >= 0 ? (rows[previewIndex] ?? null) : null;
  const filtered = filterCount(state.filters) > 0;

  const target: BulkTarget = allMatching
    ? { kind: 'filter', filter: { unitId: scope.id, ...cleanFilters(state.filters) } }
    : { kind: 'ids', ids: [...selection.selected] };

  if (!canView) {
    return (
      <EmptyState icon="lock" title="Leads aren't part of your work here">
        Pick another team in &quot;Working in&quot;, or ask an admin for access to leads.
      </EmptyState>
    );
  }

  const description =
    BUILT_IN_VIEWS.find((view) => view.id === viewId)?.description ??
    (currentSaved ? `${currentSaved.visibility === 'shared' ? 'Shared' : 'Your'} view by ${currentSaved.owner.name}` : '');

  return (
    <div className="leads">
      <div className="leads__head">
        <p className="leads__summary">
          <span className="strong">{menuViews.find((view) => view.id === viewId)?.name ?? 'Leads'}</span>
          {description ? <span className="muted"> · {description}</span> : null}
        </p>
        {canCreate ? (
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New lead
          </Button>
        ) : null}
      </div>

      {outcome ? <BulkResultAlert outcome={outcome} onDismiss={() => setOutcome(null)} /> : null}
      {viewError ? <p className="field__error">{viewError}</p> : null}

      {selection.count > 0 && selection.count === rows.length && table.hasMore ? (
        <p className="leads__select-all" role="status">
          {allMatching ? (
            <>
              Every lead matching these filters is selected (up to 1,000).{' '}
              <button type="button" className="link-button" onClick={() => setAllMatchingKey(null)}>
                Select only the {formatCount(rows.length)} shown
              </button>
            </>
          ) : (
            <>
              The {formatCount(rows.length)} leads shown are selected.{' '}
              <button type="button" className="link-button" onClick={() => setAllMatchingKey(queryKey)}>
                Select every lead matching these filters
              </button>
            </>
          )}
        </p>
      ) : null}

      <DataTable
        {...table}
        label="Leads"
        columns={columns}
        rowId={(row) => row.id}
        rowLabel={(row) => leadName(row)}
        sort={sortState(state.sort)}
        onSortChange={(next) => update({ sort: sortFromState(next) })}
        selection={selection}
        onRowActivate={(row) => setPreviewId(row.id)}
        activeRowId={previewId}
        rowClassName={(row) => (row.isNew ? 'leads-row--new' : undefined)}
        empty={
          filtered ? (
            <EmptyState icon="search" title="No leads match these filters" action={<Button onClick={() => setFilters({})}>Clear filters</Button>}>
              Try another channel, owner or search term.
            </EmptyState>
          ) : (
            <EmptyState
              icon="inbox"
              title="No leads here yet"
              action={
                canCreate ? (
                  <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                    New lead
                  </Button>
                ) : undefined
              }
            >
              Enquiries from WhatsApp, forms, calls and ads appear here as they arrive.
            </EmptyState>
          )
        }
        footer={
          rows.length > 0
            ? `Showing ${formatCount(rows.length)} ${rows.length === 1 ? 'lead' : 'leads'}${table.hasMore ? ' (more below)' : ''}`
            : undefined
        }
        toolbar={
          <LeadFilters
            filters={state.filters}
            onChange={setFilters}
            channels={vocabularies.data?.channels}
            pipelines={pipelines}
            productLines={(productLines.data ?? []).filter((line) => line.active)}
            owners={owners.data ?? []}
            end={
              <span className="leads__views">
                {modified && currentSaved?.can.edit ? (
                  <Button size="sm" variant="ghost" icon="check" loading={viewMutations.update.isPending} onClick={() => void saveCurrentView()}>
                    Save changes
                  </Button>
                ) : null}
                <ColumnsMenu visible={visible} onChange={(next) => update({ columns: next })} />
                <SavedViewsMenu
                  views={menuViews}
                  currentId={viewId}
                  modified={modified}
                  canShare={session.can('deals.share_views')}
                  onSelect={selectView}
                  onSave={async ({ name, shared }) => {
                    const view = await viewMutations.create.mutateAsync({
                      unitId: scope.id,
                      name,
                      visibility: shared ? 'shared' : 'personal',
                      filters: cleanFilters(state.filters),
                      sort: state.sort,
                      columns: visible,
                    });
                    setViewId(view.id);
                    setBase(state);
                  }}
                  onRename={(view, name) => viewMutations.update.mutateAsync({ id: view.id, name })}
                  onDelete={async (view) => {
                    await viewMutations.remove.mutateAsync(view.id);
                    if (view.id === viewId) {
                      const fresh = initialState();
                      setViewId(DEFAULT_VIEW_ID);
                      setState(fresh);
                      setBase(fresh);
                    }
                  }}
                />
              </span>
            }
          />
        }
      />

      <LeadBulkActions
        target={target}
        rows={rows}
        pipelines={pipelines}
        owners={owners.data ?? []}
        onClear={() => {
          selection.clear();
          setAllMatchingKey(null);
        }}
        onDone={setOutcome}
      />

      <LeadPreview
        id={previewId}
        fallback={previewRow}
        pipelines={pipelinesById}
        onClose={() => setPreviewId(null)}
        onPrevious={previewIndex > 0 ? () => setPreviewId(rows[previewIndex - 1]?.id ?? null) : undefined}
        onNext={previewIndex >= 0 && previewIndex < rows.length - 1 ? () => setPreviewId(rows[previewIndex + 1]?.id ?? null) : undefined}
      />

      <NewLeadDialog
        open={creating}
        onClose={() => setCreating(false)}
        pipelines={pipelines}
        channels={vocabularies.data?.channels}
        onCreated={(deal) => {
          setCreating(false);
          setPreviewId(deal.id);
        }}
        onOpenExisting={(id) => {
          setCreating(false);
          setPreviewId(id);
        }}
      />
    </div>
  );
}
