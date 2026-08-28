import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Copy, CopyPlus, Pencil, Plus, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { DetailModal, EmptyState, RowMenu } from '../../components/ui';
import { api } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { PrintButton, ScaleLegend, badgeFor, labelise } from './competencyShared';
import {
  COMPETENCY_AUDIENCES, COMPETENCY_AUDIENCE_LABELS, COMPETENCY_METHODS,
  COMPETENCY_METHOD_LABELS, COMPETENCY_METHOD_HINTS, COMPETENCY_SCALE_4,
} from '../../../shared/constants/competency';
import type { CompetencyFramework, Section, Department } from '../../../shared/types/api';

/**
 * The framework builder — what a job is assessed against.
 *
 * A framework is the laboratory's own statement of what somebody on a
 * particular bench has to be able to do, and what "done properly" looks like
 * for each of those things. Assessments copy it, so this is where the
 * laboratory decides the standard once instead of each assessor deciding it
 * again every time they pick up a form.
 */

const emptyFramework = {
  title: '', appliesTo: 'all_staff', sectionId: '', departmentId: '', cadre: '', versionLabel: '1.0',
  purpose: '', scope: '', maxScore: '4', passThresholdPercent: '75', minimumElementScore: '2',
  criticalElementsMustPass: true, validityMonths: '12', requiresTechnicalReview: true,
  requiresStaffAcknowledgement: true, effectiveDate: '', nextReviewDate: '',
};

