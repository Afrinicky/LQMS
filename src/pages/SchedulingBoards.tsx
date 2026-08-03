import { FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, API_BASE, getToken } from '../services/api';
import type { Staff, Section } from '../../shared/types/api';
import { usePermissions } from '../hooks/usePermissions';

// ==========================================================================
// Scheduling boards — the department duty roster (Excel-like editable grid),
// the unit/staff reassignment memo, and per-unit bench schedules. All three
// render a monthly, fully editable view for managers/unit heads and a
// read-only view for other staff, and each prints to match the paper form.
// ==========================================================================

export type ShiftType = { id: number; code: string; label: string; category: string; bg_color: string; text_color: string; display_order: number; is_active: number; is_system: number };
type RosterRow = { id: number; staff_id: number | null; label: string | null; display_order: number; staff_name?: string | null };
type Cell = { row_id: number; day: number; shift_code: string | null; note?: string | null };
type Roster = { id: number; roster_number: string; month: string; title: string; status: string; shift_codes: string; header_org?: string; header_facility?: string; header_subtitle?: string; department_name?: string; rows: RosterRow[]; cells: Cell[]; shiftTypes: ShiftType[] };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function monthDays(month: string) {
  const [y, m] = (month || '').split('-').map(Number);
  const year = y || new Date().getFullYear();
  const mi = (m || new Date().getMonth() + 1) - 1;
  const days = new Date(year, mi + 1, 0).getDate();
  return { year, mi, days, label: `${MONTHS[mi]}, ${year}`, weekday: (d: number) => WEEKDAY[new Date(year, mi, d).getDay()], isWeekend: (d: number) => { const w = new Date(year, mi, d).getDay(); return w === 0 || w === 6; } };
}

