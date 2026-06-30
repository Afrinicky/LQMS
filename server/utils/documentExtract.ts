/**
 * Dependency-free extraction of readable content from uploaded controlled
 * documents (PDF, Word .docx, and plain text/markdown/csv). The goal is to let
 * SECH_LIMS "read the whole document" — title, scope, responsibilities,
 * procedure, references, etc. — so a controlled document can be previewed and
 * edited inside the application without relying on the original office suite.
 *
 * Design constraints (this is an offline-first, LAN-ready Electron app):
 *  - No new runtime dependencies. Native modules and large parser libraries
 *    complicate electron-builder packaging (asarUnpack, code signing). We use
 *    only Node's built-in `zlib` for inflate.
 *  - Best-effort, never throws. If a PDF uses exotic font encodings or object
 *    streams we may extract little; the file remains viewable in the in-app
 *    viewer and the content can always be edited by hand.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export type ExtractedSection = { heading: string; key: string; body: string };
export type ExtractionResult = {
  text: string;
  html: string;
  sections: ExtractedSection[];
  pageCount: number | null;
  method: string;
  titleGuess: string | null;
  documentCodeGuess: string | null;
};

const EMPTY = (method: string): ExtractionResult => ({ text: '', html: '', sections: [], pageCount: null, method, titleGuess: null, documentCodeGuess: null });

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Plain text ──────────────────────────────────────────────────────────────
function fromPlainText(buf: Buffer): string {
  return buf.toString('utf-8').replace(/\r\n?/g, '\n');
}

// ── DOCX (Office Open XML) ───────────────────────────────────────────────────
// A .docx is a ZIP archive. We read the central directory to locate and inflate
// word/document.xml (and headers), then convert the WordprocessingML run/paragraph
// markup into clean text and lightweight HTML.
// List all entry names from the ZIP central directory.
function zipListNames(buf: Buffer): string[] {
  const names: string[] = [];
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) { if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; } }
  if (eocd < 0) return names;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < cdCount && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf-8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function zipReadEntry(buf: Buffer, name: string): Buffer | null {
  // Locate End Of Central Directory record (signature 0x06054b50).
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < cdCount && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      // Jump to the local file header to compute the true data offset.
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      try {
        return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
      } catch {
        return null;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// Minimal well-formed-XML parser, sufficient for WordprocessingML (document.xml
// is always well formed). Produces a lightweight DOM we can walk to preserve the
// document's full structure — paragraphs, headings, tables, lists and runs.
type XmlNode = { tag: string; attrs: Record<string, string>; children: XmlNode[]; text?: string };
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tagRe = /<([!?][\s\S]*?)>|<(\/)?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/)?>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    if (m.index > last) {
      const txt = xml.slice(last, m.index);
      const parent = stack[stack.length - 1];
      if (txt && !/^\s*$/.test(txt)) {
        parent.children.push({ tag: '#text', attrs: {}, children: [], text: decodeXmlEntities(txt) });
      } else if (txt && parent.tag === 'w:t') {
        parent.children.push({ tag: '#text', attrs: {}, children: [], text: decodeXmlEntities(txt) });
      }
    }
    last = tagRe.lastIndex;
    if (m[1] !== undefined) continue; // <?xml?> / <!-- --> / doctype
    const closing = m[2]; const name = m[3]; const attrStr = m[4] || ''; const selfClose = m[5];
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    const aRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g; let am: RegExpExecArray | null;
    while ((am = aRe.exec(attrStr))) attrs[am[1]] = decodeXmlEntities(am[2]);
    const node: XmlNode = { tag: name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function find(node: XmlNode, tag: string): XmlNode | undefined { return node.children.find(c => c.tag === tag); }
function findAll(node: XmlNode, tag: string): XmlNode[] { return node.children.filter(c => c.tag === tag); }
function descend(node: XmlNode, ...path: string[]): XmlNode | undefined {
  let cur: XmlNode | undefined = node;
  for (const p of path) { cur = cur && find(cur, p); if (!cur) return undefined; }
  return cur;
}
function htmlEsc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Conversion context shared while walking the document: the source zip (for
// embedded media), the document relationships (rId -> part), and pre-extracted
// SmartArt/diagram text for fallback rendering.
type DocxCtx = { buf: Buffer; rels: Record<string, string>; diagrams: string[]; diagramUsed: number; embeddedBytes: number };

// WordprocessingML highlight colour names -> CSS.
const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
function colorVal(v?: string): string | null { return !v || v === 'auto' || !/^[0-9a-fA-F]{6}$/.test(v) ? null : `#${v}`; }
function deepFind(node: XmlNode, tag: string): XmlNode | undefined {
  for (const c of node.children) { if (c.tag === tag) return c; const r = deepFind(c, tag); if (r) return r; }
  return undefined;
}
function mimeForExt(name: string): string {
  const e = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/emf', wmf: 'image/wmf', svg: 'image/svg+xml' } as Record<string, string>)[e] || 'application/octet-stream';
}

// Inline formatting from a run's <w:rPr>: returns the opening/closing wrappers
// that carry colour, highlight, shading, size, weight, decoration and sup/sub.
function runWrappers(rPr?: XmlNode): { open: string; close: string } {
  if (!rPr) return { open: '', close: '' };
  const styles: string[] = [];
  const color = colorVal(find(rPr, 'w:color')?.attrs['w:val']); if (color) styles.push(`color:${color}`);
  const hl = find(rPr, 'w:highlight')?.attrs['w:val']; if (hl && HIGHLIGHT[hl]) styles.push(`background-color:${HIGHLIGHT[hl]}`);
  const shd = colorVal(find(rPr, 'w:shd')?.attrs['w:fill']); if (shd) styles.push(`background-color:${shd}`);
  const sz = find(rPr, 'w:sz')?.attrs['w:val']; if (sz && Number(sz) > 0) styles.push(`font-size:${Number(sz) / 2}pt`);
  if (find(rPr, 'w:b') || find(rPr, 'w:bCs')) styles.push('font-weight:bold');
  if (find(rPr, 'w:i') || find(rPr, 'w:iCs')) styles.push('font-style:italic');
  const fonts = find(rPr, 'w:rFonts')?.attrs; const face = fonts && (fonts['w:ascii'] || fonts['w:hAnsi']); if (face) styles.push(`font-family:'${face}'`);
  const deco: string[] = [];
  if (find(rPr, 'w:u') && find(rPr, 'w:u')?.attrs['w:val'] !== 'none') deco.push('underline');
  if (find(rPr, 'w:strike') || find(rPr, 'w:dstrike')) deco.push('line-through');
  if (deco.length) styles.push(`text-decoration:${deco.join(' ')}`);
  let open = '', close = '';
  const vert = find(rPr, 'w:vertAlign')?.attrs['w:val'];
  if (vert === 'superscript') { open = '<sup>'; close = '</sup>'; }
  else if (vert === 'subscript') { open = '<sub>'; close = '</sub>'; }
  if (styles.length) { open = `<span style="${styles.join(';')}">` + open; close = close + '</span>'; }
  return { open, close };
}

// ── Drawn diagrams (org charts built from shapes + connectors, not SmartArt) ──
// Word lets authors draw org charts by hand using Insert > Shapes: rectangles
// (wps:wsp) grouped together (wpg:wgp) and joined by line/arrow connectors
// (wps:cxnSp). These have no text-bearing "diagram data" part to fall back to
// (unlike real SmartArt), so without rendering the shapes themselves the whole
// diagram silently disappears. This renders such groups as an inline SVG —
// positioned/coloured boxes with connecting lines — built only from the
// shapes' own offsets/sizes/fills/text, so no extra parsing dependency is
// needed. Best-effort visual approximation, not pixel-identical to Word.
const EMU_PER_PX = 9525; // 914400 EMU per inch ÷ 96 px per inch
function emuToPx(v?: string): number { const n = Number(v); return Number.isFinite(n) ? n / EMU_PER_PX : 0; }

type ShapeXfrm = { x: number; y: number; w: number; h: number; chX: number; chY: number; chW: number; chH: number; flipH: boolean; flipV: boolean };
function shapeXfrm(parent: XmlNode): ShapeXfrm | null {
  const xfrm = find(parent, 'a:xfrm');
  if (!xfrm) return null;
  const off = find(xfrm, 'a:off'); const ext = find(xfrm, 'a:ext');
  const chOff = find(xfrm, 'a:chOff'); const chExt = find(xfrm, 'a:chExt');
  return {
    x: emuToPx(off?.attrs['x']), y: emuToPx(off?.attrs['y']), w: emuToPx(ext?.attrs['cx']), h: emuToPx(ext?.attrs['cy']),
    chX: emuToPx(chOff?.attrs['x']), chY: emuToPx(chOff?.attrs['y']), chW: emuToPx(chExt?.attrs['cx']), chH: emuToPx(chExt?.attrs['cy']),
    flipH: xfrm.attrs['flipH'] === '1', flipV: xfrm.attrs['flipV'] === '1',
  };
}
function shapeSpPr(node: XmlNode): XmlNode | undefined { return find(node, 'wps:spPr') || find(node, 'p:spPr'); }
function shapeFillColor(node: XmlNode): string | null {
  const spPr = shapeSpPr(node); if (!spPr) return null;
  const solid = find(spPr, 'a:solidFill'); if (!solid) return null;
  return colorVal(find(solid, 'a:srgbClr')?.attrs['val']);
}
function shapeLineStyle(node: XmlNode): { color: string | null; dashed: boolean; arrow: boolean } {
  const spPr = shapeSpPr(node); const ln = spPr ? find(spPr, 'a:ln') : undefined;
  if (!ln) return { color: null, dashed: false, arrow: false };
  const solid = find(ln, 'a:solidFill');
  const dashVal = find(ln, 'a:prstDash')?.attrs['val'];
  const tailEnd = find(ln, 'a:tailEnd');
  return { color: colorVal(solid ? find(solid, 'a:srgbClr')?.attrs['val'] : undefined), dashed: !!dashVal && dashVal !== 'solid', arrow: !!tailEnd && tailEnd.attrs['type'] !== 'none' };
}
function shapeTextOf(node: XmlNode, ctx: DocxCtx): string {
  const txbxContent = descend(node, 'wps:txbx', 'w:txbxContent') || descend(node, 'wps:txBody', 'w:txbxContent');
  if (txbxContent) return bodyToHtmlText(txbxContent, ctx).text.trim();
  const texts: string[] = [];
  const walk = (n: XmlNode) => { if (n.tag === 'w:t' || n.tag === 'a:t') texts.push(n.children.map(c => c.text || '').join('')); n.children.forEach(walk); };
  walk(node);
  return texts.join(' ').trim();
}
type DiagBox = { x: number; y: number; w: number; h: number; fill: string | null; line: string | null; text: string };
type DiagLine = { x1: number; y1: number; x2: number; y2: number; dashed: boolean; arrow: boolean };
function collectShapeDiagram(node: XmlNode, ctx: DocxCtx, originX: number, originY: number, scaleX: number, scaleY: number, boxes: DiagBox[], lines: DiagLine[]) {
  for (const child of node.children) {
    if (child.tag === 'wpg:wgp' || child.tag === 'wpg:grpSp') {
      const grpPr = find(child, 'wpg:grpSpPr');
      const xf = grpPr ? shapeXfrm(grpPr) : null;
      if (xf && xf.chW > 0 && xf.chH > 0) {
        const sx = (xf.w / xf.chW) * scaleX; const sy = (xf.h / xf.chH) * scaleY;
        collectShapeDiagram(child, ctx, originX + xf.x * scaleX - xf.chX * sx, originY + xf.y * scaleY - xf.chY * sy, sx, sy, boxes, lines);
      } else {
        collectShapeDiagram(child, ctx, originX, originY, scaleX, scaleY, boxes, lines);
      }
    } else if (child.tag === 'wps:wsp') {
      const spPr = shapeSpPr(child); const xf = spPr ? shapeXfrm(spPr) : null;
      if (!xf) continue;
      boxes.push({ x: originX + xf.x * scaleX, y: originY + xf.y * scaleY, w: xf.w * scaleX, h: xf.h * scaleY, fill: shapeFillColor(child), line: shapeLineStyle(child).color, text: shapeTextOf(child, ctx) });
    } else if (child.tag === 'wps:cxnSp') {
      const spPr = shapeSpPr(child); const xf = spPr ? shapeXfrm(spPr) : null;
      if (!xf) continue;
      let x1 = originX + xf.x * scaleX, y1 = originY + xf.y * scaleY;
      let x2 = x1 + xf.w * scaleX, y2 = y1 + xf.h * scaleY;
      if (xf.flipH) { const t = x1; x1 = x2; x2 = t; }
      if (xf.flipV) { const t = y1; y1 = y2; y2 = t; }
      const ls = shapeLineStyle(child);
      lines.push({ x1, y1, x2, y2, dashed: ls.dashed, arrow: ls.arrow });
    } else {
      collectShapeDiagram(child, ctx, originX, originY, scaleX, scaleY, boxes, lines);
    }
  }
}
function renderShapeDiagram(graphicData: XmlNode, ctx: DocxCtx): { html: string; text: string } | null {
  const boxes: DiagBox[] = []; const lines: DiagLine[] = [];
  collectShapeDiagram(graphicData, ctx, 0, 0, 1, 1, boxes, lines);
  if (!boxes.length) return null;
  const maxX = Math.max(0, ...boxes.map(b => b.x + b.w), ...lines.map(l => Math.max(l.x1, l.x2)));
  const maxY = Math.max(0, ...boxes.map(b => b.y + b.h), ...lines.map(l => Math.max(l.y1, l.y2)));
  const W = Math.ceil(maxX + 8); const H = Math.ceil(maxY + 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-width:760px;display:block;margin:10px auto" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<defs><marker id="docxDiagArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#5b6b8c"/></marker></defs>';
  for (const l of lines) svg += `<line x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" stroke="#5b6b8c" stroke-width="1.5"${l.dashed ? ' stroke-dasharray="5,4"' : ''}${l.arrow ? ' marker-end="url(#docxDiagArrow)"' : ''}/>`;
  for (const b of boxes) {
    const w = Math.max(4, b.w); const h = Math.max(4, b.h);
    svg += `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${b.fill || '#eef2f8'}" stroke="${b.line || '#5b6b8c'}" stroke-width="1.2"/>`;
    if (b.text) svg += `<foreignObject x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font:600 11px/1.25 Calibri,Arial,sans-serif;color:#10213f;padding:2px;box-sizing:border-box;overflow:hidden">${htmlEsc(b.text)}</div></foreignObject>`;
  }
  svg += '</svg>';
  const text = boxes.map(b => b.text).filter(Boolean).join('\n');
  return { html: `<div class="docx-diagram docx-shape-diagram">${svg}</div>`, text: text ? text + '\n' : '' };
}

// Render an embedded picture (<w:drawing>/<w:pict>) as an inline data-URI <img>,
// a SmartArt diagram as its extracted text, or a hand-drawn shapes+connectors
// diagram (e.g. an org chart) as an SVG.
function imageHtml(node: XmlNode, ctx: DocxCtx): { html: string; text: string } {
  const blip = deepFind(node, 'a:blip'); const vml = deepFind(node, 'v:imagedata');
  const embed = blip?.attrs['r:embed'] || blip?.attrs['r:link'] || vml?.attrs['r:id'];
  if (embed && ctx.rels[embed]) {
    const target = ctx.rels[embed].replace(/^\/?word\//, '').replace(/^\.\.\//, '');
    const bytes = zipReadEntry(ctx.buf, `word/${target}`);
    if (bytes && bytes.length <= 6_000_000 && ctx.embeddedBytes + bytes.length <= 16_000_000) {
      ctx.embeddedBytes += bytes.length;
      const mime = mimeForExt(target);
      if (mime.startsWith('image/') && mime !== 'image/emf' && mime !== 'image/wmf') {
        return { html: `<p class="docx-img"><img src="data:${mime};base64,${bytes.toString('base64')}" alt="document image" style="max-width:100%;height:auto"/></p>`, text: '[image]\n' };
      }
    }
    return { html: '<p class="docx-img-note">[Embedded image omitted — open the original file to view it.]</p>', text: '[image]\n' };
  }
  // SmartArt / diagram: render the pre-extracted diagram text.
  if (deepFind(node, 'dgm:relIds') || /diagram/i.test(deepFind(node, 'a:graphicData')?.attrs['uri'] || '')) {
    const dt = ctx.diagrams[ctx.diagramUsed] ?? ctx.diagrams[0] ?? '';
    ctx.diagramUsed += 1;
    if (dt.trim()) return { html: `<div class="docx-diagram"><p><em>Diagram (SmartArt):</em></p>${dt.split('\n').filter(Boolean).map(l => `<p>${htmlEsc(l)}</p>`).join('')}</div>`, text: dt + '\n' };
  }
  // Hand-drawn shapes/connectors diagram (e.g. an org chart built from rectangles).
  const graphicData = deepFind(node, 'a:graphicData');
  if (graphicData && (deepFind(graphicData, 'wpg:wgp') || deepFind(graphicData, 'wps:wsp') || deepFind(graphicData, 'wps:cxnSp'))) {
    const rendered = renderShapeDiagram(graphicData, ctx);
    if (rendered && (rendered.html || rendered.text)) return rendered;
  }
  return { html: '', text: '' };
}

// Collect the formatted inline content of a run container (<w:p>, <w:hyperlink>).
function runsToHtml(container: XmlNode, ctx: DocxCtx): { html: string; text: string } {
  let html = ''; let text = '';
  for (const child of container.children) {
    if (child.tag === 'w:r') {
      const { open, close } = runWrappers(find(child, 'w:rPr'));
      for (const rc of child.children) {
        if (rc.tag === 'w:t') {
          const t = rc.children.map(x => x.text || '').join('');
          html += open + htmlEsc(t) + close; text += t;
        } else if (rc.tag === 'w:tab') { html += '&nbsp;&nbsp;&nbsp;'; text += '\t'; }
        else if (rc.tag === 'w:br' || rc.tag === 'w:cr') { html += '<br/>'; text += '\n'; }
        else if (rc.tag === 'w:drawing' || rc.tag === 'w:pict' || rc.tag === 'mc:AlternateContent' || rc.tag === 'w:object') {
          const im = imageHtml(rc, ctx); html += im.html; text += im.text;
        } else if (rc.tag === 'w:sym') { html += '&bull;'; }
      }
    } else if (child.tag === 'w:hyperlink' || child.tag === 'w:smartTag' || child.tag === 'w:ins') {
      const r = runsToHtml(child, ctx); html += r.html; text += r.text;
    } else if (child.tag === 'w:drawing' || child.tag === 'w:pict') {
      const im = imageHtml(child, ctx); html += im.html; text += im.text;
    }
  }
  return { html, text };
}

// Heading level from a paragraph's style id (Heading1 -> h2, … ; Title -> h2).
function headingLevel(p: XmlNode): number | null {
  const style = descend(p, 'w:pPr', 'w:pStyle')?.attrs['w:val'] || '';
  const m = style.match(/^(?:heading|berschrift|titre|ttulo|encabezado)\s*(\d)/i);
  if (m) return Math.min(6, Number(m[1]) + 1);
  if (/^(title|titel)/i.test(style)) return 2;
  if (/^subtitle/i.test(style)) return 3;
  return null;
}
function isListItem(p: XmlNode): boolean { return !!descend(p, 'w:pPr', 'w:numPr'); }

// Block-level style from <w:pPr>: alignment and paragraph shading (fill).
function paraStyle(p: XmlNode): string {
  const pPr = find(p, 'w:pPr'); if (!pPr) return '';
  const styles: string[] = [];
  const jc = find(pPr, 'w:jc')?.attrs['w:val'];
  const jcMap: Record<string, string> = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', left: 'left', start: 'left' };
  if (jc && jcMap[jc]) styles.push(`text-align:${jcMap[jc]}`);
  const fill = colorVal(find(pPr, 'w:shd')?.attrs['w:fill']); if (fill) styles.push(`background-color:${fill};padding:3px 6px`);
  return styles.length ? ` style="${styles.join(';')}"` : '';
}
function cellStyle(tc: XmlNode): string {
  const tcPr = find(tc, 'w:tcPr'); if (!tcPr) return '';
  const styles: string[] = [];
  const fill = colorVal(find(tcPr, 'w:shd')?.attrs['w:fill']); if (fill) styles.push(`background-color:${fill}`);
  const va = find(tcPr, 'w:vAlign')?.attrs['w:val']; if (va) styles.push(`vertical-align:${va === 'center' ? 'middle' : va}`);
  return styles.length ? ` style="${styles.join(';')}"` : '';
}

function renderParagraph(p: XmlNode, ctx: DocxCtx): { html: string; text: string; list: boolean; heading: number | null; style: string } {
  const { html: inner, text } = runsToHtml(p, ctx);
  return { html: inner, text, list: isListItem(p), heading: headingLevel(p), style: paraStyle(p) };
}

function renderTable(tbl: XmlNode, ctx: DocxCtx): { html: string; text: string } {
  let html = '<table class="docx-table"><tbody>'; let text = '';
  for (const tr of findAll(tbl, 'w:tr')) {
    html += '<tr>';
    const cells: string[] = [];
    for (const tc of findAll(tr, 'w:tc')) {
      let cellHtml = ''; const cellTextParts: string[] = [];
      for (const node of tc.children) {
        if (node.tag === 'w:p') { const r = renderParagraph(node, ctx); if (r.html) cellHtml += `<p${r.style}>${r.html}</p>`; if (r.text.trim()) cellTextParts.push(r.text.trim()); }
        else if (node.tag === 'w:tbl') { const r = renderTable(node, ctx); cellHtml += r.html; cellTextParts.push(r.text); }
      }
      const span = Number(descend(tc, 'w:tcPr', 'w:gridSpan')?.attrs['w:val'] || '1');
      const vMerge = descend(tc, 'w:tcPr', 'w:vMerge'); const continued = vMerge && (vMerge.attrs['w:val'] ?? 'continue') === 'continue';
      if (continued && !cellHtml.replace(/<[^>]+>|&nbsp;|\s/g, '')) { html += ''; cells.push(''); continue; }
      html += `<td${span > 1 ? ` colspan="${span}"` : ''}${cellStyle(tc)}>${cellHtml || '&nbsp;'}</td>`;
      cells.push(cellTextParts.join(' '));
    }
    html += '</tr>';
    text += cells.join('\t') + '\n';
  }
  html += '</tbody></table>';
  return { html, text };
}

// Convert a body node (document, header, sdt content) into HTML + plain text,
// preserving headings, tables, lists, formatting and embedded images.
function bodyToHtmlText(body: XmlNode, ctx: DocxCtx): { html: string; text: string } {
  let html = ''; let text = '';
  let listOpen = false;
  const closeList = () => { if (listOpen) { html += '</ul>'; listOpen = false; } };
  for (const node of body.children) {
    if (node.tag === 'w:p') {
      const r = renderParagraph(node, ctx);
      if (r.list) {
        if (!listOpen) { html += '<ul>'; listOpen = true; }
        html += `<li${r.style}>${r.html || '&nbsp;'}</li>`;
        if (r.text.trim()) text += '• ' + r.text + '\n';
        continue;
      }
      closeList();
      if (r.heading) { html += `<h${r.heading}${r.style}>${r.html}</h${r.heading}>`; if (r.text.trim()) text += '\n' + r.text + '\n'; }
      else if (r.html.trim()) { html += `<p${r.style}>${r.html}</p>`; text += r.text + '\n'; }
      else { html += '<p></p>'; text += '\n'; }
    } else if (node.tag === 'w:tbl') {
      closeList();
      const r = renderTable(node, ctx);
      html += r.html; text += r.text;
    } else if (node.tag === 'w:sdt') {
      const content = descend(node, 'w:sdtContent');
      if (content) { const r = bodyToHtmlText(content, ctx); html += r.html; text += r.text; }
    }
  }
  closeList();
  return { html, text };
}

// Parse word/_rels/document.xml.rels into an { rId: target } map.
function parseRels(buf: Buffer): Record<string, string> {
  const rels: Record<string, string> = {};
  const data = zipReadEntry(buf, 'word/_rels/document.xml.rels');
  if (!data) return rels;
  const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"|<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data.toString('utf-8')))) { if (m[1]) rels[m[1]] = m[2]; else if (m[4]) rels[m[4]] = m[3]; }
  return rels;
}
// Pre-extract the text of any SmartArt/diagram data parts (word/diagrams/dataN.xml).
function extractDiagrams(buf: Buffer): string[] {
  const out: string[] = [];
  for (const name of zipListNames(buf)) {
    if (/^word\/diagrams\/data\d+\.xml$/i.test(name)) {
      const data = zipReadEntry(buf, name);
      if (!data) continue;
      const texts = (data.toString('utf-8').match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map(t => decodeXmlEntities(t.replace(/<\/?a:t>/g, '')).trim()).filter(Boolean);
      if (texts.length) out.push(texts.join('\n'));
    }
  }
  return out;
}

function fromDocx(buf: Buffer): { html: string; text: string } {
  const main = zipReadEntry(buf, 'word/document.xml');
  if (!main) return { html: '', text: '' };
  const documentNode = descend(parseXml(main.toString('utf-8')), 'w:document');
  const body = documentNode ? descend(documentNode, 'w:body') : undefined;
  if (!body) return { html: '', text: '' };
  const ctx: DocxCtx = { buf, rels: parseRels(buf), diagrams: extractDiagrams(buf), diagramUsed: 0, embeddedBytes: 0 };
  const { html, text } = bodyToHtmlText(body, ctx);
  return { html: html.replace(/(?:<p><\/p>){2,}/g, '<p></p>'), text: text.replace(/\n{3,}/g, '\n\n').trim() };
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// Best-effort text layer extraction: inflate FlateDecode content streams and
// pull the strings fed to the Tj / TJ text-showing operators.
function fromPdf(buf: Buffer): { text: string; pageCount: number | null } {
  const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || null;
  const chunks: string[] = [];
  let idx = 0;
  const len = buf.length;
  while (idx < len) {
    const s = buf.indexOf('stream', idx);
    if (s < 0) break;
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const e = buf.indexOf('endstream', dataStart);
    if (e < 0) break;
    const raw = buf.subarray(dataStart, e);
    idx = e + 9;
    let decoded: Buffer | null = null;
    try { decoded = zlib.inflateSync(raw); } catch {
      try { decoded = zlib.inflateRawSync(raw); } catch { decoded = null; }
    }
    if (!decoded) continue;
    const piece = extractPdfTextOperators(decoded.toString('latin1'));
    if (piece.trim()) chunks.push(piece);
  }
  const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pageCount };
}

function pdfUnescape(s: string): string {
  return s.replace(/\\([nrtbf()\\])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? c)
    .replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
}

function extractPdfTextOperators(content: string): string {
  const out: string[] = [];
  // Tokenise text-showing operators. Handles (string) Tj and [ (a) -10 (b) ] TJ.
  const re = /\((?:[^()\\]|\\.)*\)\s*Tj|\[(?:[^\]\\]|\\.)*\]\s*TJ|\bT\*|\bTd\b|\bTD\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const tok = m[0];
    if (tok === 'T*' || /Td$|TD$/.test(tok)) { out.push('\n'); continue; }
    if (/\]\s*TJ$/.test(tok)) {
      const inner = tok.replace(/\s*TJ$/, '');
      const strs = inner.match(/\((?:[^()\\]|\\.)*\)/g) || [];
      out.push(strs.map(x => pdfUnescape(x.slice(1, -1))).join(''));
    } else {
      const str = tok.replace(/\s*Tj$/, '');
      out.push(pdfUnescape(str.slice(1, -1)));
    }
  }
  return out.join('').replace(/\n{2,}/g, '\n');
}

// ── Section parsing (SOP structure) ──────────────────────────────────────────
// Recognised controlled-document section headings (ISO 15189 SOP template).
const SECTION_PATTERNS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'purpose', label: 'Purpose', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(purpose|objective)\b/i },
  { key: 'scope', label: 'Scope', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(scope)\b/i },
  { key: 'responsibility', label: 'Responsibility', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(responsibilit(?:y|ies))\b/i },
  { key: 'definitions', label: 'Terms & Definitions', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(terms|definitions|abbreviations)\b/i },
  { key: 'materials', label: 'Materials & Equipment', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(materials|equipment|reagents|specimen)\b/i },
  { key: 'procedure', label: 'Procedure', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(procedure|activity description|method|process|work instruction)\b/i },
  { key: 'quality', label: 'Quality Control', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(quality control|safety)\b/i },
  { key: 'references', label: 'References', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(references?)\b/i },
  { key: 'records', label: 'Records', re: /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(records?|appendix|attachments?)\b/i },
];

// Combined heading detector usable both at line-start and inline (PDF text
// layers frequently lose the line breaks that precede a heading).
const HEADING_KEYWORDS: Array<{ key: string; label: string; words: string }> = [
  { key: 'purpose', label: 'Purpose', words: 'PURPOSE|OBJECTIVE' },
  { key: 'scope', label: 'Scope', words: 'SCOPE' },
  { key: 'responsibility', label: 'Responsibility', words: 'RESPONSIBILITY|RESPONSIBILITIES' },
  { key: 'definitions', label: 'Terms & Definitions', words: 'TERMS AND DEFINITIONS|TERMS & DEFINITIONS|DEFINITIONS|ABBREVIATIONS' },
  { key: 'materials', label: 'Materials & Equipment', words: 'MATERIALS|EQUIPMENT AND MATERIALS|REAGENTS|SPECIMEN REQUIREMENTS' },
  { key: 'procedure', label: 'Procedure', words: 'ACTIVITY DESCRIPTION|PROCEDURE|METHODOLOGY|METHOD|WORK INSTRUCTION' },
  { key: 'quality', label: 'Quality & Safety', words: 'QUALITY CONTROL|SAFETY' },
  { key: 'references', label: 'References', words: 'REFERENCES|REFERENCE' },
  { key: 'records', label: 'Records', words: 'RECORDS|APPENDIX|ATTACHMENTS|RELATED DOCUMENTS' },
];

function parseSections(text: string): ExtractedSection[] {
  if (!text.trim()) return [];
  // Build one alternation that anchors on an optional clause number (e.g. "5.0",
  // "5.1.2") OR a word boundary, immediately followed by a known heading word and
  // a separator (colon, newline, or the start of the next sentence).
  const alt = HEADING_KEYWORDS.map(h => `(?<${h.key}>(?:\\d+(?:\\.\\d+)*\\.?\\s*)?(?:${h.words}))\\b\\s*:?`).join('|');
  const re = new RegExp(`(?:^|\\n|\\.|\\s)(?:${alt})`, 'gi');
  type Hit = { key: string; label: string; start: number; end: number };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const g = m.groups || {};
    const found = HEADING_KEYWORDS.find(h => g[h.key]);
    if (found) hits.push({ key: found.key, label: found.label, start: m.index, end: re.lastIndex });
  }
  if (!hits.length) return [];
  // Each heading's body runs from the end of its match to the start of the next
  // heading match in document order. Keep only the first occurrence of each key.
  const sections: ExtractedSection[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < hits.length; i++) {
    if (seen.has(hits[i].key)) continue;
    seen.add(hits[i].key);
    const bodyStart = hits[i].end;
    const next = hits.find(h => h.start > bodyStart);
    const body = text.slice(bodyStart, next ? next.start : text.length).replace(/\n{3,}/g, '\n\n').trim();
    if (body) sections.push({ key: hits[i].key, heading: hits[i].label, body: body.slice(0, 8000) });
  }
  return sections;
}

function guessTitleAndCode(text: string, fallbackName: string): { title: string | null; code: string | null } {
  const code = deriveDocumentCodeFromName(`${text.slice(0, 400)} ${fallbackName}`);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let title: string | null = null;
  for (const l of lines.slice(0, 12)) {
    if (l.length >= 6 && l.length <= 90 && /[a-z]/i.test(l) && !/^st\.?\s/i.test(l) && !/document number|date of issue|version|confidential/i.test(l)) {
      title = l.replace(/\s+/g, ' ');
      break;
    }
  }
  return { title, code };
}

/**
 * Derive a document control number from a document name/heading. SECH codes look
 * like SECHPO026, SECHF001, SECHSOPHA001, SECHQM, SECHHB, SECHSM, SECHML00.
 * e.g. "SECHPO026 Document Control Procedure" -> "SECHPO026".
 */
