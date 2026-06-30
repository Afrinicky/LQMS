/**
 * Build a real, Word-openable .docx file from the controlled-document HTML
 * produced by the in-app editor (server/utils/documentExtract.ts reads the
 * other direction). This lets "Edit content" round-trip back out to a genuine
 * Word file instead of staying trapped as in-app HTML.
 *
 * Design constraints (matching documentExtract.ts):
 *  - No new runtime dependencies beyond `archiver`, which the app already
 *    depends on (lazily imported — see the comment on loadArchiver() in
 *    server/routes/common.ts for why this must stay a dynamic import).
 *  - Best-effort: covers the HTML subset the in-app Word-style toolbar and the
 *    docx reader can produce (headings, bold/italic/underline/strike, colour/
 *    highlight, font/size, alignment, lists, tables, links, hr, inline images
 *    from data: URIs). Anything else degrades to plain text rather than
 *    throwing, so an export can never corrupt a user's edits.
 */
import fs from 'node:fs';
import { createZipArchive } from './zipArchive.js';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Minimal HTML parser (tailored to our own editor/extractor output) ───────
type HNode = { tag: string; attrs: Record<string, string>; children: HNode[]; text?: string };
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'area', 'base', 'embed', 'source', 'track', 'wbr']);
function decodeHtmlEntities(s: string): string {
  return s.replace(/&nbsp;/gi, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
function parseHtmlFragment(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, children: [] };
  const stack: HNode[] = [root];
  const tagRe = /<!--[\s\S]*?-->|<(\/)?([A-Za-z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (m.index > last) {
      const txt = decodeHtmlEntities(html.slice(last, m.index));
      if (txt) stack[stack.length - 1].children.push({ tag: '#text', attrs: {}, children: [], text: txt });
    }
    last = tagRe.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1]; const name = (m[2] || '').toLowerCase(); const attrStr = m[3] || ''; const selfClose = m[4];
    if (closing) { for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tag === name) { stack.length = i; break; } } continue; }
    const attrs: Record<string, string> = {};
    const aRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let am: RegExpExecArray | null;
    while ((am = aRe.exec(attrStr))) attrs[am[1].toLowerCase()] = decodeHtmlEntities(am[2] ?? am[3] ?? am[4] ?? '');
    const node: HNode = { tag: name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID_TAGS.has(name)) stack.push(node);
  }
  if (last < html.length) {
    const txt = decodeHtmlEntities(html.slice(last));
    if (txt) stack[stack.length - 1].children.push({ tag: '#text', attrs: {}, children: [], text: txt });
  }
  return root;
}

