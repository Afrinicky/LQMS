/**
 * COMMUNICATIONS — the vocabulary of the central Communication Service.
 *
 * SECH_LIMS had communication in a dozen places and a record of it in none.
 * A reassignment memo was printed from Scheduling, a critical value was
 * telephoned and written down in Process Management, a controlled document
 * notice appeared in somebody's inbox, and a supervisor sent the rest over
 * WhatsApp because the system offered nothing. Four mechanisms, four kinds of
 * evidence, and no single place an assessor — or a head of department asking
 * "was the laboratory told?" — could look.
 *
 * One service now carries all of it. Every message, memo, notice, alert and
 * system notification is a Communication record: numbered, addressed,
 * threaded, dispatched through named channels and logged. The terms a record
 * is described by live here so the server, the screens and the register can
 * never drift apart.
 *
 * Two principles are encoded in these lists and are worth stating plainly:
 *
 *  • A channel SECH_LIMS does not actually speak is recorded as *prepared*,
 *    never as delivered. Exporting a memo to PDF and sending it over WhatsApp
 *    by hand is a real, auditable act — and it is not a delivery receipt. The
 *    dispatch methods below keep the two apart, because a log that claims a
 *    read confirmation it never received is worse than no log at all.
 *
 *  • Direction is recorded from the laboratory's point of view. Outbound left
 *    SECH_LIMS, inbound arrived from outside it, and internal stayed between
 *    SECH_LIMS users. An audit asks all three questions separately.
 */

/* ============================================================================
   What kind of communication this is
   ========================================================================= */

/**
 * Message kinds. These are deliberately few: a sender choosing between
 * fourteen labels picks the wrong one, and the register becomes unsearchable.
 * Everything formal that carries a number and may need approval is a memo or
 * a notice; everything conversational is a message.
 */
export const COMMUNICATION_TYPES = [
  'direct_message',
  'memo',
  'notice',
  'alert',
  'system_notification',
  'acknowledgement_request',
  'external_message',
  'other',
] as const;
export type CommunicationType = (typeof COMMUNICATION_TYPES)[number];

export const COMMUNICATION_TYPE_LABELS: Record<CommunicationType, string> = {
  direct_message: 'Direct message',
  memo: 'Formal memo',
  notice: 'Notice',
  alert: 'Alert',
  system_notification: 'System notification',
  acknowledgement_request: 'Acknowledgement request',
  external_message: 'External message',
  other: 'Other',
};

/** The kinds that carry a formal number, a TO/FROM block and optional approval. */
export const FORMAL_TYPES: CommunicationType[] = ['memo', 'notice'];

/** The kinds a person composes by hand. The rest are raised by the system. */
export const COMPOSABLE_TYPES: CommunicationType[] = [
  'direct_message', 'memo', 'notice', 'acknowledgement_request', 'other',
];

/* ============================================================================
   Direction, channel and how it actually got there
   ========================================================================= */

export const COMMUNICATION_DIRECTIONS = ['outbound', 'inbound', 'internal'] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

export const DIRECTION_LABELS: Record<CommunicationDirection, string> = {
  outbound: 'Outbound',
  inbound: 'Inbound',
  internal: 'Internal',
};

/**
 * Channels a communication may travel by.
 *
 * `in_app` is the only one SECH_LIMS delivers itself end to end. The rest
 * depend on what the laboratory has configured or on a person doing something
 * outside the system, which is what `COMMUNICATION_INTEGRATED_CHANNELS` below
 * is for.
 */
export const COMMUNICATION_CHANNELS = [
  'in_app',
  'email',
  'whatsapp',
  'telegram',
  'sms',
  'print',
  'phone',
  'hand_delivery',
  'noticeboard',
  'other',
] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  in_app: 'SECH_LIMS (in-app)',
  email: 'Email',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  sms: 'SMS',
  print: 'Printed copy',
  phone: 'Telephone',
  hand_delivery: 'Hand delivery',
  noticeboard: 'Noticeboard',
  other: 'Other channel',
};

/**
 * Channels SECH_LIMS can itself deliver on, and therefore the only ones whose
 * status may ever read "delivered" or "read" on the system's own authority.
 * Everything else is recorded as prepared or shared, and the person who
 * carried it out is named.
 */
export const COMMUNICATION_INTEGRATED_CHANNELS: CommunicationChannel[] = ['in_app'];

