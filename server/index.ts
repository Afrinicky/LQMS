import express from 'express';
import cors from 'cors';
import setupRoutes from './routes/setup.js';
import authRoutes from './routes/auth.js';
import { commonRoutes } from './routes/common.js';
import { nonconformityRoutes } from './routes/nonconformities.js';
import { capaRoutes } from './routes/capa.js';
import { complaintsRoutes } from './routes/complaints.js';
import { riskRoutes } from './routes/risks.js';
import { equipmentRoutes } from './routes/equipment.js';
import { inventoryRoutes } from './routes/inventory.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { safetyRoutes } from './routes/safety.js';
import { iqcRoutes } from './routes/iqc.js';
import { eqaRoutes } from './routes/eqa.js';
import { verificationValidationRoutes } from './routes/verificationValidation.js';
import { measurementUncertaintyRoutes } from './routes/measurementUncertainty.js';
import { optionalAuth } from './middleware/auth.js';
import { ensureDataDirs } from './db/database.js';
import { seedDefaults } from './db/seed.js';

export function createApiServer() {
  ensureDataDirs();
  seedDefaults();
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(optionalAuth);
  app.get('/api/health', (_req, res) => res.json({ ok: true, product: 'SECH_LIMS by Nickland', lanReady: true }));
  app.use('/api/setup', setupRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/nonconformities', nonconformityRoutes());
  app.use('/api/capa', capaRoutes());
  app.use('/api/complaints', complaintsRoutes());
  app.use('/api/risks', riskRoutes());
  app.use('/api/equipment', equipmentRoutes());
  app.use('/api/supplier-inventory', inventoryRoutes());
  app.use('/api/monitoring', monitoringRoutes());
  app.use('/api/facilities-safety', safetyRoutes());
  app.use('/api/iqc', iqcRoutes());
  app.use('/api/eqa', eqaRoutes());
  app.use('/api/verification-validation', verificationValidationRoutes());
  app.use('/api/measurement-uncertainty', measurementUncertaintyRoutes());
  app.use('/api', commonRoutes());
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    res.status(500).json({ error: message });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? 4317);
  createApiServer().listen(port, '0.0.0.0', () => console.log(`SECH_LIMS host API listening on http://0.0.0.0:${port}`));
}
