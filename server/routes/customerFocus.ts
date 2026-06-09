import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const STAKEHOLDER_TYPES = ['internal_unit', 'clinician', 'patient_or_family', 'organisation', 'public_partner', 'supplier', 'other'];
const AGREEMENT_STATUSES = ['draft', 'active', 'under_review', 'archived', 'expired'];
const FEEDBACK_TYPES = ['compliment', 'concern', 'suggestion', 'enquiry', 'request', 'other'];
const FEEDBACK_STATUSES = ['new', 'acknowledged', 'in_progress', 'escalated', 'resolved', 'closed'];
const URGENCY = ['low', 'medium', 'high', 'critical'];
const SURVEY_TYPES = ['clinician_satisfaction', 'patient_satisfaction', 'internal_unit', 'partner', 'other'];
const SURVEY_STATUSES = ['draft', 'active', 'closed', 'archived'];
const QUESTION_TYPES = ['scale', 'multiple_choice', 'short_text', 'long_text', 'yes_no'];
const COMMUNICATION_TYPES = ['acknowledgement', 'update', 'meeting', 'newsletter', 'follow_up', 'other'];
const COMMUNICATION_DIRECTIONS = ['inbound', 'outbound'];
const COMMUNICATION_STATUSES = ['open', 'in_progress', 'closed'];
const IMPORT_TYPES = ['feedback', 'survey_responses', 'stakeholders', 'other'];

const uploadInstance = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname))
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

function parseCsvBody(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let row: string[] = []; let cell = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r') {}
      else if (ch === '\n') { row.push(cell); cell = ''; out.push(row); row = []; }
      else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); out.push(row); }
  const non = out.filter(r => r.some(c => c.trim() !== ''));
  if (non.length === 0) return [];
  const headers = non[0].map(h => h.trim());
  return non.slice(1).map(r => { const o: Record<string, string> = {}; headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); }); return o; });
}

function pickField(row: Record<string, string>, ...keys: string[]) {
  for (const k of keys) {
    for (const h of Object.keys(row)) {
      if (h.toLowerCase().replace(/[^a-z0-9]+/g, '') === k.toLowerCase().replace(/[^a-z0-9]+/g, '')) return row[h];
    }
  }
  return '';
}

