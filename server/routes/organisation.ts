import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';

export function organisationRoutes() {
  const router = Router();

  router.get('/summary', requirePermission('organisation', 'view'), (_req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const year = String(new Date().getFullYear());
    const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { count: number }).count;
    const totalRow = db.prepare("SELECT COALESCE(SUM(projected_amount), 0) AS total FROM budget_projections WHERE fiscal_year = ?").get(year) as { total: number };
    res.json({
      codeOfConductRecords: count("SELECT COUNT(*) count FROM code_of_conduct_records WHERE status = 'active'"),
      codeOfConductDueReview: count("SELECT COUNT(*) count FROM code_of_conduct_records WHERE status = 'active' AND review_date IS NOT NULL AND review_date <= ?", today),
      declaredConflicts: count("SELECT COUNT(*) count FROM code_of_conduct_records WHERE conflict_declared = 1"),
      budgetLinesCurrentYear: count("SELECT COUNT(*) count FROM budget_projections WHERE fiscal_year = ?", year),
      budgetTotalCurrentYear: totalRow.total,
      budgetPendingApproval: count("SELECT COUNT(*) count FROM budget_projections WHERE status IN ('draft','submitted')"),
    });
  });

  // ============= Code of conduct =============
  router.get('/code-of-conduct', requirePermission('organisation', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM code_of_conduct_records ORDER BY signed_date DESC, created_at DESC').all());
  });
  router.post('/code-of-conduct', requirePermission('organisation', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'code_of_conduct_records', 'COC', createdAt);
    const r = db.prepare(`INSERT INTO code_of_conduct_records (record_number, staff_id, commitment_type, statement, signed_date, review_date, conflict_declared, conflict_details, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, parseIntNullable(req.body.staffId), req.body.commitmentType ?? 'all', req.body.statement ?? null, req.body.signedDate ?? null, req.body.reviewDate ?? null, req.body.conflictDeclared ? 1 : 0, req.body.conflictDetails ?? null, req.body.status ?? 'active', req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'code_of_conduct_records', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, recordNumber: number });
  });
  router.put('/code-of-conduct/:id', requirePermission('organisation', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM code_of_conduct_records WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Record not found' });
    db.prepare(`UPDATE code_of_conduct_records SET staff_id = ?, commitment_type = ?, statement = ?, signed_date = ?, review_date = ?, conflict_declared = ?, conflict_details = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(parseIntNullable(req.body.staffId) ?? old.staff_id, req.body.commitmentType ?? old.commitment_type, req.body.statement ?? old.statement, req.body.signedDate ?? old.signed_date, req.body.reviewDate ?? old.review_date, req.body.conflictDeclared === undefined ? old.conflict_declared : (req.body.conflictDeclared ? 1 : 0), req.body.conflictDetails ?? old.conflict_details, req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'code_of_conduct_records', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ============= Budget projections =============
  router.get('/budget', requirePermission('organisation', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM budget_projections ORDER BY fiscal_year DESC, category ASC, created_at DESC').all());
  });
  router.post('/budget', requirePermission('organisation', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'budget_projections', 'BUD', createdAt);
    const amount = req.body.projectedAmount === '' || req.body.projectedAmount === undefined || req.body.projectedAmount === null ? null : Number(req.body.projectedAmount);
    const r = db.prepare(`INSERT INTO budget_projections (projection_number, fiscal_year, category, description, projected_amount, currency, responsible_staff_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.fiscalYear ?? String(new Date().getFullYear()), req.body.category ?? null, req.body.description ?? null, amount, req.body.currency ?? 'GHS', parseIntNullable(req.body.responsibleStaffId), req.body.status ?? 'draft', req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'budget_projections', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, projectionNumber: number });
  });
  router.put('/budget/:id', requirePermission('organisation', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM budget_projections WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Budget line not found' });
    const amount = req.body.projectedAmount === undefined ? old.projected_amount : (req.body.projectedAmount === '' || req.body.projectedAmount === null ? null : Number(req.body.projectedAmount));
    db.prepare(`UPDATE budget_projections SET fiscal_year = ?, category = ?, description = ?, projected_amount = ?, currency = ?, responsible_staff_id = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.fiscalYear ?? old.fiscal_year, req.body.category ?? old.category, req.body.description ?? old.description, amount, req.body.currency ?? old.currency, parseIntNullable(req.body.responsibleStaffId) ?? old.responsible_staff_id, req.body.status ?? old.status, req.body.notes ?? old.notes, req.params.id);
    audit(req, { action: 'edit', entity: 'budget_projections', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}
