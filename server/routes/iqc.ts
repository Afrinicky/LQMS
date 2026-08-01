import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';

const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const IQC_MATERIAL_HEADERS = ['Material name', 'Test', 'Analyte', 'Lot number', 'Manufacturer', 'Expiry date', 'Storage condition', 'Target mean', 'Target SD', 'Acceptable low', 'Acceptable high', 'Section'] as const;

type PriorResult = { result_value: number };
type SiblingZ = { z_score: number };

function evaluateIqcRules(value: number, material: any, prior: PriorResult[], siblings: SiblingZ[]): { status: string; rule: string | null; zScore: number | null } {
  const low = material.acceptable_low;
  const high = material.acceptable_high;
  const mean = material.target_mean;
  const sd = material.target_sd;
  const hasStats = mean !== null && mean !== undefined && sd !== null && sd !== undefined && sd > 0;
  const zScore = hasStats ? (value - mean) / sd : null;

  if (low !== null && low !== undefined && value < low) return { status: 'out_of_control', rule: 'out_of_range', zScore };
  if (high !== null && high !== undefined && value > high) return { status: 'out_of_control', rule: 'out_of_range', zScore };

  if (!hasStats || zScore === null) return { status: 'accepted', rule: 'within_control', zScore };

  if (Math.abs(zScore) > 3) return { status: 'out_of_control', rule: 'reject_1_3s', zScore };

  // Prior results are most-recent first
  const priorZ = prior.map(r => (r.result_value - mean) / sd);

  if (Math.abs(zScore) > 2) {
    if (priorZ.length >= 1) {
      const prev = priorZ[0];
      if (Math.abs(prev) > 2 && Math.sign(prev) === Math.sign(zScore)) {
        return { status: 'out_of_control', rule: 'reject_2_2s', zScore };
      }
      if (Math.abs(prev) > 2 && Math.sign(prev) !== Math.sign(zScore) && Math.abs(zScore - prev) >= 4) {
        return { status: 'out_of_control', rule: 'reject_R_4s', zScore };
      }
    }
    // 2of3_2s across control materials in the same run: current + at least one sibling
    // both beyond ±2 SD on the same side (sample of 3 = current plus up to two siblings)
    const siblingsSameSide = siblings.filter(s => Math.sign(s.z_score) === Math.sign(zScore) && Math.abs(s.z_score) > 2);
    if (siblingsSameSide.length >= 1 && siblings.length >= 1) {
      return { status: 'out_of_control', rule: 'reject_2of3_2s', zScore };
    }
    // R_4s across control materials: current and a sibling differ by ≥4 SD on opposite sides
    const oppositeFarSibling = siblings.find(s => Math.sign(s.z_score) !== Math.sign(zScore) && Math.abs(zScore - s.z_score) >= 4);
    if (oppositeFarSibling) {
      return { status: 'out_of_control', rule: 'reject_R_4s', zScore };
    }
    return { status: 'warning', rule: 'warning_1_2s', zScore };
  }

  if (priorZ.length >= 3) {
    const window4 = [zScore, ...priorZ.slice(0, 3)];
    if (window4.every(z => z > 1) || window4.every(z => z < -1)) {
      return { status: 'out_of_control', rule: 'reject_4_1s', zScore };
    }
  }

  if (priorZ.length >= 9) {
    const window10 = [zScore, ...priorZ.slice(0, 9)];
    if (window10.every(z => z > 0) || window10.every(z => z < 0)) {
      return { status: 'out_of_control', rule: 'reject_10x', zScore };
    }
  }

  return { status: 'accepted', rule: 'within_control', zScore };
}

