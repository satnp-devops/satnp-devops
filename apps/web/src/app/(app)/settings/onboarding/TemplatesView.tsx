'use client';

import { useState } from 'react';
import { StatusPill } from '@/components/crm';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Guard } from '@/components/Guard';
import { Button, Card, EmptyState, ErrorAlert, Field, Spinner } from '@/components/ui';
import '@/components/delivery/delivery.css';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import { useProgrammes, useSaveTemplate, useTemplates } from '@/lib/delivery/queries';
import type { OnboardingTemplate, OwnerRole, TemplateItem, TemplatePhase } from '@/lib/delivery/types';
import { useSession } from '@/lib/session';
import { trailOf } from '@/lib/tree';

export function TemplatesView() {
  return (
    <Guard anyOf={['onboarding.view']} anywhere>
      <Templates />
    </Guard>
  );
}

const OWNER_ROLES: Record<OwnerRole, string> = { record_owner: 'Enrollment owner', batch_teacher: 'Batch teacher', unassigned: 'Nobody yet' };
const DEFAULT_PHASES: TemplatePhase[] = [
  { key: 'kickoff', name: 'Kickoff', offsetDays: 0 },
  { key: 'data_import', name: 'Data import', offsetDays: 7 },
  { key: 'training', name: 'Training', offsetDays: 14 },
  { key: 'go_live', name: 'Go-live', offsetDays: 28 },
];

