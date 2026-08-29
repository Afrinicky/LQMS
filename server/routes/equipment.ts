import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { generateEquipmentNumber, previewEquipmentNumber, getEquipmentPattern, saveEquipmentPattern } from '../utils/equipmentNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import {
  classForCategory, categoryFromLegacy, isArchetype, dutiesFor, DUTY_LABELS, DUTY_CLAUSES, DUTY_HINTS,
  type EquipmentArchetype, type EquipmentDuty,
} from '../../shared/constants/equipment.js';
import { getCurrentStaffId } from './routeHelpers.js';
import { generateOccurrences } from '../services/activityService.js';
import { openSheet, refreshSheetRows, sheetsForSection } from '../services/routineSheets.js';
import {
  MAINTENANCE_FRAMEWORKS, MAINTENANCE_FREQUENCIES, MAINTENANCE_KINDS,
  MAINTENANCE_TO_ACTIVITY_FREQUENCY, frameworkForEquipment,
} from '../../shared/constants/routineWork.js';

// A category is a configurable label; the archetype pinned to it is what the
// system acts on. Resolve the archetype from the configured list, falling back
// to the value itself when it is already an archetype, and to a name-based
// guess when nothing was sent (an import, an older client).
function resolveCategory(db: any, value: unknown, name?: string | null, catText?: string | null): { category: string; archetype: EquipmentArchetype } {
  let category = String(value ?? '').trim();
  if (!category) category = categoryFromLegacy(null, name, catText);
  const row = db.prepare("SELECT extra FROM config_options WHERE list_key = 'equipment_category' AND value = ?").get(category) as { extra: string | null } | undefined;
  let archetype: string | null = null;
  if (row?.extra) { try { archetype = JSON.parse(row.extra).archetype; } catch { /* ignore */ } }
  if (!isArchetype(archetype)) archetype = isArchetype(category) ? category : 'other';
  return { category, archetype: archetype as EquipmentArchetype };
}

const EQUIPMENT_REGISTER_HEADERS = [
  'Identifier', 'Name', 'Equipment category', 'Manufacturer', 'Model', 'Serial No.', 'Country of origin', 'Condition received',
  'Criticality', 'Supplier name', 'Supplier location', 'Supplier contact', 'Department', 'Section', 'Custodian (employee no.)',
  'Status', 'Date received', 'Date in service', 'Date out of service', 'Maintenance frequency', 'Next maintenance due',
  'Calibration required', 'Calibration frequency', 'Next calibration due', 'Notes',
] as const;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const BREAKDOWN_STATUSES = ['open', 'under_repair', 'action_required', 'returned_to_service', 'closed'];
const EQUIPMENT_STATUSES = ['active', 'operational', 'out_of_service', 'under_repair', 'restricted_use', 'retired'];

/** Only a numeric `:id` names one equipment item; anything else is a collection route. */
const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

