import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getDb, closeDb, ensureDataDirs, uploadRoot, evidenceRoot, dbPath, configRoot, dataRoot } from '../db/database.js';
import { backupFolder } from '../services/backupDestinations.js';
import { config, isLanExposed, type AppMode } from '../config/index.js';
import { seedDefaults } from '../db/seed.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, viewableModulesOf } from '../middleware/permissions.js';
import { resolvePermission, explainUserAccess } from '../services/permissionResolver.js';
import { ACCESS_LEVELS, LEVEL_ACTIONS, featuresOfModule, type AccessLevel } from '../../shared/constants/features.js';
import { pendingRequests, recentRequests, decideRequest } from '../services/passwordResetService.js';
import { historicReferences, purgeDisposableRows, purgeUserEverywhere } from '../services/userReferences.js';
import { historicStaffReferences, purgeDisposableStaffRows, describeStaffReference, purgeStaffEverywhere } from '../services/staffReferences.js';
import { audit } from '../services/auditService.js';
import { mintViewTicket, VIEW_TICKET_MS } from '../services/viewTickets.js';
import { writeBackupZip, isSafeBackupName, createBackup } from '../services/backupService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable } from './routeHelpers.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';
import * as tailscale from '../services/tailscale.js';
import * as XLSX from 'xlsx';

