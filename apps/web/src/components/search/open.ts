// Opening the palette from anywhere (a button, another page) without importing its state:
// the palette, mounted once in the signed-in layout, listens for this window event.

export const OPEN_SEARCH_EVENT = 'phoenix:open-search';

export interface OpenSearchDetail {
  /** Text to start with. */
  query?: string;
}

export function openSearch(detail: OpenSearchDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenSearchDetail>(OPEN_SEARCH_EVENT, { detail }));
}

/** Is the user typing somewhere, so "/" belongs to the field rather than to us? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
}
