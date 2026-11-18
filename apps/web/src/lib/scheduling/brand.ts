// Company colours on public pages must stay readable: text in the brand colour sits on white, and
// white text sits on the brand colour. A colour that is too light is darkened until it reaches
// 4.5:1 against white (WCAG AA for normal text).

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function contrastWithWhite(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb;
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (luminance + 0.05);
}

/** The brand colour, darkened just enough for 4.5:1 on white; the app accent when it isn't a colour. */
export function readableBrand(hex: string | null | undefined, fallback = '#2840D8'): string {
  const rgb = hex ? parseHex(hex) : null;
  if (!rgb) return fallback;
  let [r, g, b] = rgb;
  for (let i = 0; i < 20; i += 1) {
    const candidate = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    if (contrastWithWhite(candidate) >= 4.5) return candidate;
    r *= 0.9;
    g *= 0.9;
    b *= 0.9;
  }
  return fallback;
}