export function customerFocusRoutes() {
  const router = Router();

  // -------- Summary (specific) --------
  router.get('/summary', requirePermission('customer_focus', 'view'), (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const todayIso = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeStakeholders: count('SELECT COUNT(*) count FROM customer_stakeholders WHERE is_active = 1'),
      activeServiceAgreements: count("SELECT COUNT(*) count FROM service_agreements WHERE status = 'active'"),
      feedbackThisMonth: count('SELECT COUNT(*) count FROM customer_feedback WHERE feedback_date >= ?', monthStart),
      openFeedback: count("SELECT COUNT(*) count FROM customer_feedback WHERE status NOT IN ('resolved','closed')"),
      highUrgencyFeedback: count("SELECT COUNT(*) count FROM customer_feedback WHERE urgency IN ('high','critical') AND status NOT IN ('resolved','closed')"),
      activeSurveys: count("SELECT COUNT(*) count FROM satisfaction_surveys WHERE status = 'active'"),
      surveyResponsesThisMonth: count('SELECT COUNT(*) count FROM satisfaction_survey_responses WHERE response_date >= ?', monthStart),
      followUpsDue: count("SELECT COUNT(*) count FROM customer_feedback WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status NOT IN ('resolved','closed')", todayIso)
        + count("SELECT COUNT(*) count FROM customer_communication_logs WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status != 'closed'", todayIso)
    });
  });

  // ============= Stakeholders =============
  router.get('/stakeholders', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.stakeholderType) { filters.push('stakeholder_type = ?'); params.push(String(req.query.stakeholderType)); }
    if (req.query.isActive !== undefined) { filters.push('is_active = ?'); params.push(req.query.isActive === 'true' ? 1 : 0); }
    let query = 'SELECT * FROM customer_stakeholders';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY stakeholder_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/stakeholders', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!req.body.stakeholderName) return res.status(400).json({ error: 'stakeholderName is required' });
    if (!req.body.stakeholderType) return res.status(400).json({ error: 'stakeholderType is required' });
    if (!STAKEHOLDER_TYPES.includes(req.body.stakeholderType)) return res.status(400).json({ error: `stakeholderType must be one of: ${STAKEHOLDER_TYPES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const stakeholderNumber = generateRecordNumber(db, 'customer_stakeholders', 'CST', createdAt);
    const result = db.prepare(`INSERT INTO customer_stakeholders (stakeholder_number, stakeholder_name, stakeholder_type, organisation, contact_person, email, phone, address, department_id, section_id, notes, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(stakeholderNumber, req.body.stakeholderName, req.body.stakeholderType, req.body.organisation ?? null, req.body.contactPerson ?? null, req.body.email ?? null, req.body.phone ?? null, req.body.address ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.notes ?? null, req.body.isActive === false ? 0 : 1, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'customer_stakeholders', entityId: id, newValue: { stakeholderNumber, ...req.body } });
    res.status(201).json({ id, stakeholderNumber });
  });

  router.get('/stakeholders/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const stakeholder = db.prepare('SELECT * FROM customer_stakeholders WHERE id = ?').get(req.params.id) as any;
    if (!stakeholder) return res.status(404).json({ error: 'Stakeholder not found' });
    const agreements = db.prepare('SELECT * FROM service_agreements WHERE stakeholder_id = ? ORDER BY start_date DESC, id DESC').all(req.params.id);
    const feedback = db.prepare('SELECT * FROM customer_feedback WHERE stakeholder_id = ? ORDER BY feedback_date DESC LIMIT 50').all(req.params.id);
    const communications = db.prepare('SELECT * FROM customer_communication_logs WHERE stakeholder_id = ? ORDER BY communication_date DESC LIMIT 50').all(req.params.id);
    res.json({ ...stakeholder, agreements, feedback, communications });
  });

  router.put('/stakeholders/:id', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM customer_stakeholders WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Stakeholder not found' });
    if (req.body.stakeholderType && !STAKEHOLDER_TYPES.includes(req.body.stakeholderType)) return res.status(400).json({ error: `stakeholderType must be one of: ${STAKEHOLDER_TYPES.join(', ')}` });
    db.prepare(`UPDATE customer_stakeholders SET stakeholder_name = ?, stakeholder_type = ?, organisation = ?, contact_person = ?, email = ?, phone = ?, address = ?, department_id = ?, section_id = ?, notes = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.stakeholderName ?? oldValue.stakeholder_name, req.body.stakeholderType ?? oldValue.stakeholder_type, req.body.organisation ?? oldValue.organisation, req.body.contactPerson ?? oldValue.contact_person, req.body.email ?? oldValue.email, req.body.phone ?? oldValue.phone, req.body.address ?? oldValue.address, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.notes ?? oldValue.notes, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'customer_stakeholders', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/stakeholders/:id/toggle', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM customer_stakeholders WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Stakeholder not found' });
    const newActive = s.is_active ? 0 : 1;
    db.prepare('UPDATE customer_stakeholders SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newActive, req.params.id);
    audit(req, { action: newActive ? 'activate' : 'deactivate', entity: 'customer_stakeholders', entityId: req.params.id, oldValue: { is_active: s.is_active }, newValue: { is_active: newActive } });
    res.json({ ok: true, isActive: newActive === 1 });
  });

  // ============= Service Agreements =============
  router.get('/service-agreements', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('sa.status = ?'); params.push(String(req.query.status)); }
    if (req.query.stakeholderId) { filters.push('sa.stakeholder_id = ?'); params.push(Number(req.query.stakeholderId)); }
    let query = 'SELECT sa.*, cs.stakeholder_name FROM service_agreements sa LEFT JOIN customer_stakeholders cs ON cs.id = sa.stakeholder_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY sa.start_date DESC, sa.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/service-agreements', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.stakeholderId)) return res.status(400).json({ error: 'stakeholderId is required' });
    if (!req.body.agreementTitle) return res.status(400).json({ error: 'agreementTitle is required' });
    if (!req.body.serviceScope) return res.status(400).json({ error: 'serviceScope is required' });
    const status = req.body.status ?? 'draft';
    if (!AGREEMENT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${AGREEMENT_STATUSES.join(', ')}` });
    const db = getDb();
    const stakeholder = db.prepare('SELECT id FROM customer_stakeholders WHERE id = ?').get(req.body.stakeholderId);
    if (!stakeholder) return res.status(404).json({ error: 'Stakeholder not found' });
    const createdAt = new Date().toISOString();
    const agreementNumber = generateRecordNumber(db, 'service_agreements', 'SAG', createdAt);
    const result = db.prepare(`INSERT INTO service_agreements (agreement_number, stakeholder_id, agreement_title, service_scope, start_date, end_date, review_due_date, responsible_staff_id, agreed_turnaround, reporting_format, status, attached_file_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agreementNumber, req.body.stakeholderId, req.body.agreementTitle, req.body.serviceScope, req.body.startDate ?? null, req.body.endDate ?? null, req.body.reviewDueDate ?? null, parseIntNullable(req.body.responsibleStaffId), req.body.agreedTurnaround ?? null, req.body.reportingFormat ?? null, status, parseIntNullable(req.body.attachedFileId), req.body.notes ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    insertLink(db, { module: 'customer_focus', type: 'service_agreements', id }, { module: 'customer_focus', type: 'customer_stakeholders', id: req.body.stakeholderId }, 'Service agreement stakeholder');
    if (parseIntNullable(req.body.attachedFileId)) insertLink(db, { module: 'customer_focus', type: 'service_agreements', id }, { module: 'documents', type: 'files', id: parseIntNullable(req.body.attachedFileId)! }, 'Service agreement attachment');
    audit(req, { action: 'create', entity: 'service_agreements', entityId: id, newValue: { agreementNumber, ...req.body } });
    res.status(201).json({ id, agreementNumber });
  });

  router.get('/service-agreements/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const sa = db.prepare('SELECT sa.*, cs.stakeholder_name FROM service_agreements sa LEFT JOIN customer_stakeholders cs ON cs.id = sa.stakeholder_id WHERE sa.id = ?').get(req.params.id);
    if (!sa) return res.status(404).json({ error: 'Service agreement not found' });
    res.json(sa);
  });

  router.put('/service-agreements/:id', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM service_agreements WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Service agreement not found' });
    if (req.body.status && !AGREEMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${AGREEMENT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE service_agreements SET agreement_title = ?, service_scope = ?, start_date = ?, end_date = ?, review_due_date = ?, responsible_staff_id = ?, agreed_turnaround = ?, reporting_format = ?, status = ?, attached_file_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.agreementTitle ?? oldValue.agreement_title, req.body.serviceScope ?? oldValue.service_scope, req.body.startDate ?? oldValue.start_date, req.body.endDate ?? oldValue.end_date, req.body.reviewDueDate ?? oldValue.review_due_date, parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id, req.body.agreedTurnaround ?? oldValue.agreed_turnaround, req.body.reportingFormat ?? oldValue.reporting_format, req.body.status ?? oldValue.status, parseIntNullable(req.body.attachedFileId) ?? oldValue.attached_file_id, req.body.notes ?? oldValue.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'service_agreements', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/service-agreements/:id/approve', requirePermission('customer_focus', 'approve'), (req, res) => {
    const db = getDb();
    const sa = db.prepare('SELECT * FROM service_agreements WHERE id = ?').get(req.params.id) as any;
    if (!sa) return res.status(404).json({ error: 'Service agreement not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE service_agreements SET status = 'active', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'service_agreements', entityId: req.params.id, oldValue: { status: sa.status }, newValue: { status: 'active', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/service-agreements/:id/archive', requirePermission('customer_focus', 'approve'), (req, res) => {
    const db = getDb();
    const sa = db.prepare('SELECT * FROM service_agreements WHERE id = ?').get(req.params.id) as any;
    if (!sa) return res.status(404).json({ error: 'Service agreement not found' });
    db.prepare("UPDATE service_agreements SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'archive', entity: 'service_agreements', entityId: req.params.id, oldValue: { status: sa.status }, newValue: { status: 'archived' } });
    res.json({ ok: true });
  });

  // ============= Feedback =============
  router.get('/feedback', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('f.status = ?'); params.push(String(req.query.status)); }
    if (req.query.urgency) { filters.push('f.urgency = ?'); params.push(String(req.query.urgency)); }
    if (req.query.feedbackType) { filters.push('f.feedback_type = ?'); params.push(String(req.query.feedbackType)); }
    let query = 'SELECT f.*, cs.stakeholder_name, s.full_name AS assigned_to_name FROM customer_feedback f LEFT JOIN customer_stakeholders cs ON cs.id = f.stakeholder_id LEFT JOIN staff s ON s.id = f.assigned_to_staff_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY f.feedback_date DESC, f.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/feedback', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!req.body.feedbackDate) return res.status(400).json({ error: 'feedbackDate is required' });
    if (!req.body.feedbackType) return res.status(400).json({ error: 'feedbackType is required' });
    if (!FEEDBACK_TYPES.includes(req.body.feedbackType)) return res.status(400).json({ error: `feedbackType must be one of: ${FEEDBACK_TYPES.join(', ')}` });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    if (req.body.urgency && !URGENCY.includes(req.body.urgency)) return res.status(400).json({ error: `urgency must be one of: ${URGENCY.join(', ')}` });
    const status = req.body.status ?? 'new';
    if (!FEEDBACK_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${FEEDBACK_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const feedbackNumber = generateRecordNumber(db, 'customer_feedback', 'CFB', createdAt);
    const result = db.prepare(`INSERT INTO customer_feedback (feedback_number, feedback_date, feedback_type, source_channel, stakeholder_id, contact_name, contact_detail, department_id, section_id, title, description, urgency, sentiment, status, assigned_to_staff_id, follow_up_due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(feedbackNumber, req.body.feedbackDate, req.body.feedbackType, req.body.sourceChannel ?? null, parseIntNullable(req.body.stakeholderId), req.body.contactName ?? null, req.body.contactDetail ?? null, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.title, req.body.description, req.body.urgency ?? null, req.body.sentiment ?? null, status, parseIntNullable(req.body.assignedToStaffId), req.body.followUpDueDate ?? null, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'customer_feedback', entityId: id, newValue: { feedbackNumber, ...req.body } });
    res.status(201).json({ id, feedbackNumber });
  });

  router.get('/feedback/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT f.*, cs.stakeholder_name FROM customer_feedback f LEFT JOIN customer_stakeholders cs ON cs.id = f.stakeholder_id WHERE f.id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?').all('customer_focus', 'customer_feedback', String(req.params.id));
    res.json({ ...f, links });
  });

  router.put('/feedback/:id', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM customer_feedback WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Feedback not found' });
    if (req.body.status && !FEEDBACK_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${FEEDBACK_STATUSES.join(', ')}` });
    if (req.body.urgency && !URGENCY.includes(req.body.urgency)) return res.status(400).json({ error: `urgency must be one of: ${URGENCY.join(', ')}` });
    db.prepare(`UPDATE customer_feedback SET feedback_date = ?, feedback_type = ?, source_channel = ?, stakeholder_id = ?, contact_name = ?, contact_detail = ?, department_id = ?, section_id = ?, title = ?, description = ?, urgency = ?, sentiment = ?, status = ?, assigned_to_staff_id = ?, acknowledgement_sent_at = ?, follow_up_due_date = ?, resolution_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.feedbackDate ?? oldValue.feedback_date, req.body.feedbackType ?? oldValue.feedback_type, req.body.sourceChannel ?? oldValue.source_channel, parseIntNullable(req.body.stakeholderId) ?? oldValue.stakeholder_id, req.body.contactName ?? oldValue.contact_name, req.body.contactDetail ?? oldValue.contact_detail, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.title ?? oldValue.title, req.body.description ?? oldValue.description, req.body.urgency ?? oldValue.urgency, req.body.sentiment ?? oldValue.sentiment, req.body.status ?? oldValue.status, parseIntNullable(req.body.assignedToStaffId) ?? oldValue.assigned_to_staff_id, req.body.acknowledgementSentAt ?? oldValue.acknowledgement_sent_at, req.body.followUpDueDate ?? oldValue.follow_up_due_date, req.body.resolutionSummary ?? oldValue.resolution_summary, req.params.id);
    audit(req, { action: 'edit', entity: 'customer_feedback', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/feedback/:id/create-complaint', requirePermission('complaints', 'create'), (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT f.*, cs.stakeholder_name FROM customer_feedback f LEFT JOIN customer_stakeholders cs ON cs.id = f.stakeholder_id WHERE f.id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    const createdAt = new Date().toISOString();
    const complaintNumber = generateRecordNumber(db, 'complaints', 'COMP', createdAt);
    const result = db.prepare(`INSERT INTO complaints (complaint_number, received_date, source, complainant_type, complainant_name, contact, department_id, section_id, category, title, description, assigned_to_staff_id, acknowledgement_status, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(complaintNumber, f.feedback_date, f.source_channel ?? 'customer_focus', req.body.complainantType ?? 'external', f.contact_name ?? f.stakeholder_name ?? null, f.contact_detail ?? null, f.department_id, f.section_id, req.body.category ?? f.feedback_type, req.body.title ?? f.title, req.body.description ?? f.description, parseIntNullable(req.body.assignedToStaffId) ?? f.assigned_to_staff_id, 'pending', 'new', req.user!.id, createdAt);
    const complaintId = Number(result.lastInsertRowid);
    db.prepare("UPDATE customer_feedback SET complaint_id = ?, status = 'escalated', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(complaintId, req.params.id);
    insertLink(db, { module: 'customer_focus', type: 'customer_feedback', id: req.params.id }, { module: 'complaints', type: 'complaints', id: complaintId }, 'Formal complaint escalated from customer feedback');
    audit(req, { action: 'create', entity: 'complaints', entityId: complaintId, newValue: { complaintNumber, sourceModule: 'customer_focus', sourceRecordId: req.params.id } });
    res.status(201).json({ id: complaintId, complaintNumber });
  });

  router.post('/feedback/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const f = db.prepare('SELECT * FROM customer_feedback WHERE id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'customer_focus', 'customer_focus', String(req.params.id), req.body.description ?? f.description ?? null, req.body.priority ?? (f.urgency === 'high' || f.urgency === 'critical' ? 'high' : 'normal'), parseIntNullable(req.body.assignedToStaffId) ?? f.assigned_to_staff_id, req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    insertLink(db, { module: 'customer_focus', type: 'customer_feedback', id: req.params.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from customer feedback');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'customer_focus', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/feedback/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT * FROM customer_feedback WHERE id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? f.assigned_to_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, f.feedback_date, detectedBy, 'customer_focus', String(f.id), req.body.title ?? `Customer feedback: ${f.title}`, req.body.description ?? f.description, req.body.category ?? 'customer_focus', req.body.severity ?? (f.urgency === 'critical' ? 'high' : 'medium'), 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare("UPDATE customer_feedback SET nc_id = ?, status = CASE WHEN status NOT IN ('resolved','closed') THEN 'escalated' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    insertLink(db, { module: 'customer_focus', type: 'customer_feedback', id: f.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from customer feedback');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'customer_focus', sourceRecordId: f.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/feedback/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT * FROM customer_feedback WHERE id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const capaResult = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'customer_focus', String(f.id), f.nc_id ?? null, req.body.title ?? `CAPA for ${f.title}`, req.body.problemSummary ?? f.description, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(capaResult.lastInsertRowid);
    db.prepare('UPDATE customer_feedback SET capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, req.params.id);
    insertLink(db, { module: 'customer_focus', type: 'customer_feedback', id: f.id }, { module: 'nc_capa', type: 'capa_records', id: capaId }, 'CAPA from customer feedback');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'customer_focus', sourceRecordId: f.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/feedback/:id/close', requirePermission('customer_focus', 'approve'), (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT * FROM customer_feedback WHERE id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    const closedBy = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE customer_feedback SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, resolution_summary = COALESCE(?, resolution_summary), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(closedBy, req.body.resolutionSummary ?? null, req.params.id);
    audit(req, { action: 'close', entity: 'customer_feedback', entityId: req.params.id, oldValue: { status: f.status }, newValue: { status: 'closed', closedByStaffId: closedBy } });
    res.json({ ok: true });
  });

  // ============= Surveys =============
  router.get('/surveys', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM satisfaction_surveys';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/surveys', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!req.body.surveyTitle) return res.status(400).json({ error: 'surveyTitle is required' });
    if (!req.body.surveyType) return res.status(400).json({ error: 'surveyType is required' });
    if (!SURVEY_TYPES.includes(req.body.surveyType)) return res.status(400).json({ error: `surveyType must be one of: ${SURVEY_TYPES.join(', ')}` });
    const status = req.body.status ?? 'draft';
    if (!SURVEY_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${SURVEY_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const surveyNumber = generateRecordNumber(db, 'satisfaction_surveys', 'CSS', createdAt);
    const result = db.prepare(`INSERT INTO satisfaction_surveys (survey_number, survey_title, survey_type, description, audience, period_start, period_end, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(surveyNumber, req.body.surveyTitle, req.body.surveyType, req.body.description ?? null, req.body.audience ?? null, req.body.periodStart ?? null, req.body.periodEnd ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'satisfaction_surveys', entityId: id, newValue: { surveyNumber, ...req.body } });
    res.status(201).json({ id, surveyNumber });
  });

  router.get('/surveys/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(req.params.id) as any;
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const questions = db.prepare('SELECT * FROM satisfaction_survey_questions WHERE survey_id = ? ORDER BY display_order, id').all(req.params.id);
    const responseCount = (db.prepare('SELECT COUNT(*) AS c FROM satisfaction_survey_responses WHERE survey_id = ?').get(req.params.id) as { c: number }).c;
    res.json({ ...survey, questions, responseCount });
  });

  router.put('/surveys/:id', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Survey not found' });
    if (req.body.status && !SURVEY_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SURVEY_STATUSES.join(', ')}` });
    db.prepare(`UPDATE satisfaction_surveys SET survey_title = ?, survey_type = ?, description = ?, audience = ?, period_start = ?, period_end = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.surveyTitle ?? oldValue.survey_title, req.body.surveyType ?? oldValue.survey_type, req.body.description ?? oldValue.description, req.body.audience ?? oldValue.audience, req.body.periodStart ?? oldValue.period_start, req.body.periodEnd ?? oldValue.period_end, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'satisfaction_surveys', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/surveys/:id/questions', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!req.body.questionText) return res.status(400).json({ error: 'questionText is required' });
    if (!req.body.questionType) return res.status(400).json({ error: 'questionType is required' });
    if (!QUESTION_TYPES.includes(req.body.questionType)) return res.status(400).json({ error: `questionType must be one of: ${QUESTION_TYPES.join(', ')}` });
    const db = getDb();
    const survey = db.prepare('SELECT id FROM satisfaction_surveys WHERE id = ?').get(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const result = db.prepare(`INSERT INTO satisfaction_survey_questions (survey_id, question_code, question_text, question_type, scale_min, scale_max, options_text, is_required, display_order, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(req.params.id, req.body.questionCode ?? null, req.body.questionText, req.body.questionType, parseIntNullable(req.body.scaleMin), parseIntNullable(req.body.scaleMax), req.body.optionsText ?? null, req.body.isRequired ? 1 : 0, parseIntNullable(req.body.displayOrder) ?? 0, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'satisfaction_survey_questions', entityId: id, newValue: { surveyId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.put('/surveys/:id/questions/:questionId', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM satisfaction_survey_questions WHERE id = ? AND survey_id = ?').get(req.params.questionId, req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Question not found' });
    if (req.body.questionType && !QUESTION_TYPES.includes(req.body.questionType)) return res.status(400).json({ error: `questionType must be one of: ${QUESTION_TYPES.join(', ')}` });
    db.prepare(`UPDATE satisfaction_survey_questions SET question_code = ?, question_text = ?, question_type = ?, scale_min = ?, scale_max = ?, options_text = ?, is_required = ?, display_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.questionCode ?? old.question_code, req.body.questionText ?? old.question_text, req.body.questionType ?? old.question_type, parseIntNullable(req.body.scaleMin) ?? old.scale_min, parseIntNullable(req.body.scaleMax) ?? old.scale_max, req.body.optionsText ?? old.options_text, req.body.isRequired !== undefined ? (req.body.isRequired ? 1 : 0) : old.is_required, parseIntNullable(req.body.displayOrder) ?? old.display_order, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : old.is_active, req.params.questionId);
    audit(req, { action: 'edit', entity: 'satisfaction_survey_questions', entityId: req.params.questionId, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/surveys/:id/approve', requirePermission('customer_focus', 'approve'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Survey not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE satisfaction_surveys SET status = 'active', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'satisfaction_surveys', entityId: req.params.id, oldValue: { status: s.status }, newValue: { status: 'active', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/surveys/:id/close', requirePermission('customer_focus', 'approve'), (req, res) => {
    const db = getDb();
    const s = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Survey not found' });
    db.prepare("UPDATE satisfaction_surveys SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'satisfaction_surveys', entityId: req.params.id, oldValue: { status: s.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  router.get('/surveys/:id/analytics', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(req.params.id) as any;
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const questions = db.prepare('SELECT * FROM satisfaction_survey_questions WHERE survey_id = ? ORDER BY display_order, id').all(req.params.id) as any[];
    const totalResponses = (db.prepare('SELECT COUNT(*) AS c FROM satisfaction_survey_responses WHERE survey_id = ?').get(req.params.id) as { c: number }).c;
    const analytics = questions.map(q => {
      const items = db.prepare('SELECT answer_text, answer_number FROM satisfaction_survey_answer_items WHERE question_id = ?').all(q.id) as Array<{ answer_text: string | null; answer_number: number | null }>;
      const answered = items.length;
      if (q.question_type === 'scale') {
        const nums = items.map(i => i.answer_number).filter((n): n is number => n !== null && n !== undefined && Number.isFinite(Number(n)));
        const mean = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        const min = nums.length ? Math.min(...nums) : null;
        const max = nums.length ? Math.max(...nums) : null;
        const dist: Record<string, number> = {};
        for (const n of nums) dist[String(n)] = (dist[String(n)] || 0) + 1;
        return { question_id: q.id, question_text: q.question_text, question_type: q.question_type, answered, mean, min, max, distribution: dist };
      }
      if (q.question_type === 'yes_no' || q.question_type === 'multiple_choice') {
        const dist: Record<string, number> = {};
        for (const i of items) { const k = (i.answer_text || '').trim() || '(blank)'; dist[k] = (dist[k] || 0) + 1; }
        return { question_id: q.id, question_text: q.question_text, question_type: q.question_type, answered, distribution: dist };
      }
      const samples = items.slice(0, 5).map(i => (i.answer_text || '').slice(0, 200));
      return { question_id: q.id, question_text: q.question_text, question_type: q.question_type, answered, samples };
    });
    res.json({ survey_id: Number(req.params.id), survey_title: survey.survey_title, total_responses: totalResponses, period_start: survey.period_start, period_end: survey.period_end, status: survey.status, questions: analytics });
  });

  router.get('/service-agreements/:id/performance', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const sa = db.prepare('SELECT sa.*, cs.stakeholder_name FROM service_agreements sa LEFT JOIN customer_stakeholders cs ON cs.id = sa.stakeholder_id WHERE sa.id = ?').get(req.params.id) as any;
    if (!sa) return res.status(404).json({ error: 'Service agreement not found' });
    const start = sa.start_date || '1900-01-01';
    const end = sa.end_date || '2100-12-31';
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const feedbackTotal = count('SELECT COUNT(*) count FROM customer_feedback WHERE stakeholder_id = ? AND feedback_date BETWEEN ? AND ?', sa.stakeholder_id, start, end);
    const feedbackOpen = count("SELECT COUNT(*) count FROM customer_feedback WHERE stakeholder_id = ? AND feedback_date BETWEEN ? AND ? AND status NOT IN ('resolved','closed')", sa.stakeholder_id, start, end);
    const feedbackHigh = count("SELECT COUNT(*) count FROM customer_feedback WHERE stakeholder_id = ? AND feedback_date BETWEEN ? AND ? AND urgency IN ('high','critical')", sa.stakeholder_id, start, end);
    const escalated = count('SELECT COUNT(*) count FROM customer_feedback WHERE stakeholder_id = ? AND feedback_date BETWEEN ? AND ? AND complaint_id IS NOT NULL', sa.stakeholder_id, start, end);
    const communications = count('SELECT COUNT(*) count FROM customer_communication_logs WHERE stakeholder_id = ? AND communication_date BETWEEN ? AND ?', sa.stakeholder_id, start, end);
    const byType = db.prepare("SELECT feedback_type, COUNT(*) AS c FROM customer_feedback WHERE stakeholder_id = ? AND feedback_date BETWEEN ? AND ? GROUP BY feedback_type").all(sa.stakeholder_id, start, end) as Array<{ feedback_type: string; c: number }>;
    res.json({
      agreement_id: Number(req.params.id),
      agreement_number: sa.agreement_number,
      stakeholder_name: sa.stakeholder_name,
      period_start: sa.start_date,
      period_end: sa.end_date,
      agreed_turnaround: sa.agreed_turnaround,
      feedback_total: feedbackTotal,
      feedback_open: feedbackOpen,
      feedback_high_urgency: feedbackHigh,
      feedback_escalated_to_complaint: escalated,
      communications_total: communications,
      feedback_by_type: byType,
      note: 'Performance counts are derived from feedback and communications recorded against the stakeholder during the agreement period.'
    });
  });

  router.get('/surveys/:id/responses', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT r.*, cs.stakeholder_name FROM satisfaction_survey_responses r LEFT JOIN customer_stakeholders cs ON cs.id = r.stakeholder_id WHERE r.survey_id = ? ORDER BY r.response_date DESC, r.id DESC').all(req.params.id));
  });

  router.post('/surveys/:id/responses', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!req.body.responseDate) return res.status(400).json({ error: 'responseDate is required' });
    const db = getDb();
    const survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(req.params.id) as any;
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (survey.status !== 'active') return res.status(400).json({ error: 'Survey is not active' });
    const answers: Array<{ questionId: number; answerText?: string; answerNumber?: number }> = Array.isArray(req.body.answers) ? req.body.answers : [];
    const validQuestions = db.prepare('SELECT id FROM satisfaction_survey_questions WHERE survey_id = ?').all(req.params.id) as Array<{ id: number }>;
    const validIds = new Set(validQuestions.map(q => q.id));
    for (const a of answers) { if (!validIds.has(Number(a.questionId))) return res.status(400).json({ error: `Question id ${a.questionId} does not belong to this survey` }); }

    let responseId = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO satisfaction_survey_responses (survey_id, response_date, source_channel, stakeholder_id, respondent_name, respondent_role, notes, overall_comment, feedback_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.params.id, req.body.responseDate, req.body.sourceChannel ?? null, parseIntNullable(req.body.stakeholderId), req.body.respondentName ?? null, req.body.respondentRole ?? null, req.body.notes ?? null, req.body.overallComment ?? null, parseIntNullable(req.body.feedbackId), req.user!.id);
      responseId = Number(r.lastInsertRowid);
      const insertItem = db.prepare(`INSERT OR REPLACE INTO satisfaction_survey_answer_items (response_id, question_id, answer_text, answer_number) VALUES (?, ?, ?, ?)`);
      for (const a of answers) {
        insertItem.run(responseId, Number(a.questionId), a.answerText ?? null, a.answerNumber !== undefined && a.answerNumber !== null && a.answerNumber !== '' as any ? Number(a.answerNumber) : null);
      }
    });
    tx();
    if (parseIntNullable(req.body.feedbackId)) insertLink(db, { module: 'customer_focus', type: 'satisfaction_survey_responses', id: responseId }, { module: 'customer_focus', type: 'customer_feedback', id: parseIntNullable(req.body.feedbackId)! }, 'Survey response linked to feedback');
    audit(req, { action: 'create', entity: 'satisfaction_survey_responses', entityId: responseId, newValue: { surveyId: req.params.id, answerCount: answers.length, ...req.body } });
    res.status(201).json({ id: responseId, answersSaved: answers.length });
  });

  router.get('/responses', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.surveyType) { filters.push('s.survey_type = ?'); params.push(String(req.query.surveyType)); }
    if (req.query.stakeholderId) { filters.push('r.stakeholder_id = ?'); params.push(Number(req.query.stakeholderId)); }
    if (req.query.from) { filters.push('r.response_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push('r.response_date <= ?'); params.push(String(req.query.to)); }
    let query = `SELECT r.*, s.survey_number, s.survey_title, s.survey_type, cs.stakeholder_name
      FROM satisfaction_survey_responses r
      JOIN satisfaction_surveys s ON s.id = r.survey_id
      LEFT JOIN customer_stakeholders cs ON cs.id = r.stakeholder_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY r.response_date DESC, r.id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.get('/responses/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const response = db.prepare('SELECT r.*, s.survey_title, cs.stakeholder_name FROM satisfaction_survey_responses r JOIN satisfaction_surveys s ON s.id = r.survey_id LEFT JOIN customer_stakeholders cs ON cs.id = r.stakeholder_id WHERE r.id = ?').get(req.params.id) as any;
    if (!response) return res.status(404).json({ error: 'Response not found' });
    const items = db.prepare('SELECT i.*, q.question_text, q.question_type FROM satisfaction_survey_answer_items i JOIN satisfaction_survey_questions q ON q.id = i.question_id WHERE i.response_id = ? ORDER BY q.display_order, q.id').all(req.params.id);
    res.json({ ...response, answers: items });
  });

  // ============= Communications =============
  router.get('/communications', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('cl.status = ?'); params.push(String(req.query.status)); }
    if (req.query.stakeholderId) { filters.push('cl.stakeholder_id = ?'); params.push(Number(req.query.stakeholderId)); }
    let query = 'SELECT cl.*, cs.stakeholder_name, s.full_name AS staff_name FROM customer_communication_logs cl LEFT JOIN customer_stakeholders cs ON cs.id = cl.stakeholder_id LEFT JOIN staff s ON s.id = cl.staff_id';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY cl.communication_date DESC, cl.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/communications', requirePermission('customer_focus', 'create'), (req, res) => {
    if (!req.body.communicationDate) return res.status(400).json({ error: 'communicationDate is required' });
    if (!req.body.communicationType) return res.status(400).json({ error: 'communicationType is required' });
    if (!COMMUNICATION_TYPES.includes(req.body.communicationType)) return res.status(400).json({ error: `communicationType must be one of: ${COMMUNICATION_TYPES.join(', ')}` });
    if (!req.body.subject) return res.status(400).json({ error: 'subject is required' });
    if (!req.body.messageSummary) return res.status(400).json({ error: 'messageSummary is required' });
    const direction = req.body.direction ?? 'outbound';
    if (!COMMUNICATION_DIRECTIONS.includes(direction)) return res.status(400).json({ error: `direction must be one of: ${COMMUNICATION_DIRECTIONS.join(', ')}` });
    const status = req.body.status ?? 'open';
    if (!COMMUNICATION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${COMMUNICATION_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const communicationNumber = generateRecordNumber(db, 'customer_communication_logs', 'CCOM', createdAt);
    const staffId = getStaffIdOrCurrent(req, req.body.staffId);
    const result = db.prepare(`INSERT INTO customer_communication_logs (communication_number, communication_date, communication_type, direction, channel, subject, message_summary, stakeholder_id, feedback_id, contact_name, contact_detail, staff_id, attached_file_id, follow_up_due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(communicationNumber, req.body.communicationDate, req.body.communicationType, direction, req.body.channel ?? null, req.body.subject, req.body.messageSummary, parseIntNullable(req.body.stakeholderId), parseIntNullable(req.body.feedbackId), req.body.contactName ?? null, req.body.contactDetail ?? null, staffId, parseIntNullable(req.body.attachedFileId), req.body.followUpDueDate ?? null, status, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.feedbackId)) insertLink(db, { module: 'customer_focus', type: 'customer_communication_logs', id }, { module: 'customer_focus', type: 'customer_feedback', id: parseIntNullable(req.body.feedbackId)! }, 'Communication for feedback');
    audit(req, { action: 'create', entity: 'customer_communication_logs', entityId: id, newValue: { communicationNumber, ...req.body } });
    res.status(201).json({ id, communicationNumber });
  });

  router.get('/communications/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT cl.*, cs.stakeholder_name, s.full_name AS staff_name FROM customer_communication_logs cl LEFT JOIN customer_stakeholders cs ON cs.id = cl.stakeholder_id LEFT JOIN staff s ON s.id = cl.staff_id WHERE cl.id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Communication not found' });
    res.json(c);
  });

  router.put('/communications/:id', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM customer_communication_logs WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Communication not found' });
    if (req.body.status && !COMMUNICATION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${COMMUNICATION_STATUSES.join(', ')}` });
    if (req.body.direction && !COMMUNICATION_DIRECTIONS.includes(req.body.direction)) return res.status(400).json({ error: `direction must be one of: ${COMMUNICATION_DIRECTIONS.join(', ')}` });
    if (req.body.communicationType && !COMMUNICATION_TYPES.includes(req.body.communicationType)) return res.status(400).json({ error: `communicationType must be one of: ${COMMUNICATION_TYPES.join(', ')}` });
    db.prepare(`UPDATE customer_communication_logs SET communication_date = ?, communication_type = ?, direction = ?, channel = ?, subject = ?, message_summary = ?, stakeholder_id = ?, feedback_id = ?, contact_name = ?, contact_detail = ?, staff_id = ?, attached_file_id = ?, follow_up_due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.communicationDate ?? oldValue.communication_date, req.body.communicationType ?? oldValue.communication_type, req.body.direction ?? oldValue.direction, req.body.channel ?? oldValue.channel, req.body.subject ?? oldValue.subject, req.body.messageSummary ?? oldValue.message_summary, parseIntNullable(req.body.stakeholderId) ?? oldValue.stakeholder_id, parseIntNullable(req.body.feedbackId) ?? oldValue.feedback_id, req.body.contactName ?? oldValue.contact_name, req.body.contactDetail ?? oldValue.contact_detail, parseIntNullable(req.body.staffId) ?? oldValue.staff_id, parseIntNullable(req.body.attachedFileId) ?? oldValue.attached_file_id, req.body.followUpDueDate ?? oldValue.follow_up_due_date, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'customer_communication_logs', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/communications/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const c = db.prepare('SELECT * FROM customer_communication_logs WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Communication not found' });
    const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.body.title, 'customer_focus', 'customer_focus', String(req.params.id), req.body.description ?? c.message_summary, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? c.follow_up_due_date ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
    const actionId = Number(result.lastInsertRowid);
    insertLink(db, { module: 'customer_focus', type: 'customer_communication_logs', id: req.params.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from communication');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'customer_focus', sourceRecordId: req.params.id, ...req.body } });
    res.status(201).json({ id: actionId });
  });

  router.post('/communications/:id/close', requirePermission('customer_focus', 'edit'), (req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM customer_communication_logs WHERE id = ?').get(req.params.id) as any;
    if (!c) return res.status(404).json({ error: 'Communication not found' });
    const closedBy = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE customer_communication_logs SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(closedBy, req.params.id);
    audit(req, { action: 'close', entity: 'customer_communication_logs', entityId: req.params.id, oldValue: { status: c.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Imports =============
  router.get('/imports', requirePermission('customer_focus', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM customer_focus_import_batches ORDER BY created_at DESC').all());
  });

  router.post('/imports', requirePermission('customer_focus', 'create'), uploadInstance.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A file upload is required' });
    if (!req.body.importType) return res.status(400).json({ error: 'importType is required' });
    if (!IMPORT_TYPES.includes(req.body.importType)) return res.status(400).json({ error: `importType must be one of: ${IMPORT_TYPES.join(', ')}` });
    const db = getDb();
    const fileRow = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    const fileId = Number(fileRow.lastInsertRowid);
    const createdAt = new Date().toISOString();
    const batchNumber = generateRecordNumber(db, 'customer_focus_import_batches', 'CFIMP', createdAt);
    const importedBy = getStaffIdOrCurrent(req, req.body.importedByStaffId);
    const result = db.prepare(`INSERT INTO customer_focus_import_batches (batch_number, import_type, source_file_id, original_filename, imported_by_staff_id, imported_at, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(batchNumber, req.body.importType, fileId, req.file.originalname, importedBy, createdAt, req.body.notes ?? null, req.user!.id, createdAt);
    const batchId = Number(result.lastInsertRowid);
    insertLink(db, { module: 'customer_focus', type: 'customer_focus_import_batches', id: batchId }, { module: 'documents', type: 'files', id: fileId }, 'Customer focus import source');
    audit(req, { action: 'create', entity: 'customer_focus_import_batches', entityId: batchId, newValue: { batchNumber, importType: req.body.importType, fileId } });
    res.status(201).json({ id: batchId, batchNumber });
  });

  router.get('/imports/:id', requirePermission('customer_focus', 'view'), (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM customer_focus_import_batches WHERE id = ?').get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    const rows = db.prepare('SELECT * FROM customer_focus_import_rows WHERE import_batch_id = ? ORDER BY row_number LIMIT 500').all(req.params.id);
    res.json({ ...batch, rows });
  });

  router.post('/imports/:id/process', requirePermission('customer_focus', 'create'), (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM customer_focus_import_batches WHERE id = ?').get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    if (!batch.source_file_id) return res.status(400).json({ error: 'Batch has no source file' });
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(batch.source_file_id) as any;
    if (!file) return res.status(404).json({ error: 'Source file missing' });
    const filePath = path.join(uploadRoot, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Source file missing on disk' });
    const ext = path.extname(file.original_name).toLowerCase();
    let rows: Record<string, string>[] = [];
    try {
      if (ext === '.csv') rows = parseCsvBody(fs.readFileSync(filePath, 'utf-8'));
      else if (ext === '.xlsx' || ext === '.xls') {
        const wb = XLSX.readFile(filePath, { cellDates: false });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
        rows = raw.map(r => { const o: Record<string, string> = {}; for (const k of Object.keys(r)) o[k] = r[k] === null || r[k] === undefined ? '' : String(r[k]).trim(); return o; });
      } else {
        db.prepare("UPDATE customer_focus_import_batches SET status = 'failed', notes = COALESCE(notes,'') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(`\nUnsupported file extension ${ext}. Upload .csv, .xlsx or .xls.`, req.params.id);
        return res.status(400).json({ error: `Unsupported file extension ${ext}` });
      }
    } catch (e) { return res.status(400).json({ error: `Parse failed: ${(e as Error).message}` }); }

    db.prepare('DELETE FROM customer_focus_import_rows WHERE import_batch_id = ?').run(req.params.id);
    let processed = 0; let exceptions = 0;
    const insertRow = db.prepare('INSERT INTO customer_focus_import_rows (import_batch_id, row_number, raw_json, mapped_target, mapped_target_id, status, exception_reason) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      rows.forEach((row, idx) => {
        let mappedTarget: string | null = null;
        let mappedTargetId: number | null = null;
        let exceptionReason: string | null = null;
        let status = 'mapped';
        try {
          if (batch.import_type === 'stakeholders') {
            const name = pickField(row, 'stakeholderName', 'name');
            const type = pickField(row, 'stakeholderType', 'type') || 'other';
            if (!name) throw new Error('stakeholderName/name missing');
            const validType = STAKEHOLDER_TYPES.includes(type) ? type : 'other';
            const createdAt = new Date().toISOString();
            const stakeholderNumber = generateRecordNumber(db, 'customer_stakeholders', 'CST', createdAt);
            const r = db.prepare(`INSERT INTO customer_stakeholders (stakeholder_number, stakeholder_name, stakeholder_type, organisation, contact_person, email, phone, address, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
              .run(stakeholderNumber, name, validType, pickField(row, 'organisation') || null, pickField(row, 'contactPerson', 'contact') || null, pickField(row, 'email') || null, pickField(row, 'phone') || null, pickField(row, 'address') || null, req.user!.id, createdAt);
            mappedTarget = 'customer_stakeholders'; mappedTargetId = Number(r.lastInsertRowid);
          } else if (batch.import_type === 'feedback') {
            const title = pickField(row, 'title');
            const description = pickField(row, 'description');
            const feedbackDate = pickField(row, 'feedbackDate', 'date') || new Date().toISOString().slice(0, 10);
            const feedbackType = pickField(row, 'feedbackType', 'type') || 'other';
            if (!title || !description) throw new Error('title and description required');
            const validType = FEEDBACK_TYPES.includes(feedbackType) ? feedbackType : 'other';
            const urgency = pickField(row, 'urgency');
            const createdAt = new Date().toISOString();
            const feedbackNumber = generateRecordNumber(db, 'customer_feedback', 'CFB', createdAt);
            const r = db.prepare(`INSERT INTO customer_feedback (feedback_number, feedback_date, feedback_type, source_channel, contact_name, contact_detail, title, description, urgency, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
              .run(feedbackNumber, feedbackDate, validType, pickField(row, 'sourceChannel', 'channel') || 'import', pickField(row, 'contactName') || null, pickField(row, 'contactDetail') || null, title, description, URGENCY.includes(urgency) ? urgency : null, req.user!.id, createdAt);
            mappedTarget = 'customer_feedback'; mappedTargetId = Number(r.lastInsertRowid);
          } else if (batch.import_type === 'survey_responses') {
            const surveyNumber = pickField(row, 'surveyNumber', 'survey');
            const surveyIdField = pickField(row, 'surveyId');
            let survey: any = null;
            if (surveyIdField) survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE id = ?').get(Number(surveyIdField));
            if (!survey && surveyNumber) survey = db.prepare('SELECT * FROM satisfaction_surveys WHERE survey_number = ?').get(surveyNumber);
            if (!survey) throw new Error('survey not resolved — provide surveyNumber or surveyId column');
            if (survey.status !== 'active') throw new Error(`survey ${survey.survey_number} is not active`);
            const responseDate = pickField(row, 'responseDate', 'date') || new Date().toISOString().slice(0, 10);
            const respondentName = pickField(row, 'respondentName', 'respondent') || null;
            const respondentRole = pickField(row, 'respondentRole', 'role') || null;
            const overallComment = pickField(row, 'overallComment', 'comment') || null;
            const sourceChannel = pickField(row, 'sourceChannel', 'channel') || 'import';
            const r = db.prepare('INSERT INTO satisfaction_survey_responses (survey_id, response_date, source_channel, respondent_name, respondent_role, overall_comment, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(survey.id, responseDate, sourceChannel, respondentName, respondentRole, overallComment, req.user!.id);
            const responseId = Number(r.lastInsertRowid);
            const questions = db.prepare('SELECT id, question_code, question_text, question_type FROM satisfaction_survey_questions WHERE survey_id = ?').all(survey.id) as Array<{ id: number; question_code: string | null; question_text: string; question_type: string }>;
            const insertItem = db.prepare('INSERT OR REPLACE INTO satisfaction_survey_answer_items (response_id, question_id, answer_text, answer_number) VALUES (?, ?, ?, ?)');
            let matched = 0;
            for (const q of questions) {
              const candidates = [q.question_code, q.question_text, `Q${q.id}`, `q${q.id}`].filter(Boolean) as string[];
              let raw = '';
              for (const c of candidates) { const v = pickField(row, c); if (v) { raw = v; break; } }
              if (!raw) continue;
              if (q.question_type === 'scale' || (Number.isFinite(Number(raw)) && raw.trim() !== '')) {
                insertItem.run(responseId, q.id, null, Number.isFinite(Number(raw)) ? Number(raw) : null);
              } else {
                insertItem.run(responseId, q.id, raw, null);
              }
              matched++;
            }
            mappedTarget = 'satisfaction_survey_responses'; mappedTargetId = responseId;
            if (matched === 0) exceptionReason = 'response saved but no question columns matched';
          } else {
            status = 'unmapped';
            exceptionReason = `Import type ${batch.import_type} captured as raw rows for manual review.`;
          }
        } catch (e) {
          status = 'exception';
          exceptionReason = (e as Error).message;
          exceptions++;
        }
        insertRow.run(req.params.id, idx + 1, JSON.stringify(row), mappedTarget, mappedTargetId, status, exceptionReason);
        if (status !== 'exception') processed++;
      });
      db.prepare("UPDATE customer_focus_import_batches SET status = 'processed', total_rows = ?, processed_rows = ?, exception_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(rows.length, processed, exceptions, req.params.id);
    });
    tx();
    audit(req, { action: 'process', entity: 'customer_focus_import_batches', entityId: req.params.id, newValue: { rows: rows.length, processed, exceptions } });
    res.json({ ok: true, rows: rows.length, processed, exceptions });
  });

  // -------- Printable feedback (print) --------
  router.get('/feedback/:id/print', requirePermission('customer_focus', 'print'), (req, res) => {
    const db = getDb();
    const f = db.prepare('SELECT f.*, cs.stakeholder_name FROM customer_feedback f LEFT JOIN customer_stakeholders cs ON cs.id = f.stakeholder_id WHERE f.id = ?').get(req.params.id) as any;
    if (!f) return res.status(404).send('Feedback not found');
    const links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?').all('customer_focus', 'customer_feedback', String(req.params.id)) as any[];
    const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const autoprint = req.query.autoprint === '0' ? '' : '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 250); });</script>';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(f.feedback_number)} — Print</title>
<style>@page{size:A4;margin:14mm}body{font-family:'Times New Roman',serif;color:#111;padding:18px 24px}.no-print{background:#f4f6fb;padding:8px 12px;border:1px solid #ccd;border-radius:6px;margin-bottom:12px;font-size:12px}h1{font-size:18px;border-bottom:2px solid #1B3A6B;padding-bottom:6px}table.meta{border-collapse:collapse;width:100%;font-size:11px}table.meta th,table.meta td{border:1px solid #888;padding:4px 8px;text-align:left;vertical-align:top}table.meta th{background:#eef2f7;width:22%}@media print{.no-print{display:none}body{padding:0}}</style>${autoprint}</head><body>
<div class="no-print">The print dialog will open automatically. Choose any printer or Save as PDF. <button onclick="window.print()">Print</button> <a href="?autoprint=0">disable autoprint</a></div>
<h1>${esc(f.feedback_number)} — ${esc(f.title)}</h1>
<table class="meta">
  <tr><th>Date</th><td>${esc(f.feedback_date)}</td><th>Type</th><td>${esc(f.feedback_type)}</td></tr>
  <tr><th>Status</th><td>${esc(f.status)}</td><th>Urgency</th><td>${esc(f.urgency || '—')}</td></tr>
  <tr><th>Source</th><td>${esc(f.source_channel || '—')}</td><th>Stakeholder</th><td>${esc(f.stakeholder_name || '—')}</td></tr>
  <tr><th>Contact</th><td>${esc(f.contact_name || '—')}</td><th>Contact detail</th><td>${esc(f.contact_detail || '—')}</td></tr>
  <tr><th>Description</th><td colspan="3">${esc(f.description)}</td></tr>
  ${f.resolution_summary ? `<tr><th>Resolution</th><td colspan="3">${esc(f.resolution_summary)}</td></tr>` : ''}
</table>
${links.length ? `<h3>Linked records</h3><ul>${links.map(l => `<li>${esc(l.target_module_key)}/${esc(l.target_record_type)}#${esc(l.target_record_id)} — ${esc(l.notes || '')}</li>`).join('')}</ul>` : ''}
<p style="margin-top:24px;font-size:10px;color:#555">SECH_LIMS by Nickland · ${new Date().toISOString().slice(0,19).replace('T',' ')}</p>
</body></html>`;
    audit(req, { action: 'print', entity: 'customer_feedback', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  return router;
}

export { STAKEHOLDER_TYPES, AGREEMENT_STATUSES, FEEDBACK_TYPES, FEEDBACK_STATUSES, URGENCY, SURVEY_TYPES, SURVEY_STATUSES, QUESTION_TYPES, COMMUNICATION_TYPES, COMMUNICATION_DIRECTIONS, COMMUNICATION_STATUSES, IMPORT_TYPES };
