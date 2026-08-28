import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText, apiRead } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  ORIENTATION_AUDIENCES, ORIENTATION_AUDIENCE_LABELS,
  ORIENTATION_RESPONSIBLE_ROLES, ORIENTATION_RESPONSIBLE_ROLE_LABELS,
  ORIENTATION_ITEM_STATUS_LABELS, ORIENTATION_FRAMEWORK_STATUS_LABELS,
  ORIENTATION_RECORD_STATUS_LABELS, orientationLabelise,
} from '../../../shared/constants/orientation';
import type {
  OrientationFramework, OrientationFrameworkItem, StaffOrientation, StaffOrientationItem,
  Staff, Section, Department,
} from '../../../shared/types/api';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';

/**
 * Orientation & induction — built and used exactly like competency assessment.
 *
 * A framework is the laboratory's induction checklist (grouped items); a record
 * copies a framework's items for one new starter and is worked down item by
 * item. This screen carries both: the "Records" tab raises and closes
 * inductions, the "Frameworks" tab is the builder.
 */

const badge = (value?: string | null, label?: string) =>
  <span className={`badge ${value ? value.toLowerCase().replace(/[\s_]+/g, '-') : 'unknown'}`}>{label ?? orientationLabelise(value)}</span>;

function ProgressBar({ done, total, na }: { done: number; total: number; na: number }) {
  const applicable = Math.max(0, total - na);
  const pct = applicable > 0 ? Math.round((100 * done) / applicable) : 0;
  return <div>
    <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#16a34a' : pct >= 40 ? '#f59e0b' : '#dc2626' }} />
    </div>
    <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>{done} of {applicable} done ({pct}%){na ? ` · ${na} N/A` : ''}</div>
  </div>;
}

export default function OrientationInduction({ staff, sections, departments }: {
  staff: Staff[]; sections: Section[]; departments: Department[];
}) {
  const { can } = usePermissions();
  const mayCreate = can('personnel.orientation', 'create');
  const mayEdit = can('personnel.orientation', 'edit');
  const mayApprove = can('personnel.orientation', 'approve');
  const mayArchive = can('personnel.orientation', 'void_archive');

  const [view, setView] = useState<'records' | 'frameworks'>('records');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName || '—';

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ margin: 0 }}>Orientation &amp; Induction</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Set the laboratory's induction checklists as frameworks, then raise a record against a framework for each new starter and work it down item by item — the same way competency assessments are built and used.</p>
      </div>
      <div className="segmented" style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden' }}>
        {(['records', 'frameworks'] as const).map(v => <button key={v} type="button" onClick={() => setView(v)}
          style={{ padding: '6px 14px', border: 'none', background: view === v ? 'var(--accent-soft, #eef4ff)' : 'transparent', fontWeight: view === v ? 600 : 400, cursor: 'pointer' }}>
          {v === 'records' ? 'Records' : 'Frameworks'}
        </button>)}
      </div>
    </div>

    {error && <Notice kind="error" style={{ marginTop: 10 }}>{error}</Notice>}
    {notice && <div className="notice" style={{ marginTop: 10, background: '#ecfdf5', color: '#065f46', padding: '8px 12px', borderRadius: 6 }}>{notice}</div>}

    {view === 'records'
      ? <RecordsView staff={staff} staffName={staffName} mayCreate={mayCreate} mayEdit={mayEdit}
          onError={setError} onNotice={setNotice} />
      : <FrameworksView sections={sections} departments={departments}
          mayCreate={mayCreate} mayEdit={mayEdit} mayApprove={mayApprove} mayArchive={mayArchive}
          onError={setError} onNotice={setNotice} />}
  </div>;
}

/* ══════════════════════════════════════════════════════════════════════════
 * RECORDS
 * ════════════════════════════════════════════════════════════════════════ */

const emptyRecordForm = { staffId: '', frameworkId: '', hireDate: '', orientationStart: '', facilitatorStaffId: '', notes: '' };