function fetchSiblingZScores(db: any, material: any, runDate: string): SiblingZ[] {
  // Sibling control materials = same test + analyte, different material id.
  // If equipment_id is set on the current material, restrict to siblings with the same equipment.
  const params: unknown[] = [material.test_name, material.analyte, material.id];
  let equipmentClause = '';
  if (material.equipment_id) {
    equipmentClause = ' AND equipment_id = ?';
    params.push(material.equipment_id);
  }
  const siblingMaterials = db.prepare(
    `SELECT id, target_mean, target_sd FROM iqc_materials WHERE test_name = ? AND analyte = ? AND id != ?${equipmentClause} AND is_active = 1`
  ).all(...params) as Array<{ id: number; target_mean: number | null; target_sd: number | null }>;
  const out: SiblingZ[] = [];
  for (const sib of siblingMaterials) {
    if (sib.target_mean === null || sib.target_sd === null || !sib.target_sd) continue;
    const latest = db.prepare(
      'SELECT result_value FROM iqc_results WHERE iqc_material_id = ? AND run_date = ? ORDER BY id DESC LIMIT 1'
    ).get(sib.id, runDate) as { result_value: number } | undefined;
    if (latest) out.push({ z_score: (latest.result_value - sib.target_mean) / sib.target_sd });
  }
  return out;
}

