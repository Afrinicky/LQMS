import type { ReactNode } from 'react';
import { AlertTriangle, Check, CircleDot, Info, Lock, Minus, X } from 'lucide-react';
import TextBox from '../ui/TextField';
import {
  CONNECTION_STATE_LABELS, CONNECTION_STATE_TONES, DELIVERY_STATE_LABELS,
  MESSAGE_STATUS_LABELS, type ConnectionState, type DeliveryState,
} from '../../../shared/constants/middleware';

/**
 * The parts every middleware section shares.
 *
 * One status chip, one panel, one definition list, one table shell. A module
 * where each of twelve sections styles its own status word is a module where
 * "Degraded" means something slightly different on every screen.
 */

/* ============================================================================
   Types the sections pass between themselves
   ========================================================================= */
export type Destination = {
  id: number; dest_code: string; name: string;
  platform: string; transport: string; payload_format: string;
  host: string | null; port: number | null; base_url: string | null;
  use_tls: number; username: string | null; secret_set: boolean; auth_scheme: string;
  export_dir: string | null; file_template: string | null;
  sending_facility: string | null; receiving_facility: string | null; receiving_application: string | null;
  ack_policy: string; ack_timeout_ms: number;
  retry_max: number; retry_base_ms: number; retry_factor: number;
  transform: Record<string, unknown>;
  state: ConnectionState; state_detail: string | null;
  is_protected: number; is_active: number; auto_deliver: number;
  approved_by: number | null; approved_by_name: string | null; approved_at: string | null;
  activated_by_name: string | null; activated_at: string | null;
  last_test_at: string | null; last_test_outcome: string | null;
  last_delivery_at: string | null; last_error: string | null; notes: string | null;
  confirmable: boolean;
  routes: number; mappings: number; delivered: number; pending: number; dead_letters: number;
};

export type MiddlewareLink = {
  id: number; name: string; link_code: string; role: string; mode: string; protocol: string;
  state: string; state_detail: string | null; last_error: string | null;
  listen_host: string | null; listen_port: number | null;
  remote_host: string | null; remote_port: number | null;
  watch_path: string | null; tap_path: string | null;
  equipment_name: string | null; section_name: string | null; profile_key: string | null;
  last_message_at: string | null; messages_received: number;
  middleware_messages: number; unrouted: number; pending: number; dead_letters: number; routes: number;
  engine_protected: boolean;
};

export type Route = {
  id: number; route_code: string; name: string; destination_id: number; destination_name: string;
  destination_state: string; destination_protected: number; platform: string;
  priority: number; source_link_id: number | null; source_link_name: string | null;
  source_profile_key: string | null; message_kind: string; test_codes: string[];
  section_id: number | null; section_name: string | null; facility: string | null; department: string | null;
  stop_on_match: number; is_active: number; notes: string | null; deliveries: number;
};

export type Delivery = {
  id: number; delivery_uid: string; message_id: number; destination_id: number;
  destination_name: string; platform: string; transport: string; ack_policy: string;
  idempotency_key: string; state: DeliveryState; attempt: number; max_attempts: number;
  next_attempt_at: string | null; last_attempt_at: string | null; delivered_at: string | null;
  ack_code: string | null; ack_text: string | null; results_sent: number; results_unmapped: string[];
  error: string | null; dead_letter_reason: string | null;
  replay_count: number; replayed_by_name: string | null; replayed_at: string | null;
  sample_id: string | null; kind: string; message_uid: string; message_received_at: string;
  link_name: string | null; confirmable: boolean; payload_format: string | null; payload?: string | null;
};

export type MessageRow = {
  id: number; message_uid: string; received_at: string; source: string; protocol: string | null;
  kind: string; sample_id: string | null; lot_number: string | null;
  instrument_name: string | null; instrument_run_at: string | null;
  result_count: number; status: string; routes_matched: number;
  link_name: string | null; deliveries: number; delivered: number; dead_letters: number;
  validation: Array<{ severity: string; field: string; detail: string }>;
};

export type DiagnosticReport = {
  subject: string; subjectKind: string; subjectId: number | null; at: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped' | 'info';
  summary: string;
  findings: Array<{
    layer: string; key: string; label: string;
    status: 'ok' | 'warn' | 'fail' | 'skipped' | 'info';
    detail: string; remedy: string | null; measuredMs: number | null;
  }>;
};

