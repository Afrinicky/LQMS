/**
 * THE CENTRAL COMMUNICATION SERVICE.
 *
 * One door for everything SECH_LIMS says and everything it is told.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Communication used to happen in whichever module needed it. Scheduling
 * printed a reassignment memo. Process Management recorded that a critical
 * value had been telephoned. Documents raised an attestation alert. The alert
 * scan routed notifications. Each of those is a communication, each kept its
 * own evidence in its own shape, and no screen in the system could answer the
 * question an assessor actually asks: *what has this laboratory communicated,
 * to whom, by what means, and did they receive it?*
 *
 * Every one of those paths now ends here. A communication is a numbered record
 * in a thread, addressed to an audience, dispatched through named channels and
 * logged event by event. A module that wants to send a memo calls
 * `recordModuleCommunication()` and gets a communication number back; it does
 * not write its own inbox, its own log or its own notion of "sent".
 *
 * ── Three rules this module will not bend ────────────────────────────────────
 *
 *  1. **Delivery is never claimed, only recorded.** SECH_LIMS delivers on one
 *     channel — its own. A memo exported to PDF and carried to WhatsApp by a
 *     supervisor is recorded as PREPARED, with the person who prepared it
 *     named, and `delivery_confirmed` is left null. A log that invents a read
 *     receipt is worse than no log, because somebody will rely on it.
 *
 *  2. **An audience is remembered as it was named.** "All laboratory staff" is
 *     resolved to people at the moment of sending, and both are kept: the
 *     label the sender chose and the individual it reached. Membership changes;
 *     what the memo was addressed to does not.
 *
 *  3. **Confidential content does not leave without a reason on the record.**
 *     A restricted or confidential communication cannot be shared through an
 *     external channel without an explicit confirmation and a justification,
 *     both stored on the dispatch.
 *
 * The notification, staff, file, audit and record-link infrastructure is reused
 * rather than duplicated: an in-app delivery raises an ordinary notification so
 * the existing inbox, bell badge and sounds all work unchanged, and the
 * notification's id is kept on the recipient row so the two never drift.
 */
import { getDb } from '../db/database.js';
import { audit } from './auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import {
  COMMUNICATION_NUMBER_PREFIX, THREAD_NUMBER_PREFIX, COMMUNICATION_MODULE_KEY,
  PRIORITY_SEVERITY, channelIsIntegrated, confidentialityIsSensitive, messagePreview,
  type CommunicationType, type CommunicationDirection, type CommunicationPriority,
  type CommunicationConfidentiality, type AudienceKind, type DispatchMethod, type ShareFormat,
} from '../../shared/constants/communications.js';

/* ========================================================================== *
 * Audience resolution
 * ========================================================================== */

/** One audience the sender picked, before it is resolved to people. */
export type AudienceSelection = {
  kind: AudienceKind | string;
  /** The id, code or value the kind needs: a user id, a section id, an email. */
  ref?: string | number | null;
  /** What the sender saw. Resolved from the register when not supplied. */
  label?: string | null;
};

/** One person (or address) an audience resolved to. */
export type ResolvedRecipient = {
  audienceKind: string;
  audienceRef: string | null;
  audienceLabel: string;
  userId: number | null;
  staffId: number | null;
  stakeholderId: number | null;
  externalAddress: string | null;
  /** The person's own name, for the recipient list and the memo sheet. */
  name: string;
  /** False when SECH_LIMS has no in-app route to this recipient. */
  reachableInApp: boolean;
};

type AccountRow = { user_id: number | null; staff_id: number | null; full_name: string };

/** Active accounts, with the staff record behind each where one is linked. */
function activeAccounts(db: any, where = '', params: unknown[] = []): AccountRow[] {
  return db.prepare(`SELECT u.id AS user_id, u.staff_id, COALESCE(s.full_name, u.full_name) AS full_name
    FROM users u LEFT JOIN staff s ON s.id = u.staff_id
    WHERE u.is_active = 1 ${where ? `AND ${where}` : ''}
    ORDER BY full_name`).all(...params) as AccountRow[];
}

function staffWithoutAccount(db: any, where = '', params: unknown[] = []): AccountRow[] {
  return db.prepare(`SELECT NULL AS user_id, s.id AS staff_id, s.full_name
    FROM staff s WHERE s.is_active = 1
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.staff_id = s.id AND u.is_active = 1)
      ${where ? `AND ${where}` : ''}
    ORDER BY s.full_name`).all(...params) as AccountRow[];
}

function recipientFrom(selection: AudienceSelection, label: string, row: AccountRow): ResolvedRecipient {
  return {
    audienceKind: String(selection.kind),
    audienceRef: selection.ref == null ? null : String(selection.ref),
    audienceLabel: label,
    userId: row.user_id ?? null,
    staffId: row.staff_id ?? null,
    stakeholderId: null,
    externalAddress: null,
    name: row.full_name,
    reachableInApp: row.user_id != null,
  };
}

/** The staff ids of everybody who runs a unit today, substantive or acting. */
function unitLeadStaffIds(db: any): number[] {
  const today = new Date().toISOString().slice(0, 10);
  const ids = new Set<number>();
  for (const r of db.prepare('SELECT head_staff_id AS id FROM sections WHERE is_active = 1 AND head_staff_id IS NOT NULL').all() as Array<{ id: number }>) ids.add(r.id);
  for (const r of db.prepare(`SELECT acting_staff_id AS id FROM acting_unit_heads
      WHERE status = 'active' AND start_date <= ? AND end_date >= ? AND acting_staff_id IS NOT NULL`)
    .all(today, today) as Array<{ id: number }>) ids.add(r.id);
  return [...ids];
}