function thisMonthValue() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function nextMonthValue() { const d = new Date(); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

async function openPrintPage(path: string, onError: (m: string) => void) {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error(await res.text() || res.statusText);
    const html = await res.text();
    const w = window.open('', '_blank');
    if (!w) { onError('Pop-up blocked. Allow pop-ups to open the print dialog.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  } catch (e) { onError((e as Error).message); }
}

const statusBadge = (s: string) => <span className={`badge ${s === 'approved' ? 'approved' : s === 'published' ? 'active' : ''}`}>{s}</span>;

// ============================ Duty Roster Board ============================
export function DutyRosterBoard({ staff, canEdit }: { staff: Staff[]; canEdit: boolean }) {
  const { can } = usePermissions();
  const [rosters, setRosters] = useState<Array<{ id: number; roster_number: string; month: string; title: string; status: string }>>([]);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newMonth, setNewMonth] = useState(nextMonthValue());
  const [copyFrom, setCopyFrom] = useState('');
  const [paint, setPaint] = useState<string>('M');
  const [erase, setErase] = useState(false);
  // local editable cell map: `${rowId}:${day}` -> code
  const [cellMap, setCellMap] = useState<Map<string, string>>(new Map());
  const dirty = useRef<Set<string>>(new Set());
  const [addStaffId, setAddStaffId] = useState('');
  const [addLabel, setAddLabel] = useState('');

  function loadList() { api<typeof rosters>('/scheduling/duty-rosters').then(setRosters).catch(e => setError((e as Error).message)); }
  useEffect(() => { loadList(); }, []);

  async function open(id: number) {
    setError(null); setMsg(null);
    try {
      const r = await api<Roster>(`/scheduling/duty-rosters/${id}`);
      setRoster(r);
      const m = new Map<string, string>();
      for (const c of r.cells) if (c.shift_code) m.set(`${c.row_id}:${c.day}`, c.shift_code);
      setCellMap(m); dirty.current = new Set();
    } catch (e) { setError((e as Error).message); }
  }

  async function createRoster(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      const r = await api<{ id: number }>('/scheduling/duty-rosters', { method: 'POST', body: JSON.stringify({ month: newMonth, copyFromId: copyFrom || undefined }) });
      setCopyFrom(''); loadList(); await open(r.id);
      setMsg(copyFrom ? 'Roster created from the previous month — adjust the cells and publish.' : 'Roster created with every active staff member. Paint the shifts below.');
    } catch (e) { setError((e as Error).message); }
  }

  const enabledShifts = useMemo(() => {
    if (!roster) return [] as ShiftType[];
    let codes: string[] = [];
    try { codes = JSON.parse(roster.shift_codes || '[]'); } catch { codes = []; }
    const active = roster.shiftTypes.filter(s => s.is_active);
    const chosen = codes.length ? active.filter(s => codes.includes(s.code)) : active;
    return chosen.sort((a, b) => a.display_order - b.display_order);
  }, [roster]);

  const shiftByCode = useMemo(() => new Map((roster?.shiftTypes || []).map(s => [s.code, s])), [roster]);
  const md = roster ? monthDays(roster.month) : null;

  function setCell(rowId: number, day: number, code: string) {
    const key = `${rowId}:${day}`;
    setCellMap(prev => { const n = new Map(prev); if (code) n.set(key, code); else n.delete(key); return n; });
    dirty.current.add(key);
  }
  function paintCell(rowId: number, day: number) {
    if (!canEdit) return;
    setCell(rowId, day, erase ? '' : paint);
  }
  function fillRow(rowId: number) {
    if (!canEdit || !md) return;
    for (let d = 1; d <= md.days; d++) setCell(rowId, d, erase ? '' : paint);
  }
  function fillWeekends(rowId: number, code: string) {
    if (!canEdit || !md) return;
    for (let d = 1; d <= md.days; d++) if (md.isWeekend(d)) setCell(rowId, d, code);
  }

  async function save() {
    if (!roster) return;
    setError(null); setMsg(null);
    const cells = Array.from(dirty.current).map(key => { const [rowId, day] = key.split(':').map(Number); return { rowId, day, shiftCode: cellMap.get(key) || '' }; });
    try {
      await api(`/scheduling/duty-rosters/${roster.id}/cells`, { method: 'POST', body: JSON.stringify({ cells }) });
      dirty.current = new Set(); setMsg('Saved.');
    } catch (e) { setError((e as Error).message); }
  }
  async function addRow(e: FormEvent) {
    e.preventDefault(); if (!roster) return;
    try {
      await api(`/scheduling/duty-rosters/${roster.id}/rows`, { method: 'POST', body: JSON.stringify({ staffId: addStaffId || null, label: addStaffId ? null : (addLabel || null) }) });
      setAddStaffId(''); setAddLabel(''); await open(roster.id);
    } catch (e) { setError((e as Error).message); }
  }
  async function deleteRow(rowId: number) {
    if (!roster || !confirm('Remove this row?')) return;
    try { await api(`/scheduling/duty-roster-rows/${rowId}`, { method: 'DELETE' }); await open(roster.id); } catch (e) { setError((e as Error).message); }
  }
  async function act(path: string, ok: string) {
    if (!roster) return; setError(null);
    try { await api(`/scheduling/duty-rosters/${roster.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok); loadList(); await open(roster.id); } catch (e) { setError((e as Error).message); }
  }
  async function removeRoster(id: number) {
    if (!confirm('Delete this entire roster?')) return;
    try { await api(`/scheduling/duty-rosters/${id}`, { method: 'DELETE' }); if (roster?.id === id) setRoster(null); loadList(); } catch (e) { setError((e as Error).message); }
  }

  return <div>
    {error && <div className="error">{error}</div>}
    {msg && <div className="notice-ok">{msg}</div>}
    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Department Duty Roster</h3>
        {canEdit && <form onSubmit={createRoster} style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>Copy from <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)}><option value="">— blank —</option>{rosters.map(r => <option key={r.id} value={r.id}>{r.roster_number}{r.month ? ` (${monthDays(r.month).label})` : ''}</option>)}</select></label>
          <label style={{ margin: 0 }}>New monthly roster <input type="month" value={newMonth} onChange={e => setNewMonth(e.target.value)} required /></label>
          <button type="submit">+ Create roster</button>
        </form>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>A single roster for the whole department each month. Creating a blank one adds every active staff member automatically; or <strong>copy a previous month</strong> to reuse its shifts as a starting point and make only a few edits. Colours and shift codes are configured in <em>Settings → Roster &amp; Scheduling</em>.</p>
      <table className="data-table"><thead><tr><th>Number</th><th>Month</th><th>Title</th><th>Status</th><th></th></tr></thead><tbody>
        {rosters.map(r => <tr key={r.id}>
          <td>{r.roster_number}</td><td>{r.month ? monthDays(r.month).label : '—'}</td><td>{r.title}</td><td>{statusBadge(r.status)}</td>
          <td><button onClick={() => open(r.id)}>Open</button> {can('personnel', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/duty-rosters/${r.id}/print`, setError)}>Print</button>}{canEdit && <> <button className="secondary" onClick={() => removeRoster(r.id)}>Delete</button></>}</td>
        </tr>)}
        {rosters.length === 0 && <tr><td colSpan={5} className="muted">No rosters yet.{canEdit ? ' Create one for next month above.' : ''}</td></tr>}
      </tbody></table>
    </div>

    {roster && md && <div className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{roster.title} — {md.label} {statusBadge(roster.status)}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button onClick={save} disabled={dirty.current.size === 0} title="Save painted cells">Save changes</button>}
          {can('personnel', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/duty-rosters/${roster.id}/print`, setError)}>Print / PDF</button>}
          {canEdit && roster.status !== 'published' && <button className="secondary" onClick={() => act('publish', 'Published — now visible to all staff (read-only).')}>Publish</button>}
          {canEdit && roster.status !== 'approved' && <button className="secondary" onClick={() => act('approve', 'Approved.')}>Approve</button>}
          <button className="secondary" onClick={() => setRoster(null)}>Close</button>
        </div>
      </div>

      {canEdit && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 12px' }}>
        <span className="muted" style={{ fontSize: 12 }}>Paint:</span>
        {enabledShifts.map(s => <button key={s.code} type="button" onClick={() => { setPaint(s.code); setErase(false); }} title={s.label}
          style={{ padding: '4px 10px', border: paint === s.code && !erase ? '2px solid #111' : '1px solid #bbb', borderRadius: 5, background: s.bg_color, color: s.text_color, fontWeight: 700, cursor: 'pointer' }}>{s.code}</button>)}
        <button type="button" onClick={() => setErase(true)} style={{ padding: '4px 10px', border: erase ? '2px solid #111' : '1px solid #bbb', borderRadius: 5, background: '#fff', color: '#111', fontWeight: 700, cursor: 'pointer' }}>Erase</button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>Click a cell to apply · click the ✎ on a row to fill the whole row.</span>
      </div>}

      <table className="roster-grid" style={{ borderCollapse: 'collapse', fontSize: 11, tableLayout: 'fixed', width: 'max-content' }}>
        <colgroup><col style={{ width: 168 }} />{Array.from({ length: md.days }).map((_, i) => <col key={i} style={{ width: 26 }} />)}{canEdit ? <col style={{ width: 30 }} /> : null}</colgroup>
        <thead>
          <tr>
            <th style={{ ...gridHead, textAlign: 'left', color: '#c85a2a', background: '#fff', fontStyle: 'italic' }}>{md.label}</th>
            {Array.from({ length: md.days }).map((_, i) => { const d = i + 1; return <th key={d} style={{ ...gridHead, background: md.isWeekend(d) ? '#a8471f' : '#c85a2a' }}>{md.weekday(d)}</th>; })}
            {canEdit && <th style={gridHead}></th>}
          </tr>
          <tr>
            <th style={{ ...gridHead, textAlign: 'left' }}>NAMES</th>
            {Array.from({ length: md.days }).map((_, i) => { const d = i + 1; return <th key={d} style={{ ...gridHead, background: md.isWeekend(d) ? '#a8471f' : '#c85a2a' }}>{d}</th>; })}
            {canEdit && <th style={gridHead}></th>}
          </tr>
        </thead>
        <tbody>
          {roster.rows.map(row => <tr key={row.id}>
            <td style={{ ...gridCell, textAlign: 'left', fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', background: '#fff', color: '#111' }} title={row.staff_id ? (row.staff_name || '') : (row.label || '')}>
              {row.staff_id ? row.staff_name : (row.label || '—')}
            </td>
            {Array.from({ length: md.days }).map((_, i) => {
              const d = i + 1; const code = cellMap.get(`${row.id}:${d}`) || '';
              const st = code ? shiftByCode.get(code) : null;
              return <td key={d} onClick={() => paintCell(row.id, d)}
                style={{ ...gridCell, cursor: canEdit ? 'pointer' : 'default', background: st ? st.bg_color : (md.isWeekend(d) ? '#f3d9cc' : '#fff'), color: st ? st.text_color : '#111', fontWeight: 700 }}>{code}</td>;
            })}
            {canEdit && <td style={{ ...gridCell, whiteSpace: 'nowrap' }}>
              <button type="button" title="Fill whole row with the painted shift" onClick={() => fillRow(row.id)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>✎</button>
              <button type="button" title="Remove row" onClick={() => deleteRow(row.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b00' }}>×</button>
            </td>}
          </tr>)}
        </tbody>
      </table>

      <div style={{ marginTop: 10, fontSize: 12, fontFamily: 'monospace' }}>
        {enabledShifts.map(s => <span key={s.code} style={{ marginRight: 24 }}><b>{s.code}</b>: {s.label.toUpperCase()}</span>)}
      </div>

      {canEdit && <form onSubmit={addRow} style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ margin: 0 }}>Add staff row <select value={addStaffId} onChange={e => setAddStaffId(e.target.value)}><option value="">— pick staff —</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <span className="muted">or</span>
        <label style={{ margin: 0 }}>label/spacer row <input value={addLabel} onChange={e => setAddLabel(e.target.value)} placeholder="e.g. MORNING SHIFT" /></label>
        <button type="submit">+ Add row</button>
      </form>}
      {!canEdit && <p className="muted" style={{ marginTop: 12 }}>This roster is read-only for your account. It is prepared by the laboratory manager and posted in the laboratory.</p>}
    </div>}
  </div>;
}

const gridHead: CSSProperties = { border: '1px solid #6b7280', color: '#fff', background: '#c85a2a', fontWeight: 700, textAlign: 'center', padding: 2, fontSize: 10 };
const gridCell: CSSProperties = { border: '1px solid #6b7280', textAlign: 'center', padding: 1, height: 20 };

// ========================= Reassignment (memo) Board =========================
type ReRow = { id: number; unit_label: string; is_span: number; section_id: number | null; supervisor_staff_id: number | null; supervisor_text: string | null; supervisor_name?: string | null; deputy_staff_id: number | null; deputy_text: string | null; deputy_name?: string | null; members_text: string | null; member_ids: string | null; span_text: string | null; display_order: number };
type Reassign = { id: number; schedule_number: string; month: string; effective_date: string; memo_to: string; memo_from: string; memo_date: string; subject: string; intro_text: string; nb_notes: string; signatory_name: string; status: string; rows: ReRow[] };

const emptyReRow = { unitLabel: '', sectionId: '', supervisorStaffId: '', deputyStaffId: '', memberIds: [] as string[], isSpan: false, spanText: '' };

export function ReassignmentBoard({ staff, sections, canEdit }: { staff: Staff[]; sections: Section[]; canEdit: boolean }) {
  const { can } = usePermissions();
  const [list, setList] = useState<Array<{ id: number; schedule_number: string; month: string; status: string; subject: string }>>([]);
  const [sched, setSched] = useState<Reassign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newMonth, setNewMonth] = useState(nextMonthValue());
  const [copyFrom, setCopyFrom] = useState('');
  const [rowForm, setRowForm] = useState(emptyReRow);
  const staffName = (id: number | string) => staff.find(s => String(s.id) === String(id))?.fullName || '';

  function loadList() { api<typeof list>('/scheduling/reassignments').then(setList).catch(e => setError((e as Error).message)); }
  useEffect(() => { loadList(); }, []);
  async function open(id: number) { setError(null); setMsg(null); try { setSched(await api<Reassign>(`/scheduling/reassignments/${id}`)); } catch (e) { setError((e as Error).message); } }
  async function create(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { const r = await api<{ id: number }>('/scheduling/reassignments', { method: 'POST', body: JSON.stringify({ month: newMonth, copyFromId: copyFrom || undefined }) }); setCopyFrom(''); loadList(); await open(r.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function saveHeader(patch: Record<string, unknown>) {
    if (!sched) return; try { await api(`/scheduling/reassignments/${sched.id}`, { method: 'PUT', body: JSON.stringify(patch) }); await open(sched.id); setMsg('Saved.'); } catch (e) { setError((e as Error).message); }
  }
  async function addRow(e: FormEvent) {
    e.preventDefault(); if (!sched) return; if (!rowForm.unitLabel) { setError('Unit label required.'); return; }
    const membersText = rowForm.memberIds.map(staffName).filter(Boolean).join(', ');
    const body = { unitLabel: rowForm.unitLabel, sectionId: rowForm.sectionId || null, isSpan: rowForm.isSpan, spanText: rowForm.spanText,
      supervisorStaffId: rowForm.supervisorStaffId || null, deputyStaffId: rowForm.deputyStaffId || null, memberIds: rowForm.memberIds, membersText };
    try { await api(`/scheduling/reassignments/${sched.id}/rows`, { method: 'POST', body: JSON.stringify(body) }); setRowForm(emptyReRow); await open(sched.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function delRow(id: number) { if (!sched) return; try { await api(`/scheduling/reassignment-rows/${id}`, { method: 'DELETE' }); await open(sched.id); } catch (e) { setError((e as Error).message); } }
  async function act(path: string, ok: string) { if (!sched) return; try { const r = await api<{ staffReassigned?: number[] }>(`/scheduling/reassignments/${sched.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok + (r?.staffReassigned?.length ? ` ${r.staffReassigned.length} staff moved to their new unit on the register.` : '')); loadList(); await open(sched.id); } catch (e) { setError((e as Error).message); } }
  async function remove(id: number) { if (!confirm('Delete this schedule?')) return; try { await api(`/scheduling/reassignments/${id}`, { method: 'DELETE' }); if (sched?.id === id) setSched(null); loadList(); } catch (e) { setError((e as Error).message); } }

  return <div>
    {error && <div className="error">{error}</div>}
    {msg && <div className="notice-ok">{msg}</div>}
    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Unit / Staff Reassignment Schedule</h3>
        {canEdit && <form onSubmit={create} style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>Copy from <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)}><option value="">— blank —</option>{list.map(s => <option key={s.id} value={s.id}>{s.schedule_number}{s.month ? ` (${monthDays(s.month).label})` : ''}</option>)}</select></label>
          <label style={{ margin: 0 }}>New schedule <input type="month" value={newMonth} onChange={e => setNewMonth(e.target.value)} required /></label>
          <button type="submit">+ Create</button>
        </form>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>The monthly memo re-assigning staff to units (supervisor, deputy and members). Prepared by the laboratory manager. Creating one pre-fills the standard NB notes — or <strong>copy last month</strong> and edit a few rows. When a row is linked to a unit, publishing moves those staff to that unit on the master register.</p>
      <table className="data-table"><thead><tr><th>Number</th><th>Month</th><th>Subject</th><th>Status</th><th></th></tr></thead><tbody>
        {list.map(s => <tr key={s.id}><td>{s.schedule_number}</td><td>{s.month ? monthDays(s.month).label : '—'}</td><td>{s.subject}</td><td>{statusBadge(s.status)}</td>
          <td><button onClick={() => open(s.id)}>Open</button> {can('personnel', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/reassignments/${s.id}/print`, setError)}>Print</button>}{canEdit && <> <button className="secondary" onClick={() => remove(s.id)}>Delete</button></>}</td></tr>)}
        {list.length === 0 && <tr><td colSpan={5} className="muted">No reassignment schedules yet.</td></tr>}
      </tbody></table>
    </div>

    {sched && <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{sched.schedule_number} {statusBadge(sched.status)}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can('personnel', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/reassignments/${sched.id}/print`, setError)}>Print / PDF</button>}
          {canEdit && sched.status !== 'published' && <button className="secondary" onClick={() => act('publish', 'Published to all staff.')}>Publish</button>}
          {canEdit && sched.status !== 'approved' && <button className="secondary" onClick={() => act('approve', 'Approved.')}>Approve</button>}
          <button className="secondary" onClick={() => setSched(null)}>Close</button>
        </div>
      </div>

      {canEdit && <div className="form-grid" style={{ marginBottom: 12 }}>
        <label>Memo TO<input defaultValue={sched.memo_to} onBlur={e => saveHeader({ memoTo: e.target.value })} /></label>
        <label>Memo FROM<input defaultValue={sched.memo_from} onBlur={e => saveHeader({ memoFrom: e.target.value })} /></label>
        <label>Date<input type="date" defaultValue={sched.memo_date} onBlur={e => saveHeader({ memoDate: e.target.value })} /></label>
        <label>Subject<input defaultValue={sched.subject} onBlur={e => saveHeader({ subject: e.target.value })} /></label>
        <label>Effective date<input type="date" defaultValue={sched.effective_date} onBlur={e => saveHeader({ effectiveDate: e.target.value })} /></label>
        <label>Signatory name<input defaultValue={sched.signatory_name || ''} onBlur={e => saveHeader({ signatoryName: e.target.value })} placeholder="e.g. Dr Paul Ntiamoah" /></label>
        <label style={{ gridColumn: '1 / -1' }}>Intro line<input defaultValue={sched.intro_text || ''} onBlur={e => saveHeader({ introText: e.target.value })} /></label>
        <label style={{ gridColumn: '1 / -1' }}>NB notes (one per line)<textarea defaultValue={sched.nb_notes || ''} rows={4} onBlur={e => saveHeader({ nbNotes: e.target.value })} /></label>
      </div>}

      <table className="data-table"><thead><tr><th>UNIT</th><th>SUPERVISOR</th><th>DEPUTY SUPERVISOR</th><th>MEMBER(S)</th>{canEdit && <th></th>}</tr></thead><tbody>
        {sched.rows.map(r => <tr key={r.id}>
          <td><strong>{r.unit_label}</strong></td>
          {r.is_span ? <td colSpan={3}>{r.span_text || r.members_text || ''}</td> : <>
            <td>{r.supervisor_text || r.supervisor_name || '—'}</td>
            <td>{r.deputy_text || r.deputy_name || '—'}</td>
            <td>{r.members_text || '—'}</td>
          </>}
          {canEdit && <td><button className="secondary" onClick={() => delRow(r.id)}>×</button></td>}
        </tr>)}
        {sched.rows.length === 0 && <tr><td colSpan={canEdit ? 5 : 4} className="muted">No unit rows yet.</td></tr>}
      </tbody></table>

      {canEdit && <form onSubmit={addRow} className="form-grid" style={{ marginTop: 12 }}>
        <label>Link to unit / section<select value={rowForm.sectionId} onChange={e => { const sid = e.target.value; const nm = sections.find(s => String(s.id) === sid)?.name; setRowForm({ ...rowForm, sectionId: sid, unitLabel: rowForm.unitLabel || nm || '' }); }}><option value="">— not linked —</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Unit label (as printed)<input value={rowForm.unitLabel} onChange={e => setRowForm({ ...rowForm, unitLabel: e.target.value })} placeholder="e.g. Microbiology & GeneXpert" required /></label>
        <label className="check-inline"><input type="checkbox" checked={rowForm.isSpan} onChange={e => setRowForm({ ...rowForm, isSpan: e.target.checked })} /> Single wide cell (e.g. QMS Desk, Manager)</label>
        {rowForm.isSpan ? <label style={{ gridColumn: '1 / -1' }}>People (free text)<input value={rowForm.spanText} onChange={e => setRowForm({ ...rowForm, spanText: e.target.value })} placeholder="e.g. Evans Agyapong Owusu, Nicholas Afriyie" /></label> : <>
          <label>Supervisor<select value={rowForm.supervisorStaffId} onChange={e => setRowForm({ ...rowForm, supervisorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label>Deputy supervisor<select value={rowForm.deputyStaffId} onChange={e => setRowForm({ ...rowForm, deputyStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          <label style={{ gridColumn: '1 / -1' }}>Member(s) — select one or more (Ctrl/Cmd-click)
            <select multiple value={rowForm.memberIds} size={Math.min(6, Math.max(3, staff.length))} onChange={e => setRowForm({ ...rowForm, memberIds: Array.from(e.target.selectedOptions).map(o => o.value) })} style={{ minHeight: 90 }}>
              {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
          </label>
          {rowForm.memberIds.length > 0 && <div className="muted" style={{ gridColumn: '1 / -1', fontSize: 12 }}>Members: {rowForm.memberIds.map(staffName).filter(Boolean).join(', ')}</div>}
        </>}
        <button type="submit">+ Add unit row</button>
      </form>}
      {!canEdit && <p className="muted" style={{ marginTop: 12 }}>Read-only. Prepared by the laboratory manager.</p>}
    </div>}
  </div>;
}

// ========================= Bench Schedule Board =========================
type BenchRow = { id: number; staff_id: number | null; label: string | null; staff_name?: string | null; display_order: number };
type BenchCell = { row_id: number; day: number; value: string | null };
type BenchDef = { id: number; name: string; code: string | null; display_order: number; is_active: number };
type Bench = { id: number; schedule_number: string; section_id: number; section_name: string; month: string; title: string; status: string; rows: BenchRow[]; cells: BenchCell[]; benches: BenchDef[] };

export function BenchScheduleBoard({ sections, canEdit }: { sections: Section[]; canEdit: boolean }) {
  const { can } = usePermissions();
  const [list, setList] = useState<Array<{ id: number; schedule_number: string; section_id: number; section_name: string; month: string; status: string }>>([]);
  const [bs, setBs] = useState<Bench | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ sectionId: '', month: nextMonthValue() });
  const [copyFrom, setCopyFrom] = useState('');
  const [paint, setPaint] = useState('');
  const [cellMap, setCellMap] = useState<Map<string, string>>(new Map());
  const dirty = useRef<Set<string>>(new Set());

  function loadList() { api<typeof list>('/scheduling/bench-schedules').then(setList).catch(e => setError((e as Error).message)); }
  useEffect(() => { loadList(); }, []);
  // Bench schedules for the unit chosen in the create form, offered as templates.
  const templatesForSection = form.sectionId ? list.filter(s => String(s.section_id) === form.sectionId) : list;
  async function open(id: number) {
    setError(null); setMsg(null);
    try {
      const b = await api<Bench>(`/scheduling/bench-schedules/${id}`);
      setBs(b); const m = new Map<string, string>(); for (const c of b.cells) if (c.value) m.set(`${c.row_id}:${c.day}`, c.value); setCellMap(m); dirty.current = new Set();
      setPaint(b.benches[0]?.code || b.benches[0]?.name || '');
    } catch (e) { setError((e as Error).message); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!form.sectionId) { setError('Pick a unit.'); return; }
    try { const r = await api<{ id: number }>('/scheduling/bench-schedules', { method: 'POST', body: JSON.stringify({ ...form, copyFromId: copyFrom || undefined }) }); setCopyFrom(''); loadList(); await open(r.id); }
    catch (e) { setError((e as Error).message); }
  }
  const md = bs ? monthDays(bs.month) : null;
  function setCell(rowId: number, day: number, v: string) { const key = `${rowId}:${day}`; setCellMap(prev => { const n = new Map(prev); if (v) n.set(key, v); else n.delete(key); return n; }); dirty.current.add(key); }
  async function save() {
    if (!bs) return; setError(null);
    const cells = Array.from(dirty.current).map(key => { const [rowId, day] = key.split(':').map(Number); return { rowId, day, value: cellMap.get(key) || '' }; });
    try { await api(`/scheduling/bench-schedules/${bs.id}/cells`, { method: 'POST', body: JSON.stringify({ cells }) }); dirty.current = new Set(); setMsg('Saved.'); } catch (e) { setError((e as Error).message); }
  }
  async function act(path: string, ok: string) { if (!bs) return; try { await api(`/scheduling/bench-schedules/${bs.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok); loadList(); await open(bs.id); } catch (e) { setError((e as Error).message); } }
  async function remove(id: number) { if (!confirm('Delete this bench schedule?')) return; try { await api(`/scheduling/bench-schedules/${id}`, { method: 'DELETE' }); if (bs?.id === id) setBs(null); loadList(); } catch (e) { setError((e as Error).message); } }

  return <div>
    {error && <div className="error">{error}</div>}
    {msg && <div className="notice-ok">{msg}</div>}
    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Unit Bench Schedules</h3>
        {canEdit && <form onSubmit={create} style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={form.sectionId} onChange={e => { setForm({ ...form, sectionId: e.target.value }); setCopyFrom(''); }} required><option value="">— unit —</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input type="month" value={form.month} onChange={e => setForm({ ...form, month: e.target.value })} required />
          <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)} title="Copy a previous schedule as a template"><option value="">— blank —</option>{templatesForSection.map(s => <option key={s.id} value={s.id}>copy {s.schedule_number}{s.month ? ` (${monthDays(s.month).label})` : ''}</option>)}</select>
          <button type="submit">+ Create</button>
        </form>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Each unit assigns its staff to benches/workspaces per day. Benches are configured in <em>Settings → Section/Unit Configuration → Benches</em>. Unit heads prepare these for their own unit — or <strong>copy last month</strong> and tweak.</p>
      <table className="data-table"><thead><tr><th>Number</th><th>Unit</th><th>Month</th><th>Status</th><th></th></tr></thead><tbody>
        {list.map(s => <tr key={s.id}><td>{s.schedule_number}</td><td>{s.section_name}</td><td>{s.month ? monthDays(s.month).label : '—'}</td><td>{statusBadge(s.status)}</td>
          <td><button onClick={() => open(s.id)}>Open</button> {can('personnel', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/bench-schedules/${s.id}/print`, setError)}>Print</button>}{canEdit && <> <button className="secondary" onClick={() => remove(s.id)}>Delete</button></>}</td></tr>)}
        {list.length === 0 && <tr><td colSpan={5} className="muted">No bench schedules yet.</td></tr>}
      </tbody></table>
    </div>

    {bs && md && <div className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{bs.section_name} — {md.label} {statusBadge(bs.status)}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button onClick={save} disabled={dirty.current.size === 0}>Save changes</button>}
          {can('personnel', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/bench-schedules/${bs.id}/print`, setError)}>Print / PDF</button>}
          {canEdit && bs.status !== 'published' && <button className="secondary" onClick={() => act('publish', 'Published to all staff.')}>Publish</button>}
          {canEdit && bs.status !== 'approved' && <button className="secondary" onClick={() => act('approve', 'Approved.')}>Approve</button>}
          <button className="secondary" onClick={() => setBs(null)}>Close</button>
        </div>
      </div>
      {bs.benches.length === 0 ? <div className="notice">No benches configured for this unit yet. Add them in <em>Settings → Section/Unit Configuration → Benches</em>.</div> : canEdit && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 12px' }}>
        <span className="muted" style={{ fontSize: 12 }}>Paint bench:</span>
        {bs.benches.filter(b => b.is_active).map(b => { const v = b.code || b.name; return <button key={b.id} type="button" onClick={() => setPaint(v)} title={b.name} style={{ padding: '4px 10px', border: paint === v ? '2px solid #111' : '1px solid #bbb', borderRadius: 5, background: '#eef2f7', color: '#111', cursor: 'pointer', fontWeight: 700 }}>{v}</button>; })}
        <button type="button" onClick={() => setPaint('')} style={{ padding: '4px 10px', border: paint === '' ? '2px solid #111' : '1px solid #bbb', borderRadius: 5, background: '#fff', color: '#111', fontWeight: 700, cursor: 'pointer' }}>Erase</button>
      </div>}

      <table style={{ borderCollapse: 'collapse', fontSize: 11, tableLayout: 'fixed', width: 'max-content' }}>
        <colgroup><col style={{ width: 168 }} />{Array.from({ length: md.days }).map((_, i) => <col key={i} style={{ width: 26 }} />)}</colgroup>
        <thead>
          <tr><th style={{ ...gridHead, textAlign: 'left', background: '#fff', color: '#c85a2a', fontStyle: 'italic' }}>{md.label}</th>{Array.from({ length: md.days }).map((_, i) => { const d = i + 1; return <th key={d} style={{ ...gridHead, background: md.isWeekend(d) ? '#a8471f' : '#c85a2a' }}>{md.weekday(d)}</th>; })}</tr>
          <tr><th style={{ ...gridHead, textAlign: 'left' }}>STAFF</th>{Array.from({ length: md.days }).map((_, i) => { const d = i + 1; return <th key={d} style={{ ...gridHead, background: md.isWeekend(d) ? '#a8471f' : '#c85a2a' }}>{d}</th>; })}</tr>
        </thead>
        <tbody>
          {bs.rows.map(row => <tr key={row.id}>
            <td style={{ ...gridCell, textAlign: 'left', fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', background: '#fff', color: '#111' }}>{row.staff_id ? row.staff_name : row.label}</td>
            {Array.from({ length: md.days }).map((_, i) => { const d = i + 1; const v = cellMap.get(`${row.id}:${d}`) || ''; return <td key={d} onClick={() => canEdit && setCell(row.id, d, paint)} style={{ ...gridCell, cursor: canEdit ? 'pointer' : 'default', background: md.isWeekend(d) ? '#f3d9cc' : '#fff', color: '#0b1f33', fontWeight: 800, fontSize: 11 }}>{v}</td>; })}
          </tr>)}
        </tbody>
      </table>
      {bs.benches.length > 0 && <div style={{ marginTop: 10, fontSize: 12, fontFamily: 'monospace' }}>{bs.benches.map(b => <span key={b.id} style={{ marginRight: 20 }}><b>{b.code || b.name}</b>: {b.name}</span>)}</div>}
      {!canEdit && <p className="muted" style={{ marginTop: 12 }}>Read-only.</p>}
    </div>}
  </div>;
}
