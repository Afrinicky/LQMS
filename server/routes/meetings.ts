import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const MEETING_STATUSES = ['scheduled', 'completed', 'closed', 'cancelled'];
const ATTENDANCE_STATUSES = ['invited', 'present', 'absent', 'excused'];

export function meetingsRoutes() {
  const router = Router();

  router.get('/', requirePermission('meetings', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.meetingType) { filters.push('meeting_type = ?'); params.push(String(req.query.meetingType)); }
    let query = 'SELECT * FROM meetings';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY meeting_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('meetings', 'create'), (req, res) => {
    if (!req.body.meetingType) return res.status(400).json({ error: 'meetingType is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.meetingDate) return res.status(400).json({ error: 'meetingDate is required' });
    const status = req.body.status ?? 'scheduled';
    if (!MEETING_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${MEETING_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const meetingNumber = generateRecordNumber(db, 'meetings', 'MTG', createdAt);
    const result = db.prepare(`INSERT INTO meetings (meeting_number, meeting_type, title, meeting_date, start_time, end_time, location, chair_staff_id, secretary_staff_id, agenda, minutes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(meetingNumber, req.body.meetingType, req.body.title, req.body.meetingDate, req.body.startTime ?? null, req.body.endTime ?? null, req.body.location ?? null, parseIntNullable(req.body.chairStaffId), parseIntNullable(req.body.secretaryStaffId), req.body.agenda ?? null, req.body.minutes ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'meetings', entityId: id, newValue: { meetingNumber, ...req.body } });
    res.status(201).json({ id, meetingNumber });
  });

  router.get('/:id', requirePermission('meetings', 'view'), (req, res) => {
    const db = getDb();
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id) as any;
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const attendance = db.prepare('SELECT a.*, s.full_name AS staff_name FROM meeting_attendance a JOIN staff s ON s.id = a.staff_id WHERE a.meeting_id = ? ORDER BY s.full_name').all(req.params.id);
    const actions = db.prepare('SELECT a.* FROM meeting_actions ma JOIN actions a ON a.id = ma.action_id WHERE ma.meeting_id = ? ORDER BY a.created_at DESC').all(req.params.id);
    res.json({ ...meeting, attendance, actions });
  });

  router.put('/:id', requirePermission('meetings', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Meeting not found' });
    if (req.body.status && !MEETING_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${MEETING_STATUSES.join(', ')}` });
    db.prepare(`UPDATE meetings SET meeting_type = ?, title = ?, meeting_date = ?, start_time = ?, end_time = ?, location = ?, chair_staff_id = ?, secretary_staff_id = ?, agenda = ?, minutes = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.meetingType ?? oldValue.meeting_type, req.body.title ?? oldValue.title, req.body.meetingDate ?? oldValue.meeting_date, req.body.startTime ?? oldValue.start_time, req.body.endTime ?? oldValue.end_time, req.body.location ?? oldValue.location, parseIntNullable(req.body.chairStaffId) ?? oldValue.chair_staff_id, parseIntNullable(req.body.secretaryStaffId) ?? oldValue.secretary_staff_id, req.body.agenda ?? oldValue.agenda, req.body.minutes ?? oldValue.minutes, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'meetings', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/attendance', requirePermission('meetings', 'edit'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const status = req.body.attendanceStatus ?? 'invited';
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `attendanceStatus must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
    const db = getDb();
    const existing = db.prepare('SELECT id FROM meeting_attendance WHERE meeting_id = ? AND staff_id = ?').get(req.params.id, req.body.staffId) as any;
    let id: number;
    if (existing) {
      db.prepare('UPDATE meeting_attendance SET attendance_status = ?, signed_at = CASE WHEN ? = \'present\' THEN CURRENT_TIMESTAMP ELSE signed_at END, remarks = COALESCE(?, remarks) WHERE id = ?').run(status, status, req.body.remarks ?? null, existing.id);
      id = existing.id;
    } else {
      const result = db.prepare(`INSERT INTO meeting_attendance (meeting_id, staff_id, attendance_status, signed_at, remarks, created_by) VALUES (?, ?, ?, CASE WHEN ? = 'present' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)`)
        .run(req.params.id, req.body.staffId, status, status, req.body.remarks ?? null, req.user!.id);
      id = Number(result.lastInsertRowid);
    }
    audit(req, { action: 'attendance', entity: 'meeting_attendance', entityId: id, newValue: { meetingId: req.params.id, staffId: req.body.staffId, status } });
    res.status(201).json({ id });
  });

  router.post('/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id) as any;
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'meetings', 'meetings', String(req.params.id), req.body.description ?? null, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO meeting_actions (meeting_id, action_id) VALUES (?, ?)').run(req.params.id, actionId);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('meetings', 'meetings', String(req.params.id), 'actions', 'actions', String(actionId), 'Action from meeting');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'meetings', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/:id/close', requirePermission('meetings', 'approve'), (req, res) => {
    const db = getDb();
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id) as any;
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    db.prepare("UPDATE meetings SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'meetings', entityId: req.params.id, oldValue: { status: meeting.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  return router;
}

export { MEETING_STATUSES, ATTENDANCE_STATUSES };