/**
 * The label an audience selection carries in the log.
 *
 * Resolved from the register when the client did not send one, so a stored
 * recipient row always reads as something a person recognises — "Haematology",
 * not "section 4".
 */
export function audienceLabel(db: any, selection: AudienceSelection): string {
  if (selection.label) return String(selection.label);
  const ref = selection.ref == null ? null : String(selection.ref);
  const one = (sql: string, column: string): string | null => {
    if (ref === null) return null;
    const row = db.prepare(sql).get(ref) as Record<string, unknown> | undefined;
    return row ? String(row[column] ?? '') || null : null;
  };
  switch (selection.kind) {
    case 'user': return one('SELECT COALESCE(s.full_name, u.full_name) AS n FROM users u LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = ?', 'n') ?? `User #${ref}`;
    case 'staff': return one('SELECT full_name AS n FROM staff WHERE id = ?', 'n') ?? `Staff #${ref}`;
    case 'department': return one('SELECT name AS n FROM departments WHERE id = ?', 'n') ?? `Department #${ref}`;
    case 'section': return one('SELECT name AS n FROM sections WHERE id = ?', 'n') ?? `Unit #${ref}`;
    case 'position': return one('SELECT title AS n FROM positions WHERE id = ?', 'n') ?? `Position #${ref}`;
    case 'role': return one('SELECT name AS n FROM roles WHERE id = ?', 'n') ?? `Access profile #${ref}`;
    case 'laboratory_staff': return 'All laboratory staff';
    case 'all_users': return 'All SECH_LIMS users';
    case 'stakeholder': return one('SELECT stakeholder_name AS n FROM customer_stakeholders WHERE id = ?', 'n') ?? `Stakeholder #${ref}`;
    case 'stakeholder_group': return `Stakeholders — ${String(ref ?? '').replace(/_/g, ' ')}`;
    case 'audience_group': return one('SELECT audience_name AS n FROM communication_audiences WHERE audience_code = ?', 'n') ?? `Audience ${ref}`;
    case 'external': return String(ref ?? 'External recipient');
    default: return String(ref ?? 'Recipient');
  }
}

/**
 * Turn one audience selection into the people it reaches.
 *
 * `depth` guards the one recursive case: a configured audience whose rule
 * names another audience. Two levels is plenty and a cycle cannot run away.
 */
