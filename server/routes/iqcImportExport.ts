/**
 * IQC in and out of Excel.
 *
 * Two workbooks, both deliberately FLAT — one row per analyte, one row per
 * reading — because a laboratory fills these in by hand and cross-sheet
 * references are where that goes wrong. Control-level columns simply repeat
 * down the rows of the same control, which also means one file carries one
 * control or forty without changing shape.
 *
 * Export and import use the same columns, so a register can be exported,
 * edited in Excel and imported back.
 *
 *   GET  /iqc/controls/template            blank workbook with guidance rows
 *   GET  /iqc/controls/export              the register, optionally by date
 *   POST /iqc/controls/import              create or update controls
 *   GET  /iqc/runs/template                blank run sheet, optionally per control
 *   GET  /iqc/runs/export                  recorded runs, optionally by date
 *   POST /iqc/runs/import                  record runs, evaluated as if typed
 *   GET  /iqc/analytes/:id/chart.xlsx      chart data and statistics
 *   GET  /iqc/analytes/:id/chart/print     printable chart (browser → PDF)
 */
import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';
import { evaluateRun, chartStatistics, type AnalyteDef, type History } from '../services/iqcEvaluation.js';
import {
  IQC_SOURCES, IQC_CONTROL_TYPES, IQC_FREQUENCIES, IQC_RULE_PROFILES,
  QUALITATIVE_OUTCOMES, RULE_LABELS,
  type IqcControlType, type IqcRuleProfile,
} from '../../shared/constants/iqc.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/* ------------------------------------------------------------------ columns */

const CONTROL_HEADERS = [
  'Control name', 'Test', 'Lot number', 'Level or designation', 'Source', 'Control type',
  'Manufacturer', 'Expiry date', 'Open-vial expiry', 'Storage condition', 'Section', 'Instrument',
  'Run frequency', 'Rule set',
  'Prepared by', 'Preparation date', 'Base material', 'Preparation method', 'Validation summary',
  'Analyte', 'Unit', 'Target mean', 'Target SD', 'Acceptable low', 'Acceptable high',
  'Decimal places', 'Expected result', 'Active',
] as const;

const RUN_HEADERS = [
  'Lot number', 'Run date', 'Run time', 'Shift', 'Instrument', 'Operator', 'Reagent lot',
  'Analyte', 'Result', 'Qualitative result', 'Comment',
] as const;

/** What a run or a result is called on a record somebody signs. */
const OUTCOME_LABELS: Record<string, string> = {
  accepted: 'Accepted', in_control: 'In control', warning: 'Warning',
  out_of_control: 'Rejected', rejected: 'Rejected',
};
const outcome = (s: unknown) => OUTCOME_LABELS[String(s ?? '')] ?? String(s ?? '');

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Guidance rows in a blank template, so the allowed values are on the sheet. */
const CONTROL_GUIDE: unknown[][] = [
  ['Haematology Control Normal', 'Full blood count', 'HC-2026-04', 'Level 2 (Normal)', 'commercial', 'quantitative',
    'Acme Diagnostics', '2026-12-31', '', '2–8 °C', 'Haematology', '', 'daily', 'westgard_standard',
    '', '', '', '', '', 'Haemoglobin', 'g/dL', '13.5', '0.4', '11', '16', '1', '', 'yes'],
  ['Haematology Control Normal', 'Full blood count', 'HC-2026-04', 'Level 2 (Normal)', 'commercial', 'quantitative',
    'Acme Diagnostics', '2026-12-31', '', '2–8 °C', 'Haematology', '', 'daily', 'westgard_standard',
    '', '', '', '', '', 'WBC', '×10⁹/L', '7.2', '0.35', '4', '11', '2', '', 'yes'],
  ['HBsAg Positive Control', 'Hepatitis B surface antigen', 'HB-2026-11', 'Positive control', 'commercial', 'qualitative',
    'Acme Diagnostics', '2026-10-31', '', '2–8 °C', 'Serology', '', 'per_kit', 'match_expected',
    '', '', '', '', '', 'HBsAg', '', '', '', '', '', '', 'reactive', 'yes'],
  ['Pooled Serum Control', 'Glucose', 'IH-2026-01', 'Level 1', 'in_house', 'quantitative',
    '', '2026-09-30', '', '−20 °C', 'Biochemistry', '', 'each_run', 'westgard_standard',
    'Ama Serwaa', '2026-03-01', 'Residual patient serum',
    'Pooled from 20 residual sera, filtered, aliquoted 0.5 mL', 'Assigned over 20 runs against the reference analyser',
    'Glucose', 'mmol/L', '5.5', '0.2', '4', '7', '2', '', 'yes'],
];

