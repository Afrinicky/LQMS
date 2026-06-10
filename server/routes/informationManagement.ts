import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const ASSET_STATUSES = ['active', 'inactive', 'under_review', 'archived'];
const SYSTEM_STATUSES = ['active', 'inactive', 'under_review', 'archived'];
const ACCESS_REVIEW_STATUSES = ['draft', 'completed', 'action_required', 'closed'];
const SECURITY_INCIDENT_STATUSES = ['open', 'investigating', 'linked_to_nc', 'linked_to_capa', 'closed'];
const DATA_CORRECTION_STATUSES = ['submitted', 'reviewed', 'approved', 'rejected', 'completed', 'closed'];
const CHANGE_REQUEST_STATUSES = ['submitted', 'reviewed', 'approved', 'implemented', 'validated', 'rejected', 'closed'];
const RELEASE_STATUSES = ['planned', 'tested', 'approved', 'deployed', 'archived'];
const VALIDATION_STATUSES = ['planned', 'completed', 'approved', 'closed'];
const DOWNTIME_STATUSES = ['open', 'resolved', 'linked_to_nc', 'closed'];
const REVIEW_STATUSES = ['draft', 'reviewed', 'approved', 'closed'];
const ACCESS_DECISIONS = ['keep_access', 'modify_access', 'remove_access', 'suspend_account', 'needs_investigation'];

function insertLink(db: any, source: { module: string; type: string; id: string | number }, target: { module: string; type: string; id: string | number }, notes?: string) {
  db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(source.module, source.type, String(source.id), target.module, target.type, String(target.id), notes ?? null);
}

function createActionFromSource(req: any, recordType: string, sourceId: string | number, fallbackTitle: string, fallbackDesc: string) {
  const db = getDb();
  const title = req.body.title ?? fallbackTitle;
  const result = db.prepare('INSERT INTO actions (title, module_key, source_module, source_record_id, description, priority, assigned_to_staff_id, due_date, status, evidence_required, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title, 'information_management', 'information_management', String(sourceId), req.body.description ?? fallbackDesc, req.body.priority ?? 'normal', parseIntNullable(req.body.assignedToStaffId), req.body.dueDate ?? null, 'Not started', req.body.evidenceRequired ? 1 : 0, req.user!.id);
  const actionId = Number(result.lastInsertRowid);
  insertLink(db, { module: 'information_management', type: recordType, id: sourceId }, { module: 'actions', type: 'actions', id: actionId }, `Action from ${recordType}`);
  audit(req, { action: 'create', entity: 'actions', entityId: actionId, newValue: { sourceModule: 'information_management', sourceRecordType: recordType, sourceRecordId: sourceId, title } });
  return actionId;
}

function createNcFromSource(req: any, recordType: string, sourceId: string | number, fallbackDate: string, fallbackTitle: string, fallbackDesc: string, severity = 'medium') {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
  const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId);
  const r = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, status, created_by, created_at) VALUES (?, ?, ?, 'information_management', ?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(ncNumber, req.body.eventDate ?? fallbackDate, detectedBy, String(sourceId), req.body.title ?? fallbackTitle, req.body.description ?? fallbackDesc, req.body.category ?? 'information_management', req.body.severity ?? severity, req.user!.id, createdAt);
  const ncId = Number(r.lastInsertRowid);
  insertLink(db, { module: 'information_management', type: recordType, id: sourceId }, { module: 'nc_capa', type: 'nonconforming_events', id: ncId }, `NC from ${recordType}`);
  audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'information_management', sourceRecordType: recordType, sourceRecordId: sourceId } });
  return { ncId, ncNumber };
}