export function equipmentRoutes() {
  const router = Router();

  router.get('/', requirePermission('equipment.register', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_items ORDER BY created_at DESC').all());
  });

  // --- Configurable unique-identifier pattern (registered before '/:id') ---
  router.get('/config/id-pattern', requirePermission('equipment.register', 'view'), (_req, res) => {
    const db = getDb();
    res.json({ pattern: getEquipmentPattern(db), preview: previewEquipmentNumber(db) });
  });

  router.put('/config/id-pattern', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    try {
      const saved = saveEquipmentPattern(db, req.body?.pattern ?? req.body);
      audit(req, { action: 'edit', entity: 'settings', entityId: 'equipment_id_pattern', newValue: saved });
      res.json({ pattern: saved, preview: previewEquipmentNumber(db) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Preview the identifier the next new item would receive.
  router.get('/config/next-number', requirePermission('equipment.register', 'view'), (_req, res) => {
    res.json({ number: previewEquipmentNumber(getDb()) });
  });

  // ===================== Excel export / import =====================
  function sendWorkbook(res: any, buf: Buffer, filename: string) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buf);
  }
  function buildEquipmentWorkbook(withData: boolean): Buffer {
    const db = getDb();
    const rows: any[][] = [];
    if (withData) {
      const items = db.prepare(`SELECT e.*, d.name AS dept_name, sec.name AS sec_name, st.employee_no AS staff_no FROM equipment_items e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN sections sec ON sec.id = e.section_id LEFT JOIN staff st ON st.id = COALESCE(e.responsible_staff_id, e.assigned_to_staff_id) ORDER BY e.equipment_number`).all() as any[];
      for (const i of items) {
        rows.push([
          i.equipment_number, i.name, i.equipment_category ?? '', i.manufacturer ?? '', i.model ?? '', i.serial_number ?? '', i.country_of_origin ?? '', i.condition_received ?? '',
          i.criticality ?? '', i.supplier_name ?? '', i.supplier_location ?? '', i.supplier_contact ?? '', i.dept_name ?? '', i.sec_name ?? '', i.staff_no ?? '',
          i.status ?? '', i.date_received ?? '', i.date_commissioned ?? '', i.date_out_of_service ?? '', i.maintenance_frequency ?? '', i.next_maintenance_due ?? '',
          i.calibration_required ? 'Yes' : 'No', i.calibration_frequency ?? '', i.next_calibration_due ?? '', i.notes ?? '',
        ]);
      }
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([EQUIPMENT_REGISTER_HEADERS as unknown as string[], ...rows]);
    ws['!cols'] = EQUIPMENT_REGISTER_HEADERS.map(h => ({ wch: Math.min(28, Math.max(12, h.length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'EQUIPMENT REGISTER');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  router.get('/register/template', requirePermission('equipment.register', 'export'), (_req, res) => {
    sendWorkbook(res, buildEquipmentWorkbook(false), 'Equipment_Register_Template.xlsx');
  });
  router.get('/register/export', requirePermission('equipment.register', 'export'), (_req, res) => {
    sendWorkbook(res, buildEquipmentWorkbook(true), 'Equipment_Register.xlsx');
  });

  // Rows are matched by Identifier: existing items are updated, new ones created.
  router.post('/register/import', requirePermission('equipment.register', 'import'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Equipment Register .xlsx file.' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.SheetNames.find(n => n.toUpperCase().includes('EQUIPMENT')) || wb.SheetNames[0];
      const ws = wb.Sheets[sheet];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false });
      const db = getDb();
      const deptByName = new Map<string, number>();
      for (const d of db.prepare('SELECT id, name FROM departments').all() as any[]) deptByName.set(String(d.name).toLowerCase(), d.id);
      const secByName = new Map<string, number>();
      for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) secByName.set(String(s.name).toLowerCase(), s.id);
      const staffByNo = new Map<string, number>();
      for (const s of db.prepare('SELECT id, employee_no FROM staff WHERE employee_no IS NOT NULL').all() as any[]) staffByNo.set(String(s.employee_no).toLowerCase(), s.id);
      const norm = (v: unknown) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
      const yn = (v: unknown) => { const s = String(v ?? '').trim().toLowerCase(); return s === 'yes' || s === 'y' || s === 'true' || s === '1' ? 1 : 0; };

      const errors: string[] = [];
      let created = 0, updated = 0;
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2; // human-friendly (header on row 1)
          const identifier = norm(r['Identifier']);
          const name = norm(r['Name']);
          if (!name) { errors.push(`Row ${rowNo}: Name is required.`); return; }
          const deptId = norm(r['Department']) ? (deptByName.get(String(r['Department']).toLowerCase()) ?? null) : null;
          const secId = norm(r['Section']) ? (secByName.get(String(r['Section']).toLowerCase()) ?? null) : null;
          const staffId = norm(r['Custodian (employee no.)']) ? (staffByNo.get(String(r['Custodian (employee no.)']).toLowerCase()) ?? null) : null;
          const status = (norm(r['Status']) ?? 'operational').toLowerCase();
          const finalStatus = EQUIPMENT_STATUSES.includes(status) ? status : 'operational';
          const values = {
            name, equipmentCategory: norm(r['Equipment category']), manufacturer: norm(r['Manufacturer']), model: norm(r['Model']),
            serialNumber: norm(r['Serial No.']), countryOfOrigin: norm(r['Country of origin']), conditionReceived: norm(r['Condition received']),
            criticality: norm(r['Criticality']), supplierName: norm(r['Supplier name']), supplierLocation: norm(r['Supplier location']), supplierContact: norm(r['Supplier contact']),
            departmentId: deptId, sectionId: secId, responsibleStaffId: staffId, status: finalStatus,
            dateReceived: norm(r['Date received']), dateCommissioned: norm(r['Date in service']), dateOutOfService: norm(r['Date out of service']),
            maintenanceFrequency: norm(r['Maintenance frequency']), nextMaintenanceDue: norm(r['Next maintenance due']),
            calibrationRequired: yn(r['Calibration required']), calibrationFrequency: norm(r['Calibration frequency']), nextCalibrationDue: norm(r['Next calibration due']),
            notes: norm(r['Notes']),
          };
          const impCat = resolveCategory(db, values.equipmentCategory, values.name, null);
          try {
            const existing = identifier ? db.prepare('SELECT id FROM equipment_items WHERE equipment_number = ?').get(identifier) as any : null;
            if (existing) {
              db.prepare(`UPDATE equipment_items SET name = ?, equipment_category = ?, equipment_archetype = ?, equipment_class = ?, manufacturer = ?, model = ?, serial_number = ?, country_of_origin = ?, condition_received = ?, criticality = ?, supplier_name = ?, supplier_location = ?, supplier_contact = ?, department_id = ?, section_id = ?, responsible_staff_id = ?, status = ?, date_received = ?, date_commissioned = ?, date_out_of_service = ?, maintenance_frequency = ?, next_maintenance_due = ?, calibration_required = ?, calibration_frequency = ?, next_calibration_due = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(values.name, impCat.category, impCat.archetype, classForCategory(impCat.archetype), values.manufacturer, values.model, values.serialNumber, values.countryOfOrigin, values.conditionReceived, values.criticality, values.supplierName, values.supplierLocation, values.supplierContact, values.departmentId, values.sectionId, values.responsibleStaffId, values.status, values.dateReceived, values.dateCommissioned, values.dateOutOfService, values.maintenanceFrequency, values.nextMaintenanceDue, values.calibrationRequired, values.calibrationFrequency, values.nextCalibrationDue, values.notes, existing.id);
              updated++;
            } else {
              const createdAt = new Date().toISOString();
              const equipmentNumber = identifier || generateEquipmentNumber(db, createdAt);
              if (db.prepare('SELECT 1 FROM equipment_items WHERE equipment_number = ?').get(equipmentNumber)) { errors.push(`Row ${rowNo}: identifier ${equipmentNumber} already in use.`); return; }
              db.prepare(`INSERT INTO equipment_items (equipment_number, name, equipment_category, equipment_archetype, equipment_class, manufacturer, model, serial_number, country_of_origin, condition_received, criticality, supplier_name, supplier_location, supplier_contact, department_id, section_id, responsible_staff_id, status, date_received, date_commissioned, date_out_of_service, maintenance_frequency, next_maintenance_due, calibration_required, calibration_frequency, next_calibration_due, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(equipmentNumber, values.name, impCat.category, impCat.archetype, classForCategory(impCat.archetype), values.manufacturer, values.model, values.serialNumber, values.countryOfOrigin, values.conditionReceived, values.criticality, values.supplierName, values.supplierLocation, values.supplierContact, values.departmentId, values.sectionId, values.responsibleStaffId, values.status, values.dateReceived, values.dateCommissioned, values.dateOutOfService, values.maintenanceFrequency, values.nextMaintenanceDue, values.calibrationRequired, values.calibrationFrequency, values.nextCalibrationDue, values.notes, req.user!.id, createdAt);
              created++;
            }
          } catch (e) {
            errors.push(`Row ${rowNo}: ${(e as Error).message}`);
          }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'equipment_items', entityId: null, newValue: { created, updated, errors: errors.length } });
      res.json({ totalRows: rows.length, created, updated, errors });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ===================== Maintenance records — Excel export / import =====================
  const MAINTENANCE_HEADERS = [
    'Equipment identifier', 'Equipment name', 'Maintenance date', 'Maintenance type', 'Performed by (employee no.)',
    'Findings', 'Action taken', 'Next due date', 'Status', 'Service provider', 'Provider type',
  ] as const;
  function buildMaintenanceWorkbook(withData: boolean): Buffer {
    const db = getDb();
    const rows: any[][] = [];
    if (withData) {
      const recs = db.prepare(`SELECT m.*, e.equipment_number, e.name AS equipment_name, st.employee_no AS performed_no
        FROM equipment_maintenance_records m JOIN equipment_items e ON e.id = m.equipment_id
        LEFT JOIN staff st ON st.id = m.performed_by_staff_id ORDER BY m.maintenance_date DESC, m.id DESC`).all() as any[];
      for (const m of recs) rows.push([
        m.equipment_number, m.equipment_name, m.maintenance_date, m.maintenance_type, m.performed_no ?? '',
        m.findings ?? '', m.action_taken ?? '', m.next_due_date ?? '', m.status ?? '', m.service_provider ?? '', m.provider_type ?? '',
      ]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([MAINTENANCE_HEADERS as unknown as string[], ...rows]);
    ws['!cols'] = MAINTENANCE_HEADERS.map(h => ({ wch: Math.min(30, Math.max(14, h.length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'MAINTENANCE RECORDS');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  router.get('/maintenance/template', requirePermission('equipment.maintenance', 'export'), (_req, res) => sendWorkbook(res, buildMaintenanceWorkbook(false), 'Equipment_Maintenance_Template.xlsx'));
  router.get('/maintenance/export', requirePermission('equipment.maintenance', 'export'), (_req, res) => sendWorkbook(res, buildMaintenanceWorkbook(true), 'Equipment_Maintenance_Records.xlsx'));
  router.post('/maintenance/import', requirePermission('equipment.maintenance', 'import'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Equipment Maintenance .xlsx file.' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.SheetNames.find(n => n.toUpperCase().includes('MAINTEN')) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet], { defval: '', raw: false });
      const db = getDb();
      const eqByNo = new Map<string, number>();
      for (const e of db.prepare('SELECT id, equipment_number FROM equipment_items').all() as any[]) eqByNo.set(String(e.equipment_number).toLowerCase(), e.id);
      const staffByNo = new Map<string, number>();
      for (const s of db.prepare('SELECT id, employee_no FROM staff WHERE employee_no IS NOT NULL').all() as any[]) staffByNo.set(String(s.employee_no).toLowerCase(), s.id);
      const norm = (v: unknown) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
      const errors: string[] = [];
      let created = 0;
      const ins = db.prepare(`INSERT INTO equipment_maintenance_records (equipment_id, maintenance_date, maintenance_type, performed_by_staff_id, findings, action_taken, next_due_date, status, service_provider, provider_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const eqNo = norm(r['Equipment identifier']);
          const eqId = eqNo ? eqByNo.get(String(eqNo).toLowerCase()) : undefined;
          if (!eqId) { errors.push(`Row ${rowNo}: equipment identifier "${eqNo ?? ''}" not found.`); return; }
          const date = norm(r['Maintenance date']);
          const type = norm(r['Maintenance type']);
          if (!date) { errors.push(`Row ${rowNo}: Maintenance date is required.`); return; }
          if (!type) { errors.push(`Row ${rowNo}: Maintenance type is required.`); return; }
          const performedBy = norm(r['Performed by (employee no.)']) ? (staffByNo.get(String(r['Performed by (employee no.)']).toLowerCase()) ?? null) : null;
          const nextDue = norm(r['Next due date']);
          try {
            ins.run(eqId, date, type, performedBy, norm(r['Findings']), norm(r['Action taken']), nextDue, norm(r['Status']) ?? 'completed', norm(r['Service provider']), norm(r['Provider type']), req.user!.id);
            if (nextDue) db.prepare('UPDATE equipment_items SET last_service_date = ?, next_service_due = ?, next_maintenance_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(date, nextDue, nextDue, eqId);
            else db.prepare('UPDATE equipment_items SET last_service_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(date, eqId);
            created++;
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'equipment_maintenance_records', entityId: null, newValue: { created, errors: errors.length } });
      res.json({ totalRows: rows.length, created, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // ===================== Editable checklist question bank =====================
  const CHECKLIST_TYPES = ['verification_validation', 'calibration'];

  router.get('/checklists/:type', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    if (!CHECKLIST_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Unknown checklist type' });
    const db = getDb();
    const includeInactive = req.query.all === '1';
    const rows = db.prepare(`SELECT * FROM equipment_checklist_items WHERE checklist_type = ?${includeInactive ? '' : ' AND is_active = 1'} ORDER BY sort_order, id`).all(req.params.type);
    res.json(rows);
  });

  router.post('/checklists/:type', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    if (!CHECKLIST_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Unknown checklist type' });
    if (!req.body.prompt) return res.status(400).json({ error: 'prompt is required' });
    const db = getDb();
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM equipment_checklist_items WHERE checklist_type = ?').get(req.params.type) as { m: number }).m;
    const result = db.prepare('INSERT INTO equipment_checklist_items (checklist_type, prompt, guidance, sort_order, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.type, req.body.prompt, req.body.guidance ?? null, maxOrder + 1, req.user!.id);
    audit(req, { action: 'create', entity: 'equipment_checklist_items', entityId: result.lastInsertRowid, newValue: { type: req.params.type, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.put('/checklists/items/:id', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM equipment_checklist_items WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Checklist item not found' });
    db.prepare('UPDATE equipment_checklist_items SET prompt = ?, guidance = ?, sort_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.prompt ?? old.prompt,
        req.body.guidance ?? old.guidance,
        req.body.sortOrder ?? old.sort_order,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : old.is_active,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'equipment_checklist_items', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Store the responses submitted for a verification or calibration record.
  function saveResponses(db: any, recordType: string, recordId: number, responses: any[]) {
    if (!Array.isArray(responses)) return;
    const ins = db.prepare('INSERT INTO equipment_checklist_responses (record_type, record_id, item_id, prompt, response, notes, evidence_file_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of responses) {
      if (!r || !r.prompt) continue;
      ins.run(recordType, recordId, parseIntNullable(r.itemId), r.prompt, r.response ?? null, r.notes ?? null, parseIntNullable(r.evidenceFileId));
    }
  }

  // ===================== Verification & validation =====================
  router.get('/:id/verifications', requirePermission('equipment.verification', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_verification_records WHERE equipment_id = ? ORDER BY performed_date DESC, id DESC').all(req.params.id));
  });

  router.post('/:id/verifications', requirePermission('equipment.verification', 'create'), (req, res) => {
    if (!req.body.performedDate) return res.status(400).json({ error: 'performedDate is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'equipment_verification_records', 'VER', createdAt);
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const tx = db.transaction(() => {
      const result = db.prepare('INSERT INTO equipment_verification_records (verification_number, equipment_id, verification_type, performed_by_staff_id, performed_date, conclusion, outcome, status, evidence_file_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(number, req.params.id, req.body.verificationType ?? 'verification', performedBy, req.body.performedDate, req.body.conclusion ?? null, req.body.outcome ?? null, 'completed', parseIntNullable(req.body.evidenceFileId), req.body.notes ?? null, req.user!.id, createdAt);
      saveResponses(db, 'verification', Number(result.lastInsertRowid), req.body.responses);
      return result.lastInsertRowid;
    });
    const id = tx();
    audit(req, { action: 'create', entity: 'equipment_verification_records', entityId: id, newValue: { number, equipmentId: req.params.id } });
    res.status(201).json({ id, verificationNumber: number });
  });

  router.get('/verifications/:vid', requirePermission('equipment.verification', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM equipment_verification_records WHERE id = ?').get(req.params.vid);
    if (!record) return res.status(404).json({ error: 'Verification not found' });
    const responses = db.prepare('SELECT * FROM equipment_checklist_responses WHERE record_type = ? AND record_id = ? ORDER BY id').all('verification', req.params.vid);
    res.json({ ...record, responses });
  });

  router.post('/verifications/:vid/review', requirePermission('equipment.verification', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM equipment_verification_records WHERE id = ?').get(req.params.vid) as any;
    if (!record) return res.status(404).json({ error: 'Verification not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    db.prepare('UPDATE equipment_verification_records SET reviewed_by_staff_id = ?, reviewed_at = ?, review_outcome = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reviewedBy, new Date().toISOString(), req.body.reviewOutcome ?? 'approved', 'reviewed', req.params.vid);
    audit(req, { action: 'edit', entity: 'equipment_verification_records', entityId: req.params.vid, oldValue: record, newValue: { reviewOutcome: req.body.reviewOutcome ?? 'approved' } });
    res.json({ ok: true });
  });

  // ===================== Reference standards register =====================
  router.get('/reference-standards', requirePermission('equipment.maintenance', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM reference_standards ORDER BY created_at DESC').all());
  });

  router.post('/reference-standards', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'reference_standards', 'REF', createdAt);
    const result = db.prepare('INSERT INTO reference_standards (reference_number, name, standard_type, identifier, certificate_number, traceable_to, valid_from, valid_until, custodian_staff_id, status, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(number, req.body.name, req.body.standardType ?? null, req.body.identifier ?? null, req.body.certificateNumber ?? null, req.body.traceableTo ?? null, req.body.validFrom ?? null, req.body.validUntil ?? null, parseIntNullable(req.body.custodianStaffId), req.body.status ?? 'active', req.body.notes ?? null, req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'reference_standards', entityId: result.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, referenceNumber: number });
  });

  // ===================== Calibration =====================
  router.get('/:id/calibrations', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_calibration_records WHERE equipment_id = ? ORDER BY calibration_date DESC, id DESC').all(req.params.id));
  });

  router.post('/:id/calibrations', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    if (!req.body.calibrationDate) return res.status(400).json({ error: 'calibrationDate is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'equipment_calibration_records', 'CAL', createdAt);
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const tx = db.transaction(() => {
      const result = db.prepare('INSERT INTO equipment_calibration_records (calibration_number, equipment_id, calibration_date, calibration_mode, provider, certificate_number, traceability_reference, reference_standard_id, result, next_due_date, verified_before_use, performed_by_staff_id, status, evidence_file_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(number, req.params.id, req.body.calibrationDate, req.body.calibrationMode ?? null, req.body.provider ?? null, req.body.certificateNumber ?? null, req.body.traceabilityReference ?? null, parseIntNullable(req.body.referenceStandardId), req.body.result ?? null, req.body.nextDueDate ?? null, req.body.verifiedBeforeUse ? 1 : 0, performedBy, 'completed', parseIntNullable(req.body.evidenceFileId), req.body.notes ?? null, req.user!.id, createdAt);
      saveResponses(db, 'calibration', Number(result.lastInsertRowid), req.body.responses);
      return result.lastInsertRowid;
    });
    const id = tx();
    // Keep the equipment's next calibration date in step with the latest calibration.
    if (req.body.nextDueDate) {
      db.prepare('UPDATE equipment_items SET next_calibration_due = ?, calibration_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.nextDueDate, req.body.nextDueDate, req.params.id);
    }
    audit(req, { action: 'create', entity: 'equipment_calibration_records', entityId: id, newValue: { number, equipmentId: req.params.id } });
    res.status(201).json({ id, calibrationNumber: number });
  });

  router.get('/calibrations/:cid', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM equipment_calibration_records WHERE id = ?').get(req.params.cid);
    if (!record) return res.status(404).json({ error: 'Calibration not found' });
    const responses = db.prepare('SELECT * FROM equipment_checklist_responses WHERE record_type = ? AND record_id = ? ORDER BY id').all('calibration', req.params.cid);
    res.json({ ...record, responses });
  });

  router.post('/calibrations/:cid/review', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT * FROM equipment_calibration_records WHERE id = ?').get(req.params.cid) as any;
    if (!record) return res.status(404).json({ error: 'Calibration not found' });
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    db.prepare('UPDATE equipment_calibration_records SET reviewed_by_staff_id = ?, reviewed_at = ?, review_outcome = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reviewedBy, new Date().toISOString(), req.body.reviewOutcome ?? 'accepted', 'reviewed', req.params.cid);
    audit(req, { action: 'edit', entity: 'equipment_calibration_records', entityId: req.params.cid, oldValue: record, newValue: { reviewOutcome: req.body.reviewOutcome ?? 'accepted' } });
    res.json({ ok: true });
  });

  // ===================== Maintenance & servicing schedules =====================
  const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom'];

  function advanceDate(dateStr: string, freq: string, intervalDays?: number | null): string | null {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    switch (freq) {
      case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
      case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
      case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
      case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
      case 'biannual': d.setUTCMonth(d.getUTCMonth() + 6); break;
      case 'annual': d.setUTCMonth(d.getUTCMonth() + 12); break;
      case 'custom': d.setUTCDate(d.getUTCDate() + (intervalDays && intervalDays > 0 ? intervalDays : 30)); break;
      default: return null;
    }
    return d.toISOString().slice(0, 10);
  }

  // All schedules that are due within 30 days or overdue, newest-due first.
  router.get('/schedules/due', requirePermission('equipment.maintenance', 'view'), (_req, res) => {
    const db = getDb();
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    res.json(db.prepare(`SELECT s.*, e.name AS equipment_name, e.equipment_number FROM equipment_schedules s JOIN equipment_items e ON e.id = s.equipment_id WHERE s.is_active = 1 AND s.next_due_date IS NOT NULL AND s.next_due_date <= ? ORDER BY s.next_due_date`).all(soon));
  });

  router.get('/:id/schedules', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_schedules WHERE equipment_id = ? ORDER BY is_active DESC, next_due_date').all(req.params.id));
  });

  router.post('/:id/schedules', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    if (!req.body.frequency || !SCHEDULE_FREQUENCIES.includes(req.body.frequency)) return res.status(400).json({ error: `frequency must be one of: ${SCHEDULE_FREQUENCIES.join(', ')}` });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    // Seed the first due date: use the supplied one, otherwise compute from today.
    const nextDue = req.body.nextDueDate || advanceDate(new Date().toISOString().slice(0, 10), req.body.frequency, parseIntNullable(req.body.intervalDays));
    const result = db.prepare('INSERT INTO equipment_schedules (equipment_id, schedule_type, frequency, interval_days, provider_type, provider_name, responsible_staff_id, section_id, task_description, last_done_date, next_due_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.params.id, req.body.scheduleType ?? 'preventive_maintenance', req.body.frequency, parseIntNullable(req.body.intervalDays), req.body.providerType ?? null, req.body.providerName ?? null, parseIntNullable(req.body.responsibleStaffId), parseIntNullable(req.body.sectionId), req.body.taskDescription ?? null, req.body.lastDoneDate ?? null, nextDue, req.body.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'equipment_schedules', entityId: result.lastInsertRowid, newValue: { equipmentId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, nextDueDate: nextDue });
  });

  router.put('/schedules/:sid', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM equipment_schedules WHERE id = ?').get(req.params.sid) as any;
    if (!old) return res.status(404).json({ error: 'Schedule not found' });
    if (req.body.frequency && !SCHEDULE_FREQUENCIES.includes(req.body.frequency)) return res.status(400).json({ error: 'Invalid frequency' });
    db.prepare('UPDATE equipment_schedules SET schedule_type = ?, frequency = ?, interval_days = ?, provider_type = ?, provider_name = ?, responsible_staff_id = ?, section_id = ?, task_description = ?, next_due_date = ?, is_active = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.scheduleType ?? old.schedule_type,
        req.body.frequency ?? old.frequency,
        req.body.intervalDays !== undefined ? parseIntNullable(req.body.intervalDays) : old.interval_days,
        req.body.providerType ?? old.provider_type,
        req.body.providerName ?? old.provider_name,
        req.body.responsibleStaffId !== undefined ? parseIntNullable(req.body.responsibleStaffId) : old.responsible_staff_id,
        req.body.sectionId !== undefined ? parseIntNullable(req.body.sectionId) : old.section_id,
        req.body.taskDescription ?? old.task_description,
        req.body.nextDueDate ?? old.next_due_date,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : old.is_active,
        req.body.notes ?? old.notes,
        req.params.sid
      );
    audit(req, { action: 'edit', entity: 'equipment_schedules', entityId: req.params.sid, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ===================== Equipment adverse events =====================
  // Raise a nonconformity for an adverse event and link them both ways.
  function raiseNcForAdverseEvent(db: any, req: any, ae: any): number {
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, ae.reported_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, impact_level, immediate_correction, patient_or_service_impact, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, ae.event_date, detectedBy, 'equipment', String(ae.id), `Equipment adverse event: ${ae.event_type}`, ae.description, 'equipment', ae.severity ?? 'high', ae.patient_harm ?? null, ae.immediate_action ?? null, ae.patient_harm ? `Patient harm: ${ae.patient_harm}` : null, 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE equipment_adverse_events SET nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, ae.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_adverse_events', String(ae.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC raised from equipment adverse event');
    return ncId;
  }

  router.get('/adverse-events', requirePermission('equipment.adverse', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT a.*, e.name AS equipment_name, e.equipment_number FROM equipment_adverse_events a JOIN equipment_items e ON e.id = a.equipment_id ORDER BY a.event_date DESC, a.id DESC').all());
  });

  router.get('/:id/adverse-events', requirePermission('equipment.adverse', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_adverse_events WHERE equipment_id = ? ORDER BY event_date DESC, id DESC').all(req.params.id));
  });

  router.post('/:id/adverse-events', requirePermission('equipment.adverse', 'create'), (req, res) => {
    if (!req.body.eventDate) return res.status(400).json({ error: 'eventDate is required' });
    if (!req.body.eventType) return res.status(400).json({ error: 'eventType is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'equipment_adverse_events', 'EAE', createdAt);
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const result = db.prepare(`INSERT INTO equipment_adverse_events (adverse_event_number, equipment_id, event_date, reported_by_staff_id, event_type, severity, patient_harm, description, immediate_action, retrospective_impact_required, results_affected, affected_period_from, affected_period_to, retrospective_impact_summary, reported_to_manufacturer, reported_to_authority, report_reference, report_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.params.id, req.body.eventDate, reportedBy, req.body.eventType, req.body.severity ?? null, req.body.patientHarm ?? null, req.body.description, req.body.immediateAction ?? null, req.body.retrospectiveImpactRequired ? 1 : 0, req.body.resultsAffected ? 1 : 0, req.body.affectedPeriodFrom ?? null, req.body.affectedPeriodTo ?? null, req.body.retrospectiveImpactSummary ?? null, req.body.reportedToManufacturer ? 1 : 0, req.body.reportedToAuthority ? 1 : 0, req.body.reportReference ?? null, req.body.reportDate ?? null, 'open', req.user!.id, createdAt);
    const id = Number(result.lastInsertRowid);
    // A reportable adverse event is a nonconformity by definition — auto-raise
    // and link one unless the caller explicitly opts out.
    let ncId: number | null = null;
    if (req.body.raiseNc !== false) {
      const ae = db.prepare('SELECT * FROM equipment_adverse_events WHERE id = ?').get(id) as any;
      ncId = raiseNcForAdverseEvent(db, req, ae);
    }
    audit(req, { action: 'create', entity: 'equipment_adverse_events', entityId: id, newValue: { number, equipmentId: req.params.id, ncId } });
    res.status(201).json({ id, adverseEventNumber: number, ncId });
  });

  router.get('/adverse-events/:aid', requirePermission('equipment.adverse', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare('SELECT a.*, e.name AS equipment_name, e.equipment_number FROM equipment_adverse_events a JOIN equipment_items e ON e.id = a.equipment_id WHERE a.id = ?').get(req.params.aid);
    if (!record) return res.status(404).json({ error: 'Adverse event not found' });
    res.json(record);
  });

  router.put('/adverse-events/:aid', requirePermission('equipment.adverse', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM equipment_adverse_events WHERE id = ?').get(req.params.aid) as any;
    if (!old) return res.status(404).json({ error: 'Adverse event not found' });
    const b = req.body;
    db.prepare(`UPDATE equipment_adverse_events SET severity = ?, patient_harm = ?, immediate_action = ?, investigation = ?, investigated_by_staff_id = ?, investigation_date = ?, corrective_action = ?, follow_up = ?, follow_up_date = ?, retrospective_impact_required = ?, results_affected = ?, affected_period_from = ?, affected_period_to = ?, retrospective_impact_summary = ?, reported_to_manufacturer = ?, reported_to_authority = ?, report_reference = ?, report_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        b.severity ?? old.severity,
        b.patientHarm ?? old.patient_harm,
        b.immediateAction ?? old.immediate_action,
        b.investigation ?? old.investigation,
        b.investigatedByStaffId !== undefined ? parseIntNullable(b.investigatedByStaffId) : old.investigated_by_staff_id,
        b.investigationDate ?? old.investigation_date,
        b.correctiveAction ?? old.corrective_action,
        b.followUp ?? old.follow_up,
        b.followUpDate ?? old.follow_up_date,
        b.retrospectiveImpactRequired !== undefined ? (b.retrospectiveImpactRequired ? 1 : 0) : old.retrospective_impact_required,
        b.resultsAffected !== undefined ? (b.resultsAffected ? 1 : 0) : old.results_affected,
        b.affectedPeriodFrom ?? old.affected_period_from,
        b.affectedPeriodTo ?? old.affected_period_to,
        b.retrospectiveImpactSummary ?? old.retrospective_impact_summary,
        b.reportedToManufacturer !== undefined ? (b.reportedToManufacturer ? 1 : 0) : old.reported_to_manufacturer,
        b.reportedToAuthority !== undefined ? (b.reportedToAuthority ? 1 : 0) : old.reported_to_authority,
        b.reportReference ?? old.report_reference,
        b.reportDate ?? old.report_date,
        b.status ?? old.status,
        req.params.aid
      );
    audit(req, { action: 'edit', entity: 'equipment_adverse_events', entityId: req.params.aid, oldValue: old, newValue: b });
    res.json({ ok: true });
  });

  router.post('/adverse-events/:aid/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const ae = db.prepare('SELECT * FROM equipment_adverse_events WHERE id = ?').get(req.params.aid) as any;
    if (!ae) return res.status(404).json({ error: 'Adverse event not found' });
    if (ae.nc_id) return res.status(409).json({ error: 'A nonconformity is already linked.' });
    const ncId = raiseNcForAdverseEvent(db, req, ae);
    res.status(201).json({ ncId });
  });

  router.post('/adverse-events/:aid/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const ae = db.prepare('SELECT * FROM equipment_adverse_events WHERE id = ?').get(req.params.aid) as any;
    if (!ae) return res.status(404).json({ error: 'Adverse event not found' });
    if (ae.capa_id) return res.status(409).json({ error: 'A CAPA is already linked.' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, corrective_action, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'equipment', String(ae.id), ae.nc_id ?? null, req.body.title ?? `CAPA for equipment adverse event ${ae.adverse_event_number}`, req.body.problemSummary ?? ae.description, req.body.correctiveAction ?? ae.corrective_action ?? null, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'high', 'open', req.user!.id, createdAt);
    const capaId = Number(result.lastInsertRowid);
    db.prepare('UPDATE equipment_adverse_events SET capa_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, 'action_required', req.params.aid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_adverse_events', String(ae.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from equipment adverse event');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'equipment', sourceRecordId: ae.id } });
    res.status(201).json({ capaId, capaNumber });
  });

  // ===================== Equipment training & competence =====================
  router.get('/competencies', requirePermission('equipment.training', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT c.*, e.name AS equipment_name, e.equipment_number, s.full_name AS staff_name FROM equipment_competencies c JOIN equipment_items e ON e.id = c.equipment_id JOIN staff s ON s.id = c.staff_id ORDER BY c.created_at DESC`).all());
  });

  router.get('/:id/competencies', requirePermission('equipment.training', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT c.*, s.full_name AS staff_name FROM equipment_competencies c JOIN staff s ON s.id = c.staff_id WHERE c.equipment_id = ? ORDER BY c.created_at DESC').all(req.params.id));
  });

  router.post('/:id/competencies', requirePermission('equipment.training', 'create'), (req, res) => {
    if (!req.body.staffId) return res.status(400).json({ error: 'staffId is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id, name, equipment_number, section_id, department_id FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const staffId = parseIntNullable(req.body.staffId);
    const outcome = req.body.outcome ?? 'competent';
    const authorized = req.body.authorized ? 1 : 0;
    const assessmentDate = req.body.assessmentDate ?? req.body.trainingDate ?? new Date().toISOString().slice(0, 10);
    const activity = `Operate equipment ${equipment.equipment_number} — ${equipment.name}`;

    const tx = db.transaction(() => {
      const result = db.prepare(`INSERT INTO equipment_competencies (equipment_id, staff_id, training_date, trainer_staff_id, assessment_method, assessment_date, assessor_staff_id, outcome, authorized, authorization_level, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.params.id, staffId, req.body.trainingDate ?? null, parseIntNullable(req.body.trainerStaffId), req.body.assessmentMethod ?? null, assessmentDate, parseIntNullable(req.body.assessorStaffId), outcome, authorized, req.body.authorizationLevel ?? null, req.body.notes ?? null, 'recorded', req.user!.id);
      const ecId = Number(result.lastInsertRowid);

      let competencyAssessmentId: number | null = null;
      let technicalAuthorizationId: number | null = null;
      // Competent staff get a personnel competency assessment; authorised ones
      // also get a technical authorization — both appear in Personnel Management.
      if (outcome === 'competent' || outcome === 'competent_with_supervision') {
        const createdAt = new Date().toISOString();
        const competencyNumber = generateRecordNumber(db, 'competency_assessments', 'COMP', createdAt);
        const compRes = db.prepare(`INSERT INTO competency_assessments (competency_number, staff_id, department_id, section_id, activity, assessment_method, assessor_staff_id, assessment_date, outcome, findings, retraining_required, next_assessment_due, authorization_recommendation, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(competencyNumber, staffId, equipment.department_id ?? null, equipment.section_id ?? null, activity, req.body.assessmentMethod ?? 'direct_observation', parseIntNullable(req.body.assessorStaffId), assessmentDate, outcome, req.body.notes ?? null, 0, req.body.nextAssessmentDue ?? null, authorized ? `Authorise to operate: ${req.body.authorizationLevel ?? 'Perform'}` : null, 'completed', req.user!.id, createdAt);
        competencyAssessmentId = Number(compRes.lastInsertRowid);
        db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_items', String(req.params.id), 'personnel', 'competency_assessments', String(competencyAssessmentId), `Equipment competence: ${activity}`);

        if (authorized) {
          const authRes = db.prepare('INSERT INTO technical_authorizations (staff_id, module_key, section_id, level, is_active, expires_at, competency_assessment_id, created_by, notes) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)')
            .run(staffId, 'equipment', equipment.section_id ?? null, req.body.authorizationLevel ?? 'Perform', req.body.authorizationExpiry ?? null, competencyAssessmentId, req.user!.id, `Authorised to operate ${equipment.equipment_number} — ${equipment.name}`);
          technicalAuthorizationId = Number(authRes.lastInsertRowid);
        }
        db.prepare('UPDATE equipment_competencies SET competency_assessment_id = ?, technical_authorization_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(competencyAssessmentId, technicalAuthorizationId, authorized ? 'authorised' : 'competent', ecId);
      }
      return { ecId, competencyAssessmentId, technicalAuthorizationId };
    });
    const out = tx();
    audit(req, { action: 'create', entity: 'equipment_competencies', entityId: out.ecId, newValue: { equipmentId: req.params.id, staffId, outcome, authorized } });
    res.status(201).json(out);
  });

  // ===================== Equipment documents (via Documents module) =====================
  router.get('/:id/documents', requirePermission('equipment.files', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT d.id, d.document_code, d.title, d.document_type, d.status,
        (SELECT file_id FROM document_versions WHERE document_id = d.id AND file_id IS NOT NULL ORDER BY id DESC LIMIT 1) AS file_id
      FROM record_links rl JOIN documents d ON d.id = CAST(rl.target_record_id AS INTEGER)
      WHERE rl.source_module_key = 'equipment' AND rl.source_record_type = 'equipment_items' AND rl.source_record_id = ? AND rl.target_module_key = 'documents' AND rl.target_record_type = 'documents'
      ORDER BY d.id DESC`).all(req.params.id));
  });

  // Link an already-created controlled document (from the Documents module) to
  // this equipment so it appears in both places.
  router.post('/:id/documents', requirePermission('equipment.files', 'edit'), (req, res) => {
    if (!req.body.documentId) return res.status(400).json({ error: 'documentId is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.body.documentId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const exists = db.prepare("SELECT 1 FROM record_links WHERE source_module_key='equipment' AND source_record_type='equipment_items' AND source_record_id=? AND target_module_key='documents' AND target_record_type='documents' AND target_record_id=?").get(String(req.params.id), String(req.body.documentId));
    if (!exists) {
      db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_items', String(req.params.id), 'documents', 'documents', String(req.body.documentId), req.body.notes ?? 'Equipment document');
    }
    audit(req, { action: 'link', entity: 'equipment_items', entityId: req.params.id, newValue: { documentId: req.body.documentId } });
    res.status(201).json({ ok: true });
  });

  // `/:id` matches any single segment, so it would otherwise swallow every
  // collection route declared after it — /maintenance-tasks and
  // /maintenance-charts among them, which is exactly how those started
  // answering 404. An equipment id is always numeric, so anything else falls
  // through to the route that actually means it.
  router.get('/:id', numericOnly, requirePermission('equipment.register', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Equipment item not found' });
    const maintenance = db.prepare('SELECT * FROM equipment_maintenance_records WHERE equipment_id = ? ORDER BY maintenance_date DESC').all(req.params.id);
    const breakdowns = db.prepare('SELECT * FROM equipment_breakdowns WHERE equipment_id = ? ORDER BY breakdown_date DESC').all(req.params.id);
    const verifications = db.prepare('SELECT * FROM equipment_verification_records WHERE equipment_id = ? ORDER BY performed_date DESC, id DESC').all(req.params.id);
    const calibrations = db.prepare('SELECT * FROM equipment_calibration_records WHERE equipment_id = ? ORDER BY calibration_date DESC, id DESC').all(req.params.id);
    const schedules = db.prepare('SELECT * FROM equipment_schedules WHERE equipment_id = ? ORDER BY is_active DESC, next_due_date').all(req.params.id);
    const adverseEvents = db.prepare('SELECT * FROM equipment_adverse_events WHERE equipment_id = ? ORDER BY event_date DESC, id DESC').all(req.params.id);
    const competencies = db.prepare('SELECT c.*, s.full_name AS staff_name FROM equipment_competencies c JOIN staff s ON s.id = c.staff_id WHERE c.equipment_id = ? ORDER BY c.created_at DESC').all(req.params.id);
    const documents = db.prepare(`SELECT d.id, d.document_code, d.title, d.document_type, d.status,
        (SELECT file_id FROM document_versions WHERE document_id = d.id AND file_id IS NOT NULL ORDER BY id DESC LIMIT 1) AS file_id
      FROM record_links rl JOIN documents d ON d.id = CAST(rl.target_record_id AS INTEGER)
      WHERE rl.source_module_key = 'equipment' AND rl.source_record_type = 'equipment_items' AND rl.source_record_id = ? AND rl.target_module_key = 'documents' AND rl.target_record_type = 'documents'
      ORDER BY d.id DESC`).all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('equipment', 'equipment_items', String(req.params.id), 'equipment', 'equipment_items', String(req.params.id));
    res.json({ ...item, maintenance, breakdowns, verifications, calibrations, schedules, adverseEvents, competencies, documents, links });
  });

  router.post('/', requirePermission('equipment.register', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    if (!req.body.status) return res.status(400).json({ error: 'status is required' });
    if (!EQUIPMENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    // Use the caller's identifier when supplied (manual override), otherwise
    // generate the next one from the configured pattern.
    const equipmentNumber = (typeof req.body.equipmentNumber === 'string' && req.body.equipmentNumber.trim())
      ? req.body.equipmentNumber.trim()
      : generateEquipmentNumber(db, createdAt);
    if (db.prepare('SELECT 1 FROM equipment_items WHERE equipment_number = ?').get(equipmentNumber)) {
      return res.status(409).json({ error: `Equipment identifier ${equipmentNumber} is already in use.` });
    }
    const responsibleStaffId = parseIntNullable(req.body.responsibleStaffId ?? req.body.assignedToStaffId);
    const nextMaintenanceDue = req.body.nextMaintenanceDue ?? req.body.nextServiceDue ?? null;
    // The chosen category is a configurable label; resolve the archetype it is
    // pinned to, and derive the legacy class from that.
    const cat = resolveCategory(db, req.body.equipmentCategory, req.body.name, req.body.category ?? req.body.equipmentType);
    const result = db.prepare(`INSERT INTO equipment_items (equipment_number, name, equipment_class, equipment_category, equipment_archetype, manufacturer, model, serial_number, location_id, department_id, section_id, status, calibration_due_date, last_service_date, next_service_due, assigned_to_staff_id, equipment_type, maintenance_frequency, calibration_frequency, next_maintenance_due, next_calibration_due, responsible_staff_id, date_received, date_commissioned, calibration_required, notes, supplier_name, supplier_location, supplier_contact, country_of_origin, condition_received, date_out_of_service, criticality, ifu_file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        equipmentNumber,
        req.body.name,
        classForCategory(cat.archetype),
        cat.category,
        cat.archetype,
        req.body.manufacturer ?? null,
        req.body.model ?? null,
        req.body.serialNumber ?? null,
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        req.body.status,
        req.body.calibrationDueDate ?? req.body.nextCalibrationDue ?? null,
        req.body.lastServiceDate ?? null,
        nextMaintenanceDue,
        responsibleStaffId,
        req.body.equipmentType ?? null,
        req.body.maintenanceFrequency ?? null,
        req.body.calibrationFrequency ?? null,
        nextMaintenanceDue,
        req.body.nextCalibrationDue ?? req.body.calibrationDueDate ?? null,
        responsibleStaffId,
        req.body.dateReceived ?? null,
        req.body.dateCommissioned ?? req.body.dateInService ?? null,
        req.body.calibrationRequired ? 1 : 0,
        req.body.notes ?? null,
        req.body.supplierName ?? null,
        req.body.supplierLocation ?? null,
        req.body.supplierContact ?? null,
        req.body.countryOfOrigin ?? null,
        req.body.conditionReceived ?? null,
        req.body.dateOutOfService ?? null,
        req.body.criticality ?? null,
        parseIntNullable(req.body.ifuFileId),
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'equipment_items', entityId: result.lastInsertRowid, newValue: { equipmentNumber, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, equipmentNumber });
  });

  router.put('/:id', numericOnly, requirePermission('equipment.register', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Equipment item not found' });
    if (req.body.status && !EQUIPMENT_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${EQUIPMENT_STATUSES.join(', ')}` });
    }
    const responsibleStaffId = parseIntNullable(req.body.responsibleStaffId ?? req.body.assignedToStaffId) ?? oldValue.responsible_staff_id ?? oldValue.assigned_to_staff_id;
    // Allow a manual identifier override, but keep it unique.
    let equipmentNumber = oldValue.equipment_number;
    if (typeof req.body.equipmentNumber === 'string' && req.body.equipmentNumber.trim() && req.body.equipmentNumber.trim() !== oldValue.equipment_number) {
      equipmentNumber = req.body.equipmentNumber.trim();
      if (db.prepare('SELECT 1 FROM equipment_items WHERE equipment_number = ? AND id <> ?').get(equipmentNumber, req.params.id)) {
        return res.status(409).json({ error: `Equipment identifier ${equipmentNumber} is already in use.` });
      }
    }
    const cat = req.body.equipmentCategory === undefined
      ? { category: oldValue.equipment_category, archetype: oldValue.equipment_archetype ?? oldValue.equipment_category ?? 'other' }
      : resolveCategory(db, req.body.equipmentCategory, req.body.name ?? oldValue.name, null);
    db.prepare(`UPDATE equipment_items SET equipment_number = ?, name = ?, equipment_class = ?, equipment_category = ?, equipment_archetype = ?, manufacturer = ?, model = ?, serial_number = ?, location_id = ?, department_id = ?, section_id = ?, status = ?, calibration_due_date = ?, last_service_date = ?, next_service_due = ?, assigned_to_staff_id = ?, equipment_type = ?, maintenance_frequency = ?, calibration_frequency = ?, next_maintenance_due = ?, next_calibration_due = ?, responsible_staff_id = ?, date_received = ?, date_commissioned = ?, calibration_required = ?, notes = ?, supplier_name = ?, supplier_location = ?, supplier_contact = ?, country_of_origin = ?, condition_received = ?, date_out_of_service = ?, criticality = ?, ifu_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        equipmentNumber,
        req.body.name ?? oldValue.name,
        classForCategory(cat.archetype as never),
        cat.category,
        cat.archetype,
        req.body.manufacturer ?? oldValue.manufacturer,
        req.body.model ?? oldValue.model,
        req.body.serialNumber ?? oldValue.serial_number,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.status ?? oldValue.status,
        req.body.calibrationDueDate ?? oldValue.calibration_due_date,
        req.body.lastServiceDate ?? oldValue.last_service_date,
        req.body.nextServiceDue ?? req.body.nextMaintenanceDue ?? oldValue.next_service_due,
        responsibleStaffId,
        req.body.equipmentType ?? oldValue.equipment_type,
        req.body.maintenanceFrequency ?? oldValue.maintenance_frequency,
        req.body.calibrationFrequency ?? oldValue.calibration_frequency,
        req.body.nextMaintenanceDue ?? oldValue.next_maintenance_due,
        req.body.nextCalibrationDue ?? oldValue.next_calibration_due,
        responsibleStaffId,
        req.body.dateReceived ?? oldValue.date_received,
        req.body.dateCommissioned ?? req.body.dateInService ?? oldValue.date_commissioned,
        req.body.calibrationRequired !== undefined ? (req.body.calibrationRequired ? 1 : 0) : oldValue.calibration_required,
        req.body.notes ?? oldValue.notes,
        req.body.supplierName ?? oldValue.supplier_name,
        req.body.supplierLocation ?? oldValue.supplier_location,
        req.body.supplierContact ?? oldValue.supplier_contact,
        req.body.countryOfOrigin ?? oldValue.country_of_origin,
        req.body.conditionReceived ?? oldValue.condition_received,
        req.body.dateOutOfService ?? oldValue.date_out_of_service,
        req.body.criticality ?? oldValue.criticality,
        req.body.ifuFileId !== undefined ? parseIntNullable(req.body.ifuFileId) : oldValue.ifu_file_id,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'equipment_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // Decommissioning & safe disposal. One record per item; sets status to retired
  // and captures decontamination confirmation + disposal method as a safety and
  // traceability trail.
  router.post('/:id/decommission', requirePermission('equipment.register', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Equipment item not found' });
    if (!req.body.decommissionedAt) return res.status(400).json({ error: 'decommissionedAt is required' });
    if (!req.body.decontaminationConfirmed) return res.status(400).json({ error: 'Decontamination must be confirmed before decommissioning' });
    db.prepare(`UPDATE equipment_items SET decommissioned = 1, decommissioned_at = ?, decommissioned_by_staff_id = ?, decommission_reason = ?, decontamination_confirmed = 1, decontamination_method = ?, decontamination_confirmed_by_staff_id = ?, disposal_method = ?, disposal_date = ?, disposal_reference = ?, disposal_evidence_file_id = ?, date_out_of_service = COALESCE(date_out_of_service, ?), status = 'retired', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.decommissionedAt,
        getStaffIdOrCurrent(req, req.body.decommissionedByStaffId),
        req.body.decommissionReason ?? null,
        req.body.decontaminationMethod ?? null,
        getStaffIdOrCurrent(req, req.body.decontaminationConfirmedByStaffId),
        req.body.disposalMethod ?? null,
        req.body.disposalDate ?? null,
        req.body.disposalReference ?? null,
        parseIntNullable(req.body.disposalEvidenceFileId),
        req.body.decommissionedAt,
        req.params.id
      );
    audit(req, { action: 'decommission', entity: 'equipment_items', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // Maintenance records
  router.get('/:id/maintenance', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_maintenance_records WHERE equipment_id = ? ORDER BY maintenance_date DESC').all(req.params.id));
  });

  router.post('/:id/maintenance', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    if (!req.body.maintenanceDate) return res.status(400).json({ error: 'maintenanceDate is required' });
    if (!req.body.maintenanceType) return res.status(400).json({ error: 'maintenanceType is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id FROM equipment_items WHERE id = ?').get(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const performedBy = getStaffIdOrCurrent(req, req.body.performedByStaffId);
    const scheduleId = parseIntNullable(req.body.scheduleId);
    const result = db.prepare(`INSERT INTO equipment_maintenance_records (equipment_id, maintenance_date, maintenance_type, performed_by_staff_id, findings, action_taken, next_due_date, status, evidence_file_id, reviewed_by_staff_id, schedule_id, service_provider, provider_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.maintenanceDate,
        req.body.maintenanceType,
        performedBy,
        req.body.findings ?? null,
        req.body.actionTaken ?? null,
        req.body.nextDueDate ?? null,
        req.body.status ?? 'completed',
        parseIntNullable(req.body.evidenceFileId),
        parseIntNullable(req.body.reviewedByStaffId),
        scheduleId,
        req.body.serviceProvider ?? null,
        req.body.providerType ?? null,
        req.user!.id
      );
    if (req.body.nextDueDate) {
      db.prepare('UPDATE equipment_items SET last_service_date = ?, next_service_due = ?, next_maintenance_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(req.body.maintenanceDate, req.body.nextDueDate, req.body.nextDueDate, req.params.id);
    } else {
      db.prepare('UPDATE equipment_items SET last_service_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.maintenanceDate, req.params.id);
    }
    // Logging against a schedule rolls it forward from the date it was done.
    if (scheduleId) {
      const sched = db.prepare('SELECT * FROM equipment_schedules WHERE id = ? AND equipment_id = ?').get(scheduleId, req.params.id) as any;
      if (sched) {
        const nextDue = req.body.nextDueDate || advanceDate(req.body.maintenanceDate, sched.frequency, sched.interval_days);
        db.prepare('UPDATE equipment_schedules SET last_done_date = ?, next_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.maintenanceDate, nextDue, scheduleId);
      }
    }
    audit(req, { action: 'create', entity: 'equipment_maintenance_records', entityId: result.lastInsertRowid, newValue: { equipmentId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  // Breakdowns
  router.get('/:id/breakdowns', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM equipment_breakdowns WHERE equipment_id = ? ORDER BY breakdown_date DESC').all(req.params.id));
  });

  router.post('/:id/breakdown', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    if (!req.body.breakdownDate) return res.status(400).json({ error: 'breakdownDate is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    const db = getDb();
    const equipment = db.prepare('SELECT id, status FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!equipment) return res.status(404).json({ error: 'Equipment item not found' });
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const equipmentStatusUpdate = req.body.equipmentStatus ?? 'out_of_service';
    if (equipmentStatusUpdate && !['out_of_service', 'under_repair', 'restricted_use'].includes(equipmentStatusUpdate)) {
      return res.status(400).json({ error: 'equipmentStatus must be out_of_service, under_repair, or restricted_use' });
    }
    const result = db.prepare(`INSERT INTO equipment_breakdowns (equipment_id, breakdown_date, reported_by_staff_id, description, service_impact, immediate_action, equipment_status, repair_action, service_provider, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.breakdownDate,
        reportedBy,
        req.body.description,
        req.body.serviceImpact ?? null,
        req.body.immediateAction ?? null,
        equipmentStatusUpdate,
        req.body.repairAction ?? null,
        req.body.serviceProvider ?? null,
        req.body.status ?? 'open',
        req.user!.id
      );
    db.prepare('UPDATE equipment_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(equipmentStatusUpdate, req.params.id);
    audit(req, { action: 'create', entity: 'equipment_breakdowns', entityId: result.lastInsertRowid, newValue: { equipmentId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/breakdowns/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const breakdown = db.prepare('SELECT * FROM equipment_breakdowns WHERE id = ?').get(req.params.id) as any;
    if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedByStaffId = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? breakdown.reported_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, impact_level, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        breakdown.breakdown_date,
        detectedByStaffId,
        'equipment',
        String(breakdown.id),
        req.body.title ?? `Equipment breakdown #${breakdown.id}`,
        req.body.description ?? breakdown.description,
        req.body.category ?? 'equipment',
        req.body.severity ?? 'medium',
        req.body.impactLevel ?? breakdown.service_impact ?? null,
        req.body.immediateCorrection ?? breakdown.immediate_action ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE equipment_breakdowns SET nc_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, 'action_required', req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_breakdowns', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC raised from equipment breakdown');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'equipment', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/breakdowns/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const breakdown = db.prepare('SELECT * FROM equipment_breakdowns WHERE id = ?').get(req.params.id) as any;
    if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const result = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, root_cause, corrective_action, preventive_action, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        capaNumber,
        'equipment',
        String(breakdown.id),
        breakdown.nc_id ?? null,
        req.body.title ?? `CAPA for equipment breakdown #${breakdown.id}`,
        req.body.problemSummary ?? breakdown.description,
        req.body.rootCause ?? null,
        req.body.correctiveAction ?? breakdown.repair_action ?? null,
        req.body.preventiveAction ?? null,
        parseIntNullable(req.body.responsibleStaffId),
        req.body.dueDate ?? null,
        req.body.priority ?? 'normal',
        'open',
        req.user!.id,
        createdAt
      );
    const capaId = Number(result.lastInsertRowid);
    db.prepare('UPDATE equipment_breakdowns SET capa_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, 'action_required', req.params.id);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('equipment', 'equipment_breakdowns', String(req.params.id), 'nc_capa', 'capa_records', String(capaId), 'CAPA from equipment breakdown');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'equipment', sourceRecordId: req.params.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/breakdowns/:id/return-to-service', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    const db = getDb();
    const breakdown = db.prepare('SELECT * FROM equipment_breakdowns WHERE id = ?').get(req.params.id) as any;
    if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });
    const verifiedByStaffId = getStaffIdOrCurrent(req, req.body.verifiedByStaffId);
    if (verifiedByStaffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const returnDate = req.body.returnToServiceDate ?? new Date().toISOString();
    const newEquipmentStatus = req.body.equipmentStatus ?? 'operational';
    if (!EQUIPMENT_STATUSES.includes(newEquipmentStatus)) {
      return res.status(400).json({ error: `equipmentStatus must be one of: ${EQUIPMENT_STATUSES.join(', ')}` });
    }
    db.prepare('UPDATE equipment_breakdowns SET return_to_service_date = ?, verified_by_staff_id = ?, status = ?, repair_action = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(returnDate, verifiedByStaffId, 'returned_to_service', req.body.repairAction ?? breakdown.repair_action, req.params.id);
    db.prepare('UPDATE equipment_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newEquipmentStatus, breakdown.equipment_id);
    audit(req, { action: 'edit', entity: 'equipment_breakdowns', entityId: req.params.id, oldValue: breakdown, newValue: { returnToServiceDate: returnDate, verifiedByStaffId, status: 'returned_to_service' } });
    res.json({ ok: true });
  });

  /* ======================================================================
     Maintenance tasks — what is actually done, and when
     ----------------------------------------------------------------------
     equipment_schedules already says when servicing falls due. What it never
     said is what the visit consists of, and that is the part the bench needs:
     "clean the objectives" is a task somebody does on a Tuesday, not a date on
     a calendar.

     Tasks carry their own cadence, so one instrument's chart holds the daily
     lens clean, the weekly condenser check and the annual engineer's service
     together — which is how the laboratory's own freezer schedule is laid out,
     daily rows across the days and weekly rows across the weeks.
     ==================================================================== */

  router.get('/maintenance-tasks', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    const clauses: string[] = ['t.is_active = 1'];
    const params: unknown[] = [];
    if (req.query.equipmentId) { clauses.push('t.equipment_id = ?'); params.push(Number(req.query.equipmentId)); }
    if (req.query.sectionId) { clauses.push('e.section_id = ?'); params.push(Number(req.query.sectionId)); }
    if (req.query.kind) { clauses.push('t.maintenance_kind = ?'); params.push(String(req.query.kind)); }
    if (req.query.active === 'all') clauses.shift();
    res.json(db.prepare(`SELECT t.*, e.name AS equipment_name, e.equipment_number, e.section_id,
          s.provider_name, s.provider_type AS schedule_provider_type, s.next_due_date
        FROM equipment_maintenance_tasks t
        JOIN equipment_items e ON e.id = t.equipment_id
        LEFT JOIN equipment_schedules s ON s.id = t.schedule_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY e.name, t.maintenance_kind, t.display_order, t.id`).all(...params));
  });

  /**
   * What this instrument would normally be maintained with.
   *
   * A laboratory adding a microscope should not have to invent "clean the
   * objectives daily". The framework is chosen from the instrument's name and
   * archetype, offered in full, and edited on the way in — nothing here
   * overrides a manufacturer's manual, and the screen says so.
   */
  router.get('/:id/maintenance-framework', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    const equipment = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    const framework = frameworkForEquipment(equipment.name, equipment.equipment_archetype ?? equipment.equipment_category);
    const existing = db.prepare('SELECT task_text FROM equipment_maintenance_tasks WHERE equipment_id = ? AND is_active = 1').all(req.params.id) as any[];
    const have = new Set(existing.map(t => String(t.task_text).toLowerCase().trim()));
    res.json({
      framework: framework.key,
      label: framework.label,
      allFrameworks: MAINTENANCE_FRAMEWORKS.map(f => ({ key: f.key, label: f.label })),
      tasks: framework.tasks.map(t => ({ ...t, alreadyAdded: have.has(t.task.toLowerCase().trim()) })),
    });
  });

  router.post('/:id/maintenance-tasks', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    const db = getDb();
    const equipment = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const items = Array.isArray(req.body?.tasks) ? req.body.tasks : [req.body ?? {}];
    const insert = db.prepare(`INSERT INTO equipment_maintenance_tasks
        (equipment_id, schedule_id, maintenance_kind, task_text, guidance, frequency, performer_tier,
         provider_type, consumable, display_order, framework_key, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const startOrder = Number((db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM equipment_maintenance_tasks WHERE equipment_id = ?').get(req.params.id) as any).n);

    const created: number[] = [];
    const problems: string[] = [];
    const tx = db.transaction(() => {
      items.forEach((item: any, index: number) => {
        const text = String(item.task ?? item.taskText ?? '').trim();
        if (!text) { problems.push('A task with no wording was skipped.'); return; }
        const frequency = String(item.frequency ?? 'daily');
        if (!(MAINTENANCE_FREQUENCIES as readonly string[]).includes(frequency)) { problems.push(`"${text}": ${frequency} is not a frequency this system schedules.`); return; }
        const kind = String(item.kind ?? item.maintenanceKind ?? 'routine');
        if (!(MAINTENANCE_KINDS as readonly string[]).includes(kind)) { problems.push(`"${text}": maintenance must be routine or scheduled.`); return; }
        const result = insert.run(req.params.id, parseIntNullable(item.scheduleId), kind, text,
          item.guidance ?? null, frequency,
          // Scheduled servicing defaults to the supervisor, routine care to
          // whoever is on duty. A laboratory that disagrees changes it here.
          String(item.tier ?? item.performerTier ?? (kind === 'scheduled' ? 'supervisory' : 'general')),
          item.providerType ?? (kind === 'scheduled' ? 'external' : 'internal'),
          item.consumable ?? null, startOrder + index, item.frameworkKey ?? null, req.user!.id);
        created.push(Number(result.lastInsertRowid));
      });
    });
    tx();

    if (created.length) syncMaintenanceSchedule(db, Number(req.params.id), req.user!.id);
    audit(req, { action: 'create', entity: 'equipment_maintenance_tasks', entityId: req.params.id, newValue: { added: created.length } });
    res.status(created.length ? 201 : 400).json({ created: created.length, ids: created, problems });
  });

  router.put('/maintenance-tasks/:id', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM equipment_maintenance_tasks WHERE id = ?').get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: 'Maintenance task not found' });
    const b = req.body ?? {};
    const frequency = b.frequency !== undefined ? String(b.frequency) : task.frequency;
    if (!(MAINTENANCE_FREQUENCIES as readonly string[]).includes(frequency)) {
      return res.status(400).json({ error: `Frequency must be one of: ${MAINTENANCE_FREQUENCIES.join(', ')}.` });
    }
    db.prepare(`UPDATE equipment_maintenance_tasks SET task_text = ?, guidance = ?, frequency = ?,
        maintenance_kind = ?, performer_tier = ?, provider_type = ?, consumable = ?, schedule_id = ?,
        display_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(String(b.taskText ?? b.task ?? task.task_text).trim(), b.guidance ?? task.guidance, frequency,
        String(b.maintenanceKind ?? b.kind ?? task.maintenance_kind),
        String(b.performerTier ?? b.tier ?? task.performer_tier),
        b.providerType ?? task.provider_type, b.consumable ?? task.consumable,
        b.scheduleId !== undefined ? parseIntNullable(b.scheduleId) : task.schedule_id,
        b.displayOrder !== undefined ? (parseIntNullable(b.displayOrder) ?? task.display_order) : task.display_order,
        b.isActive !== undefined ? (b.isActive ? 1 : 0) : task.is_active, req.params.id);
    syncMaintenanceSchedule(db, Number(task.equipment_id), req.user!.id);
    audit(req, { action: 'edit', entity: 'equipment_maintenance_tasks', entityId: req.params.id, oldValue: task, newValue: b });
    res.json({ ok: true });
  });

  /**
   * Retiring a task deactivates it. The months already charted against it are
   * records, and a chart that loses its own rows when somebody tidies the task
   * list is not a chart.
   */
  router.delete('/maintenance-tasks/:id', requirePermission('equipment.maintenance', 'edit'), (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM equipment_maintenance_tasks WHERE id = ?').get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: 'Maintenance task not found' });
    db.prepare('UPDATE equipment_maintenance_tasks SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    syncMaintenanceSchedule(db, Number(task.equipment_id), req.user!.id);
    audit(req, { action: 'delete', entity: 'equipment_maintenance_tasks', entityId: req.params.id, oldValue: task });
    res.json({ ok: true });
  });

  /* ======================================================================
     The unit's own instruments, and what each of them is owed
     ----------------------------------------------------------------------
     A unit head opening the maintenance tab was being told only that no
     maintenance tasks existed anywhere in their unit — which is true and
     useless. It named no instrument, sized no gap, and sent them to a module
     screen to fix it one instrument at a time.

     What they actually need is the inventory: every instrument the unit holds,
     what ISO 15189:2022 says that KIND of instrument is owed (§6.4.5
     maintenance, §6.5.2-6.5.3 calibration with traceability, §7.3.3
     verification, §6.4.3 acceptance, and so on — the duties differ by
     archetype and pretending otherwise is how a fridge ends up in an IQC
     picker), and for each duty whether anything is actually set up.

     The duty list is deliberately derived from the archetype rather than
     asked for. A refrigerator is not exempt from control, it is controlled
     differently from an analyser, and the screen should say which.
     ==================================================================== */
  router.get('/portal/unit-overview', requirePermission('equipment.register', 'view'), (req, res) => {
    const db = getDb();
    const staffId = getCurrentStaffId(req);
    const sectionId = parseIntNullable(req.query.sectionId)
      ?? (staffId !== null ? (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any)?.section_id ?? null : null);

    if (!sectionId) {
      return res.json({
        sectionId: null, sectionName: null, equipment: [], counts: emptyEquipmentCounts(), isUnitHead: false,
        message: 'Your account is not linked to a unit, so no equipment inventory can be listed for you. Ask an administrator to link your staff record to your section.',
      });
    }

    const section = db.prepare('SELECT id, name, head_staff_id FROM sections WHERE id = ?').get(sectionId) as any;
    const isUnitHead = Boolean(staffId !== null && section?.head_staff_id && Number(section.head_staff_id) === Number(staffId));

    const items = db.prepare(`SELECT e.*, s.full_name AS custodian_name, l.name AS location_name
        FROM equipment_items e
        LEFT JOIN staff s ON s.id = COALESCE(e.responsible_staff_id, e.assigned_to_staff_id)
        LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.section_id = ? AND COALESCE(e.decommissioned, 0) = 0 AND e.status != 'decommissioned'
        ORDER BY e.name`).all(sectionId) as any[];

    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    // An install upgraded across several versions may be missing a column one of
    // these reads. That is worth fixing (and the migration does), but it must
    // never blank the whole inventory: the instruments and their maintenance are
    // the point of the screen, and losing them because a calibration column is
    // absent is the wrong failure. A query that cannot be prepared simply
    // reports nothing for its own duty.
    const optional = (sql: string) => {
      try { return db.prepare(sql); } catch { return null; }
    };
    const taskCount = db.prepare(`SELECT maintenance_kind AS kind, COUNT(*) AS n
        FROM equipment_maintenance_tasks WHERE equipment_id = ? AND is_active = 1 GROUP BY maintenance_kind`);
    const lastCalibration = optional(`SELECT calibration_date, next_due_date, result, provider, certificate_number
        FROM equipment_calibration_records WHERE equipment_id = ? ORDER BY calibration_date DESC, id DESC LIMIT 1`);
    const lastVerification = optional(`SELECT verification_date, verification_type, conclusion, status
        FROM equipment_verifications WHERE equipment_id = ? ORDER BY verification_date DESC, id DESC LIMIT 1`);
    const schedules = optional(`SELECT id, schedule_type, frequency, next_due_date, provider_type, provider_name, is_active
        FROM equipment_schedules WHERE equipment_id = ? AND is_active = 1 ORDER BY next_due_date`);
    const controls = optional(`SELECT COUNT(*) AS n FROM iqc_materials WHERE equipment_id = ? AND is_active = 1`);

    /**
     * How a due date reads. "Overdue" and "nothing is scheduled" are different
     * states and the difference matters: one is a lapse, the other is a gap in
     * the programme, and they are answered by different actions.
     */
    const dueState = (date: string | null | undefined): string => {
      if (!date) return 'unscheduled';
      if (date < today) return 'overdue';
      if (date <= soon) return 'due_soon';
      return 'scheduled';
    };

    const rows = items.map(item => {
      const { archetype } = resolveCategory(db, item.equipment_category ?? item.category, item.name, item.category);
      const duties = dutiesFor(archetype);

      const tasks = taskCount.all(item.id) as any[];
      const routine = Number(tasks.find(t => t.kind === 'routine')?.n ?? 0);
      const scheduled = Number(tasks.find(t => t.kind === 'scheduled')?.n ?? 0);
      const calibration = lastCalibration?.get(item.id) as any;
      const verification = lastVerification?.get(item.id) as any;
      const scheduleRows = (schedules?.all(item.id) ?? []) as any[];
      const iqcCount = Number((controls?.get(item.id) as any)?.n ?? 0);

      const scheduleFor = (kind: string) => scheduleRows.find(s => s.schedule_type === kind) ?? null;
      const calibrationDue = calibration?.next_due_date ?? item.next_calibration_due ?? scheduleFor('calibration')?.next_due_date ?? null;
      const maintenanceDue = scheduleFor('preventive_maintenance')?.next_due_date
        ?? item.next_maintenance_due ?? item.next_service_due ?? null;
      const verificationDue = scheduleFor('verification')?.next_due_date ?? null;

      // What is owed, and whether anything answers it. `setUp` is deliberately
      // "is there a programme", not "is it up to date" — the two failures need
      // different words in front of a unit head.
      const state: Record<string, any> = {
        maintenance: {
          setUp: routine + scheduled > 0,
          detail: routine + scheduled > 0
            ? `${routine} routine, ${scheduled} scheduled task${routine + scheduled === 1 ? '' : 's'}`
            : 'No maintenance tasks defined',
          dueDate: maintenanceDue, dueState: dueState(maintenanceDue),
        },
        calibration: {
          setUp: Boolean(calibration || scheduleFor('calibration') || item.calibration_required),
          detail: calibration
            ? `Last calibrated ${calibration.calibration_date}${calibration.result ? ` — ${calibration.result}` : ''}${calibration.provider ? `, ${calibration.provider}` : ''}`
            : scheduleFor('calibration')
              ? `Scheduled ${scheduleFor('calibration')!.frequency}, never yet performed`
              : 'No calibration recorded and none scheduled',
          dueDate: calibrationDue, dueState: dueState(calibrationDue),
        },
        verification: {
          setUp: Boolean(verification || scheduleFor('verification')),
          detail: verification
            ? `Last verified ${verification.verification_date}${verification.conclusion ? ` — ${verification.conclusion}` : ''}`
            : scheduleFor('verification')
              ? `Scheduled ${scheduleFor('verification')!.frequency}, never yet performed`
              : 'No performance verification on record',
          dueDate: verificationDue, dueState: dueState(verificationDue),
        },
        iqc: {
          setUp: iqcCount > 0,
          detail: iqcCount > 0 ? `${iqcCount} control${iqcCount === 1 ? '' : 's'} defined` : 'No controls defined against it',
          dueDate: null, dueState: iqcCount > 0 ? 'scheduled' : 'unscheduled',
        },
      };

      const owed = duties.map(duty => ({
        duty,
        label: DUTY_LABELS[duty],
        clause: DUTY_CLAUSES[duty],
        hint: DUTY_HINTS[duty],
        // Only the four duties above are tracked as records in this system.
        // The rest are listed so the unit head can see the whole obligation,
        // marked as not tracked rather than falsely reported as missing.
        tracked: Object.prototype.hasOwnProperty.call(state, duty),
        ...(state[duty] ?? { setUp: null, detail: null, dueDate: null, dueState: null }),
      }));

      return {
        id: item.id, name: item.name, equipmentNumber: item.equipment_number,
        manufacturer: item.manufacturer, model: item.model, serialNumber: item.serial_number,
        status: item.status, archetype, category: item.equipment_category ?? item.category,
        locationName: item.location_name ?? null, custodianName: item.custodian_name ?? null,
        duties: owed,
        gaps: owed.filter(d => d.tracked && d.setUp === false).map(d => d.duty),
        overdue: owed.filter(d => d.dueState === 'overdue').map(d => d.duty),
        dueSoon: owed.filter(d => d.dueState === 'due_soon').map(d => d.duty),
        maintenanceTasks: routine + scheduled,
      };
    });

    res.json({
      sectionId, sectionName: section?.name ?? null, isUnitHead,
      equipment: rows,
      counts: {
        items: rows.length,
        withGaps: rows.filter(r => r.gaps.length > 0).length,
        overdue: rows.filter(r => r.overdue.length > 0).length,
        dueSoon: rows.filter(r => r.dueSoon.length > 0).length,
        needMaintenanceTasks: rows.filter(r => r.duties.some(d => d.duty === 'maintenance' && d.setUp === false)).length,
        needCalibration: rows.filter(r => r.duties.some(d => d.duty === 'calibration' && d.setUp === false)).length,
        needVerification: rows.filter(r => r.duties.some(d => d.duty === 'verification' && d.setUp === false)).length,
        outOfService: rows.filter(r => r.status === 'out_of_service' || r.status === 'under_repair').length,
      },
      message: null,
    });
  });

  function emptyEquipmentCounts() {
    return {
      items: 0, withGaps: 0, overdue: 0, dueSoon: 0,
      needMaintenanceTasks: 0, needCalibration: 0, needVerification: 0, outOfService: 0,
    };
  }

  /** The unit's maintenance charts for a month. */
  router.get('/maintenance-charts', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const sectionId = parseIntNullable(req.query.sectionId)
      ?? (getCurrentStaffId(req) !== null ? (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(getCurrentStaffId(req)) as any)?.section_id ?? null : null);
    if (!sectionId) return res.json({ month, sectionId: null, sheets: [] });
    res.json({ month, sectionId, sheets: sheetsForSection(db, 'equipment_maintenance', sectionId, month, { userId: req.user!.id }) });
  });

  /** Open one instrument's chart for a month. */
  router.post('/maintenance-charts/open', requirePermission('equipment.maintenance', 'view'), (req, res) => {
    const db = getDb();
    const equipmentId = parseIntNullable(req.body?.equipmentId);
    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month)) ? String(req.body.month) : new Date().toISOString().slice(0, 7);
    if (!equipmentId) return res.status(400).json({ error: 'equipmentId is required' });
    const sheet = openSheet(db, { kind: 'equipment_maintenance', subjectId: equipmentId, month, userId: req.user!.id });
    if (!sheet) return res.status(404).json({ error: 'Equipment not found' });
    refreshSheetRows(db, sheet);
    res.json({ sheetId: sheet.id });
  });

  /**
   * The external engineer's visit.
   *
   * Scheduled servicing is not a tick on a chart — it is a visit, by a named
   * engineer, against a contract, producing a report the laboratory has to be
   * able to show. So it writes a maintenance record, moves the schedule on, and
   * marks the chart row done in one act rather than asking somebody to do the
   * same thing in three places and forget one.
   */
  router.post('/:id/service-visit', requirePermission('equipment.maintenance', 'create'), (req, res) => {
    const db = getDb();
    const equipment = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(req.params.id) as any;
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    const b = req.body ?? {};
    const date = String(b.maintenanceDate ?? '').trim() || new Date().toISOString().slice(0, 10);
    if (!String(b.workDone ?? b.actionTaken ?? '').trim()) {
      return res.status(400).json({ error: 'Record what the engineer actually did. A service visit with no work recorded proves nothing.' });
    }

    const result = db.prepare(`INSERT INTO equipment_maintenance_records
        (equipment_id, maintenance_date, maintenance_type, performed_by_staff_id, findings, action_taken,
         next_due_date, status, evidence_file_id, service_provider, provider_type, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
      .run(req.params.id, date, b.maintenanceType ?? 'scheduled', getStaffIdOrCurrent(req, b.performedByStaffId),
        b.findings ?? null, String(b.workDone ?? b.actionTaken).trim(), b.nextDueDate ?? null,
        parseIntNullable(b.evidenceFileId), b.serviceProvider ?? null, b.providerType ?? 'external', req.user!.id);

    if (b.nextDueDate) {
      db.prepare('UPDATE equipment_items SET last_service_date = ?, next_service_due = ?, next_maintenance_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(date, b.nextDueDate, b.nextDueDate, req.params.id);
      const scheduleId = parseIntNullable(b.scheduleId);
      if (scheduleId) {
        db.prepare('UPDATE equipment_schedules SET last_done_date = ?, next_due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(date, b.nextDueDate, scheduleId);
      }
    }
    audit(req, { action: 'create', entity: 'equipment_maintenance_records', entityId: result.lastInsertRowid, newValue: { equipmentId: req.params.id, date, provider: b.serviceProvider } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  return router;
}

/* ============================================================================
   Putting maintenance on somebody's list
   ----------------------------------------------------------------------------
   One reminder per (instrument × cadence), not one per task. A microscope with
   four daily tasks produces one "Microscope — daily care" entry on the bench's
   list that opens the chart, rather than four items that each need ticking and
   that nobody will tick four times.
   ========================================================================= */
export function syncMaintenanceSchedule(db: any, equipmentId: number, userId: number | null): void {
  const equipment = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(equipmentId) as any;
  if (!equipment?.section_id) return;

  const tasks = db.prepare('SELECT * FROM equipment_maintenance_tasks WHERE equipment_id = ? AND is_active = 1').all(equipmentId) as any[];
  const byFrequency = new Map<string, any[]>();
  for (const task of tasks) {
    const frequency = MAINTENANCE_TO_ACTIVITY_FREQUENCY[task.frequency as keyof typeof MAINTENANCE_TO_ACTIVITY_FREQUENCY] ?? 'daily';
    const list = byFrequency.get(frequency) ?? [];
    list.push(task);
    byFrequency.set(frequency, list);
  }

  const wanted = new Set<string>();
  for (const [frequency, group] of byFrequency) {
    const code = `ACT-MAINT-${equipmentId}-${frequency.toUpperCase()}`;
    wanted.add(code);
    const kinds = new Set(group.map(t => t.maintenance_kind));
    const scheduledOnly = kinds.size === 1 && kinds.has('scheduled');
    // The lowest tier on the group decides, so a technician able to do the
    // daily clean is not blocked by the annual service sharing a chart.
    const tiers = group.map(t => String(t.performer_tier || 'general'));
    const tier = tiers.includes('general') ? 'general' : tiers.includes('technical') ? 'technical' : 'supervisory';

    const label = scheduledOnly
      ? `${equipment.name} — ${frequency} servicing`
      : `${equipment.name} — ${frequency} maintenance`;
    const instructions = group.slice(0, 8).map(t => `• ${t.task_text}`).join('\n')
      + (group.length > 8 ? `\n• …and ${group.length - 8} more on the chart` : '');
    const route = `/equipment?tab=Maintenance&equipment=${equipmentId}`;

    const existing = db.prepare('SELECT id FROM unit_activities WHERE activity_code = ?').get(code) as any;
    if (existing) {
      db.prepare(`UPDATE unit_activities SET name = ?, instructions = ?, frequency = ?, performer_tier = ?,
          section_id = ?, equipment_id = ?, target_route = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(label, instructions, frequency, tier, equipment.section_id, equipmentId, route, existing.id);
      continue;
    }
    db.prepare(`INSERT INTO unit_activities
        (activity_code, name, description, instructions, category, section_id, equipment_id,
         target_module_key, target_route, frequency, assign_mode, performer_tier, priority, estimated_minutes, is_active, created_by)
        VALUES (?, ?, ?, ?, 'equipment', ?, ?, 'equipment.maintenance', ?, ?, 'on_duty', ?, 'normal', ?, 1, ?)`)
      .run(code, label, `${group.length} task(s) on ${equipment.name}.`, instructions,
        equipment.section_id, equipmentId, route, frequency, tier, Math.min(60, 5 * group.length), userId);
  }

  // A cadence that no longer has any task on it stops appearing on the list.
  const stale = db.prepare("SELECT id, activity_code FROM unit_activities WHERE activity_code LIKE ? AND is_active = 1").all(`ACT-MAINT-${equipmentId}-%`) as any[];
  for (const activity of stale) {
    if (!wanted.has(String(activity.activity_code))) {
      db.prepare('UPDATE unit_activities SET is_active = 0 WHERE id = ?').run(activity.id);
    }
  }

  try { generateOccurrences(db, {}); } catch { /* the scheduler will catch up */ }
}

export { BREAKDOWN_STATUSES, EQUIPMENT_STATUSES };