export function resolveAudience(db: any, selection: AudienceSelection, depth = 0): ResolvedRecipient[] {
  const label = audienceLabel(db, selection);
  const ref = selection.ref == null ? null : String(selection.ref);
  const from = (rows: AccountRow[]) => rows.map(r => recipientFrom(selection, label, r));

  switch (selection.kind) {
    case 'user':
      return from(activeAccounts(db, 'u.id = ?', [ref]));

    case 'staff': {
      const linked = activeAccounts(db, 'u.staff_id = ?', [ref]);
      if (linked.length) return from(linked);
      // A member of staff with no account is still a legitimate recipient:
      // the communication is recorded against them and dispatched by a
      // channel that does not need a login (printed copy, hand delivery).
      return from(staffWithoutAccount(db, 's.id = ?', [ref]));
    }

    case 'department':
      return from([
        ...activeAccounts(db, 'u.staff_id IN (SELECT st.id FROM staff st JOIN sections sec ON sec.id = st.section_id WHERE sec.department_id = ?)', [ref]),
        ...staffWithoutAccount(db, 's.section_id IN (SELECT id FROM sections WHERE department_id = ?)', [ref]),
      ]);

    case 'section':
      return from([
        ...activeAccounts(db, 'u.staff_id IN (SELECT id FROM staff WHERE section_id = ?)', [ref]),
        ...staffWithoutAccount(db, 's.section_id = ?', [ref]),
      ]);

    case 'position':
      return from(activeAccounts(db, `u.staff_id IN (SELECT staff_id FROM staff_position_assignments
        WHERE position_id = ? AND is_active = 1)`, [ref]));

    case 'role':
      return from(activeAccounts(db, 'u.role_id = ?', [ref]));

    case 'laboratory_staff':
      return from([
        ...activeAccounts(db, 'u.staff_id IS NOT NULL'),
        ...staffWithoutAccount(db),
      ]);

    case 'all_users':
      return from(activeAccounts(db));

    case 'stakeholder': {
      const row = db.prepare('SELECT id, stakeholder_name, email, phone FROM customer_stakeholders WHERE id = ? AND is_active = 1')
        .get(ref) as { id: number; stakeholder_name: string; email: string | null; phone: string | null } | undefined;
      if (!row) return [];
      return [{
        audienceKind: 'stakeholder', audienceRef: String(row.id), audienceLabel: label,
        userId: null, staffId: null, stakeholderId: row.id,
        externalAddress: row.email || row.phone || null,
        name: row.stakeholder_name, reachableInApp: false,
      }];
    }

    case 'stakeholder_group': {
      const rows = db.prepare(`SELECT id, stakeholder_name, email, phone FROM customer_stakeholders
        WHERE stakeholder_type = ? AND is_active = 1 ORDER BY stakeholder_name`)
        .all(ref) as Array<{ id: number; stakeholder_name: string; email: string | null; phone: string | null }>;
      return rows.map(row => ({
        audienceKind: 'stakeholder_group', audienceRef: ref, audienceLabel: label,
        userId: null, staffId: null, stakeholderId: row.id,
        externalAddress: row.email || row.phone || null,
        name: row.stakeholder_name, reachableInApp: false,
      }));
    }

    case 'audience_group': {
      if (depth > 1) return [];
      const group = db.prepare('SELECT * FROM communication_audiences WHERE audience_code = ? AND is_active = 1').get(ref) as
        { audience_code: string; audience_name: string; source: string; rule_json: string | null } | undefined;
      if (!group) return [];
      const rule = parseJson<Record<string, unknown>>(group.rule_json) ?? {};
      const relabel = (list: ResolvedRecipient[]) => list.map(r => ({
        ...r, audienceKind: 'audience_group', audienceRef: group.audience_code, audienceLabel: group.audience_name,
      }));

      if (group.source === 'staff_list') {
        const ids = Array.isArray(rule.staffIds) ? (rule.staffIds as unknown[]).map(Number).filter(Number.isFinite) : [];
        const out: ResolvedRecipient[] = [];
        for (const staffId of ids) out.push(...resolveAudience(db, { kind: 'staff', ref: staffId }, depth + 1));
        return relabel(out);
      }
      if (group.source === 'external_list') {
        const addresses = Array.isArray(rule.addresses) ? (rule.addresses as unknown[]).map(String).filter(Boolean) : [];
        return addresses.map(address => ({
          audienceKind: 'audience_group', audienceRef: group.audience_code, audienceLabel: group.audience_name,
          userId: null, staffId: null, stakeholderId: null, externalAddress: address,
          name: address, reachableInApp: false,
        }));
      }
      // organisation_rule — a live query over the register, so the audience
      // follows the organisation instead of going stale.
      const kind = String(rule.kind ?? '');
      if (kind === 'unit_leads') {
        const ids = unitLeadStaffIds(db);
        const out: ResolvedRecipient[] = [];
        for (const staffId of ids) out.push(...resolveAudience(db, { kind: 'staff', ref: staffId }, depth + 1));
        return relabel(dedupe(out));
      }
      if (kind === 'position_match') {
        const match = `%${String(rule.match ?? '').toLowerCase()}%`;
        return relabel(from(activeAccounts(db, `u.staff_id IN (SELECT a.staff_id FROM staff_position_assignments a
          JOIN positions p ON p.id = a.position_id
          WHERE a.is_active = 1 AND LOWER(p.title) LIKE ?)`, [match])));
      }
      if (kind === 'stakeholder_group' || kind === 'laboratory_staff' || kind === 'all_users'
        || kind === 'section' || kind === 'department' || kind === 'role' || kind === 'position') {
        const inner = resolveAudience(db, {
          kind,
          ref: (rule.stakeholderType ?? rule.ref ?? null) as string | number | null,
        }, depth + 1);
        return relabel(inner);
      }
      return [];
    }

    case 'external': {
      if (!ref) return [];
      return [{
        audienceKind: 'external', audienceRef: ref, audienceLabel: label,
        userId: null, staffId: null, stakeholderId: null, externalAddress: ref,
        name: ref, reachableInApp: false,
      }];
    }

    default:
      return [];
  }
}

