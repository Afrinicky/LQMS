/**
 * ACCESS CONTROL AUDIT — the live half.
 *
 * Runs every module past every seeded role against a running API and asserts
 * the two things a laboratory actually cares about:
 *
 *   NOTHING SHOWS THAT IS REFUSED.  For each role and each module, the
 *   effective permission map the client renders from must agree with what the
 *   API does. A module in the map whose listing 403s is a page that opens and
 *   then fails; a module absent from the map whose listing returns 200 is a
 *   workspace hidden from someone entitled to it, and reachable by URL.
 *
 *   VIEW MEANS VIEW.  A cohort set to View on an area may read it and may not
 *   export it, import into it, create in it, edit it or approve in it. This is
 *   checked by setting the level and then trying, not by reading the model
 *   back to itself.
 *
 * It also proves the unified model end to end: a profile decides, an
 * organogram position mapped to a profile decides for its holders, an
 * individual override beats both, and clearing it returns the person to the
 * profile.
 *
 *   API=http://127.0.0.1:4399/api node scripts/access-audit-live.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4399/api';
const PW = 'Passw0rd!audit';

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* file streams are not JSON */ }
  return { status: res.status, json };
}

/**
 * One representative endpoint per module, chosen because it is the listing the
 * module's own front page loads. If the map and this disagree, the user sees a
 * page that does not work.
 */
const MODULE_PROBE = {
  // permission key the route actually guards → the listing it guards
  'documents.library': '/documents',
  'personnel.register': '/personnel/staff-documents',
  'equipment.register': '/equipment',
  'supplier_inventory.stock': '/supplier-inventory/items',
  nc_capa: '/nonconformities',
  complaints: '/complaints',
  risks: '/risks',
  actions: '/actions',
  assessments: '/assessments/checklists',
  iqc: '/iqc/materials',
  eqa: '/eqa/programs',
  verification_validation: '/verification-validation',
  measurement_uncertainty: '/measurement-uncertainty',
  poct: '/poct/sites',
  blood_bank_handover: '/blood-bank-handover/units',
  monthly_reports: '/monthly-reports/imports',
  quality_indicators: '/quality-indicators',
  'continual_improvement.projects': '/continual-improvement/projects',
  'customer_focus.stakeholders': '/customer-focus/stakeholders',
  process_management: '/process-management/sample-receipts',
  'information_management.assets': '/information-management/assets',
  'facilities_safety.incidents': '/facilities-safety/incidents',
  'monitoring.readings': '/monitoring/readings',
  'records_reports.generate': '/records-reports/reports',
  notifications: '/notifications',
  'system_audit.flags': '/system-audit/flags',
  management_review: '/management-review/reviews',
  meetings: '/meetings',
  organisation: '/organisation/summary',
  settings: '/users',
};

/**
 * Areas with an export, an import and a create, so "View may not take the file
 * out" can be tried for real rather than asserted.
 */
const IO_PROBE = [
  { area: 'personnel.register', exportPath: '/personnel/register/export', templatePath: '/personnel/register/template' },
  { area: 'equipment.register', exportPath: '/equipment/register/export', templatePath: '/equipment/register/template' },
  { area: 'equipment.maintenance', exportPath: '/equipment/maintenance/export', templatePath: '/equipment/maintenance/template' },
  { area: 'iqc', exportPath: '/iqc/materials/export', templatePath: '/iqc/materials/template' },
  { area: 'eqa', exportPath: '/eqa/programs/export', templatePath: '/eqa/programs/template' },
  { area: 'nc_capa', exportPath: '/nonconformities/register/export', templatePath: '/nonconformities/register/template' },
  { area: 'measurement_uncertainty', exportPath: '/measurement-uncertainty/export', templatePath: '/measurement-uncertainty/template' },
  { area: 'verification_validation', exportPath: '/verification-validation/export' },
  { area: 'process_management.intervals', exportPath: '/process-management/reference-intervals/export', templatePath: '/process-management/reference-intervals/template' },
  { area: 'supplier_inventory.stock', exportPath: '/supplier-inventory/items/export' },
  { area: 'supplier_inventory.suppliers', exportPath: '/supplier-inventory/suppliers/export' },
  { area: 'facilities_safety.environment', exportPath: '/environmental/readings/export', templatePath: '/environmental/readings/template' },
  { area: 'documents.masterlist', exportPath: '/documents/masterlist/export' },
];

