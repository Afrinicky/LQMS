import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'completed', 'closed'];

export function improvementRoutes() {
  const router = Router();

  router.get('/', requirePermission('continual_improvement', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM improvement_projects';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('continual_improvement', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.improvementArea) return res.status(400).json({ error: 'improvementArea is required' });
    if (!req.body.aimStatement) return res.status(400).json({ error: 'aimStatement is required' });
    const status = req.body.status ?? 'planned';
    if (!PROJECT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const projectNumber = generateRecordNumber(db, 'improvement_projects', 'IMP', createdAt);
    const result = db.prepare(`INSERT INTO improvement_projects (project_number, title, source_module, source_record_id, improvement_area, aim_statement, baseline_measure, target_measure, start_date, expected_completion_date, responsible_staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectNumber, req.body.title, req.body.sourceModule ?? null, req.body.sourceRecordId ?? null, req.body.improvementArea, req.body.aimStatement, req.body.baselineMeasure ?? null, req.body.targetMeasure ?? null, req.body.startDate ?? null, req.body.expectedCompletionDate ?? null, parseIntNullable(req.body.responsibleStaffId), status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (req.body.sourceModule && req.body.sourceRecordId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('continual_improvement', 'improvement_projects', String(id), req.body.sourceModule, req.body.sourceRecordType ?? 'unspecified', String(req.body.sourceRecordId), 'Improvement project source');
    }
    audit(req, { action: 'create', entity: 'improvement_projects', entityId: id, newValue: { projectNumber, ...req.body } });
    res.status(201).json({ id, projectNumber });
  });

  router.get('/:id', requirePermission('continual_improvement', 'view'), (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM improvement_projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Improvement project not found' });
    const updates = db.prepare('SELECT * FROM improvement_updates WHERE project_id = ? ORDER BY update_date DESC, id DESC').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)').all('continual_improvement', 'improvement_projects', String(req.params.id), 'continual_improvement', 'improvement_projects', String(req.params.id));
    res.json({ ...project, updates, links });
  });

  router.put('/:id', requirePermission('continual_improvement', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM improvement_projects WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Improvement project not found' });
    if (req.body.status && !PROJECT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE improvement_projects SET title = ?, improvement_area = ?, aim_statement = ?, baseline_measure = ?, target_measure = ?, start_date = ?, expected_completion_date = ?, responsible_staff_id = ?, status = ?, outcome_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.title ?? oldValue.title, req.body.improvementArea ?? oldValue.improvement_area, req.body.aimStatement ?? oldValue.aim_statement, req.body.baselineMeasure ?? oldValue.baseline_measure, req.body.targetMeasure ?? oldValue.target_measure, req.body.startDate ?? oldValue.start_date, req.body.expectedCompletionDate ?? oldValue.expected_completion_date, parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id, req.body.status ?? oldValue.status, req.body.outcomeSummary ?? oldValue.outcome_summary, req.params.id);
    audit(req, { action: 'edit', entity: 'improvement_projects', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/update', requirePermission('continual_improvement', 'edit'), (req, res) => {
    if (!req.body.updateDate) return res.status(400).json({ error: 'updateDate is required' });
    const db = getDb();
    const project = db.prepare('SELECT id FROM improvement_projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Improvement project not found' });
    const result = db.prepare(`INSERT INTO improvement_updates (project_id, update_date, update_text, progress_status, evidence_file_id, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.updateDate, req.body.updateText ?? null, req.body.progressStatus ?? null, parseIntNullable(req.body.evidenceFileId), req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (req.body.progressStatus) {
      db.prepare('UPDATE improvement_projects SET status = CASE WHEN status = \'planned\' AND ? = \'in_progress\' THEN \'active\' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.progressStatus, req.params.id);
    }
    audit(req, { action: 'update', entity: 'improvement_updates', entityId: id, newValue: { projectId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const project = db.prepare('SELECT id FROM improvement_projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Improvement project not found' });
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'continual_improvement', 'continual_improvement', String(req.params.id), req.body.description ?? null, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('continual_improvement', 'improvement_projects', String(req.params.id), 'actions', 'actions', String(actionId), 'Action from improvement project');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'continual_improvement', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/:id/close', requirePermission('continual_improvement', 'approve'), (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM improvement_projects WHERE id = ?').get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: 'Improvement project not found' });
    const closedBy = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE improvement_projects SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, outcome_summary = COALESCE(?, outcome_summary), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(closedBy, req.body.outcomeSummary ?? null, req.params.id);
    audit(req, { action: 'close', entity: 'improvement_projects', entityId: req.params.id, oldValue: { status: project.status }, newValue: { status: 'closed', closedByStaffId: closedBy } });
    res.json({ ok: true });
  });

  return router;
}

export { PROJECT_STATUSES };