/** One row per person, keeping the first audience that reached them. */
function dedupe(list: ResolvedRecipient[]): ResolvedRecipient[] {
  const seen = new Set<string>();
  const out: ResolvedRecipient[] = [];
  for (const r of list) {
    const key = r.userId != null ? `u:${r.userId}`
      : r.staffId != null ? `s:${r.staffId}`
      : r.stakeholderId != null ? `k:${r.stakeholderId}`
      : `e:${(r.externalAddress ?? r.name).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Resolve every audience the sender chose into a single recipient list.
 *
 * A person named twice — once by unit and once by name — receives one copy.
 * They are counted once in the read statistics too, which is what makes a
 * "14 of 20 have read this" figure mean anything.
 */
export function resolveAudiences(db: any, selections: AudienceSelection[]): ResolvedRecipient[] {
  const all: ResolvedRecipient[] = [];
  for (const selection of selections) all.push(...resolveAudience(db, selection));
  return dedupe(all);
}

/** How many people an audience currently reaches — for the compose screen. */
export function audienceSize(db: any, selection: AudienceSelection): number {
  try { return resolveAudience(db, selection).length; } catch { return 0; }
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/* ========================================================================== *
 * Creating and dispatching a communication
 * ========================================================================== */

export type CommunicationInput = {
  type: CommunicationType | string;
  subject: string;
  body: string;
  bodyFormat?: 'text' | 'html';
  direction?: CommunicationDirection | string;
  channel?: string;
  priority?: CommunicationPriority | string;
  confidentiality?: CommunicationConfidentiality | string;
  audiences: AudienceSelection[];
  /** Continue an existing conversation instead of starting one. */
  threadId?: number | null;
  parentCommunicationId?: number | null;
  requiresApproval?: boolean;
  requiresAcknowledgement?: boolean;
  acknowledgementDue?: string | null;
  /** The formal memo block. Only read for a memo or a notice. */
  memoToText?: string | null;
  memoFromText?: string | null;
  memoDate?: string | null;
  memoReference?: string | null;
  signatoryStaffId?: number | null;
  signatoryName?: string | null;
  /** The record this communication is about. */
  sourceModule?: string | null;
  sourceRecordType?: string | null;
  sourceRecordId?: string | number | null;
  /** The sender, when it is not the signed-in user (an inbound message). */
  senderUserId?: number | null;
  senderStaffId?: number | null;
  senderExternalName?: string | null;
  senderExternalAddress?: string | null;
  attachments?: Array<{ fileId: number; caption?: string | null }>;
};

export type CreatedCommunication = {
  id: number;
  communicationNumber: string;
  threadId: number;
  threadNumber: string;
  recipientCount: number;
  /** Recipients SECH_LIMS has no in-app route to — the caller may want to say so. */
  externalRecipientCount: number;
};

const FORMAL = new Set(['memo', 'notice']);

function numberFor(db: any, type: string, createdAt: string): string {
  const prefix = COMMUNICATION_NUMBER_PREFIX[type as CommunicationType] ?? 'COMM';
  return generateRecordNumber(db, 'communications', prefix, createdAt, 'communication_number');
}

/**
 * Open or continue a thread.
 *
 * A reply belongs to the conversation it answers; anything else starts one.
 * The thread carries the subject and the confidentiality of its first message,
 * because a conversation that began as confidential does not become internal
 * halfway down.
 */
function ensureThread(db: any, input: CommunicationInput, actorUserId: number | null, createdAt: string): { id: number; thread_number: string } {
  if (input.threadId) {
    const row = db.prepare('SELECT id, thread_number FROM communication_threads WHERE id = ?').get(input.threadId) as
      { id: number; thread_number: string } | undefined;
    if (row) return row;
  }
  const threadNumber = generateRecordNumber(db, 'communication_threads', THREAD_NUMBER_PREFIX, createdAt, 'thread_number');
  const r = db.prepare(`INSERT INTO communication_threads
    (thread_number, subject, communication_type, source_module, source_record_type, source_record_id,
     confidentiality, status, started_by_user_id, message_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 0, ?)`)
    .run(threadNumber, input.subject, String(input.type), input.sourceModule ?? null, input.sourceRecordType ?? null,
      input.sourceRecordId == null ? null : String(input.sourceRecordId),
      input.confidentiality ?? 'internal', actorUserId, createdAt);
  return { id: Number(r.lastInsertRowid), thread_number: threadNumber };
}

/** Record one event on the communication's trail. */
export function logCommunicationEvent(db: any, entry: {
  communicationId: number;
  recipientId?: number | null;
  eventType: string;
  note?: string | null;
  actorUserId?: number | null;
  actorStaffId?: number | null;
}) {
  db.prepare(`INSERT INTO communication_events
    (communication_id, recipient_id, event_type, event_note, actor_user_id, actor_staff_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(entry.communicationId, entry.recipientId ?? null, entry.eventType, entry.note ?? null,
      entry.actorUserId ?? null, entry.actorStaffId ?? null);
}

/**
 * Create a communication, with its recipients and attachments, in whatever
 * state the caller asked for.
 *
 * Nothing is delivered here. A draft stays a draft, a memo needing approval
 * waits for it, and `sendCommunication()` is the only thing that puts a
 * message in front of a person — one place to get delivery right.
 */
export function createCommunication(req: any, input: CommunicationInput, options: { status?: string } = {}): CreatedCommunication {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const actorUserId = input.senderUserId ?? req?.user?.id ?? null;
  const type = String(input.type);
  const isFormal = FORMAL.has(type);
  const channel = input.channel ?? 'in_app';
  const direction = input.direction ?? 'internal';

  const senderStaffId = input.senderStaffId
    ?? (actorUserId ? (db.prepare('SELECT staff_id FROM users WHERE id = ?').get(actorUserId) as { staff_id: number | null } | undefined)?.staff_id ?? null : null);

  const thread = ensureThread(db, input, actorUserId, createdAt);
  const communicationNumber = numberFor(db, type, createdAt);
  const requiresApproval = input.requiresApproval ? 1 : 0;
  const status = options.status ?? (requiresApproval ? 'pending_approval' : 'draft');

  const result = db.prepare(`INSERT INTO communications
    (communication_number, thread_id, parent_communication_id, communication_type, direction, channel,
     subject, body, body_format, priority, confidentiality, status,
     sender_user_id, sender_staff_id, sender_external_name, sender_external_address,
     memo_to_text, memo_from_text, memo_date, memo_reference, signatory_staff_id, signatory_name,
     requires_approval, requires_acknowledgement, acknowledgement_due,
     source_module, source_record_type, source_record_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(communicationNumber, thread.id, input.parentCommunicationId ?? null, type, direction, channel,
      input.subject, input.body ?? '', input.bodyFormat ?? 'text',
      input.priority ?? 'normal', input.confidentiality ?? 'internal', status,
      actorUserId, senderStaffId, input.senderExternalName ?? null, input.senderExternalAddress ?? null,
      isFormal ? (input.memoToText ?? null) : null,
      isFormal ? (input.memoFromText ?? null) : null,
      isFormal ? (input.memoDate ?? createdAt.slice(0, 10)) : null,
      isFormal ? (input.memoReference ?? null) : null,
      input.signatoryStaffId ?? null, input.signatoryName ?? null,
      requiresApproval, input.requiresAcknowledgement ? 1 : 0, input.acknowledgementDue ?? null,
      input.sourceModule ?? null, input.sourceRecordType ?? null,
      input.sourceRecordId == null ? null : String(input.sourceRecordId),
      req?.user?.id ?? actorUserId, createdAt);
  const id = Number(result.lastInsertRowid);

  const recipients = resolveAudiences(db, input.audiences ?? []);
  const insertRecipient = db.prepare(`INSERT INTO communication_recipients
    (communication_id, audience_kind, audience_ref, audience_label, user_id, staff_id, stakeholder_id,
     external_address, delivery_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  for (const r of recipients) {
    insertRecipient.run(id, r.audienceKind, r.audienceRef, r.audienceLabel,
      r.userId, r.staffId, r.stakeholderId, r.externalAddress, createdAt);
  }

  if (input.attachments?.length) {
    const insertAttachment = db.prepare(`INSERT INTO communication_attachments
      (communication_id, file_id, caption, created_by) VALUES (?, ?, ?, ?)`);
    for (const a of input.attachments) insertAttachment.run(id, a.fileId, a.caption ?? null, req?.user?.id ?? null);
  }

  // A communication about a record is linked to it, so the record's own screen
  // can show what has been said about it without knowing about this module.
  if (input.sourceModule && input.sourceRecordType && input.sourceRecordId != null) {
    db.prepare(`INSERT INTO record_links
      (source_module_key, source_record_type, source_record_id, target_module_key, target_record_type, target_record_id, notes)
      VALUES (?, ?, ?, ?, 'communications', ?, ?)`)
      .run(input.sourceModule, input.sourceRecordType, String(input.sourceRecordId),
        COMMUNICATION_MODULE_KEY, String(id), `Communication ${communicationNumber}`);
  }

  logCommunicationEvent(db, {
    communicationId: id, eventType: 'created', actorUserId, actorStaffId: senderStaffId,
    note: `${recipients.length} recipient(s) resolved from ${(input.audiences ?? []).length} audience(s)`,
  });
  if (req) audit(req, { action: 'create', entity: 'communications', entityId: id, newValue: { communicationNumber, type, subject: input.subject, recipients: recipients.length } });

  return {
    id, communicationNumber, threadId: thread.id, threadNumber: thread.thread_number,
    recipientCount: recipients.length,
    externalRecipientCount: recipients.filter(r => !r.reachableInApp).length,
  };
}

/** The route an inbox alert opens: the thread this message belongs to. */
function actionUrlFor(threadId: number): string {
  return `/information-management?tab=Communication&thread=${threadId}`;
}

/**
 * Deliver a communication to its recipients and mark it sent.
 *
 * In-app recipients get a notification through the existing infrastructure, so
 * the bell, the portal inbox, the sounds and the alert feed all behave exactly
 * as they do for anything else — a message is not a second inbox bolted on
 * beside the first. Recipients with no in-app route are marked `prepared`,
 * which is the system saying plainly: a record exists, a delivery does not,
 * and somebody must still carry it.
 *
 * Idempotent: sending an already-sent communication delivers nothing twice.
 */
export function sendCommunication(req: any, communicationId: number, options: { channel?: string } = {}): {
  delivered: number; prepared: number; alreadySent: boolean;
} {
  const db = getDb();
  const comm = db.prepare('SELECT * FROM communications WHERE id = ?').get(communicationId) as any;
  if (!comm) throw new Error('Communication not found');
  if (comm.status === 'sent' || comm.status === 'received') return { delivered: 0, prepared: 0, alreadySent: true };

  const sentAt = new Date().toISOString();
  const channel = options.channel ?? comm.channel ?? 'in_app';
  const recipients = db.prepare('SELECT * FROM communication_recipients WHERE communication_id = ?').all(communicationId) as any[];
  const senderName = comm.sender_external_name
    ?? (comm.sender_user_id ? (db.prepare('SELECT COALESCE(s.full_name, u.full_name) AS n FROM users u LEFT JOIN staff s ON s.id = u.staff_id WHERE u.id = ?').get(comm.sender_user_id) as { n: string } | undefined)?.n : null)
    ?? 'SECH_LIMS';

  const insertNotification = db.prepare(`INSERT INTO notifications
    (notification_number, user_id, module_key, title, message, status, severity, notification_type,
     record_type, record_id, assigned_to_staff_id, assigned_to_user_id, action_url, action_label, due_date, created_by)
    VALUES (?, ?, ?, ?, ?, 'unread', ?, 'communication', 'communications', ?, ?, ?, ?, ?, ?, ?)`);
  const markRecipient = db.prepare('UPDATE communication_recipients SET delivery_status = ?, delivered_at = ?, notification_id = ? WHERE id = ?');

  let delivered = 0;
  let prepared = 0;
  const severity = PRIORITY_SEVERITY[(comm.priority ?? 'normal') as CommunicationPriority] ?? 'info';
  // Whether the communication's own channel is one SECH_LIMS speaks. This
  // decides what the DISPATCH record may claim, not whether a colleague with an
  // account hears about it: a critical value telephoned to a ward is still
  // something the unit's own bench must see, and withholding it from their
  // inbox because the ward was rung rather than messaged would be absurd.
  //
  // So in-app delivery follows the RECIPIENT — anybody with an active account
  // gets it, and that delivery is real and may be attested to. The nominal
  // channel gets a dispatch record of its own below, prepared or manual, with
  // no delivery claimed.
  const integrated = channelIsIntegrated(channel);

  for (const recipient of recipients) {
    if (recipient.delivery_status !== 'pending') continue;
    if (recipient.user_id) {
      const notificationNumber = generateRecordNumber(db, 'notifications', 'NOTIF', sentAt);
      const n = insertNotification.run(
        notificationNumber, recipient.user_id, COMMUNICATION_MODULE_KEY,
        `${senderName}: ${comm.subject}`, messagePreview(comm.body, 220), severity,
        String(communicationId), recipient.staff_id ?? null, recipient.user_id,
        actionUrlFor(comm.thread_id), 'Open the conversation', comm.acknowledgement_due ?? null,
        comm.sender_user_id ?? null,
      );
      markRecipient.run('delivered', sentAt, Number(n.lastInsertRowid), recipient.id);
      logCommunicationEvent(db, { communicationId, recipientId: recipient.id, eventType: 'delivered', actorUserId: comm.sender_user_id, note: `Delivered in-app to ${recipient.audience_label}` });
      delivered++;
    } else {
      // No in-app route. The record stands; the delivery is somebody's job.
      markRecipient.run('prepared', sentAt, null, recipient.id);
      logCommunicationEvent(db, {
        communicationId, recipientId: recipient.id, eventType: 'sent', actorUserId: comm.sender_user_id,
        note: `Prepared for ${recipient.audience_label} — no in-app route; dispatch through an external channel and record it`,
      });
      prepared++;
    }
  }

  db.prepare("UPDATE communications SET status = 'sent', sent_at = ?, channel = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(sentAt, channel, communicationId);
  db.prepare(`UPDATE communication_threads SET
      message_count = (SELECT COUNT(*) FROM communications WHERE thread_id = ? AND status IN ('sent','received')),
      last_message_at = ?, last_message_preview = ?, last_sender_user_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .run(comm.thread_id, sentAt, messagePreview(comm.body), comm.sender_user_id ?? null, comm.thread_id);

  // The dispatch records. In-app delivery is the only one SECH_LIMS may attest
  // to, so it is recorded on its own terms; a communication nominally carried
  // by another channel gets a second, honest row for that channel.
  if (delivered > 0) {
    recordDispatch(req, {
      communicationId, channel: 'in_app', dispatchMethod: 'system',
      recipientLabel: `${delivered} recipient(s) with a SECH_LIMS account`,
      deliveryConfirmed: 1,
      notes: `Delivered in-app to ${delivered} recipient(s). Read status is recorded by the system.`,
    });
  }
  if (!integrated) {
    recordDispatch(req, {
      communicationId, channel, dispatchMethod: 'prepared',
      recipientLabel: `${recipients.length} recipient(s)`,
      notes: `Prepared for the ${channel} channel. SECH_LIMS has no integration with it, so no delivery or read confirmation is claimed — share the prepared copy and record it.`,
    });
  } else if (delivered === 0) {
    recordDispatch(req, {
      communicationId, channel: 'in_app', dispatchMethod: 'prepared',
      recipientLabel: `${prepared} recipient(s)`,
      notes: `No recipient has a SECH_LIMS account, so nothing was delivered in-app. Dispatch a copy through another channel and record it.`,
    });
  }

  logCommunicationEvent(db, { communicationId, eventType: 'sent', actorUserId: req?.user?.id ?? comm.sender_user_id, note: `Sent on the ${channel} channel` });
  if (req) audit(req, { action: 'send', entity: 'communications', entityId: communicationId, newValue: { channel, delivered, prepared } });
  return { delivered, prepared, alreadySent: false };
}

/* ========================================================================== *
 * Dispatch records — how it actually travelled
 * ========================================================================== */

export type DispatchInput = {
  communicationId: number;
  channel: string;
  dispatchMethod: DispatchMethod | string;
  shareFormat?: ShareFormat | string | null;
  recipientLabel?: string | null;
  externalReference?: string | null;
  /** Only ever 1 for a channel SECH_LIMS delivers itself. */
  deliveryConfirmed?: number | null;
  fileId?: number | null;
  notes?: string | null;
  sensitiveReleaseConfirmed?: boolean;
  sensitiveReleaseJustification?: string | null;
};

/**
 * Record one dispatch.
 *
 * The guard is the point of this function: a channel SECH_LIMS does not speak
 * cannot record a delivery confirmation, whatever the caller passes. The log is
 * allowed to say "a PDF was produced and shared by this person at this time".
 * It is not allowed to say "the recipient received it", because nothing here
 * knows that.
 */
export function recordDispatch(req: any, input: DispatchInput): number {
  const db = getDb();
  const confirmed = channelIsIntegrated(input.channel) ? (input.deliveryConfirmed ?? null) : null;
  const r = db.prepare(`INSERT INTO communication_dispatches
    (communication_id, channel, dispatch_method, share_format, recipient_label, external_reference,
     delivery_confirmed, file_id, dispatched_by_user_id, dispatched_at, notes,
     sensitive_release_confirmed, sensitive_release_justification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.communicationId, input.channel, String(input.dispatchMethod), input.shareFormat ?? null,
      input.recipientLabel ?? null, input.externalReference ?? null, confirmed, input.fileId ?? null,
      req?.user?.id ?? null, new Date().toISOString(), input.notes ?? null,
      input.sensitiveReleaseConfirmed ? 1 : 0, input.sensitiveReleaseJustification ?? null);
  return Number(r.lastInsertRowid);
}

/**
 * Record that a communication was shared outside SECH_LIMS.
 *
 * Confidentiality is enforced here rather than at the screen, because the
 * screen is not the only caller and a restricted memo leaving the building
 * without a reason on the record is the failure this whole module exists to
 * prevent.
 */
export function recordExternalShare(req: any, input: DispatchInput & { communicationId: number }): { dispatchId: number } {
  const db = getDb();
  const comm = db.prepare('SELECT id, communication_number, confidentiality FROM communications WHERE id = ?').get(input.communicationId) as
    { id: number; communication_number: string; confidentiality: string } | undefined;
  if (!comm) throw new Error('Communication not found');

  if (confidentialityIsSensitive(comm.confidentiality)) {
    if (!input.sensitiveReleaseConfirmed || !String(input.sensitiveReleaseJustification ?? '').trim()) {
      const err = new Error(`${comm.communication_number} is marked ${comm.confidentiality}. Confirm the release and record why it is being shared outside SECH_LIMS before continuing.`);
      (err as Error & { code?: string }).code = 'SENSITIVE_RELEASE_REQUIRED';
      throw err;
    }
  }

  const dispatchId = recordDispatch(req, { ...input, deliveryConfirmed: null });
  logCommunicationEvent(db, {
    communicationId: input.communicationId, eventType: 'externally_shared',
    actorUserId: req?.user?.id ?? null,
    note: `${input.shareFormat ? `${String(input.shareFormat).toUpperCase()} ` : ''}prepared and shared through ${input.channel}${input.recipientLabel ? ` to ${input.recipientLabel}` : ''}. No delivery confirmation claimed.`,
  });
  if (req) audit(req, { action: 'external_share', entity: 'communications', entityId: input.communicationId, newValue: { channel: input.channel, format: input.shareFormat, confidentiality: comm.confidentiality } });
  return { dispatchId };
}

/* ========================================================================== *
 * What a recipient does with it
 * ========================================================================== */

/** The recipient row belonging to one reader, if the message is theirs. */
export function recipientRowFor(db: any, communicationId: number, userId: number): any | null {
  return db.prepare(`SELECT * FROM communication_recipients
    WHERE communication_id = ? AND (user_id = ? OR staff_id = (SELECT staff_id FROM users WHERE id = ?))
    ORDER BY (user_id = ?) DESC LIMIT 1`)
    .get(communicationId, userId, userId, userId) ?? null;
}

/**
 * Mark one recipient's state.
 *
 * Read, acknowledged and dismissed are three different facts and the register
 * keeps them separately — "I have seen it" is not "I accept it", and an
 * acknowledgement that silently counts a glance is not evidence of anything.
 * A state never moves backwards: a message already acknowledged is not
 * un-acknowledged by being opened again.
 */
const DELIVERY_RANK: Record<string, number> = {
  pending: 0, prepared: 0, failed: 0, delivered: 1, read: 2, replied: 3, acknowledged: 4, dismissed: 4,
};

export function markRecipientState(req: any, communicationId: number, recipientId: number,
  state: 'read' | 'replied' | 'acknowledged' | 'dismissed', note?: string | null): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM communication_recipients WHERE id = ? AND communication_id = ?')
    .get(recipientId, communicationId) as any;
  if (!row) throw new Error('Recipient not found');

  const stamp = new Date().toISOString();
  const column = { read: 'read_at', replied: 'replied_at', acknowledged: 'acknowledged_at', dismissed: 'dismissed_at' }[state];
  const keepStatus = (DELIVERY_RANK[row.delivery_status] ?? 0) >= (DELIVERY_RANK[state] ?? 0);
  // Replying to a communication, acknowledging it or dismissing it all mean it
  // was read, so `read_at` is set at the same time when it is still blank.
  // Without this a memo everybody acknowledged still reported "0 of 20 read",
  // which is the sort of figure that gets a register disbelieved.
  db.prepare(`UPDATE communication_recipients
      SET ${column} = COALESCE(${column}, ?), read_at = COALESCE(read_at, ?), delivery_status = ?
    WHERE id = ?`)
    .run(stamp, stamp, keepStatus ? row.delivery_status : state, recipientId);

  // The inbox alert and the recipient row are two views of the same fact, so
  // reading one settles the other rather than leaving a stale badge behind.
  if (row.notification_id) {
    if (state === 'read') db.prepare("UPDATE notifications SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.notification_id);
    if (state === 'acknowledged') db.prepare("UPDATE notifications SET status = 'acknowledged', acknowledged_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(stamp, row.notification_id);
    if (state === 'dismissed') db.prepare("UPDATE notifications SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.notification_id);
  }

  logCommunicationEvent(db, {
    communicationId, recipientId, eventType: state, note: note ?? null,
    actorUserId: req?.user?.id ?? null,
  });
}

/* ========================================================================== *
 * The integration entry point every other module uses
 * ========================================================================== */

/**
 * Record — and optionally send — a communication raised by another module.
 *
 * This is the function the rest of SECH_LIMS calls. A module that needs to
 * issue a memo, a notice, a critical-value communication or a staff
 * communication calls it and gets a number back; it does not insert into
 * `communications`, does not raise its own notifications and does not keep its
 * own log. That is what makes the Communication register authoritative instead
 * of being one more copy of the truth.
 *
 * It never throws into its caller. A module's own work — releasing a document,
 * recording a critical value — must not fail because the communication record
 * could not be written; the failure is reported in the audit trail instead,
 * where it can be found and fixed.
 */
export function recordModuleCommunication(req: any, input: CommunicationInput & { send?: boolean; once?: boolean }):
  (CreatedCommunication & { delivered?: number; prepared?: number; reused?: boolean }) | null {
  try {
    // `once` is for a module whose action can legitimately repeat — printing
    // the same memo twice, re-issuing the same notice — where the second run
    // is another DISPATCH of one communication rather than another
    // communication. Without it the register fills with duplicates of a memo
    // that was only ever written once.
    if (input.once) {
      const existing = findModuleCommunication(getDb(), input);
      if (existing) return { ...existing, reused: true };
    }
    const created = createCommunication(req, { ...input }, { status: 'draft' });
    if (input.send === false) return created;
    const sent = sendCommunication(req, created.id, { channel: input.channel ?? 'in_app' });
    return { ...created, delivered: sent.delivered, prepared: sent.prepared };
  } catch (err) {
    try {
      audit(req, {
        action: 'communication_record_failed', entity: 'communications',
        newValue: { subject: input.subject, type: input.type, error: err instanceof Error ? err.message : String(err) },
      });
    } catch { /* the audit trail is the last resort, not a dependency */ }
    return null;
  }
}

/* ========================================================================== *
 * Reading
 * ========================================================================== */

/**
 * The communication a module already raised for a given record, if any.
 *
 * Matched on the source triple plus the kind, which is how a module asks "have
 * I already written this?" without keeping a column of its own to remember.
 */
export function findModuleCommunication(db: any, input: {
  type: CommunicationType | string;
  sourceModule?: string | null;
  sourceRecordType?: string | null;
  sourceRecordId?: string | number | null;
}): CreatedCommunication | null {
  if (!input.sourceModule || !input.sourceRecordType || input.sourceRecordId == null) return null;
  const row = db.prepare(`SELECT c.id, c.communication_number, c.thread_id, t.thread_number,
      (SELECT COUNT(*) FROM communication_recipients r WHERE r.communication_id = c.id) AS recipient_count
    FROM communications c JOIN communication_threads t ON t.id = c.thread_id
    WHERE c.communication_type = ? AND c.source_module = ? AND c.source_record_type = ?
      AND c.source_record_id = ? AND c.status <> 'void'
    ORDER BY c.id DESC LIMIT 1`)
    .get(String(input.type), input.sourceModule, input.sourceRecordType, String(input.sourceRecordId)) as
    { id: number; communication_number: string; thread_id: number; thread_number: string; recipient_count: number } | undefined;
  if (!row) return null;
  return {
    id: row.id, communicationNumber: row.communication_number,
    threadId: row.thread_id, threadNumber: row.thread_number,
    recipientCount: row.recipient_count, externalRecipientCount: 0,
  };
}

/** One communication with everything hanging off it, for a detail view. */
export function loadCommunication(db: any, id: number): any | null {
  const comm = db.prepare(`SELECT c.*, t.thread_number,
      COALESCE(ss.full_name, su.full_name, c.sender_external_name) AS sender_name,
      au.full_name AS approved_by_name
    FROM communications c
    JOIN communication_threads t ON t.id = c.thread_id
    LEFT JOIN users su ON su.id = c.sender_user_id
    LEFT JOIN staff ss ON ss.id = c.sender_staff_id
    LEFT JOIN users au ON au.id = c.approved_by_user_id
    WHERE c.id = ?`).get(id) as any;
  if (!comm) return null;
  comm.recipients = db.prepare(`SELECT r.*, s.full_name AS staff_name, u.full_name AS user_name
    FROM communication_recipients r
    LEFT JOIN staff s ON s.id = r.staff_id
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.communication_id = ? ORDER BY r.audience_label, s.full_name`).all(id);
  comm.attachments = db.prepare(`SELECT a.*, f.original_name, f.mime_type, f.size_bytes
    FROM communication_attachments a JOIN files f ON f.id = a.file_id
    WHERE a.communication_id = ? ORDER BY a.id`).all(id);
  comm.dispatches = db.prepare(`SELECT d.*, u.full_name AS dispatched_by_name
    FROM communication_dispatches d LEFT JOIN users u ON u.id = d.dispatched_by_user_id
    WHERE d.communication_id = ? ORDER BY d.id DESC`).all(id);
  comm.events = db.prepare(`SELECT e.*, u.full_name AS actor_name
    FROM communication_events e LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.communication_id = ? ORDER BY e.id DESC`).all(id);
  // The counts the register and the thread view show without walking the
  // recipient list themselves. Derived rather than stored: a stored counter and
  // a recipient row that disagree is a worse answer than no counter at all.
  const recipients = comm.recipients as Array<{ read_at: string | null; acknowledged_at: string | null }>;
  comm.recipient_count = recipients.length;
  comm.read_count = recipients.filter(r => r.read_at).length;
  comm.acknowledged_count = recipients.filter(r => r.acknowledged_at).length;
  comm.attachment_count = (comm.attachments as unknown[]).length;
  comm.reply_count = (db.prepare('SELECT COUNT(*) c FROM communications WHERE parent_communication_id = ?').get(id) as { c: number }).c;
  return comm;
}

/**
 * The thread ids this person is part of — as a sender or as a recipient.
 *
 * Membership, not permission: holding the right to read the register is what
 * lets somebody see other people's conversations, and that is checked by the
 * route. This answers the narrower question the inbox asks.
 */
export function threadIdsForUser(db: any, userId: number): number[] {
  const rows = db.prepare(`SELECT DISTINCT c.thread_id AS id
    FROM communications c
    LEFT JOIN communication_recipients r ON r.communication_id = c.id
    WHERE c.sender_user_id = ?
       OR r.user_id = ?
       OR (r.staff_id IS NOT NULL AND r.staff_id = (SELECT staff_id FROM users WHERE id = ?))`)
    .all(userId, userId, userId) as Array<{ id: number }>;
  return rows.map(r => r.id);
}
