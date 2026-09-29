import { Router, type Request } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { viewableModulesOf } from '../middleware/permissions.js';
import { MODULES } from '../../shared/constants/modules.js';

// ==========================================================================
// Global search — the one field in the top bar that reaches the whole system.
//
// A laboratory does not think in modules. Someone holding a centrifuge with a
// sticker on it, or a document code read off a printed SOP, wants to type what
// they have and be taken to the record; working out that a centrifuge lives
// under Equipment Management → Equipment Register is the software's job, not
// theirs. So this endpoint asks every register the same question and returns
// one ranked list.
//
// Three rules hold it together:
//
//  * Permission is per module, resolved per request. `viewableModulesOf` gives
//    the caller's viewable set and a register whose module is not in it is not
//    queried at all — search can never become a way to read a module you were
//    refused. This mirrors the dashboard summary endpoints in common.ts.
//
//  * Every result carries the URL that opens it, built the way an alert's is:
//    the module's route, the tab the record lives on, and
//    `?focus=<table>:<id>` for the client's useFocusTarget to scroll to and
//    flash. A page that does not yet consume that focus type still lands the
//    reader on the right tab, which is no worse than before.
//
//  * Soft-deleted rows (`deleted_at`) never surface.
// ==========================================================================

/** A register this endpoint can search. */
type SearchSource = {
  /** Result grouping, and what the reader sees above the group. */
  type: string;
  /** The module whose `view` permission governs the whole register. */
  moduleKey: string;
  table: string;
  /** Columns matched against the query, most identifying first. */
  columns: string[];
  /** The column holding the record's human reference (document code, NC number). */
  codeColumn?: string;
  /** The column holding the record's name, used as the result's heading. */
  titleColumn: string;
  /** Extra columns shown under the heading, in order, blanks dropped. */
  detailColumns?: string[];
  /** Route to open, when the module is served by more than one. */
  route?: string;
  /** The workspace tab the record lives on. */
  tab?: string;
  /** Inner tab, for a workspace nested inside another module's tab. */
  subtab?: string;
  /** `WHERE` fragment applied on top of the text match (no parameters). */
  scope?: string;
};

/**
 * Every register the top bar can reach, in the order a tie is broken.
 *
 * Documents and staff lead because they are what people look up by code and by
 * name all day. `columns` is ordered too: a hit on the first column (the code,
 * the name) outranks a hit further down (a description), which is what makes
 * typing a document code put that document at the top rather than every SOP
 * that happens to mention it.
 */
