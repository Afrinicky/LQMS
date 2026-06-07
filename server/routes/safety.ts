import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const SAFETY_STATUSES = ['open', 'under_review', 'action_required', 'closed'];

export function safetyRoutes() {
  const router = Router();

  router.get('/', requirePermission('facilities_safety', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM safety_incidents ORDER BY incident_date DESC, created_at DESC').all());
  });

  router.get('/incidents', requirePermission('facilities_safety', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM safety_incidents ORDER BY incident_date DESC, created_at DESC').all());
  });

  router.post('/', requirePermission('facilities_safety', 'create'), (req, res) => {
    const result = createIncident(req);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.payload);
  });

  router.post('/incidents', requirePermission('facilities_safety', 'create'), (req, res) => {
    const result = createIncident(req);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.payload);
  });

  router.get('/incidents/:id', requirePermission('facilities_safety', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Safety incident not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('facilities_safety', 'safety_incidents', String(req.params.id), 'facilities_safety', 'safety_incidents', String(req.params.id));
    res.json({ ...item, links });
  });

  router.put('/incidents/:id', requirePermission('facilities_safety', 'edit'), (req, res) => updateIncident(req, res));

  router.get('/:id', requirePermission('facilities_safety', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM safety_incidents WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Safety incident not found' });
    res.json(item);
  });

  router.put('/:id', requirePermission('facilities_safety', 'edit'), (req, res) => updateIncident(req, res));

  router.post('/:id/close', requirePermission('facilities_safety', 'void_archive'), (req, res) => closeIncident(req, res));
  router.post('/incidents/:id/close', requirePermission('facilities_safety', 'void_archive'), (req, res) => closeIncident(req, res));

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
