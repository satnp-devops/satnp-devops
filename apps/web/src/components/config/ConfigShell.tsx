'use client';

import { useId, type ReactNode } from 'react';
import { Guard } from '@/components/Guard';
import { Alert, EmptyState } from '@/components/ui';
import { useCompanyChoice, useConfigCompanies, type ConfigCompany } from '@/lib/config/companies';
import { useSession } from '@/lib/session';
import './config.css';

/**
 * The frame of a configuration screen: checks the view permission in the working scope, offers
 * the companies in it (a picker when there are several) and says when changes aren't allowed.
 */
export function ConfigShell({
  view,
  manage,
  intro,
  children,
}: {
  view: string;
  manage: string;
  /** One line about what the screen sets up. */
  intro: ReactNode;
  children: (company: ConfigCompany) => ReactNode;
}) {
  return (
    <Guard anyOf={[view]} anywhere>
      <Shell view={view} manage={manage} intro={intro}>
        {children}
      </Shell>
    </Guard>
  );
}

function Shell({ view, manage, intro, children }: Parameters<typeof ConfigShell>[0]) {
  const { scope } = useSession();
  const companies = useConfigCompanies(view, manage);
  const { current, choose } = useCompanyChoice(companies);
  const pickerId = useId();

  if (!current) {
    return (
      <div className="card">
        <EmptyState icon="building" title="No company here">
          {scope.name} has no company you can set up. Pick a company in &ldquo;Working in&rdquo;.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="stack gap-16">
      <div className="config-bar">
        <p className="config-bar__intro muted">{intro}</p>
        {companies.length > 1 ? (
          <div className="config-bar__picker">
            <label htmlFor={pickerId} className="small strong">
              Company
            </label>
            <select id={pickerId} className="select" value={current.unit.id} onChange={(event) => choose(event.target.value)}>
              {companies.map((company) => (
                <option key={company.unit.id} value={company.unit.id}>
                  {company.unit.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="config-bar__company strong">{current.unit.name}</p>
        )}
      </div>
      {current.canManage ? null : (
        <Alert tone="info">
          You can see how {current.unit.name} is set up but not change it. Company admins make changes here.
        </Alert>
      )}
      <div key={current.unit.id}>{children(current)}</div>
    </div>
  );
}
