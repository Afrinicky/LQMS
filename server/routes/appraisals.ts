import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, evidenceRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { canReachPersonalRecord } from '../services/permissionResolver.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getStaffIdOrCurrent, getCurrentStaffId } from './routeHelpers.js';
import { printSheet, htmlEscape, htmlText, signatureBlock } from '../utils/printLayout.js';
import {
  APPRAISAL_SECTIONS, APPRAISAL_SECTION_LABELS, APPRAISAL_TYPES, APPRAISAL_TYPE_LABELS,
  APPRAISAL_STATUSES, APPRAISAL_CYCLE_TYPES, APPRAISAL_CYCLE_STATUSES, APPRAISAL_RECOMMENDATIONS,
  APPRAISAL_RECOMMENDATION_LABELS, APPRAISAL_OBJECTIVE_STATUSES, DEVELOPMENT_ACTION_TYPES,
  DEVELOPMENT_ACTION_TYPE_LABELS, APPRAISAL_SCALE_5, appraisalBand, labelise,
} from '../../shared/constants/competency.js';

/**
 * Performance appraisal.
 *
 * The register held one row per appraisal with a free-text rating, which made
 * every appraisal a private judgement in a different shape. Two people doing
 * the same job could be rated "Good" and "3/5" in the same year and nothing
 * connected the words to anything.
 *
 * An appraisal is now raised from a template against a cycle. The template
 * carries the questions and their weights, so the same job is scored the same
 * way twice running; the member of staff rates themselves first and the
 * appraiser rates independently, so the conversation starts from two views
 * rather than one; a second-level reviewer moderates before the record closes;
 * and the person signs to say the appraisal was discussed with them, with room
 * to disagree in writing. Objectives for the coming period and the development
 * actions that follow are part of the same record, so next year's appraisal
 * opens on what was agreed this year.
 */

const TEMPLATE_STATUSES = ['draft', 'active', 'archived'];
const EDITABLE_STATUSES = ['draft', 'self_assessment', 'appraiser_review', 'pending_moderation'];

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

