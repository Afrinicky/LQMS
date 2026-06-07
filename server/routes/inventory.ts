import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';

export function inventoryRoutes() {
  const router = Router();

  router.get('/', requirePermission('supplier_inventory', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT i.*, s.name AS supplier_name, s.contact AS supplier_contact FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id ORDER BY i.created_at DESC`).all());
  });

  router.get('/suppliers', requirePermission('supplier_inventory', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all());
  });

  router.get('/:id', requirePermission('supplier_inventory', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT i.*, s.name AS supplier_name, s.contact AS supplier_contact FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    res.json(item);
  });

  router.post('/', requirePermission('supplier_inventory', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const itemCode = generateRecordNumber(db, 'inventory_items', 'INV', createdAt);
    const result = db.prepare('INSERT INTO inventory_items (item_code, name, category, supplier_id, location_id, quantity, unit, status, reorder_level, expiry_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        itemCode,
        req.body.name,
        req.body.category ?? null,
        parseIntNullable(req.body.supplierId),
        parseIntNullable(req.body.locationId),
        Number(req.body.quantity) || 0,
        req.body.unit ?? null,
        req.body.status ?? 'available',
        Number(req.body.reorderLevel) || 0,
        req.body.expiryDate ?? null,
        req.user!.id,
        createdAt
      );
    audit(req, { action: 'create', entity: 'inventory_items', entityId: result.lastInsertRowid, newValue: { itemCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, itemCode });
  });

  router.post('/suppliers', requirePermission('supplier_inventory', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const supplierCode = generateRecordNumber(db, 'suppliers', 'SUP', createdAt);
    const result = db.prepare('INSERT INTO suppliers (supplier_code, name, contact, phone, email, address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(supplierCode, req.body.name, req.body.contact ?? null, req.body.phone ?? null, req.body.email ?? null, req.body.address ?? null, req.body.status ?? 'active', createdAt);
    audit(req, { action: 'create', entity: 'suppliers', entityId: result.lastInsertRowid, newValue: { supplierCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, supplierCode });
  });

  router.put('/:id', requirePermission('supplier_inventory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Inventory item not found' });
    db.prepare('UPDATE inventory_items SET name = ?, category = ?, supplier_id = ?, location_id = ?, quantity = ?, unit = ?, status = ?, reorder_level = ?, expiry_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.name ?? oldValue.name,
        req.body.category ?? oldValue.category,
        parseIntNullable(req.body.supplierId),
        parseIntNullable(req.body.locationId),
        Number(req.body.quantity) || oldValue.quantity,
        req.body.unit ?? oldValue.unit,
        req.body.status ?? oldValue.status,
        Number(req.body.reorderLevel) || oldValue.reorder_level,
        req.body.expiryDate ?? oldValue.expiry_date,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  router.put('/suppliers/:id', requirePermission('supplier_inventory', 'edit'), (req, res) => {
    const db = getDb();
    const oldValue = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!oldValue) return res.status(404).json({ error: 'Supplier not found' });
    db.prepare('UPDATE suppliers SET name = ?, contact = ?, phone = ?, email = ?, address = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(
        req.body.name ?? oldValue.name,
        req.body.contact ?? oldValue.contact,
        req.body.phone ?? oldValue.phone,
        req.body.email ?? oldValue.email,
        req.body.address ?? oldValue.address,
        req.body.status ?? oldValue.status,
        req.params.id
      );
    audit(req, { action: 'edit', entity: 'suppliers', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}