export function iqcImportExportRoutes() {
  const router = Router();
  const db = () => getDb();

  const yes = (v: string | null) => v === null || /^(y|yes|true|1|active)$/i.test(v);

  /* ================================================================ controls */

  router.get('/controls/template', requirePermission('iqc', 'view'), (_req, res) => {
    sendWorkbook(res, buildWorkbook(CONTROL_HEADERS, CONTROL_GUIDE, 'IQC CONTROLS'), 'IQC_Controls_Template.xlsx');
  });

  /**
   * The register. `from`/`to` narrow it to controls REGISTERED in that window —
   * the question a register export is usually answering ("what did we bring
   * into use this quarter"). `activeOnly` drops retired lots.
   */
  router.get('/controls/export', requirePermission('iqc', 'export'), (req, res) => {
    const where: string[] = []; const params: unknown[] = [];
    if (req.query.from) { where.push('date(m.created_at) >= date(?)'); params.push(String(req.query.from)); }
    if (req.query.to) { where.push('date(m.created_at) <= date(?)'); params.push(String(req.query.to)); }
    if (req.query.activeOnly === '1') where.push('m.is_active = 1');
    if (req.query.materialId) { where.push('m.id = ?'); params.push(Number(req.query.materialId)); }

    const rows = db().prepare(`SELECT m.*, sec.name AS section_name, e.name AS equipment_name, s.full_name AS prepared_by_name,
        a.analyte, a.unit AS analyte_unit, a.target_mean AS a_mean, a.target_sd AS a_sd,
        a.acceptable_low AS a_low, a.acceptable_high AS a_high, a.decimal_places, a.expected_result, a.is_active AS analyte_active
      FROM iqc_materials m
      LEFT JOIN iqc_analytes a ON a.iqc_material_id = m.id
      LEFT JOIN sections sec ON sec.id = m.section_id
      LEFT JOIN equipment_items e ON e.id = m.equipment_id
      LEFT JOIN staff s ON s.id = m.prepared_by_staff_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.material_name, m.lot_number, a.display_order, a.id`).all(...params) as Record<string, unknown>[];

    const data = rows.map(r => [
      r.material_name, r.test_name, r.lot_number, r.level_label ?? '', r.source ?? 'commercial', r.control_type ?? 'quantitative',
      r.manufacturer ?? '', r.expiry_date ?? '', r.open_vial_expiry ?? '', r.storage_condition ?? '',
      r.section_name ?? '', r.equipment_name ?? '', r.qc_frequency ?? '', r.rule_profile ?? '',
      r.prepared_by_name ?? '', r.preparation_date ?? '', r.base_material ?? '', r.preparation_method ?? '', r.validation_summary ?? '',
      r.analyte ?? '', r.analyte_unit ?? '', r.a_mean ?? '', r.a_sd ?? '', r.a_low ?? '', r.a_high ?? '',
      r.decimal_places ?? '', r.expected_result ?? '', Number(r.is_active) === 1 ? 'yes' : 'no',
    ]);
    const suffix = req.query.from || req.query.to ? `_${String(req.query.from ?? 'start')}_to_${String(req.query.to ?? 'today')}` : '';
    sendWorkbook(res, buildWorkbook(CONTROL_HEADERS, data, 'IQC CONTROLS'), `IQC_Controls${suffix}.xlsx`);
  });

  /**
   * Import controls. Rows are grouped by (control name + lot number), so one
   * file may carry a single control or a whole register. An existing lot is
   * updated rather than duplicated, and its analytes are merged by name.
   */
  router.post('/controls/import', requirePermission('iqc', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let rows: Record<string, unknown>[];
    try { rows = readSheet(req.file.buffer, 'CONTROL'); }
    catch { return res.status(400).json({ error: 'Could not read that workbook. Use the template.' }); }
    if (rows.length === 0) return res.status(400).json({ error: 'The sheet is empty.' });

    const errors: string[] = [];
    let created = 0, updated = 0, analytesWritten = 0;

    // Group by control identity. Sheet row numbers are kept so an error names
    // the row the person has to go and fix.
    const groups = new Map<string, { rows: { r: Record<string, unknown>; line: number }[] }>();
    rows.forEach((r, i) => {
      const name = cell(r, 'Control name');
      const lot = cell(r, 'Lot number');
      if (!name || !lot) {
        if (name || lot || cell(r, 'Analyte')) errors.push(`Row ${i + 2}: a control name and lot number are required.`);
        return;
      }
      const key = `${name.toLowerCase()}::${lot.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { rows: [] });
      groups.get(key)!.rows.push({ r, line: i + 2 });
    });

    const database = db();
    const sectionId = (name: string | null) => name
      ? (database.prepare('SELECT id FROM sections WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id ?? null
      : null;
    const equipmentId = (name: string | null) => name
      ? (database.prepare('SELECT id FROM equipment_items WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id ?? null
      : null;
    const staffId = (name: string | null) => name
      ? (database.prepare('SELECT id FROM staff WHERE full_name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id ?? null
      : null;

    const tx = database.transaction(() => {
      for (const [, group] of groups) {
        const head = group.rows[0].r;
        const line = group.rows[0].line;
        const name = cell(head, 'Control name')!;
        const lot = cell(head, 'Lot number')!;
        const test = cell(head, 'Test');
        if (!test) { errors.push(`Row ${line}: "${name}" has no test.`); continue; }

        const source = (cell(head, 'Source') ?? 'commercial').toLowerCase();
        if (!IQC_SOURCES.includes(source as never)) { errors.push(`Row ${line}: source must be ${IQC_SOURCES.join(' or ')}.`); continue; }
        const controlType = (cell(head, 'Control type') ?? 'quantitative').toLowerCase() as IqcControlType;
        if (!IQC_CONTROL_TYPES.includes(controlType)) { errors.push(`Row ${line}: control type must be one of ${IQC_CONTROL_TYPES.join(', ')}.`); continue; }

        let ruleProfile = (cell(head, 'Rule set') ?? '').toLowerCase() as IqcRuleProfile;
        if (!IQC_RULE_PROFILES.includes(ruleProfile)) {
          ruleProfile = controlType === 'qualitative' ? 'match_expected' : controlType === 'semi_quantitative' ? 'range_only' : 'westgard_standard';
        }
        if (controlType === 'qualitative') ruleProfile = 'match_expected';

        const frequency = (cell(head, 'Run frequency') ?? 'each_run').toLowerCase();
        const qcFrequency = IQC_FREQUENCIES.includes(frequency as never) ? frequency : 'each_run';

        const prepMethod = cell(head, 'Preparation method');
        if (source === 'in_house' && !prepMethod) {
          errors.push(`Row ${line}: "${name}" is in-house, so it must record how it was prepared.`);
          continue;
        }

        // Read the analyte rows BEFORE writing anything. A control that
        // measures nothing cannot be run, so a file whose analyte rows are all
        // unusable must leave no half-made control behind in the register.
        type ParsedAnalyte = { analyte: string; values: unknown[] };
        const parsed: ParsedAnalyte[] = [];
        let order = 0;
        for (const { r: row, line: ln } of group.rows) {
          const analyte = cell(row, 'Analyte');
          if (!analyte) continue;
          const expected = cell(row, 'Expected result');
          if (controlType === 'qualitative' && !expected) {
            errors.push(`Row ${ln}: "${analyte}" is qualitative, so it needs an expected result (${QUALITATIVE_OUTCOMES.join(', ')}).`);
            continue;
          }
          if (expected && !QUALITATIVE_OUTCOMES.includes(expected.toLowerCase() as never)) {
            errors.push(`Row ${ln}: "${expected}" is not a recognised result. Use one of ${QUALITATIVE_OUTCOMES.join(', ')}.`);
            continue;
          }
          parsed.push({
            analyte,
            values: [
              cell(row, 'Unit'), numCell(row, 'Target mean'), numCell(row, 'Target SD'),
              numCell(row, 'Acceptable low'), numCell(row, 'Acceptable high'),
              numCell(row, 'Decimal places') ?? 2, expected ? expected.toLowerCase() : null, order++, 1,
            ],
          });
        }
        if (parsed.length === 0) {
          errors.push(`Row ${line}: "${name}" has no usable analyte, so it was not created — a control has to measure something.`);
          continue;
        }

        const existing = database.prepare('SELECT id FROM iqc_materials WHERE material_name = ? COLLATE NOCASE AND lot_number = ? COLLATE NOCASE')
          .get(name, lot) as { id: number } | undefined;

        const shared = [
          test, lot, cell(head, 'Manufacturer'), cell(head, 'Expiry date'), cell(head, 'Storage condition'),
          sectionId(cell(head, 'Section')), equipmentId(cell(head, 'Instrument')),
          source, controlType, cell(head, 'Level or designation'), qcFrequency, ruleProfile,
          staffId(cell(head, 'Prepared by')), cell(head, 'Preparation date'), prepMethod,
          cell(head, 'Base material'), cell(head, 'Validation summary'), cell(head, 'Open-vial expiry'),
          yes(cell(head, 'Active')) ? 1 : 0,
        ];

        let materialId: number;
        if (existing) {
          database.prepare(`UPDATE iqc_materials SET test_name = ?, lot_number = ?, manufacturer = ?, expiry_date = ?,
              storage_condition = ?, section_id = ?, equipment_id = ?, source = ?, control_type = ?, level_label = ?,
              qc_frequency = ?, rule_profile = ?, prepared_by_staff_id = ?, preparation_date = ?, preparation_method = ?,
              base_material = ?, validation_summary = ?, open_vial_expiry = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`).run(...shared, existing.id);
          materialId = existing.id;
          updated++;
        } else {
          const code = generateRecordNumber(database, 'iqc_materials', 'IQCM', new Date().toISOString(), 'material_code');
          const r = database.prepare(`INSERT INTO iqc_materials (material_code, material_name, analyte, created_by,
              test_name, lot_number, manufacturer, expiry_date, storage_condition, section_id, equipment_id,
              source, control_type, level_label, qc_frequency, rule_profile, prepared_by_staff_id, preparation_date,
              preparation_method, base_material, validation_summary, open_vial_expiry, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(code, name, parsed[0].analyte, req.user!.id, ...shared);
          materialId = Number(r.lastInsertRowid);
          created++;
        }

        // Analytes, merged by name so re-importing an edited export is safe.
        for (const { analyte, values } of parsed) {
          const have = database.prepare('SELECT id FROM iqc_analytes WHERE iqc_material_id = ? AND analyte = ? COLLATE NOCASE')
            .get(materialId, analyte) as { id: number } | undefined;
          if (have) {
            database.prepare(`UPDATE iqc_analytes SET unit = ?, target_mean = ?, target_sd = ?, acceptable_low = ?,
              acceptable_high = ?, decimal_places = ?, expected_result = ?, display_order = ?, is_active = ? WHERE id = ?`)
              .run(...values, have.id);
          } else {
            database.prepare(`INSERT INTO iqc_analytes (iqc_material_id, analyte, unit, target_mean, target_sd,
              acceptable_low, acceptable_high, decimal_places, expected_result, display_order, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(materialId, analyte, ...values);
          }
          analytesWritten++;
        }
      }
    });
    tx();

    audit(req, { action: 'import', entity: 'iqc_materials', newValue: { created, updated, analytes: analytesWritten, errors: errors.length } });
    res.json({ totalRows: rows.length, created, updated, analytes: analytesWritten, errors });
  });

  /* ==================================================================== runs */

  /**
   * A blank run sheet. Given a control, it pre-fills one row per analyte with
   * the lot number already in place — the bench then only types results.
   */
  router.get('/runs/template', requirePermission('iqc', 'view'), (req, res) => {
    const guide: unknown[][] = [];
    const materialId = parseIntNullable(req.query.materialId);
    if (materialId) {
      const m = db().prepare('SELECT lot_number, control_type FROM iqc_materials WHERE id = ?').get(materialId) as
        { lot_number: string; control_type: string } | undefined;
      const analytes = db().prepare('SELECT analyte FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id')
        .all(materialId) as { analyte: string }[];
      const today = new Date().toISOString().slice(0, 10);
      for (const a of analytes) {
        guide.push(m?.control_type === 'qualitative'
          ? [m?.lot_number ?? '', today, '', '', '', '', '', a.analyte, '', '', '']
          : [m?.lot_number ?? '', today, '', '', '', '', '', a.analyte, '', '', '']);
      }
    }
    if (guide.length === 0) {
      guide.push(['HC-2026-04', new Date().toISOString().slice(0, 10), '08:30', 'Morning', '', '', '', 'Haemoglobin', '13.6', '', '']);
      guide.push(['HB-2026-11', new Date().toISOString().slice(0, 10), '09:00', 'Morning', '', '', '', 'HBsAg', '', 'reactive', '']);
    }
    sendWorkbook(res, buildWorkbook(RUN_HEADERS, guide, 'IQC RUNS'), 'IQC_Run_Template.xlsx');
  });

  router.get('/runs/export', requirePermission('iqc', 'export'), (req, res) => {
    const where: string[] = []; const params: unknown[] = [];
    if (req.query.from) { where.push('r.run_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { where.push('r.run_date <= ?'); params.push(String(req.query.to)); }
    if (req.query.materialId) { where.push('r.iqc_material_id = ?'); params.push(Number(req.query.materialId)); }

    const rows = db().prepare(`SELECT m.lot_number, r.run_date, r.run_time, r.shift, e.name AS equipment_name,
        s.full_name AS operator_name, r.reagent_lot, a.analyte, res.result_value, res.qualitative_result,
        res.is_qualitative, res.status, res.rule_violation, res.z_score, r.comment
      FROM iqc_results res
      JOIN iqc_runs r ON r.id = res.iqc_run_id
      JOIN iqc_materials m ON m.id = r.iqc_material_id
      LEFT JOIN iqc_analytes a ON a.id = res.iqc_analyte_id
      LEFT JOIN equipment_items e ON e.id = r.equipment_id
      LEFT JOIN staff s ON s.id = r.operator_staff_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.run_date, r.id, a.display_order`).all(...params) as Record<string, unknown>[];

    // The export carries the verdict as well, so a period's QC record leaves
    // the system complete rather than as bare numbers.
    const headers = [...RUN_HEADERS, 'Outcome', 'Rule', 'z-score'] as const;
    const data = rows.map(r => [
      r.lot_number, r.run_date, r.run_time ?? '', r.shift ?? '', r.equipment_name ?? '', r.operator_name ?? '',
      r.reagent_lot ?? '', r.analyte ?? '', Number(r.is_qualitative) === 1 ? '' : r.result_value,
      r.qualitative_result ?? '', r.comment ?? '',
      outcome(r.status), RULE_LABELS[String(r.rule_violation ?? '')] ?? r.rule_violation ?? '',
      r.z_score === null || r.z_score === undefined ? '' : Number(r.z_score).toFixed(2),
    ]);
    const suffix = req.query.from || req.query.to ? `_${String(req.query.from ?? 'start')}_to_${String(req.query.to ?? 'today')}` : '';
    sendWorkbook(res, buildWorkbook(headers, data, 'IQC RUNS'), `IQC_Runs${suffix}.xlsx`);
  });

  /**
   * Import runs. Rows are grouped into runs by lot + date + time + instrument,
   * then put through exactly the same evaluation as a run typed at the bench —
   * so an imported failure is caught, flagged and withholds patient results in
   * the same way.
   */
  router.post('/runs/import', requirePermission('iqc', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let rows: Record<string, unknown>[];
    try { rows = readSheet(req.file.buffer, 'RUN'); }
    catch { return res.status(400).json({ error: 'Could not read that workbook. Use the template.' }); }
    if (rows.length === 0) return res.status(400).json({ error: 'The sheet is empty.' });

    const database = db();
    const errors: string[] = [];
    let runsCreated = 0, readingsCreated = 0, rejected = 0;

    type Grouped = { lot: string; runDate: string; runTime: string | null; shift: string | null; equipment: string | null; operator: string | null; reagentLot: string | null; comment: string | null; readings: { analyte: string; value: string | null; qualitative: string | null; line: number }[] };
    const groups = new Map<string, Grouped>();

    rows.forEach((r, i) => {
      const line = i + 2;
      const lot = cell(r, 'Lot number');
      const runDate = cell(r, 'Run date');
      const analyte = cell(r, 'Analyte');
      if (!lot && !runDate && !analyte) return;
      if (!lot || !runDate || !analyte) { errors.push(`Row ${line}: lot number, run date and analyte are all required.`); return; }
      const normDate = /^\d{4}-\d{2}-\d{2}/.test(runDate) ? runDate.slice(0, 10) : runDate;
      const runTime = cell(r, 'Run time');
      const equipment = cell(r, 'Instrument');
      const key = `${lot.toLowerCase()}|${normDate}|${runTime ?? ''}|${equipment ?? ''}`;
      if (!groups.has(key)) {
        groups.set(key, {
          lot, runDate: normDate, runTime, shift: cell(r, 'Shift'), equipment,
          operator: cell(r, 'Operator'), reagentLot: cell(r, 'Reagent lot'), comment: cell(r, 'Comment'), readings: [],
        });
      }
      groups.get(key)!.readings.push({ analyte, value: cell(r, 'Result'), qualitative: cell(r, 'Qualitative result'), line });
    });

    const tx = database.transaction(() => {
      for (const [, g] of groups) {
        const material = database.prepare('SELECT * FROM iqc_materials WHERE lot_number = ? COLLATE NOCASE')
          .get(g.lot) as Record<string, unknown> | undefined;
        if (!material) { errors.push(`Lot "${g.lot}": no control with that lot number is registered.`); continue; }
        if (Number(material.is_active) !== 1) { errors.push(`Lot "${g.lot}": that control is no longer active.`); continue; }
        if (material.expiry_date && String(material.expiry_date) < g.runDate) {
          errors.push(`Lot "${g.lot}": the lot expired on ${material.expiry_date}, before the run date ${g.runDate}.`);
          continue;
        }

        const analytes = database.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id')
          .all(material.id) as AnalyteDef[];
        const byName = new Map(analytes.map(a => [a.analyte.toLowerCase(), a]));

        const readings: { analyteId: number; value?: number | null; qualitativeResult?: string | null }[] = [];
        const controlType = material.control_type as IqcControlType;
        for (const rd of g.readings) {
          const def = byName.get(rd.analyte.toLowerCase());
          if (!def) { errors.push(`Row ${rd.line}: "${rd.analyte}" is not an analyte of lot ${g.lot}.`); continue; }
          if (controlType === 'qualitative') {
            const q = (rd.qualitative ?? rd.value ?? '').toLowerCase();
            if (!q) { errors.push(`Row ${rd.line}: a qualitative result is required for "${rd.analyte}".`); continue; }
            if (!QUALITATIVE_OUTCOMES.includes(q as never)) { errors.push(`Row ${rd.line}: "${q}" is not a recognised result.`); continue; }
            readings.push({ analyteId: def.id, qualitativeResult: q });
          } else {
            if (rd.value === null || Number.isNaN(Number(rd.value))) { errors.push(`Row ${rd.line}: "${rd.analyte}" needs a numeric result.`); continue; }
            readings.push({ analyteId: def.id, value: Number(rd.value) });
          }
        }
        if (readings.length === 0) continue;

        // Same history rule as a typed run: only accepted runs count.
        const history: History = {};
        const priorStmt = database.prepare(`SELECT res.result_value FROM iqc_results res
          JOIN iqc_runs r ON r.id = res.iqc_run_id
          WHERE res.iqc_analyte_id = ? AND r.status != 'out_of_control' AND r.run_date <= ?
          ORDER BY r.run_date DESC, r.id DESC LIMIT 12`);
        for (const a of analytes) {
          const prior = priorStmt.all(a.id, g.runDate) as { result_value: number }[];
          history[a.id] = (a.target_mean !== null && a.target_sd !== null && a.target_sd > 0)
            ? prior.map(p => (p.result_value - a.target_mean!) / a.target_sd!)
            : [];
        }

        const verdict = evaluateRun(controlType, material.rule_profile as IqcRuleProfile, analytes, readings, history);
        const runNumber = generateRecordNumber(database, 'iqc_runs', 'QCR', new Date().toISOString(), 'run_number');
        const equipmentId = g.equipment
          ? (database.prepare('SELECT id FROM equipment_items WHERE name = ? COLLATE NOCASE').get(g.equipment) as { id: number } | undefined)?.id ?? null
          : null;
        const operatorId = g.operator
          ? (database.prepare('SELECT id FROM staff WHERE full_name = ? COLLATE NOCASE').get(g.operator) as { id: number } | undefined)?.id ?? null
          : getStaffIdOrCurrent(req, null);

        const runRow = database.prepare(`INSERT INTO iqc_runs (run_number, iqc_material_id, run_date, run_time, shift,
            equipment_id, operator_staff_id, reagent_lot, status, rule_summary, patient_results_released, comment, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(runNumber, material.id, g.runDate, g.runTime, g.shift, equipmentId, operatorId, g.reagentLot,
            verdict.status, verdict.ruleSummary, verdict.mayReleasePatientResults ? 1 : 0, g.comment, req.user!.id);
        const runId = Number(runRow.lastInsertRowid);
        runsCreated++;
        if (verdict.status === 'out_of_control') rejected++;

        const insert = database.prepare(`INSERT INTO iqc_results (iqc_material_id, iqc_run_id, iqc_analyte_id, run_date, run_time,
            result_value, qualitative_result, expected_result, is_qualitative, entered_by_staff_id, equipment_id,
            status, rule_violation, z_score, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const v of verdict.analytes) {
          insert.run(material.id, runId, v.analyteId, g.runDate, g.runTime, v.value ?? 0, v.qualitativeResult,
            v.expectedResult, v.qualitativeResult !== null && v.qualitativeResult !== undefined ? 1 : 0,
            operatorId, equipmentId, v.status, v.rule, v.zScore, req.user!.id);
          readingsCreated++;
        }
      }
    });
    tx();

    audit(req, { action: 'import', entity: 'iqc_runs', newValue: { runs: runsCreated, readings: readingsCreated, rejected, errors: errors.length } });
    res.json({ totalRows: rows.length, created: runsCreated, readings: readingsCreated, rejected, errors });
  });

  /* ============================================== Levey-Jennings out of here */

  /** Chart data as a workbook: the series, then the statistics beneath it. */
  router.get('/analytes/:id/chart.xlsx', requirePermission('iqc', 'export'), (req, res) => {
    const ctx = chartContext(req.params.id, req.query.from as string, req.query.to as string);
    if (!ctx) return res.status(404).json({ error: 'Analyte not found' });
    const { analyte, material, points, stats } = ctx;

    const headers = ['Run date', 'Time', 'Result', 'z-score', 'Outcome', 'Rule', 'Instrument', 'Operator'] as const;
    const data: unknown[][] = points.map(p => [
      p.run_date, p.run_time ?? '', Number(p.is_qualitative) === 1 ? p.qualitative_result : p.result_value,
      p.z_score === null ? '' : Number(p.z_score).toFixed(2),
      outcome(p.status), RULE_LABELS[String(p.rule_violation ?? '')] ?? p.rule_violation ?? '',
      p.equipment_name ?? '', p.operator_name ?? '',
    ]);
    // Statistics travel with the series so the file is self-contained.
    data.push([], ['STATISTICS'],
      ['Results (n)', stats.n], ['Observed mean', stats.mean], ['Observed SD', stats.sd],
      ['CV%', stats.cv], ['Target mean', analyte.target_mean], ['Target SD', analyte.target_sd],
      ['Bias', stats.bias], ['Bias %', stats.biasPercent], ['SD index', stats.sdIndex],
      [], ['Control', material.material_name], ['Lot', material.lot_number], ['Analyte', analyte.analyte],
      ['Period', `${req.query.from ?? 'start'} to ${req.query.to ?? 'today'}`]);

    const suffix = req.query.from || req.query.to ? `_${String(req.query.from ?? 'start')}_to_${String(req.query.to ?? 'today')}` : '';
    sendWorkbook(res, buildWorkbook(headers, data, 'LEVEY-JENNINGS'),
      `LJ_${String(analyte.analyte).replace(/\W+/g, '_')}_${material.lot_number}${suffix}.xlsx`);
  });

  /**
   * Printable chart. The browser's own print dialog turns it into a PDF, which
   * is how every other printed record in this system works — no extra engine
   * to install on a laboratory host that may never see the internet.
   */
  router.get('/analytes/:id/chart/print', requirePermission('iqc', 'print'), (req, res) => {
    const ctx = chartContext(req.params.id, req.query.from as string, req.query.to as string);
    if (!ctx) return res.status(404).send('Analyte not found');
    const { analyte, material, points, stats, lotChanges } = ctx;
    const lab = (db().prepare('SELECT facility_name FROM laboratory_profile WHERE id = 1').get() as { facility_name: string } | undefined)?.facility_name ?? 'Laboratory';
    const dp = Number(analyte.decimal_places ?? 2);
    const html = renderChartPrint({ lab, analyte, material, points, stats, lotChanges, dp, from: String(req.query.from ?? ''), to: String(req.query.to ?? ''), autoprint: req.query.autoprint !== '0' });
    audit(req, { action: 'print', entity: 'iqc_analytes', entityId: req.params.id, newValue: { from: req.query.from ?? null, to: req.query.to ?? null } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  /* ------------------------------------------------------------- internals */

  function chartContext(analyteId: string, from?: string, to?: string) {
    const database = db();
    const analyte = database.prepare(`SELECT a.*, m.material_name, m.lot_number, m.test_name, m.control_type,
        m.level_label, m.source, m.id AS material_id FROM iqc_analytes a
        JOIN iqc_materials m ON m.id = a.iqc_material_id WHERE a.id = ?`).get(analyteId) as Record<string, any> | undefined;
    if (!analyte) return null;
    const where = ['res.iqc_analyte_id = ?']; const params: unknown[] = [analyteId];
    if (from) { where.push('res.run_date >= ?'); params.push(from); }
    if (to) { where.push('res.run_date <= ?'); params.push(to); }
    const points = database.prepare(`SELECT res.*, r.run_number, e.name AS equipment_name, s.full_name AS operator_name
      FROM iqc_results res
      LEFT JOIN iqc_runs r ON r.id = res.iqc_run_id
      LEFT JOIN equipment_items e ON e.id = res.equipment_id
      LEFT JOIN staff s ON s.id = res.entered_by_staff_id
      WHERE ${where.join(' AND ')} ORDER BY res.run_date, res.id`).all(...params) as Record<string, any>[];
    const numeric = points.filter(p => Number(p.is_qualitative) !== 1).map(p => Number(p.result_value)).filter(v => !Number.isNaN(v));
    const stats = chartStatistics(numeric, analyte.target_mean, analyte.target_sd);
    const lotChanges = database.prepare(`SELECT change_date, reason FROM iqc_lot_changes
      WHERE old_iqc_material_id = ? OR new_iqc_material_id = ? ORDER BY change_date`).all(analyte.material_id, analyte.material_id) as Record<string, any>[];
    return { analyte, material: { material_name: analyte.material_name, lot_number: analyte.lot_number, test_name: analyte.test_name, level_label: analyte.level_label, source: analyte.source }, points, stats, lotChanges };
  }

  return router;
}

/* ------------------------------------------------------------- print render */

/**
 * The chart, drawn as SVG on the server so the printed page is identical to the
 * screen and needs no browser rendering beyond laying out the page. Geometry
 * mirrors src/components/LeveyJenningsChart.tsx, including the ±6 SD cap.
 */
function renderChartPrint(ctx: {
  lab: string; analyte: Record<string, any>; material: Record<string, any>;
  points: Record<string, any>[]; stats: Record<string, number | null>;
  lotChanges: Record<string, any>[]; dp: number; from: string; to: string; autoprint: boolean;
}): string {
  const { lab, analyte, material, points, stats, dp, from, to, autoprint } = ctx;
  const mean = analyte.target_mean as number | null;
  const sd = analyte.target_sd as number | null;
  const fmt = (v: unknown, d = dp) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));

  const W = 980, H = 360, PAD = { top: 20, right: 110, bottom: 48, left: 70 };
  const PW = W - PAD.left - PAD.right, PH = H - PAD.top - PAD.bottom;
  let svg = '';

  const numeric = points.filter(p => Number(p.is_qualitative) !== 1);
  if (mean !== null && sd !== null && sd > 0 && numeric.length > 0) {
    const zs = numeric.map(p => (Number(p.result_value) - mean) / sd);
    const extent = Math.min(6, Math.max(4, Math.ceil(Math.max(...zs.map(Math.abs)) + 0.5)));
    const top = mean + extent * sd, bottom = mean - extent * sd;
    const y = (v: number) => PAD.top + ((top - Math.min(top, Math.max(bottom, v))) / (top - bottom)) * PH;
    const x = (i: number) => PAD.left + (numeric.length === 1 ? PW / 2 : (i / (numeric.length - 1)) * PW);

    const band = (a: number, b: number, fill: string) =>
      `<rect x="${PAD.left}" y="${y(mean + b * sd)}" width="${PW}" height="${Math.max(0, y(mean + a * sd) - y(mean + b * sd))}" fill="${fill}"/>`;
    svg += band(-extent, extent, '#fdeaec') + band(-2, 2, '#fef6e6') + band(-1, 1, '#eafaf2');

    for (const k of [3, 2, 1, 0, -1, -2, -3]) {
      const v = mean + k * sd, yy = y(v);
      const stroke = k === 0 ? '#1849c0' : Math.abs(k) === 3 ? '#d64258' : '#b9c2d0';
      const dash = k === 0 ? '' : ' stroke-dasharray="4 4"';
      svg += `<line x1="${PAD.left}" x2="${PAD.left + PW}" y1="${yy}" y2="${yy}" stroke="${stroke}" stroke-width="${k === 0 ? 1.6 : 1}"${dash}/>`;
      svg += `<text x="${PAD.left + PW + 7}" y="${yy + 3.5}" font-size="10" fill="${k === 0 ? '#1849c0' : '#6b7686'}">${k === 0 ? 'Mean' : `${k > 0 ? '+' : '−'}${Math.abs(k)}SD`}</text>`;
      svg += `<text x="${PAD.left - 8}" y="${yy + 3.5}" font-size="9.5" fill="#6b7686" text-anchor="end">${fmt(v)}</text>`;
    }

    svg += `<polyline fill="none" stroke="#98a2b3" stroke-width="1.3" points="${numeric.map((p, i) => `${x(i)},${y(Number(p.result_value))}`).join(' ')}"/>`;
    numeric.forEach((p, i) => {
      const rejected = p.status === 'out_of_control';
      const warned = p.status === 'warning';
      const colour = rejected ? '#d64258' : warned ? '#d99413' : '#199e6b';
      const off = Math.abs((Number(p.result_value) - mean) / sd) > extent;
      const px = x(i), py = y(Number(p.result_value));
      svg += off
        ? `<polygon points="${px},${py - 6} ${px - 5},${py + 4} ${px + 5},${py + 4}" fill="${colour}"/>`
        : `<circle cx="${px}" cy="${py}" r="${rejected ? 4.5 : 3.4}" fill="${colour}"/>`;
      if (rejected) svg += `<text x="${px}" y="${py - 9}" font-size="8.5" fill="#d64258" text-anchor="middle">${esc(RULE_LABELS[String(p.rule_violation ?? '')] ?? '!')}</text>`;
    });

    const every = Math.max(1, Math.ceil(numeric.length / 8));
    numeric.forEach((p, i) => {
      if (i % every === 0 || i === numeric.length - 1) {
        svg += `<text x="${x(i)}" y="${PAD.top + PH + 18}" font-size="9" fill="#6b7686" text-anchor="middle">${esc(String(p.run_date).slice(5))}</text>`;
      }
    });
  }

  const rows = points.map(p => `<tr>
    <td>${esc(p.run_date)}</td><td>${esc(p.run_time ?? '')}</td>
    <td>${Number(p.is_qualitative) === 1 ? esc(p.qualitative_result) : fmt(p.result_value)}</td>
    <td>${p.z_score === null || p.z_score === undefined ? '' : Number(p.z_score).toFixed(2)}</td>
    <td class="${p.status === 'out_of_control' ? 'bad' : p.status === 'warning' ? 'warn' : ''}">${esc(outcome(p.status))}</td>
    <td>${esc(RULE_LABELS[String(p.rule_violation ?? '')] ?? p.rule_violation ?? '')}</td>
    <td>${esc(p.equipment_name ?? '')}</td><td>${esc(p.operator_name ?? '')}</td>
  </tr>`).join('');

  const period = from || to ? `${from || 'start'} to ${to || 'today'}` : 'all recorded results';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Levey-Jennings — ${esc(analyte.analyte)} — ${esc(material.lot_number)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #16202f; font-size: 11px; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { color: #5a6577; font-size: 11px; margin-bottom: 12px; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #16202f; padding-bottom: 8px; margin-bottom: 12px; }
  .stats { display: flex; flex-wrap: wrap; gap: 0; border: 1px solid #d5dbe4; margin: 12px 0; }
  .stats div { flex: 1 1 108px; padding: 6px 9px; border-right: 1px solid #d5dbe4; }
  .stats div:last-child { border-right: 0; }
  .stats dt { font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #6b7686; }
  .stats dd { margin: 2px 0 0; font-size: 13px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #d5dbe4; padding: 3px 6px; text-align: left; font-size: 9.5px; }
  th { background: #eef2f7; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
  td.bad { color: #d64258; font-weight: 700; }
  td.warn { color: #b4770c; font-weight: 700; }
  .sign { display: flex; gap: 40px; margin-top: 18px; font-size: 10px; }
  .sign div { flex: 1; border-top: 1px solid #16202f; padding-top: 5px; }
  .foot { margin-top: 14px; font-size: 8.5px; color: #6b7686; border-top: 1px solid #d5dbe4; padding-top: 6px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="hdr">
  <div>
    <h1>Levey-Jennings chart — ${esc(analyte.analyte)}${analyte.unit ? ` (${esc(analyte.unit)})` : ''}</h1>
    <div class="sub">
      ${esc(material.material_name)} · lot ${esc(material.lot_number)}${material.level_label ? ` · ${esc(material.level_label)}` : ''}
      · ${esc(material.test_name)}${material.source === 'in_house' ? ' · in-house prepared' : ''}
    </div>
  </div>
  <div style="text-align:right">
    <strong>${esc(lab)}</strong><br/>
    <span class="sub">Period: ${esc(period)}<br/>Printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span>
  </div>
</div>

<svg viewBox="0 0 ${W} ${H}" width="100%" height="300" xmlns="http://www.w3.org/2000/svg">${svg}</svg>

<div class="stats">
  <div><dt>Results (n)</dt><dd>${stats.n ?? 0}</dd></div>
  <div><dt>Observed mean</dt><dd>${fmt(stats.mean)}</dd></div>
  <div><dt>Observed SD</dt><dd>${fmt(stats.sd, dp + 1)}</dd></div>
  <div><dt>CV%</dt><dd>${fmt(stats.cv, 1)}</dd></div>
  <div><dt>Target mean</dt><dd>${fmt(mean)}</dd></div>
  <div><dt>Target SD</dt><dd>${fmt(sd, dp + 1)}</dd></div>
  <div><dt>Bias</dt><dd>${fmt(stats.bias)}${stats.biasPercent !== null ? ` (${fmt(stats.biasPercent, 1)}%)` : ''}</dd></div>
  <div><dt>SD index</dt><dd>${fmt(stats.sdIndex, 2)}</dd></div>
</div>

<table><thead><tr>
  <th>Date</th><th>Time</th><th>Result</th><th>z</th><th>Outcome</th><th>Rule</th><th>Instrument</th><th>Operator</th>
</tr></thead><tbody>${rows || '<tr><td colspan="8">No results in this period.</td></tr>'}</tbody></table>

<div class="sign">
  <div>Reviewed by (name &amp; signature)<br/><br/>Date: ______________</div>
  <div>Authorised by (name &amp; signature)<br/><br/>Date: ______________</div>
</div>

<div class="foot">SECH_LIMS by Nickland · Internal quality control record · Retain according to the laboratory's retention schedule.</div>
${autoprint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),400))</script>' : ''}
</body></html>`;
}
