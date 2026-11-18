import { Fragment, type ReactNode } from 'react';
import './crm.css';

// Symbols read badly aloud ("place of interest sign"), so screen readers get the key's name.
const SPOKEN: Record<string, string> = {
  '⌘': 'Command',
  '⌥': 'Option',
  '⇧': 'Shift',
  '⌃': 'Control',
  '↵': 'Enter',
  '↑': 'Up arrow',
  '↓': 'Down arrow',
  '←': 'Left arrow',
  '→': 'Right arrow',
  Esc: 'Escape',
};

function Key({ name }: { name: string }) {
  const spoken = SPOKEN[name];
  return (
    <kbd className="crm-kbd">
      {spoken ? (
        <>
          <span aria-hidden="true">{name}</span>
          <span className="visually-hidden">{spoken}</span>
        </>
      ) : (
        name
      )}
    </kbd>
  );
}

/**
 * A key or a shortcut: <Kbd>Esc</Kbd>, or <Kbd keys={[mod, 'K']} /> with `mod` from useModifierKey().
 */
export function Kbd({ keys, children }: { keys?: readonly string[]; children?: ReactNode }) {
  if (!keys) return typeof children === 'string' ? <Key name={children} /> : <kbd className="crm-kbd">{children}</kbd>;
  return (
    <kbd className="crm-kbds">
      {keys.map((name, index) => (
        <Fragment key={`${name}-${index}`}>
          {index > 0 ? (
            <span className="crm-kbds__plus" aria-hidden="true">
              +
            </span>
          ) : null}
          <Key name={name} />
        </Fragment>
      ))}
    </kbd>
  );
}
