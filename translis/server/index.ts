/**
 * The TransLis host.
 *
 * Everything that carries a result from an analyser to a laboratory
 * information system, and nothing else. SECHLIMS mounts seventy routers; this
 * mounts six, and five of them are SECHLIMS's own files imported unchanged:
 *
 *   /api/auth               who is signed in
 *   /api/instrument-links   the analysers, and the bridge that reads them
 *   /api/middleware         the engine, the destinations, the routing, the queues
 *   /api/result-filler      the extension, the forms, the field mappings
 *   /api/transmission-reports   what a received result prints as
 *   /api/translis           this product's own setup, accounts, mode and retention
 *
 * The engine, the bridge and the filler are imported rather than copied. They
 * are the same files SECHLIMS runs, so a fix in either product is a fix in
 * both and the two can never drift into disagreeing about a protocol.
 *
 * The database is SECHLIMS's schema in a data folder of this product's own.
 * Reusing the schema is what makes importing the services honest — they were
 * written against those tables, and a hand-copied subset would be a second
 * schema to keep in step. The unused tables cost an empty file a megabyte and
 * buy exact agreement, which is the right side of that trade.
 */
// FIRST, before anything that reads where the database lives.
import './boot.js';

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authRoutes from '../../server/routes/auth.js';
import { instrumentLinkRoutes } from '../../server/routes/instrumentLinks.js';
import { middlewareRoutes } from '../../server/routes/middleware.js';
import { resultFillerRoutes } from '../../server/routes/resultFiller.js';
import { transmissionReportRoutes } from '../../server/routes/transmissionReports.js';
import { optionalAuth } from '../../server/middleware/auth.js';
import { ensureDataDirs, getDb } from '../../server/db/database.js';
import { SignatureRequiredError } from '../../server/services/signatureService.js';

import { PRODUCT, PRODUCT_LONG } from './brand.js';
import { translisRoutes } from './routes.js';
import { seedTransLis, setupComplete } from './seed.js';
import { listenHost, listenPort } from './network.js';
import { startTransLisServices } from './services.js';

/** Where the built TransLis renderer lives, when there is one. */
function rendererDir(): string | null {
  const fromEnv = process.env.TRANSLIS_RENDERER_DIR;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'index.html'))) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../dist-translis'),     // packaged
    path.resolve(here, '../../../dist-translis'),  // compiled into dist-electron
    path.resolve(process.cwd(), 'dist-translis'),  // run from the repository
  ];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

export function createTransLisServer() {
  ensureDataDirs();
  const db = getDb();
  // The access profiles are written on every boot rather than once. They are
  // this product's definition of what an account may do, not a laboratory's
  // choice, so an upgrade that adds a feature grants it to the administrator
  // without anybody having to notice.
  if (setupComplete(db)) seedTransLis(db);

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '8mb' }));
  app.use(optionalAuth);

  app.get('/api/health', (_req, res) => res.json({ ok: true, product: PRODUCT, productLong: PRODUCT_LONG }));

  app.use('/api/auth', authRoutes);
  app.use('/api/translis', translisRoutes());
  app.use('/api/instrument-links', instrumentLinkRoutes());
  app.use('/api/middleware', middlewareRoutes());
  app.use('/api/result-filler', resultFillerRoutes());
  app.use('/api/transmission-reports', transmissionReportRoutes());

  const dir = rendererDir();
  if (dir) {
    app.use(express.static(dir, { index: false }));
    const indexFile = path.join(dir, 'index.html');
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api')) return next();
      if (req.path.includes('.')) return next();
      res.sendFile(indexFile, err => { if (err) next(err); });
    });
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    if (err instanceof SignatureRequiredError) return res.status(400).json({ error: message, code: err.code });
    res.status(500).json({ error: message });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = listenHost();
  const port = listenPort();
  createTransLisServer().listen(port, host, () => {
    console.log(`[translis] ${PRODUCT_LONG}`);
    console.log(`[translis] listening on http://${host}:${port}`
      + (host === '127.0.0.1' ? ' (this computer only)' : ' (reachable from the network)'));
    startTransLisServices(getDb);
  });
}