export type Reference = {
  platforms: Array<{ key: string; label: string }>;
  transports: Array<{ key: string; label: string; hint: string }>;
  payloadFormats: Array<{ key: string; label: string }>;
  ackPolicies: Array<{ key: string; label: string }>;
  connectionStates: Array<{ key: string; label: string }>;
  deliveryStates: Array<{ key: string; label: string }>;
  messageKinds: Array<{ key: string; label: string }>;
  messageStatuses: Record<string, string>;
  traceStages: Record<string, string>;
  diagnosticLayers: Record<string, string>;
  linkStates: Record<string, string>;
  dennisTools: Array<{ key: string; label: string }>;
  profiles: Array<{ key: string; label: string; vendor: string; protocol: string; discipline: string }>;
  discoveryPorts: number[];
};

export type Overview = {
  running: boolean;
  destinations: number; destinationsActive: number; destinationsDegraded: number;
  protectedConnections: number; routes: number;
  messagesToday: number; deliveredToday: number;
  queued: number; retrying: number; inFlight: number; deadLetters: number; queueDepth: number;
  lastDeliveryAt: string | null; tone: 'ok' | 'warn' | 'crit';
  links: { n: number; running: number; blocked: number; failing: number };
  baselines: Array<{ id: number; label: string; last_verdict: string | null; last_verified_at: string | null; captured_at: string }>;
  recent: MessageRow[];
};

/* ============================================================================
   Presentation
   ========================================================================= */

/** A connection's state, in the one appearance it has everywhere. */
export function StateChip({ state, protectedConnection }: { state: string; protectedConnection?: boolean }) {
  if (protectedConnection) {
    return <span className="mw-chip t-lock"><Lock size={10} /> Protected</span>;
  }
  const tone = CONNECTION_STATE_TONES[state as ConnectionState] ?? 'idle';
  return <span className={`mw-chip t-${tone}`}>{CONNECTION_STATE_LABELS[state as ConnectionState] ?? state}</span>;
}

/** A delivery's state. */
export function DeliveryChip({ state }: { state: string }) {
  const tone = state === 'delivered' ? 'ok'
    : state === 'dead_letter' || state === 'rejected' ? 'crit'
    : state === 'retrying' || state === 'in_flight' ? 'warn'
    : state === 'cancelled' ? 'idle' : 'info';
  return <span className={`mw-chip t-${tone}`}>{DELIVERY_STATE_LABELS[state as DeliveryState] ?? state}</span>;
}

/** A message's status. */
export function MessageChip({ status }: { status: string }) {
  const tone = status === 'complete' ? 'ok'
    : status === 'failed' || status === 'invalid' ? 'crit'
    : status === 'partial' || status === 'no_route' ? 'warn' : 'info';
  return <span className={`mw-chip t-${tone}`}>{MESSAGE_STATUS_LABELS[status as keyof typeof MESSAGE_STATUS_LABELS] ?? status}</span>;
}

/** A diagnostic outcome, as an icon plus a word. */
export function StatusMark({ status }: { status: string }) {
  const map: Record<string, { tone: string; icon: ReactNode; label: string }> = {
    ok: { tone: 'ok', icon: <Check size={11} />, label: 'Pass' },
    warn: { tone: 'warn', icon: <AlertTriangle size={11} />, label: 'Attention' },
    fail: { tone: 'crit', icon: <X size={11} />, label: 'Fail' },
    skipped: { tone: 'idle', icon: <Minus size={11} />, label: 'Skipped' },
    info: { tone: 'info', icon: <Info size={11} />, label: 'Note' },
  };
  const entry = map[status] ?? map.info;
  return <span className={`mw-mark t-${entry.tone}`}>{entry.icon} {entry.label}</span>;
}

/** One section panel: a heading, an optional action, and a body. */
export function Panel({ title, subtitle, actions, children, tone }: {
  title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; tone?: 'warn' | 'crit' | 'lock';
}) {
  return (
    <section className={`mw-panel${tone ? ` t-${tone}` : ''}`}>
      <header>
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="mw-panel-actions">{actions}</div>}
      </header>
      <div className="mw-panel-body">{children}</div>
    </section>
  );
}