const SOURCES: SearchSource[] = [
  {
    type: 'Document', moduleKey: 'documents', table: 'documents',
    codeColumn: 'document_code', titleColumn: 'title',
    columns: ['document_code', 'title', 'remarks'],
    detailColumns: ['document_type', 'status'],
    tab: 'Documents',
  },
  {
    type: 'Record', moduleKey: 'documents', table: 'record_register',
    codeColumn: 'record_code', titleColumn: 'title',
    columns: ['record_code', 'title', 'notes'],
    detailColumns: ['record_category', 'status'],
    tab: 'Records',
  },
  {
    type: 'Staff', moduleKey: 'personnel', table: 'staff',
    codeColumn: 'employee_no', titleColumn: 'full_name',
    columns: ['full_name', 'employee_no', 'email', 'phone', 'designation', 'job_title'],
    detailColumns: ['job_title', 'designation'],
    tab: 'Master Personnel Register',
  },
  {
    type: 'Equipment', moduleKey: 'equipment', table: 'equipment_items',
    codeColumn: 'equipment_number', titleColumn: 'name',
    columns: ['name', 'equipment_number', 'serial_number', 'model', 'manufacturer', 'category'],
    detailColumns: ['manufacturer', 'model', 'status'],
    tab: 'Equipment Register',
  },
  {
    type: 'Stock item', moduleKey: 'supplier_inventory', table: 'inventory_items',
    codeColumn: 'item_code', titleColumn: 'name',
    columns: ['name', 'item_code', 'catalogue_number', 'product_barcode', 'manufacturer', 'category'],
    detailColumns: ['category', 'status'],
    tab: 'Item Register',
  },
  {
    type: 'Supplier', moduleKey: 'supplier_inventory', table: 'suppliers',
    codeColumn: 'supplier_code', titleColumn: 'name',
    columns: ['name', 'supplier_code', 'contact_person', 'email', 'phone'],
    detailColumns: ['item_category', 'status'],
    tab: 'Suppliers',
  },
  {
    type: 'Action', moduleKey: 'actions', table: 'actions',
    titleColumn: 'title',
    columns: ['title', 'description'],
    detailColumns: ['status', 'priority'],
  },
  {
    type: 'Nonconformity', moduleKey: 'nc_capa', table: 'nonconforming_events',
    codeColumn: 'nc_number', titleColumn: 'title',
    columns: ['nc_number', 'title', 'description'],
    detailColumns: ['category', 'status'],
    route: '/nonconformities', tab: 'Register',
  },
  {
    type: 'Incident', moduleKey: 'nc_capa', table: 'incidents',
    codeColumn: 'incident_number', titleColumn: 'description',
    columns: ['incident_number', 'description', 'incident_type', 'location_text'],
    detailColumns: ['incident_type', 'status'],
    route: '/incidents', tab: 'Register',
  },
  {
    type: 'CAPA', moduleKey: 'nc_capa', table: 'capa_records',
    codeColumn: 'capa_number', titleColumn: 'title',
    columns: ['capa_number', 'title', 'problem_summary'],
    detailColumns: ['priority', 'status'],
    route: '/capa', tab: 'Register',
  },
  {
    type: 'Complaint', moduleKey: 'complaints', table: 'complaints',
    codeColumn: 'complaint_number', titleColumn: 'title',
    columns: ['complaint_number', 'title', 'description', 'complainant_name'],
    detailColumns: ['category', 'status'],
    route: '/complaints', tab: 'Complaints Register',
  },
  {
    type: 'Risk', moduleKey: 'risks', table: 'risks',
    codeColumn: 'risk_number', titleColumn: 'risk_description',
    columns: ['risk_number', 'risk_description', 'risk_area', 'cause'],
    detailColumns: ['risk_area', 'risk_level', 'status'],
    route: '/risks', tab: 'Risk Register',
  },
  {
    type: 'Improvement project', moduleKey: 'continual_improvement', table: 'improvement_projects',
    codeColumn: 'project_number', titleColumn: 'title',
    columns: ['project_number', 'title', 'aim_statement', 'improvement_area'],
    detailColumns: ['improvement_area', 'status'],
    tab: 'Improvement Projects',
  },
];

const MODULE_PATHS = new Map(MODULES.map(m => [m.key, m.path]));
const MODULE_LABELS = new Map(MODULES.map(m => [m.key, m.label]));

export type SearchHit = {
  type: string;
  moduleKey: string;
  moduleLabel: string;
  id: number;
  code: string | null;
  title: string;
  detail: string;
  url: string;
};

/**
 * Which columns a table really has.
 *
 * A source names the columns worth searching, but this schema grows by
 * migration and an installation that has not run the latest one is still
 * expected to boot. Checking first means a missing column narrows the search
 * by one field instead of throwing on every keystroke.
 */
const columnCache = new Map<string, Set<string>>();
function columnsOf(table: string): Set<string> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  let cols = new Set<string>();
  try {
    cols = new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  } catch { /* table absent on this installation — the source is skipped */ }
  columnCache.set(table, cols);
  return cols;
}

