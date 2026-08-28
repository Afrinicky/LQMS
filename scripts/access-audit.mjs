/**
 * ACCESS CONTROL AUDIT — the static half.
 *
 * Reads the source and asserts the rules the access model depends on, so a
 * change that quietly re-opens a hole fails here instead of in a laboratory.
 * It needs no running server; `npm run audit:access:live` does the other half.
 *
 * What it checks, and why each one exists:
 *
 *   1. Every permission key named anywhere — a route guard, a `can()` in the
 *      UI, a route element — is a real module or feature. A typo silently
 *      denies everybody, or (worse) names a key nothing ever grants.
 *   2. Export, import, template-download and print routes ask for `export`,
 *      `create` and `print` — not `view`. "View only" walking off with the
 *      register is the complaint this audit was written for.
 *   3. Every module route in the client is wrapped in a permission gate. A
 *      page that renders and then 403s piecemeal is the "No permission, but
 *      the page still opens" symptom.
 *   4. Nothing writes permissions outside the two tables the resolver reads,
 *      and no second screen decides access behind the merged one.
 *   5. Every module page filters its tab bar. An ungated tab bar is how a
 *      "New …" form reaches somebody who may only read.
 */
import fs from 'fs';
import path from 'path';

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const read = p => fs.readFileSync(p, 'utf8');

// ── The catalogue of valid keys, read from the shared constants ────────────
const moduleSrc = read('shared/constants/modules.ts');
const featureSrc = read('shared/constants/features.ts');
const MODULE_KEYS = [...moduleSrc.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
const FEATURE_KEYS = [...featureSrc.matchAll(/\{\s*key:\s*'([^']+)',\s*module:/g)].map(m => m[1]);
const VALID = new Set([...MODULE_KEYS, ...FEATURE_KEYS]);
const ACTIONS = new Set(['view', 'create', 'edit', 'void_archive', 'export', 'print', 'approve']);

const SERVER_FILES = walk('server');
const CLIENT_FILES = walk('src');

console.log(`\nSECH_LIMS ACCESS CONTROL AUDIT (static)\n${MODULE_KEYS.length} modules, ${FEATURE_KEYS.length} features, ${VALID.size} grantable areas\n`);

/* ==========================================================================
   1 — Every permission key named in the code exists
   ========================================================================= */
console.log('[1] Permission keys named in the code are real');
{
  const bad = new Map();
  const note = (key, where) => { if (!VALID.has(key) && !ACTIONS.has(key)) (bad.get(key) ?? bad.set(key, []).get(key)).push(where); };
  for (const p of [...SERVER_FILES, ...CLIENT_FILES]) {
    const s = read(p);
    const patterns = [
      /requirePermission\(\s*'([^']+)'/g,
      /resolvePermission\([^,]+,\s*'([^']+)'/g,
      /\bcan\(\s*'([^']+)'/g,
      /canView\(\s*'([^']+)'/g,
      /usePermittedTabs\(\s*'([^']+)'/g,
      /moduleKey="([a-z_][a-z_.]*)"/g,
      /module="([a-z_][a-z_.]*)"/g,
    ];
    for (const re of patterns) for (const m of s.matchAll(re)) note(m[1], p);
  }
  check('no unknown permission keys are referenced', bad.size === 0,
    [...bad.entries()].map(([k, v]) => `${k} (${v[0]})`).join('; '));
}

/* ==========================================================================
   2 — Taking data out asks for the right to take data out
   ========================================================================= */
