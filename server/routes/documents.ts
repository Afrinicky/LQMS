import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const DOCUMENT_STATUSES = ['draft', 'under_review', 'approved', 'current', 'due_review', 'obsolete', 'archived'];
const VERSION_STATUSES = ['draft', 'under_review', 'approved', 'current', 'obsolete'];
const REVIEW_OUTCOMES = ['no_change', 'minor_revision', 'major_revision', 'obsolete'];
const ATTESTATION_STATUSES = ['pending', 'signed', 'overdue', 'waived'];
const DISTRIBUTION_TARGETS = ['staff', 'position', 'section', 'department'];

function addMonths(dateIso: string, months: number): string {
  const d = new Date(dateIso);
  if (isNaN(d.getTime())) return dateIso;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function documentControlRoutes() {
  const router = Router();

  // -------- Reviews due (specific path before /:id) --------
  router.get('/reviews/due', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const horizonDays = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const cutoff = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    res.json(db.prepare(`SELECT id, document_code, title, document_type, status, next_review_date, owner_staff_id FROM documents WHERE next_review_date IS NOT NULL AND next_review_date <= ? AND status != 'obsolete' ORDER BY next_review_date`).all(cutoff));
  });

  router.get('/attestations/pending', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const staffId = parseIntNullable(req.query.staffId);
    const where = staffId ? 'WHERE a.staff_id = ? AND a.status IN (\'pending\',\'overdue\')' : 'WHERE a.status IN (\'pending\',\'overdue\')';
    const params: unknown[] = staffId ? [staffId] : [];
    res.json(db.prepare(`SELECT a.*, d.document_code, d.title, d.document_type, v.version_number FROM document_attestations a JOIN documents d ON d.id = COALESCE(a.document_id, (SELECT document_id FROM document_versions WHERE id = a.document_version_id)) LEFT JOIN document_versions v ON v.id = a.document_version_id ${where} ORDER BY a.due_date NULLS LAST, a.id DESC`).all(...params));
  });

  // -------- Documents CRUD --------
  router.get('/', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.documentType) { filters.push('document_type = ?'); params.push(String(req.query.documentType)); }
    if (req.query.sectionId) { filters.push('section_id = ?'); params.push(Number(req.query.sectionId)); }
    let query = 'SELECT * FROM documents';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('documents', 'create'), (req, res) => {
    if (!req.body.documentCode) return res.status(400).json({ error: 'documentCode is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.documentType) return res.status(400).json({ error: 'documentType is required' });
    const db = getDb();
    const existing = db.prepare('SELECT id FROM documents WHERE document_code = ?').get(req.body.documentCode);
    if (existing) return res.status(400).json({ error: 'documentCode already exists' });
    const reviewFreq = parseIntNullable(req.body.reviewFrequencyMonths);
    const nextReview = req.body.nextReviewDate ?? (reviewFreq ? addMonths(new Date().toISOString(), reviewFreq) : null);
    const status = req.body.status ?? 'draft';
    if (!DOCUMENT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO documents (document_code, title, document_type, department_id, section_id, owner_staff_id, owner_position_id, status, review_frequency_months, next_review_date, access_level, is_controlled, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.documentCode, req.body.title, req.body.documentType, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), parseIntNullable(req.body.ownerStaffId), parseIntNullable(req.body.ownerPositionId), status, reviewFreq, nextReview, req.body.accessLevel ?? 'internal', req.body.isControlled === false ? 0 : 1, req.user!.id);
    const docId = Number(result.lastInsertRowid);

    if (parseIntNullable(req.body.fileId)) {
      const fileId = parseIntNullable(req.body.fileId)!;
      const versionNumber = req.body.versionNumber ?? '1.0';
      const versionResult = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, prepared_by_staff_id, effective_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docId, versionNumber, versionNumber, fileId, req.body.revisionSummary ?? 'Initial version', 'draft', getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.effectiveDate ?? null, req.user!.id);
      const versionId = Number(versionResult.lastInsertRowid);
      db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(versionId, docId);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'documents', String(docId), 'documents', 'files', String(fileId), 'Initial document file');
    }

    audit(req, { action: 'create', entity: 'documents', entityId: docId, newValue: { documentCode: req.body.documentCode, ...req.body } });
    res.status(201).json({ id: docId });
  });

  router.get('/:id', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versions = db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY id DESC').all(req.params.id);
    const reviews = db.prepare('SELECT * FROM document_reviews WHERE document_id = ? ORDER BY review_date DESC, id DESC').all(req.params.id);
    const attestations = db.prepare('SELECT a.*, s.full_name AS staff_name FROM document_attestations a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.document_id = ? OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?) ORDER BY a.id DESC').all(req.params.id, req.params.id);
    const printLogs = db.prepare('SELECT pl.*, s.full_name AS printed_by_name FROM document_print_logs pl LEFT JOIN staff s ON s.id = pl.printed_by_staff_id WHERE pl.document_id = ? ORDER BY pl.print_date DESC, pl.id DESC').all(req.params.id);
    const distribution = db.prepare('SELECT * FROM document_distribution WHERE document_id = ? ORDER BY id DESC').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)').all('documents', 'documents', String(req.params.id), 'documents', 'documents', String(req.params.id));
    res.json({ ...doc, versions, reviews, attestations, printLogs, distribution, links });
  });

  router.put('/:id', requirePermission('documents', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Document not found' });
    if (req.body.status && !DOCUMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${DOCUMENT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE documents SET title = ?, document_type = ?, department_id = ?, section_id = ?, owner_staff_id = ?, owner_position_id = ?, status = ?, review_frequency_months = ?, next_review_date = ?, access_level = ?, is_controlled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.title ?? oldValue.title, req.body.documentType ?? oldValue.document_type, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, parseIntNullable(req.body.ownerStaffId) ?? oldValue.owner_staff_id, parseIntNullable(req.body.ownerPositionId) ?? oldValue.owner_position_id, req.body.status ?? oldValue.status, parseIntNullable(req.body.reviewFrequencyMonths) ?? oldValue.review_frequency_months, req.body.nextReviewDate ?? oldValue.next_review_date, req.body.accessLevel ?? oldValue.access_level, req.body.isControlled !== undefined ? (req.body.isControlled ? 1 : 0) : oldValue.is_controlled, req.params.id);
    audit(req, { action: 'edit', entity: 'documents', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/versions', requirePermission('documents', 'create'), (req, res) => {
    if (!req.body.versionNumber) return res.status(400).json({ error: 'versionNumber is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const status = req.body.status ?? 'draft';
    if (!VERSION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${VERSION_STATUSES.join(', ')}` });
    const result = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, prepared_by_staff_id, effective_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.versionNumber, req.body.versionNumber, parseIntNullable(req.body.fileId), req.body.revisionSummary ?? null, status, getStaffIdOrCurrent(req, req.body.preparedByStaffId), req.body.effectiveDate ?? null, req.user!.id);
    const versionId = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.fileId)) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'document_versions', String(versionId), 'documents', 'files', String(req.body.fileId), `Document version ${req.body.versionNumber}`);
    }
    audit(req, { action: 'create', entity: 'document_versions', entityId: versionId, newValue: { documentId: req.params.id, ...req.body } });
    res.status(201).json({ id: versionId });
  });

  router.post('/:id/submit-review', requirePermission('documents', 'edit'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    db.prepare("UPDATE documents SET status = 'under_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    if (parseIntNullable(req.body.versionId)) {
      db.prepare("UPDATE document_versions SET status = 'under_review' WHERE id = ?").run(req.body.versionId);
    }
    audit(req, { action: 'submit_review', entity: 'documents', entityId: req.params.id, oldValue: { status: doc.status }, newValue: { status: 'under_review' } });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('documents', 'edit'), (req, res) => {
    if (!req.body.reviewOutcome) return res.status(400).json({ error: 'reviewOutcome is required' });
    if (!REVIEW_OUTCOMES.includes(req.body.reviewOutcome)) return res.status(400).json({ error: `reviewOutcome must be one of: ${REVIEW_OUTCOMES.join(', ')}` });
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const nextReview = req.body.nextReviewDate ?? (req.body.reviewOutcome === 'no_change' && doc.review_frequency_months ? addMonths(req.body.reviewDate, doc.review_frequency_months) : null);
    const reviewNumber = generateRecordNumber(db, 'document_reviews', 'DOCREV', new Date().toISOString());
    const result = db.prepare(`INSERT INTO document_reviews (review_number, document_id, document_version_id, review_date, review_outcome, review_notes, next_review_date, reviewed_by_staff_id, action_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reviewNumber, req.params.id, parseIntNullable(req.body.documentVersionId) ?? doc.current_version_id, req.body.reviewDate, req.body.reviewOutcome, req.body.reviewNotes ?? null, nextReview, reviewedBy, req.body.actionRequired ? 1 : 0, req.user!.id);
    const reviewId = Number(result.lastInsertRowid);
    if (nextReview) db.prepare('UPDATE documents SET next_review_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextReview, req.params.id);
    audit(req, { action: 'review', entity: 'documents', entityId: req.params.id, newValue: { reviewId, reviewNumber, ...req.body } });
    res.status(201).json({ id: reviewId, reviewNumber });
  });

  router.post('/:id/approve', requirePermission('documents', 'approve'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const versionId = parseIntNullable(req.body.versionId) ?? doc.current_version_id;
    if (!versionId) return res.status(400).json({ error: 'No version available to approve. Add a version first.' });
    const previousCurrent = db.prepare("SELECT id FROM document_versions WHERE document_id = ? AND status = 'current' AND id != ?").all(req.params.id, versionId) as Array<{ id: number }>;
    for (const v of previousCurrent) {
      db.prepare("UPDATE document_versions SET status = 'obsolete', obsolete_date = CURRENT_TIMESTAMP WHERE id = ?").run(v.id);
    }
    db.prepare("UPDATE document_versions SET status = 'current', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, effective_date = COALESCE(?, effective_date) WHERE id = ?").run(approvedBy, req.body.effectiveDate ?? null, versionId);
    db.prepare("UPDATE documents SET status = 'current', current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(versionId, req.params.id);
    audit(req, { action: 'approve', entity: 'documents', entityId: req.params.id, oldValue: { status: doc.status, currentVersionId: doc.current_version_id }, newValue: { versionId, status: 'current', approvedByStaffId: approvedBy } });
    res.json({ ok: true, versionId });
  });

  router.post('/:id/mark-obsolete', requirePermission('documents', 'approve'), (req, res) => {
    if (!req.body.obsoleteReason) return res.status(400).json({ error: 'obsoleteReason is required' });
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    db.prepare("UPDATE documents SET status = 'obsolete', obsolete_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.body.obsoleteReason, req.params.id);
    db.prepare("UPDATE document_versions SET status = 'obsolete', obsolete_date = CURRENT_TIMESTAMP, obsolete_reason = COALESCE(obsolete_reason, ?) WHERE document_id = ?").run(req.body.obsoleteReason, req.params.id);
    audit(req, { action: 'mark_obsolete', entity: 'documents', entityId: req.params.id, oldValue: { status: doc.status }, newValue: { status: 'obsolete', obsoleteReason: req.body.obsoleteReason } });
    res.json({ ok: true });
  });

  router.post('/:id/assign-attestation', requirePermission('documents', 'edit'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const versionId = parseIntNullable(req.body.documentVersionId) ?? doc.current_version_id;
    if (!versionId) return res.status(400).json({ error: 'document has no version to attest to' });
    const targetStaffIds: number[] = Array.isArray(req.body.staffIds) ? req.body.staffIds.map((n: unknown) => Number(n)).filter((n: number) => isFinite(n)) : [];
    const targetType = req.body.targetType ?? (targetStaffIds.length ? 'staff' : null);
    if (!targetType || !DISTRIBUTION_TARGETS.includes(targetType)) return res.status(400).json({ error: `targetType must be one of: ${DISTRIBUTION_TARGETS.join(', ')}` });
    const assignedBy = getStaffIdOrCurrent(req, req.body.assignedByStaffId);

    let resolvedStaffIds: number[] = targetStaffIds;
    if (targetType === 'position' && parseIntNullable(req.body.positionId)) {
      const rows = db.prepare('SELECT staff_id FROM staff_position_assignments WHERE position_id = ? AND is_active = 1').all(parseIntNullable(req.body.positionId)) as Array<{ staff_id: number }>;
      resolvedStaffIds = rows.map(r => r.staff_id);
    } else if (targetType === 'section' && parseIntNullable(req.body.sectionId)) {
      const rows = db.prepare('SELECT id FROM staff WHERE section_id = ? AND is_active = 1').all(parseIntNullable(req.body.sectionId)) as Array<{ id: number }>;
      resolvedStaffIds = rows.map(r => r.id);
    } else if (targetType === 'department' && parseIntNullable(req.body.departmentId)) {
      const rows = db.prepare('SELECT s.id FROM staff s JOIN sections sec ON sec.id = s.section_id WHERE sec.department_id = ? AND s.is_active = 1').all(parseIntNullable(req.body.departmentId)) as Array<{ id: number }>;
      resolvedStaffIds = rows.map(r => r.id);
    }
    if (!resolvedStaffIds.length) return res.status(400).json({ error: 'No staff resolved for the target.' });

    const dueDate = req.body.dueDate ?? null;
    const created: number[] = [];
    const tx = db.transaction(() => {
      for (const staffId of resolvedStaffIds) {
        const existing = db.prepare("SELECT id FROM document_attestations WHERE document_version_id = ? AND staff_id = ? AND status IN ('pending','overdue')").get(versionId, staffId);
        if (existing) continue;
        const r = db.prepare(`INSERT INTO document_attestations (document_id, document_version_id, staff_id, assigned_by_staff_id, assigned_at, due_date, status, notes) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'pending', ?)`)
          .run(req.params.id, versionId, staffId, assignedBy, dueDate, req.body.notes ?? null);
        const attId = Number(r.lastInsertRowid);
        db.prepare('INSERT INTO document_distribution (document_id, document_version_id, target_type, target_staff_id, assigned_by_staff_id, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(req.params.id, versionId, 'staff', staffId, assignedBy, dueDate, 'pending', req.user!.id);
        db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'documents', String(req.params.id), 'documents', 'document_attestations', String(attId), 'Attestation assignment');
        created.push(attId);
      }
    });
    tx();
    audit(req, { action: 'assign_attestation', entity: 'documents', entityId: req.params.id, newValue: { versionId, targetType, staffCount: created.length, dueDate } });
    res.status(201).json({ ok: true, assigned: created.length, attestationIds: created });
  });

  router.get('/:id/attestations', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT a.*, s.full_name AS staff_name, v.version_number FROM document_attestations a LEFT JOIN staff s ON s.id = a.staff_id LEFT JOIN document_versions v ON v.id = a.document_version_id WHERE a.document_id = ? OR a.document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?) ORDER BY a.id DESC').all(req.params.id, req.params.id));
  });

  router.post('/:id/attest', requirePermission('documents', 'view'), (req, res) => {
    const db = getDb();
    const attestationId = parseIntNullable(req.body.attestationId);
    const staffId = getStaffIdOrCurrent(req, req.body.staffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    let attestation: any;
    if (attestationId) {
      attestation = db.prepare('SELECT * FROM document_attestations WHERE id = ?').get(attestationId);
    } else {
      attestation = db.prepare("SELECT * FROM document_attestations WHERE (document_id = ? OR document_version_id IN (SELECT id FROM document_versions WHERE document_id = ?)) AND staff_id = ? AND status IN ('pending','overdue') ORDER BY id DESC LIMIT 1").get(req.params.id, req.params.id, staffId);
    }
    if (!attestation) return res.status(404).json({ error: 'No pending attestation found for this staff/document' });
    db.prepare("UPDATE document_attestations SET status = 'signed', attested_at = CURRENT_TIMESTAMP, signature_file_id = ?, notes = COALESCE(?, notes) WHERE id = ?")
      .run(parseIntNullable(req.body.signatureFileId), req.body.notes ?? null, attestation.id);
    db.prepare("UPDATE document_distribution SET status = 'completed' WHERE document_id = ? AND target_staff_id = ? AND status = 'pending'").run(req.params.id, staffId);
    audit(req, { action: 'attest_sign', entity: 'document_attestations', entityId: attestation.id, oldValue: { status: attestation.status }, newValue: { status: 'signed', staffId } });
    res.json({ ok: true, attestationId: attestation.id });
  });

  router.post('/:id/print-log', requirePermission('documents', 'print'), (req, res) => {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const printedBy = getStaffIdOrCurrent(req, req.body.printedByStaffId);
    const result = db.prepare(`INSERT INTO document_print_logs (document_id, document_version_id, printed_by_staff_id, print_date, print_purpose, controlled_copy, copy_number, watermark, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, parseIntNullable(req.body.documentVersionId) ?? doc.current_version_id, printedBy, req.body.printDate ?? new Date().toISOString(), req.body.printPurpose ?? null, req.body.controlledCopy ? 1 : 0, req.body.copyNumber ?? null, req.body.watermark ?? null, req.user!.id);
    const printId = Number(result.lastInsertRowid);
    audit(req, { action: 'print', entity: 'documents', entityId: req.params.id, newValue: { printId, ...req.body } });
    res.status(201).json({ id: printId });
  });

  return router;
}

export { DOCUMENT_STATUSES, VERSION_STATUSES, REVIEW_OUTCOMES, ATTESTATION_STATUSES, DISTRIBUTION_TARGETS };
