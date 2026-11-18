// Small helpers for nested form values such as a unit profile's "address.city".

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Returns a copy with `path` set to `value`; the input is not changed. */
export function setPath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return source;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = isPlainObject(source[head]) ? (source[head] as Record<string, unknown>) : {};
  return { ...source, [head]: setPath(child, rest.join('.'), value) };
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A lowercase, hyphenated code from a name: "Pune Centre" → "pune-centre". */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

const SAME_SITE_BASE = 'https://phoenix.invalid';

/**
 * Only allow redirects to paths on this site, never to another origin. Browsers drop tabs and
 * newlines from URLs and read "\" as "/", so "/\t/evil.example" or "/\evil.example" would become
 * "//evil.example": anything with control characters or backslashes is refused, and the result
 * must still resolve to this site.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const url = new URL(value, SAME_SITE_BASE);
    if (url.origin !== SAME_SITE_BASE) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * A link to another site that is safe to put in href: http(s) only, so a stored "javascript:" or
 * "data:" value can never run in the app. Returns null for anything else.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