// adm-zip is loaded lazily for the same packaging reasons as archiver above:
// it is a CommonJS module and a top-level static import breaks under app.asar.
// A dynamic import resolves the default-exported AdmZip class in dev, prod and
// packaged Electron alike. It is only needed when a restore actually runs.
async function loadAdmZip(): Promise<any> {
  const mod: any = await import('adm-zip');
  return mod.default ?? mod;
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

  router.get('/dashboard', requireAuth, (req, res) => {
    const db = getDb();
    const seen = viewableModulesOf(req);
    const only = (moduleKey: string, fields: () => Record<string, unknown>) => (seen.has(moduleKey) ? fields() : {});
    res.json({
      ...only('documents', () => ({ documents: db.prepare('SELECT COUNT(*) count FROM documents').get() })),
      ...only('actions', () => ({ actionsOpen: db.prepare("SELECT COUNT(*) count FROM actions WHERE status != 'closed'").get() })),
      ...only('personnel', () => ({ staff: db.prepare('SELECT COUNT(*) count FROM staff').get() })),
      ...only('equipment', () => ({ equipmentItems: db.prepare('SELECT COUNT(*) count FROM equipment_items').get() })),
      ...only('supplier_inventory', () => ({ inventoryItems: db.prepare('SELECT COUNT(*) count FROM inventory_items').get() })),
      ...only('monitoring', () => ({ monitoringRecords: db.prepare('SELECT COUNT(*) count FROM monitoring_records').get() })),
      ...only('facilities_safety', () => ({ safetyIncidents: db.prepare('SELECT COUNT(*) count FROM safety_incidents').get() })),
      ...only('settings', () => ({
        modulesEnabled: db.prepare('SELECT COUNT(*) count FROM system_modules WHERE enabled = 1').get(),
        latestBackup: db.prepare('SELECT file_name FROM backup_logs ORDER BY id DESC LIMIT 1').get(),
      })),
    });
  });
  router.get('/dashboard/operations-summary', requireAuth, (req, res) => {
    const db = getDb();
    const seen = viewableModulesOf(req);
    const now = new Date().toISOString();
    const expiringSoonCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const only = (moduleKey: string, fields: () => Record<string, number>) => (seen.has(moduleKey) ? fields() : {});
    res.json({
      ...only('equipment', () => ({
        equipmentTotal: count('SELECT COUNT(*) count FROM equipment_items'),
        equipmentMaintenanceDue: count('SELECT COUNT(*) count FROM equipment_items WHERE COALESCE(next_maintenance_due, next_service_due) IS NOT NULL AND COALESCE(next_maintenance_due, next_service_due) <= ?', now),
        equipmentCalibrationDue: count('SELECT COUNT(*) count FROM equipment_items WHERE COALESCE(next_calibration_due, calibration_due_date) IS NOT NULL AND COALESCE(next_calibration_due, calibration_due_date) <= ?', now),
        equipmentOutOfService: count("SELECT COUNT(*) count FROM equipment_items WHERE status IN ('out_of_service','under_repair','restricted_use')"),
      })),
      ...only('supplier_inventory', () => ({
        inventoryLowStock: count('SELECT COUNT(*) count FROM inventory_items WHERE quantity <= COALESCE(NULLIF(minimum_stock,0), reorder_level, 0)'),
        inventoryExpiringSoon: count('SELECT COUNT(*) count FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date > ? AND expiry_date <= ?', now, expiringSoonCutoff),
        inventoryExpired: count('SELECT COUNT(*) count FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date < ?', now),
      })),
      ...only('monitoring', () => ({
        monitoringWarnings: count("SELECT COUNT(*) count FROM monitoring_readings WHERE status = 'warning'"),
        monitoringCritical: count("SELECT COUNT(*) count FROM monitoring_readings WHERE status IN ('critical','out_of_range')"),
      })),
      ...only('facilities_safety', () => ({
        openSafetyIncidents: count("SELECT COUNT(*) count FROM safety_incidents WHERE status != 'closed'"),
        storageInspectionsThisMonth: count("SELECT COUNT(*) count FROM storage_inspections WHERE strftime('%Y-%m', inspection_date) = strftime('%Y-%m','now')"),
        storageInspectionsDue: count("SELECT COUNT(*) count FROM storage_inspections WHERE next_due_date IS NOT NULL AND next_due_date <= ?", now.slice(0, 10)),
        openStorageActions: count("SELECT COUNT(*) count FROM storage_inspections WHERE outcome IN ('action_required','fail') AND status != 'closed'"),
      })),
    });
  });

  // Deprecated: kept for backward compatibility. New code should use the per-module
  // summary endpoints below (/dashboard/iqc-summary etc).
  router.get('/dashboard/technical-quality-summary', requireAuth, (req, res) => {
    const db = getDb();
    const seen = viewableModulesOf(req);
    const now = new Date().toISOString();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const only = (moduleKey: string, fields: () => Record<string, number>) => (seen.has(moduleKey) ? fields() : {});
    res.json({
      ...only('iqc', () => ({
        activeIqcMaterials: count('SELECT COUNT(*) count FROM iqc_materials WHERE is_active = 1'),
        iqcFailuresThisMonth: count("SELECT COUNT(*) count FROM iqc_results WHERE status IN ('rejected','warning','out_of_control') AND run_date >= ?", monthStartIso),
        iqcResultsPendingReview: count("SELECT COUNT(*) count FROM iqc_results WHERE reviewed_at IS NULL AND status != 'accepted'"),
      })),
      ...only('eqa', () => ({
        eqaEventsDue: count('SELECT COUNT(*) count FROM eqa_events WHERE submission_due_date IS NOT NULL AND submitted_date IS NULL AND submission_due_date <= ?', now),
        eqaUnsatisfactoryEvents: count("SELECT COUNT(*) count FROM eqa_events WHERE performance_status IN ('unsatisfactory','poor','fail','failed')"),
      })),
      ...only('verification_validation', () => ({
        openVerifications: count("SELECT COUNT(*) count FROM method_verifications WHERE status IN ('planned','in_progress')"),
        equipmentVerificationsDue: count("SELECT COUNT(*) count FROM equipment_verifications WHERE status IN ('planned','in_progress')"),
      })),
      ...only('measurement_uncertainty', () => ({
        muRecordsDueForReview: count("SELECT COUNT(*) count FROM measurement_uncertainty_records WHERE status IN ('draft','in_review')"),
      })),
    });
  });

  router.get('/dashboard/iqc-summary', requirePermission('iqc', 'view'), (_req, res) => {
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

  router.get('/dashboard/eqa-summary', requirePermission('eqa', 'view'), (_req, res) => {
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

  router.get('/dashboard/verification-summary', requirePermission('verification_validation', 'view'), (_req, res) => {
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

  router.get('/dashboard/measurement-uncertainty-summary', requirePermission('measurement_uncertainty', 'view'), (_req, res) => {
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

  router.get('/dashboard/blood-bank-summary', requirePermission('blood_bank_handover', 'view'), (_req, res) => {
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

  router.get('/dashboard/monthly-reports-summary', requirePermission('monthly_reports', 'view'), (_req, res) => {
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

  router.get('/dashboard/document-control-summary', requirePermission('documents', 'view'), (_req, res) => {
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

  router.get('/dashboard/personnel-summary', requirePermission('personnel', 'view'), (_req, res) => {
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
      // Due means the person's most recent closed assessment against a scope
      // has run out and nothing is open to replace it — an earlier assessment
      // that has since been superseded is history, not a task.
      competencyAssessmentsDue: count(`SELECT COUNT(*) count FROM competency_assessments c
        WHERE c.next_assessment_due IS NOT NULL AND c.next_assessment_due <= ?
          AND c.status IN ('completed','acknowledged')
          AND c.id = (SELECT c2.id FROM competency_assessments c2
                      WHERE c2.staff_id = c.staff_id
                        AND COALESCE(CAST(c2.framework_id AS TEXT), c2.activity) = COALESCE(CAST(c.framework_id AS TEXT), c.activity)
                        AND c2.status IN ('completed','acknowledged')
                      ORDER BY c2.assessment_date DESC, c2.id DESC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM competency_assessments c3
                          WHERE c3.staff_id = c.staff_id
                            AND COALESCE(CAST(c3.framework_id AS TEXT), c3.activity) = COALESCE(CAST(c.framework_id AS TEXT), c.activity)
                            AND c3.status IN ('planned','in_progress','pending_review'))`, expiryCutoff),
      authorizationsDueReview: count("SELECT COUNT(*) count FROM technical_authorizations WHERE expires_at IS NOT NULL AND expires_at <= ? AND is_active = 1", expiryCutoff),
      rostersThisMonth: count("SELECT COUNT(*) count FROM duty_rosters WHERE roster_start_date <= ? AND roster_end_date >= ?", monthEnd, monthStart),
      totalStaff: count("SELECT COUNT(*) count FROM staff WHERE is_active = 1"),
      licencesExpiringSoon: count("SELECT COUNT(*) count FROM staff WHERE licence_expiry_date IS NOT NULL AND licence_expiry_date <= ? AND licence_expiry_date >= ?", expiryCutoff, todayIso),
      orientationsInProgress: count("SELECT COUNT(*) count FROM staff_orientations WHERE orientation_complete = 0 AND status != 'cancelled'"),
      ethicsReviewsDue: count("SELECT COUNT(*) count FROM staff_declarations WHERE next_review_date IS NOT NULL AND next_review_date <= ?", expiryCutoff),
      appraisalsThisYear: count("SELECT COUNT(*) count FROM performance_appraisals WHERE strftime('%Y', appraisal_date) = strftime('%Y','now')"),
      appraisalsDue: count(`SELECT COUNT(*) count FROM performance_appraisals a
        WHERE a.next_appraisal_due IS NOT NULL AND a.next_appraisal_due <= ?
          AND a.status IN ('completed','acknowledged')
          AND a.id = (SELECT a2.id FROM performance_appraisals a2 WHERE a2.staff_id = a.staff_id
                      AND a2.status IN ('completed','acknowledged') ORDER BY a2.appraisal_date DESC, a2.id DESC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM performance_appraisals a3 WHERE a3.staff_id = a.staff_id
                          AND a3.status IN ('draft','self_assessment','appraiser_review','pending_moderation'))`, todayIso),
      appraisalsInProgress: count("SELECT COUNT(*) count FROM performance_appraisals WHERE status IN ('self_assessment','appraiser_review','pending_moderation')")
    });
  });

  router.get('/dashboard/customer-focus-summary', requirePermission('customer_focus', 'view'), (_req, res) => {
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
        + count("SELECT COUNT(*) count FROM customer_communication_logs WHERE follow_up_due_date IS NOT NULL AND follow_up_due_date <= ? AND status != 'closed'", todayIso),
      advisoryThisMonth: count('SELECT COUNT(*) count FROM advisory_services WHERE service_date >= ?', monthStart),
      advisoryFollowUpsDue: count("SELECT COUNT(*) count FROM advisory_services WHERE follow_up_required = 1 AND follow_up_due_date IS NOT NULL AND follow_up_due_date <= ?", todayIso),
      handbookEntries: count("SELECT COUNT(*) count FROM laboratory_handbook_entries WHERE status = 'active'"),
      handbookDueReview: count("SELECT COUNT(*) count FROM laboratory_handbook_entries WHERE status = 'active' AND review_date IS NOT NULL AND review_date <= ?", todayIso)
    });
  });

  router.get('/dashboard/notifications-summary', requirePermission('notifications', 'view'), (req, res) => {
    // Reuse the central summary computation to keep numbers identical.
    // Defer the import to avoid a circular module load. Also opportunistically
    // run the throttled routed alert scan so notifications stay current as the
    // dashboards are used.
    import('../services/alertService.js').then(a => { try { a.throttledAutoScan(getDb()); } catch { /* best-effort */ } }).catch(() => {});
    import('./notifications.js').then(m => res.json(m.computeSummary(req))).catch(e => res.status(500).json({ error: (e as Error).message }));
  });

  router.get('/dashboard/records-reports-summary', requirePermission('records_reports', 'view'), (_req, res) => {
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

  router.get('/dashboard/poct-summary', requirePermission('poct', 'view'), (_req, res) => {
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

  router.get('/dashboard/information-management-summary', requirePermission('information_management', 'view'), (_req, res) => {
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

  router.get('/dashboard/process-management-summary', requirePermission('process_management', 'view'), (_req, res) => {
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
      pendingProcessReviews: count("SELECT COUNT(*) count FROM process_review_records WHERE status IN ('draft','reviewed')"),
      preExaminationInstructions: count("SELECT COUNT(*) count FROM pre_examination_instructions WHERE status = 'active'"),
      sampleReceiptsThisMonth: count("SELECT COUNT(*) count FROM sample_receipt_records WHERE receipt_date >= ?", monthStart),
      suboptimalReceipts: count("SELECT COUNT(*) count FROM sample_receipt_records WHERE condition = 'suboptimal' AND receipt_date >= ?", monthStart),
      referenceIntervalsDueReview: count("SELECT COUNT(*) count FROM reference_interval_records WHERE status = 'active' AND review_date IS NOT NULL AND review_date <= ?", today),
      comparabilityStudiesDue: count("SELECT COUNT(*) count FROM result_comparability_studies WHERE next_due_date IS NOT NULL AND next_due_date <= ?", today),
      openComparabilityIssues: count("SELECT COUNT(*) count FROM result_comparability_studies WHERE outcome = 'significant_difference' AND status != 'closed'"),
      activeContingencyPlans: count("SELECT COUNT(*) count FROM contingency_plans WHERE status = 'active'"),
      contingencyTestsDue: count("SELECT COUNT(*) count FROM contingency_plans WHERE status = 'active' AND next_test_due IS NOT NULL AND next_test_due <= ?", today)
    });
  });

  // The cross-module summaries below report on several modules at once, so
  // each field is emitted only when the caller may view the module it counts.
  // A field the caller may not see is absent rather than zero — the client
  // then leaves it out of the dashboard instead of showing a misleading 0.
  router.get('/dashboard/governance-summary', requireAuth, (req, res) => {
    const db = getDb();
    const seen = viewableModulesOf(req);
    const todayIso = new Date().toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const only = (moduleKey: string, fields: () => Record<string, number>) => (seen.has(moduleKey) ? fields() : {});
    res.json({
      ...only('assessments', () => ({
        plannedAssessments: count("SELECT COUNT(*) count FROM assessment_programs WHERE status IN ('planned','in_progress')"),
        openFindings: count("SELECT COUNT(*) count FROM assessment_findings WHERE status != 'closed'"),
      })),
      ...only('meetings', () => ({
        openMeetings: count("SELECT COUNT(*) count FROM meetings WHERE status IN ('scheduled','completed')"),
      })),
      ...only('management_review', () => ({
        pendingManagementReviews: count("SELECT COUNT(*) count FROM management_reviews WHERE status IN ('draft','inputs_collected','reviewed')"),
      })),
      ...only('quality_indicators', () => ({
        activeQualityIndicators: count("SELECT COUNT(*) count FROM quality_indicators WHERE is_active = 1"),
        criticalQualityIndicatorResults: count("SELECT COUNT(*) count FROM quality_indicator_results WHERE status = 'critical' AND (reviewed_at IS NULL OR nc_id IS NULL)"),
      })),
      ...only('continual_improvement', () => ({
        activeImprovementProjects: count("SELECT COUNT(*) count FROM improvement_projects WHERE status IN ('planned','active')"),
        overdueImprovementActions: count("SELECT COUNT(*) count FROM actions WHERE module_key = 'continual_improvement' AND status != 'Closed' AND due_date IS NOT NULL AND due_date < ?", todayIso),
      })),
    });
  });

  router.get('/dashboard/qms-summary', requireAuth, (req, res) => {
    const db = getDb();
    const seen = viewableModulesOf(req);
    const staffId = req.user?.staffId ?? null;
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const only = (moduleKey: string, fields: () => Record<string, number>) => (seen.has(moduleKey) ? fields() : {});
    res.json({
      ...only('nc_capa', () => ({
        openNCs: count("SELECT COUNT(*) count FROM nonconforming_events WHERE status != 'closed'"),
        openCAPAs: count("SELECT COUNT(*) count FROM capa_records WHERE status != 'closed'"),
      })),
      ...only('complaints', () => ({
        pendingComplaints: count("SELECT COUNT(*) count FROM complaints WHERE status != 'closed'"),
      })),
      ...only('risks', () => ({
        highRisks: count("SELECT COUNT(*) count FROM risks WHERE risk_level IN ('High','Critical') AND status != 'closed'"),
      })),
      ...only('actions', () => ({
        overdueActions: count('SELECT COUNT(*) count FROM actions WHERE due_date IS NOT NULL AND due_date < CURRENT_TIMESTAMP AND status != ?', 'Closed'),
      })),
      // Always personal to the caller, so it needs no module right.
      myAssignedActions: staffId ? count('SELECT COUNT(*) count FROM actions WHERE assigned_to_staff_id = ? AND status != ?', staffId, 'Closed') : 0,
    });
  });

  router.get('/roles', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name, description, is_system isSystem, is_administrator isAdministrator FROM roles ORDER BY name').all()));

  // ── Access profiles ──────────────────────────────────────────────────────
  // A profile IS a role: one row, one cohort, the single thing that decides
  // what a person may do before their own individual decisions are applied.
  // A laboratory has to be able to add one — "Night shift", "Locum" — without
  // reaching into the database, so the merged Access Control screen creates,
  // renames and retires them here.
  router.post('/roles', requirePermission('settings', 'create'), (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required for the access profile.' });
    const db = getDb();
    if (db.prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)').get(name)) {
      return res.status(400).json({ error: 'An access profile with that name already exists.' });
    }
    const r = db.prepare('INSERT INTO roles (name, description, is_system) VALUES (?, ?, 0)')
      .run(name, String(req.body?.description ?? '').trim() || null);
    // A new profile starts with nothing granted, stated explicitly rather than
    // left blank, so it reads as "no access" everywhere until somebody decides
    // otherwise. Least privilege is the default, not an omission.
    const id = Number(r.lastInsertRowid);
    for (const p of db.prepare('SELECT id FROM permissions').all() as { id: number }[]) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, 0, ?)').run(id, p.id, 'Access profile');
    }
    audit(req, { action: 'create', entity: 'roles', entityId: id, newValue: { name } });
    res.status(201).json({ id, name });
  });

  router.put('/roles/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id) as { id: number; name: string } | undefined;
    if (!existing) return res.status(404).json({ error: 'Access profile not found' });
    const name = String(req.body?.name ?? existing.name).trim();
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const clash = db.prepare('SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, existing.id);
    if (clash) return res.status(400).json({ error: 'Another access profile already has that name.' });
    db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?')
      .run(name, req.body?.description ?? null, existing.id);
    audit(req, { action: 'edit', entity: 'roles', entityId: existing.id, oldValue: existing, newValue: { name, description: req.body?.description ?? null } });
    res.json({ ok: true });
  });

  router.delete('/roles/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id) as
      { id: number; name: string; is_system: number; is_administrator: number } | undefined;
    if (!existing) return res.status(404).json({ error: 'Access profile not found' });
    if (existing.is_administrator === 1) return res.status(400).json({ error: 'The administrator profile cannot be removed.' });
    if (existing.is_system === 1) return res.status(400).json({ error: 'This is a built-in profile and cannot be removed.' });
    const accounts = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(existing.id) as { n: number };
    if (accounts.n > 0) return res.status(400).json({ error: `${accounts.n} account(s) still work under this profile. Move them to another one first.` });
    const positions = db.prepare('SELECT COUNT(*) AS n FROM positions WHERE access_profile_role_id = ?').get(existing.id) as { n: number };
    if (positions.n > 0) return res.status(400).json({ error: `${positions.n} organogram position(s) are mapped to this profile. Unmap them first.` });
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(existing.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(existing.id);
    audit(req, { action: 'delete', entity: 'roles', entityId: existing.id, oldValue: existing });
    res.json({ ok: true });
  });

  router.get('/users', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT u.id, u.username, u.full_name fullName, u.role_id roleId, u.staff_id staffId, s.full_name staffName, r.name roleName, u.is_active isActive, u.must_change_password mustChangePassword FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN staff s ON s.id = u.staff_id ORDER BY u.full_name').all()));
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
  // Edits an account: which staff record it belongs to, the name it signs with,
  // and the role it holds. The role is the one that moves someone between
  // cohorts — promoting a quality manager to System Administrator, standing an
  // officer down to a read-only role — so it is applied here rather than by
  // deleting and re-creating the account, which would orphan their history.
  //
  // Only the keys actually sent are touched, so the existing "link a staff
  // record" call keeps working unchanged.
  router.put('/users/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const body = req.body ?? {};
    const current = db.prepare('SELECT id, username, full_name fullName, role_id roleId, staff_id staffId, is_active isActive FROM users WHERE id = ?').get(req.params.id) as
      { id: number; username: string; fullName: string; roleId: number; staffId: number | null; isActive: number } | undefined;
    if (!current) return res.status(404).json({ error: 'User not found' });

    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: Record<string, unknown> = {};

    if ('staffId' in body) {
      const sid = idOrNull(body.staffId);
      if (sid) {
        if (!db.prepare('SELECT id FROM staff WHERE id = ?').get(sid)) return res.status(400).json({ error: 'Staff record not found.' });
        const taken = db.prepare('SELECT id, username FROM users WHERE staff_id = ? AND id != ?').get(sid, req.params.id) as { username: string } | undefined;
        if (taken) return res.status(400).json({ error: `That staff record is already linked to user “${taken.username}”. Unlink it first.` });
      }
      sets.push('staff_id = ?'); params.push(sid); changed.staffId = sid;
    }

    if ('fullName' in body) {
      const name = String(body.fullName ?? '').trim();
      if (!name) return res.status(400).json({ error: 'A full name is required.' });
      sets.push('full_name = ?'); params.push(name); changed.fullName = name;
    }

    if ('roleId' in body) {
      const roleId = idOrNull(body.roleId);
      if (!roleId) return res.status(400).json({ error: 'A role is required.' });
      const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(roleId) as { id: number; name: string } | undefined;
      if (!role) return res.status(400).json({ error: 'That role no longer exists.' });
      if (roleId !== current.roleId) {
        // A laboratory that has locked itself out of its own settings cannot be
        // repaired from inside the application, so the last administrator is
        // never allowed to move — by anyone, including themselves.
        const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'System Administrator'").get() as { id: number } | undefined;
        if (adminRole && current.roleId === adminRole.id && roleId !== adminRole.id) {
          const others = (db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND is_active = 1 AND id != ?').get(adminRole.id, current.id) as { c: number }).c;
          if (others === 0) return res.status(400).json({ error: 'This is the only active System Administrator. Give another account that role first.' });
        }
        sets.push('role_id = ?'); params.push(roleId); changed.roleId = roleId; changed.roleName = role.name;
      }
    }

    if (!sets.length) return res.json({ ok: true, changed: {} });
    db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params, req.params.id);

    // A role change rewrites what this person may reach, so the sessions they
    // are holding are ended and the new rights are picked up on next sign-in
    // rather than at some unpredictable point mid-shift.
    if (changed.roleId !== undefined) {
      db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(current.id);
    }
    audit(req, {
      action: changed.roleId !== undefined ? 'change_role' : 'link_staff',
      entity: 'users', entityId: req.params.id,
      oldValue: { staffId: current.staffId, roleId: current.roleId, fullName: current.fullName },
      newValue: changed,
    });
    res.json({ ok: true, changed });
  });

  // Administrator password reset. For when a staff member has forgotten their
  // password (there is no email-based recovery on a LAN Host): an admin sets a
  // new temporary password, hands it over, and the user changes it themselves
  // via /auth/change-password. All of the user's sessions are revoked.
  router.post('/users/:id/reset-password', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const { newPassword } = req.body ?? {};
    if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'A temporary password of at least 8 characters is required.' });
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id) as { id: number; username: string } | undefined;
    if (!user) return res.status(404).json({ error: 'User not found' });
    // The password is temporary by definition, so the account is flagged to
    // choose its own on first use rather than living on the one handed over.
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 12), user.id);
    db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").run(user.id);
    audit(req, { action: 'reset_password', entity: 'users', entityId: user.id, newValue: { username: user.username } });
    res.json({ ok: true });
  });

  // Require this person to choose a new password. They sign in with the one
  // they have and the application will not let them past the change dialog —
  // so this is for "your password must change", not "I have forgotten it".
  // Someone who cannot sign in at all needs a temporary password (above) or an
  // approved self-service request.
  router.post('/users/:id/require-password-change', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id) as { id: number; username: string } | undefined;
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET must_change_password = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    audit(req, { action: 'require_password_change', entity: 'users', entityId: user.id, newValue: { username: user.username } });
    res.json({ ok: true });
  });

  // ===== Password reset requests raised from the sign-in screen =====
  router.get('/users/password-resets', requirePermission('settings', 'edit'), (_req, res) => {
    res.json({ pending: pendingRequests(), recent: recentRequests() });
  });

  router.post('/users/password-resets/:id/decide', requirePermission('settings', 'edit'), (req, res) => {
    const { decision, note } = (req.body ?? {}) as { decision?: string; note?: string };
    if (decision !== 'approve' && decision !== 'deny') return res.status(400).json({ error: "decision must be 'approve' or 'deny'" });
    const row = decideRequest(Number(req.params.id), decision, req.user!.id, note);
    if (!row) return res.status(404).json({ error: 'That request is no longer waiting for a decision.' });
    audit(req, {
      action: decision === 'approve' ? 'approve_password_reset' : 'deny_password_reset',
      entity: 'password_reset_requests', entityId: row.id,
      newValue: { username: row.requested_username, note: note ?? null },
    });
    // Close the approver's own notification for this request.
    getDb().prepare("UPDATE notifications SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE record_type = 'password_reset_requests' AND record_id = ? AND status != 'resolved'")
      .run(String(row.id));
    res.json({ ok: true, status: row.status });
  });

  // ===== Removing an account =====
  //
  // A user is woven through the audit trail, electronic signatures and the
  // authorship of records, and an accredited laboratory may not lose any of
  // that. So deactivating is the normal answer — access ends, history stands —
  // and erasing is offered only for an account that never did anything.
  // This reports which it is, and why.
  router.get('/users/:id/deletion-impact', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username, full_name fullName, role_id roleId, is_active isActive FROM users WHERE id = ?').get(req.params.id) as
      { id: number; username: string; fullName: string; roleId: number; isActive: number } | undefined;
    if (!user) return res.status(404).json({ error: 'User not found' });

    const blockers: string[] = [];
    if (Number(req.params.id) === req.user!.id) blockers.push('This is your own account.');
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'System Administrator'").get() as { id: number } | undefined;
    if (adminRole && user.roleId === adminRole.id) {
      const others = (db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND is_active = 1 AND id != ?').get(adminRole.id, user.id) as { c: number }).c;
      if (others === 0) blockers.push('This is the only active System Administrator. Promote someone else first.');
    }

    const historic = historicReferences(user.id);

    res.json({
      user: { id: user.id, username: user.username, fullName: user.fullName, isActive: user.isActive === 1 },
      blockers,
      canDeactivate: blockers.length === 0,
      canDelete: blockers.length === 0 && historic.length === 0,
      // Offered when the refusal is history rather than a blocker (your own
      // account, the last administrator). Costs a written reason.
      canForceDelete: blockers.length === 0 && historic.length > 0,
      historicReferences: historic,
      totalHistoricRows: historic.reduce((n, r) => n + r.rows, 0),
    });
  });

  // Deactivate (default) or erase. Erasing is refused when the account left any
  // trace in the record — the client is told to deactivate instead.
  router.delete('/users/:id', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const mode = req.query.mode === 'delete' ? 'delete' : req.query.mode === 'purge' ? 'purge' : 'deactivate';
    const user = db.prepare('SELECT id, username, full_name, role_id, is_active FROM users WHERE id = ?').get(req.params.id) as
      { id: number; username: string; full_name: string; role_id: number; is_active: number } | undefined;
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.user!.id) return res.status(400).json({ error: 'You cannot remove your own account.' });

    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'System Administrator'").get() as { id: number } | undefined;
    if (adminRole && user.role_id === adminRole.id) {
      const others = (db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND is_active = 1 AND id != ?').get(adminRole.id, user.id) as { c: number }).c;
      if (others === 0) return res.status(400).json({ error: 'This is the only active System Administrator. Give another account that role first.' });
    }

    if (mode === 'deactivate') {
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(user.id);
        db.prepare("UPDATE password_reset_requests SET status = 'cancelled' WHERE user_id = ? AND status IN ('pending','approved')").run(user.id);
      });
      tx();
      audit(req, { action: 'deactivate', entity: 'users', entityId: user.id, oldValue: { isActive: 1 }, newValue: { isActive: 0, username: user.username } });
      return res.json({ ok: true, mode: 'deactivate' });
    }

    // Force erase — for a demonstration login the live system grew around.
    //
    // Same situation as the register's force erase, and the same bargain: an
    // account created to try the system out is not a person, but a month of
    // routed notifications and document distribution has accumulated against
    // it, so the ordinary rule refuses it for good.
    //
    // What it does NOT do is blank the audit trail. Columns with a declared
    // foreign key have to let go for the delete to succeed; `actor_user_id`,
    // which has none, keeps its value, so every entry the account wrote stays
    // exactly as it was and this purge record says whose id that was.
    if (mode === 'purge') {
      const reason = String((req.body ?? {}).reason ?? '').trim();
      if (reason.length < 10) {
        return res.status(400).json({ error: 'A written reason of at least 10 characters is required to erase an account the laboratory record still names.' });
      }
      const before = historicReferences(user.id).map(r => `${r.rows} × ${r.table}.${r.column}`);
      let outcome: ReturnType<typeof purgeUserEverywhere>;
      try {
        const tx = db.transaction(() => {
          outcome = purgeUserEverywhere(user.id);
          purgeDisposableRows(user.id);
          db.prepare("DELETE FROM record_links WHERE (source_record_type = 'users' AND source_record_id = ?) OR (target_record_type = 'users' AND target_record_id = ?)").run(String(user.id), String(user.id));
          db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        });
        tx();
      } catch (err) {
        return res.status(409).json({ error: err instanceof Error ? `The account could not be erased: ${err.message}` : 'The account could not be erased.' });
      }
      audit(req, {
        action: 'purge', entity: 'users', entityId: user.id,
        oldValue: { username: user.username, fullName: user.full_name, userId: user.id, referencedIn: before },
        newValue: {
          reason,
          detached: outcome!.detached.map(d => `${d.action} ${d.rows} × ${d.table}.${d.column}`),
          // Named explicitly so a later reader knows these entries were left
          // pointing at an id that no longer resolves, and whose it was.
          keptPointingAtErasedId: outcome!.keptWithId.map(k => `${k.rows} × ${k.table}.${k.column}`),
        },
      });
      return res.json({
        ok: true, mode: 'purge',
        detached: outcome!.detached.reduce((n, d) => n + d.rows, 0),
        keptWithId: outcome!.keptWithId.reduce((n, k) => n + k.rows, 0),
      });
    }

    // Permanent erase — only for an account with no laboratory history.
    const blocking = historicReferences(user.id);
    if (blocking.length) {
      return res.status(409).json({
        error: 'This account has laboratory history and cannot be erased. Deactivate it instead — access ends immediately and the record stays intact.',
        references: blocking.map(r => `${r.table} (${r.rows})`),
      });
    }

    const tx = db.transaction(() => {
      purgeDisposableRows(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    });
    tx();
    audit(req, { action: 'delete', entity: 'users', entityId: user.id, oldValue: { username: user.username, fullName: user.full_name }, newValue: null });
    res.json({ ok: true, mode: 'delete' });
  });

  // Bring a deactivated account back.
  router.post('/users/:id/reactivate', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id) as { id: number; username: string } | undefined;
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    audit(req, { action: 'reactivate', entity: 'users', entityId: user.id, newValue: { username: user.username } });
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
      ['legal_status', 'legalStatus'], ['legal_identity_notes', 'legalIdentityNotes'],
      ['quality_policy', 'qualityPolicy'], ['quality_manual_summary', 'qualityManualSummary'],
      ['mission', 'mission'], ['vision', 'vision'],
    ];
    for (const [col, key] of fields) {
      if (b[key] !== undefined) db.prepare(`UPDATE laboratory_profile SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(b[key] === '' ? null : b[key]);
    }
    // Laboratory logo — an uploaded file id (from POST /files). Cleared with null.
    if (b.logoFileId !== undefined) db.prepare('UPDATE laboratory_profile SET logo_file_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(b.logoFileId === '' || b.logoFileId === null ? null : parseIntNullable(b.logoFileId));
    if (b.registrationComplete !== undefined) db.prepare('UPDATE laboratory_profile SET registration_complete = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(b.registrationComplete ? 1 : 0);
    audit(req, { action: 'edit', entity: 'laboratory_profile', entityId: 1, newValue: b });
    res.json({ ok: true });
  });

  // Serve the laboratory logo bytes for on-screen display anywhere in the app
  // (Settings preview, headers). Any signed-in user may read it; the image is
  // also embedded as a data URI directly into printed rosters and schedules.
  router.get('/laboratory-logo', requireAuth, (_req, res) => {
    const db = getDb();
    const prof = db.prepare('SELECT logo_file_id FROM laboratory_profile WHERE id = 1').get() as { logo_file_id?: number } | undefined;
    if (!prof?.logo_file_id) return res.status(404).json({ error: 'No logo set' });
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(prof.logo_file_id) as any;
    if (!file) return res.status(404).json({ error: 'Logo file missing' });
    const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const fp = path.join(root, file.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Logo file missing' });
    res.setHeader('Content-Type', file.mime_type || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=30');
    fs.createReadStream(fp).pipe(res);
  });

  // Combined, read-only laboratory configuration for display outside Settings
  // (e.g. the Organisation module). Any signed-in user may read it; editing is
  // restricted to Settings routes below.
  router.get('/laboratory-config', requireAuth, (_req, res) => {
    const db = getDb();
    const profile = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() ?? null;
    const policies = db.prepare('SELECT * FROM quality_policies WHERE is_active = 1 ORDER BY display_order, id').all();
    const objectives = db.prepare('SELECT * FROM quality_objectives WHERE is_active = 1 ORDER BY (year IS NULL) DESC, year DESC, display_order, id').all();
    const documents = db.prepare(`SELECT d.*, f.original_name AS file_name, f.mime_type AS file_mime FROM laboratory_documents d LEFT JOIN files f ON f.id = d.file_id ORDER BY d.category, d.created_at DESC`).all();
    res.json({ profile, policies, objectives, documents });
  });

  // ---- Laboratory supporting documents (legal identity + core documents) ----
  // The three core documents are auto-registered as controlled documents so they
  // appear in the Documents & Records register without re-uploading.
  const CORE_DOC_MAP: Record<string, { type: string; prefix: string }> = {
    quality_manual: { type: 'Quality Manual', prefix: 'QM' },
    laboratory_handbook: { type: 'Handbook', prefix: 'LH' },
    safety_manual: { type: 'Safety Manual', prefix: 'SM' },
  };
  function autoRegisterCoreDocument(labDocId: number | bigint, userId: number) {
    const db = getDb();
    const d = db.prepare('SELECT * FROM laboratory_documents WHERE id = ?').get(labDocId) as any;
    if (!d) return;
    const map = CORE_DOC_MAP[d.category];
    if (!map || !d.file_id) return; // only core categories with an attached file
    const today = new Date().toISOString().slice(0, 10);
    if (d.linked_document_id) {
      const vr = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, effective_date, created_by) VALUES (?, ?, ?, ?, 'Updated from My Laboratory', 'current', ?, ?)`)
        .run(d.linked_document_id, d.version || 'updated', d.version || 'updated', d.file_id, d.effective_date || today, userId);
      db.prepare("UPDATE documents SET current_version_id = ?, status = 'current', title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(vr.lastInsertRowid), d.title, d.linked_document_id);
      return d.linked_document_id;
    }
    const rows = db.prepare('SELECT document_code FROM documents WHERE document_code LIKE ?').all(`${map.prefix}-%`) as Array<{ document_code: string }>;
    let max = 0; for (const r of rows) { const m = /(\d+)\s*$/.exec(r.document_code || ''); if (m) max = Math.max(max, Number(m[1])); }
    const code = `${map.prefix}-${String(max + 1).padStart(3, '0')}`;
    const dr = db.prepare(`INSERT INTO documents (document_code, title, document_type, status, access_level, is_controlled, created_by) VALUES (?, ?, ?, 'current', 'internal', 1, ?)`).run(code, d.title, map.type, userId);
    const docId = Number(dr.lastInsertRowid);
    const vr = db.prepare(`INSERT INTO document_versions (document_id, version_label, version_number, file_id, revision_summary, status, effective_date, created_by) VALUES (?, ?, ?, ?, 'Initial version', 'current', ?, ?)`)
      .run(docId, d.version || '1.0', d.version || '1.0', d.file_id, d.effective_date || today, userId);
    db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(Number(vr.lastInsertRowid), docId);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('documents', 'documents', String(docId), 'documents', 'files', String(d.file_id), 'Core laboratory document from My Laboratory');
    db.prepare('UPDATE laboratory_documents SET linked_document_id = ? WHERE id = ?').run(docId, labDocId);
    return docId;
  }

  // ===== Core laboratory documents =====
  //
  // A slot is a named place a laboratory expects a document to be — Quality
  // Manual, Laboratory Handbook, Safety Manual, and whatever else it calls
  // core. It points at ONE controlled document that already lives in the
  // register, so a manual is registered once and appears wherever it is
  // expected, rather than being uploaded again for each screen that wants it.
  router.get('/laboratory/core-documents', requireAuth, (_req, res) => {
    res.json(getDb().prepare(`
      SELECT s.id, s.slot_key slotKey, s.label, s.description, s.document_type documentType,
        s.document_id documentId, s.display_order displayOrder, s.is_system isSystem, s.assigned_at assignedAt,
        d.document_code documentCode, d.title documentTitle, d.status documentStatus,
        d.current_version_id currentVersionId, d.next_review_date nextReviewDate,
        v.version_number versionNumber, v.file_id fileId, f.original_name fileName, f.mime_type fileMime
      FROM core_document_slots s
      LEFT JOIN documents d ON d.id = s.document_id
      LEFT JOIN document_versions v ON v.id = d.current_version_id
      LEFT JOIN files f ON f.id = v.file_id
      ORDER BY s.display_order, s.id`).all());
  });

  // Add a slot of the laboratory's own — "Ethics Policy", "Biobank Manual",
  // whatever this laboratory treats as foundational.
  router.post('/laboratory/core-documents', requirePermission('settings', 'edit'), (req, res) => {
    const label = String(req.body?.label ?? '').trim();
    if (!label) return res.status(400).json({ error: 'A name for the core document is required.' });
    const slotKey = (String(req.body?.slotKey ?? label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `core_${Date.now()}`).slice(0, 60);
    const db = getDb();
    if (db.prepare('SELECT id FROM core_document_slots WHERE slot_key = ?').get(slotKey)) {
      return res.status(400).json({ error: 'There is already a core document with that name.' });
    }
    const order = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 n FROM core_document_slots').get() as { n: number }).n;
    const r = db.prepare('INSERT INTO core_document_slots (slot_key, label, description, document_type, display_order, is_system) VALUES (?, ?, ?, ?, ?, 0)')
      .run(slotKey, label, req.body?.description ?? null, req.body?.documentType ?? null, order);
    audit(req, { action: 'create', entity: 'core_document_slots', entityId: r.lastInsertRowid, newValue: { slotKey, label } });
    res.status(201).json({ id: Number(r.lastInsertRowid), slotKey });
  });

  router.put('/laboratory/core-documents/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const slot = db.prepare('SELECT * FROM core_document_slots WHERE id = ?').get(req.params.id) as any;
    if (!slot) return res.status(404).json({ error: 'Core document not found' });
    const sets: string[] = []; const params: unknown[] = [];
    if (req.body?.label !== undefined) {
      const label = String(req.body.label).trim();
      if (!label) return res.status(400).json({ error: 'A name is required.' });
      sets.push('label = ?'); params.push(label);
    }
    if (req.body?.description !== undefined) { sets.push('description = ?'); params.push(req.body.description || null); }
    if (req.body?.documentType !== undefined) { sets.push('document_type = ?'); params.push(req.body.documentType || null); }
    if (req.body?.displayOrder !== undefined) { sets.push('display_order = ?'); params.push(Number(req.body.displayOrder) || 0); }
    if (!sets.length) return res.json({ ok: true });
    db.prepare(`UPDATE core_document_slots SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params, slot.id);
    audit(req, { action: 'edit', entity: 'core_document_slots', entityId: slot.id, oldValue: slot, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/laboratory/core-documents/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const slot = db.prepare('SELECT * FROM core_document_slots WHERE id = ?').get(req.params.id) as any;
    if (!slot) return res.status(404).json({ error: 'Core document not found' });
    // The three standard ones stay: a laboratory without a place for its
    // quality manual is not a state worth being able to reach by accident.
    if (slot.is_system === 1) return res.status(400).json({ error: `“${slot.label}” is one of the standard core documents and cannot be removed. You can rename it, or clear the document assigned to it.` });
    if (slot.document_id) db.prepare('UPDATE documents SET core_slot_key = NULL WHERE id = ?').run(slot.document_id);
    db.prepare('DELETE FROM core_document_slots WHERE id = ?').run(slot.id);
    audit(req, { action: 'delete', entity: 'core_document_slots', entityId: slot.id, oldValue: slot });
    res.json({ ok: true });
  });

  // Point a slot at a document already in the register — the whole reason this
  // exists. `documentId: null` clears it.
  router.put('/laboratory/core-documents/:id/document', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const slot = db.prepare('SELECT * FROM core_document_slots WHERE id = ?').get(req.params.id) as any;
    if (!slot) return res.status(404).json({ error: 'Core document not found' });
    const documentId = idOrNull(req.body?.documentId);
    if (documentId) {
      const doc = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(documentId) as { id: number; title: string } | undefined;
      if (!doc) return res.status(400).json({ error: 'That document is not in the register.' });
      const taken = db.prepare('SELECT label FROM core_document_slots WHERE document_id = ? AND id != ?').get(documentId, slot.id) as { label: string } | undefined;
      if (taken) return res.status(400).json({ error: `“${doc.title}” is already the ${taken.label}. A document fills one core place at a time.` });
    }
    const tx = db.transaction(() => {
      if (slot.document_id) db.prepare('UPDATE documents SET core_slot_key = NULL WHERE id = ?').run(slot.document_id);
      db.prepare('UPDATE core_document_slots SET document_id = ?, assigned_at = CURRENT_TIMESTAMP, assigned_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(documentId, documentId ? req.user!.id : null, slot.id);
      if (documentId) db.prepare('UPDATE documents SET core_slot_key = ? WHERE id = ?').run(slot.slot_key, documentId);
    });
    tx();
    audit(req, { action: 'edit', entity: 'core_document_slots', entityId: slot.id, oldValue: { documentId: slot.document_id }, newValue: { documentId } });
    res.json({ ok: true });
  });

  router.get('/laboratory-documents', requireAuth, (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : null;
    const sql = `SELECT d.*, f.original_name AS file_name, f.mime_type AS file_mime, f.size_bytes AS file_size FROM laboratory_documents d LEFT JOIN files f ON f.id = d.file_id ${category ? 'WHERE d.category = ?' : ''} ORDER BY d.created_at DESC`;
    const rows = category ? getDb().prepare(sql).all(category) : getDb().prepare(sql).all();
    res.json(rows);
  });
  router.post('/laboratory-documents', requirePermission('settings', 'edit'), (req, res) => {
    const b = req.body ?? {};
    if (!b.category || !b.title) return res.status(400).json({ error: 'Category and title are required.' });
    const r = getDb().prepare(`INSERT INTO laboratory_documents (category, doc_type, title, file_id, reference_number, issuing_authority, issue_date, expiry_date, version, effective_date, notes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(b.category, b.docType ?? null, b.title, parseIntNullable(b.fileId), b.referenceNumber ?? null, b.issuingAuthority ?? null, b.issueDate ?? null, b.expiryDate ?? null, b.version ?? null, b.effectiveDate ?? null, b.notes ?? null, req.user!.id);
    const linkedDocumentId = autoRegisterCoreDocument(r.lastInsertRowid, req.user!.id);
    audit(req, { action: 'create', entity: 'laboratory_documents', entityId: r.lastInsertRowid, newValue: b });
    res.status(201).json({ id: r.lastInsertRowid, linkedDocumentId });
  });
  router.put('/laboratory-documents/:id', requirePermission('settings', 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [['doc_type', 'docType'], ['title', 'title'], ['file_id', 'fileId'], ['reference_number', 'referenceNumber'], ['issuing_authority', 'issuingAuthority'], ['issue_date', 'issueDate'], ['expiry_date', 'expiryDate'], ['version', 'version'], ['effective_date', 'effectiveDate'], ['notes', 'notes']];
    for (const [col, key] of fields) if (b[key] !== undefined) getDb().prepare(`UPDATE laboratory_documents SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(col === 'file_id' ? parseIntNullable(b[key]) : (b[key] === '' ? null : b[key]), req.params.id);
    // Keep the auto-registered controlled document in step (new version on file change / title update).
    if (b.fileId !== undefined || b.title !== undefined || b.version !== undefined) autoRegisterCoreDocument(Number(req.params.id), req.user!.id);
    audit(req, { action: 'edit', entity: 'laboratory_documents', entityId: req.params.id, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/laboratory-documents/:id', requirePermission('settings', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM laboratory_documents WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'laboratory_documents', entityId: req.params.id });
    res.json({ ok: true });
  });

  // ---- Quality policies ----
  router.get('/quality-policies', requireAuth, (_req, res) => res.json(getDb().prepare('SELECT * FROM quality_policies ORDER BY display_order, id').all()));
  router.post('/quality-policies', requirePermission('settings', 'edit'), (req, res) => {
    const b = req.body ?? {};
    if (!b.title || !b.policyStatement) return res.status(400).json({ error: 'Title and policy statement are required.' });
    const r = getDb().prepare('INSERT INTO quality_policies (title, policy_statement, reference_note, display_order, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(b.title, b.policyStatement, b.referenceNote ?? null, parseIntNullable(b.displayOrder) ?? 0, req.user!.id);
    audit(req, { action: 'create', entity: 'quality_policies', entityId: r.lastInsertRowid, newValue: b });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/quality-policies/:id', requirePermission('settings', 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [['title', 'title'], ['policy_statement', 'policyStatement'], ['reference_note', 'referenceNote'], ['display_order', 'displayOrder'], ['is_active', 'isActive']];
    for (const [col, key] of fields) if (b[key] !== undefined) getDb().prepare(`UPDATE quality_policies SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(col === 'is_active' ? (b[key] ? 1 : 0) : (b[key] === '' ? null : b[key]), req.params.id);
    audit(req, { action: 'edit', entity: 'quality_policies', entityId: req.params.id, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/quality-policies/:id', requirePermission('settings', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM quality_policies WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'quality_policies', entityId: req.params.id });
    res.json({ ok: true });
  });

  // ---- Quality objectives (standing when year is null; annual when set) ----
  router.get('/quality-objectives', requireAuth, (req, res) => {
    const year = req.query.year;
    if (year === 'standing') return res.json(getDb().prepare('SELECT o.*, s.full_name AS responsible_name FROM quality_objectives o LEFT JOIN staff s ON s.id = o.responsible_staff_id WHERE o.year IS NULL ORDER BY o.display_order, o.id').all());
    if (typeof year === 'string' && /^\d+$/.test(year)) return res.json(getDb().prepare('SELECT o.*, s.full_name AS responsible_name FROM quality_objectives o LEFT JOIN staff s ON s.id = o.responsible_staff_id WHERE o.year = ? ORDER BY o.display_order, o.id').all(Number(year)));
    res.json(getDb().prepare('SELECT o.*, s.full_name AS responsible_name FROM quality_objectives o LEFT JOIN staff s ON s.id = o.responsible_staff_id ORDER BY (o.year IS NULL) DESC, o.year DESC, o.display_order, o.id').all());
  });
  router.post('/quality-objectives', requirePermission('settings', 'edit'), (req, res) => {
    const b = req.body ?? {};
    if (!b.objective) return res.status(400).json({ error: 'Objective is required.' });
    const r = getDb().prepare('INSERT INTO quality_objectives (objective, target, measure, year, responsible_staff_id, status, review_notes, reference_note, display_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.objective, b.target ?? null, b.measure ?? null, parseIntNullable(b.year), parseIntNullable(b.responsibleStaffId), b.status ?? 'active', b.reviewNotes ?? null, b.referenceNote ?? null, parseIntNullable(b.displayOrder) ?? 0, req.user!.id);
    audit(req, { action: 'create', entity: 'quality_objectives', entityId: r.lastInsertRowid, newValue: b });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/quality-objectives/:id', requirePermission('settings', 'edit'), (req, res) => {
    const b = req.body ?? {};
    const fields: Array<[string, string]> = [['objective', 'objective'], ['target', 'target'], ['measure', 'measure'], ['year', 'year'], ['responsible_staff_id', 'responsibleStaffId'], ['status', 'status'], ['review_notes', 'reviewNotes'], ['reference_note', 'referenceNote'], ['display_order', 'displayOrder'], ['is_active', 'isActive']];
    for (const [col, key] of fields) {
      if (b[key] === undefined) continue;
      const val = ['year', 'responsible_staff_id', 'display_order'].includes(col) ? parseIntNullable(b[key]) : col === 'is_active' ? (b[key] ? 1 : 0) : (b[key] === '' ? null : b[key]);
      getDb().prepare(`UPDATE quality_objectives SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(val, req.params.id);
    }
    audit(req, { action: 'edit', entity: 'quality_objectives', entityId: req.params.id, newValue: b });
    res.json({ ok: true });
  });
  router.delete('/quality-objectives/:id', requirePermission('settings', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM quality_objectives WHERE id = ?').run(req.params.id);
    audit(req, { action: 'delete', entity: 'quality_objectives', entityId: req.params.id });
    res.json({ ok: true });
  });

  // The full register carries dates of birth, national identifiers, licences
  // and appointment terms. Anyone may need a colleague's NAME — to assign an
  // action, record attendance, pick a reviewer — so a minimal directory is
  // served to everyone and the full record only to the personnel register.
  // Somebody who has left the laboratory is not a colleague you can assign work
  // to, roster, or name as a reviewer — so the register serves the people who
  // are actually here, and a retired record has to be asked for by name. This
  // is what keeps former staff out of every picker in the system at once, and
  // out of the Master Personnel Register and its Excel export.
  //   (default)        active staff
  //   ?status=retired  the retired list, for the register's own Retired section
  //   ?status=all      both, for anything that genuinely needs the full history
  router.get('/staff', requirePermission('personnel.self', 'view'), (req, res) => {
    const status = String(req.query.status || 'active');
    const activeFilter = status === 'retired' ? 's.is_active = 0' : status === 'all' ? '1 = 1' : 's.is_active = 1';
    if (!resolvePermission(req.user!.id, 'personnel.register', 'view').allowed) {
      return res.json(getDb().prepare(`
        SELECT s.id, s.employee_no employeeNo, s.full_name fullName, s.section_id sectionId,
          sec.name sectionName, s.job_title jobTitle, s.designation, s.is_active isActive
        FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
        WHERE s.is_active = 1 ORDER BY s.full_name`).all());
    }
    return res.json(getDb().prepare(`
    SELECT s.id, s.employee_no employeeNo, s.full_name fullName, s.email, s.phone, s.section_id sectionId, sec.name sectionName, s.is_active isActive,
      s.surname, s.middle_name middleName, s.first_name firstName, s.initials, s.date_of_birth dateOfBirth, s.gender,
      s.designation, s.job_title jobTitle, s.professional_regulator professionalRegulator, s.professional_licence professionalLicence,
      s.licence_expiry_date licenceExpiryDate, s.qualifications, s.unit, s.personnel_category personnelCategory,
      s.appointment_type appointmentType, s.appointment_date appointmentDate, s.national_id_type nationalIdType,
      s.national_id_number nationalIdNumber, s.emergency_contact emergencyContact, s.staff_file_location staffFileLocation,
      s.cadre, s.professional_rank professionalRank, s.availability_status availabilityStatus,
      s.exit_reason exitReason, s.exit_date exitDate, s.exit_notes exitNotes, s.exit_recorded_at exitRecordedAt,
      (SELECT p.title FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = s.id AND spa.is_active = 1 ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 ELSE 1 END, spa.id LIMIT 1) primaryPosition,
      u.id userId, u.username, r.name roleName, u.is_active userActive
    FROM staff s
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN users u ON u.staff_id = s.id
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE ${activeFilter}
    ORDER BY s.is_active DESC, s.full_name`).all());
  });

  router.post('/staff', requirePermission('personnel.register', 'create'), (req, res) => {
    const cols = buildStaffColumns(req.body);
    if (!cols.full_name) return res.status(400).json({ error: 'A full name (or first name + surname) is required.' });
    const keys = Object.keys(cols);
    const r = getDb().prepare(`INSERT INTO staff (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => cols[k]));
    if (idOrNull(req.body.positionId)) getDb().prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)').run(r.lastInsertRowid, idOrNull(req.body.positionId), req.body.assignmentType ?? 'primary');
    audit(req, { action: 'create', entity: 'staff', entityId: r.lastInsertRowid, newValue: req.body });
    res.status(201).json({ id: r.lastInsertRowid });
  });
  router.put('/staff/:id', requirePermission('personnel.self', 'view'), (req, res) => {
    const existing = getDb().prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });

    // A member of staff keeps their own contact details current without being
    // handed the register. Identity, professional registration and appointment
    // terms are the employer's record of them, not theirs to rewrite, so those
    // columns still take the register's edit right — as does anyone else's row.
    const mine = Number(req.params.id) === Number(req.user?.staffId ?? -1);
    const mayEditRegister = resolvePermission(req.user!.id, 'personnel.register', 'edit').allowed;
    if (!mine && !mayEditRegister) {
      return res.status(403).json({ error: 'Permission denied', decision: { allowed: false, source: 'Denied override', reason: 'You may only change your own record.' } });
    }
    let cols = buildStaffColumns(req.body);
    if (!mayEditRegister) {
      const SELF_EDITABLE = new Set(['email', 'phone', 'emergency_contact']);
      const refused = Object.keys(cols).filter(c => !SELF_EDITABLE.has(c));
      if (refused.length) {
        return res.status(403).json({ error: 'Permission denied', decision: { allowed: false, source: 'Denied override', reason: 'You may update your contact details only. Ask the personnel office to change anything else.' } });
      }
      cols = Object.fromEntries(Object.entries(cols).filter(([c]) => SELF_EDITABLE.has(c)));
    }
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
  router.post('/staff/register', requirePermission('personnel.register', 'create'), (req, res) => {
    const db = getDb();
    const { firstName, surname, otherNames, employeeNo, fullName, email, phone, sectionId, positionIds, primaryPositionId, createUser, username, password, roleId, authorizations } = req.body as {
      firstName?: string; surname?: string; otherNames?: string;
      employeeNo?: string; fullName?: string; email?: string; phone?: string; sectionId?: number | string | null;
      positionIds?: Array<number | string>; primaryPositionId?: number | string | null;
      createUser?: boolean; username?: string; password?: string; roleId?: number | string;
      authorizations?: Array<{ moduleKey: string; sectionId?: number | string | null; level: string }>;
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

          // Registration no longer sets raw permission flags. It used to carry
          // its own action grid, which was a third place access could be
          // decided and therefore a third place it could contradict the
          // others. The new account starts on the access profile chosen above;
          // anything personal is set afterwards under Access Control →
          // Individuals, where it is visible and reversible.
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
  function buildRegisterWorkbook(includeData: boolean, population: 'active' | 'former' = 'active'): Buffer {
    const db = getDb();
    // The former-staff workbook is the register plus why each person left —
    // the three columns that turn a list of absent names into a record.
    const header = population === 'former'
      ? [...REGISTER_HEADER_ROW, 'REASON FOR LEAVING', 'DATE OF LEAVING', 'NOTES']
      : REGISTER_HEADER_ROW.slice();
    const aoa: (string | number)[][] = [header];
    if (includeData) {
      const rows = db.prepare(`
        SELECT s.*, sec.name AS section_name,
          (SELECT p.title FROM staff_position_assignments spa JOIN positions p ON p.id = spa.position_id WHERE spa.staff_id = s.id AND spa.is_active = 1 ORDER BY CASE spa.assignment_type WHEN 'primary' THEN 0 ELSE 1 END, spa.id LIMIT 1) AS position_title
        FROM staff s LEFT JOIN sections sec ON sec.id = s.section_id
        WHERE s.is_active = ${population === 'former' ? 0 : 1}
        ORDER BY ${population === 'former' ? 's.exit_date DESC, ' : ''}s.employee_no, s.full_name`).all() as any[];
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
        if (population === 'former') row.push(r.exit_reason || '', r.exit_date || '', r.exit_notes || '');
        aoa.push(row);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = header.map(h => ({ wch: Math.max(12, Math.min(40, (h || 'QUALIFICATION').length + 3)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, population === 'former' ? 'FORMER PERSONNEL' : 'MASTER PERSONNEL REGISTER');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  // Registered before '/staff/:id' so the ":id" param route does not capture these.
  router.get('/staff/template', requirePermission('personnel.register', 'export'), (_req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Staff_Register_Template.xlsx"');
    res.send(buildRegisterWorkbook(false));
  });
  // ?status=former exports the people who have left, with the reason and date
  // they left — a record a laboratory is asked for at assessment, and which the
  // register itself no longer carries.
  router.get('/staff/export', requirePermission('personnel.register', 'export'), (req, res) => {
    const former = String(req.query.status || '') === 'former' || String(req.query.status || '') === 'retired';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${former ? 'Former_Personnel' : 'Master_Personnel_Register'}-${stamp}.xlsx"`);
    res.send(buildRegisterWorkbook(true, former ? 'former' : 'active'));
  });

  // Full linkage profile for a staff member — surfaces every place the person is
  // connected across the system (login account, positions/organogram, technical
  // authorizations and section scope, and personnel activity volumes).
  router.get('/staff/:id', requirePermission('personnel.self', 'view'), (req, res) => {
    if (Number(req.params.id) !== Number(req.user?.staffId ?? -1)
      && !resolvePermission(req.user!.id, 'personnel.register', 'view').allowed) {
      return res.status(403).json({ error: 'Permission denied', decision: { allowed: false, source: 'Denied override', reason: 'You may only open your own staff record.' } });
    }
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

  router.post('/staff/:id/positions', requirePermission('personnel.register', 'edit'), (req, res) => {
    const db = getDb();
    if (!parseIntNullable(req.body.positionId)) return res.status(400).json({ error: 'positionId is required' });
    const r = db.prepare('INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, ?)')
      .run(req.params.id, Number(req.body.positionId), req.body.assignmentType ?? 'secondary');
    audit(req, { action: 'assign', entity: 'staff_position_assignments', entityId: Number(r.lastInsertRowid), newValue: { staffId: req.params.id, ...req.body } });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // ===== Removing a member of staff =====
  //
  // The register is the spine of the record: a person is the reviewer of a
  // nonconformity, the owner of a CAPA, the name on a roster. Where any of that
  // exists the record is retired, not erased — access and rosters end, the
  // history keeps naming them. A record that never did anything (a
  // demonstration row, a duplicate import) can be erased outright. This says
  // which of the two applies, and why.
  router.get('/staff/:id/deletion-impact', requirePermission('personnel.register', 'edit'), (req, res) => {
    const db = getDb();
    const staff = db.prepare('SELECT id, full_name fullName, employee_no employeeNo, is_active isActive FROM staff WHERE id = ?').get(req.params.id) as
      { id: number; fullName: string; employeeNo: string | null; isActive: number } | undefined;
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });

    const blockers: string[] = [];
    if (Number(req.params.id) === Number(req.user?.staffId ?? -1)) blockers.push('This is your own staff record.');
    const account = db.prepare('SELECT u.id, u.username, u.is_active isActive FROM users u WHERE u.staff_id = ?').get(req.params.id) as
      { id: number; username: string; isActive: number } | undefined;

    const historic = historicStaffReferences(staff.id).filter(r => r.table !== 'users');

    res.json({
      staff: { id: staff.id, fullName: staff.fullName, employeeNo: staff.employeeNo, isActive: staff.isActive === 1 },
      account: account ? { id: account.id, username: account.username, isActive: account.isActive === 1 } : null,
      blockers,
      canDeactivate: blockers.length === 0,
      canDelete: blockers.length === 0 && historic.length === 0,
      // Force erase is for a demonstration record the live system grew around.
      // It is offered whenever an ordinary erase is refused for history rather
      // than for a blocker (your own record, the last administrator), and it
      // costs a written reason.
      canForceDelete: blockers.length === 0 && historic.length > 0,
      historicReferences: historic.map(r => ({ ...r, label: describeStaffReference(r) })),
      totalHistoricRows: historic.reduce((n, r) => n + r.rows, 0),
    });
  });

  // Retire (default) or erase. Erasing is refused the moment the person left a
  // trace in the laboratory record — the client is told to retire instead.
  // A linked login account follows the staff record: retiring one deactivates
  // the account, erasing one erases the account when it too has no history.
  router.delete('/staff/:id', requirePermission('personnel.register', 'void_archive'), (req, res) => {
    const db = getDb();
    const mode = req.query.mode === 'delete' ? 'delete' : req.query.mode === 'purge' ? 'purge' : 'deactivate';
    const staff = db.prepare('SELECT id, full_name, employee_no, is_active FROM staff WHERE id = ?').get(req.params.id) as
      { id: number; full_name: string; employee_no: string | null; is_active: number } | undefined;
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });
    if (Number(staff.id) === Number(req.user?.staffId ?? -1)) return res.status(400).json({ error: 'You cannot remove your own staff record.' });
    const account = db.prepare('SELECT id, username, role_id FROM users WHERE staff_id = ?').get(staff.id) as
      { id: number; username: string; role_id: number } | undefined;

    // Never leave the laboratory without an administrator, whichever mode runs.
    if (account) {
      const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'System Administrator'").get() as { id: number } | undefined;
      if (adminRole && account.role_id === adminRole.id) {
        const others = (db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND is_active = 1 AND id != ?').get(adminRole.id, account.id) as { c: number }).c;
        if (others === 0) return res.status(400).json({ error: 'This person holds the only active System Administrator account. Give another account that role first.' });
      }
    }

    if (mode === 'deactivate') {
      // Why they left is part of the record, not a detail. "Retired" is one
      // reason among several and the register has to be able to say which.
      const body = (req.body ?? {}) as { exitReason?: string; exitDate?: string; notes?: string };
      const exitReason = String(body.exitReason ?? '').trim();
      if (!exitReason) return res.status(400).json({ error: 'A reason for leaving is required — retirement, transfer, end of contract, and so on.' });
      const exitDate = String(body.exitDate ?? '').trim() || new Date().toISOString().slice(0, 10);
      const notes = String(body.notes ?? '').trim() || null;
      const tx = db.transaction(() => {
        db.prepare(`UPDATE staff SET is_active = 0, exit_reason = ?, exit_date = ?, exit_notes = ?,
          exit_recorded_at = CURRENT_TIMESTAMP, exit_recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(exitReason, exitDate, notes, req.user!.id, staff.id);
        db.prepare("UPDATE staff_position_assignments SET is_active = 0, ends_at = CURRENT_TIMESTAMP WHERE staff_id = ? AND is_active = 1").run(staff.id);
        db.prepare('UPDATE technical_authorizations SET is_active = 0 WHERE staff_id = ? AND is_active = 1').run(staff.id);
        if (account) {
          db.prepare('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(account.id);
          db.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(account.id);
        }
      });
      tx();
      audit(req, { action: 'record_exit', entity: 'staff', entityId: staff.id, oldValue: { isActive: 1 }, newValue: { isActive: 0, fullName: staff.full_name, exitReason, exitDate, notes } });
      return res.json({ ok: true, mode: 'deactivate', exitReason, exitDate, accountDeactivated: !!account });
    }

    // Force erase — for a demonstration record the live system has grown around.
    //
    // A laboratory that set the system up with example staff and then went live
    // cannot clear them the ordinary way: a month of routed alerts, attestation
    // assignments and roster slots has accumulated against names that were
    // never people, and the "erase only what left no trace" rule refuses. This
    // cuts the record out and leaves the surrounding rows standing — every
    // column that named them is emptied, and rows that cannot exist without a
    // person go with them.
    //
    // The name disappears; the fact that it was removed does not. A reason is
    // required and the audit entry keeps the person's identity, the reason, and
    // every table touched, so the trail can still answer "what happened to this
    // record" long after the row is gone.
    if (mode === 'purge') {
      const reason = String((req.body ?? {}).reason ?? '').trim();
      if (reason.length < 10) {
        return res.status(400).json({ error: 'A written reason of at least 10 characters is required to erase a record the laboratory record still names.' });
      }
      const before = historicStaffReferences(staff.id).map(r => describeStaffReference(r));
      // A demonstration person usually came with a demonstration login. It goes
      // with them when it too has done nothing; when the account itself has
      // history it stays, unlinked, for Users & Access to deal with — an
      // account is the author of records in its own right.
      const accountIsClean = !!account && historicReferences(account.id).length === 0;
      let detached: { table: string; column: string; rows: number; action: string }[] = [];
      try {
        const tx = db.transaction(() => {
          if (account && accountIsClean) {
            purgeDisposableRows(account.id);
            db.prepare('DELETE FROM users WHERE id = ?').run(account.id);
          }
          detached = purgeStaffEverywhere(staff.id);
          db.prepare("DELETE FROM record_links WHERE (source_record_type = 'staff' AND source_record_id = ?) OR (target_record_type = 'staff' AND target_record_id = ?)").run(String(staff.id), String(staff.id));
          db.prepare('DELETE FROM staff WHERE id = ?').run(staff.id);
        });
        tx();
      } catch (err) {
        return res.status(409).json({ error: err instanceof Error ? `The record could not be erased: ${err.message}` : 'The record could not be erased.' });
      }
      audit(req, {
        action: 'purge', entity: 'staff', entityId: staff.id,
        oldValue: { fullName: staff.full_name, employeeNo: staff.employee_no, referencedIn: before },
        newValue: { reason, detached: detached.map(d => `${d.action} ${d.rows} × ${d.table}.${d.column}`) },
      });
      return res.json({
        ok: true, mode: 'purge',
        detached: detached.reduce((n, d) => n + d.rows, 0),
        tables: detached.length,
        accountDeleted: !!account && accountIsClean,
        accountUnlinked: !!account && !accountIsClean ? account.username : null,
      });
    }

    // Permanent erase — only for a record with no laboratory history.
    const blocking = historicStaffReferences(staff.id).filter(r => r.table !== 'users');
    if (blocking.length) {
      return res.status(409).json({
        error: 'This person appears in the laboratory record and cannot be erased. Retire the record instead — rosters and access end immediately and the history stays intact.',
        references: blocking.map(r => describeStaffReference(r)),
      });
    }
    // The account is erased with the record, but only when it is itself clean.
    if (account) {
      const accountHistory = historicReferences(account.id);
      if (accountHistory.length) {
        return res.status(409).json({
          error: `The login account “${account.username}” linked to this person has laboratory history and cannot be erased. Retire the record instead.`,
          references: accountHistory.map(r => `${r.table} (${r.rows})`),
        });
      }
    }

    const tx = db.transaction(() => {
      purgeDisposableStaffRows(staff.id);
      if (account) {
        purgeDisposableRows(account.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(account.id);
      }
      db.prepare("DELETE FROM record_links WHERE (source_record_type = 'staff' AND source_record_id = ?) OR (target_record_type = 'staff' AND target_record_id = ?)").run(String(staff.id), String(staff.id));
      db.prepare('DELETE FROM staff WHERE id = ?').run(staff.id);
    });
    tx();
    audit(req, { action: 'delete', entity: 'staff', entityId: staff.id, oldValue: { fullName: staff.full_name, employeeNo: staff.employee_no }, newValue: null });
    res.json({ ok: true, mode: 'delete', accountDeleted: !!account });
  });

  // Bring a retired staff record back into the register.
  router.post('/staff/:id/reactivate', requirePermission('personnel.register', 'edit'), (req, res) => {
    const db = getDb();
    const staff = db.prepare('SELECT id, full_name FROM staff WHERE id = ?').get(req.params.id) as { id: number; full_name: string } | undefined;
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });
    // Coming back means the departure did not stand, so it stops being part of
    // the current record. The audit trail keeps that it was ever recorded.
    db.prepare(`UPDATE staff SET is_active = 1, exit_reason = NULL, exit_date = NULL, exit_notes = NULL,
      exit_recorded_at = NULL, exit_recorded_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(staff.id);
    audit(req, { action: 'reactivate', entity: 'staff', entityId: staff.id, newValue: { fullName: staff.full_name } });
    res.json({ ok: true });
  });

  router.get('/system-modules', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, key, label, path, enabled, alerts_paused alertsPaused FROM system_modules ORDER BY id').all()));
  router.put('/system-modules/:key', requirePermission('settings', 'edit'), (req, res) => {
    const oldValue = getDb().prepare('SELECT * FROM system_modules WHERE key = ?').get(req.params.key);
    getDb().prepare('UPDATE system_modules SET enabled = ?, alerts_paused = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND key != ?').run(req.body.enabled ? 1 : 0, req.body.enabled ? 0 : 1, req.params.key, 'settings');
    audit(req, { action: 'edit', entity: 'system_modules', entityId: req.params.key, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // The reference data the merged Access Control screen shows alongside the
  // levels: what a permission key means, and the trail of who changed access.
  // Position permissions are gone — positions are mapped to an access profile
  // instead — so nothing here can contradict the profile any more.
  router.get('/permissions/matrix', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    res.json({
      permissions: db.prepare('SELECT * FROM permissions ORDER BY module_key, action').all(),
      rolePermissions: db.prepare('SELECT * FROM role_permissions').all(),
      positionPermissions: [],
      userOverrides: db.prepare('SELECT * FROM user_permission_overrides').all(),
      technicalAuthorizations: db.prepare(`SELECT ta.*, s.full_name AS staff_name, p.title AS position_title, sec.name AS section_name
        FROM technical_authorizations ta LEFT JOIN staff s ON s.id = ta.staff_id LEFT JOIN positions p ON p.id = ta.position_id LEFT JOIN sections sec ON sec.id = ta.section_id`).all(),
      auditHistory: db.prepare(`SELECT a.id, a.action, a.entity, a.entity_id, a.old_value, a.new_value, a.created_at, u.username AS actor_username, u.full_name AS actor_name
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.entity IN ('permissions','role_permissions','position_permissions','user_permission_overrides','technical_authorizations','positions','staff','users')
        ORDER BY a.id DESC LIMIT 100`).all()
    });
  });

  const storage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadRoot), filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)) });
  const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

  // ===== People & Access — staff Excel import (export lives near the staff routes) =====
  router.post('/staff/import', requirePermission('personnel.register', 'create'), upload.single('file'), (req, res) => {
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
          const existing = employeeNo ? db.prepare('SELECT id, full_name, is_active FROM staff WHERE employee_no = ?').get(employeeNo) as any : null;
          let staffId: number;
          // A retired record is out of the register on purpose, and the export
          // this workbook came from does not carry one — so a row matching a
          // retired Staff ID is somebody typing a number that has been retired,
          // not an update anybody meant. Say so rather than silently editing a
          // record nobody can see.
          if (existing && existing.is_active === 0) {
            result.skipped++;
            result.errors.push(`Row ${idx + 2}: “${existing.full_name}” (${employeeNo}) is retired. Restore them from the register first if this row is meant for them.`);
            return;
          }
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
  router.post('/files', requirePermission('documents.library', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const r = getDb().prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    audit(req, { action: 'create', entity: 'files', entityId: r.lastInsertRowid, newValue: { originalName: req.file.originalname, storedName: req.file.filename } });
    res.status(201).json({ id: r.lastInsertRowid, storedName: req.file.filename });
  });
  router.post('/evidence', requirePermission('records_reports.evidence', 'create'), upload.single('file'), (req, res) => {
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
  // ===== Reading a file inline, with its own name =====
  //
  // Mints the ticket; the bytes are served from an unauthenticated route (see
  // routes/fileView.ts) because the <iframe> that will ask for them cannot
  // carry this request's Authorization header. Minting is the authenticated
  // half: only somebody already allowed to read the file gets a ticket for it.
  router.post('/files/:id/view-ticket', requirePermission('documents', 'view'), (req, res) => {
    const resolved = resolveFileOnDisk(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'File not found' });
    const token = mintViewTicket(Number(req.params.id), req.user!.id);
    res.status(201).json({
      // Absolute from the site root, not from the API base: the bytes are
      // served outside /api, where no bearer token is expected.
      path: `/file-view/${token}/${encodeURIComponent(resolved.file.original_name || 'document')}`,
      expiresInMinutes: VIEW_TICKET_MS / 60000,
    });
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
  router.post('/documents/import-master-list', requirePermission('documents.masterlist', 'create'), (req, res) => { audit(req, { action: 'create', entity: 'documents', newValue: req.body }); res.json({ ok: true, message: 'MVP import placeholder accepted. CSV parsing will be implemented in the next phase.' }); });

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

  /**
   * The assignee reporting on their own action.
   *
   * Editing the action tracker is a management right: who an action is
   * assigned to, when it is due, and whether it may be closed are decisions
   * about other people's work. But the person the action was given to has to
   * be able to say "I have started this" and "I have done this" without
   * holding that right, or the tracker only ever reflects what a manager last
   * had time to type in.
   *
   * So this route is narrow on purpose. It touches one action, only if the
   * caller is the person it is assigned to, and it can move it only along the
   * doing half of the lifecycle. Verified and Closed are the verifier's words
   * and are refused here — an assignee marking their own work verified is the
   * thing an audit trail exists to prevent.
   */
  const ASSIGNEE_STATUSES = ['In progress', 'Waiting for evidence', 'Submitted for review', 'Completed'];

  router.post('/actions/:id/my-progress', requirePermission('actions', 'view'), (req, res) => {
    const db = getDb();
    const staffId = req.user?.staffId ?? null;
    if (!staffId) return res.status(400).json({ error: 'Your account is not linked to a staff record.' });
    const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id) as { id: number; assigned_to_staff_id: number | null; status: string; completion_notes: string | null } | undefined;
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (Number(action.assigned_to_staff_id) !== Number(staffId)) {
      return res.status(403).json({ error: 'You can only report progress on an action assigned to you.' });
    }
    const status = String(req.body.status ?? '');
    if (!ASSIGNEE_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Choose one of: ${ASSIGNEE_STATUSES.join(', ')}. Verifying and closing an action belong to whoever raised it.` });
    }
    const notes = req.body.completionNotes === undefined ? action.completion_notes : (String(req.body.completionNotes).trim() || null);
    db.prepare('UPDATE actions SET status = ?, completion_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, notes, action.id);
    // Clear the alerts that were chasing this person for it.
    if (status === 'Completed' && tableExists(db, 'notifications')) {
      db.prepare("UPDATE notifications SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by_staff_id = ? WHERE assigned_to_staff_id = ? AND module_key = 'actions' AND record_id = ? AND status NOT IN ('resolved','dismissed')")
        .run(staffId, staffId, String(action.id));
    }
    audit(req, { action: 'assignee_progress', entity: 'actions', entityId: action.id, oldValue: { status: action.status }, newValue: { status, completionNotes: notes } });
    res.json({ ok: true, status });
  });

  router.get('/permissions', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM permissions ORDER BY module_key, action').all()));

  // ======================================================================
  // ACCESS CONTROL — one model, two layers
  // ----------------------------------------------------------------------
  // Layer 1, the ACCESS PROFILE, is the single cohort decision: every user
  // resolves to exactly one, so two cohorts can never contradict. Layer 2,
  // the INDIVIDUAL override, supersedes it for one person.
  //
  // Everything an administrator sets goes through `/permissions/level`, which
  // writes a whole coherent position — the actions the level allows, and an
  // explicit denial of the ones it does not — rather than leaving a scatter
  // of half-set flags nobody can review.
  // ======================================================================

  /** Every permission key a level may be written against, module or feature. */
  const areaKeysFor = (permKey: string): string[] => {
    const features = featuresOfModule(permKey);
    // A module that has been split into features carries no grants of its own:
    // writing the level onto its features is what actually decides access, and
    // is what makes "no access to Personnel" hold across every tab inside it.
    return features.length ? [permKey, ...features.map(f => f.key)] : [permKey];
  };

  function writeLevel(
    scope: 'profile' | 'user',
    subjectId: number,
    permKey: string,
    level: AccessLevel,
    reason: string | null,
  ): { keys: string[]; actions: string[] } {
    const db = getDb();
    const keys = areaKeysFor(permKey);
    const granted = new Set(LEVEL_ACTIONS[level]);
    const perms = db.prepare(
      `SELECT id, module_key, action FROM permissions WHERE module_key IN (${keys.map(() => '?').join(',')})`,
    ).all(...keys) as { id: number; module_key: string; action: string }[];
    const tx = db.transaction(() => {
      for (const p of perms) {
        const allowed = granted.has(p.action) ? 1 : 0;
        if (scope === 'user') {
          db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source, reason) VALUES (?, ?, ?, ?, ?)')
            .run(subjectId, p.id, allowed, 'Individual override', reason);
        } else {
          db.prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)')
            .run(subjectId, p.id, allowed, 'Access profile');
        }
      }
    });
    tx();
    return { keys, actions: [...granted] };
  }

  function clearIndividual(userId: number, permKey: string): void {
    const db = getDb();
    const keys = areaKeysFor(permKey);
    const perms = db.prepare(
      `SELECT id FROM permissions WHERE module_key IN (${keys.map(() => '?').join(',')})`,
    ).all(...keys) as { id: number }[];
    const tx = db.transaction(() => {
      for (const p of perms) db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?').run(userId, p.id);
    });
    tx();
  }

  // Set an access LEVEL for one area.
  //
  // `scope` is 'profile' (the merged cohort — roles and the positions mapped
  // onto them) or 'user' (the individual, which supersedes). 'role' is
  // accepted as a synonym for 'profile' so older clients keep working;
  // 'position' is refused, because positions no longer carry grants of their
  // own — they are mapped to a profile instead.
  router.post('/permissions/level', requirePermission('settings', 'edit'), (req, res) => {
    const { scope: rawScope, subjectId, permKey, level, reason } = req.body ?? {};
    const scope = rawScope === 'role' ? 'profile' : rawScope;
    if (scope === 'position') {
      return res.status(400).json({
        error: 'Positions no longer hold permissions of their own. Map the position to an access profile instead (PUT /positions/:id/access-profile).',
      });
    }
    if (!['profile', 'user'].includes(scope)) return res.status(400).json({ error: "scope must be 'profile' or 'user'" });
    if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
    if (!permKey) return res.status(400).json({ error: 'permKey is required' });

    // "inherit" is only meaningful for a person: it removes their personal
    // decision so they follow their access profile again.
    if (level === 'inherit') {
      if (scope !== 'user') return res.status(400).json({ error: 'Only an individual can inherit; a profile must state a level.' });
      clearIndividual(Number(subjectId), String(permKey));
      audit(req, { action: 'clear_override', entity: 'user_permission_overrides', entityId: subjectId, newValue: { permKey } });
      return res.json({ ok: true, permKey, level: 'inherit' });
    }

    if (!ACCESS_LEVELS.includes(level)) return res.status(400).json({ error: `level must be one of: ${ACCESS_LEVELS.join(', ')}, inherit` });
    const known = getDb().prepare('SELECT 1 FROM permissions WHERE module_key = ? LIMIT 1').get(permKey);
    if (!known) return res.status(404).json({ error: `No permissions are defined for "${permKey}".` });

    const written = writeLevel(scope, Number(subjectId), String(permKey), level as AccessLevel, reason ?? null);
    audit(req, {
      action: 'set_level',
      entity: scope === 'user' ? 'user_permission_overrides' : 'role_permissions',
      entityId: subjectId,
      newValue: { permKey, level, scope, areas: written.keys },
    });
    res.json({ ok: true, permKey, level, actionsGranted: written.actions, areas: written.keys });
  });

  // One action, one area — the low-level write.
  //
  // The screens never use this: an administrator picks a LEVEL, which writes a
  // whole coherent position, because that is the thing a person can review.
  // This exists for scripted corrections and for the checks that prove the
  // engine's own invariants still hold (that `print` without `view` is
  // refused, for one). It writes to the same two tables as everything else, so
  // it cannot become a third source of truth.
  router.post('/permissions/action', requirePermission('settings', 'edit'), (req, res) => {
    const { scope: rawScope, subjectId, permKey, action, allowed, reason } = req.body ?? {};
    const scope = rawScope === 'role' ? 'profile' : rawScope;
    if (!['profile', 'user'].includes(scope)) return res.status(400).json({ error: "scope must be 'profile' or 'user'" });
    if (!subjectId || !permKey || !action) return res.status(400).json({ error: 'subjectId, permKey and action are required' });
    const db = getDb();
    const perm = db.prepare('SELECT id FROM permissions WHERE module_key = ? AND action = ?').get(permKey, action) as { id: number } | undefined;
    if (!perm) return res.status(404).json({ error: `No "${action}" permission is defined for "${permKey}".` });
    if (scope === 'user') {
      db.prepare('INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, allowed, source, reason) VALUES (?, ?, ?, ?, ?)')
        .run(Number(subjectId), perm.id, allowed ? 1 : 0, 'Individual override', reason ?? null);
    } else {
      db.prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)')
        .run(Number(subjectId), perm.id, allowed ? 1 : 0, 'Access profile');
    }
    audit(req, {
      action: 'set_action',
      entity: scope === 'user' ? 'user_permission_overrides' : 'role_permissions',
      entityId: subjectId, newValue: { permKey, action, allowed: !!allowed, scope },
    });
    res.json({ ok: true });
  });

  // Clear a person's individual decision for one area so they follow their
  // access profile again. Without this an override could only be replaced.
  router.delete('/permissions/user-override/:userId/:permKey', requirePermission('settings', 'edit'), (req, res) => {
    clearIndividual(Number(req.params.userId), req.params.permKey);
    audit(req, { action: 'clear_override', entity: 'user_permission_overrides', entityId: req.params.userId, newValue: { permKey: req.params.permKey } });
    res.json({ ok: true });
  });

  // Clear every individual decision for one person.
  router.delete('/permissions/user-override/:userId', requirePermission('settings', 'edit'), (req, res) => {
    getDb().prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(req.params.userId);
    audit(req, { action: 'clear_override', entity: 'user_permission_overrides', entityId: req.params.userId, newValue: { all: true } });
    res.json({ ok: true });
  });

  // Map an organogram position to an access profile — or unmap it. This is
  // what replaces per-position permissions: the position says which profile
  // its holders work under, and the profile says what that means.
  router.put('/positions/:id/access-profile', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const position = db.prepare('SELECT id, title, access_profile_role_id FROM positions WHERE id = ?').get(req.params.id) as
      { id: number; title: string; access_profile_role_id: number | null } | undefined;
    if (!position) return res.status(404).json({ error: 'Position not found' });
    const raw = req.body?.accessProfileId;
    const profileId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (profileId !== null) {
      const profile = db.prepare('SELECT id FROM roles WHERE id = ?').get(profileId);
      if (!profile) return res.status(404).json({ error: 'Access profile not found' });
    }
    db.prepare('UPDATE positions SET access_profile_role_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(profileId, position.id);
    audit(req, {
      action: 'edit', entity: 'positions', entityId: position.id,
      oldValue: { accessProfileId: position.access_profile_role_id }, newValue: { accessProfileId: profileId },
    });
    res.json({ ok: true });
  });

  // The catalogue the merged Access Control screen renders: every access
  // profile and the level it holds in each area, every position and the
  // profile it is mapped to, and every person's individual decisions
  // alongside the profile they would otherwise follow.
  router.get('/permissions/catalogue', requirePermission('settings', 'view'), (_req, res) => {
    const db = getDb();
    const perms = db.prepare('SELECT id, module_key, action FROM permissions').all() as { id: number; module_key: string; action: string }[];
    const byId = new Map(perms.map(p => [p.id, p]));
    const collect = (rows: { subject: number; permission_id: number; allowed: number }[]) => {
      const map: Record<string, Record<string, string[]>> = {};
      for (const r of rows) {
        if (r.allowed !== 1) continue;
        const p = byId.get(r.permission_id);
        if (!p) continue;
        ((map[String(r.subject)] ??= {})[p.module_key] ??= []).push(p.action);
      }
      return map;
    };

    const profiles = db.prepare(`
      SELECT r.id, r.name, r.description, r.is_administrator AS isAdministrator,
        (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS accountCount
      FROM roles r ORDER BY r.name
    `).all() as Array<{ id: number; name: string; description: string | null; isAdministrator: number; accountCount: number }>;

    const positions = db.prepare(`
      SELECT p.id, p.title, p.is_active AS isActive, p.access_profile_role_id AS accessProfileId,
        r.name AS accessProfileName,
        (SELECT COUNT(*) FROM staff_position_assignments spa WHERE spa.position_id = p.id AND spa.is_active = 1) AS holderCount
      FROM positions p LEFT JOIN roles r ON r.id = p.access_profile_role_id
      ORDER BY p.title
    `).all();

    res.json({
      profiles,
      positions,
      // `roles` is kept as an alias so an older client still renders.
      roles: collect(db.prepare('SELECT role_id AS subject, permission_id, allowed FROM role_permissions').all() as never),
      users: collect(db.prepare('SELECT user_id AS subject, permission_id, allowed FROM user_permission_overrides').all() as never),
      userOverrideKeys: (db.prepare('SELECT DISTINCT user_id, permission_id FROM user_permission_overrides').all() as { user_id: number; permission_id: number }[])
        .map(r => ({ userId: r.user_id, permKey: byId.get(r.permission_id)?.module_key }))
        .filter(r => r.permKey),
    });
  });

  // What one person can actually do, and why — profile level, individual
  // decision, and the effective outcome, area by area. This is what makes the
  // Individuals screen answer "why can they see that?" without guesswork.
  router.get('/permissions/effective/:userId', requirePermission('settings', 'view'), (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username, full_name AS fullName, role_id AS roleId, is_active AS isActive FROM users WHERE id = ?').get(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const explained = explainUserAccess(Number(req.params.userId));
    const profile = explained.profileId === null ? null
      : db.prepare('SELECT id, name FROM roles WHERE id = ?').get(explained.profileId);
    res.json({ user, profile, via: explained.via, positionTitle: explained.positionTitle ?? null, areas: explained.areas });
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
  router.get('/sections', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT id, name, department_id FROM sections WHERE is_active = 1 ORDER BY name').all()));

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
    const tests = db.prepare(`SELECT t.id, t.test_code, t.test_name, t.sample_type, t.method_name, t.tat_target_minutes,
        t.status, t.is_panel, t.parent_test_id, t.automation, t.equipment_id, e.name AS equipment_name
      FROM lab_test_catalog t LEFT JOIN equipment_items e ON e.id = t.equipment_id
      WHERE t.section_id = ? ORDER BY COALESCE(t.parent_test_id, t.id), t.is_panel DESC, t.test_name`).all(req.params.id);
    const equipment = db.prepare('SELECT id, equipment_number, name, category, equipment_class, equipment_category, equipment_archetype, manufacturer, model, serial_number, status FROM equipment_items WHERE section_id = ? ORDER BY name').all(req.params.id);
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
  // A test is one of two things: a single test, or a panel/profile that groups
  // component tests. Both are catalogue rows; a component points to its panel
  // through parent_test_id. Only automated / semi-automated tests carry an
  // analyser (ISO 15189:2022 §6.4 — equipment used for examinations is linked).
  const AUTOMATION = ['manual', 'semi_automated', 'automated'];
  const normAutomation = (v: unknown) => (AUTOMATION.includes(String(v)) ? String(v) : null);
  const usesEquipment = (a: string | null) => a === 'automated' || a === 'semi_automated';

  router.post('/section-config/sections/:id/tests', requirePermission('settings', 'create'), (req, res) => {
    const db = getDb();
    const section = db.prepare('SELECT department_id FROM sections WHERE id = ?').get(req.params.id) as { department_id: number | null } | undefined;
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    const deptId = section.department_id;
    const sectionId = Number(req.params.id);

    // An equipment link is only honoured when the analyser belongs to this unit
    // and is diagnostic — a fridge or a computer is never a test's analyser.
    const resolveEquipment = (equipmentId: unknown, automation: string | null): number | null => {
      const id = parseIntNullable(equipmentId);
      if (!id || !usesEquipment(automation)) return null;
      const eq = db.prepare("SELECT id FROM equipment_items WHERE id = ? AND section_id = ? AND COALESCE(equipment_archetype, equipment_category, CASE WHEN equipment_class = 'support' THEN 'support' ELSE 'analyser' END) IN ('analyser','poct')").get(id, sectionId);
      return eq ? id : null;
    };
    const insertTest = (t: Record<string, unknown>, isPanel: number, parentId: number | null) => {
      const automation = isPanel ? null : normAutomation(t.automation);
      const code = (t.testCode as string) || generateRecordNumber(db, 'lab_test_catalog', 'TEST', undefined, 'test_code');
      const r = db.prepare(`INSERT INTO lab_test_catalog (test_code, test_name, department_id, section_id, sample_type,
          container_type, minimum_volume, method_name, method_summary, equipment_id, tat_target_minutes,
          critical_result_applicable, is_panel, parent_test_id, automation, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(code, String(t.testName).trim(), deptId, sectionId, (t.sampleType as string) || null,
          (t.containerType as string) || null, (t.minimumVolume as string) || null, (t.methodName as string) || null,
          (t.methodSummary as string) || null, resolveEquipment(t.equipmentId, automation), parseIntNullable(t.tatTargetMinutes),
          t.criticalResultApplicable ? 1 : 0, isPanel, parentId, automation, (t.status as string) || 'active', req.user!.id);
      return Number(r.lastInsertRowid);
    };

    const isPanel = req.body.isPanel === true || req.body.isPanel === 'true';
    if (!req.body.testName || !String(req.body.testName).trim()) {
      return res.status(400).json({ error: isPanel ? 'A panel name is required.' : 'A test name is required.' });
    }
    const components = Array.isArray(req.body.components)
      ? req.body.components.filter((c: Record<string, unknown>) => String(c.testName ?? '').trim())
      : [];
    if (isPanel && components.length === 0) {
      return res.status(400).json({ error: 'A panel needs at least one component test.' });
    }

    let panelId = 0;
    const tx = db.transaction(() => {
      if (!isPanel) { panelId = insertTest(req.body, 0, null); return; }
      // The panel row carries the profile's own defaults; each component
      // inherits any field it leaves blank, so a shared sample type or analyser
      // is set once and cascades.
      panelId = insertTest(req.body, 1, null);
      for (const c of components as Record<string, unknown>[]) {
        insertTest({
          testName: c.testName,
          sampleType: c.sampleType || req.body.sampleType,
          methodName: c.methodName || req.body.methodName,
          automation: c.automation || req.body.automation,
          equipmentId: c.equipmentId ?? req.body.equipmentId,
          tatTargetMinutes: c.tatTargetMinutes ?? req.body.tatTargetMinutes,
        }, 0, panelId);
      }
    });
    tx();
    audit(req, { action: 'create', entity: 'lab_test_catalog', entityId: panelId, newValue: { sectionId, isPanel, components: components.length, ...req.body } });
    res.status(201).json({ id: panelId });
  });

  // Edit one test's fields (sample, method, automation, analyser, TAT).
  router.put('/section-config/tests/:testId', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT * FROM lab_test_catalog WHERE id = ?').get(req.params.testId) as Record<string, any> | undefined;
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const automation = req.body.automation === undefined ? t.automation : normAutomation(req.body.automation);
    let equipmentId = req.body.equipmentId === undefined ? t.equipment_id : parseIntNullable(req.body.equipmentId);
    if (!usesEquipment(automation)) equipmentId = null;
    else if (equipmentId) {
      const eq = db.prepare("SELECT id FROM equipment_items WHERE id = ? AND section_id = ? AND COALESCE(equipment_archetype, equipment_category, CASE WHEN equipment_class = 'support' THEN 'support' ELSE 'analyser' END) IN ('analyser','poct')").get(equipmentId, t.section_id);
      if (!eq) equipmentId = t.equipment_id && usesEquipment(automation) ? t.equipment_id : null;
    }
    db.prepare(`UPDATE lab_test_catalog SET test_name = ?, sample_type = ?, method_name = ?, automation = ?, equipment_id = ?, tat_target_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.testName?.trim() || t.test_name, req.body.sampleType ?? t.sample_type, req.body.methodName ?? t.method_name,
        automation, equipmentId, req.body.tatTargetMinutes === undefined ? t.tat_target_minutes : parseIntNullable(req.body.tatTargetMinutes), req.params.testId);
    audit(req, { action: 'edit', entity: 'lab_test_catalog', entityId: Number(req.params.testId), oldValue: t, newValue: req.body });
    res.json({ ok: true });
  });

  // Apply one or more fields to many tests at once — the "apply to all" the
  // bench asks for when a whole panel shares a sample type or moves to a new
  // analyser. Only the fields sent are touched.
  router.post('/section-config/tests/bulk-apply', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const ids = Array.isArray(req.body.testIds) ? req.body.testIds.map((x: unknown) => parseIntNullable(x)).filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Select at least one test to apply to.' });
    const f = req.body.fields ?? {};
    const setSample = f.sampleType !== undefined, setMethod = f.methodName !== undefined;
    const setAuto = f.automation !== undefined, setEquip = f.equipmentId !== undefined || setAuto;
    let updated = 0;
    const tx = db.transaction(() => {
      for (const id of ids) {
        const t = db.prepare('SELECT * FROM lab_test_catalog WHERE id = ?').get(id) as Record<string, any> | undefined;
        if (!t || t.is_panel) continue; // a panel holds no results of its own
        const automation = setAuto ? normAutomation(f.automation) : t.automation;
        let equipmentId = setEquip ? (f.equipmentId !== undefined ? parseIntNullable(f.equipmentId) : t.equipment_id) : t.equipment_id;
        if (!usesEquipment(automation)) equipmentId = null;
        else if (equipmentId && (setEquip)) {
          const eq = db.prepare("SELECT id FROM equipment_items WHERE id = ? AND section_id = ? AND COALESCE(equipment_archetype, equipment_category, CASE WHEN equipment_class = 'support' THEN 'support' ELSE 'analyser' END) IN ('analyser','poct')").get(equipmentId, t.section_id);
          if (!eq) equipmentId = t.equipment_id;
        }
        db.prepare('UPDATE lab_test_catalog SET sample_type = ?, method_name = ?, automation = ?, equipment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(setSample ? (f.sampleType || null) : t.sample_type, setMethod ? (f.methodName || null) : t.method_name, automation, equipmentId, id);
        updated++;
      }
    });
    tx();
    audit(req, { action: 'edit', entity: 'lab_test_catalog', entityId: null, newValue: { bulkApply: true, count: updated, fields: f } });
    res.json({ ok: true, updated });
  });

  // --- Test menu — Excel export / template / import (scoped to one unit) ---
  // One row per test. A row's Panel column names the profile it belongs to; a
  // blank Panel is a standalone single test. Panels are created from the
  // distinct Panel names so a whole menu — singles and grouped profiles alike —
  // imports from one flat sheet, the same shape it exports as.
  const TEST_MENU_HEADERS = ['Panel', 'Test name', 'Sample type', 'Automation', 'Analyser', 'Method', 'TAT (min)', 'Status'] as const;
  const testMenuUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

  function testMenuWorkbook(sectionId: number, withData: boolean): Buffer {
    const db = getDb();
    const rows: unknown[][] = [];
    if (withData) {
      const tests = db.prepare(`SELECT t.*, e.name AS analyser, p.test_name AS panel_name
        FROM lab_test_catalog t
        LEFT JOIN equipment_items e ON e.id = t.equipment_id
        LEFT JOIN lab_test_catalog p ON p.id = t.parent_test_id
        WHERE t.section_id = ? ORDER BY COALESCE(t.parent_test_id, t.id), t.is_panel DESC, t.test_name`).all(sectionId) as any[];
      for (const t of tests) {
        if (t.is_panel) continue; // a panel is represented by its components' Panel column
        rows.push([t.panel_name ?? '', t.test_name, t.sample_type ?? '', t.automation ?? '', t.analyser ?? '', t.method_name ?? '', t.tat_target_minutes ?? '', t.status ?? 'active']);
      }
    }
    return buildWorkbook(TEST_MENU_HEADERS, rows, 'TEST MENU');
  }
  router.get('/section-config/sections/:id/tests/template', requirePermission('settings', 'export'), (req, res) => sendWorkbook(res, testMenuWorkbook(Number(req.params.id), false), 'Test_Menu_Template.xlsx'));
  router.get('/section-config/sections/:id/tests/export', requirePermission('settings', 'export'), (req, res) => sendWorkbook(res, testMenuWorkbook(Number(req.params.id), true), 'Test_Menu.xlsx'));
  router.post('/section-config/sections/:id/tests/import', requirePermission('settings', 'create'), testMenuUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Attach the Test Menu .xlsx file.' });
    const db = getDb();
    const section = db.prepare('SELECT department_id FROM sections WHERE id = ?').get(req.params.id) as { department_id: number | null } | undefined;
    if (!section) return res.status(404).json({ error: 'Unit not found' });
    const sectionId = Number(req.params.id);
    try {
      const rows = readSheet(req.file.buffer, 'TEST');
      // The unit's diagnostic analysers, matched to the Analyser column by name.
      const analyserByName = new Map<string, number>();
      for (const e of db.prepare("SELECT id, name FROM equipment_items WHERE section_id = ? AND COALESCE(equipment_archetype, equipment_category, CASE WHEN equipment_class = 'support' THEN 'support' ELSE 'analyser' END) IN ('analyser','poct')").all(sectionId) as any[]) {
        analyserByName.set(String(e.name).trim().toLowerCase(), e.id);
      }
      const errors: string[] = []; let created = 0, updated = 0, panelsCreated = 0;
      // Panels named in the sheet, created once and reused across their rows.
      const panelId = new Map<string, number>();
      const ensurePanel = (name: string): number => {
        const key = name.toLowerCase();
        const cached = panelId.get(key);
        if (cached) return cached;
        const existing = db.prepare('SELECT id FROM lab_test_catalog WHERE section_id = ? AND is_panel = 1 AND test_name = ? COLLATE NOCASE').get(sectionId, name) as { id: number } | undefined;
        if (existing) { panelId.set(key, existing.id); return existing.id; }
        const code = generateRecordNumber(db, 'lab_test_catalog', 'TEST', undefined, 'test_code');
        const r = db.prepare('INSERT INTO lab_test_catalog (test_code, test_name, department_id, section_id, is_panel, status, created_by) VALUES (?, ?, ?, ?, 1, ?, ?)')
          .run(code, name, section.department_id, sectionId, 'active', req.user!.id);
        panelsCreated++; const id = Number(r.lastInsertRowid); panelId.set(key, id); return id;
      };
      const AUTO = ['manual', 'semi_automated', 'automated'];
      const tx = db.transaction(() => {
        rows.forEach((r, idx) => {
          const rowNo = idx + 2;
          const name = cell(r, 'Test name');
          if (!name) { errors.push(`Row ${rowNo}: Test name is required.`); return; }
          const panelName = cell(r, 'Panel');
          const parent = panelName ? ensurePanel(panelName) : null;
          let automation = String(cell(r, 'Automation') ?? '').trim().toLowerCase().replace(/[ -]/g, '_');
          if (automation && !AUTO.includes(automation)) { errors.push(`Row ${rowNo}: Automation must be one of ${AUTO.join(', ')}.`); return; }
          automation = automation || '';
          const usesEq = automation === 'automated' || automation === 'semi_automated';
          let equipmentId: number | null = null;
          const analyser = cell(r, 'Analyser');
          if (analyser && usesEq) {
            equipmentId = analyserByName.get(analyser.trim().toLowerCase()) ?? null;
            if (equipmentId === null) errors.push(`Row ${rowNo}: analyser "${analyser}" is not diagnostic equipment in this unit — left unlinked.`);
          }
          const status = /^(inactive|archived|under_review)$/i.test(String(cell(r, 'Status') ?? '')) ? String(cell(r, 'Status')).toLowerCase() : 'active';
          try {
            const existing = db.prepare('SELECT id FROM lab_test_catalog WHERE section_id = ? AND is_panel = 0 AND test_name = ? COLLATE NOCASE AND (parent_test_id IS ? OR parent_test_id = ?)')
              .get(sectionId, name, parent, parent) as { id: number } | undefined;
            if (existing) {
              db.prepare('UPDATE lab_test_catalog SET sample_type = ?, method_name = ?, automation = ?, equipment_id = ?, tat_target_minutes = ?, parent_test_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(cell(r, 'Sample type'), cell(r, 'Method'), automation || null, equipmentId, numCell(r, 'TAT (min)'), parent, status, existing.id);
              updated++;
            } else {
              const code = generateRecordNumber(db, 'lab_test_catalog', 'TEST', undefined, 'test_code');
              db.prepare('INSERT INTO lab_test_catalog (test_code, test_name, department_id, section_id, sample_type, method_name, equipment_id, tat_target_minutes, is_panel, parent_test_id, automation, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
                .run(code, name, section.department_id, sectionId, cell(r, 'Sample type'), cell(r, 'Method'), equipmentId, numCell(r, 'TAT (min)'), parent, automation || null, status, req.user!.id);
              created++;
            }
          } catch (e) { errors.push(`Row ${rowNo}: ${(e as Error).message}`); }
        });
      });
      tx();
      audit(req, { action: 'import', entity: 'lab_test_catalog', entityId: null, newValue: { sectionId, created, updated, panelsCreated, errors: errors.length } });
      res.json({ totalRows: rows.length, created, updated, panelsCreated, errors });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Remove a test or a whole panel. A test that is already cited elsewhere —
  // acceptance criteria, a reference interval, a recorded result — cannot be
  // erased without rewriting history, so it is deactivated instead and the
  // caller is told. Deleting a panel takes its components with it.
  router.delete('/section-config/tests/:testId', requirePermission('settings', 'void_archive'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT id, is_panel, test_name FROM lab_test_catalog WHERE id = ?').get(req.params.testId) as { id: number; is_panel: number; test_name: string } | undefined;
    if (!t) return res.status(404).json({ error: 'Test not found' });
    let deleted = 0, deactivated = 0;
    const removeOne = (id: number) => {
      try { db.prepare('DELETE FROM lab_test_catalog WHERE id = ?').run(id); deleted++; return true; }
      catch (e) {
        if (String((e as Error).message).includes('FOREIGN KEY')) {
          db.prepare("UPDATE lab_test_catalog SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          deactivated++; return false;
        }
        throw e;
      }
    };
    if (t.is_panel) {
      const kids = db.prepare('SELECT id FROM lab_test_catalog WHERE parent_test_id = ?').all(t.id) as { id: number }[];
      const allKidsGone = kids.map(k => removeOne(k.id)).every(Boolean);
      // The panel can only be erased once no component still points at it.
      if (allKidsGone) removeOne(t.id);
      else { db.prepare("UPDATE lab_test_catalog SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(t.id); deactivated++; }
    } else {
      removeOne(t.id);
    }
    audit(req, { action: 'delete', entity: 'lab_test_catalog', entityId: Number(req.params.testId), oldValue: t, newValue: { deleted, deactivated } });
    const message = deactivated > 0
      ? `Removed ${deleted} test(s); ${deactivated} kept as inactive because they are already used elsewhere.`
      : `"${t.test_name}"${t.is_panel ? ' and its components' : ''} removed.`;
    res.json({ ok: true, deleted, deactivated, message });
  });

  router.post('/section-config/tests/:testId/toggle', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT id, status, is_panel FROM lab_test_catalog WHERE id = ?').get(req.params.testId) as { id: number; status: string; is_panel: number } | undefined;
    if (!t) return res.status(404).json({ error: 'Test not found' });
    const next = t.status === 'active' ? 'inactive' : 'active';
    const tx = db.transaction(() => {
      db.prepare('UPDATE lab_test_catalog SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, t.id);
      // Toggling a panel carries its components with it — they are the panel.
      if (t.is_panel) db.prepare('UPDATE lab_test_catalog SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE parent_test_id = ?').run(next, t.id);
    });
    tx();
    audit(req, { action: 'edit', entity: 'lab_test_catalog', entityId: Number(req.params.testId), oldValue: { status: t.status }, newValue: { status: next } });
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
      destination: (_req, _file, cb) => { ensureDataDirs(); cb(null, backupFolder()); },
      filename: (_req, file, cb) => cb(null, `._upload-restore-${Date.now()}-${safeStoredFilename(file.originalname)}`),
    }),
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  });

  router.post('/backup/create', requirePermission('settings', 'export'), async (req, res) => {
    ensureDataDirs();
    const fileName = `sech-lims-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const fullPath = path.join(backupFolder(), fileName);
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

    // Copy it out straight away. A backup that waits on this machine until
    // somebody remembers to press a second button is only half a backup, and
    // the day it is needed is exactly the day nobody pressed it.
    let copies: Array<{ destinationName: string; ok: boolean; error?: string }> = [];
    try {
      const { copyToAll } = await import('../services/backupDestinations.js');
      copies = await copyToAll(fileName, req.user!.id);
    } catch (err) {
      console.error('[backup/create] copying to destinations failed', err);
    }

    audit(req, { action: 'create', entity: 'backup', entityId: fileName, newValue: { ...manifest, copies: copies.map(c => ({ to: c.destinationName, ok: c.ok })) } });
    res.status(201).json({ fileName, manifest, sizeBytes, location: backupFolder(), copies, downloadPath: `/backup/download/${encodeURIComponent(fileName)}` });
  });

  // List the backup ZIPs available on disk, newest first, merged with any
  // metadata recorded in backup_logs so the UI can offer download / restore.
  router.get('/backup/list', requirePermission('settings', 'view'), (_req, res) => {
    ensureDataDirs();
    const logs = getDb().prepare('SELECT file_name, created_at FROM backup_logs ORDER BY id DESC').all() as Array<{ file_name: string; created_at: string }>;
    const logByName = new Map(logs.map(l => [l.file_name, l.created_at]));
    // When each backup last reached an off-site destination, so the list can say
    // which copies exist only on this machine.
    const synced = new Map((getDb().prepare(
      "SELECT file_name, MAX(created_at) AS at FROM backup_sync_log WHERE status = 'success' GROUP BY file_name",
    ).all() as Array<{ file_name: string; at: string }>).map(r => [r.file_name, r.at]));
    const files = fs.readdirSync(backupFolder())
      .filter(f => f.toLowerCase().endsWith('.zip') && !f.startsWith('.') && !f.startsWith('_'))
      .map(f => {
        const stat = fs.statSync(path.join(backupFolder(), f));
        return {
          fileName: f,
          sizeBytes: stat.size,
          createdAt: logByName.get(f) ?? stat.mtime.toISOString(),
          source: logByName.has(f) ? 'system' : 'external',
          syncedAt: synced.get(f) ?? null,
          downloadPath: `/backup/download/${encodeURIComponent(f)}`,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ location: backupFolder(), backups: files });
  });

  // Stream a backup ZIP back to the browser for the user to save locally.
  router.get('/backup/download/:fileName', requirePermission('settings', 'export'), (req, res) => {
    const name = req.params.fileName;
    if (!isSafeBackupName(name)) return res.status(400).json({ error: 'Invalid backup file name.' });
    const full = path.join(backupFolder(), name);
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
      sourceZip = path.join(backupFolder(), req.body.fileName);
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
      const safetyPath = path.join(backupFolder(), safetyName);
      await writeBackupZip(safetyPath, { product: 'SECH_LIMS by Nickland', createdAt: new Date().toISOString(), kind: 'pre-restore-safety-snapshot' });
      safetyBackup = safetyName;
    } catch (err) {
      console.error('[backup/restore] safety snapshot failed', err);
      cleanupUpload();
      return res.status(500).json({ error: 'Could not create a pre-restore safety snapshot. Restore aborted; nothing was changed.' });
    }

    const actorId = req.user!.id;
    const tmpDir = path.join(backupFolder(), `._restore-${Date.now()}`);
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

  // Factory reset: wipe the database and all data (uploads, evidence, config) and
  // return the deployment to its first-run state (the setup wizard). This is more
  // destructive than a restore, so it is gated tightly:
  //   - the caller must be a System Administrator (not just "settings/approve");
  //   - the request body must contain the exact confirmation phrase { confirm: 'RESET' };
  //   - a full backup is ALWAYS taken first so the wipe can be undone.
  // Existing backup ZIPs are preserved (the backups folder is never cleared).
  router.post('/backup/factory-reset', requirePermission('settings', 'approve'), async (req, res) => {
    ensureDataDirs();

    // Only a System Administrator may factory-reset the system.
    const roleRow = getDb().prepare('SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(req.user!.id) as { name: string } | undefined;
    if (!roleRow || roleRow.name !== 'System Administrator') {
      return res.status(403).json({ error: 'Only a System Administrator can perform a factory reset.' });
    }

    // Require the exact confirmation phrase so a reset can never happen by accident.
    if (!req.body || req.body.confirm !== 'RESET') {
      return res.status(400).json({ error: 'Factory reset not confirmed. Type RESET to confirm.' });
    }

    const actorUsername = req.user!.username;

    // 1) Always take a full backup first so the wipe can be undone.
    let backupName: string;
    try {
      try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
      backupName = `pre-factory-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      await writeBackupZip(path.join(backupFolder(), backupName), { product: 'SECH_LIMS by Nickland', createdAt: new Date().toISOString(), kind: 'pre-factory-reset-backup' });
    } catch (err) {
      console.error('[backup/factory-reset] pre-reset backup failed', err);
      return res.status(500).json({ error: 'Could not create a pre-reset backup. Factory reset aborted; nothing was changed.' });
    }

    // 2) Wipe the database file and all data directories. Backups are preserved.
    try {
      closeDb();
      for (const ext of ['', '-wal', '-shm']) {
        const p = dbPath + ext;
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
      for (const dir of [uploadRoot, evidenceRoot, configRoot]) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error('[backup/factory-reset] wipe failed', err);
      try { getDb(); } catch { /* reopen best-effort */ }
      return res.status(500).json({ error: `Factory reset failed while clearing data. A pre-reset backup was saved as ${backupName}. See server log for details.` });
    }

    // 3) Recreate a fresh, seeded database (schema + default roles/permissions/
    //    modules). No users are created, so the app returns to first-run setup.
    try {
      getDb();        // reopens and re-migrates a blank database
      seedDefaults(); // re-seed the foundation defaults
    } catch (err) {
      console.error('[backup/factory-reset] re-initialisation failed', err);
      return res.status(500).json({ error: `Factory reset cleared the data but failed to re-initialise. A pre-reset backup was saved as ${backupName}. See server log for details.` });
    }

    // Record the event directly (the acting user no longer exists after the wipe).
    try {
      getDb().prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value) VALUES (NULL, ?, ?, ?, ?)')
        .run('factory_reset', 'backup', backupName, JSON.stringify({ backup: backupName, performedBy: actorUsername }));
    } catch { /* never block on audit */ }

    res.json({ ok: true, message: 'Factory reset complete. All data was cleared and first-time setup is required.', backup: backupName });
  });

  router.get('/audit-log', requirePermission('settings', 'view'), (_req, res) => res.json(getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all()));

  // -------- Phase 15: System health, my-work, setup health, linked records --------
  function tableExists(db: any, name: string): boolean {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  }
  function safeCount(db: any, sql: string, ...params: unknown[]): number {
    try { return (db.prepare(sql).get(...params) as { count: number }).count; } catch { return 0; }
  }

  router.get('/system/about', requireAuth, (_req, res) => {
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

  // ---------------------------------------------------------------------------
  // Connectivity & deployment mode (Phase 1 — offline-first hybrid architecture).
  //
  // Effective mode = runtime override in `settings.systemMode` (admin-settable)
  // falling back to the SECH_LIMS_MODE env deployment default. `local` keeps the
  // host fully offline; `hybrid` marks it LAN/remote-capable. Neither mode
  // affects instruments, monitoring, printers or workflows — those always run.
  // Cloud synchronization is not implemented yet; it is reported as planned.
  // ---------------------------------------------------------------------------
  function resolveMode(): { mode: AppMode; source: 'override' | 'default' } {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'systemMode'").get() as { value: string } | undefined;
    const raw = row?.value?.toLowerCase();
    if (raw === 'local' || raw === 'hybrid') return { mode: raw, source: 'override' };
    return { mode: config.mode, source: 'default' };
  }

  function lanUrls(): string[] {
    if (!isLanExposed()) return [];
    const urls: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${config.api.port}/`);
      }
    }
    return urls;
  }

  router.get('/system/connectivity', requireAuth, async (_req, res) => {
    const { mode, source } = resolveMode();
    // Whether anybody else can actually open this laboratory. Binding to
    // loopback is the default and is invisible from the outside — a browser on
    // another machine simply times out — so the host has to say so itself
    // rather than leaving somebody to infer it from a bind address.
    const reach = await tailscale.reachability({
      host: config.api.host, port: config.api.port, lanExposed: isLanExposed(),
    });
    res.json({
      mode,
      modeSource: source,
      envDefaultMode: config.mode,
      api: { host: config.api.host, port: config.api.port, publicUrl: config.api.publicUrl },
      lanExposed: isLanExposed(),
      lanReady: true,
      lanUrls: lanUrls(),
      reach,
      database: { driver: config.db.driver },
      sync: { enabled: config.sync.enabled, status: 'planned' },
      generatedAt: new Date().toISOString()
    });
  });

  router.put('/system/mode', requirePermission('settings', 'edit'), (req, res) => {
    const requested = String((req.body ?? {}).mode ?? '').toLowerCase();
    if (requested !== 'local' && requested !== 'hybrid') {
      return res.status(400).json({ error: "mode must be 'local' or 'hybrid'" });
    }
    const before = resolveMode().mode;
    getDb().prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('systemMode', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).run(requested);
    audit(req, { action: 'edit', entity: 'system_mode', entityId: 'systemMode', oldValue: before, newValue: requested });
    res.json({ ok: true, mode: requested });
  });

  router.get('/dashboard/system-health-summary', requirePermission('settings', 'view'), (_req, res) => {
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

  router.get('/dashboard/my-work-summary', requireAuth, (req, res) => {
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

  router.get('/common/linked-records', requireAuth, (req, res) => {
    const moduleKey = String(req.query.module_key ?? '').trim();
    const recordType = String(req.query.record_type ?? '').trim();
    const recordId = String(req.query.record_id ?? '').trim();
    if (!moduleKey || !recordType || !recordId) return res.status(400).json({ error: 'module_key, record_type, and record_id are required' });
    // Links point at records in other modules, so both the anchor record's
    // module and every linked module are checked before anything is returned.
    const seen = viewableModulesOf(req);
    if (!seen.has(moduleKey)) return res.status(403).json({ error: 'Permission denied', decision: { allowed: false, source: 'Denied override', reason: 'You may not view records in this module.' } });
    const db = getDb();
    const outgoing = db.prepare('SELECT id, source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes, created_at FROM record_links WHERE source_module_key = ? AND source_record_type = ? AND source_record_id = ? ORDER BY id DESC').all(moduleKey, recordType, recordId);
    const incoming = db.prepare('SELECT id, source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes, created_at FROM record_links WHERE target_module_key = ? AND target_record_type = ? AND target_record_id = ? ORDER BY id DESC').all(moduleKey, recordType, recordId);
    const visible = (r: { source_module_key: string; target_module_key: string }) => seen.has(r.source_module_key) && seen.has(r.target_module_key);
    res.json({
      outgoing: (outgoing as { source_module_key: string; target_module_key: string }[]).filter(visible),
      incoming: (incoming as { source_module_key: string; target_module_key: string }[]).filter(visible),
    });
  });

  for (const group of ['lab-profile','departments','sections','locations','authorizations','approval-routes','links','notifications','settings']) router.get(`/${group}`, (_req, res) => res.json([]));
  return router;
}