/** True when the system can confirm delivery on this channel by itself. */
export function channelIsIntegrated(channel: string): boolean {
  return COMMUNICATION_INTEGRATED_CHANNELS.includes(channel as CommunicationChannel);
}

/**
 * How a dispatch actually happened — the distinction that keeps the log
 * honest.
 *
 *  • `system`   — SECH_LIMS delivered it. Delivery and read status are real.
 *  • `prepared` — SECH_LIMS produced the document or the share payload; a
 *                 person carried it the rest of the way. No delivery claim.
 *  • `manual`   — recorded after the fact by the person who did it (telephoned,
 *                 handed over, posted on the board).
 */
export const DISPATCH_METHODS = ['system', 'prepared', 'manual'] as const;
export type DispatchMethod = (typeof DISPATCH_METHODS)[number];

export const DISPATCH_METHOD_LABELS: Record<DispatchMethod, string> = {
  system: 'Delivered by SECH_LIMS',
  prepared: 'Prepared in SECH_LIMS, shared externally',
  manual: 'Recorded manually',
};

/** The sentence the log shows so nobody mistakes a share for a delivery. */
export const DISPATCH_METHOD_HINTS: Record<DispatchMethod, string> = {
  system: 'Delivered in-app. Read status is recorded by the system.',
  prepared: 'Prepared here and shared through an external channel. No delivery or read confirmation is claimed.',
  manual: 'Recorded by the member of staff who carried it out. No delivery or read confirmation is claimed.',
};

/* ============================================================================
   Who it is addressed to
   ========================================================================= */

/**
 * Audience kinds a sender may choose from.
 *
 * The first three name people directly. The next group names an existing part
 * of the organisation, so the list resolves itself from the register rather
 * than being retyped — a department's membership changes and the audience
 * follows. `audience_group` is a saved audience configured by an
 * administrator, which is how a laboratory adds "Hospital management" or
 * "Referral laboratories" without a code change.
 */
export const AUDIENCE_KINDS = [
  'user',
  'staff',
  'department',
  'section',
  'position',
  'role',
  'laboratory_staff',
  'all_users',
  'stakeholder',
  'stakeholder_group',
  'audience_group',
  'external',
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const AUDIENCE_KIND_LABELS: Record<AudienceKind, string> = {
  user: 'A SECH_LIMS user',
  staff: 'A member of staff',
  department: 'A department',
  section: 'A unit / section',
  position: 'A position',
  role: 'An access profile',
  laboratory_staff: 'All laboratory staff',
  all_users: 'All SECH_LIMS users',
  stakeholder: 'A stakeholder',
  stakeholder_group: 'A stakeholder type',
  audience_group: 'A configured audience',
  external: 'An external address',
};

/** Audience kinds that reach more than one person, so a send is a broadcast. */
export const BROADCAST_KINDS: AudienceKind[] = [
  'department', 'section', 'position', 'role', 'laboratory_staff', 'all_users',
  'stakeholder_group', 'audience_group',
];

export function audienceIsBroadcast(kind: string): boolean {
  return BROADCAST_KINDS.includes(kind as AudienceKind);
}

/**
 * How a configured audience names its members. A saved audience is either a
 * fixed list of staff, or a rule over the organisation that re-resolves every
 * time it is used, or a list of external addresses.
 */
export const AUDIENCE_GROUP_SOURCES = ['staff_list', 'organisation_rule', 'external_list'] as const;
export type AudienceGroupSource = (typeof AUDIENCE_GROUP_SOURCES)[number];

/* ============================================================================
   Lifecycle
   ========================================================================= */

/**
 * A communication's own status. `draft` and `pending_approval` are the only
 * states in which a formal memo has not yet left the building.
 */
export const COMMUNICATION_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'sent',
  'received',
  'archived',
  'void',
] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

export const COMMUNICATION_STATUS_LABELS: Record<CommunicationStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Returned',
  sent: 'Sent',
  received: 'Received',
  archived: 'Archived',
  void: 'Void',
};

/** One recipient's state. Read and acknowledged are different questions. */
export const DELIVERY_STATUSES = [
  'pending', 'delivered', 'read', 'replied', 'acknowledged', 'dismissed', 'failed', 'prepared',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: 'Pending',
  delivered: 'Delivered',
  read: 'Read',
  replied: 'Replied',
  acknowledged: 'Acknowledged',
  dismissed: 'Dismissed',
  failed: 'Failed',
  prepared: 'Prepared for an external channel',
};