export function deriveDocumentCodeFromName(name: string): string | null {
  if (!name) return null;
  const cleaned = name.replace(/\.[a-z0-9]+$/i, ' ');
  const patterns = [
    /\bSECH(?:SOP[A-Z]{0,3}|PO|F|ML|QM|HB|SM)\s?-?\s?\d{1,4}[A-Z]?\b/i,
    /\bSECH(?:QM|HB|SM)\b/i,
    /\b[A-Z]{2,5}[-\s]?\d{2,4}[A-Z]?\b/,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m) return m[0].replace(/\s+/g, '').toUpperCase();
  }
  return null;
}

function buildHtml(sections: ExtractedSection[], text: string): string {
  if (sections.length) {
    return sections.map(s =>
      `<h3>${htmlEscape(s.heading)}</h3>\n<p>${htmlEscape(s.body).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`
    ).join('\n');
  }
  if (!text.trim()) return '';
  return `<p>${htmlEscape(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;
}

/**
 * Extract content from a file on disk. `originalName` and `mimeType` choose the
 * parser; extraction is best-effort and never throws.
 */
export function extractDocument(filePath: string, originalName: string, mimeType?: string | null): ExtractionResult {
  const ext = (originalName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  let buf: Buffer;
  try { buf = fs.readFileSync(filePath); } catch { return EMPTY('unreadable'); }

  let text = '';
  let htmlOverride: string | null = null;
  let pageCount: number | null = null;
  let method = 'none';
  try {
    if (ext === 'pdf' || mimeType === 'application/pdf') {
      const r = fromPdf(buf); text = r.text; pageCount = r.pageCount; method = 'pdf';
    } else if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const r = fromDocx(buf); text = r.text; htmlOverride = r.html || null; method = 'docx';
    } else if (['txt', 'md', 'csv', 'log', 'rtf'].includes(ext) || (mimeType && mimeType.startsWith('text/'))) {
      text = fromPlainText(buf); method = 'text';
      if (ext === 'rtf') text = text.replace(/\\par[d]?/g, '\n').replace(/\{\\[^}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').trim();
    } else {
      // Unknown binary (e.g. legacy .doc) — try plain text as a last resort.
      const guess = fromPlainText(buf).replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, ' ');
      if (guess.replace(/\s/g, '').length > 40) { text = guess; method = 'binary-text'; }
    }
  } catch { /* best-effort */ }

  text = (text || '').replace(/ /g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const sections = parseSections(text);
  // For Word, keep the high-fidelity HTML (tables, headings, lists, formatting);
  // otherwise synthesise HTML from the parsed sections / plain text.
  const html = htmlOverride ?? buildHtml(sections, text);
  const { title, code } = guessTitleAndCode(text, originalName);
  return { text, html, sections, pageCount, method, titleGuess: title, documentCodeGuess: code };
}
