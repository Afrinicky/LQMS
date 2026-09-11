/**
 * THE WORKLIST — every control that triggers a write and is not behind a gate.
 *
 * The access audits assert rules; this answers the blunter question: which
 * buttons, menu items and forms in the interface would a person be shown, click,
 * and then be refused? It finds the handler behind each control, follows it to
 * the API endpoint it calls, reads the guard the SERVER puts on that endpoint,
 * and reports the exact `can(key, action)` the control is missing.
 *
 * That derivation is why the gates are right: they are not a guess about what a
 * control ought to need, they are what the API will actually ask for.
 *
 *   node scripts/access-scan-controls.mjs
 *
 * A control it cannot resolve is reported as `(?)` — usually self-service (your
 * own profile, your own inbox), which is guarded inside the handler against the
 * caller's own record rather than by a permission.
 */
import fs from 'fs'; import path from 'path';
// The server's own guard table, read from source so it can never go stale.
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

// Match a client path (template literal, params interpolated) to a server route.
function lookup(method, clientPath) {
  const cp = clientPath.replace(/\$\{[^}]*\}/g, ':x').replace(/\?.*$/, '').replace(/\/+$/,'') || '/';
  const cparts = cp.split('/').filter(Boolean);
  let best = null;
  for (const r of table) {
    if (r.verb !== method) continue;
    const rparts = r.path.split('/').filter(Boolean);
    if (rparts.length !== cparts.length) continue;
    let score = 0, ok = true;
    for (let i=0;i<rparts.length;i++){
      if (rparts[i].startsWith(':')) { score += 1; continue; }
      if (cparts[i] === ':x') { score += 1; continue; }
      if (rparts[i] !== cparts[i]) { ok = false; break; }
      score += 3;
    }
    if (!ok) continue;
    if (!best || score > best.score) best = { ...r, score, tiedWith: [] };
    else if (score === best.score) best.tiedWith.push(r);
  }
  // A path with more than one interpolated segment can match several routes
  // equally well. `/equipment/${id}/${recordsPath}` scores the same against
  // /equipment/:id/verifications as against /equipment/register/import, and
  // picking whichever was found first then reports a confident mismatch
  // against a route the control never calls — which is an invitation to
  // "fix" correct code to match a wrong answer. A tie between routes that
  // want DIFFERENT rights is not a match; it is a question, and the caller
  // treats an unresolved lookup as ungated rather than mis-gated.
  if (best && best.tiedWith.some(r => `${r.key}:${r.action}` !== `${best.key}:${best.action}`)) return null;
  return best;
}


/**
 * Where the function starting at `from` actually ends.
 *
 * Walks from its opening brace counting depth, stepping over strings, template
 * literals and comments so a `}` inside one of them does not end the function
 * early. Falls back to `limit` if the braces never balance — a truncated body
 * is better than one that swallows the rest of the file.
 */
function bodyEnd(src, from, limit) {
  let i = src.indexOf('{', from);
  if (i < 0 || i >= limit) return limit;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i+1] === '/') { i = src.indexOf('\n', i); if (i < 0) return limit; continue; }
    if (c === '/' && src[i+1] === '*') { i = src.indexOf('*/', i); if (i < 0) return limit; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    // A regular expression literal, which may contain quotes of its own.
    // `/filename="?([^"]+)"?/` holds three double quotes; reading them as
    // string delimiters leaves the walk inside an imaginary string and the
    // function appears to run on for another thousand lines, swallowing every
    // handler defined below it. A `/` in one of these positions cannot be
    // division, so it opens a regex.
    if (c === '/' && /[(,=:[!&|?{;+\-*%^~<>]\s*$|\breturn\s*$/.test(src.slice(Math.max(0, i - 12), i))) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '\n') break;      // not a regex after all; give up on this line
        else if (src[i] === '/' && !inClass) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return limit;
}

function walk(d,acc=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,acc);else if(/\.tsx$/.test(e.name))acc.push(p);}return acc;}


// Does holding `asked` guarantee holding `needed`? A gate that is STRICTER than
// the endpoint behind it is a deliberate choice, not a hole — the button is
// simply offered to fewer people than the server would accept. A gate that is
// LOOSER is the bug: it shows a control to somebody the server will refuse.
//
// Two things make the guarantee:
//   · same area — every access level that grants `asked` also grants `needed`;
//   · a feature vs its module — any right on a feature implies view on the
//     module, because view is the floor and a module is the union of its
//     features.
const LEVEL_ACTIONS = {
  none: [], view: ['view','print'], contribute: ['view','print','create'],
  manage: ['view','print','create','edit','export'],
  full: ['view','print','create','edit','export','import','void_archive','approve'],
};
function implies(asked, needed) {
  if (asked === needed) return true;
  const [ak, aa] = asked.split(':'); const [nk, na] = needed.split(':');
  if (ak === nk) {
    const levels = Object.values(LEVEL_ACTIONS).filter(as => as.includes(aa));
    return levels.length > 0 && levels.every(as => as.includes(na));
  }
  return ak.startsWith(nk + '.') && na === 'view';
}

