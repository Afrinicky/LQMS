import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { printSheet, htmlEscape, htmlText, signatureBlock } from '../utils/printLayout.js';

/**
 * Supplier evaluation on the same footing as competency assessment.
 *
 * A framework states, once, what a supplier is judged against — a set of
 * questions grouped by theme, each carrying the standard that defines an
 * acceptable answer. An evaluation is raised against a copy of that framework,
 * scored question by question, concluded with a rating and printed. Raising the
 * evaluation copies the questions onto the record, so revising the framework
 * later never rewrites a rating already given.
 *
 * Access reuses the suppliers permission: anyone who may view suppliers may read
 * frameworks and evaluations; building frameworks takes create/edit; and
 * carrying out an evaluation — raising, scoring, concluding it — takes the
 * approve level on suppliers, which is how "only the managers evaluate" is
 * expressed without inventing a second permission.
 */

const PERM = 'supplier_inventory.suppliers';
const FRAMEWORK_STATUSES = ['draft', 'active', 'archived'];
const OPEN_STATUSES = ['planned', 'in_progress'];
const RATINGS = ['approved', 'approved_conditional', 'not_approved'];
const RATING_LABELS: Record<string, string> = {
  approved: 'Approved', approved_conditional: 'Approved with conditions', not_approved: 'Not approved',
};

type Row = Record<string, any>;

const oneOf = (list: readonly string[], value: unknown, fallback: string) =>
  (typeof value === 'string' && list.includes(value)) ? value : fallback;
const nullableText = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
};
const parseNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const labelise = (value?: string | null) =>
  value ? value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—';

function addMonths(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  if (date.getUTCDate() < day) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/** Weighted score over the questions actually answered; N/A drops out of both sides. */
function scoreEvaluation(db: any, assessmentId: number | string) {
  const items = db.prepare('SELECT * FROM supplier_eval_assessment_items WHERE assessment_id = ?').all(assessmentId) as Row[];
  const assessment = db.prepare('SELECT * FROM supplier_eval_assessments WHERE id = ?').get(assessmentId) as Row;
  const framework = assessment?.framework_id
    ? db.prepare('SELECT * FROM supplier_eval_frameworks WHERE id = ?').get(assessment.framework_id) as Row | undefined
    : undefined;
  const applicable = items.filter(i => !i.not_applicable);
  const scored = applicable.filter(i => i.score !== null && i.score !== undefined);
  let earned = 0, possible = 0;
  for (const item of scored) {
    const weight = Number(item.weight) || 1;
    earned += Number(item.score) * weight;
    possible += Number(item.max_score || 4) * weight;
  }
  const percent = possible > 0 ? (earned / possible) * 100 : null;
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
    passThreshold: framework ? Number(framework.pass_threshold_percent) : (assessment?.pass_threshold_percent ?? 70),
    criticalMustPass: framework ? Number(framework.critical_elements_must_pass) === 1 : true,
    minimumElementScore: floor,
  };
}

function recommendRating(summary: ReturnType<typeof scoreEvaluation>): string | null {
  if (summary.percent === null) return null;
  if (summary.criticalMustPass && summary.criticalFailures > 0) return 'not_approved';
  if (summary.percent >= summary.passThreshold) {
    return summary.elementsBelowFloor > 0 ? 'approved_conditional' : 'approved';
  }
  if (summary.percent >= summary.passThreshold - 15) return 'approved_conditional';
  return 'not_approved';
}

function loadFramework(db: any, id: number | string) {
  const framework = db.prepare(`SELECT f.*, a.full_name AS approved_by_name FROM supplier_eval_frameworks f
    LEFT JOIN staff a ON a.id = f.approved_by_staff_id WHERE f.id = ?`).get(id) as Row | undefined;
  if (!framework) return null;
  framework.groups = db.prepare('SELECT * FROM supplier_eval_framework_groups WHERE framework_id = ? ORDER BY display_order, id').all(id);
  framework.elements = db.prepare('SELECT * FROM supplier_eval_framework_elements WHERE framework_id = ? ORDER BY display_order, id').all(id);
  framework.evaluations_raised = (db.prepare('SELECT COUNT(*) AS c FROM supplier_eval_assessments WHERE framework_id = ?').get(id) as Row).c;
  return framework;
}

