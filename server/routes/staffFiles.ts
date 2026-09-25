import { Router } from 'express';
import multer from 'multer';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { canReachPersonalRecord, resolvePermission } from '../services/permissionResolver.js';
import { getCurrentStaffId } from './routeHelpers.js';
import { printSheet, htmlEscape, htmlText, signatureBlock } from '../utils/printLayout.js';
import { fileDataUri, staffSignatureDataUri } from '../services/signatureService.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import path from 'node:path';

/**
 * The staff file.
 *
 * A personnel file is one folder per person holding everything the laboratory
 * keeps about them: the papers they handed in, and the records the system
 * itself produced — induction, training, competence, appraisal, authorisation,
 * declarations and the job description for their post. They were spread across
 * as many screens as there are kinds of record, so nobody could open "the
 * file". These routes assemble it: a register of everybody, and, per person,
 * one list of every document and record with the means to open each one.
 */

type Row = Record<string, any>;

// A signature is a small image kept beside every other uploaded file.
const signatureUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
});

const JOB_DESCRIPTION_TYPE = 'Job Description';

/** The categories a file is grouped by, in the order a paper file is tabbed. */
export const STAFF_FILE_CATEGORIES = [
  'Personal Documents',
  'Job Description',
  'Orientation & Induction',
  'Training',
  'Competency Assessment',
  'Performance Appraisal',
  'Technical Authorization',
  'Declarations',
] as const;

const labelise = (value?: string | null) =>
  value ? String(value).replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase()) : '—';

const dateOnly = (value?: string | null) => (value ? String(value).slice(0, 10) : null);

