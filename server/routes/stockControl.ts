import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { buildWorkbook, sendWorkbook } from '../utils/xlsxRegister.js';
import {
  stockPositions, planFor, allocateFefo, issuableQuantity, postMovement, storagePathMap,
  monthWindow, isOutMovement, WASTAGE,
} from '../services/stockLedger.js';
import { MOVEMENT_LABELS } from '../../shared/constants/inventory.js';
import { STOCK_STATUS_LABELS, VEN_CLASSES, NEEDS_ACTION, sum } from '../../shared/constants/stockControl.js';

/**
 * Running the store.
 *
 * The item register says what the laboratory *stocks*; these routes are about
 * what it *has* — receiving it, issuing it, counting it, knowing when to
 * reorder and how much. They are kept apart from the catalogue routes because
 * they answer a different question and are used by a different person on a
 * different day.
 */
export function stockControlRoutes() {
  const router = Router();

  /* ─────────────────────────────────────────── the stock control ledger */

  /**
   * Everything held, with the numbers a store runs on.
   *
   * This is the register a storekeeper looks at first thing: what is on the
   * shelf, how much of it can actually be issued, how long it will last at the
   * rate it is going, and whether that is a problem.
   */
  router.get('/ledger', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const { months, rows } = stockPositions({
      monthsBack: Number(req.query.months) || 12,
      includeInactive: req.query.includeInactive === '1',
    });
    res.json({ months, rows, statusLabels: STOCK_STATUS_LABELS });
  });

  router.get('/ledger/export', requirePermission('supplier_inventory.stock', 'export'), (_req, res) => {
    const { rows } = stockPositions({});
    const headers = ['Item code', 'Item', 'Category', 'Unit', 'Where it is kept', 'On hand', 'Issuable',
      'In quarantine', 'Expired on shelf', 'Batches', 'Expires first', 'Monthly use', 'Months of stock',
      'Minimum', 'Reorder level', 'Maximum', 'Status', 'ABC', 'VEN', 'Unit cost', 'Stock value'];
    const aoa = rows.map(r => [
      r.item_code, r.name, r.category ?? '', r.unit ?? '', r.storage_path ?? '',
      r.on_hand, r.issuable, r.quarantined, r.expired_on_hand, r.batch_count,
      String(r.earliest_expiry ?? '').slice(0, 10), r.amc, r.months_of_stock ?? '',
      r.minimum_stock ?? 0, r.reorder_level ?? 0, r.maximum_stock ?? '',
      STOCK_STATUS_LABELS[r.status], r.abc_class ?? '', r.ven_class ?? '', r.unit_cost ?? '', r.stock_value ?? '',
    ]);
    sendWorkbook(res, buildWorkbook(headers, aoa, 'STOCK LEDGER'),
      `Stock_Control_Ledger-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  /**
   * One item's bin card.
   *
   * The tally card that hangs on the shelf: every movement in date order with
   * the balance it left behind, the balance the register believes now, and
   * whether the two agree. When they do not, something posted out of order and
   * somebody needs to know.
   */
  router.get('/ledger/:itemId', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.itemId);
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });

    const movements = db.prepare(`SELECT m.*, b.batch_number, b.lot_number, b.expiry_date AS batch_expiry,
        sec.name AS issued_to_section_name, st.full_name AS received_by_name, u.full_name AS recorded_by_name,
        iss.issue_number
      FROM inventory_movements m
      LEFT JOIN inventory_batches b ON b.id = m.batch_id
      LEFT JOIN sections sec ON sec.id = m.issued_to_section_id
      LEFT JOIN staff st ON st.id = m.received_by_staff_id
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN stock_issues iss ON iss.id = m.issue_id
      WHERE m.item_id = ? ORDER BY date(m.movement_date), m.id`).all(id) as any[];

    // Older rows predate the balance column; the card is still readable, so the
    // running total is filled in for them rather than left blank.
    let running = 0;
    const lines = movements.map(m => {
      const delta = isOutMovement(m.movement_type) ? -Math.abs(m.quantity) : Math.abs(m.quantity);
      running += delta;
      return { ...m, direction: delta < 0 ? 'out' : 'in', running_balance: m.balance_after ?? running };
    });
    const onHand = Number((db.prepare('SELECT COALESCE(SUM(quantity_available), 0) AS n FROM inventory_batches WHERE item_id = ?').get(id) as { n: number }).n) || 0;
    const position = stockPositions({ includeInactive: true }).rows.find(r => r.id === id) ?? null;

    res.json({
      item: { id: item.id, itemCode: item.item_code, name: item.name, unit: item.unit },
      position,
      lines: lines.reverse(),
      onHand,
      reconciles: lines.length === 0 || Math.abs((lines[0]?.running_balance ?? 0) - onHand) < 0.001,
    });
  });

  /* ───────────────────────────────────────────────────────── issuing out */

  /**
   * Somebody from a unit comes for a reagent.
   *
   * One request, one voucher. The storekeeper names the requesting unit and
   * the member of staff collecting, lists what they are taking, and the store
   * allocates the lots — earliest expiry first — writing a movement per lot.
   * Nobody picks a batch by hand.
   *
   * The collector is a member of staff, not a name typed at the counter: an
   * issue that cannot be traced to a person on the staff register is not a
   * record of who took the stock. A name is still accepted for records written
   * before that, and for a collector who is not on the register at all.
   */
  router.post('/issues', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
    const db = getDb();
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (lines.length === 0) return res.status(400).json({ error: 'Add at least one item to issue.' });
    const sectionId = parseIntNullable(req.body.sectionId);
    const collectorId = parseIntNullable(req.body.receivedByStaffId);
    // The collector's name is carried on the voucher so it reads on its own,
    // and so the register survives the staff record being renamed.
    const collector = collectorId
      ? db.prepare('SELECT full_name FROM staff WHERE id = ?').get(collectorId) as { full_name?: string } | undefined
      : undefined;
    if (collectorId && !collector) return res.status(400).json({ error: 'That member of staff is not on the staff register.' });
    const collectedBy = String(req.body.issuedToName ?? '').trim() || collector?.full_name || '';
    if (!sectionId && !collectedBy) {
      return res.status(400).json({ error: 'Say which unit this is going to, or who is collecting it.' });
    }

    // Everything is checked before anything moves, so a request for five items
    // where the fourth is short does not leave three of them issued.
    const planned: { itemId: number; quantity: number; name: string; unit: string | null; unitCost: number | null; alloc: ReturnType<typeof allocateFefo> }[] = [];
    for (const line of lines) {
      const itemId = parseIntNullable(line.itemId);
      const quantity = Number(line.quantity);
      if (!itemId) return res.status(400).json({ error: 'Every line needs an item.' });
      if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Every line needs a quantity greater than zero.' });
      const item = db.prepare('SELECT id, name, unit, unit_cost FROM inventory_items WHERE id = ?').get(itemId) as any;
      if (!item) return res.status(400).json({ error: `Item ${itemId} is not on the register.` });
      const available = issuableQuantity(db, itemId);
      if (available < quantity) {
        return res.status(400).json({
          error: `Only ${available} ${item.unit ?? ''} of ${item.name} can be issued — the rest is either in quarantine, expired, or not there.`.replace(/\s+/g, ' '),
          itemId, requested: quantity, available,
        });
      }
      const alloc = allocateFefo(db, itemId, quantity);
      if (alloc.length === 0) return res.status(400).json({ error: `${item.name} could not be allocated from the batches on the shelf.`, itemId });
      planned.push({ itemId, quantity, name: item.name, unit: item.unit, unitCost: item.unit_cost, alloc });
    }

    const issueDate = req.body.issueDate || new Date().toISOString().slice(0, 10);
    const createdAt = new Date().toISOString();
    const issueNumber = generateRecordNumber(db, 'stock_issues', 'ISS', createdAt);
    const receivedBy = collectorId;
    const purposeLabel = optionLabel(db, 'stock_issue_reason', req.body.purpose);

    let issueId = 0;
    db.transaction(() => {
      issueId = Number(db.prepare(`INSERT INTO stock_issues
        (issue_number, issue_date, section_id, issued_to_name, received_by_staff_id, issued_by_user_id, purpose, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`)
        .run(issueNumber, issueDate, sectionId, collectedBy || null,
          receivedBy, req.user!.id, req.body.purpose ?? null, req.body.note ?? null, createdAt).lastInsertRowid);

      for (const p of planned) {
        db.prepare('INSERT INTO stock_issue_lines (issue_id, item_id, quantity, unit, unit_cost, allocation) VALUES (?, ?, ?, ?, ?, ?)')
          .run(issueId, p.itemId, p.quantity, p.unit, p.unitCost, JSON.stringify(p.alloc));
        for (const a of p.alloc) {
          postMovement(db, {
            itemId: p.itemId, batchId: a.batchId, movementType: 'issue', quantity: a.quantity,
            movementDate: issueDate, issuedToSectionId: sectionId, receivedByStaffId: receivedBy,
            reason: purposeLabel || `Issued on ${issueNumber}`, issueId, unitCost: p.unitCost, userId: req.user!.id,
          });
        }
      }
    })();

    audit(req, { action: 'create', entity: 'stock_issues', entityId: issueId, newValue: { issueNumber, lines: planned.length } });
    res.status(201).json({
      id: issueId, issueNumber,
      lines: planned.map(p => ({ itemId: p.itemId, name: p.name, quantity: p.quantity, unit: p.unit, allocation: p.alloc })),
    });
  });

  router.get('/issues', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const args: unknown[] = [];
    const where: string[] = [];
    if (req.query.sectionId) { where.push('i.section_id = ?'); args.push(Number(req.query.sectionId)); }
    if (req.query.from) { where.push('date(i.issue_date) >= date(?)'); args.push(String(req.query.from)); }
    if (req.query.to) { where.push('date(i.issue_date) <= date(?)'); args.push(String(req.query.to)); }
    const rows = db.prepare(`SELECT i.*, sec.name AS section_name, st.full_name AS received_by_name, u.full_name AS issued_by_name,
        (SELECT COUNT(*) FROM stock_issue_lines l WHERE l.issue_id = i.id) AS line_count,
        (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_issue_lines l WHERE l.issue_id = i.id) AS total_quantity
      FROM stock_issues i
      LEFT JOIN sections sec ON sec.id = i.section_id
      LEFT JOIN staff st ON st.id = i.received_by_staff_id
      LEFT JOIN users u ON u.id = i.issued_by_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY date(i.issue_date) DESC, i.id DESC LIMIT ?`).all(...args, Number(req.query.limit) || 300) as any[];
    res.json(rows.map(r => ({ ...r, purpose_label: optionLabel(db, 'stock_issue_reason', r.purpose) })));
  });

  router.get('/issues/:id', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const issue = db.prepare(`SELECT i.*, sec.name AS section_name, st.full_name AS received_by_name, u.full_name AS issued_by_name
      FROM stock_issues i
      LEFT JOIN sections sec ON sec.id = i.section_id
      LEFT JOIN staff st ON st.id = i.received_by_staff_id
      LEFT JOIN users u ON u.id = i.issued_by_user_id WHERE i.id = ?`).get(req.params.id) as any;
    if (!issue) return res.status(404).json({ error: 'Issue voucher not found' });
    const lines = (db.prepare(`SELECT l.*, it.name AS item_name, it.item_code FROM stock_issue_lines l
      LEFT JOIN inventory_items it ON it.id = l.item_id WHERE l.issue_id = ?`).all(req.params.id) as any[])
      .map(l => ({ ...l, allocation: safeJson(l.allocation) }));
    res.json({ ...issue, purpose_label: optionLabel(db, 'stock_issue_reason', issue.purpose), lines });
  });

  /**
   * Something comes back unused.
   *
   * A unit takes more than it needs and returns the rest; the stock goes back
   * to the lot it came from, not to a general pool, so the lot's own balance
   * and its expiry stay true.
   */
  router.post('/issues/:id/return', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
    const db = getDb();
    const issue = db.prepare('SELECT * FROM stock_issues WHERE id = ?').get(req.params.id) as any;
    if (!issue) return res.status(404).json({ error: 'Issue voucher not found' });
    if (issue.status === 'returned') return res.status(400).json({ error: 'This voucher has already been returned in full.' });
    const returns = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (returns.length === 0) return res.status(400).json({ error: 'Say what is coming back.' });

    const date = req.body.returnDate || new Date().toISOString().slice(0, 10);
    const done: unknown[] = [];
    db.transaction(() => {
      for (const r of returns) {
        const line = db.prepare('SELECT * FROM stock_issue_lines WHERE id = ? AND issue_id = ?').get(parseIntNullable(r.lineId), issue.id) as any;
        if (!line) continue;
        const qty = Math.min(Number(r.quantity) || 0, line.quantity);
        if (qty <= 0) continue;
        // Back into the lots it left, largest allocation first.
        const alloc = (safeJson(line.allocation) as { batchId: number; quantity: number }[] | null) ?? [];
        let left = qty;
        for (const a of alloc) {
          if (left <= 0) break;
          const back = Math.min(left, a.quantity);
          postMovement(db, {
            itemId: line.item_id, batchId: a.batchId, movementType: 'return', quantity: back, movementDate: date,
            reason: req.body.reason || `Returned from ${issue.issue_number}`, issueId: issue.id, userId: req.user!.id,
          });
          left -= back;
        }
        if (left > 0) {
          postMovement(db, { itemId: line.item_id, batchId: null, movementType: 'return', quantity: left, movementDate: date,
            reason: req.body.reason || `Returned from ${issue.issue_number}`, issueId: issue.id, userId: req.user!.id });
        }
        done.push({ lineId: line.id, quantity: qty });
      }
      db.prepare("UPDATE stock_issues SET status = 'returned' WHERE id = ?").run(issue.id);
    })();
    audit(req, { action: 'edit', entity: 'stock_issues', entityId: issue.id, oldValue: issue, newValue: { returned: done } });
    res.json({ ok: true, returned: done });
  });

  /* ────────────────────────────────────────────────────────── stock take */

  /**
   * Counting the shelf.
   *
   * What the register believes and what is physically there part company —
   * breakages, unrecorded issues, miscounts on receipt. A count freezes what
   * the register says, records what was found, and posts the difference as an
   * adjustment with a reason, so the correction is itself part of the record.
   */
  router.post('/counts', requirePermission('supplier_inventory.stock', 'create'), (req, res) => {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const number = generateRecordNumber(db, 'stock_counts', 'CNT', createdAt);
    const locationId = parseIntNullable(req.body.storageLocationId);
    const scope = ['full', 'location', 'category', 'cycle'].includes(req.body.scope) ? req.body.scope : 'full';

    let countId = 0;
    db.transaction(() => {
      countId = Number(db.prepare(`INSERT INTO stock_counts
        (count_number, count_date, storage_location_id, counted_by_staff_id, scope, scope_value, status, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .run(number, req.body.countDate || createdAt.slice(0, 10), locationId,
          getStaffIdOrCurrent(req, req.body.countedByStaffId), scope, req.body.scopeValue ?? null,
          req.body.note ?? null, req.user!.id, createdAt).lastInsertRowid);

      // The sheet is drawn up per BATCH, because that is the unit sitting on the
      // shelf — a count of "48 tests" says nothing about which lot they are.
      const where: string[] = ['i.is_active = 1', 'b.quantity_available > 0'];
      const args: unknown[] = [];
      if (scope === 'location' && locationId) { where.push('(b.storage_location_id = ? OR i.storage_location_id = ?)'); args.push(locationId, locationId); }
      if (scope === 'category' && req.body.scopeValue) { where.push('i.category = ?'); args.push(req.body.scopeValue); }
      if (scope === 'cycle') where.push("i.abc_class = 'A'");
      const batches = db.prepare(`SELECT b.id, b.item_id, b.quantity_available FROM inventory_batches b
        JOIN inventory_items i ON i.id = b.item_id WHERE ${where.join(' AND ')}
        ORDER BY i.name, b.expiry_date`).all(...args) as any[];
      const insert = db.prepare('INSERT INTO stock_count_lines (count_id, item_id, batch_id, system_quantity) VALUES (?, ?, ?, ?)');
      for (const b of batches) insert.run(countId, b.item_id, b.id, b.quantity_available);
    })();

    audit(req, { action: 'create', entity: 'stock_counts', entityId: countId, newValue: { number, scope } });
    res.status(201).json({ id: countId, countNumber: number });
  });

  router.get('/counts', requirePermission('supplier_inventory.stock', 'view'), (_req, res) => {
    const db = getDb();
    const paths = storagePathMap(db);
    const rows = db.prepare(`SELECT c.*, st.full_name AS counted_by_name, u.full_name AS posted_by_name,
        (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) AS line_count,
        (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted_quantity IS NOT NULL) AS counted_lines,
        (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted_quantity IS NOT NULL AND l.counted_quantity != l.system_quantity) AS variance_lines
      FROM stock_counts c
      LEFT JOIN staff st ON st.id = c.counted_by_staff_id
      LEFT JOIN users u ON u.id = c.posted_by_user_id
      ORDER BY date(c.count_date) DESC, c.id DESC`).all() as any[];
    res.json(rows.map(r => ({ ...r, storage_path: r.storage_location_id ? paths.get(r.storage_location_id) ?? null : null })));
  });

  router.get('/counts/:id', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const db = getDb();
    const count = db.prepare(`SELECT c.*, st.full_name AS counted_by_name FROM stock_counts c
      LEFT JOIN staff st ON st.id = c.counted_by_staff_id WHERE c.id = ?`).get(req.params.id) as any;
    if (!count) return res.status(404).json({ error: 'Stock count not found' });
    const lines = db.prepare(`SELECT l.*, i.name AS item_name, i.item_code, i.unit,
        b.batch_number, b.lot_number, b.expiry_date
      FROM stock_count_lines l
      LEFT JOIN inventory_items i ON i.id = l.item_id
      LEFT JOIN inventory_batches b ON b.id = l.batch_id
      WHERE l.count_id = ? ORDER BY i.name, b.expiry_date`).all(req.params.id) as any[];
    res.json({ ...count, lines: lines.map(l => ({ ...l, variance: l.counted_quantity == null ? null : l.counted_quantity - l.system_quantity })) });
  });

  router.put('/counts/:id/lines', requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
    const db = getDb();
    const count = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(req.params.id) as any;
    if (!count) return res.status(404).json({ error: 'Stock count not found' });
    if (count.status !== 'open') return res.status(400).json({ error: 'This count has been posted and cannot be changed.' });
    const updates = Array.isArray(req.body.lines) ? req.body.lines : [];
    const stmt = db.prepare('UPDATE stock_count_lines SET counted_quantity = ?, reason = ? WHERE id = ? AND count_id = ?');
    db.transaction(() => {
      for (const u of updates) {
        const q = u.countedQuantity === '' || u.countedQuantity == null ? null : Number(u.countedQuantity);
        stmt.run(q, u.reason ?? null, parseIntNullable(u.id), count.id);
      }
    })();
    res.json({ ok: true, updated: updates.length });
  });

  /**
   * Post the count.
   *
   * Every difference becomes an adjustment movement against the lot it was
   * found on, so the bin card shows the correction and its reason rather than
   * a balance that silently changed overnight.
   */
  router.post('/counts/:id/post', requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
    const db = getDb();
    const count = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(req.params.id) as any;
    if (!count) return res.status(404).json({ error: 'Stock count not found' });
    if (count.status !== 'open') return res.status(400).json({ error: 'This count has already been posted.' });
    const lines = db.prepare('SELECT * FROM stock_count_lines WHERE count_id = ? AND counted_quantity IS NOT NULL').all(count.id) as any[];
    if (lines.length === 0) return res.status(400).json({ error: 'Nothing has been counted yet.' });

    const date = new Date().toISOString().slice(0, 10);
    const adjustments: unknown[] = [];
    db.transaction(() => {
      for (const l of lines) {
        const variance = Number(l.counted_quantity) - Number(l.system_quantity);
        if (Math.abs(variance) < 0.0001) continue;
        postMovement(db, {
          itemId: l.item_id, batchId: l.batch_id,
          movementType: variance > 0 ? 'adjust_in' : 'adjust_out',
          quantity: Math.abs(variance), movementDate: date,
          reason: `Stock count ${count.count_number}${l.reason ? ` — ${l.reason}` : ''}`,
          countId: count.id, userId: req.user!.id,
        });
        adjustments.push({ itemId: l.item_id, batchId: l.batch_id, variance });
      }
      db.prepare("UPDATE stock_counts SET status = 'posted', posted_at = CURRENT_TIMESTAMP, posted_by_user_id = ? WHERE id = ?")
        .run(req.user!.id, count.id);
    })();
    audit(req, { action: 'edit', entity: 'stock_counts', entityId: count.id, oldValue: count, newValue: { posted: adjustments.length } });
    res.json({ ok: true, adjustments: adjustments.length, detail: adjustments });
  });

  /* ────────────────────────────────────────────────────────── forecasting */

  /**
   * What to order, and what the levels should be.
   *
   * Every item's own consumption is put through the forecast, the buffer is
   * sized from how uneven that consumption has been and how long the supplier
   * takes, and the levels follow. The method and its error come back with the
   * numbers, because a level nobody can see the reasoning behind is a level
   * nobody trusts.
   */
  router.get('/forecast', requirePermission('supplier_inventory.stock', 'view'), (req, res) => {
    const monthsBack = Number(req.query.months) || 12;
    const horizon = Number(req.query.horizon) || 3;
    const { months, rows } = stockPositions({ monthsBack });
    const advice = rows.map(r => ({
      item: {
        id: r.id, itemCode: r.item_code, name: r.name, unit: r.unit, category: r.category,
        supplierName: r.supplier_name, abcClass: r.abc_class, venClass: r.ven_class,
        leadTimeDays: r.lead_time_days, reviewPeriodDays: r.review_period_days, serviceLevel: r.service_level,
        unitCost: r.unit_cost, planningLocked: r.planning_locked,
        onHand: r.on_hand, issuable: r.issuable, status: r.status, monthsOfStock: r.months_of_stock,
        consumption: r.consumption, priority: r.priority,
      },
      ...planFor(r, horizon),
    }));
    res.json({ months, horizon, rows: advice });
  });

  /** Write the proposed levels onto the items the laboratory chose. */
  router.post('/forecast/apply', requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
    const db = getDb();
    const ids: number[] = Array.isArray(req.body.itemIds) ? req.body.itemIds.map(Number).filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Choose at least one item to apply the levels to.' });
    const { rows } = stockPositions({ monthsBack: Number(req.body.months) || 12 });
    const wanted = new Set(ids);
    const applied: unknown[] = [];
    const skipped: unknown[] = [];
    const stmt = db.prepare('UPDATE inventory_items SET minimum_stock = ?, reorder_level = ?, maximum_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    db.transaction(() => {
      for (const r of rows) {
        if (!wanted.has(r.id)) continue;
        // A level somebody set deliberately is not overwritten by a forecast.
        if (r.planning_locked) { skipped.push({ id: r.id, name: r.name, reason: 'levels are locked' }); continue; }
        const plan = planFor(r);
        if (plan.forecast.method === 'none') { skipped.push({ id: r.id, name: r.name, reason: 'no consumption to forecast from' }); continue; }
        stmt.run(plan.minimumStock, plan.reorderLevel, plan.maximumStock, r.id);
        applied.push({ id: r.id, name: r.name, minimum: plan.minimumStock, reorder: plan.reorderLevel, maximum: plan.maximumStock });
      }
    })();
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: 0, newValue: { appliedLevels: applied.length } });
    res.json({ applied, skipped });
  });

  /** The planning parameters of one item — lead time, service level, ABC/VEN. */
  router.put('/planning/:itemId', requirePermission('supplier_inventory.stock', 'edit'), (req, res) => {
    const db = getDb();
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.itemId) as any;
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    const ven = VEN_CLASSES.includes(req.body.venClass) ? req.body.venClass : item.ven_class;
    const abc = ['A', 'B', 'C', ''].includes(req.body.abcClass ?? '') ? (req.body.abcClass || null) : item.abc_class;
    db.prepare(`UPDATE inventory_items SET lead_time_days = ?, review_period_days = ?, service_level = ?,
      unit_cost = ?, ven_class = ?, abc_class = ?, planning_locked = ?, maximum_stock = ?,
      minimum_stock = ?, reorder_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(
        Math.max(1, Number(req.body.leadTimeDays ?? item.lead_time_days) || 30),
        Math.max(1, Number(req.body.reviewPeriodDays ?? item.review_period_days) || 30),
        Math.min(0.999, Math.max(0.5, Number(req.body.serviceLevel ?? item.service_level) || 0.95)),
        req.body.unitCost === '' || req.body.unitCost == null ? item.unit_cost : Number(req.body.unitCost),
        ven, abc,
        req.body.planningLocked === undefined ? item.planning_locked : (req.body.planningLocked ? 1 : 0),
        req.body.maximumStock === '' || req.body.maximumStock == null ? item.maximum_stock : Number(req.body.maximumStock),
        req.body.minimumStock === '' || req.body.minimumStock == null ? item.minimum_stock : Number(req.body.minimumStock),
        req.body.reorderLevel === '' || req.body.reorderLevel == null ? item.reorder_level : Number(req.body.reorderLevel),
        item.id,
      );
    audit(req, { action: 'edit', entity: 'inventory_items', entityId: item.id, oldValue: item, newValue: req.body });
    res.json({ ok: true });
  });

  /* ───────────────────────────────────────────────────────────── reports */

  /**
   * The state of the store, in the figures a manager is asked for.
   *
   * One call rather than a dozen, because these numbers are read together: a
   * consumption trend means one thing beside a healthy stock position and quite
   * another beside a stockout list.
   */
  // Reporting is its own feature — it is read on the module dashboard by
  // whoever holds it, which is not everyone who may work the store.
  router.get('/reports', requirePermission('supplier_inventory.reports', 'view'), (req, res) => {
    const db = getDb();
    const monthsBack = Number(req.query.months) || 12;
    const { months, rows } = stockPositions({ monthsBack });
    const since = monthWindow(monthsBack)[0] + '-01';

    // Consumption and receipts by month — the shape of the store's year.
    const byMonth = db.prepare(`SELECT substr(movement_date, 1, 7) AS month, movement_type, SUM(quantity) AS quantity,
        SUM(COALESCE(unit_cost, 0) * quantity) AS value
      FROM inventory_movements WHERE date(movement_date) >= date(?)
      GROUP BY month, movement_type`).all(since) as any[];
    const trend = months.map(m => {
      const forMonth = byMonth.filter(r => r.month === m);
      const pick = (types: string[]) => sum(forMonth.filter(r => types.includes(r.movement_type)).map(r => Number(r.quantity) || 0));
      return { month: m, issued: pick(['issue', 'consume']), received: pick(['receive', 'return', 'adjust_in', 'transfer_in']), wasted: pick(WASTAGE) };
    });

    // Wastage: what was thrown away against what was received, over the window.
    const wastedUnits = sum(trend.map(t => t.wasted));
    const receivedUnits = sum(trend.map(t => t.received));
    const issuedUnits = sum(trend.map(t => t.issued));

    const statusCounts: Record<string, number> = {};
    for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

    const days = (d: string | null) => d == null ? Infinity : Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
    const expiryRisk = db.prepare(`SELECT b.id, b.batch_number, b.expiry_date, b.quantity_available, i.name AS item_name, i.unit, i.unit_cost
      FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
      WHERE b.quantity_available > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date != ''
        AND date(b.expiry_date) <= date('now', '+180 days')
      ORDER BY b.expiry_date`).all() as any[];
    const riskBand = (d: number) => d < 0 ? 'expired' : d <= 30 ? 'within30' : d <= 90 ? 'within90' : 'within180';
    const expiryBands = { expired: 0, within30: 0, within90: 0, within180: 0 } as Record<string, number>;
    const expiryValue = { expired: 0, within30: 0, within90: 0, within180: 0 } as Record<string, number>;
    for (const b of expiryRisk) {
      const band = riskBand(days(b.expiry_date));
      expiryBands[band] += 1;
      expiryValue[band] += (Number(b.unit_cost) || 0) * (Number(b.quantity_available) || 0);
    }

    // Stock turnover: how many times the average holding was used in a year.
    const stockValue = sum(rows.map(r => r.stock_value ?? 0));
    const consumedValue = sum(rows.map(r => (r.unit_cost ?? 0) * sum(r.consumption)));
    const turnover = stockValue > 0 ? (consumedValue / stockValue) * (12 / monthsBack) : null;

    // Suppliers: what they delivered and how much of it was refused.
    const supplierPerformance = db.prepare(`SELECT s.id, s.name,
        COUNT(b.id) AS deliveries,
        SUM(CASE WHEN b.acceptance_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN b.acceptance_status IN ('pending', 'quarantined') THEN 1 ELSE 0 END) AS awaiting,
        s.last_evaluation_date, s.next_evaluation_due
      FROM suppliers s LEFT JOIN inventory_batches b ON b.supplier_id = s.id AND date(b.date_received) >= date(?)
      GROUP BY s.id ORDER BY deliveries DESC`).all(since) as any[];

    const consumptionByItem = rows.map(r => ({ id: r.id, name: r.name, unit: r.unit, total: sum(r.consumption), value: (r.unit_cost ?? 0) * sum(r.consumption) }))
      .filter(r => r.total > 0).sort((a, b) => b.total - a.total);

    const abcMix = ['A', 'B', 'C'].map(cls => ({
      abc: cls,
      items: rows.filter(r => r.abc_class === cls).length,
      value: Math.round(sum(rows.filter(r => r.abc_class === cls).map(r => r.stock_value ?? 0)) * 100) / 100,
    }));
    const venMix = VEN_CLASSES.map(v => ({ ven: v, items: rows.filter(r => r.ven_class === v).length }));

    res.json({
      generatedAt: new Date().toISOString(),
      months, trend,
      totals: {
        items: rows.length,
        stockValue: Math.round(stockValue * 100) / 100,
        issuedUnits, receivedUnits, wastedUnits,
        wastageRate: receivedUnits > 0 ? Math.round((wastedUnits / receivedUnits) * 1000) / 10 : 0,
        turnover: turnover == null ? null : Math.round(turnover * 100) / 100,
        stockoutItems: rows.filter(r => r.status === 'stockout').length,
        belowReorder: rows.filter(r => NEEDS_ACTION.includes(r.status)).length,
      },
      statusCounts,
      expiry: { bands: expiryBands, value: expiryValue, batches: expiryRisk.slice(0, 40) },
      topConsumers: consumptionByItem.slice(0, 12),
      slowMovers: rows.filter(r => sum(r.consumption) === 0 && r.on_hand > 0)
        .map(r => ({ id: r.id, name: r.name, onHand: r.on_hand, unit: r.unit, value: r.stock_value, lastIssued: r.last_issued }))
        .slice(0, 12),
      shortages: rows.filter(r => NEEDS_ACTION.includes(r.status))
        .sort((a, b) => a.priority - b.priority || (a.months_of_stock ?? 0) - (b.months_of_stock ?? 0))
        .map(r => ({ id: r.id, name: r.name, unit: r.unit, onHand: r.on_hand, issuable: r.issuable, status: r.status,
          monthsOfStock: r.months_of_stock, amc: r.amc, priority: r.priority, abc: r.abc_class, ven: r.ven_class,
          supplierName: r.supplier_name })),
      abcMix, venMix, supplierPerformance,
    });
  });

  return router;
}

function safeJson(v: unknown) {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}

/**
 * The words behind a picklist code.
 *
 * Issue reasons are the laboratory's own list, held as codes so a rename in
 * Settings does not orphan the records that used them. A movement, though, is
 * read as a line of text on a bin card long after the fact, so it carries the
 * label as it read on the day.
 */
function optionLabel(db: ReturnType<typeof getDb>, listKey: string, value: unknown): string | null {
  const code = String(value ?? '').trim();
  if (!code) return null;
  const row = db.prepare('SELECT label FROM config_options WHERE list_key = ? AND value = ?')
    .get(listKey, code) as { label?: string } | undefined;
  return row?.label ?? code;
}
