import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import {
  STORAGE_KINDS, normaliseBarcodePolicy, DEFAULT_BARCODE_POLICY, BARCODE_SOURCES,
  ISSUING_MOVEMENTS, ACCEPTANCE_STATES, MOVEMENT_LABELS, effectiveBarcode, parseGs1, normaliseGtin, type BarcodePolicy,
} from '../../shared/constants/inventory.js';

import { buildWorkbook, sendWorkbook, readSheet, cell, numCell } from '../utils/xlsxRegister.js';
import { stockControlRoutes } from './stockControl.js';
import { postMovement } from '../services/stockLedger.js';
import { VEN_CLASSES } from '../../shared/constants/stockControl.js';

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
/**
 * One stock row, told the way a storekeeper would tell it.
 *
 * The dates and quantities a laboratory acts on live on the batches, not on
 * the item: a product does not expire, a lot of it does. This puts the derived
 * facts beside the stored ones so every screen agrees on what "expiry" and
 * "on hand" mean, rather than each one working it out again.
 */
function decorateItem(row: any, paths: Map<number, string>) {
  const expiry = row.batch_expiry || row.expiry_date || null;
  const onHand = row.batch_count > 0 ? Number(row.batch_quantity) : Number(row.quantity ?? 0);
  return {
    ...row,
    item_name: row.name,
    unit_of_measure: row.unit,
    storage_path: row.storage_location_id ? paths.get(row.storage_location_id) ?? row.storage_name ?? null : null,
    barcode: effectiveBarcode(row),
    effective_expiry: expiry,
    expiry_status: computeExpiryStatus(expiry),
    stock_on_hand: onHand,
    low_stock: onHand <= (row.minimum_stock || row.reorder_level || 0),
  };
}

