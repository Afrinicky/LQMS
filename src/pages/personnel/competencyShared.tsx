import { useRef, useState, type ReactNode } from 'react';
import { Paperclip, Printer, Trash2, Upload } from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import { openPrintable } from '../../services/xlsx';
import type { RecordAttachment } from '../../../shared/types/api';

/**
 * The pieces the competence and appraisal workspaces both need: the score
 * dial, the rating picker, the evidence panel and the print button. They live
 * here so a score reads the same on an assessment and on an appraisal.
 */

/* ── Small display pieces ───────────────────────────────────────────────── */

export const labelise = (value?: string | null) =>
  value ? value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—';

/** The tone comes from the stored value; the wording can be given explicitly. */
export const badgeFor = (value?: string | null, label?: string) =>
  <span className={`badge ${label ? 'plain ' : ''}${value ? value.toLowerCase().replace(/[\s_]+/g, '-') : 'unknown'}`}>{label ?? labelise(value)}</span>;

/** Days between today and a due date, negative when it has passed. */
function daysUntil(date?: string | null): number | null {
  if (!date) return null;
  const then = new Date(`${date}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((then.getTime() - today.getTime()) / 86400000);
}

export function DueBadge({ date }: { date?: string | null }) {
  const days = daysUntil(date);
  if (!date || days === null) return <span className="muted">—</span>;
  const tone = days < 0 ? 'overdue' : days <= 60 ? 'due-soon' : 'not-due';
  const text = days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? 'due today' : `in ${days} days`;
  // `plain` keeps the phrase as written; the default badge rule title-cases,
  // which turns "in 184 days" into "In 184 Days".
  return <span className={`badge plain ${tone}`} title={date}>{date} · {text}</span>;
}

/**
 * The headline figure of a scored record: the percentage, what it is measured
 * against, and whether it cleared the mark.
 */
export function ScoreDial({ percent, threshold, label = 'Overall', sublabel }: {
  percent?: number | null;
  threshold?: number | null;
  label?: string;
  sublabel?: string;
}) {
  const value = percent ?? null;
  const pass = value !== null && threshold !== null && threshold !== undefined ? value >= threshold : null;
  const tone = value === null ? 'var(--muted)' : pass === false ? 'var(--danger)' : pass === true ? 'var(--success)' : 'var(--accent-bright)';
  const angle = Math.max(0, Math.min(100, value ?? 0)) * 3.6;
  return <div className="score-dial">
    <div className="dial" style={{ background: `conic-gradient(${tone} ${angle}deg, rgba(255,255,255,0.07) 0deg)` }}>
      <div className="dial-inner">
        <strong style={{ color: tone }}>{value === null ? '—' : `${value}%`}</strong>
      </div>
    </div>
    <div className="dial-caption">
      <span className="dial-label">{label}</span>
      <span className="dial-sub">{sublabel ?? (threshold !== null && threshold !== undefined ? `Pass mark ${threshold}%` : '')}</span>
    </div>
  </div>;
}

/** A compact figure beside the dial. */
export function StatCell({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; hint?: string }) {
  return <div className={`stat-cell${tone ? ` ${tone}` : ''}`} title={hint}>
    <span className="sc-label">{label}</span>
    <strong className="sc-value">{value}</strong>
    {hint && <span className="sc-hint">{hint}</span>}
  </div>;
}

/**
 * The rating control. A row of buttons rather than a dropdown, because an
 * assessor working down a bench checklist is choosing from four options on
 * every line and should not have to open a menu for each one.
 */
export function RatingPicker({ value, max, onChange, labels, disabled, allowNotApplicable, notApplicable, onNotApplicable }: {
  value?: number | null;
  max: number;
  onChange: (score: number | null) => void;
  labels?: Record<number, string>;
  disabled?: boolean;
  allowNotApplicable?: boolean;
  notApplicable?: boolean;
  onNotApplicable?: (value: boolean) => void;
}) {
  const points = Array.from({ length: max }, (_, i) => i + 1);
  return <div className={`rating-picker${notApplicable ? ' na' : ''}`}>
    {points.map(point => {
      const on = !notApplicable && value === point;
      return <button
        key={point}
        type="button"
        disabled={disabled || notApplicable}
        className={`rp-dot${on ? ' on' : ''} rp-${point}`}
        title={labels?.[point] ? `${point} — ${labels[point]}` : String(point)}
        aria-pressed={on}
        aria-label={labels?.[point] ? `${point}, ${labels[point]}` : String(point)}
        onClick={() => onChange(on ? null : point)}
      >{point}</button>;
    })}
    {allowNotApplicable && <button
      type="button"
      disabled={disabled}
      className={`rp-na${notApplicable ? ' on' : ''}`}
      title="Not applicable to this post — excluded from the score"
      aria-pressed={!!notApplicable}
      onClick={() => onNotApplicable?.(!notApplicable)}
    >N/A</button>}
  </div>;
}

/** The rating scale, spelled out once above a scoring grid. */
export function ScaleLegend({ scale, max }: { scale: Array<{ score: number; label: string; descriptor: string }>; max: number }) {
  return <div className="scale-legend">
    {scale.filter(s => s.score <= max).map(s => <span key={s.score} className="sl-item" title={s.descriptor}>
      <em className={`sl-dot rp-${s.score}`}>{s.score}</em> {s.label}
    </span>)}
  </div>;
}

/* ── Print ──────────────────────────────────────────────────────────────── */

/**
 * Opens the server-rendered record in a new window with the print dialog up.
 * The token travels in a header, so the sheet is fetched and written into the
 * window rather than linked to.
 */
export function PrintButton({ path, label = 'Print', disabled, title }: { path: string; label?: string; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <button type="button" className="secondary" disabled={disabled || busy} title={title}
      onClick={async () => {
        setError(null); setBusy(true);
        try { await openPrintable(path); }
        catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
      }}>
      <Printer size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy ? 'Preparing…' : label}
    </button>
    {error && <span className="error inline-error">{error}</span>}
  </>;
}

/* ── Evidence ───────────────────────────────────────────────────────────── */

/**
 * Attachments on a record: photographs of a worksheet, a scanned checklist, a
 * proficiency-testing report, a certificate. Anything an assessor would
 * otherwise staple to the paper form.
 */
export function EvidencePanel({ basePath, attachments, canEdit, onChanged, itemChoices }: {
  /** e.g. `/personnel/competency/12` — attachments hang off `${basePath}/attachments`. */
  basePath: string;
  attachments: RecordAttachment[];
  canEdit: boolean;
  onChanged: () => void | Promise<void>;
  /** Optional: tie the file to one scored line of the record. */
  itemChoices?: Array<{ id: number; label: string }>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [itemId, setItemId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload() {
    if (!file) { setError('Choose a file to attach.'); return; }
    setError(null); setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (title.trim()) form.append('title', title.trim());
      if (description.trim()) form.append('description', description.trim());
      if (itemId) form.append('itemId', itemId);
      const token = getToken();
      const response = await fetch(`${API_BASE}${basePath}/attachments`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      setFile(null); setTitle(''); setDescription(''); setItemId('');
      if (inputRef.current) inputRef.current.value = '';
      await onChanged();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function remove(id: number) {
    setError(null);
    try { await api(`${basePath}/attachments/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { setError(errorText(e)); }
  }

  return <div className="evidence-panel">
    {attachments.length === 0
      ? <p className="muted">Nothing attached yet. Add a scanned worksheet, a photograph, a certificate or a report to evidence what was assessed.</p>
      : <table className="data-table">
        <thead><tr><th>Title</th><th>File</th><th>Description</th><th>Attached</th>{canEdit && <th />}</tr></thead>
        <tbody>
          {attachments.map(a => <tr key={a.id}>
            <td><Paperclip size={13} style={{ verticalAlign: '-2px', marginRight: 6, opacity: .6 }} />{a.title || a.original_name}</td>
            <td>
              <a href={`${API_BASE}/files/${a.file_id}/download`} onClick={e => { e.preventDefault(); void downloadFile(a.file_id, a.original_name); }}>
                {a.original_name}
              </a>
              {typeof a.size_bytes === 'number' && <span className="muted"> · {formatBytes(a.size_bytes)}</span>}
            </td>
            <td>{a.description || '—'}</td>
            <td>{String(a.created_at || '').slice(0, 10)}<br /><small className="muted">{a.uploaded_by_name || '—'}</small></td>
            {canEdit && <td><button type="button" className="link-button danger" onClick={() => void remove(a.id)} aria-label={`Remove ${a.title || a.original_name}`}><Trash2 size={14} /></button></td>}
          </tr>)}
        </tbody>
      </table>}

    {canEdit && <div className="evidence-add">
      <label>File<input ref={inputRef} type="file" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
      <label>Title<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Defaults to the file name" /></label>
      <label>Description<input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this evidences" /></label>
      {itemChoices && itemChoices.length > 0 && <label>Evidence for
        <select value={itemId} onChange={e => setItemId(e.target.value)}>
          <option value="">The record as a whole</option>
          {itemChoices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>}
      <button type="button" disabled={busy || !file} onClick={() => void upload()}>
        <Upload size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />{busy ? 'Attaching…' : 'Attach evidence'}
      </button>
    </div>}
    {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
  </div>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetches a file with the auth header, then hands it to the browser to save. */
export async function downloadFile(fileId: number, name: string) {
  const token = getToken();
  const response = await fetch(`${API_BASE}/files/${fileId}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}
