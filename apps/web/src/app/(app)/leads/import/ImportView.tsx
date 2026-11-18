'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DataTable, DateTime, Mono, RelativeTime, StatusPill, type Column, type PillTone } from '@/components/crm';
import { Alert, Button, Card, EmptyState, ErrorAlert, Field, PageLoading } from '@/components/ui';
import { Guard } from '@/components/Guard';
import { Icon } from '@/components/icons';
import { api, errorMessage, fieldErrorsOf } from '@/lib/api';
import { crmKeys } from '@/lib/crm/keys';
import { useSession } from '@/lib/session';
import { companyOfUnit, intakeKeys, uploadCsv, useImportFields, useImportJob, useImportRows, useImports } from '@/lib/intake/api';
import type { Audience, ImportJob, ImportRow, ImportRowStatus, ImportStatus } from '@/lib/intake/types';
import '@/components/intake/intake.css';

const STATUS: Record<ImportStatus, { label: string; tone: PillTone }> = {
  uploaded: { label: 'Waiting for mapping', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'accent' },
  running: { label: 'Importing', tone: 'accent' },
  completed: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const ROW_STATUS: Record<ImportRowStatus, { label: string; tone: PillTone }> = {
  created: { label: 'New lead', tone: 'success' },
  merged: { label: 'Added to existing', tone: 'accent' },
  reopened: { label: 'Reopened', tone: 'accent' },
  review: { label: 'In review', tone: 'warning' },
  error: { label: 'Not imported', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export function ImportView() {
  return (
    <Guard anyOf={['intake.import']} anywhere>
      <Imports />
    </Guard>
  );
}

function Imports() {
  const { scope, unitsById, can } = useSession();
  const [jobId, setJobId] = useState<string | null>(null);
  const company = companyOfUnit(scope, unitsById);
  const history = useImports(scope.id);

  if (jobId) return <ImportJobView jobId={jobId} onDone={() => setJobId(null)} />;

  return (
    <div className="stack gap-16">
      {!company ? (
        <Alert tone="info">Leads belong to a company. Pick a company, branch or team in &ldquo;Working in&rdquo; to import into it.</Alert>
      ) : !can('intake.import', scope) ? (
        <Alert tone="info">You can't import into {scope.name}. Pick a team where you import leads.</Alert>
      ) : (
        <Upload unitId={scope.id} unitName={scope.name} onUploaded={(job) => setJobId(job.id)} />
      )}
      <Card flush title="Recent imports">
        {history.isPending ? (
          <PageLoading />
        ) : history.isError ? (
          <ErrorAlert error={history.error} />
        ) : history.data.data.length === 0 ? (
          <EmptyState icon="upload" title="No imports yet">
            Upload a CSV file exported from a spreadsheet, a fair&apos;s sign-up sheet or another CRM.
          </EmptyState>
        ) : (
          <DataTable<ImportJob>
            label="Recent imports"
            framed={false}
            rows={history.data.data}
            rowId={(j) => j.id}
            onRowActivate={(j) => setJobId(j.id)}
            columns={[
              { id: 'file', header: 'File', card: 'title', cell: (j) => <span className="strong">{j.fileName}</span> },
              { id: 'status', header: 'Status', cell: (j) => <StatusPill tone={STATUS[j.status].tone}>{STATUS[j.status].label}</StatusPill> },
              { id: 'rows', header: 'Rows', align: 'end', cell: (j) => j.totalRows },
              { id: 'created', header: 'New leads', align: 'end', hideBelow: 'md', cell: (j) => j.counts.created },
              { id: 'errors', header: 'Problems', align: 'end', hideBelow: 'md', cell: (j) => j.counts.error },
              { id: 'when', header: 'Uploaded', cell: (j) => <RelativeTime value={j.createdAt} /> },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function Upload({ unitId, unitName, onUploaded }: { unitId: string; unitName: string; onUploaded: (job: ImportJob) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const queryClient = useQueryClient();
  const upload = useMutation({
    mutationFn: (file: File) => uploadCsv(unitId, file),
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({ queryKey: intakeKeys.imports(unitId) });
      onUploaded(job);
    },
  });
  const pick = (file: File | undefined) => {
    if (file) upload.mutate(file);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files[0]);
  };

  return (
    <Card title="Import leads from a CSV file" description={`Rows become leads in ${unitName}, with the same de-duplication, routing and assignment as live enquiries.`}>
      <div
        className={`intake-drop${over ? ' is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Icon name="upload" size={28} />
        <p className="strong">Drop a .csv file here</p>
        <p className="muted">Up to 5 MB and 20,000 rows. The first row must be the column names.</p>
        <input ref={input} type="file" accept=".csv,text/csv,.txt" hidden onChange={(e) => pick(e.target.files?.[0])} aria-label="CSV file" />
        <Button variant="primary" icon="upload" loading={upload.isPending} onClick={() => input.current?.click()}>
          Choose a file
        </Button>
      </div>
      {upload.isError ? <Alert tone="error">{fieldErrorsOf(upload.error).content ?? errorMessage(upload.error)}</Alert> : null}
    </Card>
  );
}

function ImportJobView({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const job = useImportJob(jobId);
  if (job.isPending) return <PageLoading />;
  if (job.isError) return <ErrorAlert error={job.error} />;
  const data = job.data;
  return (
    <div className="stack gap-16">
      <div className="intake-toolbar">
        <div className="stack gap-4">
          <span className="strong">{data.fileName}</span>
          <span className="muted">
            {data.totalRows} rows · uploaded <DateTime value={data.createdAt} />
          </span>
        </div>
        <div className="row gap-8">
          <StatusPill tone={STATUS[data.status].tone}>{STATUS[data.status].label}</StatusPill>
          <Button variant="ghost" onClick={onDone}>
            Back to imports
          </Button>
        </div>
      </div>
      <ol className="intake-steps" aria-label="Steps">
        <li>1. Upload</li>
        <li aria-current={data.status === 'uploaded' ? 'step' : undefined}>2. Match columns</li>
        <li aria-current={data.status !== 'uploaded' ? 'step' : undefined}>3. Results</li>
      </ol>
      {data.status === 'uploaded' ? <Mapping job={data} /> : <Results job={data} />}
    </div>
  );
}

function Mapping({ job }: { job: ImportJob }) {
  const { unitsById } = useSession();
  const fields = useImportFields();
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(job.suggestions.map((s) => [String(s.index), s.field ?? ''])));
  const [audience, setAudience] = useState<Audience>('b2c');
  const [campaign, setCampaign] = useState('');
  const [dateOrder, setDateOrder] = useState<'DMY' | 'MDY'>('DMY');
  const start = useMutation({
    mutationFn: () => api.post<ImportJob>(`/intake/imports/${job.id}/start`, { mapping, defaults: { audience, dateOrder, ...(campaign.trim() ? { campaign: campaign.trim() } : {}) } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(intakeKeys.importJob(job.id), updated);
      await queryClient.invalidateQueries({ queryKey: intakeKeys.imports(job.unitId) });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.post<ImportJob>(`/intake/imports/${job.id}/cancel`),
    onSuccess: (updated) => queryClient.setQueryData(intakeKeys.importJob(job.id), updated),
  });
  const used = new Set(Object.values(mapping).filter(Boolean));
  const hasContact = ['contact.phone', 'contact.altPhone', 'contact.email'].some((f) => used.has(f));
  const errors = fieldErrorsOf(start.error);
  const company = unitsById.get(job.companyId);

  return (
    <Card title="Match the columns" description={`Tell us what each column holds. Columns set to “Don't import” are kept only in the row's history. Leads go to ${company?.name ?? 'the company'}.`}>
      <div className="stack gap-16">
        <div className="table-wrap">
          <table className="intake-mapping">
            <thead>
              <tr>
                <th scope="col">Column in the file</th>
                <th scope="col">First values</th>
                <th scope="col">Goes to</th>
              </tr>
            </thead>
            <tbody>
              {job.headers.map((header, index) => {
                const key = String(index);
                const suggestion = job.suggestions.find((s) => s.index === index);
                return (
                  <tr key={key}>
                    <td className="strong">{header}</td>
                    <td className="intake-sample">
                      {job.sample
                        .map((r) => r[index])
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(' · ') || '—'}
                    </td>
                    <td>
                      <select
                        className="select"
                        aria-label={`What ${header} holds`}
                        aria-invalid={errors[`mapping.${key}`] ? true : undefined}
                        value={mapping[key] ?? ''}
                        onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                      >
                        <option value="">Don&apos;t import</option>
                        {(fields.data ?? []).map((f) => (
                          <option key={f.field} value={f.field} disabled={used.has(f.field) && mapping[key] !== f.field}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      {errors[`mapping.${key}`] ? <p className="field__error">{errors[`mapping.${key}`]}</p> : suggestion?.field && suggestion.confidence < 0.85 ? <p className="field__hint">Best guess; check it</p> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="intake-grid-2">
          <Field label="Leads are">
            {(control) => (
              <select {...control} className="select" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
                <option value="b2c">Families and students</option>
                <option value="b2b">Institutes</option>
              </select>
            )}
          </Field>
          <Field label="Dates are written" hint="As in 05/11/2026">
            {(control) => (
              <select {...control} className="select" value={dateOrder} onChange={(e) => setDateOrder(e.target.value as 'DMY' | 'MDY')}>
                <option value="DMY">Day / month / year</option>
                <option value="MDY">Month / day / year</option>
              </select>
            )}
          </Field>
          <Field label="Campaign" optional hint="Recorded as the source of every lead in this file">
            {(control) => <input {...control} className="input" value={campaign} maxLength={200} onChange={(e) => setCampaign(e.target.value)} />}
          </Field>
        </div>
        {!hasContact ? <Alert tone="warning">Match a column to Phone or Email: rows without one can&apos;t become leads.</Alert> : null}
        {start.isError && !Object.keys(errors).length ? <Alert tone="error">{errorMessage(start.error)}</Alert> : null}
        <div className="row gap-8">
          <Button variant="primary" loading={start.isPending} disabled={!hasContact} onClick={() => start.mutate()}>
            Import {job.totalRows} rows
          </Button>
          <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Results({ job }: { job: ImportJob }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ImportRowStatus | ''>('');
  const finished = job.status === 'completed';
  const rows = useImportRows(job.id, status, finished);
  const list = rows.data?.pages.flatMap((p) => p.data) ?? [];
  const done = Math.min(job.processedRows, job.totalRows);
  // New and reopened leads show up in the Leads list.
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: crmKeys.deals.all });
  }, [finished, queryClient]);

  const stats: Array<{ label: string; value: number; status: ImportRowStatus }> = [
    { label: 'New leads', value: job.counts.created, status: 'created' },
    { label: 'Added to existing', value: job.counts.merged, status: 'merged' },
    { label: 'Reopened', value: job.counts.reopened, status: 'reopened' },
    { label: 'In review', value: job.counts.review, status: 'review' },
    { label: 'Not imported', value: job.counts.error, status: 'error' },
  ];
  const columns: Column<ImportRow>[] = [
    { id: 'row', header: 'Row', width: 70, cell: (r) => <Mono>{String(r.row)}</Mono> },
    { id: 'status', header: 'Result', card: 'title', cell: (r) => <StatusPill tone={ROW_STATUS[r.status].tone}>{ROW_STATUS[r.status].label}</StatusPill> },
    { id: 'lead', header: 'Lead', cell: (r) => (r.dealRef ? <Mono>{r.dealRef}</Mono> : '—') },
    { id: 'issues', header: 'Notes', cell: (r) => (r.issues.length ? r.issues.map((i) => i.message).join('; ') : '—') },
  ];

  return (
    <div className="stack gap-16">
      {job.status === 'failed' ? <Alert tone="error" title="The import failed">{job.failure}</Alert> : null}
      {job.status === 'cancelled' ? <Alert tone="info">This import was cancelled before it started.</Alert> : null}
      {job.status === 'queued' || job.status === 'running' ? (
        <Card title="Importing" description="You can leave this page; the import carries on in the background.">
          <div className="intake-progress" role="progressbar" aria-valuemin={0} aria-valuemax={job.totalRows} aria-valuenow={done} aria-label="Rows imported">
            <span style={{ width: `${job.totalRows ? Math.round((done / job.totalRows) * 100) : 0}%` }} />
          </div>
          <p className="muted">
            {done} of {job.totalRows} rows
          </p>
        </Card>
      ) : null}
      {finished ? (
        <>
          <div className="intake-stats">
            {stats.map((s) => (
              <button key={s.status} type="button" className="intake-stat" aria-pressed={status === s.status} onClick={() => setStatus(status === s.status ? '' : s.status)} style={{ textAlign: 'left', cursor: 'pointer' }}>
                <div className="intake-stat__value">{s.value}</div>
                <div className="intake-stat__label">{s.label}</div>
              </button>
            ))}
          </div>
          {job.hasErrorReport ? (
            <div className="row">
              <a className="btn" href={`/api/v1/intake/imports/${job.id}/error-report`} download>
                <Icon name="download" size={16} /> Download the problem report (CSV)
              </a>
            </div>
          ) : null}
          <DataTable<ImportRow>
            label="Rows"
            rows={list}
            rowId={(r) => String(r.row)}
            columns={columns}
            loading={rows.isPending}
            error={rows.error}
            onRetry={() => void rows.refetch()}
            hasMore={rows.hasNextPage}
            onLoadMore={() => void rows.fetchNextPage()}
            loadingMore={rows.isFetchingNextPage}
            empty={status ? 'No rows with this result.' : 'No rows.'}
          />
        </>
      ) : null}
    </div>
  );
}
