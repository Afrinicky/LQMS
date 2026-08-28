import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronRight, Grid3x3, Layers, Printer, Users, X } from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { usePortal } from './portalData';

/**
 * The rosters and schedules, read from inside the portal.
 *
 * A published roster is not management information — it is the answer to "am I
 * working on Saturday?", and every member of staff needs it whether or not
 * they happen to be on duty today. Until now the portal only showed the shift
 * you were on right now, and finding the rest meant opening Personnel
 * Management, which most of the laboratory cannot open at all.
 *
 * So the three boards live here, read-only, opened over the portal rather than
 * navigated to. Only published and approved schedules appear: a draft is
 * somebody's work in progress, and a member of staff planning their week
 * around one that later changes is worse than not seeing it.
 *
 * `personnel.rosters: view` is in the baseline every member of staff holds, so
 * these read fine for the whole laboratory; the endpoints refuse anything more
 * than reading.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Only what has been signed off. A draft roster is not yet a promise to anyone. */
const PUBLISHED = new Set(['published', 'approved']);

function monthDays(month: string) {
  const [y, m] = String(month || '').split('-').map(Number);
  const year = y || new Date().getFullYear();
  const mi = (m || new Date().getMonth() + 1) - 1;
  return {
    year, mi,
    days: new Date(year, mi + 1, 0).getDate(),
    label: `${MONTHS[mi] ?? ''} ${year}`,
    weekday: (d: number) => WEEKDAY[new Date(year, mi, d).getDay()],
    isWeekend: (d: number) => [0, 6].includes(new Date(year, mi, d).getDay()),
  };
}

type ShiftType = { id: number; code: string; label: string; category?: string; bg_color: string; text_color: string; display_order: number; is_active: number };
type GridRow = { id: number; staff_id: number | null; label: string | null; staff_name?: string | null };
type GridCell = { row_id: number; day: number; shift_code?: string | null; value?: string | null };
type Roster = { id: number; roster_number: string; month: string; title: string; status: string; shift_codes: string; department_name?: string; header_org?: string | null; header_facility?: string | null; header_subtitle?: string | null; rows: GridRow[]; cells: GridCell[]; shiftTypes: ShiftType[] };
type Bench = { id: number; code?: string | null; name: string; is_active: number };
type BenchSchedule = { id: number; schedule_number: string; section_name: string; month: string; title: string; status: string; rows: GridRow[]; cells: GridCell[]; benches: Bench[] };
type ReassignRow = {
  id: number; unit_label: string | null; is_span: number; supervisor_name?: string | null;
  supervisor_text?: string | null; deputy_name?: string | null; deputy_text?: string | null;
  members_text?: string | null; span_text?: string | null; supervisor_is_acting?: number;
};
type Reassignment = { id: number; schedule_number: string; month?: string | null; effective_date: string; subject: string; memo_from?: string | null; memo_to?: string | null; memo_date?: string | null; intro_text?: string | null; nb_notes?: string | null; signatory_name?: string | null; status: string; rows: ReassignRow[] };

const statusChip = (s: string) => <span className={`badge ${s === 'approved' ? 'approved' : 'active'}`}>{s}</span>;

