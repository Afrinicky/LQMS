import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import setupRoutes from './routes/setup.js';
import authRoutes from './routes/auth.js';
import { commonRoutes } from './routes/common.js';
import { nonconformityRoutes } from './routes/nonconformities.js';
import { incidentRoutes } from './routes/incidents.js';
import { capaRoutes } from './routes/capa.js';
import { complaintsRoutes } from './routes/complaints.js';
import { riskRoutes } from './routes/risks.js';
import { equipmentRoutes } from './routes/equipment.js';
import { inventoryRoutes } from './routes/inventory.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { safetyRoutes } from './routes/safety.js';
import { organisationRoutes } from './routes/organisation.js';
import { iqcRoutes } from './routes/iqc.js';
import { iqcRunRoutes } from './routes/iqcRuns.js';
import { iqcImportExportRoutes } from './routes/iqcImportExport.js';
import { iqcAdminRoutes } from './routes/iqcAdmin.js';
import { backupSyncRoutes } from './routes/backupSync.js';
import { eqaRoutes } from './routes/eqa.js';
import { verificationValidationRoutes } from './routes/verificationValidation.js';
import { measurementUncertaintyRoutes } from './routes/measurementUncertainty.js';
import { bloodBankHandoverRoutes } from './routes/bloodBankHandover.js';
import { monthlyReportsRoutes } from './routes/monthlyReports.js';
import { documentControlRoutes } from './routes/documents.js';
import { centralArchivesRoutes } from './routes/archives.js';
import { organisationExtendedRoutes } from './routes/organisationExtended.js';
import { personnelRoutes } from './routes/personnel.js';
import { schedulingRoutes } from './routes/scheduling.js';
import { dutyActivityRoutes } from './routes/dutyActivities.js';
import { systemAuditRoutes } from './routes/systemAudit.js';
import { scannedRecordsRoutes } from './routes/scannedRecords.js';
import { assessmentsRoutes } from './routes/assessments.js';
import { meetingsRoutes } from './routes/meetings.js';
import { managementReviewRoutes } from './routes/managementReview.js';
import { qualityIndicatorsRoutes } from './routes/qualityIndicators.js';
import { improvementRoutes } from './routes/improvement.js';
import { customerFocusRoutes } from './routes/customerFocus.js';
import { poctRoutes } from './routes/poct.js';
import { notificationsRoutes, computeSummary } from './routes/notifications.js';
import { recordsReportsRoutes } from './routes/recordsReports.js';
import { processManagementRoutes } from './routes/processManagement.js';
import { informationManagementRoutes } from './routes/informationManagement.js';
import { environmentalRoutes } from './routes/environmental.js';
import { EnvironmentalPoller } from './services/environmental/monitorService.js';
import { dennisRoutes } from './routes/dennis.js';
import { syncRoutes } from './routes/sync.js';
import { getSyncEngine } from './sync/syncEngine.js';
import { remoteAccessRoutes } from './routes/remoteAccess.js';
import { mobileRoutes } from './routes/mobile.js';
import { formsRoutes } from './routes/forms.js';
import { signatureRoutes } from './routes/signatures.js';
import { qrRoutes } from './routes/qr.js';
import { pushRoutes } from './routes/push.js';
import { optionalAuth } from './middleware/auth.js';
import { ensureDataDirs, getDb } from './db/database.js';
import { seedDefaults } from './db/seed.js';
import { config, isLanExposed } from './config/index.js';
import { SignatureRefused } from './services/signatureService.js';

/**
 * Resolve the directory that holds the built renderer (dist/index.html).
 * The packaged Electron main process passes SECH_LIMS_RENDERER_DIR; otherwise
 * we probe paths relative to this compiled file and the working directory.
 */
function resolveRendererDir(): string | null {
  const fromEnv = process.env.SECH_LIMS_RENDERER_DIR;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'index.html'))) return fromEnv;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    fromEnv,
    path.resolve(here, '../../dist'), // packaged: dist-electron/server -> dist
    path.resolve(here, '../dist'),    // dev tsx: server -> ../dist (if built)
    path.resolve(process.cwd(), 'dist'),
  ].filter(Boolean) as string[];

  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