export default function CompetencyFrameworks({ sections, departments, onChanged }: {
  sections: Section[];
  departments: Department[];
  onChanged?: () => void;
}) {
  const { can } = usePermissions();
  const mayCreate = can('personnel.training', 'create');
  const mayEdit = can('personnel.training', 'edit');
  const mayApprove = can('personnel.training', 'approve');
  const mayArchive = can('personnel.training', 'void_archive');

  const [frameworks, setFrameworks] = useState<CompetencyFramework[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<CompetencyFramework | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyFramework);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = statusFilter ? `?status=${statusFilter}` : '';
      setFrameworks(await api<CompetencyFramework[]>(`/personnel/competency-frameworks${query}`));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const openFramework = useCallback(async (id: number) => {
    try { setSelected(await api<CompetencyFramework>(`/personnel/competency-frameworks/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }, []);

  async function submitNew(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      const created = await api<{ id: number }>('/personnel/competency-frameworks', { method: 'POST', body: JSON.stringify(form) });
      setForm(emptyFramework); setCreating(false);
      await load(); onChanged?.();
      await openFramework(created.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function setStatus(id: number, status: string) {
    setError(null);
    try {
      await api(`/personnel/competency-frameworks/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await load(); onChanged?.();
      if (selected?.id === id) await openFramework(id);
    } catch (e) { setError((e as Error).message); }
  }

  async function duplicate(id: number) {
    setError(null);
    try {
      const created = await api<{ id: number }>(`/personnel/competency-frameworks/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
      await load(); onChanged?.();
      await openFramework(created.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(id: number) {
    setError(null);
    try { await api(`/personnel/competency-frameworks/${id}`, { method: 'DELETE' }); setSelected(null); await load(); onChanged?.(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div className="framework-manager">
    <div className="workspace-head">
      <div>
        <h3>Competency frameworks</h3>
        <p className="muted">What each job is assessed against. An assessment takes a copy of the framework as it stands when the assessment is raised, so revising one here never rewrites a record already on file.</p>
      </div>
      <div className="workspace-actions">
        <label className="inline-filter">Status
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        {mayCreate && <button type="button" onClick={() => setCreating(v => !v)}>
          <Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New framework
        </button>}
      </div>
    </div>

    {error && <div className="error">{error}</div>}

    {creating && mayCreate && <form className="form-grid" onSubmit={submitNew}>
      <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required placeholder="e.g. Bench competency — haematology" /></label>
      <label>Applies to
        <select value={form.appliesTo} onChange={e => setForm({ ...form, appliesTo: e.target.value })}>
          {COMPETENCY_AUDIENCES.map(a => <option key={a} value={a}>{COMPETENCY_AUDIENCE_LABELS[a]}</option>)}
        </select>
      </label>
      <label>Unit / section
        <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
          <option value="">Whole laboratory</option>
          {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Department
        <select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}>
          <option value="">—</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label>Version<input value={form.versionLabel} onChange={e => setForm({ ...form, versionLabel: e.target.value })} /></label>
      <label>Top of rating scale
        <select value={form.maxScore} onChange={e => setForm({ ...form, maxScore: e.target.value })}>
          <option value="4">4-point</option>
          <option value="5">5-point</option>
          <option value="3">3-point</option>
        </select>
      </label>
      <label>Pass mark (%)<input type="number" min={0} max={100} value={form.passThresholdPercent} onChange={e => setForm({ ...form, passThresholdPercent: e.target.value })} /></label>
      <label>Lowest acceptable element score
        <input type="number" min={0} step="0.5" value={form.minimumElementScore} onChange={e => setForm({ ...form, minimumElementScore: e.target.value })} placeholder="Leave blank for no floor" />
      </label>
      <label>Re-assess every (months)<input type="number" min={1} value={form.validityMonths} onChange={e => setForm({ ...form, validityMonths: e.target.value })} /></label>
      <label className="check-inline"><input type="checkbox" checked={form.criticalElementsMustPass} onChange={e => setForm({ ...form, criticalElementsMustPass: e.target.checked })} /> A shortfall on a critical element blocks a competent outcome</label>
      <label className="check-inline"><input type="checkbox" checked={form.requiresTechnicalReview} onChange={e => setForm({ ...form, requiresTechnicalReview: e.target.checked })} /> Requires a technical countersignature</label>
      <label className="check-inline"><input type="checkbox" checked={form.requiresStaffAcknowledgement} onChange={e => setForm({ ...form, requiresStaffAcknowledgement: e.target.checked })} /> Requires the member of staff to acknowledge</label>
      <label className="wide">Purpose<textarea rows={2} value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} placeholder="What this framework is for." /></label>
      <label className="wide">Scope<textarea rows={2} value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })} placeholder="Who it applies to, and what it covers." /></label>
      <button type="submit">Create framework</button>
    </form>}

    {loading ? <p className="muted">Loading…</p> : frameworks.length === 0
      ? <EmptyState title="No frameworks yet" message="A framework lists what a job is assessed against. Create one, add the elements of the job, then activate it." />
      : <table className="data-table">
        <thead><tr><th>Code</th><th>Framework</th><th>Applies to</th><th>Unit</th><th>Elements</th><th>Pass mark</th><th>Interval</th><th>Status</th><th /></tr></thead>
        <tbody>
          {frameworks.map(f => <tr key={f.id} className="row-click" onClick={() => void openFramework(f.id)}>
            <td>{f.framework_code}</td>
            <td>{f.title}<br /><small className="muted">v{f.version_label}{f.assessment_count ? ` · ${f.assessment_count} assessment(s) raised` : ''}</small></td>
            <td>{COMPETENCY_AUDIENCE_LABELS[f.applies_to] || labelise(f.applies_to)}</td>
            <td>{f.section_name || 'Whole laboratory'}</td>
            <td>{f.element_count ?? 0}<small className="muted"> in {f.group_count ?? 0} group(s)</small></td>
            <td>{f.pass_threshold_percent}%</td>
            <td>{f.validity_months} m</td>
            <td>{badgeFor(f.status)}</td>
            <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => void openFramework(f.id)}>Open</button></td>
          </tr>)}
        </tbody>
      </table>}

    {selected && <FrameworkEditor
      framework={selected}
      sections={sections}
      departments={departments}
      mayEdit={mayEdit}
      mayCreate={mayCreate}
      mayApprove={mayApprove}
      mayArchive={mayArchive}
      onClose={() => setSelected(null)}
      onReload={() => openFramework(selected.id)}
      onListChanged={() => { void load(); onChanged?.(); }}
      onSetStatus={setStatus}
      onDuplicate={duplicate}
      onDelete={remove}
    />}
  </div>;
}

/* ── The editor ─────────────────────────────────────────────────────────── */

function FrameworkEditor({ framework, sections, departments, mayEdit, mayCreate, mayApprove, mayArchive, onClose, onReload, onListChanged, onSetStatus, onDuplicate, onDelete }: {
  framework: CompetencyFramework;
  sections: Section[];
  departments: Department[];
  mayEdit: boolean;
  mayCreate: boolean;
  mayApprove: boolean;
  mayArchive: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
  onListChanged: () => void;
  onSetStatus: (id: number, status: string) => Promise<void>;
  onDuplicate: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [tab, setTab] = useState<'Elements' | 'Details'>('Elements');
  const [error, setError] = useState<string | null>(null);
  // Editing a live framework is off by default and switched on, per record,
  // from the management menu — see requirement 4. Kept out of plain sight so
  // the everyday answer to "revise a live framework" stays "take a new version".
  const [adminEdit, setAdminEdit] = useState(false);
  const groups = framework.groups ?? [];
  const elements = framework.elements ?? [];
  const inUse = (framework.assessments_raised ?? 0) > 0;
  const isDraft = framework.status === 'draft';
  // Editing is refused once a framework is live so an assessment already
  // raised against it keeps meaning what it meant. Revising means a new
  // version, which is what Duplicate produces — unless somebody with archival
  // rights deliberately unlocks this record to correct a mistake or clear demo
  // data.
  const editable = mayEdit && (isDraft || (adminEdit && mayArchive));

  const refresh = async () => { await onReload(); onListChanged(); };

  return <DetailModal
    open
    onClose={onClose}
    width="wide"
    title={<>{framework.framework_code} — {framework.title}</>}
    subtitle={<>v{framework.version_label} · {COMPETENCY_AUDIENCE_LABELS[framework.applies_to] || labelise(framework.applies_to)} · {framework.section_name || 'Whole laboratory'} · {elements.length} element(s)</>}
    header={<>
      {badgeFor(framework.status)}
      <PrintButton path={`/personnel/competency-frameworks/${framework.id}/print`} label="Print blank form" />
    </>}
    footer={<div className="modal-foot-row">
      <div className="foot-left">
        {framework.status === 'draft' && mayApprove && <button type="button" onClick={() => void onSetStatus(framework.id, 'active')}>Activate framework</button>}
        {mayCreate && <button type="button" className="secondary" onClick={() => void onDuplicate(framework.id)}>
          <Copy size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />New version
        </button>}
      </div>
      {(mayApprove || mayArchive) && <RowMenu label="Manage this framework">{close => <>
        {!isDraft && mayArchive && <button type="button" role="menuitem" onClick={() => { close(); setAdminEdit(v => !v); setTab('Elements'); }}>
          <Pencil size={14} /> {adminEdit ? 'Stop editing this framework' : 'Edit this framework in place'}
        </button>}
        {framework.status === 'active' && mayApprove && <button type="button" role="menuitem" onClick={() => { close(); void onSetStatus(framework.id, 'archived'); }}>
          <Archive size={14} /> Archive framework
        </button>}
        {framework.status === 'archived' && mayApprove && <button type="button" role="menuitem" onClick={() => { close(); void onSetStatus(framework.id, 'draft'); }}>
          <RotateCcw size={14} /> Return to draft
        </button>}
        {mayArchive && !inUse && <button type="button" role="menuitem" className="danger" onClick={() => { close(); void onDelete(framework.id); }}>
          <Trash2 size={14} /> Delete framework
        </button>}
        {mayArchive && inUse && <button type="button" role="menuitem" disabled title="Assessments have been raised against this framework — archive it instead.">
          <Trash2 size={14} /> Delete (raised against)
        </button>}
      </>}</RowMenu>}
    </div>}
  >
    {error && <div className="error">{error}</div>}
    {!isDraft && adminEdit && editable && <p className="notice-warn">
      <ShieldAlert size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
      You are editing a framework that is already in force. Changes here do not rewrite the {framework.assessments_raised ?? 0} assessment(s) already raised against it — those keep the wording they were judged by — but they do change the standard from now on. Use this only to correct a mistake or clear demonstration data.
    </p>}
    {framework.status === 'active' && !adminEdit && <p className="notice-ok">
      This framework is in force. To change what it asks for, take a new version — the assessments already raised against this one keep the wording they were judged by.
    </p>}
    {framework.status === 'draft' && elements.length === 0 && <p className="notice-warn">
      Add the elements of the job below, then activate the framework to start raising assessments against it.
    </p>}

    <div className="tabs sub">
      {(['Elements', 'Details'] as const).map(t =>
        <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
    </div>

    {tab === 'Elements' && <ElementBuilder
      framework={framework}
      groups={groups}
      elements={elements}
      editable={editable}
      onError={setError}
      onChanged={refresh}
    />}

    {tab === 'Details' && <FrameworkDetails
      framework={framework}
      sections={sections}
      departments={departments}
      editable={editable}
      onError={setError}
      onChanged={refresh}
    />}
  </DetailModal>;
}

/* ── Groups and elements ────────────────────────────────────────────────── */

function ElementBuilder({ framework, groups, elements, editable, onError, onChanged }: {
  framework: CompetencyFramework;
  groups: NonNullable<CompetencyFramework['groups']>;
  elements: NonNullable<CompetencyFramework['elements']>;
  editable: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const base = `/personnel/competency-frameworks/${framework.id}`;
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [newGroup, setNewGroup] = useState('');
  const [addingTo, setAddingTo] = useState<number | 'none' | null>(null);
  const [importing, setImporting] = useState(false);
  const [element, setElement] = useState({ elementText: '', performanceCriteria: '', expectedEvidence: '', defaultMethod: 'direct_observation', weight: '1', isCritical: false });
  const ungrouped = elements.filter(e => !e.group_id);

  async function addGroup() {
    if (!newGroup.trim()) return;
    onError(null);
    try { await api(`${base}/groups`, { method: 'POST', body: JSON.stringify({ groupTitle: newGroup.trim() }) }); setNewGroup(''); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  async function removeGroup(id: number) {
    onError(null);
    try { await api(`${base}/groups/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  async function addElement(groupId: number | 'none') {
    if (!element.elementText.trim()) { onError('An element description is required.'); return; }
    onError(null);
    try {
      await api(`${base}/elements`, { method: 'POST', body: JSON.stringify({ ...element, groupId: groupId === 'none' ? '' : groupId }) });
      setElement({ elementText: '', performanceCriteria: '', expectedEvidence: '', defaultMethod: 'direct_observation', weight: '1', isCritical: false });
      setAddingTo(null);
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  async function removeElement(id: number) {
    onError(null);
    try { await api(`${base}/elements/${id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  async function toggleCritical(id: number, current: number, groupId: number | null | undefined) {
    onError(null);
    try { await api(`${base}/elements/${id}`, { method: 'PUT', body: JSON.stringify({ isCritical: !current, groupId: groupId ?? '' }) }); await onChanged(); }
    catch (e) { onError((e as Error).message); }
  }

  const addForm = (groupId: number | 'none') => <div className="element-add">
    <label className="wide">Element — what the person has to be able to do
      <input autoFocus value={element.elementText} onChange={e => setElement({ ...element, elementText: e.target.value })} placeholder="e.g. Performs ABO and Rh D grouping and resolves discrepancies" />
    </label>
    <label className="wide">Performance criteria — what acceptable work looks like
      <textarea rows={2} value={element.performanceCriteria} onChange={e => setElement({ ...element, performanceCriteria: e.target.value })} placeholder="The standard the assessor judges against." />
    </label>
    <label>Method of assessment
      <select value={element.defaultMethod} onChange={e => setElement({ ...element, defaultMethod: e.target.value })}>
        {COMPETENCY_METHODS.map(m => <option key={m} value={m} title={COMPETENCY_METHOD_HINTS[m]}>{COMPETENCY_METHOD_LABELS[m]}</option>)}
      </select>
      <small className="field-hint">{COMPETENCY_METHOD_HINTS[element.defaultMethod]}</small>
    </label>
    <label>Expected evidence<input value={element.expectedEvidence} onChange={e => setElement({ ...element, expectedEvidence: e.target.value })} placeholder="e.g. Signed worksheet" /></label>
    <label>Weight<input type="number" min={0.5} step="0.5" value={element.weight} onChange={e => setElement({ ...element, weight: e.target.value })} /></label>
    <label className="check-inline"><input type="checkbox" checked={element.isCritical} onChange={e => setElement({ ...element, isCritical: e.target.checked })} /> Critical — a shortfall here blocks a competent outcome</label>
    <div className="element-add-actions">
      <button type="button" onClick={() => void addElement(groupId)}>Add element</button>
      <button type="button" className="secondary" onClick={() => setAddingTo(null)}>Cancel</button>
    </div>
  </div>;

  const elementRows = (rows: typeof elements) => <table className="data-table element-table">
    <thead><tr><th style={{ width: '4%' }}>#</th><th>Element and performance criteria</th><th style={{ width: '22%' }}>Method</th><th style={{ width: '8%' }}>Weight</th><th style={{ width: '10%' }}>Critical</th>{editable && <th style={{ width: '5%' }} />}</tr></thead>
    <tbody>
      {rows.map((e, index) => <tr key={e.id}>
        <td>{index + 1}</td>
        <td>
          <strong>{e.element_text}</strong>
          {e.performance_criteria && <><br /><small className="muted">{e.performance_criteria}</small></>}
          {e.expected_evidence && <><br /><small className="muted">Evidence: {e.expected_evidence}</small></>}
        </td>
        <td><small>{COMPETENCY_METHOD_LABELS[e.default_method] || labelise(e.default_method)}</small></td>
        <td>{e.weight}</td>
        <td>
          {editable
            ? <label className="check-inline"><input type="checkbox" checked={!!e.is_critical} onChange={() => void toggleCritical(e.id, e.is_critical, e.group_id)} /></label>
            : e.is_critical ? <span className="badge critical">Critical</span> : <span className="muted">—</span>}
        </td>
        {editable && <td><button type="button" className="link-button danger" onClick={() => void removeElement(e.id)} aria-label="Remove element"><Trash2 size={14} /></button></td>}
      </tr>)}
    </tbody>
  </table>;

  return <div className="element-builder">
    <ScaleLegend scale={COMPETENCY_SCALE_4} max={framework.max_score} />
    <p className="muted">
      Pass mark {framework.pass_threshold_percent}%{framework.minimum_element_score ? `, with no single element below ${framework.minimum_element_score}` : ''}.
      Re-assessment every {framework.validity_months} months. Weighting decides how much each element moves the overall figure.
    </p>

    {groups.length === 0 && ungrouped.length === 0 && <EmptyState title="No elements yet" message="Group the elements by bench or by theme, then add what somebody on that bench has to be able to do." />}

    {groups.map(group => {
      const rows = elements.filter(e => e.group_id === group.id);
      const isCollapsed = collapsed[group.id];
      return <section key={group.id} className="element-group">
        <header>
          <button type="button" className="link-button" onClick={() => setCollapsed(c => ({ ...c, [group.id]: !c[group.id] }))}>
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            <span className="eg-title">{group.group_title}</span>
            <span className="muted"> · {rows.length} element(s)</span>
          </button>
          {editable && <div className="eg-actions">
            <button type="button" className="secondary" onClick={() => { setAddingTo(group.id); setCollapsed(c => ({ ...c, [group.id]: false })); }}>
              <Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Element
            </button>
            <button type="button" className="link-button danger" onClick={() => void removeGroup(group.id)} aria-label={`Remove ${group.group_title}`}><Trash2 size={14} /></button>
          </div>}
        </header>
        {group.group_description && !isCollapsed && <p className="muted eg-desc">{group.group_description}</p>}
        {!isCollapsed && rows.length > 0 && elementRows(rows)}
        {!isCollapsed && rows.length === 0 && <p className="muted eg-desc">No elements in this group yet.</p>}
        {addingTo === group.id && addForm(group.id)}
      </section>;
    })}

    {ungrouped.length > 0 && <section className="element-group">
      <header><span className="eg-title">Ungrouped elements</span></header>
      {elementRows(ungrouped)}
    </section>}

    {editable && <div className="group-add">
      <label>New group
        <input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="e.g. Haematology and blood transfusion"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addGroup(); } }} />
      </label>
      <button type="button" className="secondary" onClick={() => void addGroup()}>Add group</button>
      <button type="button" className="secondary" onClick={() => setAddingTo('none')}>Add ungrouped element</button>
      <button type="button" className="secondary" onClick={() => setImporting(v => !v)}>
        <CopyPlus size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Clone from another framework
      </button>
    </div>}
    {addingTo === 'none' && addForm('none')}
    {editable && importing && <ImportElements
      targetId={framework.id}
      onError={onError}
      onClose={() => setImporting(false)}
      onChanged={async () => { await onChanged(); }}
    />}
  </div>;
}

/* ── Cloning elements from another framework ────────────────────────────── */

/**
 * Pull whole groups, single elements, or an entire framework across from
 * another one, so a laboratory states a group of elements once and reuses it
 * rather than retyping it into every framework that needs it.
 */
function ImportElements({ targetId, onError, onClose, onChanged }: {
  targetId: number;
  onError: (message: string | null) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const [options, setOptions] = useState<CompetencyFramework[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState<CompetencyFramework | null>(null);
  const [entire, setEntire] = useState(false);
  const [groups, setGroups] = useState<Set<number>>(new Set());
  const [elements, setElements] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CompetencyFramework[]>('/personnel/competency-frameworks')
      .then(list => setOptions(list.filter(f => f.id !== targetId)))
      .catch(e => onError((e as Error).message));
  }, [targetId, onError]);

  useEffect(() => {
    setSource(null); setEntire(false); setGroups(new Set()); setElements(new Set());
    if (!sourceId) return;
    setLoading(true);
    api<CompetencyFramework>(`/personnel/competency-frameworks/${sourceId}`)
      .then(setSource).catch(e => onError((e as Error).message)).finally(() => setLoading(false));
  }, [sourceId, onError]);

  const sourceGroups = source?.groups ?? [];
  const sourceElements = (source?.elements ?? []).filter(e => e.is_active);
  const ungrouped = sourceElements.filter(e => !e.group_id);

  const toggleGroup = (id: number) => setGroups(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const toggleElement = (id: number) => setElements(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  // What the current selection would actually copy, so the button can say so.
  const selectedCount = entire ? sourceElements.length
    : sourceElements.filter(e => (e.group_id && groups.has(e.group_id)) || elements.has(e.id)).length;
  const nothingChosen = !entire && groups.size === 0 && elements.size === 0;

  async function runImport() {
    if (!sourceId || nothingChosen) return;
    onError(null); setBusy(true);
    try {
      await api(`/personnel/competency-frameworks/${targetId}/import-elements`, {
        method: 'POST',
        body: JSON.stringify({
          sourceFrameworkId: Number(sourceId),
          importAll: entire,
          groupIds: entire ? [] : Array.from(groups),
          elementIds: entire ? [] : Array.from(elements),
        }),
      });
      await onChanged();
      onClose();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  const elementRow = (e: NonNullable<CompetencyFramework['elements']>[number], covered: boolean) =>
    <label key={e.id} className="check-inline import-element">
      <input type="checkbox" disabled={entire || covered} checked={entire || covered || elements.has(e.id)} onChange={() => toggleElement(e.id)} />
      <span>{e.element_text}{e.is_critical ? <span className="badge critical inline-badge">Critical</span> : null}</span>
    </label>;

  return <div className="import-panel">
    <div className="import-head">
      <div>
        <h4>Clone questions from another framework</h4>
        <p className="muted">Pick a framework, then take the whole thing, whole groups, or single elements. A group merges into one of the same name if this framework already has it.</p>
      </div>
      <button type="button" className="link-button" onClick={onClose} aria-label="Close import">Close</button>
    </div>

    <label>Copy from
      <select value={sourceId} onChange={e => setSourceId(e.target.value)}>
        <option value="">Choose a framework…</option>
        {options.map(f => <option key={f.id} value={f.id}>{f.framework_code} — {f.title} (v{f.version_label}, {labelise(f.status)})</option>)}
      </select>
    </label>

    {loading && <p className="muted">Loading…</p>}

    {source && <>
      <label className="check-inline import-all">
        <input type="checkbox" checked={entire} onChange={e => setEntire(e.target.checked)} />
        <strong>Clone the entire framework</strong> — every group and element ({sourceElements.length})
      </label>

      <div className={`import-tree${entire ? ' dimmed' : ''}`}>
        {sourceGroups.filter(g => g.is_active).map(group => {
          const rows = sourceElements.filter(e => e.group_id === group.id);
          const groupChosen = groups.has(group.id);
          return <section key={group.id} className="import-group">
            <label className="check-inline import-group-head">
              <input type="checkbox" disabled={entire} checked={entire || groupChosen} onChange={() => toggleGroup(group.id)} />
              <strong>{group.group_title}</strong><span className="muted"> · {rows.length} element(s)</span>
            </label>
            <div className="import-group-body">
              {rows.map(e => elementRow(e, groupChosen))}
              {rows.length === 0 && <p className="muted eg-desc">No elements in this group.</p>}
            </div>
          </section>;
        })}
        {ungrouped.length > 0 && <section className="import-group">
          <div className="import-group-head"><strong>Ungrouped elements</strong></div>
          <div className="import-group-body">{ungrouped.map(e => elementRow(e, false))}</div>
        </section>}
      </div>

      <div className="element-add-actions">
        {can('personnel.training', 'create') && <button type="button" disabled={busy || nothingChosen} onClick={() => void runImport()}>
          {busy ? 'Copying…' : nothingChosen ? 'Select what to copy' : `Copy ${selectedCount} element(s)`}
        </button>}
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </>}
  </div>;
}

/* ── Details ────────────────────────────────────────────────────────────── */

function FrameworkDetails({ framework, sections, departments, editable, onError, onChanged }: {
  framework: CompetencyFramework;
  sections: Section[];
  departments: Department[];
  editable: boolean;
  onError: (message: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const [form, setForm] = useState({
    title: framework.title,
    appliesTo: framework.applies_to,
    sectionId: framework.section_id ? String(framework.section_id) : '',
    departmentId: framework.department_id ? String(framework.department_id) : '',
    cadre: framework.cadre ?? '',
    versionLabel: framework.version_label,
    purpose: framework.purpose ?? '',
    scope: framework.scope ?? '',
    maxScore: String(framework.max_score),
    passThresholdPercent: String(framework.pass_threshold_percent),
    minimumElementScore: framework.minimum_element_score === null || framework.minimum_element_score === undefined ? '' : String(framework.minimum_element_score),
    criticalElementsMustPass: !!framework.critical_elements_must_pass,
    validityMonths: String(framework.validity_months),
    requiresTechnicalReview: !!framework.requires_technical_review,
    requiresStaffAcknowledgement: !!framework.requires_staff_acknowledgement,
    effectiveDate: framework.effective_date ?? '',
    nextReviewDate: framework.next_review_date ?? '',
  });
  const [saved, setSaved] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault(); onError(null); setSaved(false);
    try {
      await api(`/personnel/competency-frameworks/${framework.id}`, { method: 'PUT', body: JSON.stringify(form) });
      setSaved(true);
      await onChanged();
    } catch (e) { onError((e as Error).message); }
  }

  if (!editable) {
    return <dl className="record-facts">
      <div><dt>Applies to</dt><dd>{COMPETENCY_AUDIENCE_LABELS[framework.applies_to] || labelise(framework.applies_to)}</dd></div>
      <div><dt>Unit / section</dt><dd>{framework.section_name || 'Whole laboratory'}</dd></div>
      <div><dt>Department</dt><dd>{framework.department_name || '—'}</dd></div>
      <div><dt>Version</dt><dd>{framework.version_label}</dd></div>
      <div><dt>Rating scale</dt><dd>1 to {framework.max_score}</dd></div>
      <div><dt>Pass mark</dt><dd>{framework.pass_threshold_percent}%</dd></div>
      <div><dt>Element floor</dt><dd>{framework.minimum_element_score ?? 'None set'}</dd></div>
      <div><dt>Critical rule</dt><dd>{framework.critical_elements_must_pass ? 'A shortfall on a critical element blocks a competent outcome' : 'Critical elements are advisory'}</dd></div>
      <div><dt>Re-assessment interval</dt><dd>{framework.validity_months} months</dd></div>
      <div><dt>Technical review</dt><dd>{framework.requires_technical_review ? 'Required' : 'Not required'}</dd></div>
      <div><dt>Staff acknowledgement</dt><dd>{framework.requires_staff_acknowledgement ? 'Required' : 'Not required'}</dd></div>
      <div><dt>Effective from</dt><dd>{framework.effective_date || '—'}</dd></div>
      <div><dt>Next review</dt><dd>{framework.next_review_date || '—'}</dd></div>
      <div><dt>Approved by</dt><dd>{framework.approved_by_name || '—'}{framework.approved_at ? ` · ${String(framework.approved_at).slice(0, 10)}` : ''}</dd></div>
      <div className="wide"><dt>Purpose</dt><dd>{framework.purpose || '—'}</dd></div>
      <div className="wide"><dt>Scope</dt><dd>{framework.scope || '—'}</dd></div>
    </dl>;
  }

  return can('personnel.training', 'edit') && <form className="form-grid" onSubmit={save}>
    <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
    <label>Applies to
      <select value={form.appliesTo} onChange={e => setForm({ ...form, appliesTo: e.target.value })}>
        {COMPETENCY_AUDIENCES.map(a => <option key={a} value={a}>{COMPETENCY_AUDIENCE_LABELS[a]}</option>)}
      </select>
    </label>
    <label>Unit / section
      <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
        <option value="">Whole laboratory</option>
        {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
    <label>Department
      <select value={form.departmentId} onChange={e => setForm({ ...form, departmentId: e.target.value })}>
        <option value="">—</option>
        {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
    <label>Cadre<input value={form.cadre} onChange={e => setForm({ ...form, cadre: e.target.value })} placeholder="e.g. Scientist" /></label>
    <label>Version<input value={form.versionLabel} onChange={e => setForm({ ...form, versionLabel: e.target.value })} /></label>
    <label>Top of rating scale
      <select value={form.maxScore} onChange={e => setForm({ ...form, maxScore: e.target.value })}>
        <option value="4">4-point</option><option value="5">5-point</option><option value="3">3-point</option>
      </select>
    </label>
    <label>Pass mark (%)<input type="number" min={0} max={100} value={form.passThresholdPercent} onChange={e => setForm({ ...form, passThresholdPercent: e.target.value })} /></label>
    <label>Lowest acceptable element score<input type="number" min={0} step="0.5" value={form.minimumElementScore} onChange={e => setForm({ ...form, minimumElementScore: e.target.value })} placeholder="Blank for no floor" /></label>
    <label>Re-assess every (months)<input type="number" min={1} value={form.validityMonths} onChange={e => setForm({ ...form, validityMonths: e.target.value })} /></label>
    <label>Effective from<input type="date" value={form.effectiveDate} onChange={e => setForm({ ...form, effectiveDate: e.target.value })} /></label>
    <label>Next review<input type="date" value={form.nextReviewDate} onChange={e => setForm({ ...form, nextReviewDate: e.target.value })} /></label>
    <label className="check-inline"><input type="checkbox" checked={form.criticalElementsMustPass} onChange={e => setForm({ ...form, criticalElementsMustPass: e.target.checked })} /> A shortfall on a critical element blocks a competent outcome</label>
    <label className="check-inline"><input type="checkbox" checked={form.requiresTechnicalReview} onChange={e => setForm({ ...form, requiresTechnicalReview: e.target.checked })} /> Requires a technical countersignature</label>
    <label className="check-inline"><input type="checkbox" checked={form.requiresStaffAcknowledgement} onChange={e => setForm({ ...form, requiresStaffAcknowledgement: e.target.checked })} /> Requires the member of staff to acknowledge</label>
    <label className="wide">Purpose<textarea rows={2} value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} /></label>
    <label className="wide">Scope<textarea rows={2} value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })} /></label>
    <div className="element-add-actions">
      <button type="submit">Save details</button>
      {saved && <span className="saved-flag">Saved</span>}
    </div>
  </form>;
}
