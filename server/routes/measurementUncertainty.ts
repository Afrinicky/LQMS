import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const MU_STATUSES = ['draft', 'in_review', 'approved', 'archived', 'rejected'];

export function measurementUncertaintyRoutes() {
  const router = Router();

  router.get('/', requirePermission('measurement_uncertainty', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT mu.*, e.name AS equipment_name FROM measurement_uncertainty_records mu LEFT JOIN equipment_items e ON e.id = mu.equipment_id ORDER BY mu.calculation_date DESC, mu.id DESC`).all());
  });

  router.post('/', requirePermission('measurement_uncertainty', 'create'), (req, res) => {
    if (!req.body.testName) return res.status(400).json({ error: 'testName is required' });
    if (!req.body.analyte) return res.status(400).json({ error: 'analyte is required' });
    if (!req.body.calculationDate) return res.status(400).json({ error: 'calculationDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const muNumber = generateRecordNumber(db, 'measurement_uncertainty_records', 'MU', createdAt);
    const status = req.body.status ?? 'draft';
    if (!MU_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${MU_STATUSES.join(', ')}` });
    const numericOrNull = (v: unknown) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
    const evidenceFileId = parseIntNullable(req.body.evidenceFileId);
    const equipmentId = parseIntNullable(req.body.equipmentId);
    const result = db.prepare(`INSERT INTO measurement_uncertainty_records (mu_number, department_id, section_id, test_name, analyte, method_name, equipment_id, calculation_date, data_period_start, data_period_end, source_data, mean_value, sd_value, cv_percent, uncertainty_value, expanded_uncertainty, coverage_factor, interpretation, status, evidence_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        muNumber,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.testName,
        req.body.analyte,
        req.body.methodName ?? null,
        equipmentId,
        req.body.calculationDate,
        req.body.dataPeriodStart ?? null,
        req.body.dataPeriodEnd ?? null,
        req.body.sourceData ?? null,
        numericOrNull(req.body.meanValue),
        numericOrNull(req.body.sdValue),
        numericOrNull(req.body.cvPercent),
        numericOrNull(req.body.uncertaintyValue),
        numericOrNull(req.body.expandedUncertainty),
        numericOrNull(req.body.coverageFactor),
        req.body.interpretation ?? null,
        status,
        evidenceFileId,
        req.user!.id,
        createdAt
      );
    const muId = Number(result.lastInsertRowid);
    if (evidenceFileId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('measurement_uncertainty', 'measurement_uncertainty_records', String(muId), 'documents', 'files', String(evidenceFileId), 'Evidence for MU record');
    }
    if (equipmentId) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('measurement_uncertainty', 'measurement_uncertainty_records', String(muId), 'equipment', 'equipment_items', String(equipmentId), 'MU calculated for equipment');
    }
    audit(req, { action: 'create', entity: 'measurement_uncertainty_records', entityId: muId, newValue: { muNumber, ...req.body } });
    res.status(201).json({ id: muId, muNumber });
  });

  router.get('/:id', requirePermission('measurement_uncertainty', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT mu.*, e.name AS equipment_name FROM measurement_uncertainty_records mu LEFT JOIN equipment_items e ON e.id = mu.equipment_id WHERE mu.id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Measurement uncertainty record not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('measurement_uncertainty', 'measurement_uncertainty_records', String(req.params.id), 'measurement_uncertainty', 'measurement_uncertainty_records', String(req.params.id));
    res.json({ ...record, links });
  });

  router.put('/:id', requirePermission('measurement_uncertainty', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM measurement_uncertainty_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Measurement uncertainty record not found' });
    if (req.body.status && !MU_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${MU_STATUSES.join(', ')}` });
    const numericOrFallback = (v: unknown, fallback: number | null) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : fallback;
    db.prepare(`UPDATE measurement_uncertainty_records SET department_id = ?, section_id = ?, test_name = ?, analyte = ?, method_name = ?, equipment_id = ?, calculation_date = ?, data_period_start = ?, data_period_end = ?, source_data = ?, mean_value = ?, sd_value = ?, cv_percent = ?, uncertainty_value = ?, expanded_uncertainty = ?, coverage_factor = ?, interpretation = ?, status = ?, evidence_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.testName ?? oldValue.test_name,
        req.body.analyte ?? oldValue.analyte,
        req.body.methodName ?? oldValue.method_name,
        parseIntNullable(req.body.equipmentId) ?? oldValue.equipment_id,
        req.body.calculationDate ?? oldValue.calculation_date,
        req.body.dataPeriodStart ?? oldValue.data_period_start,
        req.body.dataPeriodEnd ?? oldValue.data_period_end,
        req.body.sourceData ?? oldValue.source_data,
        numericOrFallback(req.body.meanValue, oldValue.mean_value),
        numericOrFallback(req.body.sdValue, oldValue.sd_value),
        numericOrFallback(req.body.cvPercent, oldValue.cv_percent),
        numericOrFallback(req.body.uncertaintyValue, oldValue.uncertainty_value),
        numericOrFallback(req.body.expandedUncertainty, oldValue.expanded_uncertainty),
        numericOrFallback(req.body.coverageFactor, oldValue.coverage_factor),
        req.body.interpretation ?? oldValue.interpretation,
        req.body.status ?? oldValue.status,
        parseIntNullable(req.body.evidenceFileId) ?? oldValue.evidence_file_id,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'measurement_uncertainty_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/:id/review', requirePermission('measurement_uncertainty', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM measurement_uncertainty_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Measurement uncertainty record not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE measurement_uncertainty_records SET reviewed_by_staff_id = ?, status = ?, interpretation = COALESCE(?, interpretation), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reviewedBy, req.body.status ?? 'in_review', req.body.interpretation ?? null, req.params.id);
    audit(req, { action: 'edit', entity: 'measurement_uncertainty_records', entityId: req.params.id, oldValue, newValue: { reviewedByStaffId: reviewedBy, status: req.body.status ?? 'in_review' } });
    res.json({ ok: true });
  });

  router.post('/:id/approve', requirePermission('measurement_uncertainty', 'approve'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM measurement_uncertainty_records WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Measurement uncertainty record not found' });
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (approvedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE measurement_uncertainty_records SET approved_by_staff_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(approvedBy, req.body.status ?? 'approved', req.params.id);
    audit(req, { action: 'approve', entity: 'measurement_uncertainty_records', entityId: req.params.id, oldValue, newValue: { approvedByStaffId: approvedBy, status: req.body.status ?? 'approved' } });
    res.json({ ok: true });
  });

  return router;
}

export { MU_STATUSES };
