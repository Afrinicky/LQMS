import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

/**
 * Orientation & induction frameworks and the records raised against them.
 *
 * This mirrors the competency framework model: a framework is the laboratory's
 * own induction checklist (grouped items), and a record copies the framework's
 * items so revising a framework later never rewrites a record already in
 * progress. Nothing is in force until a framework is activated.
 *
 * Mounted on the same /api/personnel prefix as the personnel routes. The
 * legacy step-based orientation record endpoints stay in routes/personnel.ts;
 * new framework-based records are raised through /orientations/from-framework
 * and their checklist is toggled through /orientations/:id/items/:itemId.
 */

type Row = Record<string, any>;

const AUDIENCES = ['new_hire', 'existing_staff', 'intern_attachee', 'locum', 'student', 'all_staff'];
const FRAMEWORK_STATUSES = ['draft', 'active', 'archived'];
const ITEM_STATUSES = ['pending', 'completed', 'not_applicable'];

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function loadFramework(db: any, id: number | string): Row | null {
  const framework = db.prepare(`SELECT f.*, d.name AS department_name, s.name AS section_name, a.full_name AS approved_by_name
    FROM orientation_frameworks f
    LEFT JOIN departments d ON d.id = f.department_id
    LEFT JOIN sections s ON s.id = f.section_id
    LEFT JOIN staff a ON a.id = f.approved_by_staff_id
    WHERE f.id = ?`).get(id) as Row | undefined;
  if (!framework) return null;
  framework.items = db.prepare('SELECT * FROM orientation_framework_items WHERE framework_id = ? AND is_active = 1 ORDER BY display_order, id').all(id);
  framework.records_raised = (db.prepare('SELECT COUNT(*) AS c FROM staff_orientations WHERE framework_id = ?').get(id) as Row).c;
  return framework;
}