const SUPPLIER_COLUMNS = [
  'Supplier code', 'Name', 'Contact person', 'Phone', 'Email', 'Address',
  'Supplies', 'Status', 'Evaluation required', 'Last evaluated', 'Next evaluation due',
] as const;

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
  /**
   * What did somebody just scan?
   *
   * Answered most-specific-first, because a scan of a box should land on that
   * box. A two-dimensional symbol carries the product and the lot together, so
   * it can identify the exact delivery; a plain barcode usually only says which
   * product it is. Either way the caller gets back what was recognised, plus
   * whatever the symbol said, so a receiving screen can fill the lot and the
   * expiry from the box instead of asking somebody to read them off it.
   */
  router.get('/scan/:code', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const code = String(req.params.code).trim();
    const db = getDb();
    const gs1 = parseGs1(code);
    const gtin = gs1?.gtin ?? code;
    const parsed = gs1 ? { lot: gs1.lot ?? null, expiry: gs1.expiry ?? null, gtin: gs1.gtin ?? null } : null;

    // The batch first: the lot is the level traceability runs at.
    const batchByCode = db.prepare(`SELECT b.*, i.name item_name FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
      WHERE b.product_barcode = ? COLLATE NOCASE OR b.batch_number = ? COLLATE NOCASE OR b.lot_number = ? COLLATE NOCASE`)
      .get(code, code, code) as any;
    if (batchByCode) return res.json({ kind: 'batch', id: batchByCode.id, itemId: batchByCode.item_id, name: batchByCode.item_name, batchNumber: batchByCode.batch_number, parsed });

    // Then the product, matched on either barcode. A GTIN-14 and the EAN-13
    // beneath it are the same product, so leading zeros are not a difference.
    const target = normaliseGtin(gtin);
    const item = (db.prepare(`SELECT * FROM inventory_items
      WHERE item_code = ? COLLATE NOCASE OR product_barcode IS NOT NULL`).all(gtin) as any[])
      .find(r => String(r.item_code).toLowerCase() === gtin.toLowerCase()
        || (r.product_barcode && normaliseGtin(r.product_barcode) === target));
    if (item) {
      // The symbol named a lot of this product — say whether that lot is one
      // the laboratory already holds.
      const lot = gs1?.lot
        ? db.prepare('SELECT * FROM inventory_batches WHERE item_id = ? AND (batch_number = ? COLLATE NOCASE OR lot_number = ? COLLATE NOCASE)')
            .get(item.id, gs1.lot, gs1.lot) as any
        : undefined;
      if (lot) return res.json({ kind: 'batch', id: lot.id, itemId: item.id, name: item.name, batchNumber: lot.batch_number, parsed });
      return res.json({ kind: 'item', id: item.id, name: item.name, itemCode: item.item_code, parsed });
    }
    res.status(404).json({ error: `Nothing in the register answers to “${code}”.`, parsed });
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

  // Running the store — the ledger, issuing, counting, forecasting and the
  // reports. Mounted here so it shares the module's permissions and base path,
  // and ahead of the legacy numeric catch-all further down.
  router.use(stockControlRoutes());

  // Items
  router.get('/items', requirePermission('supplier_inventory.stock', 'view'), (_req, res) => {
    const db = getDb();
    const paths = storagePaths();
    // Expiry belongs to the delivery, not to the product: a box of strips does
    // not expire, a particular lot of them does. The register therefore shows
    // the earliest expiry among the stock actually on the shelf, which is the
    // date that matters — it is what will be reached first, and what FEFO
    // issues against. The item's own expiry_date is only a fallback for stock
    // recorded before batches were kept.
    const rows = db.prepare(`SELECT i.*, s.name AS supplier_name, sec.name AS section_name, l.name AS storage_name,
        (SELECT MIN(b.expiry_date) FROM inventory_batches b
          WHERE b.item_id = i.id AND b.quantity_available > 0
            AND b.expiry_date IS NOT NULL AND b.expiry_date != ''
            AND b.acceptance_status != 'rejected') AS batch_expiry,
        (SELECT COUNT(*) FROM inventory_batches b WHERE b.item_id = i.id AND b.quantity_available > 0) AS batch_count,
        (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b WHERE b.item_id = i.id) AS batch_quantity
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN sections sec ON sec.id = i.section_id
      LEFT JOIN storage_locations l ON l.id = i.storage_location_id
      ORDER BY i.name`).all() as any[];
    res.json(rows.map(row => decorateItem(row, paths)));
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
      // Planning parameters, set at registration rather than needing a second
      // visit: what it costs, how badly it is needed, and how long it takes to
      // arrive are all known when the item is first written down.
      unit_cost: req.body.unitCost === '' || req.body.unitCost == null ? null : Number(req.body.unitCost),
      maximum_stock: req.body.maximumStock === '' || req.body.maximumStock == null ? null : Number(req.body.maximumStock),
      ven_class: VEN_CLASSES.includes(req.body.venClass) ? req.body.venClass : 'essential',
      lead_time_days: Math.max(1, Number(req.body.leadTimeDays) || 30),
      review_period_days: Math.max(1, Number(req.body.reviewPeriodDays) || 30),
      service_level: Math.min(0.999, Math.max(0.5, Number(req.body.serviceLevel) || 0.95)),
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
    const paths = storagePaths();
    // Every id on the record is resolved to the name it stands for. A panel
    // that reads "supplier 4, section 2, location 11" is a database row on a
    // screen, not a record anybody can act on.
    const item = db.prepare(`SELECT i.*, s.name AS supplier_name, s.contact_person AS supplier_contact,
        s.phone AS supplier_phone, s.email AS supplier_email, sec.name AS section_name, l.name AS storage_name,
        u.full_name AS created_by_name,
        (SELECT MIN(b.expiry_date) FROM inventory_batches b
          WHERE b.item_id = i.id AND b.quantity_available > 0
            AND b.expiry_date IS NOT NULL AND b.expiry_date != ''
            AND b.acceptance_status != 'rejected') AS batch_expiry,
        (SELECT COUNT(*) FROM inventory_batches b WHERE b.item_id = i.id AND b.quantity_available > 0) AS batch_count,
        (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b WHERE b.item_id = i.id) AS batch_quantity
      FROM inventory_items i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      LEFT JOIN sections sec ON sec.id = i.section_id
      LEFT JOIN storage_locations l ON l.id = i.storage_location_id
      LEFT JOIN users u ON u.id = i.created_by
      WHERE i.id = ?`).get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const batches = (db.prepare(`SELECT b.*, sup.name AS supplier_name_resolved, st.full_name AS accepted_by_name
      FROM inventory_batches b
      LEFT JOIN suppliers sup ON sup.id = b.supplier_id
      LEFT JOIN staff st ON st.id = b.acceptance_checked_by_staff_id
      WHERE b.item_id = ? ORDER BY b.expiry_date ASC, b.date_received ASC`).all(req.params.id) as any[])
      .map(b => ({
        ...b,
        supplier_name: b.supplier_name ?? b.supplier_name_resolved,
        storage_path: b.storage_location_id ? paths.get(b.storage_location_id) ?? null : null,
        expiry_status: computeExpiryStatus(b.expiry_date),
      }));
    const movements = db.prepare(`SELECT m.*, b.batch_number, b.lot_number, sec.name AS issued_to_section_name,
        st.full_name AS received_by_name, u.full_name AS recorded_by_name
      FROM inventory_movements m
      LEFT JOIN inventory_batches b ON b.id = m.batch_id
      LEFT JOIN sections sec ON sec.id = m.issued_to_section_id
      LEFT JOIN staff st ON st.id = m.received_by_staff_id
      LEFT JOIN users u ON u.id = m.created_by
      WHERE m.item_id = ? ORDER BY m.movement_date DESC, m.id DESC LIMIT 200`).all(req.params.id);
    res.json({ ...decorateItem(item, paths), batches, movements });
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
    // Blankable fields: an empty box means "not recorded".
    for (const [key, col] of [
      ['catalogueNumber', 'catalogue_number'], ['manufacturer', 'manufacturer'],
      ['unitCost', 'unit_cost'], ['maximumStock', 'maximum_stock'],
    ] as const) {
      if (req.body[key] !== undefined) db.prepare(`UPDATE inventory_items SET ${col} = ? WHERE id = ?`).run(req.body[key] === '' || req.body[key] == null ? null : req.body[key], req.params.id);
    }
    // These always hold a value, so a blank leaves what was already there.
    if (VEN_CLASSES.includes(req.body.venClass)) db.prepare('UPDATE inventory_items SET ven_class = ? WHERE id = ?').run(req.body.venClass, req.params.id);
    if (Number(req.body.leadTimeDays) > 0) db.prepare('UPDATE inventory_items SET lead_time_days = ? WHERE id = ?').run(Number(req.body.leadTimeDays), req.params.id);
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: req.params.id, oldValue, newValue: req.body });
    res.json({ ok: true });
  });

  /* -------------------------------------------------- removing a stock item */

  /** What removing this item would take with it, so the choice is informed. */
  router.get('/items/:id/deletion-impact', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const count = (sql: string) => (db.prepare(sql).get(req.params.id) as { n: number }).n;
    const batches = count('SELECT COUNT(*) AS n FROM inventory_batches WHERE item_id = ?');
    const movements = count('SELECT COUNT(*) AS n FROM inventory_movements WHERE item_id = ?');
    const onHand = (db.prepare('SELECT COALESCE(SUM(quantity_available), 0) AS n FROM inventory_batches WHERE item_id = ?').get(req.params.id) as { n: number }).n;
    res.json({
      item: { id: item.id, itemCode: item.item_code, name: item.name, isActive: Number(item.is_active) === 1 },
      batches, movements, quantityOnHand: onHand,
      // Withdrawing is always safe: the item stops being offered for new stock
      // and everything it ever recorded stays put. Erasing destroys the
      // traceability the standard asks for, so it is offered plainly only when
      // there is none to destroy.
      canDeleteOutright: batches === 0 && movements === 0,
      recommendation: batches > 0 || movements > 0 ? 'withdraw' : 'delete',
    });
  });

  /**
   * Remove a stock item.
   *
   * `withdraw` is the normal answer — the item leaves the working register and
   * its batches and movements stay on the record, which is what lot
   * traceability rests on. `delete` erases it and everything it holds,
   * and is for an item entered by mistake: it needs a written reason, and a
   * second confirmation once there is history behind it.
   */
  router.delete('/items/:id', requirePermission('supplier_inventory.stock', 'void_archive'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const mode = String(req.query.mode ?? 'withdraw');

    if (mode === 'withdraw') {
      db.prepare("UPDATE inventory_items SET is_active = 0, status = 'unavailable', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
      audit(req, { action: 'retire', entity: 'inventory_items', entityId: req.params.id, oldValue: item, newValue: { is_active: 0, reason: String(req.body?.reason ?? '').trim() || null } });
      return res.json({ ok: true, mode: 'withdrawn', message: `${item.name} is withdrawn from the register. Its batches and movements remain on the record.` });
    }
    if (mode !== 'delete') return res.status(400).json({ error: "mode must be 'withdraw' or 'delete'" });

    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 8) {
      return res.status(400).json({ error: 'Say why this item is being erased. The reason is kept in the audit trail.', needsReason: true });
    }
    const batches = (db.prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE item_id = ?').get(req.params.id) as { n: number }).n;
    const movements = (db.prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE item_id = ?').get(req.params.id) as { n: number }).n;
    if ((batches > 0 || movements > 0) && req.query.force !== '1') {
      return res.status(409).json({
        error: `${item.name} has ${batches} batch(es) and ${movements} movement(s) on record. Erasing it destroys that traceability — withdraw it instead, or confirm if it was entered in error.`,
        batches, movements, needsForce: true,
      });
    }
    const removed = { batches: 0, movements: 0 };
    db.transaction(() => {
      removed.movements = db.prepare('DELETE FROM inventory_movements WHERE item_id = ?').run(req.params.id).changes;
      removed.batches = db.prepare('DELETE FROM inventory_batches WHERE item_id = ?').run(req.params.id).changes;
      db.prepare('DELETE FROM inventory_items WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'inventory_items', entityId: req.params.id, oldValue: item, newValue: { reason, removed } });
    res.json({ ok: true, mode: 'deleted', removed, message: `${item.name} was erased from the register.` });
  });

  /* ------------------------------------------------ the movement register */

  /**
   * Every issue, receipt and disposal, newest first.
   *
   * Recording a movement and then having nowhere to see it is not a record.
   * The receipt and use of every lot belongs in one list, with the batch, the
   * unit it went to and the person who took it named rather than left as ids.
   */
  router.get('/movements', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (req.query.itemId) { where.push('m.item_id = ?'); args.push(Number(req.query.itemId)); }
    if (req.query.batchId) { where.push('m.batch_id = ?'); args.push(Number(req.query.batchId)); }
    if (req.query.from) { where.push('date(m.movement_date) >= date(?)'); args.push(String(req.query.from)); }
    if (req.query.to) { where.push('date(m.movement_date) <= date(?)'); args.push(String(req.query.to)); }
    const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.item_code, i.unit AS unit_of_measure,
        b.batch_number, b.lot_number, b.expiry_date AS batch_expiry,
        sec.name AS issued_to_section_name, st.full_name AS received_by_name, u.full_name AS recorded_by_name
      FROM inventory_movements m
      LEFT JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN inventory_batches b ON b.id = m.batch_id
      LEFT JOIN sections sec ON sec.id = m.issued_to_section_id
      LEFT JOIN staff st ON st.id = m.received_by_staff_id
      LEFT JOIN users u ON u.id = m.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.movement_date DESC, m.id DESC
      LIMIT ?`).all(...args, Number(req.query.limit) || 500);
    res.json(rows);
  });

  router.get('/movements/export', requirePermission('supplier_inventory.stock', 'export'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.item_code, i.unit AS unit_of_measure,
        b.batch_number, b.lot_number, sec.name AS issued_to_section_name, st.full_name AS received_by_name, u.full_name AS recorded_by_name
      FROM inventory_movements m
      LEFT JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN inventory_batches b ON b.id = m.batch_id
      LEFT JOIN sections sec ON sec.id = m.issued_to_section_id
      LEFT JOIN staff st ON st.id = m.received_by_staff_id
      LEFT JOIN users u ON u.id = m.created_by
      ORDER BY m.movement_date DESC, m.id DESC`).all() as any[];
    const headers = ['Date', 'Item code', 'Item', 'Batch', 'Lot', 'Movement', 'Quantity', 'Unit', 'Issued to', 'Received by', 'Reason', 'Recorded by'];
    const aoa = rows.map(r => [
      String(r.movement_date ?? '').slice(0, 10), r.item_code ?? '', r.item_name ?? '',
      r.batch_number ?? '', r.lot_number ?? '',
      MOVEMENT_LABELS[r.movement_type] ?? String(r.movement_type ?? '').replace(/_/g, ' '),
      Number(r.quantity ?? 0), r.unit_of_measure ?? '',
      r.issued_to_section_name ?? '', r.received_by_name ?? '', r.reason ?? '', r.recorded_by_name ?? '',
    ]);
    sendWorkbook(res, buildWorkbook(headers, aoa, 'STOCK MOVEMENTS'),
      `Stock_Movements-${new Date().toISOString().slice(0, 10)}.xlsx`);
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
    // The barcode read off this particular box. A two-dimensional symbol
    // carries the product, the lot and the expiry together — the level
    // traceability runs at — so it is kept on the batch.
    const batchBarcode = String(req.body.productBarcode ?? '').trim() || null;
    if (batchBarcode) {
      const clash = db.prepare(`SELECT b.batch_number, i.name FROM inventory_batches b
        JOIN inventory_items i ON i.id = b.item_id
        WHERE b.product_barcode = ? COLLATE NOCASE`).get(batchBarcode) as { batch_number: string | null; name: string } | undefined;
      if (clash) return res.status(400).json({ error: `That barcode is already on ${clash.name} batch ${clash.batch_number || '(unnumbered)'}.` });
    }
    const result = db.prepare(`INSERT INTO inventory_batches (item_id, batch_number, lot_number, supplier_id, supplier_name, quantity_received, quantity_available, date_received, expiry_date, acceptance_status, acceptance_checked_by_staff_id, acceptance_date, storage_location_id, product_barcode, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        batchBarcode,
        req.body.status ?? 'available',
        req.user!.id
      );
    // A receipt is a movement. Without one the bin card shows stock leaving and
    // never arriving, which is not a tally card — it is half of one.
    const posted = postMovement(db, {
      itemId: Number(req.params.id), batchId: Number(result.lastInsertRowid), movementType: 'receive',
      quantity: qtyAvailable, movementDate: req.body.dateReceived,
      reason: req.body.batchNumber ? `Received batch ${req.body.batchNumber}` : 'Delivery received',
      unitCost: req.body.unitCost != null && req.body.unitCost !== '' ? Number(req.body.unitCost) : item.unit_cost,
      userId: req.user!.id,
      // The batch row above already carries the quantity, so this posting only
      // records the receipt and the balance it left — it must not add it again.
      applyToStock: false,
    });
    db.prepare('UPDATE inventory_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(posted.balanceAfter, req.params.id);
    if (req.body.unitCost != null && req.body.unitCost !== '') {
      db.prepare('UPDATE inventory_items SET unit_cost = ? WHERE id = ?').run(Number(req.body.unitCost), req.params.id);
    }
    audit(req, { action: 'create', entity: 'inventory_batches', entityId: result.lastInsertRowid, newValue: { itemId: req.params.id, ...req.body } });
    res.status(201).json({ id: result.lastInsertRowid, balanceAfter: posted.balanceAfter });
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
    if (isOut && batch.quantity_available < qty) return res.status(400).json({ error: 'Insufficient batch stock; movement would create negative stock' });

    // ---- The three controls that make this stock control rather than a tally.
    //
    // A delivery is not put into use until it has been inspected and accepted,
    // and nothing is issued past its expiry. Discarding is the one thing you
    // MUST still be able to do to a bad batch, so it is never blocked.
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
    // One posting path for every movement, so the balance on the bin card is
    // written the same way whoever recorded it and whichever screen they used.
    const movementDate = req.body.movementDate ?? new Date().toISOString().slice(0, 10);
    // The reason comes from the laboratory's own list as a code; a bin card is
    // read years later, so what is stored is the words, plus any detail typed
    // beside them. Free text from older screens passes through untouched.
    const reasonCode = String(req.body.reason ?? '').trim();
    const reasonOption = reasonCode
      ? db.prepare('SELECT label FROM config_options WHERE list_key = ? AND value = ?').get('stock_movement_reason', reasonCode) as { label?: string } | undefined
      : undefined;
    const reasonNote = String(req.body.reasonNote ?? '').trim();
    const reasonText = [reasonOption?.label ?? reasonCode, reasonNote].filter(Boolean).join(' — ') || null;
    const posted = postMovement(db, {
      itemId: batch.item_id, batchId: Number(req.params.id), movementType: req.body.movementType, quantity: qty,
      movementDate,
      issuedToSectionId: parseIntNullable(req.body.issuedToSectionId),
      receivedByStaffId: parseIntNullable(req.body.receivedByStaffId),
      reason: req.body.overrideFefo === true
        ? `${reasonText ?? ''}${reasonText ? ' — ' : ''}FEFO skipped deliberately`.trim()
        : reasonText,
      userId: req.user!.id,
    });
    audit(req, { action: 'create', entity: 'inventory_movements', entityId: posted.id, newValue: { batchId: req.params.id, ...req.body } });
    res.status(201).json({ id: posted.id, balanceAfter: posted.balanceAfter });
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
    const today = new Date().toISOString().slice(0, 10);
    // Suppliers of anything that affects a result are evaluated and monitored,
    // so the register has to show at a glance who is due — not just who exists.
    const rows = db.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM inventory_items i WHERE i.supplier_id = s.id) AS item_count,
        (SELECT COUNT(*) FROM inventory_batches b WHERE b.supplier_id = s.id) AS batch_count,
        (SELECT COUNT(*) FROM supplier_evaluations e WHERE e.supplier_id = s.id) AS evaluation_count,
        (SELECT rating FROM supplier_evaluations e WHERE e.supplier_id = s.id ORDER BY e.evaluation_date DESC LIMIT 1) AS last_rating
      FROM suppliers s ORDER BY s.name`).all() as any[];
    res.json(rows.map(r => ({
      ...r,
      evaluation_status: !r.evaluation_required ? 'not_required'
        : !r.last_evaluation_date ? 'never_evaluated'
        : r.next_evaluation_due && r.next_evaluation_due.slice(0, 10) < today ? 'overdue'
        : 'current',
    })));
  });

  router.get('/suppliers/export', requirePermission('supplier_inventory.suppliers', 'export'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM suppliers ORDER BY name').all() as any[];
    const aoa = rows.map(r => [
      r.supplier_code ?? '', r.name ?? '', r.contact_person ?? '', r.phone ?? '', r.email ?? '',
      r.address ?? '', r.item_category ?? '', r.status ?? 'active',
      r.evaluation_required ? 'Yes' : 'No',
      String(r.last_evaluation_date ?? '').slice(0, 10), String(r.next_evaluation_due ?? '').slice(0, 10),
    ]);
    sendWorkbook(res, buildWorkbook(SUPPLIER_COLUMNS, aoa, 'SUPPLIER REGISTER'),
      `Supplier_Register-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  router.post('/suppliers/import', requirePermission('supplier_inventory.suppliers', 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let rows: Record<string, unknown>[];
    try { rows = readSheet(req.file.buffer, 'SUPPLIER'); }
    catch { return res.status(400).json({ error: 'Could not read that spreadsheet. Export the register first and edit that file.' }); }

    const db = getDb();
    const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
    const yes = (v: string | null) => /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
    db.transaction(() => {
      rows.forEach((row, n) => {
        const line = n + 2;
        const name = cell(row, 'Name');
        if (!name) { result.skipped++; return; }
        const code = cell(row, 'Supplier code');
        // Matched on the code the register issued; a row without one is new.
        const existing = code
          ? db.prepare('SELECT * FROM suppliers WHERE supplier_code = ? COLLATE NOCASE').get(code) as any
          : db.prepare('SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE').get(name) as any;
        const values = [
          name, cell(row, 'Contact person'), cell(row, 'Phone'), cell(row, 'Email'), cell(row, 'Address'),
          cell(row, 'Supplies'), (cell(row, 'Status') ?? 'active').toLowerCase(),
          yes(cell(row, 'Evaluation required')) ? 1 : 0,
          cell(row, 'Last evaluated'), cell(row, 'Next evaluation due'),
        ];
        try {
          if (existing) {
            db.prepare(`UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?,
              item_category = ?, status = ?, evaluation_required = ?, last_evaluation_date = ?, next_evaluation_due = ?,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, existing.id);
            result.updated++;
          } else {
            const createdAt = new Date().toISOString();
            db.prepare(`INSERT INTO suppliers (supplier_code, name, contact_person, phone, email, address,
              item_category, status, evaluation_required, last_evaluation_date, next_evaluation_due, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(code || generateRecordNumber(db, 'suppliers', 'SUP', createdAt), ...values, createdAt);
            result.created++;
          }
        } catch (e) { result.errors.push(`Row ${line}: ${(e as Error).message}`); result.skipped++; }
      });
    })();
    audit(req, { action: 'import', entity: 'suppliers', entityId: 0, newValue: result });
    res.json(result);
  });

  /** Every evaluation ever recorded — the supplier monitoring record in one list. */
  router.get('/supplier-evaluations', requirePermission('supplier_inventory.suppliers', 'view'), (req, res) => {
    const db = getDb();
    const args: unknown[] = [];
    let where = '';
    if (req.query.supplierId) { where = 'WHERE e.supplier_id = ?'; args.push(Number(req.query.supplierId)); }
    res.json(db.prepare(`SELECT e.*, s.name AS supplier_name, s.supplier_code, st.full_name AS evaluated_by_name
      FROM supplier_evaluations e
      LEFT JOIN suppliers s ON s.id = e.supplier_id
      LEFT JOIN staff st ON st.id = e.evaluated_by_staff_id
      ${where} ORDER BY e.evaluation_date DESC, e.id DESC`).all(...args));
  });

  router.get('/suppliers/:id/deletion-impact', requirePermission('supplier_inventory.suppliers', 'view'), (req, res) => {
    const db = getDb();
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const count = (sql: string) => (db.prepare(sql).get(req.params.id) as { n: number }).n;
    const items = count('SELECT COUNT(*) AS n FROM inventory_items WHERE supplier_id = ?');
    const batches = count('SELECT COUNT(*) AS n FROM inventory_batches WHERE supplier_id = ?');
    const evaluations = count('SELECT COUNT(*) AS n FROM supplier_evaluations WHERE supplier_id = ?');
    res.json({
      supplier: { id: supplier.id, supplierCode: supplier.supplier_code, name: supplier.name, status: supplier.status },
      items, batches, evaluations,
      canDeleteOutright: items === 0 && batches === 0 && evaluations === 0,
      recommendation: items > 0 || batches > 0 || evaluations > 0 ? 'suspend' : 'delete',
    });
  });

  /**
   * Remove a supplier.
   *
   * `suspend` is the normal answer: they stop being offered for new orders and
   * everything they ever supplied keeps their name, which is what a recall
   * depends on. `delete` is for one entered by mistake — the stock they supply
   * is detached rather than deleted, so no reagent loses its record along with
   * them.
   */
  router.delete('/suppliers/:id', requirePermission('supplier_inventory.suppliers', 'void_archive'), (req, res) => {
    const db = getDb();
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const mode = String(req.query.mode ?? 'suspend');

    if (mode === 'suspend') {
      db.prepare("UPDATE suppliers SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
      audit(req, { action: 'retire', entity: 'suppliers', entityId: req.params.id, oldValue: supplier, newValue: { status: 'suspended', reason: String(req.body?.reason ?? '').trim() || null } });
      return res.json({ ok: true, mode: 'suspended', message: `${supplier.name} is suspended. Everything they supplied keeps their name.` });
    }
    if (mode !== 'delete') return res.status(400).json({ error: "mode must be 'suspend' or 'delete'" });

    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 8) {
      return res.status(400).json({ error: 'Say why this supplier is being erased. The reason is kept in the audit trail.', needsReason: true });
    }
    const items = (db.prepare('SELECT COUNT(*) AS n FROM inventory_items WHERE supplier_id = ?').get(req.params.id) as { n: number }).n;
    const batches = (db.prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE supplier_id = ?').get(req.params.id) as { n: number }).n;
    const evaluations = (db.prepare('SELECT COUNT(*) AS n FROM supplier_evaluations WHERE supplier_id = ?').get(req.params.id) as { n: number }).n;
    if ((items > 0 || batches > 0 || evaluations > 0) && req.query.force !== '1') {
      return res.status(409).json({
        error: `${supplier.name} supplies ${items} item(s), ${batches} delivered batch(es) and has ${evaluations} evaluation(s). Suspend them instead, or confirm if they were entered in error.`,
        items, batches, evaluations, needsForce: true,
      });
    }
    const detached = { items: 0, batches: 0, evaluations: 0 };
    db.transaction(() => {
      // The stock stays; only the pointer to a supplier that should never have
      // existed goes. A batch keeps the supplier's name in its own column, so
      // a recall can still be traced.
      db.prepare('UPDATE inventory_batches SET supplier_name = COALESCE(supplier_name, ?) WHERE supplier_id = ?').run(supplier.name, req.params.id);
      detached.batches = db.prepare('UPDATE inventory_batches SET supplier_id = NULL WHERE supplier_id = ?').run(req.params.id).changes;
      detached.items = db.prepare('UPDATE inventory_items SET supplier_id = NULL WHERE supplier_id = ?').run(req.params.id).changes;
      detached.evaluations = db.prepare('DELETE FROM supplier_evaluations WHERE supplier_id = ?').run(req.params.id).changes;
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
    })();
    audit(req, { action: 'delete', entity: 'suppliers', entityId: req.params.id, oldValue: supplier, newValue: { reason, detached } });
    res.json({ ok: true, mode: 'deleted', detached, message: `${supplier.name} was erased. ${detached.items} item(s) and ${detached.batches} batch(es) kept their records.` });
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
