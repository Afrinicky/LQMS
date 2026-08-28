/**
 * THE READ WORKLIST — every screen that asks the server for something the
 * person looking at it may not have.
 *
 * A module page loads by firing a handful of GETs at once. Each of those GETs
 * carries its own guard on the server, so a person who may see the module but
 * not one item inside it gets a 403 back — and the page paints a red
 * "Permission denied" across the whole module, for a restriction that was
 * supposed to hide one feature.
 *
 * This finds those loaders: a fetch whose guard differs from the module the
 * screen belongs to, and a `Promise.all` that will lose every result because
 * one member of it was refused.
 *
 *   node scripts/access-scan-reads.mjs
 */
import fs from 'fs'; import path from 'path';

const table = (() => {
  const idx = fs.readFileSync('server/index.ts', 'utf8');
  const mounts = {}, factoryFile = {};
  for (const m of idx.matchAll(/app\.use\('(\/api[^']*)',\s*([A-Za-z_$][\w$]*)\(?\)?\)/g)) (mounts[m[2]] ??= []).push(m[1].replace(/^\/api/, ''));
  for (const m of idx.matchAll(/import \{ ([A-Za-z_$][\w$]*) \} from '\.\/routes\/([\w.]+)\.js'/g)) factoryFile[m[1]] = m[2] + '.ts';
  const out = [];
  for (const [factory, prefixes] of Object.entries(mounts)) {
    const file = factoryFile[factory];
    if (!file) continue;
    const fp = path.join('server/routes', file);
    if (!fs.existsSync(fp)) continue;
    const src = fs.readFileSync(fp, 'utf8');
    const consts = {};
    for (const c of src.matchAll(/const\s+([A-Z_][A-Z_0-9]*)\s*=\s*'([^']+)'/g)) consts[c[1]] = c[2];
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`](.*)$/);
      if (!m) return;
      const w = [m[3], lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
      const g = w.match(/requirePermission\(\s*([A-Z_0-9]+|'[^']+')\s*,\s*'([^']+)'/);
      let key = g ? g[1].replace(/'/g, '') : null;
      if (key && consts[key]) key = consts[key];
      const action = g ? g[2] : (/requireAdministrator/.test(w) ? 'ADMIN' : /requireResolvedPermission/.test(w) ? 'RESOLVED' : null);
      for (const p2 of prefixes) out.push({ verb: m[1].toUpperCase(), path: (p2 + (m[2] === '/' ? '' : m[2])) || '/', key, action, file });
    });
  }
  return out;
})();

function lookup(method, clientPath) {
  const cp = clientPath.replace(/\$\{[^}]*\}/g, ':x').replace(/\?.*$/, '').replace(/\/+$/, '') || '/';
  const cparts = cp.split('/').filter(Boolean);
  let best = null;
  for (const r of table) {
    if (r.verb !== method) continue;
    const rparts = r.path.split('/').filter(Boolean);
    if (rparts.length !== cparts.length) continue;
    let score = 0, ok = true;
    for (let i = 0; i < rparts.length; i++) {
      if (rparts[i].startsWith(':')) { score += 1; continue; }
      if (cparts[i] === ':x') { score += 1; continue; }
      if (rparts[i] !== cparts[i]) { ok = false; break; }
      score += 3;
    }
    if (!ok) continue;
    if (!best || score > best.score) best = { ...r, score };
  }
  return best;
}

function walk(d, acc = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else if (/\.tsx?$/.test(e.name)) acc.push(p); } return acc; }

// Every `api<T>('/path')` with no method: option — i.e. a read.
const reads = [];
for (const f of walk('src')) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/api(?:<[^(]*?>)?\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const after = line.slice(m.index, m.index + 300);
      if (/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(after)) continue;
      const r = lookup('GET', m[1]);
      reads.push({ file: f, line: i + 1, path: m[1], key: r?.key ?? null, action: r?.action ?? null, guarded: Boolean(r), text: line.trim().slice(0, 110) });
    }
  });
}

// A loader is a try-block or Promise.all whose members carry more than one
// distinct guard: refuse one and the screen loses the lot.
const byFile = {};
for (const r of reads) (byFile[r.file] ??= []).push(r);

let mixed = 0;
const report = [];
for (const [f, rs] of Object.entries(byFile)) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  // group reads that sit inside the same Promise.all([...]) span
  const groups = [];
  src.forEach((line, i) => {
    if (!/Promise\.all\(\[/.test(line)) return;
    let depth = 0, end = i;
    for (let j = i; j < Math.min(src.length, i + 40); j++) {
      for (const ch of src[j]) { if (ch === '[') depth++; else if (ch === ']') depth--; }
      end = j; if (depth <= 0 && j > i) break;
    }
    groups.push({ from: i + 1, to: end + 1 });
  });
  for (const g of groups) {
    const members = rs.filter(r => r.line >= g.from && r.line <= g.to);
    const keys = [...new Set(members.map(r => r.key ?? '(open)'))];
    if (keys.length < 2) continue;
    // A member is safe if a refusal cannot reach the loader's catch: apiRead
    // answers with a fallback, and a member with its own .catch handles itself.
    const bare = members.filter(m => {
      const line = src[m.line - 1] ?? '';
      return !/\bapiRead[<(]/.test(line) && !/\.catch\(/.test(line);
    });
    mixed++;
    report.push({ file: f, from: g.from, to: g.to, keys, members, bare });
  }
}

const exposed = report.filter(r => r.bare.length > 0);
console.log(`${reads.length} reads found; ${reads.filter(r => r.key).length} resolve to a guard`);
console.log(`${mixed} Promise.all loaders mix guards; ${exposed.length} would still lose the module on one refusal\n`);
for (const r of report.sort((a, b) => b.bare.length - a.bare.length || b.keys.length - a.keys.length)) {
  console.log(`${r.bare.length ? 'EXPOSED' : '     ok'}  ${r.file}:${r.from}  ${r.keys.join(' + ')}`);
  for (const m of r.bare) console.log(`          ${m.line}: ${m.path}`);
}
fs.writeFileSync('/tmp/sechlims-reads.json', JSON.stringify({ reads, report }, null, 1));
if (exposed.length > 0) process.exit(1);
