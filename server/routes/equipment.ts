import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';

export function equipmentRoutes() {
  const router = Router();

  router.get('/', requirePermission('equipment', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_items ORDER BY created_at DESC').all());
  });

  router.get('/:id', requirePermission('equipment', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Equipment item not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('equipment', 'equipment_items', String(req.params.id), 'equipment', 'equipment_items', String(req.params.id));
    res.json({ ...item, links });
  });

  router.post('/', requirePermission('equipment', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const equipmentNumber = generateRecordNumber(db, 'equipment_items', 'EQP', createdAt);
    const result = db.prepare('INSERT INTO equipment_items (equipment_number, name, category, manufacturer, model, serial_number, location_id, department_id, section_id, status, calibration_due_date, last_service_date, next_service_due, assigned_to_staff_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        equipmentNumber,
        req.body.name,
        req.body.category ?? null,
        req.body.manufacturer ?? null,
        req.body.model ?? null,
        req.body.serialNumber ?? null,
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.status ?? 'operational',
        req.body.calibrationDueDate ?? null,
        req.body.lastServiceDate ?? null,
        req.body.nextServiceDue ?? null,
        parseIntNullable(req.body.assignedToStaffId),
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'equipment_items', entityId: result.lastInsertRowid, newValue: { equipmentNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, equipmentNumber });
  });

  router.put('/:id', requirePermission('equipment', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Equipment item not found' });
    db.prepare('UPDATE equipment_items SET name = ?, category = ?, manufacturer = ?, model = ?, serial_number = ?, location_id = ?, department_id = ?, section_id = ?, status = ?, calibration_due_date = ?, last_service_date = ?, next_service_due = ?, assigned_to_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.name ?? oldValue.name,
        req.body.category ?? oldValue.category,
        req.body.manufacturer ?? oldValue.manufacturer,
        req.body.model ?? oldValue.model,
        req.body.serialNumber ?? oldValue.serial_number,
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.status ?? oldValue.status,
        req.body.calibrationDueDate ?? oldValue.calibration_due_date,
        req.body.lastServiceDate ?? oldValue.last_service_date,
        req.body.nextServiceDue ?? oldValue.next_service_due,
        parseIntNullable(req.body.assignedToStaffId),
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'equipment_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}
