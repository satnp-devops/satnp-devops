'use client';

import { Kbd, useModifierKey } from '@/components/crm';
import { Icon } from '@/components/icons';
import { openSearch } from './open';
import './search.css';

/**
 * The visible way into global search, for the sidebar (and phones, which have no Ctrl/Cmd+K).
 * aria-keyshortcuts tells screen reader users the shortcut too.
 */
export function SearchButton({ disabled = false }: { disabled?: boolean }) {
  const mod = useModifierKey();
  return (
    <button
      type="button"
      className="search-trigger"
      onClick={() => openSearch()}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-keyshortcuts={mod === '⌘' ? 'Meta+K' : 'Control+K'}
    >
      <Icon name="search" size={16} />
      <span className="search-trigger__label">Search</span>
      <span className="search-trigger__keys" aria-hidden="true">
        <Kbd keys={[mod, 'K']} />
      </span>
    </button>
  );
}
