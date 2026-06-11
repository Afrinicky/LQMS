import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const INDICATOR_RESULT_STATUSES = ['within_target', 'warning', 'critical', 'pending_review'];

function classifyResult(value: number | null, target: number | null, warning: number | null, critical: number | null): string {
  if (value === null) return 'pending_review';
  // Assume lower-is-worse when warning/critical thresholds are below target,
  // higher-is-worse when above. If only target is set, just within_target.
  if (critical !== null && target !== null) {
    if (critical < target) {
      // lower thresholds: critical < warning < target
      if (value <= critical) return 'critical';
      if (warning !== null && value <= warning) return 'warning';
      return value >= target ? 'within_target' : 'warning';
    } else {
      // upper thresholds: target < warning < critical
      if (value >= critical) return 'critical';
      if (warning !== null && value >= warning) return 'warning';
      return value <= target ? 'within_target' : 'warning';
    }
  }
  if (warning !== null && target !== null) {
    if (warning < target) return value < warning ? 'warning' : 'within_target';
    return value > warning ? 'warning' : 'within_target';
  }
  return 'within_target';
}

export function qualityIndicatorsRoutes() {
  const router = Router();

  router.get('/', requirePermission('quality_indicators', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.isActive !== undefined) { filters.push('is_active = ?'); params.push(req.query.isActive === 'true' ? 1 : 0); }
    let query = 'SELECT * FROM quality_indicators';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY indicator_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/', requirePermission('quality_indicators', 'create'), (req, res) => {
    if (!req.body.indicatorName) return res.status(400).json({ error: 'indicatorName is required' });
    if (!req.body.frequency) return res.status(400).json({ error: 'frequency is required' });
    if (req.body.targetValue === undefined || req.body.targetValue === null || req.body.targetValue === '') return res.status(400).json({ error: 'targetValue is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const indicatorCode = req.body.indicatorCode || generateRecordNumber(db, 'quality_indicators', 'QI', createdAt);
    const result = db.prepare(`INSERT INTO quality_indicators (indicator_code, indicator_name, department_id, section_id, description, numerator_definition, denominator_definition, target_value, warning_threshold, critical_threshold, frequency, responsible_staff_id, reviewer_staff_id, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(indicatorCode, req.body.indicatorName, parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.description ?? null, req.body.numeratorDefinition ?? null, req.body.denominatorDefinition ?? null, Number(req.body.targetValue), req.body.warningThreshold !== undefined && req.body.warningThreshold !== '' ? Number(req.body.warningThreshold) : null, req.body.criticalThreshold !== undefined && req.body.criticalThreshold !== '' ? Number(req.body.criticalThreshold) : null, req.body.frequency, parseIntNullable(req.body.responsibleStaffId), parseIntNullable(req.body.reviewerStaffId), req.body.isActive === false ? 0 : 1, req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'quality_indicators', entityId: id, newValue: { indicatorCode, ...req.body } });
    res.status(201).json({ id, indicatorCode });
  });

  router.post('/results/:id/review', requirePermission('quality_indicators', 'approve'), (req, res) => {
    const db = getDb();
    const result = db.prepare('SELECT * FROM quality_indicator_results WHERE id = ?').get(req.params.id) as any;
    if (!result) return res.status(404).json({ error: 'Result not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE quality_indicator_results SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP, interpretation = COALESCE(?, interpretation), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(staffId, req.body.interpretation ?? null, req.params.id);
    audit(req, { action: 'review', entity: 'quality_indicator_results', entityId: req.params.id, newValue: { reviewedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/results/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('SELECT r.*, i.indicator_name, i.indicator_code FROM quality_indicator_results r JOIN quality_indicators i ON i.id = r.indicator_id WHERE r.id = ?').get(req.params.id) as any;
    if (!result) return res.status(404).json({ error: 'Result not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, result.period_end, detectedBy, 'quality_indicators', String(result.id), req.body.title ?? `Indicator failure: ${result.indicator_name}`, req.body.description ?? `${result.indicator_code} value ${result.calculated_value ?? '—'} flagged ${result.status}`, req.body.category ?? 'quality_indicator', req.body.severity ?? (result.status === 'critical' ? 'high' : 'medium'), 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE quality_indicator_results SET nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('quality_indicators', 'quality_indicator_results', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from quality indicator');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'quality_indicators', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/results/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('SELECT r.*, i.indicator_name FROM quality_indicator_results r JOIN quality_indicators i ON i.id = r.indicator_id WHERE r.id = ?').get(req.params.id) as any;
    if (!result) return res.status(404).json({ error: 'Result not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const capaResult = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'quality_indicators', String(result.id), result.nc_id ?? null, req.body.title ?? `CAPA for indicator: ${result.indicator_name}`, req.body.problemSummary ?? `Indicator value ${result.calculated_value ?? '—'} flagged ${result.status}`, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(capaResult.lastInsertRowid);
    db.prepare('UPDATE quality_indicator_results SET capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('quality_indicators', 'quality_indicator_results', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from quality indicator');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'quality_indicators', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.get('/:id', requirePermission('quality_indicators', 'view'), (req, res) => {
    const db = getDb();
    const indicator = db.prepare('SELECT * FROM quality_indicators WHERE id = ?').get(req.params.id) as any;
    if (!indicator) return res.status(404).json({ error: 'Indicator not found' });
    const results = db.prepare('SELECT * FROM quality_indicator_results WHERE indicator_id = ? ORDER BY period_start DESC, id DESC LIMIT 100').all(req.params.id);
    res.json({ ...indicator, results });
  });

  router.put('/:id', requirePermission('quality_indicators', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM quality_indicators WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Indicator not found' });
    db.prepare(`UPDATE quality_indicators SET indicator_name = ?, department_id = ?, section_id = ?, description = ?, numerator_definition = ?, denominator_definition = ?, target_value = ?, warning_threshold = ?, critical_threshold = ?, frequency = ?, responsible_staff_id = ?, reviewer_staff_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.indicatorName ?? oldValue.indicator_name, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.description ?? oldValue.description, req.body.numeratorDefinition ?? oldValue.numerator_definition, req.body.denominatorDefinition ?? oldValue.denominator_definition, req.body.targetValue !== undefined && req.body.targetValue !== '' ? Number(req.body.targetValue) : oldValue.target_value, req.body.warningThreshold !== undefined && req.body.warningThreshold !== '' ? Number(req.body.warningThreshold) : oldValue.warning_threshold, req.body.criticalThreshold !== undefined && req.body.criticalThreshold !== '' ? Number(req.body.criticalThreshold) : oldValue.critical_threshold, req.body.frequency ?? oldValue.frequency, parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id, parseIntNullable(req.body.reviewerStaffId) ?? oldValue.reviewer_staff_id, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active, req.params.id);
    audit(req, { action: 'edit', entity: 'quality_indicators', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/:id/results', requirePermission('quality_indicators', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM quality_indicator_results WHERE indicator_id = ? ORDER BY period_start DESC, id DESC').all(req.params.id));
  });

  router.post('/:id/results', requirePermission('quality_indicators', 'create'), (req, res) => {
    if (!req.body.periodStart) return res.status(400).json({ error: 'periodStart is required' });
    if (!req.body.periodEnd) return res.status(400).json({ error: 'periodEnd is required' });
    if (req.body.numeratorValue === undefined || req.body.numeratorValue === null || req.body.numeratorValue === '') return res.status(400).json({ error: 'numeratorValue is required' });
    if (req.body.denominatorValue === undefined || req.body.denominatorValue === null || req.body.denominatorValue === '') return res.status(400).json({ error: 'denominatorValue is required' });
    const db = getDb();
    const indicator = db.prepare('SELECT * FROM quality_indicators WHERE id = ?').get(req.params.id) as any;
    if (!indicator) return res.status(404).json({ error: 'Indicator not found' });
    const numerator = Number(req.body.numeratorValue);
    const denominator = Number(req.body.denominatorValue);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return res.status(400).json({ error: 'numerator/denominator must be numeric' });
    const calculated = denominator === 0 ? null : (numerator / denominator) * 100;
    const status = classifyResult(calculated, indicator.target_value, indicator.warning_threshold, indicator.critical_threshold);
    const result = db.prepare(`INSERT INTO quality_indicator_results (indicator_id, period_start, period_end, numerator_value, denominator_value, calculated_value, interpretation, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.id, req.body.periodStart, req.body.periodEnd, numerator, denominator, calculated, req.body.interpretation ?? null, status, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'quality_indicator_results', entityId: id, newValue: { indicatorId: req.params.id, calculated, status, ...req.body } });
    res.status(201).json({ id, calculatedValue: calculated, status });
  });

  return router;
}

export { INDICATOR_RESULT_STATUSES, classifyResult };
