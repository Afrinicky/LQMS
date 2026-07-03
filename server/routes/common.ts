import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, ensureDataDirs, uploadRoot, evidenceRoot, backupRoot, dbPath, configRoot, dataRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable } from './routeHelpers.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import * as XLSX from 'xlsx';

// archiver is loaded lazily inside the backup handler. Loading it at module
// top level breaks the packaged Electron app under app.asar:
//   - `import archiver from 'archiver'` fails with "does not provide an
//     export named 'default'" because archiver is CommonJS.
//   - `createRequire(import.meta.url)('archiver')` then fails with
//     ERR_REQUIRE_ESM because archiver-utils is itself ESM.
// A lazy dynamic import works in dev, production, and packaged modes and
// keeps the rest of the app bootable even if archiver fails to resolve.
async function loadArchiver(): Promise<(format: string, options?: any) => any> {
  const mod: any = await import('archiver');
  const factory = mod.default ?? mod;
  // archiver <= v7: the module is a callable factory, archiver('zip', opts).
  if (typeof factory === 'function') return factory as (format: string, options?: any) => any;
  // archiver >= v8: pure ESM that exports format-specific classes instead of a
  // factory. Provide a factory shim so the rest of the code is version-agnostic.
  return (format: string, options?: any) => {
    switch (format) {
      case 'tar': return new mod.TarArchive(options);
      case 'json': return new mod.JsonArchive(options);
      case 'zip':
      default: return new mod.ZipArchive(options);
    }
  };
}

// adm-zip is loaded lazily for the same packaging reasons as archiver above:
// it is a CommonJS module and a top-level static import breaks under app.asar.
// A dynamic import resolves the default-exported AdmZip class in dev, prod and
// packaged Electron alike. It is only needed when a restore actually runs.
async function loadAdmZip(): Promise<any> {
  const mod: any = await import('adm-zip');
  return mod.default ?? mod;
}

// Only allow plain backup file names (no path separators / traversal) when a
// caller references an existing backup by name for download or restore.
function isSafeBackupName(name: string): boolean {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+\.zip$/.test(name) && !name.includes('..');
}

// Write a backup ZIP of the current deployment (SQLite + uploads + evidence +
// config + manifest) to targetPath. Shared by the manual "Create backup"
// endpoint and the automatic pre-restore safety snapshot.
async function writeBackupZip(targetPath: string, manifest: unknown): Promise<void> {
  const archiver = await loadArchiver();
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(targetPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'database/sech_lims.sqlite' });
    if (fs.existsSync(uploadRoot)) archive.directory(uploadRoot, 'uploads');
    if (fs.existsSync(evidenceRoot)) archive.directory(evidenceRoot, 'evidence');
    if (fs.existsSync(configRoot)) archive.directory(configRoot, 'config');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'backup-manifest.json' });
    archive.finalize();
  });
}

// Replace the contents of a destination directory with an extracted source
// directory from a backup. A missing source directory leaves the destination
// untouched (the backup simply had nothing for that area).
function replaceDirFromBackup(sourceDir: string, destDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(sourceDir, destDir, { recursive: true });
}

// Safe foreign-key id coercion: empty string / null / undefined / 0 → null,
// otherwise the parsed positive integer. parseIntNullable() alone is unsafe
// for FK columns because Number(null) === Number('') === 0, which would store
// a 0 that violates the foreign-key constraint.
function idOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Compose a display full name as "First Other Surname" from the structured parts,
// falling back to an explicit fullName when the parts are not supplied.
function composeFullName(first?: unknown, surname?: unknown, other?: unknown, fallback?: unknown): string {
  const parts = [first, other, surname].map(s => (s ?? '').toString().trim()).filter(Boolean);
  if (parts.length) return parts.join(' ');
  return (fallback ?? '').toString().trim();
}

// Master Personnel Register (SECHFO003) Excel layout — the exact column order of
// the People & Access staff import/export template. PROFESSIONAL QUALIFICATION(S)
// spans 5 columns (L–P) so several qualifications can be listed per staff member.
// `col` is the staff table column the header maps to (null = layout-only / blank
// continuation column; `__years` = computed years of experience).
const REGISTER_COLUMNS: Array<{ header: string; col: string | null }> = [
  { header: 'STAFF ID', col: 'employee_no' },
  { header: 'SURNAME', col: 'surname' },
  { header: 'MIDDLE NAME(S)', col: 'middle_name' },
  { header: 'FIRSTNAME(S)', col: 'first_name' },
  { header: 'INITIALS', col: 'initials' },
  { header: 'DATE OF BIRTH', col: 'date_of_birth' },
  { header: 'GENDER', col: 'gender' },
  { header: 'DESIGNATION', col: 'designation' },
  { header: 'POSITION', col: 'job_title' },
  { header: 'PRFOFESSIONAL REGULATOR', col: 'professional_regulator' },
  { header: 'PROFESSIONAL LICENCE', col: 'professional_licence' },
  { header: 'PROFESSIONAL QUALIFICATION(S)', col: 'qualifications' },
  { header: '', col: null }, { header: '', col: null }, { header: '', col: null }, { header: '', col: null },
  { header: 'UNIT', col: 'unit' },
  { header: 'PERSONNEL CATEGORY', col: 'personnel_category' },
  { header: 'APPOINTMENT TYPE', col: 'appointment_type' },
  { header: 'DATE OF APPOINTMENT', col: 'appointment_date' },
  { header: 'YEARS_OF_EXPERIENCE', col: '__years' },
  { header: 'TYPE OF NATIONAL ID', col: 'national_id_type' },
  { header: 'NATIONAL ID NUM', col: 'national_id_number' },
  { header: 'EMERGENCY CONTACT', col: 'emergency_contact' },
  { header: 'CONTACT_PHONE', col: 'phone' },
  { header: 'EMAIL_ADDRESS', col: 'email' },
  { header: 'STAFF_FILE_LOCATION', col: 'staff_file_location' },
];
const REGISTER_HEADER_ROW = REGISTER_COLUMNS.map(c => c.header);
const QUAL_COL_INDEX = REGISTER_COLUMNS.findIndex(c => c.col === 'qualifications');

