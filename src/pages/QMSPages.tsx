import { FormEvent, useEffect, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import PageHeader from '../components/ui/PageHeader';
import { api } from '../services/api';
import { useModules } from '../hooks/useModules';
import DisabledModule from '../components/DisabledModule';
import { formatBadge, toDisplay, useLookupData, type LoadState } from './qmsShared';
import type { ActionRecord } from '../../shared/types/api';
import TextField from '../components/ui/TextField';


// Complaints moved to their own file when the module was rebuilt around the
// handling process ISO 15189 §7.4 describes; re-exported so every existing
// import keeps working.
export { ComplaintsPage } from './ComplaintsPage';

// Risk management was rebuilt around the staged risk-management process and
// lives in its own file; re-exported so every existing import keeps working.
export { RisksPage } from './RiskManagementPage';

export function QmsActionTracker({ embedded = false }: { embedded?: boolean } = {}) {
  const { can } = usePermissions();
  const { isEnabled } = useModules();
  const { staff } = useLookupData();
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [staffFilter, setStaffFilter] = useState('');
  const [overdueFilter, setOverdueFilter] = useState(false);
  const [selected, setSelected] = useState<ActionRecord | null>(null);
  const [formState, setFormState] = useState({ title: '', moduleKey: 'nc_capa', sourceModule: '', sourceRecordId: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal', status: 'Not started', evidenceRequired: false, completionNotes: '' });
  const [loadState, setLoadState] = useState<LoadState>({ loading: false, error: null });

  useEffect(() => { if (!embedded && !isEnabled('actions')) return; void load(); }, [isEnabled]);

  async function load() {
    setLoadState({ loading: true, error: null });
    try {
      const query = new URLSearchParams();
      if (statusFilter) query.set('status', statusFilter);
      if (staffFilter) query.set('assignedToStaffId', staffFilter);
      if (overdueFilter) query.set('overdue', 'true');
      setActions(await api<ActionRecord[]>(`/actions?${query.toString()}`));
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formState.title) {
      setLoadState({ loading: false, error: 'Action title is required.' });
      return;
    }
    setLoadState({ loading: true, error: null });
    try {
      await api('/actions', { method: 'POST', body: JSON.stringify({ ...formState, assignedToStaffId: formState.assignedToStaffId || undefined, evidenceRequired: formState.evidenceRequired }) });
      setFormState({ title: '', moduleKey: 'nc_capa', sourceModule: '', sourceRecordId: '', description: '', assignedToStaffId: '', dueDate: '', priority: 'normal', status: 'Not started', evidenceRequired: false, completionNotes: '' });
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  async function updateStatus() {
    if (!selected) return;
    setLoadState({ loading: true, error: null });
    try {
      await api(`/actions/${selected.id}`, { method: 'PUT', body: JSON.stringify({ ...selected, status: selected.status, completionNotes: selected.completion_notes }) });
      await load();
    } catch (error) {
      setLoadState({ loading: false, error: (error as Error).message });
      return;
    }
    setLoadState({ loading: false, error: null });
  }

  const statusOptions = ['Not started', 'In progress', 'Waiting for evidence', 'Submitted for review', 'Completed', 'Verified', 'Closed', 'Reopened', 'Overdue'];

  if (!embedded && !isEnabled('actions')) return <DisabledModule />;

  return <div>
    {!embedded && <PageHeader eyebrow="Nonconforming Event Management" title="Action Tracker" subtitle="Centralized actions, owners, due dates, and status." />}
    {loadState.error && <div className="card"><strong>Error:</strong> {loadState.error}</div>}
    {loadState.loading && <div className="card"><em>Loading actions…</em></div>}
    <div className="card"><h3>Filters</h3><div className="form" style={{ gridTemplateColumns: '1fr auto auto', alignItems: 'end' }}><label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All</option>{statusOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></label><label>Assigned staff<select value={staffFilter} onChange={e => setStaffFilter(e.target.value)}><option value="">All</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label><input type="checkbox" checked={overdueFilter} onChange={e => setOverdueFilter(e.target.checked)} /> Overdue only</label><button onClick={load}>Refresh</button></div></div>
    <div className="card"><h3>Create action</h3>{can('actions', 'create') && <form className="form" onSubmit={create}><label>Title<TextField value={formState.title} onValue={nextValue => setFormState(prev => ({ ...prev, title: nextValue }))} required /></label><label>Source module<TextField value={formState.sourceModule} onValue={nextValue => setFormState(prev => ({ ...prev, sourceModule: nextValue }))} placeholder="e.g. nc_capa" /></label><label>Source record ID<TextField value={formState.sourceRecordId} onValue={nextValue => setFormState(prev => ({ ...prev, sourceRecordId: nextValue }))} placeholder="Record ID" /></label><label>Description<TextField as="textarea" value={formState.description} onValue={nextValue => setFormState(prev => ({ ...prev, description: nextValue }))} /></label><label>Assigned to<select value={formState.assignedToStaffId} onChange={e => setFormState(prev => ({ ...prev, assignedToStaffId: e.target.value }))}><option value="">None</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label><label>Due date<input type="date" value={formState.dueDate} onChange={e => setFormState(prev => ({ ...prev, dueDate: e.target.value }))} /></label><label>Priority<select value={formState.priority} onChange={e => setFormState(prev => ({ ...prev, priority: e.target.value }))}><option>normal</option><option>high</option><option>low</option></select></label><label>Status<select value={formState.status} onChange={e => setFormState(prev => ({ ...prev, status: e.target.value }))}>{statusOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></label><label><input type="checkbox" checked={formState.evidenceRequired} onChange={e => setFormState(prev => ({ ...prev, evidenceRequired: e.target.checked }))} /> Evidence required</label><label>Completion notes<TextField as="textarea" value={formState.completionNotes} onValue={nextValue => setFormState(prev => ({ ...prev, completionNotes: nextValue }))} /></label><button>Create action</button></form>}</div>
    <div className="card"><h3>Actions</h3>{actions.length === 0 ? <p>No actions match the current filters.</p> : <table className="table"><thead><tr><th>Title</th><th>Source</th><th>Assigned</th><th>Due</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead><tbody>{actions.map(action => <tr key={action.id}><td>{action.title}</td><td>{action.source_module || action.module_key}#{action.source_record_id || ''}</td><td>{staff.find(s => s.id === action.assigned_to_staff_id)?.fullName || toDisplay(action.assigned_to_staff_id)}</td><td>{action.due_date || 'N/A'}</td><td>{action.priority}</td><td>{formatBadge(action.status)}</td><td><button onClick={() => setSelected(action)}>Select</button></td></tr>)}</tbody></table>}</div>
    {selected && <div className="card"><h3>Action detail</h3><p><strong>{selected.title}</strong></p><p><strong>Source</strong> {selected.source_module || selected.module_key} / {selected.source_record_id || 'N/A'}</p><p><strong>Assigned</strong> {staff.find(s => s.id === selected.assigned_to_staff_id)?.fullName || toDisplay(selected.assigned_to_staff_id)}</p><label>Status<select value={selected.status} onChange={e => setSelected(prev => prev ? { ...prev, status: e.target.value } : prev)}>{statusOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></label><label>Completion notes<TextField as="textarea" value={selected.completion_notes ?? ''} onValue={nextValue => setSelected(prev => prev ? { ...prev, completion_notes: nextValue } : prev)} /></label><div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>{can('actions', 'edit') && <button onClick={updateStatus}>Update</button>}<button className="secondary" onClick={() => setSelected(prev => prev ? { ...prev, status: 'Completed' } : prev)}>Mark completed</button><button className="secondary" onClick={() => setSelected(prev => prev ? { ...prev, status: 'Reopened' } : prev)}>Reopen</button></div></div>}
  </div>;
}
