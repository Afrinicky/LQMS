import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const UNIT_STATUSES = ['available', 'reserved', 'transfused', 'expired', 'discarded', 'quarantined', 'transferred', 'unknown'];
const SCREENING_RESULTS = ['negative', 'reactive', 'indeterminate', 'not_done', 'unknown'];
const SCREENING_STATUSES = ['complete_negative', 'incomplete', 'reactive_or_indeterminate', 'unknown'];
const DONOR_TYPES = ['family_donor', 'voluntary_donor', 'commercial_paid_donor', 'outside_campaign_donor', 'unknown'];
const COMPONENT_TYPES = ['whole_blood', 'packed_cells', 'plasma', 'platelets', 'other'];
const HANDOVER_STATUSES = ['draft', 'outgoing_signed', 'incoming_signed', 'reviewed', 'closed', 'issue_flagged'];

const EXPIRING_SOON_DAYS = 7;

function expiryStatus(expiryDate: string | null | undefined, now: Date = new Date()): 'valid' | 'expiring_soon' | 'expired' | 'unknown' {
  if (!expiryDate) return 'unknown';
  const exp = new Date(expiryDate);
  if (isNaN(exp.getTime())) return 'unknown';
  const diffDays = (exp.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (diffDays < 0) return 'expired';
  if (diffDays <= EXPIRING_SOON_DAYS) return 'expiring_soon';
  return 'valid';
}

function deriveScreeningStatus(hbsag?: string | null, hcv?: string | null, syphilis?: string | null, hiv?: string | null): string {
  const results = [hbsag, hcv, syphilis, hiv].map(r => (r || '').toLowerCase());
  if (results.some(r => r === 'reactive' || r === 'indeterminate')) return 'reactive_or_indeterminate';
  if (results.every(r => r === 'negative')) return 'complete_negative';
  if (results.some(r => r === 'not_done' || r === '')) return 'incomplete';
  return 'unknown';
}

function annotateUnit(unit: any) {
  if (!unit) return unit;
  return { ...unit, expiry_status: expiryStatus(unit.expiry_date) };
}

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null
  );
}

