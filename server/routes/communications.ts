/**
 * The Communication API — one surface for everything SECH_LIMS says and hears.
 *
 * Mounted at /api/communications and permissioned on the four
 * `information_management.communication*` features. The logic lives in
 * services/communicationService.ts; this file is the boundary: it validates,
 * decides who may do what, and renders a memo for paper, Word, plain text or an
 * external channel.
 *
 * ── Who may do what ─────────────────────────────────────────────────────────
 * Rights are expressed as actions on the existing permission engine rather
 * than as a new vocabulary (see shared/constants/features.ts):
 *
 *   communication            view/create       messages, conversations, replies
 *   communication_memos      create/approve/   formal memos and notices, and
 *                            export/print      preparing them for a channel
 *   communication_log        view/export       the register and the audit trail
 *   communication_audiences  view/edit         audiences and templates
 *
 * Two reading rules hold throughout, and they are what keep the hub usable
 * without opening everyone's correspondence:
 *
 *  · A person always reaches a communication they SENT or were ADDRESSED TO,
 *    on `communication: view` alone. That is their own correspondence.
 *  · Reading somebody else's requires `communication_log: view`. The register
 *    is the audit view, and it is marked sensitive for that reason.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { getDb, uploadRoot, evidenceRoot } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { buildDocxFromHtml } from '../utils/documentBuild.js';
import { buildWorkbook, sendWorkbook } from '../utils/xlsxRegister.js';
import { parseIntNullable } from './routeHelpers.js';
import {
  createCommunication, sendCommunication, recordExternalShare, recordDispatch,
  logCommunicationEvent, markRecipientState, recipientRowFor, loadCommunication,
  resolveAudiences, audienceSize, audienceLabel,
  type AudienceSelection, type CommunicationInput,
} from '../services/communicationService.js';
import {
  COMMUNICATION_TYPES, COMMUNICATION_DIRECTIONS, COMMUNICATION_CHANNELS, AUDIENCE_KINDS,
  COMMUNICATION_PRIORITIES, COMMUNICATION_CONFIDENTIALITY, SHARE_FORMATS, DISPATCH_METHODS,
  AUDIENCE_GROUP_SOURCES, COMMUNICATION_TYPE_LABELS, COMM_FEATURE,
  confidentialityIsSensitive, channelIsIntegrated, messagePreview,
  type CommunicationType,
} from '../../shared/constants/communications.js';

/**
 * The permission keys, written out as literals.
 *
 * `COMM_FEATURE` in shared/constants/communications.ts is the canonical
 * definition; these are the same four strings spelled out, because the
 * repository's access audits (scripts/access-audit.mjs,
 * scripts/access-scan-controls.mjs) read the guard on every route straight from
 * this source and cannot follow a property access. The assertion below makes
 * drift impossible: change either list and `npm run typecheck` fails here.
 */
const COMM_MESSAGES = 'information_management.communication';
const COMM_MEMOS = 'information_management.communication_memos';
const COMM_LOG = 'information_management.communication_log';
const COMM_ADMIN = 'information_management.communication_audiences';
const FEATURE_KEYS_MATCH: [
  typeof COMM_FEATURE.messages, typeof COMM_FEATURE.memos,
  typeof COMM_FEATURE.log, typeof COMM_FEATURE.admin,
] = [COMM_MESSAGES, COMM_MEMOS, COMM_LOG, COMM_ADMIN];
void FEATURE_KEYS_MATCH;

