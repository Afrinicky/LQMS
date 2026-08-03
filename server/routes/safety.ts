import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const SAFETY_STATUSES = ['open', 'under_review', 'action_required', 'closed'];

export function safetyRoutes() {
  const router = Router();

  router.get('/', requirePermission('facilities_safety.incidents', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM safety_incidents ORDER BY incident_date DESC, created_at DESC').all());
  });

  router.get('/incidents', requirePermission('facilities_safety.incidents', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM safety_incidents ORDER BY incident_date DESC, created_at DESC').all());
  });

  router.post('/', requirePermission('facilities_safety.incidents', 'create'), (req, res) => {
    const result = createIncident(req);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.payload);
  });

  router.post('/incidents', requirePermission('facilities_safety.incidents', 'create'), (req, res) => {
    const result = createIncident(req);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.payload);
  });

  router.get('/incidents/:id', requirePermission('facilities_safety.incidents', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Safety incident not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('facilities_safety', 'safety_incidents', String(req.params.id), 'facilities_safety', 'safety_incidents', String(req.params.id));
    res.json({ ...item, links });
  });

  router.put('/incidents/:id', requirePermission('facilities_safety.incidents', 'edit'), (req, res) => updateIncident(req, res));

  // Numeric-guarded so the named sub-resource routes below (equipment,
  // inspections, waste, chemicals, immunizations, summary) are not shadowed:
  // non-numeric ids fall through to the later, more specific routes.
  const numericOnly = (req: any, res: any, next: any) => /^\d+$/.test(req.params.id) ? next() : next('route');
  router.get('/:id', numericOnly, requirePermission('facilities_safety.incidents', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Safety incident not found' });
    res.json(item);
  });

  router.put('/:id', numericOnly, requirePermission('facilities_safety.incidents', 'edit'), (req, res) => updateIncident(req, res));

  router.post('/:id/close', numericOnly, requirePermission('facilities_safety.incidents', 'void_archive'), (req, res) => closeIncident(req, res));
  router.post('/incidents/:id/close', requirePermission('facilities_safety.incidents', 'void_archive'), (req, res) => closeIncident(req, res));

  router.post('/incidents/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const incident = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id) as any;
    if (!incident) return res.status(404).json({ error: 'Safety incident not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedByStaffId = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? incident.reported_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        incident.incident_date,
        detectedByStaffId,
        'facilities_safety',
        String(incident.id),
        req.body.title ?? incident.title ?? `Safety incident #${incident.id}`,
        req.body.description ?? incident.description,
        req.body.category ?? incident.category ?? 'safety',
        req.body.severity ?? incident.severity ?? 'medium',
        req.body.immediateCorrection ?? incident.immediate_action ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE safety_incidents SET nc_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, 'action_required', req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('facilities_safety', 'safety_incidents', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from safety incident');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'facilities_safety', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/incidents/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const incident = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id) as any;
    if (!incident) return res.status(404).json({ error: 'Safety incident not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        capaNumber,
        'facilities_safety',
        String(incident.id),
        incident.nc_id ?? null,
        req.body.title ?? incident.title ?? `CAPA for safety incident #${incident.id}`,
        req.body.problemSummary ?? incident.description,
        req.body.rootCause ?? null,
        req.body.correctiveAction ?? incident.corrective_action ?? null,
        req.body.preventiveAction ?? null,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.user!.id,
        createdAt
      );
    const capaId = Number(result.lastInsertRowid);
    db.prepare('UPDATE safety_incidents SET capa_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, 'action_required', req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('facilities_safety', 'safety_incidents', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from safety incident');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'facilities_safety', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  // ============================================================
  // Facilities & Safety summary (dashboard)
  // ============================================================
  router.get('/summary', requirePermission('facilities_safety', 'view'), (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { count: number }).count;
    res.json({
      openIncidents: count("SELECT COUNT(*) count FROM safety_incidents WHERE status != 'closed'"),
      safetyEquipmentTotal: count('SELECT COUNT(*) count FROM safety_equipment'),
      equipmentDueInspection: count("SELECT COUNT(*) count FROM safety_equipment WHERE status != 'removed' AND next_inspection_due IS NOT NULL AND next_inspection_due <= ?", soon),
      equipmentCertificationDue: count("SELECT COUNT(*) count FROM safety_equipment WHERE status != 'removed' AND next_certification_due IS NOT NULL AND next_certification_due <= ?", soon),
      equipmentOutOfService: count("SELECT COUNT(*) count FROM safety_equipment WHERE status IN ('out_of_service','expired')"),
      openInspections: count("SELECT COUNT(*) count FROM safety_inspections WHERE status != 'closed'"),
      inspectionsFailed: count("SELECT COUNT(*) count FROM safety_inspections WHERE outcome = 'fail' AND status != 'closed'"),
      inspectionsDue: count('SELECT COUNT(*) count FROM safety_inspections WHERE next_due_date IS NOT NULL AND next_due_date <= ?', soon),
      wasteRecordsThisMonth: count("SELECT COUNT(*) count FROM waste_disposal_records WHERE strftime('%Y-%m', disposal_date) = strftime('%Y-%m', 'now')"),
      chemicalsTotal: count("SELECT COUNT(*) count FROM hazardous_chemicals WHERE status != 'disposed'"),
      chemicalsExpired: count("SELECT COUNT(*) count FROM hazardous_chemicals WHERE status != 'disposed' AND expiry_date IS NOT NULL AND expiry_date < ?", now),
      chemicalsMissingSds: count("SELECT COUNT(*) count FROM hazardous_chemicals WHERE status != 'disposed' AND (sds_on_file = 0 OR sds_on_file IS NULL)"),
      immunizationsDue: count('SELECT COUNT(*) count FROM staff_immunizations WHERE next_due_date IS NOT NULL AND next_due_date <= ?', soon),
      openPostExposure: count("SELECT COUNT(*) count FROM staff_immunizations WHERE record_type = 'post_exposure' AND (outcome IS NULL OR outcome = '')"),
    });
  });

  // ============================================================
  // Safety equipment register
  // ============================================================
  router.get('/equipment', requirePermission('facilities_safety.equipment', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM safety_equipment ORDER BY next_inspection_due IS NULL, next_inspection_due ASC, created_at DESC').all());
  });
  router.post('/equipment', requirePermission('facilities_safety.equipment', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'safety_equipment', 'SEQ', createdAt);
    const r = db.prepare(`INSERT INTO safety_equipment (equipment_number, name, equipment_type, serial_number, location_id, section_id, responsible_staff_id, status, inspection_frequency, last_inspection_date, next_inspection_due, certification_frequency, last_certification_date, next_certification_due, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.name, req.body.equipmentType ?? null, req.body.serialNumber ?? null, parseIntNullable(req.body.locationId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.responsibleStaffId), req.body.status ?? 'operational', req.body.inspectionFrequency ?? null, req.body.lastInspectionDate ?? null, req.body.nextInspectionDue ?? null, req.body.certificationFrequency ?? null, req.body.lastCertificationDate ?? null, req.body.nextCertificationDue ?? null, req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'safety_equipment', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, equipmentNumber: number });
  });
  router.put('/equipment/:id', requirePermission('facilities_safety.equipment', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM safety_equipment WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Safety equipment not found' });
    db.prepare(`UPDATE safety_equipment SET name = ?, equipment_type = ?, serial_number = ?, location_id = ?, section_id = ?, responsible_staff_id = ?, status = ?, inspection_frequency = ?, last_inspection_date = ?, next_inspection_due = ?, certification_frequency = ?, last_certification_date = ?, next_certification_due = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.name ?? old.name, req.body.equipmentType ?? old.equipment_type, req.body.serialNumber ?? old.serial_number, parseIntNullable(req.body.locationId) ?? old.location_id, parseIntNullable(req.body.sectionId) ?? old.section_id, parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id, req.body.status ?? old.status, req.body.inspectionFrequency ?? old.inspection_frequency, req.body.lastInspectionDate ?? old.last_inspection_date, req.body.nextInspectionDue ?? old.next_inspection_due, req.body.certificationFrequency ?? old.certification_frequency, req.body.lastCertificationDate ?? old.last_certification_date, req.body.nextCertificationDue ?? old.next_certification_due, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'safety_equipment', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ============================================================
  // Safety inspections / audits / drills
  // ============================================================
  router.get('/inspections', requirePermission('facilities_safety.inspections', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM safety_inspections ORDER BY inspection_date DESC, created_at DESC').all());
  });
  router.get('/inspections/:id', requirePermission('facilities_safety.inspections', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM safety_inspections WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Inspection not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('facilities_safety', 'safety_inspections', String(req.params.id), 'facilities_safety', 'safety_inspections', String(req.params.id));
    res.json({ ...item, links });
  });
  router.post('/inspections', requirePermission('facilities_safety.inspections', 'create'), (req, res) => {
    if (!req.body.inspectionDate) return res.status(400).json({ error: 'inspectionDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'safety_inspections', 'SINS', createdAt);
    const r = db.prepare(`INSERT INTO safety_inspections (inspection_number, inspection_type, inspection_date, section_id, location_id, conducted_by_staff_id, scope, findings_summary, outcome, corrective_action, status, next_due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.inspectionType ?? null, req.body.inspectionDate, parseIntNullable(req.body.sectionId), parseIntNullable(req.body.locationId), parseIntNullable(req.body.conductedByStaffId) ?? getStaffIdOrCurrent(req, null), req.body.scope ?? null, req.body.findingsSummary ?? null, req.body.outcome ?? null, req.body.correctiveAction ?? null, req.body.status ?? 'open', req.body.nextDueDate ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'safety_inspections', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, inspectionNumber: number });
  });
  router.put('/inspections/:id', requirePermission('facilities_safety.inspections', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM safety_inspections WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Inspection not found' });
    db.prepare(`UPDATE safety_inspections SET inspection_type = ?, inspection_date = ?, section_id = ?, location_id = ?, conducted_by_staff_id = ?, scope = ?, findings_summary = ?, outcome = ?, corrective_action = ?, status = ?, next_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.inspectionType ?? old.inspection_type, req.body.inspectionDate ?? old.inspection_date, parseIntNullable(req.body.sectionId) ?? old.section_id, parseIntNullable(req.body.locationId) ?? old.location_id, parseIntNullable(req.body.conductedByStaffId) ?? old.conducted_by_staff_id, req.body.scope ?? old.scope, req.body.findingsSummary ?? old.findings_summary, req.body.outcome ?? old.outcome, req.body.correctiveAction ?? old.corrective_action, req.body.status ?? old.status, req.body.nextDueDate ?? old.next_due_date, req.params.id);
    audit(req, { action: 'edit', entity: 'safety_inspections', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });
  router.post('/inspections/:id/close', requirePermission('facilities_safety.inspections', 'void_archive'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM safety_inspections WHERE id = ?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Inspection not found' });
    const closedBy = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    db.prepare("UPDATE safety_inspections SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, corrective_action = COALESCE(?, corrective_action), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(closedBy, req.body.correctiveAction ?? null, req.params.id);
    audit(req, { action: 'void_archive', entity: 'safety_inspections', entityId: req.params.id, oldValue: old, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });
  router.post('/inspections/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const insp = db.prepare('SELECT * FROM safety_inspections WHERE id = ?').get(req.params.id) as any;
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, insp.conducted_by_staff_id);
    const nc = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, insp.inspection_date, detectedBy, 'facilities_safety', String(insp.id), req.body.title ?? `Safety inspection finding ${insp.inspection_number}`, req.body.description ?? insp.findings_summary, 'safety', req.body.severity ?? 'medium', insp.corrective_action ?? null, 'open', req.user!.id, createdAt);
    const ncId = Number(nc.lastInsertRowid);
    db.prepare("UPDATE safety_inspections SET nc_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('facilities_safety', 'safety_inspections', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from safety inspection');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'facilities_safety', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });
  router.post('/inspections/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const insp = db.prepare('SELECT * FROM safety_inspections WHERE id = ?').get(req.params.id) as any;
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const capa = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, corrective_action, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'facilities_safety', String(insp.id), insp.nc_id ?? null, req.body.title ?? `CAPA for safety inspection ${insp.inspection_number}`, req.body.problemSummary ?? insp.findings_summary, insp.corrective_action ?? null, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(capa.lastInsertRowid);
    db.prepare("UPDATE safety_inspections SET capa_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(capaId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('facilities_safety', 'safety_inspections', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from safety inspection');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'facilities_safety', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  // ============================================================
  // Waste disposal log
  // ============================================================
  router.get('/waste', requirePermission('facilities_safety.waste', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM waste_disposal_records ORDER BY disposal_date DESC, created_at DESC').all());
  });
  router.post('/waste', requirePermission('facilities_safety.waste', 'create'), (req, res) => {
    if (!req.body.disposalDate) return res.status(400).json({ error: 'disposalDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'waste_disposal_records', 'WST', createdAt);
    const r = db.prepare(`INSERT INTO waste_disposal_records (record_number, disposal_date, waste_type, quantity, unit, disposal_method, handled_by_staff_id, carrier_or_destination, manifest_reference, section_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.disposalDate, req.body.wasteType ?? null, req.body.quantity ?? null, req.body.unit ?? null, req.body.disposalMethod ?? null, parseIntNullable(req.body.handledByStaffId) ?? getStaffIdOrCurrent(req, null), req.body.carrierOrDestination ?? null, req.body.manifestReference ?? null, parseIntNullable(req.body.sectionId), req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'waste_disposal_records', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, recordNumber: number });
  });

  // ============================================================
  // Hazardous chemical inventory
  // ============================================================
  router.get('/chemicals', requirePermission('facilities_safety.waste', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM hazardous_chemicals ORDER BY expiry_date IS NULL, expiry_date ASC, created_at DESC').all());
  });
  router.post('/chemicals', requirePermission('facilities_safety.waste', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'hazardous_chemicals', 'CHM', createdAt);
    const r = db.prepare(`INSERT INTO hazardous_chemicals (chemical_number, name, hazard_class, cas_number, sds_reference, sds_on_file, storage_location_id, segregation_group, quantity, unit, expiry_date, spill_measures, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.name, req.body.hazardClass ?? null, req.body.casNumber ?? null, req.body.sdsReference ?? null, req.body.sdsOnFile ? 1 : 0, parseIntNullable(req.body.storageLocationId), req.body.segregationGroup ?? null, req.body.quantity ?? null, req.body.unit ?? null, req.body.expiryDate ?? null, req.body.spillMeasures ?? null, req.body.status ?? 'in_use', req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'hazardous_chemicals', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, chemicalNumber: number });
  });
  router.put('/chemicals/:id', requirePermission('facilities_safety.waste', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM hazardous_chemicals WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Chemical not found' });
    db.prepare(`UPDATE hazardous_chemicals SET name = ?, hazard_class = ?, cas_number = ?, sds_reference = ?, sds_on_file = ?, storage_location_id = ?, segregation_group = ?, quantity = ?, unit = ?, expiry_date = ?, spill_measures = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.name ?? old.name, req.body.hazardClass ?? old.hazard_class, req.body.casNumber ?? old.cas_number, req.body.sdsReference ?? old.sds_reference, req.body.sdsOnFile === undefined ? old.sds_on_file : (req.body.sdsOnFile ? 1 : 0), parseIntNullable(req.body.storageLocationId) ?? old.storage_location_id, req.body.segregationGroup ?? old.segregation_group, req.body.quantity ?? old.quantity, req.body.unit ?? old.unit, req.body.expiryDate ?? old.expiry_date, req.body.spillMeasures ?? old.spill_measures, req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'hazardous_chemicals', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ============================================================
  // Staff immunisation / post-exposure records
  // ============================================================
  router.get('/immunizations', requirePermission('facilities_safety.health', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM staff_immunizations ORDER BY COALESCE(date_administered, exposure_date) DESC, created_at DESC').all());
  });
  router.post('/immunizations', requirePermission('facilities_safety.health', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'staff_immunizations', 'IMM', createdAt);
    const r = db.prepare(`INSERT INTO staff_immunizations (record_number, staff_id, record_type, vaccine_or_agent, dose_or_stage, date_administered, next_due_date, provider, exposure_date, exposure_source, follow_up_summary, outcome, declination_signed, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, parseIntNullable(req.body.staffId), req.body.recordType ?? 'vaccination', req.body.vaccineOrAgent ?? null, req.body.doseOrStage ?? null, req.body.dateAdministered ?? null, req.body.nextDueDate ?? null, req.body.provider ?? null, req.body.exposureDate ?? null, req.body.exposureSource ?? null, req.body.followUpSummary ?? null, req.body.outcome ?? null, req.body.declinationSigned ? 1 : 0, req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'staff_immunizations', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, recordNumber: number });
  });
  router.put('/immunizations/:id', requirePermission('facilities_safety.health', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM staff_immunizations WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Record not found' });
    db.prepare(`UPDATE staff_immunizations SET staff_id = ?, record_type = ?, vaccine_or_agent = ?, dose_or_stage = ?, date_administered = ?, next_due_date = ?, provider = ?, exposure_date = ?, exposure_source = ?, follow_up_summary = ?, outcome = ?, declination_signed = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.staffId) ?? old.staff_id, req.body.recordType ?? old.record_type, req.body.vaccineOrAgent ?? old.vaccine_or_agent, req.body.doseOrStage ?? old.dose_or_stage, req.body.dateAdministered ?? old.date_administered, req.body.nextDueDate ?? old.next_due_date, req.body.provider ?? old.provider, req.body.exposureDate ?? old.exposure_date, req.body.exposureSource ?? old.exposure_source, req.body.followUpSummary ?? old.follow_up_summary, req.body.outcome ?? old.outcome, req.body.declinationSigned === undefined ? old.declination_signed : (req.body.declinationSigned ? 1 : 0), req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'staff_immunizations', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}

function createIncident(req: any): { status: number; error: string } | { payload: { id: number | bigint; incidentNumber: string } } {
  if (!req.body.incidentDate) return { status: 400, error: 'incidentDate is required' };
  if (!(req.body.title || req.body.description)) return { status: 400, error: 'title or description is required' };
  if (!req.body.severity) return { status: 400, error: 'severity is required' };
  const db = getDb();
  const createdAt = new Date().toISOString();
  const incidentNumber = generateRecordNumber(db, 'safety_incidents', 'SAF', createdAt);
  const status = req.body.status ?? 'open';
  if (!SAFETY_STATUSES.includes(status)) return { status: 400, error: `status must be one of: ${SAFETY_STATUSES.join(', ')}` };
  const result = db.prepare(`INSERT INTO safety_incidents (incident_number, incident_date, location_id, department_id, section_id, reported_by_staff_id, description, category, severity, status, corrective_action, reported_to, incident_type, title, immediate_action, persons_involved, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      incidentNumber,
      req.body.incidentDate,
      parseIntNullable(req.body.locationId),
      parseIntNullable(req.body.departmentId),
      parseIntNullable(req.body.sectionId),
      parseIntNullable(req.body.reportedByStaffId) ?? getStaffIdOrCurrent(req, null),
      req.body.description ?? req.body.title,
      req.body.category ?? null,
      req.body.severity,
      status,
      req.body.correctiveAction ?? null,
      req.body.reportedTo ?? null,
      req.body.incidentType ?? null,
      req.body.title ?? null,
      req.body.immediateAction ?? null,
      req.body.personsInvolved ?? null,
      req.user!.id,
      createdAt
    );
  audit(req, { action: 'create', entity: 'safety_incidents', entityId: result.lastInsertRowid, newValue: { incidentNumber, ...req.body } });
  return { payload: { id: result.lastInsertRowid, incidentNumber } };
}

function updateIncident(req: any, res: any) {
  const db = getDb();
  const oldValue = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id) as any;
  if (!oldValue) return res.status(404).json({ error: 'Safety incident not found' });
  if (req.body.status && !SAFETY_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SAFETY_STATUSES.join(', ')}` });
  db.prepare(`UPDATE safety_incidents SET incident_date = ?, location_id = ?, department_id = ?, section_id = ?, reported_by_staff_id = ?, description = ?, category = ?, severity = ?, status = ?, corrective_action = ?, reported_to = ?, incident_type = ?, title = ?, immediate_action = ?, persons_involved = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(
      req.body.incidentDate ?? oldValue.incident_date,
      parseIntNullable(req.body.locationId) ?? oldValue.location_id,
      parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
      parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
      parseIntNullable(req.body.reportedByStaffId) ?? oldValue.reported_by_staff_id,
      req.body.description ?? oldValue.description,
      req.body.category ?? oldValue.category,
      req.body.severity ?? oldValue.severity,
      req.body.status ?? oldValue.status,
      req.body.correctiveAction ?? oldValue.corrective_action,
      req.body.reportedTo ?? oldValue.reported_to,
      req.body.incidentType ?? oldValue.incident_type,
      req.body.title ?? oldValue.title,
      req.body.immediateAction ?? oldValue.immediate_action,
      req.body.personsInvolved ?? oldValue.persons_involved,
      req.params.id
    );
  audit(req, { action: 'edit', entity: 'safety_incidents', entityId: req.params.id, oldValue, newValue: req.body });
  res.json({ ok: true });
}

function closeIncident(req: any, res: any) {
  const db = getDb();
  const oldValue = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
  if (!oldValue) return res.status(404).json({ error: 'Safety incident not found' });
  const closedByStaffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
  if (closedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
  db.prepare('UPDATE safety_incidents SET status = ?, closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, corrective_action = COALESCE(?, corrective_action), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('closed', closedByStaffId, req.body.correctiveAction ?? null, req.params.id);
  audit(req, { action: 'void_archive', entity: 'safety_incidents', entityId: req.params.id, oldValue, newValue: { status: 'closed', closedByStaffId } });
  res.json({ ok: true });
}