/**
 * Which origins may call this Host from a browser.
 *
 * The old policy reflected whatever Origin the caller sent and allowed
 * credentials with it, which on a Host bound to the LAN removes the browser's
 * same-origin protection for any page a member of staff happens to open
 * (validation finding VF-16). The allow-list is: the Host's own addresses, the
 * Vite dev server, anything the laboratory has configured as a public URL, and
 * whatever it lists in SECH_LIMS_ALLOWED_ORIGINS.
 *
 * A request with no Origin header at all — the desktop shell, the mobile app,
 * curl, the check scripts — is not a browser cross-origin request and is
 * allowed through; the bearer token is what protects those.
 */
type CorsPolicy = NonNullable<Parameters<typeof cors>[0]>;

function buildCorsPolicy(): CorsPolicy {
  const allowed = new Set<string>();
  const port = config.api.port;
  for (const host of ['127.0.0.1', 'localhost']) {
    allowed.add(`http://${host}:${port}`);
    allowed.add(`https://${host}:${port}`);
    allowed.add(`http://${host}:5173`); // Vite dev server
  }
  if (config.api.publicUrl) allowed.add(config.api.publicUrl.replace(/\/$/, ''));
  for (const extra of (process.env.SECH_LIMS_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = extra.trim().replace(/\/$/, '');
    if (trimmed) allowed.add(trimmed);
  }
  // Serving the LAN means serving this Host's own addresses.
  if (isLanExposed()) {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          allowed.add(`http://${net.address}:${port}`);
          allowed.add(`https://${net.address}:${port}`);
        }
      }
    }
  }
  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.has(origin.replace(/\/$/, ''))) return callback(null, true);
      callback(null, false); // no CORS headers: the browser refuses it
    },
  };
}

/**
 * The handful of headers that cost nothing and close off a category of attack
 * each (validation finding VF-15). Written by hand rather than pulling in
 * another dependency for eleven lines — this Host already carries more
 * third-party code than it needs.
 */
function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  // The renderer is a bundled SPA served from this origin. 'unsafe-inline' for
  // styles is what Vite's injected styles need; scripts are not given it.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; " +
    "base-uri 'self'; frame-ancestors 'none'");
  if (tlsOptions()) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

/**
 * TLS material, when the laboratory has provided it.
 *
 * Serving the LAN over plain HTTP puts every password and every quality record
 * on the wire in clear (validation finding VF-01). Point SECH_LIMS_TLS_CERT and
 * SECH_LIMS_TLS_KEY at a certificate and the Host serves HTTPS instead. On a
 * LAN an internally-issued certificate is enough, and is what the deployment
 * runbook describes.
 */