// ── CSS helpers ───────────────────────────────────────────────────────────
function styleMap(styleAttr?: string): Record<string, string> {
  const out: Record<string, string> = {};
  (styleAttr || '').split(';').forEach(rule => { const i = rule.indexOf(':'); if (i < 0) return; const k = rule.slice(0, i).trim().toLowerCase(); const v = rule.slice(i + 1).trim(); if (k && v) out[k] = v; });
  return out;
}
function cssColorToHex(v: string): string | null {
  const hex = v.match(/^#?([0-9a-fA-F]{6})$/); if (hex) return hex[1].toUpperCase();
  const hex3 = v.match(/^#([0-9a-fA-F]{3})$/); if (hex3) return hex3[1].split('').map(c => c + c).join('').toUpperCase();
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [1, 2, 3].map(i => Math.min(255, Number(rgb[i])).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}
const LEGACY_FONT_SIZE_PT: Record<string, number> = { '1': 8, '2': 10, '3': 12, '4': 14, '5': 18, '6': 24, '7': 36 };

// ── Inline run formatting (accumulated while descending the inline tree) ───
type RunStyle = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; color: string | null; highlight: string | null; font: string | null; halfPts: number | null; link: string | null; sub: boolean; sup: boolean };
const BLANK_STYLE: RunStyle = { bold: false, italic: false, underline: false, strike: false, color: null, highlight: null, font: null, halfPts: null, link: null, sub: false, sup: false };
function mergeStyle(base: RunStyle, node: HNode): RunStyle {
  const s: RunStyle = { ...base };
  const t = node.tag;
  if (t === 'b' || t === 'strong') s.bold = true;
  if (t === 'i' || t === 'em') s.italic = true;
  if (t === 'u') s.underline = true;
  if (t === 's' || t === 'strike' || t === 'del') s.strike = true;
  if (t === 'sub') s.sub = true;
  if (t === 'sup') s.sup = true;
  if (t === 'a' && node.attrs.href) s.link = node.attrs.href;
  if (t === 'font') {
    if (node.attrs.color) { const h = cssColorToHex(node.attrs.color); if (h) s.color = h; }
    if (node.attrs.size && LEGACY_FONT_SIZE_PT[node.attrs.size]) s.halfPts = LEGACY_FONT_SIZE_PT[node.attrs.size] * 2;
    if (node.attrs.face) s.font = node.attrs.face.split(',')[0].replace(/['"]/g, '').trim();
  }
  const css = styleMap(node.attrs.style);
  if (css.color) { const h = cssColorToHex(css.color); if (h) s.color = h; }
  if (css['background-color']) { const h = cssColorToHex(css['background-color']); if (h) s.highlight = h; }
  if (css['font-weight'] && (css['font-weight'] === 'bold' || Number(css['font-weight']) >= 600)) s.bold = true;
  if (css['font-style'] === 'italic') s.italic = true;
  if (css['text-decoration']?.includes('underline')) s.underline = true;
  if (css['text-decoration']?.includes('line-through')) s.strike = true;
  if (css['font-family']) s.font = css['font-family'].split(',')[0].replace(/['"]/g, '').trim();
  if (css['font-size']) {
    const v = css['font-size'];
    const num = parseFloat(v);
    if (Number.isFinite(num)) {
      if (v.includes('pt')) s.halfPts = Math.round(num * 2);
      else if (v.includes('px')) s.halfPts = Math.round(num * (72 / 96) * 2);
    }
  }
  return s;
}
function runPropsXml(s: RunStyle): string {
  const parts: string[] = [];
  if (s.link) parts.push('<w:rStyle w:val="Hyperlink"/>');
  if (s.bold) parts.push('<w:b/><w:bCs/>');
  if (s.italic) parts.push('<w:i/><w:iCs/>');
  if (s.font) parts.push(`<w:rFonts w:ascii="${escapeXml(s.font)}" w:hAnsi="${escapeXml(s.font)}" w:cs="${escapeXml(s.font)}"/>`);
  if (s.color) parts.push(`<w:color w:val="${s.color}"/>`);
  if (s.highlight) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${s.highlight}"/>`);
  if (s.underline) parts.push('<w:u w:val="single"/>');
  if (s.strike) parts.push('<w:strike/>');
  if (s.halfPts) parts.push(`<w:sz w:val="${s.halfPts}"/><w:szCs w:val="${s.halfPts}"/>`);
  if (s.sup) parts.push('<w:vertAlign w:val="superscript"/>');
  if (s.sub) parts.push('<w:vertAlign w:val="subscript"/>');
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

// ── Image embedding (data: URIs only — anything else is skipped, never fetched) ──
type MediaAsset = { relId: string; partName: string; mime: string; bytes: Buffer };
function sniffImageSizePx(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) { return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }; } // PNG
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49) { return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) }; } // GIF
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) { // JPEG: scan markers for a SOF segment
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
      }
      const len = bytes.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }
  return null;
}
const EMU_PER_PX = 9525;
const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp' };
function imageDrawingXml(node: HNode, media: MediaAsset[]): string {
  const src = node.attrs.src || '';
  const m = src.match(/^data:([\w/+-]+);base64,(.+)$/s);
  if (!m) return ''; // never fetch remote URLs during export — offline-safe by design
  const mime = m[1]; const ext = MIME_EXT[mime];
  if (!ext) return '';
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 8_000_000) return '';
  const dims = sniffImageSizePx(bytes) || { w: 480, h: 320 };
  const maxW = 620; // keep inline images within a normal page's text width
  const scale = dims.w > maxW ? maxW / dims.w : 1;
  const cx = Math.round(dims.w * scale * EMU_PER_PX); const cy = Math.round(dims.h * scale * EMU_PER_PX);
  const idx = media.length + 1;
  const relId = `rIdImg${idx}`;
  media.push({ relId, partName: `media/image${idx}.${ext}`, mime, bytes });
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${idx}" name="Picture ${idx}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${idx}" name="Picture ${idx}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// ── Inline content → run XML ─────────────────────────────────────────────
type HyperlinkRel = { relId: string; url: string };
function inlineToRuns(node: HNode, style: RunStyle, media: MediaAsset[], links: HyperlinkRel[]): string {
  let out = '';
  for (const child of node.children) {
    if (child.tag === '#text') {
      const t = child.text || '';
      if (!t) continue;
      out += `<w:r>${runPropsXml(style)}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`;
    } else if (child.tag === 'br') {
      out += `<w:r>${runPropsXml(style)}<w:br/></w:r>`;
    } else if (child.tag === 'img') {
      out += imageDrawingXml(child, media);
    } else if (child.tag === 'a') {
      const next = mergeStyle(style, child);
      const inner = inlineToRuns(child, next, media, links);
      if (child.attrs.href) {
        const relId = `rIdLink${links.length + 1}`;
        links.push({ relId, url: child.attrs.href });
        out += `<w:hyperlink r:id="${relId}">${inner}</w:hyperlink>`;
      } else out += inner;
    } else {
      out += inlineToRuns(child, mergeStyle(style, child), media, links);
    }
  }
  return out;
}

