/**
 * Companion App aggregation API (Phase 2).
 *
 * A thin, mobile-first layer over the existing Host modules. It creates no new
 * authority: every action is checked against the same RBAC the desktop uses, and
 * every write flows through the shared audit trail. It provides:
 *
 *  - GET  /api/mobile/dashboard              role-based widgets + quick actions
 *  - Staff self-service:
 *      GET  /api/mobile/me                    my full self-service profile bundle
 *      PUT  /api/mobile/me/contact            update my contact / emergency info
 *      GET  /api/mobile/me/leave              my leave requests
 *      POST /api/mobile/me/leave              submit a leave request
 *      GET  /api/mobile/me/clock              today's clock status + recent
 *      POST /api/mobile/me/clock              clock in / out
 *      GET  /api/mobile/announcements         announcements for me
 *      POST /api/mobile/announcements/:id/read   mark read / acknowledge
 *  - Approvals:
 *      GET  /api/mobile/approvals             my approval inbox (RBAC-filtered)
 *      POST /api/mobile/approvals/:type/:id/decision   approve/reject/return + e-sign
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { getDb, uploadRoot } from '../db/database.js';
import { audit } from '../services/auditService.js';
import { recordSignature } from '../services/signatureService.js';
import { queuePush } from '../services/pushService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { getCurrentStaffId, requireCurrentStaffId, parseIntNullable } from './routeHelpers.js';

const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

type Row = Record<string, unknown>;

// Approval sources: each maps a mobile approval "type" to its table, the RBAC
// gate, and the columns touched on a decision. The requester (for notifying) is
// the staff member who raised the item.
interface ApprovalSource {
  type: string;
  label: string;
  table: string;
  module: string;
  action: string;              // permission action required to decide
  requesterCol: string;
  approverCol: string;
  decidedAtCol: string;
  notesCol?: string;
  approvedStatus: string;
  rejectedStatus: string;
  returnedStatus: string;
  pendingWhere: string;
  titleExpr: string;
}

const SOURCES: Record<string, ApprovalSource> = {
  leave: {
    type: 'leave', label: 'Leave request', table: 'leave_requests', module: 'personnel', action: 'approve',
    requesterCol: 'staff_id', approverCol: 'approved_by_staff_id', decidedAtCol: 'decided_at', notesCol: 'decision_notes',
    approvedStatus: 'approved', rejectedStatus: 'rejected', returnedStatus: 'returned',
    pendingWhere: "status = 'pending'", titleExpr: "COALESCE(leave_type,'Leave') || ' · ' || COALESCE(start_date,'') || ' → ' || COALESCE(end_date,'')",
  },
  inventory_request: {
    type: 'inventory_request', label: 'Inventory request', table: 'inventory_requests', module: 'supplier_inventory', action: 'edit',
    requesterCol: 'staff_id', approverCol: 'approved_by_staff_id', decidedAtCol: 'decided_at', notesCol: 'decision_notes',
    approvedStatus: 'approved', rejectedStatus: 'rejected', returnedStatus: 'returned',
    pendingWhere: "status = 'pending'", titleExpr: "COALESCE(item_name,'Item') || ' × ' || COALESCE(quantity,'')",
  },
  capa: {
    type: 'capa', label: 'CAPA verification', table: 'capa_records', module: 'nc_capa', action: 'approve',
    requesterCol: 'responsible_staff_id', approverCol: 'verified_by_staff_id', decidedAtCol: 'verified_at', notesCol: 'verification_notes',
    approvedStatus: 'verified', rejectedStatus: 'reopened', returnedStatus: 'reopened',
    pendingWhere: "status IN ('completed','pending_verification','in_progress') AND verified_at IS NULL", titleExpr: "capa_number || ' · ' || title",
  },
  nonconformity: {
    type: 'nonconformity', label: 'Nonconformity review', table: 'nonconforming_events', module: 'nc_capa', action: 'approve',
    requesterCol: 'detected_by_staff_id', approverCol: 'reviewer_staff_id', decidedAtCol: 'reviewed_at', notesCol: 'closure_notes',
    approvedStatus: 'reviewed', rejectedStatus: 'open', returnedStatus: 'open',
    pendingWhere: "status = 'open' AND reviewed_at IS NULL", titleExpr: "nc_number || ' · ' || title",
  },
};

function canApprove(userId: number, source: ApprovalSource): boolean {
  return resolvePermission(userId, source.module, source.action).allowed;
}

export function mobileRoutes() {
  const router = Router();

  // ────────────────────────────────────────────────────────────── dashboard
  router.get('/dashboard', requireAuth, (req, res) => {
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    const uid = req.user!.id;
    const role = db.prepare('SELECT r.name AS role_key, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(uid) as { role_key?: string; role_name?: string } | undefined;

    // Widgets everyone sees, scoped to the individual.
    const openTasks = staffId ? (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE assigned_to_staff_id = ? AND status NOT IN ('Closed','Completed')").get(staffId) as { n: number }).n : 0;
    const unreadAlerts = (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND status = 'unread'").get(uid) as { n: number }).n;
    const pendingAcks = staffId ? (db.prepare("SELECT COUNT(*) AS n FROM document_attestations WHERE staff_id = ? AND status IN ('pending','overdue')").get(staffId) as { n: number }).n : 0;

    // Approvals awaiting me, only for the sources I can decide.
    let approvalsPending = 0;
    for (const src of Object.values(SOURCES)) {
      if (!canApprove(uid, src)) continue;
      approvalsPending += (db.prepare(`SELECT COUNT(*) AS n FROM ${src.table} WHERE ${src.pendingWhere}`).get() as { n: number }).n;
    }

    // Role-relevant operational widgets.
    const widgets: Row[] = [];
    const has = (m: string, a: string) => resolvePermission(uid, m, a).allowed;
    widgets.push({ key: 'my_tasks', label: 'Open tasks', value: openTasks, tab: 'work', tone: openTasks ? 'accent' : 'muted' });
    widgets.push({ key: 'alerts', label: 'Unread alerts', value: unreadAlerts, tab: 'alerts', tone: unreadAlerts ? 'warn' : 'muted' });
    widgets.push({ key: 'acks', label: 'Docs to sign', value: pendingAcks, push: 'docs', tone: pendingAcks ? 'warn' : 'muted' });
    if (approvalsPending > 0 || Object.values(SOURCES).some(s => canApprove(uid, s))) {
      widgets.push({ key: 'approvals', label: 'Approvals waiting', value: approvalsPending, push: 'approvals', tone: approvalsPending ? 'accent' : 'muted' });
    }
    if (has('supplier_inventory', 'view')) {
      const lowStock = (db.prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE reorder_level > 0 AND quantity <= reorder_level").get() as { n: number } | undefined)?.n ?? 0;
      widgets.push({ key: 'low_stock', label: 'Low stock items', value: lowStock, push: 'inventory', tone: lowStock ? 'warn' : 'muted' });
    }
    if (has('equipment', 'view')) {
      const dueMaint = (db.prepare("SELECT COUNT(*) AS n FROM equipment_items WHERE next_maintenance_due IS NOT NULL AND date(next_maintenance_due) <= date('now','+7 day')").get() as { n: number } | undefined)?.n ?? 0;
      widgets.push({ key: 'maint_due', label: 'Maintenance due', value: dueMaint, push: 'equip:maintenance', tone: dueMaint ? 'warn' : 'muted' });
    }

    // Quick actions filtered by permission — the launchpad the client renders.
    const quickActions = [
      { key: 'env', label: 'Reading', module: 'monitoring', action: 'create', push: 'env' },
      { key: 'equip:maintenance', label: 'Maintenance', module: 'equipment', action: 'create', push: 'equip:maintenance' },
      { key: 'safety', label: 'Incident', module: 'facilities_safety', action: 'create', push: 'safety' },
      { key: 'nc', label: 'Nonconformity', module: 'nc_capa', action: 'create', push: 'nc' },
      { key: 'inventory', label: 'Stock use', module: 'supplier_inventory', action: 'edit', push: 'inventory' },
      { key: 'forms', label: 'Fill a form', module: 'records_reports', action: 'view', push: 'forms' },
    ].filter(a => has(a.module, a.action));

    res.json({
      role: role?.role_key ?? null, roleName: role?.role_name ?? null,
      staffLinked: Boolean(staffId), widgets, quickActions,
      approvalsPending,
    });
  });

  // ────────────────────────────────────────────────────────── self-service
  router.get('/me', requireAuth, (req, res) => {
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    if (!staffId) return res.json({ staffLinked: false });
    const staff = db.prepare('SELECT s.*, sec.name AS section_name FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.id = ?').get(staffId);
    res.json({
      staffLinked: true,
      staff,
      positions: db.prepare('SELECT p.title, spa.assignment_type, spa.is_active FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = ?').all(staffId),
      authorizations: db.prepare('SELECT * FROM technical_authorizations WHERE staff_id = ? AND is_active = 1').all(staffId),
      documents: db.prepare('SELECT sd.*, f.original_name AS file_name FROM staff_documents sd LEFT JOIN files f ON f.id = sd.file_id WHERE sd.staff_id = ? ORDER BY sd.created_at DESC').all(staffId),
      training: db.prepare("SELECT te.title, te.training_date, te.training_type, ta.attendance_status FROM training_attendance ta JOIN training_events te ON te.id = ta.training_event_id WHERE ta.staff_id = ? ORDER BY te.training_date DESC").all(staffId),
      upcomingTraining: db.prepare("SELECT te.title, te.training_date, te.training_type FROM training_attendance ta JOIN training_events te ON te.id = ta.training_event_id WHERE ta.staff_id = ? AND te.training_date >= date('now') ORDER BY te.training_date").all(staffId),
      competency: db.prepare("SELECT competency_number, activity, assessment_date, outcome, status, next_assessment_due FROM competency_assessments WHERE staff_id = ? ORDER BY assessment_date DESC").all(staffId),
      duties: db.prepare("SELECT a.duty_date, a.shift_name, a.start_time, a.end_time, a.duty_role, r.roster_number FROM duty_roster_assignments a JOIN duty_rosters r ON r.id = a.roster_id WHERE a.staff_id = ? AND a.duty_date >= date('now') AND r.status IN ('published','approved') ORDER BY a.duty_date LIMIT 20").all(staffId),
      declarations: db.prepare("SELECT id, declaration_number, declaration_type, title, status, signed_at FROM staff_declarations WHERE staff_id = ? ORDER BY created_at DESC").all(staffId),
    });
  });

  router.put('/me/contact', requireAuth, (req, res) => {
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    if (!staffId) return res.status(400).json({ error: 'Your login is not linked to a staff record.' });
    const before = db.prepare('SELECT phone, email, emergency_contact, emergency_contact_phone, emergency_contact_relation FROM staff WHERE id = ?').get(staffId);
    db.prepare(`UPDATE staff SET phone = COALESCE(?, phone), email = COALESCE(?, email),
        emergency_contact = COALESCE(?, emergency_contact), emergency_contact_phone = COALESCE(?, emergency_contact_phone),
        emergency_contact_relation = COALESCE(?, emergency_contact_relation),
        professional_licence = COALESCE(?, professional_licence), licence_expiry_date = COALESCE(?, licence_expiry_date),
        professional_regulator = COALESCE(?, professional_regulator), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.phone ?? null, req.body.email ?? null, req.body.emergencyContact ?? null, req.body.emergencyContactPhone ?? null, req.body.emergencyContactRelation ?? null,
        req.body.professionalLicence ?? null, req.body.licenceExpiryDate ?? null, req.body.professionalRegulator ?? null, staffId);
    audit(req, { action: 'self_update', entity: 'staff', entityId: staffId, oldValue: before, newValue: req.body });
    res.json({ ok: true });
  });

  // Self-service document/licence/certificate upload. Scoped strictly to the
  // signed-in user's own staff record; lands as 'pending' so it flows through the
  // existing verification workflow (personnel approve).
  router.post('/me/documents', requireAuth, upload.single('file'), (req, res) => {
    let staffId: number;
    try { staffId = requireCurrentStaffId(req); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, path.basename(req.file.path), req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    const fileId = Number(file.lastInsertRowid);
    const result = db.prepare(`INSERT INTO staff_documents (staff_id, document_type, title, file_id, issue_date, expiry_date, verification_status, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(staffId, req.body.documentType ?? 'certificate', req.body.title, fileId, req.body.issueDate ?? null, req.body.expiryDate ?? null, req.body.remarks ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'self_upload', entity: 'staff_documents', entityId: id, newValue: { title: req.body.title, documentType: req.body.documentType } });
    res.status(201).json({ id, fileId });
  });

  // Sign one of my own pending declarations/acknowledgements electronically.
  router.post('/me/declarations/:id/sign', requireAuth, (req, res) => {
    let staffId: number;
    try { staffId = requireCurrentStaffId(req); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    const db = getDb();
    const decl = db.prepare('SELECT * FROM staff_declarations WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!decl) return res.status(404).json({ error: 'Declaration not found' });
    if (decl.staff_id && Number(decl.staff_id) !== staffId) return res.status(403).json({ error: 'This declaration is assigned to another staff member.' });
    const sig = recordSignature(req, { moduleKey: 'personnel', recordType: 'staff_declaration', recordId: req.params.id, purpose: 'declaration_sign', meaning: `Signed: ${String(decl.title ?? '')}`, signatureImageFileId: req.body?.signatureImageFileId ?? null });
    db.prepare("UPDATE staff_declarations SET staff_id = ?, signed_at = CURRENT_TIMESTAMP, signature_file_id = ?, status = 'signed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(staffId, parseIntNullable(req.body?.signatureImageFileId), req.params.id);
    audit(req, { action: 'sign', entity: 'staff_declarations', entityId: req.params.id, newValue: { status: 'signed', signatureId: sig.id } });
    res.json({ ok: true, signature: sig });
  });

  router.get('/me/leave', requireAuth, (req, res) => {
    const staffId = getCurrentStaffId(req);
    if (!staffId) return res.json([]);
    res.json(getDb().prepare('SELECT * FROM leave_requests WHERE staff_id = ? ORDER BY created_at DESC').all(staffId));
  });

  router.post('/me/leave', requireAuth, (req, res) => {
    let staffId: number;
    try { staffId = requireCurrentStaffId(req); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    const { leaveType, startDate, endDate, reason, days } = req.body ?? {};
    if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required' });
    const db = getDb();
    const result = db.prepare("INSERT INTO leave_requests (staff_id, leave_type, start_date, end_date, reason, days, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(staffId, leaveType ?? 'annual', startDate, endDate, reason ?? null, parseIntNullable(days), req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'leave_requests', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.get('/me/clock', requireAuth, (req, res) => {
    const staffId = getCurrentStaffId(req);
    if (!staffId) return res.json({ staffLinked: false, status: 'out', recent: [] });
    const db = getDb();
    const last = db.prepare("SELECT event_type, event_at FROM clock_events WHERE staff_id = ? ORDER BY event_at DESC LIMIT 1").get(staffId) as { event_type?: string } | undefined;
    const recent = db.prepare("SELECT event_type, event_at, location_label FROM clock_events WHERE staff_id = ? ORDER BY event_at DESC LIMIT 10").all(staffId);
    res.json({ staffLinked: true, status: last?.event_type === 'in' ? 'in' : 'out', last: last ?? null, recent });
  });

  router.post('/me/clock', requireAuth, (req, res) => {
    let staffId: number;
    try { staffId = requireCurrentStaffId(req); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    const db = getDb();
    const last = db.prepare("SELECT event_type FROM clock_events WHERE staff_id = ? ORDER BY event_at DESC LIMIT 1").get(staffId) as { event_type?: string } | undefined;
    const nextType = req.body.eventType ?? (last?.event_type === 'in' ? 'out' : 'in');
    if (!['in', 'out'].includes(nextType)) return res.status(400).json({ error: "eventType must be 'in' or 'out'" });
    const result = db.prepare(`INSERT INTO clock_events (staff_id, user_id, event_type, latitude, longitude, accuracy_m, location_label, device_info, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(staffId, req.user!.id, nextType, req.body.latitude ?? null, req.body.longitude ?? null, req.body.accuracy ?? null, req.body.locationLabel ?? null, req.headers['user-agent'] ?? null, req.body.notes ?? null);
    audit(req, { action: 'clock_' + nextType, entity: 'clock_events', entityId: Number(result.lastInsertRowid), newValue: { eventType: nextType } });
    res.status(201).json({ id: Number(result.lastInsertRowid), eventType: nextType });
  });

  // ─────────────────────────────────────────────────────────── announcements
  router.get('/announcements', requireAuth, (req, res) => {
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    const role = db.prepare('SELECT r.name AS role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(req.user!.id) as { role_key?: string } | undefined;
    const sectionId = staffId ? (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as { section_id?: number } | undefined)?.section_id ?? null : null;
    const rows = db.prepare(`SELECT a.*, (SELECT read_at FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?) AS read_at,
        (SELECT acknowledged_at FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?) AS acknowledged_at
      FROM announcements a
      WHERE a.status = 'published' AND (a.expires_at IS NULL OR date(a.expires_at) >= date('now'))
        AND (a.audience_role_key IS NULL OR a.audience_role_key = ?)
        AND (a.section_id IS NULL OR a.section_id = ?)
      ORDER BY CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, COALESCE(a.published_at, a.created_at) DESC LIMIT 50`)
      .all(req.user!.id, req.user!.id, role?.role_key ?? null, sectionId);
    res.json(rows);
  });

  router.post('/announcements/:id/read', requireAuth, (req, res) => {
    const db = getDb();
    const ann = db.prepare('SELECT requires_acknowledgement FROM announcements WHERE id = ?').get(req.params.id) as { requires_acknowledgement?: number } | undefined;
    if (!ann) return res.status(404).json({ error: 'Announcement not found' });
    const acknowledge = req.body?.acknowledge === true || req.body?.acknowledge === 'true';
    db.prepare(`INSERT INTO announcement_reads (announcement_id, staff_id, user_id, read_at, acknowledged_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP, acknowledged_at = COALESCE(excluded.acknowledged_at, announcement_reads.acknowledged_at)`)
      .run(req.params.id, getCurrentStaffId(req), req.user!.id, acknowledge ? new Date().toISOString() : null);
    if (acknowledge && ann.requires_acknowledgement) {
      recordSignature(req, { moduleKey: 'notifications', recordType: 'announcement', recordId: req.params.id, purpose: 'announcement_ack', meaning: 'Acknowledged organisational announcement' });
    }
    res.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────── approvals
  router.get('/approvals', requireAuth, (req, res) => {
    const db = getDb();
    const uid = req.user!.id;
    const items: Row[] = [];
    for (const src of Object.values(SOURCES)) {
      if (!canApprove(uid, src)) continue;
      const rows = db.prepare(`SELECT id, ${src.titleExpr} AS title, ${src.requesterCol} AS requester_staff_id, created_at,
          (SELECT full_name FROM staff s WHERE s.id = ${src.table}.${src.requesterCol}) AS requester_name
        FROM ${src.table} WHERE ${src.pendingWhere} ORDER BY created_at DESC LIMIT 50`).all() as Row[];
      for (const r of rows) items.push({ ...r, type: src.type, typeLabel: src.label });
    }
    items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json(items);
  });

  router.post('/approvals/:type/:id/decision', requireAuth, (req, res) => {
    const src = SOURCES[req.params.type];
    if (!src) return res.status(400).json({ error: 'Unknown approval type' });
    if (!canApprove(req.user!.id, src)) return res.status(403).json({ error: 'Permission denied' });
    const decision = String(req.body?.decision ?? '');
    if (!['approve', 'reject', 'return'].includes(decision)) return res.status(400).json({ error: "decision must be 'approve', 'reject' or 'return'" });
    const db = getDb();
    const record = db.prepare(`SELECT * FROM ${src.table} WHERE id = ?`).get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: `${src.label} not found` });

    const approverStaffId = getCurrentStaffId(req);
    const status = decision === 'approve' ? src.approvedStatus : decision === 'reject' ? src.rejectedStatus : src.returnedStatus;
    const comments = req.body?.comments ?? null;
    const noteAssign = src.notesCol ? `, ${src.notesCol} = ?` : '';
    const sql = `UPDATE ${src.table} SET status = ?, ${src.approverCol} = ?, ${src.decidedAtCol} = CURRENT_TIMESTAMP${noteAssign}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
    const params: unknown[] = [status, approverStaffId];
    if (src.notesCol) params.push(comments);
    params.push(req.params.id);
    try { db.prepare(sql).run(...params); }
    catch {
      // Some target tables (older schemas) may lack updated_at — retry without it.
      const sql2 = `UPDATE ${src.table} SET status = ?, ${src.approverCol} = ?, ${src.decidedAtCol} = CURRENT_TIMESTAMP${noteAssign} WHERE id = ?`;
      db.prepare(sql2).run(...params);
    }

    // Electronic signature on every decision (identity, timestamp, device, IP, audit).
    const sig = recordSignature(req, {
      moduleKey: src.module, recordType: src.type, recordId: req.params.id,
      purpose: `${src.type}_${decision}`, meaning: `${decision.toUpperCase()} — ${src.label}`,
      signatureImageFileId: req.body?.signatureImageFileId ?? null,
    });
    audit(req, { action: `approval_${decision}`, entity: src.table, entityId: req.params.id, oldValue: { status: record.status }, newValue: { status, comments, signatureId: sig.id } });

    // Notify the requester (in-app now; push when the transport is live).
    const requesterStaffId = record[src.requesterCol] as number | undefined;
    if (requesterStaffId) {
      const requesterUser = db.prepare('SELECT id FROM users WHERE staff_id = ?').get(requesterStaffId) as { id?: number } | undefined;
      if (requesterUser?.id) {
        queuePush({ userId: requesterUser.id, moduleKey: src.module, priority: decision === 'approve' ? 'normal' : 'high',
          title: `${src.label} ${decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'returned for correction'}`,
          body: comments ? String(comments) : undefined });
      }
    }
    res.json({ ok: true, status, signature: sig });
  });

  return router;
}
