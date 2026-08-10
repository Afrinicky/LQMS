/**
 * Renders a controlled Markdown document into a .docx carrying the Nicklandsales
 * house layout, so a specification can be circulated and signed in the form the
 * laboratory's document control expects.
 *
 * Deliberately small: it handles the constructs the controlled documents use —
 * headings, paragraphs, bullet lists, pipe tables, block quotes, rules and
 * inline bold/italic/code — and nothing else.
 */
const fs = require('node:fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  Header, Footer, PageNumber, TableOfContents, LevelFormat, PageBreak,
} = require('docx');

const INK = '15211F', ACCENT = '0F5C58', MUTED = '4A5A56';
const RULE = 'CCD4D0', HEAD_BG = 'E7EDEB', ALT_BG = 'F4F7F6';
const CONTENT_W = 9360;

/** Split a line into runs, honouring **bold**, *italic* and `code`. */
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, m;
  const push = (s, extra) => { if (s) out.push(new TextRun({ text: s, font: 'Calibri', size: 20, color: INK, ...base, ...extra })); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) push(tok.slice(2, -2), { bold: true });
    else if (tok.startsWith('`')) out.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas', size: 18, color: ACCENT, ...base }));
    else push(tok.slice(1, -1), { italics: true });
    last = m.index + tok.length;
  }
  push(text.slice(last));
  return out.length ? out : [new TextRun({ text: '', font: 'Calibri', size: 20 })];
}

const cellOf = (text, w, opts = {}) => new TableCell({
  width: { size: w, type: WidthType.DXA },
  shading: opts.bg ? { type: ShadingType.CLEAR, fill: opts.bg, color: 'auto' } : undefined,
  margins: { top: 70, bottom: 70, left: 110, right: 110 },
  verticalAlign: 'top',
  children: [new Paragraph({
    children: runs(text, opts.bold ? { bold: true, size: 17 } : { size: 17 }),
    spacing: { after: 0, line: 240 },
  })],
});

function makeTable(rows) {
  const cols = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => { const c = r.slice(); while (c.length < cols) c.push(''); return c; });
  // Widths proportional to the longest content in each column, within bounds.
  const weight = Array.from({ length: cols }, (_, i) =>
    Math.min(60, Math.max(8, Math.max(...norm.map(r => (r[i] || '').length)))));
  const total = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map(w => Math.round(CONTENT_W * w / total));
  widths[cols - 1] = CONTENT_W - widths.slice(0, -1).reduce((a, b) => a + b, 0);

  return new Table({
    columnWidths: widths,
    width: { size: CONTENT_W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    },
    rows: norm.map((r, ri) => new TableRow({
      tableHeader: ri === 0,
      children: r.map((c, ci) => cellOf(c, widths[ci], {
        bg: ri === 0 ? HEAD_BG : (ri % 2 === 0 ? ALT_BG : undefined),
        bold: ri === 0,
      })),
    })),
  });
}

function convert(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isDivider = l => /^\s*\|[\s:|-]+\|\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (/^---+$/.test(line.trim())) {
      out.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 8 } }, spacing: { after: 160 } }));
      i++; continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(new Paragraph({
        children: runs(h[2].replace(/\s*—\s*$/, '')),
        heading: [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1],
        spacing: { before: level === 1 ? 400 : 300, after: 140 },
      }));
      i++; continue;
    }

    if (isTableRow(line)) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isDivider(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
        }
        i++;
      }
      if (rows.length) { out.push(makeTable(rows)); out.push(new Paragraph({ text: '', spacing: { after: 160 } })); }
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(new Paragraph({
        children: runs(buf.join(' '), { italics: true, color: MUTED }),
        indent: { left: 360 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 12 } },
        spacing: { before: 140, after: 180, line: 276 },
      }));
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        out.push(new Paragraph({
          children: runs(lines[i].replace(/^[-*]\s+/, '')),
          numbering: { reference: 'md-bullets', level: 0 },
          spacing: { after: 70, line: 276 },
        }));
        i++;
      }
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        out.push(new Paragraph({
          children: runs(lines[i].replace(/^\d+\.\s+/, '')),
          numbering: { reference: 'md-numbers', level: 0 },
          spacing: { after: 70, line: 276 },
        }));
        i++;
      }
      continue;
    }

    // Paragraph: gather until a blank line or a construct starts.
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|[-*]\s|\d+\.\s|---+$)/.test(lines[i]) && !isTableRow(lines[i])) {
      buf.push(lines[i].trim()); i++;
    }
    out.push(new Paragraph({ children: runs(buf.join(' ')), spacing: { after: 140, line: 276 } }));
  }
  return out;
}

const [, , src, dest, docTitle, docRef] = process.argv;
const body = convert(fs.readFileSync(src, 'utf8'));

const doc = new Document({
  creator: 'Nicklandsales',
  title: docTitle,
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 20, color: INK } },
      title: { run: { font: 'Calibri', size: 44, bold: true, color: INK }, paragraph: { spacing: { after: 240 } } },
      heading1: { run: { font: 'Calibri', size: 28, bold: true, color: ACCENT }, paragraph: { spacing: { before: 400, after: 140 } } },
      heading2: { run: { font: 'Calibri', size: 23, bold: true, color: INK }, paragraph: { spacing: { before: 300, after: 120 } } },
      heading3: { run: { font: 'Calibri', size: 20, bold: true, color: MUTED }, paragraph: { spacing: { before: 240, after: 100 } } },
    },
  },
  numbering: {
    config: [
      { reference: 'md-bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
      { reference: 'md-numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 260 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    headers: {
      default: new Header({
        children: [new Paragraph({
          children: [new TextRun({ text: docRef, font: 'Calibri', size: 16, color: MUTED })],
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
          spacing: { after: 200 },
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: 'Nicklandsales Controlled Document          Page ', font: 'Calibri', size: 16, color: MUTED }),
            new TextRun({ children: [PageNumber.CURRENT], font: 'Calibri', size: 16, color: MUTED }),
            new TextRun({ text: ' of ', font: 'Calibri', size: 16, color: MUTED }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Calibri', size: 16, color: MUTED }),
          ],
        })],
      }),
    },
    children: body,
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(dest, buf);
  console.log('wrote', dest, (buf.length / 1024).toFixed(0) + ' KB');
});