/** Label and value pairs, for a configuration summary. */
export function Facts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="mw-facts">
      {items.map((item, i) => (
        <div key={i}>
          <dt>{item.label}</dt>
          <dd>{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A quiet line of supporting detail under a row. */
export function Note({ children, tone }: { children: ReactNode; tone?: 'warn' | 'crit' | 'ok' }) {
  return <p className={`mw-note${tone ? ` t-${tone}` : ''}`}>{children}</p>;
}

/** The dot that says a thing is live. */
export function Live({ on }: { on: boolean }) {
  return <span className={`mw-live${on ? ' on' : ''}`}><CircleDot size={10} /> {on ? 'Running' : 'Stopped'}</span>;
}

/* ============================================================================
   Formatting
   ========================================================================= */
export function when(value: string | null | undefined): string {
  if (!value) return '—';
  return String(value).replace('T', ' ').slice(0, 16);
}

export function ago(value: string | null | undefined): string {
  if (!value) return 'never';
  const then = Date.parse(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(then)) return when(value);
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function endpointOf(destination: Destination): string {
  if (destination.transport === 'internal') return 'SECHLIMS';
  if (destination.transport === 'file_export') return destination.export_dir || '(no folder set)';
  if (destination.base_url) return destination.base_url;
  if (destination.host) return `${destination.host}:${destination.port ?? '—'}`;
  return '(not set)';
}

export function linkEndpointOf(link: MiddlewareLink): string {
  if (link.mode === 'server') return `listens on ${link.listen_host || 'every interface'}:${link.listen_port ?? '—'}`;
  if (link.mode === 'client') return `dials ${link.remote_host ?? '—'}:${link.remote_port ?? '—'}`;
  if (link.mode === 'lhims_tap') return `follows ${link.tap_path || '(no path set)'}`;
  return `watches ${link.watch_path || '(no folder set)'}`;
}

/* ============================================================================
   What every section is handed
   ----------------------------------------------------------------------------
   Declared here rather than in the page, so a section can state its own props
   without importing the page that renders it.
   ========================================================================= */
export type SectionProps = {
  overview: Overview | null;
  reference: Reference | null;
  links: MiddlewareLink[];
  destinations: Destination[];
  routes: Route[];
  reload: () => Promise<void>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  canConfigure: boolean;
  canApprove: boolean;
  canDiscover: boolean;
  canDiagnose: boolean;
  canQueue: boolean;
  canApproveDennis: boolean;
  canRollback: boolean;
  onOpen?: (tab: string) => void;
};

/* ============================================================================
   Form parts
   ----------------------------------------------------------------------------
   The same label-and-control shape the rest of SECHLIMS uses, so a middleware
   form looks like every other form in the application.
   ========================================================================= */

/** One labelled text box. `hint` is one line, under the box, or nothing. */
export function Field({ label, value, onValue, placeholder, hint, wide, type, disabled, area }: {
  label: string;
  value: string;
  onValue: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  wide?: boolean;
  type?: string;
  disabled?: boolean;
  area?: boolean;
}) {
  return (
    <label className={wide ? 'mw-wide' : undefined}>
      <span>{label}</span>
      {area
        ? <TextBox as="textarea" rows={5} value={value} onValue={onValue} placeholder={placeholder} disabled={disabled} />
        : <TextBox value={value} onValue={onValue} placeholder={placeholder} type={type} disabled={disabled} />}
      {hint && <em className="mw-hint">{hint}</em>}
    </label>
  );
}

/** One labelled picker. */
export function Pick({ label, value, onValue, options, hint, wide, disabled, blank }: {
  label: string;
  value: string;
  onValue: (value: string) => void;
  options: Array<{ key: string; label: string }>;
  hint?: ReactNode;
  wide?: boolean;
  disabled?: boolean;
  blank?: string;
}) {
  return (
    <label className={wide ? 'mw-wide' : undefined}>
      <span>{label}</span>
      <select value={value} onChange={e => onValue(e.target.value)} disabled={disabled}>
        {blank !== undefined && <option value="">{blank}</option>}
        {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
      {hint && <em className="mw-hint">{hint}</em>}
    </label>
  );
}

/** One checkbox that reads as a sentence. */
export function Switch({ label, checked, onChange, hint, disabled }: {
  label: string; checked: boolean; onChange: (value: boolean) => void; hint?: ReactNode; disabled?: boolean;
}) {
  return (
    <label className="mw-switch">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} />
      <span>{label}</span>
      {hint && <em className="mw-hint">{hint}</em>}
    </label>
  );
}
