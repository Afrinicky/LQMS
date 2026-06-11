#!/usr/bin/env node
// SECH_LIMS by Nickland — Phase 16 smoke check.
// Read-only filesystem checks. Does not start a database. Does not
// modify, insert, or create any data. Safe to run any time.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const checks = [];
function check(label, ok, detail) { checks.push({ label, ok: !!ok, detail: detail ?? '' }); }
function fileExists(rel) { return existsSync(path.join(root, rel)); }
function checkFile(rel) { check(`file present: ${rel}`, fileExists(rel)); }

// Top-level configuration
checkFile('package.json');
checkFile('tsconfig.json');
checkFile('tsconfig.electron.json');
checkFile('vite.config.ts');
checkFile('README.md');

// Electron entry points
checkFile('electron/main.ts');
checkFile('electron/preload.ts');
checkFile('electron/apiServer.ts');

// Server entry + core routes
checkFile('server/index.ts');
checkFile('server/db/database.ts');
checkFile('server/db/seed.ts');
checkFile('server/routes/common.ts');
checkFile('server/routes/auth.ts');
checkFile('server/routes/setup.ts');
checkFile('server/routes/notifications.ts');
checkFile('server/routes/recordsReports.ts');
checkFile('server/routes/processManagement.ts');
checkFile('server/routes/informationManagement.ts');
checkFile('server/routes/routeHelpers.ts');
checkFile('server/services/auditService.ts');

// Shared
checkFile('shared/constants/modules.ts');
checkFile('shared/types/api.ts');

// Frontend
checkFile('src/App.tsx');
checkFile('src/layouts/AppLayout.tsx');
checkFile('src/pages/CorePages.tsx');
checkFile('src/pages/SettingsPages.tsx');
checkFile('src/components/LinkedRecordsPanel.tsx');
checkFile('src/pages/DocumentControlPage.tsx');
checkFile('src/pages/PersonnelManagementPage.tsx');
checkFile('src/pages/Phase8Pages.tsx');
checkFile('src/pages/CustomerFocusPage.tsx');
checkFile('src/pages/POCTPage.tsx');
checkFile('src/pages/NotificationsPage.tsx');
checkFile('src/pages/RecordsReportsPage.tsx');
checkFile('src/pages/ProcessManagementPage.tsx');
checkFile('src/pages/InformationManagementPage.tsx');

// Docs
checkFile('docs/ACCEPTANCE_TESTING_PHASE_15.md');
checkFile('docs/WINDOWS_INSTALLER_AND_LAN_DEPLOYMENT.md');
checkFile('docs/RELEASE_CANDIDATE_CHECKLIST.md');
checkFile('docs/MODULE_ROUTE_SMOKE_TEST.md');

// package.json scripts
try {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const scripts = pkg.scripts ?? {};
  for (const s of ['dev', 'api', 'typecheck', 'build', 'smoke', 'pack', 'dist', 'dist:win']) {
    check(`package.json script: ${s}`, !!scripts[s], scripts[s] || 'missing');
  }
  check('package.json build.appId set', pkg.build?.appId === 'com.nickland.sechlims', pkg.build?.appId ?? 'missing');
  check('package.json build.productName set', !!pkg.build?.productName, pkg.build?.productName ?? 'missing');
  check('package.json build.win target configured', Array.isArray(pkg.build?.win?.target), JSON.stringify(pkg.build?.win?.target ?? null));
  check('package.json build.asarUnpack includes better-sqlite3', (pkg.build?.asarUnpack ?? []).some(x => /better-sqlite3/.test(x)));
  check('main field points to dist-electron/electron/main.js', pkg.main === 'dist-electron/electron/main.js', pkg.main ?? 'missing');
} catch (e) {
  check('package.json parses cleanly', false, String(e));
}

// Final report
const failed = checks.filter(c => !c.ok);
const passed = checks.length - failed.length;
const out = [];
out.push(`SECH_LIMS by Nickland — Phase 16 smoke check`);
out.push(`---------------------------------------------`);
for (const c of checks) out.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
out.push('');
out.push(`Total: ${checks.length}   Passed: ${passed}   Failed: ${failed.length}`);
console.log(out.join('\n'));
process.exit(failed.length === 0 ? 0 : 1);
