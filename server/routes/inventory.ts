import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';

const EXPIRING_SOON_DAYS = 30;

function computeExpiryStatus(expiryDate: string | null | undefined): string {
  if (!expiryDate) return 'valid';
  const expiry = new Date(expiryDate).getTime();
  if (Number.isNaN(expiry)) return 'valid';
  const now = Date.now();
  if (expiry < now) return 'expired';
  if (expiry - now <= EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000) return 'expiring_soon';
  return 'valid';
}

export function inventoryRoutes() {
  const router = Router();

  // Legacy list (kept)
  router.get('/', requirePermission('supplier_inventory', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT i.*, s.name AS supplier_name, s.contact AS supplier_contact FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id ORDER BY i.created_at DESC`).all());
  });

  router.post('/', requirePermission('supplier_inventory', 'create'), (req, res) => {
    if (!(req.body.name || req.body.itemName)) return res.status(400).json({ error: 'name is required' });
    if (!req.body.category) return res.status(400).json({ error: 'category is required' });
    if (!(req.body.unit || req.body.unitOfMeasure)) return res.status(400).json({ error: 'unit is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const itemCode = generateRecordNumber(db, 'inventory_items', 'INV', createdAt);
    const result = db.prepare(`INSERT INTO inventory_items (item_code, name, category, supplier_id, location_id, quantity, unit, status, reorder_level, expiry_date, storage_requirement, department_id, section_id, minimum_stock, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        itemCode,
        req.body.name ?? req.body.itemName,
        req.body.category,
        parseIntNullable(req.body.supplierId),
        parseIntNullable(req.body.locationId),
        Number(req.body.quantity) || 0,
        req.body.unit ?? req.body.unitOfMeasure,
        req.body.status ?? 'available',
        Number(req.body.reorderLevel) || 0,
        req.body.expiryDate ?? null,
        req.body.storageRequirement ?? null,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        Number(req.body.minimumStock) || 0,
        req.body.isActive === false ? 0 : 1,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'inventory_items', entityId: result.lastInsertRowid, newValue: { itemCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, itemCode });
  });

  // Items
  router.get('/items', requirePermission('supplier_inventory', 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT i.*, s.name AS supplier_name FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id ORDER BY i.name`).all() as any[];
    res.json(rows.map(row => ({ ...row, item_name: row.name, unit_of_measure: row.unit, expiry_status: computeExpiryStatus(row.expiry_date), low_stock: row.quantity <= (row.minimum_stock || row.reorder_level || 0) })));
  });

  router.post('/items', requirePermission('supplier_inventory', 'create'), (req, res) => {
    if (!(req.body.name || req.body.itemName)) return res.status(400).json({ error: 'name is required' });
    if (!req.body.category) return res.status(400).json({ error: 'category is required' });
    if (!(req.body.unit || req.body.unitOfMeasure)) return res.status(400).json({ error: 'unit is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const itemCode = generateRecordNumber(db, 'inventory_items', 'INV', createdAt);
    const result = db.prepare(`INSERT INTO inventory_items (item_code, name, category, supplier_id, location_id, quantity, unit, status, reorder_level, expiry_date, storage_requirement, department_id, section_id, minimum_stock, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        itemCode,
        req.body.name ?? req.body.itemName,
        req.body.category,
        parseIntNullable(req.body.supplierId),
        parseIntNullable(req.body.locationId),
        Number(req.body.quantity) || 0,
        req.body.unit ?? req.body.unitOfMeasure,
        req.body.status ?? 'available',
        Number(req.body.reorderLevel) || 0,
        req.body.expiryDate ?? null,
        req.body.storageRequirement ?? null,
        parseIntNullable(req.body.departmentId),
        parseIntNullable(req.body.sectionId),
        Number(req.body.minimumStock) || 0,
        req.body.isActive === false ? 0 : 1,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'inventory_items', entityId: result.lastInsertRowid, newValue: { itemCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, itemCode });
  });

  router.get('/items/:id', requirePermission('supplier_inventory', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare(`SELECT i.*, s.name AS supplier_name FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?`).get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const batches = db.prepare('SELECT * FROM inventory_batches WHERE item_id = ? ORDER BY expiry_date ASC, date_received ASC').all(req.params.id);
    const movements = db.prepare('SELECT * FROM inventory_movements WHERE item_id = ? ORDER BY movement_date DESC LIMIT 100').all(req.params.id);
    res.json({ ...item, item_name: item.name, unit_of_measure: item.unit, expiry_status: computeExpiryStatus(item.expiry_date), low_stock: item.quantity <= (item.minimum_stock || item.reorder_level || 0), batches, movements });
  });

  router.put('/items/:id', requirePermission('supplier_inventory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Inventory item not found' });
    db.prepare(`UPDATE inventory_items SET name = ?, category = ?, supplier_id = ?, location_id = ?, quantity = ?, unit = ?, status = ?, reorder_level = ?, expiry_date = ?, storage_requirement = ?, department_id = ?, section_id = ?, minimum_stock = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.name ?? req.body.itemName ?? oldValue.name,
        req.body.category ?? oldValue.category,
        parseIntNullable(req.body.supplierId) ?? oldValue.supplier_id,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        req.body.quantity !== undefined ? Number(req.body.quantity) : oldValue.quantity,
        req.body.unit ?? req.body.unitOfMeasure ?? oldValue.unit,
        req.body.status ?? oldValue.status,
        req.body.reorderLevel !== undefined ? Number(req.body.reorderLevel) : oldValue.reorder_level,
        req.body.expiryDate ?? oldValue.expiry_date,
        req.body.storageRequirement ?? oldValue.storage_requirement,
        parseIntNullable(req.body.departmentId) ?? oldValue.department_id,
        parseIntNullable(req.body.sectionId) ?? oldValue.section_id,
        req.body.minimumStock !== undefined ? Number(req.body.minimumStock) : oldValue.minimum_stock,
        req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : oldValue.is_active,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // Batches
  router.post('/items/:id/batches', requirePermission('supplier_inventory', 'create'), (req, res) => {
    if (req.body.quantityReceived === undefined || req.body.quantityReceived === '' || req.body.quantityReceived === null) return res.status(400).json({ error: 'quantityReceived is required' });
    if (!req.body.dateReceived) return res.status(400).json({ error: 'dateReceived is required' });
    const db = getDb();
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const qtyReceived = Number(req.body.quantityReceived);
    const qtyAvailable = req.body.quantityAvailable !== undefined ? Number(req.body.quantityAvailable) : qtyReceived;
    if (qtyReceived < 0 || qtyAvailable < 0) return res.status(400).json({ error: 'Quantities cannot be negative' });
    const result = db.prepare(`INSERT INTO inventory_batches (item_id, batch_number, lot_number, supplier_id, supplier_name, quantity_received, quantity_available, date_received, expiry_date, acceptance_status, acceptance_checked_by_staff_id, acceptance_date, storage_location_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        req.body.batchNumber ?? null,
        req.body.lotNumber ?? null,
        parseIntNullable(req.body.supplierId) ?? item.supplier_id,
        req.body.supplierName ?? null,
        qtyReceived,
        qtyAvailable,
        req.body.dateReceived,
        req.body.expiryDate ?? null,
        req.body.acceptanceStatus ?? 'pending',
        parseIntNullable(req.body.acceptanceCheckedByStaffId),
        req.body.acceptanceDate ?? null,
        parseIntNullable(req.body.storageLocationId) ?? item.location_id,
        req.body.status ?? 'available',
        req.user!.id
      );
    db.prepare('UPDATE inventory_items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qtyAvailable, req.params.id);
    audit(req, { action: 'create', entity: 'inventory_batches', entityId: result.lastInsertRowid, newValue: { itemId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.get('/batches', requirePermission('supplier_inventory', 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT b.*, i.name AS item_name, i.unit AS unit_of_measure FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id ORDER BY b.expiry_date ASC, b.date_received ASC`).all() as any[];
    res.json(rows.map(row => ({ ...row, expiry_status: computeExpiryStatus(row.expiry_date) })));
  });

  router.post('/batches/:id/movement', requirePermission('supplier_inventory', 'create'), (req, res) => {
    if (!req.body.movementType) return res.status(400).json({ error: 'movementType is required' });
    if (req.body.quantity === undefined || req.body.quantity === '') return res.status(400).json({ error: 'quantity is required' });
    const db = getDb();
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const qty = Number(req.body.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be positive' });
    const isOut = ['issue', 'consume', 'discard', 'waste', 'transfer_out'].includes(req.body.movementType);
    const isIn = ['receive', 'return', 'adjust_in', 'transfer_in'].includes(req.body.movementType);
    if (isOut && batch.quantity_available < qty) return res.status(400).json({ error: 'Insufficient batch stock; movement would create negative stock' });
    const delta = isOut ? -qty : isIn ? qty : 0;
    const movementDate = req.body.movementDate ?? new Date().toISOString();
    const receivedBy = getStaffIdOrCurrent(req, req.body.receivedByStaffId);
    const result = db.prepare(`INSERT INTO inventory_movements (item_id, batch_id, movement_type, quantity, movement_date, issued_to_section_id, received_by_staff_id, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        batch.item_id,
        req.params.id,
        req.body.movementType,
        qty,
        movementDate,
        parseIntNullable(req.body.issuedToSectionId),
        receivedBy,
        req.body.reason ?? null,
        req.user!.id
      );
    if (delta !== 0) {
      db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(delta, req.params.id);
      db.prepare('UPDATE inventory_items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(delta, batch.item_id);
    }
    audit(req, { action: 'create', entity: 'inventory_movements', entityId: result.lastInsertRowid, newValue: { batchId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/batches/:id/acceptance', requirePermission('supplier_inventory', 'edit'), (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const checkedBy = getStaffIdOrCurrent(req, req.body.acceptanceCheckedByStaffId);
    if (checkedBy === null) return res.status(400).json({ error: 'This action requires the logged-in user to be linked to a staff record.' });
    const status = req.body.acceptanceStatus ?? 'accepted';
    db.prepare('UPDATE inventory_batches SET acceptance_status = ?, acceptance_checked_by_staff_id = ?, acceptance_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, checkedBy, req.params.id);
    audit(req, { action: 'edit', entity: 'inventory_batches', entityId: req.params.id, oldValue: batch, newValue: { acceptanceStatus: status, acceptanceCheckedByStaffId: checkedBy } });
    res.json({ ok: true });
  });

  router.post('/batches/:id/create-nc', requirePermission('nc_capa', 'create'), (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT b.*, i.name AS item_name FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = ?').get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const createdAt = new Date().toISOString();
    const ncNumber = generateRecordNumber(db, 'nonconforming_events', 'NC', createdAt);
    const detectedBy = getStaffIdOrCurrent(req, req.body.detectedByStaffId);
    const ncResult = db.prepare(`INSERT INTO nonconforming_events (nc_number, event_date, detected_by_staff_id, source_module, source_record_id, title, description, category, severity, immediate_correction, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        ncNumber,
        createdAt,
        detectedBy,
        'supplier_inventory',
        String(batch.id),
        req.body.title ?? `Inventory batch issue: ${batch.item_name}`,
        req.body.description ?? `Batch ${batch.batch_number ?? batch.id}`,
        req.body.category ?? 'inventory',
        req.body.severity ?? 'medium',
        req.body.immediateCorrection ?? null,
        'open',
        req.user!.id,
        createdAt
      );
    const ncId = Number(ncResult.lastInsertRowid);
    db.prepare('INSERT INTO record_links (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run('supplier_inventory', 'inventory_batches', String(req.params.id), 'nc_capa', 'nonconforming_events', String(ncId), 'NC from inventory batch issue');
    audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { ncNumber, sourceModule: 'supplier_inventory', sourceRecordId: req.params.id } });
    res.status(201).json({ id: ncId, ncNumber });
  });

  // Suppliers
  router.get('/suppliers', requirePermission('supplier_inventory', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all());
  });

  router.post('/suppliers', requirePermission('supplier_inventory', 'create'), (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'name is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const supplierCode = generateRecordNumber(db, 'suppliers', 'SUP', createdAt);
    const result = db.prepare(`INSERT INTO suppliers (supplier_code, name, contact, phone, email, address, status, contact_person, item_category, evaluation_required, last_evaluation_date, next_evaluation_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        supplierCode,
        req.body.name,
        req.body.contact ?? null,
        req.body.phone ?? null,
        req.body.email ?? null,
        req.body.address ?? null,
        req.body.status ?? 'active',
        req.body.contactPerson ?? null,
        req.body.itemCategory ?? null,
        req.body.evaluationRequired ? 1 : 0,
        req.body.lastEvaluationDate ?? null,
        req.body.nextEvaluationDue ?? null,
        createdAt
      );
    audit(req, { action: 'create', entity: 'suppliers', entityId: result.lastInsertRowid, newValue: { supplierCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, supplierCode });
  });

  router.put('/suppliers/:id', requirePermission('supplier_inventory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Supplier not found' });
    db.prepare(`UPDATE suppliers SET name = ?, contact = ?, phone = ?, email = ?, address = ?, status = ?, contact_person = ?, item_category = ?, evaluation_required = ?, last_evaluation_date = ?, next_evaluation_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body.name ?? oldValue.name,
        req.body.contact ?? oldValue.contact,
        req.body.phone ?? oldValue.phone,
        req.body.email ?? oldValue.email,
        req.body.address ?? oldValue.address,
        req.body.status ?? oldValue.status,
        req.body.contactPerson ?? oldValue.contact_person,
        req.body.itemCategory ?? oldValue.item_category,
        req.body.evaluationRequired !== undefined ? (req.body.evaluationRequired ? 1 : 0) : oldValue.evaluation_required,
        req.body.lastEvaluationDate ?? oldValue.last_evaluation_date,
        req.body.nextEvaluationDue ?? oldValue.next_evaluation_due,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'suppliers', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/suppliers/:id/evaluation', requirePermission('supplier_inventory', 'create'), (req, res) => {
    const db = getDb();
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const evaluatedBy = getStaffIdOrCurrent(req, req.body.evaluatedByStaffId);
    const evalDate = req.body.evaluationDate ?? new Date().toISOString();
    const result = db.prepare(`INSERT INTO supplier_evaluations (supplier_id, evaluation_date, evaluated_by_staff_id, rating, findings, action_required, next_evaluation_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        req.params.id,
        evalDate,
        evaluatedBy,
        req.body.rating ?? null,
        req.body.findings ?? null,
        req.body.actionRequired ?? null,
        req.body.nextEvaluationDate ?? null,
        req.user!.id
      );
    db.prepare('UPDATE suppliers SET last_evaluation_date = ?, next_evaluation_due = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(evalDate, req.body.nextEvaluationDate ?? null, req.params.id);
    audit(req, { action: 'create', entity: 'supplier_evaluations', entityId: result.lastInsertRowid, newValue: { supplierId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  // Legacy generic item lookup — MUST come AFTER /items, /batches, /suppliers so those specific paths win
  router.get('/:id', requirePermission('supplier_inventory', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT i.*, s.name AS supplier_name, s.contact AS supplier_contact FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    res.json(item);
  });

  router.put('/:id', requirePermission('supplier_inventory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id) as any;
    if (!oldValue) return res.status(404).json({ error: 'Inventory item not found' });
    db.prepare('UPDATE inventory_items SET name = ?, category = ?, supplier_id = ?, location_id = ?, quantity = ?, unit = ?, status = ?, reorder_level = ?, expiry_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.name ?? oldValue.name,
        req.body.category ?? oldValue.category,
        parseIntNullable(req.body.supplierId) ?? oldValue.supplier_id,
        parseIntNullable(req.body.locationId) ?? oldValue.location_id,
        req.body.quantity !== undefined ? Number(req.body.quantity) : oldValue.quantity,
        req.body.unit ?? oldValue.unit,
        req.body.status ?? oldValue.status,
        req.body.reorderLevel !== undefined ? Number(req.body.reorderLevel) : oldValue.reorder_level,
        req.body.expiryDate ?? oldValue.expiry_date,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}

export { computeExpiryStatus };