// Completion of a framework-based record = every item that is not marked
// "not applicable" has been completed (and there is at least one such item).
function recomputeCompletion(db: any, orientationId: number | string) {
  const items = db.prepare("SELECT status FROM staff_orientation_items WHERE orientation_id = ?").all(orientationId) as Row[];
  const applicable = items.filter(i => i.status !== 'not_applicable');
  const complete = applicable.length > 0 && applicable.every(i => i.status === 'completed');
  const current = db.prepare('SELECT status FROM staff_orientations WHERE id = ?').get(orientationId) as Row | undefined;
  const sets: string[] = ['orientation_complete = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const vals: unknown[] = [complete ? 1 : 0];
  // Advance to completed the first time everything is done; do not reopen a
  // record an administrator has already closed or cancelled.
  if (complete && current && current.status === 'in_progress') { sets.push('status = ?'); vals.push('completed'); }
  db.prepare(`UPDATE staff_orientations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, orientationId);
  return complete;
}

export function orientationFrameworkRoutes() {
  const router = Router();

  /* ── Frameworks ───────────────────────────────────────────────────────── */

  router.get('/orientation-frameworks', requirePermission('personnel.orientation', 'view'), (req, res) => {
    const db = getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (req.query.status && FRAMEWORK_STATUSES.includes(String(req.query.status))) { clauses.push('f.status = ?'); params.push(req.query.status); }
    if (req.query.appliesTo) { clauses.push('f.applies_to = ?'); params.push(req.query.appliesTo); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT f.*, d.name AS department_name, s.name AS section_name,
        (SELECT COUNT(*) FROM orientation_framework_items i WHERE i.framework_id = f.id AND i.is_active = 1) AS item_count,
        (SELECT COUNT(DISTINCT i.group_title) FROM orientation_framework_items i WHERE i.framework_id = f.id AND i.is_active = 1) AS group_count,
        (SELECT COUNT(*) FROM staff_orientations o WHERE o.framework_id = f.id) AS record_count
      FROM orientation_frameworks f
      LEFT JOIN departments d ON d.id = f.department_id
      LEFT JOIN sections s ON s.id = f.section_id
      ${where}
      ORDER BY f.status = 'active' DESC, f.is_default DESC, f.title`).all(...params);
    res.json(rows);
  });

  router.post('/orientation-frameworks', requirePermission('personnel.orientation', 'create'), (req, res) => {
    const db = getDb();
    const title = nullableText(req.body.title);
    if (!title) return res.status(400).json({ error: 'A framework title is required.' });
    const appliesTo = AUDIENCES.includes(req.body.appliesTo) ? req.body.appliesTo : 'new_hire';
    const code = nullableText(req.body.frameworkCode) || generateRecordNumber(db, 'orientation_frameworks', 'OF', undefined, 'framework_code');
    if (db.prepare('SELECT 1 FROM orientation_frameworks WHERE framework_code = ?').get(code)) {
      return res.status(400).json({ error: `Framework code ${code} is already in use.` });
    }
    const result = db.prepare(`INSERT INTO orientation_frameworks
      (framework_code, title, applies_to, department_id, section_id, cadre, version_label, purpose, scope,
       validity_months, requires_facilitator_sign_off, requires_staff_sign_off, effective_date, next_review_date,
       status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`).run(
      code, title, appliesTo, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId),
      nullableText(req.body.cadre), nullableText(req.body.versionLabel) || '1.0', nullableText(req.body.purpose),
      nullableText(req.body.scope), parseIntNullable(req.body.validityMonths) ?? 0,
      req.body.requiresFacilitatorSignOff === false ? 0 : 1, req.body.requiresStaffSignOff === false ? 0 : 1,
      nullableText(req.body.effectiveDate), nullableText(req.body.nextReviewDate), req.user?.id ?? null);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'orientation_frameworks', entityId: id, newValue: { code, title } });
    res.status(201).json({ id, frameworkCode: code });
  });

  router.get('/orientation-frameworks/:id', requirePermission('personnel.orientation', 'view'), (req, res) => {
    const framework = loadFramework(getDb(), req.params.id);
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    res.json(framework);
  });

  router.put('/orientation-frameworks/:id', requirePermission('personnel.orientation', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM orientation_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!old) return res.status(404).json({ error: 'Framework not found' });
    db.prepare(`UPDATE orientation_frameworks SET title = ?, applies_to = ?, department_id = ?, section_id = ?, cadre = ?,
      version_label = ?, purpose = ?, scope = ?, validity_months = ?, requires_facilitator_sign_off = ?,
      requires_staff_sign_off = ?, effective_date = ?, next_review_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      nullableText(req.body.title) ?? old.title,
      AUDIENCES.includes(req.body.appliesTo) ? req.body.appliesTo : old.applies_to,
      req.body.departmentId === undefined ? old.department_id : parseIntNullable(req.body.departmentId),
      req.body.sectionId === undefined ? old.section_id : parseIntNullable(req.body.sectionId),
      req.body.cadre === undefined ? old.cadre : nullableText(req.body.cadre),
      nullableText(req.body.versionLabel) ?? old.version_label,
      req.body.purpose === undefined ? old.purpose : nullableText(req.body.purpose),
      req.body.scope === undefined ? old.scope : nullableText(req.body.scope),
      req.body.validityMonths === undefined ? old.validity_months : (parseIntNullable(req.body.validityMonths) ?? 0),
      req.body.requiresFacilitatorSignOff === undefined ? old.requires_facilitator_sign_off : (req.body.requiresFacilitatorSignOff ? 1 : 0),
      req.body.requiresStaffSignOff === undefined ? old.requires_staff_sign_off : (req.body.requiresStaffSignOff ? 1 : 0),
      req.body.effectiveDate === undefined ? old.effective_date : nullableText(req.body.effectiveDate),
      req.body.nextReviewDate === undefined ? old.next_review_date : nullableText(req.body.nextReviewDate),
      req.params.id);
    audit(req, { action: 'edit', entity: 'orientation_frameworks', entityId: Number(req.params.id), oldValue: old, newValue: req.body });
    res.json(loadFramework(db, req.params.id));
  });

  // Activation is the approval step: an induction checklist in use has been
  // agreed by someone with the authority to agree it.
  router.post('/orientation-frameworks/:id/status', requirePermission('personnel.orientation', 'approve'), (req, res) => {
    const db = getDb();
    const status = String(req.body.status);
    if (!FRAMEWORK_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${FRAMEWORK_STATUSES.join(', ')}` });
    const framework = db.prepare('SELECT * FROM orientation_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    if (status === 'active') {
      const items = (db.prepare('SELECT COUNT(*) AS c FROM orientation_framework_items WHERE framework_id = ? AND is_active = 1').get(req.params.id) as Row).c;
      if (!items) return res.status(400).json({ error: 'Add at least one checklist item before activating this framework.' });
      db.prepare(`UPDATE orientation_frameworks SET status = 'active', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(getStaffIdOrCurrent(req, req.body.approvedByStaffId), req.params.id);
    } else {
      db.prepare('UPDATE orientation_frameworks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
    }
    audit(req, { action: status === 'active' ? 'approve' : 'edit', entity: 'orientation_frameworks', entityId: Number(req.params.id), oldValue: { status: framework.status }, newValue: { status } });
    res.json(loadFramework(db, req.params.id));
  });

  // Duplicate a framework and everything in it as a fresh draft — the usual way
  // to revise a checklist already in use without touching the version in force.
  router.post('/orientation-frameworks/:id/duplicate', requirePermission('personnel.orientation', 'create'), (req, res) => {
    const db = getDb();
    const src = db.prepare('SELECT * FROM orientation_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!src) return res.status(404).json({ error: 'Framework not found' });
    const code = generateRecordNumber(db, 'orientation_frameworks', 'OF', undefined, 'framework_code');
    const title = nullableText(req.body.title) || `${src.title} (copy)`;
    const newId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO orientation_frameworks
        (framework_code, title, applies_to, department_id, section_id, cadre, version_label, purpose, scope,
         validity_months, requires_facilitator_sign_off, requires_staff_sign_off, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`).run(
        code, title, src.applies_to, src.department_id, src.section_id, src.cadre,
        nullableText(req.body.versionLabel) || src.version_label, src.purpose, src.scope, src.validity_months,
        src.requires_facilitator_sign_off, src.requires_staff_sign_off, req.user?.id ?? null);
      const id = Number(result.lastInsertRowid);
      const items = db.prepare('SELECT * FROM orientation_framework_items WHERE framework_id = ? AND is_active = 1 ORDER BY display_order, id').all(req.params.id) as Row[];
      const insert = db.prepare('INSERT INTO orientation_framework_items (framework_id, group_title, item_text, item_description, responsible_role, display_order) VALUES (?, ?, ?, ?, ?, ?)');
      for (const it of items) insert.run(id, it.group_title, it.item_text, it.item_description, it.responsible_role, it.display_order);
      return id;
    })();
    audit(req, { action: 'create', entity: 'orientation_frameworks', entityId: newId, newValue: { duplicatedFrom: req.params.id, code } });
    res.status(201).json({ id: newId, frameworkCode: code });
  });

  router.delete('/orientation-frameworks/:id', requirePermission('personnel.orientation', 'void_archive'), (req, res) => {
    const db = getDb();
    const framework = db.prepare('SELECT * FROM orientation_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    const records = (db.prepare('SELECT COUNT(*) AS c FROM staff_orientations WHERE framework_id = ?').get(req.params.id) as Row).c;
    if (records > 0) return res.status(400).json({ error: 'Records have been raised against this framework — archive it instead of deleting it.' });
    db.prepare('DELETE FROM orientation_frameworks WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'orientation_frameworks', entityId: Number(req.params.id), oldValue: framework });
    res.json({ ok: true });
  });

  /* ── Framework items ──────────────────────────────────────────────────── */

  router.post('/orientation-frameworks/:id/items', requirePermission('personnel.orientation', 'edit'), (req, res) => {
    const db = getDb();
    const framework = db.prepare('SELECT id FROM orientation_frameworks WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    const itemText = nullableText(req.body.itemText);
    if (!itemText) return res.status(400).json({ error: 'Item text is required.' });
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(display_order), 0) AS m FROM orientation_framework_items WHERE framework_id = ?').get(req.params.id) as Row).m;
    const result = db.prepare(`INSERT INTO orientation_framework_items (framework_id, group_title, item_text, item_description, responsible_role, display_order) VALUES (?, ?, ?, ?, ?, ?)`).run(
      req.params.id, nullableText(req.body.groupTitle) || 'General', itemText, nullableText(req.body.itemDescription),
      nullableText(req.body.responsibleRole), Number(maxOrder) + 10);
    audit(req, { action: 'create', entity: 'orientation_framework_items', entityId: result.lastInsertRowid, newValue: req.body });
    res.status(201).json(loadFramework(db, req.params.id));
  });

  router.put('/orientation-framework-items/:itemId', requirePermission('personnel.orientation', 'edit'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM orientation_framework_items WHERE id = ?').get(req.params.itemId) as Row | undefined;
    if (!item) return res.status(404).json({ error: 'Item not found' });
    db.prepare(`UPDATE orientation_framework_items SET group_title = ?, item_text = ?, item_description = ?, responsible_role = ?, display_order = ? WHERE id = ?`).run(
      nullableText(req.body.groupTitle) || item.group_title,
      nullableText(req.body.itemText) || item.item_text,
      req.body.itemDescription === undefined ? item.item_description : nullableText(req.body.itemDescription),
      req.body.responsibleRole === undefined ? item.responsible_role : nullableText(req.body.responsibleRole),
      req.body.displayOrder === undefined ? item.display_order : (parseIntNullable(req.body.displayOrder) ?? item.display_order),
      req.params.itemId);
    audit(req, { action: 'edit', entity: 'orientation_framework_items', entityId: Number(req.params.itemId), oldValue: item, newValue: req.body });
    res.json(loadFramework(db, item.framework_id));
  });

  router.delete('/orientation-framework-items/:itemId', requirePermission('personnel.orientation', 'edit'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM orientation_framework_items WHERE id = ?').get(req.params.itemId) as Row | undefined;
    if (!item) return res.status(404).json({ error: 'Item not found' });
    db.prepare('DELETE FROM orientation_framework_items WHERE id = ?').run(req.params.itemId);
    audit(req, { action: 'delete', entity: 'orientation_framework_items', entityId: Number(req.params.itemId), oldValue: item });
    res.json(loadFramework(db, item.framework_id));
  });

  /* ── Records raised against a framework ───────────────────────────────── */

  // Full record with its snapshotted checklist items.
  router.get('/orientations/:id', requirePermission('personnel.orientation', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare(`SELECT o.*, s.full_name AS staff_name, s.employee_no, sec.name AS section_name,
        f.full_name AS facilitator_name
      FROM staff_orientations o
      JOIN staff s ON s.id = o.staff_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN staff f ON f.id = o.facilitator_staff_id
      WHERE o.id = ?`).get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Orientation record not found' });
    record.items = db.prepare(`SELECT i.*, cs.full_name AS completed_by_name
      FROM staff_orientation_items i LEFT JOIN staff cs ON cs.id = i.completed_by_staff_id
      WHERE i.orientation_id = ? ORDER BY i.display_order, i.id`).all(req.params.id);
    res.json(record);
  });

  // Raise a new record against a framework — copies the framework's active
  // items so the checklist is fixed at the point of induction.
  router.post('/orientations/from-framework', requirePermission('personnel.orientation', 'create'), (req, res) => {
    const db = getDb();
    const staffId = parseIntNullable(req.body.staffId);
    const frameworkId = parseIntNullable(req.body.frameworkId);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });
    if (!frameworkId) return res.status(400).json({ error: 'frameworkId is required' });
    const framework = db.prepare("SELECT * FROM orientation_frameworks WHERE id = ?").get(frameworkId) as Row | undefined;
    if (!framework) return res.status(404).json({ error: 'Framework not found' });
    if (framework.status !== 'active') return res.status(400).json({ error: 'Only an active framework can be used to raise an orientation record.' });
    const items = db.prepare('SELECT * FROM orientation_framework_items WHERE framework_id = ? AND is_active = 1 ORDER BY display_order, id').all(frameworkId) as Row[];
    if (items.length === 0) return res.status(400).json({ error: 'This framework has no checklist items.' });

    const newId = db.transaction(() => {
      const result = db.prepare(`INSERT INTO staff_orientations
        (staff_id, hire_date, orientation_start, facilitator_staff_id, notes, status, framework_id, framework_code, framework_title, created_by)
        VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)`).run(
        staffId, nullableText(req.body.hireDate), nullableText(req.body.orientationStart),
        parseIntNullable(req.body.facilitatorStaffId), nullableText(req.body.notes),
        frameworkId, framework.framework_code, framework.title, req.user?.id ?? null);
      const id = Number(result.lastInsertRowid);
      const insert = db.prepare(`INSERT INTO staff_orientation_items
        (orientation_id, framework_item_id, group_title, item_text, item_description, responsible_role, display_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const it of items) insert.run(id, it.id, it.group_title, it.item_text, it.item_description, it.responsible_role, it.display_order);
      return id;
    })();
    audit(req, { action: 'create', entity: 'staff_orientations', entityId: newId, newValue: { staffId, frameworkId, items: items.length } });
    res.status(201).json({ id: newId });
  });

  // Tick, un-tick or set-not-applicable a single checklist item, then recompute
  // whether the record as a whole is complete.
  router.put('/orientations/:id/items/:itemId', requirePermission('personnel.orientation', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM staff_orientations WHERE id = ?').get(req.params.id) as Row | undefined;
    if (!record) return res.status(404).json({ error: 'Orientation record not found' });
    const item = db.prepare('SELECT * FROM staff_orientation_items WHERE id = ? AND orientation_id = ?').get(req.params.itemId, req.params.id) as Row | undefined;
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });
    const status = ITEM_STATUSES.includes(req.body.status) ? req.body.status : item.status;
    const completing = status === 'completed';
    db.prepare(`UPDATE staff_orientation_items SET status = ?, remarks = ?, completed_at = ?, completed_by_staff_id = ? WHERE id = ?`).run(
      status,
      req.body.remarks === undefined ? item.remarks : nullableText(req.body.remarks),
      completing ? (item.completed_at || new Date().toISOString()) : null,
      completing ? getStaffIdOrCurrent(req, req.body.completedByStaffId) : null,
      req.params.itemId);
    const complete = recomputeCompletion(db, req.params.id);
    audit(req, { action: 'edit', entity: 'staff_orientation_items', entityId: Number(req.params.itemId), oldValue: { status: item.status }, newValue: { status } });
    res.json({ ok: true, orientation_complete: complete });
  });

  return router;
}