function createCapaFromSource(req: any, recordType: string, sourceId: string | number, fallbackTitle: string, ncId?: number) {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const capaNumber = generateRecordNumber(db, 'capa_records', 'CAPA', createdAt);
  const r = db.prepare(`INSERT INTO capa_records (capa_number, source_module, source_record_id, nc_id, title, problem_summary, priority, status, created_by, created_at) VALUES (?, 'information_management', ?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(capaNumber, String(sourceId), ncId ?? null, req.body.title ?? fallbackTitle, req.body.problemSummary ?? null, req.body.priority ?? 'normal', req.user!.id, createdAt);
  const capaId = Number(r.lastInsertRowid);
  insertLink(db, { module: 'information_management', type: recordType, id: sourceId }, { module: 'nc_capa', type: 'capa_records', id: capaId }, `CAPA from ${recordType}`);
  audit(req, { action: 'create', entity: 'capa_records', entityId: capaId, newValue: { capaNumber, sourceModule: 'information_management', sourceRecordType: recordType, sourceRecordId: sourceId } });
  return { capaId, capaNumber };
}

export function informationManagementRoutes() {
  const router = Router();

  // ============= Summary =============
  router.get('/summary', requirePermission('information_management', 'view'), (_req, res) => {
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

  // ============= Information assets =============
  router.get('/assets', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.assetType) { filters.push('asset_type = ?'); params.push(String(req.query.assetType)); }
    let query = 'SELECT * FROM information_assets';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY asset_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/assets', requirePermission('information_management', 'create'), (req, res) => {
    if (!req.body.assetName) return res.status(400).json({ error: 'assetName is required' });
    if (!req.body.assetType) return res.status(400).json({ error: 'assetType is required' });
    const status = req.body.status ?? 'active';
    if (!ASSET_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${ASSET_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const assetCode = req.body.assetCode || generateRecordNumber(db, 'information_assets', 'IAST', createdAt);
    const r = db.prepare(`INSERT INTO information_assets (asset_code, asset_name, asset_type, owner_staff_id, department_id, section_id, description, data_category, confidentiality_level, storage_location, backup_method, retention_rule_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assetCode, req.body.assetName, req.body.assetType, parseIntNullable(req.body.ownerStaffId), parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), req.body.description ?? null, req.body.dataCategory ?? null, req.body.confidentialityLevel ?? null, req.body.storageLocation ?? null, req.body.backupMethod ?? null, parseIntNullable(req.body.retentionRuleId), status, req.user!.id);
    const id = Number(r.lastInsertRowid);
    if (parseIntNullable(req.body.retentionRuleId)) insertLink(db, { module: 'information_management', type: 'information_assets', id }, { module: 'records_reports', type: 'record_retention_rules', id: parseIntNullable(req.body.retentionRuleId)! }, 'Asset retention');
    audit(req, { action: 'create', entity: 'information_assets', entityId: id, newValue: { assetCode, ...req.body } });
    res.status(201).json({ id, assetCode });
  });

  router.get('/assets/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_assets WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    res.json(row);
  });

  router.put('/assets/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM information_assets WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Asset not found' });
    if (req.body.status && !ASSET_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${ASSET_STATUSES.join(', ')}` });
    db.prepare(`UPDATE information_assets SET asset_name = ?, asset_type = ?, owner_staff_id = ?, department_id = ?, section_id = ?, description = ?, data_category = ?, confidentiality_level = ?, storage_location = ?, backup_method = ?, retention_rule_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.assetName ?? oldValue.asset_name, req.body.assetType ?? oldValue.asset_type, parseIntNullable(req.body.ownerStaffId) ?? oldValue.owner_staff_id, parseIntNullable(req.body.departmentId) ?? oldValue.department_id, parseIntNullable(req.body.sectionId) ?? oldValue.section_id, req.body.description ?? oldValue.description, req.body.dataCategory ?? oldValue.data_category, req.body.confidentialityLevel ?? oldValue.confidentiality_level, req.body.storageLocation ?? oldValue.storage_location, req.body.backupMethod ?? oldValue.backup_method, parseIntNullable(req.body.retentionRuleId) ?? oldValue.retention_rule_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'information_assets', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/assets/:id/status', requirePermission('information_management', 'edit'), (req, res) => {
    if (!ASSET_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${ASSET_STATUSES.join(', ')}` });
    const db = getDb();
    const row = db.prepare('SELECT status FROM information_assets WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Asset not found' });
    db.prepare('UPDATE information_assets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status, req.params.id);
    audit(req, { action: 'status_change', entity: 'information_assets', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: req.body.status } });
    res.json({ ok: true });
  });

  // ============= Information systems =============
  router.get('/systems', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM information_systems';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY system_name';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/systems', requirePermission('information_management', 'create'), (req, res) => {
    if (!req.body.systemName) return res.status(400).json({ error: 'systemName is required' });
    if (!req.body.systemType) return res.status(400).json({ error: 'systemType is required' });
    const status = req.body.status ?? 'active';
    if (!SYSTEM_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${SYSTEM_STATUSES.join(', ')}` });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const systemCode = req.body.systemCode || generateRecordNumber(db, 'information_systems', 'ISYS', createdAt);
    const r = db.prepare(`INSERT INTO information_systems (system_code, system_name, system_type, vendor_or_owner, purpose, data_handled, hosting_location, access_method, backup_responsibility, support_contact, criticality, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(systemCode, req.body.systemName, req.body.systemType, req.body.vendorOrOwner ?? null, req.body.purpose ?? null, req.body.dataHandled ?? null, req.body.hostingLocation ?? null, req.body.accessMethod ?? null, req.body.backupResponsibility ?? null, req.body.supportContact ?? null, req.body.criticality ?? null, status, req.user!.id);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'information_systems', entityId: id, newValue: { systemCode, ...req.body } });
    res.status(201).json({ id, systemCode });
  });

  router.get('/systems/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_systems WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'System not found' });
    res.json(row);
  });

  router.put('/systems/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM information_systems WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'System not found' });
    if (req.body.status && !SYSTEM_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SYSTEM_STATUSES.join(', ')}` });
    db.prepare(`UPDATE information_systems SET system_name = ?, system_type = ?, vendor_or_owner = ?, purpose = ?, data_handled = ?, hosting_location = ?, access_method = ?, backup_responsibility = ?, support_contact = ?, criticality = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.systemName ?? oldValue.system_name, req.body.systemType ?? oldValue.system_type, req.body.vendorOrOwner ?? oldValue.vendor_or_owner, req.body.purpose ?? oldValue.purpose, req.body.dataHandled ?? oldValue.data_handled, req.body.hostingLocation ?? oldValue.hosting_location, req.body.accessMethod ?? oldValue.access_method, req.body.backupResponsibility ?? oldValue.backup_responsibility, req.body.supportContact ?? oldValue.support_contact, req.body.criticality ?? oldValue.criticality, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'information_systems', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/systems/:id/status', requirePermission('information_management', 'edit'), (req, res) => {
    if (!SYSTEM_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SYSTEM_STATUSES.join(', ')}` });
    const db = getDb();
    const row = db.prepare('SELECT status FROM information_systems WHERE id = ?').get(req.params.id) as { status: string } | undefined;
    if (!row) return res.status(404).json({ error: 'System not found' });
    db.prepare('UPDATE information_systems SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status, req.params.id);
    audit(req, { action: 'status_change', entity: 'information_systems', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: req.body.status } });
    res.json({ ok: true });
  });

  // ============= Access reviews =============
  router.get('/access-reviews', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.systemId) { filters.push('system_id = ?'); params.push(Number(req.query.systemId)); }
    let query = 'SELECT * FROM system_access_reviews';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY review_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/access-reviews', requirePermission('information_management', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.systemId)) return res.status(400).json({ error: 'systemId is required' });
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'system_access_reviews', 'IAR', createdAt);
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    const r = db.prepare(`INSERT INTO system_access_reviews (review_number, system_id, review_date, review_period_start, review_period_end, reviewed_by_staff_id, users_reviewed, access_issues_found, inactive_accounts_found, excessive_access_found, actions_required, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(reviewNumber, req.body.systemId, req.body.reviewDate, req.body.reviewPeriodStart ?? null, req.body.reviewPeriodEnd ?? null, reviewedBy, parseIntNullable(req.body.usersReviewed) ?? 0, parseIntNullable(req.body.accessIssuesFound) ?? 0, parseIntNullable(req.body.inactiveAccountsFound) ?? 0, parseIntNullable(req.body.excessiveAccessFound) ?? 0, req.body.actionsRequired ?? null, req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'system_access_reviews', entityId: id, newValue: { reviewNumber, ...req.body } });
    res.status(201).json({ id, reviewNumber });
  });

  router.get('/access-reviews/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_access_reviews WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Access review not found' });
    const items = db.prepare('SELECT * FROM system_access_review_items WHERE access_review_id = ? ORDER BY id').all(req.params.id);
    res.json({ ...row, items });
  });

  router.put('/access-reviews/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM system_access_reviews WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Access review not found' });
    if (req.body.status && !ACCESS_REVIEW_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${ACCESS_REVIEW_STATUSES.join(', ')}` });
    db.prepare(`UPDATE system_access_reviews SET review_date = ?, review_period_start = ?, review_period_end = ?, users_reviewed = ?, access_issues_found = ?, inactive_accounts_found = ?, excessive_access_found = ?, actions_required = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.reviewDate ?? oldValue.review_date, req.body.reviewPeriodStart ?? oldValue.review_period_start, req.body.reviewPeriodEnd ?? oldValue.review_period_end, parseIntNullable(req.body.usersReviewed) ?? oldValue.users_reviewed, parseIntNullable(req.body.accessIssuesFound) ?? oldValue.access_issues_found, parseIntNullable(req.body.inactiveAccountsFound) ?? oldValue.inactive_accounts_found, parseIntNullable(req.body.excessiveAccessFound) ?? oldValue.excessive_access_found, req.body.actionsRequired ?? oldValue.actions_required, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'system_access_reviews', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/access-reviews/:id/generate-items', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM system_access_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Access review not found' });
    const users = db.prepare('SELECT u.id user_id, u.staff_id, u.full_name, u.is_active, r.name role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.full_name').all() as Array<{ user_id: number; staff_id: number | null; full_name: string; is_active: number; role_name: string }>;
    let inserted = 0;
    const tx = db.transaction(() => {
      for (const u of users) {
        const existing = db.prepare('SELECT id FROM system_access_review_items WHERE access_review_id = ? AND user_id = ?').get(req.params.id, u.user_id);
        if (existing) continue;
        db.prepare('INSERT INTO system_access_review_items (access_review_id, staff_id, user_id, system_role, access_status, review_decision, created_by) VALUES (?, ?, ?, ?, ?, NULL, ?)')
          .run(req.params.id, u.staff_id, u.user_id, u.role_name, u.is_active ? 'active' : 'inactive', req.user!.id);
        inserted++;
      }
      db.prepare('UPDATE system_access_reviews SET users_reviewed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(users.length, req.params.id);
    });
    tx();
    audit(req, { action: 'generate_items', entity: 'system_access_reviews', entityId: req.params.id, newValue: { inserted, totalUsers: users.length } });
    res.status(201).json({ ok: true, inserted, totalUsers: users.length });
  });

  router.post('/access-reviews/:id/items', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const review = db.prepare('SELECT * FROM system_access_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Access review not found' });
    if (req.body.reviewDecision && !ACCESS_DECISIONS.includes(req.body.reviewDecision)) return res.status(400).json({ error: `reviewDecision must be one of: ${ACCESS_DECISIONS.join(', ')}` });
    if (req.body.itemId) {
      const existing = db.prepare('SELECT * FROM system_access_review_items WHERE id = ? AND access_review_id = ?').get(req.body.itemId, req.params.id) as any;
      if (!existing) return res.status(404).json({ error: 'Item not found' });
      db.prepare('UPDATE system_access_review_items SET system_role = ?, access_status = ?, review_decision = ?, review_notes = ? WHERE id = ?')
        .run(req.body.systemRole ?? existing.system_role, req.body.accessStatus ?? existing.access_status, req.body.reviewDecision ?? existing.review_decision, req.body.reviewNotes ?? existing.review_notes, req.body.itemId);
      audit(req, { action: 'edit', entity: 'system_access_review_items', entityId: req.body.itemId, oldValue: existing, newValue: req.body });
      return res.json({ ok: true, id: req.body.itemId });
    }
    const r = db.prepare('INSERT INTO system_access_review_items (access_review_id, staff_id, user_id, system_role, access_status, review_decision, review_notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.params.id, parseIntNullable(req.body.staffId), parseIntNullable(req.body.userId), req.body.systemRole ?? null, req.body.accessStatus ?? null, req.body.reviewDecision ?? null, req.body.reviewNotes ?? null, req.user!.id);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'system_access_review_items', entityId: id, newValue: req.body });
    res.status(201).json({ id });
  });

  router.post('/access-reviews/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const review = db.prepare('SELECT * FROM system_access_reviews WHERE id = ?').get(req.params.id) as any;
    if (!review) return res.status(404).json({ error: 'Access review not found' });
    const actionId = createActionFromSource(req, 'system_access_reviews', review.id, `Access review follow-up: ${review.review_number}`, review.actions_required ?? '');
    db.prepare("UPDATE system_access_reviews SET linked_action_id = ?, status = 'action_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/access-reviews/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_access_reviews WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Access review not found' });
    db.prepare("UPDATE system_access_reviews SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'system_access_reviews', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Security incidents =============
  router.get('/security-incidents', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.severity) { filters.push('severity = ?'); params.push(String(req.query.severity)); }
    let query = 'SELECT * FROM information_security_incidents';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY incident_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/security-incidents', requirePermission('information_management', 'create'), (req, res) => {
    if (!req.body.incidentDate) return res.status(400).json({ error: 'incidentDate is required' });
    if (!req.body.incidentType) return res.status(400).json({ error: 'incidentType is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    if (!req.body.severity) return res.status(400).json({ error: 'severity is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const incidentNumber = generateRecordNumber(db, 'information_security_incidents', 'ISI', createdAt);
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const r = db.prepare(`INSERT INTO information_security_incidents (incident_number, incident_date, incident_type, system_id, asset_id, reported_by_staff_id, title, description, immediate_action, severity, confidentiality_impact, data_loss_suspected, investigation_summary, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(incidentNumber, req.body.incidentDate, req.body.incidentType, parseIntNullable(req.body.systemId), parseIntNullable(req.body.assetId), reportedBy, req.body.title, req.body.description, req.body.immediateAction ?? null, req.body.severity, req.body.confidentialityImpact ?? null, req.body.dataLossSuspected ? 1 : 0, req.body.investigationSummary ?? null, req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'information_security_incidents', entityId: id, newValue: { incidentNumber, ...req.body } });
    res.status(201).json({ id, incidentNumber });
  });

  router.get('/security-incidents/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_security_incidents WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Incident not found' });
    res.json(row);
  });

  router.put('/security-incidents/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM information_security_incidents WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Incident not found' });
    if (req.body.status && !SECURITY_INCIDENT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${SECURITY_INCIDENT_STATUSES.join(', ')}` });
    db.prepare(`UPDATE information_security_incidents SET incident_date = ?, incident_type = ?, system_id = ?, asset_id = ?, title = ?, description = ?, immediate_action = ?, severity = ?, confidentiality_impact = ?, data_loss_suspected = ?, investigation_summary = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.incidentDate ?? oldValue.incident_date, req.body.incidentType ?? oldValue.incident_type, parseIntNullable(req.body.systemId) ?? oldValue.system_id, parseIntNullable(req.body.assetId) ?? oldValue.asset_id, req.body.title ?? oldValue.title, req.body.description ?? oldValue.description, req.body.immediateAction ?? oldValue.immediate_action, req.body.severity ?? oldValue.severity, req.body.confidentialityImpact ?? oldValue.confidentiality_impact, req.body.dataLossSuspected !== undefined ? (req.body.dataLossSuspected ? 1 : 0) : oldValue.data_loss_suspected, req.body.investigationSummary ?? oldValue.investigation_summary, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'information_security_incidents', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/security-incidents/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_security_incidents WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Incident not found' });
    const actionId = createActionFromSource(req, 'information_security_incidents', row.id, `Incident: ${row.incident_number}`, row.description);
    db.prepare('UPDATE information_security_incidents SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/security-incidents/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_security_incidents WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Incident not found' });
    const { ncId, ncNumber } = createNcFromSource(req, 'information_security_incidents', row.id, row.incident_date, `Information security incident: ${row.incident_number}`, row.description, row.severity ?? 'medium');
    db.prepare("UPDATE information_security_incidents SET linked_nc_id = ?, status = 'linked_to_nc', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/security-incidents/:id/create-capa', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_security_incidents WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Incident not found' });
    const { capaId, capaNumber } = createCapaFromSource(req, 'information_security_incidents', row.id, `Information security CAPA: ${row.incident_number}`, row.linked_nc_id ?? undefined);
    db.prepare("UPDATE information_security_incidents SET linked_capa_id = ?, status = 'linked_to_capa', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(capaId, req.params.id);
    res.status(201).json({ id: capaId, capaNumber });
  });

  router.post('/security-incidents/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_security_incidents WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Incident not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.closedByStaffId);
    db.prepare("UPDATE information_security_incidents SET status = 'closed', closed_by_staff_id = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'close', entity: 'information_security_incidents', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Data corrections =============
  router.get('/data-corrections', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    let query = 'SELECT * FROM data_correction_requests';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY request_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/data-corrections', requirePermission('information_management', 'create'), (req, res) => {
    if (!req.body.requestDate) return res.status(400).json({ error: 'requestDate is required' });
    if (!req.body.correctionReason) return res.status(400).json({ error: 'correctionReason is required' });
    if (!req.body.requestedCorrectionSummary) return res.status(400).json({ error: 'requestedCorrectionSummary is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const requestNumber = generateRecordNumber(db, 'data_correction_requests', 'DCR', createdAt);
    const requestedBy = getStaffIdOrCurrent(req, req.body.requestedByStaffId);
    const r = db.prepare(`INSERT INTO data_correction_requests (request_number, request_date, system_id, module_key, record_type, record_reference, requested_by_staff_id, correction_reason, original_value_summary, requested_correction_summary, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`)
      .run(requestNumber, req.body.requestDate, parseIntNullable(req.body.systemId), req.body.moduleKey ?? null, req.body.recordType ?? null, req.body.recordReference ?? null, requestedBy, req.body.correctionReason, req.body.originalValueSummary ?? null, req.body.requestedCorrectionSummary, req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'data_correction_requests', entityId: id, newValue: { requestNumber, ...req.body } });
    res.status(201).json({ id, requestNumber });
  });

  router.get('/data-corrections/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Data correction not found' });
    res.json(row);
  });

  router.put('/data-corrections/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Data correction not found' });
    if (req.body.status && !DATA_CORRECTION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${DATA_CORRECTION_STATUSES.join(', ')}` });
    db.prepare(`UPDATE data_correction_requests SET request_date = ?, system_id = ?, module_key = ?, record_type = ?, record_reference = ?, correction_reason = ?, original_value_summary = ?, requested_correction_summary = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.requestDate ?? oldValue.request_date, parseIntNullable(req.body.systemId) ?? oldValue.system_id, req.body.moduleKey ?? oldValue.module_key, req.body.recordType ?? oldValue.record_type, req.body.recordReference ?? oldValue.record_reference, req.body.correctionReason ?? oldValue.correction_reason, req.body.originalValueSummary ?? oldValue.original_value_summary, req.body.requestedCorrectionSummary ?? oldValue.requested_correction_summary, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'data_correction_requests', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/data-corrections/:id/review', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Data correction not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    db.prepare("UPDATE data_correction_requests SET status = 'reviewed', reviewed_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'data_correction_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'reviewed', reviewedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/data-corrections/:id/approve', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Data correction not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE data_correction_requests SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'data_correction_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'approved', approvedByStaffId: staffId } });
    res.json({ ok: true });
  });

  router.post('/data-corrections/:id/complete', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Data correction not found' });
    db.prepare("UPDATE data_correction_requests SET status = 'completed', correction_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'complete', entity: 'data_correction_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'completed' } });
    res.json({ ok: true });
  });

  router.post('/data-corrections/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Data correction not found' });
    const actionId = createActionFromSource(req, 'data_correction_requests', row.id, `Data correction follow-up: ${row.request_number}`, row.requested_correction_summary);
    db.prepare('UPDATE data_correction_requests SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/data-corrections/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM data_correction_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Data correction not found' });
    db.prepare("UPDATE data_correction_requests SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'data_correction_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Change requests =============
  router.get('/change-requests', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.systemId) { filters.push('system_id = ?'); params.push(Number(req.query.systemId)); }
    let query = 'SELECT * FROM system_change_requests';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY request_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/change-requests', requirePermission('information_management', 'create'), (req, res) => {
    if (!req.body.requestDate) return res.status(400).json({ error: 'requestDate is required' });
    if (!req.body.changeType) return res.status(400).json({ error: 'changeType is required' });
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    if (!req.body.description) return res.status(400).json({ error: 'description is required' });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const changeNumber = generateRecordNumber(db, 'system_change_requests', 'SCR', createdAt);
    const requestedBy = getStaffIdOrCurrent(req, req.body.requestedByStaffId);
    const r = db.prepare(`INSERT INTO system_change_requests (change_number, request_date, system_id, change_type, title, description, reason, risk_level, requested_by_staff_id, implementation_date, validation_required, validation_summary, rollback_plan, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`)
      .run(changeNumber, req.body.requestDate, parseIntNullable(req.body.systemId), req.body.changeType, req.body.title, req.body.description, req.body.reason, req.body.riskLevel ?? null, requestedBy, req.body.implementationDate ?? null, req.body.validationRequired ? 1 : 0, req.body.validationSummary ?? null, req.body.rollbackPlan ?? null, req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'system_change_requests', entityId: id, newValue: { changeNumber, ...req.body } });
    res.status(201).json({ id, changeNumber });
  });

  router.get('/change-requests/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    res.json(row);
  });

  router.put('/change-requests/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Change request not found' });
    if (req.body.status && !CHANGE_REQUEST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${CHANGE_REQUEST_STATUSES.join(', ')}` });
    db.prepare(`UPDATE system_change_requests SET request_date = ?, system_id = ?, change_type = ?, title = ?, description = ?, reason = ?, risk_level = ?, implementation_date = ?, validation_required = ?, validation_summary = ?, rollback_plan = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.requestDate ?? oldValue.request_date, parseIntNullable(req.body.systemId) ?? oldValue.system_id, req.body.changeType ?? oldValue.change_type, req.body.title ?? oldValue.title, req.body.description ?? oldValue.description, req.body.reason ?? oldValue.reason, req.body.riskLevel ?? oldValue.risk_level, req.body.implementationDate ?? oldValue.implementation_date, req.body.validationRequired !== undefined ? (req.body.validationRequired ? 1 : 0) : oldValue.validation_required, req.body.validationSummary ?? oldValue.validation_summary, req.body.rollbackPlan ?? oldValue.rollback_plan, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'system_change_requests', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/change-requests/:id/review', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    db.prepare("UPDATE system_change_requests SET status = 'reviewed', reviewed_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'review', entity: 'system_change_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'reviewed' } });
    res.json({ ok: true });
  });

  router.post('/change-requests/:id/approve', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE system_change_requests SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'system_change_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });

  router.post('/change-requests/:id/implement', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    db.prepare("UPDATE system_change_requests SET status = 'implemented', implementation_date = COALESCE(implementation_date, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'implement', entity: 'system_change_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'implemented' } });
    res.json({ ok: true });
  });

  router.post('/change-requests/:id/validate', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    db.prepare("UPDATE system_change_requests SET status = 'validated', validation_summary = COALESCE(?, validation_summary), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.body.validationSummary ?? null, req.params.id);
    audit(req, { action: 'validate', entity: 'system_change_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'validated' } });
    res.json({ ok: true });
  });

  router.post('/change-requests/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    const actionId = createActionFromSource(req, 'system_change_requests', row.id, `Change request follow-up: ${row.change_number}`, row.description);
    db.prepare('UPDATE system_change_requests SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/change-requests/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_change_requests WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Change request not found' });
    db.prepare("UPDATE system_change_requests SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'system_change_requests', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Software releases =============
  router.get('/releases', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.systemId) { filters.push('system_id = ?'); params.push(Number(req.query.systemId)); }
    let query = 'SELECT * FROM software_release_records';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY release_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/releases', requirePermission('information_management', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.systemId)) return res.status(400).json({ error: 'systemId is required' });
    if (!req.body.versionLabel) return res.status(400).json({ error: 'versionLabel is required' });
    if (!req.body.releaseDate) return res.status(400).json({ error: 'releaseDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const releaseNumber = generateRecordNumber(db, 'software_release_records', 'REL', createdAt);
    const r = db.prepare(`INSERT INTO software_release_records (release_number, system_id, version_label, release_date, release_summary, changes_included, testing_summary, deployment_notes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(releaseNumber, req.body.systemId, req.body.versionLabel, req.body.releaseDate, req.body.releaseSummary ?? null, req.body.changesIncluded ?? null, req.body.testingSummary ?? null, req.body.deploymentNotes ?? null, req.body.status ?? 'planned', req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    if (parseIntNullable(req.body.changeRequestId)) insertLink(db, { module: 'information_management', type: 'software_release_records', id }, { module: 'information_management', type: 'system_change_requests', id: parseIntNullable(req.body.changeRequestId)! }, 'Release for change');
    audit(req, { action: 'create', entity: 'software_release_records', entityId: id, newValue: { releaseNumber, ...req.body } });
    res.status(201).json({ id, releaseNumber });
  });

  router.get('/releases/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM software_release_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Release not found' });
    res.json(row);
  });

  router.put('/releases/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM software_release_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Release not found' });
    if (req.body.status && !RELEASE_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${RELEASE_STATUSES.join(', ')}` });
    db.prepare(`UPDATE software_release_records SET version_label = ?, release_date = ?, release_summary = ?, changes_included = ?, testing_summary = ?, deployment_notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.versionLabel ?? oldValue.version_label, req.body.releaseDate ?? oldValue.release_date, req.body.releaseSummary ?? oldValue.release_summary, req.body.changesIncluded ?? oldValue.changes_included, req.body.testingSummary ?? oldValue.testing_summary, req.body.deploymentNotes ?? oldValue.deployment_notes, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'software_release_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/releases/:id/approve', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM software_release_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Release not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE software_release_records SET status = 'approved', approved_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'software_release_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });

  router.post('/releases/:id/deploy', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM software_release_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Release not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.deployedByStaffId);
    db.prepare("UPDATE software_release_records SET status = 'deployed', deployed_by_staff_id = ?, deployment_notes = COALESCE(?, deployment_notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.body.deploymentNotes ?? null, req.params.id);
    audit(req, { action: 'deploy', entity: 'software_release_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'deployed' } });
    res.json({ ok: true });
  });

  router.post('/releases/:id/archive', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM software_release_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Release not found' });
    db.prepare("UPDATE software_release_records SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'archive', entity: 'software_release_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'archived' } });
    res.json({ ok: true });
  });

  // ============= System validations =============
  router.get('/validations', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.systemId) { filters.push('system_id = ?'); params.push(Number(req.query.systemId)); }
    let query = 'SELECT * FROM system_validation_records';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY validation_date DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  router.post('/validations', requirePermission('information_management', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.systemId)) return res.status(400).json({ error: 'systemId is required' });
    if (!req.body.validationDate) return res.status(400).json({ error: 'validationDate is required' });
    if (!req.body.validationType) return res.status(400).json({ error: 'validationType is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const validationNumber = generateRecordNumber(db, 'system_validation_records', 'VAL', createdAt);
    const r = db.prepare(`INSERT INTO system_validation_records (validation_number, system_id, validation_date, validation_type, scope, test_summary, deviations_found, outcome, evidence_file_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(validationNumber, req.body.systemId, req.body.validationDate, req.body.validationType, req.body.scope ?? null, req.body.testSummary ?? null, req.body.deviationsFound ?? null, req.body.outcome ?? null, parseIntNullable(req.body.evidenceFileId), req.body.status ?? 'planned', req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    if (parseIntNullable(req.body.releaseId)) insertLink(db, { module: 'information_management', type: 'system_validation_records', id }, { module: 'information_management', type: 'software_release_records', id: parseIntNullable(req.body.releaseId)! }, 'Validation for release');
    if (parseIntNullable(req.body.changeRequestId)) insertLink(db, { module: 'information_management', type: 'system_validation_records', id }, { module: 'information_management', type: 'system_change_requests', id: parseIntNullable(req.body.changeRequestId)! }, 'Validation for change');
    audit(req, { action: 'create', entity: 'system_validation_records', entityId: id, newValue: { validationNumber, ...req.body } });
    res.status(201).json({ id, validationNumber });
  });

  router.get('/validations/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_validation_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Validation not found' });
    res.json(row);
  });

  router.put('/validations/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM system_validation_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Validation not found' });
    if (req.body.status && !VALIDATION_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${VALIDATION_STATUSES.join(', ')}` });
    db.prepare(`UPDATE system_validation_records SET validation_date = ?, validation_type = ?, scope = ?, test_summary = ?, deviations_found = ?, outcome = ?, evidence_file_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.validationDate ?? oldValue.validation_date, req.body.validationType ?? oldValue.validation_type, req.body.scope ?? oldValue.scope, req.body.testSummary ?? oldValue.test_summary, req.body.deviationsFound ?? oldValue.deviations_found, req.body.outcome ?? oldValue.outcome, parseIntNullable(req.body.evidenceFileId) ?? oldValue.evidence_file_id, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'system_validation_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/validations/:id/approve', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_validation_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Validation not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE system_validation_records SET status = 'approved', approved_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'system_validation_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });

  router.post('/validations/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_validation_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Validation not found' });
    db.prepare("UPDATE system_validation_records SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'system_validation_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Downtime =============
  router.get('/downtime', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = []; const params: unknown[] = [];
    if (req.query.status) { filters.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.systemId) { filters.push('system_id = ?'); params.push(Number(req.query.systemId)); }
    let query = 'SELECT * FROM system_downtime_records';
    if (filters.length) query += ` WHERE ${filters.join(' AND ')}`;
    query += ' ORDER BY downtime_start DESC, id DESC';
    res.json(db.prepare(query).all(...params));
  });

  function calcDurationMinutes(start?: string, end?: string): number | null {
    if (!start || !end) return null;
    const s = Date.parse(start); const e = Date.parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
    return Math.round((e - s) / 60000);
  }

  router.post('/downtime', requirePermission('information_management', 'create'), (req, res) => {
    if (!parseIntNullable(req.body.systemId)) return res.status(400).json({ error: 'systemId is required' });
    if (!req.body.downtimeStart) return res.status(400).json({ error: 'downtimeStart is required' });
    if (!req.body.affectedServices) return res.status(400).json({ error: 'affectedServices is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const downtimeNumber = generateRecordNumber(db, 'system_downtime_records', 'DOWN', createdAt);
    const reportedBy = getStaffIdOrCurrent(req, req.body.reportedByStaffId);
    const duration = calcDurationMinutes(req.body.downtimeStart, req.body.downtimeEnd);
    const r = db.prepare(`INSERT INTO system_downtime_records (downtime_number, system_id, downtime_start, downtime_end, duration_minutes, downtime_type, affected_services, impact_summary, workaround_used, reported_by_staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(downtimeNumber, req.body.systemId, req.body.downtimeStart, req.body.downtimeEnd ?? null, duration, req.body.downtimeType ?? null, req.body.affectedServices, req.body.impactSummary ?? null, req.body.workaroundUsed ?? null, reportedBy, req.body.downtimeEnd ? 'resolved' : 'open', req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'system_downtime_records', entityId: id, newValue: { downtimeNumber, durationMinutes: duration, ...req.body } });
    res.status(201).json({ id, downtimeNumber, durationMinutes: duration });
  });

  router.get('/downtime/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_downtime_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Downtime not found' });
    res.json(row);
  });

  router.put('/downtime/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM system_downtime_records WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Downtime not found' });
    if (req.body.status && !DOWNTIME_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${DOWNTIME_STATUSES.join(', ')}` });
    const newStart = req.body.downtimeStart ?? oldValue.downtime_start;
    const newEnd = req.body.downtimeEnd ?? oldValue.downtime_end;
    const duration = calcDurationMinutes(newStart, newEnd) ?? oldValue.duration_minutes;
    db.prepare(`UPDATE system_downtime_records SET downtime_start = ?, downtime_end = ?, duration_minutes = ?, downtime_type = ?, affected_services = ?, impact_summary = ?, workaround_used = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(newStart, newEnd, duration, req.body.downtimeType ?? oldValue.downtime_type, req.body.affectedServices ?? oldValue.affected_services, req.body.impactSummary ?? oldValue.impact_summary, req.body.workaroundUsed ?? oldValue.workaround_used, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'system_downtime_records', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/downtime/:id/create-action', requirePermission('actions', 'create'), (req, res) => {
    if (!req.body.title) return res.status(400).json({ error: 'title is required' });
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_downtime_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Downtime not found' });
    const actionId = createActionFromSource(req, 'system_downtime_records', row.id, `Downtime follow-up: ${row.downtime_number}`, row.affected_services);
    db.prepare('UPDATE system_downtime_records SET linked_action_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(actionId, req.params.id);
    res.status(201).json({ id: actionId });
  });

  router.post('/downtime/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_downtime_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Downtime not found' });
    const { ncId, ncNumber } = createNcFromSource(req, 'system_downtime_records', row.id, row.downtime_start.slice(0, 10), `System downtime: ${row.downtime_number}`, row.affected_services);
    db.prepare("UPDATE system_downtime_records SET linked_nc_id = ?, status = 'linked_to_nc', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ncId, req.params.id);
    res.status(201).json({ id: ncId, ncNumber });
  });

  router.post('/downtime/:id/resolve', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_downtime_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Downtime not found' });
    const end = req.body.downtimeEnd ?? new Date().toISOString();
    const duration = calcDurationMinutes(row.downtime_start, end) ?? row.duration_minutes;
    const staffId = getStaffIdOrCurrent(req, req.body.resolvedByStaffId);
    db.prepare("UPDATE system_downtime_records SET status = 'resolved', downtime_end = ?, duration_minutes = ?, resolved_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(end, duration, staffId, req.params.id);
    audit(req, { action: 'resolve', entity: 'system_downtime_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'resolved', durationMinutes: duration } });
    res.json({ ok: true, durationMinutes: duration });
  });

  router.post('/downtime/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM system_downtime_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Downtime not found' });
    db.prepare("UPDATE system_downtime_records SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'system_downtime_records', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  // ============= Information management reviews =============
  router.get('/reviews', requirePermission('information_management', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM information_management_reviews ORDER BY review_period_end DESC, id DESC').all());
  });

  router.post('/reviews', requirePermission('information_management', 'create'), (req, res) => {
    if (!req.body.reviewPeriodStart) return res.status(400).json({ error: 'reviewPeriodStart is required' });
    if (!req.body.reviewPeriodEnd) return res.status(400).json({ error: 'reviewPeriodEnd is required' });
    if (!req.body.reviewDate) return res.status(400).json({ error: 'reviewDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const reviewNumber = generateRecordNumber(db, 'information_management_reviews', 'IMREV', createdAt);
    const reviewedBy = getStaffIdOrCurrent(req, req.body.reviewedByStaffId);
    const r = db.prepare(`INSERT INTO information_management_reviews (review_number, review_period_start, review_period_end, review_date, reviewed_by_staff_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(reviewNumber, req.body.reviewPeriodStart, req.body.reviewPeriodEnd, req.body.reviewDate, reviewedBy, req.user!.id, createdAt);
    const id = Number(r.lastInsertRowid);
    audit(req, { action: 'create', entity: 'information_management_reviews', entityId: id, newValue: { reviewNumber, ...req.body } });
    res.status(201).json({ id, reviewNumber });
  });

  router.get('/reviews/:id', requirePermission('information_management', 'view'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_management_reviews WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Review not found' });
    res.json(row);
  });

  router.put('/reviews/:id', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM information_management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Review not found' });
    if (req.body.status && !REVIEW_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${REVIEW_STATUSES.join(', ')}` });
    db.prepare(`UPDATE information_management_reviews SET review_period_start = ?, review_period_end = ?, review_date = ?, issues_identified = ?, actions_required = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.reviewPeriodStart ?? oldValue.review_period_start, req.body.reviewPeriodEnd ?? oldValue.review_period_end, req.body.reviewDate ?? oldValue.review_date, req.body.issuesIdentified ?? oldValue.issues_identified, req.body.actionsRequired ?? oldValue.actions_required, req.body.status ?? oldValue.status, req.params.id);
    audit(req, { action: 'edit', entity: 'information_management_reviews', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/reviews/:id/generate-summary', requirePermission('information_management', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Review not found' });
    const start = row.review_period_start; const end = row.review_period_end;
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { count: number }).count;
    const activeAssets = count("SELECT COUNT(*) count FROM information_assets WHERE status = 'active'");
    const totalAssets = count('SELECT COUNT(*) count FROM information_assets');
    const accessReviewsInPeriod = count('SELECT COUNT(*) count FROM system_access_reviews WHERE review_date BETWEEN ? AND ?', start, end);
    const accessReviewsActionRequired = count("SELECT COUNT(*) count FROM system_access_reviews WHERE review_date BETWEEN ? AND ? AND status IN ('action_required')", start, end);
    const incidents = count('SELECT COUNT(*) count FROM information_security_incidents WHERE incident_date BETWEEN ? AND ?', start, end);
    const incidentsLinkedNc = count('SELECT COUNT(*) count FROM information_security_incidents WHERE incident_date BETWEEN ? AND ? AND linked_nc_id IS NOT NULL', start, end);
    const changeRequests = count('SELECT COUNT(*) count FROM system_change_requests WHERE request_date BETWEEN ? AND ?', start, end);
    const changeRequestsApproved = count("SELECT COUNT(*) count FROM system_change_requests WHERE request_date BETWEEN ? AND ? AND status IN ('approved','implemented','validated','closed')", start, end);
    const releases = count('SELECT COUNT(*) count FROM software_release_records WHERE release_date BETWEEN ? AND ?', start, end);
    const validations = count('SELECT COUNT(*) count FROM system_validation_records WHERE validation_date BETWEEN ? AND ?', start, end);
    const downtimeCount = count('SELECT COUNT(*) count FROM system_downtime_records WHERE downtime_start BETWEEN ? AND ?', start, end + 'T23:59:59');
    const downtimeMinutes = (db.prepare('SELECT COALESCE(SUM(duration_minutes), 0) AS m FROM system_downtime_records WHERE downtime_start BETWEEN ? AND ?').get(start, end + 'T23:59:59') as { m: number }).m;
    const corrections = count('SELECT COUNT(*) count FROM data_correction_requests WHERE request_date BETWEEN ? AND ?', start, end);
    const integrityChecks = count('SELECT COUNT(*) count FROM data_integrity_checks WHERE check_date BETWEEN ? AND ?', start, end);
    const integrityIssues = (db.prepare('SELECT COALESCE(SUM(issues_found), 0) AS i FROM data_integrity_checks WHERE check_date BETWEEN ? AND ?').get(start, end) as { i: number }).i;
    const assetsSummary = `Active information assets: ${activeAssets} of ${totalAssets} recorded.`;
    const accessSummary = `Access reviews in period: ${accessReviewsInPeriod}; flagged for action: ${accessReviewsActionRequired}.`;
    const incidentSummary = `Information security incidents: ${incidents}; linked to NC: ${incidentsLinkedNc}.`;
    const changeSummary = `Change requests: ${changeRequests}; approved/implemented/validated/closed: ${changeRequestsApproved}.`;
    const downtimeSummary = `Downtime events: ${downtimeCount}; total recorded downtime minutes: ${downtimeMinutes}.`;
    const validationSummary = `Releases: ${releases}; validations: ${validations}.`;
    const integritySummary = `Data correction requests: ${corrections}. Data-integrity scans: ${integrityChecks}; issues recorded: ${integrityIssues}.`;
    db.prepare('UPDATE information_management_reviews SET information_assets_summary = ?, access_review_summary = ?, security_incident_summary = ?, change_request_summary = ?, downtime_summary = ?, validation_summary = ?, data_integrity_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(assetsSummary, accessSummary, incidentSummary, changeSummary, downtimeSummary, validationSummary, integritySummary, req.params.id);
    audit(req, { action: 'generate_summary', entity: 'information_management_reviews', entityId: req.params.id, newValue: { activeAssets, accessReviewsInPeriod, incidents, changeRequests, releases, validations, downtimeCount, downtimeMinutes, corrections } });
    res.json({ ok: true });
  });

  router.post('/reviews/:id/approve', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Review not found' });
    const staffId = getStaffIdOrCurrent(req, req.body.approvedByStaffId);
    if (staffId === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    db.prepare("UPDATE information_management_reviews SET status = 'approved', approved_by_staff_id = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId, req.params.id);
    audit(req, { action: 'approve', entity: 'information_management_reviews', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'approved' } });
    res.json({ ok: true });
  });

  router.post('/reviews/:id/close', requirePermission('information_management', 'approve'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM information_management_reviews WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Review not found' });
    db.prepare("UPDATE information_management_reviews SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    audit(req, { action: 'close', entity: 'information_management_reviews', entityId: req.params.id, oldValue: { status: row.status }, newValue: { status: 'closed' } });
    res.json({ ok: true });
  });

  return router;
}
