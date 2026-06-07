import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';

export function safetyRoutes() {
  const router = Router();

  router.get('/', requirePermission('facilities_safety', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM safety_incidents ORDER BY incident_date DESC, created_at DESC').all());
  });

  router.get('/:id', requirePermission('facilities_safety', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Safety incident not found' });
    res.json(item);
  });

  router.post('/', requirePermission('facilities_safety', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const incidentNumber = generateRecordNumber(db, 'safety_incidents', 'SAF', createdAt);
    const result = db.prepare('INSERT INTO safety_incidents (incident_number, incident_date, location_id, department_id, section_id, reported_by_staff_id, description, category, severity, status, corrective_action, reported_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        incidentNumber,
        req.body.incidentDate ?? new Date().toISOString(),
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        parseIntNullable(req.body.reportedByStaffId),
        req.body.description,
        req.body.category ?? null,
        req.body.severity ?? null,
        req.body.status ?? 'open',
        req.body.correctiveAction ?? null,
        req.body.reportedTo ?? null,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'safety_incidents', entityId: result.lastInsertRowid, newValue: { incidentNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, incidentNumber });
  });

  router.put('/:id', requirePermission('facilities_safety', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Safety incident not found' });
    db.prepare('UPDATE safety_incidents SET incident_date = ?, location_id = ?, department_id = ?, section_id = ?, reported_by_staff_id = ?, description = ?, category = ?, severity = ?, status = ?, corrective_action = ?, reported_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.incidentDate ?? oldValue.incident_date,
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        parseIntNullable(req.body.reportedByStaffId),
        req.body.description ?? oldValue.description,
        req.body.category ?? oldValue.category,
        req.body.severity ?? oldValue.severity,
        req.body.status ?? oldValue.status,
        req.body.correctiveAction ?? oldValue.corrective_action,
        req.body.reportedTo ?? oldValue.reported_to,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'safety_incidents', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/close', requirePermission('facilities_safety', 'void_archive'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT status FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Safety incident not found' });
    db.prepare('UPDATE safety_incidents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status ?? 'closed', req.params.id);
    audit(req, { action: 'void_archive', entity: 'safety_incidents', entityId: req.params.id, oldValue, newValue: { status: req.body.status ?? 'closed' } });
    res.json({ ok: true });
  });

  return router;
}
