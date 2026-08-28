import { FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, API_BASE, getToken, errorText } from '../services/api';
import type { Staff, Section, ActingUnitHead, UnitSupervisor, UnitSupervisors } from '../../shared/types/api';
import { usePermissions } from '../hooks/usePermissions';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';

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
  } catch (e) { onError(errorText(e)); }
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

  function loadList() { api<typeof rosters>('/scheduling/duty-rosters').then(setRosters).catch(e => setError(errorText(e))); }
  useEffect(() => { loadList(); }, []);

  async function open(id: number) {
    setError(null); setMsg(null);
    try {
      const r = await api<Roster>(`/scheduling/duty-rosters/${id}`);
      setRoster(r);
      const m = new Map<string, string>();
      for (const c of r.cells) if (c.shift_code) m.set(`${c.row_id}:${c.day}`, c.shift_code);
      setCellMap(m); dirty.current = new Set();
    } catch (e) { setError(errorText(e)); }
  }

  async function createRoster(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      const r = await api<{ id: number }>('/scheduling/duty-rosters', { method: 'POST', body: JSON.stringify({ month: newMonth, copyFromId: copyFrom || undefined }) });
      setCopyFrom(''); loadList(); await open(r.id);
      setMsg(copyFrom ? 'Roster created from the previous month — adjust the cells and publish.' : 'Roster created with every active staff member. Paint the shifts below.');
    } catch (e) { setError(errorText(e)); }
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
    } catch (e) { setError(errorText(e)); }
  }
  async function addRow(e: FormEvent) {
    e.preventDefault(); if (!roster) return;
    try {
      await api(`/scheduling/duty-rosters/${roster.id}/rows`, { method: 'POST', body: JSON.stringify({ staffId: addStaffId || null, label: addStaffId ? null : (addLabel || null) }) });
      setAddStaffId(''); setAddLabel(''); await open(roster.id);
    } catch (e) { setError(errorText(e)); }
  }
  async function deleteRow(rowId: number) {
    if (!roster || !confirm('Remove this row?')) return;
    try { await api(`/scheduling/duty-roster-rows/${rowId}`, { method: 'DELETE' }); await open(roster.id); } catch (e) { setError(errorText(e)); }
  }
  async function act(path: string, ok: string) {
    if (!roster) return; setError(null);
    try { await api(`/scheduling/duty-rosters/${roster.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok); loadList(); await open(roster.id); } catch (e) { setError(errorText(e)); }
  }
  async function removeRoster(id: number) {
    if (!confirm('Delete this entire roster?')) return;
    try { await api(`/scheduling/duty-rosters/${id}`, { method: 'DELETE' }); if (roster?.id === id) setRoster(null); loadList(); } catch (e) { setError(errorText(e)); }
  }

  return <div>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
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
          <td><button onClick={() => open(r.id)}>Open</button> {can('personnel.rosters', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/duty-rosters/${r.id}/print`, setError)}>Print</button>}{canEdit && <> <button className="secondary" onClick={() => removeRoster(r.id)}>Delete</button></>}</td>
        </tr>)}
        {rosters.length === 0 && <tr><td colSpan={5} className="muted">No rosters yet.{canEdit ? ' Create one for next month above.' : ''}</td></tr>}
      </tbody></table>
    </div>

    {roster && md && <div className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{roster.title} — {md.label} {statusBadge(roster.status)}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button onClick={save} disabled={dirty.current.size === 0} title="Save painted cells">Save changes</button>}
          {can('personnel.rosters', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/duty-rosters/${roster.id}/print`, setError)}>Print / PDF</button>}
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
        <label style={{ margin: 0 }}>label/spacer row <TextField value={addLabel} onValue={nextValue => setAddLabel(nextValue)} placeholder="e.g. MORNING SHIFT" /></label>
        <button type="submit">+ Add row</button>
      </form>}
      {!canEdit && <p className="muted" style={{ marginTop: 12 }}>This roster is read-only for your account. It is prepared by the laboratory manager and posted in the laboratory.</p>}
    </div>}
  </div>;
}

const gridHead: CSSProperties = { border: '1px solid #6b7280', color: '#fff', background: '#c85a2a', fontWeight: 700, textAlign: 'center', padding: 2, fontSize: 10 };
const gridCell: CSSProperties = { border: '1px solid #6b7280', textAlign: 'center', padding: 1, height: 20 };

// ========================= Reassignment (memo) Board =========================
type ReRow = { id: number; unit_label: string; is_span: number; section_id: number | null; supervisor_staff_id: number | null; supervisor_text: string | null; supervisor_name?: string | null; supervisor_is_acting?: number; supervisor_locked?: number; deputy_staff_id: number | null; deputy_text: string | null; deputy_name?: string | null; members_text: string | null; member_ids: string | null; span_text: string | null; display_order: number };
type Reassign = { id: number; schedule_number: string; month: string; effective_date: string; memo_to: string; memo_from: string; memo_date: string; subject: string; intro_text: string; nb_notes: string; signatory_name: string; status: string; rows: ReRow[] };

const emptyReRow = { unitLabel: '', sectionId: '', supervisorStaffId: '', deputyStaffId: '', memberIds: [] as string[], isSpan: false, spanText: '' };

function MemberPicker({ staff, selected, exclude = [], onChange }: { staff: Staff[]; selected: string[]; exclude?: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const ex = new Set(exclude.filter(Boolean).map(String));
  const list = staff.filter(s => !ex.has(String(s.id)) && s.fullName.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  const nameOf = (id: string) => staff.find(s => String(s.id) === id)?.fullName || '';
  return <div className="member-picker">
    <span className="rf-cap">Members{selected.length ? ` · ${selected.length}` : ''}</span>
    {selected.length > 0 && <div className="mp-chips">{selected.map(id => <span key={id} className="mp-chip">{nameOf(id)}<button type="button" onClick={() => toggle(id)} aria-label="Remove">×</button></span>)}</div>}
    <TextField className="mp-search" value={q} onValue={nextValue => setQ(nextValue)} placeholder="Search staff…" />
    <div className="mp-list">
      {list.map(s => { const id = String(s.id); const on = selected.includes(id); return <label key={id} className={`mp-item${on ? ' on' : ''}`}><input type="checkbox" checked={on} onChange={() => toggle(id)} /><span>{s.fullName}</span></label>; })}
      {list.length === 0 && <div className="muted mp-empty">No match.</div>}
    </div>
  </div>;
}

export function ReassignmentBoard({ staff, sections, canEdit, onNavigate }: { staff: Staff[]; sections: Section[]; canEdit: boolean; onNavigate?: (tab: string) => void }) {
  const { can } = usePermissions();
  const [list, setList] = useState<Array<{ id: number; schedule_number: string; month: string; status: string; subject: string }>>([]);
  const [sched, setSched] = useState<Reassign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newMonth, setNewMonth] = useState(nextMonthValue());
  const [copyFrom, setCopyFrom] = useState('');
  const [editingRow, setEditingRow] = useState<ReRow | null>(null);
  const [heads, setHeads] = useState<Record<number, UnitSupervisor>>({});

  function loadList() { api<typeof list>('/scheduling/reassignments').then(setList).catch(e => setError(errorText(e))); }
  useEffect(() => { loadList(); }, []);
  useEffect(() => { api<UnitSupervisors>('/scheduling/unit-supervisors').then(r => setHeads(Object.fromEntries(r.units.map(u => [u.section_id, u])))).catch(() => setHeads({})); }, []);
  async function open(id: number) { setError(null); setMsg(null); setEditingRow(null); try { setSched(await api<Reassign>(`/scheduling/reassignments/${id}`)); } catch (e) { setError(errorText(e)); } }
  async function create(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { const r = await api<{ id: number }>('/scheduling/reassignments', { method: 'POST', body: JSON.stringify({ month: newMonth, copyFromId: copyFrom || undefined }) }); setCopyFrom(''); loadList(); await open(r.id); }
    catch (e) { setError(errorText(e)); }
  }
  async function saveHeader(patch: Record<string, unknown>) {
    if (!sched) return; try { await api(`/scheduling/reassignments/${sched.id}`, { method: 'PUT', body: JSON.stringify(patch) }); await open(sched.id); setMsg('Saved.'); } catch (e) { setError(errorText(e)); }
  }
  // Add or update a unit row — same form, in place, so an existing row can be
  // corrected rather than deleted and retyped.
  async function submitRow(body: Record<string, unknown>, editingId: number | null) {
    if (!sched) return;
    setError(null);
    try {
      if (editingId) await api(`/scheduling/reassignment-rows/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api(`/scheduling/reassignments/${sched.id}/rows`, { method: 'POST', body: JSON.stringify(body) });
      setEditingRow(null); await open(sched.id);
    } catch (e) { setError(errorText(e)); throw e; }
  }
  async function delRow(id: number) { if (!sched) return; try { await api(`/scheduling/reassignment-rows/${id}`, { method: 'DELETE' }); if (editingRow?.id === id) setEditingRow(null); await open(sched.id); } catch (e) { setError(errorText(e)); } }
  async function act(path: string, ok: string) { if (!sched) return; try { const r = await api<{ staffReassigned?: number[] }>(`/scheduling/reassignments/${sched.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok + (r?.staffReassigned?.length ? ` ${r.staffReassigned.length} staff moved to their new unit on the register.` : '')); loadList(); await open(sched.id); } catch (e) { setError(errorText(e)); } }
  async function remove(id: number) { if (!confirm('Delete this schedule?')) return; try { await api(`/scheduling/reassignments/${id}`, { method: 'DELETE' }); if (sched?.id === id) setSched(null); loadList(); } catch (e) { setError(errorText(e)); } }

  return <div>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
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
          <td><button onClick={() => open(s.id)}>Open</button> {can('personnel.rosters', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/reassignments/${s.id}/print`, setError)}>Print</button>}{canEdit && <> <button className="secondary" onClick={() => remove(s.id)}>Delete</button></>}</td></tr>)}
        {list.length === 0 && <tr><td colSpan={5} className="muted">No reassignment schedules yet.</td></tr>}
      </tbody></table>
    </div>

    {sched && <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{sched.schedule_number} {statusBadge(sched.status)}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can('personnel.rosters', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/reassignments/${sched.id}/print`, setError)}>Print / PDF</button>}
          {canEdit && sched.status !== 'published' && <button className="secondary" onClick={() => act('publish', 'Published to all staff.')}>Publish</button>}
          {canEdit && <button className="secondary" onClick={() => act('apply-to-register', 'Applied.')}>Apply to register</button>}
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

      <table className="data-table re-table"><thead><tr><th>Unit</th><th>Supervisor</th><th>Deputy</th><th>Member(s)</th>{canEdit && <th></th>}</tr></thead><tbody>
        {sched.rows.map(r => <tr key={r.id} className={editingRow?.id === r.id ? 'row-editing' : ''}>
          <td><strong>{r.unit_label}</strong></td>
          {r.is_span ? <td colSpan={3}>{r.span_text || r.members_text || ''}</td> : <>
            <td>{r.supervisor_text || r.supervisor_name || '—'}{r.supervisor_is_acting ? <span className="badge acting" style={{ marginLeft: 6 }}>Acting</span> : null}</td>
            <td>{r.deputy_text || r.deputy_name || '—'}</td>
            <td>{r.members_text || '—'}</td>
          </>}
          {canEdit && <td className="re-row-actions">
            <button className="secondary tiny" onClick={() => setEditingRow(r)}>Edit</button>
            <button className="secondary tiny" onClick={() => delRow(r.id)} aria-label="Remove row">×</button>
          </td>}
        </tr>)}
        {sched.rows.length === 0 && <tr><td colSpan={canEdit ? 5 : 4} className="muted">No unit rows yet.</td></tr>}
      </tbody></table>

      {canEdit && <ReRowForm staff={staff} sections={sections} heads={heads} editing={editingRow}
        onSubmit={submitRow} onCancel={() => setEditingRow(null)}
        onNavigateSupervisors={onNavigate ? () => onNavigate('Unit Supervisors') : undefined} />}
      {!canEdit && <p className="muted" style={{ marginTop: 12 }}>Read-only.</p>}
    </div>}
  </div>;
}

// The add / edit row form, kept in its own component so a keystroke only
// re-renders the form — not the whole board and its tables. (A controlled input
// living on a large parent is what made the box feel frozen: every character
// reconciled the entire page before it could paint.)
function ReRowForm({ staff, sections, heads, editing, onSubmit, onCancel, onNavigateSupervisors }: {
  staff: Staff[]; sections: Section[]; heads: Record<number, UnitSupervisor>;
  editing: ReRow | null;
  onSubmit: (body: Record<string, unknown>, editingId: number | null) => Promise<void>;
  onCancel: () => void;
  onNavigateSupervisors?: () => void;
}) {
  const [form, setForm] = useState(emptyReRow);
  const staffName = (id: number | string) => staff.find(s => String(s.id) === String(id))?.fullName || '';

  useEffect(() => {
    if (!editing) { setForm(emptyReRow); return; }
    let members: string[] = [];
    try { members = JSON.parse(editing.member_ids || '[]').map((x: unknown) => String(x)); } catch { members = []; }
    setForm({
      unitLabel: editing.unit_label || '', sectionId: editing.section_id ? String(editing.section_id) : '',
      supervisorStaffId: editing.supervisor_staff_id ? String(editing.supervisor_staff_id) : '',
      deputyStaffId: editing.deputy_staff_id ? String(editing.deputy_staff_id) : '',
      memberIds: members, isSpan: !!editing.is_span, spanText: editing.span_text || '',
    });
  }, [editing]);

  const linkedHead = form.sectionId ? heads[Number(form.sectionId)] : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.unitLabel.trim()) return;
    const membersText = form.memberIds.map(staffName).filter(Boolean).join(', ');
    const body = { unitLabel: form.unitLabel, sectionId: form.sectionId || null, isSpan: form.isSpan, spanText: form.spanText,
      supervisorStaffId: form.supervisorStaffId || null, deputyStaffId: form.deputyStaffId || null, memberIds: form.memberIds, membersText };
    try { await onSubmit(body, editing ? editing.id : null); setForm(emptyReRow); } catch { /* parent shows the error */ }
  }

  return <form onSubmit={submit} className={`re-rowform${editing ? ' editing' : ''}`}>
    {editing && <div className="rf-editing-tag">Editing <strong>{editing.unit_label}</strong></div>}
    <div className="rf-line">
      <label className="rf-unit">Unit
        <select value={form.sectionId} onChange={e => { const sid = e.target.value; const nm = sections.find(s => String(s.id) === sid)?.name; setForm({ ...form, sectionId: sid, unitLabel: sid ? (nm || form.unitLabel) : form.unitLabel }); }}>
          <option value="">— not linked —</option>
          {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="rf-label">Label as printed
        <TextField value={form.unitLabel} onValue={nextValue => setForm({ ...form, unitLabel: nextValue })} placeholder="e.g. Microbiology & GeneXpert" required />
      </label>
      <label className="rf-span check-inline"><input type="checkbox" checked={form.isSpan} onChange={e => setForm({ ...form, isSpan: e.target.checked })} /> Wide cell</label>
    </div>

    {form.isSpan ? <label className="rf-full">People<TextField value={form.spanText} onValue={nextValue => setForm({ ...form, spanText: nextValue })} placeholder="e.g. Evans Owusu, Nicholas Afriyie" /></label> : <>
      <div className="rf-line">
        <div className="rf-sup">
          <span className="rf-cap">{linkedHead?.acting ? 'Acting Unit Supervisor' : 'Supervisor'}</span>
          {form.sectionId
            ? <div className="rf-locked">
                {linkedHead?.effective_name || '— no head set —'}{linkedHead?.acting && <span className="badge acting">Acting</span>}
                {onNavigateSupervisors && <button type="button" className="link-button rf-change" onClick={onNavigateSupervisors}>Change? Appoint an acting supervisor →</button>}
              </div>
            : <select value={form.supervisorStaffId} onChange={e => setForm({ ...form, supervisorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select>}
        </div>
        <label className="rf-dep">Deputy
          <select value={form.deputyStaffId} onChange={e => setForm({ ...form, deputyStaffId: e.target.value })}><option value="">—</option>{staff.filter(s => String(s.id) !== String(linkedHead?.effective_staff_id ?? '')).map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select>
        </label>
      </div>
      <MemberPicker staff={staff} selected={form.memberIds} exclude={[String(linkedHead?.effective_staff_id ?? ''), form.deputyStaffId]} onChange={ids => setForm({ ...form, memberIds: ids })} />
    </>}
    <div className="rf-actions">
      {editing && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
      <button type="submit">{editing ? 'Save changes' : 'Add row'}</button>
    </div>
  </form>;
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

  function loadList() { api<typeof list>('/scheduling/bench-schedules').then(setList).catch(e => setError(errorText(e))); }
  useEffect(() => { loadList(); }, []);
  // Bench schedules for the unit chosen in the create form, offered as templates.
  const templatesForSection = form.sectionId ? list.filter(s => String(s.section_id) === form.sectionId) : list;
  async function open(id: number) {
    setError(null); setMsg(null);
    try {
      const b = await api<Bench>(`/scheduling/bench-schedules/${id}`);
      setBs(b); const m = new Map<string, string>(); for (const c of b.cells) if (c.value) m.set(`${c.row_id}:${c.day}`, c.value); setCellMap(m); dirty.current = new Set();
      setPaint(b.benches[0]?.code || b.benches[0]?.name || '');
    } catch (e) { setError(errorText(e)); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!form.sectionId) { setError('Pick a unit.'); return; }
    try { const r = await api<{ id: number }>('/scheduling/bench-schedules', { method: 'POST', body: JSON.stringify({ ...form, copyFromId: copyFrom || undefined }) }); setCopyFrom(''); loadList(); await open(r.id); }
    catch (e) { setError(errorText(e)); }
  }
  const md = bs ? monthDays(bs.month) : null;
  function setCell(rowId: number, day: number, v: string) { const key = `${rowId}:${day}`; setCellMap(prev => { const n = new Map(prev); if (v) n.set(key, v); else n.delete(key); return n; }); dirty.current.add(key); }
  async function save() {
    if (!bs) return; setError(null);
    const cells = Array.from(dirty.current).map(key => { const [rowId, day] = key.split(':').map(Number); return { rowId, day, value: cellMap.get(key) || '' }; });
    try { await api(`/scheduling/bench-schedules/${bs.id}/cells`, { method: 'POST', body: JSON.stringify({ cells }) }); dirty.current = new Set(); setMsg('Saved.'); } catch (e) { setError(errorText(e)); }
  }
  async function act(path: string, ok: string) { if (!bs) return; try { await api(`/scheduling/bench-schedules/${bs.id}/${path}`, { method: 'POST', body: JSON.stringify({}) }); setMsg(ok); loadList(); await open(bs.id); } catch (e) { setError(errorText(e)); } }
  async function remove(id: number) { if (!confirm('Delete this bench schedule?')) return; try { await api(`/scheduling/bench-schedules/${id}`, { method: 'DELETE' }); if (bs?.id === id) setBs(null); loadList(); } catch (e) { setError(errorText(e)); } }

  return <div>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}
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
          <td><button onClick={() => open(s.id)}>Open</button> {can('personnel.rosters', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/bench-schedules/${s.id}/print`, setError)}>Print</button>}{canEdit && <> <button className="secondary" onClick={() => remove(s.id)}>Delete</button></>}</td></tr>)}
        {list.length === 0 && <tr><td colSpan={5} className="muted">No bench schedules yet.</td></tr>}
      </tbody></table>
    </div>

    {bs && md && <div className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{bs.section_name} — {md.label} {statusBadge(bs.status)}</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button onClick={save} disabled={dirty.current.size === 0}>Save changes</button>}
          {can('personnel.rosters', 'print') && <button className="secondary" onClick={() => openPrintPage(`/scheduling/bench-schedules/${bs.id}/print`, setError)}>Print / PDF</button>}
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