// Years of experience from an appointment date (1 decimal place), tolerant of
// DD/MM/YYYY and ISO formats. Empty when the date is missing/unparseable.
function yearsOfExperience(dateStr?: string | null, now = new Date()): string {
  if (!dateStr) return '';
  let d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    const m = String(dateStr).match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
    if (m) d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  if (isNaN(d.getTime())) return '';
  const yrs = (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return yrs >= 0 ? yrs.toFixed(1) : '';
}

// Master Personnel Register field mapping (personnel records).
// Maps the camelCase API body to staff table columns and derives full_name /
// initials from the structured name parts when supplied.
const STAFF_COLUMN_MAP: Array<[string, string]> = [
  ['employeeNo', 'employee_no'], ['surname', 'surname'], ['middleName', 'middle_name'],
  ['firstName', 'first_name'], ['initials', 'initials'], ['dateOfBirth', 'date_of_birth'],
  ['gender', 'gender'], ['designation', 'designation'], ['jobTitle', 'job_title'],
  ['professionalRegulator', 'professional_regulator'], ['professionalLicence', 'professional_licence'],
  ['licenceExpiryDate', 'licence_expiry_date'], ['qualifications', 'qualifications'], ['unit', 'unit'],
  ['personnelCategory', 'personnel_category'], ['appointmentType', 'appointment_type'],
  ['appointmentDate', 'appointment_date'], ['nationalIdType', 'national_id_type'],
  ['nationalIdNumber', 'national_id_number'], ['emergencyContact', 'emergency_contact'],
  ['email', 'email'], ['phone', 'phone'], ['staffFileLocation', 'staff_file_location'],
  ['cadre', 'cadre'], ['professionalRank', 'professional_rank'], ['availabilityStatus', 'availability_status'],
];
function cleanVal(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function deriveInitials(first?: string | null, middle?: string | null, surname?: string | null): string | null {
  const letters = [first, middle, surname].map(p => (p ? p.trim()[0] : '')).filter(Boolean).join('').toUpperCase();
  return letters || null;
}
// Build a { column: value } object for INSERT/UPDATE on staff from an API body.
function buildStaffColumns(body: Record<string, unknown>): Record<string, string | number | null> {
  const cols: Record<string, string | number | null> = {};
  for (const [apiKey, col] of STAFF_COLUMN_MAP) {
    if (apiKey in body) cols[col] = cleanVal(body[apiKey]);
  }
  const first = (cols.first_name as string | null) ?? cleanVal(body.firstName);
  const middle = (cols.middle_name as string | null) ?? cleanVal(body.middleName);
  const surname = (cols.surname as string | null) ?? cleanVal(body.surname);
  const composed = [first, middle, surname].filter(Boolean).join(' ');
  const fullName = cleanVal(body.fullName) || composed || null;
  if (fullName) cols.full_name = fullName;
  if (!cols.initials) { const d = deriveInitials(first, middle, surname); if (d) cols.initials = d; }
  // Keep the other branch's `other_names` column in sync with middle names.
  if (middle) cols.other_names = middle;
  if ('sectionId' in body) cols.section_id = idOrNull(body.sectionId);
  if ('isActive' in body) cols.is_active = body.isActive ? 1 : 0;
  return cols;
}

/* ── Automatic unit hierarchy helpers (organogram) ──────────────────────────
 * Cadre and professional rank drive the order of technical staff below a Unit
 * Head; availability drives acting/succession. Cadre/rank are derived from the
 * designation when not explicitly set, so imported registers work out of the box.
 */
const CADRE_LABELS = ['Scientist', 'Technician', 'Assistant'];
function deriveCadre(explicit?: unknown, designation?: unknown, jobTitle?: unknown): string {
  const e = cleanVal(explicit);
  if (e) { const m = CADRE_LABELS.find(c => c.toLowerCase() === e.toLowerCase()); if (m) return m; if (/scien/i.test(e)) return 'Scientist'; if (/tech/i.test(e)) return 'Technician'; if (/assist/i.test(e)) return 'Assistant'; }
  const t = `${designation ?? ''} ${jobTitle ?? ''}`.toLowerCase();
  if (/scientist/.test(t)) return 'Scientist';
  if (/technician|technologist|technical officer|\btech\b/.test(t)) return 'Technician';
  if (/assistant|aide|attendant|orderly|phlebotom/.test(t)) return 'Assistant';
  return 'Other';
}
const CADRE_SORT: Record<string, number> = { scientist: 0, technician: 1, assistant: 2, other: 3 };
function cadreSort(cadre: string): number { return CADRE_SORT[cadre.toLowerCase()] ?? 3; }
function rankOrderFor(staff: { professional_rank?: unknown; designation?: unknown }, ranks: Array<{ name: string; sort_order: number }>): number {
  const explicit = cleanVal(staff.professional_rank);
  if (explicit) { const m = ranks.find(r => r.name.toLowerCase() === explicit.toLowerCase()); if (m) return m.sort_order; }
  const desig = String(staff.designation ?? '').toLowerCase();
  let best = 1000;
  for (const r of ranks) { if (desig.includes(r.name.toLowerCase())) best = Math.min(best, r.sort_order); }
  return best;
}
const SECTION_SYNONYMS: Record<string, string[]> = {
  biochemistry: ['clinical chemistry', 'chemical pathology', 'chemistry'],
  haematology: ['hematology'],
  microbiology: ['micro'],
  'blood bank': ['transfusion', 'immunohaematology', 'immunohematology'],
};
function sectionForUnitHead(title: string, sections: Array<{ id: number; name: string }>): number | null {
  const t = title.toLowerCase();
  let best: number | null = null, bestLen = 0;
  for (const s of sections) {
    const names = [s.name.toLowerCase(), ...(SECTION_SYNONYMS[s.name.toLowerCase()] ?? [])];
    for (const n of names) if (t.includes(n) && n.length > bestLen) { best = s.id; bestLen = n.length; }
  }
  return best;
}
const AVAILABLE = (a?: unknown) => !a || String(a).toLowerCase() === 'available';

export function commonRoutes() {
  const router = Router();
  router.use(requireAuth);

  router.get('/dashboard', (_req, res) => {
    const db = getDb();
    res.json({
      documents: db.prepare('SELECT COUNT(*) count FROM documents').get(),
      actionsOpen: db.prepare("SELECT COUNT(*) count FROM actions WHERE status != 'closed'").get(),
      staff: db.prepare('SELECT COUNT(*) count FROM staff').get(),
      equipmentItems: db.prepare('SELECT COUNT(*) count FROM equipment_items').get(),
      inventoryItems: db.prepare('SELECT COUNT(*) count FROM inventory_items').get(),
      monitoringRecords: db.prepare('SELECT COUNT(*) count FROM monitoring_records').get(),
      safetyIncidents: db.prepare('SELECT COUNT(*) count FROM safety_incidents').get(),
      modulesEnabled: db.prepare('SELECT COUNT(*) count FROM system_modules WHERE enabled = 1').get(),
      latestBackup: db.prepare('SELECT file_name FROM backup_logs ORDER BY id DESC LIMIT 1').get()
    });
  });
  router.get('/dashboard/operations-summary', (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const expiringSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      equipmentTotal: count('SELECT COUNT(*) count FROM equipment_items'),
      equipmentMaintenanceDue: count('SELECT COUNT(*) count FROM equipment_items WHERE COALESCE(next_maintenance_due, next_service_due) IS NOT NULL AND COALESCE(next_maintenance_due, next_service_due) <= ?', now),
      equipmentCalibrationDue: count('SELECT COUNT(*) count FROM equipment_items WHERE COALESCE(next_calibration_due, calibration_due_date) IS NOT NULL AND COALESCE(next_calibration_due, calibration_due_date) <= ?', now),
      equipmentOutOfService: count("SELECT COUNT(*) count FROM equipment_items WHERE status IN ('out_of_service','under_repair','restricted_use')"),
      inventoryLowStock: count('SELECT COUNT(*) count FROM inventory_items WHERE quantity <= COALESCE(NULLIF(minimum_stock,0), reorder_level, 0)'),
      inventoryExpiringSoon: count('SELECT COUNT(*) count FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date > ? AND expiry_date <= ?', now, expiringSoonCutoff),
      inventoryExpired: count('SELECT COUNT(*) count FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date < ?', now),
      monitoringWarnings: count("SELECT COUNT(*) count FROM monitoring_readings WHERE status = 'warning'"),
      monitoringCritical: count("SELECT COUNT(*) count FROM monitoring_readings WHERE status IN ('critical','out_of_range')"),
      openSafetyIncidents: count("SELECT COUNT(*) count FROM safety_incidents WHERE status != 'closed'")
    });
  });

  // Deprecated: kept for backward compatibility. New code should use the per-module
  // summary endpoints below (/dashboard/iqc-summary etc).
  router.get('/dashboard/technical-quality-summary', (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeIqcMaterials: count('SELECT COUNT(*) count FROM iqc_materials WHERE is_active = 1'),
      iqcFailuresThisMonth: count("SELECT COUNT(*) count FROM iqc_results WHERE status IN ('rejected','warning','out_of_control') AND run_date >= ?", monthStartIso),
      iqcResultsPendingReview: count("SELECT COUNT(*) count FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted'"),
      eqaEventsDue: count('SELECT COUNT(*) count FROM eqa_events WHERE submission_due_date IS NOT NULL AND submitted_date IS NULL AND submission_due_date <= ?', now),
      eqaUnsatisfactoryEvents: count("SELECT COUNT(*) count FROM eqa_events WHERE performance_status IN ('unsatisfactory','poor','fail','failed')"),
      openVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('planned','in_progress')"),
      equipmentVerificationsDue: count("SELECT COUNT(*) count FROM equipment_verifications WHERE status IN ('planned','in_progress')"),
      muRecordsDueForReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status IN ('draft','in_review')")
    });
  });

  router.get('/dashboard/iqc-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeMaterials: count('SELECT COUNT(*) count FROM iqc_materials WHERE is_active = 1'),
      resultsThisMonth: count('SELECT COUNT(*) count FROM iqc_results WHERE run_date >= ?', monthStart.toISOString()),
      failedThisMonth: count("SELECT COUNT(*) count FROM iqc_results WHERE status IN ('rejected','out_of_control','warning') AND run_date >= ?", monthStart.toISOString()),
      resultsPendingReview: count("SELECT COUNT(*) count FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted'"),
      lotChangesThisYear: count('SELECT COUNT(*) count FROM iqc_lot_changes WHERE change_date >= ?', yearStart.toISOString())
    });
  });

  router.get('/dashboard/eqa-summary', (_req, res) => {
    const db = getDb();
    const now = new Date().toISOString();
    const dueSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activePrograms: count('SELECT COUNT(*) count FROM eqa_programs WHERE is_active = 1'),
      openEvents: count('SELECT COUNT(*) count FROM eqa_events WHERE submitted_date IS NULL'),
      eventsDueSoon: count('SELECT COUNT(*) count FROM eqa_events WHERE submitted_date IS NULL AND submission_due_date IS NOT NULL AND submission_due_date <= ? AND submission_due_date >= ?', dueSoonCutoff, now),
      unsatisfactoryEvents: count("SELECT COUNT(*) count FROM eqa_events WHERE performance_status IN ('unsatisfactory','poor','fail','failed')"),
      eventsRequiringCorrectiveAction: count('SELECT COUNT(*) count FROM eqa_events WHERE corrective_action_required = 1')
    });
  });

  router.get('/dashboard/verification-summary', (_req, res) => {
    const db = getDb();
    const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      openMethodVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('planned','in_progress')"),
      completedVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('completed','approved')"),
      pendingApproval: count("SELECT COUNT(*) count FROM method_verifications WHERE status = 'completed' AND approved_by_staff_id IS NULL"),
      equipmentVerificationsThisYear: count('SELECT COUNT(*) count FROM equipment_verifications WHERE verification_date >= ?', yearStart.toISOString()),
      equipmentVerificationsPendingApproval: count("SELECT COUNT(*) count FROM equipment_verifications WHERE status IN ('planned','in_progress','completed') AND approved_by_staff_id IS NULL")
    });
  });

  router.get('/dashboard/measurement-uncertainty-summary', (_req, res) => {
    const db = getDb();
    const yearStart = new Date(); yearStart.setMonth(0, 1); yearStart.setHours(0, 0, 0, 0);
    const dueSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeRecords: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status != 'archived'"),
      recordsPendingReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status = 'draft'"),
      recordsPendingApproval: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status = 'in_review'"),
      recordsDueForReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status IN ('draft','in_review') AND calculation_date <= ?", dueSoonCutoff),
      recordsCompletedThisYear: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status = 'approved' AND calculation_date >= ?", yearStart.toISOString())
    });
  });

  router.get('/dashboard/blood-bank-summary', (_req, res) => {
    const db = getDb();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiringSoonCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      unitsAvailable: count("SELECT COUNT(*) count FROM blood_units WHERE current_status = 'available' AND expiry_date > ?", nowIso),
      unitsExpiringSoon: count("SELECT COUNT(*) count FROM blood_units WHERE current_status = 'available' AND expiry_date > ? AND expiry_date <= ?", nowIso, expiringSoonCutoff),
      unitsExpired: count("SELECT COUNT(*) count FROM blood_units WHERE expiry_date < ? AND current_status NOT IN ('discarded','transfused')", nowIso),
      pendingHandovers: count("SELECT COUNT(*) count FROM blood_bank_handovers WHERE status NOT IN ('closed','reviewed')"),
      openAdverseEvents: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE status != 'closed'"),
      discardsThisMonth: count('SELECT COUNT(*) count FROM blood_discards WHERE discard_date BETWEEN ? AND ?', monthStart, monthEnd),
      donorReactionsThisMonth: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE event_type = 'donor_reaction' AND event_date BETWEEN ? AND ?", monthStart, monthEnd),
      transfusionReactionsThisMonth: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE event_type IN ('transfusion_reaction','transfusion_incident') AND event_date BETWEEN ? AND ?", monthStart, monthEnd),
      ncCapaLinkedRecords: count("SELECT COUNT(*) count FROM blood_adverse_events WHERE nc_id IS NOT NULL OR capa_id IS NOT NULL") + count("SELECT COUNT(*) count FROM blood_discards WHERE nc_id IS NOT NULL OR capa_id IS NOT NULL")
    });
  });

  router.get('/dashboard/monthly-reports-summary', (_req, res) => {
    const db = getDb();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const avgRow = db.prepare("SELECT AVG(CASE WHEN tat_minutes IS NOT NULL AND tat_minutes >= 0 THEN tat_minutes END) AS avg FROM tat_records").get() as { avg: number | null };
    res.json({
      importsThisMonth: count('SELECT COUNT(*) count FROM lhims_import_batches WHERE created_at >= ?', monthStart),
      unprocessedImports: count("SELECT COUNT(*) count FROM lhims_import_batches WHERE status IN ('pending','processing','failed')"),
      unresolvedExceptions: count("SELECT COUNT(*) count FROM monthly_report_exceptions WHERE status = 'open'"),
      draftReports: count("SELECT COUNT(*) count FROM monthly_report_batches WHERE status = 'draft'"),
      approvedReportsThisMonth: count("SELECT COUNT(*) count FROM monthly_report_batches WHERE status IN ('approved','exported','archived') AND approved_at >= ?", monthStart),
      delayedTatRecords: count("SELECT COUNT(*) count FROM tat_records WHERE status = 'delayed'"),
      averageTatMinutes: avgRow.avg !== null && avgRow.avg !== undefined ? Math.round(avgRow.avg) : null
    });
  });

  router.get('/dashboard/document-control-summary', (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const dueCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      currentDocuments: count("SELECT COUNT(*) count FROM documents WHERE status IN ('current','approved')"),
      drafts: count("SELECT COUNT(*) count FROM documents WHERE status = 'draft'"),
      dueReviews: count("SELECT COUNT(*) count FROM documents WHERE next_review_date IS NOT NULL AND next_review_date <= ? AND next_review_date >= ? AND status != 'obsolete'", dueCutoff, todayIso),
      overdueReviews: count("SELECT COUNT(*) count FROM documents WHERE next_review_date IS NOT NULL AND next_review_date < ? AND status != 'obsolete'", todayIso),
      pendingAttestations: count("SELECT COUNT(*) count FROM document_attestations WHERE status IN ('pending','overdue')"),
      obsoleteDocuments: count("SELECT COUNT(*) count FROM documents WHERE status = 'obsolete'")
    });
  });

  router.get('/dashboard/personnel-summary', (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const expiryCutoff = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      staffDocumentsPendingVerification: count("SELECT COUNT(*) count FROM staff_documents WHERE verification_status = 'pending'"),
      certificatesExpiringSoon: count("SELECT COUNT(*) count FROM staff_documents WHERE expiry_date IS NOT NULL AND expiry_date <= ? AND expiry_date >= ?", expiryCutoff, todayIso),
      pendingDeclarations: count("SELECT COUNT(*) count FROM staff_declarations WHERE status = 'pending'"),
      plannedTrainingEvents: count("SELECT COUNT(*) count FROM training_events WHERE status = 'planned'"),
      competencyAssessmentsDue: count("SELECT COUNT(*) count FROM competency_assessments WHERE next_assessment_due IS NOT NULL AND next_assessment_due <= ?", expiryCutoff),
      authorizationsDueReview: count("SELECT COUNT(*) count FROM technical_authorizations WHERE expires_at IS NOT NULL AND expires_at <= ? AND is_active = 1", expiryCutoff),
      rostersThisMonth: count("SELECT COUNT(*) count FROM duty_rosters WHERE roster_start_date <= ? AND roster_end_date >= ?", monthEnd, monthStart),
      totalStaff: count("SELECT COUNT(*) count FROM staff WHERE is_active = 1"),
      licencesExpiringSoon: count("SELECT COUNT(*) count FROM staff WHERE licence_expiry_date IS NOT NULL AND licence_expiry_date <= ? AND licence_expiry_date >= ?", expiryCutoff, todayIso),
      orientationsInProgress: count("SELECT COUNT(*) count FROM staff_orientations WHERE orientation_complete = 0 AND status != 'cancelled'"),
      ethicsReviewsDue: count("SELECT COUNT(*) count FROM staff_declarations WHERE next_review_date IS NOT NULL AND next_review_date <= ?", expiryCutoff)
    });
  });

  router.get('/dashboard/customer-focus-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const todayIso = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeStakeholders: count('SELECT COUNT(*) count FROM customer_stakeholders WHERE is_active = 1'),
      activeServiceAgreements: count("SELECT COUNT(*) count FROM service_agreements WHERE status = 'active'"),
      feedbackThisMonth: count('SELECT COUNT(*) count FROM customer_feedback WHERE feedback_date >= ?', monthStart),
      openFeedback: count("SELECT COUNT(*) count FROM customer_feedback WHERE status NOT IN ('resolved','closed')"),
      highUrgencyFeedback: count("SELECT COUNT(*) count FROM customer_feedback WHERE urgency IN ('high','critical') AND status NOT IN ('resolved','closed')"),
      activeSurveys: count("SELECT COUNT(*) count FROM satisfaction_surveys WHERE status = 'active'"),
      surveyResponsesThisMonth: count('SELECT COUNT(*) count FROM satisfaction_survey_responses WHERE response_date >= ?', monthStart),
      followUpsDue: count("SELECT COUNT(*) count FROM customer_feedback WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status NOT IN ('resolved','closed')", todayIso)
        + count("SELECT COUNT(*) count FROM customer_communication_logs WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status != 'closed'", todayIso)
    });
  });

  router.get('/dashboard/notifications-summary', (req, res) => {
    // Reuse the central summary computation to keep numbers identical.
    // Defer the import to avoid a circular module load.
    import('./notifications.js').then(m => res.json(m.computeSummary(req))).catch(e => res.status(500).json({ error: (e as Error).message }));
  });

  router.get('/dashboard/records-reports-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeReportTemplates: count("SELECT COUNT(*) count FROM report_templates WHERE is_active = 1"),
      reportsGeneratedThisMonth: count("SELECT COUNT(*) count FROM report_requests WHERE created_at >= ? AND status IN ('generated','reviewed','approved','archived')", monthStart),
      openEvidencePacks: count("SELECT COUNT(*) count FROM evidence_packs WHERE status NOT IN ('approved','archived')"),
      pendingApprovals: count("SELECT COUNT(*) count FROM report_requests WHERE status = 'reviewed'") + count("SELECT COUNT(*) count FROM evidence_packs WHERE status = 'reviewed'"),
      printJobsThisMonth: count("SELECT COUNT(*) count FROM print_jobs WHERE created_at >= ?", monthStart),
      retentionReviewsDue: count("SELECT COUNT(*) count FROM record_retention_reviews WHERE status = 'draft'"),
      backupChecksThisMonth: count("SELECT COUNT(*) count FROM backup_restore_checks WHERE created_at >= ?", monthStart),
      openIntegrityIssues: count("SELECT COUNT(*) count FROM data_integrity_checks WHERE status IN ('issues_found','action_required')")
    });
  });

  router.get('/dashboard/poct-summary', (_req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeSites: count("SELECT COUNT(*) count FROM poct_sites WHERE status = 'active'"),
      activeDevices: count("SELECT COUNT(*) count FROM poct_devices WHERE status = 'active'"),
      authorizedOperators: count("SELECT COUNT(DISTINCT staff_id) count FROM poct_operator_authorizations WHERE status = 'active' AND (expiry_date IS NULL OR expiry_date >= ?)", today),
      expiredAuthorizations: count("SELECT COUNT(*) count FROM poct_operator_authorizations WHERE expiry_date IS NOT NULL AND expiry_date < ? AND status NOT IN ('revoked')", today),
      qcFailuresThisMonth: count("SELECT COUNT(*) count FROM poct_qc_results WHERE status IN ('failed','warning') AND qc_date >= ?", monthStart),
      unsatisfactoryEqaEvents: count("SELECT COUNT(*) count FROM poct_eqa_events WHERE performance_status = 'unsatisfactory'"),
      openIncidents: count("SELECT COUNT(*) count FROM poct_incidents WHERE status != 'closed'"),
      maintenanceDue: count("SELECT COUNT(*) count FROM poct_devices WHERE next_service_due IS NOT NULL AND next_service_due <= ?", today)
    });
  });

  router.get('/dashboard/information-management-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeInformationAssets: count("SELECT COUNT(*) count FROM information_assets WHERE status = 'active'"),
      activeSystems: count("SELECT COUNT(*) count FROM information_systems WHERE status = 'active'"),
      openAccessReviews: count("SELECT COUNT(*) count FROM system_access_reviews WHERE status IN ('draft','action_required')"),
      openSecurityIncidents: count("SELECT COUNT(*) count FROM information_security_incidents WHERE status NOT IN ('closed')"),
      pendingDataCorrections: count("SELECT COUNT(*) count FROM data_correction_requests WHERE status IN ('submitted','reviewed','approved')"),
      openChangeRequests: count("SELECT COUNT(*) count FROM system_change_requests WHERE status NOT IN ('closed','rejected','validated')"),
      validationsPendingApproval: count("SELECT COUNT(*) count FROM system_validation_records WHERE status = 'completed'"),
      downtimeRecordsThisMonth: count("SELECT COUNT(*) count FROM system_downtime_records WHERE downtime_start >= ?", monthStart),
      pendingInformationReviews: count("SELECT COUNT(*) count FROM information_management_reviews WHERE status IN ('draft','reviewed')")
    });
  });

  router.get('/dashboard/process-management-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      activeTests: count("SELECT COUNT(*) count FROM lab_test_catalog WHERE status = 'active'"),
      activeAcceptanceCriteria: count("SELECT COUNT(*) count FROM specimen_acceptance_criteria WHERE is_active = 1"),
      specimenRejectionsThisMonth: count("SELECT COUNT(*) count FROM specimen_rejection_records WHERE rejection_date >= ?", monthStart),
      openSpecimenRejections: count("SELECT COUNT(*) count FROM specimen_rejection_records WHERE status NOT IN ('closed','linked_to_nc')"),
      criticalResultsThisMonth: count("SELECT COUNT(*) count FROM critical_result_notifications WHERE event_date >= ?", monthStart),
      delayedCriticalNotifications: count("SELECT COUNT(*) count FROM critical_result_notifications WHERE escalation_required = 1 AND status NOT IN ('closed')"),
      referralSendoutsPending: count("SELECT COUNT(*) count FROM referral_sendouts WHERE status IN ('sent','pending_result')"),
      delayedReferralSendouts: count("SELECT COUNT(*) count FROM referral_sendouts WHERE expected_return_date IS NOT NULL AND expected_return_date < ? AND result_received_date IS NULL AND status NOT IN ('closed','result_received')", today),
      reportAmendmentsThisMonth: count("SELECT COUNT(*) count FROM report_amendment_logs WHERE amendment_date >= ?", monthStart),
      pendingProcessReviews: count("SELECT COUNT(*) count FROM process_review_records WHERE status IN ('draft','reviewed')")
    });
  });

  router.get('/dashboard/governance-summary', (_req, res) => {
    const db = getDb();
    const todayIso = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    res.json({
      plannedAssessments: count("SELECT COUNT(*) count FROM assessment_programs WHERE status IN ('planned','in_progress')"),
      openFindings: count("SELECT COUNT(*) count FROM assessment_findings WHERE status != 'closed'"),
      openMeetings: count("SELECT COUNT(*) count FROM meetings WHERE status IN ('scheduled','completed')"),
      pendingManagementReviews: count("SELECT COUNT(*) count FROM management_reviews WHERE status IN ('draft','inputs_collected','reviewed')"),
      activeQualityIndicators: count("SELECT COUNT(*) count FROM quality_indicators WHERE is_active = 1"),
      criticalQualityIndicatorResults: count("SELECT COUNT(*) count FROM quality_indicator_results WHERE status = 'critical' AND (reviewed_at IS NULL OR nc_id IS NULL)"),
      activeImprovementProjects: count("SELECT COUNT(*) count FROM improvement_projects WHERE status IN ('planned','active')"),
      overdueImprovementActions: count("SELECT COUNT(*) count FROM actions WHERE module_key = 'continual_improvement' AND status != 'Closed' AND due_date IS NOT NULL AND due_date < ?", todayIso)
    });
  });

  router.get('/dashboard/qms-summary', (_req, res) => {
    const db = getDb();
    const staffId = _req.user?.staffId ?? null;
    const myAssignedActions = staffId
      ? db.prepare('SELECT COUNT(*) count FROM actions WHERE assigned_to_staff_id = ? AND status != ?').get(staffId, 'Closed')
      : { count: 0 };
    res.json({
      openNCs: db.prepare("SELECT COUNT(*) count FROM nonconforming_events WHERE status != 'closed'").get(),
      openCAPAs: db.prepare("SELECT COUNT(*) count FROM capa_records WHERE status != 'closed'").get(),
      pendingComplaints: db.prepare("SELECT COUNT(*) count FROM complaints WHERE status != 'closed'").get(),
      highRisks: db.prepare("SELECT COUNT(*) count FROM risks WHERE risk_level IN ('High','Critical') AND status != 'closed'").get(),
      myAssignedActions,
      overdueActions: db.prepare('SELECT COUNT(*) count FROM actions WHERE due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?').get('Closed')
    });
  });

  router.get('/roles', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name, description, is_system isSystem FROM roles ORDER BY name').all()));
  router.get('/users', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, u.staff_id staffId, s.full_name staffName, r.name roleName, u.is_active isActive FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id ORDER BY u.full_name').all()));
  router.post('/users', requirePermission('settings', 'create'), (req, res) => {
    const { username, password, fullName, roleId } = req.body;
    const db = getDb();
    const staffId = idOrNull(req.body.staffId);
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'A username is required.' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'A password of at least 8 characters is required.' });
    if (!roleId) return res.status(400).json({ error: 'A role is required.' });
    if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username)) return res.status(400).json({ error: 'That username is already in use.' });
    if (staffId && db.prepare('SELECT id, username FROM users WHERE staff_id = ?').get(staffId)) return res.status(400).json({ error: 'That staff record is already linked to another user.' });
    const oldValue = null;
    const result = db.prepare('INSERT INTO users (username, password_hash, full_name, role_id, staff_id) VALUES (?, ?, ?, ?, ?)').run(username, bcrypt.hashSync(password, 12), fullName, Number(roleId), staffId);
    audit(req, { action: 'create', entity: 'users', entityId: result.lastInsertRowid, oldValue, newValue: { username, fullName, roleId, staffId } });
    res.status(201).json({ id: result.lastInsertRowid });
  });
  router.put('/users/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const sid = idOrNull(req.body.staffId);
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'User not found' });
    if (sid) {
      if (!db.prepare('SELECT id FROM staff WHERE id = ?').get(sid)) return res.status(400).json({ error: 'Staff record not found.' });
      const taken = db.prepare('SELECT id, username FROM users WHERE staff_id = ? AND id != ?').get(sid, req.params.id) as { username: string } | undefined;
      if (taken) return res.status(400).json({ error: `That staff record is already linked to user “${taken.username}”. Unlink it first.` });
    }
    const oldValue = db.prepare('SELECT staff_id staffId FROM users WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE users SET staff_id = ? WHERE id = ?').run(sid, req.params.id);
    audit(req, { action: 'link_staff', entity: 'users', entityId: req.params.id, oldValue, newValue: { staffId: sid } });
    res.json({ ok: true });
  });

  router.get('/positions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, title, description, reports_to_position_id reportsToPositionId, is_active isActive, archived_at archivedAt FROM positions ORDER BY is_active DESC, title').all()));
  router.post('/positions', requirePermission('settings', 'create'), (req, res) => {
    const { title, description, reportsToPositionId } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'A position title is required.' });
    try {
      const result = getDb().prepare('INSERT INTO positions (title, description, reports_to_position_id, is_active) VALUES (?, ?, ?, 1)').run(String(title).trim(), description ?? null, idOrNull(reportsToPositionId));
      audit(req, { action: 'create', entity: 'positions', entityId: result.lastInsertRowid, newValue: req.body });
      res.status(201).json({ id: result.lastInsertRowid });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error && /UNIQUE/.test(err.message) ? 'A position with that title already exists.' : (err instanceof Error ? err.message : 'Failed to create position.') });
    }
  });
  // Partial update: only the supplied fields change, so editing just the status or
  // just the reporting line never wipes the others.
  router.put('/positions/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Position not found' });
    const title = req.body.title !== undefined ? String(req.body.title).trim() : oldValue.title;
    if (!title) return res.status(400).json({ error: 'A position title is required.' });
    const description = req.body.description !== undefined ? (req.body.description || null) : oldValue.description;
    const reportsTo = req.body.reportsToPositionId !== undefined ? idOrNull(req.body.reportsToPositionId) : oldValue.reports_to_position_id;
    const isActive = req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active;
    if (idOrNull(reportsTo) === Number(req.params.id)) return res.status(400).json({ error: 'A position cannot report to itself.' });
    try {
      db.prepare('UPDATE positions SET title = ?, description = ?, reports_to_position_id = ?, is_active = ?, archived_at = CASE WHEN ? = 0 THEN COALESCE(archived_at, CURRENT_TIMESTAMP) ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(title, description, reportsTo, isActive, isActive, req.params.id);
      audit(req, { action: 'edit', entity: 'positions', entityId: req.params.id, oldValue, newValue: req.body });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error && /UNIQUE/.test(err.message) ? 'A position with that title already exists.' : (err instanceof Error ? err.message : 'Failed to update position.') });
    }
  });
  router.delete('/positions/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const used = db.prepare('SELECT COUNT(*) count FROM staff_position_assignments WHERE position_id = ?').get(req.params.id) as { count: number };
    const children = db.prepare('SELECT COUNT(*) count FROM positions WHERE reports_to_position_id = ?').get(req.params.id) as { count: number };
    if (used.count > 0 || children.count > 0) db.prepare('UPDATE positions SET is_active = 0, archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    else db.prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
    audit(req, { action: used.count > 0 || children.count > 0 ? 'archive' : 'delete', entity: 'positions', entityId: req.params.id });
    res.json({ ok: true, archived: used.count > 0 || children.count > 0 });
  });

  // =====================================================================
  // Organogram
  // ---------------------------------------------------------------------
  // The laboratory reporting structure. Nodes are positions; edges are the
  // reports-to relationships. Each node carries its current occupant(s)
  // (active staff assignments), so the chart doubles as a live "who holds
  // which role" view. Edits here write straight to positions and
  // staff_position_assignments, so they reflect in Positions & Organogram,
  // the Permission Matrix (position permissions) and Personnel.
  // =====================================================================
  // Flat position list (+ occupants) — kept for the editor's "reports to" options
  // and any callers that still expect the legacy flat shape.
  router.get('/organogram', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    const positions = db.prepare(`
      SELECT p.id, p.title, p.description, p.reports_to_position_id AS reportsToPositionId, p.is_active AS isActive
      FROM positions p ORDER BY p.is_active DESC, p.title`).all() as any[];
    const occupants = db.prepare(`
      SELECT spa.position_id AS positionId, spa.staff_id AS staffId, s.full_name AS staffName, spa.assignment_type AS assignmentType, spa.is_active AS isActive
      FROM staff_position_assignments spa JOIN staff s ON s.id = spa.staff_id
      WHERE spa.is_active = 1 ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 WHEN 'deputy' THEN 1 ELSE 2 END, s.full_name`).all() as any[];
    const byPosition = new Map<number, any[]>();
    for (const o of occupants) { if (!byPosition.has(o.positionId)) byPosition.set(o.positionId, []); byPosition.get(o.positionId)!.push(o); }
    res.json(positions.map(p => ({ ...p, occupants: byPosition.get(p.id) ?? [] })));
  });

  // Computed organogram TREE: manual position nodes (Laboratory Manager →
  // appointed administrative roles + Unit Heads) plus, under each Unit Head, an
  // AUTOMATIC vertical chain of that unit's technical staff ordered by cadre
  // (Scientist → Technician → Assistant) then professional rank, with
  // deputy/succession and acting-when-absent logic.
  router.get('/organogram/tree', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    const positions = db.prepare('SELECT id, title, reports_to_position_id AS reportsTo, is_active AS isActive FROM positions').all() as any[];
    const occ = db.prepare(`SELECT spa.position_id AS pid, spa.staff_id AS sid, s.full_name AS name, spa.assignment_type AS type
      FROM staff_position_assignments spa JOIN staff s ON s.id = spa.staff_id WHERE spa.is_active = 1`).all() as any[];
    const holderOf = new Map<number, any>(); const deputyOf = new Map<number, any>();
    for (const o of occ) { if (o.type === 'primary' && !holderOf.has(o.pid)) holderOf.set(o.pid, o); if (o.type === 'deputy' && !deputyOf.has(o.pid)) deputyOf.set(o.pid, o); }
    const sections = db.prepare('SELECT id, name FROM sections').all() as Array<{ id: number; name: string }>;
    const ranks = db.prepare('SELECT name, sort_order FROM professional_ranks WHERE is_active = 1 ORDER BY sort_order').all() as Array<{ name: string; sort_order: number }>;
    const staff = db.prepare(`SELECT id, full_name AS name, section_id AS sectionId, designation, job_title AS jobTitle,
      cadre, professional_rank, availability_status AS availability FROM staff WHERE is_active = 1`).all() as any[];

    const isUnitHead = (title: string) => /unit head|head of|head,|hod\b/i.test(title);
    const roleType = (title: string): string => {
      const t = title.toLowerCase();
      if (/quality/.test(t)) return 'quality';
      if (/laboratory manager|laboratory director|lab manager|^director|superintend/.test(t)) return 'management';
      if (isUnitHead(t) || /scientist|technologist|technician|technical officer|biomedical|assistant/.test(t)) return 'technical';
      return 'support';
    };

    // Build the auto staff chain for a unit head position.
    function staffChain(positionId: number, sectionId: number | null): any[] {
      if (!sectionId) return [];
      const headIds = new Set<number>();
      const h = holderOf.get(positionId); if (h) headIds.add(h.sid);
      const d = deputyOf.get(positionId); if (d) headIds.add(d.sid);
      const members = staff.filter(s => s.sectionId === sectionId && !headIds.has(s.id)).map(s => {
        const cadre = deriveCadre(s.cadre, s.designation, s.jobTitle);
        return { ...s, cadre, _cadre: cadreSort(cadre), _rank: rankOrderFor(s, ranks) };
      }).sort((a, b) => a._cadre - b._cadre || a._rank - b._rank || String(a.name).localeCompare(b.name));
      // Chain vertically: each member's child is the next member (succession).
      const nodes = members.map((m, i) => ({
        key: `s${m.id}`, kind: 'staff', staffId: m.id, title: m.designation || m.jobTitle || m.cadre || 'Staff',
        staffName: m.name, cadre: m.cadre, rank: cleanVal(m.professional_rank) || null, availability: m.availability || 'available',
        nextInCommand: members[i + 1]?.name ?? null, roleType: 'technical', isActive: 1, children: [] as any[],
      }));
      for (let i = nodes.length - 1; i > 0; i--) nodes[i - 1].children.push(nodes[i]);
      return nodes.length ? [nodes[0]] : [];
    }

    const childPositions = (pid: number | null) => positions
      .filter(p => (pid === null ? (p.reportsTo == null || !positions.some(x => x.id === p.reportsTo)) : p.reportsTo === pid))
      .sort((a, b) => a.title.localeCompare(b.title));

    function buildPosition(p: any): any {
      const head = holderOf.get(p.id); const dep = deputyOf.get(p.id);
      const unitHead = isUnitHead(p.title);
      const sectionId = unitHead ? sectionForUnitHead(p.title, sections) : null;
      const children: any[] = unitHead ? staffChain(p.id, sectionId) : childPositions(p.id).map(buildPosition);
      // Next-in-command for the unit head = first member of the auto chain;
      // acting = first AVAILABLE member.
      let nextInCommand: string | null = dep?.name ?? null;
      if (unitHead && children.length) {
        const chain: any[] = []; let cur: any = children[0]; while (cur) { chain.push(cur); cur = cur.children[0]; }
        nextInCommand = chain[0]?.staffName ?? null;
        const acting = chain.find(n => AVAILABLE(n.availability));
        return { key: `p${p.id}`, kind: 'position', positionId: p.id, title: p.title, holderName: head?.name ?? null,
          vacant: !head, deputyName: nextInCommand, actingName: acting?.staffName ?? null, unitHead: true,
          roleType: roleType(p.title), isActive: p.isActive, children };
      }
      return { key: `p${p.id}`, kind: 'position', positionId: p.id, title: p.title, holderName: head?.name ?? null,
        vacant: !head, deputyName: nextInCommand, unitHead, roleType: roleType(p.title), isActive: p.isActive, children };
    }

    const roots = childPositions(null).map(buildPosition);
    res.json({ roots });
  });

  // Assign a staff member to a position.
  //  - 'primary' (the holder): one per position; any current holder is moved to secondary.
  //  - 'deputy'  (the designated deputy / acting officer for continuity):
  //              one per position; any current deputy is moved to secondary.
  //  - 'secondary': an additional non-primary assignment.
  router.post('/positions/:id/occupant', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const positionId = idOrNull(req.params.id);
    const staffId = idOrNull(req.body.staffId);
    if (!positionId || !db.prepare('SELECT id FROM positions WHERE id = ?').get(positionId)) return res.status(404).json({ error: 'Position not found' });
    if (!staffId || !db.prepare('SELECT id FROM staff WHERE id = ?').get(staffId)) return res.status(400).json({ error: 'Select a valid staff member.' });
    const assignmentType = ['primary', 'deputy', 'secondary'].includes(req.body.assignmentType) ? req.body.assignmentType : 'primary';
    try {
      db.transaction(() => {
        if (assignmentType === 'primary' || assignmentType === 'deputy') {
          db.prepare('UPDATE staff_position_assignments SET assignment_type = ? WHERE position_id = ? AND is_active = 1 AND assignment_type = ?').run('secondary', positionId, assignmentType);
        }
        const existing = db.prepare('SELECT id FROM staff_position_assignments WHERE position_id = ? AND staff_id = ? AND is_active = 1').get(positionId, staffId) as any;
        if (existing) db.prepare('UPDATE staff_position_assignments SET assignment_type = ? WHERE id = ?').run(assignmentType, existing.id);
        else db.prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)').run(staffId, positionId, assignmentType);
      })();
      audit(req, { action: 'assign_occupant', entity: 'positions', entityId: positionId, newValue: { staffId, assignmentType } });
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to assign occupant.' });
    }
  });
  router.delete('/positions/:id/occupant/:staffId', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    db.prepare('UPDATE staff_position_assignments SET is_active = 0, ends_at = CURRENT_TIMESTAMP WHERE position_id = ? AND staff_id = ? AND is_active = 1').run(req.params.id, req.params.staffId);
    audit(req, { action: 'remove_occupant', entity: 'positions', entityId: req.params.id, newValue: { staffId: req.params.staffId } });
    res.json({ ok: true });
  });

  // Apply a standard medical-laboratory reporting structure to existing positions by
  // recognised title, without overwriting reporting lines that are already set. This
  // gives an instant, sensible organogram that the user can then fine-tune.
  router.post('/organogram/apply-standard', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const structure: Record<string, string> = {
      'Quality Manager': 'Laboratory Manager',
      'Safety Manager': 'Laboratory Manager',
      'Customer Service Officer': 'Laboratory Manager',
      'Haematology Unit Head': 'Laboratory Manager',
      'Biochemistry Unit Head': 'Laboratory Manager',
      'Microbiology Unit Head': 'Laboratory Manager',
      'Blood Bank Unit Head': 'Laboratory Manager',
      'Data Officer': 'Laboratory Manager',
      'Stores Officer': 'Laboratory Manager',
      'POCT Officer': 'Quality Manager',
      'Quality Team Member': 'Quality Manager',
      'Biomedical Scientist': 'Haematology Unit Head',
      'Technician': 'Biomedical Scientist',
    };
    const idByTitle = new Map<string, number>();
    for (const p of db.prepare('SELECT id, title FROM positions').all() as any[]) idByTitle.set(p.title, p.id);
    const force = req.body?.force === true;
    let updated = 0;
    const tx = db.transaction(() => {
      for (const [childTitle, parentTitle] of Object.entries(structure)) {
        const childId = idByTitle.get(childTitle); const parentId = idByTitle.get(parentTitle);
        if (!childId || !parentId || childId === parentId) continue;
        const current = db.prepare('SELECT reports_to_position_id AS r FROM positions WHERE id = ?').get(childId) as any;
        if (!force && current?.r != null) continue;
        db.prepare('UPDATE positions SET reports_to_position_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parentId, childId);
        updated++;
      }
    });
    tx();
    audit(req, { action: 'apply_standard', entity: 'positions', newValue: { updated, force } });
    res.json({ ok: true, updated });
  });

  // Configurable professional rank order (drives the automatic within-cadre
  // ordering of staff on the organogram). Lower sort_order = higher rank.
  router.get('/professional-ranks', requirePermission('settings', 'view'), (_req, res) =>
    res.json(getDb().prepare('SELECT id, name, sort_order AS sortOrder, is_active AS isActive FROM professional_ranks ORDER BY sort_order, name').all()));
  router.post('/professional-ranks', requirePermission('settings', 'create'), (req, res) => {
    const name = cleanVal(req.body.name);
    if (!name) return res.status(400).json({ error: 'A rank name is required.' });
    const db = getDb();
    if (db.prepare('SELECT id FROM professional_ranks WHERE name = ? COLLATE NOCASE').get(name)) return res.status(400).json({ error: 'That rank already exists.' });
    const max = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM professional_ranks').get() as { m: number }).m;
    const r = db.prepare('INSERT INTO professional_ranks (name, sort_order) VALUES (?, ?)').run(name, req.body.sortOrder != null ? Number(req.body.sortOrder) : max + 10);
    audit(req, { action: 'create', entity: 'professional_ranks', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/professional-ranks/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM professional_ranks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rank not found' });
    const sets: string[] = []; const vals: unknown[] = [];
    if ('name' in req.body && cleanVal(req.body.name)) { sets.push('name = ?'); vals.push(cleanVal(req.body.name)); }
    if ('sortOrder' in req.body) { sets.push('sort_order = ?'); vals.push(Number(req.body.sortOrder)); }
    if ('isActive' in req.body) { sets.push('is_active = ?'); vals.push(req.body.isActive ? 1 : 0); }
    if (sets.length) db.prepare(`UPDATE professional_ranks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    audit(req, { action: 'edit', entity: 'professional_ranks', entityId: Number(req.params.id), oldValue: existing, newValue: req.body });
    res.json({ ok: true });
  });
  router.delete('/professional-ranks/:id', requirePermission('settings', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM professional_ranks WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'professional_ranks', entityId: Number(req.params.id) });
    res.json({ ok: true });
  });

  router.get('/departments', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name, is_active FROM departments ORDER BY name').all()));
  router.post('/departments', requirePermission('settings', 'create'), (req, res) => {
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'A department name is required.' });
    try {
      const r = getDb().prepare('INSERT INTO departments (name) VALUES (?)').run(String(req.body.name).trim());
      audit(req, { action: 'create', entity: 'departments', entityId: Number(r.lastInsertRowid), newValue: req.body });
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ error: err instanceof Error && /UNIQUE/.test(err.message) ? 'A department with that name already exists.' : 'Failed to create department.' }); }
  });
  router.put('/departments/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
    if (!old) return res.status(404).json({ error: 'Department not found' });
    db.prepare('UPDATE departments SET name = COALESCE(?, name), is_active = ? WHERE id = ?').run(req.body.name ? String(req.body.name).trim() : null, req.body.isActive === false ? 0 : 1, req.params.id);
    audit(req, { action: 'edit', entity: 'departments', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  // ===== My Laboratory — laboratory profile / identity =====
  router.get('/laboratory-profile', requirePermission('settings', 'view'), (_req, res) => {
    const row = getDb().prepare('SELECT * FROM laboratory_profile WHERE id = 1').get();
    res.json(row ?? null);
  });
  router.put('/laboratory-profile', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const b = req.body ?? {};
    const old = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() as any;
    if (!old) {
      if (!b.facilityName) return res.status(400).json({ error: 'Facility name is required.' });
      db.prepare('INSERT INTO laboratory_profile (id, facility_name, short_name) VALUES (1, ?, ?)').run(String(b.facilityName), b.shortName ?? null);
    }
    const fields: Array<[string, string]> = [
      ['facility_name', 'facilityName'], ['short_name', 'shortName'], ['address', 'address'], ['city', 'city'],
      ['country', 'country'], ['phone', 'phone'], ['email', 'email'], ['website', 'website'],
      ['registration_number', 'registrationNumber'], ['accreditation_body', 'accreditationBody'],
      ['accreditation_number', 'accreditationNumber'], ['accreditation_status', 'accreditationStatus'], ['motto', 'motto'],
    ];
    for (const [col, key] of fields) {
      if (b[key] !== undefined) db.prepare(`UPDATE laboratory_profile SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(b[key] === '' ? null : b[key]);
    }
    audit(req, { action: 'edit', entity: 'laboratory_profile', entityId: 1, newValue: b });
    res.json({ ok: true });
  });

  router.get('/staff', requirePermission('personnel', 'view'), (_req, res) => res.json(getDb().prepare(`
    SELECT s.id, s.employee_no employeeNo, s.full_name fullName, s.email, s.phone, s.section_id sectionId, sec.name sectionName, s.is_active isActive,
      s.surname, s.middle_name middleName, s.first_name firstName, s.initials, s.date_of_birth dateOfBirth, s.gender,
      s.designation, s.job_title jobTitle, s.professional_regulator professionalRegulator, s.professional_licence professionalLicence,
      s.licence_expiry_date licenceExpiryDate, s.qualifications, s.unit, s.personnel_category personnelCategory,
      s.appointment_type appointmentType, s.appointment_date appointmentDate, s.national_id_type nationalIdType,
      s.national_id_number nationalIdNumber, s.emergency_contact emergencyContact, s.staff_file_location staffFileLocation,
      s.cadre, s.professional_rank professionalRank, s.availability_status availabilityStatus,
      (SELECT p.title FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = s.id AND spa.is_active = 1 ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 ELSE 1 END, spa.id LIMIT 1) primaryPosition,
      u.id userId, u.username, r.name roleName, u.is_active userActive
    FROM staff s
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN users u ON u.staff_id = s.id
    LEFT JOIN roles r ON r.id = u.role_id
    ORDER BY s.is_active DESC, s.full_name`).all()));

  router.post('/staff', requirePermission('personnel', 'create'), (req, res) => {
    const cols = buildStaffColumns(req.body);
    if (!cols.full_name) return res.status(400).json({ error: 'A full name (or first name + surname) is required.' });
    const keys = Object.keys(cols);
    const r = getDb().prepare(`INSERT INTO staff (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => cols[k]));
    if (idOrNull(req.body.positionId)) getDb().prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)').run(r.lastInsertRowid, idOrNull(req.body.positionId), req.body.assignmentType ?? 'primary');
    audit(req, { action: 'create', entity: 'staff', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/staff/:id', requirePermission('personnel', 'edit'), (req, res) => {
    const existing = getDb().prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });
    const cols = buildStaffColumns(req.body);
    const keys = Object.keys(cols);
    if (keys.length) {
      getDb().prepare(`UPDATE staff SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...keys.map(k => cols[k]), req.params.id);
    }
    if (req.body.positionId) {
      const pid = Number(req.body.positionId);
      const has = getDb().prepare("SELECT 1 FROM staff_position_assignments WHERE staff_id = ? AND position_id = ? AND is_active = 1").get(req.params.id, pid);
      if (!has) {
        getDb().prepare("UPDATE staff_position_assignments SET is_active = 0, ends_at = CURRENT_TIMESTAMP WHERE staff_id = ? AND assignment_type = 'primary' AND is_active = 1").run(req.params.id);
        getDb().prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)').run(req.params.id, pid, 'primary');
      }
    }
    audit(req, { action: 'edit', entity: 'staff', entityId: Number(req.params.id), oldValue: existing, newValue: req.body });
    res.json({ ok: true });
  });

  // Comprehensive staff registration: creates the staff record, position assignments,
  // an optional linked login account, optional section-scoped technical authorizations,
  // and (when a login account is created) per-user permission overrides derived from
  // the authorization grid. All in one transaction. This is the Settings → Register
  // New Staff workflow and is the single source that wires a new person into Users &
  // Access, Positions & Organogram, the Permission Matrix and Personnel Management.
  router.post('/staff/register', requirePermission('personnel', 'create'), (req, res) => {
    const db = getDb();
    const { firstName, surname, otherNames, employeeNo, fullName, email, phone, sectionId, positionIds, primaryPositionId, createUser, username, password, roleId, authorizations, permissions } = req.body as {
      firstName?: string; surname?: string; otherNames?: string;
      employeeNo?: string; fullName?: string; email?: string; phone?: string; sectionId?: number | string | null;
      positionIds?: Array<number | string>; primaryPositionId?: number | string | null;
      createUser?: boolean; username?: string; password?: string; roleId?: number | string;
      authorizations?: Array<{ moduleKey: string; sectionId?: number | string | null; level: string }>;
      permissions?: Array<{ permissionId: number | string; allowed: boolean }>;
    };
    const composedName = composeFullName(firstName, surname, otherNames, fullName);
    if (!composedName) return res.status(400).json({ error: 'A staff name is required (first name and surname, or full name).' });
    if (createUser) {
      if (!username || !String(username).trim()) return res.status(400).json({ error: 'A username is required to create a login account.' });
      if (!password || String(password).length < 8) return res.status(400).json({ error: 'A password of at least 8 characters is required to create a login account.' });
      if (!roleId) return res.status(400).json({ error: 'A role is required to create a login account.' });
      const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username));
      if (taken) return res.status(400).json({ error: 'That username is already in use.' });
    }
    try {
      const out = db.transaction(() => {
        const staffResult = db.prepare('INSERT INTO staff (employee_no, full_name, first_name, surname, other_names, email, phone, section_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(employeeNo || null, composedName, (firstName || '').trim() || null, (surname || '').trim() || null, (otherNames || '').trim() || null, email || null, phone || null, idOrNull(sectionId));
        const staffId = Number(staffResult.lastInsertRowid);
        audit(req, { action: 'create', entity: 'staff', entityId: staffId, newValue: { employeeNo, fullName: composedName, email, phone, sectionId } });

        const allPositions = Array.from(new Set((positionIds ?? []).map(p => idOrNull(p)).filter((p): p is number => p !== null)));
        const primary = idOrNull(primaryPositionId) ?? allPositions[0] ?? null;
        for (const positionId of allPositions) {
          db.prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)')
            .run(staffId, positionId, positionId === primary ? 'primary' : 'secondary');
        }

        let userId: number | null = null;
        if (createUser) {
          const userResult = db.prepare('INSERT INTO users (username, password_hash, full_name, role_id, staff_id) VALUES (?, ?, ?, ?, ?)')
            .run(String(username), bcrypt.hashSync(String(password), 12), String(fullName).trim(), Number(roleId), staffId);
          userId = Number(userResult.lastInsertRowid);
          db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('settings', 'users', String(userId), 'personnel', 'staff', String(staffId), 'Login account linked to staff record at registration');
          audit(req, { action: 'create', entity: 'users', entityId: userId, newValue: { username, fullName, roleId, staffId } });

          // Persist authorization-grid edits as per-user permission overrides. These
          // are the explicit grant/deny deltas on top of the role + position defaults.
          for (const p of permissions ?? []) {
            const permId = idOrNull(p?.permissionId);
            if (!permId) continue;
            db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source, reason) VALUES (?, ?, ?, ?, ?)')
              .run(userId, permId, p.allowed ? 1 : 0, 'Manual override', 'Set during staff registration');
          }
        }

        for (const a of authorizations ?? []) {
          if (!a?.moduleKey || !a?.level) continue;
          const authResult = db.prepare('INSERT INTO technical_authorizations (staff_id, module_key, section_id, level, is_active) VALUES (?, ?, ?, ?, 1)')
            .run(staffId, a.moduleKey, idOrNull(a.sectionId), a.level);
          audit(req, { action: 'create', entity: 'technical_authorizations', entityId: Number(authResult.lastInsertRowid), newValue: { staffId, ...a } });
        }
        return { staffId, userId };
      })();
      res.status(201).json(out);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to register staff member.' });
    }
  });

  // Export the full staff register as an Excel workbook (matches the import template).
  // Build the Master Personnel Register workbook (blank template or populated).
  function buildRegisterWorkbook(includeData: boolean): Buffer {
    const db = getDb();
    const aoa: (string | number)[][] = [REGISTER_HEADER_ROW.slice()];
    if (includeData) {
      const rows = db.prepare(`
        SELECT s.*, sec.name AS section_name,
          (SELECT p.title FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = s.id AND spa.is_active = 1 ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 ELSE 1 END, spa.id LIMIT 1) AS position_title
        FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id ORDER BY s.employee_no, s.full_name`).all() as any[];
      for (const r of rows) {
        const row: (string | number)[] = REGISTER_COLUMNS.map(c => {
          if (c.col === null) return '';
          if (c.col === '__years') return yearsOfExperience(r.appointment_date);
          if (c.col === 'qualifications') return '';            // placed below across L–P
          if (c.col === 'job_title') return r.job_title || r.position_title || '';
          if (c.col === 'unit') return r.unit || r.section_name || '';
          return (r as Record<string, unknown>)[c.col] != null ? String((r as Record<string, unknown>)[c.col]) : '';
        });
        // Spread up to 5 qualifications across the L–P columns.
        const quals = String(r.qualifications || '').split('|').map((q: string) => q.trim()).filter(Boolean).slice(0, 5);
        quals.forEach((q: string, i: number) => { row[QUAL_COL_INDEX + i] = q; });
        aoa.push(row);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = REGISTER_HEADER_ROW.map(h => ({ wch: Math.max(12, Math.min(40, (h || 'QUALIFICATION').length + 3)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'MASTER PERSONNEL REGISTER');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  // Registered before '/staff/:id' so the ":id" param route does not capture these.
  router.get('/staff/template', requirePermission('personnel', 'view'), (_req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Staff_Register_Template.xlsx"');
    res.send(buildRegisterWorkbook(false));
  });
  router.get('/staff/export', requirePermission('personnel', 'view'), (_req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Master_Personnel_Register-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buildRegisterWorkbook(true));
  });

  // Full linkage profile for a staff member — surfaces every place the person is
  // connected across the system (login account, positions/organogram, technical
  // authorizations and section scope, and personnel activity volumes).
  router.get('/staff/:id', requirePermission('personnel', 'view'), (req, res) => {
    const db = getDb();
    const staff = db.prepare('SELECT s.*, sec.name AS section_name FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.id = ?').get(req.params.id) as any;
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });
    const positions = db.prepare(`SELECT spa.id, spa.position_id, p.title, spa.assignment_type, spa.is_active, p.reports_to_position_id, rp.title AS reports_to_title
      FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id LEFT JOIN positions rp ON rp.id = p.reports_to_position_id
      WHERE spa.staff_id = ? ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 ELSE 1 END, p.title`).all(req.params.id);
    const account = db.prepare('SELECT u.id, u.username, u.is_active, r.id AS role_id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.staff_id = ?').get(req.params.id) as any;
    const authorizations = db.prepare('SELECT ta.id, ta.module_key, ta.section_id, sec.name AS section_name, ta.level, ta.is_active, ta.expires_at, ta.competency_assessment_id FROM technical_authorizations ta LEFT JOIN sections sec ON sec.id = ta.section_id WHERE ta.staff_id = ? ORDER BY ta.is_active DESC, ta.module_key').all(req.params.id);
    const activity = {
      documents: (db.prepare('SELECT COUNT(*) c FROM staff_documents WHERE staff_id = ?').get(req.params.id) as any).c,
      declarations: (db.prepare('SELECT COUNT(*) c FROM staff_declarations WHERE staff_id = ?').get(req.params.id) as any).c,
      competency: (db.prepare('SELECT COUNT(*) c FROM competency_assessments WHERE staff_id = ?').get(req.params.id) as any).c,
      training: (db.prepare('SELECT COUNT(*) c FROM training_attendance WHERE staff_id = ?').get(req.params.id) as any).c,
      openActions: (db.prepare("SELECT COUNT(*) c FROM actions WHERE assigned_to_staff_id = ? AND status != 'Closed'").get(req.params.id) as any).c,
    };
    res.json({ staff, positions, account, authorizations, activity });
  });

  router.post('/staff/:id/positions', requirePermission('personnel', 'edit'), (req, res) => {
    const db = getDb();
    if (!parseIntNullable(req.body.positionId)) return res.status(400).json({ error: 'positionId is required' });
    const r = db.prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)')
      .run(req.params.id, Number(req.body.positionId), req.body.assignmentType ?? 'secondary');
    audit(req, { action: 'assign', entity: 'staff_position_assignments', entityId: Number(r.lastInsertRowid), newValue: { staffId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.get('/system-modules', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, key, label, path, enabled, alerts_paused alertsPaused FROM system_modules ORDER BY id').all()));
  router.put('/system-modules/:key', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT * FROM system_modules WHERE key = ?').get(req.params.key);
    getDb().prepare('UPDATE system_modules SET enabled = ?, alerts_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND key != ?').run(req.body.enabled ? 1 : 0, req.body.enabled ? 0 : 1, req.params.key, 'settings');
    audit(req, { action: 'edit', entity: 'system_modules', entityId: req.params.key, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/permissions/matrix', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    res.json({
      permissions: db.prepare('SELECT * FROM permissions ORDER BY module_key, action').all(),
      rolePermissions: db.prepare('SELECT * FROM role_permissions').all(),
      positionPermissions: db.prepare('SELECT * FROM position_permissions').all(),
      userOverrides: db.prepare('SELECT * FROM user_permission_overrides').all(),
      technicalAuthorizations: db.prepare(`SELECT ta.*, s.full_name AS staff_name, p.title AS position_title, sec.name AS section_name
        FROM technical_authorizations ta LEFT JOIN staff s ON s.id = ta.staff_id LEFT JOIN positions p ON p.id = ta.position_id LEFT JOIN sections sec ON sec.id = ta.section_id`).all(),
      auditHistory: db.prepare(`SELECT a.id, a.action, a.entity, a.entity_id, a.old_value, a.new_value, a.created_at, u.username AS actor_username, u.full_name AS actor_name
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.entity IN ('permissions','role_permissions','position_permissions','user_permission_overrides','technical_authorizations','staff','users')
        ORDER BY a.id DESC LIMIT 100`).all()
    });
  });

  const storage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) });
  const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

  // ===== People & Access — staff Excel import (export lives near the staff routes) =====
  router.post('/staff/import', requirePermission('personnel', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getDb();
    let rows: Record<string, unknown>[] = [];
    try {
      const buf = fs.readFileSync(req.file.path);
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
    } catch {
      return res.status(400).json({ error: 'Could not read the spreadsheet. Upload a .xlsx or .xls file based on the exported template.' });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    // Header lookup tolerant of spacing/underscores/case and the workbook's
    // "PRFOFESSIONAL" typo. Returns the first non-empty matching cell.
    const norm = (s: string) => s.trim().toUpperCase().replace(/[_\s]+/g, ' ');
    const get = (row: Record<string, unknown>, ...keys: string[]) => {
      for (const k of keys) { const hit = Object.keys(row).find(h => norm(h) === norm(k)); if (hit && String(row[hit]).trim()) return String(row[hit]).trim(); }
      return '';
    };
    // PROFESSIONAL QUALIFICATION(S) spans 5 columns (L–P); the blank continuation
    // headers are read by sheet_to_json as __EMPTY*. Merge them into one value.
    const qualifications = (row: Record<string, unknown>) => {
      const parts: string[] = [];
      const main = get(row, 'PROFESSIONAL QUALIFICATION(S)', 'QUALIFICATIONS', 'QUALIFICATION');
      if (main) parts.push(main);
      for (const k of Object.keys(row)) {
        if (/^__EMPTY/.test(k)) { const v = String(row[k] ?? '').trim(); if (v && !/^\d+(\.\d+)?$/.test(v) && v.length > 2) parts.push(v); }
      }
      return parts.length ? Array.from(new Set(parts)).join(' | ') : null;
    };
    const posByTitle = new Map<string, number>();
    for (const p of db.prepare('SELECT id, title FROM positions').all() as any[]) posByTitle.set(String(p.title).toLowerCase(), p.id);
    const secByName = new Map<string, number>();
    for (const s of db.prepare('SELECT id, name FROM sections').all() as any[]) secByName.set(String(s.name).toLowerCase(), s.id);

    const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
    const tx = db.transaction(() => {
      rows.forEach((row, idx) => {
        const surname = get(row, 'SURNAME', 'LAST NAME');
        const first = get(row, 'FIRSTNAME(S)', 'FIRSTNAME', 'FIRST NAME', 'FIRST NAME(S)');
        const middle = get(row, 'MIDDLE NAME(S)', 'MIDDLE NAME', 'MIDDLE NAMES', 'OTHER NAMES');
        const employeeNo = get(row, 'STAFF ID', 'STAFF_ID', 'EMPLOYEE NO', 'EMPLOYEE NUMBER') || null;
        const fullName = composeFullName(first, surname, middle, '');
        if (!fullName && !employeeNo) { result.skipped++; return; }
        if (!fullName) { result.errors.push(`Row ${idx + 2}: missing name.`); return; }
        const positionTitle = get(row, 'POSITION', 'JOB TITLE');
        const unitName = get(row, 'UNIT', 'DEPARTMENT', 'SECTION');
        const sectionId = unitName ? (secByName.get(unitName.toLowerCase()) ?? null) : null;
        // All Master Personnel Register fields → staff columns.
        const cols: Record<string, string | null> = {
          employee_no: employeeNo, full_name: fullName, surname: surname || null, middle_name: middle || null, other_names: middle || null,
          first_name: first || null,
          initials: get(row, 'INITIALS') || [first, middle, surname].map(p => p ? p[0] : '').join('').toUpperCase() || null,
          date_of_birth: get(row, 'DATE OF BIRTH', 'DOB') || null, gender: get(row, 'GENDER') || null,
          designation: get(row, 'DESIGNATION') || null, job_title: positionTitle || null,
          professional_regulator: get(row, 'PRFOFESSIONAL REGULATOR', 'PROFESSIONAL REGULATOR', 'REGULATOR') || null,
          professional_licence: get(row, 'PROFESSIONAL LICENCE', 'PROFESSIONAL LICENSE', 'LICENCE') || null,
          qualifications: qualifications(row), unit: unitName || null,
          personnel_category: get(row, 'PERSONNEL CATEGORY', 'CATEGORY') || null,
          appointment_type: get(row, 'APPOINTMENT TYPE') || null, appointment_date: get(row, 'DATE OF APPOINTMENT', 'APPOINTMENT DATE') || null,
          national_id_type: get(row, 'TYPE OF NATIONAL ID', 'NATIONAL ID TYPE') || null,
          national_id_number: get(row, 'NATIONAL ID NUM', 'NATIONAL ID NUMBER', 'NATIONAL ID') || null,
          emergency_contact: get(row, 'EMERGENCY CONTACT') || null, phone: get(row, 'CONTACT PHONE', 'CONTACT_PHONE', 'PHONE') || null,
          email: get(row, 'EMAIL ADDRESS', 'EMAIL_ADDRESS', 'EMAIL') || null, staff_file_location: get(row, 'STAFF FILE LOCATION', 'STAFF_FILE_LOCATION', 'FILE LOCATION') || null,
        };
        if (sectionId) cols.section_id = String(sectionId);
        try {
          const existing = employeeNo ? db.prepare('SELECT id FROM staff WHERE employee_no = ?').get(employeeNo) as any : null;
          let staffId: number;
          if (existing) {
            const keys = Object.keys(cols).filter(k => cols[k] !== null);
            if (keys.length) db.prepare(`UPDATE staff SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...keys.map(k => cols[k]), existing.id);
            staffId = existing.id; result.updated++;
          } else {
            const keys = Object.keys(cols);
            const r = db.prepare(`INSERT INTO staff (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => cols[k]));
            staffId = Number(r.lastInsertRowid); result.created++;
          }
          // Link POSITION into the positions/organogram and assign it as primary.
          if (positionTitle) {
            let resolvedPos = posByTitle.get(positionTitle.toLowerCase());
            if (resolvedPos == null) { const pr = db.prepare('INSERT INTO positions (title, is_active) VALUES (?, 1)').run(positionTitle); resolvedPos = Number(pr.lastInsertRowid); posByTitle.set(positionTitle.toLowerCase(), resolvedPos); }
            const has = db.prepare("SELECT id FROM staff_position_assignments WHERE staff_id = ? AND position_id = ? AND is_active = 1").get(staffId, resolvedPos);
            if (!has) db.prepare("INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, 'primary')").run(staffId, resolvedPos);
          }
        } catch (err) {
          result.errors.push(`Row ${idx + 2}: ${err instanceof Error ? err.message : 'failed'}`);
        }
      });
    });
    tx();
    audit(req, { action: 'import', entity: 'staff', newValue: { created: result.created, updated: result.updated, skipped: result.skipped } });
    res.json(result);
  });
  router.post('/files', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const r = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: r.lastInsertRowid, newValue: { originalName: req.file.originalname, storedName: req.file.filename } });
    res.status(201).json({ id: r.lastInsertRowid, storedName: req.file.filename });
  });
  router.post('/evidence', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    fs.renameSync(req.file.path, path.join(evidenceRoot, req.file.filename));
    const file = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'evidence', req.user!.id);
    const link = getDb().prepare('INSERT INTO evidence_files (file_id, module_key, record_type, record_id, notes, linked_by) VALUES (?, ?, ?, ?, ?, ?)').run(file.lastInsertRowid, req.body.moduleKey, req.body.recordType, req.body.recordId, req.body.notes ?? null, req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: file.lastInsertRowid, newValue: req.body });
    res.status(201).json({ fileId: file.lastInsertRowid, evidenceId: link.lastInsertRowid });
  });

  // Serve an uploaded file's bytes so controlled documents can be viewed and
  // printed inside the application. `/raw` streams inline (the in-app viewer
  // embeds PDFs/images directly); `/download` forces a save dialog. This is the
  // endpoint the document register "Open" button relies on.
  function resolveFileOnDisk(id: unknown) {
    const file = getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) as any;
    if (!file) return null;
    const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const fp = path.join(root, file.stored_name);
    if (!fs.existsSync(fp)) return null;
    return { file, fp };
  }
  router.get('/files/:id/meta', requirePermission('documents', 'view'), (req, res) => {
    // stored_name (the on-disk filename) is included alongside storage_area so the
    // desktop app's "Open in Microsoft Office" feature can ask the Electron main
    // process (running on the same machine as this embedded API) to locate and
    // open the exact file. This is safe here: the API only ever listens on
    // 127.0.0.1, so only an already-authenticated local user can reach this route.
    const file = getDb().prepare('SELECT id, original_name, stored_name, mime_type, size_bytes, storage_area, created_at FROM files WHERE id = ?').get(req.params.id) as any;
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  });
  router.get('/files/:id/raw', requirePermission('documents', 'view'), (req, res) => {
    const resolved = resolveFileOnDisk(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'File not found' });
    const { file, fp } = resolved;
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(fp).pipe(res);
  });
  router.get('/files/:id/download', requirePermission('documents', 'view'), (req, res) => {
    const resolved = resolveFileOnDisk(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'File not found' });
    const { file, fp } = resolved;
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    fs.createReadStream(fp).pipe(res);
  });

  router.get('/documents', requirePermission('documents', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM documents ORDER BY created_at DESC').all()));
  router.post('/documents/import-master-list', requirePermission('documents', 'create'), (req, res) => { audit(req, { action: 'create', entity: 'documents', newValue: req.body }); res.json({ ok: true, message: 'MVP import placeholder accepted. CSV parsing will be implemented in the next phase.' }); });

  router.get('/actions', requirePermission('actions', 'view'), (req, res) => {
    const db = getDb();
    const filters = [];
    const params: unknown[] = [];
    let query = 'SELECT * FROM actions';
    if (req.query.assignedToStaffId) {
      filters.push('assigned_to_staff_id = ?');
      params.push(Number(req.query.assignedToStaffId));
    }
    if (req.query.status) {
      filters.push('status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.overdue === 'true') {
      filters.push('due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?');
      params.push('Closed');
    }
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY created_at DESC';
    res.json(db.prepare(query).all(...params));
  });
  router.post('/actions', requirePermission('actions', 'create'), (req, res) => {
    const r = getDb().prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, completion_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      req.body.title,
      req.body.moduleKey ?? 'actions',
      req.body.sourceModule ?? null,
      req.body.sourceRecordId ?? null,
      req.body.description ?? null,
      req.body.priority ?? 'normal',
      req.body.assignedToStaffId ?? null,
      req.body.dueDate ?? null,
      req.body.status ?? 'Not started',
      req.body.evidenceRequired ? 1 : 0,
      req.body.completionNotes ?? null,
      req.user!.id
    );
    audit(req, { action: 'create', entity: 'actions', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/actions/:id', requirePermission('actions', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Action not found' });
    db.prepare('UPDATE actions SET title = ?, source_module = ?, source_record_id = ?, description = ?, priority = ?, assigned_to_staff_id = ?, due_date = ?, status = ?, evidence_required = ?, completion_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      req.body.title ?? oldValue.title,
      req.body.sourceModule ?? oldValue.source_module,
      req.body.sourceRecordId ?? oldValue.source_record_id,
      req.body.description ?? oldValue.description,
      req.body.priority ?? oldValue.priority,
      req.body.assignedToStaffId ?? oldValue.assigned_to_staff_id,
      req.body.dueDate ?? oldValue.due_date,
      req.body.status ?? oldValue.status,
      req.body.evidenceRequired ? 1 : oldValue.evidence_required,
      req.body.completionNotes ?? oldValue.completion_notes,
      req.params.id
    );
    audit(req, { action: 'edit', entity: 'actions', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.get('/permissions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM permissions ORDER BY module_key, action').all()));
  router.post('/permissions/role', requirePermission('settings', 'edit'), (req, res) => {
    const { roleId, permissionId, allowed } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(roleId, permissionId, allowed ? 1 : 0, 'Manual assignment');
    audit(req, { action: 'create', entity: 'role_permissions', entityId: result.lastInsertRowid, newValue: { roleId, permissionId, allowed } });
    res.status(201).json({ ok: true });
  });
  router.post('/permissions/position', requirePermission('settings', 'edit'), (req, res) => {
    const { positionId, permissionId, allowed } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO position_permissions (position_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(positionId, permissionId, allowed ? 1 : 0, 'Manual assignment');
    audit(req, { action: 'create', entity: 'position_permissions', entityId: result.lastInsertRowid, newValue: { positionId, permissionId, allowed } });
    res.status(201).json({ ok: true });
  });
  router.post('/permissions/user-override', requirePermission('settings', 'edit'), (req, res) => {
    const { userId, permissionId, allowed, reason } = req.body;
    const result = getDb().prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source, reason) VALUES (?, ?, ?, ?, ?)').run(userId, permissionId, allowed ? 1 : 0, 'Manual override', reason ?? null);
    audit(req, { action: 'create', entity: 'user_permission_overrides', entityId: result.lastInsertRowid, newValue: { userId, permissionId, allowed, reason } });
    res.status(201).json({ ok: true });
  });
  router.get('/authorizations/technical', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare(`
    SELECT ta.id, ta.staff_id, ta.position_id, ta.module_key, ta.section_id, ta.level, ta.is_active, ta.granted_at, ta.expires_at, ta.competency_assessment_id,
      s.full_name AS staff_name, p.title AS position_title, sec.name AS section_name
    FROM technical_authorizations ta
    LEFT JOIN staff s ON s.id = ta.staff_id
    LEFT JOIN positions p ON p.id = ta.position_id
    LEFT JOIN sections sec ON sec.id = ta.section_id
    ORDER BY ta.is_active DESC, ta.module_key, sec.name`).all()));
  router.post('/authorizations/technical', requirePermission('settings', 'edit'), (req, res) => {
    const { staffId, positionId, moduleKey, sectionId, level, expiresAt } = req.body;
    if (!moduleKey || !level) return res.status(400).json({ error: 'moduleKey and level are required.' });
    if (!idOrNull(staffId) && !idOrNull(positionId)) return res.status(400).json({ error: 'Select a staff member or a position to scope this authorization.' });
    const result = getDb().prepare('INSERT INTO technical_authorizations (staff_id, position_id, module_key, section_id, level, is_active, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(idOrNull(staffId), idOrNull(positionId), moduleKey, idOrNull(sectionId), level, expiresAt || null);
    audit(req, { action: 'create', entity: 'technical_authorizations', entityId: result.lastInsertRowid, newValue: { staffId, positionId, moduleKey, sectionId, level, expiresAt } });
    res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
  });
  router.post('/authorizations/technical/:id/deactivate', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM technical_authorizations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Authorization not found' });
    db.prepare('UPDATE technical_authorizations SET is_active = 0 WHERE id = ?').run(req.params.id);
    audit(req, { action: 'deactivate', entity: 'technical_authorizations', entityId: req.params.id, oldValue: existing, newValue: { is_active: 0 } });
    res.json({ ok: true });
  });
  router.get('/sections', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name FROM sections WHERE is_active = 1 ORDER BY name').all()));

  // =====================================================================
  // Section / Unit Configuration
  // ---------------------------------------------------------------------
  // One place to configure each laboratory unit: its profile, the services
  // it offers (and explicitly does not offer), its own test menu, its
  // equipment, and its stock/inventory. Test menu, equipment and inventory
  // write to the same section-scoped tables used by the Process Management,
  // Equipment and Supplier & Inventory modules, keeping everything linked.
  // =====================================================================
  router.get('/section-config/sections', requirePermission('settings', 'view'), (_req, res) => {
    res.json(getDb().prepare(`
      SELECT s.id, s.name, s.code, s.description, s.service_summary AS serviceSummary, s.operating_hours AS operatingHours,
        s.department_id AS departmentId, d.name AS departmentName, s.head_staff_id AS headStaffId, hs.full_name AS headStaffName, s.is_active AS isActive,
        (SELECT COUNT(*) FROM section_services ss WHERE ss.section_id = s.id AND ss.is_offered = 1) AS servicesOffered,
        (SELECT COUNT(*) FROM section_services ss WHERE ss.section_id = s.id AND ss.is_offered = 0) AS servicesNotOffered,
        (SELECT COUNT(*) FROM lab_test_catalog t WHERE t.section_id = s.id) AS testCount,
        (SELECT COUNT(*) FROM equipment_items e WHERE e.section_id = s.id) AS equipmentCount,
        (SELECT COUNT(*) FROM inventory_items i WHERE i.section_id = s.id) AS inventoryCount,
        (SELECT COUNT(*) FROM staff st WHERE st.section_id = s.id AND st.is_active = 1) AS staffCount
      FROM sections s
      LEFT JOIN departments d ON d.id = s.department_id
      LEFT JOIN staff hs ON hs.id = s.head_staff_id
      ORDER BY s.is_active DESC, s.name`).all());
  });

  router.post('/section-config/sections', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const { name, departmentId, code, description, serviceSummary, operatingHours, headStaffId } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A unit/section name is required.' });
    const deptId = idOrNull(departmentId) ?? (db.prepare('SELECT id FROM departments ORDER BY id LIMIT 1').get() as any)?.id ?? null;
    try {
      const r = db.prepare('INSERT INTO sections (department_id, name, code, description, service_summary, operating_hours, head_staff_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(deptId, String(name).trim(), code || null, description || null, serviceSummary || null, operatingHours || null, idOrNull(headStaffId));
      audit(req, { action: 'create', entity: 'sections', entityId: Number(r.lastInsertRowid), newValue: req.body });
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error && /UNIQUE/.test(err.message) ? 'A unit with that name already exists in this department.' : (err instanceof Error ? err.message : 'Failed to create unit.') });
    }
  });

  router.put('/section-config/sections/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM sections WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Unit not found' });
    db.prepare('UPDATE sections SET name = ?, code = ?, description = ?, service_summary = ?, operating_hours = ?, department_id = ?, head_staff_id = ? WHERE id = ?')
      .run(req.body.name ?? (oldValue as any).name, req.body.code ?? null, req.body.description ?? null, req.body.serviceSummary ?? null, req.body.operatingHours ?? null, idOrNull(req.body.departmentId) ?? (oldValue as any).department_id, idOrNull(req.body.headStaffId), req.params.id);
    audit(req, { action: 'edit', entity: 'sections', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/section-config/sections/:id/toggle', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const sec = db.prepare('SELECT is_active FROM sections WHERE id = ?').get(req.params.id) as { is_active: number } | undefined;
    if (!sec) return res.status(404).json({ error: 'Unit not found' });
    const next = sec.is_active ? 0 : 1;
    db.prepare('UPDATE sections SET is_active = ? WHERE id = ?').run(next, req.params.id);
    audit(req, { action: next ? 'activate' : 'deactivate', entity: 'sections', entityId: req.params.id, oldValue: { is_active: sec.is_active }, newValue: { is_active: next } });
    res.json({ ok: true, isActive: next });
  });

  // Delete a unit/section. If the unit is referenced by other records (staff,
  // tests, equipment, inventory, services) it is deactivated instead of hard
  // deleted, to protect referential integrity across the system.
  router.delete('/section-config/sections/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const sec = db.prepare('SELECT id FROM sections WHERE id = ?').get(req.params.id);
    if (!sec) return res.status(404).json({ error: 'Unit not found' });
    const refs =
      (db.prepare('SELECT COUNT(*) c FROM staff WHERE section_id = ?').get(req.params.id) as any).c +
      (db.prepare('SELECT COUNT(*) c FROM lab_test_catalog WHERE section_id = ?').get(req.params.id) as any).c +
      (db.prepare('SELECT COUNT(*) c FROM equipment_items WHERE section_id = ?').get(req.params.id) as any).c +
      (db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE section_id = ?').get(req.params.id) as any).c;
    if (refs > 0) {
      db.prepare('UPDATE sections SET is_active = 0 WHERE id = ?').run(req.params.id);
      audit(req, { action: 'deactivate', entity: 'sections', entityId: req.params.id, newValue: { reason: 'in use', references: refs } });
      return res.json({ ok: true, deactivated: true, message: `This unit is referenced by ${refs} record(s), so it was deactivated instead of deleted.` });
    }
    db.prepare('DELETE FROM section_services WHERE section_id = ?').run(req.params.id);
    db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'sections', entityId: req.params.id });
    res.json({ ok: true, deactivated: false });
  });

  router.get('/section-config/sections/:id', requirePermission('settings', 'view'), (req, res) => {
    const db = getDb();
    const section = db.prepare(`SELECT s.*, d.name AS department_name, hs.full_name AS head_staff_name FROM sections s LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN staff hs ON hs.id = s.head_staff_id WHERE s.id = ?`).get(req.params.id);
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    const services = db.prepare('SELECT id, name, category, is_offered, notes FROM section_services WHERE section_id = ? ORDER BY is_offered DESC, name').all(req.params.id);
    const tests = db.prepare('SELECT id, test_code, test_name, sample_type, method_name, tat_target_minutes, status FROM lab_test_catalog WHERE section_id = ? ORDER BY test_name').all(req.params.id);
    const equipment = db.prepare('SELECT id, equipment_number, name, category, manufacturer, model, serial_number, status FROM equipment_items WHERE section_id = ? ORDER BY name').all(req.params.id);
    const inventory = db.prepare('SELECT id, item_code, name, category, quantity, unit, reorder_level, expiry_date, status FROM inventory_items WHERE section_id = ? ORDER BY name').all(req.params.id);
    const staff = db.prepare('SELECT id, full_name, employee_no, is_active FROM staff WHERE section_id = ? ORDER BY is_active DESC, full_name').all(req.params.id);
    res.json({ section, services, tests, equipment, inventory, staff });
  });

  // --- Services (what the unit does / does not do) ---
  router.post('/section-config/sections/:id/services', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM sections WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Unit not found' });
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'A service/activity name is required.' });
    const r = db.prepare('INSERT INTO section_services (section_id, name, category, is_offered, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.params.id, String(req.body.name).trim(), req.body.category || null, req.body.isOffered === false ? 0 : 1, req.body.notes || null, req.user!.id);
    audit(req, { action: 'create', entity: 'section_services', entityId: Number(r.lastInsertRowid), newValue: { sectionId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  router.put('/section-config/services/:serviceId', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM section_services WHERE id = ?').get(req.params.serviceId) as any;
    if (!existing) return res.status(404).json({ error: 'Service not found' });
    db.prepare('UPDATE section_services SET name = ?, category = ?, is_offered = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body.name ?? existing.name, req.body.category ?? existing.category, req.body.isOffered === undefined ? existing.is_offered : (req.body.isOffered ? 1 : 0), req.body.notes ?? existing.notes, req.params.serviceId);
    audit(req, { action: 'edit', entity: 'section_services', entityId: req.params.serviceId, oldValue: existing, newValue: req.body });
    res.json({ ok: true });
  });
  router.delete('/section-config/services/:serviceId', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM section_services WHERE id = ?').get(req.params.serviceId);
    if (!existing) return res.status(404).json({ error: 'Service not found' });
    db.prepare('DELETE FROM section_services WHERE id = ?').run(req.params.serviceId);
    audit(req, { action: 'delete', entity: 'section_services', entityId: req.params.serviceId, oldValue: existing });
    res.json({ ok: true });
  });

  // --- Test menu (writes to the shared lab_test_catalog, scoped to this unit) ---
  router.post('/section-config/sections/:id/tests', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const section = db.prepare('SELECT department_id FROM sections WHERE id = ?').get(req.params.id) as { department_id: number | null } | undefined;
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    if (!req.body.testName || !String(req.body.testName).trim()) return res.status(400).json({ error: 'A test name is required.' });
    const testCode = req.body.testCode || generateRecordNumber(db, 'lab_test_catalog', 'TEST');
    const r = db.prepare(`INSERT INTO lab_test_catalog (test_code, test_name, department_id, section_id, sample_type, container_type, minimum_volume, method_name, method_summary, tat_target_minutes, critical_result_applicable, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(testCode, String(req.body.testName).trim(), section.department_id, req.params.id, req.body.sampleType || null, req.body.containerType || null, req.body.minimumVolume || null, req.body.methodName || null, req.body.methodSummary || null, parseIntNullable(req.body.tatTargetMinutes), req.body.criticalResultApplicable ? 1 : 0, req.body.status || 'active', req.user!.id);
    audit(req, { action: 'create', entity: 'lab_test_catalog', entityId: Number(r.lastInsertRowid), newValue: { testCode, sectionId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid), testCode });
  });
  router.post('/section-config/tests/:testId/toggle', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT status FROM lab_test_catalog WHERE id = ?').get(req.params.testId) as { status: string } | undefined;
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const next = t.status === 'active' ? 'inactive' : 'active';
    db.prepare('UPDATE lab_test_catalog SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, req.params.testId);
    audit(req, { action: 'edit', entity: 'lab_test_catalog', entityId: req.params.testId, oldValue: { status: t.status }, newValue: { status: next } });
    res.json({ ok: true, status: next });
  });

  // --- Equipment (writes to the shared equipment_items, scoped to this unit) ---
  router.post('/section-config/sections/:id/equipment', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const section = db.prepare('SELECT department_id FROM sections WHERE id = ?').get(req.params.id) as { department_id: number | null } | undefined;
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'An equipment name is required.' });
    const equipmentNumber = req.body.equipmentNumber || generateRecordNumber(db, 'equipment_items', 'EQP');
    const r = db.prepare(`INSERT INTO equipment_items (equipment_number, name, category, manufacturer, model, serial_number, department_id, section_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(equipmentNumber, String(req.body.name).trim(), req.body.category || null, req.body.manufacturer || null, req.body.model || null, req.body.serialNumber || null, section.department_id, req.params.id, req.body.status || 'operational', req.user!.id);
    audit(req, { action: 'create', entity: 'equipment_items', entityId: Number(r.lastInsertRowid), newValue: { equipmentNumber, sectionId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid), equipmentNumber });
  });

  // --- Stock / inventory (writes to the shared inventory_items, scoped to this unit) ---
  router.post('/section-config/sections/:id/inventory', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const section = db.prepare('SELECT department_id FROM sections WHERE id = ?').get(req.params.id) as { department_id: number | null } | undefined;
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'An item name is required.' });
    const itemCode = req.body.itemCode || generateRecordNumber(db, 'inventory_items', 'ITEM');
    const r = db.prepare(`INSERT INTO inventory_items (item_code, name, category, quantity, unit, status, reorder_level, expiry_date, storage_requirement, department_id, section_id, minimum_stock, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(itemCode, String(req.body.name).trim(), req.body.category || null, parseIntNullable(req.body.quantity) ?? 0, req.body.unit || null, req.body.status || 'available', parseIntNullable(req.body.reorderLevel) ?? 0, req.body.expiryDate || null, req.body.storageRequirement || null, section.department_id, req.params.id, parseIntNullable(req.body.minimumStock) ?? 0, req.user!.id);
    audit(req, { action: 'create', entity: 'inventory_items', entityId: Number(r.lastInsertRowid), newValue: { itemCode, sectionId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid), itemCode });
  });

  router.get('/devices', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM devices ORDER BY created_at DESC').all()));
  router.post('/devices/request-pairing', requirePermission('settings', 'create'), (req, res) => { const code = Math.random().toString(36).slice(2, 10).toUpperCase(); const r = getDb().prepare('INSERT INTO devices (device_code, name, type) VALUES (?, ?, ?)').run(code, req.body.name, req.body.type ?? 'desktop'); audit(req, { action: 'create', entity: 'devices', entityId: r.lastInsertRowid, newValue: { code, ...req.body } }); res.status(201).json({ id: r.lastInsertRowid, code }); });
  router.post('/devices/:id/approve', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('approved', req.params.id);
    audit(req, { action: 'approve', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });
  router.post('/devices/:id/revoke', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('revoked', req.params.id);
    audit(req, { action: 'revoke', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'revoked' } });
    res.json({ ok: true });
  });
  router.post('/devices/:id/block', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT status FROM devices WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!oldValue) return res.status(404).json({ error: 'Device not found' });
    getDb().prepare('UPDATE devices SET status = ? WHERE id = ?').run('blocked', req.params.id);
    audit(req, { action: 'block', entity: 'devices', entityId: req.params.id, oldValue, newValue: { status: 'blocked' } });
    res.json({ ok: true });
  });

  // Multer instance for restore uploads: stores the incoming ZIP into the
  // backups folder under a temporary "._upload-restore-*" name (filtered out of
  // the backup listing). Generous size limit because a full backup includes all
  // uploads and evidence.
  const restoreUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => { ensureDataDirs(); cb(null, backupRoot); },
      filename: (_req, file, cb) => cb(null, `._upload-restore-${Date.now()}-${safeStoredFilename(file.originalname)}`),
    }),
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  });

  router.post('/backup/create', requirePermission('settings', 'export'), async (req, res) => {
    ensureDataDirs();
    const fileName = `sech-lims-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const fullPath = path.join(backupRoot, fileName);
    const manifest = { product: 'SECH_LIMS by Nickland', createdAt: new Date().toISOString(), includes: ['SQLite database', 'uploads', 'evidence', 'config', 'backup-manifest.json'] };
    // Checkpoint the WAL so the snapshot of the SQLite file is fully up to date.
    try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    try {
      await writeBackupZip(fullPath, manifest);
    } catch (err) {
      console.error('[backup/create] archive creation failed', err);
      return res.status(500).json({ error: 'Backup ZIP could not be created. See server log for details.' });
    }
    const sizeBytes = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
    getDb().prepare('INSERT INTO backup_logs (file_name, manifest, created_by) VALUES (?, ?, ?)').run(fileName, JSON.stringify(manifest), req.user!.id);
    audit(req, { action: 'create', entity: 'backup', entityId: fileName, newValue: manifest });
    res.status(201).json({ fileName, manifest, sizeBytes, location: backupRoot, downloadPath: `/backup/download/${encodeURIComponent(fileName)}` });
  });

  // List the backup ZIPs available on disk, newest first, merged with any
  // metadata recorded in backup_logs so the UI can offer download / restore.
  router.get('/backup/list', requirePermission('settings', 'view'), (_req, res) => {
    ensureDataDirs();
    const logs = getDb().prepare('SELECT file_name, created_at FROM backup_logs ORDER BY id DESC').all() as Array<{ file_name: string; created_at: string }>;
    const logByName = new Map(logs.map(l => [l.file_name, l.created_at]));
    const files = fs.readdirSync(backupRoot)
      .filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.') && !f.startsWith('_'))
      .map(f => {
        const stat = fs.statSync(path.join(backupRoot, f));
        return {
          fileName: f,
          sizeBytes: stat.size,
          createdAt: logByName.get(f) ?? stat.mtime.toISOString(),
          source: logByName.has(f) ? 'system' : 'external',
          downloadPath: `/backup/download/${encodeURIComponent(f)}`,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ location: backupRoot, backups: files });
  });

  // Stream a backup ZIP back to the browser for the user to save locally.
  router.get('/backup/download/:fileName', requirePermission('settings', 'export'), (req, res) => {
    const name = req.params.fileName;
    if (!isSafeBackupName(name)) return res.status(400).json({ error: 'Invalid backup file name.' });
    const full = path.join(backupRoot, name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Backup not found.' });
    res.download(full, name);
  });

  // Restore from either an uploaded ZIP (multipart "file") or an existing backup
  // referenced by name ({ fileName }). The current deployment is snapshotted to a
  // pre-restore safety ZIP first, then the SQLite database, uploads, evidence and
  // config are replaced from the backup.
  router.post('/backup/restore', requirePermission('settings', 'approve'), restoreUpload.single('file'), async (req, res) => {
    ensureDataDirs();
    let sourceZip: string;
    let uploadedTemp: string | null = null;
    if (req.file) {
      sourceZip = req.file.path;
      uploadedTemp = req.file.path;
    } else if (req.body && typeof req.body.fileName === 'string' && req.body.fileName) {
      if (!isSafeBackupName(req.body.fileName)) return res.status(400).json({ error: 'Invalid backup file name.' });
      sourceZip = path.join(backupRoot, req.body.fileName);
      if (!fs.existsSync(sourceZip)) return res.status(404).json({ error: 'Selected backup was not found on the server.' });
    } else {
      return res.status(400).json({ error: 'No backup provided. Upload a ZIP file or choose an existing backup.' });
    }

    const cleanupUpload = () => { if (uploadedTemp) { try { fs.rmSync(uploadedTemp, { force: true }); } catch { /* ignore */ } } };

    // Open and validate the ZIP before touching any live data.
    let AdmZip: any;
    try {
      AdmZip = await loadAdmZip();
    } catch (err) {
      console.error('[backup/restore] failed to load adm-zip', err);
      cleanupUpload();
      return res.status(500).json({ error: 'Archive engine failed to load. Please check packaged runtime dependencies.' });
    }
    let entries: Array<{ entryName: string }>;
    try {
      const zip = new AdmZip(sourceZip);
      entries = zip.getEntries();
      const names = entries.map(e => e.entryName);
      const looksLikeBackup = names.includes('backup-manifest.json') || names.includes('database/sech_lims.sqlite');
      if (!looksLikeBackup) {
        cleanupUpload();
        return res.status(400).json({ error: 'This ZIP is not a valid SECH_LIMS backup (no database or backup-manifest.json inside).' });
      }
    } catch (err) {
      console.error('[backup/restore] invalid ZIP', err);
      cleanupUpload();
      return res.status(400).json({ error: 'The provided file is not a readable ZIP archive.' });
    }

    // Snapshot current state so a bad restore can be undone.
    let safetyBackup: string | null = null;
    try {
      try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
      const safetyName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      const safetyPath = path.join(backupRoot, safetyName);
      await writeBackupZip(safetyPath, { product: 'SECH_LIMS by Nickland', createdAt: new Date().toISOString(), kind: 'pre-restore-safety-snapshot' });
      safetyBackup = safetyName;
    } catch (err) {
      console.error('[backup/restore] safety snapshot failed', err);
      cleanupUpload();
      return res.status(500).json({ error: 'Could not create a pre-restore safety snapshot. Restore aborted; nothing was changed.' });
    }

    const actorId = req.user!.id;
    const tmpDir = path.join(backupRoot, `._restore-${Date.now()}`);
    try {
      // Extract the backup to a scratch folder.
      fs.mkdirSync(tmpDir, { recursive: true });
      new AdmZip(sourceZip).extractAllTo(tmpDir, true);

      // Release the SQLite handles, then swap files into place.
      closeDb();
      const restoredDb = path.join(tmpDir, 'database', 'sech_lims.sqlite');
      if (fs.existsSync(restoredDb)) {
        for (const ext of ['', '-wal', '-shm']) {
          const p = dbPath + ext;
          if (fs.existsSync(p)) fs.rmSync(p, { force: true });
        }
        fs.copyFileSync(restoredDb, dbPath);
      }
      replaceDirFromBackup(path.join(tmpDir, 'uploads'), uploadRoot);
      replaceDirFromBackup(path.join(tmpDir, 'evidence'), evidenceRoot);
      replaceDirFromBackup(path.join(tmpDir, 'config'), configRoot);
    } catch (err) {
      console.error('[backup/restore] restore failed', err);
      try { getDb(); } catch { /* reopen best-effort */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      cleanupUpload();
      return res.status(500).json({ error: `Restore failed. A safety snapshot was saved as ${safetyBackup}. See server log for details.` });
    }

    // Reopen the (now restored) database and record the event.
    getDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    cleanupUpload();
    try {
      audit(req, { action: 'restore', entity: 'backup', entityId: req.file ? `upload:${req.file.originalname}` : String(req.body.fileName), newValue: { restoredBy: actorId, safetyBackup } });
    } catch { /* audit table came from the restored DB; never block on it */ }

    res.json({ ok: true, message: 'Restore completed. The database and files were replaced from the backup. Users may need to sign in again.', safetyBackup });
  });
  router.get('/audit-log', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all()));

  // -------- Phase 15: System health, my-work, setup health, linked records --------
  function tableExists(db: any, name: string): boolean {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  }
  function safeCount(db: any, sql: string, ...params: unknown[]): number {
    try { return (db.prepare(sql).get(...params) as { count: number }).count; } catch { return 0; }
  }

  router.get('/system/about', (_req, res) => {
    const db = getDb();
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    res.json({
      productName: 'SECH_LIMS by Nickland',
      version: process.env.npm_package_version ?? '0.1.0',
      buildMode: process.env.NODE_ENV ?? 'development',
      apiStatus: dbOk ? 'ok' : 'database_unavailable',
      databasePath: dbPath,
      dataDirectory: dataRoot,
      lanReady: true,
      generatedAt: new Date().toISOString()
    });
  });

  router.get('/dashboard/system-health-summary', (_req, res) => {
    const db = getDb();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      activeModules: safeCount(db, 'SELECT COUNT(*) count FROM system_modules WHERE enabled = 1'),
      totalUsers: safeCount(db, 'SELECT COUNT(*) count FROM users'),
      usersLinkedToStaff: safeCount(db, 'SELECT COUNT(*) count FROM users WHERE staff_id IS NOT NULL'),
      usersNotLinkedToStaff: safeCount(db, 'SELECT COUNT(*) count FROM users WHERE staff_id IS NULL'),
      openActions: safeCount(db, "SELECT COUNT(*) count FROM actions WHERE status != 'Closed'"),
      overdueActions: safeCount(db, "SELECT COUNT(*) count FROM actions WHERE due_date IS NOT NULL AND due_date < ? AND status != 'Closed'", today),
      unreadNotifications: tableExists(db, 'notifications') ? safeCount(db, "SELECT COUNT(*) count FROM notifications WHERE status = 'unread'") : 0,
      overdueCalendarItems: tableExists(db, 'review_calendar_items') ? safeCount(db, "SELECT COUNT(*) count FROM review_calendar_items WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('completed','cancelled')", today) : 0,
      recentAuditEvents: safeCount(db, "SELECT COUNT(*) count FROM audit_logs WHERE created_at >= ?", monthStart),
      backupChecksThisMonth: tableExists(db, 'backup_restore_checks') ? safeCount(db, 'SELECT COUNT(*) count FROM backup_restore_checks WHERE created_at >= ?', monthStart) : 0,
      openDataIntegrityIssues: tableExists(db, 'data_integrity_checks') ? safeCount(db, "SELECT COUNT(*) count FROM data_integrity_checks WHERE status IN ('issues_found','action_required')") : 0
    });
  });

  router.get('/dashboard/my-work-summary', (req, res) => {
    const db = getDb();
    const userId = req.user?.id ?? null;
    const staffId = req.user?.staffId ?? null;
    const today = new Date().toISOString().slice(0, 10);
    let myOpenTasks = 0, myUnreadNotifications = 0, myDueToday = 0, myOverdueItems = 0, myOpenActions = 0, myPendingApprovals = 0;
    if (tableExists(db, 'user_task_queue')) {
      if (staffId) myOpenTasks = safeCount(db, "SELECT COUNT(*) count FROM user_task_queue WHERE status IN ('open','in_progress','overdue') AND assigned_to_staff_id = ?", staffId);
      else if (userId) myOpenTasks = safeCount(db, "SELECT COUNT(*) count FROM user_task_queue WHERE status IN ('open','in_progress','overdue') AND assigned_to_user_id = ?", userId);
    }
    if (tableExists(db, 'notifications')) {
      if (staffId) {
        myUnreadNotifications = safeCount(db, "SELECT COUNT(*) count FROM notifications WHERE status = 'unread' AND (assigned_to_staff_id = ? OR assigned_to_staff_id IS NULL)", staffId);
        myDueToday = safeCount(db, "SELECT COUNT(*) count FROM notifications WHERE due_date = ? AND status NOT IN ('resolved','dismissed') AND (assigned_to_staff_id = ? OR assigned_to_staff_id IS NULL)", today, staffId);
        myOverdueItems = safeCount(db, "SELECT COUNT(*) count FROM notifications WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('resolved','dismissed') AND (assigned_to_staff_id = ? OR assigned_to_staff_id IS NULL)", today, staffId);
        myPendingApprovals = safeCount(db, "SELECT COUNT(*) count FROM notifications WHERE notification_type = 'approval_required' AND status NOT IN ('resolved','dismissed') AND (assigned_to_staff_id = ? OR assigned_to_staff_id IS NULL)", staffId);
      }
    }
    if (staffId) myOpenActions = safeCount(db, "SELECT COUNT(*) count FROM actions WHERE assigned_to_staff_id = ? AND status != 'Closed'", staffId);
    res.json({ myOpenTasks, myUnreadNotifications, myDueToday, myOverdueItems, myOpenActions, myPendingApprovals });
  });

  router.get('/settings/setup-health', requirePermission('settings', 'view'), (req, res) => {
    const db = getDb();
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'System Administrator'").get() as { id: number } | undefined;
    const hasAdminUser = adminRole ? safeCount(db, 'SELECT COUNT(*) count FROM users WHERE role_id = ?', adminRole.id) > 0 : false;
    const adminLinkedToStaff = adminRole ? safeCount(db, 'SELECT COUNT(*) count FROM users WHERE role_id = ? AND staff_id IS NOT NULL', adminRole.id) > 0 : false;
    const moduleCount = safeCount(db, 'SELECT COUNT(*) count FROM system_modules');
    const activeModuleCount = safeCount(db, 'SELECT COUNT(*) count FROM system_modules WHERE enabled = 1');
    const permissionRowsCount = safeCount(db, 'SELECT COUNT(*) count FROM permissions');
    const staffCount = safeCount(db, 'SELECT COUNT(*) count FROM staff');
    const positionsCount = safeCount(db, 'SELECT COUNT(*) count FROM positions');
    const backupRow = db.prepare("SELECT value FROM settings WHERE key = 'backupConfigured'").get() as { value: string } | undefined;
    const backupConfigured = backupRow?.value === 'true';
    const warnings: string[] = [];
    if (!hasAdminUser) warnings.push('No system administrator user exists.');
    if (hasAdminUser && !adminLinkedToStaff) warnings.push('System administrator user is not linked to a staff record.');
    if (staffCount === 0) warnings.push('No staff records exist yet.');
    if (positionsCount === 0) warnings.push('No positions seeded.');
    if (activeModuleCount === 0) warnings.push('No active modules.');
    if (!backupConfigured) warnings.push('Backup configuration setting not recorded — confirm backup folder before going live.');
    audit(req, { action: 'view', entity: 'setup_health', newValue: { activeModuleCount, hasAdminUser, adminLinkedToStaff } });
    res.json({ hasAdminUser, adminLinkedToStaff, moduleCount, activeModuleCount, permissionRowsCount, staffCount, positionsCount, backupConfigured, warnings });
  });

  router.post('/settings/demo-data/seed', requirePermission('settings', 'create'), (req, res) => {
    audit(req, { action: 'attempt', entity: 'demo_data_seed', newValue: { note: 'demo seed disabled' } });
    res.json({ ok: false, message: 'Demo data seeding is disabled in this foundation build.' });
  });

  router.get('/common/linked-records', (req, res) => {
    const moduleKey = String(req.query.module_key ?? '').trim();
    const recordType = String(req.query.record_type ?? '').trim();
    const recordId = String(req.query.record_id ?? '').trim();
    if (!moduleKey || !recordType || !recordId) return res.status(400).json({ error: 'module_key, record_type, and record_id are required' });
    const db = getDb();
    const outgoing = db.prepare('SELECT id, source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes, created_at FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ? ORDER BY id DESC').all(moduleKey, recordType, recordId);
    const incoming = db.prepare('SELECT id, source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes, created_at FROM record_links WHERE target_module_key = ? AND target_record_type = ? AND target_record_id = ? ORDER BY id DESC').all(moduleKey, recordType, recordId);
    res.json({ outgoing, incoming });
  });

  for (const group of ['lab-profile','departments','sections','locations','authorizations','approval-routes','links','notifications','settings']) router.get(`/${group}`, (_req, res) => res.json([]));
  return router;
}
