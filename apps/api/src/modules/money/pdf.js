// A small text-only PDF writer (PDF 1.4, Helvetica, A4) for agreements sent to e-sign. No
// dependencies: the document is plain paragraphs, which is all a fee agreement needs. Characters
// outside Latin-1 are replaced (₹ becomes "Rs.") because the standard fonts have no glyphs for them.

const PAGE = { width: 595, height: 842, margin: 56 };
const FONT_SIZE = 10.5;
const LEADING = 15;
const MAX_CHARS = 92;

const toLatin1 = (text) =>
  String(text)
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');

const escape = (text) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Wrap paragraphs to lines of at most MAX_CHARS characters. Pure. */
export function wrapText(text, width = MAX_CHARS) {
  const out = [];
  for (const paragraph of toLatin1(text).split(/\r?\n/)) {
    if (!paragraph.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (word.length > width) {
        if (line) out.push(line);
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        line = '';
      } else if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Render a title and body text as a PDF.
 * @param {{ title: string, body: string, footer?: string }} input
 * @returns {Buffer}
 */
export function textPdf({ title, body, footer = '' }) {
  const lines = wrapText(body);
  const perPage = Math.floor((PAGE.height - PAGE.margin * 2 - 40) / LEADING);
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += perPage) pages.push(lines.slice(i, i + perPage));

  const objects = [];
  const add = (content) => objects.push(content) && objects.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  pages.forEach((pageLines, index) => {
    let y = PAGE.height - PAGE.margin;
    const ops = [];
    if (index === 0) {
      ops.push(`BT /F2 15 Tf ${PAGE.margin} ${y} Td (${escape(toLatin1(title))}) Tj ET`);
      y -= 32;
    }
    for (const line of pageLines) {
      if (line) ops.push(`BT /F1 ${FONT_SIZE} Tf ${PAGE.margin} ${y} Td (${escape(line)}) Tj ET`);
      y -= LEADING;
    }
    const pageFooter = `${toLatin1(footer)}${footer ? '   ' : ''}Page ${index + 1} of ${pages.length}`;
    ops.push(`BT /F1 8 Tf ${PAGE.margin} ${PAGE.margin - 20} Td (${escape(pageFooter)}) Tj ET`);
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