console.log('\n[2] Export / import / print routes ask for export / create / print');
{
  const offenders = [];
  for (const p of SERVER_FILES.filter(f => f.includes(`routes${path.sep}`))) {
    const s = read(p);
    const consts = {};
    for (const m of s.matchAll(/const\s+([A-Z_][A-Z_0-9]*)\s*=\s*'([^']+)'/g)) consts[m[1]] = m[2];
    const lines = s.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`](.*)$/);
      if (!m) return;
      const [, verb, route, rest] = m;
      // Only the endpoints that move a file or a sheet, named as such in the
      // path. `/appraisal-templates` is a record type, not a download.
      // `…/export-docx/save-as-version` builds a document and stores it as a
      // new controlled version — that is authoring, not taking data out.
      const isExport = !/save-as-version/.test(route)
        && /(^|\/)(export|register\/template|readings\/template|programs\/template|materials\/template|controls\/template|runs\/template|reference-intervals\/template|maintenance\/template)(\/|$)|\/export$|export-docx/.test(route);
      const isImport = /(^|\/)import(\/|$)|\/import$|import-csv/.test(route);
      const isPrint = /(^|\/)print(\/|$)|\/print$/.test(route) && !/print-jobs/.test(route);
      if (!isExport && !isImport && !isPrint) return;
      // A handler may do the check itself when the answer depends on the
      // record — whose appraisal it is, which module a scan belongs to — so
      // look far enough into the body to see it.
      const window = lines.slice(i, i + 8).join(' ');
      if (/requireAdministrator|requireResolvedPermission|mayReach|canReachPersonalRecord/.test(window)) return;
      const g = window.match(/requirePermission\(\s*([A-Z_0-9]+|'[^']+')\s*,\s*'([^']+)'/);
      const action = g?.[2];
      // A GET that lists import batches is a read of the register, not an import.
      const want = isExport ? 'export' : isImport ? (verb === 'get' ? null : 'create') : 'print';
      if (want === null) return;
      if (action !== want) offenders.push(`${path.basename(p)} ${verb.toUpperCase()} ${route} [${action ?? 'unguarded'}] wants ${want}`);
    });
  }
  check('every export/import/print route asks for the matching right', offenders.length === 0,
    offenders.slice(0, 8).join(' | '));
}

/* ==========================================================================
   2b — A guard that is never reached is not a guard
   --------------------------------------------------------------------------
   `router.get('/:id')` declared before `router.get('/export')` swallows the
   export request: Express matches the parameter route first, so the export
   guard is dead code and the request is decided by whatever `/:id` asks for.
   That is how a register came to be exportable by anyone — and, as it turned
   out, by no one, because the handler then answered 404.
   ========================================================================= */
console.log('\n[2b] No permission guard is shadowed by an earlier parameter route');
{
  const shadowed = [];
  for (const p of SERVER_FILES.filter(f => f.includes(`routes${path.sep}`))) {
    const lines = read(p).split('\n');
    const routes = [];
    lines.forEach((l, i) => {
      const m = l.match(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`](.*)$/);
      if (m) routes.push({ verb: m[1], route: m[2], line: i + 1, rest: m[3] });
    });
    for (const r of routes) {
      if (!r.route.includes(':')) continue;
      // A route that only accepts numeric ids lets a named sibling through.
      if (/numericOnly/.test(r.rest)) continue;
      const parts = r.route.split('/');
      for (const other of routes) {
        if (other.verb !== r.verb || other.line <= r.line) continue;
        const op = other.route.split('/');
        if (op.length !== parts.length) continue;
        let shadows = true;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].startsWith(':')) { if (op[i].startsWith(':')) { shadows = false; break; } continue; }
          if (parts[i] !== op[i]) { shadows = false; break; }
        }
        if (shadows) shadowed.push(`${path.basename(p)}: ${r.verb.toUpperCase()} ${r.route} (L${r.line}) hides ${other.route} (L${other.line})`);
      }
    }
  }
  check('no route hides a later, more specific one', shadowed.length === 0, shadowed.slice(0, 6).join(' | '));
}

/* ==========================================================================
   3 — Every module route is behind a permission gate
   ========================================================================= */