// ========================= Unit supervisors & acting heads =========================
// The substantive head of a unit lives on the unit record (Settings → Sections).
// This board shows who is effectively in charge of each unit today, and lets a
// manager appoint an Acting Unit Head for a fixed period when a head is away.
// The acting role reverts on its own once the period ends — the server judges it
// in force purely by today's date.
const emptyActing = { sectionId: '', actingStaffId: '', startDate: '', endDate: '', reason: '' };

export function ActingSupervisorsBoard({ staff, sections, canEdit }: { staff: Staff[]; sections: Section[]; canEdit: boolean }) {
  const { can } = usePermissions();
  const mayDelete = can('personnel.rosters', 'void_archive');
  const mayPrint = can('personnel.rosters', 'print');
  const [sups, setSups] = useState<UnitSupervisors | null>(null);
  const [appts, setAppts] = useState<ActingUnitHead[]>([]);
  const [form, setForm] = useState(emptyActing);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    api<UnitSupervisors>('/scheduling/unit-supervisors').then(setSups).catch(e => setError(errorText(e)));
    api<ActingUnitHead[]>('/scheduling/acting-unit-heads').then(setAppts).catch(e => setError(errorText(e)));
  }
  useEffect(() => { load(); }, []);

  async function create(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      await api('/scheduling/acting-unit-heads', { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyActing); setShowForm(false); setMsg('Acting unit head appointed.'); load();
    } catch (err) { setError(errorText(err)); }
  }
  async function endNow(id: number) {
    setError(null); setMsg(null);
    try { await api(`/scheduling/acting-unit-heads/${id}/end`, { method: 'POST', body: JSON.stringify({}) }); setMsg('Acting period ended; the substantive head resumes.'); load(); }
    catch (err) { setError(errorText(err)); }
  }
  async function remove(id: number) {
    if (!confirm('Delete this acting appointment for good?')) return;
    setError(null);
    try { await api(`/scheduling/acting-unit-heads/${id}`, { method: 'DELETE' }); load(); }
    catch (err) { setError(errorText(err)); }
  }

  const startForSection = (sectionId: number | null | undefined) => {
    setForm({ ...emptyActing, sectionId: sectionId ? String(sectionId) : '' });
    setShowForm(true); setMsg(null); setError(null);
  };

  return <div>
    {error && <Notice kind="error">{error}</Notice>}
    {msg && <Notice kind="success">{msg}</Notice>}

    <div className="card">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Unit supervisors</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {mayPrint && <button className="secondary" onClick={() => openPrintPage('/scheduling/unit-supervisors/print', setError)}>Print</button>}
          {canEdit && <button onClick={() => startForSection(null)}>+ Appoint acting head</button>}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Who is effectively in charge of each unit today{sups ? ` (as at ${sups.onDate})` : ''}. The substantive head is set under Settings → Sections;
        an acting head stands in for a fixed period and reverts on its own once it ends.
      </p>
      <table className="data-table"><thead><tr><th>Unit</th><th>Substantive head</th><th>In charge today</th>{canEdit && <th></th>}</tr></thead><tbody>
        {(sups?.units ?? []).map(u => <tr key={u.section_id}>
          <td>{u.section_name}{u.department_name ? <><br /><small className="muted">{u.department_name}</small></> : null}</td>
          <td>{u.substantive_head_name || <span className="muted">—</span>}</td>
          <td>
            {u.effective_name || <span className="muted">—</span>}
            {u.acting && <span className="badge acting" style={{ marginLeft: 6 }}>Acting</span>}
            {u.acting && u.acting_until && <><br /><small className="muted">until {u.acting_until}{u.reason ? ` · ${u.reason}` : ''}</small></>}
          </td>
          {canEdit && <td>{!u.acting && <button className="secondary" onClick={() => startForSection(u.section_id)}>Appoint acting</button>}</td>}
        </tr>)}
        {(sups?.units ?? []).length === 0 && <tr><td colSpan={canEdit ? 4 : 3} className="muted">No active units.</td></tr>}
      </tbody></table>
    </div>

    {canEdit && showForm && <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Appoint an acting unit head</h3>
      <form className="form-grid" onSubmit={create}>
        <label>Unit
          <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })} required>
            <option value="">—</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Acting unit head
          <select value={form.actingStaffId} onChange={e => setForm({ ...form, actingStaffId: e.target.value })} required>
            <option value="">—</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.employeeNo ? ` (${s.employeeNo})` : ''}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} required /></label>
        <label>Until<input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} required /></label>
        <label style={{ gridColumn: '1 / -1' }}>Reason (optional)<TextField value={form.reason} onValue={nextValue => setForm({ ...form, reason: nextValue })} placeholder="e.g. Substantive head on annual leave" /></label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
          <button type="submit">Appoint</button>
          <button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancel</button>
        </div>
      </form>
    </div>}

    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Acting appointments</h3>
      <table className="data-table"><thead><tr><th>Unit</th><th>Acting head</th><th>Standing in for</th><th>Period</th><th>Status</th>{canEdit && <th></th>}</tr></thead><tbody>
        {appts.map(a => <tr key={a.id}>
          <td>{a.section_name}</td>
          <td>{a.acting_name}</td>
          <td>{a.substantive_head_name || <span className="muted">—</span>}</td>
          <td>{a.start_date} → {a.end_date}</td>
          <td>{a.in_force ? <span className="badge acting">In force</span> : <span className="badge">{a.status}</span>}</td>
          {canEdit && <td>
            {a.status === 'active' && a.in_force && <button className="secondary" onClick={() => endNow(a.id)}>End now</button>}
            {mayDelete && <> <button className="secondary" onClick={() => remove(a.id)}>Delete</button></>}
          </td>}
        </tr>)}
        {appts.length === 0 && <tr><td colSpan={canEdit ? 6 : 5} className="muted">No acting appointments recorded.</td></tr>}
      </tbody></table>
    </div>
  </div>;
}
