'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { api, fieldErrorsOf, formErrorOf } from '@/lib/api';
import { automationKeys } from '@/lib/automations/queries';
import type { AutomationFlow, AutomationTemplate, FlowDefinition } from '@/lib/automations/types';
import type { OrgUnit } from '@/lib/types';

const BLANK: FlowDefinition = {
  trigger: { type: 'enquiry.new' },
  start: 'first_step',
  steps: [
    { id: 'first_step', type: 'action', action: 'tasks.create', params: { title: 'Call {{ record.name }}', dueIn: '2h', assignee: 'owner', priority: 'normal' }, next: 'done' },
    { id: 'done', type: 'end' },
  ],
  settings: { timeZone: 'Asia/Kolkata', reentry: 'skip_if_active' },
};

export function NewFlowDialog({
  open,
  template: initial,
  templates,
  companies,
  onClose,
  onCreated,
}: {
  open: boolean;
  template: AutomationTemplate | null;
  templates: AutomationTemplate[];
  companies: OrgUnit[];
  onClose: () => void;
  onCreated: (flow: AutomationFlow) => void;
}) {
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [templateKey, setTemplateKey] = useState(initial?.key ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const template = templates.find((t) => t.key === templateKey) ?? null;

  const create = useMutation({
    mutationFn: () =>
      api.post<AutomationFlow>('/automations/flows', {
        companyId,
        name: name.trim() || undefined,
        ...(template ? { templateKey: template.key } : { definition: BLANK, name: name.trim() || 'New flow' }),
      }),
    onSuccess: async (flow) => {
      await queryClient.invalidateQueries({ queryKey: automationKeys.all });
      onCreated(flow);
    },
  });
  const errors = fieldErrorsOf(create.error);

  return (
    <Dialog open={open} onClose={onClose} title="New flow" description="Flows start as drafts. Nothing runs until you turn the flow on.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <DialogBody>
          {companies.length > 1 ? (
            <Field label="Company" error={errors['body.companyId']}>
              {(control) => (
                <select {...control} className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Start from" hint={template?.description ?? 'A blank flow with one task step, to build on.'}>
            {(control) => (
              <select
                {...control}
                className="select"
                value={templateKey}
                onChange={(e) => {
                  const next = templates.find((t) => t.key === e.target.value);
                  setTemplateKey(e.target.value);
                  if (next && (!name || templates.some((t) => t.name === name))) setName(next.name);
                }}
              >
                <option value="">Blank flow</option>
                {[...new Set(templates.map((t) => t.category))].map((category) => (
                  <optgroup key={category} label={category}>
                    {templates
                      .filter((t) => t.category === category)
                      .map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
          <Field label="Name" error={errors['body.name']} optional={Boolean(template)}>
            {(control) => <input {...control} className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={template?.name ?? 'Welcome new enquiries'} />}
          </Field>
          <ErrorAlert error={formErrorOf(create.error, ['body.companyId', 'body.name'])} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!companyId}>
            Create draft
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
