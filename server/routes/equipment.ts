import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const BREAKDOWN_STATUSES = ['open', 'under_repair', 'action_required', 'returned_to_service', 'closed'];
const EQUIPMENT_STATUSES = ['active', 'operational', 'out_of_service', 'under_repair', 'restricted_use', 'retired'];

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
    const maintenance = db.prepare('SELECT * FROM equipment_maintenance_records WHERE equipment_id = ? ORDER BY maintenance_date DESC').all(req.params.id);
    const breakdowns = db.prepare('SELECT * FROM equipment_breakdowns WHERE equipment_id = ? ORDER BY breakdown_date DESC').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('equipment', 'equipment_items', String(req.params.id), 'equipment', 'equipment_items', String(req.params.id));
    res.json({ ...item, maintenance, breakdowns, links });
  });

  router.post('/', requirePermission('equipment', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    if (!req.body.status) return res.status(400).json({ error: 'status is required' });
    if (!EQUIPMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const equipmentNumber = generateRecordNumber(db, 'equipment_items', 'EQP', createdAt);
    const responsibleStaffId = parseIntNullable(req.body.responsibleStaffId ?? req.body.assignedToStaffId);
    const nextMaintenanceDue = req.body.nextMaintenanceDue ?? req.body.nextServiceDue ?? null;
    const result = db.prepare(`INSERT INTO equipment_items (equipment_number, name, category, manufacturer, model, serial_number, location_id, department_id, section_id, status, calibration_due_date, last_service_date, next_service_due, assigned_to_staff_id, equipment_type, maintenance_frequency, calibration_frequency, next_maintenance_due, next_calibration_due, responsible_staff_id, date_received, date_commissioned, calibration_required, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        req.body.status,
        req.body.calibrationDueDate ?? req.body.nextCalibrationDue ?? null,
        req.body.lastServiceDate ?? null,
        nextMaintenanceDue,
        responsibleStaffId,
        req.body.equipmentType ?? null,
        req.body.maintenanceFrequency ?? null,
        req.body.calibrationFrequency ?? null,
        nextMaintenanceDue,
        req.body.nextCalibrationDue ?? req.body.calibrationDueDate ?? null,
        responsibleStaffId,
        req.body.dateReceived ?? null,
        req.body.dateCommissioned ?? null,
        req.body.calibrationRequired ? 1 : 0,
        req.body.notes ?? null,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'equipment_items', entityId: result.lastInsertRowid, newValue: { equipmentNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, equipmentNumber });
  });

  router.put('/:id', requirePermission('equipment', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Equipment item not found' });
    if (req.body.status && !EQUIPMENT_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_STATUSES.join(', ')}` });
    }
    const responsibleStaffId = parseIntNullable(req.body.responsibleStaffId ?? req.body.assignedToStaffId) ?? oldValue.responsible_staff_id ?? oldValue.assigned_to_staff_id;
    db.prepare(`UPDATE equipment_items SET name = ?, category = ?, manufacturer = ?, model = ?, serial_number = ?, location_id = ?, department_id = ?, section_id = ?, status = ?, calibration_due_date = ?, last_service_date = ?, next_service_due = ?, assigned_to_staff_id = ?, equipment_type = ?, maintenance_frequency = ?, calibration_frequency = ?, next_maintenance_due = ?, next_calibration_due = ?, responsible_staff_id = ?, date_received = ?, date_commissioned = ?, calibration_required = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.name ?? oldValue.name,
        req.body.category ?? oldValue.category,
        req.body.manufacturer ?? oldValue.manufacturer,
        req.body.model ?? oldValue.model,
        req.body.serialNumber ?? oldValue.serial_number,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.status ?? oldValue.status,
        req.body.calibrationDueDate ?? oldValue.calibration_due_date,
        req.body.lastServiceDate ?? oldValue.last_service_date,
        req.body.nextServiceDue ?? req.body.nextMaintenanceDue ?? oldValue.next_service_due,
        responsibleStaffId,
        req.body.equipmentType ?? oldValue.equipment_type,
        req.body.maintenanceFrequency ?? oldValue.maintenance_frequency,
        req.body.calibrationFrequency ?? oldValue.calibration_frequency,
        req.body.nextMaintenanceDue ?? oldValue.next_maintenance_due,
        req.body.nextCalibrationDue ?? oldValue.next_calibration_due,
        responsibleStaffId,
        req.body.dateReceived ?? oldValue.date_received,
        req.body.dateCommissioned ?? oldValue.date_commissioned,
        req.body.calibrationRequired !== undefined ? (req.body.calibrationRequired ? 1 : 0) : oldValue.calibration_required,
        req.body.notes ?? oldValue.notes,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'equipment_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // Maintenance records
  router.get('/:id/maintenance', requirePermission('equipment', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_maintenance_records WHERE equipment_id = ? ORDER BY maintenance_date DESC').all(req.params.id));
  });

  router.post('/:id/maintenance', requirePermission('equipment', 'create'), (req, res) => {
    if (!req.body.maintenanceDate) return res.status(400).json({ error: 'maintenanceDate is required' });
    if (!req.body.maintenanceType) return res.status(400).json({ error: 'maintenanceType is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const result = db.prepare(`INSERT INTO equipment_maintenance_records (equipment_id, maintenance_date, maintenance_type, performed_by_staff_id, findings, action_taken, next_due_date, status, evidence_file_id, reviewed_by_staff_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.maintenanceDate,
        req.body.maintenanceType,
        performedBy,
        req.body.findings ?? null,
        req.body.actionTaken ?? null,
        req.body.nextDueDate ?? null,
        req.body.status ?? 'completed',
        parseIntNullable(req.body.evidenceFileId),
        parseIntNullable(req.body.reviewedByStaffId),
        req.user!.id
      );
    if (req.body.nextDueDate) {
      db.prepare('UPDATE equipment_items SET last_service_date = ?, next_service_due = ?, next_maintenance_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(req.body.maintenanceDate, req.body.nextDueDate, req.body.nextDueDate, req.params.id);
    } else {
      db.prepare('UPDATE equipment_items SET last_service_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.maintenanceDate, req.params.id);
    }
    audit(req, { action: 'create', entity: 'equipment_maintenance_records', entityId: result.lastInsertRowid, newValue: { equipmentId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  // Breakdowns
  router.get('/:id/breakdowns', requirePermission('equipment', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_breakdowns WHERE equipment_id = ? ORDER BY breakdown_date DESC').all(req.params.id));
  });

  router.post('/:id/breakdown', requirePermission('equipment', 'create'), (req, res) => {
    if (!req.body.breakdownDate) return res.status(400).json({ error: 'breakdownDate is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id, status FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const equipmentStatusUpdate = req.body.equipmentStatus ?? 'out_of_service';
    if (equipmentStatusUpdate && !['out_of_service', 'under_repair', 'restricted_use'].includes(equipmentStatusUpdate)) {
      return res.status(400).json({ error: 'equipmentStatus must be out_of_service, under_repair, or restricted_use' });
    }
    const result = db.prepare(`INSERT INTO equipment_breakdowns (equipment_id, breakdown_date, reported_by_staff_id, description, service_impact, immediate_action, equipment_status, repair_action, service_provider, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.breakdownDate,
        reportedBy,
        req.body.description,
        req.body.serviceImpact ?? null,
        req.body.immediateAction ?? null,
        equipmentStatusUpdate,
        req.body.repairAction ?? null,
        req.body.serviceProvider ?? null,
        req.body.status ?? 'open',
        req.user!.id
      );
    db.prepare('UPDATE equipment_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(equipmentStatusUpdate, req.params.id);
    audit(req, { action: 'create', entity: 'equipment_breakdowns', entityId: result.lastInsertRowid, newValue: { equipmentId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/breakdowns/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const breakdown = db.prepare('SELECT * FROM equipment_breakdowns WHERE id = ?').get(req.params.id) as any;
    if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedByStaffId = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? breakdown.reported_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, impact_level, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        breakdown.breakdown_date,
        detectedByStaffId,
        'equipment',
        String(breakdown.id),
        req.body.title ?? `Equipment breakdown #${breakdown.id}`,
        req.body.description ?? breakdown.description,
        req.body.category ?? 'equipment',
        req.body.severity ?? 'medium',
        req.body.impactLevel ?? breakdown.service_impact ?? null,
        req.body.immediateCorrection ?? breakdown.immediate_action ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE equipment_breakdowns SET nc_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, 'action_required', req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_breakdowns', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC raised from equipment breakdown');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'equipment', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/breakdowns/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const breakdown = db.prepare('SELECT * FROM equipment_breakdowns WHERE id = ?').get(req.params.id) as any;
    if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        capaNumber,
        'equipment',
        String(breakdown.id),
        breakdown.nc_id ?? null,
        req.body.title ?? `CAPA for equipment breakdown #${breakdown.id}`,
        req.body.problemSummary ?? breakdown.description,
        req.body.rootCause ?? null,
        req.body.correctiveAction ?? breakdown.repair_action ?? null,
        req.body.preventiveAction ?? null,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.user!.id,
        createdAt
      );
    const capaId = Number(result.lastInsertRowid);
    db.prepare('UPDATE equipment_breakdowns SET capa_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, 'action_required', req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_breakdowns', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from equipment breakdown');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'equipment', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/breakdowns/:id/return-to-service', requirePermission('equipment', 'edit'), (req, res) => {
    const db = getDb();
    const breakdown = db.prepare('SELECT * FROM equipment_breakdowns WHERE id = ?').get(req.params.id) as any;
    if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });
    const verifiedByStaffId = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    if (verifiedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const returnDate = req.body.returnToServiceDate ?? new Date().toISOString();
    const newEquipmentStatus = req.body.equipmentStatus ?? 'operational';
    if (!EQUIPMENT_STATUSES.includes(newEquipmentStatus)) {
      return res.status(400).json({ error: `equipmentStatus must be one of: ${EQUIPMENT_STATUSES.join(', ')}` });
    }
    db.prepare('UPDATE equipment_breakdowns SET return_to_service_date = ?, verified_by_staff_id = ?, status = ?, repair_action = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(returnDate, verifiedByStaffId, 'returned_to_service', req.body.repairAction ?? breakdown.repair_action, req.params.id);
    db.prepare('UPDATE equipment_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newEquipmentStatus, breakdown.equipment_id);
    audit(req, { action: 'edit', entity: 'equipment_breakdowns', entityId: req.params.id, oldValue: breakdown, newValue: { returnToServiceDate: returnDate, verifiedByStaffId, status: 'returned_to_service' } });
    res.json({ ok: true });
  });

  return router;
}

export { BREAKDOWN_STATUSES, EQUIPMENT_STATUSES };