function RecordsView({ staff, staffName, mayCreate, mayEdit, onError, onNotice }: {
  staff: Staff[]; staffName: (id?: number | null) => string; mayCreate: boolean; mayEdit: boolean;
  onError: (m: string | null) => void; onNotice: (m: string | null) => void;
}) {
  const { can } = usePermissions();
  const [frameworks, setFrameworks] = useState<OrientationFramework[]>([]);
  const [records, setRecords] = useState<StaffOrientation[]>([]);
  const [selected, setSelected] = useState<StaffOrientation | null>(null);
  const [form, setForm] = useState(emptyRecordForm);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const [fw, recs] = await Promise.all([
        apiRead<OrientationFramework[]>('/personnel/orientation-frameworks?status=active', []),
        apiRead<StaffOrientation[]>('/personnel/orientations', []),
      ]);
      setFrameworks(fw); setRecords(recs);
    } catch (e) { onError(errorText(e)); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  const openRecord = useCallback(async (id: number) => {
    onError(null);
    try { setSelected(await api<StaffOrientation>(`/personnel/orientations/${id}`)); }
    catch (e) { onError(errorText(e)); }
  }, [onError]);

  async function submitNew(e: FormEvent) {
    e.preventDefault(); onError(null);
    try {
      const created = await api<{ id: number }>('/personnel/orientations/from-framework', { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyRecordForm); setShowNew(false);
      await load(); onNotice('Orientation record raised. Work the checklist down as each item is completed.');
      await openRecord(created.id);
    } catch (e) { onError(errorText(e)); }
  }

  async function setItemStatus(item: StaffOrientationItem, status: string) {
    if (!selected) return;
    onError(null);
    try {
      await api(`/personnel/orientations/${selected.id}/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ status }) });
      await openRecord(selected.id); await load();
    } catch (e) { onError(errorText(e)); }
  }

  async function saveRemark(item: StaffOrientationItem, remarks: string) {
    if (!selected) return;
    try { await api(`/personnel/orientations/${selected.id}/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ status: item.status, remarks }) }); await openRecord(selected.id); }
    catch (e) { onError(errorText(e)); }
  }

  async function updateRecord(patch: Record<string, unknown>) {
    if (!selected) return;
    onError(null);
    try { await api(`/personnel/orientations/${selected.id}`, { method: 'PUT', body: JSON.stringify(patch) }); await openRecord(selected.id); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  const grouped = useMemo(() => {
    const groups: Array<{ title: string; items: StaffOrientationItem[] }> = [];
    for (const it of selected?.items || []) {
      const key = it.group_title || 'General';
      let g = groups.find(x => x.title === key);
      if (!g) { g = { title: key, items: [] }; groups.push(g); }
      g.items.push(it);
    }
    return groups;
  }, [selected]);

  function printRecord() {
    if (!selected) return;
    const esc = (s?: string | null) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const groupsHtml = grouped.map(g => `<h3>${esc(g.title)}</h3>
      <table><thead><tr><th>#</th><th>Item</th><th>Responsible</th><th>Status</th><th>Completed</th><th>Remarks</th></tr></thead><tbody>
      ${g.items.map((it, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(it.item_text)}${it.item_description ? `<br><small>${esc(it.item_description)}</small>` : ''}</td>
        <td>${esc(it.responsible_role ? (ORIENTATION_RESPONSIBLE_ROLE_LABELS[it.responsible_role] || it.responsible_role) : '—')}</td>
        <td>${esc(ORIENTATION_ITEM_STATUS_LABELS[it.status] || it.status)}</td>
        <td>${esc(it.completed_at ? String(it.completed_at).slice(0, 10) : '—')}</td>
        <td>${esc(it.remarks || '')}</td>
      </tr>`).join('')}
      </tbody></table>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Orientation — ${esc(selected.staff_name)}</title>
      <style>
        body { font-family: Arial, sans-serif; color: #111; margin: 28px; font-size: 12px; }
        h1 { font-size: 18px; margin: 0 0 2px; } h3 { font-size: 13px; margin: 18px 0 6px; }
        .meta { color: #555; margin-bottom: 6px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
        th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
        th { background: #f0f0f0; }
        .signrow { margin-top: 30px; display: flex; gap: 40px; }
        .signrow div { flex: 1; border-top: 1px solid #333; padding-top: 4px; }
        @media print { body { margin: 12mm; } }
      </style></head><body>
      <h1>Orientation &amp; Induction Record</h1>
      <div class="meta">${esc(selected.staff_name)}${selected.employee_no ? ` · ${esc(selected.employee_no)}` : ''}${selected.section_name ? ` · ${esc(selected.section_name)}` : ''}</div>
      <div class="meta">Framework: ${esc(selected.framework_title || '—')} · Hire date: ${esc(selected.hire_date || '—')} · Started: ${esc(selected.orientation_start || '—')} · Facilitator: ${esc(selected.facilitator_name || '—')}</div>
      <div class="meta">Status: ${esc(ORIENTATION_RECORD_STATUS_LABELS[selected.status] || selected.status)}${selected.orientation_complete ? ' · Complete' : ''}</div>
      ${groupsHtml || '<p>No checklist items.</p>'}
      ${selected.notes ? `<p><strong>Notes:</strong> ${esc(selected.notes)}</p>` : ''}
      <div class="signrow"><div>Staff signature &amp; date</div><div>Facilitator signature &amp; date</div></div>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { onError('Allow pop-ups to print the record.'); return; }
    w.document.write(html); w.document.close();
  }

  return <>
    {mayCreate && <div style={{ marginTop: 12 }}>
      <button onClick={() => setShowNew(v => !v)}>{showNew ? 'Cancel' : '＋ Start orientation record'}</button>
      {showNew && <div className="card" style={{ marginTop: 10 }}>
        <h4 style={{ marginTop: 0 }}>Start orientation record</h4>
        {frameworks.length === 0
          ? <p className="muted">No active orientation framework yet. Create one under <strong>Frameworks</strong> and activate it first.</p>
          : can('personnel.orientation', 'create') && <form className="form-grid" onSubmit={submitNew}>
            <label>Staff<select value={form.staffId} onChange={e => setForm({ ...form, staffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
            <label>Framework<select value={form.frameworkId} onChange={e => setForm({ ...form, frameworkId: e.target.value })} required><option value="">—</option>{frameworks.map(f => <option key={f.id} value={f.id}>{f.title} ({ORIENTATION_AUDIENCE_LABELS[f.applies_to] || f.applies_to})</option>)}</select></label>
            <label>Hire date<input type="date" value={form.hireDate} onChange={e => setForm({ ...form, hireDate: e.target.value })} /></label>
            <label>Orientation start<input type="date" value={form.orientationStart} onChange={e => setForm({ ...form, orientationStart: e.target.value })} /></label>
            <label>Facilitator<select value={form.facilitatorStaffId} onChange={e => setForm({ ...form, facilitatorStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
            <label style={{ gridColumn: '1 / -1' }}>Notes<TextField value={form.notes} onValue={nextValue => setForm({ ...form, notes: nextValue })} /></label>
            <button type="submit" style={{ gridColumn: '1 / -1' }}>Raise record from framework</button>
          </form>}
      </div>}
    </div>}

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) 1fr', gap: 16, alignItems: 'start', marginTop: 12 }}>
      <div className="card" style={{ padding: 12 }}>
        <h4 style={{ marginTop: 0 }}>Orientation records</h4>
        {records.length === 0 ? <p className="muted">No orientation records yet.</p> :
          <div style={{ maxHeight: '60vh', overflowY: 'auto', borderTop: '1px solid #e2e8f0' }}>
            {records.map(r => {
              const isSel = selected?.id === r.id;
              const total = r.item_count ?? 0, done = r.item_done ?? 0, na = r.item_na ?? 0;
              return <button key={r.id} type="button" onClick={() => openRecord(r.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', borderBottom: '1px solid #eef0f4', background: isSel ? 'var(--accent-soft, #eef4ff)' : 'transparent', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{r.staff_name}</span>
                  {r.orientation_complete ? badge('completed', 'Complete') : badge(r.status)}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', margin: '3px 0' }}>{r.framework_title || (total === 0 ? 'Legacy record' : '—')}</div>
                {total > 0 && <ProgressBar done={done} total={total} na={na} />}
              </button>;
            })}
          </div>}
      </div>

      <div>
        {!selected ? <div className="card" style={{ padding: 20 }}><p className="muted">Select a record to work its induction checklist.</p></div>
          : selected.items && selected.items.length === 0 && !selected.framework_id
            ? <div className="card" style={{ padding: 20 }}><p className="muted">This is a legacy step-based record created before frameworks. Open it from the register export, or raise a new framework-based record.</p></div>
            : <>
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <div>
                    <h3 style={{ margin: 0 }}>{selected.staff_name}</h3>
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>{selected.framework_title || '—'} · {selected.employee_no || '—'}{selected.section_name ? ` · ${selected.section_name}` : ''}</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {selected.orientation_complete ? badge('completed', 'Complete') : badge(selected.status)}
                    <button type="button" className="badge" onClick={printRecord} style={{ cursor: 'pointer' }}>🖨 Print</button>
                  </div>
                </div>
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <div><span className="hint">Hire date</span><div>{selected.hire_date || '—'}</div></div>
                  <div><span className="hint">Started</span><div>{selected.orientation_start || '—'}</div></div>
                  <div><span className="hint">Facilitator</span><div>{selected.facilitator_name || '—'}</div></div>
                </div>
              </div>

              {grouped.map(g => <div key={g.title} className="card" style={{ marginTop: 12 }}>
                <h4 style={{ marginTop: 0 }}>{g.title}</h4>
                <table className="data-table"><tbody>
                  {g.items.map(it => <tr key={it.id}>
                    <td style={{ width: '55%' }}>
                      <div style={{ fontWeight: 500 }}>{it.item_text}</div>
                      {it.item_description && <div className="muted" style={{ fontSize: 11.5 }}>{it.item_description}</div>}
                      {it.responsible_role && <div className="hint" style={{ fontSize: 11 }}>Responsible: {ORIENTATION_RESPONSIBLE_ROLE_LABELS[it.responsible_role] || it.responsible_role}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {(['completed', 'pending', 'not_applicable'] as const).map(st => <button key={st} type="button"
                        disabled={!mayEdit}
                        onClick={() => setItemStatus(it, st)}
                        title={ORIENTATION_ITEM_STATUS_LABELS[st]}
                        style={{ marginRight: 4, padding: '3px 8px', borderRadius: 6, border: '1px solid #cbd5e1', cursor: mayEdit ? 'pointer' : 'default',
                          background: it.status === st ? (st === 'completed' ? '#16a34a' : st === 'not_applicable' ? '#64748b' : '#f59e0b') : 'transparent',
                          color: it.status === st ? '#fff' : '#334155', fontSize: 11 }}>
                        {st === 'completed' ? '✓ Done' : st === 'not_applicable' ? 'N/A' : 'Pending'}
                      </button>)}
                    </td>
                    <td>
                      <input defaultValue={it.remarks || ''} placeholder="Remarks" disabled={!mayEdit}
                        onBlur={e => { if (e.target.value !== (it.remarks || '')) void saveRemark(it, e.target.value); }}
                        style={{ width: '100%', fontSize: 12 }} />
                    </td>
                  </tr>)}
                </tbody></table>
              </div>)}

              {mayEdit && <div className="card" style={{ marginTop: 12 }}>
                <h4 style={{ marginTop: 0 }}>Sign-off &amp; close</h4>
                <div className="form-grid">
                  <label>Staff sign-off<input defaultValue={selected.staff_sign_off || ''} onBlur={e => { if (e.target.value !== (selected.staff_sign_off || '')) void updateRecord({ staffSignOff: e.target.value }); }} placeholder="Name / date" /></label>
                  <label>Facilitator sign-off<input defaultValue={selected.facilitator_sign_off || ''} onBlur={e => { if (e.target.value !== (selected.facilitator_sign_off || '')) void updateRecord({ facilitatorSignOff: e.target.value }); }} placeholder="Name / date" /></label>
                  <label>Notes<input defaultValue={selected.notes || ''} onBlur={e => { if (e.target.value !== (selected.notes || '')) void updateRecord({ notes: e.target.value }); }} /></label>
                  <label>Status<select value={selected.status} onChange={e => void updateRecord({ status: e.target.value })}>
                    {Object.entries(ORIENTATION_RECORD_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select></label>
                </div>
              </div>}
            </>}
      </div>
    </div>
  </>;
}

/* ══════════════════════════════════════════════════════════════════════════
 * FRAMEWORKS (builder)
 * ════════════════════════════════════════════════════════════════════════ */

const emptyFramework = {
  title: '', appliesTo: 'new_hire', sectionId: '', departmentId: '', cadre: '', versionLabel: '1.0',
  purpose: '', scope: '', validityMonths: '0', requiresFacilitatorSignOff: true, requiresStaffSignOff: true,
  effectiveDate: '', nextReviewDate: '',
};
const emptyItem = { groupTitle: 'General', itemText: '', itemDescription: '', responsibleRole: '' };

function FrameworksView({ sections, departments, mayCreate, mayEdit, mayApprove, mayArchive, onError, onNotice }: {
  sections: Section[]; departments: Department[];
  mayCreate: boolean; mayEdit: boolean; mayApprove: boolean; mayArchive: boolean;
  onError: (m: string | null) => void; onNotice: (m: string | null) => void;
}) {
  const { can } = usePermissions();
  const [frameworks, setFrameworks] = useState<OrientationFramework[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<OrientationFramework | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyFramework);
  const [itemForm, setItemForm] = useState(emptyItem);
  const [editingItem, setEditingItem] = useState<OrientationFrameworkItem | null>(null);

  const load = useCallback(async () => {
    try {
      const q = statusFilter ? `?status=${statusFilter}` : '';
      setFrameworks(await api<OrientationFramework[]>(`/personnel/orientation-frameworks${q}`));
    } catch (e) { onError(errorText(e)); }
  }, [statusFilter, onError]);
  useEffect(() => { void load(); }, [load]);

  const openFramework = useCallback(async (id: number) => {
    onError(null);
    try { setSelected(await api<OrientationFramework>(`/personnel/orientation-frameworks/${id}`)); }
    catch (e) { onError(errorText(e)); }
  }, [onError]);

  async function submitNew(e: FormEvent) {
    e.preventDefault(); onError(null);
    try {
      const created = await api<{ id: number }>('/personnel/orientation-frameworks', { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyFramework); setCreating(false);
      await load(); onNotice('Framework created as a draft. Add its checklist items, then activate it.');
      await openFramework(created.id);
    } catch (e) { onError(errorText(e)); }
  }

  async function setStatus(id: number, status: string) {
    onError(null);
    try { const fresh = await api<OrientationFramework>(`/personnel/orientation-frameworks/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); setSelected(fresh); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  async function duplicate(id: number) {
    onError(null);
    try { const created = await api<{ id: number }>(`/personnel/orientation-frameworks/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) }); await load(); onNotice('Framework duplicated as a new draft.'); await openFramework(created.id); }
    catch (e) { onError(errorText(e)); }
  }

  async function removeFramework(id: number) {
    if (!confirm('Delete this draft framework? This cannot be undone.')) return;
    onError(null);
    try { await api(`/personnel/orientation-frameworks/${id}`, { method: 'DELETE' }); setSelected(null); await load(); onNotice('Framework deleted.'); }
    catch (e) { onError(errorText(e)); }
  }

  async function saveMeta(patch: Record<string, unknown>) {
    if (!selected) return; onError(null);
    try { const fresh = await api<OrientationFramework>(`/personnel/orientation-frameworks/${selected.id}`, { method: 'PUT', body: JSON.stringify(patch) }); setSelected(fresh); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  async function addItem(e: FormEvent) {
    e.preventDefault(); if (!selected) return; onError(null);
    try { const fresh = await api<OrientationFramework>(`/personnel/orientation-frameworks/${selected.id}/items`, { method: 'POST', body: JSON.stringify(itemForm) }); setSelected(fresh); setItemForm({ ...emptyItem, groupTitle: itemForm.groupTitle }); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  async function saveItem(e: FormEvent) {
    e.preventDefault(); if (!editingItem) return; onError(null);
    try {
      const fresh = await api<OrientationFramework>(`/personnel/orientation-framework-items/${editingItem.id}`, { method: 'PUT', body: JSON.stringify({
        groupTitle: editingItem.group_title, itemText: editingItem.item_text, itemDescription: editingItem.item_description, responsibleRole: editingItem.responsible_role,
      }) });
      setSelected(fresh); setEditingItem(null); await load();
    } catch (e) { onError(errorText(e)); }
  }

  async function deleteItem(itemId: number) {
    if (!selected) return; onError(null);
    try { const fresh = await api<OrientationFramework>(`/personnel/orientation-framework-items/${itemId}`, { method: 'DELETE' }); setSelected(fresh); await load(); }
    catch (e) { onError(errorText(e)); }
  }

  const grouped = useMemo(() => {
    const groups: Array<{ title: string; items: OrientationFrameworkItem[] }> = [];
    for (const it of selected?.items || []) {
      let g = groups.find(x => x.title === (it.group_title || 'General'));
      if (!g) { g = { title: it.group_title || 'General', items: [] }; groups.push(g); }
      g.items.push(it);
    }
    return groups;
  }, [selected]);
  const knownGroups = grouped.map(g => g.title);

  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: 16, alignItems: 'start', marginTop: 12 }}>
    <div>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
          <h4 style={{ margin: 0 }}>Frameworks</h4>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ fontSize: 12 }}>
            <option value="">All</option>
            {Object.entries(ORIENTATION_FRAMEWORK_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {mayCreate && <button style={{ width: '100%', marginTop: 8 }} onClick={() => { setCreating(true); setSelected(null); setForm(emptyFramework); }}>＋ New framework</button>}
        <div style={{ maxHeight: '58vh', overflowY: 'auto', marginTop: 8, borderTop: '1px solid #e2e8f0' }}>
          {frameworks.length === 0 ? <p className="muted" style={{ padding: 8 }}>No frameworks.</p> : frameworks.map(f => {
            const isSel = selected?.id === f.id;
            return <button key={f.id} type="button" onClick={() => { setCreating(false); void openFramework(f.id); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', border: 'none', borderBottom: '1px solid #eef0f4', background: isSel ? 'var(--accent-soft, #eef4ff)' : 'transparent', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontWeight: 600 }}>{f.title}</span>{badge(f.status)}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                {ORIENTATION_AUDIENCE_LABELS[f.applies_to] || f.applies_to} · {f.item_count ?? 0} items{f.is_default ? ' · default' : ''}
              </div>
            </button>;
          })}
        </div>
      </div>
    </div>

    <div>
      {creating ? <div className="card">
        <h4 style={{ marginTop: 0 }}>New orientation framework</h4>
        {can('personnel.orientation', 'create') && <form className="form-grid" onSubmit={submitNew}>
          <label style={{ gridColumn: '1 / -1' }}>Title<TextField value={form.title} onValue={nextValue => setForm({ ...form, title: nextValue })} required placeholder="e.g. Staff orientation & induction" /></label>
          <label>Applies to<select value={form.appliesTo} onChange={e => setForm({ ...form, appliesTo: e.target.value })}>{ORIENTATION_AUDIENCES.map(a => <option key={a} value={a}>{ORIENTATION_AUDIENCE_LABELS[a]}</option>)}</select></label>
          <label>Version<TextField value={form.versionLabel} onValue={nextValue => setForm({ ...form, versionLabel: nextValue })} /></label>
          <label>Department<select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}><option value="">All</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">All</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Re-induction every (months, 0 = none)<input type="number" min={0} value={form.validityMonths} onChange={e => setForm({ ...form, validityMonths: e.target.value })} /></label>
          <label>Effective date<input type="date" value={form.effectiveDate} onChange={e => setForm({ ...form, effectiveDate: e.target.value })} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Purpose<TextField as="textarea" value={form.purpose} onValue={nextValue => setForm({ ...form, purpose: nextValue })} /></label>
          <label style={{ gridColumn: '1 / -1' }}>Scope<TextField as="textarea" value={form.scope} onValue={nextValue => setForm({ ...form, scope: nextValue })} /></label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button type="submit">Create draft</button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>}
      </div>
      : !selected ? <div className="card" style={{ padding: 20 }}><p className="muted">Select a framework to view and edit it, or create a new one.</p></div>
      : <>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div>
              <span className="hint">{selected.framework_code} · {ORIENTATION_AUDIENCE_LABELS[selected.applies_to] || selected.applies_to}</span>
              <h3 style={{ margin: '2px 0 0' }}>{selected.title} {badge(selected.status)}</h3>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>v{selected.version_label} · {selected.item_count ?? selected.items?.length ?? 0} items · {selected.records_raised ?? 0} records raised{selected.approved_by_name ? ` · activated by ${selected.approved_by_name}` : ''}</p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {mayApprove && selected.status !== 'active' && <button onClick={() => setStatus(selected.id, 'active')}>Activate</button>}
              {mayApprove && selected.status === 'active' && <button className="secondary" onClick={() => setStatus(selected.id, 'draft')}>Move to draft</button>}
              {mayCreate && <button className="secondary" onClick={() => duplicate(selected.id)}>Duplicate</button>}
              {mayArchive && selected.status !== 'archived' && <button className="secondary" onClick={() => setStatus(selected.id, 'archived')}>Archive</button>}
              {mayArchive && selected.status === 'draft' && (selected.records_raised ?? 0) === 0 && <button className="secondary" style={{ color: '#dc2626' }} onClick={() => removeFramework(selected.id)}>Delete</button>}
            </div>
          </div>
          {(selected.purpose || selected.scope) && <div style={{ marginTop: 10 }}>
            {selected.purpose && <p style={{ margin: '4px 0' }}><strong>Purpose:</strong> {selected.purpose}</p>}
            {selected.scope && <p className="muted" style={{ margin: '4px 0', fontSize: 12.5 }}><strong>Scope:</strong> {selected.scope}</p>}
          </div>}
          {mayEdit && <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#64748b' }}>Edit framework details</summary>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <label>Title<input defaultValue={selected.title} onBlur={e => { if (e.target.value !== selected.title) void saveMeta({ title: e.target.value }); }} /></label>
              <label>Applies to<select value={selected.applies_to} onChange={e => void saveMeta({ appliesTo: e.target.value })}>{ORIENTATION_AUDIENCES.map(a => <option key={a} value={a}>{ORIENTATION_AUDIENCE_LABELS[a]}</option>)}</select></label>
              <label>Version<input defaultValue={selected.version_label} onBlur={e => { if (e.target.value !== selected.version_label) void saveMeta({ versionLabel: e.target.value }); }} /></label>
              <label>Re-induction (months)<input type="number" min={0} defaultValue={selected.validity_months} onBlur={e => { if (Number(e.target.value) !== selected.validity_months) void saveMeta({ validityMonths: e.target.value }); }} /></label>
              <label style={{ gridColumn: '1 / -1' }}>Purpose<textarea defaultValue={selected.purpose || ''} onBlur={e => { if (e.target.value !== (selected.purpose || '')) void saveMeta({ purpose: e.target.value }); }} /></label>
              <label style={{ gridColumn: '1 / -1' }}>Scope<textarea defaultValue={selected.scope || ''} onBlur={e => { if (e.target.value !== (selected.scope || '')) void saveMeta({ scope: e.target.value }); }} /></label>
            </div>
          </details>}
        </div>

        {grouped.map(g => <div key={g.title} className="card" style={{ marginTop: 12 }}>
          <h4 style={{ marginTop: 0 }}>{g.title}</h4>
          <table className="data-table"><tbody>
            {g.items.map(it => <tr key={it.id}>
              {editingItem?.id === it.id ? <td colSpan={2}>
                {can('personnel.orientation', 'edit') && <form onSubmit={saveItem} className="form-grid">
                  <label>Group<TextField value={editingItem.group_title} onValue={nextValue => setEditingItem({ ...editingItem, group_title: nextValue })} /></label>
                  <label>Responsible<select value={editingItem.responsible_role || ''} onChange={e => setEditingItem({ ...editingItem, responsible_role: e.target.value })}><option value="">—</option>{ORIENTATION_RESPONSIBLE_ROLES.map(r => <option key={r} value={r}>{ORIENTATION_RESPONSIBLE_ROLE_LABELS[r]}</option>)}</select></label>
                  <label style={{ gridColumn: '1 / -1' }}>Item<TextField value={editingItem.item_text} onValue={nextValue => setEditingItem({ ...editingItem, item_text: nextValue })} required /></label>
                  <label style={{ gridColumn: '1 / -1' }}>Description<TextField value={editingItem.item_description || ''} onValue={nextValue => setEditingItem({ ...editingItem, item_description: nextValue })} /></label>
                  <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}><button type="submit">Save</button><button type="button" className="secondary" onClick={() => setEditingItem(null)}>Cancel</button></div>
                </form>}
              </td> : <>
                <td>
                  <div style={{ fontWeight: 500 }}>{it.item_text}</div>
                  {it.item_description && <div className="muted" style={{ fontSize: 11.5 }}>{it.item_description}</div>}
                  {it.responsible_role && <div className="hint" style={{ fontSize: 11 }}>Responsible: {ORIENTATION_RESPONSIBLE_ROLE_LABELS[it.responsible_role] || it.responsible_role}</div>}
                </td>
                <td style={{ width: 120, whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {mayEdit && <>
                    <button type="button" className="link-button" onClick={() => setEditingItem(it)} style={{ marginRight: 8 }}>Edit</button>
                    <button type="button" className="link-button danger" onClick={() => deleteItem(it.id)} style={{ color: '#dc2626' }}>Delete</button>
                  </>}
                </td>
              </>}
            </tr>)}
          </tbody></table>
        </div>)}

        {mayEdit && <div className="card" style={{ marginTop: 12 }}>
          <h4 style={{ marginTop: 0 }}>Add checklist item</h4>
          <form className="form-grid" onSubmit={addItem}>
            <label>Group<TextField list="orient-groups" value={itemForm.groupTitle} onValue={nextValue => setItemForm({ ...itemForm, groupTitle: nextValue })} placeholder="e.g. Health, safety & biosafety" />
              <datalist id="orient-groups">{knownGroups.map(g => <option key={g} value={g} />)}</datalist>
            </label>
            <label>Responsible<select value={itemForm.responsibleRole} onChange={e => setItemForm({ ...itemForm, responsibleRole: e.target.value })}><option value="">—</option>{ORIENTATION_RESPONSIBLE_ROLES.map(r => <option key={r} value={r}>{ORIENTATION_RESPONSIBLE_ROLE_LABELS[r]}</option>)}</select></label>
            <label style={{ gridColumn: '1 / -1' }}>Item<TextField value={itemForm.itemText} onValue={nextValue => setItemForm({ ...itemForm, itemText: nextValue })} required placeholder="What the new starter must be shown, given or told" /></label>
            <label style={{ gridColumn: '1 / -1' }}>Description (optional)<TextField value={itemForm.itemDescription} onValue={nextValue => setItemForm({ ...itemForm, itemDescription: nextValue })} /></label>
            <button type="submit" style={{ gridColumn: '1 / -1' }}>Add item</button>
          </form>
        </div>}
      </>}
    </div>
  </div>;
}
