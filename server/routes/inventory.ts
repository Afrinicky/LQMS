import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import {
  STORAGE_KINDS, normaliseBarcodePolicy, DEFAULT_BARCODE_POLICY, BARCODE_SOURCES,
  ISSUING_MOVEMENTS, ACCEPTANCE_STATES, effectiveBarcode, type BarcodePolicy,
} from '../../shared/constants/inventory.js';

import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';

const BARCODE_POLICY_KEY = 'inventory.barcodePolicy';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/**
 * The item register as a spreadsheet, and back again.
 *
 * The columns are the register's own, so an export is a working document a
 * storekeeper can edit and hand back — not a blank template that throws away
 * what is already recorded. Rows are matched on Item code: a row that carries
 * one updates that item, a row without one creates a new item.
 */
const REGISTER_COLUMNS = [
  'Item code', 'Name', 'Category', 'Unit', 'Manufacturer', 'Catalogue number',
  'Product barcode', 'Barcode source', 'Supplier', 'Storage location', 'Unit / section',
  'Quantity', 'Minimum stock', 'Reorder level', 'Storage requirement', 'Expiry date', 'Status',
] as const;

/** What the laboratory does about barcodes by default. */
function getBarcodePolicy(): BarcodePolicy {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(BARCODE_POLICY_KEY) as { value: string } | undefined;
    return row ? normaliseBarcodePolicy(JSON.parse(row.value)) : { ...DEFAULT_BARCODE_POLICY };
  } catch { return { ...DEFAULT_BARCODE_POLICY }; }
}

/**
 * A storage location's full path — "Main Store › Shelf B3".
 *
 * A shelf called "B3" means nothing on its own; the register has to say which
 * B3, and an assessor asked to be shown the stock has to be able to walk to it.
 */
