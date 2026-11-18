'use client';

import { useCrmPeople } from '@/lib/accounts/queries';
import type { UserRef } from '@/lib/crm/types';
import { useSession } from '@/lib/session';
import type { ControlProps } from '@/components/ui';

/**
 * Pick who owns the institute for a company: people who can see institutes at the unit
 * (GET /crm/people, permission accounts.view). The current owner and the viewer stay listed even
 * if the list can't load, so the form keeps working.
 */
export function OwnerSelect({
  unitId,
  value,
  current,
  onChange,
  control,
  disabled = false,
}: {
  unitId: string | null;
  /** The chosen user id, or '' for nobody. */
  value: string;
  /** The owner stored on the record, shown by name even before the list loads. */
  current?: UserRef | null;
  onChange: (userId: string) => void;
  control?: ControlProps;
  disabled?: boolean;
}) {
  const { user } = useSession();
  const people = useCrmPeople(unitId, 'accounts.view');
  const options = new Map<string, string>();
  if (current) options.set(current.id, current.name);
  options.set(user.id, `${user.name} (you)`);
  for (const person of people.data ?? []) options.set(person.id, person.id === user.id ? `${person.name} (you)` : person.name);

  return (
    <>
      <select {...control} className="select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">No owner</option>
        {[...options.entries()].map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {people.isError ? <p className="field__hint">Couldn&apos;t load everyone who works here; you can still pick yourself.</p> : null}
    </>
  );
}