function Templates() {
  const session = useSession();
  const templates = useTemplates({ unitId: session.scope.id });
  const [editing, setEditing] = useState<{ template: OnboardingTemplate | null; companyId: string; kind: 'b2c' | 'b2b' } | null>(null);
  const scopeCompany = trailOf(session.scope, session.unitsById).find((u) => u.type === 'company');
  const companies = scopeCompany ? [scopeCompany] : session.units.filter((u) => u.type === 'company' && u.path.startsWith(session.scope.path));
  const configurable = companies.filter((c) => session.can('onboarding.configure', c));
  const byCompany = new Map<string, OnboardingTemplate[]>();
  for (const t of templates.data ?? []) byCompany.set(t.companyId, [...(byCompany.get(t.companyId) ?? []), t]);

  if (templates.isPending) return <Spinner label="Loading templates" />;
  if (templates.isError) return <ErrorAlert error={templates.error} />;

  return (
    <div className="stack gap-16">
      <p className="muted">
        New enrollments get the student checklist of their programme (or of the company); signed institutes get the implementation plan. Changes apply to new ones only.
      </p>
      {companies.map((company) => {
        const list = byCompany.get(company.id) ?? [];
        const canEdit = configurable.some((c) => c.id === company.id);
        return (
          <Card
            key={company.id}
            title={company.name}
            actions={
              canEdit ? (
                <div className="row gap-8">
                  <Button size="sm" icon="plus" onClick={() => setEditing({ template: null, companyId: company.id, kind: 'b2c' })}>
                    Student checklist
                  </Button>
                  <Button size="sm" icon="plus" onClick={() => setEditing({ template: null, companyId: company.id, kind: 'b2b' })}>
                    Implementation plan
                  </Button>
                </div>
              ) : null
            }
          >
            {list.length === 0 ? (
              <EmptyState icon="flag" title="No templates yet">
                Without one, enrollments start with no checklist and projects get the four standard phases with no tasks.
              </EmptyState>
            ) : (
              <div className="stack gap-12">
                {list.map((t) => (
                  <div key={t.id} className="delivery-panel__row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <div className="stack gap-6" style={{ flex: '1 1 260px' }}>
                      <div className="row gap-6">
                        <strong>{t.name}</strong>
                        <StatusPill tone={t.kind === 'b2c' ? 'accent' : 'neutral'}>{t.kind === 'b2c' ? 'Student checklist' : 'Implementation plan'}</StatusPill>
                        {!t.active ? <StatusPill tone="warning">Off</StatusPill> : null}
                      </div>
                      <span className="muted small">
                        For {t.product?.name ?? t.productLine?.name ?? 'every programme of the company'} · {t.items.length} {t.items.length === 1 ? 'step' : 'steps'}
                        {t.kind === 'b2b' ? ` in ${t.phases.length} phases` : ''}
                      </span>
                      <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {t.items.slice(0, 6).map((item, i) => (
                          <li key={item.id ?? i}>
                            {item.title} <span className="muted">· day {item.dueOffsetDays}</span>
                          </li>
                        ))}
                        {t.items.length > 6 ? <li className="muted">and {t.items.length - 6} more</li> : null}
                      </ol>
                    </div>
                    {canEdit ? (
                      <Button size="sm" icon="edit" onClick={() => setEditing({ template: t, companyId: t.companyId, kind: t.kind })}>
                        Edit
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
      {editing ? <TemplateDialog {...editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function TemplateDialog({ template, companyId, kind, onClose }: { template: OnboardingTemplate | null; companyId: string; kind: 'b2c' | 'b2b'; onClose: () => void }) {
  const session = useSession();
  const save = useSaveTemplate();
  const programmes = useProgrammes(session.scope.id, kind === 'b2c');
  const [name, setName] = useState(template?.name ?? (kind === 'b2c' ? 'New student onboarding' : 'Institute implementation'));
  const [productId, setProductId] = useState(template?.product?.id ?? '');
  const [active, setActive] = useState(template?.active ?? true);
  const [phases, setPhases] = useState<TemplatePhase[]>(template?.phases.length ? template.phases : DEFAULT_PHASES);
  const [items, setItems] = useState<TemplateItem[]>(template?.items ?? [{ phaseKey: kind === 'b2b' ? 'kickoff' : null, title: '', description: null, ownerRole: 'record_owner', dueOffsetDays: 0 }]);
  const errors = fieldErrorsOf(save.error);
  const setItem = (index: number, patch: Partial<TemplateItem>) => setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  return (
    <Dialog open onClose={onClose} size="lg" title={template ? `Edit ${template.name}` : kind === 'b2c' ? 'New student checklist' : 'New implementation plan'}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = {
            name: name.trim(),
            productId: productId || null,
            active,
            ...(kind === 'b2b' ? { phases } : {}),
            items: items
              .filter((item) => item.title.trim())
              .map((item) => ({ title: item.title.trim(), description: item.description, ownerRole: item.ownerRole, dueOffsetDays: item.dueOffsetDays, ...(kind === 'b2b' ? { phaseKey: item.phaseKey } : {}) })),
          };
          save.mutate({ id: template?.id ?? null, input: template ? input : { ...input, companyId, kind } }, { onSuccess: onClose });
        }}
      >
        <DialogBody>
          <div className="stack gap-12">
            {formErrorOf(save.error, ['name', 'productId']) ? <ErrorAlert error={save.error} /> : null}
            <div className="form-grid">
              <Field label="Name" error={errors.name}>
                {(control) => <input {...control} className="input" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />}
              </Field>
              {kind === 'b2c' ? (
                <Field label="For" error={errors.productId}>
                  {(control) => (
                    <select {...control} className="select" value={productId} onChange={(event) => setProductId(event.target.value)}>
                      <option value="">Every programme</option>
                      {(programmes.data ?? [])
                        .filter((p) => p.companyId === companyId)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  )}
                </Field>
              ) : null}
            </div>
            {kind === 'b2b' ? (
              <fieldset className="stack gap-8" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small muted">Phases (days from kickoff)</legend>
                <div className="form-grid">
                  {phases.map((phase, index) => (
                    <div key={phase.key} className="row gap-6 nowrap">
                      <input
                        className="input"
                        aria-label={`Phase ${index + 1} name`}
                        value={phase.name}
                        maxLength={80}
                        onChange={(event) => setPhases(phases.map((p, i) => (i === index ? { ...p, name: event.target.value } : p)))}
                      />
                      <input
                        className="input input--narrow"
                        aria-label={`${phase.name} starts on day`}
                        type="number"
                        min={0}
                        value={phase.offsetDays}
                        onChange={(event) => setPhases(phases.map((p, i) => (i === index ? { ...p, offsetDays: Number(event.target.value) } : p)))}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <fieldset className="stack gap-0" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small muted">Steps</legend>
              {items.map((item, index) => (
                <div key={index} className="delivery-template-item">
                  <Field label={`Step ${index + 1}`} error={errors[`items.${index}.title`] ?? errors[`items.${index}.phaseKey`]}>
                    {(control) => <input {...control} className="input" maxLength={200} value={item.title} onChange={(event) => setItem(index, { title: event.target.value })} placeholder="Welcome call with the parent" />}
                  </Field>
                  {kind === 'b2b' ? (
                    <Field label="Phase">
                      {(control) => (
                        <select {...control} className="select" value={item.phaseKey ?? ''} onChange={(event) => setItem(index, { phaseKey: event.target.value })}>
                          {phases.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  ) : (
                    <Field label="Who">
                      {(control) => (
                        <select {...control} className="select" value={item.ownerRole} onChange={(event) => setItem(index, { ownerRole: event.target.value as OwnerRole })}>
                          {(Object.keys(OWNER_ROLES) as OwnerRole[]).map((r) => (
                            <option key={r} value={r}>
                              {OWNER_ROLES[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  )}
                  <Field label="Day">
                    {(control) => <input {...control} className="input" type="number" min={0} max={730} value={item.dueOffsetDays} onChange={(event) => setItem(index, { dueOffsetDays: Number(event.target.value) })} />}
                  </Field>
                  <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label={`Remove step ${index + 1}`} onClick={() => setItems(items.filter((_, i) => i !== index))} />
                </div>
              ))}
              <div>
                <Button size="sm" icon="plus" onClick={() => setItems([...items, { phaseKey: kind === 'b2b' ? (phases[0]?.key ?? null) : null, title: '', description: null, ownerRole: 'record_owner', dueOffsetDays: 0 }])}>
                  Add a step
                </Button>
              </div>
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
              In use
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