export function tlsOptions(): { cert: Buffer; key: Buffer } | null {
  const certPath = process.env.SECH_LIMS_TLS_CERT;
  const keyPath = process.env.SECH_LIMS_TLS_KEY;
  if (!certPath || !keyPath) return null;
  try {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (err) {
    console.error('[tls] Certificate or key could not be read; refusing to start without the encryption that was asked for.', err);
    throw err;
  }
}

export function createApiServer() {
  ensureDataDirs();
  seedDefaults();
  const app = express();
  app.set('trust proxy', true); // so req.ip is the client, not the TLS terminator
  app.use(cors(buildCorsPolicy()));
  app.use(securityHeaders);
  // Controlled-document content can embed images (data URIs) and rich HTML, so
  // allow large JSON bodies for the document content save endpoints.
  app.use(express.json({ limit: '50mb' }));
  app.use(optionalAuth);
  app.get('/api/health', (_req, res) => res.json({ ok: true, product: 'SECH_LIMS by Nickland', lanReady: true }));
  app.use('/api/setup', setupRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/nonconformities', nonconformityRoutes());
  app.use('/api/incidents', incidentRoutes());
  app.use('/api/capa', capaRoutes());
  app.use('/api/complaints', complaintsRoutes());
  app.use('/api/risks', riskRoutes());
  app.use('/api/equipment', equipmentRoutes());
  app.use('/api/supplier-inventory', inventoryRoutes());
  app.use('/api/monitoring', monitoringRoutes());
  app.use('/api/facilities-safety', safetyRoutes());
  app.use('/api/organisation', organisationRoutes());
  // Runs, analytes and charts mount first so their specific paths win over
  // the older material/result routes that share the same prefix.
  app.use('/api/iqc', iqcAdminRoutes());
  app.use('/api/iqc', iqcImportExportRoutes());
  app.use('/api/iqc', iqcRunRoutes());
  app.use('/api/iqc', iqcRoutes());
  app.use('/api/eqa', eqaRoutes());
  app.use('/api/verification-validation', verificationValidationRoutes());
  app.use('/api/measurement-uncertainty', measurementUncertaintyRoutes());
  app.use('/api/blood-bank-handover', bloodBankHandoverRoutes());
  app.use('/api/monthly-reports', monthlyReportsRoutes());
  app.use('/api/documents', documentControlRoutes());
  // Central Archive — a single register of every archived record no matter
  // which module produced it. Mounted under /api/archives (searchable) and
  // also as /api/documents/archives so it appears inside Documents & Records.
  app.use('/api/archives', centralArchivesRoutes());
  app.use('/api/documents/archives', centralArchivesRoutes());
  // Organisation & Leadership extended tabs — ethical declarations, organogram
  // continuity plans, budget projections (enriched), quality & technical
  // records review workspace.
  app.use('/api/organisation', organisationExtendedRoutes());
  app.use('/api/dennis', dennisRoutes());
  app.use('/api/personnel', personnelRoutes());
  app.use('/api/scheduling', schedulingRoutes());
  // Duty-driven unit activities, the reminders they raise and the sound catalogue.
  app.use('/api/duty', dutyActivityRoutes());
  // The system's audit of itself: the live trail, and everything not done.
  app.use('/api/system-audit', systemAuditRoutes());
  app.use('/api/scanned-records', scannedRecordsRoutes());
  app.use('/api/assessments', assessmentsRoutes());
  app.use('/api/meetings', meetingsRoutes());
  app.use('/api/management-review', managementReviewRoutes());
  app.use('/api/quality-indicators', qualityIndicatorsRoutes());
  app.use('/api/improvement', improvementRoutes());
  app.use('/api/customer-focus', customerFocusRoutes());
  app.use('/api/poct', poctRoutes());
  app.use('/api/notifications', notificationsRoutes());
  app.use('/api/records-reports', recordsReportsRoutes());
  app.use('/api/process-management', processManagementRoutes());
  app.use('/api/information-management', informationManagementRoutes());
  app.use('/api/environmental', environmentalRoutes());
  app.use('/api/sync', syncRoutes());
  app.use('/api/remote-access', remoteAccessRoutes());
  // Phase 2 Companion App expansion: mobile aggregation, digital forms engine,
  // electronic signatures, QR infrastructure and push-notification framework.
  app.use('/api/mobile', mobileRoutes());
  app.use('/api/forms', formsRoutes());
  app.use('/api/signatures', signatureRoutes());
  app.use('/api/qr', qrRoutes());
  app.use('/api/push', pushRoutes());
  // Scheduling and off-site copies mount before commonRoutes so their more
  // specific /backup/* paths win over the archive endpoints that share the prefix.
  app.use('/api', backupSyncRoutes());
  app.use('/api', commonRoutes());

  // Serve the built single-page renderer so the packaged Electron window can
  // load the UI over http://127.0.0.1:<port>/ (same origin as the API) instead
  // of file://. In dev, Vite serves the renderer separately and this is a no-op.
  const rendererDir = resolveRendererDir();
  if (rendererDir) {
    app.use(express.static(rendererDir, { index: false }));
    // Mobile Staff Companion PWA: served at /m (and any /m/* client route) from
    // its own entry (mobile.html) built alongside the desktop renderer. Same
    // origin as the API, so it works over the LAN and over Tailscale unchanged.
    const mobileFile = path.join(rendererDir, 'mobile.html');
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path !== '/m' && req.path !== '/m/' && !req.path.startsWith('/m/')) return next();
      if (req.path.includes('.')) return next(); // let missing assets 404 normally
      if (!fs.existsSync(mobileFile)) return next();
      res.sendFile(mobileFile, err => { if (err) next(err); });
    });
    // SPA fallback: any non-API GET that did not match a static asset returns
    // index.html so client-side routes (/home, /dashboard, …) resolve. Uses a
    // plain middleware to stay compatible with Express 5 path matching.
    const indexFile = path.join(rendererDir, 'index.html');
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api')) return next();
      if (req.path.includes('.')) return next(); // let missing assets 404 normally
      res.sendFile(indexFile, err => { if (err) next(err); });
    });
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // A refused signature is the caller's problem to fix, not a server fault:
    // it deserves the status that says so, wherever in the system it was raised.
    if (err instanceof SignatureRefused) return res.status(err.status).json({ error: err.message });
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    res.status(500).json({ error: message });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = config.api.port;
  const host = config.api.host;
  const app = createApiServer();
  const tls = tlsOptions();

  // Serving the LAN in clear text is what validation finding VF-01 was about.
  // A laboratory that binds to the network without a certificate is warned in
  // terms that say what is actually at stake, every time the Host starts.
  if (!tls && isLanExposed()) {
    console.warn(
      '\n  ⚠  This Host is bound to the network WITHOUT TLS.\n' +
      '     Passwords and quality records will cross the LAN in clear text and can be read\n' +
      '     by anything on it. Set SECH_LIMS_TLS_CERT and SECH_LIMS_TLS_KEY before serving\n' +
      '     desktop or mobile clients. See docs/DEPLOYMENT_RUNBOOK.md.\n');
  }

  const server = tls ? https.createServer(tls, app) : app;
  server.listen(port, host, () => {
    console.log(`SECH_LIMS host API listening on ${tls ? 'https' : 'http'}://${host}:${port}`);
    // Background environmental poller. It self-gates on environmental_settings
    // (polling_enabled), so it is idle until a lab turns automated polling on.
    try { new EnvironmentalPoller(getDb).start(); } catch (e) { console.error('Environmental poller failed to start', e); }
    // Automatic backups. Self-gates on the stored schedule, so it is idle until
    // a laboratory turns them on, and it takes a missed backup shortly after a
    // host that was switched off overnight comes back.
    import('./services/backupService.js').then(({ BackupScheduler }) => {
      new BackupScheduler().start();
    }).catch(e => console.error('Backup scheduler failed to start', e));
    // Synchronization engine (stub). Self-gates on SECH_LIMS_SYNC_ENABLED and
    // does nothing while sync is disabled — reserved for the future cloud phase.
    try { getSyncEngine().start(); } catch (e) { console.error('Sync engine failed to start', e); }
    // Background alert scheduler: automatically scans every module for due,
    // overdue, expiring, excursion and pending items and routes notifications
    // to the right staff by section + role. Runs shortly after boot and then
    // every 15 minutes (the routed scan itself is idempotent/deduplicated).
    import('./services/alertService.js').then(({ runAlertScanAndRoute }) => {
      const tick = () => { try { runAlertScanAndRoute(getDb(), null); } catch (e) { console.error('Alert scan failed', e); } };
      setTimeout(tick, 20000);
      setInterval(tick, 15 * 60 * 1000);
    }).catch(e => console.error('Alert scheduler failed to start', e));
    // Duty & activity scheduler. Three jobs on one timer:
    //   * carry a month's schedules forward when nobody prepared them, and
    //     remind the managers and unit heads who owe the next month's
    //   * raise the coming fortnight's activity occurrences and re-resolve who
    //     they belong to, so a mid-month roster change lands immediately
    //   * close the window on anything never done, and put today's work on the
    //     right dashboards with a sound
    // It runs shortly after boot so a host switched on at the start of the shift
    // has the day's lists ready, then every ten minutes. Every step is
    // idempotent, so a restart mid-morning costs nothing.
    Promise.all([
      import('./services/scheduleRollover.js'),
      import('./services/activityService.js'),
      import('./services/systemAuditService.js'),
    ]).then(([schedules, activities, systemAudit]) => {
      const tick = () => {
        const db = getDb();
        try { schedules.runScheduleTick(db); } catch (e) { console.error('Schedule tick failed', e); }
        try { activities.runActivityTick(db); } catch (e) { console.error('Activity tick failed', e); }
        try { systemAudit.throttledAuditScan(db); } catch (e) { console.error('System audit scan failed', e); }
      };
      setTimeout(tick, 12000);
      setInterval(tick, 10 * 60 * 1000);
    }).catch(e => console.error('Duty & activity scheduler failed to start', e));
  });
}