// ── Block content → paragraph / table XML ────────────────────────────────
const HEADING_PT: Record<string, number> = { h1: 28, h2: 22, h3: 18, h4: 14, h5: 13, h6: 12 };
function blockAlign(node: HNode): string {
  const css = styleMap(node.attrs.style);
  const align = (node.attrs.align || css['text-align'] || '').toLowerCase();
  const map: Record<string, string> = { center: 'center', right: 'end', left: 'start', justify: 'both' };
  return map[align] ? `<w:jc w:val="${map[align]}"/>` : '';
}
function paragraphXml(node: HNode, media: MediaAsset[], links: HyperlinkRel[], extraRunProps?: RunStyle): string {
  const heading = HEADING_PT[node.tag];
  const baseStyle: RunStyle = extraRunProps ? { ...BLANK_STYLE, ...extraRunProps } : { ...BLANK_STYLE };
  if (heading) { baseStyle.bold = true; baseStyle.halfPts = heading * 2; }
  const runs = inlineToRuns(node, baseStyle, media, links);
  const pPr = blockAlign(node);
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs || `<w:r>${runPropsXml(baseStyle)}<w:t></w:t></w:r>`}</w:p>`;
}
function listParagraphXml(node: HNode, ordered: boolean, index: number, media: MediaAsset[], links: HyperlinkRel[]): string {
  const prefix = ordered ? `${index}. ` : '• ';
  const runs = inlineToRuns(node, BLANK_STYLE, media, links);
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="432" w:hanging="432"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(prefix)}</w:t></w:r>${runs}</w:p>`;
}
function tableXml(node: HNode, media: MediaAsset[], links: HyperlinkRel[]): string {
  const rows = node.children.filter(c => c.tag === 'tr' || (c.tag === 'tbody' || c.tag === 'thead')).flatMap(c => c.tag === 'tr' ? [c] : c.children.filter(cc => cc.tag === 'tr'));
  const borders = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') + '</w:tblBorders>';
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borders}</w:tblPr>`;
  for (const tr of rows) {
    xml += '<w:tr>';
    for (const tc of tr.children.filter(c => c.tag === 'td' || c.tag === 'th')) {
      const blockNodes = tc.children.filter(c => c.tag !== '#text' || (c.text || '').trim());
      const cellBody = blockNodes.length && blockNodes.some(c => c.tag === 'p' || /^h[1-6]$/.test(c.tag) || c.tag === 'ul' || c.tag === 'ol' || c.tag === 'table')
        ? blocksToXml(tc, media, links)
        : paragraphXml(tc, media, links);
      xml += `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${tc.attrs.style && /background-color/.test(tc.attrs.style) ? (cssColorToHex(styleMap(tc.attrs.style)['background-color'] || '') || 'auto') : 'auto'}"/></w:tcPr>${cellBody || '<w:p/>'}</w:tc>`;
    }
    xml += '</w:tr>';
  }
  xml += '</w:tbl>';
  return xml;
}
function blocksToXml(root: HNode, media: MediaAsset[], links: HyperlinkRel[]): string {
  let xml = '';
  for (const node of root.children) {
    if (node.tag === '#text') { if ((node.text || '').trim()) xml += `<w:p><w:r><w:t xml:space="preserve">${escapeXml(node.text || '')}</w:t></w:r></w:p>`; continue; }
    if (/^h[1-6]$/.test(node.tag)) { xml += paragraphXml(node, media, links); }
    else if (node.tag === 'p' || node.tag === 'div') { xml += paragraphXml(node, media, links); }
    else if (node.tag === 'ul' || node.tag === 'ol') {
      let i = 0;
      for (const li of node.children.filter(c => c.tag === 'li')) { i++; xml += listParagraphXml(li, node.tag === 'ol', i, media, links); }
    } else if (node.tag === 'table') { xml += tableXml(node, media, links); }
    else if (node.tag === 'hr') { xml += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>'; }
    else if (node.children.length) { xml += blocksToXml(node, media, links); }
  }
  return xml;
}

// ── Package parts ─────────────────────────────────────────────────────────
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Default Extension="bmp" ContentType="image/bmp"/>
<Default Extension="webp" ContentType="image/webp"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2F6BFF"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
function coreXml(title: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title><dc:creator>SECH_LIMS by Nickland</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}
const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SECH_LIMS by Nickland</Application></Properties>`;

export type DocxBuildResult = { mediaCount: number; linkCount: number };

/**
 * Build a .docx file at `outFilePath` from controlled-document HTML. Returns
 * basic stats; never throws for malformed HTML (degrades to plain paragraphs).
 */
export async function buildDocxFromHtml(outFilePath: string, html: string, title: string): Promise<DocxBuildResult> {
  const media: MediaAsset[] = [];
  const links: HyperlinkRel[] = [];
  let bodyXml = '';
  try {
    const root = parseHtmlFragment(html || '');
    bodyXml = blocksToXml(root, media, links);
  } catch { bodyXml = ''; }
  if (!bodyXml.trim()) bodyXml = '<w:p/>';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${media.map(m => `<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.partName}"/>`).join('\n')}
${links.map(l => `<Relationship Id="${l.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(l.url)}" TargetMode="External"/>`).join('\n')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outFilePath);
    createZipArchive({ zlib: { level: 9 } }).then(archive => {
      output.on('close', resolve); archive.on('error', reject); archive.pipe(output);
      archive.append(CONTENT_TYPES, { name: '[Content_Types].xml' });
      archive.append(PACKAGE_RELS, { name: '_rels/.rels' });
      archive.append(coreXml(title), { name: 'docProps/core.xml' });
      archive.append(APP_XML, { name: 'docProps/app.xml' });
      archive.append(documentXml, { name: 'word/document.xml' });
      archive.append(STYLES_XML, { name: 'word/styles.xml' });
      archive.append(docRels, { name: 'word/_rels/document.xml.rels' });
      for (const m of media) archive.append(m.bytes, { name: `word/${m.partName}` });
      archive.finalize();
    }).catch(reject);
  });
  return { mediaCount: media.length, linkCount: links.length };
}
