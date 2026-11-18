'use client';

import type { OrgUnit } from '@/lib/types';

/**
 * Pick the company a company-level AI screen works on. Working inside a company there is only
 * one, so this shows its name instead of a choice.
 */
export function CompanySelect({
  companies,
  value,
  onChange,
  id = 'ai-company',
}: {
  companies: readonly OrgUnit[];
  value: string | null;
  onChange: (companyId: string) => void;
  id?: string;
}) {
  if (companies.length <= 1) return null;
  return (
    <div className="row gap-8">
      <label htmlFor={id} className="small muted">
        Company
      </label>
      <select id={id} className="select toolbar__select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.name}
          </option>
        ))}
      </select>
    </div>
  );
}