/** LIKE is being used for a substring match, so its own wildcards are escaped. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
}

const clean = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function urlFor(src: SearchSource, id: number): string {
  const base = src.route || MODULE_PATHS.get(src.moduleKey) || '/home';
  const params = new URLSearchParams();
  if (src.tab) params.set('tab', src.tab);
  if (src.subtab) params.set('subtab', src.subtab);
  params.set('focus', `${src.table}:${id}`);
  return `${base}?${params.toString()}`;
}

/**
 * Rank one row against the query.
 *
 * Lower is better. The column that matched decides the band — a hit on the
 * code or the name beats a hit in a description — and within a band an exact
 * match beats a prefix, which beats a substring. Ties fall back to the order
 * SOURCES is written in, so a document outranks an improvement project when
 * both match equally well.
 */
function rankRow(row: Record<string, unknown>, columns: string[], q: string): number {
  const needle = q.toLowerCase();
  let best = Number.MAX_SAFE_INTEGER;
  columns.forEach((col, index) => {
    const value = clean(row[col]).toLowerCase();
    if (!value || !value.includes(needle)) return;
    const precision = value === needle ? 0 : value.startsWith(needle) ? 1 : 2;
    best = Math.min(best, index * 3 + precision);
  });
  return best;
}

export function searchRoutes() {
  const router = Router();
  router.use(requireAuth);

  /**
   * GET /api/search?q=…&limit=…
   *
   * Returns `{ query, results, truncated }`. `truncated` says the caller is
   * looking at the top of a longer list, so the field can say so rather than
   * implying these are all the matches there are.
   */
  router.get('/', (req, res, next) => {
    try {
      const q = clean(req.query.q);
      // Two characters is the point below which a substring match returns most
      // of the database and helps nobody.
      if (q.length < 2) return res.json({ query: q, results: [], truncated: false });

      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const seen = viewableModulesOf(req);
      const db = getDb();
      const term = likeTerm(q);
      // Per register, so one busy table cannot crowd out every other kind of
      // record before the ranking has had a chance to run.
      const perSource = Math.min(25, limit);

      const hits: (SearchHit & { rank: number; order: number })[] = [];

      SOURCES.forEach((src, order) => {
        if (!seen.has(src.moduleKey)) return;
        const available = columnsOf(src.table);
        if (available.size === 0) return;

        const columns = src.columns.filter(c => available.has(c));
        if (columns.length === 0) return;

        const selected = Array.from(new Set([
          'id', ...columns, src.titleColumn, ...(src.codeColumn ? [src.codeColumn] : []),
          ...(src.detailColumns ?? []),
        ].filter(c => available.has(c))));

        const where = [`(${columns.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`];
        if (available.has('deleted_at')) where.push('deleted_at IS NULL');
        if (src.scope) where.push(src.scope);

        const sql =
          `SELECT ${selected.join(', ')} FROM ${src.table} ` +
          `WHERE ${where.join(' AND ')} ` +
          `ORDER BY id DESC LIMIT ${perSource}`;

        let rows: Record<string, unknown>[] = [];
        try {
          rows = db.prepare(sql).all(...columns.map(() => term)) as Record<string, unknown>[];
        } catch { return; /* a register this installation does not have */ }

        for (const row of rows) {
          const title = clean(row[src.titleColumn]);
          const code = src.codeColumn ? clean(row[src.codeColumn]) : '';
          const detail = (src.detailColumns ?? [])
            .map(c => clean(row[c]))
            .filter(Boolean)
            .join(' · ');
          const id = Number(row.id);
          if (!Number.isFinite(id)) continue;
          hits.push({
            type: src.type,
            moduleKey: src.moduleKey,
            moduleLabel: MODULE_LABELS.get(src.moduleKey) ?? src.moduleKey,
            id,
            code: code || null,
            // A record with no name of its own is still findable by its code.
            title: title || code || `#${id}`,
            detail,
            url: urlFor(src, id),
            rank: rankRow(row, columns, q),
            order,
          });
        }
      });

      hits.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order));
      const results = hits.slice(0, limit).map(({ rank: _rank, order: _order, ...hit }) => hit);
      res.json({ query: q, results, truncated: hits.length > results.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default searchRoutes;
