import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, evidenceRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { canReachPersonalRecord, resolvePermission } from '../services/permissionResolver.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent, getCurrentStaffId } from './routeHelpers.js';
import { printSheet, htmlEscape, htmlText, signatureBlock } from '../utils/printLayout.js';
import {
  COMPETENCY_METHODS, COMPETENCY_METHOD_LABELS, COMPETENCY_AUDIENCES,
  COMPETENCY_ASSESSMENT_TYPES, COMPETENCY_ASSESSMENT_TYPE_LABELS, COMPETENCY_STATUSES,
  COMPETENCY_OUTCOMES, COMPETENCY_OUTCOME_LABELS, SUPERVISION_LEVELS, SUPERVISION_LEVEL_LABELS,
  SAMPLE_CHECK_TYPES, SAMPLE_CHECK_TYPE_LABELS, SAMPLE_AGREEMENTS,
  COMPETENCY_SCALE_4, labelise,
} from '../../shared/constants/competency.js';

/**
 * Competence — frameworks, structured assessments, and the record that comes
 * out of them.
 *
 * The register used to hold one row per assessment: an activity, a method, a
 * date and an outcome somebody typed. That is a conclusion without evidence,
 * and it cannot answer the two questions anybody reviewing competence asks —
 * against what standard was this person judged, and what did the assessor
 * actually see?
 *
 * So an assessment is now raised against a framework: a list of the elements
 * of a job, grouped by bench, each carrying the performance criteria that
 * define acceptable work. Raising the assessment copies that list onto the
 * record, so revising the framework later never rewrites a closed assessment.
 * Each element is then scored, evidenced and remarked on individually; the
 * score, the outcome and the level of supervision follow from the elements
 * rather than from an impression; and the record is signed by the assessor,
 * countersigned by a technical reviewer and acknowledged by the member of
 * staff, because a competence record the person never saw is not a record of
 * anything.
 */

const FRAMEWORK_STATUSES = ['draft', 'active', 'archived'];
const OPEN_STATUSES = ['planned', 'in_progress'];

const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { fs.mkdirSync(evidenceRoot, { recursive: true }); cb(null, evidenceRoot); },
    filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

type Row = Record<string, any>;

const oneOf = (list: readonly string[], value: unknown, fallback: string) =>
  (typeof value === 'string' && list.includes(value)) ? value : fallback;

const nullableText = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
};

const parseNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/**
 * The administrative override.
 *
 * Editing or removing a closed assessment, and editing a framework that is
 * already in force, are refused as a matter of course: a competence record is
 * meant to stay as it was signed. But mistakes get made and demonstration data
 * gets left behind, so somebody trusted with archival rights
 * (`personnel.training.void_archive`) may ask for the lock to be lifted for one
 * call. The request has to say so explicitly — the flag is never assumed — and
 * every such call is audited as an override so the departure from the norm is
 * on the record.
 */
const overrideRequested = (req: any) =>
  req.body?.adminOverride === true || req.body?.adminOverride === 'true' || req.query?.adminOverride === 'true';
const mayOverride = (req: any) =>
  !!req.user && resolvePermission(req.user.id, 'personnel.training', 'void_archive').allowed;
const adminOverride = (req: any) => overrideRequested(req) && mayOverride(req);

/**
 * Roll the scored elements up into a result.
 *
 * Weighted, and over the elements that were actually assessed: marking an
 * element "not applicable" takes it out of both the numerator and the
 * denominator rather than scoring it zero, so somebody assessed on eight of a
 * bench's twelve tasks is judged on those eight.
 */
function scoreAssessment(db: any, assessmentId: number | string) {
  const items = db.prepare('SELECT * FROM competency_assessment_items WHERE assessment_id = ?').all(assessmentId) as Row[];
  const assessment = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(assessmentId) as Row;
  const framework = assessment?.framework_id
    ? db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(assessment.framework_id) as Row | undefined
    : undefined;

  const applicable = items.filter(i => !i.not_applicable);
  const scored = applicable.filter(i => i.score !== null && i.score !== undefined);
  let earned = 0;
  let possible = 0;
  for (const item of scored) {
    const weight = Number(item.weight) || 1;
    earned += Number(item.score) * weight;
    possible += Number(item.max_score || 4) * weight;
  }
  const percent = possible > 0 ? (earned / possible) * 100 : null;

  // A floor applies per element as well as overall: a person can average well
  // and still be unable to do one thing the bench depends on.
  const floor = framework?.minimum_element_score === null || framework?.minimum_element_score === undefined
    ? null : Number(framework.minimum_element_score);
  const belowFloor = floor === null ? [] : scored.filter(i => Number(i.score) < floor);
  const criticalFailures = belowFloor.filter(i => i.is_critical).length;

  return {
    elementsTotal: items.length,
    elementsApplicable: applicable.length,
    elementsAssessed: scored.length,
    earned: Math.round(earned * 100) / 100,
    possible: Math.round(possible * 100) / 100,
    percent: percent === null ? null : Math.round(percent * 10) / 10,
    criticalFailures,
    elementsBelowFloor: belowFloor.length,
    passThreshold: framework ? Number(framework.pass_threshold_percent) : (assessment?.pass_threshold_percent ?? 75),
    criticalMustPass: framework ? Number(framework.critical_elements_must_pass) === 1 : true,
    minimumElementScore: floor,
  };
}

/** The outcome the scores point to. The assessor confirms or overrides it. */
function recommendOutcome(summary: ReturnType<typeof scoreAssessment>) {
  if (summary.percent === null) return null;
  if (summary.criticalMustPass && summary.criticalFailures > 0) return 'not_yet_competent';
  if (summary.percent >= summary.passThreshold) {
    return summary.elementsBelowFloor > 0 ? 'competent_with_supervision' : 'competent';
  }
  if (summary.percent >= summary.passThreshold - 15) return 'competent_with_supervision';
  return 'not_yet_competent';
}

const SUPERVISION_FOR_OUTCOME: Record<string, string> = {
  competent: 'independent',
  competent_with_supervision: 'indirect_supervision',
  not_yet_competent: 'not_authorised',
};

