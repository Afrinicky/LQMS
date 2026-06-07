import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import archiver from 'archiver';
import { getDb, uploadRoot, evidenceRoot, backupRoot, dbPath, configRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';

export function commonRoutes() {
  const router = Router();
  router.use(requireAuth);

  router.get('/dashboard', (_req, res) => {
    const db = getDb();
    res.json({ documents: db.prepare('SELECT COUNT(*) count FROM documents').get(), actionsOpen: db.prepare("SELECT COUNT(*) count FROM actions WHERE status != 'closed'").get(), staff: db.prepare('SELECT COUNT(*) count FROM staff').get(), modulesEnabled: db.prepare('SELECT COUNT(*) count FROM system_modules WHERE enabled = 1').get(), latestBackup: db.prepare('SELECT file_name FROM backup_logs ORDER BY id DESC LIMIT 1').get() });
  });
  router.get('/dashboard/qms-summary', (_req, res) => {
    const db = getDb();
    const staffId = _req.user?.staffId ?? null;
    const myAssignedActions = staffId
      ? db.prepare('SELECT COUNT(*) count FROM actions WHERE assigned_to_staff_id = ? AND status != ?').get(staffId, 'Closed')
      : { count: 0 };
    res.json({
      openNCs: db.prepare("SELECT COUNT(*) count FROM nonconforming_events WHERE status != 'closed'").get(),
      openCAPAs: db.prepare("SELECT COUNT(*) count FROM capa_records WHERE status != 'closed'").get(),
      pendingComplaints: db.prepare("SELECT COUNT(*) count FROM complaints WHERE status != 'closed'").get(),
      highRisks: db.prepare("SELECT COUNT(*) count FROM risks WHERE risk_level IN ('High','Critical') AND status != 'closed'").get(),
      myAssignedActions,
      overdueActions: db.prepare('SELECT COUNT(*) count FROM actions WHERE due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?').get('Closed')
    });
  });

  router.get('/roles', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name, description, is_system isSystem FROM roles ORDER BY name').all()));
  router.get('/users', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, u.staff_id staffId, s.full_name staffName, r.name roleName, u.is_active isActive FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id ORDER BY u.full_name').all()));
  router.post('/users', requirePermission('settings', 'create'), (req, res) => {
    const { username, password, fullName, roleId, staffId } = req.body;
    const oldValue = null;
    const result = getDb().prepare('INSERT INTO users (username, password_hash, full_name, role_id, staff_id) VALUES (?, ?, ?, ?, ?)').run(username, bcrypt.hashSync(password, 12), fullName, roleId, staffId ?? null);
    audit(req, { action: 'create', entity: 'users', entityId: result.lastInsertRowid, oldValue, newValue: { username, fullName, roleId, staffId } });
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.put('/users/:id', requirePermission('settings', 'edit'), (req, res) => {
    const { staffId } = req.body;
    const oldValue = getDb().prepare('SELECT staff_id staffId FROM users WHERE id = ?').get(req.params.id);
    getDb().prepare('UPDATE users SET staff_id = ? WHERE id = ?').run(staffId ?? null, req.params.id);
    audit(req, { action: 'link_staff', entity: 'users', entityId: req.params.id, oldValue, newValue: { staffId } });
    res.json({ ok: true });
  });

  router.get('/positions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, title, description, reports_to_position_id reportsToPositionId, is_active isActive, archived_at archivedAt FROM positions ORDER BY is_active DESC, title').all()));
  router.post('/positions', requirePermission('settings', 'create'), (req, res) => {
    const { title, description, reportsToPositionId } = req.body;
    const result = getDb().prepare('INSERT INTO positions (title, description, reports_to_position_id) VALUES (?, ?, ?)').run(title, description ?? null, reportsToPositionId ?? null);
    audit(req, { action: 'create', entity: 'positions', entityId: result.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.put('/positions/:id', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
    getDb().prepare('UPDATE positions SET title = ?, description = ?, reports_to_position_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.title, req.body.description ?? null, req.body.reportsToPositionId ?? null, req.body.isActive ? 1 : 0, req.params.id);
    audit(req, { action: 'edit', entity: 'positions', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });
  router.delete('/positions/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const used = getDb().prepare('SELECT COUNT(*) count FROM staff_position_assignments WHERE position_id = ?').get(req.params.id) as { count: number };
    if (used.count > 0) getDb().prepare('UPDATE positions SET is_active = 0, archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id); else getDb().prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
    audit(req, { action: used.count > 0 ? 'archive' : 'delete', entity: 'positions', entityId: req.params.id });
    res.json({ ok: true, archived: used.count > 0 });
  });

  router.get('/staff', requirePermission('personnel', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, employee_no employeeNo, full_name fullName, email, phone, is_active isActive FROM staff ORDER BY full_name').all()));
  router.post('/staff', requirePermission('personnel', 'create'), (req, res) => {
    const r = getDb().prepare('INSERT INTO staff (employee_no, full_name, email, phone) VALUES (?, ?, ?, ?)').run(req.body.employeeNo ?? null, req.body.fullName, req.body.email ?? null, req.body.phone ?? null);
    if (req.body.positionId) getDb().prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)').run(r.lastInsertRowid, req.body.positionId, req.body.assignmentType ?? 'primary');
    audit(req, { action: 'create', entity: 'staff', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  router.get('/system-modules', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, key, label, path, enabled, alerts_paused alertsPaused FROM system_modules ORDER BY id').all()));
  router.put('/system-modules/:key', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT * FROM system_modules WHERE key = ?').get(req.params.key);
    getDb().prepare('UPDATE system_modules SET enabled = ?, alerts_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND key != ?').run(req.body.enabled ? 1 : 0, req.body.enabled ? 0 : 1, req.params.key, 'settings');
    audit(req, { action: 'edit', entity: 'system_modules', entityId: req.params.key, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/permissions/matrix', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    res.json({ permissions: db.prepare('SELECT * FROM permissions ORDER BY module_key, action').all(), rolePermissions: db.prepare('SELECT * FROM role_permissions').all(), positionPermissions: db.prepare('SELECT * FROM position_permissions').all(), userOverrides: db.prepare('SELECT * FROM user_permission_overrides').all(), technicalAuthorizations: db.prepare('SELECT * FROM technical_authorizations').all(), auditHistory: db.prepare("SELECT * FROM audit_logs WHERE entity IN ('permissions','role_permissions','position_permissions','user_permission_overrides') ORDER BY id DESC LIMIT 50").all() });
  });

  const storage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) });
  const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
  router.post('/files', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const r = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: r.lastInsertRowid, newValue: { originalName: req.file.originalname, storedName: req.file.filename } });
    res.status(201).json({ id: r.lastInsertRowid, storedName: req.file.filename });
  });
  router.post('/evidence', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    fs.renameSync(req.file.path, path.join(evidenceRoot, req.file.filename));
    const file = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'evidence', req.user!.id);
    const link = getDb().prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)').run(file.lastInsertRowid, req.body.moduleKey, req.body.recordType, req.body.recordId, req.body.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: file.lastInsertRowid, newValue: req.body });
    res.status(201).json({ fileId: file.lastInsertRowid, evidenceId: link.lastInsertRowid });
  });

  router.get('/documents', requirePermission('documents', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM documents ORDER BY created_at DESC').all()));
  router.post('/documents/import-master-list', requirePermission('documents', 'create'), (req, res) => { audit(req, { action: 'create', entity: 'documents', newValue: req.body }); res.json({ ok: true, message: 'MVP import placeholder accepted. CSV parsing will be implemented in the next phase.' }); });

  router.get('/actions', requirePermission('actions', 'view'), (req, res) => {
    const db = getDb();
    const filters = [];
    const params: unknown[] = [];
    let query = 'SELECT * FROM actions';
    if (req.query.assignedToStaffId) {
      filters.push('assigned_to_staff_id = ?');
      params.push(Number(req.query.assignedToStaffId));
    }
    if (req.query.status) {
      filters.push('status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.overdue === 'true') {
      filters.push('due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?');
      params.push('Closed');
    }
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });
  router.post('/actions', requirePermission('actions', 'create'), (req, res) => {
    const r = getDb().prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.title,
      req.body.moduleKey ?? 'actions',
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      req.body.description ?? null,
      req.body.priority ?? 'normal',
      req.body.assignedToStaffId ?? null,
      req.body.dueDate ?? null,
      req.body.status ?? 'Not started',
      req.body.evidenceRequired ? 1 : 0,
      req.body.completionNotes ?? null,
      req.user!.id
    );
    audit(req, { action: 'create', entity: 'actions', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/actions/:id', requirePermission('actions', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Action not found' });
    db.prepare('UPDATE actions SET title = ?, source_module = ?, source_record_id = ?, description = ?, priority = ?, assigned_to_staff_id = ?, due_date = ?, status = ?, evidence_required = ?, completion_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.title ?? oldValue.title,
      req.body.sourceModule ?? oldValue.source_module,
      req.body.sourceRecordId ?? oldValue.source_record_id,
      req.body.description ?? oldValue.description,
      req.body.priority ?? oldValue.priority,
      req.body.assignedToStaffId ?? oldValue.assigned_to_staff_id,
      req.body.dueDate ?? oldValue.due_date,
      req.body.status ?? oldValue.status,
      req.body.evidenceRequired ? 1 : oldValue.evidence_required,
      req.body.completionNotes ?? oldValue.completion_notes,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'actions', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/permissions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM permissions ORDER BY module_key, action').all()));
  router.post('/permissions/role', requirePermission('settings', 'edit'), (req, res) => {
    const { roleId, permissionId, allowed } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(roleId, permissionId, allowed ? 1 : 0, 'Manual assignment');
    audit(req, { action: 'create', entity: 'role_permissions', entityId: result.lastInsertRowid, newValue: { roleId, permissionId, allowed } });
    res.status(201).json({ ok: true });
  });
  router.post('/permissions/position', requirePermission('settings', 'edit'), (req, res) => {
    const { positionId, permissionId, allowed } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO position_permissions (position_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(positionId, permissionId, allowed ? 1 : 0, 'Manual assignment');
    audit(req, { action: 'create', entity: 'position_permissions', entityId: result.lastInsertRowid, newValue: { positionId, permissionId, allowed } });
    res.status(201).json({ ok: true });
  });
  router.post('/permissions/user-override', requirePermission('settings', 'edit'), (req, res) => {
    const { userId, permissionId, allowed, reason } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source, reason) VALUES (?, ?, ?, ?, ?)').run(userId, permissionId, allowed ? 1 : 0, 'Manual override', reason ?? null);
    audit(req, { action: 'create', entity: 'user_permission_overrides', entityId: result.lastInsertRowid, newValue: { userId, permissionId, allowed, reason } });
    res.status(201).json({ ok: true });
  });
  router.post('/authorizations/technical', requirePermission('settings', 'edit'), (req, res) => {
    const { staffId, positionId, moduleKey, sectionId, level } = req.body;
    const result = getDb().prepare('INSERT INTO technical_authorizations (staff_id, position_id, module_key, section_id, level, is_active) VALUES (?, ?, ?, ?, ?, 1)').run(staffId ?? null, positionId ?? null, moduleKey, sectionId ?? null, level);
    audit(req, { action: 'create', entity: 'technical_authorizations', entityId: result.lastInsertRowid, newValue: { staffId, positionId, moduleKey, sectionId, level } });
    res.status(201).json({ ok: true });
  });
  router.get('/sections', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name FROM sections WHERE is_active = 1 ORDER BY name').all()));

  router.get('/devices', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM devices ORDER BY created_at DESC').all()));
  router.post('/devices/request-pairing', requirePermission('settings', 'create'), (req, res) => { const code = Math.random().toString(36).slice(2, 10).toUpperCase(); const r = getDb().prepare('INSERT INTO devices (device_code, name, type) VALUES (?, ?, ?)').run(code, req.body.name, req.body.type ?? 'desktop'); audit(req, { action: 'create', entity: 'devices', entityId: r.lastInsertRowid, newValue: { code, ...req.body } }); res.status(201).json({ id: r.lastInsertRowid, code }); });
  router.post('/devices/:id/approve', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('approved', req.params.id);
    audit(req, { action: 'approve', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });
  router.post('/devices/:id/revoke', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('revoked', req.params.id);
    audit(req, { action: 'revoke', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'revoked' } });
    res.json({ ok: true });
  });
  router.post('/devices/:id/block', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('blocked', req.params.id);
    audit(req, { action: 'block', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'blocked' } });
    res.json({ ok: true });
  });

  router.post('/backup/create', requirePermission('settings', 'export'), async (req, res) => {
    const fileName = `sech-lims-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const fullPath = path.join(backupRoot, fileName);
    const manifest = { product: 'SECH_LIMS by Nickland', createdAt: new Date().toISOString(), includes: ['SQLite database', 'uploads', 'evidence', 'config', 'backup-manifest.json'] };
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(fullPath); const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve); archive.on('error', reject); archive.pipe(output);
      if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'database/sech_lims.sqlite' });
      archive.directory(uploadRoot, 'uploads'); archive.directory(evidenceRoot, 'evidence'); archive.directory(configRoot, 'config'); archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-manifest.json' }); archive.finalize();
    });
    getDb().prepare('INSERT INTO backup_logs (file_name, manifest, created_by) VALUES (?, ?, ?)').run(fileName, JSON.stringify(manifest), req.user!.id);
    audit(req, { action: 'create', entity: 'backup', entityId: fileName, newValue: manifest });
    res.status(201).json({ fileName, manifest });
  });
  router.post('/backup/restore-placeholder', requirePermission('settings', 'approve'), (_req, res) => res.json({ ok: true, message: 'Restore is a guarded placeholder in the foundation MVP.' }));
  router.get('/audit-log', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all()));

  for (const group of ['lab-profile','departments','sections','locations','authorizations','approval-routes','links','notifications','settings']) router.get(`/${group}`, (_req, res) => res.json([]));
  return router;
}
