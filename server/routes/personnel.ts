import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import fs from 'node:fs';
import path from 'node:path';

// The register import parses a workbook and never keeps it, so it stays in
// memory. A file a member of staff attaches to their own record is kept, so it
// goes to disk under the same upload root every other stored file uses.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const fileUpload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Stream a stored file back to the caller. False when there is nothing to send. */
function streamStoredFile(res: import('express').Response, fileId: number | null | undefined): boolean {
  if (!fileId) return false;
  const file = getDb().prepare('SELECT stored_name, mime_type FROM files WHERE id = ?').get(fileId) as { stored_name: string; mime_type: string } | undefined;
  if (!file) return false;
  const fp = path.join(uploadRoot, file.stored_name);
  if (!fs.existsSync(fp)) return false;
  res.setHeader('Content-Type', file.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(fp).pipe(res);
  return true;
}

const ORIENTATION_STEPS = ['welcome_orientation', 'safety_training', 'ethics_training', 'lis_training', 'equipment_training', 'sop_review', 'competency_baseline', 'department_induction'] as const;

// Master Personnel Register sheet definition (header row mirrors the workbook,
// SECHFO003). Used for the import template and Excel export.
const REGISTER_HEADERS = [
  'STAFF ID', 'SURNAME', 'MIDDLE NAME(S)', 'FIRSTNAME(S)', 'INITIALS', 'DATE OF BIRTH', 'GENDER',
  'DESIGNATION', 'POSITION', 'PROFESSIONAL REGULATOR', 'PROFESSIONAL LICENCE', 'PROFESSIONAL QUALIFICATION(S)',
  'UNIT', 'PERSONNEL CATEGORY', 'APPOINTMENT TYPE', 'DATE OF APPOINTMENT', 'TYPE OF NATIONAL ID',
  'NATIONAL ID NUM', 'EMERGENCY CONTACT', 'CONTACT PHONE', 'EMAIL ADDRESS', 'STAFF FILE LOCATION',
] as const;

// Map a register row (header → value) to staff columns. Accepts a few header
// aliases so slightly different workbook exports still import cleanly.
function pick(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const found = Object.keys(row).find(h => h.trim().toUpperCase() === k.trim().toUpperCase());
    if (found) {
      const v = row[found];
      const s = v === null || v === undefined ? '' : String(v).trim();
      if (s) return s;
    }
  }
  return null;
}

const DECLARATION_TYPES = ['confidentiality', 'ethical_declaration', 'conflict_of_interest', 'safety_commitment', 'other'];
const DECLARATION_STATUSES = ['pending', 'signed', 'withdrawn'];
const TRAINING_STATUSES = ['planned', 'completed', 'cancelled'];
const ATTENDANCE_STATUSES = ['invited', 'attended', 'absent', 'excused'];
const STAFF_DOC_VERIFICATION = ['pending', 'verified', 'rejected', 'expired'];
const ROSTER_STATUSES = ['draft', 'published', 'approved', 'archived'];

