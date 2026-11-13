/**
 * One middleware, two products — enforced rather than remembered.
 *
 * TransLis is the analyser middleware standing on its own. It is not a fork:
 * the engine, the bridge, the transports, the safety rules, the Result Filler
 * services, the HTTP routers and every workspace section are IMPORTED from the
 * SECHLIMS tree. So an improvement to either product is an improvement to
 * both, which is the whole reason it was built this way.
 *
 * Nothing about that is self-enforcing. Somebody adding a section to the
 * workspace, mounting a new analyser route, or — worst — copying a component
 * into `translis/` to change one line would split the two products silently,
 * and the split would only be discovered by a laboratory running the one that
 * was left behind.
 *
 * This check is what makes the rule hold. It reads the source rather than
 * running anything, so it is fast enough to sit in the gate, and it fails with
 * the remedy rather than with a diff.
 *
 * WHAT IS DELIBERATELY NOT SHARED, and why:
 *
 *   The Dennis Assistant — the laboratory's own assistant reading the
 *   laboratory's own evidence. It belongs to a quality management system, not
 *   to a middleware dispatched to a facility that does not run one.
 *
 *   Each product's own shell, navigation, settings and accounts. TransLis has
 *   two kinds of account and a retention policy; SECHLIMS has twenty access
 *   profiles and twelve quality essentials. Those are not the same screens and
 *   were never meant to be.
 *
 * Anything else that differs is a defect, and this says so.
 *
 *   npm run check:translis-parity
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, remedy = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${remedy ? `\n        ${remedy}` : ''}`); }
};
const section = name => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

console.log('TransLis parity — one middleware, two products');

/* ========================================================================
   1. The workspace sections
   ===================================================================== */
section('The workspace carries the same sections');

/** The sections TransLis deliberately does not carry, with the reason. */
const NOT_IN_TRANSLIS = new Map([
  ['Dennis Assistant',
    'the laboratory’s own assistant, which belongs to a quality management system'],
]);

const tabsOf = (file, label) => {
  const source = read(file);
  const block = source.match(/const TABS = \[([\s\S]*?)\];/);
  if (!block) throw new Error(`${label}: no TABS array found in ${file}`);
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
};

const sechlims = tabsOf('src/pages/MiddlewarePage.tsx', 'SECHLIMS');
const translis = tabsOf('translis/src/pages/Workspace.tsx', 'TransLis');
const expected = sechlims.filter(t => !NOT_IN_TRANSLIS.has(t));

const missing = expected.filter(t => !translis.includes(t));
const extra = translis.filter(t => !sechlims.includes(t));
const excluded = translis.filter(t => NOT_IN_TRANSLIS.has(t));

check('every SECHLIMS section is in TransLis', missing.length === 0,
  missing.length
    ? `Add ${missing.map(t => `“${t}”`).join(', ')} to translis/src/pages/Workspace.tsx, `
      + 'or record it in NOT_IN_TRANSLIS here with the reason it does not belong there.'
    : '');

check('TransLis invents no section of its own', extra.length === 0,
  extra.length ? `“${extra.join('”, “')}” is in TransLis and not in SECHLIMS. `
    + 'A section worth having belongs in both — add it to src/pages/MiddlewarePage.tsx.' : '');

check('the sections run in the same order',
  translis.filter(t => expected.includes(t)).join('|') === expected.join('|'),
  'The order is the order the work is done in, and it should read the same in both.');

check('nothing excluded has crept back in', excluded.length === 0,
  excluded.length ? `“${excluded.join('”, “')}” is recorded as not belonging in TransLis.` : '');

for (const [tab, why] of NOT_IN_TRANSLIS) {
  check(`“${tab}” is still a SECHLIMS section`, sechlims.includes(tab),
    `It was removed from SECHLIMS, so the exclusion recorded here — ${why} — is stale.`);
}

/* ========================================================================
   2. The engine is imported, never copied
   ===================================================================== */
section('The engine is shared, not forked');

/**
 * Every shared module TransLis must reach by import. If one of these ever
 * appears as a file inside `translis/` instead, the products have split.
 */
const SHARED = [
  ['translis/server/index.ts', '../../server/routes/middleware.js', 'the middleware HTTP surface'],
  ['translis/server/index.ts', '../../server/routes/resultFiller.js', 'the Result Filler HTTP surface'],
  ['translis/server/index.ts', '../../server/routes/instrumentLinks.js', 'the analyser link register'],
  ['translis/server/index.ts', '../../server/routes/transmissionReports.js', 'the transmitted-result reports'],
  ['translis/server/index.ts', '../../server/routes/auth.js', 'sign-in'],
  ['translis/server/index.ts', '../../server/db/database.js', 'the schema'],
  ['translis/server/services.ts', '../../server/services/instrumentBridge/index.js', 'the analyser bridge'],
  ['translis/server/services.ts', '../../server/services/middleware/engine.js', 'the middleware engine'],
  ['translis/src/pages/AnalyserSync.tsx', '../../../src/pages/InstrumentLinksTab', 'Analyser Sync & Interfacing'],
];

for (const [file, specifier, what] of SHARED) {
  const source = read(file);
  // Static and dynamic alike. The bridge and the engine are loaded with
  // `import(...)` on purpose — the same lazy load SECHLIMS uses, so a database
  // that is busy for a second cannot stop the host coming up.
  const imported = source.includes(`from '${specifier}'`)
    || source.includes(`import('${specifier}')`);
  check(`${what} is imported from the SECHLIMS tree`, imported,
    `${file} must import it from '${specifier}' rather than hold its own.`);
}

