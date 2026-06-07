import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';

export function monitoringRoutes() {
  const router = Router();

  router.get('/', requirePermission('monitoring', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM monitoring_records ORDER BY created_at DESC').all());
  });

  router.get('/:id', requirePermission('monitoring', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM monitoring_records WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Monitoring record not found' });
    res.json(item);
  });

  router.post('/', requirePermission('monitoring', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const monitoringNumber = generateRecordNumber(db, 'monitoring_records', 'MON', createdAt);
    const result = db.prepare('INSERT INTO monitoring_records (monitoring_number, parameter, target_range, actual_value, unit, sample_date, location_id, department_id, section_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        monitoringNumber,
        req.body.parameter,
        req.body.targetRange ?? null,
        req.body.actualValue ?? null,
        req.body.unit ?? null,
        req.body.sampleDate ?? new Date().toISOString(),
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.status ?? 'reported',
        req.body.notes ?? null,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'monitoring_records', entityId: result.lastInsertRowid, newValue: { monitoringNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, monitoringNumber });
  });

  router.put('/:id', requirePermission('monitoring', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM monitoring_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Monitoring record not found' });
    db.prepare('UPDATE monitoring_records SET parameter = ?, target_range = ?, actual_value = ?, unit = ?, sample_date = ?, location_id = ?, department_id = ?, section_id = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.parameter ?? oldValue.parameter,
        req.body.targetRange ?? oldValue.target_range,
        req.body.actualValue ?? oldValue.actual_value,
        req.body.unit ?? oldValue.unit,
        req.body.sampleDate ?? oldValue.sample_date,
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.status ?? oldValue.status,
        req.body.notes ?? oldValue.notes,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'monitoring_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}
