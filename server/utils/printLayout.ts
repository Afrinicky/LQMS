import { getDb } from '../db/database.js';

/**
 * The shared look of every printable personnel record.
 *
 * A competency record and an appraisal end up in the same staff file, are read
 * by the same head of department and are shown to the same assessor, so they
 * are laid out identically: A4, the laboratory's name at the top, a metadata
 * block, then the body, then the signature strip. Only the body differs.
 */

export function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Free text keeps its line breaks on paper; an empty value prints as a dash. */
export function htmlText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '<span class="none">—</span>';
  return htmlEscape(text).replace(/\r?\n/g, '<br/>');
}

export function facilityName(): string {
  try {
    const row = getDb().prepare('SELECT facility_name FROM laboratory_profile WHERE id = 1').get() as { facility_name?: string } | undefined;
    return row?.facility_name || 'Laboratory';
  } catch {
    return 'Laboratory';
  }
}

export function printedAt(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

/** A signature block: a ruled line, a printed name and a date field. */
export function signatureBlock(role: string, name?: string | null, dated?: string | null): string {
  return `<div class="sign">
  <div class="rule">${name ? htmlEscape(name) : ''}</div>
  <div class="role">${htmlEscape(role)}</div>
  <div class="date">Signature: ______________________ &nbsp; Date: ${dated ? htmlEscape(String(dated).slice(0, 10)) : '____________'}</div>
</div>`;
}

const STYLES = `@page { size: A4; margin: 13mm; }
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; color: #16202e; margin: 0; padding: 20px 26px; font-size: 11.5px; line-height: 1.45; }
.toolbar { background: #eef3fb; border: 1px solid #c9d8ef; border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; font-size: 11.5px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.toolbar button { font: inherit; padding: 5px 14px; border: 1px solid #1B3A6B; background: #1B3A6B; color: #fff; border-radius: 4px; cursor: pointer; }
.toolbar a { color: #1B3A6B; font-size: 11px; }
.sheet-head { border-bottom: 2px solid #1B3A6B; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; }
.sheet-head .facility { font-size: 15px; font-weight: 700; color: #1B3A6B; letter-spacing: 0.01em; }
.sheet-head .doc-title { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.09em; color: #40546f; margin-top: 2px; }
.sheet-head .ref { text-align: right; font-size: 10.5px; color: #5a6b80; white-space: nowrap; }
.sheet-head .ref strong { display: block; font-size: 13px; color: #16202e; letter-spacing: 0.02em; }
h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.08em; color: #1B3A6B; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #c9d8ef; page-break-after: avoid; }
h3 { font-size: 11px; margin: 12px 0 4px; color: #2c3d55; page-break-after: avoid; }
p { margin: 4px 0; }
table { border-collapse: collapse; width: 100%; font-size: 10.5px; margin: 4px 0 10px; }
th, td { border: 1px solid #b3c1d4; padding: 4px 7px; text-align: left; vertical-align: top; }
thead th { background: #eef3fb; font-weight: 600; color: #24354b; }
tbody tr.group-row td { background: #f5f8fd; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; font-size: 10px; color: #1B3A6B; }
table.meta th { background: #f5f8fd; width: 17%; font-weight: 600; }
table.meta td { width: 33%; }
.scores { display: flex; gap: 10px; margin: 6px 0 12px; flex-wrap: wrap; }
.score-box { border: 1px solid #b3c1d4; border-radius: 5px; padding: 7px 12px; min-width: 108px; }
.score-box .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.07em; color: #64748b; }
.score-box .value { font-size: 17px; font-weight: 700; color: #1B3A6B; margin-top: 1px; }
.score-box .sub { font-size: 9.5px; color: #64748b; }
.narrative { border: 1px solid #b3c1d4; border-radius: 5px; padding: 8px 10px; min-height: 46px; margin: 4px 0 10px; }
.none { color: #94a3b8; }
.tick { text-align: center; font-weight: 700; }
.signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 26px; page-break-inside: avoid; }
.signatures.two { grid-template-columns: repeat(2, 1fr); }
.sign .rule { border-bottom: 1px solid #16202e; min-height: 22px; font-weight: 600; padding-bottom: 2px; }
.sign .role { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-top: 3px; }
.sign .date { font-size: 9.5px; color: #40546f; margin-top: 8px; }
.sheet-foot { margin-top: 22px; border-top: 1px solid #c9d8ef; padding-top: 5px; font-size: 9.5px; color: #64748b; display: flex; justify-content: space-between; gap: 16px; }
.legend { font-size: 9.5px; color: #4a5b70; margin: 2px 0 10px; }
.page-break { page-break-before: always; }
@media print { .toolbar { display: none; } body { padding: 0; } }`;

/**
 * Wrap a body in the printable sheet. `autoprint=0` on the query string opens
 * the sheet without firing the print dialog, which is what somebody reading it
 * on screen wants.
 */
export function printSheet(options: {
  title: string;
  documentTitle: string;
  reference?: string | null;
  referenceLabel?: string;
  body: string;
  autoprint?: boolean;
  footerNote?: string;
}): string {
  const autoprint = options.autoprint === false
    ? ''
    : '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 300); });</script>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${htmlEscape(options.title)}</title>
<style>${STYLES}</style>${autoprint}</head>
<body>
<div class="toolbar">
  <span>Choose any installed printer, or <strong>Save as PDF</strong> as the destination.</span>
  <button type="button" onclick="window.print()">Print</button>
  <a href="?autoprint=0">Open without printing</a>
</div>
<div class="sheet-head">
  <div>
    <div class="facility">${htmlEscape(facilityName())}</div>
    <div class="doc-title">${htmlEscape(options.documentTitle)}</div>
  </div>
  <div class="ref">${options.reference ? `<strong>${htmlEscape(options.reference)}</strong>${htmlEscape(options.referenceLabel || 'Record number')}` : ''}</div>
</div>
${options.body}
<div class="sheet-foot">
  <span>${htmlEscape(options.footerNote || 'Confidential personnel record — retain in the staff file.')}</span>
  <span>Printed ${htmlEscape(printedAt())}</span>
</div>
</body></html>`;
}