async function main() {
  const status = await call('/setup/status');
  if (!status.json?.setupComplete) {
    const r = await call('/setup/initialize', {
      method: 'POST',
      body: { facilityName: 'Access Audit Lab', username: 'admin', password: PW, fullName: 'Admin User' },
    });
    if (r.status >= 400) throw new Error(`setup failed: ${JSON.stringify(r.json)}`);
  }
  const adminLogin = await call('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } });
  if (adminLogin.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(adminLogin.json)}`);
  const A = adminLogin.json.token;

  const profiles = (await call('/roles', { token: A })).json ?? [];

  // One account per access profile, so every profile is exercised as a person.
  const accounts = [];
  for (const p of profiles) {
    const username = `audit_${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    let r = await call('/users', { token: A, method: 'POST', body: { username, password: PW, fullName: `Audit ${p.name}`, roleId: p.id } });
    if (r.status >= 400 && !/already in use/i.test(r.json?.error ?? '')) continue;
    const login = await call('/auth/login', { method: 'POST', body: { username, password: PW } });
    if (login.status !== 200) continue;
    accounts.push({ profile: p, token: login.json.token, user: login.json.user, permissions: login.json.permissions });
  }
  console.log(`\nSECH_LIMS ACCESS CONTROL AUDIT (live)\n${accounts.length} access profiles exercised against ${Object.keys(MODULE_PROBE).length} areas\n`);

  /* ======================================================================
     1 — The map the client renders from agrees with what the API does
     ====================================================================== */
  console.log('[1] What the user is shown is exactly what the API allows');
  {
    const mismatches = [];
    for (const acc of accounts) {
      const map = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      for (const [permKey, probe] of Object.entries(MODULE_PROBE)) {
        const shown = Array.isArray(map[permKey]) && map[permKey].includes('view');
        const res = await call(probe, { token: acc.token });
        if (res.status === 404 || res.status >= 500) continue; // endpoint not in this build
        const allowed = res.status !== 403;
        if (shown !== allowed) mismatches.push(`${acc.profile.name} · ${permKey}: map says ${shown ? 'visible' : 'hidden'}, API says ${allowed ? 'allowed' : 'refused'}`);
      }
    }
    check('no module is shown that the API refuses, or hidden that it allows',
      mismatches.length === 0, mismatches.slice(0, 10).join(' | '));
  }

  /* ======================================================================
     2 — "View" means view: no export, no import, no create, no approve
     ====================================================================== */
  console.log('\n[2] A cohort set to View can read, and can do nothing else');
  {
    // A profile of its own, so the audit never widens or narrows a real one.
    await call('/roles', { token: A, method: 'POST', body: { name: 'Audit Viewer', description: 'Created by the access audit.' } });
    const viewer = ((await call('/roles', { token: A })).json ?? []).find(r => r.name === 'Audit Viewer');
    const username = 'audit_viewer';
    await call('/users', { token: A, method: 'POST', body: { username, password: PW, fullName: 'Audit Viewer', roleId: viewer.id } });
    const V = (await call('/auth/login', { method: 'POST', body: { username, password: PW } })).json?.token;

    const denials = [];
    for (const probe of IO_PROBE) {
      await call('/permissions/level', { token: A, method: 'POST', body: { scope: 'profile', subjectId: viewer.id, permKey: probe.area, level: 'view' } });
      const map = (await call('/auth/permissions', { token: V })).json.permissions ?? {};
      const actions = map[probe.area] ?? [];
      if (!actions.includes('view')) denials.push(`${probe.area}: View did not even grant view (${JSON.stringify(actions)})`);
      for (const forbidden of ['export', 'create', 'edit', 'approve', 'void_archive']) {
        if (actions.includes(forbidden)) denials.push(`${probe.area}: View granted ${forbidden}`);
      }
      for (const [label, path] of [['export', probe.exportPath], ['template', probe.templatePath]]) {
        if (!path) continue;
        const res = await call(path, { token: V });
        if (res.status !== 403) denials.push(`${probe.area}: ${label} ${path} returned ${res.status}, expected 403`);
      }
      // And with Manage, the same export must succeed — a control that is
      // always refused is not a control, it is a broken button.
      await call('/permissions/level', { token: A, method: 'POST', body: { scope: 'profile', subjectId: viewer.id, permKey: probe.area, level: 'manage' } });
      if (probe.exportPath) {
        const res = await call(probe.exportPath, { token: V });
        if (res.status === 403) denials.push(`${probe.area}: Manage still could not export ${probe.exportPath}`);
      }
      await call('/permissions/level', { token: A, method: 'POST', body: { scope: 'profile', subjectId: viewer.id, permKey: probe.area, level: 'none' } });
    }
    check('View reads and nothing more; Manage can export', denials.length === 0, denials.slice(0, 10).join(' | '));

    // No access means gone from the map entirely, not greyed out.
    await call('/permissions/level', { token: A, method: 'POST', body: { scope: 'profile', subjectId: viewer.id, permKey: 'equipment', level: 'none' } });
    const gone = (await call('/auth/permissions', { token: V })).json.permissions ?? {};
    check('"No access" removes the area from the map entirely', !gone.equipment && !gone['equipment.register'],
      JSON.stringify({ equipment: gone.equipment, register: gone['equipment.register'] }));
    check('and the API refuses it too', (await call('/equipment', { token: V })).status === 403);
  }

  /* ======================================================================
     3 — One cohort decision: a position cannot contradict a profile
     ====================================================================== */
  console.log('\n[3] A position and a profile cannot contradict — there is only one');
  {
    const legacy = await call('/permissions/level', {
      token: A, method: 'POST',
      body: { scope: 'position', subjectId: 1, permKey: 'equipment', level: 'full' },
    });
    check('setting permissions on a position is refused', legacy.status === 400,
      `got ${legacy.status} ${JSON.stringify(legacy.json)}`);

    // Map a position to a profile and the holders work under that profile.
    const positions = ((await call('/permissions/catalogue', { token: A })).json?.positions ?? []).filter(p => p.isActive !== 0);
    const position = positions[0];
    const openProfile = ((await call('/roles', { token: A })).json ?? []).find(r => r.name === 'Audit Viewer');
    const wasMappedTo = position.accessProfileId ?? null;
    const mapped = await call(`/positions/${position.id}/access-profile`, { token: A, method: 'PUT', body: { accessProfileId: openProfile.id } });
    check('a position can be mapped to an access profile', mapped.status === 200, JSON.stringify(mapped.json));
    const catalogue = (await call('/permissions/catalogue', { token: A })).json;
    const row = (catalogue.positions ?? []).find(p => p.id === position.id);
    check('the merged screen shows the mapping', row?.accessProfileId === openProfile.id, JSON.stringify(row));
    // Put it back exactly as it was — an audit that leaves the organogram
    // half-wired is a bug it then reports against itself.
    await call(`/positions/${position.id}/access-profile`, { token: A, method: 'PUT', body: { accessProfileId: wasMappedTo } });
  }

  /* ======================================================================
     4 — The individual supersedes, in both directions
     ====================================================================== */
  console.log('\n[4] An individual decision overrides the profile, to grant and to withdraw');
  {
    const acc = accounts.find(a => a.profile.name === 'Technician');
    if (!acc) {
      console.log('   (skipped: no Technician profile in this database)');
    } else {
      const before = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      check('the Technician profile does not open appraisals', !before['personnel.appraisals'],
        JSON.stringify(before['personnel.appraisals']));

      await call('/permissions/level', { token: A, method: 'POST', body: { scope: 'user', subjectId: acc.user.id, permKey: 'personnel.appraisals', level: 'view' } });
      const granted = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      check('an individual grant opens it for that one person', (granted['personnel.appraisals'] ?? []).includes('view'),
        JSON.stringify(granted['personnel.appraisals']));

      // Withdrawing something the profile grants must also hold — this is the
      // direction the additive model could never express.
      const openArea = Object.keys(before).find(k => k.includes('.') && (before[k] ?? []).includes('view'));
      if (openArea) {
        await call('/permissions/level', { token: A, method: 'POST', body: { scope: 'user', subjectId: acc.user.id, permKey: openArea, level: 'none' } });
        const withdrawn = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
        check(`an individual withdrawal closes "${openArea}" the profile grants`, !withdrawn[openArea],
          JSON.stringify(withdrawn[openArea]));
        await call(`/permissions/user-override/${acc.user.id}/${encodeURIComponent(openArea)}`, { token: A, method: 'DELETE' });
        const restored = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
        check('clearing the override returns them to the profile', !!restored[openArea], JSON.stringify(restored[openArea]));
      }

      const explained = (await call(`/permissions/effective/${acc.user.id}`, { token: A })).json;
      const area = (explained.areas ?? []).find(a => a.permKey === 'personnel.appraisals');
      check('the screen can say why: profile level, personal level, effect',
        area && area.overrideLevel === 'view' && area.effectiveLevel === 'view', JSON.stringify(area));
      await call(`/permissions/user-override/${acc.user.id}/personnel.appraisals`, { token: A, method: 'DELETE' });
    }
  }

  /* ======================================================================
     5 — Nothing reaches a module the laboratory has switched off
     ====================================================================== */
  console.log('\n[5] A disabled module grants nothing to anybody');
  {
    await call('/system-modules/eqa', { token: A, method: 'PUT', body: { enabled: false } });
    const map = (await call('/auth/permissions', { token: A })).json.permissions ?? {};
    check('a disabled module leaves the administrator’s map', !map.eqa, JSON.stringify(map.eqa));
    check('and its API is refused even to the administrator', (await call('/eqa/programs', { token: A })).status === 403);
    await call('/system-modules/eqa', { token: A, method: 'PUT', body: { enabled: true } });
  }

  /* ======================================================================
     6 — The preset does what the laboratory asked of it
     ----------------------------------------------------------------------
     Everyone outside management needs three things and only three: to be told
     what they must do, to do their daily job, and to keep their own record.
     Everything else must be out of reach — not greyed out, not refused after
     the click, but absent.
     ====================================================================== */
  console.log('\n[6] Bench profiles: notified, able to work, and nothing else');
  {
    const BENCH = ['Technician', 'Biomedical Scientist', 'Stores Officer', 'Customer Service Officer'];
    const MANAGEMENT = ['System Administrator', 'Laboratory Manager', 'Quality Manager', 'Section Head'];

    // Settings is administration. Only the administrator profile holds the key.
    const settingsHolders = [];
    for (const acc of accounts) {
      const map = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      if (map.settings) settingsHolders.push(acc.profile.name);
    }
    check('only the administrator profile holds Settings',
      settingsHolders.length === 1 && settingsHolders[0] === 'System Administrator',
      settingsHolders.join(', '));

    const leaks = [];
    for (const name of BENCH) {
      const acc = accounts.find(a => a.profile.name === name);
      if (!acc) continue;
      const map = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      const can = (k, a) => (map[k] ?? []).includes(a);

      // 4. Not supposed to see or touch what they are not obliged to do.
      if (map.settings) leaks.push(`${name}: Settings is in the map`);
      if (can('personnel', 'edit')) leaks.push(`${name}: personnel:edit (module union leak)`);
      if (can('personnel.rosters', 'edit')) leaks.push(`${name}: may edit the duty roster`);
      if (can('personnel.rosters', 'approve')) leaks.push(`${name}: may approve the duty roster`);
      if (can('personnel.activities', 'edit')) leaks.push(`${name}: may set unit activities`);
      if (map['personnel.register']) leaks.push(`${name}: may open the personnel register`);
      if (map['personnel.appraisals']) leaks.push(`${name}: may open appraisals`);

      for (const [label, path, method, body] of [
        ['Settings → People & Access', '/users'],
        ['Settings → modules', '/system-modules'],
        ['Settings → sections', '/section-config/sections'],
        ['create a duty roster', '/scheduling/duty-rosters', 'POST', { month: '2030-01' }],
        ['approve a duty roster', '/scheduling/duty-rosters/1/approve', 'POST', {}],
        ['appoint an acting unit head', '/scheduling/acting-unit-heads', 'POST', { sectionId: 1, staffId: 1 }],
        ['export the staff register', '/staff/export'],
      ]) {
        const r = await call(path, { token: acc.token, method, body });
        if (r.status !== 403) leaks.push(`${name}: ${label} returned ${r.status}, expected 403`);
      }

      // Document control is not a reader's work. The tabs for these are gone
      // from the bar; the API refuses them too.
      for (const [label, path] of [
        ['the laboratory-wide attestation register', '/documents/attestations/list'],
        ['the attestation document picker', '/documents/attestations/documents'],
      ]) {
        const r = await call(path, { token: acc.token });
        if (r.status !== 403) leaks.push(`${name}: ${label} returned ${r.status}, expected 403`);
      }
      // Raising a declaration is not signing one.
      const raised = await call('/organisation/ethical-forms', {
        token: acc.token, method: 'POST', body: { title: 'Audit probe', formType: 'code_of_conduct' },
      });
      if (raised.status !== 403) leaks.push(`${name}: setting up a declaration returned ${raised.status}, expected 403`);

      // 1–3. Notified, able to work, able to keep their own record.
      for (const [label, path] of [
        ['their own inbox', '/notifications?mine=true'],
        ['what is due', '/notifications/calendar'],
        ['their own profile', '/personnel/my-profile'],
        ['their own tasks', '/personnel/my-tasks'],
        ['their own declarations', '/personnel/my-declarations'],
        ['the duty roster they are on', '/scheduling/duty-rosters'],
        ['the documents they must follow', '/documents'],
        ['the attestation they owe', '/documents/attestations/pending'],
        ['their document inbox', '/documents/distribution/inbox'],
        ['the declarations put to them', '/organisation/ethical-forms'],
      ]) {
        const r = await call(path, { token: acc.token });
        if (r.status === 403) leaks.push(`${name}: ${label} was refused`);
      }
    }
    check('bench profiles are shut out of administration and rosters', leaks.length === 0,
      leaks.slice(0, 10).join(' | '));

    // Raising what they find is everyone's job. A 400 is the field validation
    // talking, which means the guard let them through — a 403 would not.
    const raising = [];
    for (const name of BENCH) {
      const acc = accounts.find(a => a.profile.name === name);
      if (!acc) continue;
      for (const [label, path, body] of [
        ['report a nonconformity', '/nonconformities', { title: 'Audit probe', eventDate: '2030-01-01', description: 'probe' }],
        ['log a complaint', '/complaints', { title: 'Audit probe', receivedDate: '2030-01-01', description: 'probe' }],
        ['report a safety incident', '/facilities-safety/incidents', { incidentDate: '2030-01-01', description: 'probe', severity: 'low' }],
      ]) {
        const r = await call(path, { token: acc.token, method: 'POST', body });
        if (r.status === 403) raising.push(`${name}: ${label} was refused`);
      }
    }
    check('every member of staff can raise an NC, a complaint and a safety incident',
      raising.length === 0, raising.join(' | '));

    const missing = MANAGEMENT.filter(n => !accounts.some(a => a.profile.name === n));
    check('the management profiles exist', missing.length === 0, missing.join(', '));

    // ── Bulk export and import ────────────────────────────────────────────
    // Taking the equipment or stores register out as a spreadsheet, or writing
    // one back in, belongs to the three people accountable for the
    // laboratory's records. Everyone else keeps the daily right to make an
    // entry and never sees the buttons.
    const IO_LEADERS = ['System Administrator', 'Laboratory Manager', 'Quality Manager'];
    const IO_AREAS = [
      'equipment.maintenance', 'equipment.register', 'equipment.verification',
      'supplier_inventory.stock', 'supplier_inventory.suppliers', 'supplier_inventory.storage',
    ];
    const ioLeaks = [];
    for (const acc of accounts) {
      const map = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      const leader = IO_LEADERS.includes(acc.profile.name);
      for (const area of IO_AREAS) {
        for (const action of ['export', 'import']) {
          const held = (map[area] ?? []).includes(action);
          const mayView = (map[area] ?? []).includes('view');
          if (held && !leader) ioLeaks.push(`${acc.profile.name} holds ${area}:${action}`);
          // A leader who can read the register must be able to move it.
          if (!held && leader && mayView) ioLeaks.push(`${acc.profile.name} lacks ${area}:${action}`);
        }
      }
      // Reserving the bulk right must not have cost the bench the daily one:
      // whoever logs a maintenance job still logs it. (Profiles that only read
      // the register — the quality office, the internal auditor — are meant to
      // hold view alone, so they are not asked this.)
      if (BENCH.includes(acc.profile.name)
          && (map['equipment.maintenance'] ?? []).includes('view')
          && !(map['equipment.maintenance'] ?? []).includes('create')) {
        ioLeaks.push(`${acc.profile.name} lost the daily right to log maintenance`);
      }
    }
    check('bulk export and import of the equipment and stores registers is the leadership\'s alone',
      ioLeaks.length === 0, ioLeaks.slice(0, 10).join(' | '));

    // And the API says the same thing, not just the map the client is handed.
    const ioApi = [];
    for (const acc of accounts) {
      const leader = IO_LEADERS.includes(acc.profile.name);
      const r = await call('/equipment/maintenance/export', { token: acc.token });
      if (!leader && r.status !== 403) ioApi.push(`${acc.profile.name}: the maintenance export returned ${r.status}, expected 403`);
      if (leader && r.status === 403) ioApi.push(`${acc.profile.name}: the maintenance export was refused`);
    }
    check('and the endpoint behind it refuses everybody else', ioApi.length === 0, ioApi.slice(0, 8).join(' | '));
  }

  /* ======================================================================
     7 — Every organogram position says which profile its holders work under
     ====================================================================== */
  console.log('\n[7] The organogram is wired to the access model');
  {
    const catalogue = (await call('/permissions/catalogue', { token: A })).json;
    const active = (catalogue.positions ?? []).filter(p => p.isActive !== 0);
    const unmapped = active.filter(p => p.accessProfileId === null);
    check('every active position is mapped to an access profile', unmapped.length === 0,
      unmapped.map(p => p.title).join(', '));
  }

  /* ======================================================================
     8 — An inbox is one person's
     ====================================================================== */
  console.log('\n[8] An inbox shows one person their own work');
  {
    const bench = accounts.find(a => a.profile.name === 'Technician');
    if (!bench) {
      console.log('   (skipped: no Technician profile in this database)');
    } else {
      const mine = (await call('/notifications', { token: bench.token })).json ?? [];
      const strangers = mine.filter(n => n.assigned_to_staff_id && n.assigned_to_staff_id !== bench.user.staffId);
      check('the default listing carries nobody else\'s work', strangers.length === 0,
        `${strangers.length} of ${mine.length} rows belong to somebody else`);
      const everyone = await call('/notifications?all=true', { token: bench.token });
      check('and asking for everybody\'s does not widen it',
        (everyone.json ?? []).filter(n => n.assigned_to_staff_id && n.assigned_to_staff_id !== bench.user.staffId).length === 0);
    }
  }

  /* ======================================================================
     9 — Every write endpoint, every profile: the map and the API agree
     ----------------------------------------------------------------------
     Sections 1–8 answer for the surfaces somebody thought to look at. This one
     answers for all of them at once, and for every profile rather than the
     bench: it reads the server's OWN guard off each write route and asserts
     that the effective permission map — the thing every button in the client
     is drawn from — says the same. Where they disagree, a control is either
     shown and then refused, or hidden from somebody entitled to it.
     ====================================================================== */
  console.log('\n[9] Every write route agrees with the map, for every profile');
  {
    const fs = await import('node:fs');
    const path = await import('node:path');

    // The server's mounted route table, read from the source at audit time so
    // it can never drift from what is actually running.
    const idx = fs.readFileSync('server/index.ts', 'utf8');
    const mounts = {};
    for (const m of idx.matchAll(/app\.use\('(\/api[^']*)',\s*([A-Za-z_$][\w$]*)\(?\)?\)/g)) {
      (mounts[m[2]] ??= []).push(m[1].replace(/^\/api/, ''));
    }
    const factoryFile = {};
    for (const m of idx.matchAll(/import \{ ([A-Za-z_$][\w$]*) \} from '\.\/routes\/([\w.]+)\.js'/g)) factoryFile[m[1]] = m[2] + '.ts';

    const routes = [];
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
        const m = l.match(/router\.(post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`](.*)$/);
        if (!m) return;
        const w = [m[3], lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
        const g = w.match(/requirePermission\(\s*([A-Z_0-9]+|'[^']+')\s*,\s*'([^']+)'/);
        if (!g) return;
        let key = g[1].replace(/'/g, '');
        if (consts[key]) key = consts[key];
        // Some handlers carry a SECOND gate the permission map cannot express:
        // the administrator flag, reserved for the few acts that rewrite a
        // quality record after the fact. Those are probed separately below.
        const body = lines.slice(i, i + 12).join(' ');
        const adminOnly = /isAdminUser\(req\)|requireAdministrator/.test(body);
        // Only routes whose path is fully static can be probed safely — a
        // parameterised one would need a real record to aim at.
        for (const p of prefixes) {
          const full = (p + (m[2] === '/' ? '' : m[2])) || '/';
          if (full.includes(':')) continue;
          routes.push({ verb: m[1].toUpperCase(), path: full, key, action: g[2], adminOnly });
        }
      });
    }

    const mismatches = [];
    let probed = 0;
    for (const acc of accounts) {
      const map = (await call('/auth/permissions', { token: acc.token })).json.permissions ?? {};
      for (const r of routes) {
        const shown = (map[r.key] ?? []).includes(r.action);
        // An empty body is enough: a permission refusal (403) is decided before
        // any field validation (400), so the two are distinguishable.
        const res = await call(r.path, { token: acc.token, method: r.verb, body: {} });
        if (res.status === 404 || res.status >= 500) continue;
        const refused = res.status === 403;
        probed++;
        // An administrator-only act is refused to everybody else whatever the
        // map says; the client hides it on the same flag (see the static audit).
        if (r.adminOnly) {
          const isAdmin = acc.profile.isAdministrator === 1 || acc.profile.name === 'System Administrator';
          if (!isAdmin && !refused) mismatches.push(`${acc.profile.name} ${r.verb} ${r.path}: administrator-only act was allowed`);
          continue;
        }
        if (shown === refused) {
          mismatches.push(`${acc.profile.name} ${r.verb} ${r.path}: map says ${shown ? 'allowed' : 'denied'}, API ${refused ? 'refused' : 'allowed'} (${r.key}:${r.action})`);
        }
      }
    }
    check(`the map matches the API on every static write route (${probed} probes)`,
      mismatches.length === 0, mismatches.slice(0, 10).join(' | '));
  }

  /* ======================================================================
     10 — Nothing has been hidden from the people who should see it
     ----------------------------------------------------------------------
     The other direction. Section 9 proves no control is shown that the API
     refuses; this proves the gates are not over-tight — every permission the
     client asks for anywhere in the interface is one the administrator
     profile actually holds, so no screen has been quietly emptied.
     ====================================================================== */
  console.log('\n[10] Every gate the interface asks for is one the administrator holds');
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const walk = (d, acc = []) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, acc); else if (/\.tsx?$/.test(e.name)) acc.push(p);
      }
      return acc;
    };
    const asked = new Set();
    for (const f of walk('src')) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bcan\(\s*'([a-z_.]+)'\s*,\s*'([a-z_]+)'\s*\)/g)) {
        asked.add(`${m[1]}:${m[2]}`);
      }
    }
    const adminMap = (await call('/auth/permissions', { token: A })).json.permissions ?? {};
    const unheld = [...asked].filter(g => {
      const [k, a] = g.split(':');
      return !(adminMap[k] ?? []).includes(a);
    });
    check(`every gate in the interface (${asked.size}) is held by the administrator`,
      unheld.length === 0, unheld.slice(0, 12).join(', '));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