function addMonths(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  if (date.getUTCDate() < day) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/**
 * Weighted scoring, section by section.
 *
 * The overall figure is the weighted mean of every scored item, so a heavily
 * weighted objective moves the result more than a minor one. Sections also
 * report separately: an appraisal where delivery is strong and compliance is
 * weak needs to say so rather than average the two into "satisfactory".
 */
function scoreAppraisal(db: any, appraisalId: number | string) {
  const items = db.prepare('SELECT * FROM appraisal_items WHERE appraisal_id = ?').all(appraisalId) as Row[];
  const bySection = new Map<string, { earned: number; possible: number; scored: number; total: number }>();
  let earned = 0;
  let possible = 0;
  let scored = 0;
  let selfEarned = 0;
  let selfPossible = 0;

  for (const item of items) {
    const weight = Number(item.weight) || 1;
    const max = Number(item.max_score) || 5;
    const section = String(item.section || 'competency');
    if (!bySection.has(section)) bySection.set(section, { earned: 0, possible: 0, scored: 0, total: 0 });
    const bucket = bySection.get(section)!;
    bucket.total++;
    if (item.appraiser_score !== null && item.appraiser_score !== undefined) {
      bucket.earned += Number(item.appraiser_score) * weight;
      bucket.possible += max * weight;
      bucket.scored++;
      earned += Number(item.appraiser_score) * weight;
      possible += max * weight;
      scored++;
    }
    if (item.self_score !== null && item.self_score !== undefined) {
      selfEarned += Number(item.self_score) * weight;
      selfPossible += max * weight;
    }
  }

  const pct = (e: number, p: number) => p > 0 ? Math.round((e / p) * 1000) / 10 : null;
  const sections = APPRAISAL_SECTIONS.map(section => {
    const bucket = bySection.get(section);
    return {
      section,
      label: APPRAISAL_SECTION_LABELS[section],
      itemsTotal: bucket?.total ?? 0,
      itemsScored: bucket?.scored ?? 0,
      percent: bucket ? pct(bucket.earned, bucket.possible) : null,
    };
  }).filter(s => s.itemsTotal > 0);

  const overallPercent = pct(earned, possible);
  return {
    itemsTotal: items.length,
    itemsScored: scored,
    earned: Math.round(earned * 100) / 100,
    possible: Math.round(possible * 100) / 100,
    overallPercent,
    selfPercent: pct(selfEarned, selfPossible),
    // The mean score on the template's own scale, which is what people quote.
    overallScore: possible > 0 ? Math.round((earned / possible) * (Number(items[0]?.max_score) || 5) * 100) / 100 : null,
    band: appraisalBand(overallPercent),
    sections,
    deliveryPercent: sections.find(s => s.section === 'delivery')?.percent ?? null,
    competencyPercent: sections.find(s => s.section === 'competency')?.percent ?? null,
  };
}

function loadTemplate(db: any, id: number | string) {
  const template = db.prepare('SELECT * FROM appraisal_templates WHERE id = ?').get(id) as Row | undefined;
  if (!template) return null;
  template.items = db.prepare('SELECT * FROM appraisal_template_items WHERE template_id = ? ORDER BY section, display_order, id').all(id);
  template.appraisals_raised = (db.prepare('SELECT COUNT(*) AS c FROM performance_appraisals WHERE template_id = ?').get(id) as Row).c;
  return template;
}

function loadAppraisal(db: any, id: number | string) {
  const record = db.prepare(`SELECT a.*, s.full_name AS staff_name, s.employee_no, s.designation, s.appointment_date,
      ap.full_name AS appraiser_name, rv.full_name AS reviewer_name, sec.name AS section_name,
      p.title AS position_title, c.cycle_name, c.period_start AS cycle_period_start, c.period_end AS cycle_period_end
    FROM performance_appraisals a
    LEFT JOIN staff s ON s.id = a.staff_id
    LEFT JOIN staff ap ON ap.id = a.appraiser_staff_id
    LEFT JOIN staff rv ON rv.id = a.reviewer_staff_id
    LEFT JOIN sections sec ON sec.id = a.section_id
    LEFT JOIN positions p ON p.id = a.position_id
    LEFT JOIN appraisal_cycles c ON c.id = a.cycle_id
    WHERE a.id = ?`).get(id) as Row | undefined;
  if (!record) return null;
  record.items = db.prepare(`SELECT i.*, f.original_name AS evidence_file_name FROM appraisal_items i
    LEFT JOIN files f ON f.id = i.evidence_file_id
    WHERE i.appraisal_id = ? ORDER BY i.section, i.display_order, i.id`).all(id);
  record.objectives = db.prepare('SELECT * FROM appraisal_objectives WHERE appraisal_id = ? ORDER BY display_order, id').all(id);
  record.development_actions = db.prepare(`SELECT d.*, s.full_name AS responsible_name FROM appraisal_development_actions d
    LEFT JOIN staff s ON s.id = d.responsible_staff_id WHERE d.appraisal_id = ? ORDER BY d.display_order, d.id`).all(id);
  record.attachments = db.prepare(`SELECT at.*, f.original_name, f.mime_type, f.size_bytes, u.full_name AS uploaded_by_name
    FROM appraisal_attachments at JOIN files f ON f.id = at.file_id LEFT JOIN users u ON u.id = at.uploaded_by
    WHERE at.appraisal_id = ? ORDER BY at.created_at DESC`).all(id);
  record.score_summary = scoreAppraisal(db, id);
  return record;
}

/**
 * An appraisal is confidential. Somebody holding the register-wide right
 * reaches any of them; everybody else reaches their own — which is what makes
 * a self-assessment possible without handing every member of staff the right
 * to read their colleagues' reviews.
 */
function mayReach(req: any, record: Row, action: string): boolean {
  return canReachPersonalRecord(req.user!.id, 'personnel.appraisals', action, record.staff_id ?? null, getCurrentStaffId(req));
}

/** True when the signed-in user is the person this appraisal is about. */
function isSubject(req: any, record: Row): boolean {
  const staffId = getCurrentStaffId(req);
  return staffId !== null && staffId === record.staff_id;
}

export function appraisalRoutes() {
  const router = Router();

  /* ══ Templates ═══════════════════════════════════════════════════════ */

  router.get('/appraisal-templates', requirePermission('personnel.appraisals', 'view'), (req, res) => {
    const db = getDb();
    const where = req.query.status ? 'WHERE t.status = ?' : '';
    res.json(db.prepare(`SELECT t.*,
        (SELECT COUNT(*) FROM appraisal_template_items i WHERE i.template_id = t.id AND i.is_active = 1) AS item_count,
        (SELECT COUNT(*) FROM performance_appraisals a WHERE a.template_id = t.id) AS appraisal_count
      FROM appraisal_templates t ${where}
      ORDER BY CASE t.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, t.title`)
      .all(...(req.query.status ? [String(req.query.status)] : [])));
  });

  router.post('/appraisal-templates', requirePermission('personnel.appraisals', 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.title);
    if (!title) return res.status(400).json({ error: 'A template title is required.' });
    const code = nullableText(req.body.templateCode) || generateRecordNumber(db, 'appraisal_templates', 'APT', undefined, 'template_code');
    if (db.prepare('SELECT 1 FROM appraisal_templates WHERE template_code = ?').get(code)) {
      return res.status(400).json({ error: `Template code ${code} is already in use.` });
    }
    const result = db.prepare(`INSERT INTO appraisal_templates
      (template_code, title, applies_to, cadre, version_label, description, max_score, self_assessment_required,
       second_level_review_required, objectives_required, status, effective_date, next_review_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, title, nullableText(req.body.appliesTo) || 'all_staff', nullableText(req.body.cadre),
        nullableText(req.body.versionLabel) || '1.0', nullableText(req.body.description),
        parseNumber(req.body.maxScore) ?? 5, req.body.selfAssessmentRequired === false ? 0 : 1,
        req.body.secondLevelReviewRequired === false ? 0 : 1, req.body.objectivesRequired === false ? 0 : 1,
        oneOf(TEMPLATE_STATUSES, req.body.status, 'draft'),
        nullableText(req.body.effectiveDate), nullableText(req.body.nextReviewDate), req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'appraisal_templates', entityId: id, newValue: { code, title } });
    res.status(201).json({ id, templateCode: code });
  });

  router.get('/appraisal-templates/:id', requirePermission('personnel.appraisals', 'view'), (req, res) => {
    const template = loadTemplate(getDb(), req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  });

  router.put('/appraisal-templates/:id', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM appraisal_templates WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Template not found' });
    db.prepare(`UPDATE appraisal_templates SET title = ?, applies_to = ?, cadre = ?, version_label = ?, description = ?,
        max_score = ?, self_assessment_required = ?, second_level_review_required = ?, objectives_required = ?,
        effective_date = ?, next_review_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.title) ?? old.title, nullableText(req.body.appliesTo) ?? old.applies_to,
        nullableText(req.body.cadre), nullableText(req.body.versionLabel) ?? old.version_label,
        nullableText(req.body.description), parseNumber(req.body.maxScore) ?? old.max_score,
        req.body.selfAssessmentRequired === false ? 0 : 1, req.body.secondLevelReviewRequired === false ? 0 : 1,
        req.body.objectivesRequired === false ? 0 : 1, nullableText(req.body.effectiveDate),
        nullableText(req.body.nextReviewDate), req.params.id);
    audit(req, { action: 'edit', entity: 'appraisal_templates', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/appraisal-templates/:id/status', requirePermission('personnel.appraisals', 'approve'), (req, res) => {
    const db = getDb();
    const status = oneOf(TEMPLATE_STATUSES, req.body.status, '');
    if (!status) return res.status(400).json({ error: `status must be one of: ${TEMPLATE_STATUSES.join(', ')}` });
    const template = db.prepare('SELECT * FROM appraisal_templates WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!template) return res.status(404).json({ error: 'Template not found' });
    if (status === 'active') {
      const items = (db.prepare('SELECT COUNT(*) AS c FROM appraisal_template_items WHERE template_id = ? AND is_active = 1').get(req.params.id) as Row).c;
      if (!items) return res.status(400).json({ error: 'Add at least one assessed item before activating this template.' });
    }
    db.prepare("UPDATE appraisal_templates SET status = ?, effective_date = CASE WHEN ? = 'active' THEN COALESCE(effective_date, date('now')) ELSE effective_date END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status, status, req.params.id);
    audit(req, { action: status === 'active' ? 'approve' : 'edit', entity: 'appraisal_templates', entityId: req.params.id, oldValue: { status: template.status }, newValue: { status } });
    res.json({ ok: true, status });
  });

  router.post('/appraisal-templates/:id/duplicate', requirePermission('personnel.appraisals', 'create'), (req, res) => {
    const db = getDb();
    const source = loadTemplate(db, req.params.id);
    if (!source) return res.status(404).json({ error: 'Template not found' });
    const code = nullableText(req.body.templateCode) || generateRecordNumber(db, 'appraisal_templates', 'APT', undefined, 'template_code');
    const newId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO appraisal_templates
        (template_code, title, applies_to, cadre, version_label, description, max_score, self_assessment_required,
         second_level_review_required, objectives_required, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
        .run(code, nullableText(req.body.title) || source.title, source.applies_to, source.cadre,
          nullableText(req.body.versionLabel) || `${source.version_label}.1`, source.description, source.max_score,
          source.self_assessment_required, source.second_level_review_required, source.objectives_required, req.user!.id);
      const id = Number(result.lastInsertRowid);
      for (const item of source.items as Row[]) {
        db.prepare(`INSERT INTO appraisal_template_items (template_id, section, item_title, item_description, success_measure, weight, display_order, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, item.section, item.item_title, item.item_description, item.success_measure, item.weight, item.display_order, item.is_active);
      }
      return id;
    })();
    audit(req, { action: 'create', entity: 'appraisal_templates', entityId: newId, newValue: { duplicatedFrom: req.params.id, code } });
    res.status(201).json({ id: newId, templateCode: code });
  });

  router.delete('/appraisal-templates/:id', requirePermission('personnel.appraisals', 'void_archive'), (req, res) => {
    const db = getDb();
    const template = db.prepare('SELECT * FROM appraisal_templates WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const used = (db.prepare('SELECT COUNT(*) AS c FROM performance_appraisals WHERE template_id = ?').get(req.params.id) as Row).c;
    if (used) return res.status(400).json({ error: `${used} appraisal(s) were raised from this template. Archive it instead of deleting it.` });
    db.transaction(() => {
      db.prepare('DELETE FROM appraisal_template_items WHERE template_id = ?').run(req.params.id);
      db.prepare('DELETE FROM appraisal_templates WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'appraisal_templates', entityId: req.params.id, oldValue: template });
    res.json({ ok: true });
  });

  router.post('/appraisal-templates/:id/items', requirePermission('personnel.appraisals', 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.itemTitle);
    if (!title) return res.status(400).json({ error: 'An item title is required.' });
    if (!db.prepare('SELECT 1 FROM appraisal_templates WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Template not found' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM appraisal_template_items WHERE template_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO appraisal_template_items (template_id, section, item_title, item_description, success_measure, weight, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, oneOf(APPRAISAL_SECTIONS, req.body.section, 'competency'), title,
        nullableText(req.body.itemDescription), nullableText(req.body.successMeasure),
        parseNumber(req.body.weight) ?? 1, parseNumber(req.body.displayOrder) ?? nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/appraisal-templates/:id/items/:itemId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM appraisal_template_items WHERE id = ? AND template_id = ?').get(req.params.itemId, req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Template item not found' });
    db.prepare(`UPDATE appraisal_template_items SET section = ?, item_title = ?, item_description = ?, success_measure = ?,
        weight = ?, display_order = ?, is_active = ? WHERE id = ?`)
      .run(oneOf(APPRAISAL_SECTIONS, req.body.section, old.section), nullableText(req.body.itemTitle) ?? old.item_title,
        nullableText(req.body.itemDescription), nullableText(req.body.successMeasure),
        parseNumber(req.body.weight) ?? old.weight, parseNumber(req.body.displayOrder) ?? old.display_order,
        req.body.isActive === false ? 0 : 1, req.params.itemId);
    res.json({ ok: true });
  });

  router.delete('/appraisal-templates/:id/items/:itemId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM appraisal_template_items WHERE id = ? AND template_id = ?').get(req.params.itemId, req.params.id) as Row | undefined;
    if (!item) return res.status(404).json({ error: 'Template item not found' });
    db.prepare('DELETE FROM appraisal_template_items WHERE id = ?').run(req.params.itemId);
    res.json({ ok: true });
  });

  /* ══ Cycles ══════════════════════════════════════════════════════════ */

  router.get('/appraisal-cycles', requirePermission('personnel.appraisals', 'view'), (req, res) => {
    const db = getDb();
    const where = req.query.status ? 'WHERE c.status = ?' : '';
    res.json(db.prepare(`SELECT c.*, t.title AS template_title, s.name AS section_name, d.name AS department_name,
        (SELECT COUNT(*) FROM performance_appraisals a WHERE a.cycle_id = c.id) AS appraisals_raised,
        (SELECT COUNT(*) FROM performance_appraisals a WHERE a.cycle_id = c.id AND a.status IN ('completed','acknowledged')) AS appraisals_completed
      FROM appraisal_cycles c
      LEFT JOIN appraisal_templates t ON t.id = c.template_id
      LEFT JOIN sections s ON s.id = c.section_id
      LEFT JOIN departments d ON d.id = c.department_id
      ${where} ORDER BY c.period_end DESC, c.id DESC`)
      .all(...(req.query.status ? [String(req.query.status)] : [])));
  });

  router.post('/appraisal-cycles', requirePermission('personnel.appraisals', 'create'), (req, res) => {
    const db = getDb();
    const name = nullableText(req.body.cycleName);
    const start = nullableText(req.body.periodStart);
    const end = nullableText(req.body.periodEnd);
    if (!name || !start || !end) return res.status(400).json({ error: 'A cycle name and a start and end date are required.' });
    if (end < start) return res.status(400).json({ error: 'The period cannot end before it starts.' });
    const result = db.prepare(`INSERT INTO appraisal_cycles
      (cycle_name, cycle_type, period_start, period_end, template_id, self_assessment_due, appraisal_due, status,
       department_id, section_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, oneOf(APPRAISAL_CYCLE_TYPES, req.body.cycleType, 'annual'), start, end,
        parseIntNullable(req.body.templateId), nullableText(req.body.selfAssessmentDue), nullableText(req.body.appraisalDue),
        oneOf(APPRAISAL_CYCLE_STATUSES, req.body.status, 'planned'), parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId), nullableText(req.body.notes), req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'appraisal_cycles', entityId: id, newValue: { name, start, end } });
    res.status(201).json({ id });
  });

  router.put('/appraisal-cycles/:id', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM appraisal_cycles WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Cycle not found' });
    db.prepare(`UPDATE appraisal_cycles SET cycle_name = ?, cycle_type = ?, period_start = ?, period_end = ?, template_id = ?,
        self_assessment_due = ?, appraisal_due = ?, department_id = ?, section_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.cycleName) ?? old.cycle_name, oneOf(APPRAISAL_CYCLE_TYPES, req.body.cycleType, old.cycle_type),
        nullableText(req.body.periodStart) ?? old.period_start, nullableText(req.body.periodEnd) ?? old.period_end,
        parseIntNullable(req.body.templateId), nullableText(req.body.selfAssessmentDue), nullableText(req.body.appraisalDue),
        parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), nullableText(req.body.notes), req.params.id);
    audit(req, { action: 'edit', entity: 'appraisal_cycles', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/appraisal-cycles/:id/status', requirePermission('personnel.appraisals', 'approve'), (req, res) => {
    const db = getDb();
    const status = oneOf(APPRAISAL_CYCLE_STATUSES, req.body.status, '');
    if (!status) return res.status(400).json({ error: `status must be one of: ${APPRAISAL_CYCLE_STATUSES.join(', ')}` });
    const cycle = db.prepare('SELECT * FROM appraisal_cycles WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
    if (status === 'closed') {
      const open = (db.prepare("SELECT COUNT(*) AS c FROM performance_appraisals WHERE cycle_id = ? AND status NOT IN ('completed','acknowledged','cancelled')").get(req.params.id) as Row).c;
      if (open && !req.body.force) return res.status(400).json({ error: `${open} appraisal(s) in this cycle are still open.` });
    }
    db.prepare(`UPDATE appraisal_cycles SET status = ?,
        opened_at = CASE WHEN ? = 'open' THEN COALESCE(opened_at, CURRENT_TIMESTAMP) ELSE opened_at END,
        closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE NULL END,
        closed_by_staff_id = CASE WHEN ? = 'closed' THEN ? ELSE closed_by_staff_id END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status, status, status, status, getStaffIdOrCurrent(req, null), req.params.id);
    audit(req, { action: 'edit', entity: 'appraisal_cycles', entityId: req.params.id, oldValue: { status: cycle.status }, newValue: { status } });
    res.json({ ok: true, status });
  });

  /**
   * Raise an appraisal for everybody in scope in one action, so opening a
   * cycle does not mean typing the same form out forty times. Anybody who
   * already has an appraisal in this cycle is skipped rather than duplicated.
   */
  router.post('/appraisal-cycles/:id/raise', requirePermission('personnel.appraisals', 'create'), (req, res) => {
    const db = getDb();
    const cycle = db.prepare('SELECT * FROM appraisal_cycles WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
    if (cycle.status === 'closed') return res.status(400).json({ error: 'That cycle is closed.' });
    const template = cycle.template_id ? loadTemplate(db, cycle.template_id) : null;
    if (!template) return res.status(400).json({ error: 'Set a template on the cycle before raising appraisals from it.' });
    if (template.status !== 'active') return res.status(400).json({ error: 'The cycle\'s template is not active.' });

    const requested: number[] = Array.isArray(req.body.staffIds)
      ? req.body.staffIds.map((v: unknown) => parseIntNullable(v)).filter((v: number | null): v is number => v !== null)
      : [];
    const scope = requested.length
      ? db.prepare(`SELECT * FROM staff WHERE is_active = 1 AND id IN (${requested.map(() => '?').join(',')})`).all(...requested) as Row[]
      : db.prepare(`SELECT * FROM staff WHERE is_active = 1 ${cycle.section_id ? 'AND section_id = ?' : ''}`)
        .all(...(cycle.section_id ? [cycle.section_id] : [])) as Row[];
    if (!scope.length) return res.status(400).json({ error: 'No active staff matched the cycle scope.' });

    const created: Array<{ id: number; recordNumber: string; staffId: number }> = [];
    const skipped: string[] = [];
    db.transaction(() => {
      for (const person of scope) {
        const existing = db.prepare('SELECT id FROM performance_appraisals WHERE cycle_id = ? AND staff_id = ?').get(req.params.id, person.id);
        if (existing) { skipped.push(person.full_name); continue; }
        const id = insertAppraisal(db, req, {
          staffId: person.id,
          cycle,
          template,
          appraiserStaffId: parseIntNullable(req.body.appraiserStaffId),
          reviewerStaffId: parseIntNullable(req.body.reviewerStaffId),
          appraisalDate: nullableText(req.body.appraisalDate) ?? cycle.period_end,
        });
        created.push({ id: id.id, recordNumber: id.recordNumber, staffId: person.id });
      }
      db.prepare("UPDATE appraisal_cycles SET status = CASE WHEN status = 'planned' THEN 'open' ELSE status END, opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    })();
    audit(req, { action: 'create', entity: 'performance_appraisals', entityId: req.params.id, newValue: { cycleId: req.params.id, created: created.length, skipped: skipped.length } });
    res.status(201).json({ created: created.length, skipped });
  });

  /* ══ Appraisals ══════════════════════════════════════════════════════ */

  /** Shared by the single-raise route and the cycle bulk raise. */
  function insertAppraisal(db: any, req: any, options: {
    staffId: number;
    cycle?: Row | null;
    template?: Row | null;
    appraiserStaffId?: number | null;
    reviewerStaffId?: number | null;
    appraisalDate: string;
    appraisalType?: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    nextAppraisalDue?: string | null;
  }) {
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'performance_appraisals', 'APR', createdAt, 'record_number');
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(options.staffId) as Row | undefined;
    const template = options.template ?? null;
    const cycle = options.cycle ?? null;
    const periodStart = options.periodStart ?? cycle?.period_start ?? null;
    const periodEnd = options.periodEnd ?? cycle?.period_end ?? null;
    const status = template && Number(template.self_assessment_required) === 1 ? 'self_assessment' : 'appraiser_review';

    const result = db.prepare(`INSERT INTO performance_appraisals
      (record_number, staff_id, appraisal_date, period, appraiser_staff_id, reviewer_staff_id, status, cycle_id, template_id,
       template_title, appraisal_type, period_start, period_end, section_id, max_score, next_appraisal_due, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, options.staffId, options.appraisalDate,
        cycle?.cycle_name ?? (periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : null),
        options.appraiserStaffId ?? getStaffIdOrCurrent(req, null), options.reviewerStaffId ?? null, status,
        cycle?.id ?? null, template?.id ?? null, template?.title ?? null,
        oneOf(APPRAISAL_TYPES, options.appraisalType ?? cycle?.cycle_type, 'annual'),
        periodStart, periodEnd, staff?.section_id ?? null, template ? Number(template.max_score) : 5,
        options.nextAppraisalDue ?? (periodEnd ? addMonths(periodEnd, 12) : null), req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);

    if (template) {
      const insert = db.prepare(`INSERT INTO appraisal_items
        (appraisal_id, template_item_id, section, item_title, item_description, success_measure, weight, max_score, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let order = 0;
      for (const item of template.items as Row[]) {
        if (!item.is_active) continue;
        insert.run(id, item.id, item.section, item.item_title, item.item_description, item.success_measure,
          item.weight, Number(template.max_score), order += 10);
      }
      // Objectives agreed at the last appraisal are the starting point for this
      // one, so the review opens on what was actually promised.
      const previous = db.prepare(`SELECT id FROM performance_appraisals WHERE staff_id = ? AND id != ?
        AND status IN ('completed','acknowledged') ORDER BY appraisal_date DESC LIMIT 1`).get(options.staffId, id) as Row | undefined;
      if (previous) {
        const carried = db.prepare("SELECT * FROM appraisal_objectives WHERE appraisal_id = ? AND status IN ('agreed','in_progress','carried_forward') ORDER BY display_order, id").all(previous.id) as Row[];
        let objectiveOrder = 0;
        for (const objective of carried) {
          db.prepare(`INSERT INTO appraisal_objectives (appraisal_id, objective, success_measure, target_date, weight, status, carried_from_id, display_order)
            VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`)
            .run(id, objective.objective, objective.success_measure, objective.target_date, objective.weight, objective.id, objectiveOrder += 10);
        }
      }
    }
    return { id, recordNumber: number };
  }

  router.get('/appraisals', requirePermission('personnel.appraisals', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.staffId) { filters.push('a.staff_id = ?'); params.push(Number(req.query.staffId)); }
    if (req.query.cycleId) { filters.push('a.cycle_id = ?'); params.push(Number(req.query.cycleId)); }
    if (req.query.status) { filters.push('a.status = ?'); params.push(String(req.query.status)); }
    if (req.query.appraisalType) { filters.push('a.appraisal_type = ?'); params.push(String(req.query.appraisalType)); }
    if (req.query.sectionId) { filters.push('a.section_id = ?'); params.push(Number(req.query.sectionId)); }
    if (req.query.from) { filters.push('a.appraisal_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { filters.push('a.appraisal_date <= ?'); params.push(String(req.query.to)); }
    if (req.query.mine === 'true') {
      const staffId = getCurrentStaffId(req);
      filters.push('a.staff_id = ?'); params.push(staffId ?? -1);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT a.*, s.full_name AS staff_name, s.employee_no, ap.full_name AS appraiser_name,
        rv.full_name AS reviewer_name, sec.name AS section_name, c.cycle_name
      FROM performance_appraisals a
      LEFT JOIN staff s ON s.id = a.staff_id
      LEFT JOIN staff ap ON ap.id = a.appraiser_staff_id
      LEFT JOIN staff rv ON rv.id = a.reviewer_staff_id
      LEFT JOIN sections sec ON sec.id = a.section_id
      LEFT JOIN appraisal_cycles c ON c.id = a.cycle_id
      ${where} ORDER BY a.appraisal_date DESC, a.id DESC`).all(...params));
  });

  router.post('/appraisals', requirePermission('personnel.appraisals', 'create'), (req, res) => {
    const db = getDb();
    const staffId = parseIntNullable(req.body.staffId);
    if (!staffId) return res.status(400).json({ error: 'A member of staff is required.' });
    const appraisalDate = nullableText(req.body.appraisalDate);
    if (!appraisalDate) return res.status(400).json({ error: 'An appraisal date is required.' });
    const templateId = parseIntNullable(req.body.templateId);
    const template = templateId ? loadTemplate(db, templateId) : null;
    if (templateId && !template) return res.status(400).json({ error: 'The chosen template no longer exists.' });
    if (template && template.status === 'archived') return res.status(400).json({ error: 'That template has been archived and cannot be used for a new appraisal.' });
    const cycleId = parseIntNullable(req.body.cycleId);
    const cycle = cycleId ? db.prepare('SELECT * FROM appraisal_cycles WHERE id = ?').get(cycleId) as Row | undefined : null;
    if (cycleId && !cycle) return res.status(400).json({ error: 'The chosen cycle no longer exists.' });
    if (cycle && db.prepare('SELECT 1 FROM performance_appraisals WHERE cycle_id = ? AND staff_id = ?').get(cycleId, staffId)) {
      return res.status(400).json({ error: 'That member of staff already has an appraisal in this cycle.' });
    }

    const created = db.transaction(() => insertAppraisal(db, req, {
      staffId,
      cycle: cycle ?? null,
      template: template ?? (cycle?.template_id ? loadTemplate(db, cycle.template_id) : null),
      appraiserStaffId: parseIntNullable(req.body.appraiserStaffId),
      reviewerStaffId: parseIntNullable(req.body.reviewerStaffId),
      appraisalDate,
      appraisalType: nullableText(req.body.appraisalType) ?? undefined,
      periodStart: nullableText(req.body.periodStart),
      periodEnd: nullableText(req.body.periodEnd),
      nextAppraisalDue: nullableText(req.body.nextAppraisalDue),
    }))();
    audit(req, { action: 'create', entity: 'performance_appraisals', entityId: created.id, newValue: { number: created.recordNumber, staffId, templateId, cycleId } });
    res.status(201).json(created);
  });

  // Guarded per record rather than by a blanket feature check, so the person
  // an appraisal is about can always open their own.
  router.get('/appraisals/:id', requireAuth, (req, res) => {
    const record = loadAppraisal(getDb(), req.params.id);
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (!mayReach(req, record, 'view')) return res.status(403).json({ error: 'This appraisal is confidential to the member of staff and their appraiser.' });
    res.json(record);
  });

  router.put('/appraisals/:id', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Appraisal not found' });
    if (!EDITABLE_STATUSES.includes(old.status)) return res.status(400).json({ error: 'A completed appraisal cannot be edited.' });
    db.prepare(`UPDATE performance_appraisals SET appraisal_date = ?, appraisal_type = ?, period = ?, period_start = ?, period_end = ?,
        appraiser_staff_id = ?, reviewer_staff_id = ?, section_id = ?, position_id = ?, strengths = ?, development_areas = ?,
        training_needs = ?, appraiser_comments = ?, self_overall_comments = ?, next_appraisal_due = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.appraisalDate) ?? old.appraisal_date,
        oneOf(APPRAISAL_TYPES, req.body.appraisalType, old.appraisal_type),
        nullableText(req.body.period) ?? old.period, nullableText(req.body.periodStart) ?? old.period_start,
        nullableText(req.body.periodEnd) ?? old.period_end,
        parseIntNullable(req.body.appraiserStaffId) ?? old.appraiser_staff_id, parseIntNullable(req.body.reviewerStaffId),
        parseIntNullable(req.body.sectionId) ?? old.section_id, parseIntNullable(req.body.positionId),
        nullableText(req.body.strengths), nullableText(req.body.developmentAreas), nullableText(req.body.trainingNeeds),
        nullableText(req.body.appraiserComments), nullableText(req.body.selfOverallComments),
        nullableText(req.body.nextAppraisalDue) ?? old.next_appraisal_due, nullableText(req.body.notes), req.params.id);
    audit(req, { action: 'edit', entity: 'performance_appraisals', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/appraisals/:id', requirePermission('personnel.appraisals', 'void_archive'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (['completed', 'acknowledged'].includes(record.status)) return res.status(400).json({ error: 'A completed appraisal cannot be removed.' });
    db.transaction(() => {
      for (const table of ['appraisal_items', 'appraisal_objectives', 'appraisal_development_actions', 'appraisal_attachments']) {
        db.prepare(`DELETE FROM ${table} WHERE appraisal_id = ?`).run(req.params.id);
      }
      db.prepare('DELETE FROM performance_appraisals WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'performance_appraisals', entityId: req.params.id, oldValue: record });
    res.json({ ok: true });
  });

  /* ── Scoring ── */

  /**
   * Save a page of ratings. `perspective` decides whose column is written:
   * "self" is the member of staff's own rating and only they may set it,
   * "appraiser" is the manager's.
   */
  router.put('/appraisals/:id/items', requireAuth, (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (!EDITABLE_STATUSES.includes(record.status)) return res.status(400).json({ error: 'This appraisal is closed and can no longer be scored.' });
    const perspective = req.body.perspective === 'self' ? 'self' : 'appraiser';
    if (perspective === 'self') {
      // Own record only, and never a substitute for the appraiser's column.
      if (!isSubject(req, record)) return res.status(403).json({ error: 'A self-assessment can only be entered by the member of staff being appraised.' });
    } else {
      if (isSubject(req, record)) return res.status(403).json({ error: 'You cannot enter the appraiser\'s rating on your own appraisal.' });
      if (!mayReach(req, record, 'edit')) return res.status(403).json({ error: 'Permission denied' });
    }
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No ratings were supplied.' });

    let saved = 0;
    db.transaction(() => {
      for (const item of items) {
        const itemId = parseIntNullable(item.id);
        if (!itemId) continue;
        const existing = db.prepare('SELECT * FROM appraisal_items WHERE id = ? AND appraisal_id = ?').get(itemId, req.params.id) as Row | undefined;
        if (!existing) continue;
        let score = parseNumber(item.score);
        if (score !== null) score = Math.max(0, Math.min(Number(existing.max_score) || 5, score));
        if (perspective === 'self') {
          db.prepare('UPDATE appraisal_items SET self_score = ?, self_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(score, nullableText(item.comment), itemId);
        } else {
          db.prepare('UPDATE appraisal_items SET appraiser_score = ?, appraiser_comment = ?, evidence_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(score, nullableText(item.comment), nullableText(item.evidenceNote), itemId);
        }
        saved++;
      }
      const summary = scoreAppraisal(db, req.params.id);
      db.prepare(`UPDATE performance_appraisals SET overall_score = ?, overall_percent = ?, rating_band = ?,
        delivery_score_percent = ?, competency_score_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(summary.overallScore, summary.overallPercent, summary.band, summary.deliveryPercent, summary.competencyPercent, req.params.id);
    })();
    audit(req, { action: 'edit', entity: 'appraisal_items', entityId: req.params.id, newValue: { perspective, saved } });
    res.json({ ok: true, saved, summary: scoreAppraisal(db, req.params.id) });
  });

  /** An item outside the template — a one-off objective or responsibility. */
  router.post('/appraisals/:id/items', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (!EDITABLE_STATUSES.includes(record.status)) return res.status(400).json({ error: 'This appraisal is closed.' });
    const title = nullableText(req.body.itemTitle);
    if (!title) return res.status(400).json({ error: 'An item title is required.' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM appraisal_items WHERE appraisal_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO appraisal_items (appraisal_id, section, item_title, item_description, success_measure, weight, max_score, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, oneOf(APPRAISAL_SECTIONS, req.body.section, 'delivery'), title,
        nullableText(req.body.itemDescription), nullableText(req.body.successMeasure),
        parseNumber(req.body.weight) ?? 1, parseNumber(req.body.maxScore) ?? (Number(record.max_score) || 5), nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.delete('/appraisals/:id/items/:itemId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (!EDITABLE_STATUSES.includes(record.status)) return res.status(400).json({ error: 'This appraisal is closed.' });
    if (!db.prepare('SELECT 1 FROM appraisal_items WHERE id = ? AND appraisal_id = ?').get(req.params.itemId, req.params.id)) {
      return res.status(404).json({ error: 'Item not found on this appraisal' });
    }
    db.prepare('DELETE FROM appraisal_items WHERE id = ?').run(req.params.itemId);
    res.json({ ok: true });
  });

  /* ── Objectives ── */

  router.post('/appraisals/:id/objectives', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    const objective = nullableText(req.body.objective);
    if (!objective) return res.status(400).json({ error: 'An objective is required.' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM appraisal_objectives WHERE appraisal_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO appraisal_objectives (appraisal_id, objective, success_measure, target_date, weight, status, comments, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, objective, nullableText(req.body.successMeasure), nullableText(req.body.targetDate),
        parseNumber(req.body.weight) ?? 1, oneOf(APPRAISAL_OBJECTIVE_STATUSES, req.body.status, 'agreed'),
        nullableText(req.body.comments), nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/appraisals/:id/objectives/:objectiveId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM appraisal_objectives WHERE id = ? AND appraisal_id = ?').get(req.params.objectiveId, req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Objective not found' });
    db.prepare(`UPDATE appraisal_objectives SET objective = ?, success_measure = ?, target_date = ?, weight = ?,
        achievement_percent = ?, status = ?, comments = ?, display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.objective) ?? old.objective, nullableText(req.body.successMeasure),
        nullableText(req.body.targetDate), parseNumber(req.body.weight) ?? old.weight,
        parseNumber(req.body.achievementPercent), oneOf(APPRAISAL_OBJECTIVE_STATUSES, req.body.status, old.status),
        nullableText(req.body.comments), parseNumber(req.body.displayOrder) ?? old.display_order, req.params.objectiveId);
    res.json({ ok: true });
  });

  router.delete('/appraisals/:id/objectives/:objectiveId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM appraisal_objectives WHERE id = ? AND appraisal_id = ?').get(req.params.objectiveId, req.params.id)) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    db.prepare('DELETE FROM appraisal_objectives WHERE id = ?').run(req.params.objectiveId);
    res.json({ ok: true });
  });

  /* ── Development plan ── */

  router.post('/appraisals/:id/development-actions', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    const action = nullableText(req.body.action);
    if (!action) return res.status(400).json({ error: 'A development action is required.' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM appraisal_development_actions WHERE appraisal_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO appraisal_development_actions
      (appraisal_id, action, action_type, development_need, target_date, responsible_staff_id, status, notes, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, action, oneOf(DEVELOPMENT_ACTION_TYPES, req.body.actionType, 'training'),
        nullableText(req.body.developmentNeed), nullableText(req.body.targetDate),
        parseIntNullable(req.body.responsibleStaffId) ?? record.staff_id, 'planned', nullableText(req.body.notes), nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/appraisals/:id/development-actions/:actionId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM appraisal_development_actions WHERE id = ? AND appraisal_id = ?').get(req.params.actionId, req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Development action not found' });
    db.prepare(`UPDATE appraisal_development_actions SET action = ?, action_type = ?, development_need = ?, target_date = ?,
        responsible_staff_id = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.action) ?? old.action, oneOf(DEVELOPMENT_ACTION_TYPES, req.body.actionType, old.action_type),
        nullableText(req.body.developmentNeed), nullableText(req.body.targetDate),
        parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id,
        oneOf(['planned', 'in_progress', 'completed', 'cancelled'], req.body.status, old.status),
        nullableText(req.body.notes), req.params.actionId);
    res.json({ ok: true });
  });

  router.delete('/appraisals/:id/development-actions/:actionId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM appraisal_development_actions WHERE id = ? AND appraisal_id = ?').get(req.params.actionId, req.params.id)) {
      return res.status(404).json({ error: 'Development action not found' });
    }
    db.prepare('DELETE FROM appraisal_development_actions WHERE id = ?').run(req.params.actionId);
    res.json({ ok: true });
  });

  /* ── Evidence ── */

  router.post('/appraisals/:id/attachments', requirePermission('personnel.appraisals', 'edit'), evidenceUpload.single('file'), (req, res) => {
    const db = getDb();
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) {
      fs.unlink(path.join(evidenceRoot, req.file.filename), () => undefined);
      return res.status(404).json({ error: 'Appraisal not found' });
    }
    const attachmentId = db.transaction(() => {
      const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.file!.originalname, req.file!.filename, req.file!.mimetype, req.file!.size, 'evidence', req.user!.id);
      const fileId = Number(file.lastInsertRowid);
      const attachment = db.prepare('INSERT INTO appraisal_attachments (appraisal_id, file_id, title, description, uploaded_by) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, fileId, nullableText(req.body.title) || req.file!.originalname, nullableText(req.body.description), req.user!.id);
      db.prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fileId, 'personnel', 'performance_appraisals', String(req.params.id), nullableText(req.body.description), req.user!.id);
      const itemId = parseIntNullable(req.body.itemId);
      if (itemId) db.prepare('UPDATE appraisal_items SET evidence_file_id = ? WHERE id = ? AND appraisal_id = ?').run(fileId, itemId, req.params.id);
      return Number(attachment.lastInsertRowid);
    })();
    audit(req, { action: 'create', entity: 'appraisal_attachments', entityId: attachmentId, newValue: { appraisalId: req.params.id, name: req.file.originalname } });
    res.status(201).json({ id: attachmentId });
  });

  router.delete('/appraisals/:id/attachments/:attachmentId', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const attachment = db.prepare('SELECT * FROM appraisal_attachments WHERE id = ? AND appraisal_id = ?').get(req.params.attachmentId, req.params.id) as Row | undefined;
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    db.transaction(() => {
      db.prepare('UPDATE appraisal_items SET evidence_file_id = NULL WHERE evidence_file_id = ? AND appraisal_id = ?').run(attachment.file_id, req.params.id);
      db.prepare('DELETE FROM evidence_files WHERE file_id = ? AND record_type = ? AND record_id = ?').run(attachment.file_id, 'performance_appraisals', String(req.params.id));
      db.prepare('DELETE FROM appraisal_attachments WHERE id = ?').run(req.params.attachmentId);
    })();
    audit(req, { action: 'delete', entity: 'appraisal_attachments', entityId: req.params.attachmentId, oldValue: attachment });
    res.json({ ok: true });
  });

  /* ── Workflow ── */

  /** The member of staff hands their self-assessment to their appraiser. */
  router.post('/appraisals/:id/submit-self-assessment', requireAuth, (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (record.status !== 'self_assessment') return res.status(400).json({ error: 'This appraisal is not awaiting a self-assessment.' });
    if (!isSubject(req, record)) return res.status(403).json({ error: 'Only the member of staff being appraised can submit the self-assessment.' });
    db.prepare(`UPDATE performance_appraisals SET status = 'appraiser_review', self_overall_comments = COALESCE(?, self_overall_comments),
      self_assessment_submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.selfOverallComments), req.params.id);
    audit(req, { action: 'submit', entity: 'performance_appraisals', entityId: req.params.id, newValue: { stage: 'self_assessment' } });
    res.json({ ok: true });
  });

  /**
   * The appraiser closes their part. Where the template calls for a
   * second-level review the record goes to the moderator; otherwise it is
   * complete and waits on the member of staff's signature.
   */
  router.post('/appraisals/:id/submit-appraisal', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (!['self_assessment', 'appraiser_review', 'draft'].includes(record.status)) {
      return res.status(400).json({ error: 'This appraisal is no longer with the appraiser.' });
    }
    if (isSubject(req, record)) return res.status(403).json({ error: 'You cannot complete your own appraisal as the appraiser.' });
    const summary = scoreAppraisal(db, req.params.id);
    if (summary.itemsTotal > 0 && summary.itemsScored < summary.itemsTotal) {
      return res.status(400).json({ error: `Rate every item before submitting — ${summary.itemsTotal - summary.itemsScored} still unrated.` });
    }
    const recommendation = oneOf(APPRAISAL_RECOMMENDATIONS, req.body.recommendation, '');
    if (!recommendation) return res.status(400).json({ error: `recommendation must be one of: ${APPRAISAL_RECOMMENDATIONS.join(', ')}` });

    const template = record.template_id ? db.prepare('SELECT * FROM appraisal_templates WHERE id = ?').get(record.template_id) as Row | undefined : undefined;
    const needsModeration = template ? Number(template.second_level_review_required) === 1 : false;
    const nextStatus = needsModeration ? 'pending_moderation' : 'completed';

    db.prepare(`UPDATE performance_appraisals SET status = ?, overall_score = ?, overall_percent = ?, rating_band = ?,
        delivery_score_percent = ?, competency_score_percent = ?, rating = ?, recommendation = ?, outcome = ?,
        appraiser_comments = COALESCE(?, appraiser_comments), strengths = COALESCE(?, strengths),
        development_areas = COALESCE(?, development_areas), training_needs = COALESCE(?, training_needs),
        next_appraisal_due = COALESCE(?, next_appraisal_due), reviewer_staff_id = COALESCE(?, reviewer_staff_id),
        appraiser_submitted_at = CURRENT_TIMESTAMP,
        completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nextStatus, summary.overallScore, summary.overallPercent, summary.band, summary.deliveryPercent,
        summary.competencyPercent, summary.band, recommendation, APPRAISAL_RECOMMENDATION_LABELS[recommendation],
        nullableText(req.body.appraiserComments), nullableText(req.body.strengths), nullableText(req.body.developmentAreas),
        nullableText(req.body.trainingNeeds),
        nullableText(req.body.nextAppraisalDue) ?? (record.period_end ? addMonths(String(record.period_end), 12) : null),
        parseIntNullable(req.body.reviewerStaffId), nextStatus, req.params.id);

    audit(req, { action: 'complete', entity: 'performance_appraisals', entityId: req.params.id, oldValue: { status: record.status }, newValue: { status: nextStatus, recommendation, overallPercent: summary.overallPercent } });
    res.json({ ok: true, status: nextStatus, summary });
  });

  /** Second-level review — the moderation step that keeps ratings comparable. */
  router.post('/appraisals/:id/moderate', requirePermission('personnel.appraisals', 'approve'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (!['pending_moderation', 'completed'].includes(record.status)) {
      return res.status(400).json({ error: 'This appraisal is not awaiting a second-level review.' });
    }
    const reviewerStaffId = getStaffIdOrCurrent(req, req.body.reviewerStaffId);
    if (reviewerStaffId && reviewerStaffId === record.appraiser_staff_id) {
      return res.status(400).json({ error: 'The second-level review has to be carried out by somebody other than the appraiser.' });
    }
    if (reviewerStaffId && reviewerStaffId === record.staff_id) {
      return res.status(400).json({ error: 'You cannot moderate your own appraisal.' });
    }
    db.prepare(`UPDATE performance_appraisals SET status = 'completed', reviewer_staff_id = ?, reviewer_comments = ?,
      reviewed_at = CURRENT_TIMESTAMP, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(reviewerStaffId, nullableText(req.body.reviewerComments), req.params.id);
    audit(req, { action: 'review', entity: 'performance_appraisals', entityId: req.params.id, newValue: { reviewerStaffId } });
    res.json({ ok: true });
  });

  /**
   * The member of staff signs. Signing records that the appraisal was
   * discussed with them; it is not agreement, so their comments are kept
   * whether they agree or not.
   */
  router.post('/appraisals/:id/acknowledge', requireAuth, (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (record.status !== 'completed') return res.status(400).json({ error: 'The appraisal has to be completed before it can be acknowledged.' });
    const staffId = getCurrentStaffId(req);
    if (!staffId) return res.status(400).json({ error: 'Your user account is not linked to a staff record, so you cannot sign this.' });
    if (staffId !== record.staff_id) return res.status(403).json({ error: 'An appraisal can only be acknowledged by the member of staff it was carried out on.' });
    db.prepare(`UPDATE performance_appraisals SET status = 'acknowledged', employee_comments = ?, employee_acknowledged_at = CURRENT_TIMESTAMP,
      employee_acknowledged_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.employeeComments), req.user!.id, req.params.id);
    audit(req, { action: 'acknowledge', entity: 'performance_appraisals', entityId: req.params.id, newValue: { staffId } });
    res.json({ ok: true });
  });

  router.post('/appraisals/:id/cancel', requirePermission('personnel.appraisals', 'void_archive'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    if (['completed', 'acknowledged'].includes(record.status)) return res.status(400).json({ error: 'A completed appraisal cannot be cancelled.' });
    const reason = nullableText(req.body.reason);
    if (!reason) return res.status(400).json({ error: 'Give a reason for cancelling this appraisal.' });
    db.prepare("UPDATE performance_appraisals SET status = 'cancelled', notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(`${record.notes ? `${record.notes}\n\n` : ''}Cancelled: ${reason}`, req.params.id);
    audit(req, { action: 'cancel', entity: 'performance_appraisals', entityId: req.params.id, oldValue: { status: record.status }, newValue: { reason } });
    res.json({ ok: true });
  });

  /**
   * Turn the agreed development plan into tracked actions, so what was
   * promised in the review appears on somebody's list of work rather than
   * only in a document nobody reopens until next year.
   */
  router.post('/appraisals/:id/raise-development-actions', requirePermission('personnel.appraisals', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM performance_appraisals WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Appraisal not found' });
    const pending = db.prepare("SELECT * FROM appraisal_development_actions WHERE appraisal_id = ? AND linked_action_id IS NULL AND status != 'cancelled'").all(req.params.id) as Row[];
    if (!pending.length) return res.status(400).json({ error: 'Every development action on this appraisal has already been raised.' });
    let raised = 0;
    db.transaction(() => {
      for (const item of pending) {
        const action = db.prepare(`INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, status, due_date, evidence_required, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`${DEVELOPMENT_ACTION_TYPE_LABELS[item.action_type] || 'Development'}: ${item.action}`, 'personnel', 'personnel',
            String(req.params.id), `Agreed at appraisal ${record.record_number}.${item.development_need ? ` Development need: ${item.development_need}` : ''}`,
            'normal', item.responsible_staff_id ?? record.staff_id, 'Not started', item.target_date, 1, req.user!.id);
        const actionId = Number(action.lastInsertRowid);
        db.prepare('UPDATE appraisal_development_actions SET linked_action_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(actionId, 'in_progress', item.id);
        db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run('personnel', 'performance_appraisals', String(req.params.id), 'actions', 'actions', String(actionId), 'Development action agreed at appraisal');
        raised++;
      }
    })();
    audit(req, { action: 'create', entity: 'actions', entityId: req.params.id, newValue: { raisedFromAppraisal: req.params.id, count: raised } });
    res.status(201).json({ raised });
  });

  /* ══ Overview ════════════════════════════════════════════════════════ */

  router.get('/appraisal-overview', requirePermission('personnel.appraisals', 'view'), (_req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params) as Row).c);
    res.json({
      openCycles: count("SELECT COUNT(*) c FROM appraisal_cycles WHERE status IN ('open','in_review')"),
      activeTemplates: count("SELECT COUNT(*) c FROM appraisal_templates WHERE status = 'active'"),
      withStaff: count("SELECT COUNT(*) c FROM performance_appraisals WHERE status = 'self_assessment'"),
      withAppraiser: count("SELECT COUNT(*) c FROM performance_appraisals WHERE status = 'appraiser_review'"),
      awaitingModeration: count("SELECT COUNT(*) c FROM performance_appraisals WHERE status = 'pending_moderation'"),
      awaitingAcknowledgement: count("SELECT COUNT(*) c FROM performance_appraisals WHERE status = 'completed'"),
      completedThisYear: count("SELECT COUNT(*) c FROM performance_appraisals WHERE status IN ('completed','acknowledged') AND strftime('%Y', appraisal_date) = strftime('%Y','now')"),
      overdue: count('SELECT COUNT(*) c FROM performance_appraisals WHERE next_appraisal_due IS NOT NULL AND next_appraisal_due < ?', today),
      dueSoon: count('SELECT COUNT(*) c FROM performance_appraisals WHERE next_appraisal_due IS NOT NULL AND next_appraisal_due BETWEEN ? AND ?', today, soon),
      staffNeverAppraised: count("SELECT COUNT(*) c FROM staff WHERE is_active = 1 AND id NOT IN (SELECT staff_id FROM performance_appraisals WHERE staff_id IS NOT NULL AND status IN ('completed','acknowledged'))"),
      bandBreakdown: db.prepare("SELECT rating_band AS band, COUNT(*) AS count FROM performance_appraisals WHERE rating_band IS NOT NULL AND status IN ('completed','acknowledged') GROUP BY rating_band ORDER BY count DESC").all(),
      developmentActionsOpen: count("SELECT COUNT(*) c FROM appraisal_development_actions WHERE status IN ('planned','in_progress')"),
    });
  });

  /* ══ Print ═══════════════════════════════════════════════════════════ */

  router.get('/appraisals/:id/print', requireAuth, (req, res) => {
    const db = getDb();
    const record = loadAppraisal(db, req.params.id);
    if (!record) return res.status(404).send('Appraisal not found');
    if (!mayReach(req, record, 'print')) return res.status(403).send('Permission denied');
    const summary = record.score_summary as ReturnType<typeof scoreAppraisal>;
    const maxScore = Number(record.max_score) || 5;

    const items = record.items as Row[];
    const bySection = new Map<string, Row[]>();
    for (const item of items) {
      const key = String(item.section || 'competency');
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(item);
    }
    const itemRows = APPRAISAL_SECTIONS.filter(s => bySection.has(s)).map(section => {
      const rows = bySection.get(section)!;
      const sectionScore = summary.sections.find(s => s.section === section);
      return `<tr class="group-row"><td colspan="6">${htmlEscape(APPRAISAL_SECTION_LABELS[section])}${sectionScore?.percent !== null && sectionScore?.percent !== undefined ? ` — ${sectionScore.percent}%` : ''}</td></tr>
      ${rows.map((item, index) => `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(item.item_title)}${item.success_measure ? `<br/><small>Measure: ${htmlEscape(item.success_measure)}</small>` : ''}</td>
        <td class="tick">${Number(item.weight) || 1}</td>
        <td class="tick">${item.self_score ?? '—'}</td>
        <td class="tick">${item.appraiser_score ?? '—'}</td>
        <td>${htmlEscape(item.appraiser_comment || item.self_comment || '')}</td>
      </tr>`).join('')}`;
    }).join('');

    const objectives = record.objectives as Row[];
    const objectivesHtml = objectives.length === 0
      ? '<p class="none">No objectives were recorded for the period ahead.</p>'
      : `<table><thead><tr><th style="width:4%">#</th><th style="width:34%">Objective</th><th style="width:26%">How success is measured</th><th style="width:11%">Target date</th><th style="width:9%">Weight</th><th style="width:16%">Status</th></tr></thead>
        <tbody>${objectives.map((o, i) => `<tr><td>${i + 1}</td><td>${htmlEscape(o.objective)}</td><td>${htmlEscape(o.success_measure || '—')}</td><td>${htmlEscape(o.target_date || '—')}</td><td class="tick">${Number(o.weight) || 1}</td><td>${htmlEscape(labelise(o.status))}${o.achievement_percent !== null && o.achievement_percent !== undefined ? ` — ${o.achievement_percent}%` : ''}</td></tr>`).join('')}</tbody></table>`;

    const development = record.development_actions as Row[];
    const developmentHtml = development.length === 0
      ? '<p class="none">No development actions were agreed.</p>'
      : `<table><thead><tr><th style="width:4%">#</th><th style="width:32%">Action</th><th style="width:18%">Type</th><th style="width:20%">Development need</th><th style="width:12%">Target date</th><th style="width:14%">Responsible</th></tr></thead>
        <tbody>${development.map((d, i) => `<tr><td>${i + 1}</td><td>${htmlEscape(d.action)}</td><td>${htmlEscape(DEVELOPMENT_ACTION_TYPE_LABELS[d.action_type] || labelise(d.action_type))}</td><td>${htmlEscape(d.development_need || '—')}</td><td>${htmlEscape(d.target_date || '—')}</td><td>${htmlEscape(d.responsible_name || record.staff_name || '—')}</td></tr>`).join('')}</tbody></table>`;

    const attachments = record.attachments as Row[];
    const attachmentsHtml = attachments.length === 0 ? '' : `
      <h2>Evidence on file</h2>
      <table><thead><tr><th style="width:32%">Title</th><th style="width:26%">File</th><th>Description</th><th style="width:16%">Attached</th></tr></thead>
      <tbody>${attachments.map(a => `<tr><td>${htmlEscape(a.title || a.original_name)}</td><td>${htmlEscape(a.original_name)}</td><td>${htmlEscape(a.description || '—')}</td><td>${htmlEscape(String(a.created_at || '').slice(0, 10))} · ${htmlEscape(a.uploaded_by_name || '—')}</td></tr>`).join('')}</tbody></table>`;

    const body = `
<table class="meta">
  <tr><th>Member of staff</th><td>${htmlEscape(record.staff_name || '—')}</td><th>Staff ID</th><td>${htmlEscape(record.employee_no || '—')}</td></tr>
  <tr><th>Designation</th><td>${htmlEscape(record.designation || record.position_title || '—')}</td><th>Unit / section</th><td>${htmlEscape(record.section_name || '—')}</td></tr>
  <tr><th>Review period</th><td>${htmlEscape(record.period_start || '—')} to ${htmlEscape(record.period_end || '—')}</td><th>Appraisal type</th><td>${htmlEscape(APPRAISAL_TYPE_LABELS[record.appraisal_type] || labelise(record.appraisal_type))}</td></tr>
  <tr><th>Cycle</th><td>${htmlEscape(record.cycle_name || '—')}</td><th>Appraisal date</th><td>${htmlEscape(record.appraisal_date)}</td></tr>
  <tr><th>Appraiser</th><td>${htmlEscape(record.appraiser_name || '—')}</td><th>Second-level reviewer</th><td>${htmlEscape(record.reviewer_name || '—')}</td></tr>
</table>

<div class="scores">
  <div class="score-box"><div class="label">Overall</div><div class="value">${summary.overallPercent === null ? '—' : `${summary.overallPercent}%`}</div><div class="sub">${htmlEscape(summary.band || 'Not rated')}</div></div>
  <div class="score-box"><div class="label">Mean rating</div><div class="value">${summary.overallScore === null ? '—' : summary.overallScore}</div><div class="sub">out of ${maxScore}</div></div>
  <div class="score-box"><div class="label">Self-assessment</div><div class="value">${summary.selfPercent === null ? '—' : `${summary.selfPercent}%`}</div><div class="sub">${record.self_assessment_submitted_at ? `Submitted ${htmlEscape(String(record.self_assessment_submitted_at).slice(0, 10))}` : 'Not submitted'}</div></div>
  <div class="score-box"><div class="label">Items rated</div><div class="value">${summary.itemsScored}</div><div class="sub">of ${summary.itemsTotal}</div></div>
  <div class="score-box"><div class="label">Next appraisal</div><div class="value" style="font-size:13px">${htmlEscape(record.next_appraisal_due || '—')}</div><div class="sub">Status: ${htmlEscape(labelise(record.status))}</div></div>
</div>

<h2>Performance against the review criteria</h2>
<p class="legend">Rating scale: ${APPRAISAL_SCALE_5.filter(s => s.score <= maxScore).map(s => `<strong>${s.score}</strong> ${htmlEscape(s.label)}`).join(' &nbsp;·&nbsp; ')}. Weight shows how much each item counts towards the overall figure.</p>
<table>
  <thead><tr><th style="width:4%">#</th><th>Assessed item</th><th style="width:7%" class="tick">Weight</th><th style="width:9%" class="tick">Self</th><th style="width:11%" class="tick">Appraiser</th><th style="width:30%">Comments</th></tr></thead>
  <tbody>${itemRows || '<tr><td colspan="6" class="none">No rated items on this appraisal.</td></tr>'}</tbody>
</table>

<h2>Objectives for the period ahead</h2>
${objectivesHtml}

<h2>Strengths</h2>
<div class="narrative">${htmlText(record.strengths)}</div>

<h2>Areas for development</h2>
<div class="narrative">${htmlText(record.development_areas)}</div>

<h2>Training needs identified</h2>
<div class="narrative">${htmlText(record.training_needs)}</div>

<h2>Development plan</h2>
${developmentHtml}

<h2>Overall recommendation</h2>
<div class="narrative"><strong>${htmlEscape(APPRAISAL_RECOMMENDATION_LABELS[record.recommendation] || 'Not recorded')}</strong></div>

<h2>Appraiser's comments</h2>
<div class="narrative">${htmlText(record.appraiser_comments)}</div>

<h2>Second-level reviewer's comments</h2>
<div class="narrative">${htmlText(record.reviewer_comments)}</div>

<h2>Comments by the member of staff</h2>
<p class="legend">Signing records that the appraisal was discussed. It does not signify agreement; any disagreement belongs in this box.</p>
<div class="narrative">${htmlText(record.employee_comments || record.self_overall_comments)}</div>

${attachmentsHtml}

<div class="signatures">
  ${signatureBlock('Appraiser', record.appraiser_name, record.appraiser_submitted_at)}
  ${signatureBlock('Second-level reviewer', record.reviewer_name, record.reviewed_at)}
  ${signatureBlock('Member of staff', record.staff_name, record.employee_acknowledged_at)}
</div>`;

    audit(req, { action: 'print', entity: 'performance_appraisals', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${record.record_number} — Performance appraisal`,
      documentTitle: 'Performance appraisal record',
      reference: record.record_number,
      referenceLabel: 'Record number',
      body,
      autoprint: req.query.autoprint !== '0',
      footerNote: 'Confidential — between the member of staff, their appraiser and the reviewer.',
    }));
  });

  /** A blank appraisal form from a template, for use away from a screen. */
  router.get('/appraisal-templates/:id/print', requirePermission('personnel.appraisals', 'print'), (req, res) => {
    const db = getDb();
    const template = loadTemplate(db, req.params.id);
    if (!template) return res.status(404).send('Template not found');
    const maxScore = Number(template.max_score) || 5;
    const items = (template.items as Row[]).filter(i => i.is_active);
    const bySection = new Map<string, Row[]>();
    for (const item of items) {
      const key = String(item.section || 'competency');
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(item);
    }
    const rows = APPRAISAL_SECTIONS.filter(s => bySection.has(s)).map(section => `
      <tr class="group-row"><td colspan="6">${htmlEscape(APPRAISAL_SECTION_LABELS[section])}</td></tr>
      ${bySection.get(section)!.map((item, index) => `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(item.item_title)}${item.item_description ? `<br/><small>${htmlEscape(item.item_description)}</small>` : ''}${item.success_measure ? `<br/><small>Measure: ${htmlEscape(item.success_measure)}</small>` : ''}</td>
        <td class="tick">${Number(item.weight) || 1}</td><td></td><td></td><td></td>
      </tr>`).join('')}`).join('');

    const body = `
<table class="meta">
  <tr><th>Member of staff</th><td></td><th>Staff ID</th><td></td></tr>
  <tr><th>Designation</th><td></td><th>Unit / section</th><td></td></tr>
  <tr><th>Review period</th><td></td><th>Appraisal date</th><td></td></tr>
  <tr><th>Appraiser</th><td></td><th>Second-level reviewer</th><td></td></tr>
</table>
${template.description ? `<h2>Purpose</h2><div class="narrative">${htmlText(template.description)}</div>` : ''}

<h2>Performance against the review criteria</h2>
<p class="legend">${APPRAISAL_SCALE_5.filter(s => s.score <= maxScore).map(s => `<strong>${s.score}</strong> ${htmlEscape(s.label)} — ${htmlEscape(s.descriptor)}`).join('<br/>')}</p>
<table>
  <thead><tr><th style="width:4%">#</th><th>Assessed item</th><th style="width:7%" class="tick">Weight</th><th style="width:9%" class="tick">Self</th><th style="width:11%" class="tick">Appraiser</th><th style="width:30%">Comments</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="none">This template has no items yet.</td></tr>'}</tbody>
</table>

<h2>Objectives for the period ahead</h2>
<table><thead><tr><th style="width:4%">#</th><th style="width:38%">Objective</th><th style="width:28%">How success is measured</th><th style="width:14%">Target date</th><th style="width:16%">Weight</th></tr></thead>
<tbody>${[1, 2, 3, 4, 5].map(i => `<tr><td>${i}</td><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>

<h2>Strengths</h2><div class="narrative" style="min-height:60px"></div>
<h2>Areas for development</h2><div class="narrative" style="min-height:60px"></div>
<h2>Development plan</h2><div class="narrative" style="min-height:60px"></div>
<h2>Overall recommendation</h2><div class="narrative" style="min-height:40px"></div>
<h2>Comments by the member of staff</h2><div class="narrative" style="min-height:60px"></div>

<div class="signatures">
  ${signatureBlock('Appraiser')}
  ${signatureBlock('Second-level reviewer')}
  ${signatureBlock('Member of staff')}
</div>`;

    audit(req, { action: 'print', entity: 'appraisal_templates', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${template.template_code} — ${template.title}`,
      documentTitle: 'Performance appraisal form',
      reference: template.template_code,
      referenceLabel: 'Template code',
      body,
      autoprint: req.query.autoprint !== '0',
      footerNote: 'Blank appraisal form — complete, sign and file with the staff record.',
    }));
  });

  /** The cycle at a glance: who is where, and who has not started. */
  router.get('/appraisal-cycles/:id/print', requirePermission('personnel.appraisals', 'print'), (req, res) => {
    const db = getDb();
    const cycle = db.prepare(`SELECT c.*, t.title AS template_title, s.name AS section_name FROM appraisal_cycles c
      LEFT JOIN appraisal_templates t ON t.id = c.template_id LEFT JOIN sections s ON s.id = c.section_id WHERE c.id = ?`).get(req.params.id) as Row | undefined;
    if (!cycle) return res.status(404).send('Cycle not found');
    const rows = db.prepare(`SELECT a.*, s.full_name AS staff_name, s.employee_no, ap.full_name AS appraiser_name, sec.name AS section_name
      FROM performance_appraisals a
      LEFT JOIN staff s ON s.id = a.staff_id
      LEFT JOIN staff ap ON ap.id = a.appraiser_staff_id
      LEFT JOIN sections sec ON sec.id = a.section_id
      WHERE a.cycle_id = ? ORDER BY sec.name, s.full_name`).all(req.params.id) as Row[];

    const body = `
<table class="meta">
  <tr><th>Cycle</th><td>${htmlEscape(cycle.cycle_name)}</td><th>Type</th><td>${htmlEscape(labelise(cycle.cycle_type))}</td></tr>
  <tr><th>Period</th><td>${htmlEscape(cycle.period_start)} to ${htmlEscape(cycle.period_end)}</td><th>Status</th><td>${htmlEscape(labelise(cycle.status))}</td></tr>
  <tr><th>Template</th><td>${htmlEscape(cycle.template_title || '—')}</td><th>Scope</th><td>${htmlEscape(cycle.section_name || 'Whole laboratory')}</td></tr>
</table>
<h2>Appraisals in this cycle</h2>
<table>
  <thead><tr><th style="width:5%">#</th><th style="width:22%">Member of staff</th><th style="width:14%">Unit</th><th style="width:18%">Appraiser</th><th style="width:17%">Stage</th><th style="width:12%" class="tick">Overall</th><th style="width:12%">Rating band</th></tr></thead>
  <tbody>${rows.length ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${htmlEscape(r.staff_name || '—')}${r.employee_no ? `<br/><small>${htmlEscape(r.employee_no)}</small>` : ''}</td><td>${htmlEscape(r.section_name || '—')}</td><td>${htmlEscape(r.appraiser_name || '—')}</td><td>${htmlEscape(labelise(r.status))}</td><td class="tick">${r.overall_percent === null || r.overall_percent === undefined ? '—' : `${r.overall_percent}%`}</td><td>${htmlEscape(r.rating_band || '—')}</td></tr>`).join('') : '<tr><td colspan="7" class="none">No appraisals have been raised in this cycle.</td></tr>'}</tbody>
</table>
<div class="signatures two">
  ${signatureBlock('Prepared by')}
  ${signatureBlock('Head of department')}
</div>`;

    audit(req, { action: 'print', entity: 'appraisal_cycles', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${cycle.cycle_name} — Appraisal cycle`,
      documentTitle: 'Appraisal cycle summary',
      reference: cycle.cycle_name,
      referenceLabel: 'Cycle',
      body,
      autoprint: req.query.autoprint !== '0',
      footerNote: 'Confidential — for management review of appraisal completion.',
    }));
  });

  return router;
}