const FORMAL_TYPES = new Set(['memo', 'notice']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escLines(value: unknown): string {
  return esc(value).replace(/\r?\n/g, '<br/>');
}

/** The feature a communication of this type is governed by. */
function featureFor(type: string): string {
  return FORMAL_TYPES.has(type) ? COMM_MEMOS : COMM_MESSAGES;
}

function may(req: any, feature: string, action: string): boolean {
  return Boolean(req.user) && resolvePermission(req.user.id, feature, action).allowed;
}

/**
 * Whether this caller may read this communication.
 *
 * Their own correspondence always; anybody else's only with the register
 * right. Returns the caller's recipient row when they have one, because every
 * caller that asks this question then wants it.
 */
function readAccess(req: any, communicationId: number): { allowed: boolean; recipient: any | null; viaRegister: boolean } {
  const db = getDb();
  const recipient = req.user ? recipientRowFor(db, communicationId, req.user.id) : null;
  if (recipient) return { allowed: true, recipient, viaRegister: false };
  const sender = db.prepare('SELECT 1 AS hit FROM communications WHERE id = ? AND sender_user_id = ?')
    .get(communicationId, req.user?.id) as { hit: number } | undefined;
  if (sender) return { allowed: true, recipient: null, viaRegister: false };
  if (may(req, COMM_LOG, 'view')) return { allowed: true, recipient: null, viaRegister: true };
  return { allowed: false, recipient: null, viaRegister: false };
}

/** Audience selections off the request body, validated. */
function readAudiences(body: any): { audiences: AudienceSelection[]; error?: string } {
  const raw = Array.isArray(body?.audiences) ? body.audiences : [];
  const audiences: AudienceSelection[] = [];
  for (const entry of raw) {
    const kind = String(entry?.kind ?? '');
    if (!AUDIENCE_KINDS.includes(kind as never)) return { audiences: [], error: `audience kind must be one of: ${AUDIENCE_KINDS.join(', ')}` };
    audiences.push({ kind, ref: entry?.ref ?? null, label: entry?.label ?? null });
  }
  return { audiences };
}

/** The laboratory masthead, used on the printed memo sheet. */
function labHeader(db: any): { org: string; subtitle: string; logo: string | null } {
  const profile = db.prepare('SELECT * FROM laboratory_profile WHERE id = 1').get() as any;
  let logo: string | null = null;
  if (profile?.logo_file_id) {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(profile.logo_file_id) as any;
    if (file) {
      const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
      const fp = path.join(root, file.stored_name);
      try {
        if (fs.existsSync(fp)) logo = `data:${file.mime_type || 'image/png'};base64,${fs.readFileSync(fp).toString('base64')}`;
      } catch { logo = null; }
    }
  }
  return {
    org: profile?.facility_name || 'Laboratory',
    subtitle: [profile?.city, profile?.country].filter(Boolean).join(', '),
    logo,
  };
}

/** The list of addressees as the memo sheet prints it. */
function recipientSummary(recipients: Array<{ audience_label: string }>): string {
  const labels = [...new Set(recipients.map(r => r.audience_label))];
  if (labels.length === 0) return '—';
  if (labels.length <= 4) return labels.join('; ');
  return `${labels.slice(0, 4).join('; ')} and ${labels.length - 4} more`;
}

/* ========================================================================== *
 * Rendering one communication for paper, Word, plain text or an image
 * ========================================================================== */

/**
 * The memo body, as a self-contained HTML fragment.
 *
 * One renderer feeds every output: the print sheet, the Word export, the image
 * capture and the on-screen preview, so a memo that has been approved looks the
 * same however it leaves the building. A plain message renders through the same
 * frame without the TO/FROM block, because a message shared as a PDF still
 * needs to say who sent it and when.
 */
function renderBody(db: any, comm: any): string {
  const isFormal = FORMAL_TYPES.has(comm.communication_type);
  const recipients = comm.recipients ?? [];
  const heading = isFormal ? (comm.communication_type === 'memo' ? 'MEMORANDUM' : 'NOTICE') : 'COMMUNICATION';
  const bodyHtml = comm.body_format === 'html' ? String(comm.body ?? '') : escLines(comm.body);
  const metaRows: Array<[string, string]> = [];
  metaRows.push(['TO', esc(comm.memo_to_text || recipientSummary(recipients))]);
  metaRows.push(['FROM', esc(comm.memo_from_text || comm.sender_name || '—')]);
  metaRows.push(['DATE', esc(comm.memo_date || String(comm.sent_at || comm.created_at).slice(0, 10))]);
  if (comm.memo_reference) metaRows.push(['REF', esc(comm.memo_reference)]);
  metaRows.push(['OUR REF', esc(comm.communication_number)]);
  metaRows.push(['SUBJECT', esc(comm.subject)]);

  const attachments = (comm.attachments ?? []) as Array<{ original_name: string | null; caption: string | null }>;
  const signatory = comm.signatory_name
    || (comm.signatory_staff_id ? (db.prepare('SELECT full_name FROM staff WHERE id = ?').get(comm.signatory_staff_id) as { full_name?: string } | undefined)?.full_name : null)
    || comm.sender_name;

  return `<div class="memo">
  <h1>${esc(heading)}</h1>
  ${metaRows.map(([k, v]) => `<div class="metaline"><b>${k}:</b> ${v}</div>`).join('\n  ')}
  <div class="body">${bodyHtml}</div>
  ${attachments.length ? `<div class="attach"><b>Attachments:</b><ul>${attachments.map(a => `<li>${esc(a.original_name)}${a.caption ? ` — ${esc(a.caption)}` : ''}</li>`).join('')}</ul></div>` : ''}
  ${comm.requires_acknowledgement ? `<div class="ack"><b>Acknowledgement required${comm.acknowledgement_due ? ` by ${esc(String(comm.acknowledgement_due).slice(0, 10))}` : ''}.</b> Recipients are to acknowledge this communication in SECH_LIMS.</div>` : ''}
  ${comm.approved_at ? `<div class="approval">Approved by ${esc(comm.approved_by_name || '—')} on ${esc(String(comm.approved_at).slice(0, 16).replace('T', ' '))}.</div>` : ''}
  <div class="sign">……………………………………<br/>${esc(signatory || '')}</div>
</div>`;
}

/** A printable A4 sheet. `autoprint=0` opens it for reading instead. */
function printShell(title: string, bodyHtml: string, header: ReturnType<typeof labHeader>, footer: string, autoprint: boolean): string {
  const script = autoprint ? '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 300); });</script>' : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>${esc(title)}</title>
<style>
@page{size:A4 portrait;margin:16mm}
*{box-sizing:border-box}
html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Times New Roman',Times,serif;color:#111;margin:0;padding:12px 18px}
.toolbar{background:#f4f6fb;border:1px solid #ccd6e8;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;font-family:Arial,Helvetica,sans-serif;display:flex;gap:12px;align-items:center;justify-content:space-between}
.toolbar button{font:inherit;padding:4px 10px;border:1px solid #9bb0d0;border-radius:4px;background:#fff;cursor:pointer}
.mast{display:flex;align-items:center;gap:16px;border-bottom:2px solid #16284b;padding-bottom:8px;margin-bottom:16px}
.mast img{height:74px;width:auto;object-fit:contain}
.mast-txt{flex:1;text-align:center}
.mast-txt .org{font-weight:bold;font-size:17px;letter-spacing:.4px}
.mast-txt .sub{font-size:12px;color:#44546b}
.memo h1{font-size:22px;margin:0 0 12px;text-align:center;letter-spacing:3px;text-decoration:underline}
.memo .metaline{font-size:13.5px;margin:3px 0}
.memo .body{margin:18px 0;font-size:14px;line-height:1.6;white-space:normal}
.memo .body p{margin:0 0 10px}
.memo table{border-collapse:collapse;width:100%;margin:12px 0}
.memo th,.memo td{border:1px solid #333;padding:6px 8px;text-align:left;font-size:12.5px;vertical-align:top}
.memo .attach{font-size:12.5px;margin-top:14px}
.memo .attach ul{margin:4px 0 0 18px}
.memo .ack{margin-top:14px;font-size:12.5px;border:1px solid #333;padding:7px 9px}
.memo .approval{margin-top:12px;font-size:12px;color:#44546b;font-style:italic}
.memo .sign{margin-top:38px;font-size:13.5px}
.footer{margin-top:26px;border-top:1px solid #ccc;padding-top:6px;font-size:9.5px;color:#5c6b7f;font-family:Arial,Helvetica,sans-serif;display:flex;justify-content:space-between;gap:16px}
@media print{.toolbar{display:none}body{padding:0}}
</style>${script}</head><body>
<div class="toolbar"><span>Choose any installed printer, or <strong>Save as PDF</strong> as the destination.</span>
<span><button type="button" onclick="window.print()">Print</button> <a href="?autoprint=0">Open without printing</a></span></div>
<div class="mast">${header.logo ? `<img src="${header.logo}" alt=""/>` : '<div style="width:74px"></div>'}
<div class="mast-txt"><div class="org">${esc(header.org)}</div>${header.subtitle ? `<div class="sub">${esc(header.subtitle)}</div>` : ''}</div>
<div style="width:74px"></div></div>
${bodyHtml}
<div class="footer"><span>${esc(footer)}</span><span>Printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</span></div>
</body></html>`;
}

/** The same communication as plain text, for a copy-paste or a text channel. */
function renderPlainText(comm: any): string {
  const recipients = comm.recipients ?? [];
  const lines: string[] = [];
  const isFormal = FORMAL_TYPES.has(comm.communication_type);
  lines.push(isFormal ? (comm.communication_type === 'memo' ? 'MEMORANDUM' : 'NOTICE') : 'COMMUNICATION');
  lines.push('');
  lines.push(`TO:       ${comm.memo_to_text || recipientSummary(recipients)}`);
  lines.push(`FROM:     ${comm.memo_from_text || comm.sender_name || '—'}`);
  lines.push(`DATE:     ${comm.memo_date || String(comm.sent_at || comm.created_at).slice(0, 10)}`);
  lines.push(`OUR REF:  ${comm.communication_number}`);
  lines.push(`SUBJECT:  ${comm.subject}`);
  lines.push('');
  lines.push(String(comm.body ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
  if (comm.requires_acknowledgement) {
    lines.push('');
    lines.push(`Acknowledgement required${comm.acknowledgement_due ? ` by ${String(comm.acknowledgement_due).slice(0, 10)}` : ''}.`);
  }
  lines.push('');
  lines.push(comm.signatory_name || comm.sender_name || '');
  return lines.join('\n');
}

export function communicationsRoutes() {
  const router = Router();

  /* ====================================================================== *
   * Summary and reference data
   * ====================================================================== */

  router.get('/summary', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;
    const mine = `(r.user_id = ? OR (r.staff_id IS NOT NULL AND r.staff_id = (SELECT staff_id FROM users WHERE id = ?)))`;

    res.json({
      myUnread: count(`SELECT COUNT(*) c FROM communication_recipients r JOIN communications c ON c.id = r.communication_id
        WHERE ${mine} AND r.delivery_status IN ('delivered','pending') AND c.status IN ('sent','received')`, userId, userId),
      myThreads: count(`SELECT COUNT(DISTINCT c.thread_id) c FROM communications c
        LEFT JOIN communication_recipients r ON r.communication_id = c.id
        WHERE c.sender_user_id = ? OR ${mine}`, userId, userId, userId),
      myAwaitingAcknowledgement: count(`SELECT COUNT(*) c FROM communication_recipients r JOIN communications c ON c.id = r.communication_id
        WHERE ${mine} AND c.requires_acknowledgement = 1 AND r.acknowledged_at IS NULL AND c.status IN ('sent','received')`, userId, userId),
      awaitingApproval: count("SELECT COUNT(*) c FROM communications WHERE status = 'pending_approval'"),
      draftsMine: count("SELECT COUNT(*) c FROM communications WHERE status = 'draft' AND created_by = ?", userId),
      sentThisMonth: count("SELECT COUNT(*) c FROM communications WHERE status = 'sent' AND COALESCE(sent_at, created_at) >= ?", monthStart),
      inboundThisMonth: count("SELECT COUNT(*) c FROM communications WHERE direction = 'inbound' AND created_at >= ?", monthStart),
      externalSharesThisMonth: count("SELECT COUNT(*) c FROM communication_dispatches WHERE dispatch_method <> 'system' AND dispatched_at >= ?", monthStart),
      byType: db.prepare('SELECT communication_type, COUNT(*) c FROM communications GROUP BY communication_type ORDER BY c DESC').all(),
      byChannel: db.prepare('SELECT channel, COUNT(*) c FROM communications GROUP BY channel ORDER BY c DESC').all(),
      byDirection: db.prepare('SELECT direction, COUNT(*) c FROM communications GROUP BY direction ORDER BY c DESC').all(),
    });
  });

  /**
   * Every audience a sender may pick, with how many people each reaches today.
   *
   * Computed server-side because the count is the whole point: "All laboratory
   * staff (42)" is a sender checking they mean it, and a client cannot work
   * that out without being handed the staff register.
   */
  router.get('/audience-options', requirePermission(COMM_MESSAGES, 'view'), (_req, res) => {
    const db = getDb();
    const options: Array<{ kind: string; ref: string | null; label: string; detail?: string | null; recipientCount: number }> = [];
    const push = (kind: string, ref: string | number | null, label: string, detail?: string | null) => {
      options.push({ kind, ref: ref == null ? null : String(ref), label, detail: detail ?? null, recipientCount: audienceSize(db, { kind, ref }) });
    };

    push('laboratory_staff', null, 'All laboratory staff');
    push('all_users', null, 'All SECH_LIMS users');
    for (const g of db.prepare('SELECT audience_code, audience_name, description FROM communication_audiences WHERE is_active = 1 ORDER BY audience_name').all() as any[]) {
      push('audience_group', g.audience_code, g.audience_name, g.description);
    }
    for (const d of db.prepare('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name').all() as any[]) push('department', d.id, d.name, 'Department');
    for (const s of db.prepare('SELECT s.id, s.name, d.name AS dept FROM sections s LEFT JOIN departments d ON d.id = s.department_id WHERE s.is_active = 1 ORDER BY s.name').all() as any[]) push('section', s.id, s.name, s.dept ? `Unit — ${s.dept}` : 'Unit');
    for (const p of db.prepare('SELECT id, title FROM positions WHERE is_active = 1 ORDER BY title').all() as any[]) push('position', p.id, p.title, 'Position');
    for (const r of db.prepare('SELECT id, name FROM roles ORDER BY name').all() as any[]) push('role', r.id, r.name, 'Access profile');
    for (const u of db.prepare(`SELECT u.id, COALESCE(s.full_name, u.full_name) AS name, u.username
      FROM users u LEFT JOIN staff s ON s.id = u.staff_id WHERE u.is_active = 1 ORDER BY name`).all() as any[]) {
      options.push({ kind: 'user', ref: String(u.id), label: u.name, detail: u.username, recipientCount: 1 });
    }
    for (const s of db.prepare(`SELECT s.id, s.full_name, sec.name AS unit FROM staff s
      LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.is_active = 1 ORDER BY s.full_name`).all() as any[]) {
      options.push({ kind: 'staff', ref: String(s.id), label: s.full_name, detail: s.unit ?? 'Staff', recipientCount: 1 });
    }
    for (const t of db.prepare("SELECT stakeholder_type, COUNT(*) c FROM customer_stakeholders WHERE is_active = 1 GROUP BY stakeholder_type ORDER BY stakeholder_type").all() as any[]) {
      options.push({ kind: 'stakeholder_group', ref: t.stakeholder_type, label: `Stakeholders — ${String(t.stakeholder_type).replace(/_/g, ' ')}`, detail: 'Stakeholder group', recipientCount: t.c });
    }
    for (const s of db.prepare('SELECT id, stakeholder_name, stakeholder_type FROM customer_stakeholders WHERE is_active = 1 ORDER BY stakeholder_name').all() as any[]) {
      options.push({ kind: 'stakeholder', ref: String(s.id), label: s.stakeholder_name, detail: String(s.stakeholder_type).replace(/_/g, ' '), recipientCount: 1 });
    }
    res.json(options);
  });

  /** How many people a proposed audience set reaches, and who they are. */
  router.post('/resolve-audiences', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const { audiences, error } = readAudiences(req.body);
    if (error) return res.status(400).json({ error });
    const resolved = resolveAudiences(getDb(), audiences);
    res.json({
      total: resolved.length,
      inApp: resolved.filter(r => r.reachableInApp).length,
      external: resolved.filter(r => !r.reachableInApp).length,
      recipients: resolved.map(r => ({ name: r.name, label: r.audienceLabel, reachableInApp: r.reachableInApp, externalAddress: r.externalAddress })),
    });
  });

  /* ====================================================================== *
   * Conversations
   * ====================================================================== */

  /**
   * The conversation list.
   *
   * `scope=mine` (the default) is the person's own inbox. `scope=all` is the
   * register's view of every conversation in the system and asks for the
   * register right, because that is somebody else's correspondence.
   */
  router.get('/threads', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const scope = String(req.query.scope ?? 'mine');
    if (scope === 'all' && !may(req, COMM_LOG, 'view')) {
      return res.status(403).json({ error: 'Reading other people’s conversations needs the communication log right.' });
    }
    const search = String(req.query.search ?? '').trim();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (scope !== 'all') {
      filters.push(`t.id IN (SELECT c.thread_id FROM communications c
        LEFT JOIN communication_recipients r ON r.communication_id = c.id
        WHERE c.sender_user_id = ? OR r.user_id = ? OR (r.staff_id IS NOT NULL AND r.staff_id = (SELECT staff_id FROM users WHERE id = ?)))`);
      params.push(userId, userId, userId);
    }
    if (req.query.type) { filters.push('t.communication_type = ?'); params.push(String(req.query.type)); }
    if (search) { filters.push('(t.subject LIKE ? OR t.thread_number LIKE ? OR t.last_message_preview LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const rows = db.prepare(`SELECT t.*,
        COALESCE(ls.full_name, lu.full_name) AS last_sender_name,
        COALESCE(bs.full_name, bu.full_name) AS started_by_name,
        (SELECT COUNT(*) FROM communication_recipients r2
           JOIN communications c2 ON c2.id = r2.communication_id
          WHERE c2.thread_id = t.id AND c2.status IN ('sent','received')
            AND (r2.user_id = ? OR (r2.staff_id IS NOT NULL AND r2.staff_id = (SELECT staff_id FROM users WHERE id = ?)))
            AND r2.read_at IS NULL AND r2.dismissed_at IS NULL) AS unread_count
      FROM communication_threads t
      LEFT JOIN users lu ON lu.id = t.last_sender_user_id
      LEFT JOIN staff ls ON ls.id = lu.staff_id
      LEFT JOIN users bu ON bu.id = t.started_by_user_id
      LEFT JOIN staff bs ON bs.id = bu.staff_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT ?`).all(userId, userId, ...params, Math.min(500, Number(req.query.limit ?? 150)));
    res.json(rows);
  });

  /** One conversation, with every message the caller may read. */
  router.get('/threads/:id', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const thread = db.prepare('SELECT * FROM communication_threads WHERE id = ?').get(req.params.id) as any;
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });

    const member = db.prepare(`SELECT 1 AS hit FROM communications c
      LEFT JOIN communication_recipients r ON r.communication_id = c.id
      WHERE c.thread_id = ? AND (c.sender_user_id = ? OR r.user_id = ?
        OR (r.staff_id IS NOT NULL AND r.staff_id = (SELECT staff_id FROM users WHERE id = ?))) LIMIT 1`)
      .get(req.params.id, userId, userId, userId) as { hit: number } | undefined;
    if (!member && !may(req, COMM_LOG, 'view')) {
      return res.status(403).json({ error: 'This conversation is not addressed to you.' });
    }

    const ids = (db.prepare(`SELECT id FROM communications WHERE thread_id = ? AND status <> 'void' ORDER BY id`)
      .all(req.params.id) as Array<{ id: number }>).map(r => r.id);
    const messages = ids.map(id => {
      const comm = loadCommunication(db, id);
      if (!comm) return null;
      const own = req.user ? recipientRowFor(db, id, req.user.id) : null;
      comm.my_recipient_id = own?.id ?? null;
      comm.my_delivery_status = own?.delivery_status ?? null;
      comm.my_read_at = own?.read_at ?? null;
      return comm;
    }).filter(Boolean);

    const participants = (db.prepare(`SELECT DISTINCT r.audience_label AS label FROM communication_recipients r
      JOIN communications c ON c.id = r.communication_id WHERE c.thread_id = ?`).all(req.params.id) as Array<{ label: string }>)
      .map(r => r.label);

    res.json({ ...thread, messages, participants });
  });

  /** Mark every message in a conversation read by this person. */
  router.post('/threads/:id/read', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const rows = db.prepare(`SELECT r.id, r.communication_id FROM communication_recipients r
      JOIN communications c ON c.id = r.communication_id
      WHERE c.thread_id = ? AND r.read_at IS NULL
        AND (r.user_id = ? OR (r.staff_id IS NOT NULL AND r.staff_id = (SELECT staff_id FROM users WHERE id = ?)))`)
      .all(req.params.id, userId, userId) as Array<{ id: number; communication_id: number }>;
    for (const row of rows) markRecipientState(req, row.communication_id, row.id, 'read');
    res.json({ ok: true, marked: rows.length });
  });

  /**
   * The popup feed: messages addressed to this person that they have not seen.
   *
   * `since` lets the shell ask only for what has arrived since it last looked,
   * so the poll stays small however busy the laboratory is.
   */
  router.get('/inbox/new', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const since = String(req.query.since ?? '').trim();
    const params: unknown[] = [userId, userId];
    let sinceClause = '';
    if (since) { sinceClause = 'AND COALESCE(c.sent_at, c.created_at) > ?'; params.push(since); }

    const rows = db.prepare(`SELECT c.id, c.communication_number, c.thread_id, c.subject, c.body, c.communication_type,
        c.priority, c.confidentiality, c.requires_acknowledgement, c.acknowledgement_due,
        COALESCE(c.sent_at, c.created_at) AS sent_at,
        COALESCE(ss.full_name, su.full_name, c.sender_external_name) AS sender_name,
        t.thread_number, r.id AS my_recipient_id, r.delivery_status AS my_delivery_status
      FROM communication_recipients r
      JOIN communications c ON c.id = r.communication_id
      JOIN communication_threads t ON t.id = c.thread_id
      LEFT JOIN users su ON su.id = c.sender_user_id
      LEFT JOIN staff ss ON ss.id = c.sender_staff_id
      WHERE (r.user_id = ? OR (r.staff_id IS NOT NULL AND r.staff_id = (SELECT staff_id FROM users WHERE id = ?)))
        AND c.status IN ('sent','received') AND r.read_at IS NULL AND r.dismissed_at IS NULL
        ${sinceClause}
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC
      LIMIT 20`).all(...params) as any[];

    res.json({
      now: new Date().toISOString(),
      messages: rows.map(r => ({ ...r, preview: messagePreview(r.body, 160) })),
    });
  });

  /* ====================================================================== *
   * Composing, approving, sending
   * ====================================================================== */

  function validateBody(body: any): string | null {
    const type = String(body?.type ?? '');
    if (!COMMUNICATION_TYPES.includes(type as CommunicationType)) return `type must be one of: ${COMMUNICATION_TYPES.join(', ')}`;
    if (!String(body?.subject ?? '').trim()) return 'A subject is required.';
    if (!String(body?.body ?? '').trim()) return 'A message is required.';
    if (body.direction && !COMMUNICATION_DIRECTIONS.includes(body.direction)) return `direction must be one of: ${COMMUNICATION_DIRECTIONS.join(', ')}`;
    if (body.channel && !COMMUNICATION_CHANNELS.includes(body.channel)) return `channel must be one of: ${COMMUNICATION_CHANNELS.join(', ')}`;
    if (body.priority && !COMMUNICATION_PRIORITIES.includes(body.priority)) return `priority must be one of: ${COMMUNICATION_PRIORITIES.join(', ')}`;
    if (body.confidentiality && !COMMUNICATION_CONFIDENTIALITY.includes(body.confidentiality)) return `confidentiality must be one of: ${COMMUNICATION_CONFIDENTIALITY.join(', ')}`;
    return null;
  }

  function inputFrom(body: any, audiences: AudienceSelection[]): CommunicationInput {
    return {
      type: String(body.type),
      subject: String(body.subject).trim(),
      body: String(body.body),
      bodyFormat: body.bodyFormat === 'html' ? 'html' : 'text',
      direction: body.direction ?? 'internal',
      channel: body.channel ?? 'in_app',
      priority: body.priority ?? 'normal',
      confidentiality: body.confidentiality ?? 'internal',
      audiences,
      threadId: parseIntNullable(body.threadId),
      parentCommunicationId: parseIntNullable(body.parentCommunicationId),
      requiresApproval: Boolean(body.requiresApproval),
      requiresAcknowledgement: Boolean(body.requiresAcknowledgement),
      acknowledgementDue: body.acknowledgementDue || null,
      memoToText: body.memoToText || null,
      memoFromText: body.memoFromText || null,
      memoDate: body.memoDate || null,
      memoReference: body.memoReference || null,
      signatoryStaffId: parseIntNullable(body.signatoryStaffId),
      signatoryName: body.signatoryName || null,
      sourceModule: body.sourceModule || null,
      sourceRecordType: body.sourceRecordType || null,
      sourceRecordId: body.sourceRecordId ?? null,
      senderExternalName: body.senderExternalName || null,
      senderExternalAddress: body.senderExternalAddress || null,
      attachments: Array.isArray(body.attachmentFileIds)
        ? body.attachmentFileIds.map((id: unknown) => ({ fileId: Number(id) })).filter((a: { fileId: number }) => Number.isFinite(a.fileId))
        : undefined,
    };
  }

  /**
   * Compose a communication.
   *
   * `send=false` keeps it a draft. A formal memo marked for approval goes to
   * `pending_approval` and cannot be dispatched until somebody with the
   * approve right releases it — the one place in the hub where a second pair of
   * eyes is mandatory rather than advisory.
   */
  router.post('/', (req, res, next) => {
    const type = String(req.body?.type ?? 'direct_message');
    return requirePermission(featureFor(type), 'create')(req, res, next);
  }, (req, res) => {
    const invalid = validateBody(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { audiences, error } = readAudiences(req.body);
    if (error) return res.status(400).json({ error });
    if (audiences.length === 0) return res.status(400).json({ error: 'Choose at least one recipient or audience.' });

    const input = inputFrom(req.body, audiences);
    const created = createCommunication(req, input, {
      status: input.requiresApproval ? 'pending_approval' : 'draft',
    });
    if (created.recipientCount === 0) {
      return res.status(400).json({ error: 'That audience currently reaches nobody. Check the selection and try again.', id: created.id });
    }

    const shouldSend = req.body.send !== false && !input.requiresApproval;
    if (shouldSend) {
      const sent = sendCommunication(req, created.id, { channel: input.channel });
      return res.status(201).json({ ...created, ...sent, status: 'sent' });
    }
    res.status(201).json({ ...created, status: input.requiresApproval ? 'pending_approval' : 'draft' });
  });

  /** Amend a draft. Once sent, a communication is a record and does not change. */
  router.put('/:id', (req, res, next) => {
    const db = getDb();
    const row = db.prepare('SELECT communication_type FROM communications WHERE id = ?').get(req.params.id) as { communication_type: string } | undefined;
    return requirePermission(featureFor(row?.communication_type ?? 'direct_message'), 'edit')(req, res, next);
  }, (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Communication not found' });
    if (!['draft', 'pending_approval', 'rejected'].includes(old.status)) {
      return res.status(400).json({ error: 'A communication that has been sent is part of the record and cannot be edited. Send a follow-up instead.' });
    }
    const b = req.body ?? {};
    db.prepare(`UPDATE communications SET subject = ?, body = ?, body_format = ?, priority = ?, confidentiality = ?,
        channel = ?, requires_acknowledgement = ?, acknowledgement_due = ?,
        memo_to_text = ?, memo_from_text = ?, memo_date = ?, memo_reference = ?,
        signatory_staff_id = ?, signatory_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`)
      .run(b.subject ?? old.subject, b.body ?? old.body, b.bodyFormat ?? old.body_format,
        b.priority ?? old.priority, b.confidentiality ?? old.confidentiality, b.channel ?? old.channel,
        b.requiresAcknowledgement === undefined ? old.requires_acknowledgement : (b.requiresAcknowledgement ? 1 : 0),
        b.acknowledgementDue ?? old.acknowledgement_due,
        b.memoToText ?? old.memo_to_text, b.memoFromText ?? old.memo_from_text,
        b.memoDate ?? old.memo_date, b.memoReference ?? old.memo_reference,
        parseIntNullable(b.signatoryStaffId) ?? old.signatory_staff_id, b.signatoryName ?? old.signatory_name,
        req.params.id);

    if (Array.isArray(b.audiences)) {
      const { audiences, error } = readAudiences(b);
      if (error) return res.status(400).json({ error });
      db.prepare("DELETE FROM communication_recipients WHERE communication_id = ? AND delivery_status = 'pending'").run(req.params.id);
      const resolved = resolveAudiences(db, audiences);
      const insert = db.prepare(`INSERT INTO communication_recipients
        (communication_id, audience_kind, audience_ref, audience_label, user_id, staff_id, stakeholder_id, external_address, delivery_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
      for (const r of resolved) insert.run(req.params.id, r.audienceKind, r.audienceRef, r.audienceLabel, r.userId, r.staffId, r.stakeholderId, r.externalAddress);
    }

    logCommunicationEvent(db, { communicationId: Number(req.params.id), eventType: 'edited', actorUserId: req.user!.id });
    audit(req, { action: 'update', entity: 'communications', entityId: req.params.id, oldValue: old, newValue: b });
    res.json({ ok: true });
  });

  router.post('/:id/submit-approval', requirePermission(COMM_MEMOS, 'create'), (req, res) => {
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (comm.status !== 'draft' && comm.status !== 'rejected') return res.status(400).json({ error: 'Only a draft can be submitted for approval.' });
    db.prepare("UPDATE communications SET status = 'pending_approval', requires_approval = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    logCommunicationEvent(db, { communicationId: comm.id, eventType: 'submitted_for_approval', actorUserId: req.user!.id, note: req.body?.notes ?? null });
    audit(req, { action: 'submit_approval', entity: 'communications', entityId: comm.id });
    res.json({ ok: true, status: 'pending_approval' });
  });

  /** Approve and, unless asked not to, dispatch in the same movement. */
  router.post('/:id/approve', requirePermission(COMM_MEMOS, 'approve'), (req, res) => {
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (comm.status !== 'pending_approval') return res.status(400).json({ error: 'Only a communication awaiting approval can be approved.' });
    db.prepare("UPDATE communications SET status = 'approved', approved_by_user_id = ?, approved_at = ?, approval_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(req.user!.id, new Date().toISOString(), req.body?.notes ?? null, req.params.id);
    logCommunicationEvent(db, { communicationId: comm.id, eventType: 'approved', actorUserId: req.user!.id, note: req.body?.notes ?? null });
    audit(req, { action: 'approve', entity: 'communications', entityId: comm.id });
    if (req.body?.send === false) return res.json({ ok: true, status: 'approved' });
    const sent = sendCommunication(req, comm.id, { channel: comm.channel });
    res.json({ ok: true, status: 'sent', ...sent });
  });

  router.post('/:id/reject', requirePermission(COMM_MEMOS, 'approve'), (req, res) => {
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (comm.status !== 'pending_approval') return res.status(400).json({ error: 'Only a communication awaiting approval can be returned.' });
    const notes = String(req.body?.notes ?? '').trim();
    if (!notes) return res.status(400).json({ error: 'Say why it is being returned, so the author knows what to change.' });
    db.prepare("UPDATE communications SET status = 'rejected', approval_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(notes, req.params.id);
    logCommunicationEvent(db, { communicationId: comm.id, eventType: 'rejected', actorUserId: req.user!.id, note: notes });
    audit(req, { action: 'reject', entity: 'communications', entityId: comm.id, newValue: { notes } });
    res.json({ ok: true, status: 'rejected' });
  });

  router.post('/:id/send', (req, res, next) => {
    const db = getDb();
    const row = db.prepare('SELECT communication_type FROM communications WHERE id = ?').get(req.params.id) as { communication_type: string } | undefined;
    return requirePermission(featureFor(row?.communication_type ?? 'direct_message'), 'create')(req, res, next);
  }, (req, res) => {
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (comm.status === 'pending_approval') return res.status(400).json({ error: 'This communication is awaiting approval and cannot be dispatched yet.' });
    if (comm.status === 'void') return res.status(400).json({ error: 'A void communication cannot be dispatched.' });
    const channel = req.body?.channel ?? comm.channel;
    if (channel && !COMMUNICATION_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of: ${COMMUNICATION_CHANNELS.join(', ')}` });
    const sent = sendCommunication(req, comm.id, { channel });
    res.json({ ok: true, ...sent });
  });

  /**
   * Reply, keeping the conversation together.
   *
   * The reply is addressed back to the original sender plus everybody else who
   * received it, minus the person replying — the behaviour anyone who has used
   * email expects, and the reason a thread stays legible instead of forking
   * into a dozen private half-conversations.
   */
  router.post('/:id/reply', requirePermission(COMM_MESSAGES, 'create'), (req, res) => {
    const db = getDb();
    const parent = loadCommunication(db, Number(req.params.id));
    if (!parent) return res.status(404).json({ error: 'Communication not found' });
    const access = readAccess(req, parent.id);
    if (!access.allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'A reply needs a message.' });

    const audiences: AudienceSelection[] = [];
    if (parent.sender_user_id && parent.sender_user_id !== req.user!.id) {
      audiences.push({ kind: 'user', ref: parent.sender_user_id, label: parent.sender_name ?? null });
    }
    if (req.body?.replyAll !== false) {
      for (const r of parent.recipients as any[]) {
        if (r.user_id && r.user_id === req.user!.id) continue;
        if (r.user_id) audiences.push({ kind: 'user', ref: r.user_id, label: r.staff_name ?? r.user_name ?? null });
        else if (r.staff_id) audiences.push({ kind: 'staff', ref: r.staff_id, label: r.staff_name ?? null });
        else if (r.stakeholder_id) audiences.push({ kind: 'stakeholder', ref: r.stakeholder_id, label: r.audience_label });
      }
    }
    // An inbound message from outside carries its sender's address, not an
    // account — replying to it is an external dispatch and is recorded as one.
    if (parent.sender_external_address) {
      audiences.push({ kind: 'external', ref: parent.sender_external_address, label: parent.sender_external_name ?? parent.sender_external_address });
    }
    if (audiences.length === 0) return res.status(400).json({ error: 'There is nobody to reply to on this communication.' });

    const created = createCommunication(req, {
      type: 'direct_message',
      subject: parent.subject.startsWith('Re:') ? parent.subject : `Re: ${parent.subject}`,
      body,
      bodyFormat: 'text',
      direction: 'internal',
      channel: 'in_app',
      priority: req.body?.priority ?? parent.priority,
      confidentiality: parent.confidentiality,
      audiences,
      threadId: parent.thread_id,
      parentCommunicationId: parent.id,
      sourceModule: parent.source_module,
      sourceRecordType: parent.source_record_type,
      sourceRecordId: parent.source_record_id,
    }, { status: 'draft' });

    const sent = sendCommunication(req, created.id, { channel: 'in_app' });
    // The message being answered is marked replied, so the sender's own view
    // shows that it was dealt with rather than merely opened.
    if (access.recipient) markRecipientState(req, parent.id, access.recipient.id, 'replied', `Replied with ${created.communicationNumber}`);
    logCommunicationEvent(db, { communicationId: parent.id, eventType: 'replied', actorUserId: req.user!.id, note: created.communicationNumber });
    res.status(201).json({ ...created, ...sent });
  });

  /** Forward a communication to another audience, quoting it in full. */
  router.post('/:id/forward', requirePermission(COMM_MESSAGES, 'create'), (req, res) => {
    const db = getDb();
    const original = loadCommunication(db, Number(req.params.id));
    if (!original) return res.status(404).json({ error: 'Communication not found' });
    const access = readAccess(req, original.id);
    if (!access.allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    if (confidentialityIsSensitive(original.confidentiality) && !may(req, COMM_MEMOS, 'export')) {
      return res.status(403).json({ error: `This communication is marked ${original.confidentiality}. Forwarding it needs the external-sharing right.` });
    }
    const { audiences, error } = readAudiences(req.body);
    if (error) return res.status(400).json({ error });
    if (audiences.length === 0) return res.status(400).json({ error: 'Choose at least one recipient or audience to forward to.' });

    const note = String(req.body?.note ?? '').trim();
    const quoted = [
      note,
      note ? '' : null,
      '----- Forwarded communication -----',
      `From: ${original.sender_name ?? '—'}`,
      `Date: ${String(original.sent_at || original.created_at).slice(0, 16).replace('T', ' ')}`,
      `Reference: ${original.communication_number}`,
      `Subject: ${original.subject}`,
      '',
      String(original.body ?? ''),
    ].filter(line => line !== null).join('\n');

    const created = createCommunication(req, {
      type: 'direct_message',
      subject: original.subject.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`,
      body: quoted,
      bodyFormat: 'text',
      direction: 'internal',
      channel: 'in_app',
      priority: original.priority,
      confidentiality: original.confidentiality,
      audiences,
      parentCommunicationId: original.id,
      sourceModule: original.source_module,
      sourceRecordType: original.source_record_type,
      sourceRecordId: original.source_record_id,
    }, { status: 'draft' });
    const sent = sendCommunication(req, created.id, { channel: 'in_app' });
    logCommunicationEvent(db, { communicationId: original.id, eventType: 'forwarded', actorUserId: req.user!.id, note: `Forwarded as ${created.communicationNumber}` });
    audit(req, { action: 'forward', entity: 'communications', entityId: original.id, newValue: { forwardedAs: created.communicationNumber } });
    res.status(201).json({ ...created, ...sent });
  });

  /**
   * Record a communication that arrived from outside SECH_LIMS.
   *
   * Where an integration exists it calls this; where one does not, a member of
   * staff records what was received by hand. Either way the inbound message
   * joins the thread it answers, so a conversation that left by WhatsApp and
   * came back by telephone is still one conversation in the register.
   */
  router.post('/inbound', requirePermission(COMM_MESSAGES, 'create'), (req, res) => {
    const b = req.body ?? {};
    if (!String(b.subject ?? '').trim()) return res.status(400).json({ error: 'A subject is required.' });
    if (!String(b.body ?? '').trim()) return res.status(400).json({ error: 'The message received is required.' });
    if (!String(b.senderExternalName ?? '').trim()) return res.status(400).json({ error: 'Name who the communication was received from.' });
    const channel = b.channel ?? 'other';
    if (!COMMUNICATION_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of: ${COMMUNICATION_CHANNELS.join(', ')}` });

    const { audiences, error } = readAudiences(b);
    if (error) return res.status(400).json({ error });
    // An inbound message is addressed to whoever must act on it; with nobody
    // named it belongs to the person recording it.
    const recipients = audiences.length ? audiences : [{ kind: 'user', ref: req.user!.id } as AudienceSelection];

    const created = createCommunication(req, {
      type: 'external_message',
      subject: String(b.subject).trim(),
      body: String(b.body),
      bodyFormat: 'text',
      direction: 'inbound',
      channel,
      priority: b.priority ?? 'normal',
      confidentiality: b.confidentiality ?? 'internal',
      audiences: recipients,
      threadId: parseIntNullable(b.threadId),
      parentCommunicationId: parseIntNullable(b.parentCommunicationId),
      senderExternalName: String(b.senderExternalName).trim(),
      senderExternalAddress: b.senderExternalAddress || null,
      sourceModule: b.sourceModule || null,
      sourceRecordType: b.sourceRecordType || null,
      sourceRecordId: b.sourceRecordId ?? null,
    }, { status: 'draft' });

    const sent = sendCommunication(req, created.id, { channel: 'in_app' });
    const db = getDb();
    db.prepare("UPDATE communications SET status = 'received', direction = 'inbound', channel = ? WHERE id = ?").run(channel, created.id);
    recordDispatch(req, {
      communicationId: created.id, channel, dispatchMethod: 'manual',
      recipientLabel: String(b.senderExternalName).trim(),
      externalReference: b.externalReference || null,
      notes: `Inbound communication received on the ${channel} channel and recorded in SECH_LIMS.`,
    });
    logCommunicationEvent(db, { communicationId: created.id, eventType: 'received', actorUserId: req.user!.id, note: `Received from ${String(b.senderExternalName).trim()} by ${channel}` });
    res.status(201).json({ ...created, ...sent, status: 'received' });
  });

  /* ====================================================================== *
   * What a recipient does with a message
   * ====================================================================== */

  for (const action of ['read', 'acknowledge', 'dismiss'] as const) {
    router.post(`/:id/${action}`, requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
      const id = Number(req.params.id);
      const db = getDb();
      const recipient = recipientRowFor(db, id, req.user!.id);
      if (!recipient) return res.status(403).json({ error: 'This communication is not addressed to you.' });
      const state = action === 'acknowledge' ? 'acknowledged' : action === 'dismiss' ? 'dismissed' : 'read';
      markRecipientState(req, id, recipient.id, state, req.body?.notes ?? null);
      res.json({ ok: true, state });
    });
  }

  /* ====================================================================== *
   * Attachments
   * ====================================================================== */

  router.post('/:id/attachments', requirePermission(COMM_MESSAGES, 'create'), upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (comm.created_by !== req.user!.id && !may(req, COMM_MEMOS, 'edit')) {
      return res.status(403).json({ error: 'Only the author may attach to this communication.' });
    }
    const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    const fileId = Number(file.lastInsertRowid);
    const r = db.prepare('INSERT INTO communication_attachments (communication_id, file_id, caption, created_by) VALUES (?, ?, ?, ?)')
      .run(req.params.id, fileId, req.body?.caption ?? null, req.user!.id);
    logCommunicationEvent(db, { communicationId: comm.id, eventType: 'edited', actorUserId: req.user!.id, note: `Attached ${req.file.originalname}` });
    audit(req, { action: 'create', entity: 'communication_attachments', entityId: r.lastInsertRowid, newValue: { communicationId: comm.id, fileId } });
    res.status(201).json({ id: Number(r.lastInsertRowid), fileId, originalName: req.file.originalname, downloadPath: `/files/${fileId}/download` });
  });

  /**
   * An attachment's bytes.
   *
   * Served from here rather than through the general /files endpoint because
   * that one asks for the Documents right: a technician who may read their own
   * messages must be able to open what was attached to them without also being
   * granted the controlled-document library.
   */
  router.get('/:id/attachments/:attachmentId/raw', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!readAccess(req, id).allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    const row = db.prepare(`SELECT f.* FROM communication_attachments a JOIN files f ON f.id = a.file_id
      WHERE a.id = ? AND a.communication_id = ?`).get(req.params.attachmentId, id) as
      { stored_name: string; original_name: string; mime_type: string | null; storage_area: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    const root = row.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const fp = path.join(root, row.stored_name);
    if (path.dirname(path.resolve(fp)) !== path.resolve(root) || !fs.existsSync(fp)) return res.status(404).json({ error: 'Attachment not found' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.original_name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(fp).pipe(res);
  });

  /* ====================================================================== *
   * Preparing a copy for somewhere else
   * ====================================================================== */

  /** The memo as plain text, for copying or for a text-only channel. */
  router.get('/:id/render.txt', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const comm = loadCommunication(db, Number(req.params.id));
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (!readAccess(req, comm.id).allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    res.json({ text: renderPlainText(comm) });
  });

  /** The memo as an HTML fragment, for the on-screen preview and image capture. */
  router.get('/:id/render.html', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const comm = loadCommunication(db, Number(req.params.id));
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (!readAccess(req, comm.id).allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    const header = labHeader(db);
    res.json({ html: renderBody(db, comm), facility: header.org, logo: header.logo });
  });

  /**
   * The printable sheet — and therefore the PDF, since every browser prints to
   * one. Recorded as a dispatch so the log knows a paper copy exists.
   */
  router.get('/:id/print', requirePermission(COMM_MEMOS, 'print'), (req, res) => {
    const db = getDb();
    const comm = loadCommunication(db, Number(req.params.id));
    if (!comm) return res.status(404).send('Communication not found');
    if (!readAccess(req, comm.id).allowed) return res.status(403).send('This communication is not addressed to you.');
    const header = labHeader(db);
    const footer = confidentialityIsSensitive(comm.confidentiality)
      ? `${String(comm.confidentiality).toUpperCase()} — ${comm.communication_number}. Controlled distribution.`
      : `${comm.communication_number} — issued through the SECH_LIMS Communication Service.`;
    recordDispatch(req, {
      communicationId: comm.id, channel: 'print', dispatchMethod: 'prepared', shareFormat: 'pdf',
      recipientLabel: recipientSummary(comm.recipients ?? []),
      notes: 'Printable sheet opened (print or save as PDF). No delivery confirmation is claimed.',
    });
    logCommunicationEvent(db, { communicationId: comm.id, eventType: 'printed', actorUserId: req.user!.id });
    audit(req, { action: 'print', entity: 'communications', entityId: comm.id });
    res.send(printShell(`${comm.communication_number} — ${comm.subject}`, renderBody(db, comm), header, footer, req.query.autoprint !== '0'));
  });

  /** A real Word file, built from the same rendered memo. */
  router.get('/:id/export/docx', requirePermission(COMM_MEMOS, 'export'), async (req, res) => {
    const db = getDb();
    const comm = loadCommunication(db, Number(req.params.id));
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (!readAccess(req, comm.id).allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    const title = `${comm.communication_number} - ${comm.subject}`;
    const originalName = `${title}.docx`.replace(/[\\/:*?"<>|]/g, '_');
    const storedName = safeStoredFilename(originalName);
    const fullPath = path.join(uploadRoot, storedName);
    try {
      await buildDocxFromHtml(fullPath, renderBody(db, comm), title);
      const stat = fs.statSync(fullPath);
      const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(originalName, storedName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', stat.size, 'uploads', req.user!.id);
      const fileId = Number(file.lastInsertRowid);
      recordDispatch(req, {
        communicationId: comm.id, channel: 'other', dispatchMethod: 'prepared', shareFormat: 'docx',
        fileId, recipientLabel: recipientSummary(comm.recipients ?? []),
        notes: 'Word document prepared for sharing. No delivery confirmation is claimed.',
      });
      logCommunicationEvent(db, { communicationId: comm.id, eventType: 'exported', actorUserId: req.user!.id, note: 'Word document' });
      audit(req, { action: 'export_docx', entity: 'communications', entityId: comm.id, newValue: { fileId } });
      res.status(201).json({ fileId, originalName, downloadPath: `/communications/${comm.id}/exports/${fileId}/raw` });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? `Could not build the Word file: ${err.message}` : 'Could not build the Word file.' });
    }
  });

  /**
   * The bytes of a file this communication's own export produced.
   *
   * Served from here, like the attachments above, so preparing a memo for
   * sharing does not also require the controlled-document library right. Only
   * a file recorded against one of this communication's dispatches is served,
   * so the route cannot be used to read the file store generally.
   */
  router.get('/:id/exports/:fileId/raw', requirePermission(COMM_MEMOS, 'export'), (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!readAccess(req, id).allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    const row = db.prepare(`SELECT f.* FROM communication_dispatches d JOIN files f ON f.id = d.file_id
      WHERE d.communication_id = ? AND d.file_id = ?`).get(id, req.params.fileId) as
      { stored_name: string; original_name: string; mime_type: string | null; storage_area: string } | undefined;
    if (!row) return res.status(404).json({ error: 'That prepared copy is not on this communication.' });
    const root = row.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
    const fp = path.join(root, row.stored_name);
    if (path.dirname(path.resolve(fp)) !== path.resolve(root) || !fs.existsSync(fp)) return res.status(404).json({ error: 'That prepared copy is no longer on disk.' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.original_name)}"`);
    fs.createReadStream(fp).pipe(res);
  });

  /**
   * Record that this communication was shared through an external channel.
   *
   * SECH_LIMS has no API into WhatsApp, Telegram, SMS or the hospital's mail
   * server, and this endpoint does not pretend otherwise: it records that a
   * copy was prepared and carried, by whom, in what format and to whom. A
   * restricted or confidential communication needs the release confirmed and a
   * reason recorded, which the service enforces.
   */
  router.post('/:id/share', requirePermission(COMM_MEMOS, 'export'), (req, res) => {
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    if (!readAccess(req, comm.id).allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    const channel = String(req.body?.channel ?? '');
    if (!COMMUNICATION_CHANNELS.includes(channel as never)) return res.status(400).json({ error: `channel must be one of: ${COMMUNICATION_CHANNELS.join(', ')}` });
    const format = req.body?.shareFormat ? String(req.body.shareFormat) : null;
    if (format && !SHARE_FORMATS.includes(format as never)) return res.status(400).json({ error: `shareFormat must be one of: ${SHARE_FORMATS.join(', ')}` });
    const method = String(req.body?.dispatchMethod ?? 'prepared');
    if (!DISPATCH_METHODS.includes(method as never)) return res.status(400).json({ error: `dispatchMethod must be one of: ${DISPATCH_METHODS.join(', ')}` });
    if (method === 'system' && !channelIsIntegrated(channel)) {
      return res.status(400).json({ error: `SECH_LIMS has no direct integration with ${channel}, so a system delivery cannot be recorded for it. Record it as prepared or manual.` });
    }

    try {
      const { dispatchId } = recordExternalShare(req, {
        communicationId: comm.id,
        channel,
        dispatchMethod: method,
        shareFormat: format,
        recipientLabel: req.body?.recipientLabel ?? null,
        externalReference: req.body?.externalReference ?? null,
        fileId: parseIntNullable(req.body?.fileId),
        notes: req.body?.notes ?? null,
        sensitiveReleaseConfirmed: Boolean(req.body?.sensitiveReleaseConfirmed),
        sensitiveReleaseJustification: req.body?.sensitiveReleaseJustification ?? null,
      });
      res.status(201).json({
        ok: true, dispatchId,
        deliveryClaimed: false,
        message: `Recorded: a ${format ? `${format.toUpperCase()} ` : ''}copy was prepared in SECH_LIMS and shared through ${channel}. No delivery or read confirmation is claimed for that channel.`,
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      res.status(code === 'SENSITIVE_RELEASE_REQUIRED' ? 400 : 500)
        .json({ error: err instanceof Error ? err.message : 'Could not record the share.', code });
    }
  });

  /* ====================================================================== *
   * The Communication Log
   * ====================================================================== */

  /**
   * The register — every communication, whoever sent it.
   *
   * This is the audit view and it is gated on the register right rather than on
   * the hub, because it reaches other people's correspondence. Filters cover
   * what an assessor actually asks for: a period, a direction, a channel, a
   * type, a sender, or a free-text search of subject and body.
   */
  router.get('/log', requirePermission(COMM_LOG, 'view'), (req, res) => {
    const db = getDb();
    const filters: string[] = ["c.status <> 'void'"];
    const params: unknown[] = [];
    const q = req.query;
    if (q.includeVoid === 'true') filters.shift();
    if (q.type) { filters.push('c.communication_type = ?'); params.push(String(q.type)); }
    if (q.direction) { filters.push('c.direction = ?'); params.push(String(q.direction)); }
    if (q.channel) { filters.push('c.channel = ?'); params.push(String(q.channel)); }
    if (q.status) { filters.push('c.status = ?'); params.push(String(q.status)); }
    if (q.confidentiality) { filters.push('c.confidentiality = ?'); params.push(String(q.confidentiality)); }
    if (q.senderUserId) { filters.push('c.sender_user_id = ?'); params.push(Number(q.senderUserId)); }
    if (q.sourceModule) { filters.push('c.source_module = ?'); params.push(String(q.sourceModule)); }
    if (q.threadId) { filters.push('c.thread_id = ?'); params.push(Number(q.threadId)); }
    if (q.from) { filters.push('COALESCE(c.sent_at, c.created_at) >= ?'); params.push(String(q.from)); }
    if (q.to) { filters.push('COALESCE(c.sent_at, c.created_at) <= ?'); params.push(`${String(q.to)}T23:59:59`); }
    if (q.search) {
      filters.push('(c.subject LIKE ? OR c.body LIKE ? OR c.communication_number LIKE ?)');
      const like = `%${String(q.search)}%`;
      params.push(like, like, like);
    }
    if (q.requiresAcknowledgement === 'true') filters.push('c.requires_acknowledgement = 1');
    if (q.externalOnly === 'true') filters.push("EXISTS (SELECT 1 FROM communication_dispatches d WHERE d.communication_id = c.id AND d.dispatch_method <> 'system')");

    const limit = Math.min(1000, Number(q.limit ?? 300));
    const rows = db.prepare(`SELECT c.*, t.thread_number,
        COALESCE(ss.full_name, su.full_name, c.sender_external_name) AS sender_name,
        au.full_name AS approved_by_name,
        (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id) AS recipient_count,
        (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id AND r.read_at IS NOT NULL) AS read_count,
        (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id AND r.acknowledged_at IS NOT NULL) AS acknowledged_count,
        (SELECT COUNT(*) FROM communication_attachments a WHERE a.communication_id = c.id) AS attachment_count,
        (SELECT COUNT(*) FROM communications ch WHERE ch.parent_communication_id = c.id) AS reply_count,
        (SELECT GROUP_CONCAT(DISTINCT r.audience_label) FROM communication_recipients r WHERE r.communication_id = c.id) AS recipients_summary,
        (SELECT GROUP_CONCAT(DISTINCT d.channel || ' (' || d.dispatch_method || ')') FROM communication_dispatches d WHERE d.communication_id = c.id) AS dispatch_summary,
        (SELECT MAX(e.created_at) FROM communication_events e WHERE e.communication_id = c.id) AS last_event_at
      FROM communications c
      JOIN communication_threads t ON t.id = c.thread_id
      LEFT JOIN users su ON su.id = c.sender_user_id
      LEFT JOIN staff ss ON ss.id = c.sender_staff_id
      LEFT JOIN users au ON au.id = c.approved_by_user_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC, c.id DESC
      LIMIT ?`).all(...params, limit);
    res.json(rows);
  });

  /** The register as a spreadsheet, for an assessor or a management review. */
  router.get('/log/export', requirePermission(COMM_LOG, 'export'), (req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT c.communication_number, t.thread_number, c.communication_type, c.direction, c.channel,
        c.subject, COALESCE(ss.full_name, su.full_name, c.sender_external_name) AS sender_name,
        (SELECT GROUP_CONCAT(DISTINCT r.audience_label) FROM communication_recipients r WHERE r.communication_id = c.id) AS recipients,
        COALESCE(c.sent_at, c.created_at) AS dated, c.priority, c.confidentiality, c.status,
        c.requires_acknowledgement, c.acknowledgement_due,
        (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id) AS recipient_count,
        (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id AND r.read_at IS NOT NULL) AS read_count,
        (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id AND r.acknowledged_at IS NOT NULL) AS acknowledged_count,
        (SELECT GROUP_CONCAT(DISTINCT d.channel || ' / ' || d.dispatch_method) FROM communication_dispatches d WHERE d.communication_id = c.id) AS dispatches,
        (SELECT COUNT(*) FROM communication_attachments a WHERE a.communication_id = c.id) AS attachments,
        c.source_module, c.source_record_type, c.source_record_id,
        au.full_name AS approved_by, c.approved_at, c.body
      FROM communications c
      JOIN communication_threads t ON t.id = c.thread_id
      LEFT JOIN users su ON su.id = c.sender_user_id
      LEFT JOIN staff ss ON ss.id = c.sender_staff_id
      LEFT JOIN users au ON au.id = c.approved_by_user_id
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC`).all() as any[];

    const headers = ['Communication no.', 'Thread', 'Type', 'Direction', 'Channel', 'Subject', 'Sender', 'Recipients / audience',
      'Date & time', 'Priority', 'Confidentiality', 'Status', 'Ack required', 'Ack due', 'Recipients', 'Read', 'Acknowledged',
      'Dispatches (channel / method)', 'Attachments', 'Source module', 'Source record type', 'Source record', 'Approved by', 'Approved at', 'Content'] as const;
    const data = rows.map(r => [
      r.communication_number, r.thread_number, COMMUNICATION_TYPE_LABELS[r.communication_type as CommunicationType] ?? r.communication_type,
      r.direction, r.channel, r.subject, r.sender_name ?? '', r.recipients ?? '',
      String(r.dated ?? '').slice(0, 19).replace('T', ' '), r.priority, r.confidentiality, r.status,
      r.requires_acknowledgement ? 'Yes' : 'No', r.acknowledgement_due ?? '',
      r.recipient_count, r.read_count, r.acknowledged_count, r.dispatches ?? '', r.attachments,
      r.source_module ?? '', r.source_record_type ?? '', r.source_record_id ?? '',
      r.approved_by ?? '', r.approved_at ?? '', String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 1000),
    ]);
    audit(req, { action: 'export', entity: 'communications', newValue: { rows: data.length } });
    sendWorkbook(res, buildWorkbook(headers, data, 'Communication Log'), `communication-log-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  /* ====================================================================== *
   * Audiences and templates
   * ====================================================================== */

  router.get('/audiences', requirePermission(COMM_ADMIN, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM communication_audiences ORDER BY audience_name').all() as any[];
    res.json(rows.map(r => ({ ...r, member_count: audienceSize(db, { kind: 'audience_group', ref: r.audience_code }) })));
  });

  router.post('/audiences', requirePermission(COMM_ADMIN, 'create'), (req, res) => {
    const b = req.body ?? {};
    if (!String(b.audienceName ?? '').trim()) return res.status(400).json({ error: 'audienceName is required' });
    const source = String(b.source ?? 'staff_list');
    if (!AUDIENCE_GROUP_SOURCES.includes(source as never)) return res.status(400).json({ error: `source must be one of: ${AUDIENCE_GROUP_SOURCES.join(', ')}` });
    const db = getDb();
    const code = String(b.audienceCode ?? '').trim()
      || `AUD-${String(b.audienceName).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20)}`;
    if (db.prepare('SELECT 1 FROM communication_audiences WHERE audience_code = ?').get(code)) {
      return res.status(400).json({ error: `An audience with the code ${code} already exists.` });
    }
    const r = db.prepare(`INSERT INTO communication_audiences
      (audience_code, audience_name, description, source, rule_json, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(code, String(b.audienceName).trim(), b.description ?? null, source,
        b.rule ? JSON.stringify(b.rule) : null, b.isActive === false ? 0 : 1, req.user!.id);
    audit(req, { action: 'create', entity: 'communication_audiences', entityId: r.lastInsertRowid, newValue: { code, ...b } });
    res.status(201).json({ id: Number(r.lastInsertRowid), audienceCode: code });
  });

  router.put('/audiences/:id', requirePermission(COMM_ADMIN, 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM communication_audiences WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Audience not found' });
    const b = req.body ?? {};
    if (b.source && !AUDIENCE_GROUP_SOURCES.includes(b.source)) return res.status(400).json({ error: `source must be one of: ${AUDIENCE_GROUP_SOURCES.join(', ')}` });
    db.prepare(`UPDATE communication_audiences SET audience_name = ?, description = ?, source = ?, rule_json = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(b.audienceName ?? old.audience_name, b.description ?? old.description, b.source ?? old.source,
        b.rule === undefined ? old.rule_json : (b.rule ? JSON.stringify(b.rule) : null),
        b.isActive === undefined ? old.is_active : (b.isActive ? 1 : 0), req.params.id);
    audit(req, { action: 'update', entity: 'communication_audiences', entityId: req.params.id, oldValue: old, newValue: b });
    res.json({ ok: true });
  });

  router.get('/templates', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const db = getDb();
    const where = req.query.includeInactive === 'true' ? '' : 'WHERE is_active = 1';
    res.json(db.prepare(`SELECT * FROM communication_templates ${where} ORDER BY communication_type, template_name`).all());
  });

  router.post('/templates', requirePermission(COMM_ADMIN, 'create'), (req, res) => {
    const b = req.body ?? {};
    if (!String(b.templateName ?? '').trim()) return res.status(400).json({ error: 'templateName is required' });
    if (!String(b.subject ?? '').trim()) return res.status(400).json({ error: 'subject is required' });
    const type = String(b.communicationType ?? 'memo');
    if (!COMMUNICATION_TYPES.includes(type as CommunicationType)) return res.status(400).json({ error: `communicationType must be one of: ${COMMUNICATION_TYPES.join(', ')}` });
    const db = getDb();
    const code = String(b.templateCode ?? '').trim()
      || `TPL-${String(b.templateName).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20)}`;
    if (db.prepare('SELECT 1 FROM communication_templates WHERE template_code = ?').get(code)) {
      return res.status(400).json({ error: `A template with the code ${code} already exists.` });
    }
    const r = db.prepare(`INSERT INTO communication_templates
      (template_code, template_name, communication_type, subject, body, default_audience_kind, default_audience_ref,
       default_channel, requires_approval, requires_acknowledgement, confidentiality, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, String(b.templateName).trim(), type, String(b.subject).trim(), b.body ?? '',
        b.defaultAudienceKind ?? null, b.defaultAudienceRef ?? null, b.defaultChannel ?? 'in_app',
        b.requiresApproval ? 1 : 0, b.requiresAcknowledgement ? 1 : 0, b.confidentiality ?? 'internal',
        b.isActive === false ? 0 : 1, req.user!.id);
    audit(req, { action: 'create', entity: 'communication_templates', entityId: r.lastInsertRowid, newValue: { code, ...b } });
    res.status(201).json({ id: Number(r.lastInsertRowid), templateCode: code });
  });

  router.put('/templates/:id', requirePermission(COMM_ADMIN, 'edit'), (req, res) => {
    const db = getDb();
    const old = db.prepare('SELECT * FROM communication_templates WHERE id = ?').get(req.params.id) as any;
    if (!old) return res.status(404).json({ error: 'Template not found' });
    const b = req.body ?? {};
    if (b.communicationType && !COMMUNICATION_TYPES.includes(b.communicationType)) return res.status(400).json({ error: `communicationType must be one of: ${COMMUNICATION_TYPES.join(', ')}` });
    db.prepare(`UPDATE communication_templates SET template_name = ?, communication_type = ?, subject = ?, body = ?,
        default_audience_kind = ?, default_audience_ref = ?, default_channel = ?, requires_approval = ?,
        requires_acknowledgement = ?, confidentiality = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(b.templateName ?? old.template_name, b.communicationType ?? old.communication_type,
        b.subject ?? old.subject, b.body ?? old.body,
        b.defaultAudienceKind ?? old.default_audience_kind, b.defaultAudienceRef ?? old.default_audience_ref,
        b.defaultChannel ?? old.default_channel,
        b.requiresApproval === undefined ? old.requires_approval : (b.requiresApproval ? 1 : 0),
        b.requiresAcknowledgement === undefined ? old.requires_acknowledgement : (b.requiresAcknowledgement ? 1 : 0),
        b.confidentiality ?? old.confidentiality,
        b.isActive === undefined ? old.is_active : (b.isActive ? 1 : 0), req.params.id);
    audit(req, { action: 'update', entity: 'communication_templates', entityId: req.params.id, oldValue: old, newValue: b });
    res.json({ ok: true });
  });

  /* ====================================================================== *
   * One communication, and withdrawing one
   * ====================================================================== */

  /** Withdraw a communication. The record stays; the message stops counting. */
  router.post('/:id/void', requirePermission(COMM_MEMOS, 'void_archive'), (req, res) => {
    const db = getDb();
    const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(req.params.id) as any;
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Record why this communication is being withdrawn.' });
    db.prepare("UPDATE communications SET status = 'void', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    db.prepare(`UPDATE notifications SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT notification_id FROM communication_recipients WHERE communication_id = ? AND notification_id IS NOT NULL)`)
      .run(req.params.id);
    logCommunicationEvent(db, { communicationId: comm.id, eventType: 'voided', actorUserId: req.user!.id, note: reason });
    audit(req, { action: 'void', entity: 'communications', entityId: comm.id, oldValue: { status: comm.status }, newValue: { status: 'void', reason } });
    res.json({ ok: true, status: 'void' });
  });

  /**
   * One communication in full. Mounted last so it cannot shadow the named
   * routes above (/log, /inbound, /audiences, /templates, /summary).
   */
  router.get('/:id', requirePermission(COMM_MESSAGES, 'view'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Not a communication id.' });
    const db = getDb();
    const comm = loadCommunication(db, id);
    if (!comm) return res.status(404).json({ error: 'Communication not found' });
    const access = readAccess(req, id);
    if (!access.allowed) return res.status(403).json({ error: 'This communication is not addressed to you.' });
    comm.my_recipient_id = access.recipient?.id ?? null;
    comm.my_delivery_status = access.recipient?.delivery_status ?? null;
    comm.my_read_at = access.recipient?.read_at ?? null;
    res.json(comm);
  });

  return router;
}

/** Re-exported so a module wiring itself to the hub imports from one place. */
export { recordModuleCommunication } from '../services/communicationService.js';
export { audienceLabel };
