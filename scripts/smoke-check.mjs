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
checkFile('electron/preload.cjs');
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

// Offline-first hybrid architecture (config, data-access seam, sync)
checkFile('server/config/index.ts');
checkFile('server/db/dataStore.ts');
checkFile('server/db/sqliteStore.ts');
checkFile('server/db/postgresStore.ts');
checkFile('server/db/store.ts');
checkFile('server/db/syncableTables.ts');
checkFile('server/sync/syncEngine.ts');
checkFile('server/routes/sync.ts');
checkFile('server/utils/uuid.ts');
checkFile('.env.example');
checkFile('vercel.json');
checkFile('docs/HYBRID_ARCHITECTURE_PLAN.md');
checkFile('docs/DATA_ACCESS_LAYER.md');
checkFile('docs/SYNC_READY_SCHEMA.md');
checkFile('docs/SYNC_ENGINE_STUB.md');
checkFile('docs/CLOUD_SYNC.md');
checkFile('docs/CLIENTS_LAN_AND_PWA.md');

// PWA assets (installable mobile/desktop client)
checkFile('public/manifest.webmanifest');
checkFile('public/sw.js');
checkFile('public/icon-192.png');
checkFile('public/icon-512.png');
checkFile('public/icon-maskable-512.png');
checkFile('public/apple-touch-icon.png');

// Lightweight content assertions for the hybrid seams
try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf-8'));
  check('manifest.webmanifest parses and is standalone', manifest.display === 'standalone', manifest.display ?? 'missing');
  check('manifest.webmanifest declares icons', Array.isArray(manifest.icons) && manifest.icons.length > 0);
} catch (e) {
  check('manifest.webmanifest parses cleanly', false, String(e));
}
try {
  const sw = readFileSync(path.join(root, 'public/sw.js'), 'utf-8');
  // The service worker must never cache API responses (data stays live).
  check('service worker bypasses /api (no stale data cache)', /\/api/.test(sw) && /startsWith\('\/api'\)/.test(sw));
} catch (e) {
  check('service worker readable', false, String(e));
}
try {
  const html = readFileSync(path.join(root, 'index.html'), 'utf-8');
  check('index.html links the PWA manifest', /rel="manifest"/.test(html));
} catch (e) {
  check('index.html readable', false, String(e));
}

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