export function iqcRoutes() {
  const router = Router();

  router.get('/materials', requirePermission('iqc', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM iqc_materials ORDER BY material_name, lot_number').all());
  });

  router.post('/materials', requirePermission('iqc', 'create'), (req, res) => {
    if (!req.body.materialName) return res.status(400).json({ error: 'materialName is required' });
    if (!req.body.testName) return res.status(400).json({ error: 'testName is required' });
    if (!req.body.analyte) return res.status(400).json({ error: 'analyte is required' });
    if (!req.body.lotNumber) return res.status(400).json({ error: 'lotNumber is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const materialCode = generateRecordNumber(db, 'iqc_materials', 'IQCM', createdAt);
    const result = db.prepare(`INSERT INTO iqc_materials (material_code, material_name, department_id, section_id, test_name, analyte, lot_number, manufacturer, expiry_date, storage_condition, target_mean, target_sd, acceptable_low, acceptable_high, equipment_id, inventory_batch_id, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        materialCode,
        req.body.materialName,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.testName,
        req.body.analyte,
        req.body.lotNumber,
        req.body.manufacturer ?? null,
        req.body.expiryDate ?? null,
        req.body.storageCondition ?? null,
        req.body.targetMean !== undefined && req.body.targetMean !== '' ? Number(req.body.targetMean) : null,
        req.body.targetSd !== undefined && req.body.targetSd !== '' ? Number(req.body.targetSd) : null,
        req.body.acceptableLow !== undefined && req.body.acceptableLow !== '' ? Number(req.body.acceptableLow) : null,
        req.body.acceptableHigh !== undefined && req.body.acceptableHigh !== '' ? Number(req.body.acceptableHigh) : null,
        parseIntNullable(req.body.equipmentId),
        parseIntNullable(req.body.inventoryBatchId),
        req.body.isActive === false ? 0 : 1,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'iqc_materials', entityId: result.lastInsertRowid, newValue: { materialCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, materialCode });
  });

  // ---- IQC materials — Excel export / template / import ----
  function iqcMaterialsWorkbook(withData: boolean): Buffer {
    const db = getDb();
    const rows: unknown[][] = [];
    if (withData) {
      const items = db.prepare('SELECT m.*, s.name AS section_name FROM iqc_materials m LEFT JOIN sections s ON s.id = m.section_id ORDER BY m.material_name, m.lot_number').all() as any[];
      for (const m of items) rows.push([m.material_name, m.test_name, m.analyte, m.lot_number, m.manufacturer ?? '', m.expiry_date ?? '', m.storage_condition ?? '', m.target_mean ?? '', m.target_sd ?? '', m.acceptable_low ?? '', m.acceptable_high ?? '', m.section_name ?? '']);
    }
    return buildWorkbook(IQC_MATERIAL_HEADERS, rows, 'IQC MATERIALS');
  }
  router.get('/materials/template', requirePermission('iqc', 'view'), (_req, res) => sendWorkbook(res, iqcMaterialsWorkbook(false), 'IQC_Materials_Template.xlsx'));
  router.get('/materials/export', requirePermission('iqc', 'view'), (_req, res) => sendWorkbook(res, iqcMaterialsWorkbook(true), 'IQC_Materials.xlsx'));
  router.post('/materials/import', requirePermission('iqc', 'create'), xlsxUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the IQC Materials .xlsx file.' });
    try {
      const rows = readSheet(req.file.buffer, 'IQC');
      const db = getDb();
      const secByName = new Map<string, number>();
      for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) secByName.set(String(s.name).toLowerCase(), s.id);
      const errors: string[] = []; let created = 0, updated = 0;
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const name = cell(r, 'Material name'); const test = cell(r, 'Test'); const analyte = cell(r, 'Analyte'); const lot = cell(r, 'Lot number');
          if (!name || !test || !analyte || !lot) { errors.push(`Row ${rowNo}: Material name, Test, Analyte and Lot number are all required.`); return; }
          const secId = cell(r, 'Section') ? (secByName.get(String(cell(r, 'Section')).toLowerCase()) ?? null) : null;
          try {
            const existing = db.prepare('SELECT id FROM iqc_materials WHERE material_name = ? AND lot_number = ?').get(name, lot) as any;
            if (existing) {
              db.prepare('UPDATE iqc_materials SET test_name = ?, analyte = ?, manufacturer = ?, expiry_date = ?, storage_condition = ?, target_mean = ?, target_sd = ?, acceptable_low = ?, acceptable_high = ?, section_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(test, analyte, cell(r, 'Manufacturer'), cell(r, 'Expiry date'), cell(r, 'Storage condition'), numCell(r, 'Target mean'), numCell(r, 'Target SD'), numCell(r, 'Acceptable low'), numCell(r, 'Acceptable high'), secId, existing.id);
              updated++;
            } else {
              const materialCode = generateRecordNumber(db, 'iqc_materials', 'IQCM', new Date().toISOString());
              db.prepare('INSERT INTO iqc_materials (material_code, material_name, section_id, test_name, analyte, lot_number, manufacturer, expiry_date, storage_condition, target_mean, target_sd, acceptable_low, acceptable_high, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
                .run(materialCode, name, secId, test, analyte, lot, cell(r, 'Manufacturer'), cell(r, 'Expiry date'), cell(r, 'Storage condition'), numCell(r, 'Target mean'), numCell(r, 'Target SD'), numCell(r, 'Acceptable low'), numCell(r, 'Acceptable high'), req.user!.id, new Date().toISOString());
              created++;
            }
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'iqc_materials', entityId: null, newValue: { created, updated, errors: errors.length } });
      res.json({ totalRows: rows.length, created, updated, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/materials/:id', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id);
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    const results = db.prepare('SELECT * FROM iqc_results WHERE iqc_material_id = ? ORDER BY run_date DESC, id DESC LIMIT 200').all(req.params.id);
    res.json({ ...material, results });
  });

  router.put('/materials/:id', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'IQC material not found' });
    db.prepare(`UPDATE iqc_materials SET material_name = ?, department_id = ?, section_id = ?, test_name = ?, analyte = ?, lot_number = ?, manufacturer = ?, expiry_date = ?, storage_condition = ?, target_mean = ?, target_sd = ?, acceptable_low = ?, acceptable_high = ?, equipment_id = ?, inventory_batch_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.materialName ?? oldValue.material_name,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.testName ?? oldValue.test_name,
        req.body.analyte ?? oldValue.analyte,
        req.body.lotNumber ?? oldValue.lot_number,
        req.body.manufacturer ?? oldValue.manufacturer,
        req.body.expiryDate ?? oldValue.expiry_date,
        req.body.storageCondition ?? oldValue.storage_condition,
        req.body.targetMean !== undefined && req.body.targetMean !== '' ? Number(req.body.targetMean) : oldValue.target_mean,
        req.body.targetSd !== undefined && req.body.targetSd !== '' ? Number(req.body.targetSd) : oldValue.target_sd,
        req.body.acceptableLow !== undefined && req.body.acceptableLow !== '' ? Number(req.body.acceptableLow) : oldValue.acceptable_low,
        req.body.acceptableHigh !== undefined && req.body.acceptableHigh !== '' ? Number(req.body.acceptableHigh) : oldValue.acceptable_high,
        parseIntNullable(req.body.equipmentId) ?? oldValue.equipment_id,
        parseIntNullable(req.body.inventoryBatchId) ?? oldValue.inventory_batch_id,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'iqc_materials', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/materials/:id/results', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM iqc_results WHERE iqc_material_id = ? ORDER BY run_date DESC, id DESC').all(req.params.id));
  });

  router.post('/materials/:id/results', requirePermission('iqc', 'create'), (req, res) => {
    if (!req.body.runDate) return res.status(400).json({ error: 'runDate is required' });
    if (req.body.resultValue === undefined || req.body.resultValue === null || req.body.resultValue === '') {
      return res.status(400).json({ error: 'resultValue is required' });
    }
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    const value = Number(req.body.resultValue);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'resultValue must be numeric' });
    const prior = db.prepare('SELECT result_value FROM iqc_results WHERE iqc_material_id = ? ORDER BY run_date DESC, id DESC LIMIT 9').all(req.params.id) as PriorResult[];
    const siblings = fetchSiblingZScores(db, material, req.body.runDate);
    const { status, rule, zScore } = evaluateIqcRules(value, material, prior, siblings);
    if (status !== 'accepted' && !req.body.comment && !req.body.immediateAction) {
      return res.status(400).json({ error: 'comment or immediateAction is required for non-accepted IQC results' });
    }
    const enteredBy = getStaffIdOrCurrent(req, req.body.enteredByStaffId);
    const result = db.prepare(`INSERT INTO iqc_results (iqc_material_id, run_date, run_time, result_value, entered_by_staff_id, equipment_id, inventory_batch_id, status, rule_violation, z_score, comment, immediate_action, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.runDate,
        req.body.runTime ?? null,
        value,
        enteredBy,
        parseIntNullable(req.body.equipmentId) ?? material.equipment_id,
        parseIntNullable(req.body.inventoryBatchId) ?? material.inventory_batch_id,
        status,
        rule,
        zScore,
        req.body.comment ?? null,
        req.body.immediateAction ?? null,
        req.user!.id
      );
    audit(req, { action: 'create', entity: 'iqc_results', entityId: result.lastInsertRowid, newValue: { iqcMaterialId: req.params.id, value, status, rule, zScore, ...req.body } });
    if (status !== 'accepted') {
      audit(req, { action: 'rule_evaluation', entity: 'iqc_results', entityId: result.lastInsertRowid, newValue: { iqcMaterialId: req.params.id, value, status, rule, zScore } });
    }
    res.status(201).json({ id: result.lastInsertRowid, status, rule, zScore });
  });

  router.get('/materials/:id/levey-jennings', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT id, material_name, lot_number, target_mean, target_sd FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const points = db.prepare('SELECT run_date, run_time, result_value, z_score, status, rule_violation FROM iqc_results WHERE iqc_material_id = ? ORDER BY run_date DESC, id DESC LIMIT ?').all(req.params.id, limit) as any[];
    res.json({
      materialId: material.id,
      materialName: material.material_name,
      lotNumber: material.lot_number,
      targetMean: material.target_mean,
      targetSd: material.target_sd,
      points: points.reverse().map(p => ({
        run_date: p.run_date,
        run_time: p.run_time,
        result_value: p.result_value,
        target_mean: material.target_mean,
        target_sd: material.target_sd,
        z_score: p.z_score,
        status: p.status,
        rule_violation: p.rule_violation
      }))
    });
  });

  router.get('/results', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('r.status = ?'); params.push(String(req.query.status)); }
    if (req.query.materialId) { filters.push('r.iqc_material_id = ?'); params.push(Number(req.query.materialId)); }
    let query = `SELECT r.*, m.material_name, m.test_name, m.analyte, m.lot_number FROM iqc_results r JOIN iqc_materials m ON m.id = r.iqc_material_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY r.run_date DESC, r.id DESC LIMIT 500';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/results/:id/review', requirePermission('iqc', 'approve'), (req, res) => {
    const db = getDb();
    const reading = db.prepare('SELECT * FROM iqc_results WHERE id = ?').get(req.params.id);
    if (!reading) return res.status(404).json({ error: 'IQC result not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    if (reviewedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare('UPDATE iqc_results SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(reviewedBy, req.params.id);
    audit(req, { action: 'approve', entity: 'iqc_results', entityId: req.params.id, oldValue: reading, newValue: { reviewedByStaffId: reviewedBy } });
    res.json({ ok: true });
  });

  router.post('/results/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('SELECT r.*, m.material_name, m.test_name, m.analyte FROM iqc_results r JOIN iqc_materials m ON m.id = r.iqc_material_id WHERE r.id = ?').get(req.params.id) as any;
    if (!result) return res.status(404).json({ error: 'IQC result not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedByStaffId = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? result.entered_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        result.run_date,
        detectedByStaffId,
        'iqc',
        String(result.id),
        req.body.title ?? `IQC failure: ${result.material_name} (${result.analyte})`,
        req.body.description ?? `IQC result ${result.result_value} flagged ${result.status}${result.rule_violation ? ` (rule: ${result.rule_violation})` : ''}`,
        req.body.category ?? 'iqc',
        req.body.severity ?? (result.status === 'rejected' ? 'high' : 'medium'),
        req.body.immediateCorrection ?? result.immediate_action ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE iqc_results SET nc_id = ? WHERE id = ?').run(ncId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('iqc', 'iqc_results', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from IQC failure');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'iqc', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/results/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const result = db.prepare('SELECT r.*, m.material_name FROM iqc_results r JOIN iqc_materials m ON m.id = r.iqc_material_id WHERE r.id = ?').get(req.params.id) as any;
    if (!result) return res.status(404).json({ error: 'IQC result not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const capaResult = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        capaNumber,
        'iqc',
        String(result.id),
        result.nc_id ?? null,
        req.body.title ?? `CAPA for IQC failure: ${result.material_name}`,
        req.body.problemSummary ?? `IQC result ${result.result_value} flagged ${result.status}`,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.user!.id,
        createdAt
      );
    const capaId = Number(capaResult.lastInsertRowid);
    db.prepare('UPDATE iqc_results SET capa_id = ? WHERE id = ?').run(capaId, req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('iqc', 'iqc_results', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from IQC failure');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'iqc', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/lot-change', requirePermission('iqc', 'create'), (req, res) => {
    if (!req.body.changeDate) return res.status(400).json({ error: 'changeDate is required' });
    const db = getDb();
    const approvedBy = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    const result = db.prepare(`INSERT INTO iqc_lot_changes (old_iqc_material_id, new_iqc_material_id, change_date, reason, verification_summary, approved_by_staff_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        parseIntNullable(req.body.oldIqcMaterialId),
        parseIntNullable(req.body.newIqcMaterialId),
        req.body.changeDate,
        req.body.reason ?? null,
        req.body.verificationSummary ?? null,
        approvedBy,
        req.user!.id
      );
    audit(req, { action: 'create', entity: 'iqc_lot_changes', entityId: result.lastInsertRowid, newValue: { ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.get('/lot-changes', requirePermission('iqc', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT lc.*, m_old.material_name AS old_material_name, m_old.lot_number AS old_lot_number, m_new.material_name AS new_material_name, m_new.lot_number AS new_lot_number FROM iqc_lot_changes lc LEFT JOIN iqc_materials m_old ON m_old.id = lc.old_iqc_material_id LEFT JOIN iqc_materials m_new ON m_new.id = lc.new_iqc_material_id ORDER BY lc.change_date DESC`).all());
  });

  return router;
}