export function staffFileRoutes() {
  const router = Router();

  /** What the caller may see of somebody else's file, category by category. */
  function visibility(req: any, staffId: number) {
    const userId = req.user!.id;
    const mine = getCurrentStaffId(req);
    const may = (key: string) => canReachPersonalRecord(userId, key, 'view', staffId, mine);
    return {
      documents: true,
      orientation: may('personnel.orientation'),
      training: may('personnel.training'),
      competency: may('personnel.training'),
      appraisals: may('personnel.appraisals'),
      authorizations: may('personnel.authorizations'),
      declarations: may('personnel.declarations'),
    };
  }

  /**
   * Which records the caller may actually open. Reading a record is the right
   * that serves it: a stored file comes from the file store, a job description
   * from the document library, and every printed sheet from the print right on
   * the register the record belongs to. A row nobody may open is still listed —
   * the file says what it holds — but it is not offered as a link.
   */
  function openable(req: any, staffId: number) {
    const userId = req.user!.id;
    const mine = getCurrentStaffId(req);
    const mayPrint = (key: string) => canReachPersonalRecord(userId, key, 'print', staffId, mine);
    return {
      file: resolvePermission(userId, 'documents', 'view').allowed,
      document: resolvePermission(userId, 'documents.library', 'view').allowed,
      register: mayPrint('personnel.register'),
      training: mayPrint('personnel.training'),
      appraisals: mayPrint('personnel.appraisals'),
    };
  }

  function loadStaff(staffId: number): Row | undefined {
    return getDb().prepare(`SELECT s.*, sec.name AS section_name, dep.name AS department_name
      FROM staff s
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN departments dep ON dep.id = sec.department_id
      WHERE s.id = ?`).get(staffId) as Row | undefined;
  }

  // ============= The register: every member of staff, one row each =========
  router.get('/staff-files', requirePermission('personnel.register', 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT s.id, s.employee_no, s.full_name, s.designation, s.job_title, s.unit,
        s.personnel_category, s.appointment_type, s.appointment_date, s.professional_licence,
        s.licence_expiry_date, s.availability_status, s.is_active, s.staff_file_location,
        sec.name AS section_name,
        (SELECT COUNT(*) FROM staff_documents d WHERE d.staff_id = s.id) AS document_count,
        (SELECT COUNT(*) FROM staff_documents d WHERE d.staff_id = s.id AND d.verification_status = 'pending') AS pending_verification,
        (SELECT COUNT(*) FROM staff_documents d WHERE d.staff_id = s.id AND d.expiry_date IS NOT NULL AND d.expiry_date <> '' AND date(d.expiry_date) < date('now')) AS expired_documents,
        (SELECT COUNT(*) FROM competency_assessments c WHERE c.staff_id = s.id) AS competency_count,
        (SELECT COUNT(*) FROM performance_appraisals a WHERE a.staff_id = s.id) AS appraisal_count,
        (SELECT COUNT(*) FROM training_attendance t WHERE t.staff_id = s.id) AS training_count,
        (SELECT COUNT(*) FROM staff_declarations dc WHERE dc.staff_id = s.id) AS declaration_count,
        (SELECT COUNT(*) FROM technical_authorizations ta WHERE ta.staff_id = s.id AND ta.is_active = 1) AS authorization_count,
        (SELECT COUNT(*) FROM staff_orientations o WHERE o.staff_id = s.id) AS orientation_count,
        (SELECT COUNT(*) FROM documents jd WHERE jd.document_type = ? AND jd.status <> 'obsolete'
           AND (jd.applies_to_staff_id = s.id
             OR jd.applies_to_position_id IN (SELECT spa.position_id FROM staff_position_assignments spa WHERE spa.staff_id = s.id AND spa.is_active = 1))) AS job_description_count
      FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
      ORDER BY s.is_active DESC, s.full_name`).all(JOB_DESCRIPTION_TYPE) as Row[];

    res.json(rows.map(r => ({
      ...r,
      record_count: Number(r.competency_count) + Number(r.appraisal_count) + Number(r.training_count)
        + Number(r.declaration_count) + Number(r.authorization_count) + Number(r.orientation_count)
        + Number(r.job_description_count),
    })));
  });

  // ============= One file: the person, and everything in their folder ======
  router.get('/staff-files/:staffId', requirePermission('personnel.register', 'view'), (req, res) => {
    const db = getDb();
    const staffId = Number(req.params.staffId);
    const staff = loadStaff(staffId);
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });
    const see = visibility(req, staffId);
    const mayOpen = openable(req, staffId);
    const base = `/personnel/staff-files/${staffId}`;
    const items: Row[] = [];

    // -- Papers handed in and held on file -------------------------------
    for (const d of db.prepare(`SELECT sd.*, f.original_name AS file_name, f.mime_type,
        v.full_name AS verified_by_name
      FROM staff_documents sd
      LEFT JOIN files f ON f.id = sd.file_id
      LEFT JOIN staff v ON v.id = sd.verified_by_staff_id
      WHERE sd.staff_id = ? ORDER BY sd.created_at DESC`).all(staffId) as Row[]) {
      items.push({
        key: `staff-document:${d.id}`,
        id: d.id,
        category: 'Personal Documents',
        record_type: d.document_type,
        reference: null,
        title: d.title,
        date: dateOnly(d.issue_date) || dateOnly(d.created_at),
        expiry: dateOnly(d.expiry_date),
        status: d.verification_status,
        source: 'uploaded',
        file_name: d.file_name ?? null,
        detail: d.verified_by_name ? `Verified by ${d.verified_by_name}` : (d.remarks ?? null),
        can_open: d.file_id ? mayOpen.file : mayOpen.register,
        open: d.file_id
          ? { kind: 'file', fileId: Number(d.file_id), fileName: d.file_name, mimeType: d.mime_type }
          : { kind: 'sheet', path: `${base}/records/staff-document/${d.id}/print` },
      });
    }

    // -- The description of the post they hold ---------------------------
    for (const jd of db.prepare(`SELECT d.id, d.document_code, d.title, d.status, d.next_review_date,
        d.current_version_id, d.applies_to_staff_id, v.version_number, v.effective_date,
        p.title AS position_title
      FROM documents d
      LEFT JOIN document_versions v ON v.id = d.current_version_id
      LEFT JOIN positions p ON p.id = d.applies_to_position_id
      WHERE d.document_type = ? AND d.status <> 'obsolete'
        AND (d.applies_to_staff_id = ?
          OR d.applies_to_position_id IN (SELECT spa.position_id FROM staff_position_assignments spa WHERE spa.staff_id = ? AND spa.is_active = 1))
      ORDER BY d.title`).all(JOB_DESCRIPTION_TYPE, staffId, staffId) as Row[]) {
      items.push({
        key: `job-description:${jd.id}`,
        id: jd.id,
        category: 'Job Description',
        record_type: jd.applies_to_staff_id === staffId ? 'Issued by name' : 'Issued for post',
        reference: jd.document_code ?? null,
        title: jd.title,
        date: dateOnly(jd.effective_date),
        expiry: dateOnly(jd.next_review_date),
        status: jd.status,
        source: 'system',
        detail: jd.position_title ? `Post: ${jd.position_title}` : null,
        version: jd.version_number ?? null,
        can_open: mayOpen.document && !!jd.current_version_id,
        open: jd.current_version_id
          ? { kind: 'document', documentId: Number(jd.id), versionId: Number(jd.current_version_id) }
          : { kind: 'document', documentId: Number(jd.id), versionId: 0 },
      });
    }

    // -- Induction ---------------------------------------------------------
    if (see.orientation) {
      for (const o of db.prepare(`SELECT o.*, f.full_name AS facilitator_name,
          (SELECT COUNT(*) FROM staff_orientation_items i WHERE i.orientation_id = o.id) AS item_count,
          (SELECT COUNT(*) FROM staff_orientation_items i WHERE i.orientation_id = o.id AND i.status = 'completed') AS item_done
        FROM staff_orientations o LEFT JOIN staff f ON f.id = o.facilitator_staff_id
        WHERE o.staff_id = ? ORDER BY o.created_at DESC`).all(staffId) as Row[]) {
        items.push({
          key: `orientation:${o.id}`,
          id: o.id,
          category: 'Orientation & Induction',
          record_type: o.framework_title || 'Induction record',
          reference: o.framework_code ?? null,
          title: o.framework_title || 'Orientation & induction',
          date: dateOnly(o.orientation_start) || dateOnly(o.hire_date) || dateOnly(o.created_at),
          expiry: null,
          status: o.status,
          source: 'system',
          detail: o.facilitator_name ? `Facilitator: ${o.facilitator_name}` : null,
          can_open: mayOpen.register,
          open: { kind: 'sheet', path: `${base}/records/orientation/${o.id}/print` },
        });
      }
    }

    // -- Training attended --------------------------------------------------
    if (see.training) {
      for (const t of db.prepare(`SELECT te.id, te.training_number, te.title, te.training_date, te.status,
          te.location, ta.attendance_status, ta.signed_at, tr.full_name AS trainer_name
        FROM training_attendance ta
        JOIN training_events te ON te.id = ta.training_event_id
        LEFT JOIN staff tr ON tr.id = te.trainer_staff_id
        WHERE ta.staff_id = ? ORDER BY te.training_date DESC`).all(staffId) as Row[]) {
        items.push({
          key: `training:${t.id}`,
          id: t.id,
          category: 'Training',
          record_type: labelise(t.attendance_status),
          reference: t.training_number,
          title: t.title,
          date: dateOnly(t.training_date),
          expiry: null,
          status: t.status,
          source: 'system',
          detail: t.trainer_name ? `Trainer: ${t.trainer_name}` : t.location || null,
          can_open: mayOpen.training,
          open: { kind: 'sheet', path: `/personnel/training/${t.id}/print` },
        });
      }
    }

    // -- Competence ---------------------------------------------------------
    if (see.competency) {
      for (const c of db.prepare(`SELECT c.id, c.competency_number, c.activity, c.assessment_date, c.status,
          c.outcome, c.score_percent, c.next_assessment_due, c.framework_title, a.full_name AS assessor_name
        FROM competency_assessments c LEFT JOIN staff a ON a.id = c.assessor_staff_id
        WHERE c.staff_id = ? ORDER BY c.assessment_date DESC, c.id DESC`).all(staffId) as Row[]) {
        items.push({
          key: `competency:${c.id}`,
          id: c.id,
          category: 'Competency Assessment',
          record_type: c.outcome ? labelise(c.outcome) : 'Assessment',
          reference: c.competency_number,
          title: c.framework_title || c.activity,
          date: dateOnly(c.assessment_date),
          expiry: dateOnly(c.next_assessment_due),
          status: c.status,
          source: 'system',
          detail: [c.assessor_name ? `Assessor: ${c.assessor_name}` : null,
            c.score_percent != null ? `${Math.round(Number(c.score_percent))}%` : null].filter(Boolean).join(' · ') || null,
          can_open: mayOpen.training,
          open: { kind: 'sheet', path: `/personnel/competency/${c.id}/print` },
        });
      }
    }

    // -- Appraisal ----------------------------------------------------------
    if (see.appraisals) {
      for (const a of db.prepare(`SELECT a.id, a.record_number, a.appraisal_date, a.appraisal_type, a.status,
          a.rating_band, a.overall_percent, a.next_appraisal_due, a.template_title, a.period,
          ap.full_name AS appraiser_name
        FROM performance_appraisals a LEFT JOIN staff ap ON ap.id = a.appraiser_staff_id
        WHERE a.staff_id = ? ORDER BY a.appraisal_date DESC, a.id DESC`).all(staffId) as Row[]) {
        items.push({
          key: `appraisal:${a.id}`,
          id: a.id,
          category: 'Performance Appraisal',
          record_type: labelise(a.appraisal_type),
          reference: a.record_number,
          title: a.template_title || `Appraisal ${a.period || ''}`.trim(),
          date: dateOnly(a.appraisal_date),
          expiry: dateOnly(a.next_appraisal_due),
          status: a.status,
          source: 'system',
          detail: [a.appraiser_name ? `Appraiser: ${a.appraiser_name}` : null,
            a.rating_band ? labelise(a.rating_band) : null].filter(Boolean).join(' · ') || null,
          can_open: mayOpen.appraisals,
          open: { kind: 'sheet', path: `/personnel/appraisals/${a.id}/print` },
        });
      }
    }

    // -- What they are authorised to do -------------------------------------
    if (see.authorizations) {
      for (const t of db.prepare(`SELECT t.*, sec.name AS section_name, m.label AS module_label
        FROM technical_authorizations t
        LEFT JOIN sections sec ON sec.id = t.section_id
        LEFT JOIN system_modules m ON m.key = t.module_key
        WHERE t.staff_id = ? ORDER BY t.granted_at DESC`).all(staffId) as Row[]) {
        items.push({
          key: `authorization:${t.id}`,
          id: t.id,
          category: 'Technical Authorization',
          record_type: labelise(t.level),
          reference: `AUTH-${String(t.id).padStart(4, '0')}`,
          title: `${t.module_label || labelise(t.module_key)}${t.section_name ? ` — ${t.section_name}` : ''}`,
          date: dateOnly(t.granted_at),
          expiry: dateOnly(t.expires_at),
          status: t.is_active ? 'active' : 'withdrawn',
          source: 'system',
          detail: t.notes ?? null,
          can_open: mayOpen.register,
          open: { kind: 'sheet', path: `${base}/records/authorization/${t.id}/print` },
        });
      }
    }

    // -- Declarations signed -------------------------------------------------
    if (see.declarations) {
      for (const d of db.prepare(`SELECT d.*, r.full_name AS reviewer_name FROM staff_declarations d
        LEFT JOIN staff r ON r.id = d.reviewed_by_staff_id
        WHERE d.staff_id = ? ORDER BY d.created_at DESC`).all(staffId) as Row[]) {
        items.push({
          key: `declaration:${d.id}`,
          id: d.id,
          category: 'Declarations',
          record_type: labelise(d.declaration_type),
          reference: d.declaration_number,
          title: d.title,
          date: dateOnly(d.form_completed_date) || dateOnly(d.created_at),
          expiry: dateOnly(d.next_review_date),
          status: d.status,
          source: 'system',
          detail: d.reviewer_name ? `Reviewed by ${d.reviewer_name}` : null,
          can_open: mayOpen.register,
          open: { kind: 'sheet', path: `${base}/records/declaration/${d.id}/print` },
        });
      }
      const hasForms = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ethical_declaration_signatures'").get();
      if (hasForms) {
        for (const s of db.prepare(`SELECT sig.id, sig.signed_at, sig.conflict_declared, f.form_number, f.title, f.form_type, f.version
          FROM ethical_declaration_signatures sig
          JOIN ethical_declaration_forms f ON f.id = sig.form_id
          WHERE sig.staff_id = ? ORDER BY sig.signed_at DESC`).all(staffId) as Row[]) {
          items.push({
            key: `ethical-declaration:${s.id}`,
            id: s.id,
            category: 'Declarations',
            record_type: labelise(s.form_type),
            reference: s.form_number,
            title: s.title,
            date: dateOnly(s.signed_at),
            expiry: null,
            status: 'signed',
            source: 'system',
            detail: s.conflict_declared ? 'Conflict declared' : null,
            version: s.version ?? null,
            can_open: mayOpen.register,
            open: { kind: 'sheet', path: `${base}/records/ethical-declaration/${s.id}/print` },
          });
        }
      }
    }

    const positions = db.prepare(`SELECT p.title, spa.assignment_type, spa.is_active
      FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id
      WHERE spa.staff_id = ? ORDER BY spa.is_active DESC, p.title`).all(staffId);

    const counts: Record<string, number> = {};
    for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;

    res.json({
      staff, positions, items, counts, categories: STAFF_FILE_CATEGORIES,
      visibility: see, mayPrintFile: mayOpen.register,
      hasSignature: Boolean(staff.signature_file_id),
    });
  });

  // ============= The signature held for a member of staff ==================
  /*
   * Nothing in this system may be signed by somebody with no signature on file,
   * so Personnel needs a way to set one up for a member of staff who cannot do
   * it themselves — an intern on their first day, somebody without an account
   * yet. It lives on the staff file because that is where the rest of what the
   * laboratory holds about them lives.
   */
  router.post('/staff-files/:staffId/signature', requirePermission('personnel.register', 'edit'),
    signatureUpload.single('file'), (req, res) => {
      const db = getDb();
      const staffId = Number(req.params.staffId);
      const staff = db.prepare('SELECT id, full_name FROM staff WHERE id = ?').get(staffId) as Row | undefined;
      if (!staff) return res.status(404).json({ error: 'Staff record not found' });
      if (!req.file) return res.status(400).json({ error: 'No signature image was uploaded.' });
      if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'The signature must be an image.' });
      const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.file.originalname, path.basename(req.file.path), req.file.mimetype, req.file.size, 'uploads', req.user!.id);
      const fileId = Number(file.lastInsertRowid);
      db.prepare('UPDATE staff SET signature_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId, staffId);
      audit(req, { action: 'set_signature', entity: 'staff', entityId: staffId, newValue: { signatureFileId: fileId } });
      res.status(201).json({ ok: true, fileId });
    });

  /*
   * Removing it does not touch anything already signed: a printed record shows
   * the image captured with the signing, not whatever is on the profile today.
   */
  router.delete('/staff-files/:staffId/signature', requirePermission('personnel.register', 'edit'), (req, res) => {
    const db = getDb();
    const staffId = Number(req.params.staffId);
    const staff = db.prepare('SELECT id, signature_file_id FROM staff WHERE id = ?').get(staffId) as Row | undefined;
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });
    db.prepare('UPDATE staff SET signature_file_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(staffId);
    audit(req, { action: 'clear_signature', entity: 'staff', entityId: staffId, oldValue: { signatureFileId: staff.signature_file_id } });
    res.json({ ok: true });
  });

  // ============= Printable sheets for records with no sheet of their own ===
  router.get('/staff-files/:staffId/records/:kind/:id/print', requirePermission('personnel.register', 'print'), (req, res) => {
    const db = getDb();
    const staffId = Number(req.params.staffId);
    const staff = loadStaff(staffId);
    if (!staff) return res.status(404).send('Staff record not found');
    const see = visibility(req, staffId);
    const autoprint = req.query.autoprint !== '0';
    const id = Number(req.params.id);

    const person = `<table class="meta">
      <tr><th>Member of staff</th><td>${htmlEscape(staff.full_name)}</td><th>Staff ID</th><td>${htmlText(staff.employee_no)}</td></tr>
      <tr><th>Designation</th><td>${htmlText(staff.designation)}</td><th>Unit</th><td>${htmlText(staff.unit || staff.section_name)}</td></tr>
    </table>`;

    const rows = (pairs: Array<[string, unknown]>) => `<table class="meta">${pairs
      .map(([label, value]) => `<tr><th>${htmlEscape(label)}</th><td>${htmlText(value)}</td></tr>`).join('')}</table>`;

    if (req.params.kind === 'staff-document') {
      const d = db.prepare(`SELECT sd.*, f.original_name AS file_name, v.full_name AS verified_by_name
        FROM staff_documents sd LEFT JOIN files f ON f.id = sd.file_id LEFT JOIN staff v ON v.id = sd.verified_by_staff_id
        WHERE sd.id = ? AND sd.staff_id = ?`).get(id, staffId) as Row | undefined;
      if (!d) return res.status(404).send('Document not found');
      return res.send(printSheet({
        title: `${d.title} — ${staff.full_name}`,
        documentTitle: 'Staff document record',
        reference: d.document_type,
        referenceLabel: 'Document type',
        autoprint,
        body: `${person}<h2>${htmlEscape(d.title)}</h2>${rows([
          ['Document type', d.document_type], ['Issued', dateOnly(d.issue_date)], ['Expires', dateOnly(d.expiry_date)],
          ['Verification', labelise(d.verification_status)], ['Verified by', d.verified_by_name],
          ['Verified on', dateOnly(d.verified_at)], ['File held', d.file_name], ['Remarks', d.remarks],
        ])}${signatureBlock('Personnel officer')}`,
      }));
    }

    if (req.params.kind === 'authorization') {
      if (!see.authorizations) return res.status(403).send('Permission denied');
      // Who granted it is the user who created the row; the signature that goes
      // on the sheet is that person's own, applied on the date it was granted.
      // Without this the sheet printed an authorisation nobody appeared to have
      // given — a blank rule under "Authorised by" on a record already in force.
      const t = db.prepare(`SELECT t.*, sec.name AS section_name, c.competency_number, m.label AS module_label,
          gs.full_name AS granted_by_name, gs.id AS granted_by_staff_id
        FROM technical_authorizations t
        LEFT JOIN sections sec ON sec.id = t.section_id
        LEFT JOIN competency_assessments c ON c.id = t.competency_assessment_id
        LEFT JOIN system_modules m ON m.key = t.module_key
        LEFT JOIN users u ON u.id = t.created_by
        LEFT JOIN staff gs ON gs.id = u.staff_id
        WHERE t.id = ? AND t.staff_id = ?`).get(id, staffId) as Row | undefined;
      if (!t) return res.status(404).send('Authorization not found');
      return res.send(printSheet({
        title: `Technical authorisation — ${staff.full_name}`,
        documentTitle: 'Technical authorisation',
        reference: `AUTH-${String(t.id).padStart(4, '0')}`,
        autoprint,
        body: `${person}<h2>Authorisation</h2>${rows([
          ['Area of work', t.module_label || labelise(t.module_key)], ['Unit', t.section_name], ['Level', labelise(t.level)],
          ['Granted', dateOnly(t.granted_at)], ['Expires', dateOnly(t.expires_at)],
          ['State', t.is_active ? 'Active' : 'Withdrawn'], ['Based on assessment', t.competency_number],
          ['Granted by', t.granted_by_name], ['Notes', t.notes],
        ])}
        <div class="signatures two">
          ${signatureBlock('Authorised by', t.granted_by_name, dateOnly(t.granted_at),
            t.granted_by_staff_id ? staffSignatureDataUri(Number(t.granted_by_staff_id)) : null)}
          ${signatureBlock('Member of staff — acknowledged', staff.full_name)}
        </div>`,
      }));
    }

    if (req.params.kind === 'orientation') {
      if (!see.orientation) return res.status(403).send('Permission denied');
      const o = db.prepare(`SELECT o.*, f.full_name AS facilitator_name FROM staff_orientations o
        LEFT JOIN staff f ON f.id = o.facilitator_staff_id WHERE o.id = ? AND o.staff_id = ?`).get(id, staffId) as Row | undefined;
      if (!o) return res.status(404).send('Orientation record not found');
      const checklist = db.prepare(`SELECT group_title, item_text, status, completed_at, remarks
        FROM staff_orientation_items WHERE orientation_id = ? ORDER BY display_order, id`).all(id) as Row[];
      const LEGACY_STEPS: Array<[string, string]> = [
        ['welcome_orientation', 'Welcome orientation'], ['safety_training', 'Safety training'],
        ['ethics_training', 'Ethics training'], ['lis_training', 'Information system training'],
        ['equipment_training', 'Equipment training'], ['sop_review', 'Procedure review'],
        ['competency_baseline', 'Baseline competence'], ['department_induction', 'Departmental induction'],
      ];
      const checklistHtml = checklist.length > 0
        ? `<table><thead><tr><th>Group</th><th>Item</th><th>Status</th><th>Completed</th><th>Remarks</th></tr></thead><tbody>
            ${checklist.map(i => `<tr><td>${htmlText(i.group_title)}</td><td>${htmlEscape(i.item_text)}</td>
              <td>${htmlEscape(labelise(i.status))}</td><td>${htmlText(dateOnly(i.completed_at))}</td><td>${htmlText(i.remarks)}</td></tr>`).join('')}
          </tbody></table>`
        : `<table><thead><tr><th>Step</th><th>Status</th></tr></thead><tbody>
            ${LEGACY_STEPS.map(([col, label]) => `<tr><td>${htmlEscape(label)}</td><td>${htmlEscape(labelise(o[col]))}</td></tr>`).join('')}
          </tbody></table>`;
      return res.send(printSheet({
        title: `Orientation & induction — ${staff.full_name}`,
        documentTitle: 'Orientation & induction record',
        reference: o.framework_code ?? null,
        referenceLabel: 'Framework',
        autoprint,
        body: `${person}${rows([
          ['Date of hire', dateOnly(o.hire_date)], ['Induction started', dateOnly(o.orientation_start)],
          ['Facilitator', o.facilitator_name], ['Completed', dateOnly(o.form_completed_date)],
          ['Status', labelise(o.status)], ['Notes', o.notes],
        ])}<h2>Checklist</h2>${checklistHtml}
        <div class="signatures two">
          ${signatureBlock('Facilitator', o.facilitator_name, o.facilitator_sign_off,
            o.facilitator_sign_off && o.facilitator_staff_id ? staffSignatureDataUri(Number(o.facilitator_staff_id)) : null)}
          ${signatureBlock('Member of staff', staff.full_name, o.staff_sign_off,
            o.staff_sign_off ? staffSignatureDataUri(staffId) : null)}
        </div>`,
      }));
    }

    if (req.params.kind === 'declaration') {
      if (!see.declarations) return res.status(403).send('Permission denied');
      const d = db.prepare(`SELECT d.*, r.full_name AS reviewer_name FROM staff_declarations d
        LEFT JOIN staff r ON r.id = d.reviewed_by_staff_id WHERE d.id = ? AND d.staff_id = ?`).get(id, staffId) as Row | undefined;
      if (!d) return res.status(404).send('Declaration not found');
      const tick = (v: unknown) => (v == null ? '—' : v ? 'Yes' : 'No');
      return res.send(printSheet({
        title: `${d.title} — ${staff.full_name}`,
        documentTitle: 'Declaration',
        reference: d.declaration_number,
        autoprint,
        body: `${person}<h2>${htmlEscape(d.title)}</h2>${rows([
          ['Type', labelise(d.declaration_type)], ['Completed', dateOnly(d.form_completed_date)],
          ['Impartiality confirmed', tick(d.impartiality_confirmed)],
          ['Confidentiality confirmed', tick(d.confidentiality_confirmed)],
          ['Code of conduct acknowledged', tick(d.code_of_conduct_ack)],
          ['Conflict of interest', d.conflict_of_interest], ['Reviewed by', d.reviewer_name],
          ['Next review', dateOnly(d.next_review_date)], ['Status', labelise(d.status)],
          ['Notes', d.description],
        ])}
        <div class="signatures two">
          ${signatureBlock('Member of staff', staff.full_name, d.signed_at,
            d.signed_at ? fileDataUri(d.signature_file_id) ?? staffSignatureDataUri(staffId) : null)}
          ${signatureBlock('Reviewed by', d.reviewer_name, dateOnly(d.review_date),
            d.review_date && d.reviewed_by_staff_id ? staffSignatureDataUri(Number(d.reviewed_by_staff_id)) : null)}
        </div>`,
      }));
    }

    if (req.params.kind === 'ethical-declaration') {
      if (!see.declarations) return res.status(403).send('Permission denied');
      const s = db.prepare(`SELECT sig.*, f.form_number, f.title, f.form_type, f.version, f.acknowledgement_statement, f.body_content
        FROM ethical_declaration_signatures sig JOIN ethical_declaration_forms f ON f.id = sig.form_id
        WHERE sig.id = ? AND sig.staff_id = ?`).get(id, staffId) as Row | undefined;
      if (!s) return res.status(404).send('Declaration not found');
      return res.send(printSheet({
        title: `${s.title} — ${staff.full_name}`,
        documentTitle: 'Signed declaration',
        reference: s.form_number,
        autoprint,
        body: `${person}<h2>${htmlEscape(s.title)}</h2>${rows([
          ['Type', labelise(s.form_type)], ['Version', s.version], ['Signed', dateOnly(s.signed_at)],
          ['Conflict declared', s.conflict_declared ? 'Yes' : 'No'], ['Conflict details', s.conflict_details],
        ])}${s.body_content ? `<h2>Declaration</h2><p>${htmlText(s.body_content)}</p>` : ''}
        ${s.affirmation_text ? `<p>${htmlText(s.affirmation_text)}</p>` : ''}
        <div class="signatures two">
          ${signatureBlock('Member of staff', staff.full_name, s.signed_at,
            s.signed_at ? staffSignatureDataUri(staffId) : null)}
        </div>`,
      }));
    }

    return res.status(404).send('Unknown record type');
  });

  // ============= The file's own cover sheet ================================
  router.get('/staff-files/:staffId/print', requirePermission('personnel.register', 'print'), (req, res) => {
    const db = getDb();
    const staffId = Number(req.params.staffId);
    const staff = loadStaff(staffId);
    if (!staff) return res.status(404).send('Staff record not found');
    const positions = db.prepare(`SELECT p.title FROM staff_position_assignments spa
      JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = ? AND spa.is_active = 1`).all(staffId) as Row[];

    const field = (label: string, value: unknown) => `<tr><th>${htmlEscape(label)}</th><td>${htmlText(value)}</td></tr>`;
    return res.send(printSheet({
      title: `Staff file — ${staff.full_name}`,
      documentTitle: 'Staff file — personal record',
      reference: staff.employee_no ?? null,
      referenceLabel: 'Staff ID',
      autoprint: req.query.autoprint !== '0',
      body: `<h2>Identity</h2><table class="meta">
        ${field('Full name', staff.full_name)}${field('Staff ID', staff.employee_no)}
        ${field('Date of birth', dateOnly(staff.date_of_birth))}${field('Gender', staff.gender)}
        ${field('National ID', [staff.national_id_type, staff.national_id_number].filter(Boolean).join(' — '))}
      </table>
      <h2>Appointment</h2><table class="meta">
        ${field('Designation', staff.designation)}${field('Position', staff.job_title)}
        ${field('Posts held', positions.map(p => p.title).join(', '))}
        ${field('Unit', staff.unit || staff.section_name)}${field('Department', staff.department_name)}
        ${field('Category', staff.personnel_category)}${field('Appointment type', staff.appointment_type)}
        ${field('Date of appointment', dateOnly(staff.appointment_date))}
        ${field('Availability', labelise(staff.availability_status))}
      </table>
      <h2>Professional registration</h2><table class="meta">
        ${field('Regulator', staff.professional_regulator)}${field('Licence number', staff.professional_licence)}
        ${field('Licence expiry', dateOnly(staff.licence_expiry_date))}${field('Qualifications', staff.qualifications)}
        ${field('Cadre', staff.cadre)}${field('Rank', staff.professional_rank)}
      </table>
      <h2>Contact</h2><table class="meta">
        ${field('Phone', staff.phone)}${field('Email', staff.email)}
        ${field('Emergency contact', staff.emergency_contact)}
        ${field('Physical file location', staff.staff_file_location)}
      </table>
      ${signatureBlock('Personnel officer')}`,
    }));
  });

  return router;
}