const out = [];
const misgated = [];
for (const f of walk('src')) {
  const src = fs.readFileSync(f,'utf8');
  const lines = src.split('\n');
  const fnRe = /(?:async\s+function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g;
  const marks = []; let m;
  while ((m = fnRe.exec(src))) marks.push({ name: m[1]||m[2], at: m.index });
  // fn name -> every definition of that name, with where it starts.
  //
  // Keyed by name ALONE, a file holding six `submit` functions kept only the
  // last, and every `onSubmit={submit}` in the file was attributed to it. In
  // Phase3Pages that meant the equipment competence form was judged against
  // the safety-incidents endpoint — so a form gated on the WRONG right read as
  // correct, and correcting the right read as the bug. The definition nearest
  // above the control is the one that control refers to, so all of them are
  // kept and the nearest is chosen at match time.
  const writerCalls = new Map(); // fn -> [{ at, calls: [{method,path}] }]
  marks.forEach((mk,i)=>{
    // The function's ACTUAL end, by matching braces, not "wherever the next
    // thing that looks like a definition starts". The regex above only spots
    // `function x` and `const x = (`, so a handler followed by `const facts =
    // [...]` and then several hundred lines of JSX had all of it counted as its
    // body — including the api calls of handlers defined further down. That is
    // what made a form that only ever PUTs an item read as if it also reversed
    // a batch, and reported a mismatch against a route it never calls.
    const body = src.slice(mk.at, bodyEnd(src, mk.at, i+1<marks.length?marks[i+1].at:src.length));
    const calls = [];
    for (const c of body.matchAll(/api[<(][^'"`]*['"`]([^'"`]+)['"`][\s\S]{0,120}?method:\s*'(POST|PUT|PATCH|DELETE)'/g)) calls.push({method:c[2],path:c[1]});
    for (const c of body.matchAll(/fetch\(`?\$?\{?API_BASE\}?([^'"`]*)['"`,][\s\S]{0,120}?method:\s*'(POST|PUT|PATCH|DELETE)'/g)) calls.push({method:c[2],path:c[1]});
    if (calls.length) (writerCalls.get(mk.name) ?? writerCalls.set(mk.name, []).get(mk.name)).push({ at: mk.at, calls });
  });

  // Character offset of the start of each line, so "nearest definition above
  // this control" can be answered.
  const lineAt = [];
  { let n = 0; for (const l of lines) { lineAt.push(n); n += l.length + 1; } }
  const callsFor = (name, lineIndex) => {
    const defs = writerCalls.get(name) ?? [];
    const here = lineAt[lineIndex] ?? 0;
    const above = defs.filter(d => d.at <= here);
    return (above.length ? above[above.length - 1] : defs[0]).calls;
  };

  lines.forEach((line,i)=>{
    if (!/<button|<form|role="menuitem"|onSubmit=|onClick=/.test(line)) return;
    let fn = null;
    for (const w of writerCalls.keys()) if (new RegExp(`[^\\w$]${w}\\s*[(),}]|=\\{${w}\\}`).test(line)) { fn = w; break; }
    if (!fn) return;
    const ctx = lines.slice(Math.max(0,i-3), i+1).join('\n');
    const gates = new Set();
    for (const c of callsFor(fn, i)) {
      const r = lookup(c.method, c.path);
      if (r?.key && r.action && !['ADMIN','RESOLVED'].includes(r.action)) gates.add(`${r.key}:${r.action}`);
      else if (r) gates.add(`(${r.action ?? 'unguarded'})`);
      else gates.add('(?)');
    }
    const guarded = /\bcan\(|\bcanView\(|\bmay[A-Z]\w*|\bcan[A-Z]\w*|<Can\b|isAdmin|editable|permitted/.test(ctx);
    if (guarded) {
      // A gate that is present but asks the wrong question is worse than none:
      // it reads as deliberate. Only literal `can('key','action')` gates can be
      // compared — a derived boolean (canEdit, mayImport) is decided elsewhere.
      const derived = /\bcanView\(|\bmay[A-Z]\w*|\bcan[A-Z]\w*|<Can\b|isAdmin|editable|permitted/.test(line)
        // A key held in a constant (`can(ENV, 'import')`) cannot be compared here.
        || /\bcan\(\s*[A-Za-z_$]/.test(line);
      if (derived) return;
      // Only the gate ON the control's own line: a neighbour's gate says
      // nothing about this one.
      const asked = new Set([...line.matchAll(/can\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)].map(m => `${m[1]}:${m[2]}`));
      if (asked.size === 0) return;
      const exact = [...gates].filter(g => !g.startsWith('('));
      if (exact.length === 0) return;
      const missing = exact.filter(g => ![...asked].some(a => implies(a, g)));
      if (missing.length === 0) return;
      misgated.push({ file:f, line:i+1, fn, asked:[...asked], needs: missing, text: line.trim().slice(0,90) });
      return;
    }
    out.push({ file:f, line:i+1, fn, gates:[...gates], text: line.trim().slice(0,90) });
  });
}
const resolved = out.filter(o=>o.gates.every(g=>!g.startsWith('(')));
console.log(`${out.length} ungated controls; ${resolved.length} resolve to an exact gate`);
console.log(`${misgated.length} controls carry a gate that asks for the wrong right\n`);
for (const m of misgated) console.log(`  ${m.file}:${m.line}  asks ${m.asked.join(' + ')} — server wants ${m.needs.join(' + ')}\n      ${m.text}`);
if (misgated.length) console.log('');
const byFile={}; for(const o of out)(byFile[o.file]??=[]).push(o);
for (const [f,rs] of Object.entries(byFile).sort((a,b)=>b[1].length-a[1].length)) {
  const res = rs.filter(r=>r.gates.every(g=>!g.startsWith('(')));
  console.log(`${String(rs.length).padStart(3)} (${res.length} exact)  ${f}`);
}
fs.writeFileSync('/tmp/sechlims-ungated-controls.json', JSON.stringify(out, null, 1));
if (resolved.length > 0 || misgated.length > 0) process.exit(1);