function storagePaths(): Map<number, string> {
  const rows = getDb().prepare('SELECT id, name, parent_id FROM storage_locations').all() as { id: number; name: string; parent_id: number | null }[];
  const byId = new Map(rows.map(r => [r.id, r]));
  const path = (id: number, seen = new Set<number>()): string => {
    const r = byId.get(id);
    if (!r || seen.has(id)) return r?.name ?? '';
    seen.add(id);
    return r.parent_id ? `${path(r.parent_id, seen)} › ${r.name}` : r.name;
  };
  return new Map(rows.map(r => [r.id, path(r.id)]));
}

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

  // ===== Where stock lives =====
  //
  // A tree, because a laboratory stores things in a shelf in a fridge in a
  // store. Served flat with each row's full path, so a dropdown can show
  // "Main Store › Shelf B3" without the client rebuilding the tree.
  router.get('/storage-locations', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const paths = storagePaths();
    const includeInactive = String(req.query.includeInactive || '') === 'true';
    const rows = getDb().prepare(`
      SELECT l.*, sec.name AS section_name,
        (SELECT COUNT(*) FROM inventory_items i WHERE i.storage_location_id = l.id) AS item_count,
        (SELECT COUNT(*) FROM storage_locations c WHERE c.parent_id = l.id) AS child_count
      FROM storage_locations l LEFT JOIN sections sec ON sec.id = l.section_id
      ${includeInactive ? '' : 'WHERE l.is_active = 1'}
      ORDER BY l.display_order, l.name`).all() as any[];
    res.json(rows.map(r => ({ ...r, path: paths.get(r.id) ?? r.name })));
  });

  router.post('/storage-locations', requirePermission('settings', 'edit'), (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required — the shelf, fridge or store as people call it.' });
    const kind = STORAGE_KINDS.includes(req.body?.kind) ? req.body.kind : 'shelf';
    const db = getDb();
    const parentId = parseIntNullable(req.body?.parentId);
    if (parentId && !db.prepare('SELECT id FROM storage_locations WHERE id = ?').get(parentId)) {
      return res.status(400).json({ error: 'That parent place no longer exists.' });
    }
    const order = (db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 n FROM storage_locations WHERE parent_id IS ?').get(parentId) as { n: number }).n;
    const r = db.prepare(`INSERT INTO storage_locations (name, kind, parent_id, section_id, code, description, temp_min, temp_max, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, kind, parentId, parseIntNullable(req.body?.sectionId), req.body?.code || null, req.body?.description || null,
        req.body?.tempMin === '' || req.body?.tempMin == null ? null : Number(req.body.tempMin),
        req.body?.tempMax === '' || req.body?.tempMax == null ? null : Number(req.body.tempMax), order);
    audit(req, { action: 'create', entity: 'storage_locations', entityId: r.lastInsertRowid, newValue: { name, kind, parentId } });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  router.put('/storage-locations/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Storage location not found' });
    // A place cannot be moved inside itself, or inside its own descendant.
    const parentId = req.body?.parentId !== undefined ? parseIntNullable(req.body.parentId) : row.parent_id;
    if (parentId) {
      let walk: number | null = parentId;
      const seen = new Set<number>();
      while (walk) {
        if (walk === row.id) return res.status(400).json({ error: 'A storage place cannot be put inside itself.' });
        if (seen.has(walk)) break;
        seen.add(walk);
        walk = (db.prepare('SELECT parent_id FROM storage_locations WHERE id = ?').get(walk) as { parent_id: number | null } | undefined)?.parent_id ?? null;
      }
    }
    const num = (v: unknown, fallback: number | null) => (v === undefined ? fallback : v === '' || v === null ? null : Number(v));
    db.prepare(`UPDATE storage_locations SET name = ?, kind = ?, parent_id = ?, section_id = ?, code = ?, description = ?,
      temp_min = ?, temp_max = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        req.body?.name !== undefined ? String(req.body.name).trim() || row.name : row.name,
        STORAGE_KINDS.includes(req.body?.kind) ? req.body.kind : row.kind,
        parentId,
        req.body?.sectionId !== undefined ? parseIntNullable(req.body.sectionId) : row.section_id,
        req.body?.code !== undefined ? (req.body.code || null) : row.code,
        req.body?.description !== undefined ? (req.body.description || null) : row.description,
        num(req.body?.tempMin, row.temp_min), num(req.body?.tempMax, row.temp_max),
        req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : row.is_active,
        row.id);
    audit(req, { action: 'edit', entity: 'storage_locations', entityId: row.id, oldValue: row, newValue: req.body });
    res.json({ ok: true });
  });

  router.delete('/storage-locations/:id', requirePermission('settings', 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Storage location not found' });
    const kids = (db.prepare('SELECT COUNT(*) c FROM storage_locations WHERE parent_id = ?').get(row.id) as { c: number }).c;
    if (kids) return res.status(400).json({ error: `“${row.name}” still holds ${kids} place${kids === 1 ? '' : 's'}. Empty it first.` });
    const held = (db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE storage_location_id = ?').get(row.id) as { c: number }).c;
    if (held) return res.status(400).json({ error: `${held} stock item${held === 1 ? ' is' : 's are'} stored here. Move them first, or deactivate this place instead.` });
    db.prepare('DELETE FROM storage_locations WHERE id = ?').run(row.id);
    audit(req, { action: 'delete', entity: 'storage_locations', entityId: row.id, oldValue: row });
    res.json({ ok: true });
  });

  // ===== The barcode policy =====
  router.get('/barcode-policy', requirePermission('supplier_inventory.stock', 'view'), (_req, res) => res.json(getBarcodePolicy()));
  router.put('/barcode-policy', requirePermission('settings', 'edit'), (req, res) => {
    const policy = normaliseBarcodePolicy(req.body);
    getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(BARCODE_POLICY_KEY, JSON.stringify(policy));
    audit(req, { action: 'edit', entity: 'settings', entityId: BARCODE_POLICY_KEY, newValue: policy });
    res.json(policy);
  });

  // Find an item by whatever was scanned — its own barcode or ours.
  router.get('/scan/:code', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const code = String(req.params.code).trim();
    const db = getDb();
    const item = db.prepare(`SELECT * FROM inventory_items
      WHERE item_code = ? COLLATE NOCASE OR (product_barcode IS NOT NULL AND product_barcode = ? COLLATE NOCASE)`).get(code, code) as any;
    if (item) return res.json({ kind: 'item', id: item.id, name: item.name, itemCode: item.item_code });
    // A scan may also be a batch's own barcode, which is how a delivery is checked in.
    const batch = db.prepare(`SELECT b.*, i.name item_name FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
      WHERE b.product_barcode = ? COLLATE NOCASE OR b.batch_number = ? COLLATE NOCASE`).get(code, code) as any;
    if (batch) return res.json({ kind: 'batch', id: batch.id, itemId: batch.item_id, name: batch.item_name });
    res.status(404).json({ error: `Nothing in the register answers to “${code}”.` });
  });

  // ===== The register as a spreadsheet =====
  router.get('/items/export', requirePermission('supplier_inventory.stock', 'export'), (_req, res) => {
    const db = getDb();
    const paths = storagePaths();
    const rows = db.prepare(`SELECT i.*, s.name AS supplier_name, sec.name AS section_name
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN sections sec ON sec.id = i.section_id
      ORDER BY i.name`).all() as any[];
    const aoa = rows.map(r => [
      r.item_code, r.name, r.category ?? '', r.unit ?? '', r.manufacturer ?? '', r.catalogue_number ?? '',
      r.product_barcode ?? '', r.barcode_source ?? 'system', r.supplier_name ?? '',
      r.storage_location_id ? (paths.get(r.storage_location_id) ?? '') : '', r.section_name ?? '',
      r.quantity ?? 0, r.minimum_stock ?? 0, r.reorder_level ?? 0,
      r.storage_requirement ?? '', r.expiry_date ?? '', r.status ?? '',
    ]);
    sendWorkbook(res, buildWorkbook(REGISTER_COLUMNS, aoa, 'STOCK ITEM REGISTER'),
      `Stock_Item_Register-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  router.post('/items/import', requirePermission('supplier_inventory.stock', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let rows: Record<string, unknown>[];
    try { rows = readSheet(req.file.buffer, 'STOCK'); }
    catch { return res.status(400).json({ error: 'Could not read that spreadsheet. Export the register first and edit that file.' }); }

    const db = getDb();
    // Names are matched to what the laboratory already has, so a storekeeper
    // types "Main Store › Shelf B" or just "Shelf B" and it lands correctly.
    const paths = storagePaths();
    const storageByPath = new Map<string, number>();
    for (const [id, path] of paths) {
      storageByPath.set(path.toLowerCase(), id);
      storageByPath.set(path.split('›').pop()!.trim().toLowerCase(), id);
    }
    const supplierByName = new Map((db.prepare('SELECT id, name FROM suppliers').all() as any[]).map(r => [String(r.name).toLowerCase(), r.id]));
    const sectionByName = new Map((db.prepare('SELECT id, name FROM sections').all() as any[]).map(r => [String(r.name).toLowerCase(), r.id]));
    const policy = getBarcodePolicy();

    const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
    const tx = db.transaction(() => {
      rows.forEach((row, idx) => {
        const line = idx + 2;
        const name = cell(row, 'Name');
        const code = cell(row, 'Item code');
        if (!name && !code) { result.skipped++; return; }
        if (!name) { result.errors.push(`Row ${line}: a name is required.`); return; }
        const category = cell(row, 'Category');
        const unit = cell(row, 'Unit');
        if (!category || !unit) { result.errors.push(`Row ${line}: “${name}” needs both a category and a unit.`); return; }

        const storageText = cell(row, 'Storage location');
        const storageId = storageText ? storageByPath.get(storageText.toLowerCase()) ?? null : null;
        if (storageText && !storageId) result.errors.push(`Row ${line}: no storage place called “${storageText}” — the item was saved without one.`);
        const supplierText = cell(row, 'Supplier');
        const sectionText = cell(row, 'Unit / section');
        const productBarcode = cell(row, 'Product barcode');
        const sourceText = (cell(row, 'Barcode source') || '').toLowerCase();
        const source = sourceText === 'product' ? 'product' : sourceText === 'system' ? 'system' : (productBarcode ? 'product' : policy.defaultSource);
        if (source === 'product' && !productBarcode) {
          result.errors.push(`Row ${line}: “${name}” is set to use the product's barcode but none is given.`);
          return;
        }

        const fields: Record<string, unknown> = {
          name, category, unit,
          manufacturer: cell(row, 'Manufacturer'),
          catalogue_number: cell(row, 'Catalogue number'),
          product_barcode: productBarcode,
          barcode_source: source,
          supplier_id: supplierText ? supplierByName.get(supplierText.toLowerCase()) ?? null : null,
          storage_location_id: storageId,
          section_id: sectionText ? sectionByName.get(sectionText.toLowerCase()) ?? null : null,
          quantity: numCell(row, 'Quantity') ?? 0,
          minimum_stock: numCell(row, 'Minimum stock') ?? 0,
          reorder_level: numCell(row, 'Reorder level') ?? 0,
          storage_requirement: cell(row, 'Storage requirement'),
          expiry_date: cell(row, 'Expiry date'),
          status: cell(row, 'Status') || 'available',
        };

        try {
          const existing = code ? db.prepare('SELECT id FROM inventory_items WHERE item_code = ?').get(code) as { id: number } | undefined : undefined;
          if (productBarcode) {
            const clash = db.prepare('SELECT id, name FROM inventory_items WHERE product_barcode = ? COLLATE NOCASE').get(productBarcode) as { id: number; name: string } | undefined;
            if (clash && (!existing || clash.id !== existing.id)) {
              result.errors.push(`Row ${line}: the barcode on “${name}” already belongs to “${clash.name}”.`);
              return;
            }
          }
          if (existing) {
            const keys = Object.keys(fields);
            db.prepare(`UPDATE inventory_items SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(...keys.map(k => fields[k]), existing.id);
            result.updated++;
          } else {
            const createdAt = new Date().toISOString();
            const itemCode = code || generateRecordNumber(db, 'inventory_items', 'INV', createdAt);
            const all = { item_code: itemCode, ...fields, is_active: 1, created_by: req.user!.id, created_at: createdAt };
            const keys = Object.keys(all);
            db.prepare(`INSERT INTO inventory_items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
              .run(...keys.map(k => (all as Record<string, unknown>)[k]));
            result.created++;
          }
        } catch (err) {
          result.errors.push(`Row ${line}: ${err instanceof Error ? err.message : 'could not be saved'}`);
        }
      });
    });
    tx();
    audit(req, { action: 'import', entity: 'inventory_items', newValue: { created: result.created, updated: result.updated, skipped: result.skipped } });
    res.json(result);
  });

  // Legacy list (kept)
  router.get('/', requirePermission('supplier_inventory.stock', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT i.*, s.name AS supplier_name, s.contact AS supplier_contact FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id ORDER BY i.created_at DESC`).all());
  });

  router.post('/', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
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
  router.get('/items', requirePermission('supplier_inventory.stock', 'view'), (_req, res) => {
    const db = getDb();
    const paths = storagePaths();
    const rows = db.prepare(`SELECT i.*, s.name AS supplier_name, sec.name AS section_name, l.name AS storage_name
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN sections sec ON sec.id = i.section_id
      LEFT JOIN storage_locations l ON l.id = i.storage_location_id
      ORDER BY i.name`).all() as any[];
    res.json(rows.map(row => ({
      ...row, item_name: row.name, unit_of_measure: row.unit,
      storage_path: row.storage_location_id ? paths.get(row.storage_location_id) ?? row.storage_name : null,
      barcode: effectiveBarcode(row),
      expiry_status: computeExpiryStatus(row.expiry_date),
      low_stock: row.quantity <= (row.minimum_stock || row.reorder_level || 0),
    })));
  });

  router.post('/items', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
    if (!(req.body.name || req.body.itemName)) return res.status(400).json({ error: 'name is required' });
    if (!req.body.category) return res.status(400).json({ error: 'category is required' });
    if (!(req.body.unit || req.body.unitOfMeasure)) return res.status(400).json({ error: 'unit is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const itemCode = generateRecordNumber(db, 'inventory_items', 'INV', createdAt);
    // An item that is to answer to the barcode already on the box must be told
    // what that barcode is; otherwise a scan matches nothing and the person
    // scanning concludes the system is broken.
    const policy = getBarcodePolicy();
    const requested = BARCODE_SOURCES.includes(req.body.barcodeSource) ? req.body.barcodeSource : policy.defaultSource;
    const productBarcode = String(req.body.productBarcode ?? '').trim() || null;
    if (requested === 'product' && !productBarcode) {
      return res.status(400).json({ error: 'This item is set to use the barcode printed on the product, so that barcode has to be entered — scan it from the box, or switch the item to a barcode SECH_LIMS generates.' });
    }
    if (productBarcode) {
      const clash = db.prepare('SELECT name FROM inventory_items WHERE product_barcode = ? COLLATE NOCASE').get(productBarcode) as { name: string } | undefined;
      if (clash) return res.status(400).json({ error: `That barcode already belongs to “${clash.name}”.` });
    }
    const cols: Record<string, unknown> = {
      item_code: itemCode,
      name: req.body.name ?? req.body.itemName,
      category: req.body.category,
      supplier_id: parseIntNullable(req.body.supplierId),
      location_id: parseIntNullable(req.body.locationId),
      storage_location_id: parseIntNullable(req.body.storageLocationId),
      quantity: Number(req.body.quantity) || 0,
      unit: req.body.unit ?? req.body.unitOfMeasure,
      status: req.body.status ?? 'available',
      reorder_level: Number(req.body.reorderLevel) || 0,
      expiry_date: req.body.expiryDate || null,
      storage_requirement: req.body.storageRequirement || null,
      department_id: parseIntNullable(req.body.departmentId),
      section_id: parseIntNullable(req.body.sectionId),
      minimum_stock: Number(req.body.minimumStock) || 0,
      product_barcode: productBarcode,
      barcode_source: requested,
      catalogue_number: req.body.catalogueNumber || null,
      manufacturer: req.body.manufacturer || null,
      is_active: req.body.isActive === false ? 0 : 1,
      created_by: req.user!.id,
      created_at: createdAt,
    };
    const keys = Object.keys(cols);
    const result = db.prepare(`INSERT INTO inventory_items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map(k => cols[k]));
    audit(req, { action: 'create', entity: 'inventory_items', entityId: result.lastInsertRowid, newValue: { itemCode, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, itemCode, barcode: effectiveBarcode({ item_code: itemCode, product_barcode: productBarcode, barcode_source: requested }) });
  });

  router.get('/items/:id', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare(`SELECT i.*, s.name AS supplier_name FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?`).get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const batches = db.prepare('SELECT * FROM inventory_batches WHERE item_id = ? ORDER BY expiry_date ASC, date_received ASC').all(req.params.id);
    const movements = db.prepare('SELECT * FROM inventory_movements WHERE item_id = ? ORDER BY movement_date DESC LIMIT 100').all(req.params.id);
    res.json({ ...item, item_name: item.name, unit_of_measure: item.unit, expiry_status: computeExpiryStatus(item.expiry_date), low_stock: item.quantity <= (item.minimum_stock || item.reorder_level || 0), batches, movements });
  });

  router.put('/items/:id', requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
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
    // The storage place and the barcode are edited through the same form, so
    // they are saved here rather than needing a second call.
    if (req.body.storageLocationId !== undefined) {
      db.prepare('UPDATE inventory_items SET storage_location_id = ? WHERE id = ?').run(parseIntNullable(req.body.storageLocationId), req.params.id);
    }
    if (req.body.productBarcode !== undefined || req.body.barcodeSource !== undefined) {
      const source = BARCODE_SOURCES.includes(req.body.barcodeSource) ? req.body.barcodeSource : oldValue.barcode_source;
      const barcode = req.body.productBarcode !== undefined ? (String(req.body.productBarcode).trim() || null) : oldValue.product_barcode;
      if (source === 'product' && !barcode) {
        return res.status(400).json({ error: 'This item is set to use the barcode printed on the product, so that barcode has to be entered.' });
      }
      if (barcode) {
        const clash = db.prepare('SELECT name FROM inventory_items WHERE product_barcode = ? COLLATE NOCASE AND id != ?').get(barcode, req.params.id) as { name: string } | undefined;
        if (clash) return res.status(400).json({ error: `That barcode already belongs to “${clash.name}”.` });
      }
      db.prepare('UPDATE inventory_items SET product_barcode = ?, barcode_source = ? WHERE id = ?').run(barcode, source, req.params.id);
    }
    for (const [key, col] of [['catalogueNumber', 'catalogue_number'], ['manufacturer', 'manufacturer']] as const) {
      if (req.body[key] !== undefined) db.prepare(`UPDATE inventory_items SET ${col} = ? WHERE id = ?`).run(req.body[key] || null, req.params.id);
    }
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  // Batches
  router.post('/items/:id/batches', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
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

  router.get('/batches', requirePermission('supplier_inventory.stock', 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT b.*, i.name AS item_name, i.unit AS unit_of_measure FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id ORDER BY b.expiry_date ASC, b.date_received ASC`).all() as any[];
    res.json(rows.map(row => ({ ...row, expiry_status: computeExpiryStatus(row.expiry_date) })));
  });

  router.post('/batches/:id/movement', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
    if (!req.body.movementType) return res.status(400).json({ error: 'movementType is required' });
    if (req.body.quantity === undefined || req.body.quantity === '') return res.status(400).json({ error: 'quantity is required' });
    const db = getDb();
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(req.params.id) as any;
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const qty = Number(req.body.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be positive' });
    const isOut = ISSUING_MOVEMENTS.includes(req.body.movementType);
    const isIn = ['receive', 'return', 'adjust_in', 'transfer_in'].includes(req.body.movementType);
    if (isOut && batch.quantity_available < qty) return res.status(400).json({ error: 'Insufficient batch stock; movement would create negative stock' });

    // ---- The three controls that make this stock control rather than a tally.
    //
    // ISO 15189 §6.6 asks that externally provided products are not used until
    // they have been verified as meeting the laboratory's requirements, and
    // §6.4.3 that reagents are used within their expiry. Discarding is the one
    // thing you MUST still be able to do to a bad batch, so it is never blocked.
    const disposal = ['discard', 'waste'].includes(req.body.movementType);
    if (isOut && !disposal) {
      if (batch.acceptance_status === 'pending' || batch.acceptance_status === 'quarantined') {
        return res.status(400).json({ error: 'This batch is still in quarantine — it has not been accepted on receipt. Inspect and accept it first, or discard it.' });
      }
      if (batch.acceptance_status === 'rejected') {
        return res.status(400).json({ error: 'This batch was rejected on receipt and must not be put into use. Discard it, or return it to the supplier.' });
      }
      if (computeExpiryStatus(batch.expiry_date) === 'expired') {
        return res.status(400).json({ error: `This batch expired on ${String(batch.expiry_date).slice(0, 10)} and cannot be issued. Discard it and issue from a batch that is in date.` });
      }
      // FEFO — first expiry, first out. Opening a newer box while an older one
      // sits behind it is how stock expires on a shelf, so the system says so.
      // It warns rather than refuses: a legitimate reason (a reserved lot, a
      // batch held for a repeat) is a decision the laboratory gets to make.
      //
      // Only a batch that could actually be issued counts. An expired one
      // cannot be, so naming it would send the storekeeper to a box the
      // system will refuse a moment later — and nothing for that item could
      // ever be issued again until it was cleared off the shelf.
      const today = new Date().toISOString().slice(0, 10);
      const older = db.prepare(`SELECT id, batch_number, expiry_date FROM inventory_batches
        WHERE item_id = ? AND id != ? AND quantity_available > 0
          AND acceptance_status = 'accepted'
          AND expiry_date IS NOT NULL AND expiry_date != ''
          AND date(expiry_date) >= date(?)
          AND (? IS NULL OR ? = '' OR expiry_date < ?)
        ORDER BY expiry_date LIMIT 1`).get(batch.item_id, batch.id, today, batch.expiry_date, batch.expiry_date, batch.expiry_date) as
        { id: number; batch_number: string | null; expiry_date: string } | undefined;
      if (older && req.body.overrideFefo !== true) {
        return res.status(409).json({
          error: `An older batch expires first — ${older.batch_number || `batch #${older.id}`}, expiring ${String(older.expiry_date).slice(0, 10)}. Issue that one, or confirm you mean to skip it.`,
          fefo: { batchId: older.id, batchNumber: older.batch_number, expiryDate: older.expiry_date },
        });
      }
    }
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
        req.body.overrideFefo === true ? `${req.body.reason ?? ''}${req.body.reason ? ' — ' : ''}FEFO skipped deliberately`.trim() : (req.body.reason ?? null),
        req.user!.id
      );
    if (delta !== 0) {
      db.prepare('UPDATE inventory_batches SET quantity_available = quantity_available + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(delta, req.params.id);
      db.prepare('UPDATE inventory_items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(delta, batch.item_id);
    }
    audit(req, { action: 'create', entity: 'inventory_movements', entityId: result.lastInsertRowid, newValue: { batchId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid });
  });

  router.post('/batches/:id/acceptance', requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    // Who checked the delivery in is recorded from the staff register when the
    // person has a record there, and from their login account when they do not
    // — an administrator without a staff record must still be able to accept or
    // reject a delivery, and the audit trail carries their user either way.
    const checkedBy = getStaffIdOrCurrent(req, req.body.acceptanceCheckedByStaffId);
    const status = req.body.acceptanceStatus ?? 'accepted';
    if (!ACCEPTANCE_STATES.includes(status)) {
      return res.status(400).json({ error: `A delivery is ${ACCEPTANCE_STATES.join(', ')} — not “${status}”.` });
    }
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
  router.get('/suppliers', requirePermission('supplier_inventory.suppliers', 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all());
  });

  router.post('/suppliers', requirePermission('supplier_inventory.suppliers', 'create'), (req, res) => {
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

  router.put('/suppliers/:id', requirePermission('supplier_inventory.suppliers', 'edit'), (req, res) => {
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

  router.post('/suppliers/:id/evaluation', requirePermission('supplier_inventory.suppliers', 'create'), (req, res) => {
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
  // Numeric-guarded so named sub-resources (e.g. storage-inspections) below
  // are not shadowed; non-numeric ids fall through to the later routes.
  const numericOnly = (req: any, _res: any, next: any) => /^\d+$/.test(req.params.id) ? next() : next('route');
  router.get('/:id', numericOnly, requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT i.*, s.name AS supplier_name, s.contact AS supplier_contact FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    res.json(item);
  });

  router.put('/:id', numericOnly, requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
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

  // ============= Storage-area condition inspections =============
  router.get('/storage-inspections', requirePermission('supplier_inventory.storage', 'view'), (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM storage_inspections ORDER BY inspection_date DESC, created_at DESC').all());
  });
  router.post('/storage-inspections', requirePermission('supplier_inventory.storage', 'create'), (req, res) => {
    if (!req.body.inspectionDate) return res.status(400).json({ error: 'inspectionDate is required' });
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'storage_inspections', 'STI', createdAt);
    const bit = (v: unknown) => v ? 1 : 0;
    const r = db.prepare(`INSERT INTO storage_inspections (inspection_number, inspection_date, location_id, storage_area, inspected_by_staff_id, cold_storage_adequate, temperature_monitored, humidity_monitored, ventilation_adequate, access_controlled, organised_fefo, outcome, findings, corrective_action, next_due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, req.body.inspectionDate, parseIntNullable(req.body.locationId), req.body.storageArea ?? null, parseIntNullable(req.body.inspectedByStaffId) ?? getStaffIdOrCurrent(req, null), bit(req.body.coldStorageAdequate), bit(req.body.temperatureMonitored), bit(req.body.humidityMonitored), bit(req.body.ventilationAdequate), bit(req.body.accessControlled), bit(req.body.organisedFefo), req.body.outcome ?? null, req.body.findings ?? null, req.body.correctiveAction ?? null, req.body.nextDueDate ?? null, req.body.status ?? 'open', req.user!.id, createdAt);
    audit(req, { action: 'create', entity: 'storage_inspections', entityId: r.lastInsertRowid, newValue: { number, ...req.body } });
    res.status(201).json({ id: r.lastInsertRowid, inspectionNumber: number });
  });
  router.put('/storage-inspections/:id', requirePermission('supplier_inventory.storage', 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM storage_inspections WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Storage inspection not found' });
    const bit = (v: unknown, prev: number) => v === undefined ? prev : (v ? 1 : 0);
    db.prepare(`UPDATE storage_inspections SET inspection_date = ?, location_id = ?, storage_area = ?, inspected_by_staff_id = ?, cold_storage_adequate = ?, temperature_monitored = ?, humidity_monitored = ?, ventilation_adequate = ?, access_controlled = ?, organised_fefo = ?, outcome = ?, findings = ?, corrective_action = ?, next_due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.inspectionDate ?? old.inspection_date, parseIntNullable(req.body.locationId) ?? old.location_id, req.body.storageArea ?? old.storage_area, parseIntNullable(req.body.inspectedByStaffId) ?? old.inspected_by_staff_id, bit(req.body.coldStorageAdequate, old.cold_storage_adequate), bit(req.body.temperatureMonitored, old.temperature_monitored), bit(req.body.humidityMonitored, old.humidity_monitored), bit(req.body.ventilationAdequate, old.ventilation_adequate), bit(req.body.accessControlled, old.access_controlled), bit(req.body.organisedFefo, old.organised_fefo), req.body.outcome ?? old.outcome, req.body.findings ?? old.findings, req.body.correctiveAction ?? old.corrective_action, req.body.nextDueDate ?? old.next_due_date, req.body.status ?? old.status, req.params.id);
    audit(req, { action: 'edit', entity: 'storage_inspections', entityId: req.params.id, oldValue: old, newValue: req.body });
    res.json({ ok: true });
  });

  return router;
}

export { computeExpiryStatus };