/** Everything that happens to a communication, in the log's own words. */
export const COMMUNICATION_EVENT_TYPES = [
  'created', 'edited', 'submitted_for_approval', 'approved', 'rejected', 'sent',
  'delivered', 'read', 'replied', 'forwarded', 'acknowledged', 'dismissed',
  'exported', 'externally_shared', 'printed', 'received', 'archived', 'voided',
] as const;
export type CommunicationEventType = (typeof COMMUNICATION_EVENT_TYPES)[number];

/* ============================================================================
   Priority and confidentiality
   ========================================================================= */

export const COMMUNICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type CommunicationPriority = (typeof COMMUNICATION_PRIORITIES)[number];

/**
 * How a priority maps onto the severity vocabulary the notification and alert
 * infrastructure already uses, so one inbox can sort messages and alerts
 * together instead of each page inventing its own ranking.
 */
export const PRIORITY_SEVERITY: Record<CommunicationPriority, string> = {
  low: 'low', normal: 'info', high: 'high', urgent: 'urgent',
};

/**
 * Confidentiality, borrowed verbatim from the information-asset register so a
 * memo about a restricted asset can carry the same label as the asset.
 * `restricted` and `confidential` require an explicit confirmation before the
 * content may leave SECH_LIMS through an external channel.
 */
export const COMMUNICATION_CONFIDENTIALITY = ['public', 'internal', 'restricted', 'confidential'] as const;
export type CommunicationConfidentiality = (typeof COMMUNICATION_CONFIDENTIALITY)[number];

/** Confidentiality levels whose external sharing must be confirmed in writing. */
export const SENSITIVE_CONFIDENTIALITY: CommunicationConfidentiality[] = ['restricted', 'confidential'];

export function confidentialityIsSensitive(level?: string | null): boolean {
  return SENSITIVE_CONFIDENTIALITY.includes((level ?? 'internal') as CommunicationConfidentiality);
}

/* ============================================================================
   Preparing a communication for somewhere else
   ========================================================================= */

/** Formats a memo or message can be prepared as for sharing outside SECH_LIMS. */
export const SHARE_FORMATS = ['pdf', 'docx', 'jpg', 'text', 'html'] as const;
export type ShareFormat = (typeof SHARE_FORMATS)[number];

export const SHARE_FORMAT_LABELS: Record<ShareFormat, string> = {
  pdf: 'PDF (print or save)',
  docx: 'Word document',
  jpg: 'Image (JPG)',
  text: 'Plain text',
  html: 'Web page',
};

/* ============================================================================
   The numbering prefixes
   ========================================================================= */

/**
 * A formal memo and a chat message both need a number, but an assessor asking
 * for "memo 14 of this year" should not have to count past three hundred
 * direct messages to find it. Each kind therefore numbers in its own series.
 */
export const COMMUNICATION_NUMBER_PREFIX: Record<CommunicationType, string> = {
  direct_message: 'MSG',
  memo: 'MEMO',
  notice: 'NOTE',
  alert: 'ALRT',
  system_notification: 'SYSN',
  acknowledgement_request: 'ACKR',
  external_message: 'EXTC',
  other: 'COMM',
};

export const THREAD_NUMBER_PREFIX = 'CTHR';

/** The module key communications are filed and permissioned under. */
export const COMMUNICATION_MODULE_KEY = 'information_management';

/** Permission keys. See shared/constants/features.ts for what each one covers. */
export const COMM_FEATURE = {
  /** Composing, reading, replying — everyone who may use the hub. */
  messages: 'information_management.communication',
  /** Formal memos and notices: drafting, approving, dispatching, sharing. */
  memos: 'information_management.communication_memos',
  /** The register and its audit trail. */
  log: 'information_management.communication_log',
  /** Audiences and templates — the configuration behind the hub. */
  admin: 'information_management.communication_audiences',
} as const;

/* ============================================================================
   Small shared helpers
   ========================================================================= */

/** A one-line preview for a popup or a register row. */
export function messagePreview(body?: string | null, limit = 140): string {
  const text = String(body ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Human label for any of the vocabularies above, falling back to the raw key. */
export function prettyKey(value?: string | null): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
