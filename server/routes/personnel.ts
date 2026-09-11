import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent, getCurrentStaffId, blockedForNoSignature } from './routeHelpers.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { trainingFileFor } from '../services/trainingRecord.js';
import {
  inviteParticipants, notifyParticipants, raiseNextOccurrence, raiseRemedialTraining,
} from '../services/trainingLifecycle.js';
import {
  recordSignature, SignatureRequiredError, hasSignatureOnFile, staffSignatureDataUri, fileDataUri,
} from '../services/signatureService.js';
import { printSheet, signatureBlock, htmlEscape, htmlText } from '../utils/printLayout.js';
import {
  TRAINING_DELIVERY_MODES, TRAINER_TYPES, TRAINING_CATEGORIES, TRAINING_FORMATS,
  TRAINING_STATUSES as TRAINING_STATUS_LIST, ATTENDANCE_STATUSES as ATTENDANCE_STATUS_LIST,
  TRAINING_OUTCOMES, EFFECTIVENESS_METHODS, EFFECTIVENESS_OUTCOMES, effectivenessDueDate,
  TRAINING_MODES, TRAINING_FREQUENCIES, trainingIsLocked, trainingRecurs, trainingWasHeld,
  attendedInPerson, mayCountersign, recurrenceSummary, trainerDisplayName,
  // The printed report has to name things the way every screen names them, or a
  // laboratory ends up with a sheet that disagrees with the system that made it.
  TRAINING_STATUS_LABELS as TRAINING_STATUS_LABEL_MAP,
  TRAINING_MODE_LABELS as TRAINING_MODE_LABEL_MAP,
  TRAINING_CATEGORY_LABELS as TRAINING_CATEGORY_LABEL_MAP,
  TRAINING_FORMAT_LABELS as TRAINING_FORMAT_LABEL_MAP,
  TRAINING_OUTCOME_LABELS as TRAINING_OUTCOME_LABEL_MAP,
  ATTENDANCE_STATUS_LABELS as ATTENDANCE_STATUS_LABEL_MAP,
  EFFECTIVENESS_METHOD_LABELS as EFFECTIVENESS_METHOD_LABEL_MAP,
  EFFECTIVENESS_OUTCOME_LABELS as EFFECTIVENESS_OUTCOME_LABEL_MAP,
} from '../../shared/constants/training.js';
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
// Both lists now come from shared/constants/training.ts, so the server, the
// browser and an export cannot disagree about what "attended" is called.
const TRAINING_STATUSES: readonly string[] = TRAINING_STATUS_LIST;
const ATTENDANCE_STATUSES: readonly string[] = ATTENDANCE_STATUS_LIST;
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
  /**
   * The training register, as a session that actually has a life.
   *
   * WHAT THIS REPLACES. A training session was a row. It was created, and from
   * then on it was editable for ever by anybody holding the edit right — so an
   * old session could be reopened and quietly rewritten, and there was no moment
   * at which it stopped being a draft and became evidence. None of the work a
   * laboratory really does around training had anywhere to happen.
   *
   * It now runs one way, and each step is its own endpoint rather than a status
   * field somebody sets by hand:
   *
   *   SCHEDULE → the session and everybody expected at it, in one act. The memo
   *              goes out immediately; the notice goes out again when the day
   *              comes. Or POSTPONE it, or CALL IT OFF — both tell the people who
   *              were told the first time.
   *   START    → the session is running, from start time to stop time.
   *   ATTEND   → a senior role or the facilitator marks who came; each person
   *              signs the sheet themselves, exactly as they sign every other
   *              sheet in this system.
   *   CLOSE    → a senior role completes the documentation and signs. That is
   *              the moment the session becomes a record: it lands on every
   *              attendee's file and their portal, the next occurrence of a
   *              recurring session is raised, and anybody the session did not
   *              work for gets an individual session of their own.
   *
   * After closure the record is out of reach. A senior role can still amend it —
   * a laboratory has to be able to correct its own file — but it is a deliberate
   * reopening, it is audited, and it is not on the screen for anybody else.
   *
   * A session also carries two facts that used to be one: who ARRANGED it
   * (internal or external) and who TAUGHT it (a member of staff, or somebody
   * from outside).
   */

  /**
   * Is the caller a senior role for training purposes?
   *
   * Closing a session, reopening a closed one, amending it afterwards and
   * deleting it are the four acts reserved to the people accountable for the
   * training programme — in the shipped access profiles, the System
   * Administrator, the Laboratory Manager and the Quality Manager, who hold
   * `approve` on the training register. A section head, who holds `manage`,
   * runs sessions and records attendance but does not close the file on them.
   *
   * Expressed as the `approve` right rather than a list of role names, so a
   * laboratory that has reorganised its own access profiles gets the behaviour
   * it configured rather than one hard-coded here.
   */
  function isSeniorTrainingRole(req: any): boolean {
    return resolvePermission(req.user!.id, 'personnel.training', 'approve').allowed;
  }

  const TRAINING_SELECT = `SELECT e.*, t.full_name AS trainer_name, sec.name AS section_name,
      eq.name AS equipment_name, eq.equipment_number,
      r.full_name AS effectiveness_reviewer_name, cl.full_name AS closed_by_name,
      cx.full_name AS cancelled_by_name,
      parent.training_number AS series_parent_number,
      cause.training_number AS remedial_for_number,
      rem.full_name AS remedial_for_staff_name,
      (SELECT COUNT(*) FROM training_attendance a WHERE a.training_event_id = e.id) AS invited_count,
      (SELECT COUNT(*) FROM training_attendance a WHERE a.training_event_id = e.id
        AND a.attendance_status IN ('attended','partial')) AS attended_count,
      (SELECT COUNT(*) FROM training_attendance a WHERE a.training_event_id = e.id
        AND a.signed_at IS NOT NULL) AS signed_count
    FROM training_events e
    LEFT JOIN staff t ON t.id = e.trainer_staff_id
    LEFT JOIN sections sec ON sec.id = e.section_id
    LEFT JOIN equipment_items eq ON eq.id = e.equipment_id
    LEFT JOIN staff r ON r.id = e.effectiveness_reviewed_by_staff_id
    LEFT JOIN staff cl ON cl.id = e.closed_by_staff_id
    LEFT JOIN staff cx ON cx.id = e.cancelled_by_staff_id
    LEFT JOIN training_events parent ON parent.id = e.series_parent_id
    LEFT JOIN training_events cause ON cause.id = e.remedial_for_event_id
    LEFT JOIN staff rem ON rem.id = e.remedial_for_staff_id`;

  /**
   * The attendance sheet, as a sheet.
   *
   * Name, the designation held at the time, the signature and the date — the
   * same four things every other signing sheet in this system carries. The
   * designation comes off the attendance row where it was snapshot at signing,
   * falling back to the staff record only for a line nobody has signed yet; a
   * sheet signed three years ago must not silently acquire today's job title.
   */
  const ATTENDANCE_SELECT = `SELECT a.*, s.full_name AS staff_name, s.employee_no,
      COALESCE(a.designation, s.designation, s.job_title) AS sheet_designation,
      sec.name AS section_name, m.full_name AS marked_by_name,
      CASE WHEN s.signature_file_id IS NOT NULL THEN 1 ELSE 0 END AS has_signature_on_file,
      rem.training_number AS remedial_number
    FROM training_attendance a
    JOIN staff s ON s.id = a.staff_id
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN staff m ON m.id = a.marked_by_staff_id
    LEFT JOIN training_events rem ON rem.id = a.remedial_event_id`;

  function loadTrainingEvent(db: any, id: unknown) {
    const event = db.prepare(`${TRAINING_SELECT} WHERE e.id = ?`).get(id) as any;
    if (!event) return null;
    event.attendance = db.prepare(`${ATTENDANCE_SELECT} WHERE a.training_event_id = ? ORDER BY s.full_name`).all(id);
    return event;
  }

  /**
   * Refuse to change a finished record, unless the caller is senior.
   *
   * The single rule the whole lock rests on, in one place so no endpoint can
   * forget it. The refusal says what the state is and who can change it, because
   * "permission denied" on a record somebody can see in front of them is the
   * least helpful thing a system can say.
   */
  function refuseIfFinished(req: any, res: any, event: any, verb: string): boolean {
    if (!trainingIsLocked(event.status)) return false;
    if (isSeniorTrainingRole(req)) return false;
    const what = event.status === 'cancelled' ? 'was called off' : 'has been closed and signed';
    res.status(409).json({
      error: `${event.training_number} ${what}, so it cannot be ${verb}. A closed session is the laboratory's record of `
        + 'the training: only the administrator, the laboratory manager or the quality manager can reopen it.',
      code: 'training_closed',
    });
    return true;
  }

  /**
   * May this caller reach this session's report?
   *
   * A training session is not a personal record with one owner, so
   * canReachPersonalRecord cannot answer it: a session has a whole attendance
   * sheet of owners. Whoever runs the register reaches any session; anybody who
   * was ON one reaches their own, because it is their training record and
   * somebody unable to print evidence of training they sat through goes back to
   * keeping private photocopies.
   */
  function mayReachTrainingReport(req: any, event: any, action: string): boolean {
    if (resolvePermission(req.user!.id, 'personnel.training', action).allowed) return true;
    if (action !== 'view' && action !== 'print') return false;
    const me = getCurrentStaffId(req);
    return me !== null && (event.attendance as any[] ?? []).some(a => Number(a.staff_id) === Number(me));
  }

  /** A session the equipment file owns must be changed where it is owned. */
  function refuseIfEquipmentOwned(res: any, event: any): boolean {
    if (event.source_module !== 'equipment') return false;
    res.status(400).json({
      error: 'This session was recorded against a piece of equipment, so Equipment Management owns it. Change it on the '
        + 'equipment competence record and it will update here.',
    });
    return true;
  }

  const trainingFields = (body: any, existing: any = {}) => {
    const pick = <T>(value: T | undefined, fallback: T) => (value === undefined ? fallback : value);
    const deliveryMode = String(pick(body.deliveryMode, existing.delivery_mode) ?? 'internal');
    const trainerType = String(pick(body.trainerType, existing.trainer_type) ?? 'internal_staff');
    const trainingMode = String(pick(body.trainingMode, existing.training_mode) ?? 'scheduled');
    const frequency = String(pick(body.frequency, existing.frequency) ?? 'none');
    return {
      title: String(pick(body.title, existing.title) ?? '').trim(),
      description: pick(body.description, existing.description) ?? null,
      trainingType: pick(body.trainingType, existing.training_type) ?? null,
      category: pick(body.category, existing.category) ?? null,
      trainingFormat: pick(body.trainingFormat, existing.training_format) ?? null,
      objectives: pick(body.objectives, existing.objectives) ?? null,
      deliveryMode,
      trainerType,
      // Scheduled in advance, or written down afterwards. Stored rather than
      // guessed from the date, because a session planned for last week that
      // nobody closed is outstanding work, while one entered today about last
      // week is a finished record — and a date cannot tell them apart.
      trainingMode,
      frequency,
      frequencyIntervalDays: body.frequencyIntervalDays !== undefined
        ? parseIntNullable(body.frequencyIntervalDays) : (existing.frequency_interval_days ?? null),
      seriesEndsOn: pick(body.seriesEndsOn, existing.series_ends_on) ?? null,
      // A staff trainer and an outside trainer are mutually exclusive on one
      // session, and storing both is how a register ends up showing two
      // trainers for a session that had one. Whichever kind was chosen is
      // kept; the other is cleared.
      trainerStaffId: trainerType === 'external_person' ? null
        : (body.trainerStaffId !== undefined ? parseIntNullable(body.trainerStaffId) : (existing.trainer_staff_id ?? null)),
      externalTrainerName: trainerType === 'external_person'
        ? (pick(body.externalTrainerName, existing.external_trainer_name) ?? null) : null,
      externalTrainerOrganisation: trainerType === 'external_person'
        ? (pick(body.externalTrainerOrganisation, existing.external_trainer_organisation) ?? null) : null,
      externalTrainerQualifications: trainerType === 'external_person'
        ? (pick(body.externalTrainerQualifications, existing.external_trainer_qualifications) ?? null) : null,
      provider: pick(body.provider, existing.provider) ?? null,
      departmentId: body.departmentId !== undefined ? parseIntNullable(body.departmentId) : (existing.department_id ?? null),
      sectionId: body.sectionId !== undefined ? parseIntNullable(body.sectionId) : (existing.section_id ?? null),
      equipmentId: body.equipmentId !== undefined ? parseIntNullable(body.equipmentId) : (existing.equipment_id ?? null),
      documentId: body.documentId !== undefined ? parseIntNullable(body.documentId) : (existing.document_id ?? null),
      trainingDate: String(pick(body.trainingDate, existing.training_date) ?? ''),
      endDate: pick(body.endDate, existing.end_date) ?? null,
      startTime: pick(body.startTime, existing.start_time) ?? null,
      endTime: pick(body.endTime, existing.end_time) ?? null,
      durationHours: body.durationHours !== undefined
        ? (body.durationHours === '' || body.durationHours === null ? null : Number(body.durationHours))
        : (existing.duration_hours ?? null),
      location: pick(body.location, existing.location) ?? null,
      evidenceFileId: body.evidenceFileId !== undefined ? parseIntNullable(body.evidenceFileId) : (existing.evidence_file_id ?? null),
      effectivenessMethod: String(pick(body.effectivenessMethod, existing.effectiveness_method) ?? 'not_required'),
      effectivenessDueDate: pick(body.effectivenessDueDate, existing.effectiveness_due_date) ?? null,
      notes: pick(body.notes, existing.notes) ?? null,
    };
  };

  /** Everything a session has to satisfy before it is worth recording. */
  function validateTraining(v: ReturnType<typeof trainingFields>): string | null {
    if (!v.title) return 'Give the training a title.';
    if (!v.trainingDate) return v.trainingMode === 'retrospective' ? 'When was the training held?' : 'When is the training to be held?';
    if (!(TRAINING_MODES as readonly string[]).includes(v.trainingMode)) {
      return `Say whether the session is being scheduled or recorded after the event: ${TRAINING_MODES.join(', ')}.`;
    }
    if (!(TRAINING_DELIVERY_MODES as readonly string[]).includes(v.deliveryMode)) {
      return `Say whether the training was internal or external: ${TRAINING_DELIVERY_MODES.join(', ')}.`;
    }
    if (!(TRAINER_TYPES as readonly string[]).includes(v.trainerType)) {
      return `Say whether the trainer was a member of staff or from outside: ${TRAINER_TYPES.join(', ')}.`;
    }
    // A trainer who is not on the staff register has to be named, or the record
    // says the session had a trainer and cannot say who — which is the gap this
    // whole change exists to close.
    if (v.trainerType === 'external_person' && !String(v.externalTrainerName ?? '').trim()) {
      return 'Name the trainer who came from outside, and the organisation they came from.';
    }
    if (!(TRAINING_FREQUENCIES as readonly string[]).includes(v.frequency)) {
      return `frequency must be one of: ${TRAINING_FREQUENCIES.join(', ')}`;
    }
    // "Every set number of days" with no number is a series that can never
    // produce its next date, which reads as a one-off that claims to recur.
    if (v.frequency === 'custom' && !(Number(v.frequencyIntervalDays) > 0)) {
      return 'Say how many days apart the sessions in the series are.';
    }
    if (v.category && !(TRAINING_CATEGORIES as readonly string[]).includes(String(v.category))) {
      return `category must be one of: ${TRAINING_CATEGORIES.join(', ')}`;
    }
    if (v.trainingFormat && !(TRAINING_FORMATS as readonly string[]).includes(String(v.trainingFormat))) {
      return `trainingFormat must be one of: ${TRAINING_FORMATS.join(', ')}`;
    }
    if (!(EFFECTIVENESS_METHODS as readonly string[]).includes(v.effectivenessMethod)) {
      return `effectivenessMethod must be one of: ${EFFECTIVENESS_METHODS.join(', ')}`;
    }
    if (v.durationHours !== null && (!Number.isFinite(Number(v.durationHours)) || Number(v.durationHours) < 0)) {
      return 'Duration has to be a number of hours.';
    }
    if (v.endDate && v.trainingDate && String(v.endDate) < String(v.trainingDate)) {
      return 'The session cannot finish before it starts.';
    }
    return null;
  }

  router.get('/training', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('e.status = ?'); params.push(String(req.query.status)); }
    if (req.query.mode) { filters.push('e.training_mode = ?'); params.push(String(req.query.mode)); }
    if (req.query.deliveryMode) { filters.push('e.delivery_mode = ?'); params.push(String(req.query.deliveryMode)); }
    if (req.query.category) { filters.push('e.category = ?'); params.push(String(req.query.category)); }
    if (req.query.equipmentId) { filters.push('e.equipment_id = ?'); params.push(Number(req.query.equipmentId)); }
    if (req.query.staffId) {
      filters.push('EXISTS (SELECT 1 FROM training_attendance a WHERE a.training_event_id = e.id AND a.staff_id = ?)');
      params.push(Number(req.query.staffId));
    }
    let query = TRAINING_SELECT;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY e.training_date DESC, e.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  /**
   * Schedule a session, or record one that has already happened.
   *
   * The participants are part of this call rather than something to add
   * afterwards, because training is given to groups and a register where the
   * group is a separate second step is a register full of sessions with nobody
   * on them. Scheduling one tells everybody named, now.
   */
  router.post('/training', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const v = trainingFields(req.body ?? {});
    const problem = validateTraining(v);
    if (problem) return res.status(400).json({ error: problem });

    const createdAt = new Date().toISOString();
    const trainingNumber = generateRecordNumber(db, 'training_events', 'TRN', createdAt, 'training_number');
    // When a follow-up is owed but nobody said by when, the date is worked out
    // rather than left blank: an effectiveness review with no due date is one
    // nothing can ever report as overdue, which is the same as not asking for it.
    const dueDate = v.effectivenessMethod === 'not_required' ? null
      : (v.effectivenessDueDate || effectivenessDueDate(v.trainingDate));
    // A session being scheduled starts as planned and waits for its day. One
    // being written down afterwards has already been held, so it starts with its
    // documentation outstanding and what it needs is the attendance and a
    // signature — not a plan for something that is over.
    const status = v.trainingMode === 'retrospective' ? 'completed' : 'planned';

    const participants: unknown[] = Array.isArray(req.body?.participantStaffIds) ? req.body.participantStaffIds : [];

    const tx = db.transaction(() => {
      const result = db.prepare(`INSERT INTO training_events
          (training_number, title, description, training_type, category, training_format, objectives,
           delivery_mode, trainer_type, trainer_staff_id, external_trainer_name, external_trainer_organisation,
           external_trainer_qualifications, provider, department_id, section_id, equipment_id, document_id,
           training_date, end_date, start_time, end_time, duration_hours, location, evidence_file_id,
           effectiveness_method, effectiveness_due_date, status, training_mode,
           frequency, frequency_interval_days, series_index, series_ends_on,
           held_at, source_module, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'personnel', ?, ?)`)
        .run(trainingNumber, v.title, v.description, v.trainingType, v.category, v.trainingFormat, v.objectives,
          v.deliveryMode, v.trainerType, v.trainerStaffId, v.externalTrainerName, v.externalTrainerOrganisation,
          v.externalTrainerQualifications, v.provider, v.departmentId, v.sectionId, v.equipmentId, v.documentId,
          v.trainingDate, v.endDate, v.startTime, v.endTime, v.durationHours, v.location, v.evidenceFileId,
          v.effectivenessMethod, dueDate, status, v.trainingMode,
          v.frequency, v.frequencyIntervalDays, v.seriesEndsOn,
          v.trainingMode === 'retrospective' ? v.trainingDate : null,
          req.user!.id, createdAt);
      const id = Number(result.lastInsertRowid);
      if (v.evidenceFileId) {
        db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('personnel', 'training_events', String(id), 'documents', 'files', String(v.evidenceFileId), 'Training evidence file');
      }
      const invited = inviteParticipants(db, id, participants as any[], req.user!.id);
      // Only a session still to come has anybody to notify. Sending a memo
      // about a session that finished last month is noise, and noise is what
      // makes people stop reading the ones that matter.
      const told = status === 'planned' ? notifyParticipants(db, id, 'scheduled') : 0;
      return { id, invited, told };
    });
    const out = tx();

    audit(req, { action: 'create', entity: 'training_events', entityId: out.id, newValue: { trainingNumber, ...v, invited: out.invited } });
    res.status(201).json({ id: out.id, trainingNumber, status, invited: out.invited, notified: out.told });
  });

  /**
   * Change a session that is still open.
   *
   * A closed session does not come through here for anybody but a senior role,
   * and that is the whole point: an old session that can be reopened and edited
   * is not a record of anything.
   */
  router.put('/training/:id', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfEquipmentOwned(res, existing)) return;
    if (refuseIfFinished(req, res, existing, 'changed')) return;

    const v = trainingFields(req.body ?? {}, existing);
    const problem = validateTraining(v);
    if (problem) return res.status(400).json({ error: problem });
    const dueDate = v.effectivenessMethod === 'not_required' ? null
      : (v.effectivenessDueDate || effectivenessDueDate(v.trainingDate));

    db.prepare(`UPDATE training_events SET title = ?, description = ?, training_type = ?, category = ?,
        training_format = ?, objectives = ?, delivery_mode = ?, trainer_type = ?, trainer_staff_id = ?,
        external_trainer_name = ?, external_trainer_organisation = ?, external_trainer_qualifications = ?,
        provider = ?, department_id = ?, section_id = ?, equipment_id = ?, document_id = ?,
        training_date = ?, end_date = ?, start_time = ?, end_time = ?, duration_hours = ?, location = ?,
        evidence_file_id = ?, effectiveness_method = ?, effectiveness_due_date = ?,
        training_mode = ?, frequency = ?, frequency_interval_days = ?, series_ends_on = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(v.title, v.description, v.trainingType, v.category, v.trainingFormat, v.objectives,
        v.deliveryMode, v.trainerType, v.trainerStaffId, v.externalTrainerName, v.externalTrainerOrganisation,
        v.externalTrainerQualifications, v.provider, v.departmentId, v.sectionId, v.equipmentId, v.documentId,
        v.trainingDate, v.endDate, v.startTime, v.endTime, v.durationHours, v.location, v.evidenceFileId,
        v.effectivenessMethod, dueDate, v.trainingMode, v.frequency, v.frequencyIntervalDays, v.seriesEndsOn,
        req.params.id);

    // Amending a closed record is a thing a laboratory must be able to do and
    // must never do silently. It is written down as what it is.
    audit(req, {
      action: trainingIsLocked(existing.status) ? 'amend_closed' : 'edit',
      entity: 'training_events', entityId: req.params.id,
      oldValue: { title: existing.title, status: existing.status, trainingDate: existing.training_date },
      newValue: v,
    });
    res.json({ ok: true });
  });

  router.get('/training/:id', requirePermission('personnel.training', 'view'), (req, res) => {
    const event = loadTrainingEvent(getDb(), req.params.id);
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    // The screen hides what the server would refuse, rather than each screen
    // working the rule out for itself and one of them getting it wrong.
    event.locked = trainingIsLocked(event.status);
    event.may_manage_closed = isSeniorTrainingRole(req);
    res.json(event);
  });

  /**
   * Put more people on the list.
   *
   * Bulk, because "a group of people, sometimes a selection, sometimes one" is
   * how training is actually given, and adding a ward's worth of staff one
   * dropdown at a time is why sessions were left with nobody on them. Anybody
   * already on the list keeps their attendance and their signature.
   */
  router.post('/training/:id/participants', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'added to')) return;

    const ids: unknown[] = Array.isArray(req.body?.staffIds) ? req.body.staffIds
      : (req.body?.staffId ? [req.body.staffId] : []);
    if (ids.length === 0) return res.status(400).json({ error: 'Choose at least one member of staff.' });

    const added = inviteParticipants(db, Number(req.params.id), ids as any[], req.user!.id);
    // Only people who have not already been told get a memo, which is what
    // notifyParticipants' own deduplication gives us for free.
    const told = event.status === 'planned' || event.status === 'postponed' ? notifyParticipants(db, Number(req.params.id), 'scheduled') : 0;
    audit(req, { action: 'edit', entity: 'training_events', entityId: req.params.id, newValue: { participantsAdded: added } });
    res.status(201).json({ added, notified: told });
  });

  /**
   * The session has begun.
   *
   * A real start time, not the one on the plan: a session scheduled for 09:00
   * that began at 10:20 because the engineer was late began at 10:20, and the
   * hours that go onto people's files follow the real clock.
   */
  router.post('/training/:id/start', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'started')) return;
    if (event.status === 'in_progress') return res.json({ ok: true, status: 'in_progress' });

    db.prepare(`UPDATE training_events SET status = 'in_progress', opened_at = CURRENT_TIMESTAMP,
        start_time = COALESCE(?, start_time), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body?.startTime ?? null, req.params.id);
    audit(req, { action: 'edit', entity: 'training_events', entityId: req.params.id, oldValue: { status: event.status }, newValue: { status: 'in_progress' } });
    res.json({ ok: true, status: 'in_progress' });
  });

  /**
   * The session is over, and the documentation is outstanding.
   *
   * Separate from closing it, because the facilitator who ran the session is
   * usually not the person who signs it off — and a session that is over but
   * unsigned is exactly the state a training register needs to be able to show.
   */
  router.post('/training/:id/hold', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'ended')) return;

    db.prepare(`UPDATE training_events SET status = 'completed', held_at = COALESCE(held_at, CURRENT_TIMESTAMP),
        end_time = COALESCE(?, end_time), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body?.endTime ?? null, req.params.id);
    audit(req, { action: 'edit', entity: 'training_events', entityId: req.params.id, oldValue: { status: event.status }, newValue: { status: 'completed' } });
    res.json({ ok: true, status: 'completed' });
  });

  /**
   * Put the session off.
   *
   * Not a deletion and not an edit of the date: the register has to be able to
   * say this session was moved, from when, and why — and everybody who was told
   * about the first date has to be told about the second. A session moved
   * silently is worse than one never booked.
   */
  router.post('/training/:id/postpone', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'postponed')) return;
    const newDate = String(req.body?.trainingDate ?? '').slice(0, 10);
    const reason = String(req.body?.reason ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return res.status(400).json({ error: 'Give the new date for the session.' });
    if (!reason) return res.status(400).json({ error: 'Say why the session is being postponed — the people expected at it will be told.' });

    db.prepare(`UPDATE training_events SET training_date = ?,
        postponed_from_date = COALESCE(postponed_from_date, ?), postponement_reason = ?,
        postponed_at = CURRENT_TIMESTAMP, status = 'planned',
        effectiveness_due_date = CASE WHEN effectiveness_method = 'not_required' THEN NULL ELSE ? END,
        reminder_sent_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(newDate, event.training_date, reason, effectivenessDueDate(newDate), req.params.id);
    // Cleared so the notice for the new date can be sent: the old one was about
    // a day that is no longer happening.
    db.prepare("DELETE FROM notifications WHERE record_type IN ('training_events:scheduled','training_events:reminder') AND record_id = ?")
      .run(String(req.params.id));
    const told = notifyParticipants(db, Number(req.params.id), 'postponed');
    notifyParticipants(db, Number(req.params.id), 'scheduled');

    audit(req, { action: 'postpone', entity: 'training_events', entityId: req.params.id, oldValue: { trainingDate: event.training_date }, newValue: { trainingDate: newDate, reason } });
    res.json({ ok: true, status: 'planned', trainingDate: newDate, notified: told });
  });

  /**
   * Call the session off.
   *
   * Kept rather than deleted. "This session was planned and did not happen, for
   * this reason" is a fact a training programme is asked about, and it is gone
   * the moment the row is.
   */
  router.post('/training/:id/cancel', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'called off')) return;
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Say why the session is being called off — the people expected at it will be told.' });

    db.prepare(`UPDATE training_events SET status = 'cancelled', cancellation_reason = ?,
        cancelled_at = CURRENT_TIMESTAMP, cancelled_by_staff_id = ?,
        effectiveness_method = 'not_required', effectiveness_due_date = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reason, getStaffIdOrCurrent(req, null), req.params.id);
    // Nothing is owed about a session that is not happening, so the memo and
    // the reminder are withdrawn rather than left in people's inboxes.
    db.prepare("DELETE FROM notifications WHERE record_type IN ('training_events:scheduled','training_events:reminder') AND record_id = ?")
      .run(String(req.params.id));
    const told = notifyParticipants(db, Number(req.params.id), 'cancelled');

    audit(req, { action: 'cancel', entity: 'training_events', entityId: req.params.id, oldValue: { status: event.status }, newValue: { status: 'cancelled', reason } });
    res.json({ ok: true, status: 'cancelled', notified: told });
  });

  /**
   * Who was there, and what they came away with.
   *
   * Marking somebody present is done BY somebody — the facilitator or a senior
   * role — and that is recorded, because "a supervisor saw them in the room" and
   * "they say they were there" are different claims and an attendance sheet
   * rests on the first.
   *
   * The designation is snapshot here rather than read from the staff record when
   * the sheet is printed. A sheet showing that a Medical Laboratory Technician
   * attended must still say that after their promotion; reading it live would
   * rewrite the history of who was qualified to do what.
   */
  router.post('/training/:id/attendance', requirePermission('personnel.training', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.staffId)) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'marked')) return;
    const status = req.body.attendanceStatus ?? 'invited';
    if (!ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ error: `attendanceStatus must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
    const outcome = String(req.body.outcome ?? 'not_assessed');
    if (!(TRAINING_OUTCOMES as readonly string[]).includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${TRAINING_OUTCOMES.join(', ')}` });
    }
    const person = db.prepare('SELECT id, designation, job_title FROM staff WHERE id = ?').get(req.body.staffId) as any;
    if (!person) return res.status(404).json({ error: 'Staff record not found' });

    // Somebody who was there for the whole session gets the session's own
    // duration unless a different figure was given; somebody who came for part
    // of it has to have their hours stated, because guessing half is fiction.
    const hours = req.body.hours !== undefined && req.body.hours !== ''
      ? Number(req.body.hours)
      : (status === 'attended' ? (event.duration_hours ?? null) : null);
    const score = (key: string) => (req.body[key] === undefined || req.body[key] === '' ? null : Number(req.body[key]));
    const markedBy = getStaffIdOrCurrent(req, null);
    const designation = person.designation || person.job_title || null;

    const existing = db.prepare('SELECT * FROM training_attendance WHERE training_event_id = ? AND staff_id = ?').get(req.params.id, req.body.staffId) as any;
    let id: number;
    if (existing) {
      db.prepare(`UPDATE training_attendance SET attendance_status = ?,
          remarks = COALESCE(?, remarks), outcome = ?, hours = ?, pre_test_score = ?, post_test_score = ?,
          certificate_file_id = COALESCE(?, certificate_file_id),
          designation = COALESCE(designation, ?),
          marked_by_staff_id = CASE WHEN ? IN ('attended','partial') THEN ? ELSE marked_by_staff_id END,
          marked_at = CASE WHEN ? IN ('attended','partial') THEN COALESCE(marked_at, CURRENT_TIMESTAMP) ELSE marked_at END,
          time_in = COALESCE(?, time_in), time_out = COALESCE(?, time_out),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(status, req.body.remarks ?? null, outcome, hours, score('preTestScore'), score('postTestScore'),
          parseIntNullable(req.body.certificateFileId), designation,
          status, markedBy, status, req.body.timeIn ?? null, req.body.timeOut ?? null, existing.id);
      // A signature belongs to a person who was in the room. Marking somebody
      // absent after they had signed would leave a signature attesting to
      // attendance the record denies, so the signature goes with the claim.
      if (!attendedInPerson(status) && existing.signed_at) {
        db.prepare('UPDATE training_attendance SET signed_at = NULL, signature_id = NULL, signature_file_id = NULL WHERE id = ?').run(existing.id);
      }
      id = existing.id;
    } else {
      const result = db.prepare(`INSERT INTO training_attendance
          (training_event_id, staff_id, attendance_status, remarks, outcome, hours,
           pre_test_score, post_test_score, certificate_file_id, designation,
           marked_by_staff_id, marked_at, time_in, time_out, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  CASE WHEN ? IN ('attended','partial') THEN ? ELSE NULL END,
                  CASE WHEN ? IN ('attended','partial') THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?)`)
        .run(req.params.id, req.body.staffId, status, req.body.remarks ?? null, outcome, hours,
          score('preTestScore'), score('postTestScore'), parseIntNullable(req.body.certificateFileId), designation,
          status, markedBy, status, req.body.timeIn ?? null, req.body.timeOut ?? null, req.user!.id);
      id = Number(result.lastInsertRowid);
    }
    audit(req, { action: 'attendance', entity: 'training_attendance', entityId: id, newValue: { trainingEventId: req.params.id, staffId: req.body.staffId, status, outcome } });
    res.status(201).json({ id });
  });

  /**
   * Sign the attendance sheet.
   *
   * The sheet behaves like every other signing sheet in this system: the
   * signature that goes on it is the signer's own signature on file, and
   * somebody with no signature set up is told how to set one up rather than
   * being allowed to leave a typed name where a signature belongs.
   *
   * Two ways in, because both happen in a laboratory:
   *
   *   The person signs for themselves, on their portal or at the screen. That is
   *   the default and the only one that produces an electronic signature.
   *
   *   The session was signed on paper — the sheet went round the bench and came
   *   back with pen on it — and somebody is entering that. It is recorded as
   *   exactly that, with who entered it, and the paper sheet remains the
   *   original. Claiming an electronic signature for it would be a lie.
   */
  router.post('/training/:id/attendance/:attendanceId/sign', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    const row = db.prepare(`SELECT a.*, s.full_name AS staff_name, s.designation, s.job_title
      FROM training_attendance a JOIN staff s ON s.id = a.staff_id
      WHERE a.id = ? AND a.training_event_id = ?`).get(req.params.attendanceId, req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That person is not on this session.' });

    const me = getStaffIdOrCurrent(req, null);
    const onPaper = Boolean(req.body?.onPaper);
    const self = me !== null && Number(me) === Number(row.staff_id);
    // Signing for somebody else is only ever transcribing a paper sheet, and
    // only somebody who runs the register may do it.
    if (!self && !(onPaper && resolvePermission(req.user.id, 'personnel.training', 'edit').allowed)) {
      return res.status(403).json({ error: 'You may only sign the attendance sheet for yourself.' });
    }
    if (!mayCountersign(row.attendance_status)) {
      return res.status(400).json({
        error: `${row.staff_name} is marked as ${row.attendance_status}. Only somebody who was at the session signs for it — `
          + 'mark them present first.',
      });
    }
    if (row.signed_at) return res.json({ ok: true, alreadySigned: true, signedAt: row.signed_at });

    const designation = row.designation || row.job_title || null;
    if (onPaper) {
      db.prepare(`UPDATE training_attendance SET signed_at = CURRENT_TIMESTAMP,
          designation = COALESCE(designation, ?),
          remarks = TRIM(COALESCE(remarks || ' · ', '') || 'Signed on the paper attendance sheet'),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(designation, row.id);
      audit(req, { action: 'sign', entity: 'training_attendance', entityId: row.id, newValue: { onPaper: true, staffId: row.staff_id } });
      return res.json({ ok: true, onPaper: true });
    }

    // Asked before anything is written: a row stamped as signed with no
    // signature behind it is precisely what this check exists to prevent.
    if (!hasSignatureOnFile(me)) {
      return res.status(400).json({
        error: 'You have no signature on file, so you cannot sign the attendance sheet. Add one under My Portal → My Record → '
          + 'Replace signature (or ask Personnel Management to upload it for you), then sign again.',
        code: 'signature_required',
      });
    }
    try {
      const signature = recordSignature(req, {
        moduleKey: 'personnel', recordType: 'training_attendance', recordId: row.id,
        purpose: 'training_attendance',
        meaning: `I attended ${event.training_number ?? 'this training session'} — ${event.title} on ${String(event.training_date).slice(0, 10)}.`,
        staffId: Number(row.staff_id),
      });
      db.prepare(`UPDATE training_attendance SET signed_at = CURRENT_TIMESTAMP, signature_id = ?,
          signature_file_id = (SELECT signature_file_id FROM staff WHERE id = ?),
          designation = COALESCE(designation, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(signature.id, row.staff_id, designation, row.id);
      res.json({ ok: true, signedAt: signature.signedAt, signatureId: signature.id });
    } catch (e) {
      if (e instanceof SignatureRequiredError) return res.status(400).json({ error: e.message, code: e.code });
      throw e;
    }
  });

  router.delete('/training/:id/attendance/:attendanceId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfFinished(req, res, event, 'changed')) return;
    const row = db.prepare('SELECT * FROM training_attendance WHERE id = ? AND training_event_id = ?').get(req.params.attendanceId, req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That person is not on this session.' });
    // Taking a signed line off the sheet would remove evidence somebody gave.
    // They can be marked absent; they cannot be made never to have signed.
    if (row.signed_at) {
      return res.status(409).json({ error: 'That person has signed the attendance sheet, so their line cannot be removed. Change their attendance instead.' });
    }
    db.prepare('DELETE FROM training_attendance WHERE id = ?').run(req.params.attendanceId);
    audit(req, { action: 'delete', entity: 'training_attendance', entityId: req.params.attendanceId, oldValue: row });
    res.json({ ok: true });
  });

  /**
   * Close the session. This is the act that makes it a record.
   *
   * Reserved to the senior roles because of what it does, not as a formality:
   * from here the session is on every attendee's file and their portal, it is
   * out of reach of casual editing, the next occurrence of a recurring session
   * exists, and anybody the session did not work for has an individual session
   * of their own already scheduled.
   *
   * It is signed. A closure carrying a typed name and nothing else is the first
   * thing an assessor challenges, and this system has one way of signing things.
   */
  router.post('/training/:id/close', requirePermission('personnel.training', 'approve'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (event.status === 'closed') return res.status(409).json({ error: `${event.training_number} is already closed.` });
    if (event.status === 'cancelled') return res.status(409).json({ error: `${event.training_number} was called off, so there is nothing to close.` });

    const attendance = db.prepare('SELECT * FROM training_attendance WHERE training_event_id = ?').all(req.params.id) as any[];
    if (attendance.length === 0) {
      return res.status(400).json({ error: 'Nobody is on this session. A training record with no attendance is not evidence of anything.' });
    }
    // Everybody who was expected has to be accounted for. "Invited" on a closed
    // sheet means nobody ever said whether they turned up, which is the gap that
    // makes an attendance sheet worthless.
    const unaccounted = attendance.filter(a => a.attendance_status === 'invited');
    if (unaccounted.length > 0) {
      return res.status(400).json({
        error: `${unaccounted.length} ${unaccounted.length === 1 ? 'person is' : 'people are'} still marked only as invited. `
          + 'Say who came and who did not before closing — a closed sheet has to account for everybody on it.',
        code: 'attendance_incomplete',
      });
    }
    const present = attendance.filter(a => attendedInPerson(a.attendance_status));
    if (present.length === 0) {
      return res.status(400).json({ error: 'Nobody is recorded as having attended. Call the session off instead of closing it.' });
    }
    if (blockedForNoSignature(req, res)) return;

    const summary = String(req.body?.closureSummary ?? '').trim() || null;
    const out = db.transaction(() => {
      let signatureId: number | null = null;
      const signature = recordSignature(req, {
        moduleKey: 'personnel', recordType: 'training_events', recordId: req.params.id,
        purpose: 'training_closure',
        meaning: `I have reviewed ${event.training_number} — ${event.title}, am satisfied the record and the attendance `
          + 'sheet are complete and correct, and close it to the training file of everybody who attended.',
      });
      signatureId = signature.id;

      db.prepare(`UPDATE training_events SET status = 'closed', closed_at = CURRENT_TIMESTAMP,
          closed_by_staff_id = ?, closure_summary = ?, closure_signature_id = ?,
          held_at = COALESCE(held_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(getStaffIdOrCurrent(req, null), summary, signatureId, req.params.id);

      // The hours the session took are attributed to everybody who was there
      // and whose own figure was never entered — the point of recording a
      // duration at all is that it lands on people's files.
      if (event.duration_hours) {
        db.prepare(`UPDATE training_attendance SET hours = ?, updated_at = CURRENT_TIMESTAMP
            WHERE training_event_id = ? AND attendance_status = 'attended' AND hours IS NULL`)
          .run(event.duration_hours, req.params.id);
      }

      const remedial = raiseRemedialTraining(db, Number(req.params.id), { userId: req.user!.id, makeNumber: generateRecordNumber });
      const next = trainingRecurs(event.frequency)
        ? raiseNextOccurrence(db, Number(req.params.id), { userId: req.user!.id, makeNumber: generateRecordNumber })
        : null;
      const told = notifyParticipants(db, Number(req.params.id), 'closed');
      return { signatureId, remedial, next, told };
    })();

    audit(req, {
      action: 'close', entity: 'training_events', entityId: req.params.id,
      oldValue: { status: event.status },
      newValue: { status: 'closed', attended: present.length, remedialRaised: out.remedial.length, nextOccurrence: out.next?.trainingNumber ?? null },
    });
    res.json({
      ok: true, status: 'closed', notified: out.told,
      remedial: out.remedial, nextOccurrence: out.next,
    });
  });

  /**
   * Reopen a closed session.
   *
   * Deliberately not pretty. A laboratory has to be able to correct its own
   * file — a name on the wrong line, an outcome entered against the wrong
   * person — and pretending otherwise just means the correction happens in a
   * spreadsheet nobody can audit. So it is here, it is senior-only, it demands a
   * reason, and it is recorded as a reopening rather than as an edit.
   */
  router.post('/training/:id/reopen', requirePermission('personnel.training', 'approve'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (!trainingIsLocked(event.status)) return res.status(409).json({ error: `${event.training_number} is not closed.` });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Say why this closed record is being reopened. It is recorded against your name.' });

    db.prepare(`UPDATE training_events SET status = 'completed', closed_at = NULL, closed_by_staff_id = NULL,
        closure_signature_id = NULL,
        closure_summary = TRIM(COALESCE(closure_summary || CHAR(10), '') || ?),
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(`Reopened: ${reason}`, req.params.id);
    audit(req, { action: 'reopen', entity: 'training_events', entityId: req.params.id, oldValue: { status: event.status }, newValue: { status: 'completed', reason } });
    res.json({ ok: true, status: 'completed' });
  });

  /**
   * Delete a session.
   *
   * Almost always the wrong thing — a session that did not happen is called off,
   * not deleted, so that the programme can still account for it — so this exists
   * for the one real case, a record created in error, and it is senior-only. A
   * session anybody has signed for is never deleted: that signature is evidence
   * somebody gave.
   */
  router.delete('/training/:id', requirePermission('personnel.training', 'approve'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    if (refuseIfEquipmentOwned(res, event)) return;
    const signed = db.prepare('SELECT COUNT(*) AS n FROM training_attendance WHERE training_event_id = ? AND signed_at IS NOT NULL').get(req.params.id) as any;
    if (Number(signed?.n ?? 0) > 0) {
      return res.status(409).json({
        error: `${event.training_number} has a signed attendance sheet, so it cannot be deleted. Call it off if it is not going ahead.`,
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM notifications WHERE record_type LIKE ? AND record_id = ?').run('training_events:%', String(req.params.id));
      db.prepare('DELETE FROM training_attendance WHERE training_event_id = ?').run(req.params.id);
      db.prepare("DELETE FROM record_links WHERE source_module_key = 'personnel' AND source_record_type = 'training_events' AND source_record_id = ?").run(String(req.params.id));
      db.prepare('DELETE FROM training_events WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'training_events', entityId: req.params.id, oldValue: event });
    res.json({ ok: true });
  });

  /**
   * Did the training work?
   *
   * The question a training register is actually asked at assessment. A session
   * is not finished when it has been held; it is finished when somebody has
   * looked at the work afterwards and said whether it changed. "Not effective"
   * is a real answer and carries retraining with it rather than quietly closing
   * the record — so an outcome of "not effective" for somebody raises their own
   * individual session, exactly as a poor outcome on the day does.
   *
   * For a session that recurs, this is the periodic review: each occurrence is
   * judged in its own right. A one-off is reviewed once and is then done.
   */
  router.post('/training/:id/effectiveness', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM training_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Training event not found' });
    const outcome = String(req.body?.outcome ?? '');
    if (!(EFFECTIVENESS_OUTCOMES as readonly string[]).includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${EFFECTIVENESS_OUTCOMES.join(', ')}` });
    }
    const method = req.body?.method ? String(req.body.method) : event.effectiveness_method;
    if (!(EFFECTIVENESS_METHODS as readonly string[]).includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${EFFECTIVENESS_METHODS.join(', ')}` });
    }
    if (blockedForNoSignature(req, res)) return;
    const staffId = getStaffIdOrCurrent(req, req.body?.reviewedByStaffId);

    const out = db.transaction(() => {
      const signature = recordSignature(req, {
        moduleKey: 'personnel', recordType: 'training_events', recordId: req.params.id,
        purpose: 'training_effectiveness_review',
        meaning: `I have reviewed the effect of ${event.training_number} — ${event.title} by `
          + `${method.replace(/_/g, ' ')} and find it ${outcome.replace(/_/g, ' ')}.`,
        staffId,
      });
      db.prepare(`UPDATE training_events SET effectiveness_method = ?, effectiveness_outcome = ?,
          effectiveness_notes = ?, effectiveness_reviewed_by_staff_id = ?, effectiveness_reviewed_at = CURRENT_TIMESTAMP,
          review_signature_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(method, outcome, req.body?.notes ?? null, staffId, signature.id, req.params.id);

      // Per person as well as per session, so a session that worked for four
      // people and not for the fifth records exactly that.
      const perPerson = Array.isArray(req.body?.perPerson) ? req.body.perPerson : [];
      for (const entry of perPerson) {
        const attendanceId = parseIntNullable(entry?.attendanceId);
        const personOutcome = String(entry?.outcome ?? '');
        if (!attendanceId || !(EFFECTIVENESS_OUTCOMES as readonly string[]).includes(personOutcome)) continue;
        db.prepare(`UPDATE training_attendance SET effectiveness_outcome = ?, effectiveness_notes = ?,
            outcome = CASE WHEN ? = 'not_effective' AND outcome IN ('not_assessed','satisfactory','competent')
              THEN 'needs_further_training' ELSE outcome END,
            updated_at = CURRENT_TIMESTAMP WHERE id = ? AND training_event_id = ?`)
          .run(personOutcome, entry?.notes ?? null, personOutcome, attendanceId, req.params.id);
      }
      // A review that found the training did not work owes the people it did
      // not work for another go, individually. Finding that and doing nothing
      // about it is the failure the review exists to catch.
      const remedial = raiseRemedialTraining(db, Number(req.params.id), { userId: req.user!.id, makeNumber: generateRecordNumber });
      return { signatureId: signature.id, remedial };
    })();

    audit(req, { action: 'review', entity: 'training_events', entityId: req.params.id, newValue: { effectiveness: outcome, method, remedialRaised: out.remedial.length } });
    res.json({ ok: true, remedial: out.remedial });
  });

  /* ══ The training report ═══════════════════════════════════════════════════
     One document, printable, that IS the training record.

     This is what the register could not produce, and it is the reason a
     laboratory that had all of this on the screen still kept a paper file: an
     assessor asks to see the training report for a session, and a training
     report means the session, what it was for, who taught it, what was
     achieved — and the attendance sheet, signed. Printing the session without
     the sheet, or the sheet without the session, produces two documents that
     each prove half of something.

     It is laid out by the same printSheet the competency record and the
     appraisal use, because all three end up in the same staff file and are read
     by the same people.

     `?sheet=blank` prints the attendance sheet with ruled empty lines, which is
     what somebody actually wants the morning of a session: a sheet to carry to
     the bench and have signed by hand, already carrying the session's own
     details and everybody's name and designation.
     ═══════════════════════════════════════════════════════════════════════ */
  router.get('/training/:id/print', (req, res) => {
    if (!req.user) return res.status(401).send('Authentication required');
    const db = getDb();
    const event = loadTrainingEvent(db, req.params.id);
    if (!event) return res.status(404).send('Training event not found');
    if (!mayReachTrainingReport(req, event, 'print')) return res.status(403).send('Permission denied');

    const blank = String(req.query.sheet ?? '') === 'blank';
    const attendance = event.attendance as any[];
    const present = attendance.filter(a => attendedInPerson(a.attendance_status));
    const held = trainingWasHeld(event.status);

    /* The attendance sheet.
       Name, designation, what they came away with, the signature and the date —
       the same shape as every other signing sheet in the system. A signed line
       carries the signature that was actually applied; an unsigned one carries a
       rule to sign on, so the same sheet works on screen and on the bench. */
    const sheetRow = (row: any, index: number) => {
      const signature = blank ? null
        : (row.signed_at ? fileDataUri(row.signature_file_id) ?? staffSignatureDataUri(row.staff_id) : null);
      const signatureCell = signature
        ? `<img class="sig-img" src="${signature}" alt="signature" />`
        : (row.signed_at ? '<small>Signed on the paper sheet</small>' : '');
      return `<tr>
        <td class="tick">${index + 1}</td>
        <td><strong>${htmlEscape(row.staff_name)}</strong>${row.employee_no ? `<br/><small>${htmlEscape(row.employee_no)}</small>` : ''}</td>
        <td>${htmlEscape(row.sheet_designation || '—')}</td>
        <td>${htmlEscape(row.section_name || '—')}</td>
        ${blank ? '<td></td>' : `<td>${htmlEscape(ATTENDANCE_STATUS_LABEL_MAP[row.attendance_status] ?? row.attendance_status)}</td>`}
        ${blank ? '<td></td>' : `<td class="tick">${row.hours ?? '—'}</td>`}
        <td class="sig-cell">${signatureCell}</td>
        <td>${blank || !row.signed_at ? '' : htmlEscape(String(row.signed_at).slice(0, 10))}</td>
      </tr>`;
    };

    // A blank sheet gets spare lines, because the people who turn up to a
    // session are never exactly the people who were invited to it.
    const spareLines = blank
      ? Array.from({ length: 6 }, () => `<tr><td class="tick"></td><td></td><td></td><td></td><td></td><td></td><td class="sig-cell"></td><td></td></tr>`).join('')
      : '';

    const attendanceSheet = `
<h2>Attendance sheet</h2>
<p class="legend">
  Everybody named below was expected at this session. A signature attests that the person signing attended it.
  ${blank ? 'Signatures are taken by hand on this sheet and entered against the session afterwards.'
    : `${present.length} of ${attendance.length} attended; ${attendance.filter(a => a.signed_at).length} have signed.`}
</p>
<table>
  <thead><tr>
    <th style="width:4%" class="tick">#</th>
    <th style="width:21%">Name</th>
    <th style="width:19%">Designation</th>
    <th style="width:13%">Unit / section</th>
    <th style="width:11%">Attendance</th>
    <th style="width:6%" class="tick">Hours</th>
    <th style="width:17%">Signature</th>
    <th style="width:9%">Date</th>
  </tr></thead>
  <tbody>
    ${attendance.map(sheetRow).join('') || '<tr><td colspan="8" class="none">Nobody is on this session.</td></tr>'}
    ${spareLines}
  </tbody>
</table>`;

    if (blank) {
      audit(req, { action: 'print', entity: 'training_events', entityId: req.params.id, newValue: { sheet: 'blank' } });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(printSheet({
        title: `${event.training_number} — Attendance sheet`,
        documentTitle: 'Training attendance sheet',
        reference: event.training_number,
        referenceLabel: 'Training number',
        body: `
<table class="meta">
  <tr><th>Training</th><td colspan="3">${htmlEscape(event.title)}</td></tr>
  <tr><th>Date</th><td>${htmlEscape(event.training_date)}${event.end_date ? ` → ${htmlEscape(event.end_date)}` : ''}</td>
      <th>Time</th><td>${htmlEscape([event.start_time, event.end_time].filter(Boolean).join(' – ') || '—')}</td></tr>
  <tr><th>Trainer</th><td>${htmlEscape(trainerDisplayName(event))}</td>
      <th>Location</th><td>${htmlEscape(event.location || '—')}</td></tr>
  <tr><th>Subject</th><td>${htmlEscape(event.category ? (TRAINING_CATEGORY_LABEL_MAP[event.category] ?? event.category) : '—')}</td>
      <th>Unit / section</th><td>${htmlEscape(event.section_name || 'Whole laboratory')}</td></tr>
</table>
${event.objectives ? `<h2>What the session is meant to achieve</h2><div class="narrative">${htmlText(event.objectives)}</div>` : ''}
${attendanceSheet}
<div class="signatures two">
  ${signatureBlock('Facilitator / trainer', trainerDisplayName(event) === '—' ? null : trainerDisplayName(event))}
  ${signatureBlock('Closed and signed by')}
</div>`,
        autoprint: req.query.autoprint !== '0',
        footerNote: 'Blank attendance sheet — have it signed at the session, then record the attendance against the session.',
      }));
    }

    /* What was achieved, per person. This is the part of a training report that
       an assessor reads for evidence the session did something, and it was
       previously only on a screen, one person at a time. */
    const outcomeRows = present.map(row => `<tr>
      <td><strong>${htmlEscape(row.staff_name)}</strong></td>
      <td>${htmlEscape(row.sheet_designation || '—')}</td>
      <td>${htmlEscape(TRAINING_OUTCOME_LABEL_MAP[row.outcome] ?? row.outcome ?? '—')}</td>
      <td class="tick">${row.pre_test_score ?? '—'}</td>
      <td class="tick">${row.post_test_score ?? '—'}</td>
      <td>${htmlEscape(EFFECTIVENESS_OUTCOME_LABEL_MAP[row.effectiveness_outcome] ?? '—')}</td>
      <td>${htmlEscape(row.remedial_number ? `Individual retraining ${row.remedial_number}` : (row.remarks || '—'))}</td>
    </tr>`).join('');

    const series = recurrenceSummary(event.frequency, event.frequency_interval_days);
    const body = `
<table class="meta">
  <tr><th>Training</th><td colspan="3"><strong>${htmlEscape(event.title)}</strong></td></tr>
  <tr><th>Status</th><td>${htmlEscape(TRAINING_STATUS_LABEL_MAP[event.status] ?? event.status)}</td>
      <th>How it was recorded</th><td>${htmlEscape(TRAINING_MODE_LABEL_MAP[event.training_mode] ?? event.training_mode)}</td></tr>
  <tr><th>Date held</th><td>${htmlEscape(event.training_date)}${event.end_date ? ` → ${htmlEscape(event.end_date)}` : ''}</td>
      <th>Time</th><td>${htmlEscape([event.start_time, event.end_time].filter(Boolean).join(' – ') || '—')}</td></tr>
  <tr><th>Duration</th><td>${event.duration_hours ? `${htmlEscape(event.duration_hours)} hours` : '—'}</td>
      <th>Location</th><td>${htmlEscape(event.location || '—')}</td></tr>
  <tr><th>Subject</th><td>${htmlEscape(event.category ? (TRAINING_CATEGORY_LABEL_MAP[event.category] ?? event.category) : '—')}</td>
      <th>How it was run</th><td>${htmlEscape(event.training_format ? (TRAINING_FORMAT_LABEL_MAP[event.training_format] ?? event.training_format) : '—')}</td></tr>
  <tr><th>Who arranged it</th><td>${event.delivery_mode === 'external' ? 'An outside body' : 'The laboratory'}</td>
      <th>Who taught it</th><td>${htmlEscape(trainerDisplayName(event))}</td></tr>
  ${event.external_trainer_qualifications ? `<tr><th>Trainer's qualification</th><td colspan="3">${htmlEscape(event.external_trainer_qualifications)}</td></tr>` : ''}
  <tr><th>Provider</th><td>${htmlEscape(event.provider || '—')}</td>
      <th>Unit / section</th><td>${htmlEscape(event.section_name || 'Whole laboratory')}</td></tr>
  ${event.equipment_name ? `<tr><th>Equipment</th><td colspan="3">${htmlEscape(`${event.equipment_number ?? ''} ${event.equipment_name}`.trim())}</td></tr>` : ''}
  ${series ? `<tr><th>Recurs</th><td>${htmlEscape(series)}</td><th>Occurrence</th><td>${htmlEscape(event.series_index ?? 1)}${event.series_parent_number ? ` of the series begun by ${htmlEscape(event.series_parent_number)}` : ''}</td></tr>` : ''}
  ${event.postponed_from_date ? `<tr><th>Postponed from</th><td>${htmlEscape(event.postponed_from_date)}</td><th>Reason</th><td>${htmlEscape(event.postponement_reason || '—')}</td></tr>` : ''}
  ${event.remedial_for_number ? `<tr><th>Arising from</th><td colspan="3">Individual retraining for ${htmlEscape(event.remedial_for_staff_name || 'a member of staff')} following ${htmlEscape(event.remedial_for_number)}</td></tr>` : ''}
</table>

<div class="scores">
  <div class="score-box"><div class="label">On the list</div><div class="value">${attendance.length}</div><div class="sub">expected to attend</div></div>
  <div class="score-box"><div class="label">Attended</div><div class="value">${present.length}</div><div class="sub">${attendance.length - present.length} did not</div></div>
  <div class="score-box"><div class="label">Signed the sheet</div><div class="value">${attendance.filter(a => a.signed_at).length}</div><div class="sub">of ${present.length} who attended</div></div>
  <div class="score-box"><div class="label">Training hours</div><div class="value">${event.duration_hours ?? '—'}</div><div class="sub">attributed to each attendee</div></div>
  <div class="score-box"><div class="label">Effect reviewed</div><div class="value" style="font-size:13px">${htmlEscape(EFFECTIVENESS_OUTCOME_LABEL_MAP[event.effectiveness_outcome] ?? 'Not yet reviewed')}</div><div class="sub">${htmlEscape(event.effectiveness_due_date ? `due ${event.effectiveness_due_date}` : 'no review owed')}</div></div>
</div>

<h2>What the session was for</h2>
<div class="narrative">${htmlText(event.objectives)}</div>

${event.description ? `<h2>What it covered</h2><div class="narrative">${htmlText(event.description)}</div>` : ''}

${attendanceSheet}

<h2>What those who attended came away with</h2>
<table>
  <thead><tr>
    <th style="width:20%">Name</th><th style="width:17%">Designation</th><th style="width:15%">Outcome</th>
    <th style="width:7%" class="tick">Pre</th><th style="width:7%" class="tick">Post</th>
    <th style="width:14%">Effect on the work</th><th>Remarks / action</th>
  </tr></thead>
  <tbody>${outcomeRows || '<tr><td colspan="7" class="none">Nobody is recorded as having attended this session.</td></tr>'}</tbody>
</table>

<h2>How the effect of this training ${event.effectiveness_reviewed_at ? 'was' : 'is to be'} judged</h2>
<p class="legend">
  Method: ${htmlEscape(EFFECTIVENESS_METHOD_LABEL_MAP[event.effectiveness_method] ?? event.effectiveness_method)}${event.effectiveness_due_date ? `, by ${htmlEscape(event.effectiveness_due_date)}` : ''}.
  ${series ? 'This session recurs, so its effect is reviewed each time it comes round.' : 'A one-off session, reviewed once.'}
</p>
<div class="narrative">${htmlText(event.effectiveness_notes)}</div>

${event.closure_summary ? `<h2>Closing note</h2><div class="narrative">${htmlText(event.closure_summary)}</div>` : ''}
${event.cancellation_reason ? `<h2>Why the session was called off</h2><div class="narrative">${htmlText(event.cancellation_reason)}</div>` : ''}

<div class="signatures">
  ${signatureBlock('Facilitator / trainer', trainerDisplayName(event) === '—' ? null : trainerDisplayName(event),
    held ? event.held_at ?? event.training_date : null,
    event.trainer_staff_id && held ? staffSignatureDataUri(event.trainer_staff_id) : null)}
  ${signatureBlock('Reviewed and closed by', event.closed_by_name, event.closed_at,
    event.closed_at ? staffSignatureDataUri(event.closed_by_staff_id) : null)}
  ${signatureBlock('Effectiveness reviewed by', event.effectiveness_reviewer_name, event.effectiveness_reviewed_at,
    event.effectiveness_reviewed_at ? staffSignatureDataUri(event.effectiveness_reviewed_by_staff_id) : null)}
</div>`;

    audit(req, { action: 'print', entity: 'training_events', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${event.training_number} — Training report`,
      documentTitle: 'Training report',
      reference: event.training_number,
      referenceLabel: 'Training number',
      body,
      autoprint: req.query.autoprint !== '0',
      footerNote: event.status === 'closed'
        ? 'Closed training record — retain in the training file and in the file of everybody who attended.'
        : 'Training record — NOT YET CLOSED. The documentation is outstanding and this report is provisional.',
    }));
  });

  /**
   * One person's whole training file.
   *
   * Gathered from every place training is recorded — this register, the
   * equipment file, what the person declared themselves, and the competency
   * assessments that prove any of it worked. Where a record was made decides
   * how it is labelled, never whether it is here.
   */
  router.get('/training-record/:staffId', (req, res) => {
    const staffId = Number(req.params.staffId);
    // Your own file is always yours to read. Somebody else's needs the right
    // that opens the register, which is the same test the staff profile uses.
    if (staffId !== Number(req.user?.staffId ?? -1)
      && !resolvePermission(req.user!.id, 'personnel.training', 'view').allowed
      && !resolvePermission(req.user!.id, 'personnel.register', 'view').allowed) {
      return res.status(403).json({ error: 'You may only open your own training file.' });
    }
    const db = getDb();
    const staff = db.prepare('SELECT id, full_name, employee_no FROM staff WHERE id = ?').get(staffId);
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });
    res.json({ staff, ...trainingFileFor(db, staffId) });
  });

  /** The signed-in person's own file, without needing to know their staff id. */
  router.get('/my-training-record', (req, res) => {
    const staffId = Number(req.user?.staffId ?? 0);
    if (!staffId) return res.json({ staff: null, entries: [], summary: null });
    res.json({ staff: null, ...trainingFileFor(getDb(), staffId) });
  });

  /**
   * My sessions, with everything the portal needs to act on them.
   *
   * Separate from the training file, which is a history. This is the live list:
   * what is coming, what was postponed, and — the part the portal could not do
   * at all — which attendance sheets are waiting for this person's signature.
   * Self-scoped, so it needs no register permission.
   */
  router.get('/my-training-sessions', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = Number(req.user.staffId ?? 0);
    if (!staffId) return res.json({ sessions: [], awaitingSignature: 0, hasSignatureOnFile: false });
    const db = getDb();
    const sessions = db.prepare(`SELECT e.id, e.training_number, e.title, e.description, e.category, e.training_format,
        e.delivery_mode, e.trainer_type, e.external_trainer_name, e.external_trainer_organisation, e.provider,
        e.training_date, e.end_date, e.start_time, e.end_time, e.duration_hours, e.location, e.status,
        e.training_mode, e.frequency, e.frequency_interval_days, e.objectives,
        e.postponed_from_date, e.postponement_reason, e.cancellation_reason,
        e.remedial_for_event_id, e.closed_at, e.effectiveness_outcome,
        t.full_name AS trainer_name, sec.name AS section_name,
        eq.name AS equipment_name, eq.equipment_number,
        a.id AS attendance_id, a.attendance_status, a.outcome, a.hours, a.signed_at, a.remarks,
        COALESCE(a.designation, s.designation, s.job_title) AS sheet_designation
      FROM training_attendance a
      JOIN training_events e ON e.id = a.training_event_id
      JOIN staff s ON s.id = a.staff_id
      LEFT JOIN staff t ON t.id = e.trainer_staff_id
      LEFT JOIN sections sec ON sec.id = e.section_id
      LEFT JOIN equipment_items eq ON eq.id = e.equipment_id
      WHERE a.staff_id = ?
      ORDER BY CASE WHEN e.status IN ('planned','in_progress','postponed') THEN 0 ELSE 1 END,
               e.training_date DESC, e.id DESC`).all(staffId) as any[];
    res.json({
      sessions,
      awaitingSignature: sessions.filter(s => attendedInPerson(s.attendance_status) && !s.signed_at).length,
      hasSignatureOnFile: hasSignatureOnFile(staffId),
    });
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
      // Upcoming sessions carry the trainer whichever kind they are, so the
      // portal can say "with the Sysmex engineer" rather than leaving the line
      // blank for every session somebody from outside is giving.
      upcomingTraining: db.prepare(`SELECT te.*, ta.attendance_status, t.full_name AS trainer_name
        FROM training_attendance ta
        JOIN training_events te ON te.id = ta.training_event_id
        LEFT JOIN staff t ON t.id = te.trainer_staff_id
        WHERE ta.staff_id = ? AND te.training_date >= date('now')
          AND te.status IN ('planned', 'in_progress', 'postponed')
        ORDER BY te.training_date`).all(staffId),
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

  /* ---- Job descriptions -------------------------------------------------
   * A job description is a controlled document like any other: written,
   * reviewed, approved, versioned and issued through document control. What
   * makes it different is that it is the one document whose whole purpose is to
   * describe a particular job, so it has somewhere to say which — a position,
   * or occasionally one named person.
   *
   * These two routes are the consequence. Neither holds a copy of anything:
   * both read the document register and return the same rows Document Control
   * would, so a job description is uploaded ONCE and appears in three places —
   * the document library, Personnel Management, and the portal of every person
   * who holds that post. Keeping a second copy on the staff file was the
   * alternative, and it is how a laboratory ends up with two job descriptions
   * that disagree.
   * --------------------------------------------------------------------- */
  const JOB_DESCRIPTION_TYPE = 'Job Description';
  // In force, in document control's own vocabulary: approved and issued as the
  // current version, or current but due for its periodic review. A document due
  // for review is still the one people must follow — it is not withdrawn.
  const JD_IN_FORCE = ['approved', 'current', 'due_review'];

  /** The columns both routes return, so the register and the portal agree. */
  const JD_SELECT = `SELECT d.id, d.document_code, d.title, d.document_type, d.status,
      d.next_review_date, d.applies_to_position_id, d.applies_to_staff_id,
      d.current_version_id, d.updated_at, d.created_at,
      p.title AS position_title, st.full_name AS staff_name,
      v.version_number, v.version_label, v.effective_date, v.file_id,
      f.original_name AS file_name,
      own.full_name AS owner_name
    FROM documents d
    LEFT JOIN positions p ON p.id = d.applies_to_position_id
    LEFT JOIN staff st ON st.id = d.applies_to_staff_id
    LEFT JOIN document_versions v ON v.id = d.current_version_id
    LEFT JOIN files f ON f.id = v.file_id
    LEFT JOIN staff own ON own.id = d.owner_staff_id`;

  /**
   * My job description(s).
   *
   * Matched two ways, in order of specificity: one issued to me by name wins,
   * otherwise the one for each post I actively hold. A person acting up in a
   * second post sees both descriptions, which is the honest answer — they are
   * doing both jobs.
   *
   * Only issued documents are returned. A draft job description is somebody's
   * work in progress, and a member of staff reading their duties from a draft
   * that later changes is worse than reading nothing.
   */
  router.get('/my-job-descriptions', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const staffId = req.user.staffId;
    if (!staffId) return res.json([]);
    const db = getDb();
    const rows = db.prepare(`${JD_SELECT}
      WHERE d.document_type = ?
        AND d.status IN (${JD_IN_FORCE.map(() => '?').join(', ')})
        AND (
          d.applies_to_staff_id = ?
          OR d.applies_to_position_id IN (
            SELECT spa.position_id FROM staff_position_assignments spa
            WHERE spa.staff_id = ? AND spa.is_active = 1
          )
        )
      ORDER BY CASE WHEN d.applies_to_staff_id = ? THEN 0 ELSE 1 END, d.title`)
      .all(JOB_DESCRIPTION_TYPE, ...JD_IN_FORCE, staffId, staffId, staffId);
    res.json(rows);
  });

  /**
   * The register of job descriptions, for Personnel Management.
   *
   * `personnel.register` because this is the whole laboratory's — who has a
   * description on file, which post it covers, and which posts have none. That
   * last one is the question an assessor asks, so a position with no issued
   * description is returned too, as a gap rather than a silence.
   */
  router.get('/job-descriptions', requirePermission('personnel.register', 'view'), (req, res) => {
    const db = getDb();
    const documents = db.prepare(`${JD_SELECT}
      WHERE d.document_type = ? AND d.status != 'obsolete'
      ORDER BY COALESCE(p.title, st.full_name, d.title)`).all(JOB_DESCRIPTION_TYPE) as any[];

    const covered = new Set(documents
      .filter(d => d.applies_to_position_id && JD_IN_FORCE.includes(String(d.status)))
      .map(d => Number(d.applies_to_position_id)));
    const gaps = (db.prepare(`SELECT p.id, p.title,
          (SELECT COUNT(*) FROM staff_position_assignments spa WHERE spa.position_id = p.id AND spa.is_active = 1) AS staff_count
        FROM positions p WHERE p.is_active = 1 ORDER BY p.title`).all() as any[])
      .filter(p => !covered.has(Number(p.id)));

    res.json({ documents, gaps });
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
    // Somebody who went on a course knows who ran it and who taught it. There
    // was nowhere to say so, which meant the one kind of record that always has
    // a real outside trainer behind it was also the one that could not name them.
    const deliveryMode = req.body.deliveryMode === 'internal' ? 'internal' : 'external';
    const r = getDb().prepare(`INSERT INTO staff_cpd_records (staff_id, title, provider, training_type, start_date, end_date, hours, location, description, file_id, verification_status, delivery_mode, trainer_name, category, certificate_reference, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?, ?, ?, ?)`).run(
      staffId, title, req.body.provider ?? null, trainingType,
      req.body.startDate || null, req.body.endDate || null,
      Number.isFinite(hours) ? hours : null,
      req.body.location ?? null, req.body.description ?? null,
      parseIntNullable(req.body.fileId), deliveryMode,
      req.body.trainerName ?? null, req.body.category ?? null, req.body.certificateReference ?? null,
      req.user.id);
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
    const deliveryMode = req.body.deliveryMode === 'internal' ? 'internal'
      : req.body.deliveryMode === 'external' ? 'external' : String(prev.delivery_mode ?? 'external');
    getDb().prepare(`UPDATE staff_cpd_records SET title = ?, provider = ?, training_type = ?, start_date = ?, end_date = ?, hours = ?, location = ?, description = ?, file_id = COALESCE(?, file_id), delivery_mode = ?, trainer_name = ?, category = ?, certificate_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(title, req.body.provider ?? null, trainingType, req.body.startDate || null, req.body.endDate || null,
        Number.isFinite(hours) ? hours : null, req.body.location ?? null, req.body.description ?? null,
        parseIntNullable(req.body.fileId), deliveryMode,
        req.body.trainerName ?? null, req.body.category ?? null, req.body.certificateReference ?? null,
        req.params.id);
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

  router.post('/register/import', requirePermission('personnel.register', 'import'), upload.single('file'), (req, res) => {
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
