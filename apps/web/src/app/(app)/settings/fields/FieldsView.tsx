'use client';

import { useState } from 'react';
import { ConfigShell } from '@/components/config/ConfigShell';
import { OrderButtons, Segmented, Switch } from '@/components/config/controls';
import { Badge, Button, Card, EmptyState, ErrorAlert, Spinner, cx } from '@/components/ui';
import { api } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { FIELD_TYPE_LABELS, KIND_SHORT, isChoiceType, moveItem } from '@/lib/config/format';
import { useConfigMutation, useCustomFields } from '@/lib/config/queries';
import type { CustomFieldDefinition, CustomFieldEntity, CustomFieldOrderInput, CustomFieldPatchInput } from '@/lib/crm/types';
import { ENTITIES, ENTITY_HINTS, ENTITY_PLURAL, ENTITY_SINGULAR } from './entities';
import { FieldDialog } from './FieldDialog';
import { FieldPreview } from './FieldPreview';
import './fields.css';

export function FieldsView() {
  return (
    <ConfigShell
      view="fields.view"
      manage="fields.manage"
      intro="Extra fields each company keeps on deals, contacts and institutes. Forms show them in this order; no deploy needed."
    >
      {(company) => <Fields company={company} />}
    </ConfigShell>
  );
}

function Fields({ company }: { company: ConfigCompany }) {
  const [entity, setEntity] = useState<CustomFieldEntity>('deal');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDefinition | 'new' | null>(null);
  const fields = useCustomFields(company.unit.id, entity);

  const update = useConfigMutation(({ id, body }: { id: string; body: CustomFieldPatchInput }) =>
    api.patch<CustomFieldDefinition>(`/custom-fields/${id}`, body),
  );
  const reorder = useConfigMutation((ordered: CustomFieldDefinition[]) => {
    const body: CustomFieldOrderInput = { companyId: company.unit.id, entity, ids: ordered.map((field) => field.id) };
    return api.put<CustomFieldDefinition[]>('/custom-fields/order', body);
  });

  const all = fields.data ?? [];
  const active = all.filter((field) => field.active);
  const list = showInactive ? all : active;
  const inactiveCount = all.length - active.length;
  const mutationError = update.error ?? reorder.error;

  const changeEntity = (next: CustomFieldEntity) => {
    setEntity(next);
    setShowInactive(false);
    update.reset();
    reorder.reset();
  };

  return (
    <div className="stack gap-16">
      <div className="row gap-12 fields-bar">
        <Segmented
          label="Record type"
          options={ENTITIES.map((value) => ({ value, label: ENTITY_PLURAL[value] }))}
          value={entity}
          onChange={changeEntity}
        />
        <span className="spacer" />
        {inactiveCount ? <Switch label={`Show ${inactiveCount} inactive`} checked={showInactive} onChange={setShowInactive} /> : null}
        {company.canManage ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Add field
          </Button>
        ) : null}
      </div>

      <div className="fields-layout">
        <Card flush title={`${ENTITY_PLURAL[entity]} fields`} description={ENTITY_HINTS[entity]}>
          {fields.isPending ? (
            <div className="empty">
              <Spinner />
            </div>
          ) : fields.isError ? (
            <div className="card__body">
              <ErrorAlert error={fields.error} />
            </div>
          ) : list.length === 0 ? (
            <EmptyState icon="list" title={`No ${ENTITY_SINGULAR[entity]} fields yet`}>
              {company.canManage
                ? entity === 'deal'
                  ? 'Add what your team asks on calls, like “Target exam date” or “Number of branches”.'
                  : `Add what ${company.unit.name} keeps about each ${ENTITY_SINGULAR[entity]}.`
                : 'An admin has not added any here yet.'}
            </EmptyState>
          ) : (
            <>
              {mutationError ? (
                <div className="card__body">
                  <ErrorAlert error={mutationError} />
                </div>
              ) : null}
              <ul className="config-list" aria-label={`${ENTITY_PLURAL[entity]} fields`}>
                {list.map((field, index) => (
                  <li key={field.id} className={cx('config-row', !field.active && 'config-row--inactive')}>
                    {company.canManage ? (
                      <OrderButtons
                        label={field.label}
                        index={index}
                        count={list.length}
                        disabled={reorder.isPending}
                        onMove={(delta) => reorder.mutate(moveItem(list, index, delta))}
                      />
                    ) : null}
                    <div className="config-row__main">
                      <span className="config-row__title">
                        {field.label}
                        <span className="config-key">{field.key}</span>
                        {field.required ? <Badge tone="accent">Required</Badge> : null}
                        {field.appliesTo ? <Badge>{KIND_SHORT[field.appliesTo]} only</Badge> : null}
                        {field.active ? null : <Badge tone="warning">Inactive</Badge>}
                      </span>
                      <span className="config-row__meta">
                        {FIELD_TYPE_LABELS[field.type]}
                        {isChoiceType(field.type) ? ` · ${field.options.map((option) => option.label).join(', ')}` : ''}
                        {field.help ? ` · ${field.help}` : ''}
                      </span>
                    </div>
                    <div className="config-row__actions">
                      <Switch
                        label={field.active ? 'Active' : 'Inactive'}
                        accessibleLabel={`Active: ${field.label}`}
                        checked={field.active}
                        disabled={!company.canManage || update.isPending}
                        onChange={(on) => update.mutate({ id: field.id, body: { active: on } })}
                      />
                      {company.canManage ? (
                        <Button size="sm" variant="ghost" iconOnly icon="edit" aria-label={`Edit ${field.label}`} onClick={() => setEditing(field)} />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <FormPreview entity={entity} fields={active} loading={fields.isPending} />
      </div>

      <FieldDialog company={company} entity={entity} field={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/** The active fields as a form shows them: try them out (nothing is saved). */
function FormPreview({ entity, fields, loading }: { entity: CustomFieldEntity; fields: readonly CustomFieldDefinition[]; loading: boolean }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return (
    <Card title="Form preview" description={`How the fields appear on a ${ENTITY_SINGULAR[entity]} form. Nothing here is saved.`} className="fields-preview">
      {loading ? null : fields.length === 0 ? (
        <p className="small muted">Active fields show up here.</p>
      ) : (
        <div className="stack gap-12">
          {fields.map((field) => (
            <FieldPreview
              key={field.id}
              definition={field}
              value={values[field.id] ?? null}
              onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