async function openPrint(path: string, onError: (m: string) => void) {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error(res.statusText);
    const html = await res.text();
    const w = window.open('', '_blank');
    if (!w) { onError('Allow pop-ups to open the print view.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  } catch (e) { onError(errorText(e)); }
}

/** A schedule opened over the portal. Wide, scrollable, and closes on Escape. */
function BoardModal({ title, subtitle, onClose, onPrint, children }: {
  title: string; subtitle?: React.ReactNode; onClose: () => void; onPrint?: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="portal-drawer-wrap wide" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="portal-drawer wide" onClick={e => e.stopPropagation()}>
        <div className="pd-head">
          <div>
            <span className="eyebrow">Schedule</span>
            <h3>{title}</h3>
            {subtitle && <p className="pd-meta">{subtitle}</p>}
          </div>
          <div className="pd-head-actions">
            {onPrint && <button type="button" className="secondary" onClick={onPrint}><Printer size={14} /> Print</button>}
            <button type="button" className="pd-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>
        <div className="pd-body scroll-x paper">{children}</div>
      </div>
    </div>
  );
}

/**
 * The monthly grid, drawn as the sheet on the wall.
 *
 * The first version of this rendered the roster in the application's own dark
 * theme, and it read as a spreadsheet of somebody else's data. A roster is not
 * that. It is a printed sheet the laboratory knows by sight: the orange header
 * band, the weekday letters over the dates, the month set in italics in the
 * corner, names in typewriter face down the left, leave running across as a
 * labelled bar. People find their line on it in a second because they have
 * looked at that same sheet a hundred times.
 *
 * So this is that sheet — the same colours, the same proportions, the same
 * merging of leave runs as `printShell` in server/routes/scheduling.ts, which
 * is the authority on how the paper looks. Change one and change the other.
 *
 * The screen keeps the two things paper cannot do: the reader's own line is
 * lifted to the top and marked, the way you would run a highlighter across it.
 */
type CellFace = { code: string; bg?: string | null; fg?: string | null; runLabel?: string | null };

function PaperMast({ org, title }: { org?: React.ReactNode; title: string }) {
  return (
    <div className="paper-mast">
      {org && <div className="paper-org">{org}</div>}
      <div className="paper-doctitle">{title}</div>
    </div>
  );
}

function MonthGrid({ month, rows, cells, myStaffId, nameHeading = 'NAMES', legend, faceOf }: {
  month: string;
  rows: GridRow[];
  cells: GridCell[];
  myStaffId: number | null;
  nameHeading?: string;
  legend?: React.ReactNode;
  /** How one cell is drawn: its code, its colours, and whether it merges into a run. */
  faceOf: (c: GridCell) => CellFace;
}) {
  const md = monthDays(month);
  const days = useMemo(() => Array.from({ length: md.days }, (_, i) => i + 1), [md.days]);

  const byCell = useMemo(() => {
    const m = new Map<string, CellFace>();
    for (const c of cells) {
      const face = faceOf(c);
      if (face.code) m.set(`${c.row_id}:${c.day}`, face);
    }
    return m;
  }, [cells, faceOf]);

  const ordered = useMemo(() => {
    if (!myStaffId) return rows;
    const mine = rows.filter(r => Number(r.staff_id) === Number(myStaffId));
    return mine.length ? [...mine, ...rows.filter(r => Number(r.staff_id) !== Number(myStaffId))] : rows;
  }, [rows, myStaffId]);

  // A week of leave is one bar reading "ANNUAL LEAVE", not seven cells reading
  // "AL" — exactly as it prints, and the reason the paper is readable at all.
  function drawRow(row: GridRow) {
    const out: React.ReactNode[] = [];
    let d = 1;
    while (d <= md.days) {
      const face = byCell.get(`${row.id}:${d}`);
      if (face?.runLabel) {
        let span = 1;
        while (d + span <= md.days && byCell.get(`${row.id}:${d + span}`)?.code === face.code) span++;
        if (span >= 2) {
          out.push(
            <td key={d} colSpan={span} className="pg-run" style={{ background: face.bg || undefined, color: face.fg || undefined }}>
              {face.runLabel.toUpperCase()}
            </td>,
          );
          d += span;
          continue;
        }
      }
      out.push(
        <td key={d} className={md.isWeekend(d) ? 'we' : ''}
          style={face ? { background: face.bg || undefined, color: face.fg || undefined, fontWeight: 700 } : undefined}>
          {face?.code ?? ''}
        </td>,
      );
      d++;
    }
    return out;
  }

  return (
    <>
      <table className="paper-grid">
        <colgroup>
          <col className="pg-namecol" />
          {days.map(d => <col key={d} />)}
        </colgroup>
        <thead>
          <tr>
            <td className="pg-month">{md.label}</td>
            {days.map(d => <td key={d} className={md.isWeekend(d) ? 'hdr-we' : 'hdr'}>{md.weekday(d)}</td>)}
          </tr>
          <tr>
            <th className="pg-name">{nameHeading}</th>
            {days.map(d => <td key={d} className={md.isWeekend(d) ? 'hdr-we' : 'hdr'}>{d}</td>)}
          </tr>
        </thead>
        <tbody>
          {ordered.map(row => {
            const isMine = myStaffId != null && Number(row.staff_id) === Number(myStaffId);
            return (
              <tr key={row.id} className={isMine ? 'is-mine' : ''}>
                <td className="pg-name">
                  {row.staff_id ? row.staff_name : row.label}
                  {isMine && <span className="pg-you">you</span>}
                </td>
                {drawRow(row)}
              </tr>
            );
          })}
          {ordered.length === 0 && (
            <tr><td className="pg-name pg-empty" colSpan={md.days + 1}>Nobody has been placed on this schedule yet.</td></tr>
          )}
        </tbody>
      </table>
      {legend && <div className="paper-legend">{legend}</div>}
    </>
  );
}

/* ----------------------------------------------------------------------------
   Duty roster
   ------------------------------------------------------------------------- */
export function PortalDutyRosters({ myStaffId }: { myStaffId: number | null }) {
  const { setError } = usePortal();
  const { can } = usePermissions();
  const [list, setList] = useState<Array<{ id: number; roster_number: string; month: string; title: string; status: string; department_name?: string }> | null>(null);
  const [open, setOpen] = useState<Roster | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Array<{ id: number; roster_number: string; month: string; title: string; status: string }>>('/scheduling/duty-rosters')
      .then(r => setList(r.filter(x => PUBLISHED.has(x.status))))
      .catch(() => setList([]));
  }, []);

  const openRoster = useCallback(async (id: number) => {
    setBusy(true);
    try { setOpen(await api<Roster>(`/scheduling/duty-rosters/${id}`)); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }, [setError]);

  const shiftByCode = useMemo(() => new Map((open?.shiftTypes ?? []).map(s => [s.code, s])), [open]);

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><CalendarDays size={16} /> The duty roster</h3>
          <p>Every published roster for the department. Your own line is highlighted and moved to the top.</p>
        </div>
        {list && list.length > 0 && <span className="pp-count">{list.length}</span>}
      </div>

      {list === null ? <p className="muted">Loading…</p>
        : list.length === 0 ? <p className="muted">No roster has been published yet. One appears here the moment it is.</p>
        : (
          <ul className="ps-list">
            {list.map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => void openRoster(r.id)} disabled={busy}>
                  <span className="ps-list-main">
                    <strong>{monthDays(r.month).label}</strong>
                    <span>{r.title || 'Duty roster'} · {r.roster_number}</span>
                  </span>
                  {statusChip(r.status)}
                  <ChevronRight size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}

      {open && (
        <BoardModal
          title={`${open.title || 'Duty roster'} — ${monthDays(open.month).label}`}
          subtitle={<>{open.roster_number}{open.department_name ? ` · ${open.department_name}` : ''} · {open.status}</>}
          onClose={() => setOpen(null)}
          onPrint={can('personnel.rosters', 'print') ? () => void openPrint(`/scheduling/duty-rosters/${open.id}/print`, setError) : undefined}
        >
          <PaperMast
            org={<>
              {open.header_org || open.department_name || 'Laboratory'}
              {open.header_facility && <><br />{open.header_facility}</>}
              {open.header_subtitle && open.header_subtitle !== open.header_facility && <><br />{open.header_subtitle}</>}
            </>}
            title={(open.title || 'DUTY ROSTER').toUpperCase()}
          />
          <MonthGrid
            month={open.month}
            rows={open.rows}
            cells={open.cells}
            myStaffId={myStaffId}
            nameHeading="NAMES"
            faceOf={c => {
              const code = c.shift_code ?? '';
              const st = code ? shiftByCode.get(code) : undefined;
              return {
                code,
                bg: st?.bg_color,
                fg: st?.text_color,
                runLabel: st?.category === 'leave' ? (st.label || code) : null,
              };
            }}
            legend={(open.shiftTypes ?? []).filter(s => s.is_active).map(s => (
              <span key={s.id} className="pg-key">
                <b>{s.code}</b>: {(s.label || '').toUpperCase()}
              </span>
            ))}
          />
          {shiftByCode.size === 0 && <p className="paper-note">No shift types are configured.</p>}
        </BoardModal>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
   Bench schedules
   ------------------------------------------------------------------------- */
export function PortalBenchSchedules({ myStaffId, mySectionName }: { myStaffId: number | null; mySectionName?: string | null }) {
  const { setError } = usePortal();
  const { can } = usePermissions();
  const [list, setList] = useState<Array<{ id: number; schedule_number: string; section_id: number; section_name: string; month: string; status: string }> | null>(null);
  const [open, setOpen] = useState<BenchSchedule | null>(null);
  const [onlyMine, setOnlyMine] = useState(true);

  useEffect(() => {
    api<Array<{ id: number; schedule_number: string; section_id: number; section_name: string; month: string; status: string }>>('/scheduling/bench-schedules')
      .then(r => setList(r.filter(x => PUBLISHED.has(x.status))))
      .catch(() => setList([]));
  }, []);

  // Their own unit first, because that is the one they work on. The rest stay
  // reachable — a scientist covering another bench needs to see that unit's
  // schedule, and it is published to the laboratory either way.
  const shown = useMemo(() => {
    if (!list) return null;
    if (!onlyMine || !mySectionName) return list;
    return list.filter(s => s.section_name === mySectionName);
  }, [list, onlyMine, mySectionName]);

  async function openSchedule(id: number) {
    try { setOpen(await api<BenchSchedule>(`/scheduling/bench-schedules/${id}`)); }
    catch (e) { setError(errorText(e)); }
  }

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><Grid3x3 size={16} /> Bench schedules</h3>
          <p>Which bench each person is on, day by day{mySectionName ? ` — starting with ${mySectionName}` : ''}.</p>
        </div>
        {mySectionName && list && list.length > 0 && (
          <button type="button" className="pq-link" onClick={() => setOnlyMine(v => !v)}>
            {onlyMine ? 'Show every unit' : `Only ${mySectionName}`}
          </button>
        )}
      </div>

      {shown === null ? <p className="muted">Loading…</p>
        : shown.length === 0 ? (
          <p className="muted">
            {onlyMine && mySectionName
              ? `No bench schedule has been published for ${mySectionName} yet.`
              : 'No bench schedule has been published yet.'}
          </p>
        ) : (
          <ul className="ps-list">
            {shown.map(s => (
              <li key={s.id}>
                <button type="button" onClick={() => void openSchedule(s.id)}>
                  <span className="ps-list-main">
                    <strong>{s.section_name}</strong>
                    <span>{monthDays(s.month).label} · {s.schedule_number}</span>
                  </span>
                  {statusChip(s.status)}
                  <ChevronRight size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}

      {open && (
        <BoardModal
          title={`${open.section_name} bench — ${monthDays(open.month).label}`}
          subtitle={<>{open.schedule_number} · {open.status}</>}
          onClose={() => setOpen(null)}
          onPrint={can('personnel.rosters', 'print') ? () => void openPrint(`/scheduling/bench-schedules/${open.id}/print`, setError) : undefined}
        >
          <PaperMast
            org={open.section_name}
            title={`${(open.section_name || '').toUpperCase()} — BENCH SCHEDULE — ${monthDays(open.month).label}`}
          />
          <MonthGrid
            month={open.month}
            rows={open.rows}
            cells={open.cells}
            myStaffId={myStaffId}
            nameHeading="STAFF"
            faceOf={c => ({ code: c.value ?? '' })}
            legend={(open.benches ?? []).filter(b => b.is_active).map(b => (
              <span key={b.id} className="pg-key"><b>{b.code || b.name}</b>: {b.name}</span>
            ))}
          />
        </BoardModal>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
   Unit reassignments
   ------------------------------------------------------------------------- */
export function PortalReassignments({ myStaffId, mySectionName }: { myStaffId: number | null; mySectionName?: string | null }) {
  const { setError } = usePortal();
  const { can } = usePermissions();
  const [list, setList] = useState<Array<{ id: number; schedule_number: string; month?: string | null; effective_date: string; subject: string; status: string }> | null>(null);
  const [open, setOpen] = useState<Reassignment | null>(null);

  useEffect(() => {
    api<Array<{ id: number; schedule_number: string; month?: string | null; effective_date: string; subject: string; status: string }>>('/scheduling/reassignments')
      .then(r => setList(r.filter(x => PUBLISHED.has(x.status))))
      .catch(() => setList([]));
  }, []);

  async function openMemo(id: number) {
    try { setOpen(await api<Reassignment>(`/scheduling/reassignments/${id}`)); }
    catch (e) { setError(errorText(e)); }
  }

  // The row that concerns this reader: their unit's, so a memo moving people
  // around the laboratory opens on the line that is about them.
  const isMine = (row: ReassignRow) =>
    Boolean(mySectionName && row.unit_label && row.unit_label.toLowerCase().includes(mySectionName.toLowerCase()));

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><Layers size={16} /> Unit reassignments</h3>
          <p>Who is posted to which unit, and who supervises it, as the published memo has it.</p>
        </div>
        {list && list.length > 0 && <span className="pp-count">{list.length}</span>}
      </div>

      {list === null ? <p className="muted">Loading…</p>
        : list.length === 0 ? <p className="muted">No reassignment memo has been published yet.</p>
        : (
          <ul className="ps-list">
            {list.map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => void openMemo(r.id)}>
                  <span className="ps-list-main">
                    <strong>{r.subject || 'Re-assignment of laboratory staff'}</strong>
                    <span>Effective {r.effective_date} · {r.schedule_number}</span>
                  </span>
                  {statusChip(r.status)}
                  <ChevronRight size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}

      {open && (
        <BoardModal
          title={open.subject || 'Re-assignment of laboratory staff'}
          subtitle={<>{open.schedule_number} · effective {open.effective_date}{open.memo_from ? ` · from ${open.memo_from}` : ''}</>}
          onClose={() => setOpen(null)}
          onPrint={can('personnel.rosters', 'print') ? () => void openPrint(`/scheduling/reassignments/${open.id}/print`, setError) : undefined}
        >
          {/* The memo as it is posted: heading, the four metalines, the unit table,
              the NB block and the signature rule — the same sheet the print makes. */}
          <div className="paper-memo">
            <h4>MEMO</h4>
            <p className="pm-line"><b>TO:</b> {open.memo_to || 'All Laboratory Staff'}</p>
            <p className="pm-line"><b>FROM:</b> {open.memo_from || '—'}</p>
            <p className="pm-line"><b>DATE:</b> {open.memo_date || open.effective_date}</p>
            <p className="pm-line"><b>SUBJECT:</b> {open.subject}</p>
            {open.intro_text && <p className="pm-line pm-intro">{open.intro_text}</p>}

            <table className="pm-table">
              <thead><tr><th>UNIT</th><th>SUPERVISOR</th><th>DEPUTY SUPERVISOR</th><th><Users size={12} /> MEMBER(S)</th></tr></thead>
              <tbody>
                {open.rows.map(row => row.is_span ? (
                  <tr key={row.id}><td><b>{row.unit_label}</b></td><td colSpan={3}>{row.span_text || row.members_text || ''}</td></tr>
                ) : (
                  <tr key={row.id} className={isMine(row) ? 'is-mine' : ''}>
                    <td>
                      <b>{row.unit_label}</b>
                      {isMine(row) && <span className="pg-you">your unit</span>}
                    </td>
                    <td>
                      {row.supervisor_text || row.supervisor_name || ''}
                      {row.supervisor_is_acting ? <small>(Acting Unit Supervisor)</small> : null}
                    </td>
                    <td>{row.deputy_text || row.deputy_name || ''}</td>
                    <td>{row.members_text || ''}</td>
                  </tr>
                ))}
                {open.rows.length === 0 && <tr><td colSpan={4}>This memo has no unit rows.</td></tr>}
              </tbody>
            </table>

            {open.nb_notes && (
              <div className="pm-nb">
                <u><b>NB:</b></u>
                {String(open.nb_notes).split('\n').filter(Boolean).map((n, i) => <b key={i}>{n}</b>)}
              </div>
            )}
            {open.signatory_name && (
              <div className="pm-sign">……………………………………<br />{open.signatory_name}</div>
            )}
          </div>
          {myStaffId === null && <p className="paper-note">Link your account to your staff record to have your own unit picked out.</p>}
        </BoardModal>
      )}
    </section>
  );
}