// Every section the workspace draws must be the SECHLIMS component.
const workspace = read('translis/src/pages/Workspace.tsx');
const sectionImports = [...workspace.matchAll(
  /import\s+(\w+)\s+from\s+'(\.\.\/)+src\/components\/middleware\/(\w+)'/g)];
check('every workspace section is the SECHLIMS component',
  sectionImports.length >= expected.length - 1,
  `Only ${sectionImports.length} section(s) are imported from src/components/middleware/. `
  + 'A section rendered from anywhere else is a fork.');

/* ========================================================================
   3. No duplicated file anywhere under translis/
   ===================================================================== */
section('Nothing shared has been copied into translis/');

const walk = dir => {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry.startsWith('.')) continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
};

/** Folders whose contents belong to both products and must exist once. */
const SHARED_DIRS = [
  'src/components/middleware',
  'src/components/instruments',
  'server/services/middleware',
  'server/services/instrumentBridge',
  'server/services/resultFiller',
];

/** Every shared module, by name, with its own text to compare against. */
const sharedByName = new Map();
for (const dir of SHARED_DIRS) {
  for (const file of walk(dir)) {
    if (basename(file) === 'index.ts') continue;
    sharedByName.set(basename(file), read(file));
  }
}

/**
 * The lines of a file worth comparing: its actual statements.
 *
 * Imports, braces and blank lines are the same in every React file ever
 * written and would make two unrelated files look alike.
 */
const meat = text => new Set(
  text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 24 && !l.startsWith('import ') && !l.startsWith('*') && !l.startsWith('//')),
);

/**
 * A copy, as against a coincidence.
 *
 * `translis/src/pages/Setup.tsx` is the first-run wizard and
 * `src/components/middleware/Setup.tsx` is the Connection Setup section: one
 * name, two unrelated screens. Matching on the name alone would condemn that
 * forever, so a file is only a copy when it shares the name AND a substantial
 * amount of the original's own text.
 */
const OVERLAP_IS_A_COPY = 0.4;

const copies = walk('translis').filter(file => {
  const original = sharedByName.get(basename(file));
  if (!original) return false;
  const theirs = meat(original);
  if (theirs.size === 0) return false;
  const mine = meat(read(file));
  let shared = 0;
  for (const line of theirs) if (mine.has(line)) shared += 1;
  return shared / theirs.size >= OVERLAP_IS_A_COPY;
});
check('no shared module has a twin inside translis/', copies.length === 0,
  copies.length
    ? `${copies.join(', ')} share a name with a module both products use. `
      + 'Import the original instead; if the behaviour must differ, give the original a '
      + 'parameter so both products read one implementation.'
    : '');

/* ========================================================================
   4. The analyser routes are mounted in both
   ===================================================================== */
section('The same analyser routes are served by both');

const ANALYSER_ROUTES = [
  '/api/middleware',
  '/api/result-filler',
  '/api/instrument-links',
  '/api/transmission-reports',
];
const sechlimsHost = read('server/index.ts');
const translisHost = read('translis/server/index.ts');

for (const route of ANALYSER_ROUTES) {
  const inBoth = sechlimsHost.includes(`'${route}'`) && translisHost.includes(`'${route}'`);
  check(`${route} is mounted in both hosts`, inBoth,
    sechlimsHost.includes(`'${route}'`)
      ? `translis/server/index.ts does not mount ${route}.`
      : `server/index.ts does not mount ${route}.`);
}

/* ========================================================================
   5. The master switch belongs to SECHLIMS alone
   ===================================================================== */
section('The transmission switch is SECHLIMS’s, and only SECHLIMS’s');

// TransLis exists to transmit. A switch that turns transmission off would be
// a switch that turns the product off, so it has none — and must not acquire
// one by somebody mounting the guard here out of symmetry.
check('SECHLIMS guards its analyser routes with the switch',
  sechlimsHost.includes('requireMiddlewareOn'),
  'server/index.ts should guard the analyser routers with requireMiddlewareOn.');
check('TransLis does not carry the switch', !translisHost.includes('requireMiddlewareOn'),
  'TransLis exists to transmit; a master switch there would turn the product off.');

/* ========================================================================
   6. The product name is read, never written in
   ===================================================================== */
section('The product names itself from one constant');

const nameLeaks = [];
for (const dir of ['src/components/middleware', 'src/components/instruments']) {
  for (const file of walk(dir)) {
    const source = read(file);
    // Comments are developer prose about where this came from, and stay.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The Parameter Mappings tab KEYS are deliberately fixed; their labels
    // follow the product. Everything else naming the product is a leak.
    const stripped = code
      .replace(/'Analyser → SECHLIMS'/g, '')
      .replace(/'SECHLIMS → LIS'/g, '');
    if (/\bSECHLIMS\b/.test(stripped)) nameLeaks.push(relative(ROOT, join(ROOT, file)));
  }
}
check('no shared component writes a product name into its own text', nameLeaks.length === 0,
  nameLeaks.length
    ? `${nameLeaks.join(', ')} name SECHLIMS directly. Use PRODUCT from src/constants/product.`
    : '');

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) {
  console.log('\nThe two products are one middleware. An improvement to either is an improvement to both.');
}
process.exit(fail > 0 ? 1 : 0);