/** Add months to an ISO date, used for the next-assessment date. */
function addMonths(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  if (date.getUTCDate() < day) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function loadFramework(db: any, id: number | string) {
  const framework = db.prepare(`SELECT f.*, d.name AS department_name, s.name AS section_name, a.full_name AS approved_by_name
    FROM competency_frameworks f
    LEFT JOIN departments d ON d.id = f.department_id
    LEFT JOIN sections s ON s.id = f.section_id
    LEFT JOIN staff a ON a.id = f.approved_by_staff_id
    WHERE f.id = ?`).get(id) as Row | undefined;
  if (!framework) return null;
  framework.groups = db.prepare('SELECT * FROM competency_framework_groups WHERE framework_id = ? ORDER BY display_order, id').all(id);
  framework.elements = db.prepare('SELECT * FROM competency_framework_elements WHERE framework_id = ? ORDER BY display_order, id').all(id);
  framework.assessments_raised = (db.prepare('SELECT COUNT(*) AS c FROM competency_assessments WHERE framework_id = ?').get(id) as Row).c;
  return framework;
}

function loadAssessment(db: any, id: number | string) {
  const record = db.prepare(`SELECT c.*, s.full_name AS staff_name, s.employee_no, s.designation, s.personnel_category,
      a.full_name AS assessor_name, r.full_name AS reviewer_name, sec.name AS section_name, d.name AS department_name,
      p.title AS position_title, f.framework_code
    FROM competency_assessments c
    LEFT JOIN staff s ON s.id = c.staff_id
    LEFT JOIN staff a ON a.id = c.assessor_staff_id
    LEFT JOIN staff r ON r.id = c.reviewer_staff_id
    LEFT JOIN sections sec ON sec.id = c.section_id
    LEFT JOIN departments d ON d.id = c.department_id
    LEFT JOIN positions p ON p.id = c.position_id
    LEFT JOIN competency_frameworks f ON f.id = c.framework_id
    WHERE c.id = ?`).get(id) as Row | undefined;
  if (!record) return null;
  record.items = db.prepare(`SELECT i.*, st.full_name AS assessed_by_name, fl.original_name AS evidence_file_name
    FROM competency_assessment_items i
    LEFT JOIN staff st ON st.id = i.assessed_by_staff_id
    LEFT JOIN files fl ON fl.id = i.evidence_file_id
    WHERE i.assessment_id = ? ORDER BY i.display_order, i.id`).all(id);
  record.sample_checks = db.prepare('SELECT * FROM competency_sample_checks WHERE assessment_id = ? ORDER BY date_tested, id').all(id);
  record.attachments = db.prepare(`SELECT at.*, f.original_name, f.mime_type, f.size_bytes, u.full_name AS uploaded_by_name
    FROM competency_assessment_attachments at
    JOIN files f ON f.id = at.file_id
    LEFT JOIN users u ON u.id = at.uploaded_by
    WHERE at.assessment_id = ? ORDER BY at.created_at DESC`).all(id);
  record.links = db.prepare('SELECT * FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ?')
    .all('personnel', 'competency_assessments', String(id));
  record.authorizations = db.prepare(`SELECT t.*, sec.name AS section_name FROM technical_authorizations t
    LEFT JOIN sections sec ON sec.id = t.section_id WHERE t.competency_assessment_id = ? ORDER BY t.id DESC`).all(id);
  record.score_summary = scoreAssessment(db, id);
  return record;
}

export function competencyRoutes() {
  const router = Router();

  /* ══ Frameworks ══════════════════════════════════════════════════════ */

  router.get('/competency-frameworks', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('f.status = ?'); params.push(String(req.query.status)); }
    if (req.query.appliesTo) { filters.push('f.applies_to IN (?, ?)'); params.push(String(req.query.appliesTo), 'all_staff'); }
    if (req.query.sectionId) { filters.push('(f.section_id = ? OR f.section_id IS NULL)'); params.push(Number(req.query.sectionId)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT f.*, s.name AS section_name, d.name AS department_name,
        (SELECT COUNT(*) FROM competency_framework_elements e WHERE e.framework_id = f.id AND e.is_active = 1) AS element_count,
        (SELECT COUNT(*) FROM competency_framework_groups g WHERE g.framework_id = f.id AND g.is_active = 1) AS group_count,
        (SELECT COUNT(*) FROM competency_assessments c WHERE c.framework_id = f.id) AS assessment_count
      FROM competency_frameworks f
      LEFT JOIN sections s ON s.id = f.section_id
      LEFT JOIN departments d ON d.id = f.department_id
      ${where}
      ORDER BY CASE f.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, f.title`).all(...params));
  });

  router.post('/competency-frameworks', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.title);
    if (!title) return res.status(400).json({ error: 'A framework title is required.' });
    const code = nullableText(req.body.frameworkCode) || generateRecordNumber(db, 'competency_frameworks', 'CF', undefined, 'framework_code');
    if (db.prepare('SELECT 1 FROM competency_frameworks WHERE framework_code = ?').get(code)) {
      return res.status(400).json({ error: `Framework code ${code} is already in use.` });
    }
    const result = db.prepare(`INSERT INTO competency_frameworks
      (framework_code, title, applies_to, department_id, section_id, cadre, version_label, purpose, scope,
       max_score, pass_threshold_percent, minimum_element_score, critical_elements_must_pass, validity_months,
       requires_technical_review, requires_staff_acknowledgement, status, effective_date, next_review_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, title, oneOf(COMPETENCY_AUDIENCES, req.body.appliesTo, 'all_staff'),
        parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), nullableText(req.body.cadre),
        nullableText(req.body.versionLabel) || '1.0', nullableText(req.body.purpose), nullableText(req.body.scope),
        parseNumber(req.body.maxScore) ?? 4, parseNumber(req.body.passThresholdPercent) ?? 75,
        parseNumber(req.body.minimumElementScore), req.body.criticalElementsMustPass === false ? 0 : 1,
        parseNumber(req.body.validityMonths) ?? 12,
        req.body.requiresTechnicalReview === false ? 0 : 1, req.body.requiresStaffAcknowledgement === false ? 0 : 1,
        oneOf(FRAMEWORK_STATUSES, req.body.status, 'draft'),
        nullableText(req.body.effectiveDate), nullableText(req.body.nextReviewDate), req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'competency_frameworks', entityId: id, newValue: { code, title } });
    res.status(201).json({ id, frameworkCode: code });
  });

  router.get('/competency-frameworks/:id', requirePermission('personnel.training', 'view'), (req, res) => {
    const framework = loadFramework(getDb(), req.params.id);
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    res.json(framework);
  });

  router.put('/competency-frameworks/:id', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Framework not found' });
    db.prepare(`UPDATE competency_frameworks SET title = ?, applies_to = ?, department_id = ?, section_id = ?, cadre = ?,
        version_label = ?, purpose = ?, scope = ?, max_score = ?, pass_threshold_percent = ?, minimum_element_score = ?,
        critical_elements_must_pass = ?, validity_months = ?, requires_technical_review = ?, requires_staff_acknowledgement = ?,
        effective_date = ?, next_review_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.title) ?? old.title, oneOf(COMPETENCY_AUDIENCES, req.body.appliesTo, old.applies_to),
        parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), nullableText(req.body.cadre),
        nullableText(req.body.versionLabel) ?? old.version_label, nullableText(req.body.purpose), nullableText(req.body.scope),
        parseNumber(req.body.maxScore) ?? old.max_score, parseNumber(req.body.passThresholdPercent) ?? old.pass_threshold_percent,
        parseNumber(req.body.minimumElementScore), req.body.criticalElementsMustPass === false ? 0 : 1,
        parseNumber(req.body.validityMonths) ?? old.validity_months,
        req.body.requiresTechnicalReview === false ? 0 : 1, req.body.requiresStaffAcknowledgement === false ? 0 : 1,
        nullableText(req.body.effectiveDate), nullableText(req.body.nextReviewDate), req.params.id);
    audit(req, { action: 'edit', entity: 'competency_frameworks', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Activation is the approval step: a framework in use has been agreed by
  // somebody with the authority to agree it, and the record says who.
  router.post('/competency-frameworks/:id/status', requirePermission('personnel.training', 'approve'), (req, res) => {
    const db = getDb();
    const status = oneOf(FRAMEWORK_STATUSES, req.body.status, '');
    if (!status) return res.status(400).json({ error: `status must be one of: ${FRAMEWORK_STATUSES.join(', ')}` });
    const framework = db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    if (status === 'active') {
      const elements = (db.prepare('SELECT COUNT(*) AS c FROM competency_framework_elements WHERE framework_id = ? AND is_active = 1').get(req.params.id) as Row).c;
      if (!elements) return res.status(400).json({ error: 'Add at least one element before activating this framework.' });
      db.prepare(`UPDATE competency_frameworks SET status = 'active', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP,
          effective_date = COALESCE(effective_date, date('now')),
          next_review_date = COALESCE(next_review_date, date('now', '+1 year')), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    } else {
      db.prepare('UPDATE competency_frameworks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
    }
    audit(req, { action: status === 'active' ? 'approve' : 'edit', entity: 'competency_frameworks', entityId: req.params.id, oldValue: { status: framework.status }, newValue: { status } });
    res.json({ ok: true, status });
  });

  // Revising a framework in use means a new version, not an edit in place —
  // an assessment already raised was raised against what the framework said
  // at the time.
  router.post('/competency-frameworks/:id/duplicate', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const source = loadFramework(db, req.params.id);
    if (!source) return res.status(404).json({ error: 'Framework not found' });
    const code = nullableText(req.body.frameworkCode) || generateRecordNumber(db, 'competency_frameworks', 'CF', undefined, 'framework_code');
    const title = nullableText(req.body.title) || source.title;
    const version = nullableText(req.body.versionLabel) || `${source.version_label}.1`;
    const newId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO competency_frameworks
        (framework_code, title, applies_to, department_id, section_id, cadre, version_label, purpose, scope,
         max_score, pass_threshold_percent, minimum_element_score, critical_elements_must_pass, validity_months,
         requires_technical_review, requires_staff_acknowledgement, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
        .run(code, title, source.applies_to, source.department_id, source.section_id, source.cadre, version,
          source.purpose, source.scope, source.max_score, source.pass_threshold_percent, source.minimum_element_score,
          source.critical_elements_must_pass, source.validity_months, source.requires_technical_review,
          source.requires_staff_acknowledgement, req.user!.id);
      const id = Number(result.lastInsertRowid);
      const groupMap = new Map<number, number>();
      for (const group of source.groups as Row[]) {
        const g = db.prepare('INSERT INTO competency_framework_groups (framework_id, group_title, group_description, weight, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, group.group_title, group.group_description, group.weight, group.display_order, group.is_active);
        groupMap.set(group.id, Number(g.lastInsertRowid));
      }
      for (const element of source.elements as Row[]) {
        db.prepare(`INSERT INTO competency_framework_elements
          (framework_id, group_id, element_code, element_text, performance_criteria, expected_evidence, default_method, weight, is_critical, display_order, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, element.group_id ? groupMap.get(element.group_id) ?? null : null, element.element_code, element.element_text,
            element.performance_criteria, element.expected_evidence, element.default_method, element.weight,
            element.is_critical, element.display_order, element.is_active);
      }
      return id;
    })();
    audit(req, { action: 'create', entity: 'competency_frameworks', entityId: newId, newValue: { duplicatedFrom: req.params.id, code } });
    res.status(201).json({ id: newId, frameworkCode: code });
  });

  router.delete('/competency-frameworks/:id', requirePermission('personnel.training', 'void_archive'), (req, res) => {
    const db = getDb();
    const framework = db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    const used = (db.prepare('SELECT COUNT(*) AS c FROM competency_assessments WHERE framework_id = ?').get(req.params.id) as Row).c;
    if (used) return res.status(400).json({ error: `${used} assessment(s) were raised against this framework. Archive it instead of deleting it.` });
    db.transaction(() => {
      db.prepare('DELETE FROM competency_framework_elements WHERE framework_id = ?').run(req.params.id);
      db.prepare('DELETE FROM competency_framework_groups WHERE framework_id = ?').run(req.params.id);
      db.prepare('DELETE FROM competency_frameworks WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'competency_frameworks', entityId: req.params.id, oldValue: framework });
    res.json({ ok: true });
  });

  /* ── Framework groups and elements ── */

  router.post('/competency-frameworks/:id/groups', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.groupTitle);
    if (!title) return res.status(400).json({ error: 'A group title is required.' });
    if (!db.prepare('SELECT 1 FROM competency_frameworks WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Framework not found' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM competency_framework_groups WHERE framework_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare('INSERT INTO competency_framework_groups (framework_id, group_title, group_description, weight, display_order) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, title, nullableText(req.body.groupDescription), parseNumber(req.body.weight) ?? 1, parseNumber(req.body.displayOrder) ?? nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/competency-frameworks/:id/groups/:groupId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM competency_framework_groups WHERE id = ? AND framework_id = ?').get(req.params.groupId, req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Group not found' });
    db.prepare('UPDATE competency_framework_groups SET group_title = ?, group_description = ?, weight = ?, display_order = ?, is_active = ? WHERE id = ?')
      .run(nullableText(req.body.groupTitle) ?? old.group_title, nullableText(req.body.groupDescription),
        parseNumber(req.body.weight) ?? old.weight, parseNumber(req.body.displayOrder) ?? old.display_order,
        req.body.isActive === false ? 0 : 1, req.params.groupId);
    res.json({ ok: true });
  });

  router.delete('/competency-frameworks/:id/groups/:groupId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const group = db.prepare('SELECT * FROM competency_framework_groups WHERE id = ? AND framework_id = ?').get(req.params.groupId, req.params.id) as Row | undefined;
    if (!group) return res.status(404).json({ error: 'Group not found' });
    db.transaction(() => {
      db.prepare('DELETE FROM competency_framework_elements WHERE group_id = ?').run(req.params.groupId);
      db.prepare('DELETE FROM competency_framework_groups WHERE id = ?').run(req.params.groupId);
    })();
    audit(req, { action: 'delete', entity: 'competency_framework_groups', entityId: req.params.groupId, oldValue: group });
    res.json({ ok: true });
  });

  router.post('/competency-frameworks/:id/elements', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const text = nullableText(req.body.elementText);
    if (!text) return res.status(400).json({ error: 'An element description is required.' });
    if (!db.prepare('SELECT 1 FROM competency_frameworks WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Framework not found' });
    const groupId = parseIntNullable(req.body.groupId);
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM competency_framework_elements WHERE framework_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO competency_framework_elements
      (framework_id, group_id, element_code, element_text, performance_criteria, expected_evidence, default_method, weight, is_critical, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, groupId, nullableText(req.body.elementCode), text, nullableText(req.body.performanceCriteria),
        nullableText(req.body.expectedEvidence), oneOf(COMPETENCY_METHODS, req.body.defaultMethod, 'direct_observation'),
        parseNumber(req.body.weight) ?? 1, req.body.isCritical ? 1 : 0, parseNumber(req.body.displayOrder) ?? nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/competency-frameworks/:id/elements/:elementId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM competency_framework_elements WHERE id = ? AND framework_id = ?').get(req.params.elementId, req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Element not found' });
    db.prepare(`UPDATE competency_framework_elements SET group_id = ?, element_code = ?, element_text = ?, performance_criteria = ?,
        expected_evidence = ?, default_method = ?, weight = ?, is_critical = ?, display_order = ?, is_active = ? WHERE id = ?`)
      .run(parseIntNullable(req.body.groupId), nullableText(req.body.elementCode), nullableText(req.body.elementText) ?? old.element_text,
        nullableText(req.body.performanceCriteria), nullableText(req.body.expectedEvidence),
        oneOf(COMPETENCY_METHODS, req.body.defaultMethod, old.default_method), parseNumber(req.body.weight) ?? old.weight,
        req.body.isCritical ? 1 : 0, parseNumber(req.body.displayOrder) ?? old.display_order,
        req.body.isActive === false ? 0 : 1, req.params.elementId);
    res.json({ ok: true });
  });

  router.delete('/competency-frameworks/:id/elements/:elementId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const element = db.prepare('SELECT * FROM competency_framework_elements WHERE id = ? AND framework_id = ?').get(req.params.elementId, req.params.id) as Row | undefined;
    if (!element) return res.status(404).json({ error: 'Element not found' });
    db.prepare('DELETE FROM competency_framework_elements WHERE id = ?').run(req.params.elementId);
    audit(req, { action: 'delete', entity: 'competency_framework_elements', entityId: req.params.elementId, oldValue: element });
    res.json({ ok: true });
  });

  /**
   * Pull elements across from another framework.
   *
   * Frameworks overlap — half of what a bench is assessed on is the same
   * general laboratory practice assessed everywhere else — so the laboratory
   * should be able to state a group of elements once and reuse it, rather than
   * retyping it into every framework that needs it. The caller chooses what to
   * take: whole groups (heading and all their elements), individual elements,
   * or the source framework entire. A group is merged into a target group of
   * the same title where one already exists, so importing twice does not leave
   * two "General laboratory practice" headings side by side.
   */
  router.post('/competency-frameworks/:id/import-elements', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const target = db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!target) return res.status(404).json({ error: 'Framework not found' });

    const sourceId = parseIntNullable(req.body.sourceFrameworkId);
    const source = sourceId ? loadFramework(db, sourceId) : null;
    if (!source) return res.status(400).json({ error: 'Choose a framework to copy from.' });
    if (String(source.id) === String(target.id)) return res.status(400).json({ error: 'A framework cannot import from itself.' });

    const importAll = req.body.importAll === true;
    const groupIds = new Set<number>((Array.isArray(req.body.groupIds) ? req.body.groupIds : []).map(Number).filter((n: number) => Number.isFinite(n)));
    const elementIds = new Set<number>((Array.isArray(req.body.elementIds) ? req.body.elementIds : []).map(Number).filter((n: number) => Number.isFinite(n)));

    const sourceGroups = (source.groups as Row[]);
    const sourceElements = (source.elements as Row[]).filter(e => e.is_active);
    const wantGroupIds = importAll ? new Set<number>(sourceGroups.filter(g => g.is_active).map(g => g.id)) : groupIds;
    const elementsToCopy = sourceElements.filter(e =>
      importAll || (e.group_id && wantGroupIds.has(e.group_id)) || elementIds.has(e.id));

    if (elementsToCopy.length === 0 && wantGroupIds.size === 0) {
      return res.status(400).json({ error: 'Select at least one group or element to copy.' });
    }

    const sourceGroupById = new Map<number, Row>(sourceGroups.map(g => [g.id, g]));

    const copied = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM competency_framework_groups WHERE framework_id = ? AND is_active = 1').all(target.id) as Row[];
      const byTitle = new Map<string, number>(existing.map(g => [String(g.group_title).trim().toLowerCase(), g.id]));
      const groupMap = new Map<number, number>();
      let groupOrder = Number((db.prepare('SELECT COALESCE(MAX(display_order), 0) AS o FROM competency_framework_groups WHERE framework_id = ?').get(target.id) as Row).o);
      let elementOrder = Number((db.prepare('SELECT COALESCE(MAX(display_order), 0) AS o FROM competency_framework_elements WHERE framework_id = ?').get(target.id) as Row).o);

      const ensureGroup = (sourceGroupId?: number | null): number | null => {
        if (!sourceGroupId) return null;
        if (groupMap.has(sourceGroupId)) return groupMap.get(sourceGroupId)!;
        const group = sourceGroupById.get(sourceGroupId);
        if (!group) return null;
        const key = String(group.group_title).trim().toLowerCase();
        if (byTitle.has(key)) { groupMap.set(sourceGroupId, byTitle.get(key)!); return byTitle.get(key)!; }
        groupOrder += 10;
        const inserted = db.prepare('INSERT INTO competency_framework_groups (framework_id, group_title, group_description, weight, display_order) VALUES (?, ?, ?, ?, ?)')
          .run(target.id, group.group_title, group.group_description, group.weight, groupOrder);
        const newId = Number(inserted.lastInsertRowid);
        groupMap.set(sourceGroupId, newId); byTitle.set(key, newId);
        return newId;
      };

      // Selected groups create their heading even before their elements land,
      // so an intentionally empty group still comes across.
      for (const gid of wantGroupIds) ensureGroup(gid);

      const insert = db.prepare(`INSERT INTO competency_framework_elements
        (framework_id, group_id, element_code, element_text, performance_criteria, expected_evidence, default_method, weight, is_critical, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let count = 0;
      for (const element of elementsToCopy) {
        elementOrder += 10;
        insert.run(target.id, ensureGroup(element.group_id), element.element_code, element.element_text,
          element.performance_criteria, element.expected_evidence, element.default_method, element.weight,
          element.is_critical, elementOrder);
        count++;
      }
      return count;
    })();

    audit(req, { action: 'edit', entity: 'competency_frameworks', entityId: target.id, newValue: { importedFrom: source.id, importedElements: copied } });
    res.status(201).json({ ok: true, copied });
  });

  /* ══ Assessments ═════════════════════════════════════════════════════ */

  router.get('/competency', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('c.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.status) { filters.push('c.status = ?'); params.push(String(req.query.status)); }
    if (req.query.outcome) { filters.push('c.outcome = ?'); params.push(String(req.query.outcome)); }
    if (req.query.frameworkId) { filters.push('c.framework_id = ?'); params.push(Number(req.query.frameworkId)); }
    if (req.query.sectionId) { filters.push('c.section_id = ?'); params.push(Number(req.query.sectionId)); }
    if (req.query.assessmentType) { filters.push('c.assessment_type = ?'); params.push(String(req.query.assessmentType)); }
    if (req.query.from) { filters.push('c.assessment_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push('c.assessment_date <= ?'); params.push(String(req.query.to)); }
    if (req.query.dueBy) { filters.push('c.next_assessment_due IS NOT NULL AND c.next_assessment_due <= ?'); params.push(String(req.query.dueBy)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT c.*, s.full_name AS staff_name, s.employee_no, a.full_name AS assessor_name,
        r.full_name AS reviewer_name, sec.name AS section_name, f.framework_code
      FROM competency_assessments c
      LEFT JOIN staff s ON s.id = c.staff_id
      LEFT JOIN staff a ON a.id = c.assessor_staff_id
      LEFT JOIN staff r ON r.id = c.reviewer_staff_id
      LEFT JOIN sections sec ON sec.id = c.section_id
      LEFT JOIN competency_frameworks f ON f.id = c.framework_id
      ${where}
      ORDER BY c.assessment_date DESC, c.id DESC`).all(...params));
  });

  /**
   * Raise an assessment. With a framework, the elements are copied onto the
   * record here and now; without one, the record starts empty and elements are
   * added by hand, which is what an ad-hoc assessment of a single task needs.
   */
  router.post('/competency', requirePermission('personnel.training', 'create'), (req, res) => {
    const db = getDb();
    const staffId = parseIntNullable(req.body.staffId);
    if (!staffId) return res.status(400).json({ error: 'A member of staff is required.' });
    const assessmentDate = nullableText(req.body.assessmentDate);
    if (!assessmentDate) return res.status(400).json({ error: 'An assessment date is required.' });

    const frameworkId = parseIntNullable(req.body.frameworkId);
    const framework = frameworkId ? loadFramework(db, frameworkId) : null;
    if (frameworkId && !framework) return res.status(400).json({ error: 'The chosen framework no longer exists.' });
    if (framework && framework.status === 'archived') return res.status(400).json({ error: 'That framework has been archived and cannot be used for a new assessment.' });

    const activity = nullableText(req.body.activity) || framework?.title;
    if (!activity) return res.status(400).json({ error: 'Choose a framework, or describe the activity being assessed.' });

    const status = oneOf(COMPETENCY_STATUSES, req.body.status, 'planned');
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'competency_assessments', 'COMP', createdAt, 'competency_number');
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId) as Row | undefined;
    // The unit is on the staff record; the department it belongs to is not, so
    // it is read back through the section rather than left blank.
    const sectionId = parseIntNullable(req.body.sectionId) ?? framework?.section_id ?? staff?.section_id ?? null;
    const departmentId = parseIntNullable(req.body.departmentId) ?? framework?.department_id
      ?? (sectionId ? (db.prepare('SELECT department_id FROM sections WHERE id = ?').get(sectionId) as Row | undefined)?.department_id ?? null : null);

    const id = db.transaction(() => {
      const result = db.prepare(`INSERT INTO competency_assessments
        (competency_number, staff_id, department_id, section_id, position_id, activity, assessment_method, assessor_staff_id,
         assessment_date, status, framework_id, framework_title, framework_version, assessment_type, assessment_reason,
         period_label, max_score, pass_threshold_percent, next_assessment_due, findings, authorization_recommendation,
         created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(number, staffId, departmentId, sectionId, parseIntNullable(req.body.positionId),
          activity, oneOf(COMPETENCY_METHODS, req.body.assessmentMethod, 'direct_observation'),
          getStaffIdOrCurrent(req, req.body.assessorStaffId), assessmentDate, status,
          frameworkId, framework?.title ?? null, framework?.version_label ?? null,
          oneOf(COMPETENCY_ASSESSMENT_TYPES, req.body.assessmentType, 'initial'),
          nullableText(req.body.assessmentReason), nullableText(req.body.periodLabel),
          framework ? Number(framework.max_score) : 4,
          framework ? Number(framework.pass_threshold_percent) : 75,
          nullableText(req.body.nextAssessmentDue), nullableText(req.body.findings),
          nullableText(req.body.authorizationRecommendation), req.user!.id, createdAt);
      const assessmentId = Number(result.lastInsertRowid);

      if (framework) {
        const groups = new Map<number, Row>((framework.groups as Row[]).map(g => [g.id, g]));
        const insert = db.prepare(`INSERT INTO competency_assessment_items
          (assessment_id, framework_element_id, group_title, element_code, element_text, performance_criteria,
           expected_evidence, method, max_score, weight, is_critical, display_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        let order = 0;
        for (const element of framework.elements as Row[]) {
          if (!element.is_active) continue;
          insert.run(assessmentId, element.id, element.group_id ? groups.get(element.group_id)?.group_title ?? null : null,
            element.element_code, element.element_text, element.performance_criteria, element.expected_evidence,
            element.default_method, Number(framework.max_score), element.weight, element.is_critical, order += 10);
        }
        db.prepare('UPDATE competency_assessments SET elements_total = (SELECT COUNT(*) FROM competency_assessment_items WHERE assessment_id = ?) WHERE id = ?')
          .run(assessmentId, assessmentId);
      }
      return assessmentId;
    })();

    audit(req, { action: 'create', entity: 'competency_assessments', entityId: id, newValue: { number, staffId, frameworkId, activity } });
    res.status(201).json({ id, competencyNumber: number });
  });

  // Guarded per record rather than by a blanket feature check, so the person
  // an assessment is about can always open their own.
  router.get('/competency/:id', requireAuth, (req, res) => {
    const record = loadAssessment(getDb(), req.params.id);
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (!canReachPersonalRecord(req.user!.id, 'personnel.training', 'view', record.staff_id ?? null, getCurrentStaffId(req))) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.json(record);
  });

  router.put('/competency/:id', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Competency assessment not found' });
    const override = adminOverride(req);
    if (['completed', 'acknowledged'].includes(old.status) && !override) {
      return res.status(400).json({ error: 'A completed assessment cannot be edited. Raise a new assessment instead.' });
    }
    db.prepare(`UPDATE competency_assessments SET activity = ?, section_id = ?, department_id = ?, position_id = ?,
        assessor_staff_id = ?, reviewer_staff_id = ?, assessment_date = ?, assessment_type = ?, assessment_reason = ?,
        period_label = ?, assessment_method = ?, findings = ?, assessor_comments = ?, development_plan = ?,
        next_assessment_due = ?, authorization_recommendation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.activity) ?? old.activity, parseIntNullable(req.body.sectionId) ?? old.section_id,
        parseIntNullable(req.body.departmentId) ?? old.department_id, parseIntNullable(req.body.positionId),
        parseIntNullable(req.body.assessorStaffId) ?? old.assessor_staff_id, parseIntNullable(req.body.reviewerStaffId),
        nullableText(req.body.assessmentDate) ?? old.assessment_date,
        oneOf(COMPETENCY_ASSESSMENT_TYPES, req.body.assessmentType, old.assessment_type),
        nullableText(req.body.assessmentReason), nullableText(req.body.periodLabel),
        oneOf(COMPETENCY_METHODS, req.body.assessmentMethod, old.assessment_method),
        nullableText(req.body.findings), nullableText(req.body.assessorComments), nullableText(req.body.developmentPlan),
        nullableText(req.body.nextAssessmentDue), nullableText(req.body.authorizationRecommendation), req.params.id);
    audit(req, { action: override ? 'override_edit' : 'edit', entity: 'competency_assessments', entityId: req.params.id, oldValue: old, newValue: { ...req.body, adminOverride: override } });
    res.json({ ok: true });
  });

  router.delete('/competency/:id', requirePermission('personnel.training', 'void_archive'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    // A closed assessment can only be deleted under an explicit administrative
    // override; ordinarily just an open one can be removed and the rest cancelled.
    const override = adminOverride(req);
    if (!OPEN_STATUSES.includes(record.status) && !override) {
      return res.status(400).json({ error: 'Only a planned or in-progress assessment can be removed. Cancel this one instead.' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM competency_assessment_items WHERE assessment_id = ?').run(req.params.id);
      db.prepare('DELETE FROM competency_sample_checks WHERE assessment_id = ?').run(req.params.id);
      db.prepare('DELETE FROM competency_assessment_attachments WHERE assessment_id = ?').run(req.params.id);
      // A closed assessment may have left evidence in the cross-module register,
      // an authorisation granted from it, and links to and from other records.
      // Clear those too, or deleting the record leaves them pointing at nothing.
      db.prepare('DELETE FROM evidence_files WHERE record_type = ? AND record_id = ?').run('competency_assessments', String(req.params.id));
      db.prepare('DELETE FROM technical_authorizations WHERE competency_assessment_id = ?').run(req.params.id);
      db.prepare('DELETE FROM record_links WHERE (source_record_type = ? AND source_record_id = ?) OR (target_record_type = ? AND target_record_id = ?)')
        .run('competency_assessments', String(req.params.id), 'competency_assessments', String(req.params.id));
      db.prepare('DELETE FROM competency_assessments WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: override ? 'override_delete' : 'delete', entity: 'competency_assessments', entityId: req.params.id, oldValue: { ...record, adminOverride: override } });
    res.json({ ok: true });
  });

  /* ── Scoring the elements ── */

  function assertScorable(record: Row | undefined, allowClosed = false) {
    if (!record) return 'Competency assessment not found';
    if (!allowClosed && ['completed', 'acknowledged', 'cancelled'].includes(record.status)) return 'This assessment is closed and can no longer be scored.';
    return null;
  }

  /** Save a page of scores in one go, which is how an assessor actually works. */
  router.put('/competency/:id/items', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    const problem = assertScorable(record, adminOverride(req));
    if (problem) return res.status(record ? 400 : 404).json({ error: problem });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No element scores were supplied.' });
    const assessorStaffId = getStaffIdOrCurrent(req, req.body.assessedByStaffId);

    const update = db.prepare(`UPDATE competency_assessment_items SET score = ?, method = ?, not_applicable = ?,
      observed_date = ?, evidence_note = ?, remarks = ?, assessed_by_staff_id = ?, assessed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND assessment_id = ?`);
    let saved = 0;
    db.transaction(() => {
      for (const item of items) {
        const itemId = parseIntNullable(item.id);
        if (!itemId) continue;
        const existing = db.prepare('SELECT * FROM competency_assessment_items WHERE id = ? AND assessment_id = ?').get(itemId, req.params.id) as Row | undefined;
        if (!existing) continue;
        const notApplicable = item.notApplicable ? 1 : 0;
        let score = notApplicable ? null : parseNumber(item.score);
        if (score !== null) score = Math.max(0, Math.min(Number(existing.max_score) || 4, score));
        update.run(score, oneOf(COMPETENCY_METHODS, item.method, existing.method || 'direct_observation'), notApplicable,
          nullableText(item.observedDate), nullableText(item.evidenceNote), nullableText(item.remarks),
          score === null && !notApplicable ? existing.assessed_by_staff_id : assessorStaffId, itemId, req.params.id);
        saved++;
      }
      const summary = scoreAssessment(db, req.params.id);
      db.prepare(`UPDATE competency_assessments SET total_score = ?, max_score = ?, score_percent = ?,
        elements_assessed = ?, elements_total = ?, critical_failures = ?,
        status = CASE WHEN status = 'planned' THEN 'in_progress' ELSE status END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(summary.earned, record!.max_score ?? 4, summary.percent, summary.elementsAssessed, summary.elementsTotal,
          summary.criticalFailures, req.params.id);
    })();
    audit(req, { action: 'edit', entity: 'competency_assessment_items', entityId: req.params.id, newValue: { saved } });
    res.json({ ok: true, saved, summary: scoreAssessment(db, req.params.id) });
  });

  /** An element the framework did not anticipate, added to this record only. */
  router.post('/competency/:id/items', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    const problem = assertScorable(record, adminOverride(req));
    if (problem) return res.status(record ? 400 : 404).json({ error: problem });
    const text = nullableText(req.body.elementText);
    if (!text) return res.status(400).json({ error: 'An element description is required.' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM competency_assessment_items WHERE assessment_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO competency_assessment_items
      (assessment_id, group_title, element_code, element_text, performance_criteria, expected_evidence, method, max_score, weight, is_critical, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, nullableText(req.body.groupTitle) || 'Additional elements', nullableText(req.body.elementCode), text,
        nullableText(req.body.performanceCriteria), nullableText(req.body.expectedEvidence),
        oneOf(COMPETENCY_METHODS, req.body.method, 'direct_observation'),
        parseNumber(req.body.maxScore) ?? (Number(record!.max_score) || 4), parseNumber(req.body.weight) ?? 1,
        req.body.isCritical ? 1 : 0, nextOrder);
    db.prepare('UPDATE competency_assessments SET elements_total = (SELECT COUNT(*) FROM competency_assessment_items WHERE assessment_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.params.id, req.params.id);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.delete('/competency/:id/items/:itemId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    const problem = assertScorable(record, adminOverride(req));
    if (problem) return res.status(record ? 400 : 404).json({ error: problem });
    const item = db.prepare('SELECT * FROM competency_assessment_items WHERE id = ? AND assessment_id = ?').get(req.params.itemId, req.params.id) as Row | undefined;
    if (!item) return res.status(404).json({ error: 'Element not found on this assessment' });
    db.prepare('DELETE FROM competency_assessment_items WHERE id = ?').run(req.params.itemId);
    db.prepare('UPDATE competency_assessments SET elements_total = (SELECT COUNT(*) FROM competency_assessment_items WHERE assessment_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.params.id, req.params.id);
    res.json({ ok: true });
  });

  /* ── Objective sample checks ── */

  router.post('/competency/:id/sample-checks', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    const problem = assertScorable(record, adminOverride(req));
    if (problem) return res.status(record ? 400 : 404).json({ error: problem });
    const result = db.prepare(`INSERT INTO competency_sample_checks
      (assessment_id, check_type, sample_id, date_tested, test_performed, staff_result, reference_result, agreement, remarks, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, oneOf(SAMPLE_CHECK_TYPES, req.body.checkType, 'proficiency_testing'), nullableText(req.body.sampleId),
        nullableText(req.body.dateTested), nullableText(req.body.testPerformed), nullableText(req.body.staffResult),
        nullableText(req.body.referenceResult), oneOf(SAMPLE_AGREEMENTS, req.body.agreement, 'not_evaluated'),
        nullableText(req.body.remarks), req.user!.id);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.delete('/competency/:id/sample-checks/:checkId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const check = db.prepare('SELECT * FROM competency_sample_checks WHERE id = ? AND assessment_id = ?').get(req.params.checkId, req.params.id) as Row | undefined;
    if (!check) return res.status(404).json({ error: 'Sample check not found' });
    db.prepare('DELETE FROM competency_sample_checks WHERE id = ?').run(req.params.checkId);
    res.json({ ok: true });
  });

  /* ── Evidence ── */

  router.post('/competency/:id/attachments', requirePermission('personnel.training', 'edit'), evidenceUpload.single('file'), (req, res) => {
    const db = getDb();
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) {
      fs.unlink(path.join(evidenceRoot, req.file.filename), () => undefined);
      return res.status(404).json({ error: 'Competency assessment not found' });
    }
    const attachmentId = db.transaction(() => {
      const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.file!.originalname, req.file!.filename, req.file!.mimetype, req.file!.size, 'evidence', req.user!.id);
      const fileId = Number(file.lastInsertRowid);
      const attachment = db.prepare('INSERT INTO competency_assessment_attachments (assessment_id, file_id, title, description, uploaded_by) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, fileId, nullableText(req.body.title) || req.file!.originalname, nullableText(req.body.description), req.user!.id);
      // Also index it in the cross-module evidence register, so an auditor
      // pulling evidence for a record finds this without knowing the module.
      db.prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fileId, 'personnel', 'competency_assessments', String(req.params.id), nullableText(req.body.description), req.user!.id);
      // An element may name the attachment as its own proof.
      const itemId = parseIntNullable(req.body.itemId);
      if (itemId) db.prepare('UPDATE competency_assessment_items SET evidence_file_id = ? WHERE id = ? AND assessment_id = ?').run(fileId, itemId, req.params.id);
      return Number(attachment.lastInsertRowid);
    })();
    audit(req, { action: 'create', entity: 'competency_assessment_attachments', entityId: attachmentId, newValue: { assessmentId: req.params.id, name: req.file.originalname } });
    res.status(201).json({ id: attachmentId });
  });

  router.delete('/competency/:id/attachments/:attachmentId', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const attachment = db.prepare('SELECT * FROM competency_assessment_attachments WHERE id = ? AND assessment_id = ?').get(req.params.attachmentId, req.params.id) as Row | undefined;
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    db.transaction(() => {
      db.prepare('UPDATE competency_assessment_items SET evidence_file_id = NULL WHERE evidence_file_id = ? AND assessment_id = ?').run(attachment.file_id, req.params.id);
      db.prepare('DELETE FROM evidence_files WHERE file_id = ? AND record_type = ? AND record_id = ?').run(attachment.file_id, 'competency_assessments', String(req.params.id));
      db.prepare('DELETE FROM competency_assessment_attachments WHERE id = ?').run(req.params.attachmentId);
    })();
    audit(req, { action: 'delete', entity: 'competency_assessment_attachments', entityId: req.params.attachmentId, oldValue: attachment });
    res.json({ ok: true });
  });

  /* ── Workflow ── */

  router.post('/competency/:id/submit', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (!OPEN_STATUSES.includes(record.status)) return res.status(400).json({ error: 'Only an open assessment can be submitted for review.' });
    const summary = scoreAssessment(db, req.params.id);
    if (summary.elementsTotal > 0 && summary.elementsAssessed === 0) {
      return res.status(400).json({ error: 'Score at least one element before submitting the assessment.' });
    }
    db.prepare(`UPDATE competency_assessments SET status = 'pending_review', reviewer_staff_id = COALESCE(?, reviewer_staff_id),
      assessor_comments = COALESCE(?, assessor_comments), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.reviewerStaffId), nullableText(req.body.assessorComments), req.params.id);
    audit(req, { action: 'submit', entity: 'competency_assessments', entityId: req.params.id, oldValue: { status: record.status }, newValue: { status: 'pending_review' } });
    res.json({ ok: true, summary });
  });

  /** What the scores add up to, before anybody commits to an outcome. */
  router.get('/competency/:id/score-summary', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM competency_assessments WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Competency assessment not found' });
    const summary = scoreAssessment(db, req.params.id);
    res.json({ ...summary, recommendedOutcome: recommendOutcome(summary) });
  });

  /**
   * Close the assessment. The score is recomputed here rather than trusted
   * from the request, the outcome defaults to what the elements point to, and
   * an unsatisfactory outcome raises a retraining action against the person's
   * name so it is somebody's job rather than a note in a field.
   */
  router.post('/competency/:id/complete', requirePermission('personnel.training', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (['completed', 'acknowledged'].includes(record.status)) return res.status(400).json({ error: 'This assessment is already completed.' });

    const summary = scoreAssessment(db, req.params.id);
    const recommended = recommendOutcome(summary);
    const outcome = oneOf(COMPETENCY_OUTCOMES, req.body.outcome, recommended ?? '');
    if (!outcome) return res.status(400).json({ error: `outcome must be one of: ${COMPETENCY_OUTCOMES.join(', ')}` });
    if (recommended && outcome !== recommended && !nullableText(req.body.overrideReason)) {
      return res.status(400).json({ error: `The scores point to "${COMPETENCY_OUTCOME_LABELS[recommended]}". Give a reason for recording a different outcome.` });
    }

    const framework = record.framework_id ? db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(record.framework_id) as Row | undefined : undefined;
    const validity = framework ? Number(framework.validity_months) : 12;
    const nextDue = nullableText(req.body.nextAssessmentDue)
      ?? record.next_assessment_due
      ?? addMonths(String(record.assessment_date), outcome === 'not_yet_competent' ? Math.min(3, validity) : validity);
    const supervision = oneOf(SUPERVISION_LEVELS, req.body.supervisionLevel, SUPERVISION_FOR_OUTCOME[outcome]);
    const retraining = outcome === 'not_yet_competent' ? 1 : (req.body.retrainingRequired ? 1 : 0);
    const comments = nullableText(req.body.assessorComments);
    const overrideReason = nullableText(req.body.overrideReason);

    const actionId = db.transaction(() => {
      db.prepare(`UPDATE competency_assessments SET outcome = ?, status = 'completed', supervision_level = ?,
          total_score = ?, score_percent = ?, elements_assessed = ?, elements_total = ?, critical_failures = ?,
          pass_threshold_percent = ?, retraining_required = ?, next_assessment_due = ?,
          findings = COALESCE(?, findings), assessor_comments = COALESCE(?, assessor_comments),
          development_plan = COALESCE(?, development_plan),
          authorization_recommendation = COALESCE(?, authorization_recommendation),
          completed_at = CURRENT_TIMESTAMP, completed_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(outcome, supervision, summary.earned, summary.percent, summary.elementsAssessed, summary.elementsTotal,
          summary.criticalFailures, summary.passThreshold, retraining, nextDue,
          nullableText(req.body.findings),
          overrideReason ? `${comments ? `${comments}\n\n` : ''}Outcome recorded as "${COMPETENCY_OUTCOME_LABELS[outcome]}" against a scored recommendation of "${COMPETENCY_OUTCOME_LABELS[recommended!]}": ${overrideReason}` : comments,
          nullableText(req.body.developmentPlan), nullableText(req.body.authorizationRecommendation),
          getStaffIdOrCurrent(req, null), req.params.id);

      if (retraining && req.body.createRetrainingAction !== false) {
        const action = db.prepare(`INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, status, due_date, evidence_required, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`Retraining and re-assessment: ${record.activity}`, 'personnel', 'personnel', String(req.params.id),
            `Competency assessment ${record.competency_number} closed as "${COMPETENCY_OUTCOME_LABELS[outcome]}". ${nullableText(req.body.developmentPlan) || 'Agree a retraining plan, deliver it, and re-assess before independent work resumes.'}`,
            'high', record.staff_id, 'Not started', nextDue, 1, req.user!.id);
        const id = Number(action.lastInsertRowid);
        db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run('personnel', 'competency_assessments', String(req.params.id), 'actions', 'actions', String(id), 'Retraining and re-assessment');
        return id;
      }
      // Somebody found not yet competent must not keep working unsupervised on
      // the strength of an earlier assessment, so any standing authorisation
      // for this assessment is withdrawn as the record closes.
      if (outcome === 'not_yet_competent') {
        db.prepare('UPDATE technical_authorizations SET is_active = 0 WHERE competency_assessment_id = ?').run(req.params.id);
      }
      return null;
    })();

    audit(req, {
      action: 'complete', entity: 'competency_assessments', entityId: req.params.id,
      oldValue: { status: record.status, outcome: record.outcome },
      newValue: { outcome, supervision, scorePercent: summary.percent, recommended, overrideReason, retrainingActionId: actionId },
    });
    res.json({ ok: true, outcome, supervisionLevel: supervision, summary, retrainingActionId: actionId });
  });

  /** The countersignature: a second, technically competent pair of eyes. */
  router.post('/competency/:id/review', requirePermission('personnel.training', 'approve'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (!['pending_review', 'completed', 'acknowledged'].includes(record.status)) {
      return res.status(400).json({ error: 'Only a submitted or completed assessment can be reviewed.' });
    }
    const reviewerStaffId = getStaffIdOrCurrent(req, req.body.reviewerStaffId);
    if (reviewerStaffId && reviewerStaffId === record.assessor_staff_id) {
      return res.status(400).json({ error: 'The technical review must be carried out by somebody other than the assessor.' });
    }
    db.prepare('UPDATE competency_assessments SET reviewer_staff_id = ?, reviewer_comments = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reviewerStaffId, nullableText(req.body.reviewerComments), req.params.id);
    audit(req, { action: 'review', entity: 'competency_assessments', entityId: req.params.id, newValue: { reviewerStaffId } });
    res.json({ ok: true });
  });

  /**
   * The member of staff signs their own record. Only they can: the route
   * checks the signed-in user against the staff member on the assessment.
   */
  router.post('/competency/:id/acknowledge', requireAuth, (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (record.status !== 'completed') return res.status(400).json({ error: 'The assessment has to be completed before it can be acknowledged.' });
    const staffId = getCurrentStaffId(req);
    if (!staffId) return res.status(400).json({ error: 'Your user account is not linked to a staff record, so you cannot sign this.' });
    if (staffId !== record.staff_id) return res.status(403).json({ error: 'An assessment can only be acknowledged by the member of staff it was carried out on.' });
    db.prepare(`UPDATE competency_assessments SET status = 'acknowledged', staff_comments = ?, staff_acknowledged_at = CURRENT_TIMESTAMP,
      staff_acknowledged_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.staffComments), req.user!.id, req.params.id);
    audit(req, { action: 'acknowledge', entity: 'competency_assessments', entityId: req.params.id, newValue: { staffId } });
    res.json({ ok: true });
  });

  router.post('/competency/:id/cancel', requirePermission('personnel.training', 'void_archive'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (['completed', 'acknowledged'].includes(record.status)) return res.status(400).json({ error: 'A completed assessment cannot be cancelled.' });
    const reason = nullableText(req.body.reason);
    if (!reason) return res.status(400).json({ error: 'Give a reason for cancelling this assessment.' });
    db.prepare("UPDATE competency_assessments SET status = 'cancelled', findings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(`${record.findings ? `${record.findings}\n\n` : ''}Cancelled: ${reason}`, req.params.id);
    audit(req, { action: 'cancel', entity: 'competency_assessments', entityId: req.params.id, oldValue: { status: record.status }, newValue: { reason } });
    res.json({ ok: true });
  });

  /** Authorisation to do the work follows from the assessment that proved it. */
  router.post('/competency/:id/create-authorization', requirePermission('personnel.training', 'approve'), (req, res) => {
    const db = getDb();
    const moduleKey = nullableText(req.body.moduleKey);
    const level = nullableText(req.body.level);
    if (!moduleKey || !level) return res.status(400).json({ error: 'moduleKey and level are required' });
    const record = db.prepare('SELECT * FROM competency_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Competency assessment not found' });
    if (record.status !== 'completed' && record.status !== 'acknowledged') {
      return res.status(400).json({ error: 'Complete the assessment before granting an authorisation from it.' });
    }
    if (record.outcome === 'not_yet_competent') return res.status(400).json({ error: 'An assessment closed as not yet competent cannot authorise anybody.' });

    const framework = record.framework_id ? db.prepare('SELECT * FROM competency_frameworks WHERE id = ?').get(record.framework_id) as Row | undefined : undefined;
    const expires = nullableText(req.body.expiresAt)
      ?? record.next_assessment_due
      ?? addMonths(String(record.assessment_date), framework ? Number(framework.validity_months) : 12);
    const notes = nullableText(req.body.notes)
      ?? (record.supervision_level ? SUPERVISION_LEVEL_LABELS[record.supervision_level] : null);

    const authId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO technical_authorizations
        (staff_id, position_id, module_key, section_id, level, is_active, expires_at, competency_assessment_id, created_by, notes)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(record.staff_id, parseIntNullable(req.body.positionId) ?? record.position_id, moduleKey,
          parseIntNullable(req.body.sectionId) ?? record.section_id, level, expires, req.params.id, req.user!.id, notes);
      const id = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('personnel', 'competency_assessments', String(req.params.id), 'personnel', 'technical_authorizations', String(id), 'Authorisation granted from competency assessment');
      return id;
    })();
    audit(req, { action: 'create_authorization', entity: 'technical_authorizations', entityId: authId, newValue: { competencyAssessmentId: req.params.id, moduleKey, level, expires } });
    res.status(201).json({ id: authId, expiresAt: expires });
  });

  /* ══ Overview and matrix ═════════════════════════════════════════════ */

  router.get('/competency-overview', requirePermission('personnel.training', 'view'), (_req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params) as Row).c);
    res.json({
      activeFrameworks: count("SELECT COUNT(*) c FROM competency_frameworks WHERE status = 'active'"),
      draftFrameworks: count("SELECT COUNT(*) c FROM competency_frameworks WHERE status = 'draft'"),
      openAssessments: count("SELECT COUNT(*) c FROM competency_assessments WHERE status IN ('planned','in_progress')"),
      awaitingReview: count("SELECT COUNT(*) c FROM competency_assessments WHERE status = 'pending_review'"),
      awaitingAcknowledgement: count("SELECT COUNT(*) c FROM competency_assessments WHERE status = 'completed'"),
      overdue: count('SELECT COUNT(*) c FROM competency_assessments WHERE next_assessment_due IS NOT NULL AND next_assessment_due < ?', today),
      dueSoon: count('SELECT COUNT(*) c FROM competency_assessments WHERE next_assessment_due IS NOT NULL AND next_assessment_due BETWEEN ? AND ?', today, soon),
      notYetCompetent: count("SELECT COUNT(*) c FROM competency_assessments WHERE outcome = 'not_yet_competent' AND status IN ('completed','acknowledged')"),
      staffAssessedThisYear: count("SELECT COUNT(DISTINCT staff_id) c FROM competency_assessments WHERE strftime('%Y', assessment_date) = strftime('%Y','now') AND status IN ('completed','acknowledged')"),
      staffNeverAssessed: count("SELECT COUNT(*) c FROM staff WHERE is_active = 1 AND id NOT IN (SELECT staff_id FROM competency_assessments WHERE staff_id IS NOT NULL)"),
      outcomeBreakdown: db.prepare("SELECT outcome, COUNT(*) AS count FROM competency_assessments WHERE outcome IS NOT NULL GROUP BY outcome").all(),
      byFramework: db.prepare(`SELECT f.title, COUNT(c.id) AS count FROM competency_frameworks f
        LEFT JOIN competency_assessments c ON c.framework_id = f.id GROUP BY f.id ORDER BY count DESC LIMIT 8`).all(),
    });
  });

  /**
   * Who is covered for what, and who is not. The register answers "was this
   * person assessed"; the matrix answers the question a head of department
   * actually has, which is whether the bench is covered.
   */
  router.get('/competency-matrix', requirePermission('personnel.training', 'view'), (req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const sectionId = parseIntNullable(req.query.sectionId);
    const staff = db.prepare(`SELECT s.id, s.full_name, s.employee_no, s.designation, s.personnel_category, sec.name AS section_name, s.section_id
      FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.is_active = 1 ${sectionId ? 'AND s.section_id = ?' : ''}
      ORDER BY sec.name, s.full_name`).all(...(sectionId ? [sectionId] : [])) as Row[];
    const frameworks = db.prepare(`SELECT id, framework_code, title, applies_to, section_id, validity_months
      FROM competency_frameworks WHERE status = 'active' ${sectionId ? 'AND (section_id = ? OR section_id IS NULL)' : ''}
      ORDER BY title`).all(...(sectionId ? [sectionId] : [])) as Row[];
    const latest = db.prepare(`SELECT c.staff_id, c.framework_id, c.id, c.competency_number, c.outcome, c.status,
        c.assessment_date, c.next_assessment_due, c.score_percent, c.supervision_level
      FROM competency_assessments c
      WHERE c.framework_id IS NOT NULL AND c.status IN ('completed','acknowledged')
        AND c.assessment_date = (SELECT MAX(c2.assessment_date) FROM competency_assessments c2
          WHERE c2.staff_id = c.staff_id AND c2.framework_id = c.framework_id AND c2.status IN ('completed','acknowledged'))
      GROUP BY c.staff_id, c.framework_id`).all() as Row[];

    const byKey = new Map(latest.map(r => [`${r.staff_id}:${r.framework_id}`, r]));
    const cells = staff.map(person => ({
      staff: person,
      coverage: frameworks.map(framework => {
        const record = byKey.get(`${person.id}:${framework.id}`);
        if (!record) return { frameworkId: framework.id, state: 'not_assessed' as const };
        const expired = record.next_assessment_due && String(record.next_assessment_due) < today;
        const state = record.outcome === 'not_yet_competent' ? 'not_competent'
          : expired ? 'expired'
            : record.outcome === 'competent_with_supervision' ? 'supervised' : 'competent';
        return {
          frameworkId: framework.id, state, assessmentId: record.id, competencyNumber: record.competency_number,
          assessmentDate: record.assessment_date, nextDue: record.next_assessment_due, scorePercent: record.score_percent,
        };
      }),
    }));
    res.json({ frameworks, rows: cells, generatedAt: today });
  });

  /* ══ Print ═══════════════════════════════════════════════════════════ */

  router.get('/competency/:id/print', requireAuth, (req, res) => {
    const db = getDb();
    const record = loadAssessment(db, req.params.id);
    if (!record) return res.status(404).send('Competency assessment not found');
    if (!canReachPersonalRecord(req.user!.id, 'personnel.training', 'print', record.staff_id ?? null, getCurrentStaffId(req))) {
      return res.status(403).send('Permission denied');
    }
    const summary = record.score_summary as ReturnType<typeof scoreAssessment>;
    const maxScore = Number(record.max_score) || 4;

    // Elements print grouped by bench, with a tick column per point on the
    // scale, so the sheet reads the same way as the form it replaces.
    const grouped = new Map<string, Row[]>();
    for (const item of record.items as Row[]) {
      const key = item.group_title || 'Assessed elements';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }
    const scalePoints = Array.from({ length: maxScore }, (_, i) => maxScore - i);
    const elementRows = Array.from(grouped.entries()).map(([group, items]) => `
      <tr class="group-row"><td colspan="${5 + maxScore}">${htmlEscape(group)}</td></tr>
      ${items.map((item, index) => `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(item.element_text)}${item.is_critical ? ' <strong>(critical)</strong>' : ''}${item.performance_criteria ? `<br/><small>${htmlEscape(item.performance_criteria)}</small>` : ''}</td>
        <td>${htmlEscape(COMPETENCY_METHOD_LABELS[item.method] || labelise(item.method))}</td>
        ${scalePoints.map(point => `<td class="tick">${!item.not_applicable && Number(item.score) === point ? '✓' : ''}</td>`).join('')}
        <td class="tick">${item.not_applicable ? 'N/A' : (item.score ?? '—')}</td>
        <td>${htmlEscape(item.remarks || item.evidence_note || '')}</td>
      </tr>`).join('')}`).join('');

    const samples = record.sample_checks as Row[];
    const samplesHtml = samples.length === 0 ? '' : `
      <h2>Examination of sample performance</h2>
      <table>
        <thead><tr><th style="width:16%">Check type</th><th style="width:12%">Sample ID</th><th style="width:11%">Date tested</th><th style="width:19%">Examination</th><th style="width:14%">Result obtained</th><th style="width:14%">Reference result</th><th style="width:14%">Agreement</th></tr></thead>
        <tbody>${samples.map(s => `<tr>
          <td>${htmlEscape(SAMPLE_CHECK_TYPE_LABELS[s.check_type] || labelise(s.check_type))}</td>
          <td>${htmlEscape(s.sample_id || '—')}</td><td>${htmlEscape(s.date_tested || '—')}</td>
          <td>${htmlEscape(s.test_performed || '—')}</td><td>${htmlEscape(s.staff_result || '—')}</td>
          <td>${htmlEscape(s.reference_result || '—')}</td><td>${htmlEscape(labelise(s.agreement))}</td>
        </tr>`).join('')}</tbody>
      </table>`;

    const attachments = record.attachments as Row[];
    const attachmentsHtml = attachments.length === 0 ? '' : `
      <h2>Evidence on file</h2>
      <table><thead><tr><th style="width:32%">Title</th><th style="width:26%">File</th><th>Description</th><th style="width:16%">Attached</th></tr></thead>
      <tbody>${attachments.map(a => `<tr><td>${htmlEscape(a.title || a.original_name)}</td><td>${htmlEscape(a.original_name)}</td><td>${htmlEscape(a.description || '—')}</td><td>${htmlEscape(String(a.created_at || '').slice(0, 10))} · ${htmlEscape(a.uploaded_by_name || '—')}</td></tr>`).join('')}</tbody></table>`;

    const authorizations = record.authorizations as Row[];
    const authorizationsHtml = authorizations.length === 0 ? '' : `
      <h2>Authorisation granted</h2>
      <table><thead><tr><th>Area of work</th><th style="width:18%">Level</th><th style="width:16%">Unit</th><th style="width:14%">Valid until</th><th style="width:12%">Active</th></tr></thead>
      <tbody>${authorizations.map(a => `<tr><td>${htmlEscape(a.module_key)}</td><td>${htmlEscape(a.level)}</td><td>${htmlEscape(a.section_name || '—')}</td><td>${htmlEscape(a.expires_at || '—')}</td><td>${a.is_active ? 'Yes' : 'Withdrawn'}</td></tr>`).join('')}</tbody></table>`;

    const body = `
<table class="meta">
  <tr><th>Member of staff</th><td>${htmlEscape(record.staff_name || '—')}</td><th>Staff ID</th><td>${htmlEscape(record.employee_no || '—')}</td></tr>
  <tr><th>Designation</th><td>${htmlEscape(record.designation || record.position_title || '—')}</td><th>Unit / section</th><td>${htmlEscape(record.section_name || '—')}</td></tr>
  <tr><th>Framework</th><td>${htmlEscape(record.framework_title || record.activity)}${record.framework_version ? ` (v${htmlEscape(record.framework_version)})` : ''}</td><th>Assessment type</th><td>${htmlEscape(COMPETENCY_ASSESSMENT_TYPE_LABELS[record.assessment_type] || labelise(record.assessment_type))}</td></tr>
  <tr><th>Assessment date</th><td>${htmlEscape(record.assessment_date)}</td><th>Period</th><td>${htmlEscape(record.period_label || '—')}</td></tr>
  <tr><th>Assessor</th><td>${htmlEscape(record.assessor_name || '—')}</td><th>Technical reviewer</th><td>${htmlEscape(record.reviewer_name || '—')}</td></tr>
  <tr><th>Reason</th><td colspan="3">${htmlText(record.assessment_reason)}</td></tr>
</table>

<div class="scores">
  <div class="score-box"><div class="label">Overall score</div><div class="value">${summary.percent === null ? '—' : `${summary.percent}%`}</div><div class="sub">Pass mark ${summary.passThreshold}%</div></div>
  <div class="score-box"><div class="label">Elements assessed</div><div class="value">${summary.elementsAssessed}</div><div class="sub">of ${summary.elementsTotal} on the framework</div></div>
  <div class="score-box"><div class="label">Critical shortfalls</div><div class="value">${summary.criticalFailures}</div><div class="sub">${summary.minimumElementScore === null ? 'No element floor set' : `Element floor ${summary.minimumElementScore}`}</div></div>
  <div class="score-box"><div class="label">Outcome</div><div class="value" style="font-size:13px">${htmlEscape(COMPETENCY_OUTCOME_LABELS[record.outcome] || 'Not concluded')}</div><div class="sub">${htmlEscape(record.supervision_level ? SUPERVISION_LEVEL_LABELS[record.supervision_level] : '—')}</div></div>
  <div class="score-box"><div class="label">Re-assessment due</div><div class="value" style="font-size:13px">${htmlEscape(record.next_assessment_due || '—')}</div><div class="sub">Status: ${htmlEscape(labelise(record.status))}</div></div>
</div>

<h2>Assessed elements</h2>
<p class="legend">Rating scale: ${COMPETENCY_SCALE_4.filter(s => s.score <= maxScore).map(s => `<strong>${s.score}</strong> ${htmlEscape(s.label)}`).join(' &nbsp;·&nbsp; ')}. N/A marks an element that does not apply to this post and is excluded from the score.</p>
<table>
  <thead><tr>
    <th style="width:4%">#</th><th>Element and performance criteria</th><th style="width:17%">Method of assessment</th>
    ${scalePoints.map(p => `<th style="width:4%" class="tick">${p}</th>`).join('')}
    <th style="width:6%" class="tick">Score</th><th style="width:19%">Remarks</th>
  </tr></thead>
  <tbody>${elementRows || `<tr><td colspan="${5 + maxScore}" class="none">No elements were recorded on this assessment.</td></tr>`}</tbody>
</table>

${samplesHtml}

<h2>Findings and observations</h2>
<div class="narrative">${htmlText(record.findings)}</div>

<h2>Assessor's comments</h2>
<div class="narrative">${htmlText(record.assessor_comments)}</div>

<h2>Training and development plan</h2>
<div class="narrative">${htmlText(record.development_plan)}</div>

${authorizationsHtml}

<h2>Technical review</h2>
<div class="narrative">${htmlText(record.reviewer_comments)}</div>

<h2>Comments by the member of staff</h2>
<div class="narrative">${htmlText(record.staff_comments)}</div>

${attachmentsHtml}

<div class="signatures">
  ${signatureBlock('Assessor', record.assessor_name, record.completed_at)}
  ${signatureBlock('Technical reviewer', record.reviewer_name, record.reviewed_at)}
  ${signatureBlock('Member of staff', record.staff_name, record.staff_acknowledged_at)}
</div>`;

    audit(req, { action: 'print', entity: 'competency_assessments', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${record.competency_number} — Competency assessment`,
      documentTitle: 'Competency assessment record',
      reference: record.competency_number,
      referenceLabel: 'Assessment number',
      body,
      autoprint: req.query.autoprint !== '0',
    }));
  });

  /** A blank framework, printed as a form for use away from a screen. */
  router.get('/competency-frameworks/:id/print', requirePermission('personnel.training', 'print'), (req, res) => {
    const db = getDb();
    const framework = loadFramework(db, req.params.id);
    if (!framework) return res.status(404).send('Framework not found');
    const maxScore = Number(framework.max_score) || 4;
    const scalePoints = Array.from({ length: maxScore }, (_, i) => maxScore - i);
    const groups = framework.groups as Row[];
    const elements = (framework.elements as Row[]).filter(e => e.is_active);
    const ungrouped = elements.filter(e => !e.group_id);

    const renderGroup = (title: string, rows: Row[]) => rows.length === 0 ? '' : `
      <tr class="group-row"><td colspan="${4 + maxScore}">${htmlEscape(title)}</td></tr>
      ${rows.map((element, index) => `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(element.element_text)}${element.is_critical ? ' <strong>(critical)</strong>' : ''}${element.performance_criteria ? `<br/><small>${htmlEscape(element.performance_criteria)}</small>` : ''}</td>
        <td>${htmlEscape(COMPETENCY_METHOD_LABELS[element.default_method] || labelise(element.default_method))}</td>
        ${scalePoints.map(() => '<td class="tick"></td>').join('')}
        <td></td>
      </tr>`).join('')}`;

    const body = `
<table class="meta">
  <tr><th>Member of staff</th><td></td><th>Staff ID</th><td></td></tr>
  <tr><th>Unit / section</th><td>${htmlEscape(framework.section_name || '')}</td><th>Assessment date</th><td></td></tr>
  <tr><th>Assessor</th><td></td><th>Technical reviewer</th><td></td></tr>
  <tr><th>Framework</th><td>${htmlEscape(framework.title)} (v${htmlEscape(framework.version_label)})</td><th>Applies to</th><td>${htmlEscape(labelise(framework.applies_to))}</td></tr>
</table>
${framework.purpose ? `<h2>Purpose</h2><div class="narrative">${htmlText(framework.purpose)}</div>` : ''}
${framework.scope ? `<h2>Scope</h2><div class="narrative">${htmlText(framework.scope)}</div>` : ''}

<h2>Assessed elements</h2>
<p class="legend">Rating scale: ${COMPETENCY_SCALE_4.filter(s => s.score <= maxScore).map(s => `<strong>${s.score}</strong> ${htmlEscape(s.label)} — ${htmlEscape(s.descriptor)}`).join('<br/>')}<br/>Pass mark ${htmlEscape(framework.pass_threshold_percent)}%${framework.minimum_element_score ? `, with no single element below ${htmlEscape(framework.minimum_element_score)}` : ''}. Re-assessment every ${htmlEscape(framework.validity_months)} months.</p>
<table>
  <thead><tr><th style="width:4%">#</th><th>Element and performance criteria</th><th style="width:18%">Method of assessment</th>${scalePoints.map(p => `<th style="width:4%" class="tick">${p}</th>`).join('')}<th style="width:22%">Remarks</th></tr></thead>
  <tbody>
    ${groups.filter(g => g.is_active).map(g => renderGroup(g.group_title, elements.filter(e => e.group_id === g.id))).join('')}
    ${renderGroup('Additional elements', ungrouped)}
  </tbody>
</table>

<h2>Findings and observations</h2><div class="narrative" style="min-height:70px"></div>
<h2>Training and development plan</h2><div class="narrative" style="min-height:70px"></div>

<div class="signatures">
  ${signatureBlock('Assessor')}
  ${signatureBlock('Technical reviewer')}
  ${signatureBlock('Member of staff')}
</div>`;

    audit(req, { action: 'print', entity: 'competency_frameworks', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${framework.framework_code} — ${framework.title}`,
      documentTitle: 'Competency assessment form',
      reference: framework.framework_code,
      referenceLabel: 'Framework code',
      body,
      autoprint: req.query.autoprint !== '0',
      footerNote: 'Blank assessment form — complete, sign and file with the staff record.',
    }));
  });

  /** The whole matrix on one sheet, for a management or bench review. */
  router.get('/competency-matrix/print', requirePermission('personnel.training', 'print'), (req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const sectionId = parseIntNullable(req.query.sectionId);
    const staff = db.prepare(`SELECT s.id, s.full_name, s.employee_no, sec.name AS section_name FROM staff s
      LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.is_active = 1 ${sectionId ? 'AND s.section_id = ?' : ''}
      ORDER BY sec.name, s.full_name`).all(...(sectionId ? [sectionId] : [])) as Row[];
    const frameworks = db.prepare(`SELECT id, title FROM competency_frameworks WHERE status = 'active'
      ${sectionId ? 'AND (section_id = ? OR section_id IS NULL)' : ''} ORDER BY title`).all(...(sectionId ? [sectionId] : [])) as Row[];
    const latest = db.prepare(`SELECT c.staff_id, c.framework_id, c.outcome, c.next_assessment_due, c.assessment_date
      FROM competency_assessments c WHERE c.framework_id IS NOT NULL AND c.status IN ('completed','acknowledged')
      GROUP BY c.staff_id, c.framework_id HAVING c.assessment_date = MAX(c.assessment_date)`).all() as Row[];
    const byKey = new Map(latest.map(r => [`${r.staff_id}:${r.framework_id}`, r]));
    const mark = (staffId: number, frameworkId: number) => {
      const record = byKey.get(`${staffId}:${frameworkId}`);
      if (!record) return '—';
      if (record.outcome === 'not_yet_competent') return 'NC';
      if (record.next_assessment_due && String(record.next_assessment_due) < today) return 'EXP';
      return record.outcome === 'competent_with_supervision' ? 'S' : '✓';
    };

    const body = `
<p class="legend">✓ competent &nbsp;·&nbsp; S competent under supervision &nbsp;·&nbsp; EXP re-assessment overdue &nbsp;·&nbsp; NC not yet competent &nbsp;·&nbsp; — never assessed against this framework.</p>
<table>
  <thead><tr><th style="width:22%">Member of staff</th><th style="width:12%">Unit</th>${frameworks.map(f => `<th class="tick">${htmlEscape(f.title)}</th>`).join('')}</tr></thead>
  <tbody>${staff.map(person => `<tr><td>${htmlEscape(person.full_name)}${person.employee_no ? `<br/><small>${htmlEscape(person.employee_no)}</small>` : ''}</td><td>${htmlEscape(person.section_name || '—')}</td>${frameworks.map(f => `<td class="tick">${mark(person.id, f.id)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>
<div class="signatures two">
  ${signatureBlock('Prepared by')}
  ${signatureBlock('Head of department')}
</div>`;

    audit(req, { action: 'print', entity: 'competency_assessments', newValue: { report: 'matrix', sectionId } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: 'Competency matrix',
      documentTitle: 'Competency coverage matrix',
      reference: today,
      referenceLabel: 'As at',
      body,
      autoprint: req.query.autoprint !== '0',
      footerNote: 'Coverage of active frameworks by member of staff.',
    }));
  });

  return router;
}
