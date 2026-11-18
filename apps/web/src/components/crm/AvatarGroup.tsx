'use client';

import type { CSSProperties } from 'react';
import { formatList } from '@/lib/crm/format';
import { Avatar } from '../ui';
import './crm.css';

export interface AvatarPerson {
  id?: string;
  name: string;
}

/** Overlapping avatars with "+2" for the rest; every name is in the tooltip and read aloud. */
export function AvatarGroup({
  people,
  max = 3,
  size = 28,
  label,
}: {
  people: readonly AvatarPerson[];
  max?: number;
  size?: number;
  /** Replaces the spoken list, e.g. "Hosts: Ritika Sharma and Kabir Anand". */
  label?: string;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  const names = people.map((person) => person.name);
  return (
    <span
      className="crm-avatars"
      title={names.join(', ')}
      // Overlap a fifth of an avatar, so initials stay readable at every size.
      style={{ '--crm-avatar-overlap': `${Math.round(size * 0.18)}px` } as CSSProperties}
    >
      {shown.map((person, index) => (
        <Avatar key={person.id ?? `${person.name}-${index}`} name={person.name} size={size} />
      ))}
      {rest > 0 ? (
        <span
          className="avatar crm-avatars__more"
          style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
          aria-hidden="true"
        >
          +{rest}
        </span>
      ) : null}
      <span className="visually-hidden">{label ?? formatList(names)}</span>
    </span>
  );
}