console.log('\n[3] Every module route in the client is permission-gated');
{
  const app = read('src/App.tsx');
  const ungated = [];
  for (const m of app.matchAll(/<Route\s+(?:key=\{[^}]*\}\s+)?path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g)) {
    const [, route, element] = m;
    if (/^\/(login|setup)$/.test(route) || route === '*' || route === '/home') continue;
    if (/Navigate/.test(element)) continue;
    if (/RequirePermission|RequireAnyPermission/.test(element)) continue;
    ungated.push(route);
  }
  check('no module route renders without a permission gate', ungated.length === 0, ungated.join(', '));
  // The placeholder routes are generated in a loop; they must be gated too.
  check('generated placeholder routes are gated',
    !/placeholders\.map\(m => <Route[^>]*element=\{<ModulePage/.test(app.replace(/\s+/g, ' ')) ||
    /placeholders\.map\(m => <Route[\s\S]{0,200}RequirePermission/.test(app));
}

/* ==========================================================================
   4 — One model: nothing writes access outside the two tables
   ========================================================================= */
console.log('\n[4] One access model — profiles, then individuals');
{
  const resolver = read('server/services/permissionResolver.ts');
  check('the resolver reads exactly two grant tables',
    /FROM role_permissions/.test(resolver) && /FROM user_permission_overrides/.test(resolver)
    && !/position_permissions/.test(resolver));
  check('technical authorizations no longer grant permissions',
    !/FROM technical_authorizations/.test(resolver));
  check('a user resolves to exactly one access profile',
    /export function profileIdForUser/.test(resolver) && /LIMIT 1/.test(resolver));

  const writers = [];
  for (const p of SERVER_FILES) {
    const s = read(p);
    if (p.endsWith('permissionResolver.ts')) continue;
    for (const table of ['role_permissions', 'user_permission_overrides', 'position_permissions']) {
      const re = new RegExp(`(INSERT[^;]{0,60}INTO|UPDATE|DELETE FROM)\\s+(OR (REPLACE|IGNORE) INTO )?${table}`, 'g');
      for (const _ of s.matchAll(re)) writers.push(`${path.basename(p)}:${table}`);
    }
  }
  const files = new Set(writers.map(w => w.split(':')[0]));
  // seed.ts lays down the defaults, database.ts migrates, common.ts holds the
  // one write API. Anything else is a second place access is decided.
  const allowed = new Set(['seed.ts', 'database.ts', 'common.ts']);
  check('only the seeder, the migration and the one write API touch the grant tables',
    [...files].every(f => allowed.has(f)), [...files].filter(f => !allowed.has(f)).join(', '));
  check('positions carry no grants of their own — they map to a profile',
    !writers.some(w => w.endsWith(':position_permissions') && !w.startsWith('database.ts')),
    writers.filter(w => w.endsWith(':position_permissions')).join(', '));

  const ac = read('src/pages/AccessControl.tsx');
  check('the access screen offers exactly two surfaces',
    /'profiles' \| 'individuals'/.test(ac) || /type Tab = 'profiles' \| 'individuals'/.test(ac));
  check('the Advanced Matrix is gone from People & Access',
    !/Advanced Matrix'\]/.test(read('src/pages/SettingsPages.tsx').replace(/\/\/[^\n]*/g, '')));
  check('individual decisions supersede the profile',
    /Layer 2: the individual, superseding everything above/.test(resolver));
}

/* ==========================================================================
   4b — A write is never granted by a module union
   --------------------------------------------------------------------------
   A module key is the union of everything inside it. Every member of staff
   holds "manage my own record" (`personnel.self`), so `personnel:edit` was
   true for the whole laboratory — and every gate written against the module
   opened with it: Settings → Roster & Scheduling appeared in the sidebar, and
   the duty roster handed Save / Publish / Approve / Delete to a Biomedical
   Scientist who held nothing but View on rosters. A write must name the area
   it writes to.
   ========================================================================= */
console.log('\n[4b] Writes name a feature, never a module that has features');
{
  const modulesWithFeatures = new Set(
    [...featureSrc.matchAll(/\{\s*key:\s*'[^']+',\s*module:\s*'([^']+)'/g)].map(m => m[1]),
  );
  const WRITE = new Set(['create', 'edit', 'export', 'approve', 'void_archive']);
  const offenders = [];
  for (const p of [...SERVER_FILES, ...CLIENT_FILES]) {
    read(p).split('\n').forEach((l, i) => {
      for (const m of l.matchAll(/(requirePermission|can)\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g)) {
        if (modulesWithFeatures.has(m[2]) && WRITE.has(m[3])) {
          offenders.push(`${path.basename(p)}:${i + 1} ${m[1]}('${m[2]}','${m[3]}')`);
        }
      }
    });
  }
  check('no write right is asked of a module key', offenders.length === 0, offenders.slice(0, 8).join(' | '));

  const resolver = read('server/services/permissionResolver.ts');
  check('personal areas contribute only view/print to their module',
    /MODULE_ACTIONS_FROM_PERSONAL/.test(resolver) && /f\.personal \|\| MODULE_ACTIONS_FROM_PERSONAL\.has\(action\)/.test(resolver));

  const settings = read('src/constants/settingsAccess.ts');
  const delegated = [...settings.matchAll(/module: '([a-z_.]+)', action: '(\w+)'/g)]
    .filter(m => m[1] !== 'settings' && m[1] !== 'actions');
  check('every delegated Settings page names a feature, not a module',
    delegated.every(m => m[1].includes('.')),
    delegated.filter(m => !m[1].includes('.')).map(m => m[1]).join(', '));
}

/* ==========================================================================
   4c — A task is addressed to a person, not to a login account
   --------------------------------------------------------------------------
   Attestations were notified by looping over the ACCOUNTS attached to a staff
   record. Somebody with no account yet, or linked to one afterwards, got no
   row and never would — whole benches held pending attestations nobody told
   them about, while the same work piled up unread in the administrator's
   inbox. The address is the staff record.
   ========================================================================= */
console.log('\n[4c] Tasks are addressed to the staff record, and the inbox is personal');
{
  const docs = read('server/routes/documents.ts');
  check('notifyStaff writes one row keyed on the staff record',
    /Addressed to the STAFF RECORD/.test(docs) && !/for \(const u of users\)/.test(docs));
  const org = read('server/routes/organisationExtended.ts');
  check('notifyAllStaff reaches staff without a login account',
    /FROM staff WHERE is_active = 1/.test(org));
  const notif = read('server/routes/notifications.ts');
  check('the inbox listing is personal unless the caller manages alerts',
    /An inbox is personal/.test(notif) && /notifications\.rules', 'view'/.test(notif));
  check('acknowledging your own alert needs only your own inbox',
    /'\/:id\/acknowledge', requirePermission\('notifications\.inbox', 'edit'\)/.test(notif));
}

/* ==========================================================================
   4d — Reading a document is reading, not authoring
   --------------------------------------------------------------------------
   A .docx has no in-app preview: opening it in Word IS reading it. Gating the
   Office handoff on `documents.authoring:edit` meant a Biomedical Scientist
   could not open the SOP they are required to read and attest to — the viewer
   offered them a lone Download button. Opening is governed by the right to
   read the library; whether the handoff may save a version back is a separate
   answer, carried on the session and enforced on the PUT.
   ========================================================================= */
console.log('\n[4d] Opening a controlled document needs only the right to read it');
{
  const docs = read('server/routes/documents.ts');
  check('the Office handoff is minted on documents.library:view',
    /'\/:id\/versions\/:versionId\/office-session', requirePermission\('documents\.library', 'view'\)/.test(docs));
  check('the handoff records whether it may write back',
    /readOnly: !mayAuthor/.test(docs) && /officeUriFor\(fileName, url, mayAuthor \? 'edit' : 'view'\)/.test(docs));

  const office = read('server/routes/officeEdit.ts');
  check('a read-only handoff opens for viewing, not editing',
    /mode === 'view' \? 'ofv' : 'ofe'/.test(office));
  check('and its save is refused at the door',
    /if \(session\.read_only\) \{ davHeaders\(res\); res\.status\(403\)/.test(office));

  const panel = read('src/components/OfficeHandoff.tsx');
  check('the viewer offers "Open in …" to a reader',
    /<button type="button" className="oh-primary" onClick=\{open\}/.test(panel)
    && !/\{canEdit && <button type="button" className="oh-primary"/.test(panel));
  check('but wires no save-back path for one', /if \(!canSaveBack\) return;/.test(panel));
}

/* ==========================================================================
   5 — Module pages filter their tab bars
   ========================================================================= */
console.log('\n[5] Module pages filter their tab bars by permission');
{
  // Checking that a file merely MENTIONS PermissionTabs is not enough: Documents
  // & Records imported it for its Dashboard/Documents/Records rail while a
  // second bar right underneath mapped a raw `docTabs` array — which is how a
  // Biomedical Scientist came to be offered New Document, Bulk Import and both
  // approval queues. Every `className="tabs"` block is inspected on its own.
  const offenders = [];
  for (const p of CLIENT_FILES.filter(f => f.startsWith(`src${path.sep}pages`) || f.startsWith(`src${path.sep}components`))) {
    const src = read(p);
    // Settings has its own gate per page (src/constants/settingsAccess.ts).
    if (/SettingsPages|ActivitySettingsPage|PermissionTabs\.tsx$/.test(p)) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // Only the bars that choose a WORKSPACE. `tabs sub` / `view-switch` are
      // inner switchers between views of one area the person already holds —
      // gating them would be asking the same question twice.
      if (!/className="tabs\b/.test(line)) return;
      if (/className="tabs (sub|.*view-switch)/.test(line)) return;
      // The bar and what it maps over, within the next few lines.
      const block = lines.slice(i, i + 4).join(' ');
      const mapped = block.match(/\{\s*([A-Za-z_$][\w$]*)\s*(?:\.filter\([^)]*\))?\.map\(/);
      if (!mapped) return;                       // not a mapped bar
      const ident = mapped[1];
      // Filtered in place, right here in the bar.
      if (/\.filter\([^)]*\bcan(View)?\(/.test(block)) return;
      // Or the array itself is built from a permission filter, or is the
      // output of usePermittedTabs.
      // A fixed window after the declaration, not "up to the first semicolon":
      // a filter body has semicolons of its own.
      const at = src.search(new RegExp(`\\b(const|let)\\s+${ident}\\b`));
      const body = at === -1 ? '' : src.slice(at, at + 900);
      if (/usePermittedTabs|\bcan(View)?\(/.test(body)) return;
      offenders.push(`${path.basename(p)}:${i + 1} maps ${ident} unfiltered`);
    });
  }
  check('every tab bar filters what it draws', offenders.length === 0, offenders.slice(0, 8).join(' | '));
}

/* ==========================================================================
   5b — Reading a document is not authoring it, and signing is not raising
   --------------------------------------------------------------------------
   A Biomedical Scientist reads the SOPs they must follow and signs what is put
   in front of them. Offering them New Document, Bulk Import, the review and
   approval queues, the laboratory-wide attestation register, or a "Set up
   declaration" button is offering work the API refuses — and what you cannot
   do you should not see.
   ========================================================================= */
console.log('\n[5b] A reader is offered reading, not document control');
{
  const docs = read('src/pages/DocumentControlPage.tsx');
  check('the document tabs each name the right they need', /DOC_TAB_RIGHTS/.test(docs));
  for (const [tab, key, action] of [
    ['New Document', 'documents.authoring', 'create'],
    ['Bulk Import', 'documents.authoring', 'create'],
    ['Review Queue', 'documents.workflow', 'view'],
    ['Approval Queue', 'documents.workflow', 'view'],
    ['Attestations', 'documents.workflow', 'view'],
  ]) {
    const re = new RegExp(`'${tab}': \\{ key: '${key}', action: '${action}' \\}`);
    check(`  ${tab} needs ${key}:${action}`, re.test(docs));
  }
  const server = read('server/routes/documents.ts');
  check('the laboratory-wide attestation register is document control\'s',
    /'\/attestations\/list', requirePermission\('documents\.workflow', 'view'\)/.test(server));
  check('and a reader\'s pending list is their own',
    /const mayOversee = resolvePermission\(req\.user!\.id, 'documents\.workflow', 'view'\)\.allowed/.test(server));

  const org = read('src/pages/OrganisationPage.tsx');
  check('setting up a declaration needs the right to create one',
    /const canManage = can\('organisation\.structure', 'create'\)/.test(org)
    && !/const canManage = true/.test(org));
  check('and editing or deleting one is gated separately',
    /const canEditForm = can\('organisation\.structure', 'edit'\)/.test(org)
    && /const canDeleteForm = can\('organisation\.structure', 'void_archive'\)/.test(org));
}

/* ==========================================================================
   6 — The client hides rather than disables
   ========================================================================= */
console.log('\n[6] A control the user may not use is not rendered at all');
{
  const hook = read('src/hooks/usePermissions.tsx');
  check('there is no "disabled" variant of the permission gate',
    /There is deliberately no "disabled" variant/.test(hook));
  const toolbar = read('src/components/XlsxToolbar.tsx');
  check('the shared Excel toolbar renders nothing when nothing is permitted',
    /if \(!mayExport && !mayPrint && !canImportHere\) return null;/.test(toolbar));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