function loadEvaluation(db: any, id: number | string) {
  const record = db.prepare(`SELECT c.*, s.name AS supplier_name, s.supplier_code, e.full_name AS evaluator_name,
      r.full_name AS reviewer_name, f.framework_code
    FROM supplier_eval_assessments c
    LEFT JOIN suppliers s ON s.id = c.supplier_id
    LEFT JOIN staff e ON e.id = c.evaluator_staff_id
    LEFT JOIN staff r ON r.id = c.reviewer_staff_id
    LEFT JOIN supplier_eval_frameworks f ON f.id = c.framework_id
    WHERE c.id = ?`).get(id) as Row | undefined;
  if (!record) return null;
  record.items = db.prepare('SELECT * FROM supplier_eval_assessment_items WHERE assessment_id = ? ORDER BY display_order, id').all(id);
  record.score_summary = scoreEvaluation(db, id);
  return record;
}

export function supplierEvaluationRoutes() {
  const router = Router();

  /* ══ Frameworks ══════════════════════════════════════════════════════ */

  router.get('/eval-frameworks', requirePermission(PERM, 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('f.status = ?'); params.push(String(req.query.status)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT f.*,
        (SELECT COUNT(*) FROM supplier_eval_framework_elements e WHERE e.framework_id = f.id AND e.is_active = 1) AS element_count,
        (SELECT COUNT(*) FROM supplier_eval_framework_groups g WHERE g.framework_id = f.id AND g.is_active = 1) AS group_count,
        (SELECT COUNT(*) FROM supplier_eval_assessments c WHERE c.framework_id = f.id) AS evaluation_count
      FROM supplier_eval_frameworks f ${where}
      ORDER BY CASE f.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, f.title`).all(...params));
  });

  router.post('/eval-frameworks', requirePermission(PERM, 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.title);
    if (!title) return res.status(400).json({ error: 'A framework title is required.' });
    const code = nullableText(req.body.frameworkCode) || generateRecordNumber(db, 'supplier_eval_frameworks', 'SEF', undefined, 'framework_code');
    if (db.prepare('SELECT 1 FROM supplier_eval_frameworks WHERE framework_code = ?').get(code)) {
      return res.status(400).json({ error: `Framework code ${code} is already in use.` });
    }
    const result = db.prepare(`INSERT INTO supplier_eval_frameworks
      (framework_code, title, category, version_label, purpose, scope, max_score, pass_threshold_percent,
       minimum_element_score, critical_elements_must_pass, validity_months, requires_review, status,
       effective_date, next_review_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, title, nullableText(req.body.category), nullableText(req.body.versionLabel) || '1.0',
        nullableText(req.body.purpose), nullableText(req.body.scope), parseNumber(req.body.maxScore) ?? 4,
        parseNumber(req.body.passThresholdPercent) ?? 70, parseNumber(req.body.minimumElementScore),
        req.body.criticalElementsMustPass === false ? 0 : 1, parseNumber(req.body.validityMonths) ?? 12,
        req.body.requiresReview === false ? 0 : 1, oneOf(FRAMEWORK_STATUSES, req.body.status, 'draft'),
        nullableText(req.body.effectiveDate), nullableText(req.body.nextReviewDate), req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'supplier_eval_frameworks', entityId: id, newValue: { code, title } });
    res.status(201).json({ id, frameworkCode: code });
  });

  router.get('/eval-frameworks/:id', requirePermission(PERM, 'view'), (req, res) => {
    const framework = loadFramework(getDb(), req.params.id);
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    res.json(framework);
  });

  router.put('/eval-frameworks/:id', requirePermission(PERM, 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM supplier_eval_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Framework not found' });
    db.prepare(`UPDATE supplier_eval_frameworks SET title = ?, category = ?, version_label = ?, purpose = ?, scope = ?,
        max_score = ?, pass_threshold_percent = ?, minimum_element_score = ?, critical_elements_must_pass = ?,
        validity_months = ?, requires_review = ?, effective_date = ?, next_review_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nullableText(req.body.title) ?? old.title, nullableText(req.body.category), nullableText(req.body.versionLabel) ?? old.version_label,
        nullableText(req.body.purpose), nullableText(req.body.scope), parseNumber(req.body.maxScore) ?? old.max_score,
        parseNumber(req.body.passThresholdPercent) ?? old.pass_threshold_percent, parseNumber(req.body.minimumElementScore),
        req.body.criticalElementsMustPass === false ? 0 : 1, parseNumber(req.body.validityMonths) ?? old.validity_months,
        req.body.requiresReview === false ? 0 : 1, nullableText(req.body.effectiveDate), nullableText(req.body.nextReviewDate), req.params.id);
    audit(req, { action: 'edit', entity: 'supplier_eval_frameworks', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/eval-frameworks/:id/status', requirePermission(PERM, 'approve'), (req, res) => {
    const db = getDb();
    const status = oneOf(FRAMEWORK_STATUSES, req.body.status, '');
    if (!status) return res.status(400).json({ error: `status must be one of: ${FRAMEWORK_STATUSES.join(', ')}` });
    const framework = db.prepare('SELECT * FROM supplier_eval_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    if (status === 'active') {
      const elements = (db.prepare('SELECT COUNT(*) AS c FROM supplier_eval_framework_elements WHERE framework_id = ? AND is_active = 1').get(req.params.id) as Row).c;
      if (!elements) return res.status(400).json({ error: 'Add at least one question before activating this framework.' });
      db.prepare(`UPDATE supplier_eval_frameworks SET status = 'active', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP,
          effective_date = COALESCE(effective_date, date('now')),
          next_review_date = COALESCE(next_review_date, date('now', '+1 year')), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    } else {
      db.prepare('UPDATE supplier_eval_frameworks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
    }
    audit(req, { action: status === 'active' ? 'approve' : 'edit', entity: 'supplier_eval_frameworks', entityId: req.params.id, oldValue: { status: framework.status }, newValue: { status } });
    res.json({ ok: true, status });
  });

  router.post('/eval-frameworks/:id/duplicate', requirePermission(PERM, 'create'), (req, res) => {
    const db = getDb();
    const source = loadFramework(db, req.params.id);
    if (!source) return res.status(404).json({ error: 'Framework not found' });
    const code = nullableText(req.body.frameworkCode) || generateRecordNumber(db, 'supplier_eval_frameworks', 'SEF', undefined, 'framework_code');
    const version = nullableText(req.body.versionLabel) || `${source.version_label}.1`;
    const newId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO supplier_eval_frameworks
        (framework_code, title, category, version_label, purpose, scope, max_score, pass_threshold_percent,
         minimum_element_score, critical_elements_must_pass, validity_months, requires_review, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
        .run(code, source.title, source.category, version, source.purpose, source.scope, source.max_score,
          source.pass_threshold_percent, source.minimum_element_score, source.critical_elements_must_pass,
          source.validity_months, source.requires_review, req.user!.id);
      const id = Number(result.lastInsertRowid);
      const groupMap = new Map<number, number>();
      for (const group of source.groups as Row[]) {
        const g = db.prepare('INSERT INTO supplier_eval_framework_groups (framework_id, group_title, group_description, weight, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, group.group_title, group.group_description, group.weight, group.display_order, group.is_active);
        groupMap.set(group.id, Number(g.lastInsertRowid));
      }
      for (const el of source.elements as Row[]) {
        db.prepare(`INSERT INTO supplier_eval_framework_elements (framework_id, group_id, element_code, element_text, performance_criteria, weight, is_critical, display_order, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, el.group_id ? groupMap.get(el.group_id) ?? null : null, el.element_code, el.element_text,
            el.performance_criteria, el.weight, el.is_critical, el.display_order, el.is_active);
      }
      return id;
    })();
    audit(req, { action: 'create', entity: 'supplier_eval_frameworks', entityId: newId, newValue: { duplicatedFrom: req.params.id, code } });
    res.status(201).json({ id: newId, frameworkCode: code });
  });

  router.delete('/eval-frameworks/:id', requirePermission(PERM, 'void_archive'), (req, res) => {
    const db = getDb();
    const framework = db.prepare('SELECT * FROM supplier_eval_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    const used = (db.prepare('SELECT COUNT(*) AS c FROM supplier_eval_assessments WHERE framework_id = ?').get(req.params.id) as Row).c;
    if (used) return res.status(400).json({ error: `${used} evaluation(s) were raised against this framework. Archive it instead of deleting it.` });
    db.transaction(() => {
      db.prepare('DELETE FROM supplier_eval_framework_elements WHERE framework_id = ?').run(req.params.id);
      db.prepare('DELETE FROM supplier_eval_framework_groups WHERE framework_id = ?').run(req.params.id);
      db.prepare('DELETE FROM supplier_eval_frameworks WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'supplier_eval_frameworks', entityId: req.params.id, oldValue: framework });
    res.json({ ok: true });
  });

  /* ── Groups and questions ── */

  router.post('/eval-frameworks/:id/groups', requirePermission(PERM, 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.groupTitle);
    if (!title) return res.status(400).json({ error: 'A group title is required.' });
    if (!db.prepare('SELECT 1 FROM supplier_eval_frameworks WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Framework not found' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM supplier_eval_framework_groups WHERE framework_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare('INSERT INTO supplier_eval_framework_groups (framework_id, group_title, group_description, weight, display_order) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, title, nullableText(req.body.groupDescription), parseNumber(req.body.weight) ?? 1, parseNumber(req.body.displayOrder) ?? nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.delete('/eval-frameworks/:id/groups/:groupId', requirePermission(PERM, 'edit'), (req, res) => {
    const db = getDb();
    const group = db.prepare('SELECT * FROM supplier_eval_framework_groups WHERE id = ? AND framework_id = ?').get(req.params.groupId, req.params.id) as Row | undefined;
    if (!group) return res.status(404).json({ error: 'Group not found' });
    db.transaction(() => {
      db.prepare('DELETE FROM supplier_eval_framework_elements WHERE group_id = ?').run(req.params.groupId);
      db.prepare('DELETE FROM supplier_eval_framework_groups WHERE id = ?').run(req.params.groupId);
    })();
    audit(req, { action: 'delete', entity: 'supplier_eval_framework_groups', entityId: req.params.groupId, oldValue: group });
    res.json({ ok: true });
  });

  router.post('/eval-frameworks/:id/elements', requirePermission(PERM, 'create'), (req, res) => {
    const db = getDb();
    const text = nullableText(req.body.elementText);
    if (!text) return res.status(400).json({ error: 'A question is required.' });
    if (!db.prepare('SELECT 1 FROM supplier_eval_frameworks WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Framework not found' });
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 10 AS o FROM supplier_eval_framework_elements WHERE framework_id = ?').get(req.params.id) as Row).o;
    const result = db.prepare(`INSERT INTO supplier_eval_framework_elements (framework_id, group_id, element_code, element_text, performance_criteria, weight, is_critical, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, parseIntNullable(req.body.groupId), nullableText(req.body.elementCode), text, nullableText(req.body.performanceCriteria),
        parseNumber(req.body.weight) ?? 1, req.body.isCritical ? 1 : 0, parseNumber(req.body.displayOrder) ?? nextOrder);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });

  router.put('/eval-frameworks/:id/elements/:elementId', requirePermission(PERM, 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM supplier_eval_framework_elements WHERE id = ? AND framework_id = ?').get(req.params.elementId, req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Question not found' });
    db.prepare(`UPDATE supplier_eval_framework_elements SET group_id = ?, element_code = ?, element_text = ?, performance_criteria = ?,
        weight = ?, is_critical = ?, display_order = ?, is_active = ? WHERE id = ?`)
      .run(parseIntNullable(req.body.groupId), nullableText(req.body.elementCode), nullableText(req.body.elementText) ?? old.element_text,
        nullableText(req.body.performanceCriteria), parseNumber(req.body.weight) ?? old.weight, req.body.isCritical ? 1 : 0,
        parseNumber(req.body.displayOrder) ?? old.display_order, req.body.isActive === false ? 0 : 1, req.params.elementId);
    res.json({ ok: true });
  });

  router.delete('/eval-frameworks/:id/elements/:elementId', requirePermission(PERM, 'edit'), (req, res) => {
    const db = getDb();
    const element = db.prepare('SELECT * FROM supplier_eval_framework_elements WHERE id = ? AND framework_id = ?').get(req.params.elementId, req.params.id) as Row | undefined;
    if (!element) return res.status(404).json({ error: 'Question not found' });
    db.prepare('DELETE FROM supplier_eval_framework_elements WHERE id = ?').run(req.params.elementId);
    audit(req, { action: 'delete', entity: 'supplier_eval_framework_elements', entityId: req.params.elementId, oldValue: element });
    res.json({ ok: true });
  });

  /* ══ Evaluations ═════════════════════════════════════════════════════ */

  router.get('/eval-assessments', requirePermission(PERM, 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.supplierId) { filters.push('c.supplier_id = ?'); params.push(Number(req.query.supplierId)); }
    if (req.query.status) { filters.push('c.status = ?'); params.push(String(req.query.status)); }
    if (req.query.rating) { filters.push('c.rating = ?'); params.push(String(req.query.rating)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    res.json(db.prepare(`SELECT c.*, s.name AS supplier_name, s.supplier_code, e.full_name AS evaluator_name, f.framework_code
      FROM supplier_eval_assessments c
      LEFT JOIN suppliers s ON s.id = c.supplier_id
      LEFT JOIN staff e ON e.id = c.evaluator_staff_id
      LEFT JOIN supplier_eval_frameworks f ON f.id = c.framework_id
      ${where} ORDER BY c.evaluation_date DESC, c.id DESC`).all(...params));
  });

  // Raising and running an evaluation is a manager action: it takes the approve
  // level on suppliers, not merely the right to add one.
  router.post('/eval-assessments', requirePermission(PERM, 'approve'), (req, res) => {
    const db = getDb();
    const supplierId = parseIntNullable(req.body.supplierId);
    if (!supplierId) return res.status(400).json({ error: 'A supplier is required.' });
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) return res.status(400).json({ error: 'That supplier no longer exists.' });
    const evaluationDate = nullableText(req.body.evaluationDate);
    if (!evaluationDate) return res.status(400).json({ error: 'An evaluation date is required.' });
    const frameworkId = parseIntNullable(req.body.frameworkId);
    const framework = frameworkId ? loadFramework(db, frameworkId) : null;
    if (frameworkId && !framework) return res.status(400).json({ error: 'The chosen framework no longer exists.' });
    if (framework && framework.status === 'archived') return res.status(400).json({ error: 'That framework has been archived and cannot be used for a new evaluation.' });
    if (!framework) return res.status(400).json({ error: 'Choose a framework to evaluate against.' });

    const number = generateRecordNumber(db, 'supplier_eval_assessments', 'SEV', new Date().toISOString(), 'evaluation_number');
    const id = db.transaction(() => {
      const result = db.prepare(`INSERT INTO supplier_eval_assessments
        (evaluation_number, supplier_id, framework_id, framework_title, framework_version, evaluation_date, period_label, purpose,
         evaluator_staff_id, max_score, pass_threshold_percent, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`)
        .run(number, supplierId, frameworkId, framework.title, framework.version_label, evaluationDate,
          nullableText(req.body.periodLabel), nullableText(req.body.purpose), getStaffIdOrCurrent(req, req.body.evaluatorStaffId),
          Number(framework.max_score), Number(framework.pass_threshold_percent), req.user!.id);
      const assessmentId = Number(result.lastInsertRowid);
      const groups = new Map<number, Row>((framework.groups as Row[]).map(g => [g.id, g]));
      const insert = db.prepare(`INSERT INTO supplier_eval_assessment_items
        (assessment_id, framework_element_id, group_title, element_code, element_text, performance_criteria, max_score, weight, is_critical, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let order = 0;
      for (const el of framework.elements as Row[]) {
        if (!el.is_active) continue;
        insert.run(assessmentId, el.id, el.group_id ? groups.get(el.group_id)?.group_title ?? null : null, el.element_code,
          el.element_text, el.performance_criteria, Number(framework.max_score), el.weight, el.is_critical, order += 10);
      }
      db.prepare('UPDATE supplier_eval_assessments SET elements_total = (SELECT COUNT(*) FROM supplier_eval_assessment_items WHERE assessment_id = ?) WHERE id = ?')
        .run(assessmentId, assessmentId);
      return assessmentId;
    })();
    audit(req, { action: 'create', entity: 'supplier_eval_assessments', entityId: id, newValue: { number, supplierId, frameworkId } });
    res.status(201).json({ id, evaluationNumber: number });
  });

  router.get('/eval-assessments/:id', requirePermission(PERM, 'view'), (req, res) => {
    const record = loadEvaluation(getDb(), req.params.id);
    if (!record) return res.status(404).json({ error: 'Evaluation not found' });
    res.json(record);
  });

  function assertScorable(record: Row | undefined) {
    if (!record) return 'Evaluation not found';
    if (record.status === 'completed') return 'This evaluation is closed and can no longer be scored.';
    return null;
  }

  router.put('/eval-assessments/:id/items', requirePermission(PERM, 'approve'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM supplier_eval_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    const problem = assertScorable(record);
    if (problem) return res.status(record ? 400 : 404).json({ error: problem });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No question scores were supplied.' });
    const update = db.prepare(`UPDATE supplier_eval_assessment_items SET score = ?, not_applicable = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND assessment_id = ?`);
    let saved = 0;
    db.transaction(() => {
      for (const item of items) {
        const itemId = parseIntNullable(item.id);
        if (!itemId) continue;
        const existing = db.prepare('SELECT * FROM supplier_eval_assessment_items WHERE id = ? AND assessment_id = ?').get(itemId, req.params.id) as Row | undefined;
        if (!existing) continue;
        const notApplicable = item.notApplicable ? 1 : 0;
        let score = notApplicable ? null : parseNumber(item.score);
        if (score !== null) score = Math.max(0, Math.min(Number(existing.max_score) || 4, score));
        update.run(score, notApplicable, nullableText(item.remarks), itemId, req.params.id);
        saved++;
      }
      const summary = scoreEvaluation(db, req.params.id);
      db.prepare(`UPDATE supplier_eval_assessments SET total_score = ?, score_percent = ?, elements_assessed = ?, elements_total = ?,
        critical_failures = ?, status = CASE WHEN status = 'planned' THEN 'in_progress' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(summary.earned, summary.percent, summary.elementsAssessed, summary.elementsTotal, summary.criticalFailures, req.params.id);
    })();
    audit(req, { action: 'edit', entity: 'supplier_eval_assessment_items', entityId: req.params.id, newValue: { saved } });
    res.json({ ok: true, saved, summary: scoreEvaluation(db, req.params.id) });
  });

  router.get('/eval-assessments/:id/score-summary', requirePermission(PERM, 'view'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM supplier_eval_assessments WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Evaluation not found' });
    const summary = scoreEvaluation(db, req.params.id);
    res.json({ ...summary, recommendedRating: recommendRating(summary) });
  });

  /** Close the evaluation, and feed the supplier register so its status stays true. */
  router.post('/eval-assessments/:id/complete', requirePermission(PERM, 'approve'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM supplier_eval_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Evaluation not found' });
    if (record.status === 'completed') return res.status(400).json({ error: 'This evaluation is already completed.' });
    const summary = scoreEvaluation(db, req.params.id);
    if (summary.elementsTotal > 0 && summary.elementsAssessed === 0) {
      return res.status(400).json({ error: 'Score at least one question before concluding the evaluation.' });
    }
    const recommended = recommendRating(summary);
    const rating = oneOf(RATINGS, req.body.rating, recommended ?? '');
    if (!rating) return res.status(400).json({ error: `rating must be one of: ${RATINGS.join(', ')}` });
    const framework = record.framework_id ? db.prepare('SELECT * FROM supplier_eval_frameworks WHERE id = ?').get(record.framework_id) as Row | undefined : undefined;
    const validity = framework ? Number(framework.validity_months) : 12;
    const nextDue = nullableText(req.body.nextEvaluationDue) ?? addMonths(String(record.evaluation_date), rating === 'not_approved' ? Math.min(3, validity) : validity);

    db.transaction(() => {
      db.prepare(`UPDATE supplier_eval_assessments SET rating = ?, status = 'completed', total_score = ?, score_percent = ?,
          elements_assessed = ?, elements_total = ?, critical_failures = ?, pass_threshold_percent = ?,
          findings = COALESCE(?, findings), action_required = COALESCE(?, action_required), next_evaluation_due = ?,
          completed_at = CURRENT_TIMESTAMP, completed_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(rating, summary.earned, summary.percent, summary.elementsAssessed, summary.elementsTotal, summary.criticalFailures,
          summary.passThreshold, nullableText(req.body.findings), nullableText(req.body.actionRequired), nextDue,
          getStaffIdOrCurrent(req, null), req.params.id);
      // Feed the plain supplier register and the supplier's own evaluation status,
      // so the framework evaluation is what "overdue / current" is measured from.
      db.prepare(`INSERT INTO supplier_evaluations (supplier_id, evaluation_date, evaluated_by_staff_id, rating, findings, action_required, next_evaluation_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.supplier_id, record.evaluation_date, record.evaluator_staff_id, RATING_LABELS[rating],
          nullableText(req.body.findings) ?? record.findings, nullableText(req.body.actionRequired) ?? record.action_required, nextDue, req.user!.id);
      db.prepare('UPDATE suppliers SET last_evaluation_date = ?, next_evaluation_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(record.evaluation_date, nextDue, record.supplier_id);
    })();
    audit(req, { action: 'complete', entity: 'supplier_eval_assessments', entityId: req.params.id, newValue: { rating, scorePercent: summary.percent } });
    res.json({ ok: true, rating, nextEvaluationDue: nextDue, summary });
  });

  router.post('/eval-assessments/:id/review', requirePermission(PERM, 'approve'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM supplier_eval_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Evaluation not found' });
    const reviewerStaffId = getStaffIdOrCurrent(req, null);
    if (reviewerStaffId && reviewerStaffId === record.evaluator_staff_id) {
      return res.status(400).json({ error: 'The review must be carried out by somebody other than the evaluator.' });
    }
    db.prepare('UPDATE supplier_eval_assessments SET reviewer_staff_id = ?, reviewer_comments = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reviewerStaffId, nullableText(req.body.reviewerComments), req.params.id);
    audit(req, { action: 'review', entity: 'supplier_eval_assessments', entityId: req.params.id, newValue: { reviewerStaffId } });
    res.json({ ok: true });
  });

  router.delete('/eval-assessments/:id', requirePermission(PERM, 'approve'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM supplier_eval_assessments WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Evaluation not found' });
    db.transaction(() => {
      db.prepare('DELETE FROM supplier_eval_assessment_items WHERE assessment_id = ?').run(req.params.id);
      db.prepare('DELETE FROM supplier_eval_assessments WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'supplier_eval_assessments', entityId: req.params.id, oldValue: record });
    res.json({ ok: true });
  });

  /* ══ Print ═══════════════════════════════════════════════════════════ */

  router.get('/eval-assessments/:id/print', requirePermission(PERM, 'print'), (req, res) => {
    const db = getDb();
    const record = loadEvaluation(db, req.params.id);
    if (!record) return res.status(404).send('Evaluation not found');
    const summary = record.score_summary as ReturnType<typeof scoreEvaluation>;
    const maxScore = Number(record.max_score) || 4;
    const grouped = new Map<string, Row[]>();
    for (const item of record.items as Row[]) {
      const key = item.group_title || 'Assessed questions';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }
    const scalePoints = Array.from({ length: maxScore }, (_, i) => maxScore - i);
    const rows = Array.from(grouped.entries()).map(([group, items]) => `
      <tr class="group-row"><td colspan="${4 + maxScore}">${htmlEscape(group)}</td></tr>
      ${items.map((item, index) => `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(item.element_text)}${item.is_critical ? ' <strong>(critical)</strong>' : ''}${item.performance_criteria ? `<br/><small>${htmlEscape(item.performance_criteria)}</small>` : ''}</td>
        ${scalePoints.map(p => `<td class="tick">${!item.not_applicable && Number(item.score) === p ? '✓' : ''}</td>`).join('')}
        <td class="tick">${item.not_applicable ? 'N/A' : (item.score ?? '—')}</td>
        <td>${htmlEscape(item.remarks || '')}</td>
      </tr>`).join('')}`).join('');

    const body = `
<table class="meta">
  <tr><th>Supplier</th><td>${htmlEscape(record.supplier_name || '—')}</td><th>Supplier code</th><td>${htmlEscape(record.supplier_code || '—')}</td></tr>
  <tr><th>Framework</th><td>${htmlEscape(record.framework_title || '—')}${record.framework_version ? ` (v${htmlEscape(record.framework_version)})` : ''}</td><th>Evaluation date</th><td>${htmlEscape(record.evaluation_date)}</td></tr>
  <tr><th>Evaluator</th><td>${htmlEscape(record.evaluator_name || '—')}</td><th>Reviewer</th><td>${htmlEscape(record.reviewer_name || '—')}</td></tr>
  <tr><th>Purpose</th><td colspan="3">${htmlText(record.purpose)}</td></tr>
</table>
<div class="scores">
  <div class="score-box"><div class="label">Overall score</div><div class="value">${summary.percent === null ? '—' : `${summary.percent}%`}</div><div class="sub">Pass mark ${summary.passThreshold}%</div></div>
  <div class="score-box"><div class="label">Questions scored</div><div class="value">${summary.elementsAssessed}</div><div class="sub">of ${summary.elementsTotal}</div></div>
  <div class="score-box"><div class="label">Critical shortfalls</div><div class="value">${summary.criticalFailures}</div><div class="sub">${summary.minimumElementScore === null ? 'No floor set' : `Floor ${summary.minimumElementScore}`}</div></div>
  <div class="score-box"><div class="label">Rating</div><div class="value" style="font-size:13px">${htmlEscape(record.rating ? RATING_LABELS[record.rating] : 'Not concluded')}</div><div class="sub">Next due: ${htmlEscape(record.next_evaluation_due || '—')}</div></div>
</div>
<h2>Assessed questions</h2>
<table>
  <thead><tr><th style="width:4%">#</th><th>Question and standard</th>${scalePoints.map(p => `<th style="width:4%" class="tick">${p}</th>`).join('')}<th style="width:6%" class="tick">Score</th><th style="width:22%">Remarks</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="${4 + maxScore}" class="none">No questions were recorded.</td></tr>`}</tbody>
</table>
<h2>Findings</h2><div class="narrative">${htmlText(record.findings)}</div>
<h2>Action required</h2><div class="narrative">${htmlText(record.action_required)}</div>
<h2>Reviewer's comments</h2><div class="narrative">${htmlText(record.reviewer_comments)}</div>
<div class="signatures two">
  ${signatureBlock('Evaluator', record.evaluator_name, record.completed_at)}
  ${signatureBlock('Reviewer', record.reviewer_name, record.reviewed_at)}
</div>`;
    audit(req, { action: 'print', entity: 'supplier_eval_assessments', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${record.evaluation_number} — Supplier evaluation`,
      documentTitle: 'Supplier evaluation record',
      reference: record.evaluation_number, referenceLabel: 'Evaluation number',
      body, autoprint: req.query.autoprint !== '0',
    }));
  });

  router.get('/eval-frameworks/:id/print', requirePermission(PERM, 'print'), (req, res) => {
    const db = getDb();
    const framework = loadFramework(db, req.params.id);
    if (!framework) return res.status(404).send('Framework not found');
    const maxScore = Number(framework.max_score) || 4;
    const scalePoints = Array.from({ length: maxScore }, (_, i) => maxScore - i);
    const groups = framework.groups as Row[];
    const elements = (framework.elements as Row[]).filter(e => e.is_active);
    const ungrouped = elements.filter(e => !e.group_id);
    const renderGroup = (title: string, rows: Row[]) => rows.length === 0 ? '' : `
      <tr class="group-row"><td colspan="${3 + maxScore}">${htmlEscape(title)}</td></tr>
      ${rows.map((el, index) => `<tr>
        <td>${index + 1}</td>
        <td>${htmlEscape(el.element_text)}${el.is_critical ? ' <strong>(critical)</strong>' : ''}${el.performance_criteria ? `<br/><small>${htmlEscape(el.performance_criteria)}</small>` : ''}</td>
        ${scalePoints.map(() => '<td class="tick"></td>').join('')}
        <td></td>
      </tr>`).join('')}`;
    const body = `
<table class="meta">
  <tr><th>Supplier</th><td></td><th>Supplier code</th><td></td></tr>
  <tr><th>Framework</th><td>${htmlEscape(framework.title)} (v${htmlEscape(framework.version_label)})</td><th>Evaluation date</th><td></td></tr>
  <tr><th>Evaluator</th><td></td><th>Reviewer</th><td></td></tr>
</table>
${framework.purpose ? `<h2>Purpose</h2><div class="narrative">${htmlText(framework.purpose)}</div>` : ''}
<h2>Questions</h2>
<p class="legend">Pass mark ${htmlEscape(framework.pass_threshold_percent)}%${framework.minimum_element_score ? `, with no single question below ${htmlEscape(framework.minimum_element_score)}` : ''}. Re-evaluate every ${htmlEscape(framework.validity_months)} months.</p>
<table>
  <thead><tr><th style="width:4%">#</th><th>Question and standard</th>${scalePoints.map(p => `<th style="width:4%" class="tick">${p}</th>`).join('')}<th style="width:22%">Remarks</th></tr></thead>
  <tbody>
    ${groups.filter(g => g.is_active).map(g => renderGroup(g.group_title, elements.filter(e => e.group_id === g.id))).join('')}
    ${renderGroup('Other questions', ungrouped)}
  </tbody>
</table>
<h2>Findings</h2><div class="narrative" style="min-height:70px"></div>
<div class="signatures two">${signatureBlock('Evaluator')}${signatureBlock('Reviewer')}</div>`;
    audit(req, { action: 'print', entity: 'supplier_eval_frameworks', entityId: req.params.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(printSheet({
      title: `${framework.framework_code} — ${framework.title}`,
      documentTitle: 'Supplier evaluation form',
      reference: framework.framework_code, referenceLabel: 'Framework code',
      body, autoprint: req.query.autoprint !== '0',
      footerNote: 'Blank supplier evaluation form — complete, sign and file.',
    }));
  });

  return router;
}
