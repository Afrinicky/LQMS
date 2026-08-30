/**
 * Text boxes still bound straight to their page's state.
 *
 * This is the shape that made typing in SECH_LIMS feel broken. A register here
 * is one enormous page component holding a dozen tabs, a form and a table.
 * Bound the obvious way —
 *
 *     <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
 *
 * — every character typed sets state on that page component, so React re-runs
 * the whole page before the letter can be painted: every closure rebuilt, every
 * tab's JSX re-evaluated, every row reconciled. On a real register that is
 * hundreds of milliseconds per keystroke, and it does not look slow, it looks
 * frozen. People retype, give up, and restart the application.
 *
 * `TextField` fixes it by holding what is typed in a component of its own and
 * telling the page once typing pauses. This audit finds the boxes that have not
 * been moved over yet, worst page first — a raw box on a 3,000-line page is a
 * freeze waiting to be reported, and a raw box in a 60-line dialog is fine.
 *
 * Dates, numbers, checkboxes, radios, files and colour pickers are ONE
 * interaction rather than a stream of them, so they stay bound directly and are
 * not counted.
 *
 *   node scripts/typing-audit.mjs           report
 *   node scripts/typing-audit.mjs --check    fail if a large page has any
 */
import fs from 'fs';
import path from 'path';

const ROOT = 'src';
const DISCRETE = new Set(['date', 'datetime-local', 'time', 'month', 'week', 'checkbox', 'radio',
  'file', 'color', 'range', 'password', 'hidden', 'submit', 'button', 'number']);

/** A page big enough that a keystroke re-rendering it is felt. */
const BIG_PAGE_LINES = 400;

/**
 * The two boxes that are supposed to be bound directly, and why.
 *
 * Both already hold their own text — they ARE the pattern TextField packages —
 * and both would be made worse by a debounce: a search box filters as you type,
 * and a barcode box receives a whole code from a scanner as one burst and must
 * act on the terminator immediately.
 */
const BY_DESIGN = new Map([
  ['src/components/ui/RegisterSearch.tsx', 'holds its own text already; this is the component TextField was modelled on'],
  ['src/components/BarcodeScanner.tsx', 'a scanner delivers a whole code at once and the terminator must act immediately'],
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** The whole of an <input …> or <textarea …> opening tag, brace-aware. */
function* tags(src) {
  const open = /<(input|textarea)\b/g;
  let m;
  while ((m = open.exec(src))) {
    let i = m.index + m[0].length, depth = 0, quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    yield { kind: m[1], tag: src.slice(m.index, i + 1), at: m.index };
    open.lastIndex = i + 1;
  }
}

const findings = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n').length;
  for (const { kind, tag, at } of tags(src)) {
    if (!/\bvalue=/.test(tag) || !/\bonChange=/.test(tag)) continue;
    const type = tag.match(/type="([^"]+)"/)?.[1] ?? (kind === 'textarea' ? 'textarea' : 'text');
    if (DISCRETE.has(type)) continue;
    if (BY_DESIGN.has(file.split(path.sep).join('/'))) continue;
    findings.push({ file, lines, line: src.slice(0, at).split('\n').length, type });
  }
}

const byFile = new Map();
for (const f of findings) {
  const row = byFile.get(f.file) ?? { file: f.file, lines: f.lines, count: 0, at: [] };
  row.count++; row.at.push(f.line);
  byFile.set(f.file, row);
}
const rows = [...byFile.values()].sort((a, b) => (b.count * b.lines) - (a.count * a.lines));

console.log('Text boxes still bound directly to their page\n');
for (const [file, why] of BY_DESIGN) console.log(`  (allowed) ${file} — ${why}`);
console.log();
console.log(`${'raw'.padStart(4)} ${'page'.padStart(6)}  file`);
for (const r of rows) {
  const flag = r.lines >= BIG_PAGE_LINES ? ' <= on a large page' : '';
  console.log(`${String(r.count).padStart(4)} ${String(r.lines).padStart(6)}  ${r.file}${flag}`);
}
const onBigPages = rows.filter(r => r.lines >= BIG_PAGE_LINES);
const total = findings.length;
const bad = onBigPages.reduce((n, r) => n + r.count, 0);
console.log(`\n${total} raw text box(es) in ${rows.length} file(s); ${bad} of them on a page of ${BIG_PAGE_LINES}+ lines.`);

if (process.argv.includes('--check')) {
  if (bad > 0) {
    console.log('\nFAIL — a text box on a large page must use TextField, or typing in it will feel frozen.');
    process.exit(1);
  }
  console.log('\nPASS — no raw text boxes on large pages.');
}