export function bloodBankHandoverRoutes() {
  const router = Router();

  // ============= Blood Units =============
  router.get('/units', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('current_status = ?'); params.push(String(req.query.status)); }
    if (req.query.bloodGroup) { filters.push('blood_group = ?'); params.push(String(req.query.bloodGroup)); }
    if (req.query.componentType) { filters.push('component_type = ?'); params.push(String(req.query.componentType)); }
    let query = 'SELECT * FROM blood_units';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY collection_date DESC, id DESC';
    const rows = db.prepare(query).all(...params) as any[];
    res.json(rows.map(annotateUnit));
  });

  router.post('/units', requirePermission('blood_bank_handover', 'create'), (req, res) => {
    if (!req.body.unitNumber) return res.status(400).json({ error: 'unitNumber is required' });
    if (!req.body.bloodGroup) return res.status(400).json({ error: 'bloodGroup is required' });
    if (!req.body.componentType) return res.status(400).json({ error: 'componentType is required' });
    if (!req.body.donorType) return res.status(400).json({ error: 'donorType is required' });
    if (!req.body.collectionDate) return res.status(400).json({ error: 'collectionDate is required' });
    if (!req.body.expiryDate) return res.status(400).json({ error: 'expiryDate is required' });
    if (!COMPONENT_TYPES.includes(req.body.componentType)) return res.status(400).json({ error: `componentType must be one of: ${COMPONENT_TYPES.join(', ')}` });
    if (!DONOR_TYPES.includes(req.body.donorType)) return res.status(400).json({ error: `donorType must be one of: ${DONOR_TYPES.join(', ')}` });
    for (const [field, value] of [['screeningHbsag', req.body.screeningHbsag], ['screeningHcv', req.body.screeningHcv], ['screeningSyphilis', req.body.screeningSyphilis], ['screeningHiv', req.body.screeningHiv]] as const) {
      if (value && !SCREENING_RESULTS.includes(value)) return res.status(400).json({ error: `${field} must be one of: ${SCREENING_RESULTS.join(', ')}` });
    }
    const db = getDb();
    const existing = db.prepare('SELECT id FROM blood_units WHERE unit_number = ?').get(req.body.unitNumber);
    if (existing) return res.status(400).json({ error: 'unitNumber already exists' });
    const screeningStatus = req.body.screeningStatus ?? deriveScreeningStatus(req.body.screeningHbsag, req.body.screeningHcv, req.body.screeningSyphilis, req.body.screeningHiv);
    if (screeningStatus && !SCREENING_STATUSES.includes(screeningStatus)) return res.status(400).json({ error: `screeningStatus must be one of: ${SCREENING_STATUSES.join(', ')}` });
    const currentStatus = req.body.currentStatus ?? 'available';
    if (!UNIT_STATUSES.includes(currentStatus)) return res.status(400).json({ error: `currentStatus must be one of: ${UNIT_STATUSES.join(', ')}` });
    const createdAt = new Date().toISOString();
    const result = db.prepare(`INSERT INTO blood_units (unit_number, batch_number, blood_group, component_type, donor_type, collection_date, expiry_date, screening_hbsag, screening_hcv, screening_syphilis, screening_hiv, screening_status, current_status, location_id, refrigerator_monitoring_item_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.body.unitNumber,
        req.body.batchNumber ?? null,
        req.body.bloodGroup,
        req.body.componentType,
        req.body.donorType,
        req.body.collectionDate,
        req.body.expiryDate,
        req.body.screeningHbsag ?? null,
        req.body.screeningHcv ?? null,
        req.body.screeningSyphilis ?? null,
        req.body.screeningHiv ?? null,
        screeningStatus,
        currentStatus,
        parseIntNullable(req.body.locationId),
        parseIntNullable(req.body.refrigeratorMonitoringItemId),
        req.body.notes ?? null,
        req.user!.id,
        createdAt
      );
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'blood_units', entityId: id, newValue: { unitNumber: req.body.unitNumber, ...req.body } });
    res.status(201).json({ id, unitNumber: req.body.unitNumber });
  });

  router.get('/units/:id', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const unit = db.prepare('SELECT * FROM blood_units WHERE id = ?').get(req.params.id) as any;
    if (!unit) return res.status(404).json({ error: 'Blood unit not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('blood_bank_handover', 'blood_units', String(req.params.id), 'blood_bank_handover', 'blood_units', String(req.params.id));
    res.json({ ...annotateUnit(unit), links });
  });

  router.put('/units/:id', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM blood_units WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Blood unit not found' });
    const currentStatus = req.body.currentStatus ?? oldValue.current_status;
    if (currentStatus && !UNIT_STATUSES.includes(currentStatus)) return res.status(400).json({ error: `currentStatus must be one of: ${UNIT_STATUSES.join(', ')}` });
    const screeningStatus = req.body.screeningStatus ?? deriveScreeningStatus(
      req.body.screeningHbsag ?? oldValue.screening_hbsag,
      req.body.screeningHcv ?? oldValue.screening_hcv,
      req.body.screeningSyphilis ?? oldValue.screening_syphilis,
      req.body.screeningHiv ?? oldValue.screening_hiv
    );
    db.prepare(`UPDATE blood_units SET batch_number = ?, blood_group = ?, component_type = ?, donor_type = ?, collection_date = ?, expiry_date = ?, screening_hbsag = ?, screening_hcv = ?, screening_syphilis = ?, screening_hiv = ?, screening_status = ?, current_status = ?, location_id = ?, refrigerator_monitoring_item_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.batchNumber ?? oldValue.batch_number,
        req.body.bloodGroup ?? oldValue.blood_group,
        req.body.componentType ?? oldValue.component_type,
        req.body.donorType ?? oldValue.donor_type,
        req.body.collectionDate ?? oldValue.collection_date,
        req.body.expiryDate ?? oldValue.expiry_date,
        req.body.screeningHbsag ?? oldValue.screening_hbsag,
        req.body.screeningHcv ?? oldValue.screening_hcv,
        req.body.screeningSyphilis ?? oldValue.screening_syphilis,
        req.body.screeningHiv ?? oldValue.screening_hiv,
        screeningStatus,
        currentStatus,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        parseIntNullable(req.body.refrigeratorMonitoringItemId) ?? oldValue.refrigerator_monitoring_item_id,
        req.body.notes ?? oldValue.notes,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'blood_units', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/units/:id/status', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM blood_units WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Blood unit not found' });
    const newStatus = req.body.status;
    if (!newStatus || !UNIT_STATUSES.includes(newStatus)) return res.status(400).json({ error: `status must be one of: ${UNIT_STATUSES.join(', ')}` });
    db.prepare('UPDATE blood_units SET current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
    audit(req, { action: 'status_change', entity: 'blood_units', entityId: req.params.id, oldValue: { current_status: oldValue.current_status }, newValue: { current_status: newStatus, reason: req.body.reason ?? null } });
    res.json({ ok: true });
  });

  router.post('/units/:id/discard', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required' });
    const db = getDb();
    const unit = db.prepare('SELECT * FROM blood_units WHERE id = ?').get(req.params.id) as any;
    if (!unit) return res.status(404).json({ error: 'Blood unit not found' });
    const authorizedBy = getStaffIdOrCurrent(req, req.body.authorizedByStaffId);
    const discardedBy = getStaffIdOrCurrent(req, req.body.discardedByStaffId);
    if (discardedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const discardDate = req.body.discardDate ?? new Date().toISOString().slice(0, 10);
    const result = db.prepare(`INSERT INTO blood_discards (discard_date, blood_unit_id, unit_number, blood_group, component_type, reason, authorized_by_staff_id, discarded_by_staff_id, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(discardDate, unit.id, unit.unit_number, unit.blood_group, unit.component_type, req.body.reason, authorizedBy, discardedBy, req.body.remarks ?? null, req.user!.id);
    const discardId = Number(result.lastInsertRowid);
    db.prepare("UPDATE blood_units SET current_status = 'discarded', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_units', id: unit.id }, { module: 'blood_bank_handover', type: 'blood_discards', id: discardId }, 'Discard of blood unit');
    audit(req, { action: 'discard', entity: 'blood_units', entityId: req.params.id, oldValue: { current_status: unit.current_status }, newValue: { discardId, reason: req.body.reason } });
    audit(req, { action: 'create', entity: 'blood_discards', entityId: discardId, newValue: { bloodUnitId: unit.id, ...req.body } });
    res.status(201).json({ id: discardId });
  });

  router.post('/units/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const unit = db.prepare('SELECT * FROM blood_units WHERE id = ?').get(req.params.id) as any;
    if (!unit) return res.status(404).json({ error: 'Blood unit not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        req.body.eventDate ?? createdAt.slice(0, 10),
        detectedBy,
        'blood_bank_handover',
        String(unit.id),
        req.body.title ?? `Blood unit issue: ${unit.unit_number}`,
        req.body.description ?? `Issue raised on blood unit ${unit.unit_number} (${unit.blood_group}, ${unit.component_type})`,
        req.body.category ?? 'blood_bank',
        req.body.severity ?? 'medium',
        req.body.immediateCorrection ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_units', id: unit.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from blood unit');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'blood_bank_handover', sourceRecordId: unit.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  // ============= Handovers =============
  router.get('/handovers', requirePermission('blood_bank_handover', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT h.*, so.full_name AS outgoing_staff_name, si.full_name AS incoming_staff_name, sh.full_name AS unit_head_name FROM blood_bank_handovers h LEFT JOIN staff so ON so.id = h.outgoing_staff_id LEFT JOIN staff si ON si.id = h.incoming_staff_id LEFT JOIN staff sh ON sh.id = h.blood_bank_unit_head_id ORDER BY h.handover_date DESC, h.id DESC`).all());
  });

  router.post('/handovers', requirePermission('blood_bank_handover', 'create'), (req, res) => {
    if (!req.body.handoverDate) return res.status(400).json({ error: 'handoverDate is required' });
    if (!req.body.periodStart) return res.status(400).json({ error: 'periodStart is required' });
    if (!req.body.periodEnd) return res.status(400).json({ error: 'periodEnd is required' });
    if (!parseIntNullable(req.body.outgoingStaffId)) return res.status(400).json({ error: 'outgoingStaffId is required' });
    if (!parseIntNullable(req.body.incomingStaffId)) return res.status(400).json({ error: 'incomingStaffId is required' });
    const db = getDb();
    const status = req.body.status ?? 'draft';
    if (!HANDOVER_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${HANDOVER_STATUSES.join(', ')}` });
    const createdAt = new Date().toISOString();
    const handoverNumber = generateRecordNumber(db, 'blood_bank_handovers', 'BBH', createdAt);
    const intOrZero = (v: unknown) => { const n = parseIntNullable(v); return n === null ? 0 : n; };
    const result = db.prepare(`INSERT INTO blood_bank_handovers (handover_number, handover_date, period_start, period_end, outgoing_staff_id, incoming_staff_id, blood_bank_unit_head_id, total_units_available, total_units_expiring_soon, total_units_expired, total_donations, family_donor_count, voluntary_donor_count, commercial_paid_donor_count, outside_campaign_donor_count, total_transfusions, total_discards, donor_reactions_count, transfusion_reactions_count, issues_noted, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        handoverNumber,
        req.body.handoverDate,
        req.body.periodStart,
        req.body.periodEnd,
        parseIntNullable(req.body.outgoingStaffId),
        parseIntNullable(req.body.incomingStaffId),
        parseIntNullable(req.body.bloodBankUnitHeadId),
        intOrZero(req.body.totalUnitsAvailable),
        intOrZero(req.body.totalUnitsExpiringSoon),
        intOrZero(req.body.totalUnitsExpired),
        intOrZero(req.body.totalDonations),
        intOrZero(req.body.familyDonorCount),
        intOrZero(req.body.voluntaryDonorCount),
        intOrZero(req.body.commercialPaidDonorCount),
        intOrZero(req.body.outsideCampaignDonorCount),
        intOrZero(req.body.totalTransfusions),
        intOrZero(req.body.totalDiscards),
        intOrZero(req.body.donorReactionsCount),
        intOrZero(req.body.transfusionReactionsCount),
        req.body.issuesNoted ?? null,
        status,
        req.user!.id,
        createdAt
      );
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'blood_bank_handovers', entityId: id, newValue: { handoverNumber, ...req.body } });
    res.status(201).json({ id, handoverNumber });
  });

  router.get('/handovers/:id', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const handover = db.prepare(`SELECT h.*, so.full_name AS outgoing_staff_name, si.full_name AS incoming_staff_name, sh.full_name AS unit_head_name FROM blood_bank_handovers h LEFT JOIN staff so ON so.id = h.outgoing_staff_id LEFT JOIN staff si ON si.id = h.incoming_staff_id LEFT JOIN staff sh ON sh.id = h.blood_bank_unit_head_id WHERE h.id = ?`).get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const units = db.prepare('SELECT * FROM blood_handover_units WHERE handover_id = ? ORDER BY id').all(req.params.id);
    const donations = db.prepare('SELECT * FROM blood_donation_summaries WHERE handover_id = ? ORDER BY id').all(req.params.id);
    const transfusions = db.prepare('SELECT * FROM blood_transfusion_summaries WHERE handover_id = ? ORDER BY id').all(req.params.id);
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('blood_bank_handover', 'blood_bank_handovers', String(req.params.id), 'blood_bank_handover', 'blood_bank_handovers', String(req.params.id));
    res.json({ ...handover, units, donationSummaries: donations, transfusionSummaries: transfusions, links });
  });

  router.put('/handovers/:id', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Handover not found' });
    if (req.body.status && !HANDOVER_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${HANDOVER_STATUSES.join(', ')}` });
    const intOr = (v: unknown, fallback: number) => { const n = parseIntNullable(v); return n === null ? fallback : n; };
    db.prepare(`UPDATE blood_bank_handovers SET handover_date = ?, period_start = ?, period_end = ?, outgoing_staff_id = ?, incoming_staff_id = ?, blood_bank_unit_head_id = ?, total_units_available = ?, total_units_expiring_soon = ?, total_units_expired = ?, total_donations = ?, family_donor_count = ?, voluntary_donor_count = ?, commercial_paid_donor_count = ?, outside_campaign_donor_count = ?, total_transfusions = ?, total_discards = ?, donor_reactions_count = ?, transfusion_reactions_count = ?, issues_noted = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.handoverDate ?? oldValue.handover_date,
        req.body.periodStart ?? oldValue.period_start,
        req.body.periodEnd ?? oldValue.period_end,
        parseIntNullable(req.body.outgoingStaffId) ?? oldValue.outgoing_staff_id,
        parseIntNullable(req.body.incomingStaffId) ?? oldValue.incoming_staff_id,
        parseIntNullable(req.body.bloodBankUnitHeadId) ?? oldValue.blood_bank_unit_head_id,
        intOr(req.body.totalUnitsAvailable, oldValue.total_units_available),
        intOr(req.body.totalUnitsExpiringSoon, oldValue.total_units_expiring_soon),
        intOr(req.body.totalUnitsExpired, oldValue.total_units_expired),
        intOr(req.body.totalDonations, oldValue.total_donations),
        intOr(req.body.familyDonorCount, oldValue.family_donor_count),
        intOr(req.body.voluntaryDonorCount, oldValue.voluntary_donor_count),
        intOr(req.body.commercialPaidDonorCount, oldValue.commercial_paid_donor_count),
        intOr(req.body.outsideCampaignDonorCount, oldValue.outside_campaign_donor_count),
        intOr(req.body.totalTransfusions, oldValue.total_transfusions),
        intOr(req.body.totalDiscards, oldValue.total_discards),
        intOr(req.body.donorReactionsCount, oldValue.donor_reactions_count),
        intOr(req.body.transfusionReactionsCount, oldValue.transfusion_reactions_count),
        req.body.issuesNoted ?? oldValue.issues_noted,
        req.body.status ?? oldValue.status,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'blood_bank_handovers', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/handovers/:id/add-unit', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT id FROM blood_bank_handovers WHERE id = ?').get(req.params.id);
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    let unit: any = null;
    if (parseIntNullable(req.body.bloodUnitId)) {
      unit = db.prepare('SELECT * FROM blood_units WHERE id = ?').get(parseIntNullable(req.body.bloodUnitId));
      if (!unit) return res.status(404).json({ error: 'Blood unit not found' });
    }
    const snapshot = {
      unit_number: req.body.unitNumber ?? unit?.unit_number ?? null,
      batch_number: req.body.batchNumber ?? unit?.batch_number ?? null,
      blood_group: req.body.bloodGroup ?? unit?.blood_group ?? null,
      component_type: req.body.componentType ?? unit?.component_type ?? null,
      collection_date: req.body.collectionDate ?? unit?.collection_date ?? null,
      expiry_date: req.body.expiryDate ?? unit?.expiry_date ?? null,
      screening_hbsag: req.body.screeningHbsag ?? unit?.screening_hbsag ?? null,
      screening_hcv: req.body.screeningHcv ?? unit?.screening_hcv ?? null,
      screening_syphilis: req.body.screeningSyphilis ?? unit?.screening_syphilis ?? null,
      screening_hiv: req.body.screeningHiv ?? unit?.screening_hiv ?? null,
      screening_status: req.body.screeningStatus ?? unit?.screening_status ?? null,
      unit_status_at_handover: req.body.unitStatusAtHandover ?? unit?.current_status ?? null
    };
    const result = db.prepare(`INSERT INTO blood_handover_units (handover_id, blood_unit_id, unit_number, batch_number, blood_group, component_type, collection_date, expiry_date, screening_hbsag, screening_hcv, screening_syphilis, screening_hiv, screening_status, unit_status_at_handover, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        unit?.id ?? null,
        snapshot.unit_number,
        snapshot.batch_number,
        snapshot.blood_group,
        snapshot.component_type,
        snapshot.collection_date,
        snapshot.expiry_date,
        snapshot.screening_hbsag,
        snapshot.screening_hcv,
        snapshot.screening_syphilis,
        snapshot.screening_hiv,
        snapshot.screening_status,
        snapshot.unit_status_at_handover,
        req.body.notes ?? null
      );
    const lineId = Number(result.lastInsertRowid);
    if (unit?.id) insertLink(db, { module: 'blood_bank_handover', type: 'blood_bank_handovers', id: req.params.id }, { module: 'blood_bank_handover', type: 'blood_units', id: unit.id }, 'Unit included in handover');
    audit(req, { action: 'add_unit', entity: 'blood_bank_handovers', entityId: req.params.id, newValue: { lineId, bloodUnitId: unit?.id, ...req.body } });
    res.status(201).json({ id: lineId });
  });

  router.post('/handovers/:id/sign-outgoing', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.outgoingStaffId ?? handover.outgoing_staff_id);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE blood_bank_handovers SET outgoing_staff_id = ?, outgoing_staff_signed_at = CURRENT_TIMESTAMP, status = CASE WHEN status = 'draft' THEN 'outgoing_signed' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'sign_outgoing', entity: 'blood_bank_handovers', entityId: req.params.id, oldValue: { outgoing_staff_signed_at: handover.outgoing_staff_signed_at }, newValue: { outgoingStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/handovers/:id/sign-incoming', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.incomingStaffId ?? handover.incoming_staff_id);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE blood_bank_handovers SET incoming_staff_id = ?, incoming_staff_signed_at = CURRENT_TIMESTAMP, status = CASE WHEN status IN ('draft','outgoing_signed') THEN 'incoming_signed' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'sign_incoming', entity: 'blood_bank_handovers', entityId: req.params.id, oldValue: { incoming_staff_signed_at: handover.incoming_staff_signed_at }, newValue: { incomingStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/handovers/:id/review', requirePermission('blood_bank_handover', 'approve'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.bloodBankUnitHeadId ?? handover.blood_bank_unit_head_id);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE blood_bank_handovers SET blood_bank_unit_head_id = ?, unit_head_reviewed_at = CURRENT_TIMESTAMP, status = 'reviewed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'blood_bank_handovers', entityId: req.params.id, oldValue: { status: handover.status }, newValue: { bloodBankUnitHeadId: staffId, status: 'reviewed' } });
    res.json({ ok: true });
  });

  router.post('/handovers/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const result = db.prepare(`INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.body.title,
        'blood_bank_handover',
        'blood_bank_handover',
        String(req.params.id),
        req.body.description ?? handover.issues_noted ?? null,
        req.body.priority ?? 'normal',
        parseIntNullable(req.body.assignedToStaffId),
        req.body.dueDate ?? null,
        'Not started',
        req.body.evidenceRequired ? 1 : 0,
        req.user!.id
      );
    const actionId = Number(result.lastInsertRowid);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_bank_handovers', id: req.params.id }, { module: 'actions', type: 'actions', id: actionId }, 'Action from handover');
    audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { ...req.body, sourceModule: 'blood_bank_handover', sourceRecordId: req.params.id } });
    res.status(201).json({ id: actionId });
  });

  router.post('/handovers/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? handover.outgoing_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        handover.handover_date,
        detectedBy,
        'blood_bank_handover',
        String(handover.id),
        req.body.title ?? `Issue on handover ${handover.handover_number}`,
        req.body.description ?? handover.issues_noted ?? `Issue raised on blood bank handover ${handover.handover_number}`,
        req.body.category ?? 'blood_bank',
        req.body.severity ?? 'medium',
        req.body.immediateCorrection ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare("UPDATE blood_bank_handovers SET status = 'issue_flagged', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_bank_handovers', id: handover.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from handover');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'blood_bank_handover', sourceRecordId: handover.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/handovers/:id/close', requirePermission('blood_bank_handover', 'approve'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    db.prepare("UPDATE blood_bank_handovers SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'blood_bank_handovers', entityId: req.params.id, oldValue: { status: handover.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  router.post('/handovers/:id/donation-summary', requirePermission('blood_bank_handover', 'create'), (req, res) => {
    if (!req.body.summaryDate) return res.status(400).json({ error: 'summaryDate is required' });
    const db = getDb();
    const handover = db.prepare('SELECT id FROM blood_bank_handovers WHERE id = ?').get(req.params.id);
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const intOr = (v: unknown) => { const n = parseIntNullable(v); return n === null ? 0 : n; };
    const result = db.prepare(`INSERT INTO blood_donation_summaries (summary_date, handover_id, donor_type, number_screened, number_accepted, number_deferred, number_collected, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.summaryDate, req.params.id, req.body.donorType ?? null, intOr(req.body.numberScreened), intOr(req.body.numberAccepted), intOr(req.body.numberDeferred), intOr(req.body.numberCollected), req.body.remarks ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'blood_donation_summaries', entityId: id, newValue: { handoverId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.post('/handovers/:id/transfusion-summary', requirePermission('blood_bank_handover', 'create'), (req, res) => {
    if (!req.body.summaryDate) return res.status(400).json({ error: 'summaryDate is required' });
    const db = getDb();
    const handover = db.prepare('SELECT id FROM blood_bank_handovers WHERE id = ?').get(req.params.id);
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const intOr = (v: unknown) => { const n = parseIntNullable(v); return n === null ? 0 : n; };
    const result = db.prepare(`INSERT INTO blood_transfusion_summaries (summary_date, handover_id, blood_group, component_type, number_transfused, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.body.summaryDate, req.params.id, req.body.bloodGroup ?? null, req.body.componentType ?? null, intOr(req.body.numberTransfused), req.body.remarks ?? null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'blood_transfusion_summaries', entityId: id, newValue: { handoverId: req.params.id, ...req.body } });
    res.status(201).json({ id });
  });

  router.get('/handovers/:id/activity-summary', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const handover = db.prepare('SELECT * FROM blood_bank_handovers WHERE id = ?').get(req.params.id) as any;
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    const donations = db.prepare('SELECT donor_type, SUM(number_screened) AS screened, SUM(number_accepted) AS accepted, SUM(number_deferred) AS deferred, SUM(number_collected) AS collected FROM blood_donation_summaries WHERE handover_id = ? GROUP BY donor_type').all(req.params.id);
    const transfusions = db.prepare('SELECT blood_group, component_type, SUM(number_transfused) AS transfused FROM blood_transfusion_summaries WHERE handover_id = ? GROUP BY blood_group, component_type').all(req.params.id);
    const discards = db.prepare('SELECT COUNT(*) AS count FROM blood_discards WHERE discard_date BETWEEN ? AND ?').get(handover.period_start, handover.period_end) as { count: number };
    const adverseEvents = db.prepare("SELECT event_type, COUNT(*) AS count FROM blood_adverse_events WHERE event_date BETWEEN ? AND ? GROUP BY event_type").all(handover.period_start, handover.period_end);
    res.json({ handoverId: Number(req.params.id), donations, transfusions, discards: discards.count, adverseEvents });
  });

  // ============= Donation Campaigns =============
  router.get('/campaigns', requirePermission('blood_bank_handover', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT c.*, s.full_name AS responsible_staff_name FROM blood_donation_campaigns c LEFT JOIN staff s ON s.id = c.responsible_staff_id ORDER BY c.campaign_date DESC, c.id DESC`).all());
  });

  router.post('/campaigns', requirePermission('blood_bank_handover', 'create'), (req, res) => {
    if (!req.body.campaignDate) return res.status(400).json({ error: 'campaignDate is required' });
    if (!req.body.location) return res.status(400).json({ error: 'location is required' });
    if (req.body.totalScreened === undefined || req.body.totalScreened === null || req.body.totalScreened === '') return res.status(400).json({ error: 'totalScreened is required' });
    if (req.body.totalCollected === undefined || req.body.totalCollected === null || req.body.totalCollected === '') return res.status(400).json({ error: 'totalCollected is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const campaignNumber = generateRecordNumber(db, 'blood_donation_campaigns', 'BBCAMP', createdAt);
    const intOr = (v: unknown) => { const n = parseIntNullable(v); return n === null ? 0 : n; };
    const result = db.prepare(`INSERT INTO blood_donation_campaigns (campaign_number, campaign_date, location, organizer, total_screened, total_collected, family_donor_count, voluntary_donor_count, commercial_paid_donor_count, rejected_or_deferred_count, remarks, responsible_staff_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        campaignNumber,
        req.body.campaignDate,
        req.body.location,
        req.body.organizer ?? null,
        intOr(req.body.totalScreened),
        intOr(req.body.totalCollected),
        intOr(req.body.familyDonorCount),
        intOr(req.body.voluntaryDonorCount),
        intOr(req.body.commercialPaidDonorCount),
        intOr(req.body.rejectedOrDeferredCount),
        req.body.remarks ?? null,
        parseIntNullable(req.body.responsibleStaffId),
        req.user!.id,
        createdAt
      );
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'blood_donation_campaigns', entityId: id, newValue: { campaignNumber, ...req.body } });
    res.status(201).json({ id, campaignNumber });
  });

  router.get('/campaigns/:id', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const record = db.prepare(`SELECT c.*, s.full_name AS responsible_staff_name FROM blood_donation_campaigns c LEFT JOIN staff s ON s.id = c.responsible_staff_id WHERE c.id = ?`).get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Donation campaign not found' });
    res.json(record);
  });

  router.put('/campaigns/:id', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM blood_donation_campaigns WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Donation campaign not found' });
    const intOr = (v: unknown, fallback: number) => { const n = parseIntNullable(v); return n === null ? fallback : n; };
    db.prepare(`UPDATE blood_donation_campaigns SET campaign_date = ?, location = ?, organizer = ?, total_screened = ?, total_collected = ?, family_donor_count = ?, voluntary_donor_count = ?, commercial_paid_donor_count = ?, rejected_or_deferred_count = ?, remarks = ?, responsible_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.campaignDate ?? oldValue.campaign_date,
        req.body.location ?? oldValue.location,
        req.body.organizer ?? oldValue.organizer,
        intOr(req.body.totalScreened, oldValue.total_screened),
        intOr(req.body.totalCollected, oldValue.total_collected),
        intOr(req.body.familyDonorCount, oldValue.family_donor_count),
        intOr(req.body.voluntaryDonorCount, oldValue.voluntary_donor_count),
        intOr(req.body.commercialPaidDonorCount, oldValue.commercial_paid_donor_count),
        intOr(req.body.rejectedOrDeferredCount, oldValue.rejected_or_deferred_count),
        req.body.remarks ?? oldValue.remarks,
        parseIntNullable(req.body.responsibleStaffId) ?? oldValue.responsible_staff_id,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'blood_donation_campaigns', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // ============= Adverse Events =============
  router.get('/adverse-events', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (req.query.status) { filters.push('e.status = ?'); params.push(String(req.query.status)); }
    if (req.query.eventType) { filters.push('e.event_type = ?'); params.push(String(req.query.eventType)); }
    let query = `SELECT e.*, s.full_name AS reported_by_name, u.unit_number AS related_unit_number FROM blood_adverse_events e LEFT JOIN staff s ON s.id = e.reported_by_staff_id LEFT JOIN blood_units u ON u.id = e.related_unit_id`;
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY e.event_date DESC, e.id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/adverse-events', requirePermission('blood_bank_handover', 'create'), (req, res) => {
    if (!req.body.eventDate) return res.status(400).json({ error: 'eventDate is required' });
    if (!req.body.eventType) return res.status(400).json({ error: 'eventType is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    if (!req.body.severity) return res.status(400).json({ error: 'severity is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const eventNumber = generateRecordNumber(db, 'blood_adverse_events', 'BBAE', createdAt);
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const result = db.prepare(`INSERT INTO blood_adverse_events (event_number, event_date, event_type, related_unit_id, blood_group, donor_type, department_id, section_id, location_id, reported_by_staff_id, title, description, immediate_action, severity, outcome, investigation_summary, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        eventNumber,
        req.body.eventDate,
        req.body.eventType,
        parseIntNullable(req.body.relatedUnitId),
        req.body.bloodGroup ?? null,
        req.body.donorType ?? null,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        parseIntNullable(req.body.locationId),
        reportedBy,
        req.body.title,
        req.body.description,
        req.body.immediateAction ?? null,
        req.body.severity,
        req.body.outcome ?? null,
        req.body.investigationSummary ?? null,
        req.body.status ?? 'open',
        req.user!.id,
        createdAt
      );
    const id = Number(result.lastInsertRowid);
    if (parseIntNullable(req.body.relatedUnitId)) {
      insertLink(db, { module: 'blood_bank_handover', type: 'blood_units', id: parseIntNullable(req.body.relatedUnitId)! }, { module: 'blood_bank_handover', type: 'blood_adverse_events', id }, 'Adverse event linked to unit');
    }
    audit(req, { action: 'create', entity: 'blood_adverse_events', entityId: id, newValue: { eventNumber, ...req.body } });
    res.status(201).json({ id, eventNumber });
  });

  router.get('/adverse-events/:id', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const event = db.prepare(`SELECT e.*, s.full_name AS reported_by_name, u.unit_number AS related_unit_number FROM blood_adverse_events e LEFT JOIN staff s ON s.id = e.reported_by_staff_id LEFT JOIN blood_units u ON u.id = e.related_unit_id WHERE e.id = ?`).get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Adverse event not found' });
    const links = db.prepare('SELECT * FROM record_links WHERE (source_module_key = ? AND source_record_type = ? AND source_record_id = ?) OR (target_module_key = ? AND target_record_type = ? AND target_record_id = ?)')
      .all('blood_bank_handover', 'blood_adverse_events', String(req.params.id), 'blood_bank_handover', 'blood_adverse_events', String(req.params.id));
    res.json({ ...event, links });
  });

  router.put('/adverse-events/:id', requirePermission('blood_bank_handover', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM blood_adverse_events WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Adverse event not found' });
    db.prepare(`UPDATE blood_adverse_events SET event_date = ?, event_type = ?, related_unit_id = ?, blood_group = ?, donor_type = ?, department_id = ?, section_id = ?, location_id = ?, title = ?, description = ?, immediate_action = ?, severity = ?, outcome = ?, investigation_summary = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.eventDate ?? oldValue.event_date,
        req.body.eventType ?? oldValue.event_type,
        parseIntNullable(req.body.relatedUnitId) ?? oldValue.related_unit_id,
        req.body.bloodGroup ?? oldValue.blood_group,
        req.body.donorType ?? oldValue.donor_type,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        req.body.title ?? oldValue.title,
        req.body.description ?? oldValue.description,
        req.body.immediateAction ?? oldValue.immediate_action,
        req.body.severity ?? oldValue.severity,
        req.body.outcome ?? oldValue.outcome,
        req.body.investigationSummary ?? oldValue.investigation_summary,
        req.body.status ?? oldValue.status,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'blood_adverse_events', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/adverse-events/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM blood_adverse_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Adverse event not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId ?? event.reported_by_staff_id);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ncNumber, event.event_date, detectedBy, 'blood_bank_handover', String(event.id), req.body.title ?? event.title, req.body.description ?? event.description, req.body.category ?? 'blood_bank_adverse', req.body.severity ?? event.severity ?? 'medium', req.body.immediateCorrection ?? event.immediate_action ?? null, 'open', req.user!.id, createdAt);
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('UPDATE blood_adverse_events SET nc_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ncId, req.params.id);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_adverse_events', id: event.id }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, 'NC from blood bank adverse event');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'blood_bank_handover', sourceRecordId: event.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/adverse-events/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM blood_adverse_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Adverse event not found' });
    const createdAt = new Date().toISOString();
    const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
    const capaResult = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, responsible_staff_id, due_date, priority, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(capaNumber, 'blood_bank_handover', String(event.id), event.nc_id ?? null, req.body.title ?? `CAPA for ${event.title}`, req.body.problemSummary ?? event.description, parseIntNullable(req.body.responsibleStaffId), req.body.dueDate ?? null, req.body.priority ?? 'normal', 'open', req.user!.id, createdAt);
    const capaId = Number(capaResult.lastInsertRowid);
    db.prepare('UPDATE blood_adverse_events SET capa_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(capaId, req.params.id);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_adverse_events', id: event.id }, { module: 'nc_capa', type: 'capa_records', id: capaId }, 'CAPA from blood bank adverse event');
    audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'blood_bank_handover', sourceRecordId: event.id } });
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/adverse-events/:id/create-safety-incident', requirePermission('facilities_safety', 'create'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM blood_adverse_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Adverse event not found' });
    const createdAt = new Date().toISOString();
    const incidentNumber = generateRecordNumber(db, 'safety_incidents', 'SAF', createdAt);
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId ?? event.reported_by_staff_id);
    const result = db.prepare(`INSERT INTO safety_incidents (incident_number, incident_date, location_id, department_id, section_id, reported_by_staff_id, description, category, severity, status, incident_type, title, immediate_action, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        incidentNumber,
        event.event_date,
        event.location_id,
        event.department_id,
        event.section_id,
        reportedBy,
        event.description,
        req.body.category ?? 'blood_bank_adverse',
        event.severity ?? 'medium',
        'open',
        req.body.incidentType ?? event.event_type,
        req.body.title ?? event.title,
        event.immediate_action,
        req.user!.id,
        createdAt
      );
    const incidentId = Number(result.lastInsertRowid);
    db.prepare('UPDATE blood_adverse_events SET safety_incident_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(incidentId, req.params.id);
    insertLink(db, { module: 'blood_bank_handover', type: 'blood_adverse_events', id: event.id }, { module: 'facilities_safety', type: 'safety_incidents', id: incidentId }, 'Safety incident from blood bank adverse event');
    audit(req, { action: 'create', entity: 'safety_incidents', entityId: incidentId, newValue: { incidentNumber, sourceModule: 'blood_bank_handover', sourceRecordId: event.id } });
    res.status(201).json({ id: incidentId, incidentNumber });
  });

  router.post('/adverse-events/:id/close', requirePermission('blood_bank_handover', 'approve'), (req, res) => {
    const db = getDb();
    const event = db.prepare('SELECT * FROM blood_adverse_events WHERE id = ?').get(req.params.id) as any;
    if (!event) return res.status(404).json({ error: 'Adverse event not found' });
    const closedBy = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    if (closedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE blood_adverse_events SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, outcome = COALESCE(?, outcome), investigation_summary = COALESCE(?, investigation_summary), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(closedBy, req.body.outcome ?? null, req.body.investigationSummary ?? null, req.params.id);
    audit(req, { action: 'close', entity: 'blood_adverse_events', entityId: req.params.id, oldValue: { status: event.status }, newValue: { status: 'closed', closedByStaffId: closedBy } });
    res.json({ ok: true });
  });

  // ============= Monthly Summary =============
  router.get('/monthly-summary', requirePermission('blood_bank_handover', 'view'), (req, res) => {
    const db = getDb();
    const monthArg = (typeof req.query.month === 'string' ? req.query.month : '') || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(monthArg)) return res.status(400).json({ error: 'month must be in YYYY-MM format' });
    const [year, monthIdx] = monthArg.split('-').map(Number);
    const periodStart = new Date(Date.UTC(year, monthIdx - 1, 1));
    const periodEnd = new Date(Date.UTC(year, monthIdx, 1));
    const monthEndIso = new Date(periodEnd.getTime() - 1).toISOString();
    const monthStartDate = periodStart.toISOString().slice(0, 10);
    const monthEndDate = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const expiringSoon = new Date(periodEnd.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const unitsAtMonthEnd = count("SELECT COUNT(*) count FROM blood_units WHERE created_at <= ? AND current_status = 'available' AND expiry_date > ?", monthEndIso, monthEndIso);
    const unitsExpiringSoon = count("SELECT COUNT(*) count FROM blood_units WHERE current_status = 'available' AND expiry_date > ? AND expiry_date <= ?", monthEndIso, expiringSoon);
    const unitsExpired = count("SELECT COUNT(*) count FROM blood_units WHERE expiry_date < ? AND current_status != 'discarded'", monthEndIso);
    const donationsByDonorType = db.prepare(`SELECT donor_type, SUM(number_screened) AS screened, SUM(number_accepted) AS accepted, SUM(number_deferred) AS deferred, SUM(number_collected) AS collected FROM blood_donation_summaries WHERE summary_date BETWEEN ? AND ? GROUP BY donor_type`).all(monthStartDate, monthEndDate);
    const transfusions = db.prepare(`SELECT blood_group, component_type, SUM(number_transfused) AS transfused FROM blood_transfusion_summaries WHERE summary_date BETWEEN ? AND ? GROUP BY blood_group, component_type`).all(monthStartDate, monthEndDate);
    const discards = count('SELECT COUNT(*) count FROM blood_discards WHERE discard_date BETWEEN ? AND ?', monthStartDate, monthEndDate);
    const donorAdverseEvents = count("SELECT COUNT(*) count FROM blood_adverse_events WHERE event_type LIKE 'donor%' AND event_date BETWEEN ? AND ?", monthStartDate, monthEndDate);
    const transfusionReactions = count("SELECT COUNT(*) count FROM blood_adverse_events WHERE event_type LIKE 'transfusion%' AND event_date BETWEEN ? AND ?", monthStartDate, monthEndDate);
    const ncCapaLinked = count("SELECT COUNT(*) count FROM blood_adverse_events WHERE (nc_id IS NOT NULL OR capa_id IS NOT NULL) AND event_date BETWEEN ? AND ?", monthStartDate, monthEndDate);
    audit(req, { action: 'generate_summary', entity: 'blood_bank_handover_monthly_summary', entityId: monthArg, newValue: { month: monthArg } });
    res.json({
      month: monthArg,
      unitsAvailableAtMonthEnd: unitsAtMonthEnd,
      unitsExpiringSoon,
      unitsExpired,
      donationsByDonorType,
      transfusions,
      discards,
      donorAdverseEvents,
      transfusionReactions,
      ncCapaLinkedEvents: ncCapaLinked
    });
  });

  return router;
}

export { UNIT_STATUSES, SCREENING_RESULTS, SCREENING_STATUSES, DONOR_TYPES, COMPONENT_TYPES, HANDOVER_STATUSES, EXPIRING_SOON_DAYS, expiryStatus, deriveScreeningStatus };