export function personnelRoutes() {
  const router = Router();

  // ============= Staff documents =============
  router.get('/staff-documents', requirePermission('personnel.register', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('sd.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.verificationStatus) { filters.push('sd.verification_status = ?'); params.push(String(req.query.verificationStatus)); }
    let query = 'SELECT sd.*, s.full_name AS staff_name, f.original_name AS file_name FROM staff_documents sd LEFT JOIN staff s ON s.id = sd.staff_id LEFT JOIN files f ON f.id = sd.file_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY sd.created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/staff-documents', requirePermission('personnel.register', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    if (!req.body.documentType) return res.status(400).json({ error: 'documentType is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const result = db.prepare(`INSERT INTO staff_documents (staff_id, document_type, title, file_id, issue_date, expiry_date, verification_status, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseIntNullable(req.body.staffId), req.body.documentType, req.body.title, parseIntNullable(req.body.fileId), req.body.issueDate ?? null, req.body.expiryDate ?? null, 'pending', req.body.remarks ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.fileId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'staff_documents', String(id), 'documents', 'files', String(req.body.fileId), 'Staff document file');
    }
    audit(req, { action: 'create', entity: 'staff_documents', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.post('/staff-documents/:id/verify', requirePermission('personnel.register', 'approve'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM staff_documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Staff document not found' });
    const verifiedBy = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    if (verifiedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const status = req.body.verificationStatus ?? 'verified';
    if (!STAFF_DOC_VERIFICATION.includes(status)) return res.status(400).json({ error: `verificationStatus must be one of: ${STAFF_DOC_VERIFICATION.join(', ')}` });
    db.prepare('UPDATE staff_documents SET verification_status = ?, verified_by_staff_id = ?, verified_at = CURRENT_TIMESTAMP, remarks = COALESCE(?, remarks), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, verifiedBy, req.body.remarks ?? null, req.params.id);
    audit(req, { action: 'verify', entity: 'staff_documents', entityId: req.params.id, oldValue: { verification_status: doc.verification_status }, newValue: { verificationStatus: status, verifiedByStaffId: verifiedBy } });
    res.json({ ok: true });
  });

  // ============= Declarations =============
  router.get('/declarations', requirePermission('personnel.declarations', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('d.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.status) { filters.push('d.status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT d.*, s.full_name AS staff_name FROM staff_declarations d LEFT JOIN staff s ON s.id = d.staff_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY d.created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/declarations', requirePermission('personnel.declarations', 'create'), (req, res) => {
    if (!req.body.declarationType) return res.status(400).json({ error: 'declarationType is required' });
    if (!DECLARATION_TYPES.includes(req.body.declarationType)) return res.status(400).json({ error: `declarationType must be one of: ${DECLARATION_TYPES.join(', ')}` });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const declarationNumber = generateRecordNumber(db, 'staff_declarations', 'DEC', createdAt);
    const boolInt = (v: unknown) => v === true || v === 'true' || v === 1 || v === 'Yes' || v === 'yes' ? 1 : (v === undefined || v === null || v === '' ? null : 0);
    const result = db.prepare(`INSERT INTO staff_declarations
      (declaration_number, declaration_type, title, description, document_id, document_version_id, staff_id,
       impartiality_confirmed, confidentiality_confirmed, conflict_of_interest, code_of_conduct_ack,
       form_completed_date, reviewed_by_staff_id, review_date, next_review_date, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(declarationNumber, req.body.declarationType, req.body.title, req.body.description ?? null,
        parseIntNullable(req.body.documentId), parseIntNullable(req.body.documentVersionId), parseIntNullable(req.body.staffId),
        boolInt(req.body.impartialityConfirmed), boolInt(req.body.confidentialityConfirmed), req.body.conflictOfInterest ?? null,
        boolInt(req.body.codeOfConductAck), req.body.formCompletedDate ?? null, parseIntNullable(req.body.reviewedByStaffId),
        req.body.reviewDate ?? null, req.body.nextReviewDate ?? null, 'pending', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'staff_declarations', entityId: id, newValue: { declarationNumber, ...req.body } });
    res.status(201).json({ id, declarationNumber });
  });

  router.post('/declarations/:id/sign', requirePermission('personnel.declarations', 'edit'), (req, res) => {
    const db = getDb();
    const decl = db.prepare('SELECT * FROM staff_declarations WHERE id = ?').get(req.params.id) as any;
    if (!decl) return res.status(404).json({ error: 'Declaration not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.staffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE staff_declarations SET staff_id = ?, signed_at = CURRENT_TIMESTAMP, signature_file_id = ?, status = 'signed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(staffId, parseIntNullable(req.body.signatureFileId), req.params.id);
    audit(req, { action: 'sign', entity: 'staff_declarations', entityId: req.params.id, oldValue: { status: decl.status }, newValue: { status: 'signed', staffId } });
    res.json({ ok: true });
  });

  // ============= Training =============
  router.get('/training', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM training_events';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY training_date DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/training', requirePermission('personnel.training', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.trainingDate) return res.status(400).json({ error: 'trainingDate is required' });
    const status = req.body.status ?? 'planned';
    if (!TRAINING_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${TRAINING_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const trainingNumber = generateRecordNumber(db, 'training_events', 'TRN', createdAt);
    const result = db.prepare(`INSERT INTO training_events (training_number, title, description, training_type, department_id, section_id, trainer_staff_id, training_date, start_time, end_time, location, evidence_file_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(trainingNumber, req.body.title, req.body.description ?? null, req.body.trainingType ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.trainerStaffId), req.body.trainingDate, req.body.startTime ?? null, req.body.endTime ?? null, req.body.location ?? null, parseIntNullable(req.body.evidenceFileId), status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.evidenceFileId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'training_events', String(id), 'documents', 'files', String(req.body.evidenceFileId), 'Training evidence file');
    }
    audit(req, { action: 'create', entity: 'training_events', entityId: id, newValue: { trainingNumber, ...req.body } });
    res.status(201).json({ id, trainingNumber });
  });

  router.get('/training/:id', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    const attendance = db.prepare('SELECT a.*, s.full_name AS staff_name FROM training_attendance a JOIN staff s ON s.id = a.staff_id WHERE a.training_event_id = ? ORDER BY s.full_name').all(req.params.id);
    res.json({ ...event, attendance });
  });

  router.post('/training/:id/attendance', requirePermission('personnel.training', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const event = db.prepare('SELECT id FROM training_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    const status = req.body.attendanceStatus ?? 'invited';
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `attendanceStatus must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
    const existing = db.prepare('SELECT id FROM training_attendance WHERE training_event_id = ? AND staff_id = ?').get(req.params.id, req.body.staffId) as any;
    let id: number;
    if (existing) {
      db.prepare('UPDATE training_attendance SET attendance_status = ?, signed_at = CASE WHEN ? = \'attended\' THEN CURRENT_TIMESTAMP ELSE signed_at END, remarks = COALESCE(?, remarks) WHERE id = ?')
        .run(status, status, req.body.remarks ?? null, existing.id);
      id = existing.id;
    } else {
      const result = db.prepare(`INSERT INTO training_attendance (training_event_id, staff_id, attendance_status, signed_at, remarks, created_by) VALUES (?, ?, ?, CASE WHEN ? = 'attended' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)`)
        .run(req.params.id, req.body.staffId, status, status, req.body.remarks ?? null, req.user!.id);
      id = Number(result.lastInsertRowid);
    }
    audit(req, { action: 'attendance', entity: 'training_attendance', entityId: id, newValue: { trainingEventId: req.params.id, staffId: req.body.staffId, status } });
    res.status(201).json({ id });
  });

  // Competency assessment lives in routes/competency.ts — a framework, a
  // scored record and its evidence, mounted on this same /personnel prefix.

  // ============= Duty rosters =============
  router.get('/rosters', requirePermission('personnel.rosters', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.sectionId) { filters.push('section_id = ?'); params.push(Number(req.query.sectionId)); }
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM duty_rosters';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY roster_start_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/rosters', requirePermission('personnel.rosters', 'create'), (req, res) => {
    if (!req.body.rosterStartDate) return res.status(400).json({ error: 'rosterStartDate is required' });
    if (!req.body.rosterEndDate) return res.status(400).json({ error: 'rosterEndDate is required' });
    const status = req.body.status ?? 'draft';
    if (!ROSTER_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ROSTER_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const rosterNumber = generateRecordNumber(db, 'duty_rosters', 'ROSTER', createdAt);
    const result = db.prepare(`INSERT INTO duty_rosters (roster_number, department_id, section_id, roster_start_date, roster_end_date, status, prepared_by_staff_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rosterNumber, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.rosterStartDate, req.body.rosterEndDate, status, getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'duty_rosters', entityId: id, newValue: { rosterNumber, ...req.body } });
    res.status(201).json({ id, rosterNumber });
  });

  router.get('/rosters/:id', requirePermission('personnel.rosters', 'view'), (req, res) => {
    const db = getDb();
    const roster = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const assignments = db.prepare('SELECT a.*, s.full_name AS staff_name FROM duty_roster_assignments a JOIN staff s ON s.id = a.staff_id WHERE a.roster_id = ? ORDER BY a.duty_date, a.start_time').all(req.params.id);
    res.json({ ...roster, assignments });
  });

  router.post('/rosters/:id/assignments', requirePermission('personnel.rosters', 'edit'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    if (!req.body.dutyDate) return res.status(400).json({ error: 'dutyDate is required' });
    const db = getDb();
    const roster = db.prepare('SELECT id FROM duty_rosters WHERE id = ?').get(req.params.id);
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const result = db.prepare(`INSERT INTO duty_roster_assignments (roster_id, staff_id, duty_date, shift_name, start_time, end_time, duty_role, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.staffId, req.body.dutyDate, req.body.shiftName ?? null, req.body.startTime ?? null, req.body.endTime ?? null, req.body.dutyRole ?? null, req.body.notes ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'duty_rosters', String(req.params.id), 'personnel', 'duty_roster_assignments', String(id), 'Roster assignment');
    audit(req, { action: 'assign', entity: 'duty_roster_assignments', entityId: id, newValue: { rosterId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.post('/rosters/:id/approve', requirePermission('personnel.rosters', 'approve'), (req, res) => {
    const db = getDb();
    const roster = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE duty_rosters SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(approvedBy, req.params.id);
    audit(req, { action: 'approve', entity: 'duty_rosters', entityId: req.params.id, oldValue: { status: roster.status }, newValue: { status: 'approved', approvedByStaffId: approvedBy } });
    res.json({ ok: true });
  });

  router.get('/rosters/:id/coverage', requirePermission('personnel.rosters', 'view'), (req, res) => {
    const db = getDb();
    const roster = db.prepare('SELECT * FROM duty_rosters WHERE id = ?').get(req.params.id) as any;
    if (!roster) return res.status(404).json({ error: 'Roster not found' });
    const assignments = db.prepare('SELECT * FROM duty_roster_assignments WHERE roster_id = ? ORDER BY duty_date, start_time').all(req.params.id) as any[];

    const dates: string[] = [];
    const start = new Date(roster.roster_start_date);
    const end = new Date(roster.roster_end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const byDate = new Map<string, any[]>();
    for (const a of assignments) {
      if (!byDate.has(a.duty_date)) byDate.set(a.duty_date, []);
      byDate.get(a.duty_date)!.push(a);
    }
    const gaps = dates.filter(d => !byDate.has(d));

    const conflicts: Array<{ duty_date: string; staff_id: number; assignments: any[] }> = [];
    const overlaps = (aStart?: string, aEnd?: string, bStart?: string, bEnd?: string) => {
      if (!aStart || !aEnd || !bStart || !bEnd) return Boolean(aStart === bStart && aEnd === bEnd);
      return aStart < bEnd && bStart < aEnd;
    };
    for (const [date, rows] of byDate) {
      const byStaff = new Map<number, any[]>();
      for (const r of rows) {
        if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, []);
        byStaff.get(r.staff_id)!.push(r);
      }
      for (const [staffId, list] of byStaff) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            if (overlaps(list[i].start_time, list[i].end_time, list[j].start_time, list[j].end_time)) {
              conflicts.push({ duty_date: date, staff_id: staffId, assignments: [list[i], list[j]] });
              break;
            }
          }
        }
      }
    }

    res.json({
      rosterId: Number(req.params.id),
      periodStart: roster.roster_start_date,
      periodEnd: roster.roster_end_date,
      totalDates: dates.length,
      coveredDates: dates.length - gaps.length,
      gapDates: gaps,
      conflicts,
      assignmentsByDate: dates.map(d => ({ date: d, count: (byDate.get(d) ?? []).length }))
    });
  });

  // ============= Self-service =============
  // A user's own profile. Always available to the signed-in user regardless of
  // their rights on Personnel — this is their own record, and the dashboard
  // profile card is built from it.
  router.get('/my-profile', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    const account = db.prepare(
      'SELECT u.id, u.username, u.full_name AS fullName, r.name AS roleName FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?'
    ).get(req.user.id) as { id: number; username: string; fullName: string; roleName: string } | undefined;
    const user = account ?? { id: req.user.id, username: req.user.username, fullName: req.user.username, roleName: null };
    if (!staffId) return res.json({ user, staff: null, positions: [], authorizations: [], hasSignature: false });
    const staff = db.prepare('SELECT s.*, sec.name AS section_name FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.id = ?').get(staffId) as { signature_file_id?: number | null } | undefined;
    const positions = db.prepare('SELECT p.title, spa.assignment_type, spa.is_active FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = ?').all(staffId);
    // Expired authorizations are filtered out here for the same reason the
    // resolver ignores them: they no longer authorise anything.
    const authorizations = db.prepare(
      "SELECT * FROM technical_authorizations WHERE staff_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at = '' OR date(expires_at) >= date('now'))"
    ).all(staffId);
    res.json({ user, staff, positions, authorizations, hasSignature: Boolean(staff?.signature_file_id), hasPhoto: Boolean((staff as { photo_file_id?: number | null } | undefined)?.photo_file_id) });
  });

  router.get('/my-tasks', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    if (!staffId) return res.json({ pendingAttestations: [], pendingDeclarations: [], upcomingTraining: [], upcomingCompetency: [], assignedActions: [], upcomingDuties: [] });
    res.json({
      pendingAttestations: db.prepare("SELECT a.*, d.document_code, d.title FROM document_attestations a JOIN documents d ON d.id = COALESCE(a.document_id, (SELECT document_id FROM document_versions WHERE id = a.document_version_id)) WHERE a.staff_id = ? AND a.status IN ('pending','overdue') ORDER BY a.due_date NULLS LAST").all(staffId),
      pendingDeclarations: db.prepare("SELECT * FROM staff_declarations WHERE staff_id = ? AND status = 'pending'").all(staffId),
      upcomingTraining: db.prepare("SELECT te.*, ta.attendance_status FROM training_attendance ta JOIN training_events te ON te.id = ta.training_event_id WHERE ta.staff_id = ? AND te.training_date >= date('now') ORDER BY te.training_date").all(staffId),
      upcomingCompetency: db.prepare("SELECT * FROM competency_assessments WHERE staff_id = ? AND status IN ('planned','in_progress') ORDER BY assessment_date").all(staffId),
      assignedActions: db.prepare("SELECT * FROM actions WHERE assigned_to_staff_id = ? AND status != 'Closed' ORDER BY due_date NULLS LAST").all(staffId),
      upcomingDuties: db.prepare("SELECT a.*, r.roster_number FROM duty_roster_assignments a JOIN duty_rosters r ON r.id = a.roster_id WHERE a.staff_id = ? AND a.duty_date >= date('now') AND r.status IN ('published','approved') ORDER BY a.duty_date").all(staffId)
    });
  });

  // My declarations — the Code of Conduct / ethical declarations that concern
  // the logged-in member of staff: the ones they have signed (so they can
  // reopen and print them from their own profile) and the ones still awaiting
  // their signature. Personal data, so gated only on being signed in.
  router.get('/my-declarations', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    if (!staffId) return res.json({ signed: [], pending: [] });
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ethical_declaration_forms'").get()) {
      return res.json({ signed: [], pending: [] });
    }
    const signed = db.prepare(`SELECT f.id, f.form_number, f.title, f.form_type, f.version, f.effective_date, f.body_content,
        f.acknowledgement_statement, f.file_id, fl.original_name AS file_name, iss.full_name AS issued_by,
        sig.id AS signature_id, sig.signed_at, sig.conflict_declared, sig.conflict_details, sig.affirmation_text, sig.signed_file_id
      FROM ethical_declaration_signatures sig
      JOIN ethical_declaration_forms f ON f.id = sig.form_id
      LEFT JOIN files fl ON fl.id = f.file_id
      LEFT JOIN staff iss ON iss.id = f.uploaded_by_staff_id
      WHERE sig.staff_id = ? ORDER BY sig.signed_at DESC`).all(staffId);
    const pending = db.prepare(`SELECT f.id, f.form_number, f.title, f.form_type, f.version, f.effective_date, f.body_content,
        f.acknowledgement_statement, f.file_id
      FROM ethical_declaration_forms f
      WHERE f.status = 'active' AND NOT EXISTS (SELECT 1 FROM ethical_declaration_signatures s WHERE s.form_id = f.id AND s.staff_id = ?)
      ORDER BY f.uploaded_at DESC`).all(staffId);
    res.json({ signed, pending });
  });

  // My documents — the staff documents on the logged-in member of staff's own
  // file. Self-scoped so a member of staff can see their own without holding
  // the register view permission.
  router.get('/my-documents', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    if (!staffId) return res.json([]);
    res.json(db.prepare(`SELECT sd.*, f.original_name AS file_name FROM staff_documents sd
      LEFT JOIN files f ON f.id = sd.file_id WHERE sd.staff_id = ? ORDER BY sd.created_at DESC`).all(staffId));
  });

  router.get('/staff-suggestions', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const user = db.prepare('SELECT id, username, full_name, staff_id FROM users WHERE id = ?').get(req.user.id) as any;
    if (user.staff_id) return res.json({ alreadyLinked: true, suggestions: [] });
    const suggestions = db.prepare(`SELECT s.id, s.full_name, s.email, s.employee_no, sec.name AS section_name,
        CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.staff_id = s.id) THEN 1 ELSE 0 END AS already_taken
      FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.is_active = 1 AND (LOWER(s.full_name) = LOWER(?) OR LOWER(s.email) = LOWER(COALESCE(?, '')))
      ORDER BY already_taken, s.full_name`).all(user.full_name, user.username);
    res.json({ alreadyLinked: false, suggestions });
  });

  router.post('/link-my-staff', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const me = db.prepare('SELECT id, username, full_name, staff_id FROM users WHERE id = ?').get(req.user.id) as any;
    if (me.staff_id) return res.status(400).json({ error: 'Your user is already linked to a staff record.' });
    const candidate = db.prepare('SELECT id, full_name, email FROM staff WHERE id = ? AND is_active = 1').get(req.body.staffId) as any;
    if (!candidate) return res.status(404).json({ error: 'Staff record not found' });
    const taken = db.prepare('SELECT id FROM users WHERE staff_id = ?').get(req.body.staffId);
    if (taken) return res.status(400).json({ error: 'That staff record is already linked to another user.' });
    const nameMatch = candidate.full_name && candidate.full_name.toLowerCase() === me.full_name.toLowerCase();
    const emailMatch = candidate.email && me.username && candidate.email.toLowerCase() === me.username.toLowerCase();
    if (!nameMatch && !emailMatch) return res.status(400).json({ error: 'Self-link requires exact name or email match. Ask an administrator to link your account.' });
    db.prepare('UPDATE users SET staff_id = ? WHERE id = ?').run(req.body.staffId, req.user.id);
    audit(req, { action: 'self_link_staff', entity: 'users', entityId: req.user.id, oldValue: { staffId: null }, newValue: { staffId: req.body.staffId, matchedOn: nameMatch ? 'full_name' : 'email' } });
    res.json({ ok: true, staffId: req.body.staffId });
  });

  /* ──────────────────────────────────────────────────────────────────────
   * Self-maintenance — the part of the file its subject keeps
   * ────────────────────────────────────────────────────────────────────────
   * A personnel file has two halves that are easy to confuse. One is what the
   * laboratory decides about a person: their post, their unit, their staff
   * number, their appointment, whether they are still employed. The other is
   * what the person knows and the laboratory does not: that they have moved
   * house, changed their phone, renewed a practising licence, finished a
   * course at the weekend, or that their next of kin is somebody else now.
   *
   * The second half used to be maintained by asking somebody in Personnel
   * Management to type it in, which is why it went stale. These routes hand
   * it back to the person it belongs to. Everything here is bound to the
   * caller's own staff record and nothing accepts a staff id from the body —
   * a member of staff maintaining their own file must never become a way to
   * edit a colleague's.
   *
   * The line is drawn at consequence. A field that decides what somebody may
   * do, what they are paid, or where they work is a management decision and
   * stays out. A field that is simply a fact about them that they are the
   * best source for is theirs, and every change is written to the audit trail
   * with its old value so the register can always be reconstructed.
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * The staff columns a person may set on themselves.
   *
   * Read this list as the answer to "what would it cost if this were wrong?".
   * A wrong phone number costs a phone call. A wrong designation costs the
   * access their profile grants — which is why designation, job title, unit,
   * section, staff number, appointment, category, cadre, rank, availability
   * and the exit fields are all absent, and always should be.
   *
   * Qualifications and the professional licence ARE here: the person renewing
   * the licence is the only one who knows the new number the day it changes,
   * and the certificate that proves it goes onto their file as a document for
   * Personnel Management to verify. The claim is theirs; the verification is
   * not.
   */
  const SELF_EDITABLE_STAFF_FIELDS: Record<string, string> = {
    phone: 'phone',
    email: 'email',
    dateOfBirth: 'date_of_birth',
    gender: 'gender',
    nationalIdType: 'national_id_type',
    nationalIdNumber: 'national_id_number',
    emergencyContact: 'emergency_contact',
    emergencyContactPhone: 'emergency_contact_phone',
    emergencyContactRelation: 'emergency_contact_relation',
    qualifications: 'qualifications',
    professionalRegulator: 'professional_regulator',
    professionalLicence: 'professional_licence',
    licenceExpiryDate: 'licence_expiry_date',
  };

  router.put('/my-profile', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const staffId = req.user.staffId;
    if (!staffId) return res.status(400).json({ error: 'Your account is not linked to a staff record.' });
    const before = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId) as Record<string, unknown> | undefined;
    if (!before) return res.status(404).json({ error: 'Staff record not found.' });

    const sets: string[] = [];
    const values: unknown[] = [];
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, column] of Object.entries(SELF_EDITABLE_STAFF_FIELDS)) {
      if (!(key in req.body)) continue;
      const raw = req.body[key];
      const value = raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw).trim();
      if ((before[column] ?? null) === value) continue;
      sets.push(`${column} = ?`);
      values.push(value);
      changed[column] = { from: before[column] ?? null, to: value };
    }
    // A request that names only fields nobody may set on themselves is a
    // refusal, not a silent success: the caller should learn the field is not
    // theirs rather than believe the change was saved.
    if (sets.length === 0) {
      const offered = Object.keys(req.body ?? {});
      const unknownFields = offered.filter(k => !(k in SELF_EDITABLE_STAFF_FIELDS));
      if (unknownFields.length > 0 && offered.length === unknownFields.length) {
        return res.status(400).json({
          error: `These details are maintained by Personnel Management and cannot be changed here: ${unknownFields.join(', ')}.`,
        });
      }
      return res.json({ ok: true, changed: 0 });
    }
    values.push(staffId);
    db.prepare(`UPDATE staff SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    audit(req, { action: 'self_edit', entity: 'staff', entityId: staffId, oldValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])), newValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])) });
    res.json({ ok: true, changed: sets.length });
  });

  /**
   * A file the caller is attaching to their own record.
   *
   * The general /files endpoint asks for the right to author controlled
   * documents, which a member of staff at the bench does not have and should
   * not need in order to attach a copy of their own practising licence. This
   * one asks only that they are signed in, and every row it writes is
   * attributed to them.
   */
  router.post('/my-upload', fileUpload.single('file'), (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.file) return res.status(400).json({ error: 'No file was attached.' });
    const r = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user.id);
    audit(req, { action: 'create', entity: 'files', entityId: r.lastInsertRowid, newValue: { originalName: req.file.originalname, purpose: String(req.body?.purpose ?? 'personal_record') } });
    res.status(201).json({ id: r.lastInsertRowid, storedName: req.file.filename });
  });

  /* ---- Passport photograph ----------------------------------------------
   * Capped at 2 MB and images only. The cap is not arbitrary: a passport
   * photograph is a small picture of a face, and anything larger than this is
   * a camera's full-resolution output that nobody asked for — it fills the
   * data directory, slows every register that shows a face, and carries the
   * original's location metadata with it. The portal reduces the picture to
   * passport proportions before it is sent, so a phone photograph arrives here
   * already the right shape and a small fraction of the limit.
   * --------------------------------------------------------------------- */
  const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
  const photoUpload = multer({
    storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) }),
    limits: { fileSize: PHOTO_MAX_BYTES },
  });

  router.post('/my-photo', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    photoUpload.single('file')(req, res, (err: unknown) => {
      // Multer rejects an oversized file by aborting the request, which without
      // this handler surfaces as a bare 500. The person uploading deserves to
      // be told the actual limit.
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'A profile picture must be 2 MB or smaller.' });
        return res.status(400).json({ error: (err as Error).message || 'The picture could not be uploaded.' });
      }
      const staffId = req.user!.staffId;
      if (!staffId) return res.status(400).json({ error: 'Your account is not linked to a staff record.' });
      if (!req.file) return res.status(400).json({ error: 'No picture was attached.' });
      if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'A profile picture must be an image file.' });
      const db = getDb();
      const previous = (db.prepare('SELECT photo_file_id FROM staff WHERE id = ?').get(staffId) as { photo_file_id?: number | null } | undefined)?.photo_file_id ?? null;
      const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
      const fileId = Number(file.lastInsertRowid);
      db.prepare('UPDATE staff SET photo_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId, staffId);
      audit(req, { action: 'set_photo', entity: 'staff', entityId: staffId, oldValue: { photoFileId: previous }, newValue: { photoFileId: fileId } });
      res.status(201).json({ ok: true, fileId });
    });
  });

  router.get('/my-photo/image', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = req.user.staffId;
    const row = staffId ? getDb().prepare('SELECT photo_file_id FROM staff WHERE id = ?').get(staffId) as { photo_file_id?: number | null } | undefined : undefined;
    if (!streamStoredFile(res, row?.photo_file_id)) res.status(404).json({ error: 'No profile picture on file' });
  });

  router.delete('/my-photo', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = req.user.staffId;
    if (!staffId) return res.status(400).json({ error: 'Your account is not linked to a staff record.' });
    const db = getDb();
    const previous = (db.prepare('SELECT photo_file_id FROM staff WHERE id = ?').get(staffId) as { photo_file_id?: number | null } | undefined)?.photo_file_id ?? null;
    db.prepare('UPDATE staff SET photo_file_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(staffId);
    audit(req, { action: 'clear_photo', entity: 'staff', entityId: staffId, oldValue: { photoFileId: previous } });
    res.json({ ok: true });
  });

  const STAFF_DOC_TYPES = ['CV', 'Qualification', 'Licence', 'Certificate', 'Contract', 'Job description', 'ID', 'Reference', 'Other'];

  /** Add a document to my own file. Always unverified — a claim, until checked. */
  router.post('/my-documents', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = req.user.staffId;
    if (!staffId) return res.status(400).json({ error: 'Your account is not linked to a staff record.' });
    const title = String(req.body.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'A title is required.' });
    const documentType = STAFF_DOC_TYPES.includes(String(req.body.documentType)) ? String(req.body.documentType) : 'Other';
    const db = getDb();
    const r = db.prepare(`INSERT INTO staff_documents (staff_id, document_type, title, file_id, issue_date, expiry_date, verification_status, remarks, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'self', ?)`).run(
      staffId, documentType, title, parseIntNullable(req.body.fileId),
      req.body.issueDate || null, req.body.expiryDate || null, req.body.remarks ?? null, req.user.id);
    audit(req, { action: 'self_create', entity: 'staff_documents', entityId: r.lastInsertRowid, newValue: { staffId, documentType, title } });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  /**
   * Correct a document I added, while it is still mine to correct.
   *
   * Once Personnel Management has verified it, it is evidence: somebody signed
   * their name against that title and those dates, and quietly rewriting them
   * afterwards would make the verification meaningless. From then on a change
   * goes through the register.
   */
  function ownPendingDocument(req: import('express').Request) {
    const staffId = req.user?.staffId;
    if (!staffId) return { error: 'Your account is not linked to a staff record.', status: 400 as const };
    const row = getDb().prepare('SELECT * FROM staff_documents WHERE id = ?').get(req.params.id) as
      { staff_id: number; verification_status: string; source?: string; document_type: string; title: string } | undefined;
    if (!row) return { error: 'Document not found.', status: 404 as const };
    if (Number(row.staff_id) !== Number(staffId)) return { error: 'That document is not on your file.', status: 403 as const };
    if (row.source !== 'self') return { error: 'This document was placed on your file by Personnel Management. Ask them to change it.', status: 403 as const };
    if (row.verification_status === 'verified') return { error: 'This document has been verified and can no longer be changed here. Ask Personnel Management.', status: 403 as const };
    return { row };
  }

  router.put('/my-documents/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const found = ownPendingDocument(req);
    if ('error' in found) return res.status(found.status).json({ error: found.error });
    const db = getDb();
    const documentType = STAFF_DOC_TYPES.includes(String(req.body.documentType)) ? String(req.body.documentType) : found.row.document_type;
    const title = String(req.body.title ?? '').trim() || found.row.title;
    db.prepare(`UPDATE staff_documents SET document_type = ?, title = ?, file_id = COALESCE(?, file_id), issue_date = ?, expiry_date = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(documentType, title, parseIntNullable(req.body.fileId), req.body.issueDate || null, req.body.expiryDate || null, req.body.remarks ?? null, req.params.id);
    audit(req, { action: 'self_edit', entity: 'staff_documents', entityId: Number(req.params.id), oldValue: found.row, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/my-documents/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const found = ownPendingDocument(req);
    if ('error' in found) return res.status(found.status).json({ error: found.error });
    getDb().prepare('DELETE FROM staff_documents WHERE id = ?').run(req.params.id);
    audit(req, { action: 'self_delete', entity: 'staff_documents', entityId: Number(req.params.id), oldValue: found.row });
    res.json({ ok: true });
  });

  /* ---- Training and CPD a member of staff records about themselves ---- */
  const CPD_TYPES = ['external_course', 'conference', 'webinar', 'workshop', 'qualification', 'in_house', 'self_study', 'other'];

  router.get('/my-training', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = req.user.staffId;
    if (!staffId) return res.json([]);
    res.json(getDb().prepare(`SELECT c.*, f.original_name AS file_name, v.full_name AS verified_by_name
      FROM staff_cpd_records c
      LEFT JOIN files f ON f.id = c.file_id
      LEFT JOIN staff v ON v.id = c.verified_by_staff_id
      WHERE c.staff_id = ? ORDER BY COALESCE(c.end_date, c.start_date, c.created_at) DESC, c.id DESC`).all(staffId));
  });

  router.post('/my-training', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = req.user.staffId;
    if (!staffId) return res.status(400).json({ error: 'Your account is not linked to a staff record.' });
    const title = String(req.body.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'What was the training called?' });
    const trainingType = CPD_TYPES.includes(String(req.body.trainingType)) ? String(req.body.trainingType) : 'external_course';
    const hours = req.body.hours === '' || req.body.hours === null || req.body.hours === undefined ? null : Number(req.body.hours);
    const r = getDb().prepare(`INSERT INTO staff_cpd_records (staff_id, title, provider, training_type, start_date, end_date, hours, location, description, file_id, verification_status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'declared', ?)`).run(
      staffId, title, req.body.provider ?? null, trainingType,
      req.body.startDate || null, req.body.endDate || null,
      Number.isFinite(hours) ? hours : null,
      req.body.location ?? null, req.body.description ?? null,
      parseIntNullable(req.body.fileId), req.user.id);
    audit(req, { action: 'self_create', entity: 'staff_cpd_records', entityId: r.lastInsertRowid, newValue: { staffId, title, trainingType } });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  function ownDeclaredTraining(req: import('express').Request) {
    const staffId = req.user?.staffId;
    if (!staffId) return { error: 'Your account is not linked to a staff record.', status: 400 as const };
    const row = getDb().prepare('SELECT * FROM staff_cpd_records WHERE id = ?').get(req.params.id) as { staff_id: number; verification_status: string } | undefined;
    if (!row) return { error: 'Training record not found.', status: 404 as const };
    if (Number(row.staff_id) !== Number(staffId)) return { error: 'That training record is not yours.', status: 403 as const };
    if (row.verification_status === 'verified') return { error: 'This record has been verified and can no longer be changed here. Ask Personnel Management.', status: 403 as const };
    return { row };
  }

  router.put('/my-training/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const found = ownDeclaredTraining(req);
    if ('error' in found) return res.status(found.status).json({ error: found.error });
    const prev = found.row as Record<string, unknown>;
    const trainingType = CPD_TYPES.includes(String(req.body.trainingType)) ? String(req.body.trainingType) : String(prev.training_type);
    const title = String(req.body.title ?? '').trim() || String(prev.title);
    const hours = req.body.hours === '' || req.body.hours === null || req.body.hours === undefined ? null : Number(req.body.hours);
    getDb().prepare(`UPDATE staff_cpd_records SET title = ?, provider = ?, training_type = ?, start_date = ?, end_date = ?, hours = ?, location = ?, description = ?, file_id = COALESCE(?, file_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(title, req.body.provider ?? null, trainingType, req.body.startDate || null, req.body.endDate || null,
        Number.isFinite(hours) ? hours : null, req.body.location ?? null, req.body.description ?? null,
        parseIntNullable(req.body.fileId), req.params.id);
    audit(req, { action: 'self_edit', entity: 'staff_cpd_records', entityId: Number(req.params.id), oldValue: prev, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/my-training/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const found = ownDeclaredTraining(req);
    if ('error' in found) return res.status(found.status).json({ error: found.error });
    getDb().prepare('DELETE FROM staff_cpd_records WHERE id = ?').run(req.params.id);
    audit(req, { action: 'self_delete', entity: 'staff_cpd_records', entityId: Number(req.params.id), oldValue: found.row });
    res.json({ ok: true });
  });

  /* ──────────────────────────────────────────────────────────────────────
   * Master Personnel Register — Excel import / export (Settings → People & Access)
   * ──────────────────────────────────────────────────────────────────────── */
  function buildRegisterRows() {
    const db = getDb();
    const staff = db.prepare(`SELECT s.*, sec.name AS section_name,
        (SELECT p.title FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id
         WHERE spa.staff_id = s.id AND spa.is_active = 1 ORDER BY spa.id DESC LIMIT 1) AS position_title
      FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id ORDER BY s.employee_no, s.full_name`).all() as any[];
    return staff.map(s => [
      s.employee_no || '', s.surname || '', s.middle_name || '', s.first_name || '', s.initials || '',
      s.date_of_birth || '', s.gender || '', s.designation || '', s.job_title || s.position_title || '',
      s.professional_regulator || '', s.professional_licence || '', s.qualifications || '',
      s.unit || s.section_name || '', s.personnel_category || '', s.appointment_type || '', s.appointment_date || '',
      s.national_id_type || '', s.national_id_number || '', s.emergency_contact || '', s.phone || '',
      s.email || '', s.staff_file_location || '',
    ]);
  }

  function registerWorkbook(includeData: boolean) {
    const guide = [
      ['ST. ELIZABETH CATHOLIC HOSPITAL — LABORATORY · MASTER PERSONNEL REGISTER'],
      ['Master Personnel Register import template. Fill one row per staff member.'],
      ['STAFF ID is the unique key — existing rows with the same STAFF ID are updated, new ones are created.'],
      ['Dates may be DD/MM/YYYY or YYYY-MM-DD. PROFESSIONAL QUALIFICATION(S) may list several, separated by " | ".'],
      ['PERSONNEL CATEGORY: STAFF / INTERN / NSS / LOCUM.  APPOINTMENT TYPE: FULL TIME / PART TIME / CONTRACT / INTERN.'],
    ];
    const wb = XLSX.utils.book_new();
    const guideWs = XLSX.utils.aoa_to_sheet(guide);
    XLSX.utils.book_append_sheet(wb, guideWs, 'GUIDE');
    const rows = includeData ? buildRegisterRows() : [];
    const ws = XLSX.utils.aoa_to_sheet([REGISTER_HEADERS as unknown as string[], ...rows]);
    ws['!cols'] = REGISTER_HEADERS.map(h => ({ wch: Math.max(12, Math.min(40, h.length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'MASTER PERSONNEL REGISTER');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  function sendWorkbook(res: any, buf: Buffer, filename: string) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  }

  router.get('/register/template', requirePermission('personnel.register', 'export'), (_req, res) => {
    sendWorkbook(res, registerWorkbook(false), 'Master_Personnel_Register_Template.xlsx');
  });

  router.get('/register/export', requirePermission('personnel.register', 'export'), (_req, res) => {
    sendWorkbook(res, registerWorkbook(true), 'Master_Personnel_Register.xlsx');
  });

  router.post('/register/import', requirePermission('personnel.register', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Master Personnel Register .xlsx file.' });
    let rows: Record<string, unknown>[];
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames.find(n => n.trim().toUpperCase().includes('MASTER PERSONNEL REGISTER'))
        || wb.SheetNames.find(n => n.trim().toUpperCase().includes('REGISTER')) || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false });
    } catch (err) {
      return res.status(400).json({ error: `Could not read the workbook: ${err instanceof Error ? err.message : String(err)}` });
    }
    const db = getDb();
    const sections = db.prepare('SELECT id, name FROM sections').all() as Array<{ id: number; name: string }>;
    const sectionByName = (name: string | null) => name ? sections.find(s => s.name.trim().toUpperCase() === name.trim().toUpperCase())?.id ?? null : null;

    let created = 0, updated = 0; const errors: string[] = [];
    const upsert = db.transaction((records: Record<string, unknown>[]) => {
      records.forEach((row, i) => {
        const employeeNo = pick(row, 'STAFF ID', 'STAFF_ID', 'EMPLOYEE NO', 'EMPLOYEE_NO');
        const surname = pick(row, 'SURNAME', 'LAST NAME');
        const firstName = pick(row, 'FIRSTNAME(S)', 'FIRSTNAME', 'FIRST NAME', 'FIRST NAME(S)');
        const middleName = pick(row, 'MIDDLE NAME(S)', 'MIDDLE NAME', 'MIDDLE NAMES');
        if (!surname && !firstName && !employeeNo) return; // skip blank rows silently
        const fullName = [firstName, middleName, surname].filter(Boolean).join(' ').trim();
        if (!fullName) { errors.push(`Row ${i + 2}: missing name.`); return; }
        const unit = pick(row, 'UNIT', 'DEPARTMENT', 'SECTION');
        const cols: Record<string, string | number | null> = {
          employee_no: employeeNo, surname, middle_name: middleName, first_name: firstName, full_name: fullName,
          initials: pick(row, 'INITIALS') || [firstName, middleName, surname].map(p => p ? p[0] : '').join('').toUpperCase() || null,
          date_of_birth: pick(row, 'DATE OF BIRTH', 'DOB'), gender: pick(row, 'GENDER'),
          designation: pick(row, 'DESIGNATION'), job_title: pick(row, 'POSITION', 'JOB TITLE'),
          professional_regulator: pick(row, 'PROFESSIONAL REGULATOR', 'PRFOFESSIONAL REGULATOR', 'REGULATOR', 'PROFESSIONAL REGULATORY BODY'),
          professional_licence: pick(row, 'PROFESSIONAL LICENCE', 'PROFESSIONAL LICENSE', 'LICENCE'),
          qualifications: (() => {
            // The register spreads several qualifications across the columns
            // after "PROFESSIONAL QUALIFICATION(S)" (blank headers → __EMPTY*).
            // Merge them into one " | "-joined cell.
            const parts: string[] = [];
            const main = pick(row, 'PROFESSIONAL QUALIFICATION(S)', 'QUALIFICATIONS', 'QUALIFICATION');
            if (main) parts.push(main);
            for (const k of Object.keys(row)) {
              if (/^__EMPTY/.test(k)) {
                const v = String(row[k] ?? '').trim();
                if (v && !/^\d+$/.test(v) && v.length > 2) parts.push(v);
              }
            }
            return parts.length ? Array.from(new Set(parts)).join(' | ') : null;
          })(),
          unit, personnel_category: pick(row, 'PERSONNEL CATEGORY', 'CATEGORY'),
          appointment_type: pick(row, 'APPOINTMENT TYPE'), appointment_date: pick(row, 'DATE OF APPOINTMENT', 'APPOINTMENT DATE'),
          national_id_type: pick(row, 'TYPE OF NATIONAL ID', 'NATIONAL ID TYPE'),
          national_id_number: pick(row, 'NATIONAL ID NUM', 'NATIONAL ID NUMBER', 'NATIONAL ID'),
          emergency_contact: pick(row, 'EMERGENCY CONTACT'), phone: pick(row, 'CONTACT PHONE', 'CONTACT_PHONE', 'PHONE'),
          email: pick(row, 'EMAIL ADDRESS', 'EMAIL_ADDRESS', 'EMAIL'), staff_file_location: pick(row, 'STAFF FILE LOCATION', 'STAFF_FILE_LOCATION', 'FILE LOCATION'),
          section_id: sectionByName(unit),
        };
        const existing = employeeNo ? db.prepare('SELECT id FROM staff WHERE employee_no = ?').get(employeeNo) as { id: number } | undefined : undefined;
        try {
          if (existing) {
            const keys = Object.keys(cols).filter(k => cols[k] !== null);
            if (keys.length) db.prepare(`UPDATE staff SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...keys.map(k => cols[k]), existing.id);
            updated++;
          } else {
            const keys = Object.keys(cols);
            db.prepare(`INSERT INTO staff (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => cols[k]));
            created++;
          }
        } catch (err) {
          errors.push(`Row ${i + 2} (${fullName}): ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    });
    upsert(rows);
    audit(req, { action: 'import', entity: 'staff', newValue: { created, updated, errorCount: errors.length } });
    res.json({ ok: true, created, updated, totalRows: rows.length, errors: errors.slice(0, 50) });
  });

  /* ──────────────────────────────────────────────────────────────────────
   * Orientation / Induction tracking.
   * ──────────────────────────────────────────────────────────────────────── */
  router.get('/orientations', requirePermission('personnel.orientation', 'view'), (_req, res) => {
    res.json(getDb().prepare(`SELECT o.*, s.full_name AS staff_name, f.full_name AS facilitator_name,
      (SELECT COUNT(*) FROM staff_orientation_items i WHERE i.orientation_id = o.id) AS item_count,
      (SELECT COUNT(*) FROM staff_orientation_items i WHERE i.orientation_id = o.id AND i.status = 'completed') AS item_done,
      (SELECT COUNT(*) FROM staff_orientation_items i WHERE i.orientation_id = o.id AND i.status = 'not_applicable') AS item_na
      FROM staff_orientations o JOIN staff s ON s.id = o.staff_id
      LEFT JOIN staff f ON f.id = o.facilitator_staff_id ORDER BY o.created_at DESC, o.id DESC`).all());
  });

  router.post('/orientations', requirePermission('personnel.orientation', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const stepCols: Record<string, string> = {};
    for (const step of ORIENTATION_STEPS) stepCols[step] = req.body[step] === 'completed' || req.body[step] === true ? 'completed' : 'pending';
    const r = db.prepare(`INSERT INTO staff_orientations
      (staff_id, hire_date, orientation_start, ${ORIENTATION_STEPS.join(', ')}, facilitator_staff_id, notes, status, created_by)
      VALUES (?, ?, ?, ${ORIENTATION_STEPS.map(() => '?').join(', ')}, ?, ?, ?, ?)`)
      .run(req.body.staffId, req.body.hireDate ?? null, req.body.orientationStart ?? null,
        ...ORIENTATION_STEPS.map(s => stepCols[s]), parseIntNullable(req.body.facilitatorStaffId), req.body.notes ?? null,
        req.body.status ?? 'in_progress', req.user?.id ?? null);
    audit(req, { action: 'create', entity: 'staff_orientations', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });

  router.put('/orientations/:id', requirePermission('personnel.orientation', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM staff_orientations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Orientation record not found' });
    const sets: string[] = []; const vals: unknown[] = [];
    for (const step of ORIENTATION_STEPS) if (step in req.body) { sets.push(`${step} = ?`); vals.push(req.body[step] === 'completed' || req.body[step] === true ? 'completed' : 'pending'); }
    for (const [api, col] of [['hireDate', 'hire_date'], ['orientationStart', 'orientation_start'], ['formCompletedDate', 'form_completed_date'], ['staffSignOff', 'staff_sign_off'], ['facilitatorSignOff', 'facilitator_sign_off'], ['status', 'status'], ['notes', 'notes']] as Array<[string, string]>) {
      if (api in req.body) { sets.push(`${col} = ?`); vals.push(req.body[api] ?? null); }
    }
    if ('facilitatorStaffId' in req.body) { sets.push('facilitator_staff_id = ?'); vals.push(parseIntNullable(req.body.facilitatorStaffId)); }
    // Completion for a framework-based record is driven by its checklist items
    // (recomputed as items are ticked), so leave it alone here. For a legacy
    // record it is derived from the fixed steps.
    if (!(existing as any).framework_id) {
      const merged = { ...(existing as any) };
      for (const step of ORIENTATION_STEPS) if (step in req.body) merged[step] = req.body[step] === 'completed' || req.body[step] === true ? 'completed' : 'pending';
      const allDone = ORIENTATION_STEPS.every(s => merged[s] === 'completed');
      sets.push('orientation_complete = ?'); vals.push(allDone ? 1 : 0);
      if (allDone && (existing as any).status !== 'completed' && !('status' in req.body)) { sets.push('status = ?'); vals.push('completed'); }
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE staff_orientations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    audit(req, { action: 'edit', entity: 'staff_orientations', entityId: Number(req.params.id), oldValue: existing, newValue: req.body });
    res.json({ ok: true });
  });

  // Performance appraisal lives in routes/appraisals.ts — a template, a
  // scored record with self-assessment and moderation, mounted on this same
  // /personnel prefix.

  return router;
}

export { DECLARATION_TYPES, TRAINING_STATUSES, ATTENDANCE_STATUSES, STAFF_DOC_VERIFICATION, ROSTER_STATUSES, DECLARATION_STATUSES };
